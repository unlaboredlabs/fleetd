import { Schema } from "effect";
import { ProjectRef, Timestamp } from "./ids.ts";
import { Serves, Tier, WorkstreamId } from "./ledger.ts";
import { TaskId } from "./tasks.ts";
import { CommitSha } from "./verification.ts";

// M7 objects: Changes (PRs on the merge train) and each repo's train.

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** "X" plus a positive integer, unique per hub, e.g. "X3". */
export const ChangeId = Schema.String.check(Schema.isPattern(/^X[1-9][0-9]*$/u)).pipe(
  Schema.brand("ChangeId"),
  Schema.annotate({ identifier: "ChangeId" }),
);
export type ChangeId = typeof ChangeId.Type;

// Patterns stay free of lookarounds so the app's regex engine can run the generated JSON Schema.
const OWNER = "[A-Za-z0-9][A-Za-z0-9-]{0,38}";
const NAME = "[A-Za-z0-9._-]{1,100}";
const REPO = new RegExp(`^(${OWNER})/(${NAME})$`, "u");
const PR_URL = new RegExp(`^https://github\\.com/(${OWNER}/${NAME})/pull/([1-9][0-9]*)$`, "u");

/** GitHub refuses "." and ".." as repo names. */
const isRepo = (repo: string): boolean => {
  const [, , name] = REPO.exec(repo) ?? [];
  return name !== undefined && name !== "." && name !== "..";
};

/** A GitHub repository as "owner/name". */
export const GitHubRepo = Schema.String.check(
  Schema.isPattern(REPO),
  Schema.makeFilter(isRepo, { expected: "a GitHub repository as owner/name" }),
).annotate({ identifier: "GitHubRepo", description: "GitHub repository as owner/name" });

/** The repo and number of a `https://github.com/<owner>/<name>/pull/<n>` URL, or undefined for anything else. */
export const parsePrUrl = (url: string): { readonly repo: string; readonly prNumber: number } | undefined => {
  const [, repo, n] = PR_URL.exec(url) ?? [];
  return repo === undefined || n === undefined || !isRepo(repo) ? undefined : { repo, prNumber: Number(n) };
};

export const GitHubPrUrl = Schema.String.check(
  Schema.isPattern(PR_URL),
  Schema.makeFilter((url) => parsePrUrl(url) !== undefined, { expected: "a PR URL https://github.com/<owner>/<name>/pull/<n>" }),
).annotate({ identifier: "GitHubPrUrl", description: "https://github.com/<owner>/<name>/pull/<n>" });

/** `git patch-id --stable` of the PR diff against its merge base: full lowercase hex, 40 or 64 characters. */
export const PatchId = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)).annotate({
  identifier: "PatchId",
  description: "Full lowercase hex patch id, 40 or 64 characters",
});

/** GitHub matches owner and name case-insensitively, so the URL may differ from `repo` only in case. */
export const prUrlRule = Schema.makeFilter(
  (change: { readonly repo: string; readonly prNumber: number; readonly prUrl: string }) => {
    const parsed = parsePrUrl(change.prUrl);
    if (parsed === undefined) return undefined;
    return parsed.repo.toLowerCase() === change.repo.toLowerCase() && parsed.prNumber === change.prNumber
      ? undefined
      : { path: ["prUrl"], issue: `prUrl must be https://github.com/${change.repo}/pull/${change.prNumber}` };
  },
);

export const ChangeState = Schema.Literals([
  "queued",
  "reviewing",
  "ready",
  "rebasing",
  "ci",
  "merging",
  "merged",
  "needs_rebase",
  "ci_failed",
  "refused",
  "abandoned",
]);
export type ChangeState = typeof ChangeState.Type;

/** One review verdict, valid for exactly this patch. A clean rebase that keeps the patch id keeps it valid. */
export const ChangeReview = Schema.Struct({
  taskId: TaskId,
  prHeadSha: CommitSha,
  patchId: PatchId,
  blocking: Count,
  nonBlocking: Count,
}).annotate({ identifier: "ChangeReview" });
export type ChangeReview = typeof ChangeReview.Type;

export const Change = Schema.Struct({
  changeId: ChangeId,
  projectRef: ProjectRef,
  repo: GitHubRepo,
  prNumber: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  prUrl: GitHubPrUrl,
  /** The PR's head branch. */
  branch: Schema.NonEmptyString,
  /** The write task that opened it; absent when the lead enqueued a PR no task wrote. */
  taskId: Schema.optionalKey(TaskId),
  workstreamId: WorkstreamId,
  serves: Serves,
  /** From the workstream's brief; may be raised, never lowered. */
  tier: Tier,
  headSha: CommitSha,
  patchId: Schema.optionalKey(PatchId),
  state: ChangeState,
  reviews: Schema.Array(ChangeReview),
  /** 0-based index into its train's queue; absent when not queued. */
  position: Schema.optionalKey(Count),
  /** The refusal fix, conflicting paths, or failing check names. */
  lastError: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  /** The squash commit on the base; set on merge. */
  mergedSha: Schema.optionalKey(CommitSha),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
  .check(prUrlRule)
  .annotate({ identifier: "Change" });
export type Change = typeof Change.Type;

/** One serial train per repo. */
export const TrainState = Schema.Struct({
  repo: GitHubRepo,
  /** Held by a `policy.freeze.<repo>` decision. */
  frozen: Schema.Boolean,
  /** The Change being rebased, checked or merged now. */
  head: Schema.optionalKey(ChangeId),
  /** Waiting Changes in train order. */
  queue: Schema.Array(ChangeId).check(Schema.isUnique()),
}).annotate({ identifier: "TrainState" });
export type TrainState = typeof TrainState.Type;
