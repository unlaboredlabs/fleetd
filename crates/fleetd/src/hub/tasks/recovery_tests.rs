//! Automatic recovery over a real hub with a fake node: the deaths of T18, T19 and T23 on Oct 22 (their node was
//! stopped under them, and came back hours later) each resume about 30 s after the node is back, with no message to
//! the lead. One that keeps dying is escalated, and one that waits, or was cancelled, is left alone.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::ledger::IntakeChannel;
use fleetd_contracts::node_link::HubToNode;
use fleetd_contracts::sessions::SessionCall;
use fleetd_contracts::tasks::{TaskId, TaskState};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::TaskCaller;
use super::cap_tests::{AT, Node, hub_on, running};
use super::race_tests::{catch_up, frame, lab_a, logged, reply, sent, serve, task, task_lines};
use crate::hub::api::Hub;
use crate::hub::leads::records::NewWorkstream;
use crate::hub::store::NewEvent;
use crate::hub::store::test_clock::ManualClock;

type Calls = mpsc::UnboundedReceiver<SessionCall>;

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: ProjectId::unchecked("p1"),
    }
}

/// T1, a reader in the open workstream W1, running on thread t1's run r1, with the node linked.
async fn running_t1() -> (Arc<Hub>, Arc<ManualClock>, Calls, tempfile::TempDir) {
    let clock = ManualClock::at(1_792_000_000_000);
    let (hub, home) = hub_on(clock.clone());
    hub.leads
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
    let calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    (hub, clock, calls, home)
}

/// The node's update of session t1: run `run` in `status`, with `end` (a run's `end`, `failure`) on it.
fn session(hub: &Hub, seq: u64, run: &str, status: &str, end: Value) {
    let active = matches!(status, "queued" | "starting" | "running" | "waiting");
    let session_status = match status {
        "completed" => "idle",
        "queued" | "starting" => "running",
        other => other,
    };
    let mut latest = json!({ "id": run, "status": status, "ordinal": seq });
    latest
        .as_object_mut()
        .unwrap()
        .extend(end.as_object().cloned().unwrap_or_default());
    let mut event = json!({ "type": "session_updated", "sessionId": "t1", "projectId": "p1", "title": "t1",
        "status": session_status, "model": "claude-haiku-5-5", "effort": "low", "runtimeMode": "approval-required",
        "latestRun": latest, "createdAt": AT, "updatedAt": AT });
    if active {
        event["activeRunId"] = json!(run);
    }
    if status == "waiting" {
        event["pendingPermission"] =
            json!({ "requestId": "q1", "toolName": "Bash", "summary": "rm -rf build" });
    }
    frame(
        hub,
        json!({ "t": "machine_event", "seq": seq, "at": AT, "event": event }),
    );
}

/// The node goes away for `away`, then links again; `report` is what it says first on its return.
async fn away_and_back(
    hub: &Arc<Hub>,
    clock: &ManualClock,
    away: Duration,
    report: impl FnOnce(&Hub),
) -> Calls {
    hub.executors.detach(&lab_a()).await;
    clock.advance(away);
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
    report(hub);
    reply(
        hub,
        subscribe.id.as_str(),
        json!({ "ok": { "kind": "done" } }),
    );
    serve(hub, Node { rx })
}

/// What the Oct 22 node reported on its return: the cut-off run interrupted, late, with no cause and no failure.
/// Then the session as it reads now, which ends the run in the hub's row of the thread too.
fn late_interrupt(hub: &Hub, run: &str) {
    let event: NewEvent = serde_json::from_value(json!({
        "at": AT, "type": "thread.interrupted", "machineId": "lab-a", "projectId": "p1", "threadId": "t1",
        "summary": "\"t1\" on lab-a was interrupted",
        "data": { "status": "interrupted", "runId": run, "late": true },
    }))
    .unwrap();
    hub.events.append(event).unwrap();
    session(hub, 3, run, "interrupted", json!({}));
}

