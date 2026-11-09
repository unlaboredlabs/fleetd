// When the human asked for an order, for the time from order to merged. A
// submitted order was asked for when it was submitted. One the lead opens was asked for at the earliest human chat
// message its run took in, stamped as it opens; with none, it is when it opened, and says so.
import type { PersonRef, ProjectRef, Workstream } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { parseMs } from "../store/time.ts";
import { workstreamNumber } from "./records.ts";

/** The event log keeps 30 days: a run that ended before then left no event, and no message it took in is newer. */
const LOG_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

export type RequestedBasis = "source" | "chat" | "opened";
export type Requested = { atMs: number; basis: RequestedBasis };

/**
 * The `created_ms` and person of the earliest human chat message the lead's running turn took in: one written since
 * the project's lead last ended a run, or the one sent with `now` that interrupted it.
 */
export function runHuman(db: HubDb, r: ProjectRef, thread: string, nowMs: number): { atMs: number; person?: PersonRef } | undefined {
  // The lead's earlier threads count too: a fresh lead's first run follows the old one's last.
  const ends = db.all<{ created_ms: number; type: string }>(
    `SELECT created_ms, type FROM events
     WHERE type IN ('thread.completed', 'thread.failed', 'thread.interrupted', 'thread.usage_limited')
       AND machine_id = $machine AND created_ms <= $now
       AND json_extract(data, '$.threadId') IN (
         SELECT $thread UNION SELECT json_extract(data, '$.threadId') FROM events
         WHERE type = 'lead.started' AND machine_id = $machine
           AND json_extract(data, '$.projectId') = $project)
     ORDER BY seq DESC LIMIT 2`,
    { machine: r.machineId, project: r.projectId, thread, now: nowMs },
  );
  const floor = ends[1]?.created_ms ?? nowMs - LOG_KEPT_MS;
  const since = ends[0]?.created_ms ?? floor;
  const interrupted = ends[0]?.type === "thread.interrupted";
  const messages = db.all<{ created_ms: number; delivery: string | null; person: string | null }>(
    `SELECT created_ms, json_extract(data, '$.delivery') AS delivery, json_extract(data, '$.person') AS person FROM chat_messages
     WHERE machine_id = ?1 AND project_id = ?2 AND created_ms > ?3 AND created_ms <= ?4 AND held = 0
       AND json_extract(data, '$.author') = 'human' AND json_extract(data, '$.history') IS NULL
       AND json_extract(data, '$.delivery') IS NOT NULL
     ORDER BY seq`,
    [r.machineId, r.projectId, floor, nowMs],
  );
  const found = messages.find((m) => m.created_ms > since || (interrupted && m.delivery === "now"));
  if (!found) return undefined;
  let person: PersonRef | undefined;
  try {
    person = found.person ? (JSON.parse(found.person) as PersonRef) : undefined;
  } catch {
    person = undefined;
  }
  return { atMs: found.created_ms, ...(person ? { person } : {}) };
}

/** Stamps a lead-opened order with when it was asked for. */
export function setRequested(db: HubDb, w: Workstream, requested: Requested): void {
  db.conn
    .query("UPDATE workstreams SET requested_ms = ?1, requested_basis = ?2 WHERE n = ?3")
    .run(requested.atMs, requested.basis, workstreamNumber(w.workstreamId));
}

/** When the order was asked for: its stamp, else when it was submitted, else (a lead's) when it opened. */
export function getRequested(db: HubDb, w: Workstream): Requested {
  const stamp = db.all<{ requested_ms: number | null; requested_basis: string | null }>(
    "SELECT requested_ms, requested_basis FROM workstreams WHERE n = ?",
    [workstreamNumber(w.workstreamId)],
  )[0];
  const basis = stamp?.requested_basis;
  if (stamp?.requested_ms != null && (basis === "source" || basis === "chat" || basis === "opened")) {
    return { atMs: stamp.requested_ms, basis };
  }
  const [at, b]: [string, RequestedBasis] = w.source.channel === "lead" ? [w.createdAt, "opened"] : [w.source.at, "source"];
  return { atMs: parseMs(at) ?? 0, basis: b };
}
