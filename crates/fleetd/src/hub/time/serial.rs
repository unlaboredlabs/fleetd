//! The serial-wait rules: work that waited while capacity existed. Each finding names the fix. Every number is
//! measured from recorded spans and the hub's own rows (when a plan item became ready, when its task was spawned);
//! nothing here estimates. Whether a slot was free is read fleet-wide (`slots.full` spells and every `queue.slot`
//! wait), whatever the scope. Interval lists are kept sorted and merged, so each rule is linear in what it reads
//! after one sort.
use std::collections::{BTreeMap, BTreeSet, HashMap};

use fleetd_contracts::time::{InsightRule, SpanKind, TimeScope};
use rusqlite::{Connection, params};

use super::model::{Batching, LeadRun, Ready, Row, RuleInput, Serial};
use super::rules::{Candidate, fmt_dur, short, spans, total};
use crate::hub::plan::store::{self as plan_store, ItemRow};
use crate::hub::store::StoreError;

const MIN: i64 = 60_000;

pub const QUEUE_WAIT_MIN: i64 = 5 * MIN;
pub const CONTENTION_MIN: i64 = 5 * MIN;
pub const IDLE_LEAD_MIN: i64 = 5 * MIN;
/// An idle stretch shorter than this is the hub waking the lead (its debounce and the turn's start), not idleness.
pub const IDLE_STRETCH_MIN: i64 = MIN;
pub const UNDERUSED_MIN: i64 = 5 * MIN;

/// The default policy's one area, which every write task takes.
const DEFAULT_AREA: &str = "all";

type Iv = (i64, i64);

/// Sorted, non-overlapping, non-empty. Touching intervals join.
fn merge(mut v: Vec<Iv>) -> Vec<Iv> {
    v.retain(|(s, e)| e > s);
    v.sort_unstable();
    let mut out: Vec<Iv> = Vec::with_capacity(v.len());
    for (s, e) in v {
        match out.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out
}

/// `a` minus `b`, both merged, in one pass over each.
fn minus(a: &[Iv], b: &[Iv]) -> Vec<Iv> {
    let mut out = Vec::new();
    let mut j = 0;
    for &(s, e) in a {
        while j < b.len() && b[j].1 <= s {
            j += 1;
        }
        let mut cur = s;
        let mut k = j;
        while k < b.len() && b[k].0 < e {
            if b[k].0 > cur {
                out.push((cur, b[k].0));
            }
            cur = cur.max(b[k].1);
            if b[k].1 > e {
                break;
            }
            k += 1;
        }
        if cur < e {
            out.push((cur, e));
        }
    }
    out
}

/// The parts of merged `v` within `[s, e)`.
fn clip(v: &[Iv], s: i64, e: i64) -> impl Iterator<Item = Iv> + '_ {
    let from = v.partition_point(|iv| iv.1 <= s);
    v[from..]
        .iter()
        .take_while(move |iv| iv.0 < e)
        .map(move |&(a, b)| (a.max(s), b.min(e)))
}

fn clip_len(v: &[Iv], s: i64, e: i64) -> i64 {
    clip(v, s, e).map(|(a, b)| b - a).sum()
}

fn len(v: &[Iv]) -> i64 {
    v.iter().map(|(s, e)| e - s).sum()
}

fn project_of(r: &Row) -> String {
    format!(
        "{}/{}",
        r.machine_id.as_deref().unwrap_or("?"),
        r.project_id.as_deref().unwrap_or("?")
    )
}

fn machine_of(project: &str) -> &str {
    project.split_once('/').map_or(project, |(m, _)| m)
}

fn title<'a>(input: &'a RuleInput, project: &'a str) -> &'a str {
    input
        .serial
        .project_titles
        .get(project)
        .map_or(project, String::as_str)
}

fn reason(r: &Row) -> &str {
    r.extra.reason.as_ref().map_or("", |x| x.as_str())
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// When `project`'s work could not have started anyway: no slot free (every slot held, or something already
/// queued for one), or its machine parked on a usage limit or offline. Those waits are other findings'.
fn blocked(input: &RuleInput, project: &str) -> Vec<Iv> {
    let s = &input.serial;
    merge(
        s.slots_full
            .iter()
            .chain(&s.slot_queued)
            .chain(
                s.machine_blocked
                    .get(machine_of(project))
                    .into_iter()
                    .flatten(),
            )
            .copied()
            .collect(),
    )
}

fn repo_of(lane: &str) -> &str {
    let lane = lane.strip_prefix("change:").unwrap_or(lane);
    lane.split('#').next().unwrap_or(lane)
}

/// One train run of a repo: the merged span of its members' rebase, CI and merge (a batch's members overlap).
struct Run<'a> {
    start: i64,
    end: i64,
    lanes: BTreeSet<&'a str>,
}

fn train_runs<'a>(rows: &[&'a Row]) -> Vec<Run<'a>> {
    // A PR's own rebase, CI and merge follow one another: one cycle per lane first.
    let mut by_lane: HashMap<&str, Vec<Iv>> = HashMap::new();
    for r in rows {
        by_lane
            .entry(r.lane.as_str())
            .or_default()
            .push((r.start_ms, r.end_ms));
    }
    let mut cycles: Vec<(i64, i64, &str)> = by_lane
        .into_iter()
        .flat_map(|(lane, v)| merge(v).into_iter().map(move |(s, e)| (s, e, lane)))
        .collect();
    cycles.sort_unstable();
    let mut out: Vec<Run> = Vec::new();
    for (s, e, lane) in cycles {
        match out.last_mut() {
            // Cycles of different PRs that overlap are one batch; back-to-back ones stay two runs.
            Some(run) if s < run.end => {
                run.end = run.end.max(e);
                run.lanes.insert(lane);
            }
            _ => out.push(Run {
                start: s,
                end: e,
                lanes: BTreeSet::from([lane]),
            }),
        }
    }
    out
}

/// Why waiting out a run was the train's limit and not the PR's own: only then is there a fix.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum TrainLimit {
    /// GitHub refused batch merges for the repo; it goes one at a time until the hub restarts.
    Off,
    /// `FLEETD_TRAIN_BATCH_MAX=1`.
    One,
    /// The run already held `FLEETD_TRAIN_BATCH_MAX` PRs.
    Full,
}

