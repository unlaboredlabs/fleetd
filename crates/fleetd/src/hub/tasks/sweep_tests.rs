//! The hub sweep's orphans and the machine breaker over a real hub with a fake node: a running task whose end the hub
//! never applied is reconciled, one whose session the node lost fails for its lead, a session nobody owns is reported
//! once, and agents that keep dying on one machine stop resuming there until it has been quiet or one completes.
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use fleetd_contracts::events::{HubEventType, RecoveryPausedData};
use fleetd_contracts::ids::{ProjectId, ProjectRef};
use fleetd_contracts::ledger::IntakeChannel;
use fleetd_contracts::model::ThreadStatus;
use fleetd_contracts::sessions::SessionCall;
use fleetd_contracts::tasks::{Task, TaskId, TaskState};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::cap_tests::{AT, Node, hub_on, running};
use super::race_tests::{catch_up, frame, lab_a, serve};
use crate::hub::api::Hub;
use crate::hub::doctor::checks::{self, DoctorStatus};
use crate::hub::leads::records::NewWorkstream;
use crate::hub::store::test_clock::ManualClock;

type Calls = mpsc::UnboundedReceiver<SessionCall>;

const MIN: Duration = Duration::from_secs(60);
const KILLED: &str = "claude was killed by signal 9";

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: lab_a(),
        project_id: ProjectId::unchecked("p1"),
    }
}

struct Lab {
    hub: Arc<Hub>,
    clock: Arc<ManualClock>,
    calls: Calls,
    seq: AtomicU64,
    _home: tempfile::TempDir,
}

/// Tasks T1..T`n` (readers in the open workstream W1) running on sessions t1..t`n`, run r1, with the node linked.
async fn lab(n: u32) -> Lab {
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
    let lab = Lab {
        hub,
        clock,
        calls,
        seq: AtomicU64::new(10),
        _home: home,
    };
    for i in 1..=n {
        running(&lab.hub, i);
        if i > 3 {
            lab.session(&format!("t{i}"), "r1", "running", json!({}));
            lab.row(&format!("t{i}"), Some(ThreadStatus::Running)).await;
        }
    }
    lab
}