/// Waits until the hub's row of t1 no longer says it runs.
async fn ended(hub: &Hub) {
    for _ in 0..400 {
        let row = hub.store.thread_get(&super::race_tests::t1()).unwrap();
        if row.is_some_and(|t| t.thread.status != fleetd_contracts::model::ThreadStatus::Running) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("t1 still runs");
}

/// No send reaches the node within a moment.
async fn nothing_sent(calls: &mut Calls) {
    tokio::time::sleep(Duration::from_millis(50)).await;
    while let Ok(call) = calls.try_recv() {
        assert!(!matches!(call, SessionCall::Send { .. }), "sent {call:?}");
    }
}

/// The task's queued reason, while it waits to resume.
fn reason(hub: &Hub) -> String {
    let t = task(hub);
    assert_eq!(t.state, TaskState::Queued, "{t:?}");
    t.queued_reason.unwrap().as_str().to_owned()
}

/// The death has been applied: T1 waits to resume, nothing went to the node or the lead. It goes 30-40 s later.
async fn resumes_about_30_s_later(
    hub: &Hub,
    clock: &ManualClock,
    calls: &mut Calls,
    cause: &str,
) -> String {
    catch_up(&hub.tasks).await;
    assert!(
        reason(hub).starts_with(&format!("recovering: {cause}; resumes at ")),
        "{}",
        reason(hub)
    );
    clock.advance(Duration::from_secs(29));
    {
        let _guard = hub.tasks.lock.lock().await;
        hub.tasks.retry_queue().await;
    }
    nothing_sent(calls).await;
    assert_eq!(task(hub).state, TaskState::Queued);

    clock.advance(Duration::from_secs(12));
    let (run, text) = sent(calls).await;
    assert!(
        text.starts_with(&format!("fleetd: your run was cut off ({cause}).")),
        "{text}"
    );
    assert!(text.ends_with("(Automatic recovery 1 of 3.)"), "{text}");
    let resumed = task(hub);
    assert_eq!(
        (resumed.state, resumed.attempt.get()),
        (TaskState::Running, 2)
    );
    assert!(
        !hub.leads.wakes.pending(&project()),
        "the lead is not woken"
    );
    run
}

/// The resumed run starts and completes: the task is done, and the lead hears of it once, as for any task.
async fn completes(hub: &Hub, run: &str, seq: u64) {
    session(hub, seq, run, "running", json!({}));
    session(
        hub,
        seq + 1,
        run,
        "completed",
        json!({ "end": "completed" }),
    );
    logged(hub, "thread.completed", run).await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(hub).state, TaskState::Done);
}

/// T18 and T19: the node stopped at 11:49 and came back at 14:24. Their run's end came late, with no cause (the node
/// then recorded none).
#[tokio::test]
async fn t18_and_t19_resume_about_30_s_after_their_node_is_back() {
    let (hub, clock, _first, _home) = running_t1().await;
    let mut calls = away_and_back(
        &hub,
        &clock,
        Duration::from_secs(2 * 3600 + 35 * 60),
        |hub| late_interrupt(hub, "r1"),
    )
    .await;
    ended(&hub).await;
    let run =
        resumes_about_30_s_later(&hub, &clock, &mut calls, "the node on lab-a went away").await;
    assert!(
        hub.tasks.digest_lines(&project(), None, 10)[0].ends_with(
            "; resumed automatically after the node on lab-a went away, recovery 1 of 3"
        ),
        "{:?}",
        hub.tasks.digest_lines(&project(), None, 10)
    );
    completes(&hub, &run, 10).await;
    let lines = task_lines(&hub);
    assert!(
        lines[0].starts_with("T1 queued: recovering: the node on lab-a went away; resumes at ")
    );
    assert_eq!(
        lines[1..],
        [
            "T1 resumed automatically (attempt 2, recovery 1 of 3): slice 1",
            "T1 completed: slice 1"
        ]
    );
}

