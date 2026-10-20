//! Changing a project's max agents over a real hub with an in-memory database and no node linked.
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::tasks::{AgentsCapData, Task, TaskState};
use serde_json::json;

use super::cap::{CapChange, ProjectCap};
use crate::hub::api::{Hub, HubConfig};
use crate::hub::slots::{Agents, SlotPriority, SlotRequest};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-19T10:00:00.000Z";

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Default::default(),
        url: None,
        queue_ttl_sec: None,
        router_model: None,
    };
    let clock = ManualClock::at(1_792_000_000_000);
    let hub = crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock).unwrap();
    (hub, home)
}

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: ProjectId::unchecked("p1"),
    }
}

/// A running read task holding its slot, as a launch leaves it.
fn running(hub: &Hub, n: u32) -> Task {
    let task: Task = serde_json::from_value(json!({
        "taskId": format!("T{n}"), "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "workstreamId": "W1",
        "title": format!("slice {n}"), "kind": "read", "prompt": "do it", "areas": [],
        "model": "claude-haiku-5-5", "effort": "low", "state": "running", "attempt": 1, "createdAt": AT,
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
        project: Some(ProjectCap {
            project_ref: project(),
            max_agents,
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
        hub.slots.agents(&r),
        Agents {
            running: 3,
            max_agents: 1,
            queued: 1
        }
    );

    let raised = hub.tasks.set_caps(set(5, false)).await.unwrap();
    assert_eq!(
        hub.slots.agents(&r),
        Agents {
            running: 4,
            max_agents: 5,
            queued: 0
        },
        "the queued agent took its slot before set_caps returned"
    );
    assert_eq!(
        raised.next,
        "Max agents 1 → 5: 1 queued agent starts now, 1 slot free."
    );
    assert_eq!(
        raised.chat_line,
        Some((r.clone(), raised.next.clone())),
        "the project's chat gets the same line"
    );

    let lines: Vec<String> = cap_events(&hub).into_iter().map(|(s, _)| s).collect();
    assert_eq!(
        lines,
        [
            "Max agents 40 → 1: 3 running finish their work; new agents wait.",
            "Max agents 1 → 5: 1 queued agent starts now, 1 slot free."
        ],
        "one quiet line per change"
    );
    let set_again = hub.tasks.set_caps(set(5, false)).await.unwrap();
    assert_eq!(set_again.next, "Nothing changed.");
    assert!(set_again.chat_line.is_none());
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
        (40, 1, 3)
    );
    assert!(data.paused.is_none());
}

#[tokio::test]
async fn max_agents_stays_within_the_fleet_cap() {
    let (hub, _home) = hub();
    let refused = hub.tasks.set_caps(set(41, false)).await.unwrap_err();
    assert_eq!(
        refused.message,
        "Max agents 41 is above the fleet's 40 slots."
    );
    let both = CapChange {
        cap: Some(60),
        ..set(41, false)
    };
    let outcome = hub.tasks.set_caps(both).await.unwrap();
    assert_eq!(outcome.slots.cap.get(), 60);
    assert_eq!(hub.slots.agents(&project()).max_agents, 41);
    let fleet = &cap_events(&hub)[0];
    assert_eq!(
        fleet.0,
        "Fleet cap 40 → 60: queued turns start as slots allow."
    );
    assert!(fleet.1.project_ref.is_none());
    assert_eq!(
        outcome.chat_line.map(|(_, line)| line).as_deref(),
        Some("Max agents 40 → 41: 0 queued agents start now, 41 slots free."),
        "only the project's change goes to its chat"
    );
}

#[tokio::test]
async fn every_digest_says_how_many_agents_run_of_the_max_and_wait() {
    let (hub, _home) = hub();
    hub.tasks.set_caps(set(2, false)).await.unwrap();
    for n in 1..=3 {
        running(&hub, n);
    }
    let set = hub.db.prompts().for_lead(&project());
    let lines = hub.tasks.digest_lines(&project(), None, 50, &set);
    assert_eq!(lines[0], "agents: 2 running of 2, 1 queued");
    let mut queued = hub
        .tasks
        .get(&fleetd_contracts::tasks::TaskId::unchecked("T3"))
        .unwrap()
        .unwrap();
    queued.state = TaskState::Queued;
    queued.queued_reason = Some(super::queued_reason("agents: 2/2 running"));
    assert_eq!(
        hub.tasks.queued_next(&queued).as_deref(),
        Some(
            "queued: 2/2 running, starts when a slot frees, position 1. fleetd starts it by itself; don't spawn it again."
        )
    );
}

/// A node linked to the hub that runs sessions t1..t3 and accepts every message sent to them.
struct Node {
    rx: tokio::sync::mpsc::UnboundedReceiver<fleetd_contracts::node_link::HubToNode>,
}

impl Node {
    async fn link(hub: &Hub) -> Self {
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
        "Max agents 40 → 1: 2 agents push their work and wait; 1 keep running."
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
