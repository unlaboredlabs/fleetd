// Deleting a Navi erases it (D287 navi.delete-erases): `project_remove` of a
// Navi forgets it on its node, which also deletes its sessions, their transcripts and the attachments in its folder,
// then `erase` deletes everything of it the hub keeps: its chat and the events that carried it, its approvals and
// purchases (`requests`), asks and decisions, its orders and what they hold, its memory and skills, its attachments
// and its screen recordings, and the time inspector's record of its sessions. Its agents' slots and its own max agents
// go from the slot board, and its project.removed stays in the log for the open apps.
//
// The delete is marked as asked for first (`navi_erases`, `asked`): when its node removes the Navi but its answer
// never reaches the hub, `run` finishes the erase once the hub's cache no longer has the Navi, at the node's
// `project_removed` or the first snapshot after, and at the hub's start.
import type { Database } from "bun:sqlite";
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HubEventType, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { projectDirName } from "../memory/index.ts";
import type { HubDb } from "../store/db.ts";
import { events } from "../store/events.ts";
import { MACHINE_TABLES, store } from "../store/hub_store.ts";

/** Tables with the Navi's rows by `machine_id` and `project_id`. */
const BY_PROJECT = [
  "chat_messages", "chat_projects", "checklists", "leads", "lead_mcp", "approval_checks", "memory_imports",
  "memory_refreshes", "memory_refresh_lines", "navi_auto_approved", "navi_approvals", "navi_sites", "skill_versions",
  "skill_uses", "browser_sessions", "screen_waits", "session_prompts", "tasks", "slot_claims", "workstreams", "hub_links",
];

/** Tables with rows of the Navi's sessions, by `machine_id` and `thread_id`. */
const BY_THREAD = ["threads", "wakes", "queued_writes", "steers", "thread_accounts", "task_threads", "time_lead_runs", "time_wakes"];

/** Tables with the Navi's rows by `project_key` (`<machine>/<project>`). */
const BY_KEY = ["requests", "legacy_asks", "decisions"];

const projectKey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;

/** The slot board, as the slots area keeps it (`hub.area("slots")`); absent until that area is ported (D355). */
type Slots = { forgetProject(r: ProjectRef): void };

/** Marks the Navi's delete as asked for, before its node is asked: `run` finishes it if the answer never comes. */
export function asked(hub: Hub, r: ProjectRef): void {
  hub.db.conn
    .query("INSERT OR REPLACE INTO navi_erases (machine_id, project_id, asked_ms) VALUES (?, ?, ?)")
    .run(r.machineId, r.projectId, hub.clock.now());
}

/**
 * Erases each Navi whose delete was asked for and that the hub's cache no longer has: its node removed it, whether or
 * not its answer came. One its node still has waits. How many were erased.
 */
export function finishPending(hub: Hub): number {
  const pending = hub.db.conn
    .query<{ machine_id: string; project_id: string }, []>("SELECT machine_id, project_id FROM navi_erases")
    .all();
  let n = 0;
  for (const row of pending) {
    const r = { machineId: row.machine_id, projectId: row.project_id };
    if (store(hub).projectGet(r) === undefined) {
      erase(hub, r);
      n++;
    }
  }
  return n;
}

/**
 * A hub-wide row's key, which no project has: a hub-wide MCP server's and skill's are an empty machine and project.
 * Erasing it as a project's would delete every hub-wide server and skill.
 */
export const hubWide = (machineId: string, projectId: string) => machineId === "" || projectId === "";

/** Refuses a hub-wide key where a project's is meant. */
export function aProject(r: ProjectRef): void {
  if (hubWide(r.machineId, r.projectId)) {
    throw new Error("an empty machine or project id is the hub's own, not a project's: nothing was erased");
  }
}

/**
 * Projects the hub no longer has, whose rows an older hub left behind: `projects` names their id on no machine, yet a
 * table the forget or the erase clears still holds them, or a person's sidebar order or pins do. Each is erased and
 * forgotten as a project of a removed machine is. A project any machine has under that id is never touched, nor a
 * hub-wide row. Run at the hub's start; how many were pruned.
 */
export function pruneOrphans(hub: Hub): number {
  const found = orphans(hub.db.conn);
  for (const key of found) {
    const [machineId, projectId] = JSON.parse(key) as [string, string];
    const r = { machineId, projectId };
    erase(hub, r);
    store(hub).machineProjectForget(r);
  }
  return found.length;
}

