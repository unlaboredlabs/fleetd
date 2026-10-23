use std::collections::HashMap;

use fleetd_contracts::time::{Category, CriticalPath, FiredIn, Insight, InsightRule, SpanKind};

use super::model::{PathInput, Row, RuleInput};
use super::path::critical_path;
use super::rules::{compare, fmt_dur, insights, rule_spans};

const MIN: i64 = 60_000;

fn row(id: i64, kind: SpanKind, lane: &str, start: i64, end: i64) -> Row {
    Row {
        id,
        kind,
        start_ms: start,
        end_ms: end,
        excl_ms: end - start,
        lane: lane.into(),
        thread_id: Some(lane.into()),
        ..Row::default()
    }
}

fn cmd(id: i64, lane: &str, start: i64, end: i64, label: &str) -> Row {
    Row {
        label: Some(label.into()),
        family: Some(
            label
                .split_whitespace()
                .take(2)
                .collect::<Vec<_>>()
                .join(" "),
        ),
        ..row(id, SpanKind::ToolBash, lane, start, end)
    }
}

fn path(start: i64, end: i64, rows: Vec<Row>) -> CriticalPath {
    critical_path(&PathInput {
        start_ms: start,
        end_ms: end,
        rows,
        waits_on: HashMap::new(),
    })
}

/// (lane, kind, start, end) per segment.
fn segs(p: &CriticalPath) -> Vec<(String, SpanKind, i64, i64)> {
    p.segments
        .iter()
        .map(|s| (s.lane.to_string(), s.kind, s.start_ms.get(), s.end_ms.get()))
        .collect()
}

fn path_len(p: &CriticalPath) -> i64 {
    p.segments
        .iter()
        .map(|s| s.end_ms.get() - s.start_ms.get())
        .sum()
}

fn total(p: &CriticalPath, cat: Category) -> i64 {
    p.totals
        .iter()
        .find(|t| t.cat == cat)
        .map_or(0, |t| t.ms.get())
}

#[test]
fn a_serial_chain_is_the_whole_path() {
    let p = path(
        0,
        30,
        vec![
            row(1, SpanKind::ToolBash, "a", 0, 10),
            row(2, SpanKind::ModelOutput, "b", 10, 30),
        ],
    );
    assert_eq!(
        segs(&p),
        vec![
            ("a".into(), SpanKind::ToolBash, 0, 10),
            ("b".into(), SpanKind::ModelOutput, 10, 30)
        ]
    );
    assert_eq!(path_len(&p), 30);
    assert_eq!(p.off_path_ms.get(), 0);
}

#[test]
fn parallel_writers_put_only_the_last_finisher_on_the_path() {
    let p = path(
        0,
        30,
        vec![
            row(1, SpanKind::ToolBash, "a", 0, 20),
            row(2, SpanKind::ToolBash, "b", 0, 30),
        ],
    );
    assert_eq!(segs(&p), vec![("b".into(), SpanKind::ToolBash, 0, 30)]);
    assert_eq!(p.off_path_ms.get(), 20);
}

#[test]
fn waits_in_parallel_count_once_on_the_path() {
    let p = path(
        0,
        20,
        vec![
            row(1, SpanKind::QueueSlot, "a", 0, 10),
            row(2, SpanKind::QueueSlot, "b", 0, 10),
            row(3, SpanKind::ToolBash, "a", 10, 20),
            row(4, SpanKind::ToolBash, "b", 10, 20),
        ],
    );
    assert_eq!(total(&p, Category::Queue), 10);
    assert_eq!(path_len(&p), 20);
    assert_eq!(p.off_path_ms.get(), 20);
}

