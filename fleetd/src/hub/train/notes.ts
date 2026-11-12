// The train's waits and the notes it keeps on a Change (service.ts runs the train), and what the lead does next
// about one.
import type { Change } from "../../shared/contracts.ts";

/** Batch PRs in CI at once: the one that lands next, and one behind it. */
export const PIPELINE_DEPTH = 2;
export const REVIEW_WAIT_MS = 15 * 60_000;
export const CHECKS_START_WAIT_MS = 15 * 60_000;
export const CI_RUNNING_TIMEOUT_MS = 45 * 60_000;
export const CI_QUEUE_CEILING_MS = 2 * 60 * 60_000;
export const BLOCKED_WAKE_MS = 30 * 60_000;
export const NEVER_RAN_WAIT_MS = 5 * 60_000;

/** The start of `lastError` on a Change whose CI timed out rather than went red. */
export const CI_TIMED_OUT = "CI timed out";
/** The `lastError` of a Change that left the train with its project (`dropRemovedChanges`). */
export const REMOVED_PROJECT = "its project was removed from fleetd";
export const CI_WATCHED = "the train keeps watching its checks: once they finish green it goes back in the queue, with no push needed";
export const CI_SUPERSEDED = "a push to the PR replaced the head its CI ran on; the train takes the new head";
export const CI_CANCELLED = "its CI timed out, then was cancelled, and re-running it didn't finish it";
export const RESOLVED =
  "enqueued again while its review's findings blocked it: they count no more, and a fresh full review of its patch runs";
export const RESTARTED =
  "enqueued again after its reviewers ended without a verdict: they count no more, and a fresh full review of its patch runs";
export const CI_FINISHED_LATE = "CI finished after the timeout; back in the queue";
/** The reviews' note on a Change its findings block (reviews/service.rs `BLOCKED`). */
export const BLOCKED_PREFIX = "waiting for a new head: ";

/** A Change in `ci_failed` because its CI timed out, not because a check went red. */
export const timedOut = (change: Change) => change.state === "ci_failed" && (change.lastError?.startsWith(CI_TIMED_OUT) ?? false);

/** What the lead does next about a Change: almost always nothing, since the train and reviews move it on. */
export function changeNext(change: Change): string {
  switch (change.state) {
    case "merged":
      return "nothing; it is merged.";
    case "ci_failed":
    case "needs_rebase":
      if (change.state === "ci_failed" && timedOut(change)) return `nothing: its CI timed out, and ${CI_WATCHED}.`;
      return `nothing unless its author is gone: the train told ${change.taskId ?? "you"} what to fix, and it retries the new head by itself.`;
    case "refused":
    case "abandoned":
      return "fix what it says and enqueue the PR again, or drop it.";
    default:
      return "don't merge it yourself or post the fleetd/train status; the train merges it and the outcome arrives in a wake.";
  }
}
