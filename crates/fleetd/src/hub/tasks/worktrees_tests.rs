//! Cleanup over a real hub with a fake node: the nightly sweep removes the worktrees of tasks that ended over 3 days
//! ago, keeps one holding work only there and tells the person once, tries a failed removal again and gives up after a
//! week, and skips one already removed at its task's end; closing an order stops its leftover agents but not the
//! train's reviewers, and the sweep cancels tasks left queued under orders closed before that.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::ledger::{IntakeChannel, WorkstreamId};
use fleetd_contracts::node_link::HubToNode;
use fleetd_contracts::sessions::SessionCall;
use fleetd_contracts::tasks::{Task, TaskId, TaskState};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::cap_tests::{AT, Node, hub_on, running};
use super::race_tests::reply;
use super::worktrees::MAX_TRIES;
use super::{TaskCaller, TaskRecords};
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

fn open_order(hub: &Hub, title: &str) -> WorkstreamId {
    hub.leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: project(),
            title: title.into(),
            text: title.into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap()
        .0
        .workstream_id
}

/// Task T`n` of order `w`, waiting for a slot.
fn queued(hub: &Hub, n: u32, w: &WorkstreamId) {
    let mut task = running(hub, n);
    task.state = TaskState::Queued;
    task.workstream_id = w.clone();
    hub.db
        .with(|c| {
            Ok(TaskRecords::put(
                c,
                &super::StoredTask {
                    task,
                    pending_message: None,
                },
            )?)
        })
        .unwrap();
}

fn refused(code: &str, message: &str) -> Value {
    json!({ "err": { "code": code, "message": message } })
}

/// A finished writer T`n` on session t`n` that ended `days_ago`.
fn ended(hub: &Hub, n: u32, days_ago: i64) -> Task {
    ended_on(hub, "lab-a", n, days_ago)
}

/// The same, in project p1 of `machine`.
fn ended_on(hub: &Hub, machine: &str, n: u32, days_ago: i64) -> Task {
    let task: Task = serde_json::from_value(json!({
        "taskId": format!("T{n}"), "projectRef": { "machineId": machine, "projectId": "p1" }, "workstreamId": "W1",
        "title": format!("slice {n}"), "kind": "write", "prompt": "do it", "branch": format!("fleetd/T{n}-slice"),
        "state": "done", "attempt": 1, "createdAt": AT, "startedAt": AT,
        "endedAt": iso_ms(NOW - days_ago * DAY),
        "threadRef": { "machineId": machine, "threadId": format!("t{n}") },
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
    system_lines_in(hub, &project())
}

fn system_lines_in(hub: &Hub, r: &ProjectRef) -> Vec<String> {
    let (messages, _, _) = hub.chat.page(r, None, None, 100).unwrap();
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

#[tokio::test(flavor = "current_thread")]
async fn a_worktree_removed_at_its_tasks_end_is_not_asked_about_again() {
    let clock = ManualClock::at(NOW as u64);
    let (hub, _home) = hub_on(clock.clone());
    let node = Node::link(&hub).await;
    let mut removals = serve(&hub, node, HashMap::new());
    running(&hub, 1);
    let caller = TaskCaller {
        project_ref: project(),
        by: "lead:lab-a/p1".into(),
    };
    hub.tasks
        .cancel(&caller, &TaskId::unchecked("T1"), None)
        .await
        .unwrap();
    // A reader's worktree goes when it ends, and that is recorded.
    assert_eq!(removals.recv().await.unwrap(), "t1");
    for _ in 0..400 {
        let seen: Option<String> = hub
            .db
            .with(|c| Ok(c.query_row("SELECT worktree FROM tasks WHERE n = 1", [], |r| r.get(0))?))
            .unwrap();
        if seen.as_deref() == Some("removed") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    clock.advance(Duration::from_millis(4 * DAY as u64));
    assert_eq!(hub.tasks.sweep_worktrees().await, Default::default());
    assert!(drain(&mut removals).is_empty(), "nothing asked again");
}

#[tokio::test(flavor = "current_thread")]
async fn a_worktree_whose_machine_never_answers_is_given_up_after_a_week_with_one_line() {
    let (hub, _home) = hub_on(ManualClock::at(NOW as u64));
    let gone = ProjectRef {
        machine_id: MachineId::unchecked("lab-b"),
        project_id: ProjectId::unchecked("p1"),
    };
    // lab-b's node never links: each removal finds it offline.
    ended_on(&hub, "lab-b", 1, 10);
    ended_on(&hub, "lab-b", 2, 10);
    for night in 1..MAX_TRIES {
        let swept = hub.tasks.sweep_worktrees().await;
        assert_eq!(swept.failed, 2, "night {night}");
        assert!(system_lines_in(&hub, &gone).is_empty(), "night {night}");
    }
    assert_eq!(hub.tasks.sweep_worktrees().await.failed, 2);
    let lines = system_lines_in(&hub, &gone);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(
        lines[0].contains("T1 on lab-b, T2 on lab-b after 7 nightly tries"),
        "{}",
        lines[0]
    );
    // Given up: not tried, nor told, again.
    assert_eq!(hub.tasks.sweep_worktrees().await, Default::default());
    assert_eq!(system_lines_in(&hub, &gone).len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn a_task_left_queued_under_an_order_closed_earlier_is_cancelled() {
    let (hub, _home) = hub_on(ManualClock::at(NOW as u64));
    let node = Node::link(&hub).await;
    let _removals = serve(&hub, node, HashMap::new());
    let closed = open_order(&hub, "Ship the API");
    let open = open_order(&hub, "Add dark mode");
    queued(&hub, 1, &closed);
    queued(&hub, 2, &open);
    // Closed before `close` stopped its agents: T1 stayed queued.
    let mut order = hub.leads.records.workstream_get(&closed).unwrap().unwrap();
    order.state = fleetd_contracts::ledger::WorkstreamState::Done;
    hub.leads.records.workstream_put(&order).unwrap();

    assert_eq!(hub.tasks.cancel_closed_queued().await, 1);
    let state = |n: u32| {
        hub.tasks
            .get(&TaskId::unchecked(format!("T{n}")))
            .unwrap()
            .unwrap()
            .state
    };
    assert_eq!(state(1), TaskState::Cancelled);
    // T1's freed place started T2 (the fake node refuses its launch): its order is open.
    assert_ne!(state(2), TaskState::Cancelled);
    assert_eq!(hub.tasks.cancel_closed_queued().await, 0);
}
