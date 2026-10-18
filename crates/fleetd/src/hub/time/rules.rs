//! The insight rules (spec §6): deterministic aggregates over a period's spans, never a model. Thresholds are the
//! constants below, and every finding carries the numbers it was built from.
use std::collections::{BTreeMap, BTreeSet, HashMap};

use fleetd_contracts::prim::{AnyInt, Count, Line, List, Text, js_len};
use fleetd_contracts::time::{
    DecidedBy, FiredIn, Insight, InsightNumber, InsightRule, PathSegment, SpanKind,
};

use super::model::{Row, RuleInput};

const MIN: i64 = 60_000;
const SEC: i64 = 1_000;

pub const FULL_SUITE_MIN_RUNS: usize = 5;
pub const FULL_SUITE_MIN_TOTAL: i64 = 10 * MIN;
pub const REPEAT_MIN_RUNS: usize = 3;
pub const FAILING_MIN_RUNS: usize = 3;
pub const SLOW_MIN_TOTAL: i64 = 2 * MIN;
pub const SLOW_TOP: usize = 10;
pub const CI_CRITICAL_MIN_EXCESS: i64 = 3 * MIN;
pub const CI_CRITICAL_MIN_ORDERS: usize = 2;
pub const CI_REACTION_MIN_P50: i64 = 30 * SEC;
pub const SLOTS_MIN_PEAK: i64 = 1;
pub const HUMAN_WAIT_MIN: i64 = 10 * MIN;
pub const BATCHING_MIN: i64 = 5 * MIN;
pub const APPROVAL_MIN_PROMPTS: usize = 5;
pub const USAGE_PARKS_MIN: i64 = 15 * MIN;
pub const RETRIES_MIN: i64 = 5 * MIN;
pub const REVIEW_SHARE_MIN_PCT: i64 = 30;
pub const REVIEW_SHARE_MIN_ORDERS: usize = 3;
pub const TRAIN_LINE_MIN: i64 = 10 * MIN;
pub const REBASE_MIN_BLOCKS: usize = 2;
pub const FIRST_TOKEN_MIN_P90: i64 = 20 * SEC;
pub const FIRST_TOKEN_MIN_MESSAGES: usize = 50;
pub const STARTUP_MIN_P50: i64 = 5 * SEC;
pub const OFFLINE_MIN: i64 = 5 * MIN;

/// The most findings returned, and the most span ids one finding carries.
pub const MAX_INSIGHTS: usize = 30;
pub const MAX_SPAN_IDS: usize = 200;

/// The program families the `full_suite_repeat` rule treats as test runners.
const TEST_FAMILIES: &[&str] = &[
    "cargo test",
    "cargo nextest",
    "npm test",
    "pnpm test",
    "yarn test",
    "vp test",
    "pytest",
    "go test",
    "jest",
    "vitest",
];

