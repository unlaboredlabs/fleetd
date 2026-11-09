// What the PR views read from GitHub, through `gh` on the hub's machine, cached briefly so a burst of refetches costs
// one call: a repo's open or closed PRs a page at a time, most recently updated
// first (one GraphQL query per page), one PR's detail (one query), and its changed files (REST, per page of 100, kept
// per head so a page is read once per push). Only the PR views call this; nothing here runs on a timer. A failed read
// is remembered for the same TTL, so a rate-limited or signed-out `gh` is asked again at most once a minute.
import type { Clock } from "../../shared/clock.ts";
import { GhStartError, type GhRunner } from "../train/gh.ts";
import { clip } from "../train/seams.ts";

/** How long a repo's PR list is reused. */
export const LIST_TTL_MS = 60_000;
/** How long one PR's detail is reused. */
export const DETAIL_TTL_MS = 30_000;
/** How long a failed read is remembered before GitHub is asked again. */
export const ERROR_TTL_MS = 60_000;
/** GitHub reads run at once; more wait for one of them to finish. */
export const READS_AT_ONCE = 4;
/** PRs per page read from GitHub. */
export const PAGE_SIZE = 50;
/** A file's patch kept for paging; GitHub itself leaves out the patch of very large files. */
const PATCH_MAX_BYTES = 512 * 1024;
const MAX_LISTS = 128;
const MAX_DETAILS = 64;
const MAX_FILE_PAGES = 16;

