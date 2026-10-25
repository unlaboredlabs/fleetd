//! An earlier run's end never ends the run a task is on, over a real hub with a fake node. T19 on Oct 22: its node
//! was stopped mid-run; when the node came back, the hub continued T19 and only then applied the end of the run the
//! stop had cut off, and the lead was told "T19 failed" while the new run worked on.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::ids::{MachineId, ThreadId, ThreadRef};
use fleetd_contracts::node_link::{HubToNode, NodeToHub};
use fleetd_contracts::sessions::SessionCall;
use fleetd_contracts::tasks::{Task, TaskId, TaskState};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::cap_tests::{AT, Node, hub, hub_on, running};
use super::{StoredTask, TaskRecords};
use crate::hub::api::Hub;
use crate::hub::store::NewEvent;
use crate::hub::store::test_clock::ManualClock;

const RESUME: &str = "A slot is free again; continue where you left off.";

pub(super) fn lab_a() -> MachineId {
    MachineId::unchecked("lab-a")
}

pub(super) fn t1() -> ThreadRef {
    ThreadRef {
        machine_id: lab_a(),
        thread_id: ThreadId::unchecked("t1"),
    }
}

pub(super) fn task(hub: &Hub) -> Task {
    hub.tasks.get(&TaskId::unchecked("T1")).unwrap().unwrap()
}

/// The node's update of session t1: its latest run `run` in `status` (a run status).
fn push(hub: &Hub, seq: u64, run: &str, status: &str) {
    let active = matches!(status, "queued" | "starting" | "running");
    let session_status = match status {
        _ if active => "running",
        "completed" => "idle",
        other => other,
    };
    let mut event = json!({ "type": "session_updated", "sessionId": "t1", "projectId": "p1", "title": "t1",
        "status": session_status, "model": "claude-haiku-5-5", "effort": "low", "runtimeMode": "approval-required",
        "latestRun": { "id": run, "status": status, "ordinal": 1 }, "createdAt": AT, "updatedAt": AT });
    if active {
        event["activeRunId"] = json!(run);
    }
    frame(
        hub,
        json!({ "t": "machine_event", "seq": seq, "at": AT, "event": event }),
    );
}

pub(super) fn frame(hub: &Hub, frame: Value) {
    hub.executors.handle_frame(
        &lab_a(),
        serde_json::from_value::<NodeToHub>(frame).unwrap(),
    );
}

pub(super) fn reply(hub: &Hub, id: &str, result: Value) {
    frame(
        hub,
        json!({ "t": "session_reply", "id": id, "result": result }),
    );
}

/// Waits until the executor has logged `kind` for t1's run `run`.
pub(super) async fn logged(hub: &Hub, kind: &str, run: &str) {
    for _ in 0..400 {
        let n: i64 = hub
            .db
            .with(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM events WHERE type = ?1 AND json_extract(data, '$.threadId') = 't1'
                       AND json_extract(data, '$.data.runId') = ?2",
                    [kind, run],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        if n > 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no {kind} for run {run}");
}

/// Answers every call the hub sends the node and hands each one to the test. A thread follow is refused, so reading a
/// task's last actions when it ends gives up at once.
pub(super) fn serve(hub: &Arc<Hub>, mut node: Node) -> mpsc::UnboundedReceiver<SessionCall> {
    let (tx, calls) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = node.rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let result = match &f.call {
                SessionCall::Follow { .. } => {
                    json!({ "err": { "code": "not_found", "message": "not in this test" } })
                }
                _ => json!({ "ok": { "kind": "done" } }),
            };
            reply(&hub, f.id.as_str(), result);
            let _ = tx.send(f.call);
        }
    });
    calls
}

/// The next send the node was asked for: its run id and text.
pub(super) async fn sent(calls: &mut mpsc::UnboundedReceiver<SessionCall>) -> (String, String) {
    loop {
        if let SessionCall::Send { run_id, text, .. } = calls.recv().await.unwrap() {
            return (run_id.as_str().to_owned(), text.as_str().to_owned());
        }
    }
}

/// The follower's work: applies every thread event appended so far.
pub(super) async fn catch_up(tasks: &Arc<super::Tasks>) {
    let _guard = tasks.lock.lock().await;
    tasks.catch_up().await;
}

