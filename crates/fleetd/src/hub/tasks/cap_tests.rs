//! Changing a project's max agents over a real hub with an in-memory database and no node linked.
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::sessions::RunEnd;
use fleetd_contracts::tasks::{AgentsCapData, Task, TaskState};
use serde_json::json;

use super::cap::{CapChange, ProjectCap};
use crate::hub::api::{Hub, HubConfig};
use crate::hub::slots::{Agents, MaxSource, SlotPriority, SlotRequest};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

pub(super) const AT: &str = "2026-10-19T10:00:00.000Z";

pub(super) fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    hub_on(ManualClock::at(1_792_000_000_000))
}

/// A hub on a clock the test moves.
pub(super) fn hub_on(clock: Arc<ManualClock>) -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Default::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock).unwrap();
    // A 32-CPU, 128 GB machine: it fits 28.
    let mut load = crate::hub::link::guard::tests::load(500, 1.0);
    load.mem_total_bytes = Some(fleetd_contracts::prim::Count::unchecked(128 << 30));
    hub.slots
        .observe_machine(&MachineId::unchecked("lab-a"), "lab-a", &load)
        .unwrap();
    (hub, home)
}

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: ProjectId::unchecked("p1"),
    }
}

/// A running read task holding its slot, as a launch leaves it.
pub(super) fn running(hub: &Hub, n: u32) -> Task {
    let task: Task = serde_json::from_value(json!({
        "taskId": format!("T{n}"), "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "workstreamId": "W1",
        "title": format!("slice {n}"), "kind": "read", "prompt": "do it",
        "state": "running", "attempt": 1, "createdAt": AT,
        "startedAt": AT, "threadRef": { "machineId": "lab-a", "threadId": format!("t{n}") },
    }))
    .unwrap();
    let task = hub
        .db
        .with(|c| Ok(super::TaskRecords::create(c, task)?))
        .unwrap();
    acquire(hub, &task);
    task
}

fn acquire(hub: &Hub, task: &Task) -> bool {
    hub.slots
        .acquire(SlotRequest {
            holder: task.task_id.as_str(),
            project_ref: &task.project_ref,
            priority: SlotPriority::Work,
        })
        .unwrap()
        .granted()
}

fn set(max_agents: i64, pause_extras: bool) -> CapChange {
    CapChange {
        cap: None,
        machine: None,
        project: Some(ProjectCap {
            project_ref: project(),
            max_agents: Some(max_agents),
            pause_extras,
        }),
    }
}