/// One rule's result for one key, fired or not: the numbers are kept either way so a comparison can show them.
#[derive(Clone, Debug)]
struct Candidate {
    rule: InsightRule,
    key: String,
    fired: bool,
    message: String,
    numbers: Vec<(&'static str, i64)>,
    /// (start, id), sorted.
    spans: Vec<(i64, i64)>,
    /// The total time the finding names; findings rank by it.
    weight: i64,
}

/// "34s", "2m10s", "51m", "1h12m".
pub fn fmt_dur(ms: i64) -> String {
    let s = ms.max(0) / SEC;
    let (h, m, sec) = (s / 3600, (s % 3600) / 60, s % 60);
    if h > 0 {
        if m == 0 {
            format!("{h}h")
        } else {
            format!("{h}h{m:02}m")
        }
    } else if m >= 10 || (m > 0 && sec == 0) {
        format!("{m}m")
    } else if m > 0 {
        format!("{m}m{sec:02}s")
    } else {
        format!("{sec}s")
    }
}

fn rule_name(rule: InsightRule) -> String {
    serde_json::to_value(rule)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Nearest-rank percentile; 0 for no values.
fn pct(values: &[i64], p: u32) -> i64 {
    if values.is_empty() {
        return 0;
    }
    let mut v = values.to_vec();
    v.sort_unstable();
    let idx = (v.len() * p as usize).div_ceil(100).max(1) - 1;
    v[idx.min(v.len() - 1)]
}

fn short(label: &str) -> String {
    let mut out = String::new();
    for c in label.chars() {
        if js_len(&out) + c.len_utf16() > 150 {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}

fn label(row: &Row) -> &str {
    row.label.as_deref().unwrap_or("")
}

fn spans<'a>(rows: impl IntoIterator<Item = &'a Row>) -> Vec<(i64, i64)> {
    let mut out: Vec<(i64, i64)> = rows.into_iter().map(|r| (r.start_ms, r.id)).collect();
    out.sort_unstable();
    out.dedup();
    out
}

fn total<'a>(rows: impl IntoIterator<Item = &'a Row>) -> i64 {
    rows.into_iter().map(Row::dur).sum()
}

fn task_name(input: &RuleInput, row: &Row) -> String {
    match (&row.task_id, &row.thread_id) {
        (Some(t), _) => match input.task_titles.get(t) {
            Some(title) => format!("{t} {title}"),
            None => t.clone(),
        },
        (None, Some(th)) => format!("thread {th}"),
        _ => "a session".into(),
    }
}

fn is_command(row: &Row) -> bool {
    matches!(row.kind, SpanKind::ToolBash | SpanKind::Git) && row.label.is_some()
}

fn failed(row: &Row) -> bool {
    row.exit_code.is_some_and(|c| c != 0)
        || row.status == fleetd_contracts::time::SpanStatus::Failed
}

fn family_of(row: &Row) -> Option<&'static str> {
    let fam = row.family.as_deref().unwrap_or("");
    let lab = label(row);
    TEST_FAMILIES
        .iter()
        .copied()
        .find(|f| fam == *f || lab == *f || lab.starts_with(&format!("{f} ")))
}

/// The label runs the whole suite: after the family (and a `run` subcommand) nothing but flags until a shell
/// operator. `cargo test -p x`, `pytest tests/a.py` and `cargo test -- name` filter, so they don't count.
fn is_full_suite(row: &Row, family: &str) -> bool {
    let lab = label(row);
    let Some(pos) = lab.find(family) else {
        return true;
    };
    let mut rest = lab[pos + family.len()..].split_whitespace().peekable();
    if rest.peek() == Some(&"run") {
        rest.next();
    }
    let mut after_dashes = false;
    for tok in rest {
        if matches!(tok, "|" | "||" | "&&" | ";") || tok.contains('>') || tok.contains('<') {
            break;
        }
        if tok == "--" {
            after_dashes = true;
            continue;
        }
        if after_dashes || !tok.starts_with('-') {
            return false;
        }
    }
    true
}

/// Rows by thread, oldest first.
fn by_thread<'a>(rows: impl Iterator<Item = &'a Row>) -> BTreeMap<&'a str, Vec<&'a Row>> {
    let mut out: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in rows {
        if let Some(t) = r.thread_id.as_deref() {
            out.entry(t).or_default().push(r);
        }
    }
    for v in out.values_mut() {
        v.sort_by_key(|r| (r.start_ms, r.id));
    }
    out
}

fn edited_between(edits: &[&Row], from: i64, to: i64) -> bool {
    edits.iter().any(|e| e.start_ms >= from && e.start_ms < to)
}

fn full_suite_repeat(input: &RuleInput, out: &mut Vec<Candidate>) {
    let edits = by_thread(input.rows.iter().filter(|r| r.kind == SpanKind::ToolEdit));
    let mut groups: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in input.rows.iter().filter(|r| r.kind == SpanKind::ToolBash) {
        if let Some(f) = family_of(r)
            && is_full_suite(r, f)
        {
            groups.entry(label(r)).or_default().push(r);
        }
    }
    for (lab, runs) in groups {
        let mut k = 0;
        for (_, thread_runs) in by_thread(runs.iter().copied()) {
            let none: Vec<&Row> = Vec::new();
            let thread = thread_runs[0].thread_id.as_deref().unwrap_or("");
            let e = edits.get(thread).unwrap_or(&none);
            for w in thread_runs.windows(2) {
                if !edited_between(e, w[0].start_ms, w[1].start_ms) {
                    k += 1;
                }
            }
        }
        let (n, sum) = (runs.len(), total(runs.iter().copied()));
        out.push(Candidate {
            rule: InsightRule::FullSuiteRepeat,
            key: lab.to_owned(),
            fired: n >= FULL_SUITE_MIN_RUNS && sum >= FULL_SUITE_MIN_TOTAL,
            message: format!(
                "agents ran the full test suite `{}` {n}× ({}); {k} runs followed no edit since the previous run",
                short(lab),
                fmt_dur(sum)
            ),
            numbers: vec![("runs", n as i64), ("total_ms", sum), ("no_edit", k)],
            spans: spans(runs.iter().copied()),
            weight: sum,
        });
    }
}

/// The longest streak per (thread, label) of runs of that label in a row where `breaks(prev, next)` is false.
fn streaks(
    input: &RuleInput,
    keep: impl Fn(&Row) -> bool,
    breaks: impl Fn(&[&Row], &Row, &Row) -> bool,
) -> Vec<Vec<&Row>> {
    let edits = by_thread(input.rows.iter().filter(|r| r.kind == SpanKind::ToolEdit));
    let none: Vec<&Row> = Vec::new();
    let mut found = Vec::new();
    for (thread, rows) in by_thread(input.rows.iter().filter(|r| is_command(r))) {
        let e = edits.get(thread).unwrap_or(&none);
        let mut per_label: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
        for r in rows {
            per_label.entry(label(r)).or_default().push(r);
        }
        for runs in per_label.into_values() {
            let mut best: Vec<&Row> = Vec::new();
            let mut cur: Vec<&Row> = Vec::new();
            for r in runs {
                if !keep(r) {
                    cur.clear();
                    continue;
                }
                if let Some(prev) = cur.last()
                    && breaks(e, prev, r)
                {
                    cur.clear();
                }
                cur.push(r);
                if cur.len() > best.len() {
                    best = cur.clone();
                }
            }
            if !best.is_empty() {
                found.push(best);
            }
        }
    }
    found
}

