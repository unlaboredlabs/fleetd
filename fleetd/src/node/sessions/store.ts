// `<node home>/sessions.sqlite`: the node's projects, sessions, runs, messages, items
// and machine event log, with the same schema the Rust node keeps, so either opens the other's. Contract types are
// stored as JSON next to the few columns queries need.
import { Database } from "bun:sqlite";
import type { Plan } from "../worktree/setup.ts";
import type { MachineEvent, MachineEventFrame, ProjectInfo, RunInfo, SessionRole, SessionSummary, ThreadItem, ThreadMessage, WindowEntry, PendingPermission } from "./types.ts";

/** How many machine events are kept for `subscribe{after}`; an older cursor gets a snapshot. */
export const EVENTS_KEPT = 10_000;

/** The span outbox keeps at most this many rows, and none older than SPANS_KEPT_MS, while the hub is away. Past either
 * bound the oldest rows go and one `gap` span says how many, so the loss shows in coverage. The gap spans these drops
 * add have keys under `node/gap/`. */
export const SPANS_KEPT = 500_000;
export const SPANS_KEPT_MS = 7 * 24 * 3600 * 1000;
const SPANS_DROP_BATCH = 5_000;
/** A session's steps (`items`: tool calls and their outputs) are kept this long after they last changed; its
 * messages, the chat itself, and the steps of a session at work now are kept whatever their age. */
export const ITEMS_KEPT_MS = 30 * 24 * 3600 * 1000;
/** Rows pruneItems looks at per transaction, so no other store call waits long on it. */
export const ITEMS_PRUNE_BATCH = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, summary TEXT NOT NULL, local TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  session_id TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (session_id, id));
CREATE TABLE IF NOT EXISTS messages (
  rid INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL,
  UNIQUE (session_id, id));
CREATE TABLE IF NOT EXISTS items (
  rid INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL,
  UNIQUE (session_id, id));
