//! A task whose thread can't go on in place, over a real hub with a fake node: a full context is compacted in its
//! thread and the agent told to continue; full again, or a thread the node won't resume (claude's conversation is
//! gone), and a new thread takes over on the same branch and worktree, with the brief and a handoff. The task's
//! earlier threads stay findable, and their late word never moves it.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::ids::{ThreadId, ThreadRef};
use fleetd_contracts::node_link::HubToNode;
use fleetd_contracts::sessions::{RESUME_REFUSED, SessionCall, SessionLaunch, SessionWorkspace};
use fleetd_contracts::tasks::{RecoveryMode, Task, TaskId, TaskState};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::TaskRecords;
use super::cap_tests::{AT, Node, hub_on};
use super::race_tests::{catch_up, lab_a, logged, reply, sent, t1, task, task_lines};
use super::recovery_tests::{
    Calls, completes, nothing_sent, project, reason, running_t1, session, session_of,
};
use crate::hub::api::Hub;
use crate::hub::leads::records::NewWorkstream;
use crate::hub::slots::{SlotPriority, SlotRequest};
use crate::hub::store::test_clock::ManualClock;

const BRANCH: &str = "fleetd/T1-slice-1";
const WORKTREE: &str = "/work/wt/t1";

/// claude's own end for a conversation that no longer fits.
fn context_full() -> Value {
    json!({ "end": "context_full", "failure": { "class": "invalid_request", "message": "Prompt is too long" } })
}

/// How the fake node answers a writer.
#[derive(Clone, Copy, Default)]
struct Answers {
    /// Refuses a send to t1 as a resume it won't make.
    refuse: bool,
    /// Never answers a read of a thread's changes.
    hang: bool,
    /// Launches in a new worktree, as a node without the earlier session's record does, and reports its base.
    new_worktree: bool,
}

/// Answers the calls a writer's start makes, as `answers` says. Every call goes to the test too.
fn serve_writer(hub: &Arc<Hub>, mut node: Node, answers: Answers) -> Calls {
    let (tx, calls) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = node.rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let result = match &f.call {
                SessionCall::Launch(launch) if answers.new_worktree => {
                    json!({ "ok": { "kind": "launched", "base": new_base(), "summary": {
                        "sessionId": launch.session_id, "projectId": "p1", "title": "T1: slice 1", "status": "running",
                        "model": "claude-haiku-5-5", "effort": "low", "runtimeMode": "full-access",
                        "branch": BRANCH, "createdAt": AT, "updatedAt": AT } } })
                }
                SessionCall::Changes { .. } if answers.hang => {
                    let _ = tx.send(f.call);
                    continue;
                }
                SessionCall::Follow { .. } => {
                    json!({ "err": { "code": "not_found", "message": "not in this test" } })
                }
                SessionCall::DefaultBranch { .. } => {
                    json!({ "ok": { "kind": "default_branch", "branch": "main" } })
                }
                SessionCall::ReadFile { .. } => json!({ "ok": { "kind": "file" } }),
                SessionCall::Changes { .. } => json!({ "ok": { "kind": "changes", "branch": BRANCH,
                    "worktreePath": WORKTREE, "paths": ["src/parser.rs"] } }),
                SessionCall::Send { session_id, .. }
                    if answers.refuse && session_id.as_str() == "t1" =>
                {
                    json!({ "err": { "code": "runner_unavailable", "message":
                        format!("{RESUME_REFUSED}claude's conversation /home/u/.claude/projects/x/t1.jsonl is gone") } })
                }
                _ => json!({ "ok": { "kind": "done" } }),
            };
            reply(&hub, f.id.as_str(), result);
            let _ = tx.send(f.call);
        }
    });
    calls
}

