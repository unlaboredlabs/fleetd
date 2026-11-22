// A person's memory tidy's stored state: table `memory_tidies` per person, and the files before and after each of its
// "Memory refreshed" lines (`memory_refresh_lines.snapshot`).
import type { MemoryRefreshRun, PersonId, ProjectRef, RememberedItem } from "../../shared/contracts.ts";
import type { HubDb } from "../store/db.ts";
import type { Snapshot } from "./tidy_rules.ts";

/** A bot's key in `watermarks`. */
export const botKey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

/** One person's tidy state. */
export type Tidy = {
  /** Per bot (`botKey`), the last chat `seq` a finished tidy read. */
  watermarks: Record<string, number>;
  /** The night (its hour, epoch ms) last tidied, skipped or tried. */
  nightMs?: number;
  /** When a write past a cap asked for a tidy, not yet started. */
  dueMs?: number;
  /** The bot whose machine runs the tidy's session, and whose chat gets its line. */
  host?: ProjectRef;
  threadId?: string;
  startedMs?: number;
  trigger?: string;
  /** Per bot, the chat `seq` the running tidy read up to. */
  readTo?: Record<string, number>;
  /** What the running tidy changed so far. */
  items: RememberedItem[];
  /** The person's files as the running tidy found them. */
  before?: Snapshot;
  /** `snapshotKey` of the files as the last tidy left them. */
  seen?: string;
  lastRun?: MemoryRefreshRun;
  /** The last tidy's line. */
  messageId?: string;
};

type Row = {
  watermarks: string;
  night_ms: number | null;
  due_ms: number | null;
  host_machine: string | null;
  host_project: string | null;
  thread_id: string | null;
  started_ms: number | null;
  trigger: string | null;
  read_to: string | null;
  items: string;
  before: string | null;
  seen: string | null;
  last_run: string | null;
  message_id: string | null;
};

const parseOr = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export function getTidy(db: HubDb, person: PersonId): Tidy {
  const row = db.all<Row>("SELECT * FROM memory_tidies WHERE person_id = ?", [person])[0];
  if (!row) return { watermarks: {}, items: [] };
  const t: Tidy = { watermarks: parseOr<Record<string, number>>(row.watermarks, {}), items: parseOr<RememberedItem[]>(row.items, []) };
  if (row.night_ms !== null) t.nightMs = row.night_ms;
  if (row.due_ms !== null) t.dueMs = row.due_ms;
  if (row.host_machine !== null && row.host_project !== null) t.host = { machineId: row.host_machine, projectId: row.host_project };
  if (row.thread_id !== null) t.threadId = row.thread_id;
  if (row.started_ms !== null) t.startedMs = row.started_ms;
  if (row.trigger !== null) t.trigger = row.trigger;
  const readTo = parseOr<Record<string, number> | undefined>(row.read_to, undefined);
  if (readTo) t.readTo = readTo;
  const before = parseOr<Snapshot | undefined>(row.before, undefined);
  if (before) t.before = before;
  if (row.seen !== null) t.seen = row.seen;
  const last = parseOr<MemoryRefreshRun | undefined>(row.last_run, undefined);
  if (last) t.lastRun = last;
  if (row.message_id !== null) t.messageId = row.message_id;
  return t;
}

export function putTidy(db: HubDb, person: PersonId, t: Tidy): void {
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  db.conn
    .query(
      `INSERT INTO memory_tidies (person_id, watermarks, night_ms, due_ms, host_machine, host_project, thread_id,
         started_ms, trigger, read_to, items, before, seen, last_run, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (person_id) DO UPDATE SET watermarks = excluded.watermarks, night_ms = excluded.night_ms,
         due_ms = excluded.due_ms, host_machine = excluded.host_machine, host_project = excluded.host_project,
         thread_id = excluded.thread_id, started_ms = excluded.started_ms, trigger = excluded.trigger,
         read_to = excluded.read_to, items = excluded.items, before = excluded.before, seen = excluded.seen,
         last_run = excluded.last_run, message_id = excluded.message_id`,
    )
    .run(
      person,
      JSON.stringify(t.watermarks),
      t.nightMs ?? null,
      t.dueMs ?? null,
      t.host?.machineId ?? null,
      t.host?.projectId ?? null,
      t.threadId ?? null,
      t.startedMs ?? null,
      t.trigger ?? null,
      json(t.readTo),
      JSON.stringify(t.items),
      json(t.before),
      t.seen ?? null,
      json(t.lastRun),
      t.messageId ?? null,
    );
}

/**
 * A write left `person`'s memory past a cap: a tidy is due at `nowMs` (tidy.ts starts it after TIDY_DEBOUNCE_MS), unless
 * one runs or is already due. One statement.
 */
export function askTidy(db: HubDb, person: PersonId, nowMs: number): void {
  db.conn
    .query(
      `INSERT INTO memory_tidies (person_id, due_ms) VALUES (?1, ?2)
       ON CONFLICT (person_id) DO UPDATE SET due_ms = ?2 WHERE thread_id IS NULL AND due_ms IS NULL`,
    )
    .run(person, nowMs);
}

/** Whose running tidy is in `thread`, and the bot it runs on: its calls are held to that person's memory. */
export function tidyOfThread(db: HubDb, thread: { machineId: string; threadId: string }): { person: PersonId; host: ProjectRef } | undefined {
  const row = db.all<{ person_id: string; host_project: string }>(
    "SELECT person_id, host_project FROM memory_tidies WHERE host_machine = ? AND thread_id = ?",
    [thread.machineId, thread.threadId],
  )[0];
  return row ? { person: row.person_id, host: { machineId: thread.machineId, projectId: row.host_project } } : undefined;
}

/** Keeps what `person`'s running tidy just changed, for its line at the end. One statement. */
export function recordTidy(db: HubDb, person: PersonId, item: RememberedItem): void {
  db.conn
    .query("UPDATE memory_tidies SET items = json_insert(items, '$[#]', json(?2)) WHERE person_id = ?1 AND thread_id IS NOT NULL")
    .run(person, JSON.stringify(item));
}

/** The files a tidy's line found and left, which Undo all puts back exactly; undefined for another line. */
export function lineSnapshot(db: HubDb, messageId: string): { person: PersonId; before: Snapshot; after: Snapshot } | undefined {
  const row = db.all<{ snapshot: string | null }>("SELECT snapshot FROM memory_refresh_lines WHERE message_id = ?", [messageId])[0];
  return parseOr<{ person: PersonId; before: Snapshot; after: Snapshot } | undefined>(row?.snapshot ?? null, undefined);
}

export function putLineSnapshot(db: HubDb, messageId: string, snapshot: { person: PersonId; before: Snapshot; after: Snapshot }): void {
  db.conn.query("UPDATE memory_refresh_lines SET snapshot = ? WHERE message_id = ?").run(JSON.stringify(snapshot), messageId);
}