/// Every task event's summary, in order.
pub(super) fn task_lines(hub: &Hub) -> Vec<String> {
    hub.db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT json_extract(data, '$.summary') FROM events WHERE type LIKE 'task.%' ORDER BY seq",
            )?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap()
}

/// T1, paused by a lowered max agents: queued with its resume, its thread t1 still running the checkpoint turn `r2`.
async fn paused_on_r2(hub: &Hub) {
    let stored = StoredTask {
        task: Task {
            state: TaskState::Queued,
            queued_reason: Some(super::queued_reason(
                "paused: max agents lowered to 1; resumes when a slot frees",
            )),
            ..running(hub, 1)
        },
        pending_message: Some(RESUME.to_owned()),
    };
    hub.db.with(|c| Ok(TaskRecords::put(c, &stored)?)).unwrap();
    push(hub, 3, "r2", "running");
    logged(hub, "thread.started", "r2").await;
    catch_up(&hub.tasks).await;
}

/// T19's events 526-532, in the order they happened: the node is stopped under the paused task's checkpoint turn and
/// is offline for hours. When it is back, it reports that turn interrupted, and the task is continued in its thread.
/// The end of the old turn doesn't fail it: the task runs on, and its new run's end is what finishes it.
#[tokio::test]
async fn a_node_back_from_a_stop_never_fails_the_task_it_continues() {
    let (hub, _home) = hub();
    let _calls = serve(&hub, Node::link(&hub).await);
    paused_on_r2(&hub).await;

    // The node stops; the queue, run while it is away, waits for it.
    hub.executors.detach(&lab_a()).await;
    {
        let _guard = hub.tasks.lock.lock().await;
        hub.tasks.retry_queue().await;
    }
    let waiting = task(&hub);
    assert_eq!(waiting.state, TaskState::Queued);
    assert_eq!(
        waiting.queued_reason.unwrap().as_str(),
        "machine lab-a is offline"
    );

    // Back: the node reports r2 interrupted (seq 528) before the waiting queue gets to run (530), as on Oct 22.
    let held = hub.tasks.lock.lock().await;
    let (tx, mut rx) = mpsc::unbounded_channel();
    hub.executors
        .attach(
            &lab_a(),
            crate::hub::executor::NodeSessions {
                link_id: 2,
                send: tx,
            },
        )
        .await;
    let HubToNode::SessionCall(subscribe) = rx.recv().await.unwrap() else {
        panic!("not a subscribe")
    };
    push(&hub, 4, "r2", "interrupted");
    reply(
        &hub,
        subscribe.id.as_str(),
        json!({ "ok": { "kind": "done" } }),
    );
    logged(&hub, "thread.interrupted", "r2").await;
    let mut calls = serve(&hub, Node { rx });
    drop(held);

    let (run, text) = sent(&mut calls).await;
    assert_eq!(text, RESUME, "the task is continued in its thread");
    catch_up(&hub.tasks).await;
    assert_eq!(task(&hub).state, TaskState::Running);

    // The new run starts and completes: that is the task's end.
    push(&hub, 5, &run, "running");
    push(&hub, 6, &run, "completed");
    logged(&hub, "thread.completed", &run).await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(&hub).state, TaskState::Done);
    assert_eq!(
        task_lines(&hub),
        [
            "T1 queued: machine lab-a is offline",
            "T1 continued (attempt 1): slice 1",
            "T1 completed: slice 1",
        ]
    );
}

/// The task is continued before the follower has applied its checkpoint turn's end, and only then does the node report
/// a run the hub never saw start, cut off by a stop. Neither end is the continued run's, so the task runs on.
#[tokio::test]
async fn an_end_reported_after_the_continue_went_out_is_not_the_tasks() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    paused_on_r2(&hub).await;
    push(&hub, 4, "r2", "completed");
    logged(&hub, "thread.completed", "r2").await;

    let tasks = hub.tasks.clone();
    let continued = tokio::spawn(async move {
        let _guard = tasks.lock.lock().await;
        tasks.retry_queue().await;
    });
    let (run, _) = sent(&mut calls).await;
    continued.await.unwrap();
    assert_eq!(task(&hub).state, TaskState::Running);

    // Late word of a run the hub never saw, cut off by a node stop.
    push(&hub, 5, "r3", "interrupted");
    logged(&hub, "thread.interrupted", "r3").await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(&hub).state, TaskState::Running);

    // The continued run starts, and its own interrupt is the task's end.
    push(&hub, 6, &run, "running");
    push(&hub, 7, &run, "interrupted");
    logged(&hub, "thread.interrupted", &run).await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(&hub).state, TaskState::Failed);
}

