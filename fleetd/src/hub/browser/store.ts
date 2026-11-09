// Agents' browser sessions (table `browser_sessions`, one row per session with it as JSON) and their recordings,
// under `<home>/browser/<sessionId>/` as the node uploaded them, already scrubbed.
// An hourly prune expires recordings past the retention (`browser_settings`): each one after its days, and a
// project's oldest while its recordings together are over its size.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserRetention, BrowserSession, BrowserSessionEventData, ProjectRef } from "../../shared/contracts.ts";
import {
  CAP_SESSION_END,
  DEFAULT_MAX_GB_PER_PROJECT,
  DEFAULT_RETENTION_DAYS,
  RECORDING_FILES,
  type RecordingFileName,
} from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import { isoMs } from "../auth/index.ts";
import { taskEnded } from "../machine_roles/places.ts";
import { isRecordingFile, isSessionId } from "./check.ts";
import { events } from "../store/events.ts";
import { link } from "../link/index.ts";

const DAY_MS = 86_400_000;
const GB = 2 ** 30;
const RETENTION_DAYS_KEY = "retention_days";
const MAX_GB_KEY = "max_gb_per_project";
/** What a lost recording's folder is renamed to on its way out: `.{id}.lost-<ms>`, beside the recordings. */
const ASIDE = ".lost-";
/** What a session the hub ended with its task says. */
export const OUTLIVED_NOTE = "its task ended with it still open, so the hub ended it";
/** How long the hub keeps telling a node of a screen it ended. */
const TELL_MS = DAY_MS;
/** A session still live or uploading this long after it started is a partial upload its node never finished. */
export const STALE_MS = DAY_MS;

/** Where a session's recording lives on the hub. Only a session id names one: never a path of its own. */
export function dirOf(hub: Hub, sessionId: string): string {
  if (!isSessionId(sessionId)) throw new Error(`not a browser session id: ${JSON.stringify(sessionId)}`);
  return join(hub.config.home, "browser", sessionId);
}
export const filePath = (hub: Hub, sessionId: string, file: RecordingFileName) =>
  join(dirOf(hub, sessionId), RECORDING_FILES[file].name);

/** The bytes a stored file holds now. */
export function storedBytes(hub: Hub, sessionId: string, file: RecordingFileName): number {
  if (!isRecordingFile(file)) return 0;
  try {
    return statSync(filePath(hub, sessionId, file)).size;
  } catch {
    return 0;
  }
}

const parseMs = (text: string) => {
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? undefined : ms;
};

/** Moves a session's recording out of its place, to delete once the database is free again. */
export function setAside(hub: Hub, id: string): string | undefined {
  const from = dirOf(hub, id);
  const to = join(hub.config.home, "browser", `.${id}${ASIDE}${hub.clock.now()}`);
  try {
    renameSync(from, to);
    return to;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    console.warn(`lost recording of ${id} not moved aside; deleting it in place:`, e);
    rmSync(from, { recursive: true, force: true });
    return undefined;
  }
}

export const deleteAside = (aside: string) => rm(aside, { recursive: true, force: true });

/**
 * Removes the recording folders no session keeps: those set aside that a stopped hub never deleted, and the folder of
 * a session that ended lost, which a late upload piece can make again. Returns how many it removed.
 */
export function sweepLost(hub: Hub): number {
  const root = join(hub.config.home, "browser");
  if (!existsSync(root)) return 0;
  const gone: string[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".") && name.includes(ASIDE)) {
      gone.push(join(root, name));
      continue;
    }
    // Anything else there is no session's: left alone.
    if (!isSessionId(name)) continue;
    const aside = hub.db.transaction((c) => (getOn(c, name)?.state === "lost" ? setAside(hub, name) : undefined));
    if (aside) gone.push(aside);
  }
  for (const path of gone) rmSync(path, { recursive: true, force: true });
  return gone.length;
}

function settingOn(c: Database, key: string, fallback: number): number {
  return c.query<{ value: number }, [string]>("SELECT value FROM browser_settings WHERE key = ?").get(key)?.value ?? fallback;
}

export function retentionOn(c: Database): BrowserRetention {
  return {
    retentionDays: settingOn(c, RETENTION_DAYS_KEY, DEFAULT_RETENTION_DAYS),
    maxGbPerProject: settingOn(c, MAX_GB_KEY, DEFAULT_MAX_GB_PER_PROJECT),
  };
}

