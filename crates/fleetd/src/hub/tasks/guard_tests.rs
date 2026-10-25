//! The disk and load guard and the usage soft brake over a real hub with a fake node: new agents wait while the
//! machine is short of disk or its login's window is nearly used, running ones keep going, and room again starts the
//! waiting ones. A merged writer's worktree goes.
use std::sync::Arc;

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::node_link::{HubToNode, NodeToHub};
use fleetd_contracts::sessions::SessionCall;
use fleetd_contracts::tasks::{Task, TaskId, TaskState};
use serde_json::json;
use tokio::sync::mpsc;

use super::cap_tests::{AT, Node, hub, running};
use crate::hub::api::Hub;
use crate::hub::link::guard::tests::load;
use crate::hub::store::NewEvent;

fn lab_a() -> MachineId {
    MachineId::unchecked("lab-a")
}

fn insert(hub: &Hub, task: serde_json::Value) -> Task {
    let mut base = json!({
        "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "workstreamId": "W1", "prompt": "do it",
        "kind": "read", "model": "claude-haiku-5-5", "effort": "low", "attempt": 1, "createdAt": AT,
    });
    base.as_object_mut()
        .unwrap()
        .extend(task.as_object().unwrap().clone());
    let task: Task = serde_json::from_value(base).unwrap();
    hub.db
        .with(|c| Ok(super::TaskRecords::create(c, task)?))
        .unwrap()
}

fn state(hub: &Hub, id: &str) -> Task {
    hub.tasks.get(&TaskId::unchecked(id)).unwrap().unwrap()
}

/// Applies the events the tasks area follows, as its follower would.
async fn catch_up(tasks: &Arc<super::Tasks>) {
    let _guard = tasks.lock.lock().await;
    tasks.catch_up().await;
}

/// Answers every call the hub sends the node (a file read finds nothing; anything else is done) and hands each one
/// to the test.
fn serve(hub: &Arc<Hub>, mut node: Node) -> mpsc::UnboundedReceiver<SessionCall> {
    let (tx, calls) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = node.rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let result = match f.call {
                SessionCall::ReadFile { .. } => json!({ "ok": { "kind": "file" } }),
                _ => json!({ "ok": { "kind": "done" } }),
            };
            let reply = json!({ "t": "session_reply", "id": f.id, "result": result });
            hub.executors.handle_frame(
                &lab_a(),
                serde_json::from_value::<NodeToHub>(reply).unwrap(),
            );
            let _ = tx.send(f.call);
        }
    });
    calls
}

/// Every `machine.guard` event's `data.paused`, in order.
fn guard_events(hub: &Hub) -> Vec<bool> {
    hub.db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT json_extract(data, '$.data.paused') FROM events WHERE type = 'machine.guard' ORDER BY seq",
            )?;
            let rows = stmt
                .query_map([], |r| r.get::<_, bool>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap()
}

#[tokio::test]
async fn low_disk_holds_new_agents_keeps_running_ones_and_room_again_starts_them() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    insert(
        &hub,
        json!({ "taskId": "T2", "title": "next slice", "state": "queued", "queuedReason": "Max agents: 1 of 1 running" }),
    );

    hub.link
        .observe_load(&lab_a(), Some(load(14, 3.0)), NODE_AT);
    let paused = "Paused new agents: 14 GB free on lab-a";
    assert_eq!(hub.link.paused(&lab_a()).as_deref(), Some(paused));
    catch_up(&hub.tasks).await;
    let waiting = state(&hub, "T2");
    assert_eq!(waiting.state, TaskState::Queued);
    assert_eq!(waiting.queued_reason.as_ref().unwrap().as_str(), paused);
    assert_eq!(state(&hub, "T1").state, TaskState::Running);
    while let Ok(call) = calls.try_recv() {
        assert!(
            !matches!(call, SessionCall::Stop { .. }),
            "a running agent is never stopped"
        );
    }

    // Within the margin it stays paused; the line follows the figure, with no new event.
    hub.link
        .observe_load(&lab_a(), Some(load(105, 3.0)), NODE_AT);
    assert_eq!(
        hub.link.paused(&lab_a()).as_deref(),
        Some("Paused new agents: 105 GB free on lab-a")
    );
    assert_eq!(guard_events(&hub), [true]);

    hub.link
        .observe_load(&lab_a(), Some(load(111, 3.0)), NODE_AT);
    assert_eq!(hub.link.paused(&lab_a()), None);
    assert_eq!(guard_events(&hub), [true, false]);
    catch_up(&hub.tasks).await;
    assert_eq!(state(&hub, "T2").state, TaskState::Running);
    assert_eq!(state(&hub, "T1").state, TaskState::Running);
}