/// A run's failure that the follower applies after a newer run started on the thread is not the task's end; the
/// newer run's is.
#[tokio::test]
async fn an_end_superseded_by_a_newer_run_is_not_the_tasks() {
    let (hub, _home) = hub();
    let _calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    push(&hub, 3, "r1", "interrupted");
    push(&hub, 4, "r2", "running");
    logged(&hub, "thread.started", "r2").await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(&hub).state, TaskState::Running);
    assert!(task_lines(&hub).is_empty(), "{:?}", task_lines(&hub));

    push(&hub, 5, "r2", "failed");
    logged(&hub, "thread.failed", "r2").await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(&hub).state, TaskState::Failed);
    assert_eq!(task_lines(&hub), ["T1 failed: slice 1"]);
    assert_eq!(task(&hub).thread_ref, Some(t1()));
}

/// The watchdog fails a stalled run while the lead's steer waits queued behind it: the node's latest run is then the
/// steer, but the stall is the running run's, and the task fails with it.
#[tokio::test]
async fn a_stall_with_a_steer_queued_behind_it_fails_the_task() {
    let (hub, _home) = hub();
    let _calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    frame(
        &hub,
        json!({ "t": "machine_event", "seq": 3, "at": AT, "event": { "type": "session_updated", "sessionId": "t1",
            "projectId": "p1", "title": "t1", "status": "running", "model": "claude-haiku-5-5", "effort": "low",
            "runtimeMode": "approval-required", "activeRunId": "r1",
            "latestRun": { "id": "r2", "status": "queued", "ordinal": 2 }, "createdAt": AT, "updatedAt": AT } }),
    );
    logged(&hub, "thread.started", "r2").await;
    catch_up(&hub.tasks).await;

    let stalled: NewEvent = serde_json::from_value(json!({
        "at": AT, "type": "thread.failed", "machineId": "lab-a", "projectId": "p1", "threadId": "t1",
        "summary": "stalled: no progress for 20 min inside a tool, so fleetd interrupted it",
        "data": { "status": "failed", "runId": "r1", "reason": "stalled",
            "error": { "class": "stalled", "message": "no progress for 20 min inside a tool, so fleetd interrupted it" } },
    }))
    .unwrap();
    hub.events.append(stalled).unwrap();
    catch_up(&hub.tasks).await;
    let failed = task(&hub);
    assert_eq!(failed.state, TaskState::Failed);
    assert_eq!(
        failed.result.unwrap().tail.as_str(),
        "[stalled] no progress for 20 min inside a tool, so fleetd interrupted it"
    );
}

/// The node takes the continue and then dies before the run starts, so that run never shows up. Ends of other runs
/// are ignored only for a while: after that, the task's next end ends it, rather than leaving it running for good.
#[tokio::test]
async fn a_continued_run_that_never_shows_up_is_given_up_on() {
    let clock = ManualClock::at(1_792_000_000_000);
    let (hub, _home) = hub_on(clock.clone());
    let mut calls = serve(&hub, Node::link(&hub).await);
    paused_on_r2(&hub).await;
    push(&hub, 4, "r2", "completed");
    logged(&hub, "thread.completed", "r2").await;
    let tasks = hub.tasks.clone();
    let continued = tokio::spawn(async move {
        let _guard = tasks.lock.lock().await;
        tasks.retry_queue().await;
    });
    sent(&mut calls).await;
    continued.await.unwrap();
    catch_up(&hub.tasks).await;
    assert_eq!(task(&hub).state, TaskState::Running);

    clock.advance(Duration::from_secs(2 * 60));
    push(&hub, 5, "r3", "interrupted");
    logged(&hub, "thread.interrupted", "r3").await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(&hub).state, TaskState::Failed);
}
