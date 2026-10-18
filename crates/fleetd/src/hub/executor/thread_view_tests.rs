//! A followed session's window to tail rows and actions: a snapshot, then live events, in the node's thread-stream
//! shape.
use fleetd_contracts::sessions::{PendingPermission, ThreadEvent};
use serde_json::{Value, json};

use super::OpenTool;
use super::thread_view::*;

fn event(v: Value) -> ThreadEvent {
    serde_json::from_value(v).unwrap()
}

fn item(id: &str, run: &str, status: &str, minute: u32, kind: Value) -> Value {
    json!({
        "id": id, "runId": run, "status": status, "title": "", "kind": kind,
        "startedAt": format!("2026-10-17T10:{minute:02}:00.000Z"),
        "updatedAt": format!("2026-10-17T10:{minute:02}:00.000Z"),
    })
}

fn message(id: &str, role: &str, minute: u32, text: &str) -> Value {
    json!({ "id": id, "runId": "r1", "role": role, "text": text,
            "createdAt": format!("2026-10-17T10:{minute:02}:00.000Z") })
}

/// One run: the prompt, a passing and a failing command, an edit, an API retry, a permission prompt, a compaction,
/// and the reply.
fn followed() -> ThreadView {
    let mut view = ThreadView::default();
    assert!(!view.ready);
    apply_thread_event(
        &mut view,
        &event(json!({
            "type": "snapshot",
            "summary": {
                "sessionId": "s1", "projectId": "p1", "title": "t", "status": "running", "model": "claude-haiku-5-5",
                "effort": "low", "runtimeMode": "full-access", "activeRunId": "r1",
                "createdAt": "2026-10-17T10:00:00.000Z", "updatedAt": "2026-10-17T10:09:00.000Z",
            },
            "messages": [message("m1", "user", 0, "run the tests")],
            "items": [
                item("i1", "r1", "completed", 1, json!({ "type": "command", "command": "npm test", "output": "ok", "exitCode": 0 })),
                item("i2", "r1", "failed", 2, json!({ "type": "command", "command": "npm run lint", "output": "1 error\nExit code 1", "outputOmitted": true, "exitCode": 1 })),
                item("i3", "r1", "completed", 3, json!({ "type": "file_change", "toolName": "Edit", "path": "src/a.ts" })),
                item("i4", "r1", "completed", 4, json!({ "type": "api_retry", "attempt": 2, "maxRetries": 10, "errorStatus": 529, "error": "overloaded" })),
                item("i5", "r1", "completed", 5, json!({ "type": "permission", "requestId": "q1", "toolName": "Bash", "summary": "rm -rf build" })),
                item("i6", "r1", "completed", 6, json!({ "type": "compaction", "trigger": "auto", "preTokens": 100000, "postTokens": 9000 })),
            ],
            "runs": [{ "id": "r1", "status": "running", "ordinal": 1 }],
            "truncated": false,
        })),
    );
    apply_thread_event(
        &mut view,
        &event(json!({ "type": "delta", "messageId": "m2", "append": "Do" })),
    );
    apply_thread_event(
        &mut view,
        &event(
            json!({ "type": "message", "id": "m2", "runId": "r1", "role": "assistant",
                       "text": "Done.\nLint has one error.", "createdAt": "2026-10-17T10:09:00.000Z" }),
        ),
    );
    view
}

#[test]
fn a_snapshot_then_live_events_make_the_window() {
    let view = followed();
    assert!(view.ready);
    assert_eq!(view.messages.len(), 2, "a delta adds no message");
    assert_eq!(
        latest_assistant_text(&view).as_deref(),
        Some("Done.\nLint has one error.")
    );
    assert_eq!(active_run_id(&view).as_deref(), Some("r1"));
}

