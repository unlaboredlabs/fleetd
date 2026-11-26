// What the daily check-in reads in the hub (checkin.ts decides the rest): the bot's open orders that stalled, its
// requests waiting on a person, the lead's promises in the chat of the last days, and the orders closed since.
import type { ProjectRef, Task, Workstream } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { openRequests } from "../approvals/index.ts";
import { inFlight } from "../automations/index.ts";
import { workstreamsList } from "../orders/workstreams.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { type CheckInFacts, OFFER_SOURCE, PROMISE_MS, promises, STALL_MS, WAIT_MS } from "./checkin.ts";

/** Orders, requests and messages read, at most: the newest. */
const READ = 50;

/** The newest time anything of the order changed: the order itself, or one of its agents starting or ending. */
function lastMoved(hub: Hub, r: ProjectRef, w: Workstream): number {
  let ms = parseMs(w.updatedAt) ?? parseMs(w.createdAt) ?? 0;
  const tasks = hub.db.all<{ data: string }>(
    "SELECT data FROM tasks WHERE machine_id = ? AND project_id = ? AND workstream_id = ? ORDER BY n DESC LIMIT 20",
    [r.machineId, r.projectId, w.workstreamId],
  );
  for (const { data } of tasks) {
    const t = JSON.parse(data) as Task;
    for (const at of [t.createdAt, t.startedAt, t.endedAt]) ms = Math.max(ms, at === undefined ? 0 : (parseMs(at) ?? 0));
  }
  return ms;
}

export function checkInFacts(hub: Hub, r: ProjectRef): CheckInFacts {
  const now = hub.clock.now();
  const stalled = workstreamsList(hub.db.conn, { projectRef: r, state: "open", limit: READ }).flatMap((w) => {
    if (inFlight(hub, r, w.workstreamId)) return [];
    const moved = lastMoved(hub, r, w);
    return now - moved < STALL_MS ? [] : [{ id: w.workstreamId, title: w.title, since: isoMs(moved) }];
  });
  const waiting = openRequests(hub, READ, r).flatMap((q) => {
    const at = parseMs(q.createdAt);
    return at === undefined || now - at < WAIT_MS ? [] : [{ id: q.requestId, kind: q.kind, text: q.text, at: q.createdAt }];
  });
  const promised = hub.db
    .all<{ data: string; source: string | null }>(
      `SELECT data, source FROM chat_messages WHERE machine_id = ? AND project_id = ? AND held = 0 AND created_ms >= ?
         AND json_extract(data, '$.author') = 'lead' ORDER BY seq DESC LIMIT ?`,
      [r.machineId, r.projectId, now - PROMISE_MS, READ],
    )
    .flatMap(({ data, source }) => {
      if (source?.startsWith(OFFER_SOURCE)) return [];
      const m = JSON.parse(data) as { messageId: string; text?: string; createdAt: string; state?: string; history?: unknown };
      if (m.state !== "final" || m.history !== undefined || !promises(m.text ?? "")) return [];
      return [{ id: m.messageId, text: m.text ?? "", at: m.createdAt }];
    })
    .reverse();
  const since = now - PROMISE_MS;
  const closed = workstreamsList(hub.db.conn, { projectRef: r, state: "done", limit: READ })
    .filter((w) => (parseMs(w.updatedAt) ?? 0) >= since)
    .map((w) => w.title);
  return { stalled, waiting, promised, closed };
}
