//! Pure wake-schedule math: IANA time-zone conversion, a 5-field cron parser, and "next run after".
//! Local times that don't exist (the hour skipped when DST starts) move forward by the gap; local times that
//! happen twice (the hour repeated when DST ends) take the first occurrence. This is Temporal's "compatible".
use std::collections::BTreeSet;
use std::sync::LazyLock;

use chrono::{DateTime, Datelike, NaiveDate, Offset, TimeZone, Timelike};
use chrono_tz::Tz;
use regex::Regex;

use fleetd_contracts::wakes::{WakeAt, WakeCron, WakeEvery, WakeSchedule};

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalTime {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

fn zone(tz: &str) -> Result<Tz, ScheduleError> {
    Tz::from_str_insensitive(tz)
        .map_err(|_| ScheduleError(format!("'{tz}' is not an IANA time zone")))
}

fn utc(ms: i64) -> DateTime<chrono::Utc> {
    DateTime::from_timestamp_millis(ms).unwrap_or_default()
}

/// Wall-clock fields of the instant `ms` in `tz`.
pub fn zoned_parts(ms: i64, tz: Tz) -> LocalTime {
    let t = utc(ms).with_timezone(&tz);
    LocalTime {
        year: t.year(),
        month: t.month(),
        day: t.day(),
        hour: t.hour(),
        minute: t.minute(),
        second: t.second(),
    }
}

fn as_utc(t: LocalTime) -> i64 {
    NaiveDate::from_ymd_opt(t.year, t.month, t.day)
        .and_then(|d| d.and_hms_opt(t.hour, t.minute, t.second))
        .map(|n| n.and_utc().timestamp_millis())
        .unwrap_or(0)
}

/// `tz`'s offset from UTC at the instant `ms`, in ms (New York in winter: -5 h).
pub fn offset_ms(ms: i64, tz: Tz) -> i64 {
    let whole = ms.div_euclid(1000) * 1000;
    i64::from(
        tz.offset_from_utc_datetime(&utc(whole).naive_utc())
            .fix()
            .local_minus_utc(),
    ) * 1000
}

/// The instant a wall-clock time in `tz` names.
pub fn zoned_to_utc(t: LocalTime, tz: Tz) -> i64 {
    let local = as_utc(t);
    // Offsets range over [-12 h, +14 h], so these sample the zone before and after any transition near `local`.
    let before = offset_ms(local - 15 * HOUR, tz);
    let after = offset_ms(local + 15 * HOUR, tz);
    [before, after]
        .into_iter()
        .filter(|&o| offset_ms(local - o, tz) == o)
        .map(|o| local - o)
        .min()
        .unwrap_or(local - before)
}

// ---- cron ----------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cron {
    pub minutes: Vec<u32>,
    pub hours: Vec<u32>,
    pub days: BTreeSet<u32>,
    pub months: BTreeSet<u32>,
    pub weekdays: BTreeSet<u32>,
    /// Vixie cron: when both day fields are restricted, a day matching either one runs.
    pub any_day: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct CronError(pub String);

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct ScheduleError(pub String);

fn macro_for(text: &str) -> Option<&'static str> {
    Some(match text {
        "@yearly" | "@annually" => "0 0 1 1 *",
        "@monthly" => "0 0 1 * *",
        "@weekly" => "0 0 * * 0",
        "@daily" | "@midnight" => "0 0 * * *",
        "@hourly" => "0 * * * *",
        _ => return None,
    })
}

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

struct FieldSpec {
    name: &'static str,
    min: u32,
    max: u32,
    names: &'static [&'static str],
    /// First value the names map to.
    name_base: u32,
}

const FIELDS: [FieldSpec; 5] = [
    FieldSpec {
        name: "minute",
        min: 0,
        max: 59,
        names: &[],
        name_base: 0,
    },
    FieldSpec {
        name: "hour",
        min: 0,
        max: 23,
        names: &[],
        name_base: 0,
    },
    FieldSpec {
        name: "day of month",
        min: 1,
        max: 31,
        names: &[],
        name_base: 0,
    },
    FieldSpec {
        name: "month",
        min: 1,
        max: 12,
        names: &MONTHS,
        name_base: 1,
    },
    FieldSpec {
        name: "day of week",
        min: 0,
        max: 7,
        names: &WEEKDAYS,
        name_base: 0,
    },
];

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn parse_value(raw: &str, spec: &FieldSpec) -> Result<u32, CronError> {
    let lower = raw.to_lowercase();
    if let Some(i) = spec.names.iter().position(|n| *n == lower) {
        return Ok(i as u32 + spec.name_base);
    }
    if !all_digits(raw) {
        return Err(CronError(format!("'{raw}' is not a valid {}", spec.name)));
    }
    let n: u64 = raw.parse().unwrap_or(u64::MAX);
    if n < u64::from(spec.min) || n > u64::from(spec.max) {
        return Err(CronError(format!(
            "{} {n} is outside {}-{}",
            spec.name, spec.min, spec.max
        )));
    }
    Ok(n as u32)
}

