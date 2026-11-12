// GitHub through `gh api` on the hub's machine, under the hub's login:
// one GraphQL query per page of 100 merged PRs (author and merger account types, lines, the batch line), of 100
// default-branch commits (each with the merged PRs that brought it in, so a direct push needs no call of its own) and of
// 50 recently updated PRs' reviews and conversation comments. An inline comment on the diff belongs to a review, so it
// counts through that review, not on its own. What fleetd posted itself (`fleetdPosted`) is not the person's act and
// isn't returned. Pages stop once past the cursor, and at a bound so a first read of a busy repo can't run away.
import type { ActorKind } from "../../shared/contracts.ts";
import { explain } from "../prs/shapes.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { batchHeads, clip } from "../train/text.ts";
import type { HostAct, HostActKind, HostActs } from "./source.ts";
import { fleetdPosted, type GitHostSource, HostError, type LandedCommit, type MergedPr, type MergedRead, type RepoInfo, type RepoRef } from "./source.ts";

/** Pages of merged PRs read at most per sweep: a 90-day first read of a busy repo stops at 2,000 PRs. */
export const MERGED_PAGES = 20;
/** Pages of default-branch commits read at most per sweep. */
export const COMMIT_PAGES = 20;
/** Pages of recently updated PRs read at most for reviews and comments. */
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

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor?: string | null }; nodes: (T | null)[] };
type Actor = { __typename?: string; login?: string | null };
type MergedNode = {
  number: number;
  title?: string;
  url?: string | null;
  body?: string | null;
  createdAt?: string | null;
  updatedAt: string;
  mergedAt?: string | null;
  baseRefName: string;
  headRefName: string;
  additions?: number | null;
  deletions?: number | null;
  headRepository?: { nameWithOwner: string; defaultBranchRef?: { name: string } | null } | null;
  author?: Actor | null;
  mergedBy?: Actor | null;
  mergeCommit?: { oid: string } | null;
};
type CommitNode = {
  oid: string;
  committedDate: string;
  messageHeadline?: string;
  parents: { nodes: { oid: string }[] };
  author?: { name?: string | null; email?: string | null } | null;
  associatedPullRequests?: { nodes: { number: number; merged: boolean }[] } | null;
};
type Review = { databaseId?: number | null; submittedAt?: string | null; body?: string; author?: Actor | null };
type Comment = { databaseId?: number | null; createdAt: string; body?: string; author?: Actor | null };
type ActsNode = {
  number: number;
  headRefName?: string | null;
  additions?: number | null;
  deletions?: number | null;
  updatedAt: string;
  reviews?: { nodes: (Review | null)[] } | null;
  comments?: { nodes: (Comment | null)[] } | null;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** GitHub's account type: a `Bot` is an app (dependabot, renovate…); a deleted account answers no actor. */
function kind(actor: Actor | null | undefined): ActorKind {
  switch (actor?.__typename ?? "") {
    case "Bot":
      return "bot";
    case "User":
    case "Organization":
    case "Mannequin":
    case "EnterpriseUserAccount":
      return "human";
    default:
      return "unknown";
  }
}

/** A page's shape as each query reads it: anything else is GitHub answering in a shape fleetd doesn't read. */
function page<T>(v: unknown): Page<T> {
  if (!isObject(v) || !isObject(v.pageInfo) || typeof v.pageInfo.hasNextPage !== "boolean" || !Array.isArray(v.nodes)) throw new HostError(SHAPE);
  return v as Page<T>;
}

function mergedNode(v: unknown): MergedNode {
  if (!isObject(v) || num(v.number) === undefined || str(v.updatedAt) === undefined || str(v.baseRefName) === undefined || str(v.headRefName) === undefined) {
    throw new HostError(SHAPE);
  }
  return v as MergedNode;
}

function commitNode(v: unknown): CommitNode {
  if (!isObject(v) || str(v.oid) === undefined || str(v.committedDate) === undefined || !isObject(v.parents) || !Array.isArray(v.parents.nodes)) {
    throw new HostError(SHAPE);
  }
  return v as CommitNode;
}

function actsNode(v: unknown): ActsNode {
  if (!isObject(v) || num(v.number) === undefined || str(v.updatedAt) === undefined) throw new HostError(SHAPE);
  return v as ActsNode;
}

/** The page under `repository.pullRequests`. */
function pullsPage<T>(data: unknown): Page<T> {
  if (!isObject(data)) throw new HostError(SHAPE);
  const repo = data.repository;
  if (repo === null || repo === undefined) throw new HostError("GitHub doesn't know this repository, or the signed-in account can't see it.");
  if (!isObject(repo)) throw new HostError(SHAPE);
  return page<T>(repo.pullRequests);
}

function mergedPr(n: MergedNode): MergedPr | undefined {
  const mergedMs = n.mergedAt ? parseMs(n.mergedAt) : undefined;
  if (mergedMs === undefined) return undefined;
  const headIsDefault = n.headRepository?.defaultBranchRef?.name === n.headRefName;
  const createdMs = n.createdAt ? parseMs(n.createdAt) : undefined;
  const pr: MergedPr = {
    number: n.number,
    title: n.title ?? "",
    base: n.baseRefName,
    head: n.headRefName,
    headIsDefault,
    author: kind(n.author),
    mergedBy: kind(n.mergedBy),
    updatedMs: parseMs(n.updatedAt) ?? mergedMs,
    mergedMs,
    batchMembers: n.body ? batchHeads(n.body).map(([member]) => member) : [],
  };
  if (n.url) pr.url = n.url;
  if (n.headRepository) pr.headRepo = n.headRepository.nameWithOwner;
  if (n.mergedBy?.login) pr.mergedByLogin = n.mergedBy.login;
  if (createdMs !== undefined) pr.createdMs = createdMs;
  if (n.mergeCommit) pr.mergeSha = n.mergeCommit.oid.toLowerCase();
  if (typeof n.additions === "number") pr.additions = n.additions;
  if (typeof n.deletions === "number") pr.deletions = n.deletions;
  return pr;
}

/** A git identity GitHub gives its apps: `name[bot]`, `…[bot]@users.noreply.github.com`. */
const botIdentity = (a: CommitNode["author"]) => (a?.name?.endsWith("[bot]") ?? false) || (a?.email?.includes("[bot]@") ?? false);

/** One `gh` run (train/gh.ts `GhRunner`): the shipped hub's `systemGh` (loops.ts), or what answers its calls elsewhere. */
export type GhRunner = { run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> };

export class GitHubSource implements GitHostSource, HostActs {
  constructor(private readonly gh: GhRunner) {}

  private async run(args: string[]): Promise<unknown> {
    let out;
    try {
      out = await this.gh.run(args);
    } catch (error) {
      const spawn = error instanceof Error ? error.message : String(error);
      throw new HostError(spawn === "ENOENT" ? "The GitHub CLI (gh) isn't installed on the machine fleetd runs on." : `GitHub couldn't be read: ${spawn}`);
    }
    if (out.exitCode !== 0) throw new HostError(explain(out.exitCode, out.stderr));
    try {
      return JSON.parse(out.stdout) as unknown;
    } catch {
      throw new HostError(SHAPE);
    }
  }

  /** One GraphQL query; every variable is a string. GitHub's own errors come back as an error. */
  private async graphql(query: string, vars: [string, string][]): Promise<unknown> {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of vars) args.push("-f", `${k}=${v}`);
    const v = await this.run(args);
    if (!isObject(v)) throw new HostError(SHAPE);
    const first = Array.isArray(v.errors) ? (v.errors[0] as unknown) : undefined;
    if (first !== undefined) {
      const message = isObject(first) && typeof first.message === "string" ? first.message : "no message";
      throw new HostError(`GitHub couldn't be read: ${clip(message, 200)}`);
    }
    return v.data ?? null;
  }

  /**
   * Pages of `query` from the page after `after` until `keep` says one passed the cursor or `max` pages were read: the
   * page cursor to go on from when `max` cut it short.
   */
  private async pages<T>(
    repo: RepoRef,
    query: string,
    extra: [string, string][],
    after: string | undefined,
    max: number,
    take: (data: unknown) => Page<unknown>,
    node: (v: unknown) => T,
    keep: (n: T) => boolean,
  ): Promise<string | undefined> {
    const slash = repo.path.indexOf("/");
    if (slash < 0) throw new HostError(`${repo.path} is not owner/name`);
    const [owner, name] = [repo.path.slice(0, slash), repo.path.slice(slash + 1)];
    for (let i = 0; i < max; i++) {
      const vars: [string, string][] = [["owner", owner], ["name", name], ...extra];
      if (after !== undefined) vars.push(["after", after]);
      const p = take(await this.graphql(query, vars));
      let goOn = p.pageInfo.hasNextPage;
      for (const n of p.nodes) if (n !== null) goOn = keep(node(n)) && goOn;
      after = p.pageInfo.endCursor ?? undefined;
      if (!goOn || after === undefined) return undefined;
    }
    return after;
  }

  async signedIn(): Promise<string | undefined> {
    const v = await this.run(["api", "user"]);
    return isObject(v) && typeof v.login === "string" ? v.login : undefined;
  }

  async repoInfo(repo: RepoRef): Promise<RepoInfo> {
    const v = await this.run(["api", `repos/${repo.path}`]);
    if (!isObject(v) || typeof v.default_branch !== "string") throw new HostError(SHAPE);
    const parent = isObject(v.parent) && typeof v.parent.full_name === "string" ? v.parent.full_name : undefined;
    return parent === undefined ? { defaultBranch: v.default_branch } : { defaultBranch: v.default_branch, upstream: parent };
  }

  async mergedSince(repo: RepoRef, sinceMs: number, after?: string): Promise<MergedRead> {
    const pulls: MergedPr[] = [];
    let oldest = Number.MAX_SAFE_INTEGER;
    const cut = await this.pages(repo, MERGED_QUERY, [], after, MERGED_PAGES, pullsPage, mergedNode, (n) => {
      const updated = parseMs(n.updatedAt) ?? Number.MAX_SAFE_INTEGER;
      oldest = Math.min(oldest, updated);
      if (updated >= sinceMs) {
        const pr = mergedPr(n);
        if (pr) pulls.push(pr);
      }
      return updated >= sinceMs;
    });
    return cut === undefined ? { pulls } : { pulls, rest: [cut, oldest] };
  }

  async defaultCommits(repo: RepoRef, branch: string, sinceMs: number, stopAt?: string): Promise<LandedCommit[]> {
    // Back to the last read's head whatever the commits' dates (one made earlier can be pushed later), else the date
    // window.
    const vars: [string, string][] = [["branch", `refs/heads/${branch}`]];
    if (stopAt === undefined) vars.push(["since", isoMs(sinceMs)]);
    const out: LandedCommit[] = [];
    const history = (data: unknown): Page<unknown> => {
      if (!isObject(data)) throw new HostError(SHAPE);
      const noBranch = "GitHub has no such default branch on this repository.";
      const r = data.repository;
      if (r === null || r === undefined) throw new HostError(noBranch);
      if (!isObject(r)) throw new HostError(SHAPE);
      if (r.ref === null || r.ref === undefined) throw new HostError(noBranch);
      if (!isObject(r.ref)) throw new HostError(SHAPE);
      if (r.ref.target === null || r.ref.target === undefined) throw new HostError(noBranch);
      if (!isObject(r.ref.target)) throw new HostError(SHAPE);
      return page(r.ref.target.history);
    };
    await this.pages(repo, COMMITS_QUERY, vars, undefined, COMMIT_PAGES, history, commitNode, (c) => {
      const goOn = stopAt === undefined || c.oid.toLowerCase() !== stopAt.toLowerCase();
      const parent = c.parents.nodes[0]?.oid.toLowerCase();
      out.push({
        sha: c.oid.toLowerCase(),
        atMs: parseMs(c.committedDate) ?? 0,
        title: c.messageHeadline ?? "",
        ...(parent === undefined ? {} : { firstParent: parent }),
        prs: (c.associatedPullRequests?.nodes ?? []).filter((p) => p.merged).map((p) => p.number),
        bot: botIdentity(c.author),
      });
      return goOn;
    });
    return out;
  }

  async prsOfCommit(repo: RepoRef, sha: string): Promise<number[]> {
    const v = await this.run(["api", `repos/${repo.path}/commits/${sha}/pulls`]);
    if (!Array.isArray(v)) return [];
    return v.flatMap((p: unknown) => (isObject(p) && typeof p.merged_at === "string" && num(p.number) !== undefined ? [p.number as number] : []));
  }

  acts(): HostActs {
    return this;
  }

  async actsSince(remote: string, sinceMs: number): Promise<HostAct[]> {
    if (!remote.startsWith("github.com/")) throw new HostError(`${remote} is not on GitHub`);
    const repo: RepoRef = { remote, path: remote.slice("github.com/".length) };
    const out: HostAct[] = [];
    await this.pages(repo, ACTS_QUERY, [], undefined, ACT_PAGES, pullsPage, actsNode, (n) => {
      const updated = parseMs(n.updatedAt) ?? Number.MAX_SAFE_INTEGER;
      const lines = typeof n.additions === "number" && typeof n.deletions === "number" ? n.additions + n.deletions : undefined;
      const act = (what: HostActKind, id: number | null | undefined, at: string | null | undefined, actor: Actor | null | undefined) => {
        const atMs = at ? parseMs(at) : undefined;
        if (atMs === undefined || atMs < sinceMs || typeof id !== "number") return;
        const a: HostAct = { kind: what, id: String(id), prNumber: n.number, atMs, bot: kind(actor) === "bot" };
        if (actor?.login) a.login = actor.login;
        if (n.headRefName) a.head = n.headRefName;
        if (lines !== undefined) a.lines = lines;
        out.push(a);
      };
      // A pending review has no submit time yet: it is not an act.
      for (const r of n.reviews?.nodes ?? []) if (r && !fleetdPosted(r.body ?? "")) act("review", r.databaseId, r.submittedAt, r.author);
      for (const c of n.comments?.nodes ?? []) if (c && !fleetdPosted(c.body ?? "")) act("comment", c.databaseId, c.createdAt, c.author);
      return updated >= sinceMs;
    });
    return out;
  }
}