fn repeat_no_change(input: &RuleInput, out: &mut Vec<Candidate>) {
    let found = streaks(
        input,
        |_| true,
        |e, prev, next| edited_between(e, prev.start_ms, next.start_ms),
    );
    for runs in found {
        let first = runs[0];
        let sum = total(runs.iter().copied());
        out.push(Candidate {
            rule: InsightRule::RepeatNoChange,
            key: format!(
                "{}|{}",
                first.thread_id.as_deref().unwrap_or(""),
                label(first)
            ),
            fired: runs.len() >= REPEAT_MIN_RUNS,
            message: format!(
                "`{}` ran {}× in a row in {} with nothing changed between runs ({})",
                short(label(first)),
                runs.len(),
                task_name(input, first),
                fmt_dur(sum)
            ),
            numbers: vec![("runs", runs.len() as i64), ("total_ms", sum)],
            spans: spans(runs.iter().copied()),
            weight: sum,
        });
    }
}

fn failing_repeat(input: &RuleInput, out: &mut Vec<Candidate>) {
    for runs in streaks(input, failed, |_, _, _| false) {
        let first = runs[0];
        let sum = total(runs.iter().copied());
        out.push(Candidate {
            rule: InsightRule::FailingRepeat,
            key: format!(
                "{}|{}",
                first.thread_id.as_deref().unwrap_or(""),
                label(first)
            ),
            fired: runs.len() >= FAILING_MIN_RUNS,
            message: format!(
                "`{}` failed {}× in a row in {} ({})",
                short(label(first)),
                runs.len(),
                task_name(input, first),
                fmt_dur(sum)
            ),
            numbers: vec![("runs", runs.len() as i64), ("total_ms", sum)],
            spans: spans(runs.iter().copied()),
            weight: sum,
        });
    }
}

fn slow_commands(input: &RuleInput, out: &mut Vec<Candidate>) {
    let mut groups: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in input.rows.iter().filter(|r| is_command(r)) {
        groups.entry(label(r)).or_default().push(r);
    }
    let mut all: Vec<(i64, &str, Vec<&Row>)> = groups
        .into_iter()
        .map(|(l, rows)| (total(rows.iter().copied()), l, rows))
        .collect();
    all.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
    for (i, (sum, lab, rows)) in all.into_iter().enumerate() {
        let durs: Vec<i64> = rows.iter().map(|r| r.dur()).collect();
        let p50 = pct(&durs, 50);
        out.push(Candidate {
            rule: InsightRule::SlowCommands,
            key: lab.to_owned(),
            fired: i < SLOW_TOP && sum >= SLOW_MIN_TOTAL,
            message: format!(
                "`{}`: {}×, {}, median {}",
                short(lab),
                rows.len(),
                fmt_dur(sum),
                fmt_dur(p50)
            ),
            numbers: vec![
                ("runs", rows.len() as i64),
                ("total_ms", sum),
                ("p50_ms", p50),
            ],
            spans: spans(rows.iter().copied()),
            weight: sum,
        });
    }
}

fn check_name(row: &Row) -> String {
    row.extra
        .check
        .as_ref()
        .map(|c| c.as_str().to_owned())
        .or_else(|| row.label.clone())
        .unwrap_or_default()
}

/// The check runs under a `change.ci` interval: its children, or the order's checks that overlap it.
fn checks_in<'a>(
    input: &'a RuleInput,
    ci_id: i64,
    ws: Option<&str>,
    from: i64,
    to: i64,
) -> Vec<&'a Row> {
    let checks = input.rows.iter().filter(|r| r.kind == SpanKind::CiCheck);
    let children: Vec<&Row> = checks
        .clone()
        .filter(|r| r.parent_id == Some(ci_id))
        .collect();
    if !children.is_empty() {
        return children;
    }
    checks
        .filter(|r| ws.is_some() && r.workstream_id.as_deref() == ws)
        .filter(|r| r.start_ms < to && r.end_ms > from)
        .collect()
}

fn path_segments(input: &RuleInput, kind: SpanKind) -> Vec<(&str, &PathSegment)> {
    input
        .paths
        .iter()
        .flat_map(|(ws, p)| p.segments.iter().map(move |s| (ws.as_str(), s)))
        .filter(|(_, s)| s.kind == kind)
        .collect()
}

