// Caches of what the hub has seen of each machine: machines, their projects and threads, and the machine stream's
// cursors. Reads return what was written; staleness is the reader's call.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type {
  Machine,
  MachineId,
  MachineStatus,
  ProjectRef,
  ProjectSummary,
  ThreadRef,
  ThreadSummary,
  Timestamp,
} from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import * as projectSettings from "../project_lead/store.ts";
import * as avatar from "../projects/avatar.ts";
import * as icon from "../projects/icon.ts";
import * as repos from "../repos/store.ts";
import type { HubDb } from "./db.ts";

/** A thread row: the summary, and what the node stream last said of its run. */
export type StoredThread = {
  thread: ThreadSummary;
  lastSequence?: number;
  /** The session's latest run id when this row was written. */
  lastRunId?: string;
  /** That run's phase: a ThreadStatus, or "usage_limited". */
  lastRunStatus?: string;
};

/** The hub's one store, `hub.area("store")`. */
export const store = (hub: Hub) => hub.area("store", (h) => new HubStore(h.db));

/**
 * The tables `machineRemove` clears by `machine_id`: the machine itself, what its node reported (its projects,
 * sessions, checkouts) and what the hub holds for them (chats, settings, secrets, leads, slots, projects).
 */
export const MACHINE_TABLES = [
  "machines",
  "node_keys",
  "enroll_tokens",
  "machine_roles",
  "slot_machine_caps",
  "slot_shares",
  "slot_claims",
  "shell_cursors",
  "projects",
  "project_settings",
  "project_env",
  "project_avatars",
  "project_icons",
  "project_setup_changes",
  "project_setup_clones",
  "project_profiles",
  "work_projects",
  "metric_project_repos",
  "threads",
  "thread_accounts",
  "task_threads",
  "session_prompts",
  "queued_writes",
  "wakes",
  "steers",
  "chat_projects",
  "chat_messages",
  "checklists",
  "leads",
  "lead_mcp",
  "approval_checks",
  "automations",
  "trains",
  "train_watches",
  "order_env",
  "github_order_tokens",
  "hub_links",
  "mcp_servers",
  "mcp_oauth",
  "mcp_secret_forgets",
  "memory_imports",
  "memory_refreshes",
  "memory_refresh_lines",
  "project_approvals",
  "project_auto_approved",
  "project_sites",
  "skill_versions",
  "skill_uses",
  "artifact_versions",
  "browser_sessions",
  "screen_waits",
  "vault_deliveries",
  "vault_imports",
] as const;

/**
 * Tables with a `machine_id` that `machineRemove` keeps: the record of work done, which each prunes by its own
 * retention, and what outlives a machine on purpose. A test holds every table to one list or the other.
 */
export const MACHINE_KEEPS = [
  "events",
  "time_spans",
  // The spans' hourly digests, kept as long as the spans.
  "time_digests",
  "time_orders",
  "time_lead_runs",
  "time_wakes",
  "metric_merges",
  "metric_touches",
  "workstreams",
  "tasks",
  // What its agents wrote to each other: the person's audit, kept with the tasks it names.
  "agent_messages",
  "changes",
  "project_erases",
  "pair_codes",
  // Every use of the vault: the person's audit, pruned after a year (vault.rs AUDIT_DAYS).
  "vault_audit",
] as const;

/** `machineRemove`'s deletes, in the caller's transaction. How many rows went. */
function forgetMachine(conn: Database, m: string): number {
  let n = conn
    .query(
      `DELETE FROM automation_runs WHERE automation_id IN
               (SELECT automation_id FROM automations WHERE machine_id = ?)`,
    )
    .run(m).changes;
  for (const table of MACHINE_TABLES) n += conn.query(`DELETE FROM ${table} WHERE machine_id = ?`).run(m).changes;
  // As `projectRemove` does for each project: a repo whose checkout was on it goes too.
  for (const sql of [
    "DELETE FROM repos WHERE machine_id = ?1 OR checkout_machine_id = ?1",
    "DELETE FROM project_asks WHERE from_machine_id = ?1",
    "DELETE FROM session_places WHERE origin_machine = ?1",
    // Its projects' and orders' variables; the team vault's items and those set aside name no machine (a NULL
    // machine_id, so not in MACHINE_TABLES, whose rows the orphan sweep reads as strings).
    "DELETE FROM vault_items WHERE machine_id = ?1",
  ]) {
    n += conn.query(sql).run(m).changes;
  }
  return n;
}

