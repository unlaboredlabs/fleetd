// What the PR views read from GitHub and how its answers are read (github.ts runs `gh` and caches): the queries, the
// TTLs, the shapes of a pull, its detail and files, and why a read failed.
import { clip } from "../train/text.ts";

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
export const PATCH_MAX_BYTES = 512 * 1024;

export const LIST_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String) {
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
export const LIST_CHECKS = `
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl startedAt completedAt }
          ... on StatusContext { context state targetUrl }
        } } } } } }`;
export const DETAIL_FIELDS =
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

export const str = (v: unknown) => (typeof v === "string" ? v : "");
export const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** A pull as serde reads it, defaults filled; undefined without its number. */
export function readPull(v: any): GhPull | undefined {
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

export function readDetail(v: any): GhDetail | undefined {
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

export function readPage(v: any): GhPage {
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
