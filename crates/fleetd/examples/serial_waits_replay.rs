//! Runs the time inspector's rules over real hub history and reports the serial-wait findings: what fired, and what
//! each serial rule measured while staying under its threshold. Reads COPIES of hub databases; each is read through
//! a read-only connection into a private scratch copy, so the files given are never written. Never point it at a
//! running hub's database.
//!
//! cargo run -p fleetd --example serial_waits_replay -- [--json] [--cap 40] [--batch-max 4] fleet.sqlite [lab.sqlite ...]
//!
//! The period is the whole history each database still holds spans for, at fleet scope. Slot use is measured from
//! the lead and task runs (a slot is held while its session runs).
use std::path::Path;

use fleetd::hub::store::HubDb;
use fleetd::hub::time::model::Batching;
use fleetd::hub::time::rules;
use fleetd::hub::time::tools::read_rule_input;
use fleetd_contracts::time::{Insight, InsightRule, SpanKind, TimeScope};
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

const SERIAL: [InsightRule; 4] = [
    InsightRule::QueueWait,
    InsightRule::Contention,
    InsightRule::IdleLead,
    InsightRule::SlotsUnderused,
];

fn name(rule: InsightRule) -> String {
    serde_json::to_value(rule)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn numbers(i: &Insight) -> Value {
    i.numbers
        .iter()
        .map(|n| (n.name.to_string(), json!(n.value.get())))
        .collect::<serde_json::Map<_, _>>()
        .into()
}

fn replay(path: &Path, cap: i64, batch_max: i64) -> anyhow::Result<Value> {
    let src = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let scratch = tempfile::tempdir()?;
    src.execute(
        "VACUUM INTO ?1",
        [scratch.path().join("hub.sqlite").to_string_lossy()],
    )?;
    drop(src);
    let db = HubDb::open(scratch.path())?;
    let report = db.with(|c| {
        let (since, until): (i64, i64) = c.query_row(
            "SELECT COALESCE(MIN(start_ms), 0), COALESCE(MAX(COALESCE(end_ms, start_ms)), 0) + 1 FROM time_spans",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let batching = Batching {
            max: batch_max,
            off: Default::default(),
        };
        let input = read_rule_input(c, &TimeScope::Fleet, since, until, cap, &batching)?;
        let found = rules::evaluate(&input);
        let runs: Vec<_> = input
            .rows
            .iter()
            .filter(|r| r.kind == SpanKind::Run && r.role.is_some())
            .collect();
        let held: i64 = runs.iter().map(|r| r.dur()).sum();
        let mut edges: Vec<(i64, i64)> = runs
            .iter()
            .flat_map(|r| [(r.start_ms, 1), (r.end_ms, -1)])
            .collect();
        edges.sort_unstable();
        let (mut n, mut peak) = (0, 0);
        for (_, d) in edges {
            n += d;
            peak = peak.max(n);
        }
        let ready_ms: i64 = input.serial.ready.iter().map(|r| r.to_ms - r.from_ms).sum();
        Ok(json!({
            "db": path.display().to_string(),
            "since_ms": since,
            "until_ms": until,
            "spans": input.rows.len(),
            "slots": {
                "cap": cap,
                "held_ms": held,
                "pct": if until > since { held * 100 / (cap * (until - since)) } else { 0 },
                "peak": peak,
            },
            "serial_inputs": {
                "ready_stretches": input.serial.ready.len(),
                "ready_ms": ready_ms,
                "lead_runs": input.serial.lead_runs.len(),
                "slots_full_spells": input.serial.slots_full.len(),
                "slot_waits": input.serial.slot_queued.len(),
            },
            "fired": found.iter().filter(|(_, f)| *f).map(|(i, _)| json!({
                "rule": name(i.rule), "message": i.message.as_str(), "numbers": numbers(i),
            })).collect::<Vec<_>>(),
            "serial_under_threshold": found.iter()
                .filter(|(i, f)| !*f && SERIAL.contains(&i.rule))
                .map(|(i, _)| json!({ "rule": name(i.rule), "message": i.message.as_str(), "numbers": numbers(i) }))
                .collect::<Vec<_>>(),
        }))
    })?;
    Ok(report)
}

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1).peekable();
    let (mut as_json, mut cap, mut batch_max, mut paths) = (false, 40, 4, Vec::new());
    while let Some(a) = args.next() {
        match a.as_str() {
            "--json" => as_json = true,
            "--cap" => cap = args.next().and_then(|v| v.parse().ok()).unwrap_or(40),
            "--batch-max" => batch_max = args.next().and_then(|v| v.parse().ok()).unwrap_or(4),
            _ => paths.push(a),
        }
    }
    anyhow::ensure!(!paths.is_empty(), "give the path of a hub database copy");
    let reports: Vec<Value> = paths
        .iter()
        .map(|p| replay(Path::new(p), cap, batch_max))
        .collect::<anyhow::Result<_>>()?;
    if as_json {
        println!("{}", serde_json::to_string_pretty(&reports)?);
        return Ok(());
    }
    for r in &reports {
        println!(
            "{}: {} spans over {} min; slots {}% of {} held, peak {}",
            r["db"].as_str().unwrap_or(""),
            r["spans"],
            (r["until_ms"].as_i64().unwrap_or(0) - r["since_ms"].as_i64().unwrap_or(0)) / 60_000,
            r["slots"]["pct"],
            r["slots"]["cap"],
            r["slots"]["peak"]
        );
        println!("  serial inputs: {}", r["serial_inputs"]);
        println!("  fired:");
        for f in r["fired"].as_array().into_iter().flatten() {
            println!(
                "    [{}] {}",
                f["rule"].as_str().unwrap_or(""),
                f["message"].as_str().unwrap_or("")
            );
        }
        println!("  serial, under threshold:");
        for f in r["serial_under_threshold"].as_array().into_iter().flatten() {
            println!(
                "    [{}] {}  {}",
                f["rule"].as_str().unwrap_or(""),
                f["message"].as_str().unwrap_or(""),
                f["numbers"]
            );
        }
    }
    Ok(())
}
