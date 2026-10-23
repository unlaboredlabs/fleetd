//! SQLite (same migrations as older hubs), hub store and event log.
//!
//! One `HubDb` per hub, shared by `Arc`: `HubStore`, `EventLog`, `Auth` and every area that owns tables (their
//! queries live in their own modules, against `HubDb::with` / `HubDb::transaction`).
mod db;
mod event_log;
mod hub_store;
pub(crate) mod migrations;

#[cfg(test)]
pub(crate) use migrations::MIGRATIONS;
#[cfg(test)]
pub(crate) mod test_clock;
#[cfg(test)]
mod tests;

pub use db::{HubDb, StoreError, expand_home, resolve_hub_home};
pub use event_log::{EventLog, NewEvent, WaitInput};
pub use hub_store::{HubStore, StoredThread};

use crate::clock::Clock;
use std::time::UNIX_EPOCH;

/// Milliseconds since the Unix epoch on `clock`, like Effect's `Clock.currentTimeMillis`.
pub fn now_ms(clock: &dyn Clock) -> i64 {
    clock
        .now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// `new Date(ms).toISOString()`: `YYYY-MM-DDTHH:MM:SS.mmmZ`, UTC.
pub fn iso_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}
