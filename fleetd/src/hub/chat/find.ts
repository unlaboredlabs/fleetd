// The chats' search engine: the full-text index `chat_find` (its migration says what it holds) and the one search that
// reads it, for a person's chat_find and the lead's chat_search alike. find_rules.ts has the rules a hit follows.
//
// The index is kept by temporary triggers on this connection (a trigger in the schema would need a place in an
// export's import), so a message is indexed as it is written, again when its text changes, and once a streamed one is
// final; a message still being written is in no search. A plain FTS5 table, which every SQLite a hub runs on has
// (macOS 12's 3.37 among them): it keeps its own copy of the text, so a row goes by its rowid alone. The messages written before the index, or by an import, are filled in by `fill` from the newest down, a batch
// at a time between the hub's other work; until it is done a search says `indexing` and finds in what is filled.
import type { Database } from "bun:sqlite";
import type { ChatAuthor, ChatFindHas, ChatMessage, PersonId, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { FIND_COUNT_CAP, type Term } from "./find_rules.ts";
import { parse } from "./rules.ts";

/** A search: its terms and filters, newest first from before message number `beforeN`. */
export type FindQuery = {
  terms: Term[];
  author?: ChatAuthor;
  personId?: PersonId;
  sinceMs?: number;
  /** Exclusive. */
  untilMs?: number;
  has?: ChatFindHas[];
  beforeN?: number;
  limit: number;
  /** Count every hit too, up to FIND_COUNT_CAP. */
  count?: boolean;
};

export type Found = { messages: ChatMessage[]; more: boolean; count?: number; countMore?: true; indexing?: true };

/** A tag word: a letter, then a value as hex, so any id is one word of letters and numbers. */
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const HAS_TAG: Record<string, string> = { link: "hlink", image: "himage", file: "hfile", pr: "hpr" };

/** Whether a row's message is in the index: a whole message (not the row's first, empty write) once it is final. */
const indexed = (data: string) => `(json_extract(${data}, '$.messageId') IS NOT NULL AND json_extract(${data}, '$.state') IS NOT 'streaming')`;

/**
 * What `chat_find` holds of a message row, by find_rules' `indexedText` and `holds` (the same rules, in SQL): its text,
 * and its tags: its bot, author and person, what it holds, and its UTC day and month, which a date filter narrows by.
 */
const textOf = (data: string) => `COALESCE(json_extract(${data}, '$.text'), '')`;
const tagsOf = (row: string) => {
  const data = `${row}.data`;
  const text = `json_extract(${data}, '$.text')`;
  const files = (cond: string) => `EXISTS (SELECT 1 FROM json_each(${data}, '$.attachments') WHERE json_extract(value, '$.mime') ${cond})`;
  const at = `${row}.created_ms / 1000, 'unixepoch'`;
  return `'p' || lower(hex(${row}.machine_id || '/' || ${row}.project_id))
    || ' a' || lower(hex(COALESCE(json_extract(${data}, '$.author'), '')))
    || COALESCE(' w' || lower(hex(json_extract(${data}, '$.person.personId'))), '')
    || CASE WHEN ${text} LIKE '%http://%' OR ${text} LIKE '%https://%' THEN ' hlink' ELSE '' END
    || CASE WHEN ${files("GLOB 'image/*'")} THEN ' himage' ELSE '' END
    || CASE WHEN ${files("NOT GLOB 'image/*'")} THEN ' hfile' ELSE '' END
    || CASE WHEN ${text} GLOB '*/pull/[0-9]*' OR ${text} GLOB '*#[0-9]*' THEN ' hpr' ELSE '' END
    || ' d' || strftime('%Y%m%d', ${at}) || ' u' || strftime('%Y%m', ${at})`;
};

const PUT = (row: string) => `INSERT OR REPLACE INTO chat_find (rowid, text, tags) VALUES (${row}.n, ${textOf(`${row}.data`)}, ${tagsOf(row)})`;
const CHANGED = ["text", "attachments", "author", "person"].map((f) => `json_extract(OLD.data, '$.${f}') IS NOT json_extract(NEW.data, '$.${f}')`).join(" OR ");
const TRIGGERS = `
  CREATE TEMP TRIGGER IF NOT EXISTS chat_find_insert AFTER INSERT ON main.chat_messages WHEN ${indexed("NEW.data")} BEGIN
    ${PUT("NEW")}; END;
  CREATE TEMP TRIGGER IF NOT EXISTS chat_find_update AFTER UPDATE OF data ON main.chat_messages
    WHEN ${indexed("NEW.data")} AND (NOT ${indexed("OLD.data")} OR ${CHANGED}) BEGIN
    ${PUT("NEW")}; END;
  CREATE TEMP TRIGGER IF NOT EXISTS chat_find_unindex AFTER UPDATE OF data ON main.chat_messages
    WHEN NOT ${indexed("NEW.data")} AND ${indexed("OLD.data")} BEGIN
    DELETE FROM chat_find WHERE rowid = OLD.n; END;
  CREATE TEMP TRIGGER IF NOT EXISTS chat_find_delete AFTER DELETE ON main.chat_messages BEGIN
    DELETE FROM chat_find WHERE rowid = OLD.n; END;`;

/** The messages filled per step, and the pause between steps. */
export const FILL_BATCH = 1000;
const FILL_PAUSE_MS = 5;

/** Sets up the index's upkeep on `conn`; a read-only connection writes nothing, so it only reads. */
export function keepIndex(conn: Database, readonly: boolean): void {
  if (readonly) return;
  conn.run(TRIGGERS);
}

/** The first message number not yet filled into the index from below (1 when it is all filled). */
export function unfilled(conn: Database): number {
  return conn.query<{ below: number }, []>("SELECT below FROM chat_find_built").get()?.below ?? 1;
}

/** Fills one batch below the mark; false when nothing is left. */
export function fillStep(conn: Database, batch = FILL_BATCH): boolean {
  const below = unfilled(conn);
  if (below <= 1) return false;
  const lo = Math.max(1, below - batch);
  conn.transaction(() => {
    conn
      .query(
        `INSERT OR REPLACE INTO chat_find (rowid, text, tags) SELECT m.n, ${textOf("m.data")}, ${tagsOf("m")}
         FROM chat_messages m WHERE m.n >= ?1 AND m.n < ?2 AND ${indexed("m.data")}`,
      )
      .run(lo, below);
    conn.query("UPDATE chat_find_built SET below = ?1").run(lo);
  })();
  return lo > 1;
}

/** Fills the index below its mark, a batch at a time with a pause between, until it is done or the hub stops. */
export async function fill(hub: Hub): Promise<void> {
  const conn = hub.db.conn;
  if (hub.db.readonly) return;
  while (!hub.shutdown.signal.aborted) {
    let more: boolean;
    try {
      more = fillStep(conn);
    } catch (error) {
      console.error(`chat search: filling the index failed: ${(error as Error).message}`);
      return;
    }
    if (!more) return;
    await Bun.sleep(FILL_PAUSE_MS);
  }
}

/** The other end of a date filter given only one: the chat's first moment, or one past its last (chat_by_time). */
function bounded(conn: Database, r: ProjectRef, q: FindQuery): FindQuery {
  if ((q.sinceMs === undefined) === (q.untilMs === undefined)) return q;
  const edge = conn
    .query<{ lo: number | null; hi: number | null }, [string, string]>(
      "SELECT MIN(created_ms) AS lo, MAX(created_ms) AS hi FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2",
    )
    .get(r.machineId, r.projectId);
  return q.sinceMs === undefined ? { ...q, sinceMs: edge?.lo ?? 0 } : { ...q, untilMs: (edge?.hi ?? q.sinceMs!) + 1 };
}

/** The MATCH expression of `q` in `r`'s chat. */
function matchOf(r: ProjectRef, q: FindQuery): string {
  const parts = [`tags : p${hex(`${r.machineId}/${r.projectId}`)}`];
  if (q.author !== undefined) parts.push(`tags : a${hex(q.author)}`);
  if (q.personId !== undefined) parts.push(`tags : w${hex(q.personId)}`);
  for (const h of q.has ?? []) if (HAS_TAG[h]) parts.push(`tags : ${HAS_TAG[h]}`);
  const times = timeTags(q.sinceMs, q.untilMs);
  if (times !== undefined) parts.push(`tags : (${times.join(" OR ")})`);
  // Tokens are letters and numbers only (find_rules' tokensOf), so a quoted string needs no escaping.
  for (const t of q.terms) parts.push(`text : "${t.tokens.join(" ")}"${t.prefix ? "*" : ""}`);
  return parts.join(" AND ");
}

const DAY_MS = 86_400_000;
/** Past these many days a date filter narrows by month, past these many months by nothing but the time itself. */
const DAYS_MAX = 62;
const MONTHS_MAX = 240;

/**
 * The index's words for the UTC days (or months) that hold every moment from `sinceMs` up to `untilMs`: the time
 * itself is checked on each message too, so a message written late with an early time (an old order read in) is found
 * by its own time, never by where it sits in the chat.
 */
export function timeTags(sinceMs: number | undefined, untilMs: number | undefined): string[] | undefined {
  if (sinceMs === undefined || untilMs === undefined || untilMs <= sinceMs) return undefined;
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");
  const first = Math.floor(sinceMs / DAY_MS);
  const last = Math.floor((untilMs - 1) / DAY_MS);
  if (last - first < DAYS_MAX) return Array.from({ length: last - first + 1 }, (_, i) => `d${ymd((first + i) * DAY_MS)}`);
  const month = (ms: number) => {
    const d = new Date(ms);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  };
  const [m0, m1] = [month(sinceMs), month(untilMs - 1)];
  if (m1 - m0 >= MONTHS_MAX) return undefined;
  return Array.from({ length: m1 - m0 + 1 }, (_, i) => `u${String(Math.floor((m0 + i) / 12))}${String(((m0 + i) % 12) + 1).padStart(2, "0")}`);
}

/** The messages of `r`'s chat that `q` finds, newest first, and whether more are past them. */
export function find(conn: Database, r: ProjectRef, asked: FindQuery): Found {
  const q = bounded(conn, r, asked);
  const indexing = unfilled(conn) > 1 ? ({ indexing: true } as const) : {};
  let where = "chat_find MATCH ?1 AND f.rowid < ?2 AND m.machine_id = ?3 AND m.project_id = ?4";
  const args: (string | number)[] = [matchOf(r, q), q.beforeN ?? Number.MAX_SAFE_INTEGER, r.machineId, r.projectId];
  if (q.sinceMs !== undefined) {
    args.push(q.sinceMs);
    where += ` AND m.created_ms >= ?${args.length}`;
  }
  if (q.untilMs !== undefined) {
    args.push(q.untilMs);
    where += ` AND m.created_ms < ?${args.length}`;
  }
  if (q.has?.includes("pinned")) {
    where += " AND f.rowid IN (SELECT message_n FROM chat_message_pins p WHERE p.machine_id = ?3 AND p.project_id = ?4)";
  }
  // The index first, always: a time filter would otherwise lead the planner to walk the messages and ask the index of each.
  const from = `FROM chat_find f CROSS JOIN chat_messages m ON m.n = f.rowid WHERE ${where}`;
  const rows = conn
    .query<{ data: string }, (string | number)[]>(`SELECT m.data ${from} ORDER BY f.rowid DESC LIMIT ?${args.length + 1}`)
    .all(...args, q.limit + 1);
  const more = rows.length > q.limit;
  const out: Found = { messages: rows.slice(0, q.limit).map((row) => parse(row.data)), more, ...indexing };
  if (q.count) {
    const n = (
      conn
        .query<{ k: number }, (string | number)[]>(`SELECT COUNT(*) AS k FROM (SELECT 1 ${from} LIMIT ?${args.length + 1})`)
        .get(...args, FIND_COUNT_CAP + 1) as { k: number }
    ).k;
    out.count = Math.min(n, FIND_COUNT_CAP);
    if (n > FIND_COUNT_CAP) out.countMore = true;
  }
  return out;
}
