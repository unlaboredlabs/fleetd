//! Replays real hub history through the progress model, minute by minute, next to the old figure (verified points
//! only). Reads COPIES of hub databases; each is read through a read-only connection into a private scratch copy, so
//! the files given are never written. Never point it at a running hub's database.
//!
//! cargo run -p fleetd --example progress_replay -- --out replay.json --hours 48 fleet.sqlite [lab.sqlite ...]
//!
//! The first database is the live fleet (its orders also make the fleet curve), the rest are lab runs. Every finished
//! order is replayed with the built-in model, and leave-one-out: calibrated from every other order (all databases,
//! or only those of its own kind, live or lab) pooled across projects and unit kinds, minimum sample counts ignored.
//! Progress quality: steadiness, drops only with a reason, and how far the estimate is from the share of the order's
//! time that had passed.
use std::path::{Path, PathBuf};

use fleetd::hub::status::calib;
use fleetd::hub::status::model::{
    self, Calibration, Cause, DurationRow, Group, ItemProgress, MIN_DURATION_SAMPLES,
    MIN_WEIGHT_SAMPLES, Params, Point, STAGES, StageDurations, Unit, UnitKind, item_progress,
    next_point,
};
use fleetd::hub::status::timeline::{self, Timeline};
use fleetd::hub::store::HubDb;
use fleetd_contracts::plan::Size;
use fleetd_contracts::status::DropReason;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

const MIN: i64 = 60_000;
/// A one-minute rise at least this big is reported as a jump.
const JUMP: i64 = 10;
const VARIANTS: [&str; 3] = ["builtIn", "looAll", "looSameKind"];

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
    live: bool,
    ws: &'a str,
    units: Vec<&'a Timeline>,
}

