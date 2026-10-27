//! Agents' browser sessions (table `browser_sessions`, one row per session with it as JSON) and their recordings,
//! under `<home>/browser/<sessionId>/` as the node uploaded them, already scrubbed. The node reports each session
//! with `browser_session` and uploads its files with `browser_recording_part` (calls.rs); the app lists them with
//! `browser_sessions` and reads a file with `browser_recording_get` (tools.rs). An hourly prune expires recordings past
//! the retention (`browser_settings`): each one after its days, and a project's oldest while its recordings together
//! are over its size.
pub mod calls;
pub mod live;
pub mod tools;

#[cfg(test)]
mod tests;

use std::path::PathBuf;
use std::sync::Arc;

use fleetd_contracts::browser::{
    BrowserRetention, BrowserSession, BrowserSessionEventData, BrowserSessionId,
    BrowserSessionState, DEFAULT_MAX_GB_PER_PROJECT, DEFAULT_RETENTION_DAYS, RecordingFile,
};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::node_link::{CAP_SESSION_END, HubToNode, SessionEndFrame};
use fleetd_contracts::prim::{Count, Int, List, Text};
use rusqlite::{Connection, OptionalExtension, params};

use crate::hub::api::Hub;
use crate::hub::store::{HubDb, NewEvent, StoreError, iso_ms, now_ms};

const DAY_MS: i64 = 86_400_000;
const GB: i64 = 1 << 30;
const RETENTION_DAYS_KEY: &str = "retention_days";
const MAX_GB_KEY: &str = "max_gb_per_project";

/// Where a session's recording lives on the hub.
pub fn dir(hub: &Hub, session_id: &BrowserSessionId) -> PathBuf {
    hub.config.home.join("browser").join(session_id.as_str())
}

pub fn file_path(hub: &Hub, session_id: &BrowserSessionId, file: RecordingFile) -> PathBuf {
    dir(hub, session_id).join(file.file_name())
}

fn setting(c: &Connection, key: &str, default: i64) -> Result<i64, StoreError> {
    let v: Option<i64> = c
        .query_row(
            "SELECT value FROM browser_settings WHERE key = ?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v.unwrap_or(default))
}

pub fn retention_on(c: &Connection) -> Result<BrowserRetention, StoreError> {
    Ok(BrowserRetention {
        retention_days: Int::unchecked(setting(c, RETENTION_DAYS_KEY, DEFAULT_RETENTION_DAYS)?),
        max_gb_per_project: Int::unchecked(setting(c, MAX_GB_KEY, DEFAULT_MAX_GB_PER_PROJECT)?),
    })
}

pub fn set_retention(c: &Connection, retention: &BrowserRetention) -> Result<(), StoreError> {
    for (key, value) in [
        (RETENTION_DAYS_KEY, retention.retention_days.get()),
        (MAX_GB_KEY, retention.max_gb_per_project.get()),
    ] {
        c.execute(
            "INSERT INTO browser_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
    }
    Ok(())
}

pub fn get_on(c: &Connection, id: &BrowserSessionId) -> Result<Option<BrowserSession>, StoreError> {
    let data: Option<String> = c
        .query_row(
            "SELECT data FROM browser_sessions WHERE session_id = ?1",
            [id.as_str()],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match data {
        Some(data) => Some(serde_json::from_str(&data)?),
        None => None,
    })
}

pub fn get(db: &HubDb, id: &BrowserSessionId) -> Result<Option<BrowserSession>, StoreError> {
    db.with(|c| get_on(c, id))
}

pub fn put_on(c: &Connection, s: &BrowserSession, started_ms: i64) -> Result<(), StoreError> {
    let bytes: i64 = s.files.iter().map(|f| f.bytes.get()).sum();
    c.execute(
        "INSERT INTO browser_sessions (session_id, machine_id, project_id, started_ms, state, bytes, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (session_id) DO UPDATE SET state = excluded.state, bytes = excluded.bytes, data = excluded.data",
        params![
            s.session_id.as_str(),
            s.project_ref.machine_id.as_str(),
            s.project_ref.project_id.as_str(),
            started_ms,
            s.state.as_str(),
            bytes,
            serde_json::to_string(s)?
        ],
    )?;
    Ok(())
}

/// Writes a stored session back after a change, and tells the app.
pub fn save(hub: &Hub, s: &BrowserSession) -> Result<(), StoreError> {
    let started_ms = crate::hub::store::parse_ms(s.started_at.as_str()).unwrap_or_default();
    hub.db.transaction(|c| put_on(c, s, started_ms))?;
    announce(hub, s, now_ms(hub.clock.as_ref()))
}

/// A project's live sessions whose agent asked for a person (`request_takeover`) and has no one yet.
pub fn waiting(db: &HubDb, r: &ProjectRef) -> Result<Vec<BrowserSession>, StoreError> {
    db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT data FROM browser_sessions WHERE machine_id = ?1 AND project_id = ?2 AND state = 'live'",
        )?;
        let rows = stmt.query_map(params![r.machine_id.as_str(), r.project_id.as_str()], |row| {
            row.get::<_, String>(0)
        })?;
        let mut out = Vec::new();
        for data in rows {
            let s: BrowserSession = serde_json::from_str(&data?)?;
            if s.takeover_reason.is_some() {
                out.push(s);
            }
        }
        Ok(out)
    })
}

