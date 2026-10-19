//! Replays real hub history through the progress model, minute by minute, next to the old figure (verified points
//! only). Reads COPIES of hub databases; each is read through a read-only connection into a private scratch copy, so
//! the files given are never written. Never point it at a running hub's database.
//!
//! cargo run -p fleetd --example progress_replay -- --out replay.json --hours 48 fleet.sqlite [lab.sqlite ...]
//!
//! The first database is the fleet: its orders also make the fleet curve. Each order is replayed with the model as the
//! hub would have run it (calibrated from that database's units verified before the order began, which falls back to
//! the built-in model until enough are), and with a what-if calibration from every other verified unit of its
//! database, whatever their number.
use std::path::{Path, PathBuf};

use fleetd::hub::status::calib::{self, Forecast};
use fleetd::hub::status::model::{
    self, Calibration, Cause, Group, ItemProgress, MIN_DURATION_SAMPLES, MIN_WEIGHT_SAMPLES,
    Params, Point, Unit, UnitKind, item_progress, next_point,
};
use fleetd::hub::status::timeline::{self, Timeline};
use fleetd::hub::store::HubDb;
use fleetd_contracts::status::DropReason;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

const MIN: i64 = 60_000;

/// Read through a read-only connection into a scratch copy, migrated there so an older hub's database reads like a
/// current one (a branch build's database, migrated out of order, is read as it is).
fn load(path: &Path, hours: i64) -> anyhow::Result<Vec<Timeline>> {
    let src = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let scratch = tempfile::tempdir()?;
    let file = scratch.path().join("hub.sqlite");
    src.execute("VACUUM INTO ?1", [file.to_string_lossy()])?;
    drop(src);
    let read = |c: &Connection| -> rusqlite::Result<Vec<Timeline>> {
        let newest: i64 =
            c.query_row("SELECT COALESCE(MAX(created_ms), 0) FROM events", [], |r| {
                r.get(0)
            })?;
        timeline::load(c, newest - hours * 3_600_000, None)
    };
    match HubDb::open(scratch.path()) {
        Ok(db) => Ok(db.with(|c| Ok(read(c)?))?),
        Err(_) => Ok(read(&Connection::open(&file)?)?),
    }
}

struct Order<'a> {
    source: usize,
    ws: &'a str,
    units: Vec<&'a Timeline>,
}

impl Order<'_> {
    fn start(&self) -> i64 {
        self.units[0].order_ms
    }
    fn live(&self) -> impl Iterator<Item = &&Timeline> {
        self.units.iter().filter(|u| !u.dropped)
    }
    fn done(&self) -> Option<i64> {
        let done: Option<Vec<i64>> = self.live().map(|u| u.done_ms()).collect();
        done?.into_iter().max()
    }
    fn points(&self) -> f64 {
        self.live().map(|u| u.size.points() as f64).sum()
    }
    /// The new model's group at `t`, and each planned unit's progress.
    fn group_at(&self, cal: &Calibration, t: i64) -> (Group, Vec<ItemProgress>) {
        let first = self.units[0];
        let (share, usual) = cal.planning(&first.pkey);
        let planning = model::planning(
            first.order_ms,
            first.plan_ms.filter(|p| *p <= t),
            t,
            share,
            usual,
        );
        let progress: Vec<ItemProgress> = self
            .live()
            .filter(|u| u.start_ms <= t)
            .map(|u| item_progress(&u.facts_at(t), t, &cal.resolve(&u.pkey, u.kind, u.size)))
            .collect();
        let units = self
            .live()
            .filter(|u| u.start_ms <= t)
            .zip(&progress)
            .map(|(u, p)| Unit {
                points: u.size.points() as f64,
                progress: p.clone(),
            })
            .collect();
        let group = Group {
            points: self.points(),
            planning: Some(planning),
            units,
            done: self.done().is_some_and(|d| d <= t),
        };
        (group, progress)
    }
}

