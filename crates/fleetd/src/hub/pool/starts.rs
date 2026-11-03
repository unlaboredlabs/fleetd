//! Starts: every create and resume is a boat start, which boat limits per rolling minute, hour and day. fleetd allows
//! itself half of each included window (read from `GET /limits`), counts a start before its call, pre-flights
//! `/limits` before each one and never buys an extra start (`nextStartDollars` must be 0). What boat refuses sets a
//! backoff, by its code, with one plain line that says why.
use chrono_tz::Tz;

use super::boat::{BoatError, Limits, StartLimits};
use super::ledger::{Settings, Window};

/// boat's $20 plan, until /limits was read.
pub const INCLUDED_UNKNOWN: StartLimits = StartLimits {
    per_minute: 12,
    per_hour: 60,
    per_day: 200,
};

/// What fleetd allows itself in a window: half of what the plan includes there, at least one.
pub fn allowed(included: StartLimits, window: Window) -> u32 {
    let n = match window {
        Window::Minute => included.per_minute,
        Window::Hour => included.per_hour,
        Window::Day => included.per_day,
    };
    (n / 2).max(1)
}

/// Why the start budget holds a start back, given each window's count and oldest start: the first full window's
/// line, with when its oldest start leaves it.
pub fn budget_line(
    included: StartLimits,
    counts: &[(Window, u32, Option<i64>)],
    zone: Tz,
) -> Option<String> {
    counts.iter().find_map(|(window, used, oldest)| {
        let allowed = allowed(included, *window);
        (*used >= allowed).then(|| {
            let next = oldest.map(|at| clock(at + window.ms(), zone));
            match next {
                Some(next) => format!(
                    "fleetd's boat.dev start budget is used ({used} of {allowed} this {}): next start at {next}",
                    window.name()
                ),
                None => format!(
                    "fleetd's boat.dev start budget is used ({used} of {allowed} this {})",
                    window.name()
                ),
            }
        })
    })
}

/// Why the pre-flight refuses a start, or None to go ahead: boat must say it can start, and at no cost.
pub fn preflight(limits: &Limits) -> Option<String> {
    if !limits.can_start {
        let why = limits
            .start_blocked_reason
            .as_deref()
            .unwrap_or("it can't start machines now");
        return Some(format!("boat.dev: {why}"));
    }
    match limits.next_start_dollars {
        Some(0.0) => None,
        Some(_) => {
            Some("boat.dev's included starts are used: fleetd never buys an extra start".into())
        }
        None => Some("boat.dev would refuse the next start".into()),
    }
}

/// `HH:MM` in the hub's zone.
pub fn clock(ms: i64, zone: Tz) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .with_timezone(&zone)
        .format("%H:%M")
        .to_string()
}

