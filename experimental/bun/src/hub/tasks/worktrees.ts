// The nightly worktree sweep (crates/fleetd/src/hub/tasks/worktrees.rs): hub work, no model turn. A task's worktree
// goes when it ends (a review's) or when its PR merges (a writer's); a reader's, a cancelled writer's, one whose PR
// closed unmerged, and a removal that failed stay behind.
// Around 04:00 in `policy.tz` (else the hub's zone), and once soon after the hub starts, the sweep has the node remove
// the worktree of every task that ended over `policy.worktree_days` (3) days ago, through its safe removal. One holding
// work that exists only there is kept and the person is told once, in one line a sweep listing all it kept there; one
// the node couldn't remove is tried again the next night, up to MAX_TRIES times, then given up on with one line to the
// person; a cloud machine asleep is no failure. Each sweep also cancels tasks still queued under an order that closed.
import type { KeptWorktree, MachineId, ProjectRef, Task } from "../../shared/contracts.ts";
import { hubZone, zoned } from "../../cli/steer.ts";
import { zonedToUtc } from "../../cli/time.ts";
import type { Hub } from "../api/hub.ts";
import { isoMs } from "../store/time.ts";
import type { Tasks } from "./index.ts";
import { PortError } from "./ports.ts";
import { TaskRecords } from "./records.ts";

/** The global decision setting how many days after its task ended a worktree goes. */
export const WORKTREE_DAYS_KEY = "policy.worktree_days";
export const WORKTREE_DAYS = 3;
/** The global decision naming the hub's zone for its clock times. */
export const POLICY_TZ_KEY = "policy.tz";
/** The local hour the sweep runs at. */
const HOUR = 4;
/** The first sweep after the hub starts, once its nodes have had time to link. */
const AFTER_START_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
/** Failed tries, one a night, before the sweep gives a worktree up. */
export const MAX_TRIES = 7;
/** Kept worktrees in one chat line (fleetd-contracts chat.rs `WORKTREES_KEPT_MAX`). */
const WORKTREES_KEPT_MAX = 200;
// The node's words for a worktree it kept (node/worktree.rs).
const KEPT = "kept ";
const UNCOMMITTED = "it has uncommitted changes";
const UNPUSHED = "not pushed";

/** What one sweep did. */
export type Swept = { removed: number; kept: number; failed: number };

/** Whether the node kept the worktree for work that exists only there, by its own words. */
const holdsWork = (message: string) => message.includes(KEPT) && (message.includes(UNCOMMITTED) || message.includes(UNPUSHED));

/** "uncommitted changes" or "2 unpushed commits", from the node's `<why>`. */
export function unsaved(why: string): string {
  const n = why.endsWith(UNPUSHED) ? why.slice(0, -UNPUSHED.length).trimEnd() : undefined;
  const count = n?.endsWith("commit(s)") ? n.slice(0, -"commit(s)".length).trim() : undefined;
  if (count !== undefined && /^[0-9]+$/.test(count)) return Number(count) === 1 ? "1 unpushed commit" : `${Number(count)} unpushed commits`;
  return why.startsWith("it has ") ? why.slice("it has ".length) : why;
}

/** A worktree kept for its work, as the person's line lists it. */
function keptWorktree(task: Task, machine: MachineId, message: string): KeptWorktree {
  // `... kept <path>: <why>`
  const at = message.lastIndexOf(KEPT);
  const kept = at >= 0 ? message.slice(at + KEPT.length) : "";
  const colon = kept.indexOf(": ");
  const [path, why] = colon >= 0 ? [kept.slice(0, colon), kept.slice(colon + 2)] : [kept, "work"];
  return { title: task.title, unsaved: unsaved(why), machineId: machine, path };
}

/** The text of a line listing `n` kept worktrees. */
export const keptSummary = (n: number) => `Cleanup kept ${n} ${n === 1 ? "worktree" : "worktrees"} with unsaved work`;

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

function into<T>(groups: [ProjectRef, T[]][], r: ProjectRef, item: T): void {
  const g = groups.find(([p]) => sameProject(p, r));
  if (g) g[1].push(item);
  else groups.push([r, [item]]);
}

/**
 * One sweep of the worktrees of tasks that ended over `policy.worktree_days` days ago, one at a time; `only`, one
 * machine's (a cloud machine's catch-up as it wakes). A sleeping cloud machine's are left, with no try counted.
 */
