//! Shell rows to events, replaying the S0 lab recordings (fixtures/).
use std::collections::HashMap;

use serde_json::Value;

use super::backoff_ms;
use super::shell_mapper::*;
use t3_wire::types::{ShellSnapshotItem, ShellStreamItem};

struct Fixture {
    before: u64,
    threads: HashMap<String, String>,
    items: Vec<ShellStreamItem>,
    raw: Vec<Value>,
}

fn fixture(name: &str) -> Fixture {
    let path = format!(
        "{}/src/hub/executor/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let items: Vec<Value> = raw["items"].as_array().unwrap().clone();
    Fixture {
        before: raw["before"].as_u64().unwrap_or(0),
        threads: raw["threads"]
            .as_object()
            .map(|o| {
                o.iter()
                    .map(|(k, v)| (v.as_str().unwrap().to_owned(), k.clone()))
                    .collect()
            })
            .unwrap_or_default(),
        items: items
            .iter()
            .map(|i| serde_json::from_value(i.clone()).unwrap())
            .collect(),
        raw: items,
    }
}

const MACHINE: &str = "lab-b";
const NOW: &str = "2026-10-17T11:00:00.000Z";

fn is_snapshot(i: &ShellStreamItem) -> bool {
    matches!(i, ShellStreamItem::Snapshot(_))
}

/// Feeds items in order; returns the transitions as (type, which thread).
fn run(
    items: &[&ShellStreamItem],
    state: &mut ShellState,
    stored: &HashMap<String, StoredThread>,
    baseline: bool,
) -> Vec<(String, String)> {
    let names = fixture("shell-live.json").threads;
    let ctx = ApplyContext {
        machine_id: MACHINE,
        now: NOW,
        stored,
        baseline,
    };
    let mut events = vec![];
    for item in items {
        for t in apply_shell_item(state, item, &ctx).transitions {
            events.push((
                t.kind.as_str().to_owned(),
                names.get(&t.thread_id).cloned().unwrap_or(t.thread_id),
            ));
        }
    }
    events
}

fn ev(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect()
}

fn sorted(mut v: Vec<(String, String)>) -> Vec<(String, String)> {
    v.sort();
    v
}

/// State as it stood when the recording began: the initial snapshot(s), before any turn ran.
fn before_turns(live: &Fixture) -> ShellState {
    let mut state = ShellState::default();
    let snaps: Vec<_> = live.items.iter().filter(|i| is_snapshot(i)).collect();
    run(&snaps, &mut state, &HashMap::new(), true);
    state
}

fn deltas(live: &Fixture) -> Vec<&ShellStreamItem> {
    live.items.iter().filter(|i| !is_snapshot(i)).collect()
}

fn id_of(live: &Fixture, name: &str) -> String {
    live.threads
        .iter()
        .find(|(_, n)| *n == name)
        .unwrap()
        .0
        .clone()
}

const TERMINAL: [(&str, &str); 3] = [
    ("thread.completed", "a"),
    ("thread.interrupted", "c"),
    ("thread.failed", "d"),
];

#[test]
fn baseline_snapshot_emits_nothing() {
    let live = fixture("shell-live.json");
    let mut state = ShellState::default();
    let snaps: Vec<_> = live.items.iter().filter(|i| is_snapshot(i)).collect();
    assert_eq!(run(&snaps, &mut state, &HashMap::new(), true), vec![]);
    assert!(state.complete);
    assert_eq!(state.cursor, Some(live.before));
}

#[test]
fn live_transitions_once_in_order() {
    let live = fixture("shell-live.json");
    let mut state = before_turns(&live);
    assert_eq!(
        run(&deltas(&live), &mut state, &HashMap::new(), false),
        ev(&[
            ("thread.started", "a"),
            ("thread.completed", "a"),
            ("thread.started", "c"),
            ("thread.waiting", "c"),
            ("thread.interrupted", "c"),
            ("thread.started", "d"),
            ("thread.failed", "d"),
        ])
    );
}

#[test]
fn rows_delivered_again_emit_nothing() {
    let live = fixture("shell-live.json");
    let once = run(
        &deltas(&live),
        &mut before_turns(&live),
        &HashMap::new(),
        false,
    );
    let twice: Vec<_> = deltas(&live).into_iter().flat_map(|i| [i, i]).collect();
    assert_eq!(
        run(&twice, &mut before_turns(&live), &HashMap::new(), false),
        once
    );
}

#[test]
fn failed_run_maps_class_message_and_event() {
    let live = fixture("shell-live.json");
    let mut state = ShellState::default();
    let all: Vec<_> = live.items.iter().collect();
    run(&all, &mut state, &HashMap::new(), true);
    let d = id_of(&live, "d");
    let failed = state.threads.get(&d).unwrap();
    assert_eq!(failed.summary.status, "failed");
    assert_eq!(
        failed.summary.last_error,
        Some(LastError {
            class: "provider_error".into(),
            message: "Claude gave up after repeated API errors.".into()
        })
    );
    assert_eq!(
        failed.summary.model.as_deref(),
        Some("claude-nonexistent-0")
    );
    assert_eq!(failed.summary.effort.as_deref(), Some("low"));
    assert_eq!(failed.summary.usage_limit_reset_at, None);
    let event = transition_event(
        &Transition {
            kind: EventType::Failed,
            thread_id: d.clone(),
            late: false,
        },
        failed,
        MACHINE,
    );
    assert_eq!(event.kind, "thread.failed");
    assert_eq!(event.thread_id.as_deref(), Some(d.as_str()));
    assert_eq!(
        event.project_id.as_deref(),
        Some(failed.summary.project_id.as_str())
    );
    assert_eq!(
        event.summary,
        r#""fixtures: bad model" on lab-b failed: provider_error: Claude gave up after repeated API errors."#
    );
}

#[test]
fn replay_resume_keeps_threads_and_cursor_through_the_metadata_snapshot() {
    let live = fixture("shell-live.json");
    let replay = fixture("shell-resume-replay.json");
    let mut state = before_turns(&live);
    let threads_before = state.threads.len();
    let (first, rest) = replay.items.split_first().unwrap();
    assert!(matches!(
        first,
        ShellStreamItem::Snapshot(ShellSnapshotItem {
            resolved_repository_identity_roots: Some(_),
            ..
        })
    ));
    let ctx = ApplyContext {
        machine_id: MACHINE,
        now: NOW,
        stored: &HashMap::new(),
        baseline: false,
    };
    assert_eq!(apply_shell_item(&mut state, first, &ctx).cursor, None);
    assert_eq!(state.cursor, Some(live.before));
    assert_eq!(state.threads.len(), threads_before);
    let rest: Vec<_> = rest.iter().collect();
    assert_eq!(
        sorted(run(&rest, &mut state, &HashMap::new(), false)),
        sorted(ev(&TERMINAL))
    );
    assert_eq!(state.cursor, Some(396));
}

#[test]
fn snapshot_resume_reports_what_happened_meanwhile() {
    let live = fixture("shell-live.json");
    let reset = fixture("shell-resume-snapshot.json");
    let mut state = before_turns(&live);
    let items: Vec<_> = reset.items.iter().collect();
    assert_eq!(
        sorted(run(&items, &mut state, &HashMap::new(), false)),
        sorted(ev(&TERMINAL))
    );
    assert_eq!(state.cursor, Some(396));
}

#[test]
fn replay_and_snapshot_resumes_end_in_the_live_caches() {
    let live = fixture("shell-live.json");
    let view = |s: &ShellState| {
        let mut threads: Vec<Summary> = s
            .threads
            .values()
            .map(|t| Summary {
                as_of: String::new(),
                ..t.summary.clone()
            })
            .collect();
        threads.sort_by(|x, y| x.thread_id.cmp(&y.thread_id));
        let mut projects: Vec<ProjectRow> = s
            .projects
            .keys()
            .filter_map(|id| project_summary(s, MACHINE, id))
            .collect();
        projects.sort_by(|x, y| x.project_id.cmp(&y.project_id));
        (threads, projects)
    };
    let mut via_live = ShellState::default();
    run(
        &live.items.iter().collect::<Vec<_>>(),
        &mut via_live,
        &HashMap::new(),
        true,
    );
    for name in ["shell-resume-replay.json", "shell-resume-snapshot.json"] {
        let f = fixture(name);
        let mut state = before_turns(&live);
        run(
            &f.items.iter().collect::<Vec<_>>(),
            &mut state,
            &HashMap::new(),
            false,
        );
        assert_eq!(view(&state), view(&via_live), "{name}");
    }
    let (threads, projects) = view(&via_live);
    let failed = threads.iter().filter(|t| t.status == "failed").count() as u64;
    assert_eq!(
        projects[0].threads,
        ThreadCounts {
            running: 0,
            waiting: 0,
            failed,
            idle: threads.len() as u64 - failed
        }
    );
}

fn stored_from(state: &ShellState, with_runs: bool) -> HashMap<String, StoredThread> {
    state
        .threads
        .iter()
        .map(|(id, t)| {
            let row = StoredThread {
                summary: t.summary.clone(),
                last_sequence: None,
                last_run_id: if with_runs {
                    t.known_run().map(str::to_owned)
                } else {
                    None
                },
                last_run_status: with_runs.then(|| phase(&t.summary)),
            };
            (id.clone(), row)
        })
        .collect()
}

#[test]
fn restart_diffs_rows_stored_before_run_tracking() {
    let live = fixture("shell-live.json");
    let reset = fixture("shell-resume-snapshot.json");
    let stored = stored_from(&before_turns(&live), false);
    let events = run(
        &reset.items.iter().collect::<Vec<_>>(),
        &mut ShellState::default(),
        &stored,
        false,
    );
    // Such rows carry no run id, so run 3 of `a` (completed -> completed) is not visible here.
    assert_eq!(
        sorted(events),
        ev(&[("thread.failed", "d"), ("thread.interrupted", "c")])
    );
}

#[test]
fn restart_reports_runs_that_ended_meanwhile_late_by_run_id() {
    let live = fixture("shell-live.json");
    let reset = fixture("shell-resume-snapshot.json");
    let stored = stored_from(&before_turns(&live), true);
    let mut state = ShellState::default();
    let ctx = ApplyContext {
        machine_id: MACHINE,
        now: NOW,
        stored: &stored,
        baseline: false,
    };
    let applied: Vec<Applied> = reset
        .items
        .iter()
        .map(|i| apply_shell_item(&mut state, i, &ctx))
        .collect();
    let transitions: Vec<&Transition> = applied.iter().flat_map(|x| &x.transitions).collect();
    let mut got: Vec<(String, String, bool)> = transitions
        .iter()
        .map(|t| (t.kind.as_str().to_owned(), t.thread_id.clone(), t.late))
        .collect();
    got.sort();
    let (a, c, d) = (id_of(&live, "a"), id_of(&live, "c"), id_of(&live, "d"));
    let mut want = vec![
        ("thread.completed".to_owned(), a.clone(), true), // run 3 of `a`: same phase, new run id
        ("thread.failed".to_owned(), d, true),
        ("thread.interrupted".to_owned(), c, true),
    ];
    want.sort();
    assert_eq!(got, want);
    let completed = transitions.iter().find(|t| t.thread_id == a).unwrap();
    let tracked = state.threads.get(&a).unwrap();
    let data = transition_event(completed, tracked, MACHINE).data.unwrap();
    assert_eq!(data["status"], "completed");
    assert_eq!(data["late"], true);
    assert_eq!(data["runId"].as_str(), tracked.known_run());
    // Every changed row is written back with its run, so the next restart diffs against it.
    let last = applied
        .iter()
        .flat_map(|x| &x.threads)
        .rfind(|t| t.summary.thread_id == a)
        .unwrap();
    assert_eq!(last.last_run_id.as_deref(), tracked.known_run());
    assert_eq!(last.last_run_status.as_deref(), Some("completed"));
}

#[test]
fn restart_with_nothing_new_emits_nothing() {
    let live = fixture("shell-live.json");
    let reset = fixture("shell-resume-snapshot.json");
    let mut after = ShellState::default();
    run(
        &live.items.iter().collect::<Vec<_>>(),
        &mut after,
        &HashMap::new(),
        true,
    );
    let stored = stored_from(&after, true);
    assert_eq!(
        run(
            &reset.items.iter().collect::<Vec<_>>(),
            &mut ShellState::default(),
            &stored,
            false
        ),
        vec![]
    );
}

#[test]
fn deleted_projects() {
    let live = fixture("shell-live.json");
    let replay = fixture("shell-resume-replay.json");
    let full = live
        .items
        .iter()
        .find(|i| {
            matches!(
                i,
                ShellStreamItem::Snapshot(ShellSnapshotItem {
                    resolved_repository_identity_roots: None,
                    ..
                })
            )
        })
        .unwrap();
    let ShellStreamItem::Snapshot(ShellSnapshotItem { snapshot, .. }) = full else {
        unreachable!()
    };
    let known: Vec<String> = snapshot.projects.iter().map(|p| p.id.clone()).collect();
    assert!(!known.is_empty());
    let ctx = ApplyContext {
        machine_id: MACHINE,
        now: NOW,
        stored: &HashMap::new(),
        baseline: false,
    };
    let mut state = ShellState::default();
    apply_shell_item(&mut state, full, &ctx);
    let with = |extra: &str| {
        known
            .iter()
            .cloned()
            .chain([extra.to_owned()])
            .collect::<Vec<_>>()
    };
    assert_eq!(
        removed_projects(&state, full, &with("gone")),
        vec!["gone".to_owned()]
    );
    assert_eq!(removed_projects(&state, full, &known), Vec::<String>::new());

    let mut state = before_turns(&live);
    let removed: ShellStreamItem = serde_json::from_value(
        serde_json::json!({"kind": "project.removed", "sequence": 999, "projectId": known[0]}),
    )
    .unwrap();
    apply_shell_item(&mut state, &removed, &ctx);
    assert_eq!(
        removed_projects(&state, &removed, &with("other")),
        vec![known[0].clone()]
    );
    assert_eq!(
        removed_projects(&state, &replay.items[0], &with("other")),
        Vec::<String>::new()
    );
}

/// d's failed row, with its thread fields changed.
fn failed_row(live: &Fixture, thread: Value) -> ShellStreamItem {
    let d = id_of(live, "d");
    let mut row = live
        .raw
        .iter()
        .rfind(|i| i["kind"] == "thread.updated" && i["thread"]["id"] == d.as_str())
        .unwrap()
        .clone();
    row["sequence"] = (row["sequence"].as_u64().unwrap() + 1).into();
    for (k, v) in thread.as_object().unwrap() {
        row["thread"][k] = v.clone();
    }
    serde_json::from_value(row).unwrap()
}

#[test]
fn usage_limit_is_its_own_event_with_the_reset() {
    let live = fixture("shell-live.json");
    let limited = failed_row(
        &live,
        serde_json::json!({"lastErrorClass": "usage_limit", "lastError": "Usage limit reached.", "usageLimitResetAt": "2026-10-17T15:00:00.000Z"}),
    );
    let mut state = before_turns(&live);
    assert_eq!(
        run(&[&limited], &mut state, &HashMap::new(), false),
        ev(&[("thread.usage_limited", "d")])
    );
    let tracked = state.threads.get(&id_of(&live, "d")).unwrap();
    assert_eq!(
        tracked.summary.usage_limit_reset_at.as_deref(),
        Some("2026-10-17T15:00:00.000Z")
    );
    let t = Transition {
        kind: EventType::UsageLimited,
        thread_id: tracked.summary.thread_id.clone(),
        late: false,
    };
    assert_eq!(
        transition_event(&t, tracked, MACHINE).summary,
        r#""fixtures: bad model" on lab-b hit the usage limit (resets 2026-10-17T15:00:00.000Z)"#
    );
    // A plain failure that turns into a usage limit on the same run is a transition too.
    let mut after = ShellState::default();
    run(
        &live.items.iter().collect::<Vec<_>>(),
        &mut after,
        &HashMap::new(),
        true,
    );
    assert_eq!(
        run(&[&limited], &mut after, &HashMap::new(), false),
        ev(&[("thread.usage_limited", "d")])
    );
}

#[test]
fn proxy_unknown_provider_is_pool_exhausted() {
    let live = fixture("shell-live.json");
    let proxy = failed_row(
        &live,
        serde_json::json!({
            "lastErrorClass": "provider_error",
            "lastError": "API Error: 400 {\"error\":{\"message\":\"unknown provider for model claude-opus-5-5\",\"type\":\"invalid_request_error\",\"code\":\"model_not_found\",\"param\":\"model\"}}",
            "usageLimitResetAt": null
        }),
    );
    let mut state = before_turns(&live);
    assert_eq!(
        run(&[&proxy], &mut state, &HashMap::new(), false),
        ev(&[("thread.usage_limited", "d")])
    );
    assert_eq!(run(&[&proxy], &mut state, &HashMap::new(), false), vec![]);
    let tracked = state.threads.get(&id_of(&live, "d")).unwrap();
    let t = Transition {
        kind: EventType::UsageLimited,
        thread_id: tracked.summary.thread_id.clone(),
        late: false,
    };
    let event = transition_event(&t, tracked, MACHINE);
    assert_eq!(
        event.summary,
        r#""fixtures: bad model" on lab-b hit the usage limit: your proxy has no account available for claude-opus-5-5"#
    );
    let data = event.data.unwrap();
    assert_eq!(data["usageClass"], "pool_exhausted");
    assert_eq!(data["model"], "claude-opus-5-5");
}

#[test]
fn transitions_between_observations() {
    let s = |status: &str| Summary {
        machine_id: String::new(),
        thread_id: String::new(),
        project_id: String::new(),
        title: String::new(),
        status: status.into(),
        headline: String::new(),
        latest_message_tail: String::new(),
        last_error: None,
        usage_limit_reset_at: None,
        last_progress_at: NOW.into(),
        model: None,
        effort: None,
        stale: false,
        as_of: NOW.into(),
    };
    let t = |a: &str, ra: Option<&str>, b: &str, rb: Option<&str>| {
        transition(Some((&s(a), ra)), (&s(b), rb)).map(EventType::as_str)
    };
    assert_eq!(
        t("completed", Some("r1"), "completed", Some("r2")),
        Some("thread.completed")
    );
    assert_eq!(t("completed", None, "completed", Some("r2")), None);
    assert_eq!(t("waiting", Some("r1"), "running", Some("r1")), None);
    assert_eq!(
        t("waiting", Some("r1"), "running", Some("r2")),
        Some("thread.started")
    );
    assert_eq!(t("running", Some("r1"), "cancelled", Some("r1")), None);
    assert_eq!(t("completed", Some("r1"), "idle", Some("r1")), None);
}

#[test]
fn backoff_doubles_to_a_cap_with_jitter() {
    let got: Vec<u64> = [0, 1, 2, 3, 4, 5, 6, 20]
        .iter()
        .map(|n| backoff_ms(*n, 0.5))
        .collect();
    assert_eq!(
        got,
        vec![1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]
    );
    assert_eq!(backoff_ms(0, 0.0), 750);
    assert!(backoff_ms(0, 0.999) <= 1250);
    assert_eq!(backoff_ms(9, 0.999), 30000);
}
