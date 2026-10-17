//! ISO 8601 UTC timestamps the way JS prints and parses them (`toISOString`, `Date.parse`).
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn millis(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `2026-10-17T12:00:00.000Z`.
pub fn iso(t: SystemTime) -> String {
    let ms = millis(t);
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

/// Milliseconds of `YYYY-MM-DDTHH:MM:SS[.fff]Z` (GitHub's and our own form); None for anything else.
pub fn parse_iso(s: &str) -> Option<i64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;
    let num = |p: &str| p.parse::<i64>().ok();
    let mut dp = date.split('-');
    let (y, mo, d) = (num(dp.next()?)?, num(dp.next()?)?, num(dp.next()?)?);
    let (hms, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut tp = hms.split(':');
    let (h, mi, sec) = (num(tp.next()?)?, num(tp.next()?)?, num(tp.next()?)?);
    let ms = if frac.is_empty() {
        0
    } else {
        num(&format!("{frac:0<3}")[..3])?
    };
    Some(days_from_civil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + ms)
}

pub fn from_millis(ms: i64) -> SystemTime {
    if ms >= 0 {
        UNIX_EPOCH + Duration::from_millis(ms as u64)
    } else {
        UNIX_EPOCH - Duration::from_millis(ms.unsigned_abs())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_js_iso_timestamps() {
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let ms = parse_iso("2026-10-17T12:30:00Z").unwrap();
        assert_eq!(iso(from_millis(ms)), "2026-10-17T12:30:00.000Z");
        assert_eq!(
            parse_iso("2024-02-29T23:59:59.5Z"),
            Some(parse_iso("2024-03-01T00:00:00Z").unwrap() - 500)
        );
    }
}
