// The `steers` table (crates/fleetd/src/hub/steer/store.rs): one row per steer, `n` its S<n>, `data` the Steer with
// its receipt.
import type { Database } from "bun:sqlite";
import type { Steer } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";

/** A new steer's row; `id` is filled from the row's number. */
export type NewSteer = {
  steer: Steer;
  taskId?: string;
  /** `key:<id>` for a person, `lead` for a lead, `agent:T<n>` for another agent. */
  by: string;
  /** `steer:<by>:<clientRequestId>`: a resent request returns this steer, whatever its stage. */
  request: string;
  queuedMs: number;
};

export const steerN = (id: string) => (/^S[0-9]+$/.test(id) ? Number(id.slice(1)) : undefined);

/** The steer in the Rust struct's field order, so rows read the same. */
export function encode(s: Steer): string {
  const o: Record<string, unknown> = {
    id: s.id,
    target: s.target,
    workstreamId: s.workstreamId,
    thread: s.thread,
    runId: s.runId,
    by: s.by,
    mode: s.mode,
    text: s.text,
    stage: s.stage,
    queuedAt: s.queuedAt,
  };
  for (const k of ["deliveredAt", "how", "stoppedTool", "seenAt", "ackedAt", "ackExcerpt", "detail", "held"] as const) if (s[k] !== undefined) o[k] = s[k];
  return JSON.stringify(o);
}

const decode = (data: string) => JSON.parse(data) as Steer;

function byRun(c: Database, runId: string): Steer | undefined {
  const row = c.query<{ data: string }, [string]>("SELECT data FROM steers WHERE run_id = ?").get(runId);
  return row ? decode(row.data) : undefined;
}

/** Stores a new steer, or returns the one already stored for its request (a retried request, at any stage). */
export function insert(db: HubDb, n: NewSteer): { steer: Steer; created: boolean } {
  const c = db.conn;
  const existing = c.query<{ data: string }, [string]>("SELECT data FROM steers WHERE request = ?").get(n.request);
  // Rows stored before requests were: their run id is still the one the request derives.
  const found = existing ? decode(existing.data) : byRun(c, n.steer.runId);
  if (found) return { steer: found, created: false };
  const s = n.steer;
  const row = c
    .query(
      `INSERT INTO steers (workstream_id, task_id, machine_id, thread_id, run_id, by, mode, stage, queued_ms, request, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
    )
    .run(s.workstreamId, n.taskId ?? null, s.thread.machineId, s.thread.threadId, s.runId, n.by, s.mode, s.stage, n.queuedMs, n.request);
  const steer: Steer = { ...s, id: `S${Number(row.lastInsertRowid)}` };
  c.query("UPDATE steers SET data = ? WHERE n = ?").run(encode(steer), Number(row.lastInsertRowid));
  return { steer, created: true };
}

export function get(db: HubDb, id: string): { steer: Steer; by: string } | undefined {
  const n = steerN(id);
  if (n === undefined) return undefined;
  const row = db.all<{ data: string; by: string }>("SELECT data, by FROM steers WHERE n = ?", [n])[0];
  return row ? { steer: decode(row.data), by: row.by } : undefined;
}

export function put(db: HubDb, steer: Steer, deliveredMs?: number, ackedMs?: number): void {
  const n = steerN(steer.id);
  if (n === undefined) return;
  db.conn
    .query("UPDATE steers SET stage = ?, delivered_ms = COALESCE(?, delivered_ms), acked_ms = COALESCE(?, acked_ms), data = ? WHERE n = ?")
    .run(steer.stage, deliveredMs ?? null, ackedMs ?? null, encode(steer), n);
}

/** Newest first. */
export const list = (db: HubDb, workstreamId: string, limit: number): Steer[] =>
  db.all<{ data: string }>("SELECT data FROM steers WHERE workstream_id = ?1 ORDER BY n DESC LIMIT ?2", [workstreamId, limit]).map((r) => decode(r.data));

/** Steers without a final receipt, with the time of their last stage. */
export const open = (db: HubDb): { steer: Steer; at: number }[] =>
  db
    .all<{ data: string; at: number }>(
      "SELECT data, COALESCE(delivered_ms, queued_ms) AS at FROM steers WHERE stage IN ('queued', 'delivered') AND held = 0",
    )
    .map((r) => ({ steer: decode(r.data), at: r.at }));

/** Holds a steer for its task's next run; `message` is the text it added to the task's pending message. */
export function hold(db: HubDb, id: string, message?: string): void {
  db.conn.query("UPDATE steers SET held = 1, rides_with = NULL, message = COALESCE(?, message) WHERE n = ?").run(message ?? null, steerN(id) ?? 0);
}

/** The message a steer went out as, so it can go again if its run never ran. */
export function keepMessage(db: HubDb, id: string, message: string): void {
  db.conn.query("UPDATE steers SET message = ? WHERE n = ?").run(message, steerN(id) ?? 0);
}

export const isHeld = (db: HubDb, id: string) => !!db.all<{ held: number }>("SELECT held FROM steers WHERE n = ?", [steerN(id) ?? 0])[0]?.held;

/** A task's steers that went out as run `runId`, oldest first, each with the message it went out as. */
export const ofRun = (db: HubDb, taskId: string, runId: string): { steer: Steer; message?: string }[] =>
  db
    .all<{ data: string; message: string | null }>("SELECT data, message FROM steers WHERE task_id = ? AND run_id = ? AND held = 0 ORDER BY n", [taskId, runId])
    .map((r) => ({ steer: decode(r.data), ...(r.message === null ? {} : { message: r.message }) }));

/** A held steer's pending text, while it is still held. */
export const heldMessage = (db: HubDb, id: string): string | undefined =>
  db.all<{ message: string | null }>("SELECT message FROM steers WHERE n = ? AND held = 1", [steerN(id) ?? 0])[0]?.message ?? undefined;

export function unhold(db: HubDb, id: string): void {
  db.conn.query("UPDATE steers SET held = 0 WHERE n = ?").run(steerN(id) ?? 0);
}

/** The steers that went out in `leader`'s run. */
export const riders = (db: HubDb, leader: string): Steer[] =>
  db.all<{ data: string }>("SELECT data FROM steers WHERE rides_with = ? ORDER BY n", [steerN(leader) ?? 0]).map((r) => decode(r.data));

export function ride(db: HubDb, rider: Steer, leader: string): void {
  db.conn
    .query("UPDATE steers SET held = 0, rides_with = ?, run_id = ?, data = ? WHERE n = ?")
    .run(steerN(leader) ?? 0, rider.runId, encode(rider), steerN(rider.id) ?? 0);
}

/** The held steers of a task, oldest first: the order they were added to its pending message. */
export const heldForTask = (db: HubDb, taskId: string): Steer[] =>
  db.all<{ data: string }>("SELECT data FROM steers WHERE task_id = ? AND held = 1 AND stage = 'queued' ORDER BY n", [taskId]).map((r) => decode(r.data));

/** A held steer went out with its task's next run: it is that run's now, and no longer held. */
export function bind(db: HubDb, steer: Steer): void {
  db.conn.query("UPDATE steers SET run_id = ?, held = 0, data = ? WHERE n = ?").run(steer.runId, encode(steer), steerN(steer.id) ?? 0);
}
