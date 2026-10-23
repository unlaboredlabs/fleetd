//! The `steers` table: one row per steer, `n` its S<n>, `data` the Steer with its receipt.
use fleetd_contracts::steer::{Steer, SteerId};
use rusqlite::{Connection, OptionalExtension, params};

use crate::hub::store::{HubDb, StoreError};

/// A new steer's row; `id` is filled from the row's number.
pub struct NewSteer<'a> {
    pub steer: Steer,
    pub task_id: Option<&'a str>,
    /// `key:<id>` for a person, `lead` for a lead.
    pub by: String,
    /// `steer:<by>:<clientRequestId>`: a resent request returns this steer, whatever its stage.
    pub request: String,
    pub queued_ms: i64,
}

fn decode(data: String) -> Result<Steer, StoreError> {
    Ok(serde_json::from_str(&data)?)
}

fn mode_name(steer: &Steer) -> &'static str {
    match steer.mode {
        fleetd_contracts::steer::SteerMode::Queue => "queue",
        fleetd_contracts::steer::SteerMode::Now => "now",
    }
}

/// Stores a new steer, or returns the one already stored for its request (a retried request, at any stage):
/// `(steer, created)`.
pub fn insert(db: &HubDb, new: NewSteer) -> Result<(Steer, bool), StoreError> {
    db.with(|conn| {
        let existing: Option<String> = conn
            .query_row(
                "SELECT data FROM steers WHERE request = ?",
                [&new.request],
                |r| r.get(0),
            )
            .optional()?;
        // Rows stored before requests were: their run id is still the one the request derives.
        let existing = match existing {
            Some(data) => Some(decode(data)?),
            None => by_run(conn, &new.steer.run_id)?,
        };
        if let Some(existing) = existing {
            return Ok((existing, false));
        }
        let s = &new.steer;
        conn.execute(
            "INSERT INTO steers (workstream_id, task_id, machine_id, thread_id, run_id, by, mode, stage, queued_ms,
             request, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')",
            params![
                s.workstream_id.as_str(),
                new.task_id,
                s.thread.machine_id.as_str(),
                s.thread.thread_id.as_str(),
                s.run_id.as_str(),
                new.by,
                mode_name(s),
                s.stage.as_str(),
                new.queued_ms,
                new.request,
            ],
        )?;
        let n = conn.last_insert_rowid();
        let steer = Steer {
            id: SteerId::from_n(n),
            ..new.steer
        };
        conn.execute(
            "UPDATE steers SET data = ? WHERE n = ?",
            params![serde_json::to_string(&steer)?, n],
        )?;
        Ok((steer, true))
    })
}

fn by_run(conn: &Connection, run_id: &str) -> Result<Option<Steer>, StoreError> {
    let data: Option<String> = conn
        .query_row("SELECT data FROM steers WHERE run_id = ?", [run_id], |r| {
            r.get(0)
        })
        .optional()?;
    data.map(decode).transpose()
}

pub fn get(db: &HubDb, id: &SteerId) -> Result<Option<(Steer, String)>, StoreError> {
    let Some(n) = id.n() else {
        return Ok(None);
    };
    db.with(|conn| {
        let row: Option<(String, String)> = conn
            .query_row("SELECT data, by FROM steers WHERE n = ?", [n], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        row.map(|(data, by)| Ok((decode(data)?, by))).transpose()
    })
}

pub fn put(
    db: &HubDb,
    steer: &Steer,
    delivered_ms: Option<i64>,
    acked_ms: Option<i64>,
) -> Result<(), StoreError> {
    let Some(n) = steer.id.n() else {
        return Ok(());
    };
    db.with(|conn| {
        conn.execute(
            "UPDATE steers SET stage = ?, delivered_ms = COALESCE(?, delivered_ms), acked_ms = COALESCE(?, acked_ms),
             data = ? WHERE n = ?",
            params![
                steer.stage.as_str(),
                delivered_ms,
                acked_ms,
                serde_json::to_string(steer)?,
                n
            ],
        )?;
        Ok(())
    })
}

/// Newest first.
pub fn list(
    db: &HubDb,
    workstream_id: Option<&str>,
    task_id: Option<&str>,
    after_n: i64,
    limit: usize,
) -> Result<Vec<Steer>, StoreError> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT data FROM steers WHERE (?1 IS NULL OR workstream_id = ?1) AND (?2 IS NULL OR task_id = ?2)
             AND n > ?3 ORDER BY n DESC LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            params![workstream_id, task_id, after_n, limit as i64],
            |r| r.get::<_, String>(0),
        )?;
        rows.map(|r| decode(r?)).collect()
    })
}

