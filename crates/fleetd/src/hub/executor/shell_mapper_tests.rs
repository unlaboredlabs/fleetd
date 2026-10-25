//! Session rows to events, over one machine's day in the node's machine-stream shape: three sessions on one project,
//! a completed turn (a), an approval then an interrupt (c) and a failure (d), first live, then resumed by replay and
//! by snapshot.
use std::collections::HashMap;

use fleetd_contracts::sessions::{MachineEvent, RunEnd, SessionSummary};
use serde_json::{Value, json};

use super::backoff_ms;
use super::shell_mapper::*;

const MACHINE: &str = "lab-b";
const NOW: &str = "2026-10-17T11:00:00.000Z";
const T0: &str = "2026-10-17T10:00:00.000Z";
/// The cursor after the baseline snapshot.
const BEFORE: u64 = 10;
/// The cursor after the last live event.
const AFTER: u64 = 17;

fn at(minute: u32) -> String {
    format!("2026-10-17T10:{minute:02}:00.000Z")
}

fn run(id: &str, status: &str, ordinal: u64, extra: Value) -> Value {
    let mut r = json!({ "id": id, "status": status, "ordinal": ordinal });
    for (k, v) in extra.as_object().unwrap() {
        r[k] = v.clone();
    }
    r
}

/// One session's summary row as the node sends it.
fn row(name: &str, minute: u32, latest_run: Option<Value>, extra: Value) -> SessionSummary {
    let mut v = json!({
        "sessionId": format!("s-{name}"),
        "projectId": "p1",
        "title": format!("fixtures: {name}"),
        "status": "idle",
        "model": "claude-haiku-5-5",
        "effort": "low",
        "runtimeMode": "full-access",
        "createdAt": T0,
        "updatedAt": at(minute),
    });
    if let Some(r) = latest_run {
        v["latestRun"] = r;
    }
    for (k, val) in extra.as_object().unwrap() {
        v[k] = val.clone();
    }
    serde_json::from_value(v).unwrap()
}

fn running(name: &str, minute: u32, run_id: &str, ordinal: u64) -> SessionSummary {
    row(
        name,
        minute,
        Some(run(run_id, "running", ordinal, json!({}))),
        json!({ "status": "running", "activeRunId": run_id }),
    )
}

fn a_done_before() -> SessionSummary {
    row(
        "a",
        1,
        Some(run("a1", "completed", 1, json!({}))),
        json!({ "latestAssistantTail": "OK\nsecond line" }),
    )
}
fn a_done() -> SessionSummary {
    row(
        "a",
        3,
        Some(run("a2", "completed", 2, json!({}))),
        json!({ "latestAssistantTail": "TWO" }),
    )
}
fn c_waiting(request: &str) -> SessionSummary {
    row(
        "c",
        5,
        Some(run("c1", "waiting", 1, json!({}))),
        json!({
            "status": "waiting",
            "activeRunId": "c1",
            "pendingPermission": { "requestId": request, "toolName": "Bash", "summary": "rm -rf build" },
        }),
    )
}
fn c_interrupted() -> SessionSummary {
    row(
        "c",
        6,
        Some(run("c1", "interrupted", 1, json!({}))),
        json!({ "status": "interrupted" }),
    )
}
fn d_failed(failure: Value) -> SessionSummary {
    row(
        "d",
        8,
        Some(run("d1", "failed", 1, json!({ "failure": failure }))),
        json!({ "status": "failed" }),
    )
}
fn plain_failure() -> Value {
    json!({ "class": "other", "message": "Claude gave up after repeated API errors." })
}

fn project() -> Value {
    json!({ "projectId": "p1", "title": "fixtures", "workspaceRoot": "/work/project", "updatedAt": T0 })
}

fn snapshot(sessions: Vec<SessionSummary>) -> MachineEvent {
    serde_json::from_value(json!({
        "type": "snapshot",
        "projects": [project()],
        "sessions": sessions,
    }))
    .unwrap()
}

fn baseline() -> (u64, MachineEvent) {
    (
        BEFORE,
        snapshot(vec![
            a_done_before(),
            row("c", 0, None, json!({})),
            row("d", 0, None, json!({})),
        ]),
    )
}

