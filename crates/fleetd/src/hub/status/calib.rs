//! Calibrating the progress model from history. Each night (and at hub start when the stored one is older than the
//! last night) the stage weights and durations are measured from the units verified in the last 30 days, per
//! project and across the fleet; `model::Calibration::resolve` falls back from one to the other to the defaults.
//! Internal only: it weights progress (stage shares, in-stage smoothing, "slower than usual") and is never shown as a
//! time.
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use chrono::{NaiveTime, TimeZone};
use chrono_tz::Tz;
use fleetd_contracts::plan::Size;
use rusqlite::{Connection, OptionalExtension, params};

use super::model::{
    Calibration, DurationRow, Params, STAGES, StageDurations, StageWeights, UnitKind,
};
use super::timeline::{self, Timeline};
use crate::hub::api::Hub;
use crate::hub::store::{StoreError, now_ms};

const MIN: i64 = 60_000;
const DAY_MS: i64 = 24 * 60 * MIN;
/// History the nightly recompute measures.
pub const WINDOW_MS: i64 = 30 * DAY_MS;
/// Local hour of the nightly recompute.
pub const RECOMPUTE_HOUR: u32 = 3;

/// Nearest-rank percentile of a sorted, non-empty list.
fn rank<T: Copy>(sorted: &[T], p: f64) -> T {
    let r = (p * sorted.len() as f64).ceil() as usize;
    sorted[r.clamp(1, sorted.len()) - 1]
}

fn median_f(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    let m = v.len() / 2;
    if v.len() % 2 == 1 {
        v[m]
    } else {
        (v[m - 1] + v[m]) / 2.0
    }
}

fn p50_p90(mut v: Vec<i64>) -> (i64, i64) {
    v.sort_unstable();
    let m = v.len() / 2;
    let p50 = if v.len() % 2 == 1 {
        v[m]
    } else {
        (v[m - 1] + v[m]) / 2
    };
    (p50, rank(&v, 0.9))
}

/// A verified unit's stage times, every stage set.
fn finished(t: &Timeline) -> Option<[i64; STAGES]> {
    if t.dropped {
        return None;
    }
    let done = t.done_ms()?;
    let f = t.first_reached();
    let mut out = [0; STAGES];
    for k in 0..STAGES {
        out[k] = f[k].unwrap_or(done);
    }
    (out[STAGES - 1] > out[0]).then_some(out)
}

/// One scope's measured parameters.
pub fn params(units: &[&Timeline]) -> Params {
    let done: Vec<(&Timeline, [i64; STAGES])> = units
        .iter()
        .filter_map(|t| finished(t).map(|f| (*t, f)))
        .collect();
    let mut p = Params {
        weight_samples: done.len() as i64,
        ..Params::default()
    };
    if !done.is_empty() {
        // The median share of a unit's wall time spent before each stage.
        let mut shares = [0.0; STAGES];
        for (k, share) in shares.iter_mut().enumerate() {
            *share = median_f(
                done.iter()
                    .map(|(_, f)| (f[k] - f[0]) as f64 / (f[STAGES - 1] - f[0]) as f64)
                    .collect(),
            );
        }
        p.weights = Some(StageWeights::from_shares(shares));
    }
    type Class = (UnitKind, Size);
    let mut classes: Vec<(Class, Vec<[i64; STAGES]>)> = Vec::new();
    for (t, f) in &done {
        let class = (t.kind, t.size);
        match classes.iter_mut().find(|(c, _)| *c == class) {
            Some((_, fs)) => fs.push(*f),
            None => classes.push((class, vec![*f])),
        }
    }
    for ((kind, size), fs) in classes {
        let mut d = StageDurations {
            p50: [0; STAGES - 1],
            p90: [0; STAGES - 1],
            samples: fs.len() as i64,
        };
        for k in 0..STAGES - 1 {
            let (a, b) = p50_p90(fs.iter().map(|f| f[k + 1] - f[k]).collect());
            d.p50[k] = a;
            d.p90[k] = b.max(a);
        }
        p.durations.push(DurationRow {
            kind,
            size,
            durations: d,
        });
    }
    // Planning: from the order's creation to its plan, against the order's whole wall time.
    let mut orders: HashMap<&str, (i64, Option<i64>, i64, bool)> = HashMap::new();
    for t in units {
        let e = orders
            .entry(t.workstream.as_str())
            .or_insert((t.order_ms, t.plan_ms, 0, true));
        match t.done_ms() {
            Some(d) if !t.dropped => e.2 = e.2.max(d),
            _ if t.dropped => {}
            _ => e.3 = false,
        }
    }
    let planned: Vec<(i64, i64)> = orders
        .values()
        .filter_map(|&(start, plan, done, all)| {
            let plan = plan?;
            (all && done > plan && plan >= start).then_some((plan - start, done - start))
        })
        .collect();
    p.planning_samples = planned.len() as i64;
    if !planned.is_empty() {
        p.planning_share = Some(median_f(
            planned.iter().map(|(a, w)| *a as f64 / *w as f64).collect(),
        ));
        p.planning_p50_ms = Some(p50_p90(planned.iter().map(|(a, _)| *a).collect()).0);
    }
    p
}

