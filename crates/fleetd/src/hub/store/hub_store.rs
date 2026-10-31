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
/// `assistants` whether it is a Navi.
fn with_repos(
    conn: &rusqlite::Connection,
    mut project: ProjectSummary,
) -> Result<ProjectSummary, StoreError> {
    let r = ProjectRef {
        machine_id: project.machine_id.clone(),
        project_id: project.project_id.clone(),
    };
    project.repos = crate::hub::repos::store::of(conn, &r)?;
    let navi = crate::hub::navi::store::of(conn, &r)?;
    project.avatar = crate::hub::projects::avatar::of(conn, &r)?;
    project.icon = Some(crate::hub::projects::icon::of(conn, &r)?);
    project.kind = navi.as_ref().map(|_| ProjectKind::Assistant);
    (project.created_by, project.archived_at, project.owner) = navi
        .map_or((None, None, None), |n| {
            (Some(n.created_by), n.archived_at, n.owner)
        });
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

    /// Drops the machine's record (`fleetd machine remove`); its projects and threads stay cached.
    pub fn machine_remove(&self, machine_id: &MachineId) -> Result<(), StoreError> {
        self.db.with(|conn| {
            conn.prepare_cached("DELETE FROM machines WHERE machine_id = ?")?
                .execute([&machine_id.as_str()])?;
            Ok(())
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
    /// that project's, not a project of its own, so it is left out (`project_get` still reads it).
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
                "assistants",
                "navi_sites",
                "project_avatars",
                "project_icons",
                "skill_versions",
                "skill_uses",
                "telegram_bridges",
                "telegram_cards",
            ] {
                conn.prepare_cached(&format!(
                    "DELETE FROM {table} WHERE machine_id = ? AND project_id = ?"
                ))?
                .execute(params![r.machine_id.as_str(), r.project_id.as_str()])?;
            }
            crate::hub::repos::store::remove_project(conn, r)?;
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
