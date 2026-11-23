// When each open order last moved and whether anything of it is busy, from the hub's store, for the lead state's
// stalled-order lines (stalled_rules.ts says which orders get one, and how).
import type { HumanRequest, ProjectRef, Workstream } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { TERMINAL_STATES } from "../train/states.ts";
import { stalledLines as rules } from "./stalled_rules.ts";

export { STALLED_MS } from "./stalled_rules.ts";

/** Whether anything of the order runs, is queued or waits: a live task, a done one's wait_ci or Monitor, a PR on the train. */
function busy(db: HubDb, r: ProjectRef, workstreamId: string, now: string): boolean {
  const tasks = db.all<{ n: number }>(
    `SELECT 1 AS n FROM tasks t WHERE t.machine_id = ?1 AND t.project_id = ?2 AND t.workstream_id = ?3
       AND (t.state IN ('queued', 'running', 'idle')
            OR (t.state = 'done' AND 'T' || t.n IN (SELECT task_id FROM ci_waits))
            OR (t.state = 'done' AND EXISTS (SELECT 1 FROM threads th
                  WHERE th.machine_id = json_extract(t.data, '$.threadRef.machineId') AND th.thread_id = t.thread_id
                    AND json_extract(th.data, '$.watchingUntil') > ?4)))
     LIMIT 1`,
    [r.machineId, r.projectId, workstreamId, now],
  );
  if (tasks.length > 0) return true;
  const ended = TERMINAL_STATES.map((s) => `'${s}'`).join(", ");
  return (
    db.all<{ n: number }>(
      `SELECT 1 AS n FROM changes WHERE machine_id = ?1 AND project_id = ?2 AND json_extract(data, '$.workstreamId') = ?3
         AND state NOT IN (${ended}) LIMIT 1`,
      [r.machineId, r.projectId, workstreamId],
    ).length > 0
  );
}

/** When the order last moved: it changed, a task of it ended, or a PR of it left the train. */
function lastMoved(db: HubDb, r: ProjectRef, w: Workstream): number {
  const row = db.all<{ task: string | null; change: string | null }>(
    `SELECT (SELECT MAX(ended_at) FROM tasks WHERE machine_id = ?1 AND project_id = ?2 AND workstream_id = ?3) AS task,
            (SELECT MAX(json_extract(data, '$.updatedAt')) FROM changes
               WHERE machine_id = ?1 AND project_id = ?2 AND json_extract(data, '$.workstreamId') = ?3) AS change`,
    [r.machineId, r.projectId, w.workstreamId],
  )[0];
  return Math.max(...[w.createdAt, w.updatedAt, row?.task, row?.change].map((at) => parseMs(at ?? "") ?? 0));
}

/** A line per open order with nothing running, queued or waiting for over STALLED_MS, the longest idle first. */
export function stalledLines(db: HubDb, r: ProjectRef, open: Workstream[], requests: HumanRequest[], nowMs: number): string[] {
  const now = isoMs(nowMs);
  const orders = open.map((w) => ({ workstreamId: w.workstreamId, lastMovedMs: lastMoved(db, r, w), busy: busy(db, r, w.workstreamId, now) }));
  return rules(orders, requests, nowMs);
}