/// T23: stopped at 15:10, back the next morning. Today's node reports the stop, and a crash or SIGKILL as a restart.
#[tokio::test]
async fn t23_resumes_about_30_s_after_its_node_is_back_after_a_stop_or_a_crash() {
    for (end, message, cause) in [
        (
            "node_stopping",
            "the node stopped",
            "the node on lab-a stopped",
        ),
        (
            "node_restarted",
            "node restarted mid-run",
            "the node on lab-a restarted mid-run (a crash, a kill or a power loss)",
        ),
    ] {
        let (hub, clock, _first, _home) = running_t1().await;
        let mut calls = away_and_back(&hub, &clock, Duration::from_secs(19 * 3600), |hub| {
            session(
                hub,
                3,
                "r1",
                "interrupted",
                json!({ "end": end, "failure": { "class": "process_exited", "message": message } }),
            )
        })
        .await;
        logged(&hub, "thread.interrupted", "r1").await;
        let run = resumes_about_30_s_later(&hub, &clock, &mut calls, cause).await;
        completes(&hub, &run, 10).await;
    }
}

/// The node is OOM-killed and systemd restarts it: today's 20 tasks failed with "[process_exited] the node
/// stopped". Each resumes about 30 s after the node is back.
#[tokio::test]
async fn an_oom_killed_node_restarted_by_systemd_resumes_its_tasks() {
    let (hub, clock, _first, _home) = running_t1().await;
    let mut calls = away_and_back(&hub, &clock, Duration::from_secs(20), |hub| {
        session(
            hub,
            3,
            "r1",
            "failed",
            json!({ "failure": { "class": "process_exited", "message": "the node stopped" } }),
        )
    })
    .await;
    logged(&hub, "thread.failed", "r1").await;
    let run = resumes_about_30_s_later(&hub, &clock, &mut calls, "the node on lab-a stopped").await;
    completes(&hub, &run, 10).await;
}

/// The node keeps going away: resumed three times, and the fourth death fails the task, which wakes the lead with
/// why. No fourth resume goes out.
#[tokio::test]
async fn a_task_that_keeps_dying_is_escalated_at_the_limit() {
    let (hub, clock, mut calls, _home) = running_t1().await;
    let (mut run, mut seq) = ("r1".to_owned(), 3);
    for recovery in 1..=4 {
        session(
            &hub,
            seq,
            &run,
            "interrupted",
            json!({ "end": "node_restarted", "failure": { "class": "process_exited", "message": "node restarted mid-run" } }),
        );
        logged(&hub, "thread.interrupted", &run).await;
        catch_up(&hub.tasks).await;
        if recovery == 4 {
            break;
        }
        assert!(
            reason(&hub).ends_with(&format!("(recovery {recovery} of 3)")),
            "{}",
            reason(&hub)
        );
        clock.advance(Duration::from_secs(41));
        let (next, _) = sent(&mut calls).await;
        session(&hub, seq + 1, &next, "running", json!({}));
        logged(&hub, "thread.started", &next).await;
        (run, seq) = (next, seq + 2);
    }
    let failed = task(&hub);
    assert_eq!(failed.state, TaskState::Failed);
    let tail = failed.result.unwrap().tail;
    assert!(
        tail.as_str().ends_with(
            "Not resumed automatically: it died again (the node on lab-a restarted mid-run (a crash, a kill or a \
             power loss)) after 3 automatic recoveries of at most 3. Decide: continue it with instructions \
             (message_agent), split the work, or cancel it."
        ),
        "{}",
        tail.as_str()
    );
    assert!(
        hub.leads.wakes.pending(&project()),
        "an escalation wakes the lead"
    );
    clock.advance(Duration::from_secs(3600));
    nothing_sent(&mut calls).await;
}