fn parse_field(text: &str, spec: &FieldSpec) -> Result<BTreeSet<u32>, CronError> {
    let mut out = BTreeSet::new();
    for item in text.split(',') {
        let mut parts = item.split('/');
        let range = parts.next().unwrap_or("");
        let step_text = parts.next();
        if range.is_empty() || parts.next().is_some() {
            return Err(CronError(format!("'{item}' is not a valid {}", spec.name)));
        }
        let step = match step_text {
            None => 1,
            Some(s) if all_digits(s) && s.parse::<u64>().is_ok_and(|n| n >= 1) => {
                s.parse::<u64>().unwrap_or(1)
            }
            Some(s) => {
                return Err(CronError(format!(
                    "step '{s}' in {} must be a positive integer",
                    spec.name
                )));
            }
        };
        let (lo, hi) = if range == "*" {
            (spec.min, spec.max)
        } else if range.contains('-') {
            let mut ends = range.split('-');
            let (a, b) = (ends.next(), ends.next());
            let (Some(a), Some(b), None) = (a, b, ends.next()) else {
                return Err(CronError(format!(
                    "'{range}' is not a valid {} range",
                    spec.name
                )));
            };
            let (lo, hi) = (parse_value(a, spec)?, parse_value(b, spec)?);
            if lo > hi {
                return Err(CronError(format!(
                    "{} range {range} runs backwards",
                    spec.name
                )));
            }
            (lo, hi)
        } else {
            let lo = parse_value(range, spec)?;
            (lo, if step_text.is_none() { lo } else { spec.max })
        };
        let mut v = u64::from(lo);
        while v <= u64::from(hi) {
            out.insert(v as u32);
            v += step;
        }
    }
    Ok(out)
}

/// Standard 5-field cron (minute hour day-of-month month day-of-week) plus the @daily-style macros.
pub fn parse_cron(text: &str) -> Result<Cron, CronError> {
    let trimmed = text.trim();
    let expanded = macro_for(&trimmed.to_lowercase()).unwrap_or(trimmed);
    let fields: Vec<&str> = expanded.split_whitespace().collect();
    // JS's "".split(/\s+/) is one empty field.
    let count = if fields.is_empty() { 1 } else { fields.len() };
    if count != 5 {
        return Err(CronError(format!(
            "cron needs 5 fields (minute hour day month weekday), got {count}"
        )));
    }
    let mut sets = Vec::with_capacity(5);
    for (f, spec) in fields.iter().zip(FIELDS.iter()) {
        sets.push(parse_field(f, spec)?);
    }
    let mut weekdays = sets.pop().unwrap_or_default();
    let months = sets.pop().unwrap_or_default();
    let days = sets.pop().unwrap_or_default();
    let hours = sets.pop().unwrap_or_default();
    let minutes = sets.pop().unwrap_or_default();
    if weekdays.remove(&7) {
        weekdays.insert(0);
    }
    let days_restricted = !fields[2].starts_with('*');
    let weekdays_restricted = !fields[4].starts_with('*');
    Ok(Cron {
        minutes: minutes.into_iter().collect(),
        hours: hours.into_iter().collect(),
        days,
        months,
        weekdays,
        any_day: days_restricted && weekdays_restricted,
    })
}

fn day_matches(cron: &Cron, date: NaiveDate) -> bool {
    if !cron.months.contains(&date.month()) {
        return false;
    }
    let by_day = cron.days.contains(&date.day());
    let by_weekday = cron
        .weekdays
        .contains(&date.weekday().num_days_from_sunday());
    if cron.any_day {
        by_day || by_weekday
    } else {
        by_day && by_weekday
    }
}

