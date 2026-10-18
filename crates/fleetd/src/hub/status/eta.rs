//! ETA from measured throughput: points verified per busy hour over the last 7 days, never the lead's guess. Pure.
use std::collections::HashMap;

use fleetd_contracts::plan::Size;

pub const WINDOW_MS: i64 = 7 * 24 * 3_600_000;
pub const MIN_SAMPLES: i64 = fleetd_contracts::status::MIN_SAMPLES;
const HOUR_MS: f64 = 3_600_000.0;

/// The measure of the union of `[start, end ?? now]`, clipped to `[now − WINDOW_MS, now]`.
pub fn busy_ms(intervals: &[(i64, Option<i64>)], now: i64) -> i64 {
    let from = now - WINDOW_MS;
    let mut spans: Vec<(i64, i64)> = intervals
        .iter()
        .map(|(s, e)| ((*s).max(from), e.unwrap_or(now).min(now)))
        .filter(|(s, e)| e > s)
        .collect();
    spans.sort_unstable();
    let (mut total, mut cur): (i64, Option<(i64, i64)>) = (0, None);
    for (s, e) in spans {
        match cur {
            Some((cs, ce)) if s <= ce => cur = Some((cs, ce.max(e))),
            Some((cs, ce)) => {
                total += ce - cs;
                cur = Some((s, e));
            }
            None => cur = Some((s, e)),
        }
    }
    total + cur.map_or(0, |(s, e)| e - s)
}

/// Verified points over busy time in the window.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rate {
    pub points: i64,
    pub samples: i64,
    pub busy_ms: i64,
}

impl Rate {
    pub fn per_hour(&self) -> Option<f64> {
        (self.samples >= MIN_SAMPLES && self.busy_ms > 0 && self.points > 0)
            .then(|| self.points as f64 / (self.busy_ms as f64 / HOUR_MS))
    }
}

/// `now + remaining / rate`.
pub fn throughput_eta(now: i64, remaining_pts: i64, rate_per_hour: f64) -> i64 {
    if remaining_pts <= 0 {
        return now;
    }
    now + (remaining_pts as f64 / rate_per_hour * HOUR_MS).round() as i64
}

pub fn median(mut v: Vec<i64>) -> Option<i64> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable();
    let mid = v.len() / 2;
    Some(if v.len().is_multiple_of(2) {
        (v[mid - 1] + v[mid]) / 2
    } else {
        v[mid]
    })
}

/// An open must item for the serial-chain ETA.
#[derive(Clone, Debug)]
pub struct ChainItem {
    pub n: i64,
    pub size: Size,
    pub started_ms: Option<i64>,
    /// Open items it waits on.
    pub after: Vec<i64>,
}

/// The longest `after` chain of open items: Σ max(0, d(size) − elapsed). Returns its length and the chain, first
/// gate first. None when a size on it has no measured duration.
pub fn chain(items: &[ChainItem], d: &HashMap<Size, i64>, now: i64) -> Option<(i64, Vec<i64>)> {
    let by_n: HashMap<i64, &ChainItem> = items.iter().map(|i| (i.n, i)).collect();
    let mut memo: HashMap<i64, Option<(i64, Vec<i64>)>> = HashMap::new();
    fn walk(
        n: i64,
        by_n: &HashMap<i64, &ChainItem>,
        d: &HashMap<Size, i64>,
        now: i64,
        memo: &mut HashMap<i64, Option<(i64, Vec<i64>)>>,
        depth: usize,
    ) -> Option<(i64, Vec<i64>)> {
        if let Some(v) = memo.get(&n) {
            return v.clone();
        }
        let item = by_n.get(&n)?;
        let own = (d.get(&item.size)? - item.started_ms.map_or(0, |s| now - s)).max(0);
        let mut best: (i64, Vec<i64>) = (0, Vec::new());
        if depth < 64 {
            for a in &item.after {
                if !by_n.contains_key(a) {
                    continue;
                }
                let (len, path) = walk(*a, by_n, d, now, memo, depth + 1)?;
                if len > best.0 || best.1.is_empty() {
                    best = (len, path);
                }
            }
        }
        best.1.push(n);
        let out = Some((own + best.0, best.1));
        memo.insert(n, out.clone());
        out
    }
    let mut best: Option<(i64, Vec<i64>)> = None;
    for i in items {
        let found = walk(i.n, &by_n, d, now, &mut memo, 0)?;
        if best.as_ref().is_none_or(|b| found.0 > b.0) {
            best = Some(found);
        }
    }
    best
}