export async function sweepWorktrees(tasks: Tasks, only?: MachineId): Promise<Swept> {
  const db = tasks.hub.db.conn;
  const ports = tasks.ports;
  const set = Number.parseInt(ports.globalDecision(WORKTREE_DAYS_KEY) ?? "", 10);
  const days = Number.isInteger(set) && set > 0 ? set : WORKTREE_DAYS;
  const before = isoMs(tasks.hub.clock.now() - days * DAY_MS);
  const swept: Swept = { removed: 0, kept: 0, failed: 0 };
  let ended: [Task, boolean][];
  try {
    ended = TaskRecords.unswept(db, before);
  } catch (error) {
    console.warn("worktree sweep: tasks not read:", error);
    return swept;
  }
  const givenUp: [ProjectRef, string[]][] = [];
  const kept: [ProjectRef, KeptWorktree[]][] = [];
  for (const [task, flagged] of ended) {
    const thread = task.threadRef;
    if (!thread) continue;
    if ((only !== undefined && only !== thread.machineId) || (only === undefined && ports.asleep(thread.machineId))) continue;
    let seen: string;
    try {
      await ports.removeWorktree(thread);
      swept.removed += 1;
      seen = "removed";
    } catch (error) {
      const e = error instanceof PortError ? error : new PortError(false, String(error));
      if (!e.offline && holdsWork(e.message)) {
        swept.kept += 1;
        if (!flagged) into(kept, task.projectRef, keptWorktree(task, thread.machineId, e.message));
        seen = "flagged";
      } else {
        swept.failed += 1;
        let tries = MAX_TRIES;
        try {
          tries = TaskRecords.worktreeFailed(db, task.taskId);
        } catch {}
        if (tries < MAX_TRIES) {
          console.warn(`worktree sweep: not removed, tried again next time (${task.taskId}, ${tries} tries): ${e.message}`);
          continue;
        }
        console.warn(`worktree sweep: not removed, given up (${task.taskId}, ${tries} tries): ${e.message}`);
        into(givenUp, task.projectRef, `${task.taskId} on ${thread.machineId}`);
        seen = "given_up";
      }
    }
    try {
      TaskRecords.setWorktree(db, task.taskId, seen);
    } catch (error) {
      console.warn(`worktree sweep: outcome not recorded (${task.taskId}):`, error);
    }
  }
  for (const [r, items] of kept) {
    for (let i = 0; i < items.length; i += WORKTREES_KEPT_MAX) {
      const chunk = items.slice(i, i + WORKTREES_KEPT_MAX);
      ports.tellKept(r, { items: chunk }, keptSummary(chunk.length));
    }
  }
  for (const [r, ids] of givenUp) {
    ports.tellPerson(
      r,
      `Stopped trying to remove the worktrees of finished agents ${ids.join(", ")} after ${MAX_TRIES} nightly tries: the machine was offline or git refused. If the machine is still in use, delete them by hand under ~/.fleetd/node/worktrees.`,
    );
  }
  return swept;
}

/** Cancels the tasks still queued under an order that is no longer open, which the queue never starts. */
export async function cancelClosedQueued(tasks: Tasks): Promise<number> {
  let queued: ReturnType<typeof TaskRecords.queued>;
  try {
    queued = TaskRecords.queued(tasks.hub.db.conn);
  } catch (error) {
    console.warn("tasks under closed orders: queue not read:", error);
    return 0;
  }
  let cancelled = 0;
  for (const { task } of queued) {
    const order = tasks.ports.workstream(task.workstreamId);
    if (!order || order.state === "open") continue;
    try {
      await tasks.cancel({ projectRef: task.projectRef, by: "hub" }, task.taskId, `Cancelled: its order ${order.workstreamId} is closed.`);
      console.info(`a task queued under a closed order was cancelled (${task.taskId}, ${order.workstreamId})`);
      cancelled += 1;
    } catch (error) {
      console.warn(`a task queued under a closed order was not cancelled (${task.taskId}):`, error);
    }
  }
  return cancelled;
}

const validZone = (name: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The next HOUR:00 in `zone` after `nowMs`. A day whose HOUR:00 doesn't exist (a clock change) is skipped. */
export function nextRunMs(nowMs: number, zone: string): number {
  const z = zoned(nowMs, zone);
  let day = Date.UTC(Number(z.year), MONTHS.indexOf(z.month as string), Number(z.day));
  if (Number(z.hour) >= HOUR) day += DAY_MS;
  for (;;) {
    const d = new Date(day);
    const at = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), HOUR, 0, zone);
    const back = zoned(at, zone);
    if (Number(back.hour) === HOUR && Number(back.minute) === 0 && at > nowMs) return at;
    day += DAY_MS;
  }
}

/** The sweep soon after the start, then nightly, until the hub stops. */
export async function run(hub: Hub, tasks: Tasks, sleep: (ms: number) => Promise<void>): Promise<void> {
  await sleep(AFTER_START_MS);
  while (!hub.shutdown.signal.aborted) {
    const cancelled = await cancelClosedQueued(tasks);
    if (cancelled > 0) console.info(`${cancelled} tasks queued under closed orders cancelled`);
    const swept = await sweepWorktrees(tasks);
    if (swept.removed + swept.kept + swept.failed > 0) console.info("worktree sweep:", swept);
    const name = tasks.ports.globalDecision(POLICY_TZ_KEY);
    const zone = name !== undefined && validZone(name) ? name : hubZone();
    const now = hub.clock.now();
    await sleep(Math.max(nextRunMs(now, zone) - now, 60_000));
  }
}