/// Earliest firing on the local calendar day `date` that is after `after_ms`.
fn first_on_day(cron: &Cron, date: NaiveDate, after_ms: i64, tz: Tz) -> Option<i64> {
    if !day_matches(cron, date) {
        return None;
    }
    let mut best: Option<i64> = None;
    for &hour in &cron.hours {
        for &minute in &cron.minutes {
            let t = zoned_to_utc(
                LocalTime {
                    year: date.year(),
                    month: date.month(),
                    day: date.day(),
                    hour,
                    minute,
                    second: 0,
                },
                tz,
            );
            if t > after_ms && best.is_none_or(|b| t < b) {
                best = Some(t);
            }
        }
    }
    best
}

/// Covers every Feb 29 pattern; a cron with no match in this window never matches.
const SEARCH_DAYS: i64 = 366 * 8 + 1;

/// The first firing strictly after `after_ms`, or None when the cron can never match (say, Feb 30).
pub fn next_cron(cron: &Cron, after_ms: i64, tz: Tz) -> Option<i64> {
    let start = zoned_parts(after_ms, tz);
    let start_day = NaiveDate::from_ymd_opt(start.year, start.month, start.day)?;
    for i in 0..SEARCH_DAYS {
        let day = start_day + chrono::Days::new(i as u64);
        let Some(found) = first_on_day(cron, day, after_ms, tz) else {
            continue;
        };
        // A late-evening time pushed forward across midnight by a DST gap can land after the next day's first one.
        let next = first_on_day(cron, day + chrono::Days::new(1), after_ms, tz);
        return Some(next.map_or(found, |n| n.min(found)));
    }
    None
}

// ---- schedules -----------------------------------------------------------------------------------

static AT_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?$")
        .expect("valid regex")
});

/// An ISO time with `Z` or an offset is absolute; one without names a wall-clock time in `tz`.
pub fn parse_at(at: &str, tz: &str) -> Result<i64, ScheduleError> {
    let trimmed = at.trim();
    let Some(m) = AT_PATTERN.captures(trimmed) else {
        return Err(ScheduleError(format!(
            "'{at}' is not an ISO date-time such as 2026-10-18T09:00 or 2026-10-18T09:00:00Z"
        )));
    };
    let num = |i: usize| {
        m.get(i)
            .map_or(0, |g| g.as_str().parse::<u32>().unwrap_or(0))
    };
    let fields = LocalTime {
        year: num(1) as i32,
        month: num(2),
        day: num(3),
        hour: num(4),
        minute: num(5),
        second: num(6),
    };
    if NaiveDate::from_ymd_opt(fields.year, fields.month, fields.day).is_none()
        || fields.hour > 23
        || fields.minute > 59
        || fields.second > 59
    {
        return Err(ScheduleError(format!("'{at}' is not a real date and time")));
    }
    let frac: f64 = m.get(7).map_or(0.0, |g| g.as_str().parse().unwrap_or(0.0));
    match m.get(8).map(|g| g.as_str()) {
        Some(zone_text) => {
            // Date.parse keeps milliseconds and drops finer digits.
            let ms = (frac * 1000.0).trunc() as i64;
            let offset = if zone_text == "Z" {
                0
            } else {
                let sign = if zone_text.starts_with('-') { -1 } else { 1 };
                let digits: String = zone_text[1..]
                    .chars()
                    .filter(char::is_ascii_digit)
                    .collect();
                let h: i64 = digits[..2].parse().unwrap_or(0);
                let mi: i64 = digits[2..].parse().unwrap_or(0);
                sign * (h * HOUR + mi * MINUTE)
            };
            Ok(as_utc(fields) + ms - offset)
        }
        None => Ok(zoned_to_utc(fields, zone(tz)?) + (frac * 1000.0 + 0.5).floor() as i64),
    }
}

/// Fails with ScheduleError for a schedule that can never run.
pub fn validate(schedule: &WakeSchedule) -> Result<(), ScheduleError> {
    match schedule {
        WakeSchedule::At(WakeAt { at, tz }) => parse_at(at.as_str(), tz).map(|_| ()),
        WakeSchedule::Every(_) => Ok(()),
        WakeSchedule::Cron(WakeCron { cron, tz }) => {
            zone(tz)?;
            parse_cron(cron).map(|_| ()).map_err(|e| ScheduleError(e.0))
        }
    }
}