CREATE TABLE IF NOT EXISTS machine_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS spans (
  rid INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, at_ms INTEGER NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS spans_by_at ON spans (at_ms);
PRAGMA user_version = 2;
`;

/** What the node keeps about a session beyond its summary: everything a respawn needs to resume it in place. Fields
 * this port doesn't use (an MCP role, skills, a Claude account) are kept as the Rust node wrote them. */
export type SessionLocal = {
  cwd: string;
  addDirs: string[];
  configDir: string;
  workspaceRoot: string;
  baseRef?: string;
  branch?: string;
  started: boolean;
  pid?: number;
  pidStart?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  allowedOnly?: boolean;
  role?: SessionRole;
  orderId?: string;
  setup?: Plan;
  setupPending?: boolean;
  profile?: string;
  fast?: boolean;
  helperModel?: string;
  systemPrompt?: string;
  queuedPrompts?: PendingPermission[];
  monitors?: { id: string; description?: string; untilMs: number }[];
  /** The session whose scratch dir ($TMPDIR) it uses: the earliest of the sessions it took over (a task restarted
   * fresh), so the task goes on with the files it kept there. Absent: its own. */
  scratchOf?: string;
  [more: string]: unknown;
};

export type SessionRow = { summary: SessionSummary; local: SessionLocal };

/** The event's JSON as serde writes an internally tagged enum: its tag first, then its fields. */
const eventJson = (event: MachineEvent) => JSON.stringify(event);

export class NodeStore {
  readonly db: Database;
  /** The rid of the last gap span the outbox's drops added (0 when none): later drops raise its count while it's still
   * in the outbox and not sent yet. */
  #openGap = 0;
  constructor(
    path: string,
    readonly eventsKept = EVENTS_KEPT,
  ) {
    this.db = new Database(path, { create: true, strict: true });
    // As the Rust store: WAL with NORMAL syncs at checkpoints, not on every commit.
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  tx<R>(fn: () => R): R {
    return this.db.transaction(fn)();
  }

  #append(event: MachineEvent): MachineEventFrame {
    const at = new Date().toISOString();
    const { lastInsertRowid } = this.db.query("INSERT INTO machine_events (at, json) VALUES (?, ?)").run(at, eventJson(event));
    const seq = Number(lastInsertRowid);
    this.db.query("DELETE FROM machine_events WHERE seq <= ?").run(Math.max(0, seq - this.eventsKept));
    return { seq, at, event };
  }

  upsertProject(project: ProjectInfo): MachineEventFrame {
    return this.tx(() => {
      this.db
        .query("INSERT INTO projects (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
        .run(project.projectId, JSON.stringify(project));
      return this.#append({ type: "project_upserted", ...project });
    });
  }

  appendEvent(event: MachineEvent): MachineEventFrame {
    return this.tx(() => this.#append(event));
  }

  /** undefined when there was no such project. */
  removeProject(id: string): MachineEventFrame | undefined {
    return this.tx(() => {
      if (this.db.query("DELETE FROM projects WHERE id = ?").run(id).changes === 0) return undefined;
      return this.#append({ type: "project_removed", projectId: id });
    });
  }

  /** Deletes the project's sessions and everything they hold, and their summaries from the machine stream. */
  forgetSessions(projectId: string): void {
    this.tx(() => {
      for (const table of ["runs", "messages", "items", "spans"])
        this.db.query(`DELETE FROM ${table} WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)`).run(projectId);
      this.db.query("DELETE FROM sessions WHERE project_id = ?").run(projectId);
      this.db
        .query("DELETE FROM machine_events WHERE json_extract(json, '$.type') = 'session_updated' AND json_extract(json, '$.projectId') = ?")
        .run(projectId);
    });
  }

  project(id: string): ProjectInfo | undefined {
    const row = this.db.query<{ json: string }, [string]>("SELECT json FROM projects WHERE id = ?").get(id);
    return row ? (JSON.parse(row.json) as ProjectInfo) : undefined;
  }

  projects(): ProjectInfo[] {
    return this.db.query<{ json: string }, []>("SELECT json FROM projects ORDER BY id").all().map((r) => JSON.parse(r.json) as ProjectInfo);
  }

  session(id: string): SessionRow | undefined {
    const row = this.db.query<{ summary: string; local: string }, [string]>("SELECT summary, local FROM sessions WHERE id = ?").get(id);
    return row ? { summary: JSON.parse(row.summary), local: JSON.parse(row.local) } : undefined;
  }

  sessions(): SessionRow[] {
    return this.db
      .query<{ summary: string; local: string }, []>("SELECT summary, local FROM sessions ORDER BY rowid")
      .all()
      .map((r) => ({ summary: JSON.parse(r.summary), local: JSON.parse(r.local) }));
  }

  /** Saves the session and the runs that changed in one transaction; with `announce`, appends its summary to the
   * machine stream and returns that frame. */
  commit(row: SessionRow, runs: RunInfo[], announce: boolean): MachineEventFrame | undefined {
    return this.tx(() => {
      this.db
        .query(
          `INSERT INTO sessions (id, project_id, summary, local) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, local = excluded.local`,
        )
        .run(row.summary.sessionId, row.summary.projectId, JSON.stringify(row.summary), JSON.stringify(row.local));
      const put = this.db.query(
        `INSERT INTO runs (session_id, id, ordinal, json) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, id) DO UPDATE SET json = excluded.json`,
      );
      for (const run of runs) put.run(row.summary.sessionId, run.id, run.ordinal, JSON.stringify(run));
      return announce ? this.#append({ type: "session_updated", ...row.summary }) : undefined;
    });
  }

  runs(sessionId: string): RunInfo[] {
    return this.db
      .query<{ json: string }, [string]>("SELECT json FROM runs WHERE session_id = ? ORDER BY ordinal")
      .all(sessionId)
      .map((r) => JSON.parse(r.json) as RunInfo);
  }

  #put(table: "messages" | "items", sessionId: string, id: string, json: string): void {
    this.db
      .query(`INSERT INTO ${table} (session_id, id, json) VALUES (?, ?, ?) ON CONFLICT(session_id, id) DO UPDATE SET json = excluded.json`)
      .run(sessionId, id, json);
  }

  putMessage(sessionId: string, message: ThreadMessage): void {
    this.#put("messages", sessionId, message.id, JSON.stringify(message));
  }

  putItem(sessionId: string, item: ThreadItem): void {
    this.#put("items", sessionId, item.id, JSON.stringify(item));
  }

  #get<T>(table: string, sessionId: string, id: string): T | undefined {
    const row = this.db.query<{ json: string }, [string, string]>(`SELECT json FROM ${table} WHERE session_id = ? AND id = ?`).get(sessionId, id);
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  message(sessionId: string, id: string): ThreadMessage | undefined {
    return this.#get("messages", sessionId, id);
  }

  item(sessionId: string, id: string): ThreadItem | undefined {
    return this.#get("items", sessionId, id);
  }

  #newest<T>(table: string, sessionId: string, limit: number): [T[], boolean] {
    const rows = this.db
      .query<{ json: string }, [string, number]>(`SELECT json FROM ${table} WHERE session_id = ? ORDER BY rid DESC LIMIT ?`)
      .all(sessionId, limit + 1)
      .map((r) => JSON.parse(r.json) as T);
    const truncated = rows.length > limit;
    return [rows.slice(0, limit).reverse(), truncated];
  }

  newestMessages(sessionId: string, limit: number): [ThreadMessage[], boolean] {
    return this.#newest("messages", sessionId, limit);
  }

  newestItems(sessionId: string, limit: number): [ThreadItem[], boolean] {
    return this.#newest("items", sessionId, limit);
  }

  /** The newest outbox row ever written (0 when none). */
  spansHead(): number {
    return this.db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'spans'").get()?.seq ?? 0;
  }

  spansAfter(after: number, limit: number): [number, unknown][] {
    return this.db
      .query<{ rid: number; json: string }, [number, number]>("SELECT rid, json FROM spans WHERE rid > ? ORDER BY rid LIMIT ?")
      .all(after, limit)
      .map((r) => [r.rid, JSON.parse(r.json)]);
  }

  /** Appends spans to the outbox in one transaction, then holds the outbox to its bounds. `sent` is the newest row sent
   * to the hub: a gap span past it may still take a later drop's count. */
  putSpans(spans: { sessionId: string; endMs: number }[], nowMs = Date.now(), kept = SPANS_KEPT, sent = 0): void {
    if (!spans.length) return;
    this.tx(() => {
      const put = this.db.query("INSERT INTO spans (session_id, at_ms, json) VALUES (?, ?, ?)");
      for (const span of spans) put.run(span.sessionId, span.endMs, JSON.stringify(span));
      this.#boundSpans(nowMs, kept, sent);
    });
  }

  /** Rows go only from the oldest end (acks and drops), so the row count is `max - min + 1`. A drop raises the count of
   * the last gap span the drops added while it's still here and not sent (the hub ignores a span it has already), so a
   * long outage costs one gap row, not one per span; else it adds a gap span, and leaves room for it. A gap span
   * dropped in turn passes its count on, unless it was sent. As store.rs. */
  #boundSpans(nowMs: number, kept: number, sent: number): void {
    for (;;) {
      // Each bound a lookup, as a full outbox takes this on every put: one MIN and one MAX in the same SELECT scan the
      // table, and so does the first young row's scan unless the oldest row is young.
      const { min, max } = this.db
        .query<{ min: number | null; max: number | null }, []>("SELECT (SELECT MIN(rid) FROM spans) AS min, (SELECT MAX(rid) FROM spans) AS max")
        .get()!;
      if (min === null || max === null) return;
      const cutoff = nowMs - SPANS_KEPT_MS;
      const oldest = this.db.query<{ at: number }, [number]>("SELECT at_ms AS at FROM spans WHERE rid = ?").get(min)!.at;
      const firstYoung = oldest >= cutoff ? min : this.db.query<{ r: number | null }, [number]>("SELECT MIN(rid) AS r FROM spans WHERE at_ms >= ?").get(cutoff)!.r;
      const byAge = firstYoung === null ? max : firstYoung - 1;
      const uptoWith = (room: number) => Math.min(Math.max(byAge, max - min + 1 > kept ? max - kept + room : min - 1), min + SPANS_DROP_BATCH - 1);
      const rid = this.#openGap;
      const open = rid > uptoWith(0) && rid > sent ? this.db.query<{ json: string }, [number]>("SELECT json FROM spans WHERE rid = ?").get(rid) : null;
      const upto = open ? uptoWith(0) : uptoWith(1);
      if (upto < min) return;
      const dropped = this.db
        .query<{ n: number; first: number; last: number; session: string }, [number, number]>(
          `WITH d AS (SELECT session_id, at_ms, json, rid > ?2 AND json_extract(json, '$.key') LIKE 'node/gap/%' AS gap
             FROM spans WHERE rid <= ?1)
           SELECT SUM(IIF(gap, COALESCE(json_extract(json, '$.extra.count'), 1), 1)) AS n,
             MIN(IIF(gap, json_extract(json, '$.startMs'), at_ms)) AS first,
             MAX(IIF(gap, json_extract(json, '$.endMs'), at_ms)) AS last, MIN(session_id) AS session FROM d`,
        )
        .get(upto, sent)!;
      this.db.query("DELETE FROM spans WHERE rid <= ?").run(upto);
      if (open) {
        const gap = JSON.parse(open.json) as { startMs?: number; endMs?: number; extra?: { count?: number } };
        gap.startMs = Math.max(0, Math.min(gap.startMs ?? dropped.first, dropped.first));
        gap.endMs = Math.max(0, gap.endMs ?? dropped.last, dropped.last);
        gap.extra = { ...gap.extra, count: (gap.extra?.count ?? 0) + dropped.n };
        this.db.query("UPDATE spans SET at_ms = ?, json = ? WHERE rid = ?").run(nowMs, JSON.stringify(gap), rid);
        continue;
      }
      const gap = {
        key: `node/gap/${upto}`,
        kind: "gap",
        sessionId: dropped.session,
        startMs: Math.max(0, dropped.first),
        endMs: Math.max(0, dropped.last, dropped.first),
        status: "incomplete",
        extra: { count: dropped.n, reason: "the node's span outbox was full while the hub was away" },
      };
      this.#openGap = Number(this.db.query("INSERT INTO spans (session_id, at_ms, json) VALUES (?, ?, ?)").run(dropped.session, nowMs, JSON.stringify(gap)).lastInsertRowid);
      console.warn(`${new Date().toISOString()} WARN span outbox full: dropped the oldest spans {"dropped":${dropped.n}}`);
    }
  }

  /** One batch of the items prune: of the ITEMS_PRUNE_BATCH rows after row `after`, deletes those last updated before
   * `before` (RFC 3339), but none of a session with an active run. How many went, and the row to go on after, or
   * undefined once the rest is newer: rows are numbered as they are first stored, so the oldest come first. */
  pruneItems(after: number, before: string): [number, number | undefined] {
    return this.tx(() => {
      const { last, oldest } = this.db
        .query<{ last: number | null; oldest: string | null }, [number, number]>(
          "SELECT MAX(rid) AS last, MIN(json_extract(json, '$.updatedAt')) AS oldest FROM (SELECT rid, json FROM items WHERE rid > ? ORDER BY rid LIMIT ?)",
        )
        .get(after, ITEMS_PRUNE_BATCH)!;
      if (last === null) return [0, undefined];
      const gone = this.db
        .query(
          `DELETE FROM items WHERE rid > ? AND rid <= ? AND json_extract(json, '$.updatedAt') < ?
             AND session_id NOT IN (SELECT id FROM sessions WHERE json_extract(summary, '$.activeRunId') IS NOT NULL)`,
        )
        .run(after, last, before).changes;
      return [gone, oldest !== null && oldest < before ? last : undefined];
    });
  }

  spansAcked(upto: number): void {
    this.db.query("DELETE FROM spans WHERE rid <= ?").run(upto);
  }

  /** The items around `itemId` and the messages between them, in time order; with the index of the item. */
  window(sessionId: string, itemId: string, before: number, after: number): [WindowEntry[], number | undefined] {
    const rid = this.db.query<{ rid: number }, [string, string]>("SELECT rid FROM items WHERE session_id = ? AND id = ?").get(sessionId, itemId)?.rid;
    if (rid === undefined) {
      const message = this.message(sessionId, itemId);
      return message ? [[{ kind: "message", ...message }], 0] : [[], undefined];
    }
    const read = (sql: string, limit: number) =>
      this.db
        .query<{ json: string }, [string, number, number]>(sql)
        .all(sessionId, rid, limit)
        .map((r) => JSON.parse(r.json) as ThreadItem);
    const older = read("SELECT json FROM items WHERE session_id = ? AND rid < ? ORDER BY rid DESC LIMIT ?", before).reverse();
    const newer = read("SELECT json FROM items WHERE session_id = ? AND rid > ? ORDER BY rid LIMIT ?", after);
    const focus = JSON.parse(this.db.query<{ json: string }, [number]>("SELECT json FROM items WHERE rid = ?").get(rid)!.json) as ThreadItem;
    const first = (older[0] ?? focus).startedAt;
    const last = (newer[newer.length - 1] ?? focus).updatedAt;
    const messages = this.db
      .query<{ json: string }, [string]>("SELECT json FROM messages WHERE session_id = ? ORDER BY rid DESC LIMIT 500")
      .all(sessionId)
      .map((r) => JSON.parse(r.json) as ThreadMessage)
      .filter((m) => m.createdAt >= first && m.createdAt <= last)
      .slice(0, before + after + 1);
    const entries: [string, WindowEntry][] = [
      ...[...older, focus, ...newer].map((i): [string, WindowEntry] => [i.startedAt, Object.assign({ kind: "item" }, i)]),
      ...messages.map((m): [string, WindowEntry] => [m.createdAt, { kind: "message", ...m }]),
    ];
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const at = entries.findIndex(([, e]) => e.kind !== "message" && e.id === focus.id);
    return [entries.map(([, e]) => e), at < 0 ? undefined : at];
  }

  /** The seq of the newest machine event ever appended (0 when none). */
  latestSeq(): number {
    return this.db.query<{ seq: number }, []>("SELECT seq FROM sqlite_sequence WHERE name = 'machine_events'").get()?.seq ?? 0;
  }

  /** The events after `after`, or undefined when some are no longer kept (or `after` is from another database). */
  eventsAfter(after: number): MachineEventFrame[] | undefined {
    const latest = this.latestSeq();
    if (after > latest) return undefined;
    const oldest = this.db.query<{ m: number | null }, []>("SELECT MIN(seq) AS m FROM machine_events").get()?.m ?? null;
    if (after < latest && (oldest === null || oldest > after + 1)) return undefined;
    return this.db
      .query<{ seq: number; at: string; json: string }, [number]>("SELECT seq, at, json FROM machine_events WHERE seq > ? ORDER BY seq")
      .all(after)
      .map((r) => ({ seq: r.seq, at: r.at, event: JSON.parse(r.json) as MachineEvent }));
  }
}
