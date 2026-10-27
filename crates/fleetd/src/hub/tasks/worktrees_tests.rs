//! Cleanup over a real hub with a fake node: the nightly sweep removes the worktrees of tasks that ended over 3 days
//! ago, keeps one holding work only there and tells the person once, and tries a failed removal again; closing an
//! order stops its leftover agents but not the train's reviewers.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::ledger::{IntakeChannel, WorkstreamId};
use fleetd_contracts::node_link::HubToNode;
use fleetd_contracts::sessions::SessionCall;
use fleetd_contracts::tasks::{Task, TaskId, TaskState};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::TaskRecords;
use super::cap_tests::{AT, Node, hub_on, running};
use super::race_tests::reply;
use crate::hub::api::Hub;
use crate::hub::leads::records::NewWorkstream;
use crate::hub::store::iso_ms;
use crate::hub::store::test_clock::ManualClock;

const NOW: i64 = 1_792_000_000_000;
const DAY: i64 = 86_400_000;

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: ProjectId::unchecked("p1"),
    }
}

/// Answers each removal (a stop with `removeWorktree`) with the next reply scripted for its session, `ok` once none is
/// left, and every other call with `ok`; hands the test each removal's session.
fn serve(
    hub: &Arc<Hub>,
    mut node: Node,
    script: HashMap<&'static str, Vec<Value>>,
) -> mpsc::UnboundedReceiver<String> {
    let (tx, removals) = mpsc::unbounded_channel();
    let hub = hub.clone();
    let script = Mutex::new(script);
    tokio::spawn(async move {
        while let Some(frame) = node.rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let ok = json!({ "ok": { "kind": "done" } });
            let result = match &f.call {
                SessionCall::Stop {
                    session_id,
                    remove_worktree: true,
                } => {
                    let _ = tx.send(session_id.as_str().to_owned());
                    let mut script = script.lock().unwrap();
                    let next = script
                        .get_mut(session_id.as_str())
                        .filter(|r| !r.is_empty());
                    next.map_or(ok, |r| r.remove(0))
                }
                _ => ok,
            };
            reply(&hub, f.id.as_str(), result);
        }
    });
    removals
}

fn refused(code: &str, message: &str) -> Value {
    json!({ "err": { "code": code, "message": message } })
}

/// A finished writer T`n` on session t`n` that ended `days_ago`.
fn ended(hub: &Hub, n: u32, days_ago: i64) -> Task {
    let task: Task = serde_json::from_value(json!({
        "taskId": format!("T{n}"), "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "workstreamId": "W1",
        "title": format!("slice {n}"), "kind": "write", "prompt": "do it", "branch": format!("fleetd/T{n}-slice"),
        "state": "done", "attempt": 1, "createdAt": AT, "startedAt": AT,
        "endedAt": iso_ms(NOW - days_ago * DAY),
        "threadRef": { "machineId": "lab-a", "threadId": format!("t{n}") },
    }))
    .unwrap();
    hub.db.with(|c| Ok(TaskRecords::create(c, task)?)).unwrap()
}

fn drain(removals: &mut mpsc::UnboundedReceiver<String>) -> Vec<String> {
    let mut seen = Vec::new();
    while let Ok(session) = removals.try_recv() {
        seen.push(session);
    }
    seen.sort();
    seen
}

fn system_lines(hub: &Hub) -> Vec<String> {
    let (messages, _, _) = hub.chat.page(&project(), None, None, 100).unwrap();
    messages
        .into_iter()
        .filter(|m| m.author == ChatAuthor::System)
        .map(|m| m.text.to_string())
        .collect()
}

