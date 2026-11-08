//! Warnings the train can hit on every pass (GitHub unreachable, a machine offline): each one logs the first time,
//! then at most once an hour while the same error repeats, with how many it held back, so a long outage stays a few
//! lines instead of burying the hub log.
use std::collections::HashMap;
use std::sync::Mutex;

use super::service::lock;

pub const REPEAT_EVERY_MS: i64 = 60 * 60 * 1000;

/// Past this many warnings tracked, the ones not logged in the last hour are forgotten.
const KEPT: usize = 4096;

#[derive(Default)]
pub struct Repeats(Mutex<HashMap<String, Repeat>>);

struct Repeat {
    what: String,
    logged_ms: i64,
    held: u64,
}

impl Repeats {
    /// The warning at `key` (its line and what it is about) happened with `what` (its error): `Some(held)` to log it
    /// now, with how many were held back since its last line; `None` to hold it back. Another `what` than the last
    /// logs at once.
    pub fn due(&self, key: String, what: &str, now_ms: i64) -> Option<u64> {
        let mut seen = lock(&self.0);
        if let Some(r) = seen.get_mut(&key)
            && r.what == what
        {
            if now_ms - r.logged_ms < REPEAT_EVERY_MS {
                r.held += 1;
                return None;
            }
            let held = r.held;
            (r.logged_ms, r.held) = (now_ms, 0);
            return Some(held);
        }
        if seen.len() >= KEPT {
            seen.retain(|_, r| now_ms - r.logged_ms < REPEAT_EVERY_MS);
        }
        let what = what.to_string();
        seen.insert(
            key,
            Repeat {
                what,
                logged_ms: now_ms,
                held: 0,
            },
        );
        Some(0)
    }

    /// The trouble at `key` is over: whether it was there.
    pub fn clear(&self, key: &str) -> bool {
        lock(&self.0).remove(key).is_some()
    }
}

/// `tracing::warn!` through the train's `Repeats`: `warn_hourly!(train, [about..], error; fields.., "message")` logs
/// once, then at most hourly while `error` stays the same for this line and `about`, with `repeats` = how many were
/// held back.
macro_rules! warn_hourly {
    ($train:expr, [$($about:expr),* $(,)?], $what:expr; $($warn:tt)+) => {{
        let key = [concat!(file!(), ":", line!()).to_string() $(, $about.to_string())*].join(" ");
        if let Some(repeats) = $train.repeats.due(key, &$what.to_string(), $train.now_ms()) {
            if repeats == 0 {
                tracing::warn!($($warn)+);
            } else {
                tracing::warn!(repeats, $($warn)+);
            }
        }
    }};
}
pub(crate) use warn_hourly;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_once_then_hourly_with_the_count_held_back() {
        let r = Repeats::default();
        assert_eq!(r.due("a".into(), "down", 0), Some(0));
        assert_eq!(r.due("a".into(), "down", 1_000), None);
        assert_eq!(r.due("a".into(), "down", REPEAT_EVERY_MS - 1), None);
        assert_eq!(r.due("a".into(), "down", REPEAT_EVERY_MS), Some(2));
        assert_eq!(r.due("a".into(), "down", REPEAT_EVERY_MS + 1), None);
        // Another error, or another key, is news.
        assert_eq!(r.due("a".into(), "refused", REPEAT_EVERY_MS + 2), Some(0));
        assert_eq!(r.due("b".into(), "refused", REPEAT_EVERY_MS + 2), Some(0));
        assert!(r.clear("a"));
        assert!(!r.clear("a"));
        assert_eq!(r.due("a".into(), "refused", REPEAT_EVERY_MS + 3), Some(0));
    }
}
