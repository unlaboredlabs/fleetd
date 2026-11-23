// Open orders nothing moves: on 2026-11-23 ten open orders sat with no agent for hours to days across lead restarts,
// and nobody noticed until the person asked. The lead's state opens with a line for each order that has had nothing
// running, queued or waiting (no task, no wait_ci, no Monitor, no PR on the train, no request to the person) for longer
// than STALLED_MS, with when it last moved.
import type { HumanRequest, ProjectRef, Workstream } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { isoMs, parseMs } from "../store/time.ts";
import { TERMINAL_STATES } from "../train/states.ts";

export const STALLED_MS = 30 * 60_000;

/** "2026-11-23 10:05 UTC". */
const when = (ms: number) => {
  const iso = isoMs(ms);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
};

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
  const out: { line: string; since: number }[] = [];
  for (const w of open) {
    if (requests.some((q) => q.workstreamId === w.workstreamId)) continue;
    const since = lastMoved(db, r, w);
    if (nowMs - since <= STALLED_MS || busy(db, r, w.workstreamId, now)) continue;
    out.push({ line: `${w.workstreamId} open, nothing running since ${when(since)}`, since });
  }
  return out.sort((a, b) => a.since - b.since).map((x) => x.line);
}