const LIST_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: STATES, first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title state isDraft author { login } headRefName headRefOid createdAt updatedAt mergedAt closedAt
        reviewDecision url CHECKS
      }
    }
  }
}`;
const LIST_CHECKS = `
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl startedAt completedAt }
          ... on StatusContext { context state targetUrl }
        } } } } } }`;
const DETAIL_FIELDS =
  "number,title,state,isDraft,author,headRefName,headRefOid,createdAt,updatedAt,mergedAt,closedAt,reviewDecision,statusCheckRollup,url,body,baseRefName,additions,deletions,changedFiles,mergeCommit,reviews";

/** A check run or a commit status, as `statusCheckRollup` lists them. */
export type GhCheck = {
  __typename?: string;
  name?: string | null;
  context?: string | null;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
  detailsUrl?: string | null;
  targetUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type GhPull = {
  number: number;
  title: string;
  /** OPEN, CLOSED or MERGED. */
  state: string;
  isDraft: boolean;
  author?: { login: string } | null;
  headRefName: string;
  headRefOid: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or empty. */
  reviewDecision?: string | null;
  statusCheckRollup: GhCheck[];
};

export type GhPage = { pulls: GhPull[]; next?: string };

export type GhReview = {
  author?: { login: string } | null;
  state: string;
  body: string;
  submittedAt?: string | null;
  commit?: { oid: string } | null;
};

export type GhDetail = {
  pull: GhPull;
  body: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeCommit?: { oid: string } | null;
  reviews: GhReview[];
};

/** One changed file, as `pulls/{n}/files` answers it. */
export type GhFile = {
  filename: string;
  previous_filename?: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch?: string | null;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** A pull as serde reads it, defaults filled; undefined without its number. */
function readPull(v: any): GhPull | undefined {
  if (!v || typeof v.number !== "number") return undefined;
  return {
    number: v.number,
    title: str(v.title),
    state: str(v.state),
    isDraft: v.isDraft === true,
    author: v.author && typeof v.author === "object" ? { login: str(v.author.login) } : null,
    headRefName: str(v.headRefName),
    headRefOid: str(v.headRefOid),
    createdAt: str(v.createdAt),
    updatedAt: str(v.updatedAt),
    mergedAt: v.mergedAt ?? null,
    closedAt: v.closedAt ?? null,
    reviewDecision: v.reviewDecision ?? null,
    statusCheckRollup: Array.isArray(v.statusCheckRollup) ? v.statusCheckRollup : [],
  };
}

function readDetail(v: any): GhDetail | undefined {
  const pull = readPull(v);
  if (!pull) return undefined;
  return {
    pull,
    body: str(v.body),
    baseRefName: str(v.baseRefName),
    additions: num(v.additions),
    deletions: num(v.deletions),
    changedFiles: num(v.changedFiles),
    mergeCommit: v.mergeCommit ? { oid: str(v.mergeCommit.oid) } : null,
    reviews: Array.isArray(v.reviews)
      ? v.reviews.map((r: any) => ({
          author: r?.author ? { login: str(r.author.login) } : null,
          state: str(r?.state),
          body: str(r?.body),
          submittedAt: r?.submittedAt ?? null,
          commit: r?.commit ? { oid: str(r.commit.oid) } : null,
        }))
      : [],
  };
}

function readPage(v: any): GhPage {
  const repo = v?.data?.repository;
  if (repo === undefined) throw new Error("GitHub answered in a shape fleetd doesn't read.");
  if (repo === null) throw new Error("GitHub doesn't know this repository or PR, or the signed-in account can't see it.");
  const list = repo.pullRequests;
  if (!list || !Array.isArray(list.nodes) || !list.pageInfo) throw new Error("GitHub answered in a shape fleetd doesn't read.");
  const pulls = (list.nodes as any[]).map((node) => {
    const pull = readPull(node);
    if (!pull) throw new Error("GitHub answered in a shape fleetd doesn't read.");
    const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    pull.statusCheckRollup = Array.isArray(rollup?.contexts?.nodes) ? rollup.contexts.nodes : [];
    return pull;
  });
  const next = list.pageInfo.hasNextPage === true && typeof list.pageInfo.endCursor === "string" ? list.pageInfo.endCursor : undefined;
  return next === undefined ? { pulls } : { pulls, next };
}

/** A read's answer: the value (possibly an older one) and, when the last read failed, why. */
export type Read<T> = { value?: T; error?: string };

type Entry<T> = { value?: T; okMs: number; error?: [string, number]; used: number };

/** A small map that drops its least recently used entry past `max`. */
class Cache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  /** The read of each key running now, which a burst of calls for the key shares. */
  readonly asking = new Map<string, Promise<Read<T>>>();
  private tick = 0;
  constructor(private readonly max: number) {}

  get(key: string, now: number, ttl: number): Read<T> | undefined {
    this.tick++;
    const e = this.entries.get(key);
    if (!e) return undefined;
    e.used = this.tick;
    const fresh = e.error ? now - e.error[1] < ERROR_TTL_MS : e.value !== undefined && now - e.okMs < ttl;
    return fresh ? read(e) : undefined;
  }

  put(key: string, result: { ok: true; value: T } | { ok: false; error: string }, now: number): Read<T> {
    this.tick++;
    if (this.entries.size >= this.max && !this.entries.has(key)) {
      let oldest: string | undefined;
      let used = Infinity;
      for (const [k, e] of this.entries) {
        if (e.used < used) {
          used = e.used;
          oldest = k;
        }
      }
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    let e = this.entries.get(key);
    if (!e) {
      e = { okMs: 0, used: 0 };
      this.entries.set(key, e);
    }
    e.used = this.tick;
    if (result.ok) {
      e.value = result.value;
      e.okMs = now;
      delete e.error;
    } else {
      // An older value stays: the views show it with the reason the refresh failed.
      e.error = [result.error, now];
    }
    return read(e);
  }
}

function read<T>(e: Entry<T>): Read<T> {
  const out: Read<T> = {};
  if (e.value !== undefined) out.value = e.value;
  if (e.error) out.error = e.error[0];
  return out;
}

/** Why a `gh` read failed, in words a person can act on. */
export function explain(exitCode: number, stderr: string): string {
  const s = stderr.toLowerCase();
  if (exitCode === 4 || s.includes("gh auth login") || s.includes("not logged in")) {
    return "GitHub isn't signed in on the machine fleetd runs on: run `gh auth login` there.";
  }
  if (s.includes("rate limit")) return "GitHub's rate limit is reached; fleetd asks again in a minute.";
  if (s.includes("could not resolve") || s.includes("not found")) {
    return "GitHub doesn't know this repository or PR, or the signed-in account can't see it.";
  }
  let last = (stderr.trim().split("\n").at(-1) ?? "").trim();
  if (last.startsWith("gh: ")) last = last.slice(4);
  return `GitHub couldn't be read: ${clip(last === "" ? "no answer" : last, 200)}`;
}

export class PrsGitHub {
  private readonly lists = new Cache<GhPage>(MAX_LISTS);
  private readonly details = new Cache<GhDetail>(MAX_DETAILS);
  private readonly files_ = new Cache<GhFile[]>(MAX_FILE_PAGES);
  /**
   * GitHub reads running, at most READS_AT_ONCE, and the ones waiting for a turn. Once one at a time, a chat with five
   * PR cards waited 3 s for their details, each behind the one before.
   */
  private running = 0;
  private readonly turns: (() => void)[] = [];