/// Live sessions whose task ended: their agent never called `session_end`, or their node's word of the end never came.
fn outlived(c: &Connection) -> Result<Vec<BrowserSession>, StoreError> {
    let mut stmt = c.prepare(&format!(
        "SELECT data FROM browser_sessions b WHERE b.state = 'live' AND {}",
        crate::hub::machine_roles::task_ended("json_extract(b.data, '$.taskId')")
    ))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for data in rows {
        out.push(serde_json::from_str(&data?)?);
    }
    Ok(out)
}

/// What a session the hub ended with its task says.
pub const OUTLIVED_NOTE: &str = "its task ended with it still open, so the hub ended it";

/// Ends every live session whose task ended (done, failed or cancelled; never one between turns): lost on the hub, and
/// its agent's node told to close it and kill its processes ([`CAP_SESSION_END`]), here or on the machine hosting it.
/// A recording its node still uploads records it after all. Returns how many it ended.
pub fn end_outlived(hub: &Hub) -> Result<usize, StoreError> {
    let sessions = hub.db.with(outlived)?;
    let now = now_ms(hub.clock.as_ref());
    for mut s in sessions.iter().cloned() {
        s.state = BrowserSessionState::Lost;
        s.ended_at = Some(fleetd_contracts::ids::Timestamp(iso_ms(now)));
        s.takeover_reason = None;
        s.note = Some(Text::unchecked(OUTLIVED_NOTE));
        save(hub, &s)?;
        let machine = &s.project_ref.machine_id;
        if hub.link.node_can(machine, CAP_SESSION_END) {
            hub.link.send_to(
                machine,
                HubToNode::SessionEnd(SessionEndFrame {
                    thread_id: s.thread_id.clone(),
                    session_id: s.session_id.clone(),
                }),
            );
        }
        tracing::info!(session = %s.session_id, task = ?s.task_id, "screen outlived its task; ended");
    }
    Ok(sessions.len())
}

/// [`end_outlived`] as the hub starts and after each event (a task's end is one), until the hub stops.
pub async fn run_end_outlived(hub: Arc<Hub>) {
    let mut head = hub.events.subscribe();
    loop {
        head.borrow_and_update();
        if let Err(e) = end_outlived(&hub) {
            tracing::warn!(error = %e, "screens of ended tasks not ended");
        }
        tokio::select! {
            () = hub.shutdown.wait() => return,
            changed = head.changed() => if changed.is_err() { return },
        }
    }
}

/// A project's sessions, newest first.
pub fn list(db: &HubDb, r: &ProjectRef, limit: usize) -> Result<Vec<BrowserSession>, StoreError> {
    db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT data FROM browser_sessions WHERE machine_id = ?1 AND project_id = ?2
             ORDER BY started_ms DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![r.machine_id.as_str(), r.project_id.as_str(), limit as i64],
            |row| row.get::<_, String>(0),
        )?;
        let mut out = Vec::new();
        for data in rows {
            out.push(serde_json::from_str(&data?)?);
        }
        Ok(out)
    })
}