/// The live events after the baseline, in order.
fn live() -> Vec<(u64, MachineEvent)> {
    [
        running("a", 2, "a2", 2),
        a_done(),
        running("c", 4, "c1", 1),
        c_waiting("q1"),
        c_interrupted(),
        running("d", 7, "d1", 1),
        d_failed(plain_failure()),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, s)| (BEFORE + 1 + i as u64, MachineEvent::SessionUpdated(s)))
    .collect()
}

fn finals() -> Vec<SessionSummary> {
    vec![a_done(), c_interrupted(), d_failed(plain_failure())]
}

/// Feeds events in order; returns the transitions as (type, which session).
fn feed(
    events: &[(u64, MachineEvent)],
    state: &mut ShellState,
    stored: &HashMap<String, StoredThread>,
    baseline: bool,
) -> Vec<(String, String)> {
    let ctx = ApplyContext {
        machine_id: MACHINE,
        now: NOW,
        stored,
        baseline,
    };
    let mut out = vec![];
    for (seq, event) in events {
        for t in apply_machine_event(state, Some(*seq), event, &ctx).transitions {
            out.push((
                t.kind.as_str().to_owned(),
                t.thread_id.trim_start_matches("s-").to_owned(),
            ));
        }
    }
    out
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

fn before_turns() -> ShellState {
    let mut state = ShellState::default();
    feed(&[baseline()], &mut state, &HashMap::new(), true);
    state
}

fn after_turns() -> ShellState {
    let mut state = before_turns();
    feed(&live(), &mut state, &HashMap::new(), false);
    state
}

fn updated(seq: u64, s: SessionSummary) -> [(u64, MachineEvent); 1] {
    [(seq, MachineEvent::SessionUpdated(s))]
}

fn limited(state: &ShellState) -> EventDraft {
    let t = Transition {
        kind: EventType::UsageLimited,
        thread_id: "s-d".into(),
        late: false,
    };
    transition_event(&t, &state.threads["s-d"], MACHINE)
}

const TERMINAL: [(&str, &str); 3] = [
    ("thread.completed", "a"),
    ("thread.interrupted", "c"),
    ("thread.failed", "d"),
];

#[test]
fn baseline_snapshot_emits_nothing() {
    let mut state = ShellState::default();
    assert_eq!(
        feed(&[baseline()], &mut state, &HashMap::new(), true),
        vec![]
    );
    assert!(state.complete);
    assert_eq!(state.cursor, Some(BEFORE));
    let a = &state.threads["s-a"];
    assert_eq!(a.summary.status, "completed");
    assert_eq!(a.summary.headline, "OK");
    assert_eq!(state.threads["s-c"].summary.status, "idle");
}

#[test]
fn live_transitions_once_in_order() {
    assert_eq!(
        feed(&live(), &mut before_turns(), &HashMap::new(), false),
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
    let once = feed(&live(), &mut before_turns(), &HashMap::new(), false);
    let twice: Vec<_> = live().into_iter().flat_map(|e| [e.clone(), e]).collect();
    assert_eq!(
        feed(&twice, &mut before_turns(), &HashMap::new(), false),
        once
    );
}

#[test]
fn a_queued_run_is_starting_so_a_send_waits_behind_it() {
    let mut state = before_turns();
    let queued = row(
        "c",
        4,
        Some(run("c1", "queued", 1, json!({}))),
        json!({ "status": "running", "activeRunId": "c1" }),
    );
    feed(&updated(11, queued), &mut state, &HashMap::new(), false);
    let c = &state.threads["s-c"];
    assert_eq!(c.active_run_id.as_deref(), Some("c1"));
    assert!(c.active_run_starting);
    assert_eq!(c.summary.status, "running");
}

#[test]
fn failed_run_maps_class_message_and_event() {
    let state = after_turns();
    let failed = &state.threads["s-d"];
    assert_eq!(failed.summary.status, "failed");
    assert_eq!(
        failed.summary.last_error,
        Some(LastError {
            class: "other".into(),
            message: "Claude gave up after repeated API errors.".into()
        })
    );
    assert_eq!(failed.summary.model.as_deref(), Some("claude-haiku-5-5"));
    assert_eq!(failed.summary.effort.as_deref(), Some("low"));
    assert_eq!(failed.summary.usage_limit_reset_at, None);
    assert_eq!(failed.summary.last_progress_at, at(8));
    let event = transition_event(
        &Transition {
            kind: EventType::Failed,
            thread_id: "s-d".into(),
            late: false,
        },
        failed,
        MACHINE,
    );
    assert_eq!(event.kind, "thread.failed");
    assert_eq!(event.thread_id.as_deref(), Some("s-d"));
    assert_eq!(event.project_id.as_deref(), Some("p1"));
    assert_eq!(
        event.summary,
        r#""fixtures: d" on lab-b failed: other: Claude gave up after repeated API errors."#
    );
    assert_eq!(event.data.unwrap()["runId"], "d1");
}

#[test]
fn a_waiting_event_carries_the_prompt_and_a_second_prompt_waits_again() {
    let mut state = before_turns();
    let events = [
        (11, MachineEvent::SessionUpdated(running("c", 4, "c1", 1))),
        (12, MachineEvent::SessionUpdated(c_waiting("q1"))),
    ];
    assert_eq!(
        feed(&events, &mut state, &HashMap::new(), false),
        ev(&[("thread.started", "c"), ("thread.waiting", "c")])
    );
    let t = Transition {
        kind: EventType::Waiting,
        thread_id: "s-c".into(),
        late: false,
    };
    let data = transition_event(&t, &state.threads["s-c"], MACHINE)
        .data
        .unwrap();
    assert_eq!(
        data["permission"],
        json!({ "requestId": "q1", "toolName": "Bash", "summary": "rm -rf build" })
    );
    // q1 answered and q2 raised between two rows the hub saw: still a new wait.
    let second = updated(13, c_waiting("q2"));
    assert_eq!(
        feed(&second, &mut state, &HashMap::new(), false),
        ev(&[("thread.waiting", "c")])
    );
    // The same prompt again is nothing new.
    assert_eq!(feed(&second, &mut state, &HashMap::new(), false), vec![]);
}

#[test]
fn replay_of_the_final_rows_reports_what_happened_meanwhile() {
    let mut state = before_turns();
    let replay: Vec<_> = finals()
        .into_iter()
        .enumerate()
        .map(|(i, s)| (BEFORE + 5 + i as u64, MachineEvent::SessionUpdated(s)))
        .collect();
    assert_eq!(
        sorted(feed(&replay, &mut state, &HashMap::new(), false)),
        sorted(ev(&TERMINAL))
    );
    assert_eq!(state.cursor, Some(BEFORE + 7));
}

#[test]
fn snapshot_resume_reports_what_happened_meanwhile() {
    let mut state = before_turns();
    let resume = [(AFTER, snapshot(finals()))];
    assert_eq!(
        sorted(feed(&resume, &mut state, &HashMap::new(), false)),
        sorted(ev(&TERMINAL))
    );
    assert_eq!(state.cursor, Some(AFTER));
}

#[test]
fn replay_and_snapshot_resumes_end_in_the_live_caches() {
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
        let projects: Vec<ProjectRow> = s
            .projects
            .keys()
            .filter_map(|id| project_summary(s, MACHINE, id))
            .collect();
        (threads, projects)
    };
    let via_live = after_turns();
    let mut via_snapshot = before_turns();
    feed(
        &[(AFTER, snapshot(finals()))],
        &mut via_snapshot,
        &HashMap::new(),
        false,
    );
    assert_eq!(view(&via_snapshot), view(&via_live));
    let (threads, projects) = view(&via_live);
    assert_eq!(
        projects[0].threads,
        ThreadCounts {
            running: 0,
            waiting: 0,
            failed: 1,
            idle: threads.len() as u64 - 1
        }
    );
    assert_eq!(projects[0].last_activity_at, at(8));
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
    let stored = stored_from(&before_turns(), false);
    let events = feed(
        &[(AFTER, snapshot(finals()))],
        &mut ShellState::default(),
        &stored,
        false,
    );
    // Such rows carry no run id, so run 2 of `a` (completed -> completed) is not visible here.
    assert_eq!(
        sorted(events),
        ev(&[("thread.failed", "d"), ("thread.interrupted", "c")])
    );
}

#[test]
fn restart_reports_runs_that_ended_meanwhile_late_by_run_id() {
    let stored = stored_from(&before_turns(), true);
    let mut state = ShellState::default();
    let ctx = ApplyContext {
        machine_id: MACHINE,
        now: NOW,
        stored: &stored,
        baseline: false,
    };
    let applied = apply_machine_event(&mut state, Some(AFTER), &snapshot(finals()), &ctx);
    let mut got: Vec<(String, String, bool)> = applied
        .transitions
        .iter()
        .map(|t| (t.kind.as_str().to_owned(), t.thread_id.clone(), t.late))
        .collect();
    got.sort();
    assert_eq!(
        got,
        vec![
            // Run 2 of `a`: same phase, new run id.
            ("thread.completed".to_owned(), "s-a".to_owned(), true),
            ("thread.failed".to_owned(), "s-d".to_owned(), true),
            ("thread.interrupted".to_owned(), "s-c".to_owned(), true),
        ]
    );
    let completed = applied
        .transitions
        .iter()
        .find(|t| t.thread_id == "s-a")
        .unwrap();
    let data = transition_event(completed, &state.threads["s-a"], MACHINE)
        .data
        .unwrap();
    assert_eq!(data["status"], "completed");
    assert_eq!(data["late"], true);
    assert_eq!(data["runId"], "a2");
    // Every changed row is written back with its run, so the next restart diffs against it.
    let last = applied
        .threads
        .iter()
        .rfind(|t| t.summary.thread_id == "s-a")
        .unwrap();
    assert_eq!(last.last_run_id.as_deref(), Some("a2"));
    assert_eq!(last.last_run_status.as_deref(), Some("completed"));
    // The snapshot names every session the node has, so the hub can mark the rest stale.
    let present = applied.present.unwrap();
    assert_eq!(present.len(), 3);
    assert!(present.contains("s-a"));
}

#[test]
fn restart_with_nothing_new_emits_nothing() {
    let stored = stored_from(&after_turns(), true);
    assert_eq!(
        feed(
            &[(AFTER, snapshot(finals()))],
            &mut ShellState::default(),
            &stored,
            false
        ),
        vec![]
    );
}

#[test]
fn removed_projects_by_event_and_by_snapshot() {
    let ctx = ApplyContext {
        machine_id: MACHINE,
        now: NOW,
        stored: &HashMap::new(),
        baseline: false,
    };
    let full = snapshot(finals());
    let mut state = ShellState::default();
    apply_machine_event(&mut state, Some(1), &full, &ctx);
    let with = |extra: &str| vec!["p1".to_owned(), extra.to_owned()];
    assert_eq!(
        removed_projects(&state, &full, &with("gone")),
        vec!["gone".to_owned()]
    );
    assert_eq!(
        removed_projects(&state, &full, &["p1".to_owned()]),
        Vec::<String>::new()
    );
    let removed: MachineEvent =
        serde_json::from_value(json!({ "type": "project_removed", "projectId": "p1" })).unwrap();
    let mut state = before_turns();
    apply_machine_event(&mut state, Some(99), &removed, &ctx);
    assert!(!state.projects.contains_key("p1"));
    assert_eq!(state.cursor, Some(99));
    assert_eq!(
        removed_projects(&state, &removed, &with("other")),
        vec!["p1".to_owned()]
    );
    let update = MachineEvent::SessionUpdated(a_done());
    assert_eq!(
        removed_projects(&state, &update, &with("other")),
        Vec::<String>::new()
    );
}

#[test]
fn usage_limit_is_its_own_event_with_the_reset() {
    let limit = d_failed(json!({
        "class": "usage_limit",
        "message": "You've hit your limit · resets 3pm (UTC)",
        "resetAt": "2026-10-17T15:00:00.000Z",
    }));
    let mut state = before_turns();
    assert_eq!(
        feed(
            &updated(11, limit.clone()),
            &mut state,
            &HashMap::new(),
            false
        ),
        ev(&[("thread.usage_limited", "d")])
    );
    assert_eq!(
        state.threads["s-d"].summary.usage_limit_reset_at.as_deref(),
        Some("2026-10-17T15:00:00.000Z")
    );
    let event = limited(&state);
    assert_eq!(
        event.summary,
        r#""fixtures: d" on lab-b hit the usage limit (resets 2026-10-17T15:00:00.000Z)"#
    );
    let data = event.data.unwrap();
    assert_eq!(data["usageClass"], "usage_limit");
    assert_eq!(data["resumeAt"], "2026-10-17T15:00:00.000Z");
    // A plain failure that turns into a usage limit on the same run is a transition too.
    let mut after = after_turns();
    assert_eq!(
        feed(
            &updated(AFTER + 1, limit),
            &mut after,
            &HashMap::new(),
            false
        ),
        ev(&[("thread.usage_limited", "d")])
    );
}

#[test]
fn a_rate_limit_without_a_reset_waits_five_minutes() {
    let mut state = before_turns();
    let rate = d_failed(
        json!({ "class": "rate_limit", "message": "API Error: Request rejected (429) · slow down" }),
    );
    feed(&updated(11, rate), &mut state, &HashMap::new(), false);
    let data = limited(&state).data.unwrap();
    assert_eq!(data["usageClass"], "rate_limit");
    assert_eq!(data["resumeAt"], "2026-10-17T10:13:00.000Z");
}

#[test]
fn an_auth_failure_is_a_failure_not_a_limit() {
    let mut state = before_turns();
    let auth = d_failed(json!({ "class": "auth", "message": "Not logged in · Please run /login" }));
    assert_eq!(
        feed(&updated(11, auth), &mut state, &HashMap::new(), false),
        ev(&[("thread.failed", "d")])
    );
    assert_eq!(
        state.threads["s-d"]
            .summary
            .last_error
            .as_ref()
            .unwrap()
            .class,
        "auth"
    );
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
        end_cause: None,
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

#[test]
fn a_runner_event_moves_the_cursor_and_nothing_else() {
    let mut state = after_turns();
    let before = state.threads.clone();
    let info: MachineEvent =
        serde_json::from_value(json!({ "type": "runner_info", "runner": "claude",
        "supported": ">=2.1.300, <2.2.0", "versionOk": true, "login": "logged_out" }))
        .unwrap();
    let ctx = ApplyContext {
        machine_id: MACHINE,
        now: NOW,
        stored: &HashMap::new(),
        baseline: false,
    };
    let applied = apply_machine_event(&mut state, Some(AFTER + 1), &info, &ctx);
    assert!(
        applied.transitions.is_empty() && applied.threads.is_empty() && applied.projects.is_empty()
    );
    assert_eq!(applied.cursor, Some(AFTER + 1));
    assert_eq!(state.threads, before);
}

#[test]
fn an_ended_runs_cause_reaches_the_summary_and_its_event() {
    let mut state = before_turns();
    let stopped = row(
        "c",
        6,
        Some(run(
            "c1",
            "interrupted",
            1,
            json!({ "end": "node_stopping", "failure": { "class": "process_exited", "message": "the node stopped" } }),
        )),
        json!({ "status": "interrupted" }),
    );
    let events = [
        (11, MachineEvent::SessionUpdated(running("c", 4, "c1", 1))),
        (12, MachineEvent::SessionUpdated(stopped)),
    ];
    assert_eq!(
        feed(&events, &mut state, &HashMap::new(), false),
        ev(&[("thread.started", "c"), ("thread.interrupted", "c")])
    );
    let thread = &state.threads["s-c"];
    assert_eq!(thread.summary.end_cause, Some(RunEnd::NodeStopping));
    let t = Transition {
        kind: EventType::Interrupted,
        thread_id: "s-c".into(),
        late: false,
    };
    let data = transition_event(&t, thread, MACHINE).data.unwrap();
    assert_eq!(data["endCause"], "node_stopping");

    // A cause a newer node records reads as unknown; an older node's run carries none.
    let newer = row(
        "d",
        8,
        Some(run(
            "d1",
            "failed",
            1,
            json!({ "end": "moon_phase", "failure": plain_failure() }),
        )),
        json!({ "status": "failed" }),
    );
    feed(&updated(13, newer), &mut state, &HashMap::new(), false);
    assert_eq!(
        state.threads["s-d"].summary.end_cause,
        Some(RunEnd::Unknown)
    );
    feed(
        &updated(14, d_failed(plain_failure())),
        &mut state,
        &HashMap::new(),
        false,
    );
    assert_eq!(state.threads["s-d"].summary.end_cause, None);
    let t = Transition {
        kind: EventType::Failed,
        thread_id: "s-d".into(),
        late: false,
    };
    let data = transition_event(&t, &state.threads["s-d"], MACHINE)
        .data
        .unwrap();
    assert!(data.get("endCause").is_none());
}
