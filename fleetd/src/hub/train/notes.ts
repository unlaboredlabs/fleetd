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
/** How long a PR back with its writer goes with no push before the lead's digest flags it (back.ts). */
export const BACK_IDLE_MS = 30 * 60_000;
export const NEVER_RAN_WAIT_MS = 5 * 60_000;

/** The start of `lastError` on a Change whose CI timed out rather than went red. */
export const CI_TIMED_OUT = "CI timed out";
/** The `lastError` of a Change that left the train with its project (`dropRemovedChanges`). */
export const REMOVED_PROJECT = "its bot was removed from fleetd";
export const CI_WATCHED = "the train keeps watching its checks: once they finish green it goes back in the queue, with no push needed";
export const CI_SUPERSEDED = "a push to the PR replaced the head its CI ran on; the train takes the new head";
export const CI_CANCELLED = "its CI timed out, then was cancelled, and re-running it didn't finish it";
export const RESOLVED =
  "enqueued again while its review's findings blocked it: they count no more, and a fresh full review of its patch runs";
export const RESTARTED =
  "enqueued again after its reviewers ended without a verdict: they count no more, and a fresh full review of its patch runs";
export const CI_FINISHED_LATE = "CI finished after the timeout; back in the queue";
/** A head whose CI timed out, found to be in a repo with no CI (D642): nothing was ever going to report. */
export const NO_CI_REQUEUED = "its repo has no CI, so nothing was ever going to report: back in the queue, it merges on its review alone";
/** The reviews' note on a Change its findings block (reviews/service.rs `BLOCKED`). */
export const BLOCKED_PREFIX = "waiting for a new head: ";

/** A Change in `ci_failed` because its CI timed out, not because a check went red. */
export const timedOut = (change: Change) => change.state === "ci_failed" && (change.lastError?.startsWith(CI_TIMED_OUT) ?? false);

/**
 * What the lead does next about a Change: almost always nothing, since the train and reviews move it on.
 * `peopleMerge`: people merge its bot's PRs, so the train never merges it.
 */
export function changeNext(change: Change, peopleMerge = false): string {
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
      if (peopleMerge || change.lastError === PEOPLE)
        return "nothing: people merge this bot's PRs, and the train merges this one only if every file matches its merges-itself rules. It reviews it and keeps it up to date either way, and says when one waiting for a person is reviewed and green: tell the human then, once. Never merge it yourself.";
      return "don't merge it yourself or post the fleetd/train status; the train merges it and the outcome arrives in a wake.";
  }
}

/** A ready Change's `lastError` while people merge its bot's PRs (its Who merges). */
export const PEOPLE = "held: it waits for a person to merge it on GitHub, by its bot's Who merges and risk rules; a merge there is recorded";
/** A ready Change's `lastError` while its PR has the `hold` label. */
export const HELD = "held: the PR has the `hold` label; the train takes it once the label is gone";
/** The start of a ready Change's `lastError` while the batch forming left it out, followed by why. */
export const LEFT_OUT = "not in this batch: ";
/** A ready Change's `lastError` while its base requires an approving review it doesn't have. */
export const APPROVAL = "held: waiting for a person's approval on GitHub; the train merges it once it is approved";
/**
 * A ready Change the train leaves for a person: its bot's people merge it, its `hold` label, or an approval its base
 * requires. It takes no place in the merge line the apps show, and nor do the PRs behind it count it.
 */
export const waitsForPerson = (c: Change): boolean => c.state === "ready" && (c.lastError === PEOPLE || c.lastError === HELD || c.lastError === APPROVAL);
/** The start of a `ci` Change's `lastError` while its batch passed CI and waits for the batch behind it to land with it. */
export const PASSED_WAITING = "passed, waiting up to ";
/** The note on a batch that passed while it waits up to `waitMs` for batch #`behind`. */
export const passedWaiting = (waitMs: number, behind: number): string => `${PASSED_WAITING}${Math.max(Math.ceil(waitMs / 60_000), 1)} min for batch #${behind} behind it`;