/// What a refusal does to starts.
#[derive(Clone, Debug, PartialEq)]
pub enum Backoff {
    /// No start before `until` (ms), at retry `step`, with the line that says why.
    Hold {
        until: i64,
        step: u32,
        reason: String,
    },
    /// boat's machines-at-once limit: no start until one of ours stops.
    Full,
    /// Bursting pauses until a sweep's /limits says boat can start, or the admin resumes: `kind` is `billing` or `key`.
    Pause { kind: &'static str, reason: String },
}

/// The 5 s retries after `no_ready_machine` (3 of them), then 1, 2 and 4 minutes.
const NO_READY_S: [i64; 6] = [5, 5, 5, 60, 120, 240];

/// The backoff for `error`, at the hold's current retry `step` (0 after a success); `jitter` in 0..1 spreads an
/// unreachable boat's retries ±20%.
pub fn backoff(error: &BoatError, step: u32, now: i64, jitter: f64, zone: Tz) -> Backoff {
    let next = step.saturating_add(1);
    let hold = |secs: i64, reason: String| Backoff::Hold {
        until: now + secs.max(1) * 1000,
        step: next,
        reason,
    };
    match error {
        BoatError::RateLimited {
            next_start_at,
            retry_after_s,
        } => {
            let until = next_start_at
                .or(retry_after_s.map(|s| now + s as i64 * 1000))
                .unwrap_or(now + 60_000)
                .max(now + 1000);
            Backoff::Hold {
                until,
                step: next,
                reason: format!("boat.dev start limit: next start at {}", clock(until, zone)),
            }
        }
        BoatError::LimitReached | BoatError::MemberLimitReached => Backoff::Full,
        BoatError::Billing { url, .. } => Backoff::Pause {
            kind: "billing",
            reason: match url {
                Some(url) => format!("boat.dev needs billing attention: Settings › Cloud ({url})"),
                None => "boat.dev needs billing attention: Settings › Cloud".into(),
            },
        },
        BoatError::KeyRefused { .. } | BoatError::NoKey(_) => Backoff::Pause {
            kind: "key",
            reason: "boat.dev key refused: Settings › Cloud".into(),
        },
        BoatError::NoReadyMachine => {
            let i = (step as usize).min(NO_READY_S.len() - 1);
            hold(
                NO_READY_S[i],
                "boat.dev is short of machines, retrying".into(),
            )
        }
        BoatError::OutOfCapacity { retry_after_s } => hold(
            retry_after_s.map_or(120, |s| s as i64),
            "boat.dev is short of machines, retrying".into(),
        ),
        BoatError::IpRateLimited { retry_after_s } => hold(
            retry_after_s.map_or(60, |s| s as i64),
            "boat.dev rate limit, retrying".into(),
        ),
        BoatError::Server { .. } | BoatError::Network(_) | BoatError::IdempotencyInProgress => {
            let base = (5_i64 << step.min(6)).min(300) as f64;
            let secs = (base * (0.8 + 0.4 * jitter.clamp(0.0, 1.0))).round() as i64;
            hold(secs, "boat.dev unreachable, retrying".into())
        }
        // A refusal boat won't change its mind on soon (a size the plan lacks, a gone or expired machine): hold 5
        // minutes with its own words, so a bug can't spin on it.
        other => hold(300, other.line()),
    }
}

/// Why no start may go now, before the start budget and the money budget: the first that holds.
pub fn held(s: &Settings, now: i64) -> Option<String> {
    if !s.enabled {
        return Some("cloud machines are off".into());
    }
    if !s.has_key {
        return Some("no boat.dev key: Settings › Cloud".into());
    }
    if let Some((_, reason)) = &s.paused {
        return Some(reason.clone());
    }
    if s.hold_until.is_some_and(|until| until > now) {
        return Some(
            s.hold_reason
                .clone()
                .unwrap_or_else(|| "boat.dev backoff".into()),
        );
    }
    if s.full {
        return Some("boat.dev: machines-at-once limit reached".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const UTC: Tz = chrono_tz::UTC;
    const T: i64 = 1_793_786_400_000; // 2026-11-04T10:00:00Z

    #[test]
    fn fleetd_allows_itself_half_of_each_included_window() {
        assert_eq!(allowed(INCLUDED_UNKNOWN, Window::Minute), 6);
        assert_eq!(allowed(INCLUDED_UNKNOWN, Window::Hour), 30);
        assert_eq!(allowed(INCLUDED_UNKNOWN, Window::Day), 100);
        let trial = StartLimits {
            per_minute: 5,
            per_hour: 25,
            per_day: 75,
        };
        assert_eq!(allowed(trial, Window::Minute), 2);
        let tiny = StartLimits {
            per_minute: 1,
            per_hour: 1,
            per_day: 1,
        };
        assert_eq!(allowed(tiny, Window::Day), 1);
    }

    #[test]
    fn a_full_window_says_when_its_next_start_is() {
        let counts = [
            (Window::Minute, 2, Some(T)),
            (Window::Hour, 30, Some(T - 1_800_000)),
            (Window::Day, 40, Some(T - 3_600_000)),
        ];
        assert_eq!(
            budget_line(INCLUDED_UNKNOWN, &counts, UTC).as_deref(),
            Some(
                "fleetd's boat.dev start budget is used (30 of 30 this hour): next start at 10:30"
            )
        );
        let room = [
            (Window::Minute, 5, Some(T)),
            (Window::Hour, 29, Some(T)),
            (Window::Day, 99, Some(T)),
        ];
        assert_eq!(budget_line(INCLUDED_UNKNOWN, &room, UTC), None);
    }

    #[test]
    fn the_preflight_never_buys_an_extra_start() {
        let mut l = Limits {
            can_start: true,
            next_start_dollars: Some(0.0),
            ..Default::default()
        };
        assert_eq!(preflight(&l), None);
        l.next_start_dollars = Some(0.03);
        assert!(preflight(&l).unwrap().contains("never buys"));
        l.next_start_dollars = None;
        assert!(preflight(&l).is_some());
        l = Limits {
            can_start: false,
            start_blocked_reason: Some("billing_required".into()),
            next_start_dollars: Some(0.0),
            ..Default::default()
        };
        assert_eq!(preflight(&l).as_deref(), Some("boat.dev: billing_required"));
    }

    fn until(b: Backoff) -> i64 {
        match b {
            Backoff::Hold { until, .. } => until,
            other => panic!("not a hold: {other:?}"),
        }
    }

    #[test]
    fn each_boat_code_backs_off_its_own_way() {
        // rate_limited: not before boat's nextStartAt, said in the hub's time.
        let b = backoff(
            &BoatError::RateLimited {
                next_start_at: Some(T + 32 * 60_000),
                retry_after_s: Some(9),
            },
            0,
            T,
            0.5,
            UTC,
        );
        assert_eq!(
            b,
            Backoff::Hold {
                until: T + 32 * 60_000,
                step: 1,
                reason: "boat.dev start limit: next start at 10:32".into()
            }
        );
        // Without nextStartAt, Retry-After.
        assert_eq!(
            until(backoff(
                &BoatError::RateLimited {
                    next_start_at: None,
                    retry_after_s: Some(42)
                },
                0,
                T,
                0.5,
                UTC
            )),
            T + 42_000
        );
        assert_eq!(
            backoff(&BoatError::LimitReached, 0, T, 0.5, UTC),
            Backoff::Full
        );
        assert_eq!(
            backoff(&BoatError::MemberLimitReached, 0, T, 0.5, UTC),
            Backoff::Full
        );
        assert!(matches!(
            backoff(&BoatError::Billing { code: "billing_required".into(), url: Some("https://boat.dev/billing".into()) }, 0, T, 0.5, UTC),
            Backoff::Pause { kind: "billing", reason } if reason.contains("https://boat.dev/billing")
        ));
        assert!(matches!(
            backoff(
                &BoatError::KeyRefused {
                    code: "api_key_expired".into()
                },
                0,
                T,
                0.5,
                UTC
            ),
            Backoff::Pause { kind: "key", .. }
        ));
        // no_ready_machine: 5 s three times, then 1, 2, 4 minutes, and 4 from then on.
        let waits: Vec<i64> = (0..8)
            .map(|step| (until(backoff(&BoatError::NoReadyMachine, step, T, 0.5, UTC)) - T) / 1000)
            .collect();
        assert_eq!(waits, [5, 5, 5, 60, 120, 240, 240, 240]);
        assert_eq!(
            until(backoff(
                &BoatError::OutOfCapacity {
                    retry_after_s: None
                },
                0,
                T,
                0.5,
                UTC
            )),
            T + 120_000
        );
        assert_eq!(
            until(backoff(
                &BoatError::IpRateLimited {
                    retry_after_s: Some(7)
                },
                0,
                T,
                0.5,
                UTC
            )),
            T + 7000
        );
        // Unreachable: 5 s doubling to 5 minutes, ±20%.
        let mid: Vec<i64> = (0..8)
            .map(|step| {
                (until(backoff(
                    &BoatError::Network("reset".into()),
                    step,
                    T,
                    0.5,
                    UTC,
                )) - T)
                    / 1000
            })
            .collect();
        assert_eq!(mid, [5, 10, 20, 40, 80, 160, 300, 300]);
        assert_eq!(
            until(backoff(&BoatError::Server { status: 502 }, 6, T, 0.0, UTC)) - T,
            240_000
        );
        assert_eq!(
            until(backoff(&BoatError::Server { status: 502 }, 6, T, 1.0, UTC)) - T,
            360_000
        );
        // Anything else holds 5 minutes, in boat's words.
        assert!(matches!(
            backoff(&BoatError::Refused { status: 403, code: "machine_class_plan_required".into() }, 0, T, 0.5, UTC),
            Backoff::Hold { until, reason, .. } if until == T + 300_000 && reason.contains("machine_class_plan_required")
        ));
    }
}