/// Tasks queued for a slot while the fleet had free ones (a project's max agents or the lead band held them).
fn slot_waits(input: &RuleInput, out: &mut Vec<Candidate>) {
    let full = merge(input.serial.slots_full.clone());
    let mut by_project: BTreeMap<String, Vec<(&Row, i64)>> = BTreeMap::new();
    for r in input.rows.iter().filter(|r| r.kind == SpanKind::QueueSlot) {
        let free = (r.end_ms - r.start_ms) - clip_len(&full, r.start_ms, r.end_ms);
        if free > 0 {
            by_project.entry(project_of(r)).or_default().push((r, free));
        }
    }
    for (project, waits) in by_project {
        let sum: i64 = waits.iter().map(|(_, ms)| ms).sum();
        let tasks: BTreeSet<&str> = waits
            .iter()
            .filter_map(|(r, _)| r.task_id.as_deref())
            .collect();
        let why = waits.iter().map(|(r, _)| reason(r)).find(|r| !r.is_empty());
        let fix = match why {
            Some(w) if w.starts_with("agents: ") => "raise the project's max agents with cap_set",
            Some(w) if w.contains("reserved") => {
                "raise the cap with cap_set: the last slots of the cap are kept for lead turns"
            }
            _ => "check the cap and the project's max agents with cap_set",
        };
        out.push(Candidate {
            rule: InsightRule::QueueWait,
            key: format!("slot:{project}"),
            fired: sum >= QUEUE_WAIT_MIN,
            message: format!(
                "{} in {} waited {} for a slot while the fleet had free ones{}: {fix}",
                plural(tasks.len().max(1), "task", "tasks"),
                short(title(input, &project)),
                fmt_dur(sum),
                why.map(|w| format!(" ({})", short(w))).unwrap_or_default()
            ),
            numbers: vec![("tasks", tasks.len() as i64), ("total_ms", sum)],
            spans: spans(waits.iter().map(|(r, _)| *r)),
            weight: sum,
        });
    }
}

/// PRs that were ready while a train run of other PRs started and went through it, when the train's batching is
/// what kept them out: the run was already at the batch limit, the limit is 1, or batching is off for the repo. A
/// PR left out for its own reasons (files that overlap, red on its own head, dropped by a bisect) waited for a
/// reason batching can't remove, so it isn't counted. The limit read is the train's now.
fn train_waits(input: &RuleInput, out: &mut Vec<Candidate>) {
    let batching = &input.serial.batching;
    if batching.max <= 0 {
        return;
    }
    let mut cycles: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    let mut queued: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in &input.rows {
        match r.kind {
            SpanKind::ChangeRebase | SpanKind::ChangeCi | SpanKind::ChangeMerge => {
                cycles.entry(repo_of(&r.lane)).or_default().push(r)
            }
            SpanKind::ChangeQueue => queued.entry(repo_of(&r.lane)).or_default().push(r),
            _ => {}
        }
    }
    for (repo, waits) in queued {
        let runs = train_runs(cycles.get(repo).map_or(&[][..], Vec::as_slice));
        let off = batching
            .off
            .iter()
            .find(|(r, _)| r.eq_ignore_ascii_case(repo))
            .map(|(_, why)| why.as_str());
        // limit -> (waits, runs waited out by index, ms).
        let mut by_limit: BTreeMap<TrainLimit, (Vec<&Row>, BTreeSet<usize>, i64)> = BTreeMap::new();
        for q in waits {
            // A run that started as the PR turned ready could not have taken it.
            let first = runs.partition_point(|r| r.start <= q.start_ms);
            for (i, run) in runs
                .iter()
                .enumerate()
                .skip(first)
                .take_while(|(_, r)| r.start < q.end_ms)
            {
                if run.lanes.contains(q.lane.as_str()) {
                    continue;
                }
                let limit = if off.is_some() {
                    TrainLimit::Off
                } else if batching.max <= 1 {
                    TrainLimit::One
                } else if run.lanes.len() as i64 >= batching.max {
                    TrainLimit::Full
                } else {
                    continue;
                };
                let e = by_limit.entry(limit).or_default();
                e.0.push(q);
                e.1.insert(i);
                e.2 += run.end.min(q.end_ms) - run.start;
            }
        }
        for (limit, (rows, waited_out, sum)) in by_limit {
            let prs: BTreeSet<&str> = rows.iter().map(|q| q.lane.as_str()).collect();
            let (cause, fix) = match limit {
                TrainLimit::Off => (
                    format!(
                        "of one PR each, with batching off for this repo ({})",
                        short(off.unwrap_or(""))
                    ),
                    "fix what GitHub refused, then restart the hub so the train batches again"
                        .to_owned(),
                ),
                TrainLimit::One => (
                    "of one PR each, with FLEETD_TRAIN_BATCH_MAX=1".to_owned(),
                    "raise FLEETD_TRAIN_BATCH_MAX so disjoint green PRs share a CI run".to_owned(),
                ),
                TrainLimit::Full => (
                    format!("already holding the batch limit of {} PRs", batching.max),
                    format!("raise FLEETD_TRAIN_BATCH_MAX (now {})", batching.max),
                ),
            };
            out.push(Candidate {
                rule: InsightRule::QueueWait,
                key: format!("train:{repo}:{limit:?}"),
                fired: sum >= QUEUE_WAIT_MIN,
                message: format!(
                    "{} in the `{}` train waited {} through {} {cause}: {fix}",
                    plural(prs.len(), "ready PR", "ready PRs"),
                    short(repo),
                    fmt_dur(sum),
                    plural(waited_out.len(), "CI run", "CI runs"),
                ),
                numbers: vec![
                    ("prs", prs.len() as i64),
                    ("runs", waited_out.len() as i64),
                    ("batch_max", batching.max),
                    ("total_ms", sum),
                ],
                spans: spans(rows.iter().copied()),
                weight: sum,
            });
        }
    }
}

/// Work that waited in a fleetd queue although there was room: a slot, or a place in a train run.
pub(super) fn queue_wait(input: &RuleInput, out: &mut Vec<Candidate>) {
    slot_waits(input, out);
    train_waits(input, out);
}

/// "lease: docs held by T1, hub held by T2" -> [("docs", "T1"), ("hub", "T2")].
fn lease_conflicts(reason: &str) -> Vec<(&str, &str)> {
    let Some(rest) = reason.strip_prefix("lease: ") else {
        return Vec::new();
    };
    rest.trim_end_matches('…')
        .split(", ")
        .filter_map(|part| {
            let (area, by) = part.split_once(" held by ")?;
            Some((area.trim(), by.trim()))
        })
        .collect()
}

#[derive(Default)]
struct Held<'a> {
    waits: Vec<&'a Row>,
    by: BTreeSet<&'a str>,
}

