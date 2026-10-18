use std::collections::HashMap;

use fleetd_contracts::prim::{Count, Text};
use fleetd_contracts::time::{
    Category, CriticalPath, DecidedBy, FiredIn, Insight, InsightRule, SpanExtra, SpanKind,
};

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
            row(6, SpanKind::WaitAsk, "b", 0, 10),
        ],
    );
    assert_eq!(segs(&p)[0].1, SpanKind::WaitAsk);
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
        row(2, SpanKind::WaitAsk, "other", 0, 10),
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
        since_ms: 0,
        until_ms: 1_000 * MIN,
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
fn failing_repeat_counts_non_zero_exits_in_a_row() {
    let runs = |n: i64| -> Vec<Row> {
        (0..n)
            .map(|i| Row {
                exit_code: Some(101),
                ..cmd(i, "t1", i * MIN, i * MIN + 1000, "npm run build")
            })
            .collect()
    };
    let found = fired(&input(runs(3)), InsightRule::FailingRepeat);
    assert_eq!(
        found[0].message.as_str(),
        "`npm run build` failed 3× in a row in thread t1 (3s)"
    );
    let mut broken = runs(3);
    broken[1].exit_code = Some(0);
    assert!(fired(&input(broken), InsightRule::FailingRepeat).is_empty());
    assert!(fired(&input(runs(2)), InsightRule::FailingRepeat).is_empty());
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

fn ci_order(
    ws: &str,
    base: i64,
    ci_id: i64,
    checks: &[(&str, i64, i64)],
) -> (Vec<Row>, CriticalPath) {
    let end = base + checks.iter().map(|c| c.2).max().unwrap() + 20_000;
    let mut rows = vec![Row {
        workstream_id: Some(ws.into()),
        ..row(
            ci_id,
            SpanKind::ChangeCi,
            &format!("change:acme/storefront#{ci_id}"),
            base,
            end,
        )
    }];
    for (i, (name, s, e)) in checks.iter().enumerate() {
        rows.push(Row {
            workstream_id: Some(ws.into()),
            parent_id: Some(ci_id),
            excl_ms: 0,
            extra: SpanExtra {
                check: Some(Text::unchecked(*name)),
                ..SpanExtra::default()
            },
            ..row(
                ci_id * 10 + i as i64,
                SpanKind::CiCheck,
                "check",
                base + s,
                base + e,
            )
        });
    }
    let p = path(base, end, rows.clone());
    (rows, p)
}

#[test]
fn ci_check_critical_sums_the_last_checks_excess_over_orders() {
    let make = |excess: i64| {
        let mut i = input(Vec::new());
        for (n, ws) in ["W1", "W2"].iter().enumerate() {
            let base = n as i64 * 100 * MIN;
            let (rows, p) = ci_order(
                ws,
                base,
                n as i64 + 1,
                &[
                    ("rust (linux)", 0, 5 * MIN),
                    ("rust (macos)", 0, 5 * MIN + excess),
                ],
            );
            i.rows.extend(rows);
            i.paths.push((ws.to_string(), p));
        }
        i
    };
    let found = fired(&make(90_000), InsightRule::CiCheckCritical);
    assert_eq!(
        found[0].message.as_str(),
        "CI check `rust (macos)` adds 3m on the critical path of 2 orders (median 6m30s per run)"
    );
    assert!(fired(&make(89_000), InsightRule::CiCheckCritical).is_empty());
}

#[test]
fn ci_reaction_is_the_median_lag_after_the_last_check() {
    let (rows, _) = ci_order("W1", 0, 1, &[("ci", 0, MIN)]);
    // The order's change.ci ends 20 s after its last check: under the 30 s threshold.
    assert!(fired(&input(rows.clone()), InsightRule::CiReaction).is_empty());
    let mut slow = rows;
    slow[0].end_ms += 10_000;
    let found = fired(&input(slow), InsightRule::CiReaction);
    assert_eq!(
        found[0].message.as_str(),
        "the train noticed green CI 30s after it finished (poll every 15 s)"
    );
}

#[test]
fn slots_full_needs_a_queued_task() {
    let full = |peak: i64| Row {
        excl_ms: 0,
        extra: SpanExtra {
            peak_queued: Some(Count::unchecked(peak)),
            cap: Some(Count::unchecked(40)),
            ..SpanExtra::default()
        },
        ..row(1, SpanKind::SlotsFull, "fleet", 0, 40 * MIN)
    };
    let found = fired(&input(vec![full(3)]), InsightRule::SlotsFull);
    assert_eq!(
        found[0].message.as_str(),
        "slots were full for 40m while 3 tasks queued (cap 40)"
    );
    assert!(fired(&input(vec![full(0)]), InsightRule::SlotsFull).is_empty());
}

fn ask(id: i64, dur: i64, key: &str) -> Row {
    Row {
        extra: SpanExtra {
            key: Some(Text::unchecked(key)),
            ..SpanExtra::default()
        },
        ..row(
            id,
            SpanKind::WaitAsk,
            "asks:W1",
            id * 100 * MIN,
            id * 100 * MIN + dur,
        )
    }
}

fn prompt(id: i64, dur: i64, by: DecidedBy) -> Row {
    Row {
        label: Some("git push origin main".into()),
        extra: SpanExtra {
            decided_by: Some(by),
            tool: Some(fleetd_contracts::prim::Line::unchecked("Bash")),
            ..SpanExtra::default()
        },
        ..row(
            id,
            SpanKind::WaitPermission,
            "t1",
            id * 10 * MIN,
            id * 10 * MIN + dur,
        )
    }
}

#[test]
fn human_wait_adds_asks_and_human_prompts() {
    let rows = vec![
        ask(1, 6 * MIN, "deploy.region"),
        prompt(2, 4 * MIN, DecidedBy::Human),
    ];
    let found = fired(&input(rows), InsightRule::HumanWait);
    assert_eq!(
        found[0].message.as_str(),
        "waited 10m on your answers (2 asks); longest: `deploy.region` 6m"
    );
    let rows = vec![
        ask(1, 6 * MIN, "deploy.region"),
        prompt(2, 4 * MIN, DecidedBy::Policy),
    ];
    assert!(fired(&input(rows), InsightRule::HumanWait).is_empty());
}

#[test]
fn batching_delay_reads_the_paths() {
    let make = |dur: i64| {
        let rows = vec![row(1, SpanKind::AskBatching, "asks:W1", 0, dur)];
        let mut i = input(rows.clone());
        i.paths.push(("W1".into(), path(0, dur, rows)));
        i
    };
    let found = fired(&make(5 * MIN), InsightRule::BatchingDelay);
    assert_eq!(
        found[0].message.as_str(),
        "asks sat 5m in batches before they were sent to you"
    );
    assert!(fired(&make(5 * MIN - 1000), InsightRule::BatchingDelay).is_empty());
}

#[test]
fn approval_rule_needs_five_prompts_with_one_prefix() {
    let rows: Vec<Row> = (1..=5).map(|i| prompt(i, MIN, DecidedBy::Human)).collect();
    let found = fired(&input(rows.clone()), InsightRule::ApprovalRule);
    assert_eq!(
        found[0].message.as_str(),
        "5 `Bash` prompts for `git push` waited 5m; a project tool rule `Bash(git push:*)` would answer them at once"
    );
    assert!(fired(&input(rows[..4].to_vec()), InsightRule::ApprovalRule).is_empty());
}

#[test]
fn usage_parks_and_retries_sum_their_waits() {
    let park = |dur| Row {
        machine_id: Some("devbox".into()),
        ..row(1, SpanKind::ParkUsage, "t1", 0, dur)
    };
    let found = fired(&input(vec![park(15 * MIN)]), InsightRule::UsageParks);
    assert_eq!(
        found[0].message.as_str(),
        "parked on usage limits for 15m (1 parks, devbox)"
    );
    assert!(fired(&input(vec![park(15 * MIN - 1000)]), InsightRule::UsageParks).is_empty());

    let retry = |id, status, dur| Row {
        extra: SpanExtra {
            http_status: Some(Count::unchecked(status)),
            ..SpanExtra::default()
        },
        ..row(
            id,
            SpanKind::WaitRetryApi,
            "t1",
            id * MIN * 10,
            id * MIN * 10 + dur,
        )
    };
    let rows = vec![
        retry(1, 529, 2 * MIN),
        retry(2, 529, 2 * MIN),
        retry(3, 429, MIN),
    ];
    let found = fired(&input(rows), InsightRule::Retries);
    assert_eq!(
        found[0].message.as_str(),
        "API retries cost 5m (529 ×2, 429 ×1)"
    );
    assert!(fired(&input(vec![retry(1, 529, 4 * MIN)]), InsightRule::Retries).is_empty());
}

#[test]
fn review_share_needs_three_orders_and_thirty_percent() {
    let make = |orders: usize, review: i64| {
        let mut i = input(Vec::new());
        for n in 0..orders {
            let base = n as i64 * 1000 * MIN;
            let ws = format!("W{}", n + 1);
            let rows = vec![
                Row {
                    workstream_id: Some(ws.clone()),
                    ..row(
                        n as i64 * 2 + 1,
                        SpanKind::ChangeReview,
                        "change:acme/storefront#1",
                        base,
                        base + review,
                    )
                },
                row(
                    n as i64 * 2 + 2,
                    SpanKind::ToolBash,
                    "t1",
                    base + review,
                    base + 10 * MIN,
                ),
            ];
            i.paths
                .push((ws, path(base, base + 10 * MIN, rows.clone())));
            i.rows.extend(rows);
        }
        i
    };
    let found = fired(&make(3, 3 * MIN), InsightRule::ReviewShare);
    assert_eq!(
        found[0].message.as_str(),
        "reviews were 30% of the critical path; median round 3m; 0 orders needed 2+ rounds"
    );
    assert!(fired(&make(2, 3 * MIN), InsightRule::ReviewShare).is_empty());
    assert!(fired(&make(3, 3 * MIN - 1000), InsightRule::ReviewShare).is_empty());
}

#[test]
fn train_line_and_rebase_loops() {
    let q = |dur| {
        row(
            1,
            SpanKind::ChangeQueue,
            "change:acme/storefront#12",
            0,
            dur,
        )
    };
    let found = fired(&input(vec![q(10 * MIN)]), InsightRule::TrainLine);
    assert_eq!(
        found[0].message.as_str(),
        "PRs waited 10m behind others in the `acme/storefront` train"
    );
    assert!(fired(&input(vec![q(10 * MIN - 1000)]), InsightRule::TrainLine).is_empty());

    let block = |id| Row {
        extra: SpanExtra {
            reason: Some(Text::unchecked("needs_rebase")),
            ..SpanExtra::default()
        },
        ..row(
            id,
            SpanKind::ChangeBlocked,
            "change:acme/storefront#12",
            id * MIN,
            id * MIN + MIN,
        )
    };
    let found = fired(&input(vec![block(1), block(3)]), InsightRule::RebaseLoops);
    assert_eq!(
        found[0].message.as_str(),
        "1 PRs needed 2 rebases by their authors (2m blocked)"
    );
    assert!(fired(&input(vec![block(1)]), InsightRule::RebaseLoops).is_empty());
}

#[test]
fn first_token_and_startup_use_percentiles() {
    let tokens = |n: i64, dur: i64| -> Vec<Row> {
        (0..n)
            .map(|i| row(i, SpanKind::ModelFirstToken, "t1", i * MIN, i * MIN + dur))
            .collect()
    };
    let found = fired(&input(tokens(50, 20_000)), InsightRule::FirstToken);
    assert_eq!(
        found[0].message.as_str(),
        "the model took 20s to start answering (p90 20s); 100% of model time"
    );
    assert!(fired(&input(tokens(49, 20_000)), InsightRule::FirstToken).is_empty());
    assert!(fired(&input(tokens(50, 19_000)), InsightRule::FirstToken).is_empty());

    let starts = |dur| vec![row(1, SpanKind::RunStartup, "t1", 0, dur)];
    let found = fired(&input(starts(5000)), InsightRule::Startup);
    assert_eq!(
        found[0].message.as_str(),
        "starting claude took 5s per run (1 runs)"
    );
    assert!(fired(&input(starts(4999)), InsightRule::Startup).is_empty());
}

#[test]
fn offline_counts_overlapping_waits_once() {
    let w = |id, kind, s, e| Row {
        machine_id: Some("buildbox".into()),
        ..row(id, kind, "t1", s, e)
    };
    let rows = vec![
        w(1, SpanKind::WaitOffline, 0, 3 * MIN),
        w(2, SpanKind::QueueOffline, MIN, 5 * MIN),
    ];
    let found = fired(&input(rows), InsightRule::Offline);
    assert_eq!(
        found[0].message.as_str(),
        "buildbox was offline for 5m while work waited for it"
    );
    let rows = vec![
        w(1, SpanKind::WaitOffline, 0, 3 * MIN),
        w(2, SpanKind::QueueOffline, MIN, 4 * MIN),
    ];
    assert!(fired(&input(rows), InsightRule::Offline).is_empty());
}

#[test]
fn coverage_fires_on_any_gap() {
    let gap = Row {
        excl_ms: 0,
        extra: SpanExtra {
            count: Some(Count::unchecked(12)),
            ..SpanExtra::default()
        },
        ..row(1, SpanKind::Gap, "thread:devbox/t1", 0, 10)
    };
    let found = fired(&input(vec![gap]), InsightRule::Coverage);
    assert_eq!(
        found[0].message.as_str(),
        "timeline incomplete for 1 sessions (12 spans lost)"
    );
    assert!(fired(&input(Vec::new()), InsightRule::Coverage).is_empty());
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