fn ci_check_critical(input: &RuleInput, out: &mut Vec<Candidate>) {
    // name -> (excess, orders)
    let mut excess: BTreeMap<String, (i64, BTreeSet<&str>)> = BTreeMap::new();
    for (ws, seg) in path_segments(input, SpanKind::ChangeCi) {
        let (from, to) = (seg.start_ms.get(), seg.end_ms.get());
        let id = seg.span_id.map_or(-1, Count::get);
        let mut checks = checks_in(input, id, Some(ws), from, to);
        checks.sort_by_key(|r| (r.end_ms, r.id));
        let Some(latest) = checks.last() else {
            continue;
        };
        let second = checks
            .len()
            .checked_sub(2)
            .map_or(from, |i| checks[i].end_ms);
        let clip = |ms: i64| ms.clamp(from, to);
        let add = clip(latest.end_ms) - clip(second);
        if add > 0 {
            let e = excess.entry(check_name(latest)).or_default();
            e.0 += add;
            e.1.insert(ws);
        }
    }
    for (name, (ms, orders)) in excess {
        let runs: Vec<&Row> = input
            .rows
            .iter()
            .filter(|r| r.kind == SpanKind::CiCheck && check_name(r) == name)
            .collect();
        let p50 = pct(&runs.iter().map(|r| r.dur()).collect::<Vec<_>>(), 50);
        out.push(Candidate {
            rule: InsightRule::CiCheckCritical,
            key: name.clone(),
            fired: ms >= CI_CRITICAL_MIN_EXCESS && orders.len() >= CI_CRITICAL_MIN_ORDERS,
            message: format!(
                "CI check `{}` adds {} on the critical path of {} orders (median {} per run)",
                short(&name),
                fmt_dur(ms),
                orders.len(),
                fmt_dur(p50)
            ),
            numbers: vec![
                ("excess_ms", ms),
                ("orders", orders.len() as i64),
                ("p50_ms", p50),
            ],
            spans: spans(runs),
            weight: ms,
        });
    }
}

fn ci_reaction(input: &RuleInput, out: &mut Vec<Candidate>) {
    let mut lags = Vec::new();
    let mut cis = Vec::new();
    for ci in input.rows.iter().filter(|r| r.kind == SpanKind::ChangeCi) {
        let checks = checks_in(
            input,
            ci.id,
            ci.workstream_id.as_deref(),
            ci.start_ms,
            ci.end_ms,
        );
        if let Some(last) = checks.iter().map(|r| r.end_ms).max()
            && last <= ci.end_ms
        {
            lags.push(ci.end_ms - last);
            cis.push(ci);
        }
    }
    if lags.is_empty() {
        return;
    }
    let p50 = pct(&lags, 50);
    out.push(Candidate {
        rule: InsightRule::CiReaction,
        key: String::new(),
        fired: p50 >= CI_REACTION_MIN_P50,
        message: format!(
            "the train noticed green CI {} after it finished (poll every 15 s)",
            fmt_dur(p50)
        ),
        numbers: vec![("p50_ms", p50), ("changes", lags.len() as i64)],
        spans: spans(cis),
        weight: lags.iter().sum(),
    });
}

fn slots_full(input: &RuleInput, out: &mut Vec<Candidate>) {
    let full: Vec<&Row> = input
        .rows
        .iter()
        .filter(|r| r.kind == SpanKind::SlotsFull)
        .filter(|r| {
            r.extra
                .peak_queued
                .is_some_and(|p| p.get() >= SLOTS_MIN_PEAK)
        })
        .collect();
    if full.is_empty() {
        return;
    }
    let dur = total(full.iter().copied());
    let peak = full
        .iter()
        .filter_map(|r| r.extra.peak_queued)
        .map(Count::get)
        .max()
        .unwrap_or(0);
    let cap = full
        .iter()
        .filter_map(|r| r.extra.cap)
        .map(Count::get)
        .max()
        .unwrap_or(input.slot_cap);
    let queued = input.rows.iter().filter(|q| {
        q.kind == SpanKind::QueueSlot
            && full
                .iter()
                .any(|f| q.start_ms < f.end_ms && q.end_ms > f.start_ms)
    });
    out.push(Candidate {
        rule: InsightRule::SlotsFull,
        key: String::new(),
        fired: true,
        message: format!(
            "slots were full for {} while {peak} tasks queued (cap {cap})",
            fmt_dur(dur)
        ),
        numbers: vec![("full_ms", dur), ("peak_queued", peak), ("cap", cap)],
        spans: spans(full.iter().copied().chain(queued)),
        weight: dur,
    });
}

fn human_permission(row: &Row) -> bool {
    row.kind == SpanKind::WaitPermission && row.extra.decided_by == Some(DecidedBy::Human)
}

fn wait_key(row: &Row) -> String {
    row.extra
        .key
        .as_ref()
        .map(|k| k.as_str().to_owned())
        .or_else(|| row.extra.tool.as_ref().map(|t| t.as_str().to_owned()))
        .unwrap_or_else(|| label(row).to_owned())
}

