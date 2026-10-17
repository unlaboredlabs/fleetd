//! ISO timestamps as the TS hub writes them (`Date#toISOString`: millisecond precision, `Z`).
use chrono::{DateTime, SecondsFormat, Utc};
use std::time::{SystemTime, UNIX_EPOCH};

/// `2026-10-17T10:00:00.000Z`.
pub fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `Date.parse` for the RFC 3339 timestamps fleetd stores; `None` where JS would give NaN.
pub fn parse_ms(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text).ok().map(|d| d.timestamp_millis())
}

pub fn system_ms(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// Text cut to `max` characters with an ellipsis, as the TS `clip` helpers do (UTF-16 lengths there; chars here).
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
        out.push('…');
        out
    } else {
        text.to_string()
    }
}

pub fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}
