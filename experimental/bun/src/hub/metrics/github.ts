// GitHub through `gh api` on the hub's machine (crates/fleetd/src/hub/metrics/source/github.rs): one GraphQL query per
// page of 100 merged PRs, of 100 default-branch commits (each with the merged PRs that brought it in) and of 50
// recently updated PRs' reviews and conversation comments. What fleetd posted itself isn't the person's act. Pages
// stop once past the cursor, and at a bound so a first read of a busy repo can't run away.
import type { ActorKind } from "../../shared/contracts.ts";
import { explain } from "../prs/github.ts";
import { isoMs, parseMs } from "../store/time.ts";
import type { GhRunner } from "../train/gh.ts";
import { batchHeads } from "../train/github.ts";
import type { HostAct, HostActs } from "./host_acts.ts";
import { fleetdPosted, type GitHostSource, type LandedCommit, type MergedPr, type MergedRead, type RepoInfo, type RepoRef } from "./source.ts";

/** Pages of merged PRs read at most per sweep: a 90-day first read of a busy repo stops at 2,000 PRs. */
export const MERGED_PAGES = 20;
export const COMMIT_PAGES = 20;
export const ACT_PAGES = 20;

const MERGED_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url body createdAt updatedAt mergedAt baseRefName headRefName additions deletions
        headRepository { nameWithOwner defaultBranchRef { name } }
        author { __typename login }
        mergedBy { __typename login }
        mergeCommit { oid }
      }
    }
  }
}`;

const COMMITS_QUERY = `query($owner: String!, $name: String!, $branch: String!, $since: GitTimestamp, $after: String) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $branch) {
      target {
        ... on Commit {
          history(first: 100, since: $since, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid committedDate messageHeadline
              parents(first: 1) { nodes { oid } }
              author { name email }
              associatedPullRequests(first: 5) { nodes { number merged } }
            }
          }
        }
      }
    }
  }
}`;

const ACTS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number headRefName additions deletions updatedAt
        reviews(last: 100) { nodes { databaseId submittedAt body author { __typename login } } }
        comments(last: 100) { nodes { databaseId createdAt body author { __typename login } } }
      }
    }
  }
}`;

const SHAPE = "GitHub answered in a shape fleetd doesn't read.";

type J = Record<string, unknown>;
const obj = (v: unknown): J | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as J) : undefined);
const s = (v: unknown) => (typeof v === "string" ? v : undefined);
const n = (v: unknown) => (typeof v === "number" ? v : undefined);
type Page = { hasNext: boolean; end?: string; nodes: J[] };

/** GitHub's account type: a `Bot` is an app; a deleted account answers no actor. */
function kind(actor: unknown): ActorKind {
  const t = s(obj(actor)?.__typename);
  if (t === "Bot") return "bot";
  if (t === "User" || t === "Organization" || t === "Mannequin" || t === "EnterpriseUserAccount") return "human";
  return "unknown";
}

function page(v: unknown): Page {
  const p = obj(v);
  const info = obj(p?.pageInfo);
  if (!p || !info || typeof info.hasNextPage !== "boolean" || !Array.isArray(p.nodes)) throw new Error(SHAPE);
  return { hasNext: info.hasNextPage, ...(s(info.endCursor) ? { end: s(info.endCursor) } : {}), nodes: (p.nodes as unknown[]).flatMap((x): J[] => { const o = obj(x); return o ? [o] : []; }) };
}

/** The page under `repository.pullRequests`. */
function pullsPage(data: unknown): Page {
  const d = obj(data);
  if (!d || !("repository" in d)) throw new Error(SHAPE);
  const repo = obj(d.repository);
  if (!repo) throw new Error("GitHub doesn't know this repository, or the signed-in account can't see it.");
  return page(repo.pullRequests);
}

