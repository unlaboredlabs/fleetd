//! Task rows: the Task as JSON in `data`, plus the columns queries filter on. TS spec: apps/hub/src/tasks/TaskRecords.ts.
use std::collections::HashSet;

use fleetd_contracts::ids::{ProjectRef, ThreadRef};
use fleetd_contracts::tasks::{Task, TaskCounts, TaskId, TaskState};
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::TaskFilter;

#[derive(Clone, Debug)]
pub struct StoredTask {
    pub task: Task,
    /// A `task message` that waits for a slot or lease before it goes out.
    pub pending_message: Option<String>,
}

pub const ENDED_STATES: [TaskState; 3] = [TaskState::Done, TaskState::Failed, TaskState::Cancelled];

fn number_of(task_id: &TaskId) -> i64 {
    task_id.as_str()[1..].parse().unwrap_or(0)
}

fn state_str(state: TaskState) -> String {
    serde_json::to_value(state).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

fn decode(data: &str) -> rusqlite::Result<Task> {
    serde_json::from_str(data).map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

fn stored_of(row: &Row<'_>) -> rusqlite::Result<StoredTask> {
    Ok(StoredTask { task: decode(&row.get::<_, String>(0)?)?, pending_message: row.get(1)? })
}

/// Over the hub's one SQLite connection; callers hold its lock.
pub struct TaskRecords;

impl TaskRecords {
    fn write(db: &Connection, stored: &StoredTask) -> rusqlite::Result<()> {
        let t = &stored.task;
        db.prepare_cached("UPDATE tasks SET state = ?, thread_id = ?, ended_at = ?, pending_message = ?, data = ? WHERE n = ?")?.execute(params![
            state_str(t.state),
            t.thread_ref.as_ref().map(|r| r.thread_id.as_str().to_owned()),
            t.ended_at.as_ref().map(|e| e.as_str().to_owned()),
            stored.pending_message,
            serde_json::to_string(t).expect("a Task encodes"),
            number_of(&t.task_id),
        ])?;
        Ok(())
    }

    /// Numbers the task (`T<n>`) and stores it. `task.task_id` is ignored.
    pub fn create(db: &Connection, mut task: Task) -> rusqlite::Result<Task> {
        let tx = db.unchecked_transaction()?;
        let n: i64 = tx
            .prepare_cached("INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES (?, ?, ?, ?, '') RETURNING n")?
            .query_row(
                params![task.project_ref.machine_id.as_str(), task.project_ref.project_id.as_str(), task.workstream_id.as_str(), state_str(task.state)],
                |r| r.get(0),
            )?;
        task.task_id = TaskId::unchecked(format!("T{n}"));
        Self::write(&tx, &StoredTask { task: task.clone(), pending_message: None })?;
        tx.commit()?;
        Ok(task)
    }

    pub fn get(db: &Connection, task_id: &TaskId) -> rusqlite::Result<Option<StoredTask>> {
        db.prepare_cached("SELECT data, pending_message FROM tasks WHERE n = ?")?.query_row([number_of(task_id)], stored_of).optional()
    }

    pub fn put(db: &Connection, stored: &StoredTask) -> rusqlite::Result<()> {
        Self::write(db, stored)
    }

    pub fn by_thread(db: &Connection, r: &ThreadRef) -> rusqlite::Result<Option<StoredTask>> {
        db.prepare_cached("SELECT data, pending_message FROM tasks WHERE machine_id = ? AND thread_id = ? ORDER BY n DESC LIMIT 1")?
            .query_row(params![r.machine_id.as_str(), r.thread_id.as_str()], stored_of)
            .optional()
    }

    /// Oldest first, every project.
    pub fn queued(db: &Connection) -> rusqlite::Result<Vec<StoredTask>> {
        db.prepare_cached("SELECT data, pending_message FROM tasks WHERE state = 'queued' ORDER BY n")?.query_map([], stored_of)?.collect()
    }

    /// Newest first.
    pub fn list(db: &Connection, filter: &TaskFilter) -> rusqlite::Result<Vec<Task>> {
        db.prepare_cached(
            "SELECT data FROM tasks
             WHERE (?1 IS NULL OR machine_id = ?1) AND (?2 IS NULL OR project_id = ?2)
               AND (?3 IS NULL OR state = ?3) AND (?4 IS NULL OR workstream_id = ?4)
             ORDER BY n DESC LIMIT ?5",
        )?
        .query_map(
            params![
                filter.project_ref.as_ref().map(|r| r.machine_id.as_str().to_owned()),
                filter.project_ref.as_ref().map(|r| r.project_id.as_str().to_owned()),
                filter.state.map(state_str),
                filter.workstream_id.as_ref().map(|w| w.as_str().to_owned()),
                filter.limit as i64,
            ],
            |row| decode(&row.get::<_, String>(0)?),
        )?
        .collect()
    }

    /// The digest's tasks: every queued, running or idle one, and those that ended after `since`. Newest first.
    pub fn for_digest(db: &Connection, r: &ProjectRef, since: Option<&str>, limit: usize) -> rusqlite::Result<Vec<Task>> {
        db.prepare_cached(
            "SELECT data FROM tasks
             WHERE machine_id = ?1 AND project_id = ?2
               AND (state IN ('queued', 'running', 'idle') OR (?3 IS NULL OR ended_at > ?3))
             ORDER BY n DESC LIMIT ?4",
        )?
        .query_map(params![r.machine_id.as_str(), r.project_id.as_str(), since, limit as i64], |row| decode(&row.get::<_, String>(0)?))?
        .collect()
    }

    /// The project's tasks by state.
    pub fn counts(db: &Connection, r: &ProjectRef) -> rusqlite::Result<TaskCounts> {
        let mut counts = serde_json::Map::new();
        for s in ["queued", "running", "idle", "done", "failed", "cancelled"] {
            counts.insert(s.to_owned(), 0.into());
        }
        let mut stmt = db.prepare_cached("SELECT state, COUNT(*) FROM tasks WHERE machine_id = ? AND project_id = ? GROUP BY state")?;
        let rows = stmt.query_map(params![r.machine_id.as_str(), r.project_id.as_str()], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
        for row in rows {
            let (state, n) = row?;
            counts.insert(state, n.into());
        }
        Ok(serde_json::from_value(serde_json::Value::Object(counts)).expect("TaskCounts decodes"))
    }

    /// Every thread a task of the project ran in, so thread lists can leave them out.
    pub fn thread_ids(db: &Connection, r: &ProjectRef) -> rusqlite::Result<HashSet<String>> {
        db.prepare_cached("SELECT thread_id FROM tasks WHERE machine_id = ? AND project_id = ? AND thread_id IS NOT NULL")?
            .query_map(params![r.machine_id.as_str(), r.project_id.as_str()], |row| row.get(0))?
            .collect()
    }
}
