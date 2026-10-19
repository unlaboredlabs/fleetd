//! Calibrating the progress model from history. Each night (and at hub start when the stored one is older than the
//! last night) the stage weights and durations are measured from the units verified in the last 30 days, per
//! project and across the fleet; `model::Calibration::resolve` falls back from one to the other to the defaults.
//! The forecast log keeps each unit's predicted finish from when it first appeared, against when it was verified:
//! that is "ETAs have been within ±20% this week".
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use chrono::{NaiveTime, TimeZone};
use chrono_tz::Tz;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::plan::Size;
use rusqlite::{Connection, OptionalExtension, params};

use super::model::{
    Accuracy, Calibration, DurationRow, MIN_DURATION_SAMPLES, Params, STAGES, StageDurations,
    StageWeights, UnitKind, item_progress,
};
use super::timeline::{self, Timeline};
use crate::hub::api::Hub;
use crate::hub::store::{StoreError, now_ms};

const MIN: i64 = 60_000;
const DAY_MS: i64 = 24 * 60 * MIN;
/// History the nightly recompute measures.
pub const WINDOW_MS: i64 = 30 * DAY_MS;
/// History the accuracy figure covers.
pub const ACCURACY_DAYS: i64 = 7;
/// Local hour of the nightly recompute.
pub const RECOMPUTE_HOUR: u32 = 3;
/// Four in five forecasts land within the accuracy figure.
const ACCURACY_RANK: f64 = 0.8;

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

/// One unit's predicted finish, made when it first appeared.
#[derive(Clone, Debug, PartialEq)]
pub struct Forecast {
    pub unit: String,
    pub pkey: String,
    pub predicted_ms: i64,
    pub p50_ms: i64,
    pub p90_ms: i64,
    pub done_ms: Option<i64>,
}

/// What the model predicts at `at` for a unit's finish.
pub fn forecast(t: &Timeline, at: i64, cal: &Calibration) -> Forecast {
    let r = cal.resolve(&t.pkey, t.kind, t.size);
    let p = item_progress(&t.facts_at(at), at, &r);
    Forecast {
        unit: t.label.clone(),
        pkey: t.pkey.clone(),
        predicted_ms: at,
        p50_ms: at + p.remaining_p50_ms,
        p90_ms: at + p.remaining_p90_ms,
        done_ms: t.done_ms(),
    }
}

/// How far a forecast's p50 was from the finish, as a share of the time it had to look ahead.
pub fn relative_error(f: &Forecast) -> Option<f64> {
    let done = f.done_ms?;
    Some((done - f.p50_ms).abs() as f64 / (done - f.predicted_ms).max(MIN) as f64)
}

/// Four in five of the last week's verified units finished within ±`within_pct` of their p50, rounded up to 5%.
pub fn accuracy(forecasts: &[Forecast], now: i64) -> Option<Accuracy> {
    let from = now - ACCURACY_DAYS * DAY_MS;
    let mut errs: Vec<f64> = forecasts
        .iter()
        .filter(|f| f.done_ms.is_some_and(|d| d >= from && d <= now))
        .filter_map(relative_error)
        .collect();
    if (errs.len() as i64) < MIN_DURATION_SAMPLES {
        return None;
    }
    errs.sort_by(f64::total_cmp);
    let e = rank(&errs, ACCURACY_RANK);
    Some(Accuracy {
        within_pct: (((e * 100.0) / 5.0).ceil() as i64 * 5).max(5),
        samples: errs.len() as i64,
    })
}