/// The old figure: verified points over planned points.
fn old_pct(orders: &[&Order], t: i64) -> i64 {
    let (mut done, mut total) = (0.0, 0.0);
    for u in orders
        .iter()
        .flat_map(|o| o.live())
        .filter(|u| u.order_ms <= t)
    {
        total += u.size.points() as f64;
        if u.done_ms().is_some_and(|d| d <= t) {
            done += u.size.points() as f64;
        }
    }
    if total > 0.0 {
        (100.0 * done / total).floor() as i64
    } else {
        0
    }
}

/// (t, old, new as calibrated, new what-if).
type Row = (i64, i64, Point, Point);

fn curve(
    orders: &[&Order],
    cals: &[(Calibration, Calibration)],
    causes: &[Cause],
    from: i64,
    to: i64,
) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    let mut t = from;
    while t <= to {
        let at = |pick: fn(&(Calibration, Calibration)) -> &Calibration| {
            let groups: Vec<Group> = orders
                .iter()
                .zip(cals)
                .filter(|(o, _)| o.start() <= t)
                .map(|(o, c)| o.group_at(pick(c), t).0)
                .collect();
            model::estimate(&groups)
        };
        let (a, b) = (at(|c| &c.0), at(|c| &c.1));
        let prev = rows.last();
        let pa = next_point(prev.map(|r| &r.2), a.pct, a.verified_pct, causes, t);
        let pb = next_point(prev.map(|r| &r.3), b.pct, b.verified_pct, causes, t);
        rows.push((t, old_pct(orders, t), pa, pb));
        t += MIN;
    }
    rows
}

/// The longest stretch, in ms, a figure held still before reaching 100.
fn longest_flat(rows: &[Row], pick: impl Fn(&Row) -> i64) -> i64 {
    let (mut best, mut since) = (0, None::<(i64, i64)>);
    for r in rows {
        let (t, v) = (r.0, pick(r));
        match since {
            Some((t0, v0)) if v0 == v => best = best.max(t - t0),
            _ => since = Some((t, v)),
        }
        if v >= 100 {
            break;
        }
    }
    best
}

fn rows_json(rows: &[Row]) -> Value {
    let drop = |p: &Point| {
        p.drop
            .as_ref()
            .map(|d| json!({ "reason": d.reason, "from": d.from_pct, "text": d.text }))
    };
    rows.iter()
        .map(|(t, old, a, b)| {
            json!({ "t": t, "old": old, "new": a.pct, "verified": a.verified, "drop": drop(a), "whatIf": b.pct })
        })
        .collect()
}

/// Every sample count raised to the model's minimum, so a calibration from few units is used rather than set aside.
fn any_samples(mut c: Calibration) -> Calibration {
    let bump = |p: &mut Params| {
        if p.weights.is_some() {
            p.weight_samples = p.weight_samples.max(MIN_WEIGHT_SAMPLES);
        }
        for d in &mut p.durations {
            d.durations.samples = d.durations.samples.max(MIN_DURATION_SAMPLES);
        }
        if p.planning_share.is_some() {
            p.planning_samples = p.planning_samples.max(MIN_DURATION_SAMPLES);
        }
    };
    bump(&mut c.fleet);
    c.projects.values_mut().for_each(bump);
    c
}

fn rank(mut v: Vec<f64>, p: f64) -> Option<f64> {
    v.sort_by(f64::total_cmp);
    let r = (p * v.len() as f64).ceil() as usize;
    v.get(r.max(1) - 1).copied()
}

/// |p50 − finish| per replayed minute, absolute and over the time left, and whether it finished by p90.
#[derive(Default)]
struct Errors(Vec<(f64, f64, bool)>);

