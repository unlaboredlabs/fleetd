use super::{HubDb, StoreError};
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::model::{Machine, MachineStatus, ProjectKind, ProjectSummary, ThreadSummary};
use rusqlite::{OptionalExtension, named_params, params};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredThread {
    #[serde(flatten)]
    pub thread: ThreadSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sequence: Option<i64>,
    /// The session's latest run id when this row was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_id: Option<String>,
    /// That run's phase: a ThreadStatus, or "usage_limited".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_status: Option<String>,
}

/// The tables [`HubStore::machine_remove`] clears by `machine_id`: the machine itself, what its node reported (its
/// projects, sessions, checkouts) and what the hub holds for them (chats, settings, secrets, leads, slots, Navis).
pub(crate) const MACHINE_TABLES: &[&str] = &[
    "machines",
    "node_keys",
    "enroll_tokens",
    "machine_roles",
    "slot_machine_caps",
    "slot_shares",
    "slot_claims",
    "shell_cursors",
    "cloud_outbox",
    "projects",
    "project_settings",
    "project_env",
    "project_avatars",
    "project_icons",
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
    "navi_approvals",
    "navi_auto_approved",
    "navi_sites",
    "skill_versions",
    "skill_uses",
    "artifact_versions",
    "browser_sessions",
    "screen_waits",
    "vault_shares",
    "vault_deliveries",
    "vault_imports",
];

/// Tables with a `machine_id` that [`HubStore::machine_remove`] keeps. The event log, the time inspector and the
/// factory metrics are the record of work done, which each prunes by its own retention; its orders and their train
/// changes and reviews are what the metrics and the train name by id (`machine remove` erases those of the projects
/// the hub lists for it first, as deleting each project would: `navi::erase`). `navi_erases` is a Navi's delete still to
/// finish (`navi::erase`), which also removes its files. `pair_codes` names the machine an agents' Mac setup code
/// joins (hub/pair/mac.rs): the code outlives the old Mac's removal, which is how a new Mac replaces it, and the sweep
/// prunes it with the other codes. A test holds every table to one list or the other.
#[cfg(test)]
pub(super) const MACHINE_KEEPS: &[&str] = &[
    "events",
    "time_spans",
    // The spans' hourly digests (the Bun hub's), kept as long as the spans.
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
    "navi_erases",
    "pair_codes",
    // Every use of the vault: the person's audit, pruned after a year (vault.rs AUDIT_DAYS).
    "vault_audit",
];

/// [`HubStore::machine_remove`]'s deletes, in the caller's transaction. How many rows went.
fn forget_machine(conn: &rusqlite::Connection, m: &str) -> rusqlite::Result<usize> {
    let mut n = conn
        .prepare_cached(
            "DELETE FROM automation_runs WHERE automation_id IN
               (SELECT automation_id FROM automations WHERE machine_id = ?)",
        )?
        .execute([m])?;
    for table in MACHINE_TABLES {
        n += conn
            .prepare_cached(&format!("DELETE FROM {table} WHERE machine_id = ?"))?
            .execute([m])?;
    }
    // As `project_remove` does for each project: a repo whose checkout was on it goes too.
    for sql in [
        "DELETE FROM repos WHERE machine_id = ?1 OR checkout_machine_id = ?1",
        "DELETE FROM navi_asks WHERE from_machine_id = ?",
        "DELETE FROM session_places WHERE origin_machine = ?",
        // Its projects' and orders' items; a person's and the hub's name no machine (a NULL machine_id, so not in
        // MACHINE_TABLES, whose rows the orphan sweep reads as strings).
        "DELETE FROM vault_items WHERE machine_id = ?",
    ] {
        n += conn.prepare_cached(sql)?.execute([m])?;
    }
    Ok(n)
}

/// Caches of what the hub has seen of each machine. Reads return what was written; staleness is the reader's call.
pub struct HubStore {
    db: Arc<HubDb>,
}

fn decode<T: serde::de::DeserializeOwned>(data: String) -> Result<T, StoreError> {
    Ok(serde_json::from_str(&data)?)
}

