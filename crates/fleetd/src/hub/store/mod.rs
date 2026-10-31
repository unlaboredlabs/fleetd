//! SQLite (same migrations as older hubs), hub store and event log.
//!
//! One `HubDb` per hub, shared by `Arc`: `HubStore`, `EventLog`, `Auth` and every area that owns tables (their
//! queries live in their own modules, against `HubDb::with` / `HubDb::transaction`).
mod db;
mod event_log;
mod hub_store;
pub(crate) mod migrations;

#[cfg(test)]
mod migrations_tests;
#[cfg(test)]
#[cfg(test)]
pub(crate) mod test_clock;
#[cfg(test)]
mod tests;

pub use db::{HubDb, StoreError, expand_home, resolve_hub_home};
pub use event_log::{EventLog, NewEvent, WaitInput};
pub use hub_store::{HubStore, StoredThread};

use crate::clock::Clock;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms(clock: &dyn Clock) -> i64 {
    system_ms(clock.now())
}

/// `2026-10-17T10:00:00.000Z`: UTC with milliseconds, the form of every timestamp the hub stores.
pub fn iso_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Milliseconds of an RFC 3339 timestamp (finer digits dropped); None for anything else.
pub fn parse_ms(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// Milliseconds since the Unix epoch, negative before it.
pub fn system_ms(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}
