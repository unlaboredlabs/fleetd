// What the hub sweep does for tasks, and the machine breaker's lines. The
// sweep itself and the breaker's wiring are `Tasks` methods (index.ts); these are their pure parts.
//
// Orphans (G2): a task the hub thinks runs, on a machine whose node is linked, whose thread has had no event for 2 min
// and no longer runs there: its run's end is applied now, or it fails for its lead to decide on. The other way round,
// a session the node runs that no task or lead owns is reported once (`thread.orphaned`).
import type { HubEvent, HubEventType, Task, TaskId, ThreadRef, ThreadSummary } from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";
import { WINDOW_MS } from "./breaker.ts";
import { oneLine } from "./render.ts";

/** A running task's thread this quiet, no longer running on its linked node, is an orphan. */
export const ORPHAN_MS = 2 * 60_000;

export const END_EVENTS: HubEventType[] = ["thread.completed", "thread.failed", "thread.interrupted", "thread.usage_limited"];
/** A run's own thread events the tasks' follower acts on: its start, its wait on a person, its ends. */
export const RUN_EVENTS: HubEventType[] = ["thread.started", "thread.waiting", ...END_EVENTS];

/** A session no task or lead owns, for the doctor. */
export type Unowned = { threadId: string; title: string };

/** "10:42 UTC" from epoch milliseconds. */
export function clockTime(ms: number): string {
  const t = isoMs(ms).slice(11, 16);
  return t.length === 5 ? `${t} UTC` : "";
}

export const list = (ids: TaskId[]) => ids.join(", ");

/** The lead's line when its machine's breaker opens: once, with its own agents that now wait. */
export function pausedLines(machine: string, openedBy: TaskId[], untilMs: number, waiting: TaskId[]): string {
  const head = `- Automatic recovery is paused on ${machine}: ${openedBy.length} agents died there within ${WINDOW_MS / 60_000} min (${list(openedBy)}), claude exiting or stalling each time.`;
  const theirs =
    waiting.length === 0 ? "None of yours waits on it" : waiting.length === 1 ? `${waiting[0]} waits to resume` : `${list(waiting)} wait to resume`;
  return `${head}\n  > ${theirs}; dead agents there resume again at ${clockTime(untilMs)} if no other dies, or once one there completes. To go on sooner, continue one with message_agent; stop_agent ends it.`;
}

/** An event as the log stores it, which leaves its seq to the row. */
export function storedEvent(seq: number, data: string): HubEvent {
  const value = JSON.parse(data) as HubEvent;
  return { ...value, seq: Math.max(seq, 1) };
}

export const renderSummary = (text: string) => oneLine(text, 200);

/** What `syntheticEnd` reads of the hub's row of a thread (the store's `StoredThread`). */
export type ThreadRow = { thread: ThreadSummary; lastRunId?: string; lastRunStatus?: string };

/** A thread end as the hub's row of the thread says it went, for a run whose end the hub never logged. */
export function syntheticEnd(task: Task, thread: ThreadRef, row: ThreadRow, now: number): HubEvent {
  const t = row.thread;
  const type: HubEventType =
    row.lastRunStatus === "usage_limited"
      ? "thread.usage_limited"
      : t.status === "completed"
        ? "thread.completed"
        : t.status === "failed"
          ? "thread.failed"
          : "thread.interrupted";
  const data: Record<string, unknown> = { status: t.status };
  if (row.lastRunId !== undefined) data.runId = row.lastRunId;
  if (t.lastError) data.error = { class: t.lastError.class, message: t.lastError.message };
  if (t.endCause !== undefined) data.endCause = t.endCause;
  if (t.usageLimitResetAt !== undefined) data.usageLimitResetAt = t.usageLimitResetAt;
  data.reconciled = true;
  return {
    seq: 0,
    at: isoMs(now),
    type,
    machineId: thread.machineId,
    projectId: task.projectRef.projectId,
    threadId: thread.threadId,
    summary: "",
    data,
  } as HubEvent;
}
