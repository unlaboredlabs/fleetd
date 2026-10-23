//! What needs the human now, and when a client may interrupt them. The hub stamps `attention` on the events it emits;
//! clients (the desktop app's notifications) follow the field and `fleetd_status.notify` rather than repeating
//! these rules. Pure, apart from reading the hub's time zone.
use chrono::{TimeZone, Timelike};
use chrono_tz::Tz;
use fleetd_contracts::events::Attention;
use fleetd_contracts::ledger::{GatedClass, HumanRequest, RequestState};
use regex::Regex;
use std::sync::LazyLock;

/// At most one notification per this window; what arrives meanwhile is folded into the next one as "+N more".
pub const COALESCE_MS: i64 = 20 * 60_000;
pub const QUIET_HOURS_KEY: &str = "policy.quiet_hours";
/// The global decision naming the zone that quiet hours and digests run in.
pub const POLICY_TZ_KEY: &str = "policy.tz";
/// DESIGN §4: the hours that apply while no `policy.quiet_hours` decision exists.
pub const DEFAULT_QUIET_HOURS: &str = "23:00-08:00";

/// An open request always needs the person: the lead waits on it. A money or irreversible command is urgent and
/// breaks through quiet hours; a secret, a credential command and a session's tool prompt are loud.
pub fn request_attention(r: &HumanRequest) -> Option<Attention> {
    if r.state != RequestState::Open {
        return None;
    }
    Some(match &r.gated {
        Some(g) if matches!(g.class, GatedClass::Money | GatedClass::Irreversible) => {
            Attention::Urgent
        }
        _ => Attention::Loud,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuietHours {
    /// Minutes after local midnight.
    pub start: i64,
    pub end: i64,
}

static QUIET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)\s*$").unwrap()
});

/// `"23:00-08:00"`; `None` for anything else (such as "off"), which means no quiet hours.
pub fn parse_quiet_hours(value: &str) -> Option<QuietHours> {
    let c = QUIET.captures(value)?;
    let n = |i: usize| c[i].parse::<i64>().unwrap_or(0);
    let quiet = QuietHours {
        start: n(1) * 60 + n(2),
        end: n(3) * 60 + n(4),
    };
    (quiet.start != quiet.end).then_some(quiet)
}

/// The quiet hours a `policy.quiet_hours` decision sets, or the default when there is none.
pub fn quiet_hours(decided: Option<&str>) -> Option<QuietHours> {
    parse_quiet_hours(decided.unwrap_or(DEFAULT_QUIET_HOURS))
}

fn local_minutes(now_ms: i64, tz: Tz) -> i64 {
    let t = tz
        .timestamp_millis_opt(now_ms)
        .single()
        .unwrap_or_else(|| tz.timestamp_millis_opt(0).unwrap());
    i64::from(t.hour()) * 60 + i64::from(t.minute())
}

fn inside(minutes: i64, q: QuietHours) -> bool {
    if q.start < q.end {
        minutes >= q.start && minutes < q.end
    } else {
        minutes >= q.start || minutes < q.end
    }
}

fn minute_floor(ms: i64) -> i64 {
    ms - ms.rem_euclid(60_000)
}

