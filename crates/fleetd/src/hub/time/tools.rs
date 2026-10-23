//! `time_spans`, `time_breakdown`, `time_insights`, `time_retention_set` and `thread_window`. Reads are bounded:
//! at most [`MAX_ROWS`] spans per period are loaded, and a read that hits the bound says so in coverage.
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::{MachineId, ThreadRef, Timestamp};
use fleetd_contracts::mcp::{
    ErrorCode, ThreadWindowInput, ThreadWindowOutput, TimeBreakdownInput, TimeBreakdownOutput,
    TimeInsightsInput, TimeInsightsOutput, TimeRetentionSetInput, TimeRetentionSetOutput,
    TimeSpansInput, TimeSpansOutput,
};
use fleetd_contracts::prim::{Count, Int, List, Text};
use fleetd_contracts::time::{
    Category, CategoryTotal, CiCheckStat, CommandStat, Coverage, CriticalPath, DecidedBy, Gap,
    GapWhy, HumanWait, KindTotal, LongestWait, PeriodBreakdown, RepeatStat, Span, SpanKind,
    TimeScope,
};
use rusqlite::{Connection, OptionalExtension, params};

use super::model::{PathInput, Row, RuleInput, is_detail};
use super::store::{self, Filter, Meta};
use super::{parse_ms, path, rules};
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, allows_everywhere, require};
use crate::hub::store::{StoreError, iso_ms};

/// Spans loaded per period for a breakdown or the rules.
pub const MAX_ROWS: usize = 200_000;
/// Spans of one order read for its critical path.
const PATH_ROWS: usize = 100_000;

pub fn register(tools: &mut Registry) {
    tools.add("time_spans", time_spans);
    tools.add("time_breakdown", time_breakdown);
    tools.add("time_insights", time_insights);
    tools.add("time_retention_set", time_retention_set);
    tools.add("thread_window", thread_window);
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::new(ErrorCode::Invalid, message)
}

fn ms_of(t: &Timestamp) -> Result<i64, ToolError> {
    parse_ms(t.as_str()).ok_or_else(|| invalid(format!("{} is not an ISO time", t.as_str())))
}

fn count(n: i64) -> Count {
    Count::try_from(n.max(0)).unwrap_or_default()
}

