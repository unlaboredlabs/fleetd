//! The insight rules (spec §6): deterministic aggregates over a period's spans, never a model. Thresholds are the
//! constants below, and every finding carries the numbers it was built from.
use std::collections::{BTreeMap, BTreeSet};

use fleetd_contracts::prim::{AnyInt, Count, Line, List, Text, js_len};
use fleetd_contracts::time::{FiredIn, Insight, InsightNumber, InsightRule, SpanKind};

use super::model::{Row, RuleInput};

const MIN: i64 = 60_000;
const SEC: i64 = 1_000;

pub const FULL_SUITE_MIN_RUNS: usize = 5;
pub const FULL_SUITE_MIN_TOTAL: i64 = 10 * MIN;
pub const REPEAT_MIN_RUNS: usize = 3;
pub const SLOW_MIN_TOTAL: i64 = 2 * MIN;
pub const SLOW_TOP: usize = 10;
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

/// The longest streak per (thread, label) of runs of that label with nothing edited between them.
fn streaks(input: &RuleInput) -> Vec<Vec<&Row>> {
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
                if let Some(prev) = cur.last()
                    && edited_between(e, prev.start_ms, r.start_ms)
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
    for runs in streaks(input) {
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

fn candidates(input: &RuleInput) -> Vec<Candidate> {
    let mut out = Vec::new();
    full_suite_repeat(input, &mut out);
    repeat_no_change(input, &mut out);
    slow_commands(input, &mut out);
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
