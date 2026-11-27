// The stamp on the lead reply that closes an order, "Done in 3m 10s · 3 agents" (ChatMessage.closed): written onto the
// reply as the lead's run ends, from the log (the order's workstream.done inside the run) and the order's record (its
// start, its agents), so it reads the same after a reload as it did live.
import type { ChatClosed, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { readWorkstream } from "../leads/records.ts";
import { runWindow } from "../leads/requested.ts";
import { isoMs, nowMs, parseMs } from "../store/time.ts";
import { chat } from "./index.ts";

const sameRef = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

/**
 * The order the lead's run of `thread` closed, the run ending at `endMs` (when the hub logged its end): the last
 * workstream.done of `r`'s orders logged inside it, with the order's whole time and its agents (the tasks its lead
 * started, its QA reviews among them, never the train's reviews). Undefined when it closed none.
 */
export function runClosed(hub: Hub, r: ProjectRef, thread: string, endMs: number): ChatClosed | undefined {
  const { floor, since } = runWindow(hub.db, r, thread, endMs);
  const dones = hub.db.all<{ created_ms: number; w: string | null }>(
    `SELECT created_ms, json_extract(data, '$.data.workstreamId') AS w FROM events
     WHERE type = 'workstream.done' AND machine_id = ?1 AND json_extract(data, '$.projectId') = ?2
       AND created_ms > ?3 AND created_ms <= ?4
     ORDER BY seq DESC`,
    [r.machineId, r.projectId, floor, since],
  );
  for (const done of dones) {
    const w = done.w === null ? undefined : readWorkstream(hub.db.conn, done.w);
    const start = parseMs(w?.createdAt ?? "");
    if (w === undefined || !sameRef(w.projectRef, r) || start === undefined || done.created_ms < start) continue;
    const agents = hub.db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks WHERE workstream_id = ?1
         AND NOT (json_extract(data, '$.kind') IS 'review' AND COALESCE(json_extract(data, '$.qa'), 0) = 0)`,
      [w.workstreamId],
    )[0];
    return { workstreamId: w.workstreamId, ms: done.created_ms - start, agents: agents?.n ?? 0, since: isoMs(floor), until: isoMs(since) };
  }
  return undefined;
}

/**
 * The lead's run of `thread` ended with event `seq`: when it closed an order, its reply (the lead's newest message of
 * the run) carries the stamp, announced. A reply already stamped stays as it is, so a later mirror changes nothing.
 */
export function stampClosed(hub: Hub, r: ProjectRef, thread: string, seq: number): void {
  const logged = hub.db.all<{ created_ms: number }>("SELECT created_ms FROM events WHERE seq = ?1", [seq])[0];
  if (!logged) return;
  const closed = runClosed(hub, r, thread, logged.created_ms);
  if (closed === undefined) return;
  const reply = hub.db.all<{ n: number }>(
    `SELECT n FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2 AND created_ms > ?3 AND created_ms <= ?4
       AND source LIKE 'lead:' || ?5 || ':%' AND json_extract(data, '$.author') = 'lead'
       AND json_extract(data, '$.history') IS NULL AND json_extract(data, '$.state') = 'final'
     ORDER BY seq DESC LIMIT 1`,
    [r.machineId, r.projectId, Date.parse(closed.since), Date.parse(closed.until), thread],
  )[0];
  if (!reply) return;
  const c = chat(hub);
  const out = c.update(`m${reply.n}`, (m) => {
    if (m.closed !== undefined) return false;
    m.closed = closed;
    // Newer than the copy an open chat already holds (mirror announced it as it landed), so the apps take this one.
    m.updatedAt = isoMs(nowMs(hub.clock));
    return true;
  });
  if (out) c.announce(out);
}

/**
 * Replies of the lead's thread landed later than their run's end (its machine couldn't be read then: a mirror once it's
 * back): the lead's latest run that closed an order, the first of its runs to end after the project's newest
 * workstream.done, stamps its reply as if it had just ended. Its run end gave no stamp then, its reply not in yet.
 */
export function stampLatest(hub: Hub, r: ProjectRef, thread: string): void {
  const end = hub.db.all<{ seq: number }>(
    `SELECT seq FROM events
     WHERE type IN ('thread.completed', 'thread.failed', 'thread.interrupted') AND machine_id = $machine
       AND seq > (SELECT MAX(seq) FROM events WHERE type = 'workstream.done' AND machine_id = $machine
         AND json_extract(data, '$.projectId') = $project)
       AND json_extract(data, '$.threadId') IN (
         SELECT $thread UNION SELECT json_extract(data, '$.threadId') FROM events
         WHERE type = 'lead.started' AND machine_id = $machine
           AND json_extract(data, '$.projectId') = $project)
     ORDER BY seq LIMIT 1`,
    { machine: r.machineId, project: r.projectId, thread },
  )[0];
  if (end) stampClosed(hub, r, thread, end.seq);
}