/// Every `agents.cap` event: its summary (the chat line) and data.
fn cap_events(hub: &Hub) -> Vec<(String, AgentsCapData)> {
    hub.db
        .with(|c| {
            let mut stmt = c.prepare("SELECT data FROM events WHERE type = ? ORDER BY seq")?;
            let rows = stmt
                .query_map([HubEventType::AgentsCap.as_str()], |r| {
                    r.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap()
        .into_iter()
        .map(|row| {
            let event: serde_json::Value = serde_json::from_str(&row).unwrap();
            let data = serde_json::from_value(event["data"].clone()).unwrap();
            (event["summary"].as_str().unwrap().to_owned(), data)
        })
        .collect()
}

#[tokio::test]
async fn lowering_stops_no_agent_and_raising_starts_queued_ones_at_once() {
    let (hub, _home) = hub();
    let r = project();
    let tasks: Vec<Task> = (1..=3).map(|n| running(&hub, n)).collect();

    let lowered = hub.tasks.set_caps(set(1, false)).await.unwrap();
    assert!(lowered.paused.is_empty());
    for t in &tasks {
        assert_eq!(
            hub.tasks.get(&t.task_id).unwrap().unwrap().state,
            TaskState::Running
        );
    }
    let waiting = running(&hub, 4);
    assert!(!acquire(&hub, &waiting), "a new agent waits");
    assert_eq!(
        Agents {
            moved_ms: 0,
            ..hub.slots.agents(&r)
        },
        Agents {
            running: 3,
            max_agents: 1,
            queued: 1,
            source: MaxSource::Project,
            moved_ms: 0,
        }
    );

    let raised = hub.tasks.set_caps(set(5, false)).await.unwrap();
    assert_eq!(
        Agents {
            moved_ms: 0,
            ..hub.slots.agents(&r)
        },
        Agents {
            running: 4,
            max_agents: 5,
            queued: 0,
            source: MaxSource::Project,
            moved_ms: 0,
        },
        "the queued agent took its slot before set_caps returned"
    );
    assert_eq!(
        raised.next,
        "Max agents 1 → 5: 1 queued agent starts now, 1 slot free."
    );

    let lines: Vec<String> = cap_events(&hub).into_iter().map(|(s, _)| s).collect();
    assert_eq!(
        lines,
        [
            "Max agents 28 → 1: 3 running finish their work; new agents wait.",
            "Max agents 1 → 5: 1 queued agent starts now, 1 slot free."
        ],
        "one quiet line per change"
    );
    let set_again = hub.tasks.set_caps(set(5, false)).await.unwrap();
    assert_eq!(set_again.next, "Nothing changed.");
    assert_eq!(cap_events(&hub).len(), 2);
}

/// Pausing never stops an agent: one the node can't be told about keeps running and keeps its slot.
#[tokio::test]
async fn pausing_the_extras_leaves_an_agent_it_cannot_reach_running() {
    let (hub, _home) = hub();
    for n in 1..=3 {
        running(&hub, n);
    }
    let outcome = hub.tasks.set_caps(set(1, true)).await.unwrap();
    assert!(outcome.paused.is_empty());
    assert_eq!(hub.slots.agents(&project()).running, 3);
    let (_, data) = cap_events(&hub).pop().unwrap();
    assert_eq!(
        (data.from.get(), data.to.get(), data.running.get()),
        (28, 1, 3)
    );
    assert!(data.paused.is_none());
}

#[tokio::test]
async fn max_agents_stays_within_the_fleet_cap() {
    let (hub, _home) = hub();
    // No fleet cap until someone sets one: the machines' caps are the limit.
    assert_eq!(hub.slots.cap(), None);
    assert_eq!(hub.slots.state().cap.get(), 28);
    let fleet = CapChange {
        cap: Some(20),
        machine: None,
        project: None,
    };
    let outcome = hub.tasks.set_caps(fleet).await.unwrap();
    assert_eq!(
        outcome.next,
        "Fleet cap set to 20 (the machines fit 28): running agents finish; new ones wait."
    );
    assert_eq!(
        (
            outcome.slots.cap.get(),
            outcome.slots.fleet_cap.map(|c| c.get())
        ),
        (20, Some(20))
    );
    let refused = hub.tasks.set_caps(set(21, false)).await.unwrap_err();
    assert_eq!(
        refused.message,
        "Max agents 21 is above the fleet's 20 slots."
    );
    let both = CapChange {
        cap: Some(60),
        ..set(41, false)
    };
    let outcome = hub.tasks.set_caps(both).await.unwrap();
    assert_eq!(outcome.slots.cap.get(), 60);
    assert_eq!(hub.slots.agents(&project()).max_agents, 41);
    let fleet = &cap_events(&hub)[1];
    assert_eq!(
        fleet.0,
        "Fleet cap 20 → 60: queued agents start as slots allow."
    );
    assert!(fleet.1.project_ref.is_none());
    assert_eq!(cap_events(&hub)[0].1.from.get(), 28);
}

#[tokio::test]
async fn every_digest_says_how_many_agents_run_of_the_max_and_wait() {
    let (hub, _home) = hub();
    hub.tasks.set_caps(set(2, false)).await.unwrap();
    for n in 1..=3 {
        running(&hub, n);
    }
    let a = hub.tasks.agents(&project());
    assert_eq!((a.running, a.cap, a.queued), (2, 2, 1));
    assert_eq!(
        a.to_string(),
        "agents: 2 running of 2 (max agents set), 1 queued, 0 free"
    );
    // A project nobody set a max for runs what its machine fits, and the line names the term that binds.
    let other = ProjectRef {
        project_id: ProjectId::unchecked("p2"),
        ..project()
    };
    assert_eq!(
        hub.tasks.agents(&other).to_string(),
        "agents: 0 running of 28 (auto: 28 of 32 CPUs), 0 queued, 28 free"
    );
    let mut queued = hub
        .tasks
        .get(&fleetd_contracts::tasks::TaskId::unchecked("T3"))
        .unwrap()
        .unwrap();
    queued.state = TaskState::Queued;
    queued.queued_reason = Some(super::queued_reason("Max agents: 2 of 2 running"));
    assert!(
        hub.tasks
            .queued_next(&queued)
            .unwrap()
            .contains("position 1")
    );
}

/// A node linked to the hub that runs sessions t1..t3 and accepts every message sent to them.
pub(super) struct Node {
    pub(super) rx: tokio::sync::mpsc::UnboundedReceiver<fleetd_contracts::node_link::HubToNode>,
}

impl Node {
    pub(super) async fn link(hub: &Hub) -> Self {
        use fleetd_contracts::node_link::{HubToNode, NodeToHub};
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let m = MachineId::unchecked("lab-a");
        hub.executors
            .attach(
                &m,
                crate::hub::executor::NodeSessions {
                    link_id: 1,
                    send: tx,
                },
            )
            .await;
        let HubToNode::SessionCall(subscribe) = rx.recv().await.unwrap() else {
            panic!("not a subscribe")
        };
        let session = |id: &str| {
            json!({ "sessionId": id, "projectId": "p1", "title": id, "status": "running", "model": "claude-haiku-5-5",
                "effort": "low", "runtimeMode": "approval-required", "activeRunId": "r1",
                "latestRun": { "id": "r1", "status": "running", "ordinal": 1 },
                "createdAt": AT, "updatedAt": AT })
        };
        let frame = |v: serde_json::Value| {
            hub.executors
                .handle_frame(&m, serde_json::from_value::<NodeToHub>(v).unwrap())
        };
        let project = json!({ "projectId": "p1", "title": "p1", "workspaceRoot": "/work/p1", "updatedAt": AT });
        frame(
            json!({ "t": "machine_event", "seq": 1, "at": AT, "event": { "type": "snapshot",
            "projects": [project], "sessions": [session("t1"), session("t2"), session("t3")] } }),
        );
        frame(
            json!({ "t": "machine_event", "seq": 2, "at": AT, "event": { "type": "runner_info", "runner": "claude",
            "version": "2.1.302", "supported": ">=2.1.300, <2.2.0", "versionOk": true, "login": "logged_in",
            "loginKind": "subscription", "conformanceOk": true } }),
        );
        frame(
            json!({ "t": "session_reply", "id": subscribe.id, "result": { "ok": { "kind": "done" } } }),
        );
        hub.executors.await_live(&m).await;
        Self { rx }
    }

    /// Answers calls until one is a send; returns the session it went to and its text.
    async fn sent(&mut self, hub: &Hub) -> (String, String) {
        use fleetd_contracts::node_link::{HubToNode, NodeToHub};
        use fleetd_contracts::sessions::SessionCall;
        loop {
            let HubToNode::SessionCall(f) = self.rx.recv().await.unwrap() else {
                continue;
            };
            let reply = |result: serde_json::Value| {
                let frame = json!({ "t": "session_reply", "id": f.id, "result": result });
                hub.executors.handle_frame(
                    &MachineId::unchecked("lab-a"),
                    serde_json::from_value::<NodeToHub>(frame).unwrap(),
                );
            };
            match f.call {
                SessionCall::Send {
                    session_id,
                    run_id,
                    text,
                    ..
                } => {
                    reply(
                        json!({ "ok": { "kind": "sent", "runId": run_id.as_str(), "queued": true } }),
                    );
                    return (session_id.as_str().to_owned(), text.as_str().to_owned());
                }
                _ => {
                    reply(json!({ "err": { "code": "not_found", "message": "not in this test" } }))
                }
            }
        }
    }
}

/// "Pause the extras now": the newest agents above the new max are told to push their work and end their turn, and
/// wait queued. The end of that turn doesn't end the task, and it isn't continued while that turn still runs.
#[tokio::test]
async fn pausing_the_extras_parks_the_newest_and_continues_them_in_their_thread() {
    let (hub, _home) = hub();
    let mut node = Node::link(&hub).await;
    for n in 1..=3 {
        running(&hub, n);
    }
    let tasks = hub.tasks.clone();
    let change = tokio::spawn(async move { tasks.set_caps(set(1, true)).await.unwrap() });
    let mut told = [node.sent(&hub).await, node.sent(&hub).await];
    let outcome = change.await.unwrap();
    let ids: Vec<&str> = outcome.paused.iter().map(|t| t.as_str()).collect();
    assert_eq!(ids, ["T3", "T2"], "the newest first, down to the max");
    told.sort();
    assert_eq!(told[0].0, "t2");
    assert!(
        told[0].1.contains("lowered to 1") && told[0].1.contains("push"),
        "{}",
        told[0].1
    );
    assert_eq!(
        outcome.next,
        "Max agents 28 → 1: 2 agents push their work and wait; 1 keeps running."
    );

    let t3 = super::TaskId::unchecked("T3");
    let stored = hub
        .db
        .with(|c| Ok(super::TaskRecords::get(c, &t3)?))
        .unwrap()
        .unwrap();
    assert_eq!(stored.task.state, TaskState::Queued);
    assert_eq!(
        stored.task.queued_reason.as_ref().unwrap().as_str(),
        "paused: max agents lowered to 1; resumes when a slot frees"
    );
    let resume = stored.pending_message.clone().unwrap();

    // Its checkpoint turn ends: the task stays queued, not done.
    let thread = stored.task.thread_ref.clone().unwrap();
    let ended = fleetd_contracts::events::HubEvent {
        seq: fleetd_contracts::ids::EventSeq::new(1_000_000).unwrap(),
        at: fleetd_contracts::ids::Timestamp(AT.into()),
        r#type: HubEventType::ThreadCompleted,
        machine_id: Some(thread.machine_id.clone()),
        project_id: None,
        thread_id: Some(thread.thread_id.clone()),
        summary: fleetd_contracts::prim::Text::unchecked(String::new()),
        data: None,
        attention: None,
    };
    hub.tasks.on_thread_event(&ended).await.unwrap();
    assert_eq!(
        hub.tasks.get(&t3).unwrap().unwrap().state,
        TaskState::Queued
    );

    // While its thread still runs, a retry leaves it queued; once stopped, its slot continues it there.
    let again = hub.tasks.try_start(stored.clone(), true).await;
    assert_eq!(again.state, TaskState::Queued);
    let mut summary = hub.store.thread_get(&thread).unwrap().unwrap();
    summary.thread.status = fleetd_contracts::model::ThreadStatus::Completed;
    hub.store.thread_upsert(&summary).unwrap();
    let tasks = hub.tasks.clone();
    let resumed = tokio::spawn(async move { tasks.try_start(stored, true).await });
    assert_eq!(node.sent(&hub).await, ("t3".to_owned(), resume));
    assert_eq!(resumed.await.unwrap().state, TaskState::Running);
}

/// The app lowers the max when you let go of the slider, then offers the pause: at the same max, the extras are
/// paused and the chat gets one line for it.
#[tokio::test]
async fn pausing_the_extras_after_the_max_was_lowered() {
    let (hub, _home) = hub();
    let mut node = Node::link(&hub).await;
    for n in 1..=3 {
        running(&hub, n);
    }
    hub.tasks.set_caps(set(1, false)).await.unwrap();
    let tasks = hub.tasks.clone();
    let change = tokio::spawn(async move { tasks.set_caps(set(1, true)).await.unwrap() });
    node.sent(&hub).await;
    node.sent(&hub).await;
    let outcome = change.await.unwrap();
    assert_eq!(outcome.paused.len(), 2);
    assert_eq!(
        outcome.next,
        "Max agents 1: 2 agents push their work and wait; 1 keeps running."
    );
    let (line, data) = cap_events(&hub).pop().unwrap();
    assert_eq!(line, outcome.next);
    assert_eq!((data.from.get(), data.to.get()), (1, 1));
    assert_eq!(data.paused.map(|p| p.len()), Some(2));

    // Nothing over the max any more: asking again changes nothing and says nothing.
    let again = hub.tasks.set_caps(set(1, true)).await.unwrap();
    assert!(again.paused.is_empty());
    assert_eq!(again.next, "Nothing changed.");
}

/// An agent waiting on its lead's answer is never paused, and one that asks while paused continues only with the
/// answer in hand, so a question is never left behind by a pause.
#[tokio::test]
async fn a_question_to_the_lead_outlives_a_pause() {
    let (hub, _home) = hub();
    let mut node = Node::link(&hub).await;
    for n in 1..=3 {
        running(&hub, n);
    }
    let (t2, t3) = (
        super::TaskId::unchecked("T2"),
        super::TaskId::unchecked("T3"),
    );
    hub.tasks.ask_lead(&t3, "which API version?").unwrap();
    let tasks = hub.tasks.clone();
    let change = tokio::spawn(async move { tasks.set_caps(set(1, true)).await.unwrap() });
    assert_eq!(node.sent(&hub).await.0, "t2", "only T2 is told to pause");
    let outcome = change.await.unwrap();
    assert_eq!(
        outcome.paused,
        std::slice::from_ref(&t2),
        "T3 waits on its lead, so it keeps running"
    );
    assert_eq!(
        hub.tasks.get(&t3).unwrap().unwrap().state,
        TaskState::Running
    );

    // Paused T2 asks during its checkpoint turn, which then ends: a free slot doesn't continue it yet.
    hub.tasks.ask_lead(&t2, "keep the old endpoint?").unwrap();
    let stored = hub
        .db
        .with(|c| Ok(super::TaskRecords::get(c, &t2)?))
        .unwrap()
        .unwrap();
    let thread = stored.task.thread_ref.clone().unwrap();
    let mut summary = hub.store.thread_get(&thread).unwrap().unwrap();
    summary.thread.status = fleetd_contracts::model::ThreadStatus::Completed;
    hub.store.thread_upsert(&summary).unwrap();
    assert_eq!(
        hub.tasks.try_start(stored, true).await.state,
        TaskState::Queued
    );

    // The lead's answer goes into the resume, which then goes out.
    let lead = super::TaskCaller {
        project_ref: project(),
        by: "lead:lab-a/p1".into(),
    };
    hub.tasks.message(&lead, &t2, "yes, keep it").await.unwrap();
    let (to, text) = node.sent(&hub).await;
    assert_eq!(to, "t2");
    assert!(
        text.starts_with("A slot is free again") && text.ends_with("yes, keep it"),
        "{text}"
    );
}

/// Dogfood: "1 agent push their work and wait; 1 keep running".
#[test]
fn a_pause_line_counts_in_good_grammar() {
    use super::cap::paused_line;
    assert_eq!(
        paused_line(40, 1, 1, 1),
        "Max agents 40 → 1: 1 agent pushes its work and waits; 1 keeps running."
    );
    assert_eq!(
        paused_line(40, 2, 3, 2),
        "Max agents 40 → 2: 3 agents push their work and wait; 2 keep running."
    );
    assert_eq!(
        paused_line(2, 0, 2, 0),
        "Max agents 2 → 0: 2 agents push their work and wait; 0 keep running."
    );
    // The pause the app offers after a lower, at the max it already set.
    assert_eq!(
        paused_line(2, 2, 1, 2),
        "Max agents 2: 1 agent pushes its work and waits; 2 keep running."
    );
}

/// "Medium allowed" is on until `project_set` turns it off; the change is evented for the clients and is what the next
/// spawn reads, so a spawn's medium then runs high.
#[tokio::test]
async fn the_medium_switch_is_on_by_default_and_a_spawn_reads_it() {
    let (hub, _home) = hub();
    let r = project();
    assert!(hub.tasks.d.ports.medium_allowed(&r));
    hub.leads
        .leads
        .set_medium_allowed(&r, "shop", false)
        .unwrap();
    assert!(!hub.tasks.d.ports.medium_allowed(&r));
    let (summary, data): (String, String) = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT json_extract(data, '$.summary'), json_extract(data, '$.data') FROM events WHERE type = ?",
                [HubEventType::ProjectSettings.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(summary, "shop: every task runs on high (medium off)");
    assert_eq!(data, r#"{"mediumAllowed":false}"#);
    hub.leads
        .leads
        .set_medium_allowed(&r, "shop", true)
        .unwrap();
    assert!(hub.tasks.d.ports.medium_allowed(&r));
}

/// The watchdog's stall fails the task, and the lead's line says why: the thread row does not hold it yet.
#[tokio::test]
async fn a_stalled_run_fails_its_task_and_says_why() {
    let (hub, _home) = hub();
    let task = running(&hub, 1);
    let stalled: fleetd_contracts::events::HubEvent = serde_json::from_value(json!({
        "seq": 1_000_000, "at": AT, "type": "thread.failed", "machineId": "lab-a", "threadId": "t1",
        "summary": "\"slice 1\" on lab-a stalled",
        "data": { "reason": "stalled", "runId": "r1",
            "error": { "class": "stalled", "message": "no progress for 10 min outside a tool, so fleetd interrupted it" } },
    }))
    .unwrap();
    hub.tasks.on_thread_event(&stalled).await.unwrap();
    let failed = hub.tasks.get(&task.task_id).unwrap().unwrap();
    assert_eq!(failed.state, TaskState::Failed);
    let result = failed.result.unwrap();
    assert_eq!(
        result.tail.as_str(),
        "[stalled] no progress for 10 min outside a tool, so fleetd interrupted it"
    );
    assert_eq!(result.end_cause, Some(RunEnd::Stalled));
}

/// The task's result says why its run ended, from the thread event: what recovery and the lead's lines read.
#[tokio::test]
async fn a_task_result_says_why_its_run_ended() {
    let (hub, _home) = hub();
    let event = |seq: i64, kind: &str, thread: &str, data: serde_json::Value| {
        serde_json::from_value::<fleetd_contracts::events::HubEvent>(json!({
            "seq": seq, "at": AT, "type": kind, "machineId": "lab-a", "threadId": thread,
            "summary": "ended", "data": data,
        }))
        .unwrap()
    };
    let cases = [
        (
            "thread.interrupted",
            json!({ "runId": "r1", "late": true, "endCause": "node_stopping" }),
            TaskState::Failed,
            Some(RunEnd::NodeStopping),
        ),
        (
            "thread.failed",
            json!({ "runId": "r1", "endCause": "exited" }),
            TaskState::Failed,
            Some(RunEnd::Exited),
        ),
        (
            "thread.failed",
            json!({ "runId": "r1", "endCause": "context_full" }),
            TaskState::Failed,
            Some(RunEnd::ContextFull),
        ),
        // An older node's event says nothing; a completed turn is completed all the same.
        (
            "thread.failed",
            json!({ "runId": "r1" }),
            TaskState::Failed,
            None,
        ),
        (
            "thread.completed",
            json!({ "runId": "r1" }),
            TaskState::Done,
            Some(RunEnd::Completed),
        ),
    ];
    for (n, (kind, data, state, end)) in cases.into_iter().enumerate() {
        let n = n as u32 + 1;
        let task = running(&hub, n);
        let thread = format!("t{n}");
        hub.tasks
            .on_thread_event(&event(1_000_000 + i64::from(n), kind, &thread, data))
            .await
            .unwrap();
        let ended = hub.tasks.get(&task.task_id).unwrap().unwrap();
        assert_eq!(ended.state, state, "{kind} {n}");
        assert_eq!(ended.result.unwrap().end_cause, end, "{kind} {n}");
    }
}

fn fleet(cap: i64) -> CapChange {
    CapChange {
        cap: Some(cap),
        machine: None,
        project: None,
    }
}

/// The app's flow, as a person reported it: the project's slider moved off the top and Undone, then the whole fleet
/// raised and lowered. A project with no max of its own follows the fleet cap at once, in what it shows and runs.
#[tokio::test]
async fn a_project_without_its_own_max_follows_the_fleet_cap() {
    let (hub, _home) = hub();
    let r = project();
    hub.tasks.set_caps(fleet(10)).await.unwrap();
    assert_eq!(hub.slots.agents(&r).max_agents, 10, "within the fleet cap");
    assert_eq!(
        hub.tasks.agents(&r).to_string(),
        "agents: 0 running of 10 (fleet cap set), 0 queued, 10 free"
    );
    hub.tasks.set_caps(fleet(20)).await.unwrap();
    assert_eq!(hub.slots.agents(&r).max_agents, 20, "raised");
    hub.tasks.set_caps(fleet(2)).await.unwrap();
    assert_eq!(hub.slots.agents(&r).max_agents, 2, "lowered");
    for n in 1..=3 {
        running(&hub, n);
    }
    assert_eq!(
        (hub.slots.agents(&r).running, hub.slots.agents(&r).queued),
        (2, 1)
    );
    hub.tasks.set_caps(fleet(3)).await.unwrap();
    assert_eq!(
        (hub.slots.agents(&r).running, hub.slots.agents(&r).queued),
        (3, 0),
        "raising starts the queued one at once"
    );
}

/// A max a person set is the project's own: no fleet cap change moves it, the slot state says so, and going back to
/// the default follows the fleet cap again.
#[tokio::test]
async fn a_projects_own_max_holds_until_it_goes_back_to_the_default() {
    let (hub, _home) = hub();
    let r = project();
    hub.tasks.set_caps(fleet(10)).await.unwrap();
    // The app's Undo of 10 → 6 from the default used to write 10 back as the project's own.
    let own = hub.tasks.set_caps(set(6, false)).await.unwrap();
    let row = |s: &fleetd_contracts::tasks::SlotState| {
        let row = s.per_project.iter().find(|p| p.project_ref == r).unwrap();
        (row.max_agents.get(), row.own)
    };
    assert_eq!(row(&own.slots), (6, true));
    let raised = hub.tasks.set_caps(fleet(20)).await.unwrap();
    assert_eq!(row(&raised.slots), (6, true), "its own max stays");
    assert_eq!(
        hub.tasks.agents(&r).to_string(),
        "agents: 0 running of 6 (max agents set), 0 queued, 6 free"
    );

    let back = hub
        .tasks
        .set_caps(CapChange {
            cap: None,
            machine: None,
            project: Some(ProjectCap {
                project_ref: r.clone(),
                max_agents: None,
                pause_extras: false,
            }),
        })
        .await
        .unwrap();
    assert_eq!(back.next, "Max agents 6 → 20. It follows the default now.");
    assert!(back.slots.per_project.iter().all(|p| p.project_ref != r));
    assert_eq!(hub.slots.agents(&r).source, MaxSource::Fleet);
    hub.tasks.set_caps(fleet(12)).await.unwrap();
    assert_eq!(hub.slots.agents(&r).max_agents, 12, "it follows again");
    running(&hub, 1);
    assert_eq!(row(&hub.slots.state()), (12, false));

    // At its default already, going back to it says so once, then nothing changes.
    hub.tasks.set_caps(set(12, false)).await.unwrap();
    let same = hub
        .tasks
        .set_caps(CapChange {
            cap: None,
            machine: None,
            project: Some(ProjectCap {
                project_ref: r.clone(),
                max_agents: None,
                pause_extras: false,
            }),
        })
        .await
        .unwrap();
    assert_eq!(same.next, "Max agents 12, the default now.");
    assert_eq!(row(&same.slots), (12, false));
}

/// Free slots sit idle from the last time one of the project's slots was taken or freed, for any reason: time
/// passing adds minutes, a start or an end starts the count again, and another project's agents don't touch it.
#[tokio::test]
async fn idle_minutes_count_from_the_last_slot_taken_or_freed() {
    let clock = ManualClock::at(1_792_000_000_000);
    let (hub, _home) = hub_on(clock.clone());
    hub.tasks.set_caps(set(4, false)).await.unwrap();
    let r = project();
    let minutes = |m: u64| std::time::Duration::from_secs(60 * m);
    let idle = || hub.tasks.agents(&r).idle_minutes;

    clock.advance(minutes(12));
    assert_eq!(idle(), 12, "nothing moved since the hub started");
    let first = running(&hub, 1);
    assert_eq!(idle(), 0, "a start");
    let since = hub.tasks.agents(&r).idle_since_ms;
    clock.advance(minutes(11));
    assert_eq!(idle(), 11);
    hub.slots
        .acquire(SlotRequest {
            holder: "T9",
            project_ref: &ProjectRef {
                project_id: ProjectId::unchecked("p2"),
                ..project()
            },
            priority: SlotPriority::Work,
        })
        .unwrap();
    assert_eq!(idle(), 11, "another project's start");
    assert_eq!(
        hub.tasks.agents(&r).idle_since_ms,
        since,
        "the same stretch"
    );
    hub.slots.release(first.task_id.as_str()).unwrap();
    assert_eq!(idle(), 0, "an end");
    assert!(hub.tasks.agents(&r).idle_since_ms > since, "a new stretch");
    clock.advance(minutes(10));
    let a = hub.tasks.agents(&r);
    assert_eq!((a.idle_minutes, a.free()), (10, 4));
}

/// The idle line shows once slots have sat free 10 minutes beside an approved order; a slot taken or freed starts
/// the count again. (Once per stretch is the sender's: `leads::auto_start_tests`.)
#[tokio::test]
async fn the_idle_line_shows_after_ten_idle_minutes() {
    let clock = ManualClock::at(1_792_000_000_000);
    let (hub, _home) = hub_on(clock.clone());
    hub.tasks.set_caps(set(4, false)).await.unwrap();
    let r = project();
    let (mut order, _) = hub
        .leads
        .records
        .workstream_create(crate::hub::leads::records::NewWorkstream {
            project_ref: r.clone(),
            title: "dark mode".into(),
            text: "dark mode".into(),
            channel: fleetd_contracts::ledger::IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    order.brief = Some(
        serde_json::from_value(json!({
            "goal": "dark mode", "why": "asked", "pointers": [], "constraints": [],
            "doneWhen": ["the app follows the system theme"],
        }))
        .unwrap(),
    );
    hub.leads.records.workstream_put(&order).unwrap();
    let idle = || async {
        hub.leads
            .wakes
            .digest(&r)
            .await
            .unwrap()
            .contains("\nIdle: ")
    };

    clock.advance(std::time::Duration::from_secs(9 * 60));
    assert!(!idle().await, "not yet");
    clock.advance(std::time::Duration::from_secs(60));
    assert!(idle().await, "10 min idle");
    let t = running(&hub, 1);
    hub.slots.release(t.task_id.as_str()).unwrap();
    assert!(!idle().await, "a slot moved");
    clock.advance(std::time::Duration::from_secs(10 * 60));
    assert!(idle().await, "a new stretch");
}