#[test]
fn time_with_nothing_running_is_a_gap() {
    let p = path(
        0,
        40,
        vec![
            row(1, SpanKind::ToolBash, "a", 0, 10),
            row(2, SpanKind::ToolBash, "b", 20, 30),
        ],
    );
    assert_eq!(
        segs(&p),
        vec![
            ("a".into(), SpanKind::ToolBash, 0, 10),
            ("none".into(), SpanKind::Gap, 10, 20),
            ("b".into(), SpanKind::ToolBash, 20, 30),
            ("none".into(), SpanKind::Gap, 30, 40),
        ]
    );
    assert_eq!(p.nothing_running_ms.get(), 20);
    assert_eq!(path_len(&p), 40);
}

#[test]
fn ties_break_on_causal_edge_then_category_then_id() {
    // Both lanes end at 10: the human wait wins over the model.
    let p = path(
        0,
        10,
        vec![
            row(5, SpanKind::ModelOutput, "a", 0, 10),
            row(6, SpanKind::WaitRequest, "b", 0, 10),
        ],
    );
    assert_eq!(segs(&p)[0].1, SpanKind::WaitRequest);
    // Same category: the lower span id.
    let p = path(
        0,
        10,
        vec![
            row(8, SpanKind::ToolBash, "a", 0, 10),
            row(7, SpanKind::ToolRead, "b", 0, 10),
        ],
    );
    assert_eq!(segs(&p)[0].0, "b");
    // The lane the current segment waits on wins over a better category.
    let rows = vec![
        row(1, SpanKind::ModelOutput, "lead", 0, 10),
        row(2, SpanKind::WaitRequest, "other", 0, 10),
        row(3, SpanKind::ToolBash, "task", 10, 20),
    ];
    let mut waits_on = HashMap::new();
    waits_on.insert("task".to_owned(), vec!["lead".to_owned()]);
    let p = critical_path(&PathInput {
        start_ms: 0,
        end_ms: 20,
        rows,
        waits_on,
    });
    assert_eq!(segs(&p)[0].0, "lead");
}

#[test]
fn lanes_are_cut_into_exclusive_tiles() {
    let p = path(
        0,
        20,
        vec![
            Row {
                excl_ms: 0,
                ..row(1, SpanKind::Run, "a", 0, 20)
            },
            row(2, SpanKind::ToolBash, "a", 2, 12),
            row(3, SpanKind::WaitPermission, "a", 4, 8),
        ],
    );
    assert_eq!(
        segs(&p),
        vec![
            ("a".into(), SpanKind::ClaudeOther, 0, 2),
            ("a".into(), SpanKind::ToolBash, 2, 4),
            ("a".into(), SpanKind::WaitPermission, 4, 8),
            ("a".into(), SpanKind::ToolBash, 8, 12),
            ("a".into(), SpanKind::ClaudeOther, 12, 20),
        ]
    );
    assert_eq!(total(&p, Category::Human), 4);
}

#[test]
fn the_same_input_gives_the_same_path_and_segments_sum_to_wall() {
    let mut rows = Vec::new();
    for i in 0..200 {
        let lane = format!("l{}", i % 7);
        rows.push(row(
            i,
            SpanKind::ToolBash,
            &lane,
            i * 13 % 900,
            i * 13 % 900 + 50 + i % 11,
        ));
    }
    let a = path(5, 1000, rows.clone());
    rows.reverse();
    let b = path(5, 1000, rows);
    assert_eq!(a, b);
    assert_eq!(path_len(&a), 995);
    let mut t = 5;
    for s in a.segments.iter() {
        assert_eq!(s.start_ms.get(), t);
        t = s.end_ms.get();
    }
    assert_eq!(t, 1000);
}

// Rules.

fn input(rows: Vec<Row>) -> RuleInput {
    RuleInput {
        rows,
        ..RuleInput::default()
    }
}

fn fired(input: &RuleInput, rule: InsightRule) -> Vec<Insight> {
    let a = insights(input);
    assert_eq!(a, insights(input), "same input, same findings");
    a.into_iter().filter(|i| i.rule == rule).collect()
}

