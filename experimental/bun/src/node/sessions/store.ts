// `<node home>/sessions.sqlite` (crates/fleetd/src/node/store.rs): the node's projects, sessions, runs, messages, items
// and machine event log, with the same schema the Rust node keeps, so either opens the other's. Contract types are
// stored as JSON next to the few columns queries need.
import { Database } from "bun:sqlite";
import type { MachineEvent, MachineEventFrame, ProjectInfo, RunInfo, SessionRole, SessionSummary, ThreadItem, ThreadMessage, WindowEntry, PendingPermission } from "./types.ts";

/** How many machine events are kept for `subscribe{after}`; an older cursor gets a snapshot. */
export const EVENTS_KEPT = 10_000;

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
  setup?: import("../../shared/contracts.ts").WorktreeSetup;
  setupPending?: boolean;
  profile?: string;
  fast?: boolean;
  helperModel?: string;
  systemPrompt?: string;
  queuedPrompts?: PendingPermission[];
  monitors?: { id: string; description?: string; untilMs: number }[];
  [more: string]: unknown;
};

export type SessionRow = { summary: SessionSummary; local: SessionLocal };

/** The event's JSON as serde writes an internally tagged enum: its tag first, then its fields. */
const eventJson = (event: MachineEvent) => JSON.stringify(event);

export class NodeStore {
  readonly db: Database;
  constructor(
    path: string,
    readonly eventsKept = EVENTS_KEPT,
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
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

  putSpans(spans: { sessionId: string; endMs: number }[]): void {
    if (!spans.length) return;
    this.tx(() => {
      const put = this.db.query("INSERT INTO spans (session_id, at_ms, json) VALUES (?, ?, ?)");
      for (const span of spans) put.run(span.sessionId, span.endMs, JSON.stringify(span));
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