/// The calibration measured from `units`: only verified ones are measured, per project and across the fleet.
pub fn derive(units: &[Timeline], now: i64) -> Calibration {
    let all: Vec<&Timeline> = units.iter().collect();
    let mut by_project: BTreeMap<&str, Vec<&Timeline>> = BTreeMap::new();
    for t in units {
        by_project.entry(t.pkey.as_str()).or_default().push(t);
    }
    Calibration {
        fleet: params(&all),
        projects: by_project
            .into_iter()
            .map(|(k, v)| (k.to_owned(), params(&v)))
            .collect(),
        accuracy: None,
        computed_ms: now,
    }
}

pub fn stored(c: &Connection) -> rusqlite::Result<Option<Calibration>> {
    let row: Option<String> = c
        .query_row(
            "SELECT data FROM progress_calibration WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(row.and_then(|d| serde_json::from_str(&d).ok()))
}

fn save(c: &Connection, cal: &Calibration) -> rusqlite::Result<()> {
    let data = serde_json::to_string(cal).unwrap_or_default();
    c.execute(
        "INSERT INTO progress_calibration (id, computed_ms, data) VALUES (1, ?1, ?2)
         ON CONFLICT (id) DO UPDATE SET computed_ms = excluded.computed_ms, data = excluded.data",
        params![cal.computed_ms, data],
    )?;
    Ok(())
}

/// Measures the last 30 days and stores the result.
pub fn recompute(c: &Connection, now: i64) -> rusqlite::Result<Calibration> {
    let units = timeline::load(c, now - WINDOW_MS, None)?;
    let cal = derive(&units, now);
    save(c, &cal)?;
    Ok(cal)
}

/// The first `RECOMPUTE_HOUR`:00 local strictly after `after_ms`.
pub fn next_run(after_ms: i64, tz: Tz) -> i64 {
    let day = tz
        .timestamp_millis_opt(after_ms)
        .single()
        .map_or_else(|| chrono::Utc::now().date_naive(), |t| t.date_naive());
    let at = NaiveTime::from_hms_opt(RECOMPUTE_HOUR, 0, 0).expect("valid hour");
    (0..3)
        .filter_map(|d| day.checked_add_signed(chrono::Duration::days(d)))
        .filter_map(|d| tz.from_local_datetime(&d.and_time(at)).earliest())
        .map(|t| t.timestamp_millis())
        .find(|t| *t > after_ms)
        .unwrap_or(after_ms + DAY_MS)
}

fn db<R>(hub: &Hub, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> Result<R, StoreError> {
    hub.db.with(|c| Ok(f(c)?))
}

/// Recomputes at hub start when the stored calibration predates the last night, then at each `RECOMPUTE_HOUR`.
/// Sleeps at most an hour at a time, so a host that slept recomputes once on waking. Never polls.
pub async fn run(hub: Arc<Hub>) {
    let tz = crate::hub::attention::hub_zone();
    let now = now_ms(hub.clock.as_ref());
    let last_night = next_run(now - DAY_MS, tz);
    let cal = match db(&hub, stored) {
        Ok(Some(c)) if c.computed_ms >= last_night || last_night > now => c,
        _ => db(&hub, |c| recompute(c, now)).unwrap_or_else(|error| {
            tracing::error!(%error, "progress calibration");
            Calibration::default()
        }),
    };
    hub.status.set_calibration(Arc::new(cal));
    let mut due = next_run(now, tz);
    loop {
        let now = now_ms(hub.clock.as_ref());
        if now >= due {
            match db(&hub, |c| recompute(c, now)) {
                Ok(c) => hub.status.set_calibration(Arc::new(c)),
                Err(error) => tracing::error!(%error, "progress calibration"),
            }
            due = next_run(now, tz);
        }
        let sleep = Duration::from_millis((due - now).clamp(0, 3_600_000) as u64);
        tokio::select! {
            () = hub.clock.sleep(sleep) => {}
            () = hub.shutdown.wait() => return,
        }
    }
}

#[cfg(test)]
mod tests;