/** A person's saved list of project refs without `r` (hub/sidebar_order and hub/chat_pins `forget`). */
function forgetRef(conn: Database, table: "sidebar_orders" | "chat_pins", r: ProjectRef): void {
  const rows = conn.query<{ person_id: string; refs: string }, []>(`SELECT person_id, refs FROM ${table}`).all();
  for (const { person_id, refs } of rows) {
    let list: ProjectRef[];
    try {
      list = JSON.parse(refs) as ProjectRef[];
    } catch {
      if (table === "sidebar_orders") continue;
      list = [];
    }
    if (!Array.isArray(list)) continue;
    const same = (o: ProjectRef) => o.machineId === r.machineId && o.projectId === r.projectId;
    if (!list.some(same)) continue;
    const kept = list.filter((o) => !same(o)).map((o) => ({ machineId: o.machineId, projectId: o.projectId }));
    conn.query(`UPDATE ${table} SET refs = ? WHERE person_id = ?`).run(JSON.stringify(kept), person_id);
  }
}

/** An empty machine or project id is the hub's own, not a project's (hub/project_lead/erase.rs `a_project`). */
function aProject(r: ProjectRef): void {
  if (r.machineId === "" || r.projectId === "") {
    throw new Error("an empty machine or project id is the hub's own, not a project's: nothing was erased");
  }
}

/**
 * The project with what the hub keeps of it, whatever its stored row says: its repos from `repos`, and from
 * `project_settings` who made it, its archive and its bot's color.
 */
function withRepos(conn: Database, stored: ProjectSummary): ProjectSummary {
  const r = { machineId: stored.machineId, projectId: stored.projectId };
  const {
    repos: _repos,
    createdBy: _createdBy,
    archivedAt: _archivedAt,
    avatar: _avatar,
    avatarColor: _avatarColor,
    chatTags: _chatTags,
    icon: _icon,
    ...project
  } = stored;
  const out: ProjectSummary = project;
  const held = repos.of(conn, r);
  if (held.length > 0) out.repos = held;
  const kept = projectSettings.kept(conn, r) ?? {};
  if (kept.createdBy) out.createdBy = kept.createdBy;
  if (kept.archivedAt !== undefined) out.archivedAt = kept.archivedAt;
  if (kept.avatarColor !== undefined) out.avatarColor = kept.avatarColor;
  if (kept.chatTags) out.chatTags = true;
  const picture = avatar.of(conn, r);
  if (picture !== undefined) out.avatar = picture;
  out.icon = icon.of(conn, r);
  return out;
}