impl Errors {
    fn json(&self) -> Value {
        let abs = self.0.iter().map(|e| e.0 / MIN as f64).collect::<Vec<_>>();
        let rel = self.0.iter().map(|e| e.1).collect::<Vec<_>>();
        json!({
            "samples": self.0.len(),
            "absMinutes": { "p50": rank(abs.clone(), 0.5), "p90": rank(abs, 0.9) },
            "relative": { "p50": rank(rel.clone(), 0.5), "p90": rank(rel, 0.9) },
            "finishedByP90": self.0.iter().filter(|e| e.2).count() as f64 / self.0.len().max(1) as f64,
        })
    }
}

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let (mut out, mut hours, mut paths) =
        (PathBuf::from("replay.json"), 48i64, Vec::<PathBuf>::new());
    while let Some(a) = args.next() {
        match a.as_str() {
            "--out" => out = args.next().expect("--out path").into(),
            "--hours" => hours = args.next().expect("--hours n").parse()?,
            _ => paths.push(a.into()),
        }
    }
    anyhow::ensure!(!paths.is_empty(), "give at least one hub database copy");
    let mut sources: Vec<(String, Vec<Timeline>)> = Vec::new();
    for path in &paths {
        let name = path
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        match load(path, hours) {
            Ok(units) => sources.push((name, units)),
            Err(error) => eprintln!("skipping {name}: {error}"),
        }
    }
    anyhow::ensure!(!sources.is_empty(), "no database could be read");
    let mut orders: Vec<Order> = Vec::new();
    for (i, (_, units)) in sources.iter().enumerate() {
        let mut ids: Vec<&str> = units.iter().map(|u| u.workstream.as_str()).collect();
        ids.dedup();
        for ws in ids {
            orders.push(Order {
                source: i,
                ws,
                units: units.iter().filter(|u| u.workstream == ws).collect(),
            });
        }
    }
    let cals_of = |o: &Order| {
        let units = &sources[o.source].1;
        let pick = |keep: &dyn Fn(&Timeline) -> bool| -> Vec<Timeline> {
            units.iter().filter(|u| keep(u)).cloned().collect()
        };
        let before = pick(&|u| u.done_ms().is_some_and(|d| d < o.start()));
        let others = pick(&|u| u.workstream != o.ws);
        (
            calib::derive(&before, &[], o.start()),
            any_samples(calib::derive(&others, &[], o.start())),
        )
    };
    let smallest: Vec<Option<i64>> = sources
        .iter()
        .map(|(_, units)| {
            units
                .iter()
                .filter(|u| !u.dropped)
                .filter_map(|u| Some(u.done_ms()? - u.start_ms))
                .min()
        })
        .collect();

    let mut out_orders = Vec::new();
    let mut errors = [
        [Errors::default(), Errors::default()],
        [Errors::default(), Errors::default()],
    ];
    let mut forecasts: [Vec<Forecast>; 2] = [Vec::new(), Vec::new()];
    let mut worst_flat = [(0i64, 0i64), (0, 0)];
    for o in orders.iter().filter(|o| o.done().is_some()) {
        let done = o.done().unwrap_or_default();
        let cals = cals_of(o);
        let group = usize::from(o.source != 0);
        let rows = curve(
            &[o],
            std::slice::from_ref(&cals),
            &o.units[0].causes,
            o.start(),
            done + MIN,
        );
        let flat = (
            longest_flat(&rows, |r| r.1),
            longest_flat(&rows, |r| r.2.pct),
        );
        worst_flat[group] = (
            worst_flat[group].0.max(flat.0),
            worst_flat[group].1.max(flat.1),
        );
        let mut eta = Vec::new();
        for (k, cal) in [&cals.0, &cals.1].into_iter().enumerate() {
            let mut t = o.start();
            while t < done {
                let (_, progress) = o.group_at(cal, t);
                if !progress.is_empty() {
                    let (p50, p90) =
                        model::scope_eta(&progress.iter().collect::<Vec<_>>(), 1, (0, 0), t);
                    let err = (p50 - done).abs() as f64;
                    errors[group][k]
                        .0
                        .push((err, err / (done - t).max(MIN) as f64, done <= p90));
                    if k == 0 {
                        eta.push(json!({ "t": t, "p50": p50, "p90": p90 }));
                    }
                }
                t += MIN;
            }
        }
        for u in o.live() {
            forecasts[group].push(calib::forecast(u, u.start_ms, &cals.0));
        }
        let first = o.units[0];
        out_orders.push(json!({
            "source": sources[o.source].0, "workstream": o.ws, "start": o.start(), "done": done,
            "basis": cals.0.resolve(&first.pkey, first.kind, first.size).basis,
            "units": o.units.iter().map(|u| json!({
                "label": u.label, "kind": if u.kind == UnitKind::Order { "order" } else { "item" },
                "size": u.size, "start": u.start_ms, "done": u.done_ms(), "dropped": u.dropped,
            })).collect::<Vec<_>>(),
            "longestFlatMs": { "old": flat.0, "new": flat.1, "smallestUnitMs": smallest[o.source] },
            "series": rows_json(&rows), "eta": eta,
        }));
    }

    // The fleet: the first database's orders, each joining the figure (a scope change) when it was created.
    let fleet_orders: Vec<&Order> = orders.iter().filter(|o| o.source == 0).collect();
    let fleet = (!fleet_orders.is_empty()).then(|| {
        let mut causes: Vec<Cause> = fleet_orders
            .iter()
            .flat_map(|o| o.units[0].causes.clone())
            .collect();
        causes.extend(fleet_orders.iter().map(|o| Cause {
            at_ms: o.start(),
            reason: DropReason::ScopeChange,
            text: format!("+1 order: {}", o.ws),
        }));
        let cals: Vec<(Calibration, Calibration)> =
            fleet_orders.iter().map(|o| cals_of(o)).collect();
        let from = fleet_orders.iter().map(|o| o.start()).min().unwrap_or(0);
        let to = fleet_orders
            .iter()
            .map(|o| o.done().unwrap_or(from))
            .max()
            .unwrap_or(from)
            + MIN;
        curve(&fleet_orders, &cals, &causes, from, to)
    });
    let fleet_flat = fleet
        .as_ref()
        .map(|r| (longest_flat(r, |r| r.1), longest_flat(r, |r| r.2.pct)));

    let group_json = |g: usize, flat_fleet: Option<(i64, i64)>| {
        let smallest = if g == 0 {
            smallest[0]
        } else {
            smallest[1..].iter().flatten().min().copied()
        };
        let worst_new = worst_flat[g].1.max(flat_fleet.map_or(0, |f| f.1));
        let latest = forecasts[g]
            .iter()
            .filter_map(|f| f.done_ms)
            .max()
            .unwrap_or(0);
        json!({
            "smallestUnitMs": smallest,
            "longestFlatMs": {
                "orders": { "old": worst_flat[g].0, "new": worst_flat[g].1 },
                "fleet": flat_fleet.map(|(o, n)| json!({ "old": o, "new": n })),
            },
            "flatWithinSmallestUnit": smallest.is_some_and(|s| worst_new <= s),
            "etaError": { "asShipped": errors[g][0].json(), "whatIfCalibratedFromOthers": errors[g][1].json() },
            "forecastAccuracy": calib::accuracy(&forecasts[g], latest)
                .map(|a| json!({ "withinPct": a.within_pct, "samples": a.samples })),
        })
    };
    let report = json!({
        "hours": hours,
        "sources": sources.iter().map(|(n, u)| json!({ "name": n, "units": u.len() })).collect::<Vec<_>>(),
        "fleet": group_json(0, fleet_flat),
        "lab": (sources.len() > 1).then(|| group_json(1, None)),
        "notes": [
            "asShipped: calibrated from the database's units verified before the order began; with fewer than the model's minimum samples that is the built-in model",
            "whatIfCalibratedFromOthers: calibrated from every other verified unit of the same database, minimum sample counts ignored",
            "etaError: |p50 - actual finish| at every replayed minute of a finished order; relative = over the time that was left",
            "forecastAccuracy: four in five units finished within ±withinPct of the p50 predicted when they were planned",
        ],
        "orders": out_orders,
        "fleetSeries": fleet.map(|r| json!({ "source": sources[0].0, "series": rows_json(&r) })),
    });
    std::fs::write(&out, serde_json::to_string_pretty(&report)?)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({ "fleet": report["fleet"], "lab": report["lab"] }))?
    );
    Ok(())
}