/// claude is killed the same way twice while running the same command: resumed once, then escalated.
#[tokio::test]
async fn a_task_killed_the_same_way_twice_is_escalated() {
    let (hub, clock, mut calls, _home) = running_t1().await;
    let killed = json!({ "end": "exited", "failure": { "class": "process_exited",
        "message": "claude was killed by signal 9" } });
    session(&hub, 3, "r1", "failed", killed.clone());
    logged(&hub, "thread.failed", "r1").await;
    catch_up(&hub.tasks).await;
    assert!(reason(&hub).starts_with("recovering: claude was killed by signal 9; resumes at "));
    // A minute, ±10%.
    clock.advance(Duration::from_secs(50));
    {
        let _guard = hub.tasks.lock.lock().await;
        hub.tasks.retry_queue().await;
    }
    nothing_sent(&mut calls).await;
    clock.advance(Duration::from_secs(17));
    let (run, _) = sent(&mut calls).await;
    session(&hub, 4, &run, "running", json!({}));
    clock.advance(Duration::from_secs(600));
    session(&hub, 5, &run, "failed", killed);
    logged(&hub, "thread.failed", &run).await;
    catch_up(&hub.tasks).await;
    let failed = task(&hub);
    assert_eq!(failed.state, TaskState::Failed);
    assert!(failed.result.unwrap().tail.as_str().contains(
        "Not resumed automatically: it died the same way twice: claude was killed by signal 9."
    ));
    clock.advance(Duration::from_secs(3600));
    nothing_sent(&mut calls).await;
}

/// A task waiting on a person is not dead: through its node's absence and long after, nothing is sent to it.
#[tokio::test]
async fn a_waiting_task_is_left_alone() {
    let (hub, clock, _first, _home) = running_t1().await;
    session(&hub, 3, "r1", "waiting", json!({}));
    logged(&hub, "thread.waiting", "r1").await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(&hub).state, TaskState::Idle);

    let mut calls = away_and_back(&hub, &clock, Duration::from_secs(3600), |hub| {
        session(hub, 4, "r1", "waiting", json!({}))
    })
    .await;
    catch_up(&hub.tasks).await;
    clock.advance(Duration::from_secs(3600));
    {
        let _guard = hub.tasks.lock.lock().await;
        hub.tasks.retry_queue().await;
    }
    nothing_sent(&mut calls).await;
    let waiting = task(&hub);
    assert_eq!((waiting.state, waiting.recovery), (TaskState::Idle, None));
}

/// A task the lead cancelled is never resumed, whatever its run's end says when the node is back.
#[tokio::test]
async fn a_cancelled_task_is_never_resumed() {
    let (hub, clock, _first, _home) = running_t1().await;
    let caller = TaskCaller {
        project_ref: project(),
        by: "lead".into(),
    };
    hub.tasks
        .cancel(&caller, &TaskId::unchecked("T1"), None)
        .await
        .unwrap();
    let mut calls = away_and_back(&hub, &clock, Duration::from_secs(600), |hub| {
        late_interrupt(hub, "r1")
    })
    .await;
    catch_up(&hub.tasks).await;
    clock.advance(Duration::from_secs(3600));
    nothing_sent(&mut calls).await;
    let cancelled = task(&hub);
    assert_eq!(
        (cancelled.state, cancelled.recovery),
        (TaskState::Cancelled, None)
    );
}

/// A person writes to the thread while the task waits to resume: that run continues it, and the note isn't sent.
#[tokio::test]
async fn a_run_started_while_recovering_continues_the_task_without_the_note() {
    let (hub, clock, mut calls, _home) = running_t1().await;
    session(
        &hub,
        3,
        "r1",
        "interrupted",
        json!({ "end": "node_stopping", "failure": { "class": "process_exited", "message": "the node stopped" } }),
    );
    logged(&hub, "thread.interrupted", "r1").await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(&hub).state, TaskState::Queued);

    session(&hub, 4, "r9", "running", json!({}));
    logged(&hub, "thread.started", "r9").await;
    catch_up(&hub.tasks).await;
    let continued = task(&hub);
    assert_eq!(continued.state, TaskState::Running);
    assert_eq!(continued.recovery.unwrap().next_at, None);
    clock.advance(Duration::from_secs(60));
    nothing_sent(&mut calls).await;
    completes(&hub, "r9", 5).await;
}