fn human_wait(input: &RuleInput, out: &mut Vec<Candidate>) {
    let waits: Vec<&Row> = input
        .rows
        .iter()
        .filter(|r| r.kind == SpanKind::WaitAsk || human_permission(r))
        .collect();
    let Some(longest) = waits.iter().max_by_key(|r| (r.dur(), -r.id)) else {
        return;
    };
    let sum = total(waits.iter().copied());
    out.push(Candidate {
        rule: InsightRule::HumanWait,
        key: String::new(),
        fired: sum >= HUMAN_WAIT_MIN,
        message: format!(
            "waited {} on your answers ({} asks); longest: `{}` {}",
            fmt_dur(sum),
            waits.len(),
            short(&wait_key(longest)),
            fmt_dur(longest.dur())
        ),
        numbers: vec![
            ("total_ms", sum),
            ("waits", waits.len() as i64),
            ("max_ms", longest.dur()),
        ],
        spans: spans(waits.iter().copied()),
        weight: sum,
    });
}

fn batching_delay(input: &RuleInput, out: &mut Vec<Candidate>) {
    let segs = path_segments(input, SpanKind::AskBatching);
    if segs.is_empty() {
        return;
    }
    let sum: i64 = segs
        .iter()
        .map(|(_, s)| s.end_ms.get() - s.start_ms.get())
        .sum();
    let ids: HashMap<i64, i64> = input.rows.iter().map(|r| (r.id, r.start_ms)).collect();
    let mut sp: Vec<(i64, i64)> = segs
        .iter()
        .filter_map(|(_, s)| s.span_id.map(Count::get))
        .map(|id| (ids.get(&id).copied().unwrap_or(0), id))
        .collect();
    sp.sort_unstable();
    sp.dedup();
    out.push(Candidate {
        rule: InsightRule::BatchingDelay,
        key: String::new(),
        fired: sum >= BATCHING_MIN,
        message: format!(
            "asks sat {} in batches before they were sent to you",
            fmt_dur(sum)
        ),
        numbers: vec![("total_ms", sum), ("segments", segs.len() as i64)],
        spans: sp,
        weight: sum,
    });
}

fn approval_rule(input: &RuleInput, out: &mut Vec<Candidate>) {
    let mut groups: BTreeMap<(String, String), Vec<&Row>> = BTreeMap::new();
    for r in input.rows.iter().filter(|r| human_permission(r)) {
        let tool = r
            .extra
            .tool
            .as_ref()
            .map_or_else(String::new, |t| t.as_str().to_owned());
        let prefix = label(r)
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ");
        groups.entry((tool, prefix)).or_default().push(r);
    }
    for ((tool, prefix), rows) in groups {
        let sum = total(rows.iter().copied());
        out.push(Candidate {
            rule: InsightRule::ApprovalRule,
            key: format!("{tool}|{prefix}"),
            fired: rows.len() >= APPROVAL_MIN_PROMPTS,
            message: format!(
                "{} `{tool}` prompts for `{}` waited {}; a project tool rule `{tool}({}:*)` would answer them at once",
                rows.len(),
                short(&prefix),
                fmt_dur(sum),
                short(&prefix)
            ),
            numbers: vec![("prompts", rows.len() as i64), ("total_ms", sum)],
            spans: spans(rows.iter().copied()),
            weight: sum,
        });
    }
}

fn usage_parks(input: &RuleInput, out: &mut Vec<Candidate>) {
    let parks: Vec<&Row> = input
        .rows
        .iter()
        .filter(|r| r.kind == SpanKind::ParkUsage)
        .collect();
    if parks.is_empty() {
        return;
    }
    let sum = total(parks.iter().copied());
    let machines: BTreeSet<&str> = parks
        .iter()
        .filter_map(|r| r.machine_id.as_deref())
        .collect();
    out.push(Candidate {
        rule: InsightRule::UsageParks,
        key: String::new(),
        fired: sum >= USAGE_PARKS_MIN,
        message: format!(
            "parked on usage limits for {} ({} parks, {})",
            fmt_dur(sum),
            parks.len(),
            machines.into_iter().collect::<Vec<_>>().join(", ")
        ),
        numbers: vec![("total_ms", sum), ("parks", parks.len() as i64)],
        spans: spans(parks.iter().copied()),
        weight: sum,
    });
}

fn retries(input: &RuleInput, out: &mut Vec<Candidate>) {
    let rows: Vec<&Row> = input
        .rows
        .iter()
        .filter(|r| matches!(r.kind, SpanKind::WaitRetryApi | SpanKind::WaitRetryNode))
        .collect();
    if rows.is_empty() {
        return;
    }
    let sum = total(rows.iter().copied());
    let mut by_status: BTreeMap<Option<i64>, i64> = BTreeMap::new();
    for r in &rows {
        *by_status
            .entry(r.extra.http_status.map(Count::get))
            .or_default() += 1;
    }
    let mut counts: Vec<(Option<i64>, i64)> = by_status.into_iter().collect();
    counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let parts: Vec<String> = counts
        .iter()
        .map(|(s, n)| match s {
            Some(s) => format!("{s} ×{n}"),
            None => format!("other ×{n}"),
        })
        .collect();
    out.push(Candidate {
        rule: InsightRule::Retries,
        key: String::new(),
        fired: sum >= RETRIES_MIN,
        message: format!("API retries cost {} ({})", fmt_dur(sum), parts.join(", ")),
        numbers: vec![("total_ms", sum), ("retries", rows.len() as i64)],
        spans: spans(rows.iter().copied()),
        weight: sum,
    });
}