fn decode_all<T: serde::de::DeserializeOwned>(
    conn: &rusqlite::Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<T>, StoreError> {
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(params, |row| row.get::<_, String>(0))?;
    rows.map(|data| decode(data?)).collect()
}

fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The project with what the hub keeps of it, whatever its stored row says: its repos from `repos`, and from
/// `project_settings` whether only its owner has it (a Navi, sent as `kind: assistant` too for one release).
fn with_repos(
    conn: &rusqlite::Connection,
    mut project: ProjectSummary,
) -> Result<ProjectSummary, StoreError> {
    let r = ProjectRef {
        machine_id: project.machine_id.clone(),
        project_id: project.project_id.clone(),
    };
    project.repos = crate::hub::repos::store::of(conn, &r)?;
    let kept = crate::hub::navi::store::kept(conn, &r)?.unwrap_or_default();
    project.avatar = crate::hub::projects::avatar::of(conn, &r)?;
    project.icon = Some(crate::hub::projects::icon::of(conn, &r)?);
    project.only_me = kept.only_me;
    project.kind = project.only_me.then_some(ProjectKind::Assistant);
    (project.created_by, project.archived_at, project.owner) =
        (kept.created_by, kept.archived_at, kept.owner);
    Ok(project)
}

const MACHINE_UPSERT: &str = "INSERT INTO machines (machine_id, data) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET data = excluded.data";
const MACHINE_GET: &str = "SELECT data FROM machines WHERE machine_id = ?";

fn get_machine(
    conn: &rusqlite::Connection,
    machine_id: &MachineId,
) -> Result<Option<Machine>, StoreError> {
    let data: Option<String> = conn
        .prepare_cached(MACHINE_GET)?
        .query_row([&machine_id.as_str()], |row| row.get(0))
        .optional()?;
    data.map(decode).transpose()
}

impl HubStore {
    pub fn new(db: Arc<HubDb>) -> Self {
        Self { db }
    }

    pub fn db(&self) -> &HubDb {
        &self.db
    }

    /// `pub_key`, when given, replaces the machine's node key.
    pub fn machine_upsert(
        &self,
        machine: &Machine,
        pub_key: Option<&str>,
    ) -> Result<(), StoreError> {
        let data = serde_json::to_string(machine)?;
        self.db.transaction(|conn| {
            conn.prepare_cached(MACHINE_UPSERT)?.execute(params![machine.machine_id.as_str(), data])?;
            if let Some(pub_key) = pub_key {
                conn.prepare_cached(
                    "INSERT INTO node_keys (machine_id, pub_key) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET pub_key = excluded.pub_key",
                )?
                .execute(params![machine.machine_id.as_str(), pub_key])?;
            }
            Ok(())
        })
    }

    pub fn machine_get(&self, machine_id: &MachineId) -> Result<Option<Machine>, StoreError> {
        self.db.with(|conn| get_machine(conn, machine_id))
    }

    pub fn machines_list(&self) -> Result<Vec<Machine>, StoreError> {
        self.db
            .with(|conn| decode_all(conn, "SELECT data FROM machines ORDER BY machine_id", []))
    }

    /// The titles of the machine's projects that have a lead, by title: what removing the machine stops.
    pub fn machine_lead_projects(&self, machine_id: &MachineId) -> Result<Vec<String>, StoreError> {
        self.db.with(|conn| {
            let titles = conn
                .prepare_cached(
                    "SELECT coalesce(json_extract(p.data, '$.title'), l.project_id) AS title FROM leads l
                     LEFT JOIN projects p ON p.machine_id = l.machine_id AND p.project_id = l.project_id
                     WHERE l.machine_id = ? ORDER BY title",
                )?
                .query_map([machine_id.as_str()], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(titles)
        })
    }

    /// Sets the status and `lastSeenAt = at`. A no-op for an unknown machine.
    pub fn machine_set_status(
        &self,
        machine_id: &MachineId,
        status: MachineStatus,
        at: &Timestamp,
    ) -> Result<(), StoreError> {
        self.db.transaction(|conn| {
            if let Some(mut machine) = get_machine(conn, machine_id)? {
                machine.status = status;
                machine.last_seen_at = at.clone();
                conn.prepare_cached(MACHINE_UPSERT)?.execute(params![
                    machine_id.as_str(),
                    serde_json::to_string(&machine)?
                ])?;
            }
            Ok(())
        })
    }

    /// Forgets the machine (`fleetd machine remove`): every row of its in [`MACHINE_TABLES`], keyed by its id, so
    /// another machine's rows under the same project ids stay. What `MACHINE_KEEPS` holds is history and stays.
    /// Safe to run again: it clears what an older remove left behind. How many rows went.
    pub fn machine_remove(&self, machine_id: &MachineId) -> Result<usize, StoreError> {
        self.db
            .transaction(|conn| Ok(forget_machine(conn, machine_id.as_str())?))
    }

    /// Forgets one project of a machine the hub no longer has, where no node is left to remove it: its rows in
    /// [`MACHINE_TABLES`] that name it or one of its threads, as [`Self::machine_remove`] does for the whole machine.
    /// Another machine's rows under the same project id stay. How many rows went.
    pub fn machine_project_forget(&self, r: &ProjectRef) -> Result<usize, StoreError> {
        // A hub-wide row's empty key is no project's: forgetting it would delete every hub-wide server and skill.
        crate::hub::navi::erase::a_project(r)?;
        let (m, p) = (r.machine_id.as_str(), r.project_id.as_str());
        self.db.transaction(|conn| {
            let mut n = conn
                .prepare_cached(
                    "DELETE FROM automation_runs WHERE automation_id IN
                       (SELECT automation_id FROM automations WHERE machine_id = ? AND project_id = ?)",
                )?
                .execute([m, p])?;
            let mut by_project = Vec::new();
            for table in MACHINE_TABLES {
                let columns: Vec<String> = conn
                    .prepare_cached("SELECT name FROM pragma_table_info(?)")?
                    .query_map([table], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                if columns.iter().any(|c| c == "project_id") {
                    by_project.push(table);
                } else if columns.iter().any(|c| c == "thread_id") {
                    // Before `threads` goes: it says which threads are the project's.
                    n += conn
                        .prepare_cached(&format!(
                            "DELETE FROM {table} WHERE machine_id = ?1 AND thread_id IN
                               (SELECT thread_id FROM threads WHERE machine_id = ?1 AND project_id = ?2)"
                        ))?
                        .execute([m, p])?;
                }
            }
            for table in by_project {
                n += conn
                    .prepare_cached(&format!(
                        "DELETE FROM {table} WHERE machine_id = ? AND project_id = ?"
                    ))?
                    .execute([m, p])?;
            }
            for sql in [
                "DELETE FROM repos WHERE (machine_id = ?1 AND project_id = ?2)
                   OR (checkout_machine_id = ?1 AND checkout_project_id = ?2)",
                "DELETE FROM navi_asks WHERE from_machine_id = ? AND from_project_id = ?",
                "DELETE FROM session_places WHERE origin_machine = ? AND project_id = ?",
                "DELETE FROM vault_items WHERE machine_id = ? AND project_id = ?",
            ] {
                n += conn.prepare_cached(sql)?.execute([m, p])?;
            }
            crate::hub::sidebar_order::forget(conn, r)?;
            crate::hub::chat_pins::forget(conn, r)?;
            Ok(n)
        })
    }

    pub fn projects_upsert_many(
        &self,
        machine_id: &MachineId,
        projects: &[ProjectSummary],
    ) -> Result<(), StoreError> {
        self.db.transaction(|conn| {
            let mut stmt = conn.prepare_cached(
                "INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (machine_id, project_id) DO UPDATE SET
         search = excluded.search, last_activity_at = excluded.last_activity_at, data = excluded.data",
            )?;
            for project in projects {
                // Its repos are the hub's, served from `repos` (`with_repos`); a node never knows them.
                let row = ProjectSummary {
                    machine_id: machine_id.clone(),
                    repos: Vec::new(),
                    kind: None,
                    only_me: false,
                    created_by: None,
                    archived_at: None,
                    owner: None,
                    avatar: None,
                    icon: None,
                    ..project.clone()
                };
                stmt.execute(params![
                    machine_id.as_str(),
                    row.project_id.as_str(),
                    format!("{}\n{}", row.title, row.workspace_root),
                    row.last_activity_at.as_str(),
                    serde_json::to_string(&row)?,
                ])?;
                let r = ProjectRef { machine_id: machine_id.clone(), project_id: row.project_id };
                crate::hub::repos::store::ensure_own(conn, &r, None)?;
            }
            Ok(())
        })
    }

    /// Every project the nodes reported, attached checkouts too, newest activity first. `query` matches title or
    /// workspace root, case-insensitively.
    pub fn projects_list(
        &self,
        machine_id: Option<&MachineId>,
        query: Option<&str>,
    ) -> Result<Vec<ProjectSummary>, StoreError> {
        self.projects(machine_id, query, false)
    }

    /// [`Self::projects_list`] as people and leads see it: a checkout another project holds as one of its repos is
    /// that project's, not a project of its own, so it is left out (`project_get` still reads it), and so is a cloud
    /// machine's clone of a project's checkout (D306), which hosts no project of its own.
    pub fn projects_shown(
        &self,
        machine_id: Option<&MachineId>,
        query: Option<&str>,
    ) -> Result<Vec<ProjectSummary>, StoreError> {
        self.projects(machine_id, query, true)
    }

    fn projects(
        &self,
        machine_id: Option<&MachineId>,
        query: Option<&str>,
        shown: bool,
    ) -> Result<Vec<ProjectSummary>, StoreError> {
        let query = query
            .filter(|q| !q.is_empty())
            .map(|q| format!("%{}%", escape_like(q)));
        self.db.with(|conn| {
            decode_all(
                conn,
                r"SELECT data FROM projects
       WHERE ($machine IS NULL OR machine_id = $machine) AND ($query IS NULL OR search LIKE $query ESCAPE '\')
         AND NOT ($shown AND EXISTS (SELECT 1 FROM repos r WHERE r.checkout_machine_id = projects.machine_id
           AND r.checkout_project_id = projects.project_id
           AND NOT (r.machine_id = projects.machine_id AND r.project_id = projects.project_id)))
         AND NOT ($shown AND EXISTS (SELECT 1 FROM node_keys k WHERE k.machine_id = projects.machine_id AND k.pool = 1))
       ORDER BY last_activity_at DESC",
                named_params! {
                    "$machine": machine_id.map(MachineId::as_str), "$query": query, "$shown": shown
                },
            )?
            .into_iter()
            .map(|p| with_repos(conn, p))
            .collect()
        })
    }

    pub fn project_get(&self, r: &ProjectRef) -> Result<Option<ProjectSummary>, StoreError> {
        self.db.with(|conn| {
            let data: Option<String> = conn
                .prepare_cached(
                    "SELECT data FROM projects WHERE machine_id = ? AND project_id = ?",
                )?
                .query_row(
                    params![r.machine_id.as_str(), r.project_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            data.map(|data| with_repos(conn, decode(data)?)).transpose()
        })
    }

    /// Drops the project, its cached threads, its settings and its repos, once its node no longer has it.
    pub fn project_remove(&self, r: &ProjectRef) -> Result<(), StoreError> {
        self.db.transaction(|conn| {
            for table in [
                "projects",
                "threads",
                "project_settings",
                "project_env",
                "mcp_servers",
                "order_env",
                "memory_refreshes",
                "memory_refresh_lines",
                "navi_sites",
                "navi_approvals",
                "navi_auto_approved",
                "project_avatars",
                "project_icons",
                "skill_versions",
                "skill_uses",
                "artifact_versions",
            ] {
                conn.prepare_cached(&format!(
                    "DELETE FROM {table} WHERE machine_id = ? AND project_id = ?"
                ))?
                .execute(params![r.machine_id.as_str(), r.project_id.as_str()])?;
            }
            crate::hub::repos::store::remove_project(conn, r)?;
            crate::hub::sidebar_order::forget(conn, r)?;
            crate::hub::chat_pins::forget(conn, r)?;
            Ok(())
        })
    }

    /// An absent `last_sequence`, `last_run_id` or `last_run_status` keeps the stored one.
    pub fn thread_upsert(&self, stored: &StoredThread) -> Result<(), StoreError> {
        let thread = &stored.thread;
        let data = serde_json::to_string(thread)?;
        self.db.with(|conn| {
            conn.prepare_cached(
                "INSERT INTO threads (machine_id, thread_id, project_id, last_progress_at, last_sequence, last_run_id, last_run_status, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (machine_id, thread_id) DO UPDATE SET
         project_id = excluded.project_id, last_progress_at = excluded.last_progress_at,
         last_sequence = COALESCE(excluded.last_sequence, threads.last_sequence),
         last_run_id = COALESCE(excluded.last_run_id, threads.last_run_id),
         last_run_status = COALESCE(excluded.last_run_status, threads.last_run_status), data = excluded.data",
            )?
            .execute(params![
                thread.machine_id.as_str(),
                thread.thread_id.as_str(),
                thread.project_id.as_str(),
                thread.last_progress_at.as_str(),
                stored.last_sequence,
                stored.last_run_id,
                stored.last_run_status,
                data,
            ])?;
            Ok(())
        })
    }

    pub fn thread_get(&self, r: &ThreadRef) -> Result<Option<StoredThread>, StoreError> {
        self.db.with(|conn| {
            let row = conn
                .prepare_cached(
                    "SELECT data, last_sequence, last_run_id, last_run_status FROM threads WHERE machine_id = ? AND thread_id = ?",
                )?
                .query_row(params![r.machine_id.as_str(), r.thread_id.as_str()], |row| {
                    Ok((row.get::<_, String>(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .optional()?;
            row.map(|(data, last_sequence, last_run_id, last_run_status)| {
                Ok(StoredThread { thread: decode(data)?, last_sequence, last_run_id, last_run_status })
            })
            .transpose()
        })
    }

    /// Threads whose last known status is "running", on every machine; stale rows never run again.
    pub fn threads_running(&self) -> Result<Vec<ThreadSummary>, StoreError> {
        self.db.with(|conn| {
            decode_all(
                conn,
                "SELECT data FROM threads WHERE json_extract(data, '$.status') = 'running' AND COALESCE(json_extract(data, '$.stale'), 0) = 0",
                [],
            )
        })
    }

    /// Newest progress first.
    pub fn threads_by_project(
        &self,
        r: &ProjectRef,
        limit: i64,
    ) -> Result<Vec<ThreadSummary>, StoreError> {
        self.db.with(|conn| {
            decode_all(
                conn,
                "SELECT data FROM threads WHERE machine_id = ? AND project_id = ? ORDER BY last_progress_at DESC LIMIT ?",
                params![r.machine_id.as_str(), r.project_id.as_str(), limit],
            )
        })
    }

    /// Marks the machine's rows outside `present` stale, as of `as_of`; returns how many it marked. A thread its node
    /// has no session for never resumes (risk 7 of the native runner: threads from before it).
    pub fn threads_mark_stale(
        &self,
        machine_id: &MachineId,
        present: &std::collections::HashSet<String>,
        as_of: &str,
    ) -> Result<usize, StoreError> {
        self.db.with(|conn| {
            let ids: Vec<String> = conn
                .prepare_cached(
                    "SELECT thread_id FROM threads WHERE machine_id = ? AND COALESCE(json_extract(data, '$.stale'), 0) = 0",
                )?
                .query_map([machine_id.as_str()], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            let mut marked = 0;
            for id in ids.iter().filter(|id| !present.contains(*id)) {
                marked += conn
                    .prepare_cached(
                        "UPDATE threads SET data = json_set(data, '$.stale', json('true'), '$.asOf', ?) WHERE machine_id = ? AND thread_id = ?",
                    )?
                    .execute(params![as_of, machine_id.as_str(), id])?;
            }
            Ok(marked)
        })
    }

    /// The machine stream's cursor per machine.
    pub fn cursor_get(&self, machine_id: &MachineId) -> Result<Option<i64>, StoreError> {
        self.db.with(|conn| {
            Ok(conn
                .prepare_cached("SELECT seq FROM shell_cursors WHERE machine_id = ?")?
                .query_row([&machine_id.as_str()], |row| row.get(0))
                .optional()?)
        })
    }

    pub fn cursor_set(&self, machine_id: &MachineId, seq: i64) -> Result<(), StoreError> {
        self.db.with(|conn| {
            conn.prepare_cached(
                "INSERT INTO shell_cursors (machine_id, seq) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET seq = excluded.seq",
            )?
            .execute(params![machine_id.as_str(), seq])?;
            Ok(())
        })
    }
}
