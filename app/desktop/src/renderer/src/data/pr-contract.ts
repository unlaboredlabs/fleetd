// The PR reads (pr_list, pr_get, pr_files, pr_diff), copied verbatim from the hub's generated contracts on the branch
// that adds them (crates/fleetd-contracts/src/prs.rs), until that lands here. They join ToolMap below, so they go
// through the one data layer like any other read. When the generated file has them: delete this file and import
// the same names from shared/contracts.
import type {
  AgentRole,
  ChangeId,
  ChangeState,
  CommitSha,
  Effort,
  GitHubPrUrl,
  GitHubRepo,
  ProjectRef,
  TaskId,
  ThreadRef,
  Timestamp,
  WorkstreamId,
} from "../../../shared/contracts";

/** The checks on the PR's head, rolled up: any failed is `failing`, else any running is `pending`. */
export type KnownChecksState = "pending" | "passing" | "failing" | "none";

/** KnownChecksState, or a value from a newer hub. */
export type ChecksState = KnownChecksState | (string & {});

export type ChecksSummary = {
  failed: number;
  passed: number;
  pending: number;
  state: ChecksState;
};

/** One line of a file's diff. Secrets are replaced by `[secret]`. */
export type DiffLine = {
  /** The line was longer than `PR_DIFF_LINE_MAX` and is cut. */
  cut?: boolean;
  kind: DiffLineKind;
  /** Line number in the new file (context and added lines; a hunk's start). */
  new?: number;
  /** Line number in the old file (context and deleted lines; a hunk's start). */
  old?: number;
  /** Without the leading "+", "-" or " ". */
  text: string;
};

export type KnownDiffLineKind = "context" | "add" | "del" | "hunk";

/** KnownDiffLineKind, or a value from a newer hub. */
export type DiffLineKind = KnownDiffLineKind | (string & {});

/** Who wrote the PR: fleetd's agent when one did, and the GitHub account it was opened from. */
export type PrAuthor = {
  effort?: Effort;
  /** The writing agent's lane in the agents view. */
  laneId?: string;
  /** GitHub login; absent when GitHub wasn't reached. */
  login?: string;
  model?: string;
  role?: AgentRole;
  taskId?: TaskId;
  /** Its session, for `agent_work`. */
  threadRef?: ThreadRef;
  /** The agent's task title. */
  title?: string;
};

/** One check run or commit status on the head. fleetd's own merge statuses are left out: `queue` says the same. */
export type PrCheck = {
  completedAt?: Timestamp;
  /** GitHub's conclusion as given, lowercased ("success", "failure", "skipped", "timed_out"…). */
  conclusion?: string;
  name: string;
  startedAt?: Timestamp;
  state: ChecksState;
  url?: string;
};

export type PrDiffInput = {
  limit?: number;
  number: number;
  offset?: number;
  path: string;
  repo: GitHubRepo;
};

export type PrDiffOutput = {
  headSha?: CommitSha;
  lines: DiffLine[];
  next?: string;
  /** Pass back as `offset` for the next page; absent on the last. */
  nextOffset?: number;
  /** GitHub shows no diff for this file (binary, or too large). */
  noDiff?: boolean;
  /** Lines in the file's diff. */
  total: number;
  truncated?: boolean;
};

/** One changed file. */
export type PrFile = {
  additions: number;
  deletions: number;
  /** Lines `pr_diff` pages through; absent when GitHub shows no diff for it (binary, or too large). */
  diffLines?: number;
  /** Repo-relative; the new path of a rename. */
  path: string;
  /** A rename's old path. */
  previousPath?: string;
  status: PrFileStatus;
};

export type KnownPrFileStatus = "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";

/** KnownPrFileStatus, or a value from a newer hub. */
export type PrFileStatus = KnownPrFileStatus | (string & {});

export type PrFilesInput = {
  number: number;
  offset?: number;
  repo: GitHubRepo;
};

export type PrFilesOutput = {
  files: PrFile[];
  /** The head these files are of. */
  headSha?: CommitSha;
  next?: string;
  /** Pass back as `offset` for the next page; absent on the last. */
  nextOffset?: number;
  /** Changed files in the PR. */
  total: number;
  truncated?: boolean;
};

export type PrGetInput = {
  number: number;
  repo: GitHubRepo;
};