fn review_share(input: &RuleInput, out: &mut Vec<Candidate>) {
    if input.paths.is_empty() {
        return;
    }
    let path_ms: i64 = input
        .paths
        .iter()
        .map(|(_, p)| p.end_ms.get() - p.start_ms.get())
        .sum();
    let review_ms: i64 = path_segments(input, SpanKind::ChangeReview)
        .iter()
        .map(|(_, s)| s.end_ms.get() - s.start_ms.get())
        .sum();
    let share = if path_ms > 0 {
        review_ms * 100 / path_ms
    } else {
        0
    };
    let reviews: Vec<&Row> = input
        .rows
        .iter()
        .filter(|r| r.kind == SpanKind::ChangeReview)
        .collect();
    let p50 = pct(&reviews.iter().map(|r| r.dur()).collect::<Vec<_>>(), 50);
    let mut rounds: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    for r in &reviews {
        *rounds
            .entry((r.workstream_id.as_deref().unwrap_or(""), r.lane.as_str()))
            .or_default() += 1;
    }
    let k = rounds
        .iter()
        .filter(|(_, n)| **n >= 2)
        .map(|((ws, _), _)| *ws)
        .collect::<BTreeSet<_>>()
        .len();
    out.push(Candidate {
        rule: InsightRule::ReviewShare,
        key: String::new(),
        fired: share >= REVIEW_SHARE_MIN_PCT && input.paths.len() >= REVIEW_SHARE_MIN_ORDERS,
        message: format!(
            "reviews were {share}% of the critical path; median round {}; {k} orders needed 2+ rounds",
            fmt_dur(p50)
        ),
        numbers: vec![
            ("pct", share),
            ("review_ms", review_ms),
            ("p50_ms", p50),
            ("orders_2plus", k as i64),
        ],
        spans: spans(reviews.iter().copied()),
        weight: review_ms,
    });
}

fn repo_of(lane: &str) -> &str {
    let lane = lane.strip_prefix("change:").unwrap_or(lane);
    lane.split('#').next().unwrap_or(lane)
}

fn train_line(input: &RuleInput, out: &mut Vec<Candidate>) {
    let mut groups: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in input
        .rows
        .iter()
        .filter(|r| r.kind == SpanKind::ChangeQueue)
    {
        groups.entry(repo_of(&r.lane)).or_default().push(r);
    }
    for (repo, rows) in groups {
        let sum = total(rows.iter().copied());
        out.push(Candidate {
            rule: InsightRule::TrainLine,
            key: repo.to_owned(),
            fired: sum >= TRAIN_LINE_MIN,
            message: format!(
                "PRs waited {} behind others in the `{}` train",
                fmt_dur(sum),
                short(repo)
            ),
            numbers: vec![("total_ms", sum), ("waits", rows.len() as i64)],
            spans: spans(rows.iter().copied()),
            weight: sum,
        });
    }
}

fn rebase_loops(input: &RuleInput, out: &mut Vec<Candidate>) {
    let mut by_lane: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in input.rows.iter().filter(|r| {
        r.kind == SpanKind::ChangeBlocked
            && r.extra
                .reason
                .as_ref()
                .is_some_and(|x| x.as_str() == "needs_rebase")
    }) {
        by_lane.entry(r.lane.as_str()).or_default().push(r);
    }
    let looped: Vec<&Row> = by_lane
        .values()
        .filter(|v| v.len() >= REBASE_MIN_BLOCKS)
        .flatten()
        .copied()
        .collect();
    let k = by_lane
        .values()
        .filter(|v| v.len() >= REBASE_MIN_BLOCKS)
        .count();
    if by_lane.is_empty() {
        return;
    }
    let sum = total(looped.iter().copied());
    out.push(Candidate {
        rule: InsightRule::RebaseLoops,
        key: String::new(),
        fired: k >= 1,
        message: format!(
            "{k} PRs needed {} rebases by their authors ({} blocked)",
            looped.len(),
            fmt_dur(sum)
        ),
        numbers: vec![
            ("prs", k as i64),
            ("rebases", looped.len() as i64),
            ("total_ms", sum),
        ],
        spans: spans(looped.iter().copied()),
        weight: sum,
    });
}

