//! `<node home>/sessions.sqlite`: the node's projects, sessions, runs, messages, items and machine event log. It is
//! the source of every snapshot and replay, and what lets a session resume after the node restarts or crashes.
//! Contract types are stored as JSON next to the few columns queries need.
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::sessions::{
    MachineEvent, MachineEventFrame, ProjectInfo, RunInfo, SessionSummary, ThreadItem,
    ThreadMessage,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::util::now_iso;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("stored json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type StoreResult<T> = Result<T, StoreError>;

/// How many machine events are kept for `subscribe{after}`; an older cursor gets a snapshot.
pub const EVENTS_KEPT: u64 = 10_000;

const SCHEMA: &str = "
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
PRAGMA user_version = 1;
";

/// What the node keeps about a session beyond its summary: everything a respawn needs to resume it in place.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLocal {
    /// claude files sessions by cwd, so this never changes once `started`.
    pub cwd: PathBuf,
    pub add_dirs: Vec<PathBuf>,
    /// The `CLAUDE_CONFIG_DIR` the session was started with; resuming needs the same one.
    pub config_dir: PathBuf,
    pub workspace_root: PathBuf,
    /// Set for worktree sessions.
    pub base_ref: Option<String>,
    pub branch: Option<String>,
    /// claude has been started with `--session-id` at least once: later starts use `--resume`.
    pub started: bool,
    /// The live process, so a node that crashed can kill it on start (and never a reused pid).
    pub pid: Option<u32>,
    pub pid_start: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SessionRow {
    pub summary: SessionSummary,
    pub local: SessionLocal,
}

pub struct NodeStore {
    conn: Mutex<Connection>,
    events_kept: u64,
}

impl NodeStore {
    pub fn open(path: &Path) -> StoreResult<Self> {
        if let Some(dir) = path.parent() {
            super::config::mkdir_private(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA busy_timeout = 5000")?;
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        conn.execute_batch("PRAGMA synchronous = NORMAL")?;
        Self::init(conn, EVENTS_KEPT)
    }

    #[cfg(test)]
    pub fn open_memory(events_kept: u64) -> StoreResult<Self> {
        Self::init(Connection::open_in_memory()?, events_kept)
    }

    fn init(conn: Connection, events_kept: u64) -> StoreResult<Self> {
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            events_kept,
        })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn tx<R>(&self, f: impl FnOnce(&Connection) -> StoreResult<R>) -> StoreResult<R> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    fn append(&self, conn: &Connection, event: MachineEvent) -> StoreResult<MachineEventFrame> {
        let at = Timestamp::from(now_iso());
        conn.execute(
            "INSERT INTO machine_events (at, json) VALUES (?1, ?2)",
            params![at.as_str(), serde_json::to_string(&event)?],
        )?;
        let seq = conn.last_insert_rowid() as u64;
        conn.execute(
            "DELETE FROM machine_events WHERE seq <= ?1",
            params![seq.saturating_sub(self.events_kept) as i64],
        )?;
        Ok(MachineEventFrame { seq, at, event })
    }

    pub fn upsert_project(&self, project: &ProjectInfo) -> StoreResult<MachineEventFrame> {
        self.tx(|conn| {
            conn.execute(
                "INSERT INTO projects (id, json) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET json = excluded.json",
                params![project.project_id.as_str(), serde_json::to_string(project)?],
            )?;
            self.append(conn, MachineEvent::ProjectUpserted(project.clone()))
        })
    }

    /// `None` when there was no such project.
    pub fn remove_project(&self, id: &str) -> StoreResult<Option<MachineEventFrame>> {
        self.tx(|conn| {
            if conn.execute("DELETE FROM projects WHERE id = ?1", [id])? == 0 {
                return Ok(None);
            }
            let project_id = fleetd_contracts::ids::ProjectId::unchecked(id);
            self.append(conn, MachineEvent::ProjectRemoved { project_id })
                .map(Some)
        })
    }

    pub fn project(&self, id: &str) -> StoreResult<Option<ProjectInfo>> {
        let json: Option<String> = self
            .lock()
            .query_row("SELECT json FROM projects WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(json.map(|j| serde_json::from_str(&j)).transpose()?)
    }

    pub fn projects(&self) -> StoreResult<Vec<ProjectInfo>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT json FROM projects ORDER BY id")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|j| Ok(serde_json::from_str(&j?)?)).collect()
    }

    pub fn session(&self, id: &str) -> StoreResult<Option<SessionRow>> {
        let row: Option<(String, String)> = self
            .lock()
            .query_row(
                "SELECT summary, local FROM sessions WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        row.map(|(s, l)| decode_session(&s, &l)).transpose()
    }

    pub fn sessions(&self) -> StoreResult<Vec<SessionRow>> {
        let conn = self.lock();
        let mut stmt = conn.prepare("SELECT summary, local FROM sessions ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.map(|row| {
            let (s, l) = row?;
            decode_session(&s, &l)
        })
        .collect()
    }

    /// Saves the session and the runs that changed in one transaction. With `announce`, also appends the summary to
    /// the machine stream and returns that frame; without, only node-local fields changed.
    pub fn commit(
        &self,
        row: &SessionRow,
        runs: &[&RunInfo],
        announce: bool,
    ) -> StoreResult<Option<MachineEventFrame>> {
        self.tx(|conn| {
            conn.execute(
                "INSERT INTO sessions (id, project_id, summary, local) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, local = excluded.local",
                params![
                    row.summary.session_id.as_str(),
                    row.summary.project_id.as_str(),
                    serde_json::to_string(&row.summary)?,
                    serde_json::to_string(&row.local)?
                ],
            )?;
            for run in runs {
                conn.execute(
                    "INSERT INTO runs (session_id, id, ordinal, json) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(session_id, id) DO UPDATE SET json = excluded.json",
                    params![
                        row.summary.session_id.as_str(),
                        run.id.as_str(),
                        run.ordinal as i64,
                        serde_json::to_string(run)?
                    ],
                )?;
            }
            if !announce {
                return Ok(None);
            }
            self.append(conn, MachineEvent::SessionUpdated(row.summary.clone()))
                .map(Some)
        })
    }

    /// Every run of the session, oldest first.
    pub fn runs(&self, session_id: &str) -> StoreResult<Vec<RunInfo>> {
        let conn = self.lock();
        let mut stmt =
            conn.prepare("SELECT json FROM runs WHERE session_id = ?1 ORDER BY ordinal")?;
        let rows = stmt.query_map([session_id], |r| r.get::<_, String>(0))?;
        rows.map(|j| Ok(serde_json::from_str(&j?)?)).collect()
    }

    /// Inserts, or replaces in place (keeping its position) a message with the same id.
    pub fn put_message(&self, session_id: &str, message: &ThreadMessage) -> StoreResult<()> {
        self.put(
            "messages",
            session_id,
            message.id.as_str(),
            serde_json::to_string(message)?,
        )
    }

    pub fn put_item(&self, session_id: &str, item: &ThreadItem) -> StoreResult<()> {
        self.put(
            "items",
            session_id,
            item.id.as_str(),
            serde_json::to_string(item)?,
        )
    }

    fn put(&self, table: &str, session_id: &str, id: &str, json: String) -> StoreResult<()> {
        self.lock().execute(
            &format!(
                "INSERT INTO {table} (session_id, id, json) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id, id) DO UPDATE SET json = excluded.json"
            ),
            params![session_id, id, json],
        )?;
        Ok(())
    }

    pub fn message(&self, session_id: &str, id: &str) -> StoreResult<Option<ThreadMessage>> {
        self.get("messages", session_id, id)
    }

    /// The full item, outputs uncut.
    pub fn item(&self, session_id: &str, id: &str) -> StoreResult<Option<ThreadItem>> {
        self.get("items", session_id, id)
    }

    fn get<T: serde::de::DeserializeOwned>(
        &self,
        table: &str,
        session_id: &str,
        id: &str,
    ) -> StoreResult<Option<T>> {
        let json: Option<String> = self
            .lock()
            .query_row(
                &format!("SELECT json FROM {table} WHERE session_id = ?1 AND id = ?2"),
                [session_id, id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(json.map(|j| serde_json::from_str(&j)).transpose()?)
    }

    /// The newest `limit` rows of a table for the session, oldest first, and whether older ones exist.
    fn newest<T: serde::de::DeserializeOwned>(
        &self,
        table: &str,
        session_id: &str,
        limit: usize,
    ) -> StoreResult<(Vec<T>, bool)> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!(
            "SELECT json FROM {table} WHERE session_id = ?1 ORDER BY rid DESC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![session_id, limit as i64 + 1], |r| {
            r.get::<_, String>(0)
        })?;
        let mut out = rows
            .map(|j| Ok(serde_json::from_str(&j?)?))
            .collect::<StoreResult<Vec<T>>>()?;
        let truncated = out.len() > limit;
        out.truncate(limit);
        out.reverse();
        Ok((out, truncated))
    }

    pub fn newest_messages(
        &self,
        session_id: &str,
        limit: usize,
    ) -> StoreResult<(Vec<ThreadMessage>, bool)> {
        self.newest("messages", session_id, limit)
    }

    pub fn newest_items(
        &self,
        session_id: &str,
        limit: usize,
    ) -> StoreResult<(Vec<ThreadItem>, bool)> {
        self.newest("items", session_id, limit)
    }

    /// The seq of the newest machine event ever appended (0 when none).
    pub fn latest_seq(&self) -> StoreResult<u64> {
        let seq: Option<i64> = self
            .lock()
            .query_row(
                "SELECT seq FROM sqlite_sequence WHERE name = 'machine_events'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(seq.unwrap_or(0) as u64)
    }

    /// The events after `after`, or `None` when some of them are no longer kept (or `after` is from another
    /// database) and the subscriber needs a snapshot instead.
    pub fn events_after(&self, after: u64) -> StoreResult<Option<Vec<MachineEventFrame>>> {
        let latest = self.latest_seq()?;
        if after > latest {
            return Ok(None);
        }
        let conn = self.lock();
        let oldest: Option<i64> =
            conn.query_row("SELECT MIN(seq) FROM machine_events", [], |r| r.get(0))?;
        if after < latest && oldest.is_none_or(|o| (o as u64) > after + 1) {
            return Ok(None);
        }
        let mut stmt =
            conn.prepare("SELECT seq, at, json FROM machine_events WHERE seq > ?1 ORDER BY seq")?;
        let rows = stmt.query_map([after as i64], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        rows.map(|row| {
            let (seq, at, json) = row?;
            Ok(MachineEventFrame {
                seq: seq as u64,
                at: Timestamp::from(at),
                event: serde_json::from_str(&json)?,
            })
        })
        .collect::<StoreResult<Vec<_>>>()
        .map(Some)
    }
}

fn decode_session(summary: &str, local: &str) -> StoreResult<SessionRow> {
    Ok(SessionRow {
        summary: serde_json::from_str(summary)?,
        local: serde_json::from_str(local)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::ids::ProjectId;

    fn project(id: &str) -> ProjectInfo {
        ProjectInfo {
            project_id: ProjectId::unchecked(id),
            title: id.into(),
            workspace_root: "/w".into(),
            updated_at: Timestamp::from("2026-10-18T00:00:00.000Z"),
        }
    }

    #[test]
    fn a_cursor_replays_what_is_kept_and_a_stale_or_foreign_one_gets_a_snapshot() {
        let store = NodeStore::open_memory(3).unwrap();
        assert_eq!(store.events_after(0).unwrap(), Some(vec![]));
        for id in ["a", "b", "c", "d", "e"] {
            store.upsert_project(&project(id)).unwrap();
        }
        assert_eq!(store.latest_seq().unwrap(), 5);
        // Seqs 3..=5 are kept: a hub at 2 or later replays, one at 1 missed seq 2.
        let seqs = |after| {
            store
                .events_after(after)
                .unwrap()
                .map(|v| v.iter().map(|f| f.seq).collect::<Vec<_>>())
        };
        assert_eq!(seqs(2), Some(vec![3, 4, 5]));
        assert_eq!(seqs(4), Some(vec![5]));
        assert_eq!(seqs(5), Some(vec![]));
        assert_eq!(seqs(1), None);
        // A cursor from before the node's database was reset.
        assert_eq!(seqs(9), None);
    }

    #[test]
    fn sessions_and_windows_survive_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.sqlite");
        {
            let store = NodeStore::open(&path).unwrap();
            for n in 0..5 {
                let message = ThreadMessage {
                    id: fleetd_contracts::prim::NonEmpty::unchecked(format!("m{n}")),
                    run_id: None,
                    role: fleetd_contracts::sessions::MessageRole::User,
                    text: format!("{n}"),
                    created_at: Timestamp::from("t"),
                };
                store.put_message("s1", &message).unwrap();
            }
            // Replacing m1 keeps its place.
            let mut m1 = store.message("s1", "m1").unwrap().unwrap();
            m1.text = "one".into();
            store.put_message("s1", &m1).unwrap();
        }
        let store = NodeStore::open(&path).unwrap();
        let (window, truncated) = store.newest_messages("s1", 4).unwrap();
        let texts: Vec<_> = window.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, ["one", "2", "3", "4"]);
        assert!(truncated);
        assert!(!store.newest_messages("s1", 5).unwrap().1);
    }
}
