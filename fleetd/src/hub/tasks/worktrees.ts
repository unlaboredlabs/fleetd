// The nightly worktree sweep: hub work, no model turn. A task's worktree
// goes when it ends (a review's) or when its PR merges (a writer's); a reader's, a cancelled writer's, one whose PR
// closed unmerged, and a removal that failed stay behind.
// Around 04:00 in `policy.tz` (else the hub's zone), and once soon after the hub starts, the sweep has the node remove
// the worktree of every task that ended over `policy.worktree_days` (3) days ago, through its safe removal. One holding
// work that exists only there is kept and the person is told once, in one line a sweep listing all it kept there; one
// the node couldn't remove is tried again the next night, up to MAX_TRIES times, then given up on with one line to the
// person. Each sweep also cancels tasks still queued under an order that closed.
import type { KeptWorktree, ProjectRef, Task } from "../../shared/contracts.ts";
import { hubZone } from "../../cli/steer.ts";
import type { Hub } from "../api/hub.ts";
import { isoMs } from "../store/time.ts";
import type { Tasks } from "./index.ts";
import { PortError } from "./ports.ts";
import { TaskRecords } from "./records.ts";
import {
  AFTER_START_MS,
  closedOrderReason,
  DAY_MS,
  givenUpLine,
  holdsWork,
  keptSummary,
  keptWorktree,
  MAX_TRIES,
  nextRunMs,
  POLICY_TZ_KEY,
  unsaved,
  validZone,
  WORKTREE_DAYS,
  WORKTREE_DAYS_KEY,
  WORKTREES_KEPT_MAX,
} from "./worktree_rules.ts";

export { keptSummary, MAX_TRIES, nextRunMs, POLICY_TZ_KEY, unsaved, WORKTREE_DAYS, WORKTREE_DAYS_KEY };

/** What one sweep did. */
export type Swept = { removed: number; kept: number; failed: number };

const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

function into<T>(groups: [ProjectRef, T[]][], r: ProjectRef, item: T): void {
  const g = groups.find(([p]) => sameProject(p, r));
  if (g) g[1].push(item);
  else groups.push([r, [item]]);
}

/** One sweep of the worktrees of tasks that ended over `policy.worktree_days` days ago, one at a time. */
export async function sweepWorktrees(tasks: Tasks): Promise<Swept> {
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
    ports.tellPerson(r, givenUpLine(ids));
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
      await tasks.cancel({ projectRef: task.projectRef, by: "hub" }, task.taskId, closedOrderReason(order.workstreamId));
      console.info(`a task queued under a closed order was cancelled (${task.taskId}, ${order.workstreamId})`);
      cancelled += 1;
    } catch (error) {
      console.warn(`a task queued under a closed order was not cancelled (${task.taskId}):`, error);
    }
  }
  return cancelled;
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
