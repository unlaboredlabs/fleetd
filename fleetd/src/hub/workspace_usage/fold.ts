// The Usage page's counts table (usage_facts): each thing it counts, folded from the tables that keep it, a batch at a
// time from each one's last row read. Rows only ever added (chat messages, orders, agents) fold once; answers that come
// later (an approval) fold when they come; states that can change back (an agent failed, an order stopped) are read
// whole each time, as there are few. Before people existed every message and lead's order was the owner's, so those
// count for the owner. A message copied into the chat from before it (`history`, an order's own words) is no one's
// message to a lead. Writes run inside the caller's transaction.
import type { Database } from "bun:sqlite";
import { parseMs } from "../store/time.ts";
import { ROLLUP_DAYS } from "../time/store.ts";
import type { Kind } from "./read.ts";

/** Rows read per source table per fold: a year of history folds in a few hundred milliseconds' steps. */
export const BATCH = 2_000;
export const DAY_MS = 86_400_000;
/** The counts are kept as long as the Time view's roll-ups, which hold the agent time beside them. */
export const KEEP_DAYS = ROLLUP_DAYS;


type Fact = { kind: Kind; key: string; at: number; m: string; p: string; order?: string | null; person?: string | null };

const cursor = (c: Database, source: string): number =>
  c.query<{ n: number }, [string]>("SELECT n FROM usage_cursors WHERE source = ?1").get(source)?.n ?? 0;

const setCursor = (c: Database, source: string, n: number) =>
  c.query("INSERT INTO usage_cursors (source, n) VALUES (?1, ?2) ON CONFLICT(source) DO UPDATE SET n = excluded.n").run(source, n);

function put(c: Database, f: Fact): void {
  c.query(
    `INSERT INTO usage_facts (kind, key, at_ms, machine_id, project_id, workstream_id, person_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(kind, key) DO UPDATE SET at_ms = excluded.at_ms, person_id = excluded.person_id`,
  ).run(f.kind, f.key, f.at, f.m, f.p, f.order ?? null, f.person ?? null);
}

/** The owner, and since when people are known: what came before is theirs. */
function owner(c: Database): { id: string; since: number } | undefined {
  const row = c
    .query<{ person_id: string; created_ms: number }, []>("SELECT person_id, created_ms FROM people WHERE role = 'owner' ORDER BY created_ms LIMIT 1")
    .get();
  return row ? { id: row.person_id, since: row.created_ms } : undefined;
}

const before = (o: ReturnType<typeof owner>, at: number) => (o !== undefined && at < o.since ? o.id : null);

function messages(c: Database, o: ReturnType<typeof owner>): boolean {
  const from = cursor(c, "chat");
  const rows = c
    .query<{ n: number; m: string; p: string; at: number; human: number; person: string | null }, [number, number]>(
      `SELECT n, machine_id AS m, project_id AS p, created_ms AS at,
         json_extract(data, '$.author') = 'human' AND json_extract(data, '$.history') IS NULL AS human,
         json_extract(data, '$.person.personId') AS person
       FROM chat_messages WHERE n > ?1 ORDER BY n LIMIT ?2`,
    )
    .all(from, BATCH);
  for (const r of rows) {
    if (r.human !== 1) continue;
    put(c, { kind: "message", key: String(r.n), at: r.at, m: r.m, p: r.p, person: r.person ?? before(o, r.at) });
  }
  if (rows.length > 0) setCursor(c, "chat", rows.at(-1)!.n);
  return rows.length === BATCH;
}

function orders(c: Database, o: ReturnType<typeof owner>): boolean {
  const from = cursor(c, "orders");
  const rows = c
    .query<{ n: number; m: string; p: string; id: string; at: string; person: string | null; by: string | null }, [number, number]>(
      `SELECT n, machine_id AS m, project_id AS p, json_extract(data, '$.workstreamId') AS id, json_extract(data, '$.createdAt') AS at,
         json_extract(data, '$.startedBy.personId') AS person, json_extract(data, '$.source.by') AS by
       FROM workstreams WHERE n > ?1 ORDER BY n LIMIT ?2`,
    )
    .all(from, BATCH);
  for (const r of rows) {
    const at = parseMs(r.at) ?? 0;
    // A lead's order from before people was the owner's; an automation's or the train's is nobody's.
    const lead = r.by !== null && (r.by === "human" || r.by.startsWith("lead:"));
    put(c, { kind: "order", key: r.id, at, m: r.m, p: r.p, order: r.id, person: r.person ?? (lead ? before(o, at) : null) });
  }
  if (rows.length > 0) setCursor(c, "orders", rows.at(-1)!.n);
  return rows.length === BATCH;
}

