// The nightly memory refresh's stored state (`get`, `put`, `you`, `record`,
// `line_items`, `put_line_items`, `listed`): table `memory_refreshes` per project, `memory_refresh_lines` per line.
import type { MemoryRefreshRun, ProjectRef, RememberedItem } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import { naviOwner, type You, youOf } from "./index.ts";

export { listed, REFRESHED_LISTED } from "./refresh_rules.ts";

/** One project's refresh state. */
export type Run = {
  /** The last chat `seq` a finished refresh read. */
  watermark: number;
  /** The night (its hour, epoch ms) last refreshed, skipped as quiet, or tried. */
  nightMs?: number;
  /** The refresh session running now. */
  threadId?: string;
  startedMs?: number;
  /** The chat `seq` the running refresh read up to. */
  readTo?: number;
  /** What the running refresh changed so far. */
  items: RememberedItem[];
  /** The night last skipped for a node too old to run it. */
  skippedMs?: number;
  lastRun?: MemoryRefreshRun;
};

type RunRow = {
  watermark: number;
  night_ms: number | null;
  thread_id: string | null;
  started_ms: number | null;
  read_to: number | null;
  items: string;
  skipped_ms: number | null;
  last_run: string | null;
};

const parseOr = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export function getRun(db: HubDb, r: ProjectRef): Run {
  const row = db.all<RunRow>(
    `SELECT watermark, night_ms, thread_id, started_ms, read_to, items, skipped_ms, last_run FROM memory_refreshes
     WHERE machine_id = ? AND project_id = ?`,
    [r.machineId, r.projectId],
  )[0];
  if (!row) return { watermark: 0, items: [] };
  const run: Run = { watermark: row.watermark, items: parseOr<RememberedItem[]>(row.items, []) };
  if (row.night_ms !== null) run.nightMs = row.night_ms;
  if (row.thread_id !== null) run.threadId = row.thread_id;
  if (row.started_ms !== null) run.startedMs = row.started_ms;
  if (row.read_to !== null) run.readTo = row.read_to;
  if (row.skipped_ms !== null) run.skippedMs = row.skipped_ms;
  const last = parseOr<MemoryRefreshRun | undefined>(row.last_run, undefined);
  if (last) run.lastRun = last;
  return run;
}

export function putRun(db: HubDb, r: ProjectRef, run: Run): void {
  db.conn
    .query(
      `INSERT INTO memory_refreshes (machine_id, project_id, watermark, night_ms, thread_id, started_ms, read_to, items,
         skipped_ms, last_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (machine_id, project_id) DO UPDATE SET watermark = excluded.watermark,
         night_ms = excluded.night_ms, thread_id = excluded.thread_id, started_ms = excluded.started_ms,
         read_to = excluded.read_to, items = excluded.items, skipped_ms = excluded.skipped_ms,
         last_run = excluded.last_run`,
    )
    .run(
      r.machineId,
      r.projectId,
      run.watermark,
      run.nightMs ?? null,
      run.threadId ?? null,
      run.startedMs ?? null,
      run.readTo ?? null,
      JSON.stringify(run.items),
      run.skippedMs ?? null,
      run.lastRun === undefined ? null : JSON.stringify(run.lastRun),
    );
}

/** The project whose running refresh is in `thread`: its calls are held to the memory ones. */
export function projectOfThread(db: HubDb, thread: { machineId: string; threadId: string }): ProjectRef | undefined {
  const id = db.all<{ project_id: string }>("SELECT project_id FROM memory_refreshes WHERE machine_id = ? AND thread_id = ?", [
    thread.machineId,
    thread.threadId,
  ])[0]?.project_id;
  return id === undefined ? undefined : { machineId: thread.machineId, projectId: id };
}

/** Whose user memory the running refresh of `r` adds to: a Navi's owner's, else the one person who wrote in its chat. */
export function refreshYou(db: HubDb, r: ProjectRef): You {
  const run = getRun(db, r);
  return youOver(db, r, run.watermark, run.readTo ?? Number.MAX_SAFE_INTEGER);
}

export function youOver(db: HubDb, r: ProjectRef, watermark: number, readTo: number): You {
  const owner = naviOwner(db, r);
  if (owner !== undefined) return youOf(db, owner);
  const ids = db
    .all<{ id: string | null }>(
      `SELECT DISTINCT json_extract(data, '$.person.personId') AS id FROM chat_messages
       WHERE machine_id = ?1 AND project_id = ?2 AND seq > ?3 AND seq <= ?4 AND held = 0
         AND json_extract(data, '$.author') = 'human' AND json_extract(data, '$.person') IS NOT NULL`,
      [r.machineId, r.projectId, watermark, readTo],
    )
    .map((row) => row.id);
  if (ids.length === 0) return youOf(db, undefined);
  if (ids.length === 1) return youOf(db, ids[0] ?? undefined);
  return { kind: "nobody" };
}

/** Keeps what the running refresh of project `r` just changed, for its line at the end. One statement. */
export function record(db: HubDb, r: ProjectRef, item: RememberedItem): void {
  db.conn
    .query(
      `UPDATE memory_refreshes SET items = json_insert(items, '$[#]', json(?3))
       WHERE machine_id = ?1 AND project_id = ?2 AND thread_id IS NOT NULL`,
    )
    .run(r.machineId, r.projectId, JSON.stringify(item));
}

/** Every change a "Memory refreshed" line stands for; undefined for a line without a row. */
export function lineItems(db: HubDb, messageId: string): RememberedItem[] | undefined {
  const row = db.all<{ items: string }>("SELECT items FROM memory_refresh_lines WHERE message_id = ?", [messageId])[0];
  return row ? parseOr<RememberedItem[] | undefined>(row.items, undefined) : undefined;
}

/** Keeps every change of line `messageId` in project `r`, as Undo marks them. */
export function putLineItems(db: HubDb, r: ProjectRef, messageId: string, items: RememberedItem[]): void {
  db.conn
    .query(
      `INSERT INTO memory_refresh_lines (message_id, machine_id, project_id, items) VALUES (?, ?, ?, ?)
       ON CONFLICT (message_id) DO UPDATE SET items = excluded.items`,
    )
    .run(messageId, r.machineId, r.projectId, JSON.stringify(items));
}