/// Tasks that waited, one after another, for one shared resource: an area lease of a project, or one machine's
/// claude usage. Offline machines are the `offline` rule's.
pub(super) fn contention(input: &RuleInput, out: &mut Vec<Candidate>) {
    // (project, area) -> the waits, and the tasks that held it.
    let mut areas: BTreeMap<(String, String), Held> = BTreeMap::new();
    for r in input.rows.iter().filter(|r| r.kind == SpanKind::QueueLease) {
        for (area, by) in lease_conflicts(reason(r)) {
            let e = areas.entry((project_of(r), area.to_owned())).or_default();
            e.waits.push(r);
            e.by.insert(by);
        }
    }
    for (
        (project, area),
        Held {
            waits: rows,
            by: holders,
        },
    ) in areas
    {
        let sum = total(rows.iter().copied());
        let tasks: BTreeSet<&str> = rows.iter().filter_map(|r| r.task_id.as_deref()).collect();
        let fix = if area == DEFAULT_AREA {
            "define areas in .fleetd/policy.yaml so tasks that write different paths run side by side".to_owned()
        } else {
            format!(
                "narrow or split area `{}` in .fleetd/policy.yaml so tasks that touch different paths run side by side",
                short(&area)
            )
        };
        out.push(Candidate {
            rule: InsightRule::Contention,
            key: format!("area:{project}/{area}"),
            fired: sum >= CONTENTION_MIN,
            message: format!(
                "{} in {} waited {} for area `{}`, held by {}: {fix}",
                plural(tasks.len().max(1), "task", "tasks"),
                short(title(input, &project)),
                fmt_dur(sum),
                short(&area),
                holders
                    .iter()
                    .take(3)
                    .copied()
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            numbers: vec![
                ("tasks", tasks.len() as i64),
                ("holders", holders.len() as i64),
                ("total_ms", sum),
            ],
            spans: spans(rows.iter().copied()),
            weight: sum,
        });
    }

    let mut machines: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in input.rows.iter().filter(|r| r.kind == SpanKind::QueueUsage) {
        machines
            .entry(r.machine_id.as_deref().unwrap_or("a machine"))
            .or_default()
            .push(r);
    }
    for (machine, rows) in machines {
        let sum = total(rows.iter().copied());
        let tasks: BTreeSet<&str> = rows.iter().filter_map(|r| r.task_id.as_deref()).collect();
        out.push(Candidate {
            rule: InsightRule::Contention,
            key: format!("usage:{machine}"),
            fired: sum >= CONTENTION_MIN,
            message: format!(
                "{} waited {} for claude usage on {machine}, one limit for all of its projects: a larger plan, or some projects on another machine",
                plural(tasks.len().max(1), "task", "tasks"),
                fmt_dur(sum)
            ),
            numbers: vec![("tasks", tasks.len() as i64), ("total_ms", sum)],
            spans: spans(rows.iter().copied()),
            weight: sum,
        });
    }
}

fn ready_by_project(input: &RuleInput) -> BTreeMap<&str, Vec<&Ready>> {
    let mut out: BTreeMap<&str, Vec<&Ready>> = BTreeMap::new();
    for r in &input.serial.ready {
        out.entry(r.project.as_str()).or_default().push(r);
    }
    out
}

/// Each project's lead runs, by when they end.
fn lead_runs_by_project(input: &RuleInput) -> HashMap<&str, Vec<&LeadRun>> {
    let mut out: HashMap<&str, Vec<&LeadRun>> = HashMap::new();
    for r in &input.serial.lead_runs {
        out.entry(r.project.as_str()).or_default().push(r);
    }
    for runs in out.values_mut() {
        runs.sort_by_key(|r| (r.end_ms, r.span_id));
    }
    out
}

/// The lead runs that ended last before each stretch, and those during it: the turns that left ready work. A
/// lead's runs follow one another, so by their end they are also by their start.
fn runs_before(runs: &[&LeadRun], stretches: &[Iv]) -> Vec<(i64, i64)> {
    let mut out = BTreeSet::new();
    for &(s, e) in stretches {
        let i = runs.partition_point(|r| r.end_ms <= s);
        if let Some(r) = i.checked_sub(1).map(|i| runs[i]) {
            out.insert((r.start_ms, r.span_id));
        }
        for r in runs[i..].iter().take_while(|r| r.start_ms < e) {
            out.insert((r.start_ms, r.span_id));
        }
    }
    out.into_iter().collect()
}

/// A project's lead was not running while one of its orders had a plan item ready to start and its work could
/// have started (a slot free, its machine neither parked on usage nor offline). A lead with no runs in the period is
/// left out: its node sent no spans (an older fleetd), so idle is not known.
pub(super) fn idle_lead(input: &RuleInput, out: &mut Vec<Candidate>) {
    let lead = lead_runs_by_project(input);
    for (project, items) in ready_by_project(input) {
        let Some(runs) = lead.get(project) else {
            continue;
        };
        let busy = merge(runs.iter().map(|r| (r.start_ms, r.end_ms)).collect());
        let ready = merge(items.iter().map(|r| (r.from_ms, r.to_ms)).collect());
        let idle: Vec<Iv> = minus(&minus(&ready, &busy), &blocked(input, project))
            .into_iter()
            .filter(|(s, e)| e - s >= IDLE_STRETCH_MIN)
            .collect();
        let sum = len(&idle);
        if sum == 0 {
            continue;
        }
        // Each item's own share of the idle time, most first.
        let mut per_item: BTreeMap<(&str, &str), i64> = BTreeMap::new();
        for r in &items {
            *per_item.entry((&r.item_id, &r.title)).or_default() +=
                clip_len(&idle, r.from_ms, r.to_ms);
        }
        let mut ranked: Vec<((&str, &str), i64)> =
            per_item.into_iter().filter(|(_, ms)| *ms > 0).collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let ((item, item_title), _) = ranked[0];
        let more = match ranked.len() - 1 {
            0 => " was".to_owned(),
            n => format!(" and {n} more were"),
        };
        out.push(Candidate {
            rule: InsightRule::IdleLead,
            key: project.to_owned(),
            fired: sum >= IDLE_LEAD_MIN,
            message: format!(
                "the lead of {} was idle {} while {item} `{}`{more} ready to start and slots were free: spawn ready plan items before the lead's turn ends",
                short(title(input, project)),
                fmt_dur(sum),
                short(item_title)
            ),
            numbers: vec![
                ("idle_ms", sum),
                ("items", ranked.len() as i64),
                ("stretches", idle.len() as i64),
            ],
            spans: runs_before(runs, &idle),
            weight: sum,
        });
    }
}

/// The stretches where at least two of `items` were ready at once, and the most ready at once.
fn side_by_side(items: impl Iterator<Item = Iv>) -> (Vec<Iv>, i64) {
    let mut edges: Vec<(i64, i64)> = Vec::new();
    for (s, e) in items.filter(|(s, e)| e > s) {
        edges.push((s, 1));
        edges.push((e, -1));
    }
    // Ends before starts at the same instant: back-to-back items are not side by side.
    edges.sort_unstable();
    let (mut n, mut peak, mut since) = (0i64, 0i64, None);
    let mut out = Vec::new();
    for (t, d) in edges {
        n += d;
        peak = peak.max(n);
        match (n >= 2, since) {
            (true, None) => since = Some(t),
            (false, Some(s)) => {
                out.push((s, t));
                since = None;
            }
            _ => {}
        }
    }
    (merge(out), peak)
}

/// The most lead and task sessions running at once among the scope's spans.
fn peak_running(input: &RuleInput) -> i64 {
    let mut edges: Vec<(i64, i64)> = Vec::new();
    for r in input
        .rows
        .iter()
        .filter(|r| r.kind == SpanKind::Run && r.role.is_some())
    {
        edges.push((r.start_ms, 1));
        edges.push((r.end_ms, -1));
    }
    edges.sort_unstable();
    let (mut n, mut peak) = (0, 0);
    for (_, d) in edges {
        n += d;
        peak = peak.max(n);
    }
    peak
}

/// Two or more ready plan items of a project waited at the same time while their work could have started: work
/// that could have run side by side ran one after another.
pub(super) fn slots_underused(input: &RuleInput, out: &mut Vec<Candidate>) {
    let running = peak_running(input);
    let lead = lead_runs_by_project(input);
    for (project, items) in ready_by_project(input) {
        let (both, _) = side_by_side(items.iter().map(|r| (r.from_ms, r.to_ms)));
        let free = minus(&both, &blocked(input, project));
        let sum = len(&free);
        if sum == 0 {
            continue;
        }
        let (_, peak) = side_by_side(
            items
                .iter()
                .flat_map(|r| clip(&free, r.from_ms, r.to_ms).collect::<Vec<_>>()),
        );
        let n_items = items
            .iter()
            .filter(|r| clip_len(&free, r.from_ms, r.to_ms) > 0)
            .map(|r| r.item_id.as_str())
            .collect::<BTreeSet<_>>()
            .len();
        out.push(Candidate {
            rule: InsightRule::SlotsUnderused,
            key: project.to_owned(),
            fired: sum >= UNDERUSED_MIN,
            message: format!(
                "up to {peak} ready plan items of {} waited side by side for {} while slots were free (at most {} ran at once): spawn ready items together instead of one after another",
                short(title(input, project)),
                fmt_dur(sum),
                plural(running.max(0) as usize, "session", "sessions")
            ),
            numbers: vec![
                ("side_by_side_ms", sum),
                ("peak_ready", peak),
                ("items", n_items as i64),
                ("peak_running", running),
            ],
            spans: lead
                .get(project)
                .map(|runs| runs_before(runs, &free))
                .unwrap_or_default(),
            weight: sum,
        });
    }
}

// The serial facts a period reads, from the hub's rows.

fn json_ms(v: Option<String>) -> Option<i64> {
    v.as_deref().and_then(super::parse_ms)
}

/// Spells of one kind of hub span, found by their key prefix (`slots/`, `task/`) on the `(src, src_key)` index.
fn hub_spells(
    c: &Connection,
    prefix: &str,
    kind: SpanKind,
    since: i64,
    until: i64,
) -> Result<Vec<Iv>, StoreError> {
    let mut stmt = c.prepare_cached(
        "SELECT start_ms, COALESCE(end_ms, ?4) FROM time_spans
         WHERE src = 'h' AND src_key >= ?1 AND src_key < ?5 AND kind = ?2
           AND start_ms < ?4 AND COALESCE(end_ms, ?4) > ?3",
    )?;
    let (lo, hi) = (format!("{prefix}/"), format!("{prefix}0"));
    let rows = stmt.query_map(params![lo, kind.code(), since, until, hi], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    })?;
    Ok(merge(rows.collect::<Result<_, _>>()?))
}