/** `pruneOrphans`' projects, as JSON `[machine, project]`, in order. */
function orphans(c: Database): string[] {
  const live = new Set(c.query<{ project_id: string }, []>("SELECT project_id FROM projects").all().map((r) => r.project_id));
  const out = new Set<string>();
  const tables = [...MACHINE_TABLES, "workstreams", "tasks"].filter((t) => t !== "projects");
  for (const table of tables) {
    if (c.query("SELECT 1 FROM pragma_table_info(?) WHERE name = 'project_id'").get(table) === null) continue;
    for (const row of c.query<{ machine_id: string; project_id: string }, []>(`SELECT DISTINCT machine_id, project_id FROM ${table}`).all()) {
      if (!live.has(row.project_id) && !hubWide(row.machine_id, row.project_id)) out.add(JSON.stringify([row.machine_id, row.project_id]));
    }
  }
  for (const table of ["sidebar_orders", "chat_pins"]) {
    for (const { refs } of c.query<{ refs: string }, []>(`SELECT refs FROM ${table}`).all()) {
      let list: unknown;
      try {
        list = JSON.parse(refs);
      } catch {
        list = [];
      }
      if (!Array.isArray(list)) continue;
      for (const r of list as Partial<ProjectRef>[]) {
        if (typeof r?.machineId !== "string" || typeof r.projectId !== "string") continue;
        if (!live.has(r.projectId) && !hubWide(r.machineId, r.projectId)) out.add(JSON.stringify([r.machineId, r.projectId]));
      }
    }
  }
  // A BTreeSet of (machine, project): sorted by machine, then project.
  return [...out].sort((a, b) => {
    const [x, y] = [JSON.parse(a) as string[], JSON.parse(b) as string[]];
    return x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : x[1]! < y[1]! ? -1 : x[1]! > y[1]! ? 1 : 0;
  });
}

const ERASES: HubEventType[] = ["project.removed"];

/**
 * Prunes what older hubs left of deleted projects, then finishes the erases asked for at the hub's start, then at
 * each `project.removed`, until the hub stops.
 */
export async function run(hub: Hub): Promise<void> {
  try {
    const n = pruneOrphans(hub);
    if (n > 0) console.info(`erased what was left of ${n} deleted projects`);
  } catch (error) {
    console.warn(`what was left of deleted projects wasn't erased: ${(error as Error).message}`);
  }
  const signal = hub.shutdown.signal;
  const log = events(hub);
  let cursor = log.head();
  let due = true;
  while (!signal.aborted) {
    if (due) {
      try {
        finishPending(hub);
      } catch (error) {
        console.warn(`a deleted Navi's erase wasn't finished: ${(error as Error).message}`);
      }
    }
    try {
      let page = log.page(cursor, ERASES);
      if (page.events.length === 0 && !page.more) page = await log.wait({ cursor: page.cursor, types: ERASES, timeoutSec: 3600 }, signal);
      due = page.events.length > 0;
      cursor = page.cursor;
    } catch (error) {
      if (signal.aborted) return;
      console.warn(`navi erases: event log read failed: ${(error as Error).message}`);
      due = true;
      await new Promise<void>((done) => {
        const t = setTimeout(done, 5_000);
        signal.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
      });
    }
  }
}

/** Erases what the hub keeps of the Navi `r`, its rows and its files, and its mark. Run once its node has forgotten it. */
export function erase(hub: Hub, r: ProjectRef): void {
  aProject(r);
  // Its tasks' rows go below, so their slots are given back here, while the board still knows whose they are.
  hub.peek<Slots>("slots")?.forgetProject(r);
  eraseIn(hub.db, hub.config.home, r);
}

/** `erase` in the hub database `db` whose home is `home`: `fleetd machine remove` erases a machine's projects too. */
export function eraseIn(db: HubDb, home: string, r: ProjectRef): void {
  aProject(r);
  const { recordings, blobs } = db.transaction((c) => rows(c, r));
  // A hub with no home (an in-memory one) keeps no files: never a path relative to where it runs.
  if (home !== "") {
    for (const id of recordings) gone(join(home, "browser", id));
    const attachments = join(home, "attachments");
    for (const sha of blobs) {
      // A file another chat or order holds too stays.
      if (db.conn.query("SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1").get(sha) === null) gone(join(attachments, sha));
    }
    gone(join(home, "memory", r.machineId, projectDirName(r)));
    gone(join(home, "skills", "projects", r.machineId, projectDirName(r)));
  }
  db.conn.query("DELETE FROM navi_erases WHERE machine_id = ? AND project_id = ?").run(r.machineId, r.projectId);
}

