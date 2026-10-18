use super::{HubDb, StoreError, now_ms};
use crate::clock::Clock;
use fleetd_contracts::events::{Attention, HubEvent, HubEventType};
use fleetd_contracts::ids::{EventSeq, MachineId, ProjectId, ThreadId, Timestamp};
use fleetd_contracts::prim::{Count, Text};
use rusqlite::{OptionalExtension, named_params, params};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

const PAGE: usize = 100;
const MAX_DATA_BYTES: usize = 2048;
const MAX_SUMMARY: usize = 200;
const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS: i64 = 60 * 60 * 1000;

/// A `HubEvent` before the log numbers it; also exactly what a row's `data` column holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    pub at: Timestamp,
    #[serde(rename = "type")]
    pub r#type: HubEventType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_id: Option<MachineId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<ThreadId>,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    /// Set by the emitter (see the attention area); stored and returned as given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<Attention>,
}

impl NewEvent {
    fn with_seq(self, seq: i64) -> HubEvent {
        HubEvent {
            seq: EventSeq(Count::unchecked(seq)),
            at: self.at,
            r#type: self.r#type,
            machine_id: self.machine_id,
            project_id: self.project_id,
            thread_id: self.thread_id,
            summary: Text::unchecked(self.summary),
            data: self.data,
            attention: self.attention,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct WaitInput {
    /// Absent means start at the current end.
    pub cursor: Option<i64>,
    pub types: Option<Vec<HubEventType>>,
    pub machine_id: Option<MachineId>,
    pub timeout_sec: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WaitResult {
    pub events: Vec<HubEvent>,
    /// Pass back as the next `cursor`; it moves past events the filters skipped.
    pub cursor: i64,
    /// More matching events are already waiting.
    pub more: bool,
}

/// Trims `summary` to 200 UTF-16 units (199 plus "…", as older hubs cut it) and replaces a `data` over 2 KB of
/// JSON with `{"truncated": true}`.
fn trim(mut event: NewEvent) -> NewEvent {
    if event.summary.encode_utf16().count() > MAX_SUMMARY {
        let mut units = 0;
        let cut: String = event
            .summary
            .chars()
            .take_while(|c| {
                units += c.len_utf16();
                units < MAX_SUMMARY
            })
            .collect();
        event.summary = cut + "…";
    }
    if let Some(data) = &event.data
        && serde_json::to_string(data).map_or(0, |s| s.len()) > MAX_DATA_BYTES
    {
        event.data = Some(serde_json::json!({ "truncated": true }));
    }
    event
}

struct State {
    last_prune_ms: i64,
}

/// The hub-global, append-only event log behind `events_wait` and the app stream.
pub struct EventLog {
    db: Arc<HubDb>,
    clock: Arc<dyn Clock>,
    state: Mutex<State>,
    /// The head seq, updated under the db lock on every append; waiters subscribe before reading.
    head: watch::Sender<i64>,
}

impl EventLog {
    /// Prunes events past retention, then picks the head up where the database left it.
    pub fn new(db: Arc<HubDb>, clock: Arc<dyn Clock>) -> Result<Self, StoreError> {
        let now = now_ms(clock.as_ref());
        let head = db.with(|conn| {
            conn.prepare_cached("DELETE FROM events WHERE created_ms < ?")?
                .execute([now - RETENTION_MS])?;
            // AUTOINCREMENT keeps this past retention deletes, so seq never goes backwards.
            let seq: Option<i64> = conn
                .prepare_cached("SELECT seq FROM sqlite_sequence WHERE name = 'events'")?
                .query_row([], |row| row.get(0))
                .optional()?;
            Ok(seq.unwrap_or(0))
        })?;
        Ok(Self {
            db,
            clock,
            state: Mutex::new(State { last_prune_ms: now }),
            head: watch::Sender::new(head),
        })
    }

    /// Seq of the newest event ever appended; 0 for none.
    pub fn head(&self) -> i64 {
        *self.head.borrow()
    }

    /// Changes to the head seq: `changed()` resolves after each append. Mark the current value seen before reading a
    /// page so no append is missed.
    pub fn subscribe(&self) -> watch::Receiver<i64> {
        self.head.subscribe()
    }

    pub fn append(&self, event: NewEvent) -> Result<HubEvent, StoreError> {
        let now = now_ms(self.clock.as_ref());
        let trimmed = trim(event);
        let stored = serde_json::to_string(&trimmed)?;
        let prune = {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            let due = now - state.last_prune_ms >= PRUNE_EVERY_MS;
            if due {
                state.last_prune_ms = now;
            }
            due
        };
        let seq = self.db.with(|conn| {
            if prune {
                conn.prepare_cached("DELETE FROM events WHERE created_ms < ?")?.execute([now - RETENTION_MS])?;
            }
            let seq: i64 = conn
                .prepare_cached("INSERT INTO events (created_ms, type, machine_id, data) VALUES (?, ?, ?, ?) RETURNING seq")?
                .query_row(
                    params![now, type_name(trimmed.r#type)?, trimmed.machine_id.as_ref().map(MachineId::as_str), stored],
                    |row| row.get(0),
                )?;
            // Still under the db lock, so a reader never sees a head behind the rows it read.
            self.head.send_replace(seq);
            Ok(seq)
        })?;
        Ok(trimmed.with_seq(seq))
    }

    /// One page after `after`, with the cursor to resume from. Reads rows and head under one lock.
    pub fn page(
        &self,
        after: i64,
        types: Option<&[HubEventType]>,
        machine_id: Option<&MachineId>,
    ) -> Result<WaitResult, StoreError> {
        let types = types.map(serde_json::to_string).transpose()?;
        self.db.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT seq, data FROM events
       WHERE seq > $after
         AND ($types IS NULL OR type IN (SELECT value FROM json_each($types)))
         AND ($machine IS NULL OR machine_id = $machine)
       ORDER BY seq LIMIT $limit",
            )?;
            let rows = stmt.query_map(
                named_params! {
                    "$after": after,
                    "$types": types,
                    "$machine": machine_id.map(MachineId::as_str),
                    "$limit": (PAGE + 1) as i64,
                },
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )?;
            let mut events = Vec::with_capacity(PAGE);
            let mut more = false;
            for row in rows {
                let (seq, data) = row?;
                if events.len() == PAGE {
                    more = true;
                    break;
                }
                events.push(serde_json::from_str::<NewEvent>(&data)?.with_seq(seq));
            }
            let head = *self.head.borrow();
            // Without more, every event up to head was looked at, matching or not.
            let cursor = if more {
                events[PAGE - 1].seq.get()
            } else {
                after.max(head)
            };
            Ok(WaitResult {
                events,
                cursor,
                more,
            })
        })
    }

    /// Returns at once if matching events exist after `cursor`, otherwise waits up to `timeout_sec` for one.
    pub async fn wait(&self, input: WaitInput) -> Result<WaitResult, StoreError> {
        let deadline = now_ms(self.clock.as_ref()) + input.timeout_sec as i64 * 1000;
        let mut appended = self.head.subscribe();
        // A cursor past head (say, from before a hub reset) waits for new events instead of forever.
        let head = *appended.borrow_and_update();
        let mut after = input.cursor.unwrap_or(head).min(head);
        loop {
            appended.borrow_and_update();
            let page = self.page(after, input.types.as_deref(), input.machine_id.as_ref())?;
            let remaining = deadline - now_ms(self.clock.as_ref());
            if !page.events.is_empty() || remaining <= 0 {
                return Ok(page);
            }
            after = page.cursor;
            tokio::select! {
                _ = appended.changed() => {}
                () = self.clock.sleep(Duration::from_millis(remaining as u64)) => {}
            }
        }
    }
}

/// The `type` column: the event type's wire name.
fn type_name(t: HubEventType) -> Result<String, StoreError> {
    match serde_json::to_value(t)? {
        serde_json::Value::String(s) => Ok(s),
        other => Ok(other.to_string()),
    }
}