/// Per machine: when it was parked on a usage limit (`park.usage`, `queue.usage`) or offline (`wait.offline`,
/// `queue.offline`). All are hub spans, found by key prefix.
fn machine_blocked(
    c: &Connection,
    since: i64,
    until: i64,
) -> Result<HashMap<String, Vec<Iv>>, StoreError> {
    let mut stmt = c.prepare_cached(
        "SELECT machine_id, start_ms, COALESCE(end_ms, ?4) FROM time_spans
         WHERE src = 'h' AND src_key >= ?1 AND src_key < ?5 AND kind IN (?2, ?6)
           AND machine_id IS NOT NULL AND start_ms < ?4 AND COALESCE(end_ms, ?4) > ?3",
    )?;
    let mut by: HashMap<String, Vec<Iv>> = HashMap::new();
    for (prefix, kinds) in [
        ("park", [SpanKind::ParkUsage, SpanKind::ParkUsage]),
        ("task", [SpanKind::QueueUsage, SpanKind::QueueOffline]),
        ("write", [SpanKind::WaitOffline, SpanKind::WaitOffline]),
    ] {
        let (lo, hi) = (format!("{prefix}/"), format!("{prefix}0"));
        let rows = stmt.query_map(
            params![lo, kinds[0].code(), since, until, hi, kinds[1].code()],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )?;
        for row in rows {
            let (m, s, e) = row?;
            by.entry(m).or_default().push((s, e));
        }
    }
    Ok(by.into_iter().map(|(m, v)| (m, merge(v))).collect())
}

fn in_scope(scope: &TimeScope, item: &ItemRow) -> bool {
    match scope {
        TimeScope::Fleet => true,
        TimeScope::Machine { machine_id } => item
            .pkey
            .split_once('/')
            .is_some_and(|(m, _)| m == machine_id.as_str()),
        TimeScope::Project { project_ref } | TimeScope::Lead { project_ref } => {
            item.pkey == plan_store::pkey(project_ref)
        }
        TimeScope::Order { workstream_id } => {
            item.workstream_id.as_deref() == Some(workstream_id.as_str())
        }
        TimeScope::Task { .. } | TimeScope::Thread { .. } => false,
    }
}

/// When each order ran: from `workstream.running` (its brief frozen) or a state of running or converging, until a
/// state that isn't (verifying, idle, stopped, failed) or `workstream.done`. A spell still open runs to the end.
fn order_spells(c: &Connection) -> Result<HashMap<String, Vec<Iv>>, StoreError> {
    let mut stmt = c.prepare_cached(
        "SELECT created_ms, type, json_extract(data, '$.data.workstreamId'), json_extract(data, '$.data.state')
         FROM events WHERE type IN ('workstream.running', 'workstream.state', 'workstream.done') ORDER BY seq",
    )?;
    let mut open: HashMap<String, i64> = HashMap::new();
    let mut out: HashMap<String, Vec<Iv>> = HashMap::new();
    for row in stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })? {
        let (at, ty, ws, state) = row?;
        let Some(ws) = ws else { continue };
        let runs = match ty.as_str() {
            "workstream.running" => true,
            "workstream.state" => matches!(state.as_deref(), Some("running" | "converging")),
            _ => false,
        };
        match (runs, open.get(&ws).copied()) {
            (true, None) => {
                open.insert(ws, at);
            }
            (false, Some(from)) => {
                open.remove(&ws);
                out.entry(ws).or_default().push((from, at));
            }
            _ => {}
        }
    }
    for (ws, from) in open {
        out.entry(ws).or_default().push((from, i64::MAX));
    }
    Ok(out.into_iter().map(|(w, v)| (w, merge(v))).collect())
}