/// The heartbeat's time on the node's clock: the test clock's, when the 5-hour reading below was taken.
const NODE_AT: &str = "2026-10-14T17:46:40.000Z";

/// `load` with one 5-hour window `used` of the way through, read at the test clock's time and resetting after it.
fn used(used: f64) -> fleetd_contracts::node_link::NodeLoad {
    let mut l = load(500, 3.0);
    l.limits = serde_json::from_value(json!([{
        "limitType": "five_hour", "utilization": used, "resetsAt": "2026-10-30T14:00:00.000Z", "status": "allowed",
        "observedAt": "2026-10-14T17:46:40.000Z",
    }]))
    .unwrap();
    l
}

#[tokio::test]
async fn a_nearly_used_window_holds_new_agents_keeps_running_ones_and_below_85_starts_them() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    insert(
        &hub,
        json!({ "taskId": "T2", "title": "next slice", "state": "queued", "queuedReason": "Max agents: 1 of 1 running" }),
    );

    hub.link.observe_load(&lab_a(), Some(used(0.91)), NODE_AT);
    let paused = "Paused new agents: 5-hour limit 91% on lab-a as of 17:46 UTC, resets Fri 14:00 UTC (pauses at 90%, lifts below 85%)";
    assert_eq!(hub.link.paused(&lab_a()).as_deref(), Some(paused));
    catch_up(&hub.tasks).await;
    let waiting = state(&hub, "T2");
    assert_eq!(waiting.state, TaskState::Queued);
    assert_eq!(waiting.queued_reason.as_ref().unwrap().as_str(), paused);
    assert_eq!(state(&hub, "T1").state, TaskState::Running);
    while let Ok(call) = calls.try_recv() {
        assert!(
            !matches!(call, SessionCall::Stop { .. }),
            "a running agent is never stopped"
        );
    }

    hub.link.observe_load(&lab_a(), Some(used(0.87)), NODE_AT);
    assert!(
        hub.link.paused(&lab_a()).is_some(),
        "between 85% and 90% it stays braked"
    );
    assert_eq!(guard_events(&hub), [true]);

    hub.link.observe_load(&lab_a(), Some(used(0.84)), NODE_AT);
    assert_eq!(hub.link.paused(&lab_a()), None);
    assert_eq!(guard_events(&hub), [true, false]);
    catch_up(&hub.tasks).await;
    assert_eq!(state(&hub, "T2").state, TaskState::Running);
}

#[tokio::test]
async fn a_merged_writer_has_the_node_remove_its_worktree() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    // The store numbers tasks itself: this one is T1.
    let task = insert(
        &hub,
        json!({ "taskId": "T3", "title": "fix", "kind": "write", "state": "done",
            "threadRef": { "machineId": "lab-a", "threadId": "t3" }, "branch": "fleetd/T3-fix", "startedAt": AT,
            "endedAt": AT }),
    );
    let merged: NewEvent = serde_json::from_value(json!({
        "at": AT, "type": "pr.merged", "machineId": "lab-a", "projectId": "p1", "summary": "X1 merged",
        "data": { "changeId": "X1", "taskId": task.task_id, "repo": "o/r", "prNumber": 7 },
    }))
    .unwrap();
    hub.events.append(merged).unwrap();
    catch_up(&hub.tasks).await;
    loop {
        if let SessionCall::Stop {
            session_id,
            remove_worktree,
        } = calls.recv().await.unwrap()
        {
            assert_eq!(session_id.as_str(), "t3");
            assert!(remove_worktree);
            break;
        }
    }
}