fn first_token(input: &RuleInput, out: &mut Vec<Candidate>) {
    let rows: Vec<&Row> = input
        .rows
        .iter()
        .filter(|r| r.kind == SpanKind::ModelFirstToken)
        .collect();
    if rows.is_empty() {
        return;
    }
    let durs: Vec<i64> = rows.iter().map(|r| r.dur()).collect();
    let (p50, p90) = (pct(&durs, 50), pct(&durs, 90));
    let ft: i64 = rows.iter().map(|r| r.excl_ms).sum();
    let model: i64 = input
        .rows
        .iter()
        .filter(|r| r.cat() == fleetd_contracts::time::Category::Model)
        .map(|r| r.excl_ms)
        .sum();
    let share = if model > 0 { ft * 100 / model } else { 0 };
    let mut slowest = rows.clone();
    slowest.sort_by_key(|r| (-r.dur(), r.id));
    slowest.truncate(20);
    out.push(Candidate {
        rule: InsightRule::FirstToken,
        key: String::new(),
        fired: rows.len() >= FIRST_TOKEN_MIN_MESSAGES && p90 >= FIRST_TOKEN_MIN_P90,
        message: format!(
            "the model took {} to start answering (p90 {}); {share}% of model time",
            fmt_dur(p50),
            fmt_dur(p90)
        ),
        numbers: vec![
            ("p50_ms", p50),
            ("p90_ms", p90),
            ("messages", rows.len() as i64),
            ("pct", share),
        ],
        spans: spans(slowest),
        weight: ft,
    });
}

fn startup(input: &RuleInput, out: &mut Vec<Candidate>) {
    let rows: Vec<&Row> = input
        .rows
        .iter()
        .filter(|r| r.kind == SpanKind::RunStartup)
        .collect();
    if rows.is_empty() {
        return;
    }
    let p50 = pct(&rows.iter().map(|r| r.dur()).collect::<Vec<_>>(), 50);
    out.push(Candidate {
        rule: InsightRule::Startup,
        key: String::new(),
        fired: p50 >= STARTUP_MIN_P50,
        message: format!(
            "starting claude took {} per run ({} runs)",
            fmt_dur(p50),
            rows.len()
        ),
        numbers: vec![("p50_ms", p50), ("runs", rows.len() as i64)],
        spans: spans(rows.iter().copied()),
        weight: total(rows.iter().copied()),
    });
}

/// The length of the union of the rows' intervals.
fn union_ms(rows: &[&Row]) -> i64 {
    let mut iv: Vec<(i64, i64)> = rows.iter().map(|r| (r.start_ms, r.end_ms)).collect();
    iv.sort_unstable();
    let (mut sum, mut cur): (i64, Option<(i64, i64)>) = (0, None);
    for (s, e) in iv {
        cur = match cur {
            Some((cs, ce)) if s <= ce => Some((cs, ce.max(e))),
            Some((cs, ce)) => {
                sum += ce - cs;
                Some((s, e))
            }
            None => Some((s, e)),
        };
    }
    sum + cur.map_or(0, |(s, e)| e - s)
}

fn offline(input: &RuleInput, out: &mut Vec<Candidate>) {
    let mut groups: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in input
        .rows
        .iter()
        .filter(|r| matches!(r.kind, SpanKind::WaitOffline | SpanKind::QueueOffline))
    {
        groups
            .entry(r.machine_id.as_deref().unwrap_or("a machine"))
            .or_default()
            .push(r);
    }
    for (machine, rows) in groups {
        let dur = union_ms(&rows);
        out.push(Candidate {
            rule: InsightRule::Offline,
            key: machine.to_owned(),
            fired: dur >= OFFLINE_MIN,
            message: format!(
                "{machine} was offline for {} while work waited for it",
                fmt_dur(dur)
            ),
            numbers: vec![("offline_ms", dur), ("waits", rows.len() as i64)],
            spans: spans(rows.iter().copied()),
            weight: dur,
        });
    }
}

fn coverage(input: &RuleInput, out: &mut Vec<Candidate>) {
    let gaps: Vec<&Row> = input
        .rows
        .iter()
        .filter(|r| r.kind == SpanKind::Gap)
        .collect();
    if gaps.is_empty() {
        return;
    }
    let lanes: BTreeSet<&str> = gaps.iter().map(|r| r.lane.as_str()).collect();
    let lost: i64 = gaps
        .iter()
        .filter_map(|r| r.extra.count)
        .map(Count::get)
        .sum();
    let why = if lost > 0 {
        format!("{lost} spans lost")
    } else {
        gaps.iter()
            .find_map(|r| r.extra.reason.as_ref().map(|x| x.as_str().to_owned()))
            .unwrap_or_else(|| "spans lost".into())
    };
    out.push(Candidate {
        rule: InsightRule::Coverage,
        key: String::new(),
        fired: true,
        message: format!("timeline incomplete for {} sessions ({why})", lanes.len()),
        numbers: vec![("sessions", lanes.len() as i64), ("lost", lost)],
        spans: spans(gaps.iter().copied()),
        weight: total(gaps.iter().copied()),
    });
}

fn candidates(input: &RuleInput) -> Vec<Candidate> {
    let mut out = Vec::new();
    full_suite_repeat(input, &mut out);
    repeat_no_change(input, &mut out);
    failing_repeat(input, &mut out);
    slow_commands(input, &mut out);
    ci_check_critical(input, &mut out);
    ci_reaction(input, &mut out);
    slots_full(input, &mut out);
    human_wait(input, &mut out);
    batching_delay(input, &mut out);
    approval_rule(input, &mut out);
    usage_parks(input, &mut out);
    retries(input, &mut out);
    review_share(input, &mut out);
    train_line(input, &mut out);
    rebase_loops(input, &mut out);
    first_token(input, &mut out);
    startup(input, &mut out);
    offline(input, &mut out);
    coverage(input, &mut out);
    out
}