function mergedPr(x: J): MergedPr | undefined {
  const mergedMs = s(x.mergedAt) === undefined ? undefined : parseMs(s(x.mergedAt)!);
  if (mergedMs === undefined || typeof x.number !== "number" || typeof x.baseRefName !== "string" || typeof x.headRefName !== "string") return undefined;
  const headRepo = obj(x.headRepository);
  const login = s(obj(x.mergedBy)?.login);
  const created = s(x.createdAt) === undefined ? undefined : parseMs(s(x.createdAt)!);
  const sha = s(obj(x.mergeCommit)?.oid)?.toLowerCase();
  return {
    number: x.number,
    title: s(x.title) ?? "",
    ...(s(x.url) ? { url: s(x.url) } : {}),
    base: x.baseRefName,
    head: x.headRefName,
    ...(headRepo && s(headRepo.nameWithOwner) ? { headRepo: s(headRepo.nameWithOwner) } : {}),
    headIsDefault: s(obj(headRepo?.defaultBranchRef)?.name) === x.headRefName,
    author: kind(x.author),
    mergedBy: kind(x.mergedBy),
    ...(login ? { mergedByLogin: login } : {}),
    ...(created === undefined ? {} : { createdMs: created }),
    updatedMs: parseMs(s(x.updatedAt) ?? "") ?? mergedMs,
    mergedMs,
    ...(sha ? { mergeSha: sha } : {}),
    ...(n(x.additions) === undefined ? {} : { additions: n(x.additions) }),
    ...(n(x.deletions) === undefined ? {} : { deletions: n(x.deletions) }),
    batchMembers: s(x.body) ? batchHeads(s(x.body)!).map(([m]) => m) : [],
  };
}

/** A git identity GitHub gives its apps: `name[bot]`, `…[bot]@users.noreply.github.com`. */
const botIdentity = (a: unknown) => (s(obj(a)?.name)?.endsWith("[bot]") ?? false) || (s(obj(a)?.email)?.includes("[bot]@") ?? false);

const clip200 = (t: string) => ([...t].length > 200 ? `${[...t].slice(0, 199).join("")}…` : t);

export class GitHubSource implements GitHostSource, HostActs {
  constructor(private readonly gh: GhRunner) {}

  private async run(args: string[]): Promise<unknown> {
    let out;
    try {
      out = await this.gh.run(args);
    } catch (error) {
      const why = (error as Error).message;
      throw new Error(why === "ENOENT" ? "The GitHub CLI (gh) isn't installed on the machine fleetd runs on." : `GitHub couldn't be read: ${why}`);
    }
    if (out.exitCode !== 0) throw new Error(explain(out.exitCode, out.stderr));
    try {
      return JSON.parse(out.stdout);
    } catch {
      throw new Error(SHAPE);
    }
  }