/// T1, a writer on its branch and worktree in the open workstream W1, running on thread t1's run r1. `recovery` is
/// what it has been through already.
async fn running_writer(
    answers: Answers,
    recovery: Option<Value>,
) -> (Arc<Hub>, Arc<ManualClock>, Calls, tempfile::TempDir) {
    let clock = ManualClock::at(1_792_000_000_000);
    let (hub, home) = hub_on(clock.clone());
    hub.leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: project(),
            title: "Ship the parser".into(),
            text: "Ship the parser".into(),
            channel: fleetd_contracts::ledger::IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    let calls = serve_writer(&hub, Node::link(&hub).await, answers);
    let mut task = json!({
        "taskId": "T1", "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "workstreamId": "W1",
        "title": "slice 1", "kind": "write", "prompt": "Write the parser.",
        "state": "running", "attempt": 1, "createdAt": AT, "startedAt": AT, "branch": BRANCH,
        "worktreePath": WORKTREE, "threadRef": { "machineId": "lab-a", "threadId": "t1" }, "base": base(),
    });
    if let Some(recovery) = recovery {
        task["recovery"] = recovery;
    }
    let task: Task = serde_json::from_value(task).unwrap();
    let task = hub.db.with(|c| Ok(TaskRecords::create(c, task)?)).unwrap();
    hub.slots
        .acquire(SlotRequest {
            holder: task.task_id.as_str(),
            project_ref: &task.project_ref,
            priority: SlotPriority::Work,
        })
        .unwrap();
    (hub, clock, calls, home)
}

/// Where T1's branch started, as the node reported at its first launch.
fn base() -> Value {
    json!({ "ref": "origin/main", "sha": "0123456789abcdef0123456789abcdef01234567", "fetchedAt": AT })
}

/// Where a new worktree's branch started, when a fresh restart could not take over the earlier one.
fn new_base() -> Value {
    json!({ "ref": "origin/main", "sha": "89abcdef0123456789abcdef0123456789abcdef", "fetchedAt": AT })
}

/// The next launch the node was asked for.
async fn launched(calls: &mut Calls) -> SessionLaunch {
    loop {
        if let SessionCall::Launch(launch) = calls.recv().await.unwrap() {
            return launch;
        }
    }
}

/// A new thread took over T1 on its branch and worktree: launched from t1 with the brief and the handoff, which
/// says `why`. Earlier threads stay findable. `recorded` is T1's base after: the one it had when the new thread took
/// over the worktree, or the new worktree's. Returns the new thread.
async fn takes_over(hub: &Hub, calls: &mut Calls, why: &str, recorded: Value) -> ThreadRef {
    let launch = launched(calls).await;
    assert_eq!(
        launch.workspace,
        SessionWorkspace::Worktree {
            base_ref: fleetd_contracts::prim::NonEmpty::unchecked("main"),
            branch: fleetd_contracts::prim::NonEmpty::unchecked(BRANCH),
            from_session: Some(ThreadId::unchecked("t1")),
        }
    );
    let prompt = launch.prompt.as_str();
    let (brief, handoff) = prompt.split_once("\n\n## Handoff\n").expect("a handoff");
    assert!(brief.contains("## Task\nWrite the parser."), "{brief}");
    assert!(
        handoff.starts_with(&format!(
            "fleetd restarted this task in a fresh thread: {why}. An earlier agent worked on it before you"
        )),
        "{handoff}"
    );
    assert!(
        handoff.contains(&format!(
            "You work in its worktree {WORKTREE}, on its branch {BRANCH}."
        )),
        "{handoff}"
    );
    // This node runs no git for the hub; the agent is told to check itself.
    assert!(
        handoff.contains("Commits on the branch (newest first):\n(fleetd could not read them)"),
        "{handoff}"
    );
    assert!(handoff.contains("Pull request: none"), "{handoff}");

    let fresh = ThreadRef {
        machine_id: lab_a(),
        thread_id: launch.session_id.clone(),
    };
    let t = task(hub);
    assert_eq!(t.state, TaskState::Running);
    assert_eq!(t.thread_ref.as_ref(), Some(&fresh));
    assert_eq!(t.previous_threads, [t1()]);
    assert_eq!(t.branch.as_ref().map(|b| b.as_str()), Some(BRANCH));
    assert_eq!(t.recovery.as_ref().unwrap().mode, RecoveryMode::Fresh);
    assert_eq!(
        serde_json::to_value(&t.base).unwrap(),
        recorded,
        "the recorded base"
    );
    assert!(
        !hub.leads.wakes.pending(&project()),
        "the lead is not woken"
    );
    // Both threads find the task: the one it is on, and the one it was restarted from.
    let found = |r: &ThreadRef| {
        hub.db
            .with(|c| Ok(TaskRecords::by_thread(c, r)?))
            .unwrap()
            .map(|s| s.task.task_id.as_str().to_owned())
    };
    assert_eq!(found(&t1()).as_deref(), Some("T1"));
    assert_eq!(found(&fresh).as_deref(), Some("T1"));
    let by_id = hub
        .db
        .with(|c| Ok(TaskRecords::by_thread_id(c, "t1")?))
        .unwrap()
        .unwrap();
    assert_eq!(by_id.task.thread_ref.as_ref(), Some(&fresh));
    let ids = hub
        .db
        .with(|c| Ok(TaskRecords::thread_ids(c, &project())?))
        .unwrap();
    assert!(
        ids.contains("t1") && ids.contains(fresh.thread_id.as_str()),
        "{ids:?}"
    );
    fresh
}