/// The machine a scope needs a read grant on; `None` for fleet-wide scopes, which every read key may see filtered.
fn scope_machine(c: &Connection, scope: &TimeScope) -> Result<Option<MachineId>, StoreError> {
    Ok(match scope {
        TimeScope::Fleet => None,
        TimeScope::Machine { machine_id } | TimeScope::Thread { machine_id, .. } => {
            Some(machine_id.clone())
        }
        TimeScope::Project { project_ref } | TimeScope::Lead { project_ref } => {
            Some(project_ref.machine_id.clone())
        }
        TimeScope::Order { workstream_id } => c
            .query_row(
                "SELECT machine_id FROM workstreams WHERE n = ?1",
                [workstream_id.as_str()[1..].parse::<i64>().unwrap_or(-1)],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(MachineId::unchecked),
        TimeScope::Task { task_id } => c
            .query_row(
                "SELECT machine_id FROM tasks WHERE n = ?1",
                [task_id.as_str()[1..].parse::<i64>().unwrap_or(-1)],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .map(MachineId::unchecked),
    })
}

fn check(c: &Connection, caller: &Caller, scope: &TimeScope) -> Result<(), ToolError> {
    match scope_machine(c, scope)? {
        Some(m) => require(caller, Role::Read, Some(&m)),
        None if matches!(scope, TimeScope::Fleet) => {
            if allows_everywhere(caller, Role::Read) {
                Ok(())
            } else {
                Err(ToolError::new(
                    ErrorCode::Forbidden,
                    "The fleet scope needs read on every machine.",
                )
                .with_fix("Ask for a machine, project or order scope instead."))
            }
        }
        None => Err(ToolError::new(ErrorCode::NotFound, "No such work or task.")),
    }
}

fn filter(scope: &TimeScope, since: i64, until: i64) -> Filter {
    let mut f = Filter {
        since_ms: since,
        until_ms: until,
        ..Filter::default()
    };
    match scope {
        TimeScope::Fleet => {}
        TimeScope::Machine { machine_id } => f.machine_id = Some(machine_id.to_string()),
        TimeScope::Project { project_ref } => {
            f.project = Some((
                project_ref.machine_id.to_string(),
                project_ref.project_id.to_string(),
            ))
        }
        TimeScope::Lead { project_ref } => {
            f.lead = Some((
                project_ref.machine_id.to_string(),
                project_ref.project_id.to_string(),
            ))
        }
        TimeScope::Order { workstream_id } => f.workstream_id = Some(workstream_id.to_string()),
        TimeScope::Task { task_id } => f.task_ids = Some(vec![task_id.to_string()]),
        TimeScope::Thread {
            machine_id,
            thread_id,
        } => f.thread = Some((machine_id.to_string(), thread_id.to_string())),
    }
    f
}

/// An order's start (intake submit, else `workstream.created`) and end (`workstream.done`, else none).
pub fn order_bounds(c: &Connection, w: &str) -> Result<Option<(i64, Option<i64>)>, StoreError> {
    let row: Option<(i64, Option<i64>)> = c
        .query_row(
            "SELECT start_ms, end_ms FROM time_orders WHERE workstream_id = ?1",
            [w],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let intake: Option<i64> = c.query_row(
        "SELECT MIN(start_ms) FROM time_spans WHERE workstream_id = ?1 AND kind = ?2",
        params![w, SpanKind::IntakeRoute.code()],
        |r| r.get(0),
    )?;
    Ok(row.map(|(s, e)| (intake.map_or(s, |i| i.min(s)), e)))
}

/// Which lane each lane waits on, for the path's tie-break: a task on the lead that spawned it, a change on its
/// writer, a review on its change.
fn waits_on(c: &Connection, rows: &[Row]) -> Result<HashMap<String, Vec<String>>, StoreError> {
    let mut lead_lanes: Vec<String> = rows
        .iter()
        .filter(|r| {
            r.lane.starts_with("thread:") && r.task_id.is_none() && r.workstream_id.is_none()
        })
        .map(|r| r.lane.clone())
        .collect();
    lead_lanes.sort();
    lead_lanes.dedup();
    let mut task_lanes: HashMap<String, String> = HashMap::new();
    for r in rows {
        if let Some(t) = &r.task_id
            && r.lane.starts_with("thread:")
        {
            task_lanes.insert(t.clone(), r.lane.clone());
        }
    }
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for r in rows {
        if out.contains_key(&r.lane) {
            continue;
        }
        let mut on = Vec::new();
        if let Some(t) = &r.task_id {
            let review: Option<(String, String, i64)> = c
                .query_row(
                    "SELECT rt.change_id, ch.repo, ch.pr_number FROM review_tasks rt
                     JOIN changes ch ON 'X' || ch.n = rt.change_id WHERE rt.task_id = ?1",
                    [t],
                    |q| Ok((q.get(0)?, q.get(1)?, q.get(2)?)),
                )
                .optional()?;
            match review {
                Some((_, repo, pr)) => on.push(format!("change:{repo}#{pr}")),
                None => on.extend(lead_lanes.iter().cloned()),
            }
        }
        if r.lane.starts_with("change:")
            && let Some(t) = &r.task_id
            && let Some(l) = task_lanes.get(t)
        {
            on.push(l.clone());
        }
        out.insert(r.lane.clone(), on);
    }
    Ok(out)
}

/// The order's critical path from its start to `end` (its done time, or now).
pub fn order_path(c: &Connection, w: &str, end: i64) -> Result<Option<CriticalPath>, StoreError> {
    let Some((start, done)) = order_bounds(c, w)? else {
        return Ok(None);
    };
    let end = done.unwrap_or(end).max(start);
    let mut f = Filter {
        since_ms: start,
        until_ms: end,
        workstream_id: Some(w.to_owned()),
        ..Filter::default()
    };
    f.after_id = None;
    let rows = store::read(c, &f, PATH_ROWS)?;
    let waits_on = waits_on(c, &rows)?;
    Ok(Some(path::critical_path(&PathInput {
        start_ms: start,
        end_ms: end,
        rows,
        waits_on,
    })))
}

/// Lead rows of an order count once over the orders their wake served.
fn weights(
    c: &Connection,
    rows: &[Row],
    metas: &[Meta],
    order: Option<&str>,
) -> Result<Vec<f64>, StoreError> {
    let Some(order) = order else {
        return Ok(vec![1.0; rows.len()]);
    };
    let mut cache: HashMap<(String, String, String), f64> = HashMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for (r, m) in rows.iter().zip(metas) {
        let lead_share =
            r.workstream_id.as_deref() != Some(order) && m.role.as_deref() == Some("lead");
        if !lead_share {
            out.push(1.0);
            continue;
        }
        let key = (
            r.machine_id.clone().unwrap_or_default(),
            r.thread_id.clone().unwrap_or_default(),
            m.run_id.clone().unwrap_or_default(),
        );
        if let Some(w) = cache.get(&key) {
            out.push(*w);
            continue;
        }
        let n: Option<i64> = c
            .query_row(
                "SELECT n FROM time_lead_runs WHERE machine_id = ?1 AND thread_id = ?2 AND run_id = ?3 LIMIT 1",
                params![key.0, key.1, key.2],
                |q| q.get(0),
            )
            .optional()?;
        let w = 1.0 / n.unwrap_or(1).max(1) as f64;
        cache.insert(key, w);
        out.push(w);
    }
    Ok(out)
}

struct Loaded {
    rows: Vec<Row>,
    metas: Vec<Meta>,
    weights: Vec<f64>,
    truncated: bool,
}

fn load(
    c: &Connection,
    scope: &TimeScope,
    since: i64,
    until: i64,
    role: Option<String>,
) -> Result<Loaded, StoreError> {
    let mut f = filter(scope, since, until);
    f.role = role;
    // Spans that start a day before the period at most: keeps the read on the start index. Totals count spans by
    // their start anyway.
    f.start_from = Some(since - store::DAY);
    f.newest = true;
    let got = store::read_meta(c, &f, MAX_ROWS + 1)?;
    let truncated = got.len() > MAX_ROWS;
    let (rows, metas): (Vec<Row>, Vec<Meta>) = got.into_iter().take(MAX_ROWS).unzip();
    let order = match scope {
        TimeScope::Order { workstream_id } => Some(workstream_id.as_str()),
        _ => None,
    };
    let weights = weights(c, &rows, &metas, order)?;
    Ok(Loaded {
        rows,
        metas,
        weights,
        truncated,
    })
}

/// The roll-up row a scope adds to, if it has one.
fn rollup_scope(scope: &TimeScope) -> Option<(&'static str, String)> {
    Some(match scope {
        TimeScope::Fleet => ("fleet", String::new()),
        TimeScope::Machine { machine_id } => ("machine", machine_id.to_string()),
        TimeScope::Project { project_ref } => (
            "project",
            format!("{}/{}", project_ref.machine_id, project_ref.project_id),
        ),
        TimeScope::Lead { project_ref } => (
            "lead",
            format!("{}/{}", project_ref.machine_id, project_ref.project_id),
        ),
        TimeScope::Order { workstream_id } => ("order", workstream_id.to_string()),
        TimeScope::Task { task_id } => ("task", task_id.to_string()),
        TimeScope::Thread { .. } => return None,
    })
}

/// Agent time per category and kind. Whole UTC days inside the period come from the daily roll-ups, which outlive
/// span retention; the partial days at its edges, and scopes without a roll-up (a thread, a role filter), from
/// spans. Every span counts in the day it started.
fn totals(
    c: &Connection,
    scope: &TimeScope,
    role: Option<&str>,
    l: &Loaded,
    since: i64,
    until: i64,
) -> Result<(i64, Vec<CategoryTotal>), StoreError> {
    type Totals = (f64, i64, BTreeMap<SpanKind, (f64, i64)>);
    let mut by: BTreeMap<Category, Totals> = BTreeMap::new();
    let (from_day, to_day) = (
        since.div_euclid(store::DAY) + i64::from(since.rem_euclid(store::DAY) != 0),
        until.div_euclid(store::DAY),
    );
    let whole = match (rollup_scope(scope), role) {
        (Some((sc, id)), None) if to_day > from_day => {
            for (cat, kind, ms, n) in store::rollup_totals(c, sc, &id, from_day, to_day)? {
                if is_detail(kind) {
                    continue;
                }
                let e = by.entry(cat).or_default();
                e.0 += ms as f64;
                e.1 += n;
                let k = e.2.entry(kind).or_default();
                k.0 += ms as f64;
                k.1 += n;
            }
            Some((from_day * store::DAY, to_day * store::DAY))
        }
        _ => None,
    };
    for (r, w) in l.rows.iter().zip(&l.weights) {
        if r.start_ms < since || r.start_ms >= until || is_detail(r.kind) {
            continue;
        }
        if whole.is_some_and(|(a, b)| r.start_ms >= a && r.start_ms < b) {
            continue;
        }
        let e = by.entry(r.cat()).or_default();
        let ms = r.excl_ms as f64 * w;
        e.0 += ms;
        e.1 += 1;
        let k = e.2.entry(r.kind).or_default();
        k.0 += ms;
        k.1 += 1;
    }
    let mut agent = 0;
    let cats = by
        .into_iter()
        .map(|(cat, (ms, n, kinds))| {
            agent += ms.round() as i64;
            CategoryTotal {
                cat,
                ms: count(ms.round() as i64),
                n: count(n),
                kinds: List::unchecked(
                    kinds
                        .into_iter()
                        .map(|(kind, (ms, n))| KindTotal {
                            kind,
                            ms: count(ms.round() as i64),
                            n: count(n),
                        })
                        .collect(),
                ),
            }
        })
        .collect();
    Ok((agent, cats))
}

fn p50(v: &mut [i64]) -> i64 {
    if v.is_empty() {
        return 0;
    }
    v.sort_unstable();
    v[(v.len() - 1) / 2]
}

fn top_commands(rows: &[Row]) -> Vec<CommandStat> {
    let mut by: HashMap<&str, (String, Vec<i64>, i64)> = HashMap::new();
    for r in rows {
        if !matches!(
            r.kind,
            SpanKind::ToolBash | SpanKind::Git | SpanKind::CheckClaim
        ) {
            continue;
        }
        let Some(label) = r.label.as_deref() else {
            continue;
        };
        let e = by
            .entry(label)
            .or_insert_with(|| (r.family.clone().unwrap_or_default(), Vec::new(), 0));
        e.1.push(r.dur());
        if r.exit_code.is_some_and(|x| x != 0)
            || r.status == fleetd_contracts::time::SpanStatus::Failed
        {
            e.2 += 1;
        }
    }
    let mut out: Vec<CommandStat> = by
        .into_iter()
        .map(|(label, (family, mut durs, failed))| {
            let total: i64 = durs.iter().sum();
            let max = durs.iter().copied().max().unwrap_or(0);
            CommandStat {
                label: Text::unchecked(label),
                family: Text::unchecked(crate::node::util::head_utf16(&family, 120)),
                n: count(durs.len() as i64),
                total_ms: count(total),
                p50_ms: count(p50(&mut durs)),
                max_ms: count(max),
                failed: count(failed),
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.total_ms
            .get()
            .cmp(&a.total_ms.get())
            .then(a.label.as_str().cmp(b.label.as_str()))
    });
    out.truncate(20);
    out
}

fn repeated(rows: &[Row]) -> Vec<RepeatStat> {
    let mut by_thread: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in rows {
        if matches!(
            r.kind,
            SpanKind::ToolBash | SpanKind::Git | SpanKind::ToolEdit
        ) && let Some(t) = &r.thread_id
        {
            by_thread.entry(t).or_default().push(r);
        }
    }
    let mut out = Vec::new();
    for (thread, mut rs) in by_thread {
        rs.sort_by_key(|r| (r.start_ms, r.id));
        let mut i = 0;
        while i < rs.len() {
            if rs[i].kind == SpanKind::ToolEdit {
                i += 1;
                continue;
            }
            let label = rs[i].label.as_deref().unwrap_or("");
            let mut j = i;
            let mut total = 0;
            while j < rs.len()
                && rs[j].kind != SpanKind::ToolEdit
                && rs[j].label.as_deref() == Some(label)
            {
                total += rs[j].dur();
                j += 1;
            }
            if j - i >= 3 {
                out.push(RepeatStat {
                    label: Text::unchecked(label),
                    thread_id: fleetd_contracts::ids::ThreadId::unchecked(thread),
                    task_id: rs[i]
                        .task_id
                        .as_deref()
                        .map(fleetd_contracts::tasks::TaskId::unchecked),
                    n: count((j - i) as i64),
                    total_ms: count(total),
                });
            }
            i = j.max(i + 1);
        }
    }
    out.sort_by_key(|r| std::cmp::Reverse(r.total_ms.get()));
    out.truncate(10);
    out
}

fn ci_checks(rows: &[Row], paths: &[(String, CriticalPath)]) -> Vec<CiCheckStat> {
    let mut by: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    for r in rows.iter().filter(|r| r.kind == SpanKind::CiCheck) {
        let name = r
            .extra
            .check
            .as_ref()
            .map(|c| c.to_string())
            .unwrap_or_default();
        by.entry(name).or_default().push(r.dur());
    }
    // The excess of the last check over the one before, on `change.ci` segments of the paths.
    let mut excess: HashMap<String, i64> = HashMap::new();
    for (w, p) in paths {
        for seg in p.segments.iter().filter(|s| s.kind == SpanKind::ChangeCi) {
            let mut checks: Vec<&Row> = rows
                .iter()
                .filter(|r| {
                    r.kind == SpanKind::CiCheck
                        && r.workstream_id.as_deref() == Some(w.as_str())
                        && r.start_ms < seg.end_ms.get()
                        && r.end_ms > seg.start_ms.get()
                })
                .collect();
            checks.sort_by_key(|r| r.end_ms);
            if let Some(last) = checks.last() {
                let before = if checks.len() >= 2 {
                    checks[checks.len() - 2].end_ms
                } else {
                    seg.start_ms.get()
                };
                let e = last.end_ms.min(seg.end_ms.get()) - before.max(seg.start_ms.get());
                let name = last
                    .extra
                    .check
                    .as_ref()
                    .map(|c| c.to_string())
                    .unwrap_or_default();
                *excess.entry(name).or_default() += e.max(0);
            }
        }
    }
    let mut out: Vec<CiCheckStat> = by
        .into_iter()
        .filter(|(n, _)| !n.is_empty())
        .map(|(name, mut d)| {
            let total = d.iter().sum();
            let max = d.iter().copied().max().unwrap_or(0);
            CiCheckStat {
                critical_excess_ms: count(excess.get(&name).copied().unwrap_or(0)),
                name: Text::unchecked(crate::node::util::head_utf16(&name, 200)),
                n: count(d.len() as i64),
                total_ms: count(total),
                p50_ms: count(p50(&mut d)),
                max_ms: count(max),
            }
        })
        .collect();
    out.sort_by_key(|r| std::cmp::Reverse(r.total_ms.get()));
    out.truncate(20);
    out
}

fn human_wait(rows: &[Row]) -> HumanWait {
    let waits: Vec<&Row> = rows
        .iter()
        .filter(|r| {
            r.kind == SpanKind::WaitRequest
                || (r.kind == SpanKind::WaitPermission
                    && r.extra.decided_by == Some(DecidedBy::Human))
        })
        .collect();
    let longest = waits
        .iter()
        .max_by_key(|r| (r.dur(), -r.id))
        .map(|r| LongestWait {
            span_id: count(r.id),
            ms: count(r.dur()),
            label: r
                .extra
                .key
                .as_ref()
                .map(|k| Text::unchecked(crate::node::util::head_utf16(k.as_str(), 200)))
                .or_else(|| r.extra.tool.as_ref().map(|t| Text::unchecked(t.as_str()))),
        });
    HumanWait {
        total_ms: count(waits.iter().map(|r| r.dur()).sum()),
        n: count(waits.len() as i64),
        longest,
    }
}

/// Orders whose span overlaps the period, with their bounds clipped to it.
fn orders_in(
    c: &Connection,
    scope: &TimeScope,
    since: i64,
    until: i64,
) -> Result<Vec<(String, i64, i64, bool)>, StoreError> {
    let (clause, args): (&str, Vec<String>) = match scope {
        TimeScope::Fleet => ("1", vec![]),
        TimeScope::Machine { machine_id } => ("machine_id = ?3", vec![machine_id.to_string()]),
        TimeScope::Project { project_ref } | TimeScope::Lead { project_ref } => (
            "machine_id = ?3 AND project_id = ?4",
            vec![
                project_ref.machine_id.to_string(),
                project_ref.project_id.to_string(),
            ],
        ),
        TimeScope::Order { workstream_id } => {
            ("workstream_id = ?3", vec![workstream_id.to_string()])
        }
        _ => return Ok(Vec::new()),
    };
    let mut stmt = c.prepare(&format!(
        "SELECT workstream_id, start_ms, end_ms FROM time_orders
         WHERE start_ms < ?2 AND COALESCE(end_ms, ?2) > ?1 AND {clause} ORDER BY start_ms DESC LIMIT 5000"
    ))?;
    let mut values: Vec<rusqlite::types::Value> = vec![since.into(), until.into()];
    values.extend(args.into_iter().map(rusqlite::types::Value::from));
    let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Option<i64>>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (w, s, e) = row?;
        let (s, e) = match order_bounds(c, &w)? {
            Some((s2, e2)) => (s2.min(s), e2.or(e)),
            None => (s, e),
        };
        out.push((w, s, e.unwrap_or(until), e.is_some()));
    }
    Ok(out)
}

/// The union of the intervals, in ms.
fn union_ms(mut spans: Vec<(i64, i64)>) -> i64 {
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

fn wall(
    c: &Connection,
    scope: &TimeScope,
    l: &Loaded,
    since: i64,
    until: i64,
) -> Result<i64, StoreError> {
    Ok(match scope {
        TimeScope::Task { .. } | TimeScope::Thread { .. } => {
            let s = l
                .rows
                .iter()
                .map(|r| r.start_ms)
                .min()
                .unwrap_or(since)
                .max(since);
            let e = l
                .rows
                .iter()
                .map(|r| r.end_ms)
                .max()
                .unwrap_or(since)
                .min(until);
            (e - s).max(0)
        }
        _ => union_ms(
            orders_in(c, scope, since, until)?
                .into_iter()
                .map(|(_, s, e, _)| (s.max(since), e.min(until)))
                .filter(|(s, e)| e > s)
                .collect(),
        ),
    })
}

/// Running orders whose path a read computes, newest first; the rest wait for their own order scope.
const RUNNING_PATHS: usize = 20;

/// Paths of running orders, kept until a span is written or a minute passes: a breakdown, its insights and every
/// `time_spans { rule }` page would otherwise walk each running order again.
#[derive(Default)]
pub struct PathCache(std::sync::Mutex<HashMap<String, (i64, i64, CriticalPath)>>);

impl PathCache {
    fn get_or(
        &self,
        c: &Connection,
        w: &str,
        now: i64,
    ) -> Result<Option<CriticalPath>, StoreError> {
        let head: i64 = c.query_row("SELECT COALESCE(MAX(id), 0) FROM time_spans", [], |r| {
            r.get(0)
        })?;
        let minute = now / 60_000;
        if let Some((h, m, p)) = self.0.lock().unwrap().get(w)
            && *h == head
            && *m == minute
        {
            return Ok(Some(p.clone()));
        }
        let path = order_path(c, w, now)?;
        if let Some(p) = &path {
            let mut map = self.0.lock().unwrap();
            if map.len() > 200 {
                map.clear();
            }
            map.insert(w.to_owned(), (head, minute, p.clone()));
        }
        Ok(path)
    }
}

/// Critical paths of the orders in the period: stored for finished orders, computed for running ones.
fn paths(
    c: &Connection,
    scope: &TimeScope,
    since: i64,
    until: i64,
    now: i64,
    cache: &PathCache,
) -> Result<Vec<(String, CriticalPath)>, StoreError> {
    let mut out = Vec::new();
    let mut running = 0;
    for (w, _, _, done) in orders_in(c, scope, since, until)?.into_iter().take(500) {
        let stored: Option<String> = if done {
            c.query_row(
                "SELECT data FROM time_paths WHERE workstream_id = ?1",
                [&w],
                |r| r.get(0),
            )
            .optional()?
        } else {
            None
        };
        let path = match stored.and_then(|s| path::decode_stored(&s)) {
            Some(p) => Some(p),
            None if running >= RUNNING_PATHS => continue,
            None => {
                running += 1;
                cache.get_or(c, &w, now)?
            }
        };
        if let Some(p) = path {
            out.push((w, p));
        }
    }
    Ok(out)
}

fn coverage(
    c: &Connection,
    scope: &TimeScope,
    l: &Loaded,
    path: Option<&CriticalPath>,
    since: i64,
    now: i64,
) -> Result<Coverage, StoreError> {
    let mut gaps: Vec<Gap> = Vec::new();
    for (r, m) in l.rows.iter().zip(&l.metas) {
        if r.kind != SpanKind::Gap || gaps.len() >= 50 {
            continue;
        }
        let why = if m.src_key.starts_with("node/") || r.lane.starts_with("thread:") {
            GapWhy::NodeDropped
        } else {
            GapWhy::HubDropped
        };
        gaps.push(Gap {
            why,
            lane: Text::new(r.lane.clone()).ok(),
            machine_id: r.machine_id.as_deref().map(MachineId::unchecked),
            from_ms: count(r.start_ms),
            to_ms: count(r.end_ms),
            count: r.extra.count,
        });
    }
    // Sessions of the scope's tasks that started but sent no node spans: an older node, or a node restart mid-run.
    let tasks: Vec<(String, String, String)> = match scope {
        TimeScope::Order { workstream_id } => {
            let mut stmt = c.prepare(
                "SELECT 'T' || n, machine_id, thread_id FROM tasks WHERE workstream_id = ?1 AND thread_id IS NOT NULL LIMIT 200",
            )?;
            stmt.query_map([workstream_id.as_str()], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<Result<_, _>>()?
        }
        TimeScope::Task { task_id } => {
            let mut stmt =
                c.prepare("SELECT 'T' || n, machine_id, thread_id FROM tasks WHERE n = ?1 AND thread_id IS NOT NULL")?;
            stmt.query_map([task_id.as_str()[1..].parse::<i64>().unwrap_or(-1)], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<Result<_, _>>()?
        }
        _ => Vec::new(),
    };
    for (_, m, t) in tasks {
        let has: Option<i64> = c
            .query_row(
                "SELECT 1 FROM time_spans WHERE machine_id = ?1 AND thread_id = ?2 AND src LIKE 'n:%' LIMIT 1",
                [&m, &t],
                |r| r.get(0),
            )
            .optional()?;
        if has.is_none() && gaps.len() < 50 {
            gaps.push(Gap {
                why: GapWhy::NoNodeSpans,
                lane: Text::new(format!("thread:{m}/{t}")).ok(),
                machine_id: Some(MachineId::unchecked(m)),
                from_ms: count(0),
                to_ms: count(0),
                count: None,
            });
        }
    }
    if let Some(p) = path
        && p.nothing_running_ms.get() > 0
        && gaps.len() < 50
    {
        for s in p.segments.iter().filter(|s| s.span_id.is_none()) {
            if gaps.len() >= 50 {
                break;
            }
            gaps.push(Gap {
                why: GapWhy::NothingRunning,
                lane: None,
                machine_id: None,
                from_ms: s.start_ms,
                to_ms: s.end_ms,
                count: None,
            });
        }
    }
    let kept_from = now - store::retention_days(c)? * store::DAY;
    let detail_since = (since < kept_from).then(|| Timestamp(iso_ms(kept_from)));
    let complete = gaps.is_empty() && !l.truncated && detail_since.is_none();
    Ok(Coverage {
        complete,
        gaps: List::unchecked(gaps),
        detail_since,
        capped: l.truncated.then_some(true),
    })
}

fn to_span(r: &Row, m: &Meta) -> Span {
    let item_id = item_id(&m.src_key, r.kind);
    Span {
        id: count(r.id),
        kind: r.kind,
        cat: r.cat(),
        lane: Text::new(r.lane.clone()).unwrap_or_else(|_| Text::unchecked("?")),
        start_ms: count(r.start_ms),
        end_ms: (!m.open).then(|| count(r.end_ms)),
        excl_ms: (!m.open).then(|| count(r.excl_ms)),
        machine_id: r.machine_id.as_deref().map(MachineId::unchecked),
        project_id: r
            .project_id
            .as_deref()
            .map(fleetd_contracts::ids::ProjectId::unchecked),
        workstream_id: r
            .workstream_id
            .as_deref()
            .map(fleetd_contracts::ledger::WorkstreamId::unchecked),
        task_id: r
            .task_id
            .as_deref()
            .map(fleetd_contracts::tasks::TaskId::unchecked),
        thread_id: r
            .thread_id
            .as_deref()
            .map(fleetd_contracts::ids::ThreadId::unchecked),
        run_id: m.run_id.as_deref().and_then(|r| Text::new(r).ok()),
        parent: r.parent_id.map(count),
        label: r.label.as_deref().map(Text::unchecked),
        family: r
            .family
            .as_deref()
            .map(|f| Text::unchecked(crate::node::util::head_utf16(f, 120))),
        exit_code: r.exit_code.and_then(|c| c.try_into().ok()),
        out_bytes: r.out_bytes.map(count),
        status: r.status,
        item_id: item_id.and_then(|i| Text::new(i).ok()),
        extra: (r.extra != Default::default()).then(|| r.extra.clone()),
    }
}

/// A node span's item id in its thread: a tool call's `tool_use_id`, a message's id, a prompt's permission item.
fn item_id(src_key: &str, kind: SpanKind) -> Option<String> {
    let (_, rest) = src_key.split_once('/')?;
    match kind {
        SpanKind::ModelMessage => rest.strip_prefix("msg/").map(str::to_owned),
        SpanKind::ModelFirstToken | SpanKind::ModelThinking | SpanKind::ModelOutput => rest
            .strip_prefix("msg/")
            .and_then(|m| m.rsplit_once('/'))
            .map(|(m, _)| m.to_owned()),
        SpanKind::WaitPermission => rest
            .strip_prefix("perm/")
            .map(|r| format!("permission-{r}")),
        SpanKind::ToolBash
        | SpanKind::ToolRead
        | SpanKind::ToolEdit
        | SpanKind::ToolWeb
        | SpanKind::ToolMcp
        | SpanKind::ToolOther
        | SpanKind::Git
            if !rest.contains('/') =>
        {
            Some(rest.to_owned())
        }
        _ => None,
    }
}

fn period(since: &Timestamp, until: Option<&Timestamp>, now: i64) -> Result<(i64, i64), ToolError> {
    let s = ms_of(since)?;
    let u = until.map(ms_of).transpose()?.unwrap_or(now);
    if u <= s {
        return Err(invalid("until must be after since").with_fix("Give since earlier than until."));
    }
    Ok((s, u))
}

/// Rows readable by the caller (fleet scope: only machines it may read).
fn readable(caller: &Caller, l: Loaded) -> Loaded {
    if allows_everywhere(caller, Role::Read) {
        return l;
    }
    let keep: Vec<bool> = l
        .rows
        .iter()
        .map(|r| {
            r.machine_id
                .as_deref()
                .is_none_or(|m| allows(caller, Role::Read, Some(&MachineId::unchecked(m))))
        })
        .collect();
    let mut it = keep.iter();
    let mut rows = l.rows;
    rows.retain(|_| *it.next().unwrap());
    let mut it = keep.iter();
    let mut metas = l.metas;
    metas.retain(|_| *it.next().unwrap());
    let mut it = keep.iter();
    let mut weights = l.weights;
    weights.retain(|_| *it.next().unwrap());
    Loaded {
        rows,
        metas,
        weights,
        truncated: l.truncated,
    }
}

fn rule_input(c: &Connection, l: &Loaded, since: i64, until: i64) -> Result<RuleInput, StoreError> {
    let mut titles = HashMap::new();
    let mut ids: Vec<&str> = l.rows.iter().filter_map(|r| r.task_id.as_deref()).collect();
    ids.sort_unstable();
    ids.dedup();
    for t in ids.into_iter().take(2000) {
        let title: Option<String> = c
            .query_row(
                "SELECT json_extract(data, '$.title') FROM tasks WHERE n = ?1",
                [t[1..].parse::<i64>().unwrap_or(-1)],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        if let Some(title) = title {
            titles.insert(t.to_owned(), title);
        }
    }
    Ok(RuleInput {
        rows: l
            .rows
            .iter()
            .filter(|r| r.start_ms >= since && r.start_ms < until)
            .cloned()
            .collect(),
        task_titles: titles,
    })
}

async fn time_spans(
    hub: Arc<Hub>,
    caller: Caller,
    input: TimeSpansInput,
) -> Result<TimeSpansOutput, ToolError> {
    let now = hub.time.now_ms();
    let (since, until) = period(&input.since, input.until.as_ref(), now)?;
    let limit = input.limit.get() as usize;
    let (rows, coverage) = hub.db.with(|c| {
        if let Err(e) = check(c, &caller, &input.scope) {
            return Ok(Err(e));
        }
        let mut f = filter(&input.scope, since, until);
        f.kinds = input.kinds.as_ref().map(|k| k.to_vec());
        f.after_id = input.after_id.map(|a| a.get());
        let mut rows: Vec<(Row, Meta)> = match input.rule {
            Some(rule) => {
                let l = readable(&caller, load(c, &input.scope, since, until, None)?);
                let ri = rule_input(c, &l, since, until)?;
                let after = f.after_id.unwrap_or(0);
                let wanted: std::collections::HashSet<i64> = rules::rule_spans(&ri, rule)
                    .into_iter()
                    .filter(|i| *i > after)
                    .collect();
                l.rows
                    .into_iter()
                    .zip(l.metas)
                    .filter(|(r, _)| wanted.contains(&r.id))
                    .take(limit + 1)
                    .collect()
            }
            None => store::read_meta(c, &f, limit + 1)?,
        };
        rows.retain(|(r, _)| {
            r.machine_id
                .as_deref()
                .is_none_or(|m| allows(&caller, Role::Read, Some(&MachineId::unchecked(m))))
        });
        let l = Loaded {
            rows: rows.iter().map(|(r, _)| r.clone()).collect(),
            metas: rows.iter().map(|(_, m)| m.clone()).collect(),
            weights: vec![1.0; rows.len()],
            truncated: false,
        };
        let cov = coverage(c, &input.scope, &l, None, since, now)?;
        Ok(Ok((rows, cov)))
    })??;
    let mut rows = rows;
    let more = rows.len() > limit;
    rows.truncate(limit);
    Ok(TimeSpansOutput {
        next_after_id: if more {
            rows.last().map(|(r, _)| count(r.id))
        } else {
            None
        },
        spans: List::unchecked(rows.iter().map(|(r, m)| to_span(r, m)).collect()),
        coverage,
        next: Some(if more {
            "More spans: call again with afterId.".into()
        } else {
            "time_breakdown sums these; thread_window opens a span's transcript by its itemId."
                .into()
        }),
        truncated: more.then_some(true),
    })
}

fn period_breakdown(
    c: &Connection,
    caller: &Caller,
    scope: &TimeScope,
    since: i64,
    until: i64,
    role: Option<String>,
) -> Result<(Loaded, i64, i64, Vec<CategoryTotal>), StoreError> {
    let l = readable(caller, load(c, scope, since, until, role.clone())?);
    let (agent, cats) = totals(c, scope, role.as_deref(), &l, since, until)?;
    let wall = wall(c, scope, &l, since, until)?;
    Ok((l, wall, agent, cats))
}

async fn time_breakdown(
    hub: Arc<Hub>,
    caller: Caller,
    input: TimeBreakdownInput,
) -> Result<TimeBreakdownOutput, ToolError> {
    let now = hub.time.now_ms();
    let (since, until) = period(&input.since, input.until.as_ref(), now)?;
    let compare = input
        .compare
        .as_ref()
        .map(|p| period(&p.since, Some(&p.until), now))
        .transpose()?;
    let role = input.filters.role.map(|r| {
        serde_json::to_value(r)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default()
    });
    let scope = narrow(&input.scope, &input.filters);
    hub.db.with(|c| {
        if let Err(e) = check(c, &caller, &scope) {
            return Ok(Err(e));
        }
        let (l, wall_ms, agent_ms, by_category) =
            period_breakdown(c, &caller, &scope, since, until, role.clone())?;
        let in_period: Vec<Row> = l
            .rows
            .iter()
            .filter(|r| r.start_ms >= since && r.start_ms < until)
            .cloned()
            .collect();
        let ps = paths(c, &scope, since, until, now, &hub.time.paths)?;
        let critical_path = match &scope {
            TimeScope::Order { workstream_id } => ps
                .iter()
                .find(|(w, _)| w == workstream_id.as_str())
                .map(|(_, p)| p.clone()),
            _ => None,
        };
        let coverage = coverage(c, &scope, &l, critical_path.as_ref(), since, now)?;
        let critical_path = critical_path.as_ref().map(path::for_output);
        let compare = match compare {
            Some((s, u)) => {
                let (_, wall, agent, cats) =
                    period_breakdown(c, &caller, &scope, s, u, role.clone())?;
                Some(PeriodBreakdown {
                    since: Timestamp(iso_ms(s)),
                    until: Timestamp(iso_ms(u)),
                    wall_ms: count(wall),
                    agent_ms: count(agent),
                    by_category: List::unchecked(cats),
                })
            }
            None => None,
        };
        Ok(Ok(TimeBreakdownOutput {
            wall_ms: count(wall_ms),
            agent_ms: count(agent_ms),
            by_category: List::unchecked(by_category),
            top_commands: List::unchecked(top_commands(&in_period)),
            repeated: List::unchecked(repeated(&in_period)),
            ci_checks: List::unchecked(ci_checks(&in_period, &ps)),
            human_wait: human_wait(&in_period),
            critical_path,
            retention_days: Int::try_from(store::retention_days(c)?)
                .unwrap_or_else(|_| Int::try_from(30).unwrap()),
            stored_bytes: count(store::stored_bytes(c)?),
            coverage,
            compare,
            next: Some(
                "time_insights reads the same spans for findings; time_spans lists them.".into(),
            ),
            truncated: l.truncated.then_some(true),
        }))
    })?
}

/// Filters narrow a fleet scope to a project or a machine.
fn narrow(scope: &TimeScope, f: &fleetd_contracts::time::TimeFilters) -> TimeScope {
    match (scope, &f.project_ref, &f.machine_id) {
        (TimeScope::Fleet, Some(p), _) => TimeScope::Project {
            project_ref: p.clone(),
        },
        (TimeScope::Fleet, None, Some(m)) => TimeScope::Machine {
            machine_id: m.clone(),
        },
        _ => scope.clone(),
    }
}

async fn time_insights(
    hub: Arc<Hub>,
    caller: Caller,
    input: TimeInsightsInput,
) -> Result<TimeInsightsOutput, ToolError> {
    let now = hub.time.now_ms();
    let (since, until) = period(&input.since, input.until.as_ref(), now)?;
    let compare = input
        .compare
        .as_ref()
        .map(|p| period(&p.since, Some(&p.until), now))
        .transpose()?;
    let insights = hub.db.with(|c| {
        if let Err(e) = check(c, &caller, &input.scope) {
            return Ok(Err(e));
        }
        let l = readable(&caller, load(c, &input.scope, since, until, None)?);
        let cur = rule_input(c, &l, since, until)?;
        Ok(Ok(match compare {
            Some((s, u)) => {
                let lp = readable(&caller, load(c, &input.scope, s, u, None)?);
                let prev = rule_input(c, &lp, s, u)?;
                rules::compare(&cur, &prev)
            }
            None => rules::insights(&cur),
        }))
    })??;
    Ok(TimeInsightsOutput {
        next: Some("time_spans with rule lists every span a finding links to.".into()),
        truncated: None,
        insights: List::unchecked(insights.into_iter().take(rules::MAX_INSIGHTS).collect()),
    })
}

async fn time_retention_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: TimeRetentionSetInput,
) -> Result<TimeRetentionSetOutput, ToolError> {
    // Retention prunes every machine's spans, so Admin on one machine is not enough.
    if !allows_everywhere(&caller, Role::Admin) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Span retention is fleet-wide: it needs Admin on every machine.",
        )
        .with_fix("Use an Admin key for all machines (`--machines '*'`)."));
    }
    let days = input.retention_days.get();
    hub.db.transaction(|c| store::set_retention_days(c, days))?;
    Ok(TimeRetentionSetOutput {
        retention_days: input.retention_days,
        next: Some(
            "Spans older than this go at the next hourly prune; roll-ups stay 400 days.".into(),
        ),
        truncated: None,
    })
}

async fn thread_window(
    hub: Arc<Hub>,
    caller: Caller,
    input: ThreadWindowInput,
) -> Result<ThreadWindowOutput, ToolError> {
    require(&caller, Role::Read, Some(&input.machine_id))?;
    let r = ThreadRef {
        machine_id: input.machine_id.clone(),
        thread_id: input.thread_id.clone(),
    };
    let (rows, focus) = hub
        .executors
        .window(
            &r,
            input.item_id.as_str(),
            input.before.get() as u64,
            input.after.get() as u64,
        )
        .await
        .map_err(crate::hub::executor::tools::from_executor)?;
    let items: Vec<fleetd_contracts::mcp::TailItem> = rows
        .into_iter()
        .filter_map(|row| {
            serde_json::to_value(row)
                .ok()
                .and_then(|v| serde_json::from_value(v).ok())
        })
        .collect();
    Ok(ThreadWindowOutput {
        focus: focus.map(|f| count(f as i64)),
        items: List::unchecked(items.into_iter().take(51).collect()),
        next: Some("thread_tail shows the newest entries.".into()),
        truncated: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::store::HubDb;
    use crate::hub::time::store::{Ids, NewSpan, write};

    fn span(key: &str, start: i64, ms: i64) -> NewSpan {
        NewSpan {
            src: "h".into(),
            src_key: key.into(),
            kind: SpanKind::ToolBash,
            start_ms: start,
            end_ms: Some(start + ms),
            ids: Ids {
                machine_id: Some("devbox".into()),
                ..Ids::default()
            },
            lane: "thread:devbox/t".into(),
            ..NewSpan::default()
        }
    }

    /// Past span retention, whole days still add up from the roll-ups, the edge days from spans, and coverage says
    /// from when the detail exists.
    #[test]
    fn whole_days_past_retention_come_from_the_roll_ups() {
        let db = HubDb::open_memory().unwrap();
        let day = store::DAY;
        let now = 400 * day + day / 2;
        db.transaction(|c| {
            write(c, &span("old", 300 * day + 1_000, 7_000), &[])?;
            write(c, &span("edge", 399 * day + day / 2, 3_000), &[])?;
            write(c, &span("today", 400 * day + 1_000, 2_000), &[])?;
            // Retention (30 days) pruned the old span; its roll-up stays.
            c.execute("DELETE FROM time_spans WHERE src_key = 'old'", [])?;
            let since = 299 * day + day / 2;
            let l = load(c, &TimeScope::Fleet, since, now, None)?;
            let (agent, cats) = totals(c, &TimeScope::Fleet, None, &l, since, now)?;
            assert_eq!(agent, 12_000);
            assert_eq!(cats[0].n.get(), 3);
            // A role filter has no roll-up: only what spans remain.
            let (agent, _) = totals(c, &TimeScope::Fleet, Some("lead"), &l, since, now)?;
            assert_eq!(agent, 5_000);
            let cov = coverage(c, &TimeScope::Fleet, &l, None, since, now)?;
            assert!(!cov.complete);
            assert_eq!(cov.detail_since.map(|t| t.0), Some(iso_ms(now - 30 * day)));
            let recent = coverage(c, &TimeScope::Fleet, &l, None, now - day, now)?;
            assert!(recent.complete && recent.detail_since.is_none());
            Ok(())
        })
        .unwrap();
    }
}