impl Lab {
    /// The node's update of `session`: its run `run` in `status`, with `end` (a run's `end`, `failure`) on it.
    fn session(&self, session: &str, run: &str, status: &str, end: Value) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let active = matches!(status, "running");
        let mut latest = json!({ "id": run, "status": status, "ordinal": seq });
        latest
            .as_object_mut()
            .unwrap()
            .extend(end.as_object().cloned().unwrap_or_default());
        let mut event = json!({ "type": "session_updated", "sessionId": session, "projectId": "p1",
            "title": session, "status": if status == "completed" { "idle" } else { status },
            "model": "claude-haiku-5-5", "effort": "low", "runtimeMode": "approval-required",
            "latestRun": latest, "createdAt": AT, "updatedAt": AT });
        if active {
            event["activeRunId"] = json!(run);
        }
        frame(
            &self.hub,
            json!({ "t": "machine_event", "seq": seq, "at": AT, "event": event }),
        );
    }

    /// claude on `session` is killed mid-run, and the hub applies it.
    async fn killed(&self, session: &str, run: &str) {
        self.session(
            session,
            run,
            "failed",
            json!({ "end": "exited", "failure": { "class": "process_exited", "message": KILLED } }),
        );
        self.logged("thread.failed", session).await;
        catch_up(&self.hub.tasks).await;
    }

    /// Waits until the hub has logged `kind` for `session`.
    async fn logged(&self, kind: &str, session: &str) {
        self.until(|| {
            self.hub
                .db
                .with(|c| {
                    Ok(c.query_row(
                        "SELECT COUNT(*) FROM events WHERE type = ?1 AND json_extract(data, '$.threadId') = ?2",
                        [kind, session],
                        |r| r.get::<_, i64>(0),
                    )?)
                })
                .unwrap()
                > 0
        })
        .await;
    }

    /// Waits until the hub's row of `session` is in `status` (stale when `None`).
    async fn row(&self, session: &str, status: Option<ThreadStatus>) {
        let r = fleetd_contracts::ids::ThreadRef {
            machine_id: lab_a(),
            thread_id: fleetd_contracts::ids::ThreadId::unchecked(session),
        };
        self.until(|| {
            self.hub
                .store
                .thread_get(&r)
                .unwrap()
                .is_some_and(|t| match status {
                    None => t.thread.stale,
                    Some(s) => !t.thread.stale && t.thread.status == s,
                })
        })
        .await;
    }

    async fn until(&self, done: impl Fn() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("never happened");
    }

    fn task(&self, n: u32) -> Task {
        self.hub
            .tasks
            .get(&TaskId::unchecked(format!("T{n}")))
            .unwrap()
            .unwrap()
    }

    fn reason(&self, n: u32) -> String {
        let t = self.task(n);
        assert_eq!(t.state, TaskState::Queued, "{t:?}");
        t.queued_reason.unwrap().as_str().to_owned()
    }

    async fn sweep(&self) {
        self.hub.tasks.sweep().await.unwrap();
    }

    async fn retry_queue(&self) {
        let _guard = self.hub.tasks.lock.lock().await;
        self.hub.tasks.retry_queue().await;
    }

    /// Every event of `type`: its summary and data.
    fn events(&self, r#type: HubEventType) -> Vec<(String, Value)> {
        self.hub
            .db
            .with(|c| {
                let mut stmt = c.prepare("SELECT data FROM events WHERE type = ? ORDER BY seq")?;
                let rows = stmt
                    .query_map([r#type.as_str()], |r| r.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .unwrap()
            .into_iter()
            .map(|row| {
                let event: Value = serde_json::from_str(&row).unwrap();
                (
                    event["summary"].as_str().unwrap().to_owned(),
                    event["data"].clone(),
                )
            })
            .collect()
    }

    /// The sessions the node was asked to send to within a moment.
    async fn sends(&mut self) -> Vec<String> {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let mut out = Vec::new();
        while let Ok(call) = self.calls.try_recv() {
            if let SessionCall::Send { session_id, .. } = call {
                out.push(session_id.as_str().to_owned());
            }
        }
        out.sort();
        out
    }
}

/// G2: the node reported T1's death and the hub logged it, but stopped before its tasks applied it (a hub's follower
/// starts after every event appended before it). The sweep applies it once the thread has been quiet for 2 min, and
/// T1 resumes as it would have. Its neighbour, still running, is left alone.
#[tokio::test]
async fn an_orphaned_running_task_is_reconciled() {
    let lab = lab(2).await;
    lab.session(
        "t1",
        "r1",
        "failed",
        json!({ "end": "exited", "failure": { "class": "process_exited", "message": KILLED } }),
    );
    lab.logged("thread.failed", "t1").await;
    lab.hub
        .tasks
        .applied
        .store(lab.hub.events.head(), Ordering::SeqCst);

    lab.sweep().await;
    assert_eq!(
        lab.task(1).state,
        TaskState::Running,
        "not quiet for 2 min yet"
    );

    lab.clock.advance(2 * MIN);
    lab.sweep().await;
    assert!(
        lab.reason(1)
            .starts_with(&format!("recovering: {KILLED}; resumes at ")),
        "{}",
        lab.reason(1)
    );
    assert_eq!(lab.task(1).recovery.unwrap().count.get(), 1);
    assert_eq!(lab.task(2).state, TaskState::Running);
}

/// The node came back without T2's session: it can't be resumed in it, so it fails for its lead, with why. A task
/// on a machine that is away is never an orphan: it waits for its node.
#[tokio::test]
async fn a_task_whose_session_the_node_lost_fails_for_its_lead() {
    let lab = lab(2).await;
    let session = |id: &str| {
        json!({ "sessionId": id, "projectId": "p1", "title": id, "status": "running", "model": "claude-haiku-5-5",
            "effort": "low", "runtimeMode": "approval-required", "activeRunId": "r1",
            "latestRun": { "id": "r1", "status": "running", "ordinal": 1 }, "createdAt": AT, "updatedAt": AT })
    };
    let p1 =
        json!({ "projectId": "p1", "title": "p1", "workspaceRoot": "/work/p1", "updatedAt": AT });
    frame(
        &lab.hub,
        json!({ "t": "machine_event", "seq": 5, "at": AT, "event": { "type": "snapshot",
            "projects": [p1], "sessions": [session("t1")] } }),
    );
    lab.row("t2", None).await;
    lab.clock.advance(2 * MIN);
    lab.hub.executors.detach(&lab_a()).await;
    lab.sweep().await;
    assert_eq!(lab.task(2).state, TaskState::Running, "its node is away");

    let _calls = serve(&lab.hub, Node::link(&lab.hub).await);
    frame(
        &lab.hub,
        json!({ "t": "machine_event", "seq": 6, "at": AT, "event": { "type": "snapshot",
            "projects": [p1], "sessions": [session("t1")] } }),
    );
    lab.row("t2", None).await;
    lab.clock.advance(2 * MIN);
    lab.sweep().await;
    let failed = lab.task(2);
    assert_eq!(failed.state, TaskState::Failed);
    let tail = failed.result.unwrap().tail;
    assert!(
        tail.as_str().contains(
            "[session_lost] the node on lab-a has no session for this agent any more\n\nNot resumed automatically: \
             its node no longer has its session, so it can't be resumed in it."
        ),
        "{}",
        tail.as_str()
    );
    assert!(lab.hub.leads.wakes.pending(&project()));
    assert_eq!(lab.task(1).state, TaskState::Running);
}

/// The node runs t1..t3: t1 is T1's and t3 the lead's, but nothing of this hub's owns t2. It is reported once, after
/// 2 min, and shows in the doctor until it stops.
#[tokio::test]
async fn an_unknown_node_session_is_reported() {
    let lab = lab(1).await;
    lab.hub
        .db
        .with(|c| {
            c.execute(
                "INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation)
                 VALUES ('lab-a', 'p1', 't3', ?, 0)",
                [AT],
            )?;
            Ok(())
        })
        .unwrap();
    lab.sweep().await;
    assert!(lab.events(HubEventType::ThreadOrphaned).is_empty());

    lab.clock.advance(2 * MIN);
    lab.sweep().await;
    lab.sweep().await;
    let reported = lab.events(HubEventType::ThreadOrphaned);
    assert_eq!(
        reported
            .iter()
            .map(|(summary, _)| summary.as_str())
            .collect::<Vec<_>>(),
        ["lab-a runs \"t2\", a session no agent or lead of this hub owns"]
    );
    let unowned = lab.hub.tasks.unowned(&lab_a());
    assert_eq!(
        unowned
            .iter()
            .map(|u| (u.thread_id.as_str(), u.title.as_str()))
            .collect::<Vec<_>>(),
        [("t2", "t2")]
    );
    let sessions: Vec<_> = unowned
        .into_iter()
        .map(|u| checks::UnownedSession {
            thread_id: u.thread_id,
            title: u.title,
        })
        .collect();
    let check = checks::unowned_sessions("lab-a", false, &sessions).check;
    assert_eq!(
        (check.id.as_str(), check.status),
        ("lab-a/sessions", DoctorStatus::Warn)
    );
    assert!(
        check
            .message
            .starts_with("lab-a runs 1 session no agent or lead of this hub owns: \"t2\" (t2)."),
        "{}",
        check.message
    );

    lab.session("t2", "r1", "completed", json!({ "end": "completed" }));
    lab.row("t2", Some(ThreadStatus::Completed)).await;
    lab.sweep().await;
    assert!(lab.hub.tasks.unowned(&lab_a()).is_empty());
}

/// Three agents killed on lab-a within 10 min open its breaker: none of them resumes, the lead is told once, and the
/// doctor says so. A fourth death there waits too, and tells nobody again. After 30 quiet minutes it closes and all
/// four resume.
#[tokio::test]
async fn deaths_on_one_machine_trip_the_breaker_until_it_has_been_quiet() {
    let mut lab = lab(4).await;
    lab.killed("t1", "r1").await;
    lab.killed("t2", "r1").await;
    assert!(
        lab.reason(2)
            .starts_with(&format!("recovering: {KILLED}; "))
    );
    assert!(lab.hub.tasks.recovery_paused_on(&lab_a()).is_none());
    assert!(!lab.hub.leads.wakes.pending(&project()));

    lab.killed("t3", "r1").await;
    for n in 1..=3 {
        assert!(
            lab.reason(n).starts_with(
                "recovering: automatic recovery is paused on lab-a after 3 agents died there; resumes after "
            ),
            "{}",
            lab.reason(n)
        );
    }
    let paused = lab.events(HubEventType::MachineRecoveryPaused);
    assert_eq!(paused.len(), 1);
    assert_eq!(
        paused[0].0,
        "automatic recovery paused on lab-a: 3 agents died there within 10 min (T1, T2, T3)"
    );
    let data: RecoveryPausedData = serde_json::from_value(paused[0].1.clone()).unwrap();
    assert_eq!((data.paused, data.task_ids.unwrap().len()), (true, 3));
    assert!(lab.hub.leads.wakes.pending(&project()), "the lead is told");

    lab.clock.advance(2 * MIN);
    lab.retry_queue().await;
    assert!(lab.sends().await.is_empty(), "no resume while it is open");

    lab.killed("t4", "r1").await;
    assert!(
        lab.reason(4)
            .starts_with("recovering: automatic recovery is paused on lab-a")
    );
    assert_eq!(
        lab.events(HubEventType::MachineRecoveryPaused).len(),
        1,
        "told once"
    );

    let open = lab.hub.tasks.recovery_paused_on(&lab_a()).unwrap();
    let check = checks::recovery_breaker(
        "lab-a",
        Some(&checks::RecoveryPaused {
            opened_by: open
                .opened_by
                .iter()
                .map(|t| t.as_str().to_owned())
                .collect(),
            waiting: open.held.iter().map(|t| t.as_str().to_owned()).collect(),
            until: super::sweep::clock_time(open.until_ms),
        }),
    )
    .check;
    assert_eq!(
        (check.id.as_str(), check.status),
        ("lab-a/recovery", DoctorStatus::Warn)
    );
    assert!(
        check.message.starts_with(
            "Automatic recovery is paused on lab-a: 3 agents died there within 10 min (T1, T2, T3). 4 wait: T1, T2, \
             T3, T4. It resumes at "
        ),
        "{}",
        check.message
    );

    // 30 min after the last death, not before.
    lab.clock.advance(29 * MIN);
    lab.sweep().await;
    assert!(lab.sends().await.is_empty());
    lab.clock.advance(MIN);
    lab.sweep().await;
    assert_eq!(lab.sends().await, ["t1", "t2", "t3", "t4"]);
    let events = lab.events(HubEventType::MachineRecoveryPaused);
    assert_eq!(
        events[1].0,
        "automatic recovery resumes on lab-a: no agent died there for 30 min; T1, T2, T3, T4 resume"
    );
    assert!(lab.hub.tasks.recovery_paused_on(&lab_a()).is_none());
    assert_eq!(
        checks::recovery_breaker("lab-a", None).check.status,
        DoctorStatus::Ok
    );
}

/// An agent on the machine completing closes the breaker at once, and the held agents resume. A node going away
/// never opens it.
#[tokio::test]
async fn an_agent_completing_closes_the_breaker_and_a_node_going_away_never_opens_it() {
    let mut lab = lab(4).await;
    for n in 1..=3 {
        lab.killed(&format!("t{n}"), "r1").await;
    }
    assert!(lab.hub.tasks.recovery_paused_on(&lab_a()).is_some());
    lab.clock.advance(2 * MIN);
    lab.session("t4", "r1", "completed", json!({ "end": "completed" }));
    lab.logged("thread.completed", "t4").await;
    catch_up(&lab.hub.tasks).await;
    assert_eq!(lab.task(4).state, TaskState::Done);
    assert!(lab.hub.tasks.recovery_paused_on(&lab_a()).is_none());
    assert_eq!(lab.sends().await, ["t1", "t2", "t3"]);
    assert!(
        lab.events(HubEventType::MachineRecoveryPaused)[1]
            .0
            .starts_with("automatic recovery resumes on lab-a: T4 completed there")
    );

    let lab = self::lab(3).await;
    for n in 1..=3 {
        lab.session(
            &format!("t{n}"),
            "r1",
            "interrupted",
            json!({ "end": "node_stopping", "failure": { "class": "process_exited", "message": "the node stopped" } }),
        );
        lab.logged("thread.interrupted", &format!("t{n}")).await;
    }
    catch_up(&lab.hub.tasks).await;
    assert!(lab.hub.tasks.recovery_paused_on(&lab_a()).is_none());
    assert!(
        lab.reason(3)
            .starts_with("recovering: the node on lab-a stopped")
    );
}

/// The lead's call stands over the breaker: its message to a held agent continues it now.
#[tokio::test]
async fn the_leads_message_continues_a_held_agent() {
    let mut lab = lab(3).await;
    for n in 1..=3 {
        lab.killed(&format!("t{n}"), "r1").await;
    }
    lab.clock.advance(2 * MIN);
    let caller = super::TaskCaller {
        project_ref: project(),
        by: "lead".into(),
    };
    lab.hub
        .tasks
        .message(
            &caller,
            &TaskId::unchecked("T2"),
            "Use less memory: run the tests one crate at a time.",
        )
        .await
        .unwrap();
    catch_up(&lab.hub.tasks).await;
    lab.retry_queue().await;
    assert_eq!(lab.sends().await, ["t2"]);
    assert!(
        lab.reason(1)
            .starts_with("recovering: automatic recovery is paused")
    );
}