/// Late word of t1 once a new thread took over: the task stays on the new one, untouched.
async fn earlier_thread_is_ignored(hub: &Hub, seq: u64) {
    let before = task(hub);
    session(
        hub,
        seq,
        "r1",
        "interrupted",
        json!({ "end": "node_restarted", "failure": { "class": "process_exited", "message": "node restarted mid-run" } }),
    );
    logged(hub, "thread.interrupted", "r1").await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(hub), before);
}

/// Its context fills up: `/compact` goes to its thread at once, and once that run completed, the note to continue.
#[tokio::test]
async fn a_full_context_is_compacted_then_resumed_in_its_thread() {
    let (hub, clock, mut calls, _home) = running_t1().await;
    session(&hub, 3, "r1", "failed", context_full());
    logged(&hub, "thread.failed", "r1").await;
    catch_up(&hub.tasks).await;
    assert!(
        reason(&hub).starts_with("recovering: its context is full; compacts and resumes at "),
        "{}",
        reason(&hub)
    );
    clock.advance(Duration::from_secs(1));
    let (compact, text) = sent(&mut calls).await;
    assert_eq!(text, "/compact");
    assert_eq!(task(&hub).state, TaskState::Running);

    session(&hub, 4, &compact, "running", json!({}));
    session(
        &hub,
        5,
        &compact,
        "completed",
        json!({ "end": "completed" }),
    );
    logged(&hub, "thread.completed", &compact).await;
    catch_up(&hub.tasks).await;
    let (run, note) = sent(&mut calls).await;
    assert!(
        note.starts_with(
            "fleetd: your run was cut off (its context was full; fleetd compacted it)."
        ),
        "{note}"
    );
    assert!(
        note.ends_with("(Automatic recovery: 1 of 3 recoveries used.)"),
        "{note}"
    );
    let resumed = task(&hub);
    assert_eq!(
        (resumed.state, resumed.attempt.get()),
        (TaskState::Running, 3)
    );
    assert!(
        !hub.leads.wakes.pending(&project()),
        "the lead is not woken"
    );
    completes(&hub, &run, 6).await;
    let lines = task_lines(&hub);
    assert_eq!(
        lines[1..],
        [
            "T1 compacting its full context to resume (attempt 2, 1 of 3 recoveries used): slice 1",
            "T1 resumed automatically (attempt 3, 1 of 3 recoveries used): slice 1",
            "T1 completed: slice 1"
        ]
    );
}

/// What T1 has been through when its context fills up again: compacted once.
fn compacted() -> Value {
    json!({ "count": 1, "max": 3, "lastCause": "context_full",
        "lastCauseText": "its context was full; fleetd compacted it", "streak": 1, "resumedAt": AT, "mode": "resume" })
}