/** Deletes the Navi's rows; the ids of its screen recordings and the files of its attachments, for their files. */
function rows(c: Database, r: ProjectRef): { recordings: string[]; blobs: Set<string> } {
  const [m, p, key] = [r.machineId, r.projectId, projectKey(r)];
  const strings = (sql: string, ...args: (string | number)[]) =>
    c
      .query<{ v: string }, (string | number)[]>(sql)
      .all(...args)
      .map((row) => row.v);
  const recordings = strings("SELECT session_id AS v FROM browser_sessions WHERE machine_id = ? AND project_id = ?", m, p);
  // Its orders, as `W<n>`.
  const orders = strings("SELECT 'W' || n AS v FROM workstreams WHERE machine_id = ? AND project_id = ?", m, p);
  const threads = new Set<string>();
  for (const sql of [
    "SELECT thread_id AS v FROM threads WHERE machine_id = ? AND project_id = ?",
    "SELECT thread_id AS v FROM leads WHERE machine_id = ? AND project_id = ?",
    "SELECT thread_id AS v FROM session_prompts WHERE machine_id = ? AND project_id = ?",
    "SELECT thread_id AS v FROM memory_refreshes WHERE machine_id = ? AND project_id = ? AND thread_id IS NOT NULL",
  ]) {
    for (const t of strings(sql, m, p)) threads.add(t);
  }
  const ordersJson = JSON.stringify(orders);
  const blobs = new Set(
    strings("SELECT sha256 AS v FROM attachments WHERE project = ? OR workstream_id IN (SELECT value FROM json_each(?))", key, ordersJson),
  );
  c.query("DELETE FROM attachments WHERE project = ? OR workstream_id IN (SELECT value FROM json_each(?))").run(key, ordersJson);
  for (const table of ["navi_ask_orders", "order_env", "time_orders", "time_paths"]) {
    c.query(`DELETE FROM ${table} WHERE workstream_id IN (SELECT value FROM json_each(?))`).run(ordersJson);
  }
  c.query(
    `DELETE FROM automation_runs WHERE automation_id IN
       (SELECT automation_id FROM automations WHERE machine_id = ? AND project_id = ?)`,
  ).run(m, p);
  c.query("DELETE FROM automations WHERE machine_id = ? AND project_id = ?").run(m, p);
  // What its agents wrote to each other: each message's recipients, then the messages.
  c.query("DELETE FROM agent_message_to WHERE message_n IN (SELECT n FROM agent_messages WHERE machine_id = ? AND project_id = ?)").run(m, p);
  c.query("DELETE FROM agent_messages WHERE machine_id = ? AND project_id = ?").run(m, p);
  // The time inspector's spans of its sessions, whose labels hold its commands, searches, URLs and paths: the spans,
  // then each label no other span uses.
  const spans = `FROM time_spans WHERE machine_id = ?1
       AND (project_id = ?2 OR thread_id IN (SELECT value FROM json_each(?3)))`;
  const threadsJson = JSON.stringify([...threads].sort());
  const labels = c
    .query<{ label_id: number }, [string, string, string]>(`SELECT DISTINCT label_id ${spans} AND label_id IS NOT NULL`)
    .all(m, p, threadsJson)
    .map((row) => row.label_id);
  c.query(`DELETE ${spans}`).run(m, p, threadsJson);
  for (const label of labels) {
    c.query("DELETE FROM time_labels WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM time_spans WHERE label_id = ?1)").run(label);
  }
  for (const table of BY_THREAD) {
    for (const t of [...threads].sort()) c.query(`DELETE FROM ${table} WHERE machine_id = ? AND thread_id = ?`).run(m, t);
  }
  for (const table of BY_PROJECT) c.query(`DELETE FROM ${table} WHERE machine_id = ? AND project_id = ?`).run(m, p);
  for (const table of BY_KEY) c.query(`DELETE FROM ${table} WHERE project_key = ?`).run(key);
  c.query(
    `DELETE FROM navi_asks WHERE (from_machine_id = ?1 AND from_project_id = ?2)
       OR (to_machine_id = ?1 AND to_project_id = ?2)`,
  ).run(m, p);
  // The event log: its chat's messages ride in their events, under `data.projectRef`; the rest name it at the top.
  // Its project.removed stays: open apps read the log after it to drop the project (W465).
  c.query(
    `DELETE FROM events WHERE type != 'project.removed'
       AND ((machine_id = ?1 AND json_extract(data, '$.projectId') = ?2)
         OR (json_extract(data, '$.data.projectRef.machineId') = ?1
             AND json_extract(data, '$.data.projectRef.projectId') = ?2))`,
  ).run(m, p);
  // Without its name, as nothing else of it stays: the removal says only which id went from which machine.
  c.query(
    `UPDATE events SET data = json_set(json_remove(data, '$.data'), '$.summary', ?3)
     WHERE type = 'project.removed' AND machine_id = ?1 AND json_extract(data, '$.projectId') = ?2`,
  ).run(m, p, `A project on ${m} was removed`);
  return { recordings, blobs };
}

/** Removes a file or a folder; nothing there is no error, and what can't go is logged. */
function gone(path: string): void {
  try {
    lstatSync(path);
  } catch {
    return;
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.warn(`a deleted Navi's file was not removed (${path}): ${(error as Error).message}`);
  }
}