export function setRetention(c: Database, r: BrowserRetention): void {
  for (const [key, value] of [
    [RETENTION_DAYS_KEY, r.retentionDays],
    [MAX_GB_KEY, r.maxGbPerProject],
  ] as const) {
    c.query(
      `INSERT INTO browser_settings (key, value) VALUES (?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }
}

export function getOn(c: Database, id: string): BrowserSession | undefined {
  const row = c.query<{ data: string }, [string]>("SELECT data FROM browser_sessions WHERE session_id = ?").get(id);
  return row ? (JSON.parse(row.data) as BrowserSession) : undefined;
}

export const get = (hub: Hub, id: string) => getOn(hub.db.conn, id);

/**
 * Writes a session, unless its row is already final: nothing replaces an expired one, and only its expiry replaces a
 * recorded one. The check is the write's own, so a report that read the row before another made it final can't undo
 * it. Whether it wrote.
 */
export function putOn(c: Database, s: BrowserSession, startedMs: number): boolean {
  const bytes = (s.files ?? []).reduce((n, f) => n + f.bytes, 0);
  return (
    c
      .query(
        `INSERT INTO browser_sessions (session_id, machine_id, project_id, started_ms, state, bytes, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (session_id) DO UPDATE SET state = excluded.state, bytes = excluded.bytes, data = excluded.data
         WHERE browser_sessions.state NOT IN ('recorded', 'expired')
           OR (browser_sessions.state = 'recorded' AND excluded.state = 'expired')`,
      )
      .run(s.sessionId, s.projectRef.machineId, s.projectRef.projectId, startedMs, s.state, bytes, stringify(s)).changes > 0
  );
}

/** A session as the Rust hub writes it: absent fields left out, none written as null. */
export const stringify = (s: BrowserSession) => JSON.stringify(s, (_, v) => (v === null ? undefined : v));

/** Writes a stored session back after a change, and tells the app; nothing when it became final meanwhile. */
export function save(hub: Hub, s: BrowserSession): void {
  const startedMs = parseMs(s.startedAt) ?? 0;
  if (hub.db.transaction((c) => putOn(c, s, startedMs))) announce(hub, s);
}

/**
 * Writes a session whose agent just asked for a person (`request_takeover`), and tells the app with a loud event: the
 * desktop's notification and the person's phone's push, which opens its live view.
 */
export function saveAsking(hub: Hub, s: BrowserSession): void {
  const startedMs = parseMs(s.startedAt) ?? 0;
  if (hub.db.transaction((c) => putOn(c, s, startedMs))) {
    announceAs(hub, s, `Needs you on its screen: ${s.takeoverReason ?? ""}`, "loud");
  }
}

const rows = (c: Database, sql: string, ...params: (string | number)[]): BrowserSession[] =>
  c
    .query<{ data: string }, (string | number)[]>(sql)
    .all(...params)
    .map((r) => JSON.parse(r.data) as BrowserSession);

/** A project's live sessions whose agent asked for a person and has no one yet. */
export const waiting = (hub: Hub, r: ProjectRef) =>
  rows(
    hub.db.conn,
    "SELECT data FROM browser_sessions WHERE machine_id = ?1 AND project_id = ?2 AND state = 'live'",
    r.machineId,
    r.projectId,
  ).filter((s) => s.takeoverReason !== undefined);

/** A project's sessions, newest first. */
export const list = (hub: Hub, r: ProjectRef, limit: number) =>
  rows(
    hub.db.conn,
    "SELECT data FROM browser_sessions WHERE machine_id = ?1 AND project_id = ?2 ORDER BY started_ms DESC LIMIT ?3",
    r.machineId,
    r.projectId,
    limit,
  );

/** Every live screen. */
export const liveSessions = (hub: Hub) => rows(hub.db.conn, "SELECT data FROM browser_sessions WHERE state = 'live'");

/**
 * Ends every live session whose task ended (cancelled, or done or failed past a screen's idle limit): lost on the
 * hub, for `tellNodes` to have its node close it. Returns how many it ended.
 */
export function endOutlived(hub: Hub): number {
  const now = hub.clock.now();
  const sessions = rows(
    hub.db.conn,
    `SELECT data FROM browser_sessions b WHERE b.state = 'live' AND ${taskEnded("json_extract(b.data, '$.taskId')", now)}`,
  );
  for (const s of sessions) {
    const { takeoverReason: _, ...rest } = s;
    save(hub, { ...rest, state: "lost", endedAt: isoMs(now), note: OUTLIVED_NOTE });
  }
  return sessions.length;
}

/** Each session told of, by id: the link of its node's it went out on. */
export type Told = Map<string, number>;

/**
 * Tells the agent's node of each session `endOutlived` ended, to close it and kill its processes: once per link, so
 * a node that was offline then, or reconnected since, hears of it when it links. Returns how many it told.
 */
export function tellNodes(hub: Hub, told: Told): number {
  const now = hub.clock.now();
  const sessions = rows(
    hub.db.conn,
    `SELECT data FROM browser_sessions WHERE state = 'lost' AND json_extract(data, '$.note') = ?1
       AND json_extract(data, '$.endedAt') >= ?2`,
    OUTLIVED_NOTE,
    isoMs(now - TELL_MS),
  );
  for (const id of told.keys()) if (!sessions.some((s) => s.sessionId === id)) told.delete(id);
  const nodes = link(hub);
  let sent = 0;
  for (const s of sessions) {
    const machine = s.projectRef.machineId;
    const linkId = nodes.linkId(machine);
    if (linkId === undefined || told.get(s.sessionId) === linkId || !nodes.can(machine, CAP_SESSION_END)) continue;
    if (nodes.send(machine, { t: "session_end", threadId: s.threadId, sessionId: s.sessionId })) {
      told.set(s.sessionId, linkId);
      sent += 1;
    }
  }
  return sent;
}

/** `browser.session`, which tells the app to read the session again. */
export function announce(hub: Hub, s: BrowserSession): void {
  announceAs(hub, s, `screen of ${s.taskId ?? "the lead"}: ${s.state}`, undefined);
}

function announceAs(hub: Hub, s: BrowserSession, summary: string, attention: "loud" | undefined): void {
  const data: BrowserSessionEventData = {
    projectRef: s.projectRef,
    sessionId: s.sessionId,
    state: s.state,
    control: s.control,
    ...(s.taskId === undefined ? {} : { taskId: s.taskId }),
  };
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "browser.session",
    machineId: s.projectRef.machineId,
    projectId: s.projectRef.projectId,
    threadId: s.threadId,
    summary,
    data,
    ...(attention ? { attention } : {}),
  });
}

/** Deletes a session's recording and marks it expired; its row stays, so the app can say it was there. */
function expire(hub: Hub, s: BrowserSession, startedMs: number): void {
  try {
    rmSync(dirOf(hub, s.sessionId), { recursive: true, force: true });
  } catch (e) {
    console.warn(`browser recording of ${s.sessionId} not deleted:`, e);
    return;
  }
  const { note: _, ...rest } = s;
  const next: BrowserSession = { ...rest, state: "expired", files: [] };
  if (hub.db.transaction((c) => putOn(c, next, startedMs))) announce(hub, next);
}

/** The bytes a session holds on the hub's disk now, whatever its row says. */
const onDisk = (hub: Hub, id: string) =>
  (Object.keys(RECORDING_FILES) as RecordingFileName[]).reduce((n, f) => n + storedBytes(hub, id, f), 0);

/**
 * The recordings past the retention, oldest first: those older than its days, then each project's oldest while its
 * recordings together are over its size. A partial upload counts toward the size by what it holds on disk; once it is
 * stale it goes as a recording does, before that never. Returns how many it expired.
 */
export function prune(hub: Hub): number {
  const now = hub.clock.now();
  const retention = retentionOn(hub.db.conn);
  const found = hub.db.all<{ machine_id: string; project_id: string; started_ms: number; bytes: number; data: string }>(
    `SELECT machine_id, project_id, started_ms, bytes, data FROM browser_sessions
     WHERE state IN ('recorded', 'uploading', 'live') ORDER BY started_ms ASC`,
  );
  const cutoff = now - retention.retentionDays * DAY_MS;
  const maxBytes = retention.maxGbPerProject * GB;
  const totals = new Map<string, number>();
  const sessions = found.map((row) => {
    const session = JSON.parse(row.data) as BrowserSession;
    const partial = session.state !== "recorded";
    const bytes = partial ? onDisk(hub, session.sessionId) : row.bytes;
    const project = `${row.machine_id}\u0000${row.project_id}`;
    totals.set(project, (totals.get(project) ?? 0) + bytes);
    return { project, startedMs: row.started_ms, bytes, partial, session };
  });
  let expired = 0;
  for (const s of sessions) {
    // An upload still going is never cut short.
    if (s.partial && s.startedMs >= now - STALE_MS) continue;
    const total = totals.get(s.project) ?? 0;
    if (s.startedMs >= cutoff && total <= maxBytes) continue;
    totals.set(s.project, total - s.bytes);
    expire(hub, s.session, s.startedMs);
    expired += 1;
  }
  return expired;
}