  /** One GraphQL query; every variable is a string. GitHub's own errors come back as an error. */
  private async graphql(query: string, vars: [string, string][]): Promise<unknown> {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of vars) args.push("-f", `${k}=${v}`);
    const v = obj(await this.run(args));
    const errors = v?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`GitHub couldn't be read: ${clip200(s(obj(errors[0])?.message) ?? "no message")}`);
    }
    return v?.data;
  }

  /** Pages from the one after `after` until `keep` says one passed the cursor or `max` were read; the cursor left. */
  private async pages(repo: RepoRef, query: string, extra: [string, string][], after: string | undefined, max: number, take: (data: unknown) => Page, keep: (node: J) => boolean): Promise<string | undefined> {
    const slash = repo.path.indexOf("/");
    if (slash < 0) throw new Error(`${repo.path} is not owner/name`);
    const [owner, name] = [repo.path.slice(0, slash), repo.path.slice(slash + 1)];
    for (let i = 0; i < max; i++) {
      const vars: [string, string][] = [["owner", owner], ["name", name], ...extra];
      if (after !== undefined) vars.push(["after", after]);
      const p = take(await this.graphql(query, vars));
      let goOn = p.hasNext;
      for (const node of p.nodes) goOn = keep(node) && goOn;
      after = p.end;
      if (!goOn || after === undefined) return undefined;
    }
    return after;
  }

  async signedIn(): Promise<string | undefined> {
    return s(obj(await this.run(["api", "user"]))?.login);
  }

  async repoInfo(repo: RepoRef): Promise<RepoInfo> {
    const r = obj(await this.run(["api", `repos/${repo.path}`]));
    const branch = s(r?.default_branch);
    if (branch === undefined) throw new Error(SHAPE);
    const upstream = s(obj(r?.parent)?.full_name);
    return upstream === undefined ? { defaultBranch: branch } : { defaultBranch: branch, upstream };
  }

  async mergedSince(repo: RepoRef, sinceMs: number, after?: string): Promise<MergedRead> {
    const pulls: MergedPr[] = [];
    let oldest = Number.MAX_SAFE_INTEGER;
    const cut = await this.pages(repo, MERGED_QUERY, [], after, MERGED_PAGES, pullsPage, (x) => {
      const updated = parseMs(s(x.updatedAt) ?? "") ?? Number.MAX_SAFE_INTEGER;
      oldest = Math.min(oldest, updated);
      if (updated >= sinceMs) {
        const pr = mergedPr(x);
        if (pr) pulls.push(pr);
      }
      return updated >= sinceMs;
    });
    return cut === undefined ? { pulls } : { pulls, rest: [cut, oldest] };
  }

  async defaultCommits(repo: RepoRef, branch: string, sinceMs: number, stopAt?: string): Promise<LandedCommit[]> {
    // Back to the last read's head whatever the commits' dates, else the date window.
    const vars: [string, string][] = [["branch", `refs/heads/${branch}`]];
    if (stopAt === undefined) vars.push(["since", isoMs(sinceMs)]);
    const out: LandedCommit[] = [];
    const history = (data: unknown) => {
      const d = obj(data);
      if (!d || !("repository" in d)) throw new Error(SHAPE);
      const h = obj(obj(obj(obj(d.repository)?.ref)?.target)?.history);
      if (!h) throw new Error("GitHub has no such default branch on this repository.");
      return page(h);
    };
    await this.pages(repo, COMMITS_QUERY, vars, undefined, COMMIT_PAGES, history, (c) => {
      const oid = s(c.oid) ?? "";
      const goOn = stopAt === undefined || oid.toLowerCase() !== stopAt.toLowerCase();
      const parent = s(obj((obj(c.parents)?.nodes as unknown[] | undefined)?.[0])?.oid);
      const associated = (obj(c.associatedPullRequests)?.nodes as unknown[] | undefined) ?? [];
      out.push({
        sha: oid.toLowerCase(),
        atMs: parseMs(s(c.committedDate) ?? "") ?? 0,
        title: s(c.messageHeadline) ?? "",
        ...(parent ? { firstParent: parent.toLowerCase() } : {}),
        prs: associated.flatMap((p) => (obj(p)?.merged === true && typeof obj(p)?.number === "number" ? [obj(p)!.number as number] : [])),
        bot: botIdentity(c.author),
      });
      return goOn;
    });
    return out;
  }

  async prsOfCommit(repo: RepoRef, sha: string): Promise<number[]> {
    const v = await this.run(["api", `repos/${repo.path}/commits/${sha}/pulls`]);
    return Array.isArray(v) ? v.flatMap((p) => (typeof obj(p)?.merged_at === "string" && typeof obj(p)?.number === "number" ? [obj(p)!.number as number] : [])) : [];
  }

  acts(): HostActs {
    return this;
  }

  async actsSince(remote: string, sinceMs: number): Promise<HostAct[]> {
    if (!remote.startsWith("github.com/")) throw new Error(`${remote} is not on GitHub`);
    const repo = { remote, path: remote.slice("github.com/".length) };
    const out: HostAct[] = [];
    await this.pages(repo, ACTS_QUERY, [], undefined, ACT_PAGES, pullsPage, (x) => {
      const updated = parseMs(s(x.updatedAt) ?? "") ?? Number.MAX_SAFE_INTEGER;
      const lines = n(x.additions) !== undefined && n(x.deletions) !== undefined ? n(x.additions)! + n(x.deletions)! : undefined;
      const head = s(x.headRefName);
      const act = (what: HostAct["kind"], id: unknown, at: unknown, actor: unknown) => {
        const atMs = s(at) === undefined ? undefined : parseMs(s(at)!);
        if (atMs === undefined || atMs < sinceMs || typeof id !== "number" || typeof x.number !== "number") return;
        const login = s(obj(actor)?.login);
        out.push({
          kind: what,
          id: String(id),
          prNumber: x.number,
          atMs,
          ...(login ? { login } : {}),
          bot: kind(actor) === "bot",
          ...(head === undefined ? {} : { head }),
          ...(lines === undefined ? {} : { lines }),
        });
      };
      // A pending review has no submit time yet: it is not an act.
      for (const r of (obj(x.reviews)?.nodes as unknown[] | undefined) ?? []) {
        const rv = obj(r);
        if (rv && !fleetdPosted(s(rv.body) ?? "")) act("review", rv.databaseId, rv.submittedAt, rv.author);
      }
      for (const c of (obj(x.comments)?.nodes as unknown[] | undefined) ?? []) {
        const cm = obj(c);
        if (cm && !fleetdPosted(s(cm.body) ?? "")) act("comment", cm.databaseId, cm.createdAt, cm.author);
      }
      return updated >= sinceMs;
    });
    return out;
  }
}
