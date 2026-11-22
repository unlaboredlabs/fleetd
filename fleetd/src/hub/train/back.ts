// A PR sent back to its writer (needs_rebase, red CI, its review's blocking findings) stays with its writer until it pushes. The writer hears why at
// once: steered while it runs, continued if its turn ended, or held for the wait it armed (its wait_ci, a Monitor)
// so that wait's wake carries it instead of a second one. A writer whose turn then ends with no push and nothing armed
// is continued once more by the train's next pass; one that can't be (cancelled) is the lead's. Once per send-back:
// the Change's `back` wait, at its head, says whether its writer was continued for it yet. Its start is when the PR
// went back, which the lead's digest reads for a PR left with no push (`BACK_IDLE_MS`).
import type { Change } from "../../shared/contracts.ts";
import { openBlocking } from "../reviews/read.ts";
import { oneLine, prNote } from "./events.ts";
import { BLOCKED_PREFIX } from "./notes.ts";
import { fixYourPr } from "./prompts.ts";
import { type ChangeRecords, WAIT_BACK } from "./records.ts";
import { TRAIN_BY, type Train } from "./service.ts";

/** How long a sent-back PR goes with no push before the lead's digest flags it. */
export const BACK_IDLE_MS = 30 * 60_000;
/** The `back` wait's states: its writer was told and may still end without a push, or was continued for it. */
const TOLD = "told";
const WOKEN = "woken";

/** Whether the Change waits on its writer's push: parked by the train, or held in review by blocking findings. */
export function isBack(c: Change): boolean {
  return c.state === "needs_rebase" || c.state === "ci_failed" || (c.state === "reviewing" && c.lastError?.startsWith(BLOCKED_PREFIX) === true);
}

/** Records the send-back of `change`, as stored now, as `state`; a send-back at the head it was at keeps its start. */
function mark(t: Train, change: Change, state: string): void {
  const c = t.records.get(change.changeId) ?? change;
  if (!isBack(c)) return;
  if (!t.records.startWait(c, WAIT_BACK, c.headSha, t.nowMs(), state)) t.records.setWait(c.changeId, WAIT_BACK, c.headSha, state);
}

/** `text` from `by` to the writer `taskId` of `change`; why it could not take it, else undefined. */
export async function tellWriter(t: Train, change: Change, taskId: string, text: string, by = TRAIN_BY): Promise<string | undefined> {
  const state = t.host.task(taskId)?.state;
  const ended = state === "done" || state === "failed";
  if (state === "done" && t.host.waitingOn?.(taskId) !== undefined && t.host.holdMessage) {
    try {
      await t.host.holdMessage(change.projectRef, by, taskId, text);
    } catch (error) {
      mark(t, change, WOKEN);
      return (error as Error).message;
    }
    mark(t, change, TOLD);
    return undefined;
  }
  try {
    await t.host.messageTask(change.projectRef, by, taskId, text);
  } catch (error) {
    // The lead hears of it instead: nothing for the next pass to wake.
    mark(t, change, WOKEN);
    return (error as Error).message;
  }
  mark(t, change, ended ? WOKEN : TOLD);
  return undefined;
}

/** On each pass over a Change back with its writer: its writer, ended since it was told with no push and no wait armed, is continued. */
export async function stillBack(t: Train, change: Change): Promise<void> {
  const taskId = change.taskId;
  const w = t.records.wait(change.changeId, WAIT_BACK);
  if (taskId === undefined || !isBack(change) || w?.head !== change.headSha || w.state !== TOLD) return;
  const task = t.host.task(taskId);
  if (task?.state === "running" || task?.state === "queued" || task?.state === "idle") return;
  if (task?.state === "done" && t.host.waitingOn?.(taskId) !== undefined) return;
  t.records.setWait(change.changeId, WAIT_BACK, change.headSha, WOKEN);
  const why = oneLine(change.lastError ?? "", 300);
  if (task === undefined || task.state === "cancelled") {
    const writer = task === undefined ? `its writer ${taskId} is gone` : `its writer ${taskId} was cancelled`;
    await t.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, `back with its author and no push since: ${why}; ${writer}, so it is yours to hand on`));
    return;
  }
  const min = Math.round((t.nowMs() - w.sinceMs) / 60_000);
  const problem = `it is still back with you, with no push since the merge train sent it back ${min} min ago, and your turn ended with nothing armed to wake you: ${why}`;
  const text = fixYourPr(t.promptSet(change), change, problem, openBlocking(t.records.db, change.prUrl));
  console.info(`train: ${change.changeId} still back with ${taskId}, which ended with no push: continued`);
  try {
    await t.host.messageTask(change.projectRef, TRAIN_BY, taskId, text);
  } catch (error) {
    await t.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, `back with its author and no push since: ${why}; continuing its writer ${taskId} failed: ${(error as Error).message}`));
  }
}

/** When each Change of `changes` back with its writer went back, where the train knows. */
export function backSince(records: ChangeRecords, changes: Change[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of changes) {
    if (!isBack(c)) continue;
    const w = records.wait(c.changeId, WAIT_BACK);
    if (w?.head === c.headSha) out[c.changeId] = w.sinceMs;
  }
  return out;
}