/// The calibration measured from `units`: only verified ones are measured, per project and across the fleet.
pub fn derive(units: &[Timeline], forecasts: &[Forecast], now: i64) -> Calibration {
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
        accuracy: accuracy(forecasts, now),
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

pub fn forecasts(c: &Connection, since_ms: i64) -> rusqlite::Result<Vec<Forecast>> {
    let mut stmt = c.prepare(
        "SELECT unit, pkey, predicted_ms, p50_ms, p90_ms, done_ms FROM progress_forecasts
         WHERE done_ms IS NULL OR done_ms >= ?1",
    )?;
    stmt.query_map([since_ms], |r| {
        Ok(Forecast {
            unit: r.get(0)?,
            pkey: r.get(1)?,
            predicted_ms: r.get(2)?,
            p50_ms: r.get(3)?,
            p90_ms: r.get(4)?,
            done_ms: r.get(5)?,
        })
    })?
    .collect()
}

/// Logs a forecast for each unit that has none yet (made at `now` with `cal`), and the finish of each verified one.
pub fn log(
    c: &Connection,
    units: &[Timeline],
    cal: &Calibration,
    now: i64,
) -> rusqlite::Result<()> {
    for t in units.iter().filter(|t| !t.dropped) {
        let done = t.done_ms();
        if done.is_none() {
            let f = forecast(t, now.max(t.start_ms), cal);
            c.execute(
                "INSERT INTO progress_forecasts (unit, pkey, predicted_ms, p50_ms, p90_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (unit) DO NOTHING",
                params![f.unit, f.pkey, f.predicted_ms, f.p50_ms, f.p90_ms],
            )?;
        }
        c.execute(
            "UPDATE progress_forecasts SET done_ms = ?2 WHERE unit = ?1 AND done_ms IS NOT ?2",
            params![t.label, done],
        )?;
    }
    Ok(())
}

/// Measures the last 30 days and stores the result.
pub fn recompute(c: &Connection, now: i64) -> rusqlite::Result<Calibration> {
    let units = timeline::load(c, now - WINDOW_MS, None)?;
    let fc = forecasts(c, now - ACCURACY_DAYS * DAY_MS)?;
    let cal = derive(&units, &fc, now);
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

/// Events after which an order's units may have appeared or finished.
const FOLLOWED: &[HubEventType] = &[
    HubEventType::PlanChanged,
    HubEventType::TaskStarted,
    HubEventType::PlanVerified,
    HubEventType::WorkstreamDone,
];

fn db<R>(hub: &Hub, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> Result<R, StoreError> {
    hub.db.with(|c| Ok(f(c)?))
}

/// The nightly recompute and the forecast log. Recomputes at hub start when the stored calibration predates the
/// last night, then at each `RECOMPUTE_HOUR`; logs on the events that make or finish units. Never polls.
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
    let mut cal = Arc::new(cal);
    hub.status.set_calibration(cal.clone());
    let mut head = hub.events.subscribe();
    let mut cursor = *head.borrow_and_update();
    let mut due = next_run(now, tz);
    loop {
        loop {
            let page = match hub.events.page(cursor, Some(FOLLOWED), None) {
                Ok(p) => p,
                Err(error) => {
                    tracing::error!(%error, "progress calibration: reading events");
                    break;
                }
            };
            let mut orders: Vec<String> = page
                .events
                .iter()
                .filter_map(|e| {
                    e.data
                        .as_ref()?
                        .get("workstreamId")?
                        .as_str()
                        .map(str::to_owned)
                })
                .collect();
            orders.sort();
            orders.dedup();
            let now = now_ms(hub.clock.as_ref());
            for ws in orders {
                if let Err(error) = db(&hub, |c| {
                    log(c, &timeline::load(c, 0, Some(&ws))?, &cal, now)
                }) {
                    tracing::error!(%error, "progress forecast log");
                }
            }
            cursor = page.cursor;
            if !page.more {
                break;
            }
        }
        let now = now_ms(hub.clock.as_ref());
        if now >= due {
            match db(&hub, |c| recompute(c, now)) {
                Ok(c) => {
                    cal = Arc::new(c);
                    hub.status.set_calibration(cal.clone());
                }
                Err(error) => tracing::error!(%error, "progress calibration"),
            }
            due = next_run(now, tz);
        }
        let sleep = Duration::from_millis((due - now).clamp(0, 3_600_000) as u64);
        tokio::select! {
            changed = head.changed() => if changed.is_err() { return },
            () = hub.clock.sleep(sleep) => {}
            () = hub.shutdown.wait() => return,
        }
        head.borrow_and_update();
    }
}

#[cfg(test)]
mod tests;