/// `current − original`, split into what scope added (points added since the original, at the current rate) and
/// what speed lost (the rest). Minutes.
pub fn slip(current: i64, original: i64, scope_pts: i64, rate_per_hour: Option<f64>) -> (i64, i64) {
    let total = (current - original) / 60_000;
    let scope = match rate_per_hour {
        Some(r) if r > 0.0 => (scope_pts as f64 / r * 60.0).round() as i64,
        _ => 0,
    };
    let scope = if total >= 0 {
        scope.clamp(0, total)
    } else {
        scope.clamp(total, 0)
    };
    (scope, total - scope)
}

/// The slip is a risk at max(1 h, 25% of the planned duration).
pub fn slipping(current: i64, original: i64, started: i64) -> bool {
    let planned = (original - started).max(0);
    current - original >= (3_600_000).max(planned / 4)
}

/// The lead's calibrated estimate is shown beside the measured ETA when they differ by more than max(1 h, 50% of the
/// measured duration).
pub fn lead_differs(lead_done: i64, current: i64, started: i64) -> bool {
    let measured = (current - started).max(0);
    (lead_done - current).abs() > (3_600_000).max(measured / 2)
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 3_600_000;

    #[test]
    fn busy_time_is_the_union_clipped_to_the_window() {
        let now = 10 * 24 * H;
        let spans = [
            (now - 5 * H, Some(now - 2 * H)),
            (now - 3 * H, None),
            (now - 9 * 24 * H, Some(now - 6 * 24 * H)),
        ];
        assert_eq!(
            busy_ms(&spans, now),
            5 * H + 24 * H,
            "overlap merged, open runs to now, old clipped to 7 days"
        );
        assert_eq!(busy_ms(&[], now), 0);
    }

    #[test]
    fn rate_needs_five_samples_and_eta_divides_remaining_by_it() {
        let few = Rate {
            points: 12,
            samples: 4,
            busy_ms: 3 * H,
        };
        assert_eq!(few.per_hour(), None, "measuring: 4 of 5");
        let r = Rate {
            points: 12,
            samples: 5,
            busy_ms: 3 * H,
        }
        .per_hour()
        .unwrap();
        assert!((r - 4.0).abs() < 1e-9);
        assert_eq!(throughput_eta(0, 8, r), 2 * H);
        assert_eq!(throughput_eta(7, 0, r), 7);
    }

    #[test]
    fn the_chain_is_the_longest_serial_path_less_elapsed_time() {
        let d: HashMap<Size, i64> = [(Size::S, H), (Size::M, 3 * H), (Size::L, 8 * H)].into();
        let items = vec![
            ChainItem {
                n: 12,
                size: Size::L,
                started_ms: Some(0),
                after: vec![],
            },
            ChainItem {
                n: 14,
                size: Size::M,
                started_ms: None,
                after: vec![12],
            },
            ChainItem {
                n: 15,
                size: Size::S,
                started_ms: None,
                after: vec![],
            },
        ];
        let (len, path) = chain(&items, &d, 2 * H).unwrap();
        assert_eq!(len, 6 * H + 3 * H, "P12 has 6h left, then P14 3h");
        assert_eq!(path, vec![12, 14]);
        let overdue = vec![ChainItem {
            n: 1,
            size: Size::S,
            started_ms: Some(0),
            after: vec![],
        }];
        assert_eq!(chain(&overdue, &d, 5 * H).unwrap().0, 0);
        let cyclic = vec![
            ChainItem {
                n: 1,
                size: Size::S,
                started_ms: None,
                after: vec![2],
            },
            ChainItem {
                n: 2,
                size: Size::S,
                started_ms: None,
                after: vec![1],
            },
        ];
        assert!(
            chain(&cyclic, &d, 0).is_some(),
            "a cycle ends instead of looping"
        );
        let unmeasured: HashMap<Size, i64> = HashMap::new();
        assert!(chain(&items, &unmeasured, 0).is_none());
    }

    #[test]
    fn slip_splits_into_scope_and_speed() {
        assert_eq!(
            slip(20 * H, 0, 24, Some(4.0)),
            (6 * 60, 14 * 60),
            "+6h scope, +14h slower"
        );
        assert_eq!(
            slip(2 * H, 0, 40, Some(4.0)),
            (2 * 60, 0),
            "scope never exceeds the slip"
        );
        assert!(slipping(H, 0, -H));
        assert!(!slipping(H - 1, 0, -H));
        assert!(!slipping(2 * H, 0, -10 * H), "25% of a 10h plan is 2.5h");
        assert!(lead_differs(10 * H, 3 * H, 0));
        assert!(!lead_differs(4 * H, 3 * H, 0));
    }
}