/// `browser.session`, which tells the app to read the session again.
pub fn announce(hub: &Hub, s: &BrowserSession, now: i64) -> Result<(), StoreError> {
    let data = BrowserSessionEventData {
        project_ref: s.project_ref.clone(),
        session_id: s.session_id.clone(),
        state: s.state,
        control: s.control,
        task_id: s.task_id.clone(),
    };
    let who = s.task_id.as_ref().map_or("the lead", |t| t.as_str());
    hub.events.append(NewEvent {
        at: iso_ms(now).into(),
        r#type: HubEventType::BrowserSession,
        machine_id: Some(s.project_ref.machine_id.clone()),
        project_id: Some(s.project_ref.project_id.clone()),
        thread_id: Some(s.thread_id.clone()),
        summary: format!("screen of {who}: {}", s.state.as_str()),
        data: Some(serde_json::to_value(data)?),
        attention: None,
    })?;
    Ok(())
}

/// Deletes a session's recording and marks it expired; its row stays, so the app can say it was there.
fn expire(hub: &Hub, mut s: BrowserSession, started_ms: i64, now: i64) -> Result<(), StoreError> {
    if let Err(e) = std::fs::remove_dir_all(dir(hub, &s.session_id))
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!(session = %s.session_id, error = %e, "browser recording not deleted");
        return Ok(());
    }
    s.state = BrowserSessionState::Expired;
    s.files = List::unchecked(Vec::new());
    s.note = None;
    hub.db.transaction(|c| put_on(c, &s, started_ms))?;
    announce(hub, &s, now)
}

/// A session still live or uploading this long after it started is a partial upload its node never finished (it
/// went, or lost the files): retention treats it as a recording.
pub const STALE_MS: i64 = DAY_MS;

/// The bytes a session holds on the hub's disk now, whatever its row says.
fn on_disk(hub: &Hub, id: &BrowserSessionId) -> i64 {
    RecordingFile::ALL
        .iter()
        .map(|f| stored_bytes(hub, id, *f) as i64)
        .sum()
}

/// The recordings past the retention, oldest first: those older than its days, then each project's oldest while its
/// recordings together are over its size. A partial upload counts toward the size by what it holds on disk. Once it
/// is stale ([`STALE_MS`]) it goes as a recording does, past the retention's days or while its project is over the
/// size; before that, never. Returns how many it expired.
pub fn prune(hub: &Hub) -> Result<usize, StoreError> {
    let now = now_ms(hub.clock.as_ref());
    let (retention, rows) = hub.db.with(|c| {
        let retention = retention_on(c)?;
        let mut stmt = c.prepare(
            "SELECT machine_id, project_id, started_ms, bytes, data FROM browser_sessions
             WHERE state IN ('recorded', 'uploading', 'live') ORDER BY started_ms ASC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok((retention, rows))
    })?;
    let cutoff = now - retention.retention_days.get() * DAY_MS;
    let max_bytes = retention.max_gb_per_project.get() * GB;
    let mut sessions = Vec::new();
    let mut totals: std::collections::HashMap<(String, String), i64> = Default::default();
    for (machine, project, started_ms, bytes, data) in rows {
        let session: BrowserSession = serde_json::from_str(&data)?;
        let partial = session.state != BrowserSessionState::Recorded;
        let bytes = if partial {
            on_disk(hub, &session.session_id)
        } else {
            bytes
        };
        *totals
            .entry((machine.clone(), project.clone()))
            .or_default() += bytes;
        sessions.push((machine, project, started_ms, bytes, partial, session));
    }
    let mut expired = 0;
    for (machine, project, started_ms, bytes, partial, session) in sessions {
        // An upload still going is never cut short.
        if partial && started_ms >= now - STALE_MS {
            continue;
        }
        let total = totals.entry((machine, project)).or_default();
        if started_ms >= cutoff && *total <= max_bytes {
            continue;
        }
        *total -= bytes;
        expire(hub, session, started_ms, now)?;
        expired += 1;
    }
    Ok(expired)
}

/// The hourly prune, until the hub stops.
pub async fn run_prune(hub: Arc<Hub>) {
    loop {
        match prune(&hub) {
            Ok(0) => {}
            Ok(n) => tracing::info!(n, "browser recordings expired"),
            Err(e) => tracing::warn!(error = %e, "browser recordings not pruned"),
        }
        hub.clock.sleep(std::time::Duration::from_secs(3600)).await;
    }
}

/// The bytes a stored file holds now.
pub fn stored_bytes(hub: &Hub, id: &BrowserSessionId, file: RecordingFile) -> u64 {
    std::fs::metadata(file_path(hub, id, file)).map_or(0, |m| m.len())
}

pub fn count(n: u64) -> Count {
    Count::unchecked(n as i64)
}