fn num(i: &Insight, name: &str) -> i64 {
    i.numbers
        .iter()
        .find(|n| n.name.as_str() == name)
        .unwrap()
        .value
        .get()
}

fn suite_runs(n: i64, each: i64, edit_between: bool) -> Vec<Row> {
    let mut rows = Vec::new();
    for i in 0..n {
        let s = i * 10 * MIN;
        rows.push(cmd(i + 1, "t1", s, s + each, "cargo test --workspace"));
        if edit_between {
            rows.push(row(
                100 + i,
                SpanKind::ToolEdit,
                "t1",
                s + each + 1,
                s + each + 2,
            ));
        }
    }
    rows
}

#[test]
fn full_suite_repeat_fires_at_five_runs_and_ten_minutes() {
    let found = fired(
        &input(suite_runs(5, 2 * MIN, false)),
        InsightRule::FullSuiteRepeat,
    );
    assert_eq!(found.len(), 1);
    assert_eq!(
        found[0].message.as_str(),
        "agents ran the full test suite `cargo test --workspace` 5× (10m); 4 runs followed no edit since the previous run"
    );
    assert!(
        fired(
            &input(suite_runs(4, 3 * MIN, false)),
            InsightRule::FullSuiteRepeat
        )
        .is_empty()
    );
    assert!(
        fired(
            &input(suite_runs(5, 2 * MIN - 1000, false)),
            InsightRule::FullSuiteRepeat
        )
        .is_empty()
    );
    let edited = fired(
        &input(suite_runs(5, 2 * MIN, true)),
        InsightRule::FullSuiteRepeat,
    );
    assert_eq!(num(&edited[0], "no_edit"), 0);
    // A filtered run is not the full suite.
    let filtered: Vec<Row> = (0..6)
        .map(|i| {
            cmd(
                i,
                "t1",
                i * 10 * MIN,
                i * 10 * MIN + 3 * MIN,
                "cargo test -p fleetd",
            )
        })
        .collect();
    assert!(fired(&input(filtered), InsightRule::FullSuiteRepeat).is_empty());
}

#[test]
fn repeat_no_change_needs_three_runs_without_an_edit() {
    let mut i = input(suite_runs(3, MIN, false));
    i.rows
        .iter_mut()
        .for_each(|r| r.task_id = Some("T88".into()));
    i.task_titles
        .insert("T88".into(), "add the login page".into());
    let found = fired(&i, InsightRule::RepeatNoChange);
    assert_eq!(
        found[0].message.as_str(),
        "`cargo test --workspace` ran 3× in a row in T88 add the login page with nothing changed between runs (3m)"
    );
    assert!(
        fired(
            &input(suite_runs(2, MIN, false)),
            InsightRule::RepeatNoChange
        )
        .is_empty()
    );
    assert!(
        fired(
            &input(suite_runs(3, MIN, true)),
            InsightRule::RepeatNoChange
        )
        .is_empty()
    );
}

#[test]
fn slow_commands_lists_labels_over_two_minutes() {
    let rows = vec![
        cmd(1, "t1", 0, MIN, "npm run build"),
        cmd(2, "t2", 0, MIN, "npm run build"),
        cmd(3, "t1", 2 * MIN, 2 * MIN + 119_000, "ls -la"),
    ];
    let found = fired(&input(rows), InsightRule::SlowCommands);
    assert_eq!(found.len(), 1);
    assert_eq!(
        found[0].message.as_str(),
        "`npm run build`: 2×, 2m, median 1m"
    );
}

#[test]
fn compare_shows_both_periods_also_when_only_one_fired() {
    let now = input(suite_runs(2, 2 * MIN, false));
    let before = input(suite_runs(6, 2 * MIN, false));
    let found = compare(&now, &before);
    let suite = found
        .iter()
        .find(|i| i.rule == InsightRule::FullSuiteRepeat)
        .unwrap();
    assert_eq!(suite.fired_in, Some(FiredIn::Compare));
    assert_eq!(num(suite, "runs"), 2);
    let prev = suite.compare.as_ref().unwrap();
    assert_eq!(
        prev.iter()
            .find(|n| n.name.as_str() == "runs")
            .unwrap()
            .value
            .get(),
        6
    );
    assert_eq!(compare(&now, &before), found);
}

