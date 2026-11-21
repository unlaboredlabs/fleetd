// The chats' search engine: the full-text index `chat_find` (its migration says what it holds) and the one search that
// reads it, for a person's chat_find and the lead's chat_search alike. find_rules.ts has the rules a hit follows.
//
// The index is kept by temporary triggers on this connection (a trigger in the schema would need a place in an
// export's import), so a message is indexed as it is written, again when its text changes, and once a streamed one is
// final. The messages written before the index, or by an import, are filled in by `fill` from the newest down, a batch
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

/** What `chat_find` holds of a message row, by find_rules' `indexedText` and `holds` (the same rules, in SQL). */
const ROWS = `CREATE TEMP VIEW IF NOT EXISTS chat_find_rows AS SELECT n, COALESCE(json_extract(data, '$.text'), '') AS text,
    'p' || lower(hex(machine_id || '/' || project_id))
    || ' a' || lower(hex(COALESCE(json_extract(data, '$.author'), '')))
    || COALESCE(' w' || lower(hex(json_extract(data, '$.person.personId'))), '')
    || CASE WHEN json_extract(data, '$.text') LIKE '%http://%' OR json_extract(data, '$.text') LIKE '%https://%' THEN ' hlink' ELSE '' END
    || CASE WHEN EXISTS (SELECT 1 FROM json_each(data, '$.attachments') WHERE json_extract(value, '$.mime') GLOB 'image/*')
         THEN ' himage' ELSE '' END
    || CASE WHEN EXISTS (SELECT 1 FROM json_each(data, '$.attachments') WHERE json_extract(value, '$.mime') NOT GLOB 'image/*')
         THEN ' hfile' ELSE '' END
    || CASE WHEN json_extract(data, '$.text') GLOB '*/pull/[0-9]*' OR json_extract(data, '$.text') GLOB '*#[0-9]*' THEN ' hpr' ELSE '' END
    AS tags
  FROM main.chat_messages WHERE json_extract(data, '$.state') IS NOT 'streaming'`;

const TRIGGERS = `
  CREATE TEMP TRIGGER IF NOT EXISTS chat_find_insert AFTER INSERT ON main.chat_messages BEGIN
    INSERT OR REPLACE INTO main.chat_find (rowid, text, tags) SELECT n, text, tags FROM chat_find_rows WHERE n = NEW.n; END;
  CREATE TEMP TRIGGER IF NOT EXISTS chat_find_update AFTER UPDATE OF data ON main.chat_messages
    WHEN json_extract(NEW.data, '$.state') IS NOT 'streaming' AND (json_extract(OLD.data, '$.state') IS 'streaming'
      OR json_extract(OLD.data, '$.text') IS NOT json_extract(NEW.data, '$.text')
      OR json_extract(OLD.data, '$.attachments') IS NOT json_extract(NEW.data, '$.attachments')
      OR json_extract(OLD.data, '$.person') IS NOT json_extract(NEW.data, '$.person')) BEGIN
    INSERT OR REPLACE INTO main.chat_find (rowid, text, tags) SELECT n, text, tags FROM chat_find_rows WHERE n = NEW.n; END;
  CREATE TEMP TRIGGER IF NOT EXISTS chat_find_delete AFTER DELETE ON main.chat_messages BEGIN
    DELETE FROM main.chat_find WHERE rowid = OLD.n; END;`;

/** The messages filled per step, and the pause between steps. */
export const FILL_BATCH = 1000;
const FILL_PAUSE_MS = 5;

/** Sets up the index's upkeep on `conn`; a read-only connection writes nothing, so it only reads. */
export function keepIndex(conn: Database, readonly: boolean): void {
  if (readonly) return;
  conn.run(ROWS);
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
    conn.query("INSERT OR REPLACE INTO chat_find (rowid, text, tags) SELECT n, text, tags FROM chat_find_rows WHERE n >= ?1 AND n < ?2").run(lo, below);
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

/** The MATCH expression of `q` in `r`'s chat. */
function matchOf(r: ProjectRef, q: FindQuery): string {
  const parts = [`tags : p${hex(`${r.machineId}/${r.projectId}`)}`];
  if (q.author !== undefined) parts.push(`tags : a${hex(q.author)}`);
  if (q.personId !== undefined) parts.push(`tags : w${hex(q.personId)}`);
  for (const h of q.has ?? []) if (HAS_TAG[h]) parts.push(`tags : ${HAS_TAG[h]}`);
  // Tokens are letters and numbers only (find_rules' tokensOf), so a quoted string needs no escaping.
  for (const t of q.terms) parts.push(`text : "${t.tokens.join(" ")}"${t.prefix ? "*" : ""}`);
  return parts.join(" AND ");
}

/** The range of message numbers created from `sinceMs` up to `untilMs` in `r`'s chat, or undefined when none is. */
function timeRange(conn: Database, r: ProjectRef, sinceMs?: number, untilMs?: number): [number, number] | undefined | null {
  if (sinceMs === undefined && untilMs === undefined) return null;
  const edge = (cond: string, order: "ASC" | "DESC", at: number) =>
    conn
      .query<{ n: number }, [string, string, number]>(
        `SELECT n FROM chat_messages INDEXED BY chat_by_time WHERE machine_id = ?1 AND project_id = ?2 AND ${cond}
         ORDER BY created_ms ${order}, n ${order} LIMIT 1`,
      )
      .get(r.machineId, r.projectId, at)?.n;
  const lo = sinceMs === undefined ? 1 : edge("created_ms >= ?3", "ASC", sinceMs);
  const hi = untilMs === undefined ? Number.MAX_SAFE_INTEGER : edge("created_ms < ?3", "DESC", untilMs);
  if (lo === undefined || hi === undefined || lo > hi) return undefined;
  return [lo, hi];
}

/** The messages of `r`'s chat that `q` finds, newest first, and whether more are past them. */
export function find(conn: Database, r: ProjectRef, q: FindQuery): Found {
  const indexing = unfilled(conn) > 1 ? ({ indexing: true } as const) : {};
  const range = timeRange(conn, r, q.sinceMs, q.untilMs);
  if (range === undefined) return { messages: [], more: false, ...(q.count ? { count: 0 } : {}), ...indexing };
  const [lo, hi] = range ?? [1, Number.MAX_SAFE_INTEGER - 1];
  // One bound on each side: the index takes one of each, so a second would be checked row by row.
  const below = Math.min(q.beforeN ?? Number.MAX_SAFE_INTEGER, hi + 1);
  let where = `chat_find MATCH ?1 AND f.rowid < ?2 AND f.rowid >= ?3 AND m.machine_id = ?4 AND m.project_id = ?5`;
  const args: (string | number)[] = [matchOf(r, q), below, lo, r.machineId, r.projectId];
  if (q.sinceMs !== undefined) {
    args.push(q.sinceMs);
    where += ` AND m.created_ms >= ?${args.length}`;
  }
  if (q.untilMs !== undefined) {
    args.push(q.untilMs);
    where += ` AND m.created_ms < ?${args.length}`;
  }
  if (q.has?.includes("pinned")) {
    where += " AND f.rowid IN (SELECT message_n FROM chat_message_pins p WHERE p.machine_id = ?4 AND p.project_id = ?5)";
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