/// Compacted once already, its context fills up again: a fresh thread takes over on the branch and worktree.
#[tokio::test]
async fn a_full_context_again_restarts_fresh_on_the_branch_with_a_handoff() {
    let (hub, clock, mut calls, _home) =
        running_writer(Answers::default(), Some(compacted())).await;
    session(&hub, 3, "r1", "failed", context_full());
    logged(&hub, "thread.failed", "r1").await;
    catch_up(&hub.tasks).await;
    assert!(
        reason(&hub).starts_with("recovering: its context is full; restarts in a fresh thread at "),
        "{}",
        reason(&hub)
    );
    clock.advance(Duration::from_secs(1));
    let fresh = takes_over(
        &hub,
        &mut calls,
        "its context filled up again after `/compact`",
        base(),
    )
    .await;
    assert_eq!(task(&hub).recovery.unwrap().count.get(), 2);
    assert!(
        hub.tasks.digest_lines(&project(), None, 10)[0]
            .ends_with("; restarted fresh after its context is full, 2 of 3 recoveries used"),
        "{:?}",
        hub.tasks.digest_lines(&project(), None, 10)
    );
    earlier_thread_is_ignored(&hub, 4).await;

    session_of(
        &hub,
        fresh.thread_id.as_str(),
        5,
        "f1",
        "running",
        json!({}),
        json!({}),
    );
    session_of(
        &hub,
        fresh.thread_id.as_str(),
        6,
        "f1",
        "completed",
        json!({ "end": "completed" }),
        json!({}),
    );
    for _ in 0..400 {
        catch_up(&hub.tasks).await;
        if task(&hub).state == TaskState::Done {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(task(&hub).state, TaskState::Done);
    let lines = task_lines(&hub);
    assert!(
        lines.contains(
            &"T1 restarted in a fresh thread (attempt 2, 2 of 3 recoveries used): slice 1"
                .to_owned()
        ),
        "{lines:?}"
    );
}

/// Its node stopped; when the resume goes, the node refuses it (claude's conversation is gone): a fresh thread takes
/// over on the pushed branch, with the handoff.
#[tokio::test]
async fn a_refused_resume_restarts_fresh_on_the_branch_with_a_handoff() {
    let (hub, clock, mut calls, _home) = running_writer(
        Answers {
            refuse: true,
            ..Answers::default()
        },
        None,
    )
    .await;
    session(
        &hub,
        3,
        "r1",
        "interrupted",
        json!({ "end": "node_stopping", "failure": { "class": "process_exited", "message": "the node stopped" } }),
    );
    logged(&hub, "thread.interrupted", "r1").await;
    catch_up(&hub.tasks).await;
    clock.advance(Duration::from_secs(41));
    // The resume goes to t1 first, and is refused.
    let (_, note) = sent(&mut calls).await;
    assert!(note.starts_with("fleetd: your run was cut off (the node on lab-a stopped)."));
    let fresh = takes_over(
        &hub,
        &mut calls,
        &format!(
            "its thread could not resume: the node on lab-a refused or failed the send request: {RESUME_REFUSED}\
             claude's conversation /home/u/.claude/projects/x/t1.jsonl is gone"
        ),
        base(),
    )
    .await;
    let recovery = task(&hub).recovery.unwrap();
    assert_eq!((recovery.count.get(), recovery.node_lost.get()), (1, 1));
    earlier_thread_is_ignored(&hub, 4).await;
    assert_ne!(fresh, t1());
    nothing_sent(&mut calls).await;
}

/// The handoff reads the node off the tasks lock: while the node never answers, another task's end is applied at once.
/// After the step's timeout the fresh thread starts with what the hub knows of the work.
#[tokio::test]
async fn a_node_that_never_answers_holds_up_no_other_task_while_a_handoff_is_gathered() {
    let hang = Answers {
        hang: true,
        ..Answers::default()
    };
    let (hub, clock, mut calls, _home) = running_writer(hang, Some(compacted())).await;
    super::cap_tests::running(&hub, 2);
    session(&hub, 3, "r1", "failed", context_full());
    logged(&hub, "thread.failed", "r1").await;
    catch_up(&hub.tasks).await;
    clock.advance(Duration::from_secs(1));
    while !matches!(calls.recv().await.unwrap(), SessionCall::Changes { .. }) {}

    session_of(
        &hub,
        "t2",
        4,
        "r1",
        "completed",
        json!({ "end": "completed" }),
        json!({}),
    );
    let t2 = TaskId::unchecked("T2");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            catch_up(&hub.tasks).await;
            if hub.tasks.get(&t2).unwrap().unwrap().state == TaskState::Done {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("T2's end waited on T1's handoff");
    assert_eq!(task(&hub).state, TaskState::Queued);

    clock.advance(Duration::from_secs(20));
    takes_over(
        &hub,
        &mut calls,
        "its context filled up again after `/compact`",
        base(),
    )
    .await;
}

/// A fresh restart the node couldn't run in the earlier worktree (its record of t1 was gone, so it made a new one from
/// the default branch): T1 records the new worktree's base, not the old one's.
#[tokio::test]
async fn a_fresh_restart_in_a_new_worktree_records_its_new_base() {
    let elsewhere = Answers {
        new_worktree: true,
        ..Answers::default()
    };
    let (hub, clock, mut calls, _home) = running_writer(elsewhere, Some(compacted())).await;
    session(&hub, 3, "r1", "failed", context_full());
    logged(&hub, "thread.failed", "r1").await;
    catch_up(&hub.tasks).await;
    clock.advance(Duration::from_secs(1));
    takes_over(
        &hub,
        &mut calls,
        "its context filled up again after `/compact`",
        new_base(),
    )
    .await;
}