export type PrGetOutput = {
  additions?: number;
  baseBranch?: string;
  /** The PR's description, at most 8000 characters. Secrets are replaced by `[secret]`. */
  body: string;
  changedFiles?: number;
  checks: PrCheck[];
  deletions?: number;
  githubError?: string;
  headSha?: CommitSha;
  /** Its moves through the merge queue, newest first. */
  history: PrQueueStep[];
  links: PrLinks;
  next?: string;
  pr: PrRow;
  /** Newest first: agent verdicts and people's reviews. */
  reviews: PrReviewEntry[];
  truncated?: boolean;
};

export type PrLinks = {
  checks: string;
  files: string;
  /** The squash commit on the base, once merged. */
  mergeCommit?: string;
  pr: GitHubPrUrl;
};

export type PrListInput = {
  closedSince?: Timestamp;
  projectRef: ProjectRef;
};

export type PrListOutput = {
  at: Timestamp;
  /** GitHub couldn't be reached: the list holds only the PRs fleetd records, without checks. Why, and what to do. */
  githubError?: string;
  next?: string;
  prs: PrRow[];
  truncated?: boolean;
};

/** Where the PR stands in fleetd's merge queue. Absent from a PR fleetd doesn't land. */
export type PrQueue = {
  changeId: ChangeId;
  /** PRs waiting in the same queue. */
  length: number;
  /** Merging is paused for the repository. */
  paused: boolean;
  /** 0-based place in the queue; absent when not waiting in it. */
  position?: number;
  /** Why it is held or was sent back: a conflict, failing check names, or the refusal's fix. */
  reason?: string;
  state: ChangeState;
};

/** One move of the PR through the merge queue. */
export type PrQueueStep = {
  at: Timestamp;
  from: ChangeState;
  to: ChangeState;
};

/** One review: an agent's verdict with its findings, or a person's review on GitHub. */
export type PrReviewEntry = {
  /** The reviewing agent (reviewer, verifier or QA); absent for a person's review. */
  agent?: PrAuthor;
  at: Timestamp;
  /** Findings that must be fixed before merging; agent reviews only. */
  blocking?: number;
  /** It reviewed the PR's current change (an agent review stays current across a rebase that changes nothing). */
  current: boolean;
  /** GitHub login of a person's review. */
  login?: string;
  nonBlocking?: number;
  /** The agent's findings, or the person's review text. Secrets are replaced by `[secret]`. */
  text: string;
  verdict: ReviewVerdictKind;
};

/** One PR as the list shows it. */
export type PrRow = {
  author: PrAuthor;
  /** Its head branch. */
  branch?: string;
  /** Absent when GitHub wasn't reached. */
  checks?: ChecksSummary;
  createdAt: Timestamp;
  mergedAt?: Timestamp;
  number: number;
  queue?: PrQueue;
  repo: GitHubRepo;
  review: ReviewSummary;
  state: PrState;
  /** GitHub's title; the writing agent's task title when GitHub wasn't reached. */
  title: string;
  updatedAt: Timestamp;
  url: GitHubPrUrl;
  /** The work it belongs to, when fleetd's agents wrote it. */
  workstreamId?: WorkstreamId;
};

/** The PR on GitHub. */
export type KnownPrState = "open" | "draft" | "merged" | "closed";

/** KnownPrState, or a value from a newer hub. */
export type PrState = KnownPrState | (string & {});

/** Its reviews, rolled up. */
export type KnownReviewState = "approved" | "changes_requested" | "none" | "pending";

/** KnownReviewState, or a value from a newer hub. */
export type ReviewState = KnownReviewState | (string & {});

export type ReviewSummary = {
  /** Clean agent reviews of the current change. */
  done: number;
  /** Agent reviews it needs before it can merge; 0 for a PR fleetd doesn't land. */
  needed: number;
  state: ReviewState;
};

export type KnownReviewVerdictKind = "approved" | "changes_requested" | "commented" | "dismissed";

/** KnownReviewVerdictKind, or a value from a newer hub. */
export type ReviewVerdictKind = KnownReviewVerdictKind | (string & {});

declare module "../../../shared/contracts/generated/contracts" {
  interface ToolMap {
    pr_diff: { input: PrDiffInput; output: PrDiffOutput };
    pr_files: { input: PrFilesInput; output: PrFilesOutput };
    pr_get: { input: PrGetInput; output: PrGetOutput };
    pr_list: { input: PrListInput; output: PrListOutput };
  }
}
