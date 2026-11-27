// A PR sent back to its writer (needs_rebase, red CI, CI that never ran, its review's blocking findings) stays with its writer until it pushes. The writer hears why at
// once: steered while it runs, continued if its turn ended, or held for the wait it armed (its wait_ci, a Monitor)
// so that wait's wake carries it instead of a second one. A conflicting PR gets no CI and doesn't move on the train,
// so a wait on it never fires and doesn't count: its writer is continued. A writer whose turn then ends with no push and nothing armed
// is continued once more by the train's next pass. One that can't be (cancelled) hands the PR on: to a live writer
// already pointed at it, else to a fresh writer on its branch, which becomes the PR's writer; the lead hears only when
// neither can take it, and of a writer the train can't read at all. Once per send-back: the Change's `back` wait, at its head, says whether a writer was woken
// for it yet. Its start is when the PR went back, which the lead's digest reads for a PR left with no push (notes.ts `BACK_IDLE_MS`).
import type { Change } from "../../shared/contracts.ts";
import { openBlocking } from "../reviews/read.ts";
import { oneLine, prNote } from "./events.ts";
import { BLOCKED_PREFIX } from "./notes.ts";
import { fixYourPr } from "./prompts.ts";
import { type ChangeRecords, WAIT_BACK } from "./records.ts";
import { TRAIN_BY, type Train } from "./service.ts";

/** The `back` wait's states: its writer was told and may still end without a push, or was continued for it. */
const TOLD = "told";
const WOKEN = "woken";

/** Whether the Change waits on its writer's push: parked by the train, or held in review by blocking findings. */
export function isBack(c: Change): boolean {
  return c.state === "needs_rebase" || c.state === "ci_failed" || (c.state === "reviewing" && c.lastError?.startsWith(BLOCKED_PREFIX) === true);
}

/** Records the send-back of `change`, as stored now, as `state`: each send-back starts its own, at now. */
function mark(t: Train, change: Change, state: string): void {
  const c = t.records.get(change.changeId) ?? change;
  if (!isBack(c)) return;
  t.records.endWait(c.changeId, WAIT_BACK);
  t.records.startWait(c, WAIT_BACK, c.headSha, t.nowMs(), state);
}

/** Whether the Change went back conflicting with its base (`needsRebase`), not for work it would undo, which gets CI. */
const conflicting = (c: Change) => c.state === "needs_rebase" && c.lastError?.startsWith("conflicts with ") === true;

/** What the ended writer `taskId` of `change` waits on that will wake it: none of its waits on a conflicting PR. */
function waitingOn(t: Train, change: Change, taskId: string): string | undefined {
  return t.host.waitingOn?.(taskId, conflicting(change) ? change.prUrl : undefined);
}

/** `text` from `by` to the writer `taskId` of `change`; why it could not take it, else undefined. */
export async function tellWriter(t: Train, change: Change, taskId: string, text: string, by = TRAIN_BY): Promise<string | undefined> {
  const state = t.host.task(taskId)?.state;
  if (state === "cancelled" && t.host.spawnWriter) {
    // Marked woken first, so no second writer ever starts for this send-back; a live writer it goes to is told (handOn).
    mark(t, change, WOKEN);
    return handOn(t, change, taskId, text);
  }
  const ended = state === "done" || state === "failed";
  if (state === "done" && waitingOn(t, change, taskId) !== undefined && t.host.holdMessage) {
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
  if (task?.state === "done" && waitingOn(t, change, taskId) !== undefined) return;
  t.records.setWait(change.changeId, WAIT_BACK, change.headSha, WOKEN);
  const why = oneLine(change.lastError ?? "", 300);
  if (task?.state === "cancelled" && t.host.spawnWriter) {
    const text = fixYourPr(t.promptSet(change), change, `the merge train sent it back: ${why}`, openBlocking(t.records.db, change.prUrl));
    const failed = await handOn(t, change, taskId, text);
    if (failed !== undefined) {
      await t.wakeLead(change.projectRef, prNote(change.changeId, change.prUrl, `back with its author and no push since: ${why}; its writer ${taskId} was cancelled, and ${failed}, so it is yours to hand on`));
    }
    return;
  }
  if (task === undefined || task.state === "cancelled") {
    // Unread may mean only that its record could not be read now: no second writer starts on that.
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

/** How much of the old writer's last words a fresh writer's handoff carries. */
const HANDOFF_TAIL = 600;

/**
 * Hands `change`, sent back with `text`, from its cancelled writer `taskId` to another: a live write task already
 * pointed at its PR is told, else a fresh writer starts on its branch. That one becomes the PR's writer, so the next
 * send-back goes to it. Why neither could take it, else undefined.
 */
async function handOn(t: Train, change: Change, taskId: string, text: string): Promise<string | undefined> {
  const live = t.host.tasksUnderWay?.(change.projectRef).find((w) => w.pr === change.prUrl && w.taskId !== taskId);
  if (live) {
    try {
      await t.host.messageTask(change.projectRef, TRAIN_BY, live.taskId, text);
    } catch (error) {
      return `telling ${live.taskId}, already on it, failed: ${(error as Error).message}`;
    }
    adopt(t, change, live.taskId);
    // Told as any running writer is: continued once if its turn ends with no push and nothing armed.
    t.records.setWait(change.changeId, WAIT_BACK, change.headSha, TOLD);
    console.info(`train: ${change.changeId} back with ${taskId}, which was cancelled: handed to ${live.taskId}, already on its PR`);
    return undefined;
  }
  const old = t.host.task(taskId);
  const tail = old?.resultTail ? `\n\nIts last words: ${oneLine(old.resultTail, HANDOFF_TAIL)}` : "";
  const prompt =
    `You take over the PR ${change.prUrl} (${change.changeId}) from its writer ${taskId}, which was cancelled: the merge train sent it back, and ` +
    `nobody else works on it. Its old worktree may still hold its branch ${change.branch}, so don't check that branch out: put ` +
    `yours on it (\`git fetch origin ${change.branch} && git reset --hard FETCH_HEAD\`), then push to it ` +
    `(\`git push origin HEAD:${change.branch}\`, with --force-with-lease after a rebase), so the same PR moves on. Open no new PR.` +
    `${tail}\n\n${text}`;
  let spawned;
  try {
    spawned = await t.host.spawnWriter!({
      projectRef: change.projectRef,
      by: TRAIN_BY,
      workstreamId: change.workstreamId,
      title: `Fix ${prLabel(change)}, sent back by the merge train`,
      prompt,
      pr: change.prUrl,
      ...(old?.profile !== undefined ? { profile: old.profile } : {}),
      notDuplicateOf: [change.changeId, taskId],
      notDuplicateWhy: `the PR's own writer ${taskId} was cancelled: this one takes the PR over`,
    });
  } catch (error) {
    return `starting a fresh writer for it failed: ${(error as Error).message}`;
  }
  adopt(t, change, spawned.taskId);
  console.info(`train: ${change.changeId} back with ${taskId}, which was cancelled: fresh writer ${spawned.taskId} on ${change.branch}`);
  return undefined;
}

/** `taskId` is the writer of `change` from now on. */
function adopt(t: Train, change: Change, taskId: string): void {
  t.update(change.changeId, undefined, (c) => ({ ...c, taskId }));
}

/** `fleetd#12` for the PR of `change`. */
const prLabel = (change: Change) => `${change.repo.split("/").at(-1)}#${change.prNumber}`;

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