/** What a node's report keeps in the `projects` row: the hub's own fields are served from its tables. */
function nodeRow(machineId: MachineId, project: ProjectSummary): ProjectSummary {
  const {
    repos: _repos,
    createdBy: _createdBy,
    archivedAt: _archivedAt,
    avatar: _avatar,
    avatarColor: _avatarColor,
    chatTags: _chatTags,
    icon: _icon,
    ...row
  } = project;
  return { ...row, machineId };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const MACHINE_UPSERT =
  "INSERT INTO machines (machine_id, data) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET data = excluded.data";

type ThreadRow = { data: string; last_sequence: number | null; last_run_id: string | null; last_run_status: string | null };

export class HubStore {
  constructor(readonly db: HubDb) {}

  private get conn(): Database {
    return this.db.conn;
  }

  private decodeAll<T>(sql: string, params: SQLQueryBindings[] | Record<string, SQLQueryBindings> = []): T[] {
    return this.db.all<{ data: string }>(sql, params).map((r) => JSON.parse(r.data) as T);
  }

  private machine(machineId: MachineId): Machine | undefined {
    const row = this.conn.query<{ data: string }, [string]>("SELECT data FROM machines WHERE machine_id = ?").get(machineId);
    return row ? (JSON.parse(row.data) as Machine) : undefined;
  }

  /** `pubKey`, when given, replaces the machine's node key. */
  machineUpsert(machine: Machine, pubKey?: string): void {
    const data = JSON.stringify(machine);
    this.db.transaction((conn) => {
      conn.query(MACHINE_UPSERT).run(machine.machineId, data);
      if (pubKey !== undefined) {
        conn
          .query(
            "INSERT INTO node_keys (machine_id, pub_key) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET pub_key = excluded.pub_key",
          )
          .run(machine.machineId, pubKey);
      }
    });
  }

  machineGet(machineId: MachineId): Machine | undefined {
    return this.machine(machineId);
  }

  machinesList(): Machine[] {
    return this.decodeAll<Machine>("SELECT data FROM machines ORDER BY machine_id");
  }

  /** The titles of the machine's projects that have a lead, by title: what removing the machine stops. */
  machineLeadProjects(machineId: MachineId): string[] {
    return this.conn
      .query<{ title: string }, [string]>(
        `SELECT coalesce(json_extract(p.data, '$.title'), l.project_id) AS title FROM leads l
                     LEFT JOIN projects p ON p.machine_id = l.machine_id AND p.project_id = l.project_id
                     WHERE l.machine_id = ? ORDER BY title`,
      )
      .all(machineId)
      .map((r) => r.title);
  }

  /** Sets the status and `lastSeenAt = at`. A no-op for an unknown machine. */
  machineSetStatus(machineId: MachineId, status: MachineStatus, at: Timestamp): void {
    this.db.transaction((conn) => {
      const machine = this.machine(machineId);
      if (!machine) return;
      conn.query(MACHINE_UPSERT).run(machineId, JSON.stringify({ ...machine, status, lastSeenAt: at }));
    });
  }

  /**
   * Forgets the machine (`fleetd machine remove`): every row of its in MACHINE_TABLES, so another machine's rows
   * under the same project ids stay. Safe to run again. How many rows went.
   */
  machineRemove(machineId: MachineId): number {
    return this.db.transaction((conn) => forgetMachine(conn, machineId));
  }

  /**
   * Forgets one project of a machine the hub no longer has, where no node is left to remove it: its rows in
   * MACHINE_TABLES that name it or one of its threads. How many rows went.
   */
  machineProjectForget(r: ProjectRef): number {
    aProject(r);
    const { machineId: m, projectId: p } = r;
    return this.db.transaction((conn) => {
      let n = conn
        .query(
          `DELETE FROM automation_runs WHERE automation_id IN
                       (SELECT automation_id FROM automations WHERE machine_id = ? AND project_id = ?)`,
        )
        .run(m, p).changes;
      const byProject: string[] = [];
      for (const table of MACHINE_TABLES) {
        const columns = conn
          .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
          .all(table)
          .map((c) => c.name);
        if (columns.includes("project_id")) byProject.push(table);
        else if (columns.includes("thread_id")) {
          // Before `threads` goes: it says which threads are the project's.
          n += conn
            .query(
              `DELETE FROM ${table} WHERE machine_id = ?1 AND thread_id IN
                               (SELECT thread_id FROM threads WHERE machine_id = ?1 AND project_id = ?2)`,
            )
            .run(m, p).changes;
        }
      }
      for (const table of byProject) {
        n += conn.query(`DELETE FROM ${table} WHERE machine_id = ? AND project_id = ?`).run(m, p).changes;
      }
      for (const sql of [
        `DELETE FROM repos WHERE (machine_id = ?1 AND project_id = ?2)
                   OR (checkout_machine_id = ?1 AND checkout_project_id = ?2)`,
        "DELETE FROM project_asks WHERE from_machine_id = ?1 AND from_project_id = ?2",
        "DELETE FROM session_places WHERE origin_machine = ?1 AND project_id = ?2",
        "DELETE FROM vault_items WHERE machine_id = ?1 AND project_id = ?2",
      ]) {
        n += conn.query(sql).run(m, p).changes;
      }
      forgetRef(conn, "sidebar_orders", r);
      forgetRef(conn, "chat_pins", r);
      return n;
    });
  }

  projectsUpsertMany(machineId: MachineId, projects: ProjectSummary[]): void {
    this.db.transaction((conn) => {
      const stmt = conn.query(
        `INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (machine_id, project_id) DO UPDATE SET
         search = excluded.search, last_activity_at = excluded.last_activity_at, data = excluded.data`,
      );
      for (const project of projects) {
        // Its repos are the hub's, served from `repos` (`withRepos`); a node never knows them.
        const row = nodeRow(machineId, project);
        stmt.run(machineId, row.projectId, `${row.title}\n${row.workspaceRoot}`, row.lastActivityAt, JSON.stringify(row));
        repos.ensureOwn(conn, { machineId, projectId: row.projectId });
      }
    });
  }

  /**
   * Every project the nodes reported, attached checkouts too, newest activity first. `query` matches title or
   * workspace root, case-insensitively.
   */
  projectsList(machineId?: MachineId, query?: string): ProjectSummary[] {
    return this.projects(machineId, query, false);
  }

  /**
   * `projectsList` as people and leads see it: a checkout another project holds as one of its repos is that
   * project's, so it is left out (`projectGet` still reads it).
   */
  projectsShown(machineId?: MachineId, query?: string): ProjectSummary[] {
    return this.projects(machineId, query, true);
  }

  private projects(machineId: MachineId | undefined, query: string | undefined, shown: boolean): ProjectSummary[] {
    const like = query ? `%${escapeLike(query)}%` : null;
    return this.decodeAll<ProjectSummary>(
      `SELECT data FROM projects
       WHERE ($machine IS NULL OR machine_id = $machine) AND ($query IS NULL OR search LIKE $query ESCAPE '\\')
         AND NOT ($shown AND EXISTS (SELECT 1 FROM repos r WHERE r.checkout_machine_id = projects.machine_id
           AND r.checkout_project_id = projects.project_id
           AND NOT (r.machine_id = projects.machine_id AND r.project_id = projects.project_id)))
       ORDER BY last_activity_at DESC`,
      { machine: machineId ?? null, query: like, shown: shown ? 1 : 0 },
    ).map((p) => withRepos(this.conn, p));
  }

  projectGet(r: ProjectRef): ProjectSummary | undefined {
    const row = this.conn
      .query<{ data: string }, [string, string]>("SELECT data FROM projects WHERE machine_id = ? AND project_id = ?")
      .get(r.machineId, r.projectId);
    return row ? withRepos(this.conn, JSON.parse(row.data) as ProjectSummary) : undefined;
  }

  /** Drops the project, its cached threads, its settings and its repos, once its node no longer has it. */
  projectRemove(r: ProjectRef): void {
    this.db.transaction((conn) => {
      for (const table of [
        "projects",
        "threads",
        "project_settings",
        "project_env",
        "mcp_servers",
        "order_env",
        "memory_refreshes",
        "memory_refresh_lines",
        "project_sites",
        "project_approvals",
        "project_auto_approved",
        "project_avatars",
        "project_icons",
        "project_setup_changes",
        "project_setup_clones",
        "skill_versions",
        "skill_uses",
        "artifact_versions",
      ]) {
        conn.query(`DELETE FROM ${table} WHERE machine_id = ? AND project_id = ?`).run(r.machineId, r.projectId);
      }
      repos.removeProject(conn, r);
      forgetRef(conn, "sidebar_orders", r);
      forgetRef(conn, "chat_pins", r);
    });
  }

  /** An absent `lastSequence`, `lastRunId` or `lastRunStatus` keeps the stored one. */
  threadUpsert(stored: StoredThread): void {
    const t = stored.thread;
    this.conn
      .query(
        `INSERT INTO threads (machine_id, thread_id, project_id, last_progress_at, last_sequence, last_run_id, last_run_status, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (machine_id, thread_id) DO UPDATE SET
         project_id = excluded.project_id, last_progress_at = excluded.last_progress_at,
         last_sequence = COALESCE(excluded.last_sequence, threads.last_sequence),
         last_run_id = COALESCE(excluded.last_run_id, threads.last_run_id),
         last_run_status = COALESCE(excluded.last_run_status, threads.last_run_status), data = excluded.data`,
      )
      .run(
        t.machineId,
        t.threadId,
        t.projectId,
        t.lastProgressAt,
        stored.lastSequence ?? null,
        stored.lastRunId ?? null,
        stored.lastRunStatus ?? null,
        JSON.stringify(t),
      );
  }

  threadGet(r: ThreadRef): StoredThread | undefined {
    const row = this.conn
      .query<ThreadRow, [string, string]>(
        "SELECT data, last_sequence, last_run_id, last_run_status FROM threads WHERE machine_id = ? AND thread_id = ?",
      )
      .get(r.machineId, r.threadId);
    if (!row) return undefined;
    const out: StoredThread = { thread: JSON.parse(row.data) as ThreadSummary };
    if (row.last_sequence !== null) out.lastSequence = row.last_sequence;
    if (row.last_run_id !== null) out.lastRunId = row.last_run_id;
    if (row.last_run_status !== null) out.lastRunStatus = row.last_run_status;
    return out;
  }

  /** Threads whose last known status is "running", on every machine; stale rows never run again. */
  threadsRunning(): ThreadSummary[] {
    return this.decodeAll<ThreadSummary>(
      "SELECT data FROM threads WHERE json_extract(data, '$.status') = 'running' AND COALESCE(json_extract(data, '$.stale'), 0) = 0",
    );
  }

  /** Newest progress first. */
  threadsByProject(r: ProjectRef, limit: number): ThreadSummary[] {
    return this.decodeAll<ThreadSummary>(
      "SELECT data FROM threads WHERE machine_id = ? AND project_id = ? ORDER BY last_progress_at DESC LIMIT ?",
      [r.machineId, r.projectId, limit],
    );
  }

  /**
   * Marks the machine's rows outside `present` stale, as of `asOf`; returns how many it marked. A thread its node
   * has no session for never resumes.
   */
  threadsMarkStale(machineId: MachineId, present: Set<string>, asOf: string): number {
    const ids = this.conn
      .query<{ thread_id: string }, [string]>(
        "SELECT thread_id FROM threads WHERE machine_id = ? AND COALESCE(json_extract(data, '$.stale'), 0) = 0",
      )
      .all(machineId)
      .map((r) => r.thread_id);
    let marked = 0;
    const mark = this.conn.query(
      "UPDATE threads SET data = json_set(data, '$.stale', json('true'), '$.asOf', ?) WHERE machine_id = ? AND thread_id = ?",
    );
    for (const id of ids) if (!present.has(id)) marked += mark.run(asOf, machineId, id).changes;
    return marked;
  }

  /** The machine stream's cursor per machine. */
  cursorGet(machineId: MachineId): number | undefined {
    return (
      this.conn.query<{ seq: number }, [string]>("SELECT seq FROM shell_cursors WHERE machine_id = ?").get(machineId)?.seq ??
      undefined
    );
  }

  cursorSet(machineId: MachineId, seq: number): void {
    this.conn
      .query(
        "INSERT INTO shell_cursors (machine_id, seq) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET seq = excluded.seq",
      )
      .run(machineId, seq);
  }
}