/// Steers without a final receipt, with the time of their last stage.
pub fn open(db: &HubDb) -> Result<Vec<(Steer, i64)>, StoreError> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT data, COALESCE(delivered_ms, queued_ms) FROM steers
             WHERE stage IN ('queued', 'delivered') AND held = 0",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.map(|r| {
            let (data, at) = r?;
            Ok((decode(data)?, at))
        })
        .collect()
    })
}

/// Holds a steer for its task's next run; `message` is the text it added to the task's pending message.
pub fn hold(db: &HubDb, id: &SteerId, message: Option<&str>) -> Result<(), StoreError> {
    db.with(|conn| {
        conn.execute(
            "UPDATE steers SET held = 1, rides_with = NULL, message = COALESCE(?, message) WHERE n = ?",
            params![message, id.n()],
        )?;
        Ok(())
    })
}

/// A held steer's pending text, while it is still held.
pub fn held_message(db: &HubDb, id: &SteerId) -> Result<Option<String>, StoreError> {
    db.with(|conn| {
        Ok(conn
            .query_row(
                "SELECT message FROM steers WHERE n = ? AND held = 1",
                [id.n()],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    })
}

pub fn unhold(db: &HubDb, id: &SteerId) -> Result<(), StoreError> {
    db.with(|conn| {
        conn.execute("UPDATE steers SET held = 0 WHERE n = ?", [id.n()])?;
        Ok(())
    })
}

/// The steers that went out in `leader`'s run.
pub fn riders(db: &HubDb, leader: &SteerId) -> Result<Vec<Steer>, StoreError> {
    db.with(|conn| {
        let mut stmt = conn.prepare("SELECT data FROM steers WHERE rides_with = ? ORDER BY n")?;
        let rows = stmt.query_map([leader.n()], |r| r.get::<_, String>(0))?;
        rows.map(|r| decode(r?)).collect()
    })
}

pub fn ride(db: &HubDb, rider: &Steer, leader: &SteerId) -> Result<(), StoreError> {
    db.with(|conn| {
        conn.execute(
            "UPDATE steers SET held = 0, rides_with = ?, run_id = ?, data = ? WHERE n = ?",
            params![
                leader.n(),
                rider.run_id.as_str(),
                serde_json::to_string(rider)?,
                rider.id.n()
            ],
        )?;
        Ok(())
    })
}

/// The held steers of a task, oldest first: the order they were added to its pending message.
pub fn held_for_task(db: &HubDb, task_id: &str) -> Result<Vec<Steer>, StoreError> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT data FROM steers WHERE task_id = ? AND held = 1 AND stage = 'queued' ORDER BY n",
        )?;
        let rows = stmt.query_map([task_id], |r| r.get::<_, String>(0))?;
        rows.map(|r| decode(r?)).collect()
    })
}

/// A held steer went out with its task's next run: it is that run's now, and no longer held.
pub fn bind(db: &HubDb, steer: &Steer) -> Result<(), StoreError> {
    db.with(|conn| {
        conn.execute(
            "UPDATE steers SET run_id = ?, held = 0, data = ? WHERE n = ?",
            params![
                steer.run_id.as_str(),
                serde_json::to_string(steer)?,
                steer.id.n()
            ],
        )?;
        Ok(())
    })
}