/// When each item first had a task spawned for it (`itemId`, or listed in the item's links).
fn spawned(c: &Connection, ws: &str) -> Result<HashMap<String, i64>, StoreError> {
    let mut out: HashMap<String, i64> = HashMap::new();
    let mut stmt = c.prepare_cached(
        "SELECT 'T' || n, json_extract(data, '$.itemId'), json_extract(data, '$.createdAt') FROM tasks
         WHERE workstream_id = ?1",
    )?;
    for row in stmt.query_map([ws], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })? {
        let (task, item, created) = row?;
        let Some(at) = json_ms(created) else { continue };
        for key in [Some(task), item].into_iter().flatten() {
            let e = out.entry(key).or_insert(at);
            *e = (*e).min(at);
        }
    }
    Ok(out)
}

/// An order's blocking asks over the period, merged: read once per order.
fn blocking_asks(c: &Connection, ws: &str, since: i64, until: i64) -> Result<Vec<Iv>, StoreError> {
    let mut stmt = c.prepare_cached(
        "SELECT start_ms, COALESCE(end_ms, ?3) FROM time_spans
         WHERE workstream_id = ?1 AND start_ms < ?3 AND kind = ?4 AND COALESCE(end_ms, ?3) > ?2",
    )?;
    let rows = stmt.query_map(params![ws, since, until, SpanKind::WaitAsk.code()], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    })?;
    Ok(merge(rows.collect::<Result<_, _>>()?))
}

/// The ready stretches of the scope's plan items within `[since, until)`. An item counts only while its order ran
/// (not stopped, failed, idle or verifying), once it existed and every item it is `after` was done, until a task was
/// spawned for it; a blocking ask on its order pauses it. Items with a dropped dependency, or no known start, are left out rather than guessed.
fn ready(
    c: &Connection,
    scope: &TimeScope,
    since: i64,
    until: i64,
) -> Result<Vec<Ready>, StoreError> {
    if matches!(scope, TimeScope::Task { .. } | TimeScope::Thread { .. }) {
        return Ok(Vec::new());
    }
    let items = plan_store::items_live(c, since)?;
    let by_n: HashMap<i64, &ItemRow> = items.iter().map(|i| (i.n, i)).collect();
    let first_items: HashMap<i64, Option<i64>> = plan_store::milestones_all(c)?
        .into_iter()
        .map(|m| (m.n, m.first_item_ms))
        .collect();
    let spells = order_spells(c)?;
    let mut tasks: HashMap<String, HashMap<String, i64>> = HashMap::new();
    let mut asks: HashMap<String, Vec<Iv>> = HashMap::new();
    let mut out = Vec::new();
    for item in items.iter().filter(|i| in_scope(scope, i)) {
        use fleetd_contracts::plan::PlanItemState;
        if item.state == PlanItemState::Dropped {
            continue;
        }
        let Some(ws) = item.workstream_id.as_deref() else {
            continue;
        };
        let Some(ran) = spells.get(ws) else {
            continue;
        };
        let Some(created) = item
            .data
            .created_ms
            .or_else(|| first_items.get(&item.milestone).copied().flatten())
        else {
            continue;
        };
        let mut deps_done = Some(i64::MIN);
        for a in &item.data.after {
            let dep = match by_n.get(a) {
                Some(d) => Some((*d).clone()),
                None => plan_store::item_get(c, *a)?,
            };
            deps_done = match (deps_done, dep) {
                (Some(t), Some(d)) if d.state != PlanItemState::Dropped => {
                    d.done_ms.map(|done| t.max(done))
                }
                _ => None,
            };
        }
        let Some(deps_done) = deps_done else { continue };
        if !tasks.contains_key(ws) {
            tasks.insert(ws.to_owned(), spawned(c, ws)?);
        }
        let spawned = &tasks[ws];
        let first_task = item
            .data
            .links
            .tasks
            .iter()
            .filter_map(|t| spawned.get(t.as_str()))
            .chain(spawned.get(&format!("P{}", item.n)))
            .min()
            .copied();
        let from = created.max(deps_done).max(since);
        let to = [first_task, item.started_ms, item.done_ms, Some(until)]
            .into_iter()
            .flatten()
            .min()
            .unwrap_or(until);
        if to <= from {
            continue;
        }
        if !asks.contains_key(ws) {
            asks.insert(ws.to_owned(), blocking_asks(c, ws, since, until)?);
        }
        let running: Vec<Iv> = clip(ran, from, to).collect();
        for (s, e) in minus(&running, &asks[ws]) {
            out.push(Ready {
                project: item.pkey.clone(),
                workstream_id: ws.to_owned(),
                item_id: format!("P{}", item.n),
                title: item.data.title.clone(),
                from_ms: s,
                to_ms: e,
            });
        }
    }
    Ok(out)
}