  constructor(
    private readonly gh: GhRunner,
    private readonly clock: Clock,
  ) {}

  private async runJson<T>(args: string[], shape: (v: unknown) => T): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    let out;
    try {
      out = await this.gh.run(args);
    } catch (error) {
      const spawn = error instanceof GhStartError ? error.message : String((error as Error)?.message ?? error);
      return {
        ok: false,
        error: spawn === "ENOENT" ? "The GitHub CLI (gh) isn't installed on the machine fleetd runs on." : `GitHub couldn't be read: ${spawn}`,
      };
    }
    if (out.exitCode !== 0) return { ok: false, error: explain(out.exitCode, out.stderr) };
    try {
      return { ok: true, value: shape(JSON.parse(out.stdout)) };
    } catch (error) {
      const message = (error as Error).message;
      return { ok: false, error: message.startsWith("GitHub") ? message : "GitHub answered in a shape fleetd doesn't read." };
    }
  }

  /** The cached answer for `key`, else one read of it: a burst of calls for the same key shares it. */
  private cached<T>(cache: Cache<T>, key: string, ttl: number, fetch: () => Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<Read<T>> {
    const hit = cache.get(key, this.clock.now(), ttl);
    if (hit) return Promise.resolve(hit);
    let asking = cache.asking.get(key);
    if (!asking) {
      asking = this.turn(async () => cache.put(key, await fetch(), this.clock.now())).finally(() => cache.asking.delete(key));
      cache.asking.set(key, asking);
    }
    return asking;
  }

  /** Runs `read` once fewer than READS_AT_ONCE others run; a finished read hands its turn to the first waiting. */
  private async turn<T>(read: () => Promise<T>): Promise<T> {
    if (this.running < READS_AT_ONCE) this.running++;
    else await new Promise<void>((resolve) => this.turns.push(resolve));
    try {
      return await read();
    } finally {
      const next = this.turns.shift();
      if (next) next();
      else this.running--;
    }
  }

  /** A page of the repo's open PRs (`closed` false) or of its closed and merged ones, most recently updated first. */
  page(repo: string, closed: boolean, after?: string): Promise<Read<GhPage>> {
    const state = closed ? "closed" : "open";
    const key = JSON.stringify([repo.toLowerCase(), state, after ?? null]);
    return this.cached(this.lists, key, LIST_TTL_MS, () => {
      const slash = repo.indexOf("/");
      const [owner, name] = slash < 0 ? [repo, ""] : [repo.slice(0, slash), repo.slice(slash + 1)];
      const [states, checks] = closed ? ["[CLOSED, MERGED]", ""] : ["[OPEN]", LIST_CHECKS];
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${LIST_QUERY.replace("STATES", states).replace("CHECKS", checks)}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `first=${PAGE_SIZE}`,
      ];
      if (after !== undefined) args.push("-f", `after=${after}`);
      return this.runJson(args, readPage);
    });
  }

  /** One PR's detail. */
  detail(repo: string, number: number): Promise<Read<GhDetail>> {
    const key = JSON.stringify([repo.toLowerCase(), number]);
    return this.cached(this.details, key, DETAIL_TTL_MS, () =>
      this.runJson(["pr", "view", String(number), "--repo", repo, "--json", DETAIL_FIELDS], (v) => {
        const d = readDetail(v);
        if (!d) throw new Error("shape");
        return d;
      }),
    );
  }

  /** Page `page` (0-based, 100 files each) of the PR's files at `head`, kept until it falls out of the cache. */
  files(repo: string, number: number, head: string, page: number): Promise<Read<GhFile[]>> {
    const key = JSON.stringify([repo.toLowerCase(), number, head, page]);
    return this.cached(this.files_, key, Number.MAX_SAFE_INTEGER, () =>
      this.runJson(["api", `repos/${repo}/pulls/${number}/files?per_page=100&page=${page + 1}`], (v) => {
        if (!Array.isArray(v)) throw new Error("shape");
        return v.map((f: any) => {
          if (typeof f?.filename !== "string") throw new Error("shape");
          const patch = typeof f.patch === "string" && Buffer.byteLength(f.patch) <= PATCH_MAX_BYTES ? f.patch : null;
          return {
            filename: f.filename,
            previous_filename: f.previous_filename ?? null,
            status: str(f.status),
            additions: num(f.additions),
            deletions: num(f.deletions),
            patch,
          } as GhFile;
        });
      }),
    );
  }
}