/// The first run strictly after `after_ms`, or None when there is none. `anchor_ms` is the previous scheduled
/// run of an "every" wake, so its runs stay on one grid however late each firing was.
pub fn next_run(
    schedule: &WakeSchedule,
    after_ms: i64,
    anchor_ms: Option<i64>,
) -> Result<Option<i64>, ScheduleError> {
    Ok(match schedule {
        WakeSchedule::At(WakeAt { at, tz }) => {
            Some(parse_at(at.as_str(), tz)?).filter(|&at| at > after_ms)
        }
        WakeSchedule::Every(WakeEvery { every_sec }) => {
            let every = every_sec.get() * 1000;
            Some(match anchor_ms {
                None => after_ms + every,
                Some(anchor) => anchor + ((after_ms - anchor).max(0) / every + 1) * every,
            })
        }
        WakeSchedule::Cron(WakeCron { cron, tz }) => next_cron(
            &parse_cron(cron).map_err(|e| ScheduleError(e.0))?,
            after_ms,
            zone(tz)?,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::store::{iso_ms, parse_ms};

    const NY: &str = "America/New_York";
    const LONDON: &str = "Europe/London";

    fn at(s: &str) -> i64 {
        parse_ms(s).unwrap()
    }
    fn tz(s: &str) -> Tz {
        s.parse().unwrap()
    }
    fn lt(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> LocalTime {
        LocalTime {
            year,
            month,
            day,
            hour,
            minute,
            second: 0,
        }
    }

    /// Successive firings after `from`.
    fn firings(cron: &str, zone: &str, from: &str, count: usize) -> Vec<Option<String>> {
        let parsed = parse_cron(cron).unwrap();
        let mut out = vec![];
        let mut t = at(from);
        for _ in 0..count {
            let next = next_cron(&parsed, t, tz(zone));
            out.push(next.map(iso_ms));
            match next {
                Some(n) => t = n,
                None => break,
            }
        }
        out
    }
    fn some(v: &[&str]) -> Vec<Option<String>> {
        v.iter().map(|s| Some((*s).to_string())).collect()
    }

    #[test]
    fn new_york_local_times_across_dst() {
        let hour = 3_600_000;
        assert_eq!(offset_ms(at("2026-01-15T12:00:00Z"), tz(NY)), -5 * hour);
        assert_eq!(offset_ms(at("2026-07-15T12:00:00Z"), tz(NY)), -4 * hour);
        // In the spring-forward gap: moved forward by the gap. Repeated in autumn: the first one.
        assert_eq!(
            iso_ms(zoned_to_utc(lt(2026, 3, 8, 2, 30), tz(NY))),
            "2026-03-08T07:30:00.000Z"
        );
        assert_eq!(
            iso_ms(zoned_to_utc(lt(2026, 11, 1, 1, 30), tz(NY))),
            "2026-11-01T05:30:00.000Z"
        );
    }

    #[test]
    fn parse_at_absolute_and_wall_clock() {
        assert_eq!(
            iso_ms(parse_at("2026-10-18T09:00:00Z", NY).unwrap()),
            "2026-10-18T09:00:00.000Z"
        );
        assert_eq!(
            iso_ms(parse_at("2026-10-18T09:00:00+02:00", NY).unwrap()),
            "2026-10-18T07:00:00.000Z"
        );
        assert_eq!(
            iso_ms(parse_at("2026-10-18T09:00", LONDON).unwrap()),
            "2026-10-18T08:00:00.000Z"
        );
        assert_eq!(
            iso_ms(parse_at("2026-12-18T09:00", LONDON).unwrap()),
            "2026-12-18T09:00:00.000Z"
        );
        assert!(parse_at("tomorrow 9am", NY).is_err());
        assert!(parse_at("2026-02-30T09:00", NY).is_err());
        assert!(parse_at("2026-02-10T24:00", NY).is_err());
    }

    #[test]
    fn parse_cron_expands_lists_ranges_steps_names_and_macros() {
        let c = parse_cron("0,30 9-17/4 * jan-mar MON-FRI").unwrap();
        assert_eq!(c.minutes, vec![0, 30]);
        assert_eq!(c.hours, vec![9, 13, 17]);
        assert_eq!(c.months.iter().copied().collect::<Vec<_>>(), vec![1, 2, 3]);
        assert_eq!(
            c.weekdays.iter().copied().collect::<Vec<_>>(),
            vec![1, 2, 3, 4, 5]
        );
        assert_eq!(parse_cron("@hourly").unwrap().minutes, vec![0]);
        assert_eq!(
            parse_cron("0 0 * * 7")
                .unwrap()
                .weekdays
                .into_iter()
                .collect::<Vec<_>>(),
            vec![0]
        );
        assert_eq!(parse_cron("5/20 * * * *").unwrap().minutes, vec![5, 25, 45]);
    }

    #[test]
    fn parse_cron_refuses_malformed_fields_with_a_reason() {
        assert!(parse_cron("* * * *").unwrap_err().0.contains("5 fields"));
        assert!(
            parse_cron("60 * * * *")
                .unwrap_err()
                .0
                .contains("minute 60")
        );
        assert!(parse_cron("* * * * 1-").is_err());
        assert!(parse_cron("*/0 * * * *").unwrap_err().0.contains("step"));
        assert!(
            parse_cron("5-1 * * * *")
                .unwrap_err()
                .0
                .contains("backwards")
        );
    }

    #[test]
    fn cron_jobs_keep_local_time_across_dst() {
        let cases = [
            // A weekday job keeps 09:00 local across the spring change.
            (
                "0 9 * * 1-5",
                NY,
                "2026-03-05T15:00:00Z",
                &[
                    "2026-03-06T14:00:00.000Z",
                    "2026-03-09T13:00:00.000Z",
                    "2026-03-10T13:00:00.000Z",
                ][..],
            ),
            // In the skipped hour: once, an hour later.
            (
                "30 2 * * *",
                NY,
                "2026-03-07T12:00:00Z",
                &[
                    "2026-03-08T07:30:00.000Z",
                    "2026-03-09T06:30:00.000Z",
                    "2026-03-10T06:30:00.000Z",
                ],
            ),
            // In the repeated hour: once.
            (
                "30 1 * * *",
                NY,
                "2026-10-31T12:00:00Z",
                &["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"],
            ),
            // Hourly stays on the hour through London's autumn change.
            (
                "0 * * * *",
                LONDON,
                "2026-10-24T23:30:00Z",
                &[
                    "2026-10-25T00:00:00.000Z",
                    "2026-10-25T02:00:00.000Z",
                    "2026-10-25T03:00:00.000Z",
                ],
            ),
        ];
        for (cron, zone, from, want) in cases {
            assert_eq!(
                firings(cron, zone, from, want.len()),
                some(want),
                "{cron} {zone}"
            );
        }
    }

    #[test]
    fn either_day_field_matches_when_both_are_restricted() {
        assert_eq!(
            firings("0 12 13 * 5", "UTC", "2026-11-01T00:00:00Z", 3),
            some(&[
                "2026-11-06T12:00:00.000Z",
                "2026-11-13T12:00:00.000Z",
                "2026-11-20T12:00:00.000Z"
            ])
        );
    }

    #[test]
    fn finds_feb_29_years_ahead_and_gives_up_on_feb_30() {
        assert_eq!(
            firings("0 0 29 2 *", "UTC", "2026-10-17T00:00:00Z", 1),
            some(&["2028-02-29T00:00:00.000Z"])
        );
        assert_eq!(
            next_cron(
                &parse_cron("0 0 30 2 *").unwrap(),
                at("2026-10-17T00:00:00Z"),
                tz("UTC")
            ),
            None
        );
    }

    #[test]
    fn next_cron_is_strictly_after() {
        assert_eq!(
            firings("0 9 * * *", "UTC", "2026-10-17T09:00:00Z", 1),
            some(&["2026-10-18T09:00:00.000Z"])
        );
    }

    #[test]
    fn next_run_at_only_while_in_the_future() {
        let s = WakeSchedule::At(WakeAt {
            at: "2026-10-17T10:01:00Z".into(),
            tz: fleetd_contracts::wakes::TimeZone::unchecked("UTC"),
        });
        assert_eq!(
            next_run(&s, at("2026-10-17T10:00:00Z"), None)
                .unwrap()
                .map(iso_ms)
                .as_deref(),
            Some("2026-10-17T10:01:00.000Z")
        );
        assert_eq!(
            next_run(&s, at("2026-10-17T10:01:00Z"), None).unwrap(),
            None
        );
    }

    #[test]
    fn every_runs_stay_on_the_first_grid() {
        let s = WakeSchedule::Every(WakeEvery {
            every_sec: fleetd_contracts::prim::Int::unchecked(3600),
        });
        assert_eq!(
            next_run(&s, at("2026-10-17T10:00:00Z"), None)
                .unwrap()
                .map(iso_ms)
                .as_deref(),
            Some("2026-10-17T11:00:00.000Z")
        );
        assert_eq!(
            next_run(
                &s,
                at("2026-10-17T13:20:00Z"),
                Some(at("2026-10-17T11:00:00Z"))
            )
            .unwrap()
            .map(iso_ms)
            .as_deref(),
            Some("2026-10-17T14:00:00.000Z")
        );
    }
}