/// The runs of `project`'s lead sessions (its current one and every one a wake reached) overlapping the period.
fn lead_runs(
    c: &Connection,
    project: &str,
    since: i64,
    until: i64,
) -> Result<Vec<LeadRun>, StoreError> {
    let (m, p) = project.split_once('/').unwrap_or((project, ""));
    let mut stmt = c.prepare_cached(
        "SELECT thread_id FROM leads WHERE machine_id = ?1 AND project_id = ?2
         UNION SELECT DISTINCT w.thread_id FROM time_wakes w JOIN threads t
           ON t.machine_id = w.machine_id AND t.thread_id = w.thread_id
         WHERE w.machine_id = ?1 AND t.project_id = ?2",
    )?;
    let threads: Vec<String> = stmt
        .query_map(params![m, p], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    let mut stmt = c.prepare_cached(
        "SELECT id, start_ms, COALESCE(end_ms, ?4) FROM time_spans
         WHERE machine_id = ?1 AND thread_id = ?2 AND start_ms >= ?3 AND start_ms < ?4
           AND kind = ?5 AND role = 'lead' AND COALESCE(end_ms, ?4) > ?6",
    )?;
    for t in threads {
        let rows = stmt.query_map(
            params![
                m,
                t,
                since - super::store::DAY,
                until,
                SpanKind::Run.code(),
                since
            ],
            |r| {
                Ok(LeadRun {
                    project: project.to_owned(),
                    span_id: r.get(0)?,
                    start_ms: r.get(1)?,
                    end_ms: r.get(2)?,
                })
            },
        )?;
        out.extend(rows.collect::<Result<Vec<_>, _>>()?);
    }
    Ok(out)
}

/// The serial facts of `scope` over `[since, until)`, with the train's batching as it runs now.
pub fn load(
    c: &Connection,
    scope: &TimeScope,
    since: i64,
    until: i64,
    batching: Batching,
) -> Result<Serial, StoreError> {
    let ready = ready(c, scope, since, until)?;
    let projects: BTreeSet<&str> = ready.iter().map(|r| r.project.as_str()).collect();
    let mut lead = Vec::new();
    for p in &projects {
        lead.extend(lead_runs(c, p, since, until)?);
    }
    let mut titles = HashMap::new();
    let mut stmt = c.prepare_cached(
        "SELECT machine_id || '/' || project_id, json_extract(data, '$.title') FROM projects",
    )?;
    for row in stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })? {
        if let (k, Some(t)) = row? {
            titles.insert(k, t);
        }
    }
    Ok(Serial {
        slots_full: hub_spells(c, "slots", SpanKind::SlotsFull, since, until)?,
        slot_queued: hub_spells(c, "task", SpanKind::QueueSlot, since, until)?,
        machine_blocked: machine_blocked(c, since, until)?,
        batching,
        ready,
        lead_runs: lead,
        project_titles: titles,
    })
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::plan::{PlanItemState, Size, Weight};
    use fleetd_contracts::prim::Text;
    use fleetd_contracts::time::{Insight, SpanExtra};

    use super::*;
    use crate::hub::plan::store::ItemData;
    use crate::hub::store::HubDb;
    use crate::hub::time::rules::insights;
    use crate::hub::time::store::{Ids, NewSpan, write};

    const P: &str = "devbox/p1";

    fn row(id: i64, kind: SpanKind, lane: &str, start: i64, end: i64) -> Row {
        Row {
            id,
            kind,
            start_ms: start,
            end_ms: end,
            lane: lane.into(),
            machine_id: Some("devbox".into()),
            project_id: Some("p1".into()),
            ..Row::default()
        }
    }

    fn queued(id: i64, kind: SpanKind, task: &str, start: i64, end: i64, why: &str) -> Row {
        Row {
            task_id: Some(task.into()),
            extra: SpanExtra {
                reason: Some(Text::unchecked(why)),
                ..SpanExtra::default()
            },
            ..row(id, kind, &format!("task:{task}"), start, end)
        }
    }

    fn ready(item: &str, from: i64, to: i64) -> Ready {
        Ready {
            project: P.into(),
            workstream_id: "W1".into(),
            item_id: item.into(),
            title: format!("{item} title"),
            from_ms: from * MIN,
            to_ms: to * MIN,
        }
    }

    fn lead(id: i64, from: i64, to: i64) -> LeadRun {
        LeadRun {
            project: P.into(),
            span_id: id,
            start_ms: from * MIN,
            end_ms: to * MIN,
        }
    }

    fn input(rows: Vec<Row>, serial: Serial) -> RuleInput {
        let mut serial = serial;
        serial.project_titles.insert(P.into(), "storefront".into());
        RuleInput {
            since_ms: 0,
            until_ms: 1_000 * MIN,
            rows,
            serial,
            ..RuleInput::default()
        }
    }

    fn fired(input: &RuleInput, rule: InsightRule) -> Vec<Insight> {
        insights(input)
            .into_iter()
            .filter(|i| i.rule == rule)
            .collect()
    }

    fn num(i: &Insight, name: &str) -> i64 {
        i.numbers
            .iter()
            .find(|n| n.name.as_str() == name)
            .unwrap()
            .value
            .get()
    }

    #[test]
    fn intervals() {
        assert_eq!(
            merge(vec![(5, 9), (0, 2), (1, 3), (9, 9)]),
            vec![(0, 3), (5, 9)]
        );
        assert_eq!(
            minus(&[(0, 10), (20, 30)], &[(2, 4), (8, 22)]),
            vec![(0, 2), (4, 8), (22, 30)]
        );
        // One b interval spanning two of a, and one a interval cut by several b.
        assert_eq!(
            minus(
                &[(0, 5), (6, 10), (12, 20)],
                &[(4, 7), (13, 14), (15, 16), (19, 30)]
            ),
            vec![(0, 4), (7, 10), (12, 13), (14, 15), (16, 19)]
        );
        assert_eq!(
            clip(&[(0, 10), (20, 30), (40, 50)], 5, 25).collect::<Vec<_>>(),
            vec![(5, 10), (20, 25)]
        );
        assert_eq!(clip_len(&[(0, 10), (20, 30)], 10, 20), 0);
    }

    /// A slot wait counts only while the fleet had a free slot: inside a `slots.full` spell it is the cap's.
    #[test]
    fn a_slot_wait_with_free_slots_names_the_share() {
        let why = "agents: 3/3 running";
        let full = Serial {
            slots_full: vec![(0, 4 * MIN)],
            ..Serial::default()
        };
        let rows = vec![queued(1, SpanKind::QueueSlot, "T4", 0, 8 * MIN, why)];
        let found = fired(&input(rows.clone(), full.clone()), InsightRule::QueueWait);
        assert!(found.is_empty(), "4m with free slots is under the bar");
        let rows = vec![
            queued(1, SpanKind::QueueSlot, "T4", 0, 8 * MIN, why),
            queued(2, SpanKind::QueueSlot, "T5", 10 * MIN, 12 * MIN, why),
        ];
        let found = fired(&input(rows, full), InsightRule::QueueWait);
        assert_eq!(
            found[0].message.as_str(),
            "2 tasks in storefront waited 6m for a slot while the fleet had free ones (agents: 3/3 running): raise the project's max agents with cap_set"
        );
        assert_eq!(num(&found[0], "total_ms"), 6 * MIN);
    }

    fn batching(max: i64, off: &[(&str, &str)]) -> Serial {
        Serial {
            batching: Batching {
                max,
                off: off
                    .iter()
                    .map(|(r, w)| (r.to_string(), w.to_string()))
                    .collect(),
            },
            ..Serial::default()
        }
    }

    /// #1 and #2 go as one batch (one run, 2–8m); #3 and #4, ready since 1m, wait it out and go together next. #5
    /// turned ready after that run started, so no batch could have taken it.
    fn train_rows() -> Vec<Row> {
        let lane = |n: i64| format!("change:acme/web#{n}");
        let mut rows = Vec::new();
        for (n, ready_from, run) in [(1, 0, 2), (2, 0, 2), (3, 1, 8), (4, 1, 8), (5, 3, 8)] {
            rows.push(row(
                n * 10,
                SpanKind::ChangeQueue,
                &lane(n),
                ready_from * MIN,
                run * MIN,
            ));
            rows.push(row(
                n * 10 + 1,
                SpanKind::ChangeCi,
                &lane(n),
                run * MIN,
                (run + 4) * MIN,
            ));
            rows.push(row(
                n * 10 + 2,
                SpanKind::ChangeMerge,
                &lane(n),
                (run + 4) * MIN,
                (run + 6) * MIN,
            ));
        }
        rows
    }

    /// A batch is one run however many PRs it holds, and the fix names the limit that kept the PRs out.
    #[test]
    fn ready_prs_kept_out_of_a_full_run_name_the_batch_limit() {
        let found = fired(
            &input(train_rows(), batching(2, &[])),
            InsightRule::QueueWait,
        );
        assert_eq!(
            found[0].message.as_str(),
            "2 ready PRs in the `acme/web` train waited 12m through 1 CI run already holding the batch limit of 2 PRs: raise FLEETD_TRAIN_BATCH_MAX (now 2)"
        );
        assert_eq!((num(&found[0], "prs"), num(&found[0], "runs")), (2, 1));
        let one = fired(
            &input(train_rows(), batching(1, &[])),
            InsightRule::QueueWait,
        );
        assert!(
            one[0]
                .message
                .as_str()
                .contains("through 1 CI run of one PR each, with FLEETD_TRAIN_BATCH_MAX=1: raise")
        );
        let off = fired(
            &input(
                train_rows(),
                batching(4, &[("Acme/Web", "batch PR refused: 405")]),
            ),
            InsightRule::QueueWait,
        );
        assert!(off[0].message.as_str().contains(
            "with batching off for this repo (batch PR refused: 405): fix what GitHub refused, then restart the hub"
        ));
    }

    /// A run under the limit left the PRs out for their own reasons (overlapping files, red alone, a bisect):
    /// batching would not have helped, so nothing is said.
    #[test]
    fn prs_left_out_of_a_run_with_room_are_not_a_batching_finding() {
        let i = input(train_rows(), batching(4, &[]));
        assert!(
            super::super::rules::evaluate(&i)
                .iter()
                .all(|(f, _)| f.rule != InsightRule::QueueWait)
        );
    }

    #[test]
    fn tasks_serialized_on_one_area_name_the_policy_fix() {
        let why = "lease: all held by T4";
        let short_wait = vec![queued(1, SpanKind::QueueLease, "T5", 0, 72_000, why)];
        assert!(
            fired(
                &input(short_wait, Serial::default()),
                InsightRule::Contention
            )
            .is_empty()
        );
        let rows = vec![
            queued(1, SpanKind::QueueLease, "T5", 0, 3 * MIN, why),
            queued(
                2,
                SpanKind::QueueLease,
                "T6",
                3 * MIN,
                6 * MIN,
                "lease: all held by T5, lab held by T2",
            ),
        ];
        let found = fired(&input(rows, Serial::default()), InsightRule::Contention);
        assert_eq!(found.len(), 1, "lab waited 3m only");
        assert_eq!(
            found[0].message.as_str(),
            "2 tasks in storefront waited 6m for area `all`, held by T4, T5: define areas in .fleetd/policy.yaml so tasks that write different paths run side by side"
        );
        let usage = vec![
            queued(
                1,
                SpanKind::QueueUsage,
                "T7",
                0,
                4 * MIN,
                "usage: five_hour",
            ),
            queued(
                2,
                SpanKind::QueueUsage,
                "T8",
                0,
                2 * MIN,
                "usage: five_hour",
            ),
        ];
        let found = fired(&input(usage, Serial::default()), InsightRule::Contention);
        assert!(
            found[0]
                .message
                .as_str()
                .starts_with("2 tasks waited 6m for claude usage on devbox")
        );
    }

    /// Idle counts only with the lead not running, a slot free, and the stretch past the wake's own delay.
    #[test]
    fn an_idle_lead_with_a_ready_item_and_free_slots() {
        let serial = Serial {
            ready: vec![ready("P3", 10, 30)],
            lead_runs: vec![lead(7, 0, 12), lead(8, 20, 21), lead(9, 30, 31)],
            slots_full: vec![(25 * MIN, 27 * MIN)],
            slot_queued: vec![(14 * MIN, 14 * MIN + 30_000), (27 * MIN, 27 * MIN + 10_000)],
            ..Serial::default()
        };
        let found = fired(&input(Vec::new(), serial.clone()), InsightRule::IdleLead);
        // 12–14 (2m), 14:30–20 (5m30s), 21–25 (4m), 27:10–30 (2m50s).
        assert_eq!(num(&found[0], "idle_ms"), 14 * MIN + 20_000);
        assert_eq!(num(&found[0], "stretches"), 4);
        assert_eq!(
            found[0].message.as_str(),
            "the lead of storefront was idle 14m while P3 `P3 title` was ready to start and slots were free: spawn ready plan items before the lead's turn ends"
        );
        assert_eq!(
            found[0]
                .span_ids
                .iter()
                .map(|c| c.get())
                .collect::<Vec<_>>(),
            vec![7, 8],
            "the turns that ended with the item ready"
        );
        let busy = Serial {
            lead_runs: vec![lead(7, 0, 40)],
            ..serial.clone()
        };
        assert!(fired(&input(Vec::new(), busy), InsightRule::IdleLead).is_empty());
        let full = Serial {
            slots_full: vec![(0, 40 * MIN)],
            ..serial.clone()
        };
        assert!(fired(&input(Vec::new(), full), InsightRule::IdleLead).is_empty());
        let parked = |machine: &str| Serial {
            machine_blocked: HashMap::from([(machine.to_owned(), vec![(0, 40 * MIN)])]),
            ..serial.clone()
        };
        assert!(
            fired(&input(Vec::new(), parked("devbox")), InsightRule::IdleLead).is_empty(),
            "parked on usage or offline: the lead could not run"
        );
        assert_eq!(
            fired(&input(Vec::new(), parked("other")), InsightRule::IdleLead).len(),
            1
        );
        let unseen = Serial {
            lead_runs: Vec::new(),
            ..serial
        };
        assert!(
            fired(&input(Vec::new(), unseen), InsightRule::IdleLead).is_empty(),
            "no lead spans: idle is not known"
        );
    }

    #[test]
    fn ready_items_side_by_side_with_free_slots() {
        let runs = vec![Row {
            role: Some("lead".into()),
            ..row(1, SpanKind::Run, "thread:devbox/l", 0, 30 * MIN)
        }];
        let serial = Serial {
            // P2 ends as P3 starts: P1 overlaps both, so 5–20 has two ready at once.
            ready: vec![ready("P1", 0, 20), ready("P2", 5, 15), ready("P3", 15, 30)],
            lead_runs: vec![lead(1, 0, 30)],
            slots_full: vec![(18 * MIN, 19 * MIN)],
            ..Serial::default()
        };
        let found = fired(&input(runs, serial.clone()), InsightRule::SlotsUnderused);
        assert_eq!(num(&found[0], "side_by_side_ms"), 14 * MIN);
        assert_eq!(num(&found[0], "peak_ready"), 2);
        assert_eq!(
            found[0].message.as_str(),
            "up to 2 ready plan items of storefront waited side by side for 14m while slots were free (at most 1 session ran at once): spawn ready items together instead of one after another"
        );
        assert!(
            fired(&input(Vec::new(), serial), InsightRule::IdleLead).is_empty(),
            "the lead ran throughout"
        );
        let one_after_another = Serial {
            ready: vec![ready("P1", 0, 10), ready("P2", 10, 30)],
            ..Serial::default()
        };
        assert!(
            fired(
                &input(Vec::new(), one_after_another),
                InsightRule::SlotsUnderused
            )
            .is_empty()
        );
    }

    fn item(
        c: &Connection,
        ws: &str,
        after: Vec<i64>,
        state: PlanItemState,
        done: Option<i64>,
    ) -> i64 {
        plan_store::item_insert(
            c,
            &ItemRow {
                n: 0,
                pkey: P.into(),
                milestone: 1,
                workstream_id: Some(ws.into()),
                state,
                weight: Weight::Must,
                size: Size::M,
                position: 0,
                started_ms: None,
                done_ms: done,
                data: ItemData {
                    title: "an item".into(),
                    after,
                    created_ms: Some(0),
                    ..ItemData::default()
                },
            },
        )
        .unwrap()
    }

    fn event(c: &Connection, at: i64, kind: &str, data: serde_json::Value) {
        let body =
            serde_json::json!({ "type": kind, "machineId": "devbox", "data": data }).to_string();
        c.execute(
            "INSERT INTO events (created_ms, type, machine_id, data) VALUES (?1, ?2, 'devbox', ?3)",
            params![at, kind, body],
        )
        .unwrap();
    }

    fn span(key: &str, kind: SpanKind, start: i64, end: i64, ids: Ids, lane: &str) -> NewSpan {
        NewSpan {
            src: "h".into(),
            src_key: key.into(),
            kind,
            start_ms: start,
            end_ms: Some(end),
            ids,
            lane: lane.into(),
            ..NewSpan::default()
        }
    }

    /// Ready runs from when the order ran and the item's `after` items were done to its first task; a blocking ask
    /// pauses it, and an item behind a dropped one is left out.
    #[test]
    fn ready_stretches_come_from_the_plan_tasks_and_asks() {
        let db = HubDb::open_memory().unwrap();
        db.transaction(|c| {
            plan_store::milestone_insert(c, P, "M1", None, 0)?;
            event(c, 2 * MIN, "workstream.running", serde_json::json!({ "workstreamId": "W1" }));
            let p1 = item(c, "W1", vec![], PlanItemState::Done, Some(10 * MIN));
            let p2 = item(c, "W1", vec![p1], PlanItemState::Open, None);
            let gone = item(c, "W1", vec![], PlanItemState::Dropped, None);
            item(c, "W1", vec![gone], PlanItemState::Open, None);
            c.execute(
                "INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES ('devbox', 'p1', 'W1', 'running', ?1)",
                [serde_json::json!({ "itemId": format!("P{p2}"), "createdAt": "1970-01-01T00:25:00.000Z" }).to_string()],
            )?;
            c.execute(
                "INSERT INTO tasks (machine_id, project_id, workstream_id, state, data) VALUES ('devbox', 'p1', 'W1', 'done', ?1)",
                [serde_json::json!({ "itemId": format!("P{p1}"), "createdAt": "1970-01-01T00:03:00.000Z" }).to_string()],
            )?;
            let ask = Ids {
                workstream_id: Some("W1".into()),
                ..Ids::default()
            };
            write(c, &span("ask/A1", SpanKind::WaitAsk, 12 * MIN, 15 * MIN, ask, "asks:W1"), &[])?;
            c.execute(
                "INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'p1', 'lead-1', '', 0)",
                [],
            )?;
            let lead_ids = Ids {
                machine_id: Some("devbox".into()),
                project_id: Some("p1".into()),
                thread_id: Some("lead-1".into()),
                role: Some("lead".into()),
                ..Ids::default()
            };
            write(c, &span("n/run1", SpanKind::Run, 9 * MIN, 11 * MIN, lead_ids, "thread:devbox/lead-1"), &[])?;
            write(c, &span("slots/600000", SpanKind::SlotsFull, 30 * MIN, 31 * MIN, Ids::default(), "fleet"), &[])?;

            // W2 ran 2–20m, was stopped, and resumed at 40m: its open item is ready only while it ran.
            event(c, 2 * MIN, "workstream.running", serde_json::json!({ "workstreamId": "W2" }));
            event(c, 20 * MIN, "workstream.state", serde_json::json!({ "workstreamId": "W2", "state": "stopped" }));
            event(c, 40 * MIN, "workstream.state", serde_json::json!({ "workstreamId": "W2", "state": "running" }));
            let p5 = item(c, "W2", vec![], PlanItemState::Open, None);
            let park = Ids {
                machine_id: Some("devbox".into()),
                ..Ids::default()
            };
            write(c, &span("park/devbox/t/9", SpanKind::ParkUsage, 5 * MIN, 9 * MIN, park, "thread:devbox/t"), &[])?;

            let s = load(c, &TimeScope::Fleet, 0, 60 * MIN, Batching::default())?;
            let got: Vec<(String, i64, i64)> = s
                .ready
                .iter()
                .map(|r| (r.item_id.clone(), r.from_ms / MIN, r.to_ms / MIN))
                .collect();
            assert_eq!(
                got,
                vec![
                    (format!("P{p1}"), 2, 3),
                    (format!("P{p2}"), 10, 12),
                    (format!("P{p2}"), 15, 25),
                    (format!("P{p5}"), 2, 20),
                    (format!("P{p5}"), 40, 60),
                ]
            );
            assert_eq!(s.machine_blocked["devbox"], vec![(5 * MIN, 9 * MIN)]);
            assert_eq!(s.lead_runs.len(), 1);
            assert_eq!(s.slots_full, vec![(30 * MIN, 31 * MIN)]);
            let task_scope = TimeScope::Task {
                task_id: fleetd_contracts::tasks::TaskId::unchecked("T1"),
            };
            assert!(load(c, &task_scope, 0, 60 * MIN, Batching::default())?.ready.is_empty());
            Ok(())
        })
        .unwrap();
    }
}