#[tokio::test(flavor = "current_thread")]
async fn the_sweep_removes_old_safe_worktrees_keeps_and_flags_work_once_and_retries_a_failure() {
    let (hub, _home) = hub_on(ManualClock::at(NOW as u64));
    let node = Node::link(&hub).await;
    let mut removals = serve(
        &hub,
        node,
        HashMap::from([
            (
                "t2",
                vec![
                    refused("git", "kept /w/p1/t2: it has uncommitted changes"),
                    refused("git", "kept /w/p1/t2: it has uncommitted changes"),
                ],
            ),
            (
                "t3",
                vec![refused(
                    "git",
                    "fatal: '/w/p1/t3' is locked; use 'unlock' to override",
                )],
            ),
            (
                "t5",
                vec![refused("not_found", "no session t5 on this machine")],
            ),
        ]),
    );
    // T1 is clean and pushed, T2 holds uncommitted changes, T3's removal fails once, T4 ended only yesterday, and the
    // node no longer knows T5's session.
    for (n, days_ago) in [(1, 4), (2, 4), (3, 4), (4, 1), (5, 10)] {
        ended(&hub, n, days_ago);
    }

    let first = hub.tasks.sweep_worktrees().await;
    assert_eq!(
        (first.removed, first.kept, first.failed),
        (2, 1, 1),
        "T1 and T5 gone, T2 kept, T3 failed"
    );
    assert_eq!(
        drain(&mut removals),
        ["t1", "t2", "t3", "t5"],
        "T4 is too recent"
    );
    let lines = system_lines(&hub);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(
        lines[0].contains("\"slice 2\" (T2) on lab-a: it has uncommitted changes")
            && lines[0].contains("/w/p1/t2"),
        "{}",
        lines[0]
    );

    // The next night: T3's removal is tried again and goes through; T2 is still kept, and not flagged again.
    let second = hub.tasks.sweep_worktrees().await;
    assert_eq!((second.removed, second.kept, second.failed), (1, 1, 0));
    assert_eq!(
        drain(&mut removals),
        ["t2", "t3"],
        "removed ones aren't asked again"
    );
    assert_eq!(system_lines(&hub).len(), 1, "flagged once");

    // Once its work is pushed, T2's worktree goes too.
    let third = hub.tasks.sweep_worktrees().await;
    assert_eq!((third.removed, third.kept, third.failed), (1, 0, 0));
    assert_eq!(drain(&mut removals), ["t2"]);
}

#[tokio::test(flavor = "current_thread")]
async fn the_sweep_leaves_a_project_that_keeps_its_worktrees_alone() {
    let (hub, _home) = hub_on(ManualClock::at(NOW as u64));
    let node = Node::link(&hub).await;
    let mut removals = serve(&hub, node, HashMap::new());
    hub.db
        .project_settings()
        .set_keep_worktrees(&project(), true)
        .unwrap();
    ended(&hub, 1, 30);
    assert_eq!(hub.tasks.sweep_worktrees().await, Default::default());
    assert!(drain(&mut removals).is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn closing_an_order_stops_its_leftover_agents_but_not_the_trains_reviewers() {
    let (hub, _home) = hub_on(ManualClock::at(NOW as u64));
    let node = Node::link(&hub).await;
    let mut removals = serve(&hub, node, HashMap::new());
    let (w, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: project(),
            title: "Ship the API".into(),
            text: "Ship the API".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    assert_eq!(w.workstream_id, WorkstreamId::unchecked("W1"));
    // T1 and T2 run; T2 is a reviewer the train spawned. T3 waits for a slot, T4 is done.
    running(&hub, 1);
    running(&hub, 2);
    hub.db
        .with(|c| {
            Ok(c.execute(
                "INSERT INTO review_tasks (task_id, change_id, role, patch_id) VALUES ('T2', 'C1', 'reviewer', 'p')",
                [],
            )?)
        })
        .unwrap();
    let mut queued = running(&hub, 3);
    queued.state = TaskState::Queued;
    hub.db
        .with(|c| {
            Ok(TaskRecords::put(
                c,
                &super::StoredTask {
                    task: queued,
                    pending_message: None,
                },
            )?)
        })
        .unwrap();
    ended(&hub, 4, 0);

    let closed = hub
        .leads
        .workstreams
        .close(&project(), &w.workstream_id, "shipped", "lead:lab-a/p1")
        .await
        .unwrap();
    let state = |n: u32| {
        hub.tasks
            .get(&TaskId::unchecked(format!("T{n}")))
            .unwrap()
            .unwrap()
            .state
    };
    assert_eq!(
        [state(1), state(2), state(3), state(4)],
        [
            TaskState::Cancelled,
            TaskState::Running,
            TaskState::Cancelled,
            TaskState::Done
        ]
    );
    let next = closed.next.unwrap();
    assert!(
        next.contains("Stopped its agents still at it: T1, T3."),
        "{next}"
    );
    assert!(
        drain(&mut removals).is_empty(),
        "a stop at close keeps the worktree"
    );
}
