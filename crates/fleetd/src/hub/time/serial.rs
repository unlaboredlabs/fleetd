//! The serial-wait rules: work that waited while capacity existed. Each finding names the fix. Every number is
//! measured from recorded spans and the hub's own rows (when a plan item became ready, when its task was spawned);
//! nothing here estimates. Whether a slot was free is read fleet-wide (`slots.full` spells and every `queue.slot`
//! wait), whatever the scope.
use std::collections::{BTreeMap, BTreeSet, HashMap};

use fleetd_contracts::time::{InsightRule, SpanKind, TimeScope};
use rusqlite::{Connection, params};

use super::model::{LeadRun, Ready, Row, RuleInput, Serial};
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

/// Sorted, non-overlapping, non-empty.
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

/// `a` minus `b`, both merged.
fn minus(a: &[Iv], b: &[Iv]) -> Vec<Iv> {
    let mut out = Vec::new();
    for &(s, e) in a {
        let mut cur = s;
        for &(bs, be) in b {
            if be <= cur || bs >= e {
                continue;
            }
            if bs > cur {
                out.push((cur, bs));
            }
            cur = cur.max(be);
            if cur >= e {
                break;
            }
        }
        if cur < e {
            out.push((cur, e));
        }
    }
    out
}

fn intersect(a: &[Iv], b: &[Iv]) -> Vec<Iv> {
    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        let (s, e) = (a[i].0.max(b[j].0), a[i].1.min(b[j].1));
        if e > s {
            out.push((s, e));
        }
        if a[i].1 < b[j].1 {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
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

/// No slot free for new work: every slot held, or something already queued for one.
fn no_slot(input: &RuleInput) -> Vec<Iv> {
    merge(
        input
            .serial
            .slots_full
            .iter()
            .chain(&input.serial.slot_queued)
            .copied()
            .collect(),
    )
}

fn repo_of(lane: &str) -> &str {
    let lane = lane.strip_prefix("change:").unwrap_or(lane);
    lane.split('#').next().unwrap_or(lane)
}

/// Tasks queued for a slot while the fleet had free ones (a project share or the lead band held them), and PRs
/// that waited in the train's line while another PR's cycle (rebase, CI, merge) ran.
pub(super) fn queue_wait(input: &RuleInput, out: &mut Vec<Candidate>) {
    let full = merge(input.serial.slots_full.clone());
    let mut by_project: BTreeMap<String, Vec<(&Row, i64)>> = BTreeMap::new();
    for r in input.rows.iter().filter(|r| r.kind == SpanKind::QueueSlot) {
        let free = len(&minus(&[(r.start_ms, r.end_ms)], &full));
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
            Some(w) if w.contains("project share") => "raise the project's slot share with cap_set",
            Some(w) if w.contains("reserved") => {
                "raise the cap with cap_set: the last slots of the cap are kept for lead turns"
            }
            _ => "check the cap and the project's share with cap_set",
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

    let mut cycles: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in input.rows.iter().filter(|r| {
        matches!(
            r.kind,
            SpanKind::ChangeRebase | SpanKind::ChangeCi | SpanKind::ChangeMerge
        )
    }) {
        cycles.entry(repo_of(&r.lane)).or_default().push(r);
    }
    // repo -> (the PR's wait, how long it overlapped other PRs' cycles, how many PRs those were).
    let mut by_repo: BTreeMap<&str, Vec<(&Row, i64, usize)>> = BTreeMap::new();
    for q in input
        .rows
        .iter()
        .filter(|r| r.kind == SpanKind::ChangeQueue)
    {
        let repo = repo_of(&q.lane);
        let others: Vec<&Row> = cycles
            .get(repo)
            .into_iter()
            .flatten()
            .filter(|c| c.lane != q.lane && c.start_ms < q.end_ms && c.end_ms > q.start_ms)
            .copied()
            .collect();
        let busy = merge(others.iter().map(|c| (c.start_ms, c.end_ms)).collect());
        let waited = len(&intersect(&[(q.start_ms, q.end_ms)], &busy));
        if waited > 0 {
            let ahead: BTreeSet<&str> = others.iter().map(|c| c.lane.as_str()).collect();
            by_repo
                .entry(repo)
                .or_default()
                .push((q, waited, ahead.len()));
        }
    }
    for (repo, waits) in by_repo {
        let sum: i64 = waits.iter().map(|(_, ms, _)| ms).sum();
        let prs: BTreeSet<&str> = waits.iter().map(|(q, _, _)| q.lane.as_str()).collect();
        let cycles: usize = waits.iter().map(|(_, _, ahead)| ahead).sum();
        out.push(Candidate {
            rule: InsightRule::QueueWait,
            key: format!("train:{repo}"),
            fired: sum >= QUEUE_WAIT_MIN,
            message: format!(
                "{} in the `{}` train waited out {} of other PRs ({}): batch disjoint green PRs so they merge in one CI run",
                plural(prs.len(), "PR", "PRs"),
                short(repo),
                plural(cycles, "train cycle", "train cycles"),
                fmt_dur(sum)
            ),
            numbers: vec![
                ("prs", prs.len() as i64),
                ("cycles", cycles as i64),
                ("total_ms", sum),
            ],
            spans: spans(waits.iter().map(|(q, _, _)| *q)),
            weight: sum,
        });
    }
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

fn lead_busy(input: &RuleInput, project: &str) -> Vec<Iv> {
    merge(
        input
            .serial
            .lead_runs
            .iter()
            .filter(|r| r.project == project)
            .map(|r| (r.start_ms, r.end_ms))
            .collect(),
    )
}

/// The lead runs that ended last before each stretch starts, or ran during it: the turns that left ready work.
fn runs_before(input: &RuleInput, project: &str, stretches: &[Iv]) -> Vec<(i64, i64)> {
    let runs: Vec<&LeadRun> = input
        .serial
        .lead_runs
        .iter()
        .filter(|r| r.project == project)
        .collect();
    let mut out = BTreeSet::new();
    for &(s, e) in stretches {
        if let Some(r) = runs
            .iter()
            .filter(|r| r.end_ms <= s)
            .max_by_key(|r| (r.end_ms, r.span_id))
        {
            out.insert((r.start_ms, r.span_id));
        }
        for r in runs.iter().filter(|r| r.start_ms < e && r.end_ms > s) {
            out.insert((r.start_ms, r.span_id));
        }
    }
    out.into_iter().collect()
}

/// A project's lead was not running while one of its orders had a plan item ready to start and a slot was free.
/// A lead with no runs in the period is left out: its node sent no spans (an older fleetd), so idle is not known.
pub(super) fn idle_lead(input: &RuleInput, out: &mut Vec<Candidate>) {
    let no_slot = no_slot(input);
    for (project, items) in ready_by_project(input) {
        let busy = lead_busy(input, project);
        if busy.is_empty() {
            continue;
        }
        let ready = merge(items.iter().map(|r| (r.from_ms, r.to_ms)).collect());
        let idle: Vec<Iv> = minus(&minus(&ready, &busy), &no_slot)
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
                len(&intersect(&[(r.from_ms, r.to_ms)], &idle));
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
            spans: runs_before(input, project, &idle),
            weight: sum,
        });
    }
}

/// The stretches where at least two items were ready at once, and the most ready at once.
fn side_by_side(items: &[&Ready]) -> (Vec<Iv>, i64) {
    let mut edges: Vec<(i64, i64)> = Vec::new();
    for r in items.iter().filter(|r| r.to_ms > r.from_ms) {
        edges.push((r.from_ms, 1));
        edges.push((r.to_ms, -1));
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

/// Two or more ready plan items of a project waited at the same time while slots were free: work that could
/// have run side by side ran one after another.
pub(super) fn slots_underused(input: &RuleInput, out: &mut Vec<Candidate>) {
    let no_slot = no_slot(input);
    let running = peak_running(input);
    for (project, items) in ready_by_project(input) {
        let (both, _) = side_by_side(&items);
        let free = minus(&both, &no_slot);
        let sum = len(&free);
        if sum == 0 {
            continue;
        }
        let in_free: Vec<Ready> = items
            .iter()
            .flat_map(|r| {
                intersect(&[(r.from_ms, r.to_ms)], &free)
                    .into_iter()
                    .map(|(s, e)| Ready {
                        from_ms: s,
                        to_ms: e,
                        ..(*r).clone()
                    })
            })
            .collect();
        let (_, peak) = side_by_side(&in_free.iter().collect::<Vec<_>>());
        let n_items = in_free
            .iter()
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
            spans: runs_before(input, project, &free),
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

/// When each order first ran (its brief approved), and when it ended.
fn order_bounds(c: &Connection) -> Result<HashMap<String, (i64, Option<i64>)>, StoreError> {
    let mut out: HashMap<String, (i64, Option<i64>)> = HashMap::new();
    let mut stmt = c.prepare_cached(
        "SELECT json_extract(data, '$.data.workstreamId'), MIN(created_ms) FROM events
         WHERE type = 'workstream.running' GROUP BY 1",
    )?;
    for row in stmt.query_map([], |r| {
        Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?))
    })? {
        if let (Some(w), at) = row? {
            out.insert(w, (at, None));
        }
    }
    let mut stmt =
        c.prepare_cached("SELECT workstream_id, end_ms FROM time_orders WHERE end_ms IS NOT NULL")?;
    for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (w, end) = row?;
        if let Some(b) = out.get_mut(&w) {
            b.1 = Some(end);
        }
    }
    Ok(out)
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

/// The ready stretches of the scope's plan items within `[since, until)`. An item counts only while its order ran,
/// once it existed and every item it is `after` was done, until a task was spawned for it; a blocking ask on its
/// order pauses it. Items with a dropped dependency, or no known start, are left out rather than guessed.
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
    let bounds = order_bounds(c)?;
    let mut tasks: HashMap<String, HashMap<String, i64>> = HashMap::new();
    let mut out = Vec::new();
    for item in items.iter().filter(|i| in_scope(scope, i)) {
        use fleetd_contracts::plan::PlanItemState;
        if item.state == PlanItemState::Dropped {
            continue;
        }
        let Some(ws) = item.workstream_id.as_deref() else {
            continue;
        };
        let Some(&(running, order_end)) = bounds.get(ws) else {
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
        let from = running.max(created).max(deps_done).max(since);
        let to = [
            first_task,
            item.started_ms,
            item.done_ms,
            order_end,
            Some(until),
        ]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(until);
        if to <= from {
            continue;
        }
        for (s, e) in minus(&[(from, to)], &blocking_asks(c, ws, from, to)?) {
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

pub fn load(
    c: &Connection,
    scope: &TimeScope,
    since: i64,
    until: i64,
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
        assert_eq!(
            intersect(&[(0, 10), (20, 30)], &[(5, 25)]),
            vec![(5, 10), (20, 25)]
        );
    }

    /// A slot wait counts only while the fleet had a free slot: inside a `slots.full` spell it is the cap's.
    #[test]
    fn a_slot_wait_with_free_slots_names_the_share() {
        let why = "slots: project share 3/3 in use";
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
            "2 tasks in storefront waited 6m for a slot while the fleet had free ones (slots: project share 3/3 in use): raise the project's slot share with cap_set"
        );
        assert_eq!(num(&found[0], "total_ms"), 6 * MIN);
    }

    /// The spec's example: PRs that sat in line while other PRs' CI cycles ran, one cycle each or more.
    #[test]
    fn prs_waiting_out_other_cycles_ask_for_batching() {
        let lane = |n: i64| format!("change:acme/web#{n}");
        let rows = vec![
            row(1, SpanKind::ChangeCi, &lane(1), 0, 4 * MIN),
            row(2, SpanKind::ChangeQueue, &lane(2), 0, 4 * MIN),
            row(3, SpanKind::ChangeCi, &lane(2), 4 * MIN, 8 * MIN),
            row(4, SpanKind::ChangeQueue, &lane(3), 0, 8 * MIN),
            row(5, SpanKind::ChangeCi, &lane(3), 8 * MIN, 12 * MIN),
        ];
        let found = fired(&input(rows, Serial::default()), InsightRule::QueueWait);
        assert_eq!(
            found[0].message.as_str(),
            "2 PRs in the `acme/web` train waited out 3 train cycles of other PRs (12m): batch disjoint green PRs so they merge in one CI run"
        );
        assert_eq!((num(&found[0], "prs"), num(&found[0], "cycles")), (2, 3));
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

            let s = load(c, &TimeScope::Fleet, 0, 60 * MIN)?;
            let got: Vec<(String, i64, i64)> = s
                .ready
                .iter()
                .map(|r| (r.item_id.clone(), r.from_ms / MIN, r.to_ms / MIN))
                .collect();
            assert_eq!(
                got,
                vec![(format!("P{p1}"), 2, 3), (format!("P{p2}"), 10, 12), (format!("P{p2}"), 15, 25)]
            );
            assert_eq!(s.lead_runs.len(), 1);
            assert_eq!(s.slots_full, vec![(30 * MIN, 31 * MIN)]);
            let task_scope = TimeScope::Task {
                task_id: fleetd_contracts::tasks::TaskId::unchecked("T1"),
            };
            assert!(load(c, &task_scope, 0, 60 * MIN)?.ready.is_empty());
            Ok(())
        })
        .unwrap();
    }
}