impl Order<'_> {
    fn start(&self) -> i64 {
        self.units[0].order_ms
    }
    fn live_units(&self) -> impl Iterator<Item = &&Timeline> {
        self.units.iter().filter(|u| !u.dropped)
    }
    fn done(&self) -> Option<i64> {
        let done: Option<Vec<i64>> = self.live_units().map(|u| u.done_ms()).collect();
        done?.into_iter().max()
    }
    fn points(&self) -> f64 {
        self.live_units().map(|u| u.size.points() as f64).sum()
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
        let planned: Vec<&&Timeline> = self.live_units().filter(|u| u.start_ms <= t).collect();
        let progress: Vec<ItemProgress> = planned
            .iter()
            .map(|u| item_progress(&u.facts_at(t), t, &cal.resolve(&u.pkey, u.kind, u.size)))
            .collect();
        let units = planned
            .iter()
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
        .flat_map(|o| o.live_units())
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

/// (t, old, one point per calibration).
type Row = (i64, i64, Vec<Point>);

/// `cals[i][k]`: order i's calibration in variant k.
fn curve(
    orders: &[&Order],
    cals: &[Vec<Calibration>],
    causes: &[Cause],
    from: i64,
    to: i64,
) -> Vec<Row> {
    let variants = cals.first().map_or(0, Vec::len);
    let mut rows: Vec<Row> = Vec::new();
    let mut t = from;
    while t <= to {
        let points = (0..variants)
            .map(|k| {
                let groups: Vec<Group> = orders
                    .iter()
                    .zip(cals)
                    .filter(|(o, _)| o.start() <= t)
                    .map(|(o, c)| o.group_at(&c[k], t).0)
                    .collect();
                let e = model::estimate(&groups);
                next_point(
                    rows.last().map(|r| &r.2[k]),
                    e.pct,
                    e.verified_pct,
                    causes,
                    t,
                )
            })
            .collect();
        rows.push((t, old_pct(orders, t), points));
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
        .map(|(t, old, p)| {
            json!({ "t": t, "old": old, "new": p[0].pct, "verified": p[0].verified, "drop": drop(&p[0]),
                    "loo": p.get(1).map(|p| p.pct) })
        })
        .collect()
}

/// One calibration from `units` pooled across projects and unit kinds, every sample count raised to the model's
/// minimum. A size nobody measured is scaled from a measured one by points.
fn pooled(units: &[&Timeline]) -> Calibration {
    let us: Vec<Timeline> = units
        .iter()
        .map(|u| Timeline {
            kind: UnitKind::Item,
            pkey: "pooled".into(),
            ..(*u).clone()
        })
        .collect();
    let mut p = calib::derive(&us, 0).fleet;
    let measured: Vec<DurationRow> = p.durations.clone();
    let mut rows = Vec::new();
    for size in [Size::S, Size::M, Size::L] {
        let base = measured
            .iter()
            .find(|r| r.size == size)
            .or_else(|| measured.iter().find(|r| r.size == Size::M))
            .or(measured.first());
        let Some(base) = base else { continue };
        let k = size.points() as f64 / base.size.points() as f64;
        let scale = |a: [i64; STAGES - 1]| a.map(|v| (v as f64 * k).round() as i64);
        let d = StageDurations {
            p50: scale(base.durations.p50),
            p90: scale(base.durations.p90),
            samples: base.durations.samples,
        };
        for kind in [UnitKind::Item, UnitKind::Order] {
            rows.push(DurationRow {
                kind,
                size,
                durations: d.clone(),
            });
        }
    }
    p.durations = rows;
    bump(&mut p);
    Calibration {
        fleet: p,
        ..Calibration::default()
    }
}

fn bump(p: &mut Params) {
    if p.weights.is_some() {
        p.weight_samples = p.weight_samples.max(MIN_WEIGHT_SAMPLES);
    }
    for d in &mut p.durations {
        d.durations.samples = d.durations.samples.max(MIN_DURATION_SAMPLES);
    }
    if p.planning_share.is_some() {
        p.planning_samples = p.planning_samples.max(MIN_DURATION_SAMPLES);
    }
}

/// The weights and per-size lengths a pooled calibration measured: a candidate for the built-in model.
fn defaults_json(units: &[&Timeline]) -> Value {
    let c = pooled(units);
    let measured = units
        .iter()
        .filter(|u| !u.dropped && u.done_ms().is_some())
        .count();
    json!({
        "units": measured,
        "cumWeights": c.fleet.weights.map(|w| w.cum.map(|x| (x * 1000.0).round() / 1000.0)),
        "totalMinutesBySize": c.fleet.durations.iter().filter(|r| r.kind == UnitKind::Item)
            .map(|r| json!({ "size": r.size, "p50": r.durations.total_p50() as f64 / MIN as f64,
                             "p90": r.durations.p90.iter().sum::<i64>() as f64 / MIN as f64 }))
            .collect::<Vec<_>>(),
        "planningShare": c.fleet.planning_share,
        "planningMinutes": c.fleet.planning_p50_ms.map(|m| m as f64 / MIN as f64),
    })
}

fn rank(mut v: Vec<f64>, p: f64) -> Option<f64> {
    v.sort_by(f64::total_cmp);
    let r = (p * v.len() as f64).ceil() as usize;
    v.get(r.max(1) - 1).copied()
}

/// |estimate − share of the order's time passed| per replayed minute, in points.
#[derive(Default)]
struct Tracking(Vec<f64>);

impl Tracking {
    fn json(&self) -> Value {
        let r1 = |x: Option<f64>| x.map(|x| (x * 10.0).round() / 10.0);
        let mean = (!self.0.is_empty()).then(|| self.0.iter().sum::<f64>() / self.0.len() as f64);
        json!({ "minutes": self.0.len(), "meanAbsPoints": r1(mean), "p90AbsPoints": r1(rank(self.0.clone(), 0.9)) })
    }
}

/// Points where a figure fell, and those of them without a stated reason.
fn drops(rows: &[Row], k: usize) -> (usize, usize) {
    rows.windows(2)
        .filter(|w| w[1].2[k].pct < w[0].2[k].pct)
        .fold((0, 0), |(n, bare), w| {
            (n + 1, bare + usize::from(w[1].2[k].drop.is_none()))
        })
}

/// Every one-minute rise of at least JUMP points, with what each unit did in that minute.
fn jumps(o: &Order, cal: &Calibration, rows: &[Row], k: usize) -> Vec<Value> {
    let mut out = Vec::new();
    for w in rows.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        let delta = b.2[k].pct - a.2[k].pct;
        if delta < JUMP {
            continue;
        }
        let units: Vec<Value> = o
            .live_units()
            .filter_map(|u| {
                let r = cal.resolve(&u.pkey, u.kind, u.size);
                let (s0, e0) = u.facts_at(a.0).current();
                let (s1, _) = u.facts_at(b.0).current();
                let usual = r.durations.p50.get(s0.index()).copied().unwrap_or(1).max(1);
                let fill = (a.0 - e0) as f64 / usual as f64;
                (s0 != s1 || fill >= model::IN_STAGE_CAP).then(|| {
                    json!({ "unit": u.label, "from": s0, "to": s1,
                            "stageFilledBefore": (fill.min(9.99) * 100.0).round() / 100.0,
                            "heldAtCapBefore": fill >= model::IN_STAGE_CAP,
                            "usualStageMinutes": usual as f64 / MIN as f64 })
                })
            })
            .collect();
        out.push(json!({ "minute": (b.0 - o.start()) / MIN, "from": a.2[k].pct, "to": b.2[k].pct, "units": units }));
    }
    out
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
    for (i, path) in paths.iter().enumerate() {
        let name = path
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        match load(path, hours) {
            Ok(units) => sources.push((name, units)),
            Err(error) if i == 0 => anyhow::bail!("the fleet database {name}: {error}"),
            Err(error) => eprintln!("skipping {name}: {error}"),
        }
    }
    let mut orders: Vec<Order> = Vec::new();
    for (i, (_, units)) in sources.iter().enumerate() {
        let mut ids: Vec<&str> = units.iter().map(|u| u.workstream.as_str()).collect();
        ids.dedup();
        for ws in ids {
            orders.push(Order {
                source: i,
                live: i == 0,
                ws,
                units: units.iter().filter(|u| u.workstream == ws).collect(),
            });
        }
    }
    let same = |a: &Order, b: &Order| a.source == b.source && a.ws == b.ws;
    let cals_of = |o: &Order| -> Vec<Calibration> {
        let others = |keep: &dyn Fn(&Order) -> bool| -> Vec<&Timeline> {
            orders
                .iter()
                .filter(|x| !same(x, o) && keep(x))
                .flat_map(|x| x.units.iter().copied())
                .collect()
        };
        vec![
            Calibration::default(),
            pooled(&others(&|_| true)),
            pooled(&others(&|x| x.live == o.live)),
        ]
    };
    let smallest = |live: bool| {
        orders
            .iter()
            .filter(|o| o.live == live)
            .flat_map(|o| o.live_units())
            .filter_map(|u| Some(u.done_ms()? - u.start_ms))
            .min()
    };

    let mut out_orders = Vec::new();
    let mut worst_flat = [(0i64, 0i64, 0i64); 2];
    let mut tracking: Vec<[Tracking; 2]> = VARIANTS.iter().map(|_| Default::default()).collect();
    let mut drop_counts = [[(0usize, 0usize); 3]; 2];
    for o in orders.iter().filter(|o| o.done().is_some()) {
        let done = o.done().unwrap_or_default();
        let cals = cals_of(o);
        let tag = usize::from(!o.live);
        let rows = curve(
            &[o],
            std::slice::from_ref(&cals),
            &o.units[0].causes,
            o.start(),
            done + MIN,
        );
        let flat = (
            longest_flat(&rows, |r| r.1),
            longest_flat(&rows, |r| r.2[0].pct),
            longest_flat(&rows, |r| r.2[1].pct),
        );
        let w = &mut worst_flat[tag];
        *w = (w.0.max(flat.0), w.1.max(flat.1), w.2.max(flat.2));
        for (k, counts) in drop_counts[tag].iter_mut().enumerate() {
            let cal = &cals[k];
            let rows_k = if k < 2 {
                rows.iter()
                    .map(|r| (r.0, r.1, vec![r.2[k].clone()]))
                    .collect::<Vec<Row>>()
            } else {
                curve(
                    &[o],
                    &[vec![cal.clone()]],
                    &o.units[0].causes,
                    o.start(),
                    done + MIN,
                )
            };
            let (n, bare) = drops(&rows_k, 0);
            *counts = (counts.0 + n, counts.1 + bare);
            for r in rows_k.iter().filter(|r| r.0 <= done) {
                let realized = 100.0 * (r.0 - o.start()) as f64 / (done - o.start()).max(1) as f64;
                tracking[k][tag]
                    .0
                    .push((r.2[0].pct as f64 - realized).abs());
            }
        }
        out_orders.push(json!({
            "source": sources[o.source].0, "live": o.live, "workstream": o.ws, "start": o.start(), "done": done,
            "units": o.units.iter().map(|u| json!({
                "label": u.label, "kind": if u.kind == UnitKind::Order { "order" } else { "item" },
                "size": u.size, "start": u.start_ms, "done": u.done_ms(), "dropped": u.dropped,
            })).collect::<Vec<_>>(),
            "longestFlatMs": { "old": flat.0, "builtIn": flat.1, "looAll": flat.2 },
            "jumps": { "builtIn": jumps(o, &cals[0], &rows, 0), "looAll": jumps(o, &cals[1], &rows, 1) },
            "series": rows_json(&rows),
        }));
    }

    // The fleet: the live database's orders, each joining the figure (a scope change) when it was created.
    let fleet_orders: Vec<&Order> = orders.iter().filter(|o| o.live).collect();
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
        let cals: Vec<Vec<Calibration>> = fleet_orders
            .iter()
            .map(|o| cals_of(o)[..2].to_vec())
            .collect();
        let from = fleet_orders.iter().map(|o| o.start()).min().unwrap_or(0);
        let to = fleet_orders
            .iter()
            .map(|o| o.done().unwrap_or(from))
            .max()
            .unwrap_or(from)
            + MIN;
        curve(&fleet_orders, &cals, &causes, from, to)
    });
    let fleet_flat = fleet.as_ref().map(|r| {
        json!({ "old": longest_flat(r, |r| r.1), "builtIn": longest_flat(r, |r| r.2[0].pct),
                "looAll": longest_flat(r, |r| r.2[1].pct) })
    });

    let group = |tag: usize| {
        let live = tag == 0;
        let w = worst_flat[tag];
        json!({
            "orders": orders.iter().filter(|o| o.live == live && o.done().is_some()).count(),
            "smallestUnitMs": smallest(live),
            "longestFlatMsPerOrder": { "old": w.0, "builtIn": w.1, "looAll": w.2 },
            "tracking": VARIANTS.iter().zip(&tracking).map(|(n, e)| (n.to_string(), e[tag].json()))
                .collect::<serde_json::Map<_, _>>(),
            "drops": VARIANTS.iter().zip(&drop_counts[tag]).map(|(n, (all, bare))| (n.to_string(), json!({ "all": all, "unexplained": bare })))
                .collect::<serde_json::Map<_, _>>(),
        })
    };
    let all_units: Vec<&Timeline> = orders
        .iter()
        .flat_map(|o| o.units.iter().copied())
        .collect();
    let live_units: Vec<&Timeline> = orders
        .iter()
        .filter(|o| o.live)
        .flat_map(|o| o.units.iter().copied())
        .collect();
    let report = json!({
        "hours": hours,
        "sources": sources.iter().map(|(n, u)| json!({ "name": n, "units": u.len() })).collect::<Vec<_>>(),
        "live": group(0),
        "lab": group(1),
        "fleetLongestFlatMs": fleet_flat,
        "proposedDefaults": { "allData": defaults_json(&all_units), "liveOnly": defaults_json(&live_units) },
        "notes": [
            "builtIn: the model's built-in weights and lengths (M item = 60 min)",
            "looAll: leave-one-out, calibrated from every other finished unit of every database, pooled across projects and unit kinds, minimum sample counts ignored; a size nobody measured is scaled by points",
            "looSameKind: the same, from other live orders only for a live order and other lab orders only for a lab order",
            "tracking: |estimate % - share of the order's wall time passed| at every replayed minute, in points",
            "drops: points where the estimate fell; unexplained = without a stated reason (must be 0)",
            "jumps: one-minute rises of 10+ points; stageFilledBefore = elapsed/usual in the stage the unit was in (the model caps credit at 0.9 of it)",
        ],
        "orders": out_orders,
        "fleetSeries": fleet.map(|r| json!({ "source": sources[0].0, "series": rows_json(&r) })),
    });
    std::fs::write(&out, serde_json::to_string_pretty(&report)?)?;
    let brief = |g: &Value| {
        json!({ "orders": g["orders"], "smallestUnitMs": g["smallestUnitMs"],
        "longestFlatMsPerOrder": g["longestFlatMsPerOrder"], "tracking": g["tracking"], "drops": g["drops"] })
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "live": brief(&report["live"]), "lab": brief(&report["lab"]),
            "fleetLongestFlatMs": report["fleetLongestFlatMs"], "proposedDefaults": report["proposedDefaults"],
        }))?
    );
    Ok(())
}