function agents(c: Database): boolean {
  const from = cursor(c, "tasks");
  const rows = c
    .query<{ n: number; m: string; p: string; id: string; order: string; at: string }, [number, number]>(
      `SELECT n, machine_id AS m, project_id AS p, json_extract(data, '$.taskId') AS id, workstream_id AS "order",
         json_extract(data, '$.createdAt') AS at
       FROM tasks WHERE n > ?1 ORDER BY n LIMIT ?2`,
    )
    .all(from, BATCH);
  for (const r of rows) put(c, { kind: "agent", key: r.id, at: parseMs(r.at) ?? 0, m: r.m, p: r.p, order: r.order });
  if (rows.length > 0) setCursor(c, "tasks", rows.at(-1)!.n);
  return rows.length === BATCH;
}

/** Agents failed and orders stopped, as they stand now: few, and either can change (a retry, an order reopened). */
function ended(c: Database): void {
  c.run("DELETE FROM usage_facts WHERE kind IN ('failed', 'stopped')");
  const failed = c
    .query<{ m: string; p: string; id: string; order: string; at: string | null }, []>(
      `SELECT machine_id AS m, project_id AS p, json_extract(data, '$.taskId') AS id, workstream_id AS "order",
         COALESCE(json_extract(data, '$.endedAt'), ended_at) AS at
       FROM tasks WHERE state = 'failed'`,
    )
    .all();
  for (const r of failed) put(c, { kind: "failed", key: r.id, at: parseMs(r.at ?? "") ?? 0, m: r.m, p: r.p, order: r.order });
  const stopped = c
    .query<{ m: string; p: string; id: string; at: string }, []>(
      `SELECT machine_id AS m, project_id AS p, json_extract(data, '$.workstreamId') AS id, json_extract(data, '$.updatedAt') AS at
       FROM workstreams WHERE state = 'stopped'`,
    )
    .all();
  for (const r of stopped) put(c, { kind: "stopped", key: r.id, at: parseMs(r.at) ?? 0, m: r.m, p: r.p, order: r.id });
}

type RequestRow = { n: number; key: string; at: string | null; by: string | null; person: string | null; order: string | null };
const REQUEST_COLUMNS = `n, project_key AS key, CASE WHEN state = 'open' THEN NULL ELSE json_extract(data, '$.answeredAt') END AS at,
  json_extract(data, '$.answeredBy') AS by, json_extract(data, '$.answeredByPerson.personId') AS person,
  json_extract(data, '$.workstreamId') AS "order"`;

/**
 * A request a person answered from one of their devices (`answeredBy` "human:<device>"). Not one the workspace closed
 * ("hub": its run ended, or it was answered elsewhere), a no-ask rule approved ("fleetd:no-ask") or a lead withdrew
 * ("lead:…"). From before people, the owner's.
 */
function answered(c: Database, r: RequestRow, o: ReturnType<typeof owner>): void {
  const at = r.at === null ? undefined : parseMs(r.at);
  if (at === undefined || r.by === null || !r.by.startsWith("human:")) return;
  const slash = r.key.indexOf("/");
  const person = r.person ?? before(o, at);
  put(c, { kind: "approval", key: String(r.n), at, m: r.key.slice(0, slash), p: r.key.slice(slash + 1), order: r.order, person });
}

/**
 * Approvals and secret requests answered: new requests a batch at a time ("requests", the last read), and again those
 * from the oldest still waiting at the last fold ("requests_open"), so an answer folds when it comes.
 */
function approvals(c: Database, o: ReturnType<typeof owner>): boolean {
  const seen = cursor(c, "requests");
  const open = c.query<{ n: number }, []>("SELECT n FROM usage_cursors WHERE source = 'requests_open'").get()?.n ?? seen;
  const again = c.query<RequestRow, [number, number]>(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE n > ?1 AND n <= ?2`).all(open, seen);
  for (const r of again) answered(c, r, o);
  const rows = c.query<RequestRow, [number, number]>(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE n > ?1 ORDER BY n LIMIT ?2`).all(seen, BATCH);
  for (const r of rows) answered(c, r, o);
  const last = rows.at(-1)?.n ?? seen;
  setCursor(c, "requests", last);
  const waiting = c.query<{ n: number | null }, [number]>("SELECT MIN(n) AS n FROM requests WHERE state = 'open' AND n <= ?1").get(last)?.n ?? null;
  setCursor(c, "requests_open", waiting === null ? last : waiting - 1);
  return rows.length === BATCH;
}

/** One fold step over every source table; true while some table has more to fold. */
export function fold(c: Database): boolean {
  const o = owner(c);
  // Orders before their agents, though a read joins them either way.
  const more = [orders(c, o), agents(c), messages(c, o), approvals(c, o)].some(Boolean);
  ended(c);
  return more;
}

/** Drops counts older than KEEP_DAYS. */
export function prune(c: Database, nowMs: number): void {
  c.query("DELETE FROM usage_facts WHERE at_ms < ?1").run(nowMs - KEEP_DAYS * DAY_MS);
}