#[test]
fn rule_spans_lists_every_linked_span_oldest_first() {
    let i = input(suite_runs(6, 2 * MIN, false));
    assert_eq!(
        rule_spans(&i, InsightRule::FullSuiteRepeat),
        vec![1, 2, 3, 4, 5, 6]
    );
}

#[test]
fn durations_read_like_people_write_them() {
    assert_eq!(fmt_dur(34_000), "34s");
    assert_eq!(fmt_dur(130_000), "2m10s");
    assert_eq!(fmt_dur(51 * MIN), "51m");
    assert_eq!(fmt_dur(72 * MIN), "1h12m");
    assert_eq!(fmt_dur(60 * MIN), "1h");
}

/// A long order keeps its last stages: the path the rules and `time_paths` read has every segment, and the tool
/// output keeps the longest ones, so the review and CI at the end survive a writer's hundreds of tool calls.
#[test]
fn a_long_order_keeps_its_review_and_ci_on_the_path() {
    let mut rows: Vec<Row> = (0..600)
        .map(|i| {
            let kind = if i % 2 == 0 {
                SpanKind::ToolBash
            } else {
                SpanKind::ModelOutput
            };
            Row {
                label: Some(format!("step {i}")),
                ..row(i + 1, kind, "thread:w", i * 1_000, (i + 1) * 1_000)
            }
        })
        .collect();
    rows.push(row(
        1_000,
        SpanKind::ChangeReview,
        "change:acme/storefront#1",
        600_000,
        900_000,
    ));
    rows.push(row(
        1_001,
        SpanKind::ChangeCi,
        "change:acme/storefront#1",
        900_000,
        1_500_000,
    ));
    let full = path(0, 1_500_000, rows);
    assert_eq!(full.segments.len(), 602);
    assert!(!full.segments_truncated);
    assert_eq!(path_len(&full), 1_500_000);
    let shown = super::path::for_output(&full);
    assert_eq!(shown.segments.len(), super::path::MAX_SEGMENTS);
    assert!(shown.segments_truncated);
    let kinds: Vec<SpanKind> = shown.segments.iter().map(|s| s.kind).collect();
    assert!(kinds.contains(&SpanKind::ChangeCi) && kinds.contains(&SpanKind::ChangeReview));
    assert!(
        shown
            .segments
            .windows(2)
            .all(|w| w[0].start_ms.get() <= w[1].start_ms.get())
    );
    let pipeline = shown
        .totals
        .iter()
        .find(|t| t.cat == Category::Pipeline)
        .unwrap();
    let ci = pipeline
        .kinds
        .as_ref()
        .unwrap()
        .iter()
        .find(|k| k.kind == SpanKind::ChangeCi)
        .unwrap();
    assert_eq!(ci.ms.get(), 600_000);
    // Stored and read back past the wire's bound.
    let stored = serde_json::to_string(&full).unwrap();
    assert_eq!(
        super::path::decode_stored(&stored).unwrap().segments.len(),
        602
    );
}

/// A wake that waited while the lead was mid-turn never takes the model's place on the path.
#[test]
fn a_wake_mid_turn_yields_to_the_model_on_the_path() {
    let p = path(
        0,
        100,
        vec![
            row(1, SpanKind::ModelOutput, "thread:lead", 0, 80),
            row(2, SpanKind::WakeDebounce, "thread:lead", 50, 100),
        ],
    );
    assert_eq!(
        segs(&p),
        vec![
            ("thread:lead".into(), SpanKind::ModelOutput, 0, 80),
            ("thread:lead".into(), SpanKind::WakeDebounce, 80, 100),
        ]
    );
}
