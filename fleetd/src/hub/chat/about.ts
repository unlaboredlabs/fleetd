// Which order a chat message is about and which person it is for, set by the hub from what the lead already does,
// never from a judgement of the lead per message (artifact threads-design). A lead turn that touched exactly one
// order is about it: a call it made for that order (`touched`), or a wake all about it. Its messages are for the
// order's starter, else the person whose message the turn answered. A request (a card) is about its order.
import type { HumanRequest, PersonRef, ProjectRef, WorkstreamId } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { readWorkstream } from "../leads/records.ts";
import { runHuman, runWindow } from "../leads/requested.ts";
import { nowMs } from "../store/time.ts";

/** The lead calls that act on one order: what the turn did for it. Reading (brief_read, task_list) touches nothing. */
export const TOUCHING_OPS: readonly string[] = ["brief_create", "close", "task_spawn", "task_message", "task_cancel", "request_secret", "gated_run"];

/** How long a touch is kept: far longer than any turn. */
const TOUCH_KEPT_MS = 24 * 60 * 60_000;

type Touch = { workstreamId: WorkstreamId; atMs: number };

const keyOf = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

/**
 * The orders each project's lead acted on, as its calls came: kept in memory, so a hub restart mid-turn forgets the
 * turn's touches and its messages stay untagged, which shows no tag.
 */
const touches = (hub: Hub) => hub.area("chat_about_touches", () => new Map<string, Touch[]>());

/** The lead of `r` acted on `workstreamId` (one of TOUCHING_OPS). */
export function touched(hub: Hub, r: ProjectRef, workstreamId: WorkstreamId, atMs = nowMs(hub.clock)): void {
  const map = touches(hub);
  const key = keyOf(r);
  const kept = (map.get(key) ?? []).filter((t) => atMs - t.atMs < TOUCH_KEPT_MS);
  kept.push({ workstreamId, atMs });
  map.set(key, kept);
}

/** The order a lead call names: its result's or its own `workstreamId`, an `order:` sink's, or its task's. */
export function callOrder(hub: Hub, call: Record<string, unknown>, result: Record<string, unknown> | undefined): WorkstreamId | undefined {
  const named = [result?.workstreamId, call.workstreamId].find((w): w is string => typeof w === "string" && /^W[1-9][0-9]*$/.test(w));
  if (named) return named;
  const sink = typeof call.sink === "string" ? /^order:(W[1-9][0-9]*)\b/.exec(call.sink)?.[1] : undefined;
  if (sink) return sink;
  return typeof call.taskId === "string" ? taskOrder(hub, call.taskId) : undefined;
}

/** The order task `taskId` (`T<n>`) works for. */
export function taskOrder(hub: Hub, taskId: string): WorkstreamId | undefined {
  const n = Number(taskId.slice(1));
  if (!/^T[1-9][0-9]*$/.test(taskId)) return undefined;
  return hub.db.all<{ w: string }>("SELECT workstream_id AS w FROM tasks WHERE n = ?1", [n])[0]?.w;
}

/** The order of the task running in session `threadId` on `machineId`. */
export function threadOrder(hub: Hub, machineId: string, threadId: string): WorkstreamId | undefined {
  return hub.db.all<{ w: string }>("SELECT workstream_id AS w FROM tasks WHERE machine_id = ?1 AND thread_id = ?2 ORDER BY n DESC LIMIT 1", [
    machineId,
    threadId,
  ])[0]?.w;
}

/** The order a request (a secret or approval card) is about: its own, else (a task's tool prompt) its task's. */
export function requestOrder(hub: Hub, request: HumanRequest): WorkstreamId | undefined {
  if (request.workstreamId !== undefined) return request.workstreamId;
  const thread = request.permission?.threadId;
  return thread === undefined ? undefined : threadOrder(hub, request.projectRef.machineId, thread);
}

/** Who started the order: its `startedBy`. Undefined for one no person started (an automation's, the train's). */
export function orderFor(hub: Hub, workstreamId: WorkstreamId): PersonRef | undefined {
  return readWorkstream(hub.db.conn, workstreamId)?.startedBy;
}

/** The lead's thread of `r`. */
function leadThread(hub: Hub, r: ProjectRef): string | undefined {
  return hub.db.all<{ thread_id: string }>("SELECT thread_id FROM leads WHERE machine_id = ?1 AND project_id = ?2", [r.machineId, r.projectId])[0]?.thread_id;
}

/** The lead's run that holds `atMs`: from when the run before it ended to when it ended (still running: now). */
function runAt(hub: Hub, r: ProjectRef, thread: string, atMs: number): { fromMs: number; toMs: number } {
  const { since } = runWindow(hub.db, r, thread, atMs);
  const end = hub.db.all<{ created_ms: number }>(
    `SELECT created_ms FROM events
     WHERE type IN ('thread.completed', 'thread.failed', 'thread.interrupted', 'thread.usage_limited')
       AND machine_id = ?1 AND created_ms > ?2 AND json_extract(data, '$.threadId') = ?3
     ORDER BY seq LIMIT 1`,
    [r.machineId, atMs, thread],
  )[0];
  return { fromMs: since, toMs: end?.created_ms ?? Math.max(nowMs(hub.clock), atMs) };
}

/** The orders the lead's run holding `atMs` touched: its calls' orders, and each wake of it all about one order. */
export function turnOrders(hub: Hub, r: ProjectRef, atMs: number): WorkstreamId[] {
  const thread = leadThread(hub, r);
  if (thread === undefined) return [];
  const { fromMs, toMs } = runAt(hub, r, thread, atMs);
  const out = new Set<WorkstreamId>();
  for (const t of touches(hub).get(keyOf(r)) ?? []) if (t.atMs > fromMs && t.atMs <= toMs) out.add(t.workstreamId);
  const wakes = hub.db.all<{ ids: string | null }>(
    `SELECT json_extract(data, '$.data.workstreamIds') AS ids FROM events
     WHERE type = 'lead.woken' AND machine_id = ?1 AND json_extract(data, '$.projectId') = ?2
       AND created_ms > ?3 AND created_ms <= ?4`,
    [r.machineId, r.projectId, fromMs, toMs],
  );
  for (const w of wakes) {
    let ids: unknown;
    try {
      ids = w.ids ? JSON.parse(w.ids) : [];
    } catch {
      ids = [];
    }
    if (Array.isArray(ids) && ids.length === 1 && typeof ids[0] === "string") out.add(ids[0]);
  }
  return [...out];
}

/** The one order the lead's run holding `atMs` touched; none or several: undefined. */
export function turnOrder(hub: Hub, r: ProjectRef, atMs: number): WorkstreamId | undefined {
  const orders = turnOrders(hub, r, atMs);
  return orders.length === 1 ? orders[0] : undefined;
}

/**
 * What a lead message said at `atMs` is about and whom it is for: the one order its turn touched, and that order's
 * starter, else the person whose message the turn answered.
 */
export function aboutFor(hub: Hub, r: ProjectRef, atMs: number): { workstreamId?: WorkstreamId; for?: PersonRef } {
  const workstreamId = turnOrder(hub, r, atMs);
  const starter = workstreamId === undefined ? undefined : orderFor(hub, workstreamId);
  const thread = leadThread(hub, r);
  const person = starter ?? (thread === undefined ? undefined : runHuman(hub.db, r, thread, atMs)?.person);
  return { ...(workstreamId !== undefined ? { workstreamId } : {}), ...(person !== undefined ? { for: person } : {}) };
}