fn numbers(n: &[(&'static str, i64)]) -> List<InsightNumber, 0, 12> {
    List::unchecked(
        n.iter()
            .take(12)
            .map(|(name, v)| InsightNumber {
                name: Line::unchecked(*name),
                value: AnyInt::unchecked(*v),
            })
            .collect(),
    )
}

fn zeros(n: &[(&'static str, i64)]) -> Vec<(&'static str, i64)> {
    n.iter().map(|(k, _)| (*k, 0)).collect()
}

fn message(m: &str) -> Text<1, 600> {
    let mut s = m.to_owned();
    while js_len(&s) > 600 {
        s.pop();
    }
    if s.is_empty() {
        s.push('-');
    }
    Text::unchecked(s)
}

fn to_insight(c: &Candidate) -> Insight {
    Insight {
        rule: c.rule,
        message: message(&c.message),
        numbers: numbers(&c.numbers),
        span_ids: List::unchecked(
            c.spans
                .iter()
                .take(MAX_SPAN_IDS)
                .map(|(_, id)| Count::unchecked(*id))
                .collect(),
        ),
        compare: None,
        fired_in: None,
    }
}

/// Strongest first: the time a finding names, then rule name and key, so the order never depends on input order.
fn rank(found: &mut [(i64, Candidate)]) {
    found.sort_by(|(wa, a), (wb, b)| {
        wb.cmp(wa)
            .then_with(|| rule_name(a.rule).cmp(&rule_name(b.rule)))
            .then_with(|| a.key.cmp(&b.key))
    });
}

/// Every rule that fires on `input`, strongest first, at most 30.
pub fn insights(input: &RuleInput) -> Vec<Insight> {
    let mut found: Vec<(i64, Candidate)> = candidates(input)
        .into_iter()
        .filter(|c| c.fired)
        .map(|c| (c.weight, c))
        .collect();
    rank(&mut found);
    found
        .iter()
        .take(MAX_INSIGHTS)
        .map(|(_, c)| to_insight(c))
        .collect()
}

/// `insights` for the current period, with each finding's numbers for the compare period beside it. A rule that
/// fires in only one period still shows its numbers for the other.
pub fn compare(current: &RuleInput, previous: &RuleInput) -> Vec<Insight> {
    let key = |c: &Candidate| (rule_name(c.rule), c.key.clone());
    let cur: BTreeMap<_, Candidate> = candidates(current)
        .into_iter()
        .map(|c| (key(&c), c))
        .collect();
    let prev: BTreeMap<_, Candidate> = candidates(previous)
        .into_iter()
        .map(|c| (key(&c), c))
        .collect();
    let keys: BTreeSet<_> = cur
        .iter()
        .chain(prev.iter())
        .filter(|(_, c)| c.fired)
        .map(|(k, _)| k.clone())
        .collect();
    let mut found: Vec<(i64, Candidate, Option<&Candidate>, FiredIn)> = keys
        .into_iter()
        .map(|k| {
            let (c, p) = (cur.get(&k), prev.get(&k));
            let fired = match (c.is_some_and(|c| c.fired), p.is_some_and(|p| p.fired)) {
                (true, true) => FiredIn::Both,
                (true, false) => FiredIn::Current,
                _ => FiredIn::Compare,
            };
            let shown = match fired {
                FiredIn::Compare => p.expect("fired there"),
                _ => c.expect("fired here"),
            };
            let mut main = shown.clone();
            main.numbers = c.map_or_else(|| zeros(&shown.numbers), |c| c.numbers.clone());
            let weight = c.map_or(0, |c| c.weight).max(p.map_or(0, |p| p.weight));
            (weight, main, p, fired)
        })
        .collect();
    found.sort_by(|(wa, a, ..), (wb, b, ..)| {
        wb.cmp(wa)
            .then_with(|| rule_name(a.rule).cmp(&rule_name(b.rule)))
            .then_with(|| a.key.cmp(&b.key))
    });
    found
        .iter()
        .take(MAX_INSIGHTS)
        .map(|(_, main, p, fired)| {
            let mut insight = to_insight(main);
            let other = p.map_or_else(|| zeros(&main.numbers), |p| p.numbers.clone());
            insight.compare = Some(numbers(&other));
            insight.fired_in = Some(*fired);
            insight
        })
        .collect()
}

/// The span ids a rule links to on `input`, all of them, oldest first (for `time_spans { rule }`).
pub fn rule_spans(input: &RuleInput, rule: InsightRule) -> Vec<i64> {
    let mut all: Vec<(i64, i64)> = candidates(input)
        .into_iter()
        .filter(|c| c.fired && c.rule == rule)
        .flat_map(|c| c.spans)
        .collect();
    all.sort_unstable();
    all.dedup();
    all.into_iter().map(|(_, id)| id).collect()
}