/// When the quiet hours around `now_ms` end, or `None` when it is not quiet now.
pub fn quiet_until(now_ms: i64, tz: Tz, quiet: Option<QuietHours>) -> Option<i64> {
    let q = quiet?;
    let now = local_minutes(now_ms, tz);
    inside(now, q).then(|| minute_floor(now_ms) + (q.end - now + 1440).rem_euclid(1440) * 60_000)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuietWindow {
    pub from_ms: i64,
    pub to_ms: i64,
}

/// The quiet window under way at `now_ms` (if any) and the next one, as absolute times, so a client needs no time
/// zone rules. Like `quiet_until`, a window that spans a DST change can be an hour off at its far end.
pub fn quiet_windows(now_ms: i64, tz: Tz, quiet: Option<QuietHours>) -> Vec<QuietWindow> {
    let Some(q) = quiet else { return Vec::new() };
    let mut windows = Vec::new();
    let now = local_minutes(now_ms, tz);
    let current_end = quiet_until(now_ms, tz, quiet);
    if let Some(to_ms) = current_end {
        windows.push(QuietWindow {
            from_ms: minute_floor(now_ms) - (now - q.start + 1440).rem_euclid(1440) * 60_000,
            to_ms,
        });
    }
    let after = current_end.unwrap_or(now_ms);
    let from_ms =
        minute_floor(after) + (q.start - local_minutes(after, tz) + 1440).rem_euclid(1440) * 60_000;
    if let Some(to_ms) = quiet_until(from_ms, tz, quiet) {
        windows.push(QuietWindow { from_ms, to_ms });
    }
    windows
}

/// `fleetd_status.notify`: the coalesce window and the quiet windows from now, as absolute times.
pub fn notify_policy(hub: &crate::hub::api::Hub) -> serde_json::Value {
    let (tz, quiet) = quiet_policy(|k| hub.decisions.global_value(k).ok().flatten());
    let windows = quiet_windows(crate::hub::store::now_ms(hub.clock.as_ref()), tz, quiet);
    serde_json::json!({
        "coalesceSec": COALESCE_MS / 1000,
        "quiet": windows
            .iter()
            .map(|w| serde_json::json!({
                "from": crate::hub::store::iso_ms(w.from_ms),
                "to": crate::hub::store::iso_ms(w.to_ms),
            }))
            .collect::<Vec<_>>(),
    })
}

/// An IANA zone name fleetd can use.
pub fn zone(name: &str) -> Option<Tz> {
    name.parse().ok()
}

/// The hub machine's zone: `TZ`, else `/etc/localtime`'s target, else UTC.
pub fn hub_zone() -> Tz {
    if let Some(tz) = std::env::var("TZ")
        .ok()
        .and_then(|t| zone(t.trim_start_matches(':')))
    {
        return tz;
    }
    std::fs::read_link("/etc/localtime")
        .ok()
        .and_then(|p| {
            p.to_str()
                .and_then(|s| s.split_once("zoneinfo/").and_then(|(_, name)| zone(name)))
        })
        .unwrap_or(Tz::UTC)
}

/// The quiet hours the global `policy.quiet_hours` decision sets, in `policy.tz` (else the hub's zone).
/// `global_value` reads a global decision's trimmed value.
pub fn quiet_policy(global_value: impl Fn(&str) -> Option<String>) -> (Tz, Option<QuietHours>) {
    let tz = global_value(POLICY_TZ_KEY)
        .and_then(|t| zone(&t))
        .unwrap_or_else(hub_zone);
    (tz, quiet_hours(global_value(QUIET_HOURS_KEY).as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(iso: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn quiet_hours_end_at_the_next_local_end_across_midnight_and_in_policy_tz() {
        let quiet = parse_quiet_hours("23:00-08:00");
        assert_eq!(
            quiet,
            Some(QuietHours {
                start: 1380,
                end: 480
            })
        );
        assert_eq!(
            parse_quiet_hours(" 01:30 - 02:00 "),
            Some(QuietHours {
                start: 90,
                end: 120
            })
        );
        assert_eq!(parse_quiet_hours("11pm-8am"), None);
        assert_eq!(parse_quiet_hours("08:00-08:00"), None);
        assert_eq!(quiet_hours(None), quiet);
        assert_eq!(quiet_hours(Some("off")), None);
        assert_eq!(
            quiet_until(ms("2026-10-17T23:30:00Z"), Tz::UTC, quiet),
            Some(ms("2026-10-18T08:00:00Z"))
        );
        assert_eq!(
            quiet_until(ms("2026-10-18T07:59:30Z"), Tz::UTC, quiet),
            Some(ms("2026-10-18T08:00:00Z"))
        );
        assert_eq!(
            quiet_until(ms("2026-10-18T08:00:00Z"), Tz::UTC, quiet),
            None
        );
        // 21:30 UTC is 23:30 in Berlin (CEST, +2).
        assert_eq!(
            quiet_until(ms("2026-10-17T21:30:00Z"), Tz::Europe__Berlin, quiet),
            Some(ms("2026-10-18T06:00:00Z"))
        );
        assert_eq!(
            quiet_until(ms("2026-10-17T21:30:00Z"), Tz::UTC, quiet),
            None
        );
    }

    #[test]
    fn quiet_windows_are_the_one_under_way_then_the_next() {
        let quiet = parse_quiet_hours("23:00-08:00");
        let w = |a: &str, b: &str| QuietWindow {
            from_ms: ms(a),
            to_ms: ms(b),
        };
        let t0 = ms("2026-10-17T12:00:00Z");
        assert_eq!(
            quiet_windows(t0, Tz::UTC, quiet),
            [w("2026-10-17T23:00:00Z", "2026-10-18T08:00:00Z")]
        );
        assert_eq!(
            quiet_windows(ms("2026-10-18T01:15:30Z"), Tz::UTC, quiet),
            [
                w("2026-10-17T23:00:00Z", "2026-10-18T08:00:00Z"),
                w("2026-10-18T23:00:00Z", "2026-10-19T08:00:00Z")
            ]
        );
        // 12:00 UTC is 14:00 in Berlin: quiet from 21:00 UTC.
        assert_eq!(
            quiet_windows(t0, Tz::Europe__Berlin, quiet),
            [w("2026-10-17T21:00:00Z", "2026-10-18T06:00:00Z")]
        );
        assert_eq!(quiet_windows(t0, Tz::UTC, None), []);
    }
}