#[test]
fn actions_are_the_agents_work_newest_first() {
    let view = followed();
    let actions = actions_of(&view, 10, false);
    let ids: Vec<&str> = actions.iter().map(|(id, _)| id.as_str()).collect();
    // The permission prompt and the compaction are bookkeeping, not work.
    assert_eq!(ids, ["i4", "i3", "i2", "i1"]);
    let (_, retry) = &actions[0];
    assert_eq!(retry.kind, "other");
    assert_eq!(retry.summary, "API retry 2/10: 529 overloaded");
    assert!(!retry.failed);
    let (_, lint) = &actions[2];
    assert_eq!(
        (lint.kind, lint.status, lint.exit_code, lint.failed),
        ("command", "failed", Some(1), true)
    );
    assert_eq!(actions[1].1.summary, "src/a.ts");
    let failed: Vec<_> = actions_of(&view, 10, true)
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    assert_eq!(failed, ["i2"]);
    assert_eq!(
        omitted_outputs(&view, &["i1".into(), "i2".into(), "i3".into()]),
        ["i2"]
    );
}

#[test]
fn the_tail_mixes_messages_and_actions_newest_first() {
    let view = followed();
    let (rows, truncated) = tail_of(&view, 3, None);
    assert!(!truncated);
    let kinds: Vec<(&str, &str)> = rows
        .iter()
        .map(|(id, r)| {
            (
                id.as_str(),
                match r {
                    TailRow::Message { .. } => "message",
                    TailRow::Action { .. } => "action",
                },
            )
        })
        .collect();
    assert_eq!(
        kinds,
        [("m2", "message"), ("i4", "action"), ("i3", "action")]
    );
    let (only_messages, _) = tail_of(&view, 10, Some(&["message"]));
    assert_eq!(only_messages.len(), 2);
    assert!(matches!(&only_messages[1].1, TailRow::Message { role, .. } if role == "user"));
}

#[test]
fn an_open_command_states_its_timeout_and_another_tool_does_not() {
    let mut view = followed();
    assert_eq!(open_tool(&view, Some("r1")), None);
    apply_thread_event(
        &mut view,
        &event(
            json!({ "type": "item", "id": "i7", "runId": "r1", "status": "running", "title": "",
            "startedAt": "2026-10-17T10:10:00.000Z", "updatedAt": "2026-10-17T10:10:00.000Z",
            "kind": { "type": "command", "command": "sleep 600", "timeoutMs": 600000 } }),
        ),
    );
    assert_eq!(
        open_tool(&view, Some("r1")),
        Some(OpenTool {
            stated_timeout_ms: Some(600_000),
            unstated: false
        })
    );
    // Another run's open tool is not this run's.
    assert_eq!(open_tool(&view, Some("r2")), None);
    apply_thread_event(
        &mut view,
        &event(
            json!({ "type": "item", "id": "i8", "runId": "r1", "status": "running", "title": "WebFetch",
            "startedAt": "2026-10-17T10:11:00.000Z", "updatedAt": "2026-10-17T10:11:00.000Z",
            "kind": { "type": "tool", "toolName": "WebFetch", "input": { "url": "https://example.com" } } }),
        ),
    );
    assert_eq!(
        open_tool(&view, Some("r1")),
        Some(OpenTool {
            stated_timeout_ms: Some(600_000),
            unstated: true
        })
    );
    let (_, newest) = &actions_of(&view, 1, false)[0];
    assert_eq!(
        (newest.kind, newest.summary.as_str()),
        ("tool_call", "WebFetch")
    );
}

#[test]
fn a_pending_prompt_reads_as_what_it_would_do() {
    let p = |summary: &str| PendingPermission {
        request_id: fleetd_contracts::prim::NonEmpty::unchecked("q1"),
        tool_name: fleetd_contracts::prim::NonEmpty::unchecked("Bash"),
        summary: fleetd_contracts::prim::Text::unchecked(summary),
    };
    assert_eq!(
        pending_question_text(&p("rm -rf build")),
        "approve Bash: rm -rf build"
    );
    assert_eq!(pending_question_text(&p(" ")), "approve a Bash call");
    let long = pending_question_text(&p(&"x".repeat(1990)));
    assert_eq!(long.chars().count(), 1500);
    assert!(long.ends_with('…'));
}

#[test]
fn a_node_retry_reads_as_when_and_why() {
    use fleetd_contracts::sessions::FailureClass;
    assert_eq!(
        node_retry_summary(1, 3, 60_000, FailureClass::Overloaded),
        "node retry 1/3 in 60 s: overloaded"
    );
    assert_eq!(
        node_retry_summary(2, 3, 500, FailureClass::Network),
        "node retry 2/3 in 500 ms: network"
    );
}
