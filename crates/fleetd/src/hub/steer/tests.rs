//! The Steers service over a real hub with an in-memory database and no node linked: steers wait in the offline
//! queue, and receipts are fed as the node would send them.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, ThreadId};
use fleetd_contracts::ledger::{IntakeChannel, WorkstreamId};
use fleetd_contracts::steer::{DeliveredHow, SteerReceipt};
use serde_json::json;

use super::*;
use crate::hub::api::HubConfig;
use crate::hub::leads::records::{NewWorkstream, StoredLead};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-18T10:00:00.000Z";

struct Lab {
    hub: Arc<Hub>,
    clock: Arc<ManualClock>,
    _home: tempfile::TempDir,
}

fn lab() -> Lab {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Default::default(),
        url: None,
        queue_ttl_sec: None,
        router_model: None,
    };
    let clock = ManualClock::at(1_792_000_000_000);
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    let r = ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: fleetd_contracts::ids::ProjectId::unchecked("p1"),
    };
    let (w, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: r.clone(),
            title: "Ship the API".into(),
            text: "Ship the API".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
            playbook: None,
            parent: None,
        })
        .unwrap();
    assert_eq!(w.workstream_id.as_str(), "W1");
    hub.leads
        .records
        .lead_put(&StoredLead {
            project_ref: r,
            thread_id: ThreadId::unchecked("lead-thread"),
            started_at: AT.into(),
            last_wake_at: None,
            session_generation: 1,
        })
        .unwrap();
    Lab {
        hub,
        clock,
        _home: home,
    }
}

fn person(key_id: &str) -> Caller {
    serde_json::from_value::<Caller>(json!({
        "keyId": key_id, "name": "wynn-mac", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "operate", "machines": "*" }],
    }))
    .map(|c| Caller {
        kind: Some(KeyKind::Human),
        ..c
    })
    .unwrap()
}

fn to_lead<'a>(text: &'a str, mode: SteerMode, crid: &'a str) -> SteerRequest<'a> {
    SteerRequest {
        target: SteerTarget::Lead {
            workstream_id: WorkstreamId::unchecked("W1"),
        },
        text,
        mode,
        refs: vec![],
        attached: vec![],
        client_request_id: crid,
    }
}

fn events_of(hub: &Hub, kind: HubEventType) -> i64 {
    hub.db
        .with(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM events WHERE type = ?",
                [kind.as_str()],
                |r| r.get(0),
            )?)
        })
        .unwrap()
}

fn receipt(steer: &Steer, stage: SteerStage) -> SteerReceipt {
    SteerReceipt {
        session_id: steer.thread.thread_id.clone(),
        run_id: steer.run_id.clone(),
        steer_id: steer.id.clone(),
        stage,
        at: "2026-10-18T10:00:02.000Z".into(),
        how: (stage == SteerStage::Delivered).then_some(DeliveredHow::Stopped),
        stopped_tool: (stage == SteerStage::Delivered).then(|| Text::unchecked("cargo test")),
        seen_at: None,
        message_id: None,
        excerpt: (stage == SteerStage::Acknowledged)
            .then(|| Text::unchecked("S1: dropping the docs page")),
        reason: None,
    }
}

#[tokio::test]
async fn a_resent_steer_with_the_same_key_and_request_id_is_one_steer() {
    let lab = lab();
    let me = person("k1");
    let first = send(
        &lab.hub,
        By::Human(&me),
        to_lead("skip the docs page", SteerMode::Now, "r1"),
    )
    .await
    .unwrap();
    assert_eq!(first.id.as_str(), "S1");
    assert_eq!(first.stage, SteerStage::Queued);
    // No node is linked: it waits in the offline queue, and says so.
    assert!(
        first
            .detail
            .as_deref()
            .unwrap()
            .starts_with("waiting for lab-a")
    );
    let again = send(
        &lab.hub,
        By::Human(&me),
        to_lead("skip the docs page", SteerMode::Now, "r1"),
    )
    .await
    .unwrap();
    assert_eq!(again, first);
    assert_eq!(events_of(&lab.hub, HubEventType::SteerQueued), 1);
    let queued: i64 = lab
        .hub
        .db
        .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM queued_writes", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(queued, 1);
    // Another device's request with the same id is its own steer.
    let other = send(
        &lab.hub,
        By::Human(&person("k2")),
        to_lead("and the CLI", SteerMode::Queue, "r1"),
    )
    .await
    .unwrap();
    assert_eq!(other.id.as_str(), "S2");
    // The message the lead gets names the steer and asks it to answer to it.
    let message: String = lab
        .hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT message FROM queued_writes ORDER BY write_id LIMIT 1",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert!(
        message.starts_with("S1 · the human steers you (W1 'Ship the API'): 'skip the docs page'")
    );
    assert!(message.contains("\"S1:\""));
}

#[tokio::test]
async fn receipts_move_a_steer_forward_once_and_replays_change_nothing() {
    let lab = lab();
    let me = person("k1");
    let steer = send(
        &lab.hub,
        By::Human(&me),
        to_lead("skip the docs page", SteerMode::Now, "r1"),
    )
    .await
    .unwrap();
    let machine = MachineId::unchecked("lab-a");
    on_receipt(&lab.hub, &machine, &receipt(&steer, SteerStage::Delivered));
    on_receipt(&lab.hub, &machine, &receipt(&steer, SteerStage::Delivered));
    on_receipt(
        &lab.hub,
        &machine,
        &receipt(&steer, SteerStage::Acknowledged),
    );
    on_receipt(&lab.hub, &machine, &receipt(&steer, SteerStage::Delivered));
    on_receipt(
        &lab.hub,
        &machine,
        &receipt(&steer, SteerStage::Unacknowledged),
    );
    let (now, _) = store::get(&lab.hub.db, &steer.id).unwrap().unwrap();
    assert_eq!(now.stage, SteerStage::Acknowledged);
    assert_eq!(now.how, Some(DeliveredHow::Stopped));
    assert_eq!(now.stopped_tool.as_deref(), Some("cargo test"));
    assert_eq!(
        now.ack_excerpt.as_deref(),
        Some("S1: dropping the docs page")
    );
    assert_eq!(events_of(&lab.hub, HubEventType::SteerDelivered), 1);
    assert_eq!(events_of(&lab.hub, HubEventType::SteerAcknowledged), 1);
    assert_eq!(events_of(&lab.hub, HubEventType::SteerUnacknowledged), 0);
    // A receipt from another machine is not this steer's.
    let mut stray = receipt(&steer, SteerStage::Failed);
    stray.steer_id = SteerId::unchecked("S1");
    on_receipt(&lab.hub, &MachineId::unchecked("lab-b"), &stray);
    assert_eq!(
        store::get(&lab.hub.db, &steer.id).unwrap().unwrap().0.stage,
        SteerStage::Acknowledged
    );
}

#[tokio::test]
async fn a_queued_steer_is_withdrawn_from_the_offline_queue_and_a_delivered_one_is_not() {
    let lab = lab();
    let me = person("k1");
    let steer = send(
        &lab.hub,
        By::Human(&me),
        to_lead("skip the docs page", SteerMode::Queue, "r1"),
    )
    .await
    .unwrap();
    let refused = withdraw(&lab.hub, &person("k2"), &steer.id)
        .await
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Forbidden);
    let gone = withdraw(&lab.hub, &me, &steer.id).await.unwrap();
    assert_eq!(gone.stage, SteerStage::Withdrawn);
    assert!(!lab.hub.queue.has_steer(&steer.id));
    assert_eq!(events_of(&lab.hub, HubEventType::SteerWithdrawn), 1);

    let second = send(
        &lab.hub,
        By::Human(&me),
        to_lead("ship the CLI too", SteerMode::Queue, "r2"),
    )
    .await
    .unwrap();
    on_receipt(
        &lab.hub,
        &MachineId::unchecked("lab-a"),
        &receipt(&second, SteerStage::Delivered),
    );
    let late = withdraw(&lab.hub, &me, &second.id).await.unwrap_err();
    assert_eq!(late.code, ErrorCode::Invalid);
    assert!(
        late.message.contains("already delivered at 10:00:02"),
        "{}",
        late.message
    );
}

#[tokio::test]
async fn steers_a_restarted_node_forgot_are_closed_after_the_grace() {
    let lab = lab();
    let me = person("k1");
    let delivered = send(
        &lab.hub,
        By::Human(&me),
        to_lead("skip the docs page", SteerMode::Queue, "r1"),
    )
    .await
    .unwrap();
    let waiting = send(
        &lab.hub,
        By::Human(&me),
        to_lead("and the CLI", SteerMode::Queue, "r2"),
    )
    .await
    .unwrap();
    let lost = send(
        &lab.hub,
        By::Human(&me),
        to_lead("and the site", SteerMode::Queue, "r3"),
    )
    .await
    .unwrap();
    // The node took two of them; the third still waits in the hub's queue for the machine.
    lab.hub.queue.withdraw_steer(&delivered.id);
    lab.hub.queue.withdraw_steer(&lost.id);
    on_receipt(
        &lab.hub,
        &MachineId::unchecked("lab-a"),
        &receipt(&delivered, SteerStage::Delivered),
    );
    assert_eq!(sweep(&lab.hub), 0, "nothing closes inside the grace");
    lab.clock.advance(RECEIPT_GRACE + Duration::from_secs(1));
    assert_eq!(sweep(&lab.hub), 2);
    let stage = |s: &Steer| store::get(&lab.hub.db, &s.id).unwrap().unwrap().0;
    assert_eq!(stage(&delivered).stage, SteerStage::Unacknowledged);
    assert_eq!(stage(&lost).stage, SteerStage::Failed);
    assert!(stage(&lost).detail.unwrap().contains("restarted"));
    assert_eq!(stage(&waiting).stage, SteerStage::Queued);
    assert_eq!(sweep(&lab.hub), 0, "a closed steer stays closed");
}

fn running_task(hub: &Hub, project: &str) -> Task {
    let task: Task = serde_json::from_value(json!({
        "taskId": "T1", "projectRef": { "machineId": "lab-a", "projectId": project }, "workstreamId": "W1",
        "title": "write the API", "kind": "write", "prompt": "do it", "areas": ["api"],
        "model": "claude-haiku-5-5", "effort": "low", "state": "running", "attempt": 1, "createdAt": AT,
        "startedAt": AT, "threadRef": { "machineId": "lab-a", "threadId": "task-thread" },
    }))
    .unwrap();
    hub.db
        .with(|c| Ok(crate::hub::tasks::records::TaskRecords::create(c, task)?))
        .unwrap()
}

fn to_task<'a>(task: &Task, text: &'a str, mode: SteerMode, crid: &'a str) -> SteerRequest<'a> {
    SteerRequest {
        target: SteerTarget::Task {
            task_id: task.task_id.clone(),
        },
        text,
        mode,
        refs: vec![],
        attached: vec![],
        client_request_id: crid,
    }
}

#[tokio::test]
async fn a_persons_steer_to_a_task_tells_its_lead_and_shows_in_the_digest() {
    let lab = lab();
    let task = running_task(&lab.hub, "p1");
    let r = task.project_ref.clone();
    assert!(!lab.hub.leads.wakes.pending(&r));
    let steer = send(
        &lab.hub,
        By::Human(&person("k1")),
        to_task(&task, "skip the docs page", SteerMode::Now, "r1"),
    )
    .await
    .unwrap();
    // The lead hears it at its next (debounced) wake, not as an interrupt.
    assert!(lab.hub.leads.wakes.pending(&r));
    let message: String = lab
        .hub
        .db
        .with(|c| Ok(c.query_row("SELECT message FROM queued_writes", [], |r| r.get(0))?))
        .unwrap();
    assert!(
        message.starts_with("S1 · the human steers you (T1 (write) for W1)"),
        "{message}"
    );
    assert_eq!(
        digest_line(&lab.hub.db, &steer.workstream_id).as_deref(),
        Some("S1 → T1 queued")
    );
    let machine = MachineId::unchecked("lab-a");
    on_receipt(&lab.hub, &machine, &receipt(&steer, SteerStage::Delivered));
    on_receipt(
        &lab.hub,
        &machine,
        &receipt(&steer, SteerStage::Unacknowledged),
    );
    assert_eq!(
        digest_line(&lab.hub.db, &steer.workstream_id).as_deref(),
        Some("S1 → T1 not acknowledged")
    );
}

#[tokio::test]
async fn a_lead_steers_only_its_own_projects_tasks_and_its_lead_is_not_told_of_itself() {
    let lab = lab();
    let task = running_task(&lab.hub, "p1");
    let own = task.project_ref.clone();
    let steer = send(
        &lab.hub,
        By::Lead(&own),
        to_task(&task, "use the v2 endpoint", SteerMode::Queue, "c1"),
    )
    .await
    .unwrap();
    assert_eq!(steer.by, SteerBy::Lead);
    assert!(!lab.hub.leads.wakes.pending(&own));
    let message: String = lab
        .hub
        .db
        .with(|c| Ok(c.query_row("SELECT message FROM queued_writes", [], |r| r.get(0))?))
        .unwrap();
    assert!(
        message.starts_with("S1 · your lead steers you"),
        "{message}"
    );
    let other = ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: fleetd_contracts::ids::ProjectId::unchecked("p2"),
    };
    let refused = send(
        &lab.hub,
        By::Lead(&other),
        to_task(&task, "x", SteerMode::Queue, "c2"),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn a_withdrawn_or_failed_steer_never_reads_as_delivered() {
    let lab = lab();
    let me = person("k1");
    let steer = send(
        &lab.hub,
        By::Human(&me),
        to_lead("skip the docs page", SteerMode::Queue, "r1"),
    )
    .await
    .unwrap();
    on_receipt(
        &lab.hub,
        &MachineId::unchecked("lab-a"),
        &receipt(&steer, SteerStage::Withdrawn),
    );
    let (now, _) = store::get(&lab.hub.db, &steer.id).unwrap().unwrap();
    assert_eq!(now.stage, SteerStage::Withdrawn);
    assert_eq!(now.delivered_at, None);
}

#[tokio::test]
async fn a_steer_to_a_task_that_is_not_running_waits_for_its_next_run_and_is_never_swept() {
    let lab = lab();
    let mut task = running_task(&lab.hub, "p1");
    task.state = TaskState::Idle;
    lab.hub
        .db
        .with(|c| {
            Ok(crate::hub::tasks::records::TaskRecords::put(
                c,
                &crate::hub::tasks::records::StoredTask {
                    task: task.clone(),
                    pending_message: None,
                },
            )?)
        })
        .unwrap();
    let steer = send(
        &lab.hub,
        By::Human(&person("k1")),
        to_task(&task, "skip the docs page", SteerMode::Queue, "r1"),
    )
    .await
    .unwrap();
    assert_eq!(steer.stage, SteerStage::Queued);
    assert_eq!(
        steer.detail.as_deref(),
        Some("queued until T1 starts; it gets this with its next run")
    );
    // The machine is away, so the continuation did not go out: the steer stays held for the next run.
    lab.clock.advance(RECEIPT_GRACE * 10);
    assert_eq!(sweep(&lab.hub), 0);
    assert_eq!(
        store::get(&lab.hub.db, &steer.id).unwrap().unwrap().0.stage,
        SteerStage::Queued
    );
    // When the run goes out, the steer is that run's.
    let thread = task.thread_ref.clone().unwrap();
    let id = take_held(&lab.hub.db, "T1", &thread, "next-run").unwrap();
    assert_eq!(id, steer.id);
    let (bound, _) = store::get(&lab.hub.db, &id).unwrap().unwrap();
    assert_eq!(
        bound.run_id.as_str(),
        Executors::send_run_id(&thread, "next-run")
    );
    assert!(store::held_for_task(&lab.hub.db, "T1").unwrap().is_empty());
}

#[tokio::test]
async fn a_steer_the_queue_is_sending_cannot_be_withdrawn_from_under_it() {
    let lab = lab();
    let me = person("k1");
    let steer = send(
        &lab.hub,
        By::Human(&me),
        to_lead("skip the docs page", SteerMode::Queue, "r1"),
    )
    .await
    .unwrap();
    lab.hub.queue.mark_sending(&steer.id);
    assert!(!lab.hub.queue.withdraw_steer(&steer.id));
    assert!(lab.hub.queue.has_steer(&steer.id));
}

#[tokio::test]
async fn held_steers_go_out_in_order_with_the_next_run_and_any_still_held_can_be_withdrawn() {
    let lab = lab();
    let mut task = running_task(&lab.hub, "p1");
    task.state = TaskState::Idle;
    lab.hub
        .db
        .with(|c| {
            Ok(crate::hub::tasks::records::TaskRecords::put(
                c,
                &crate::hub::tasks::records::StoredTask {
                    task: task.clone(),
                    pending_message: None,
                },
            )?)
        })
        .unwrap();
    let me = person("k1");
    let mut sent = Vec::new();
    for (i, text) in ["one", "two", "three"].iter().enumerate() {
        let crid = format!("r{i}");
        sent.push(
            send(
                &lab.hub,
                By::Human(&me),
                to_task(&task, text, SteerMode::Queue, &crid),
            )
            .await
            .unwrap(),
        );
    }
    let pending = || {
        lab.hub
            .db
            .with(|c| {
                Ok(crate::hub::tasks::records::TaskRecords::get(
                    c,
                    &task.task_id,
                )?)
            })
            .unwrap()
            .unwrap()
            .pending_message
            .unwrap_or_default()
    };
    assert!(
        pending().contains("'one'") && pending().contains("'two'") && pending().contains("'three'")
    );
    // A held steer is withdrawn by taking its words back out of the task's next message.
    let gone = withdraw(&lab.hub, &me, &sent[1].id).await.unwrap();
    assert_eq!(gone.stage, SteerStage::Withdrawn);
    assert!(
        !pending().contains("'two'")
            && pending().contains("'one'")
            && pending().contains("'three'")
    );
    // The next run carries the rest, tagged with the newest; the older one rides with it.
    let thread = task.thread_ref.clone().unwrap();
    let leader = take_held(&lab.hub.db, "T1", &thread, "next-run").unwrap();
    assert_eq!(leader, sent[2].id);
    let (bound, _) = store::get(&lab.hub.db, &leader).unwrap().unwrap();
    let machine = MachineId::unchecked("lab-a");
    on_receipt(&lab.hub, &machine, &receipt(&bound, SteerStage::Delivered));
    on_receipt(
        &lab.hub,
        &machine,
        &receipt(&bound, SteerStage::Acknowledged),
    );
    let stage = |s: &Steer| store::get(&lab.hub.db, &s.id).unwrap().unwrap().0;
    assert_eq!(stage(&sent[2]).stage, SteerStage::Acknowledged);
    let rider = stage(&sent[0]);
    assert_eq!(rider.stage, SteerStage::Acknowledged);
    assert!(rider.detail.unwrap().contains("together with S3"));
    assert_eq!(stage(&sent[1]).stage, SteerStage::Withdrawn);
    lab.clock.advance(RECEIPT_GRACE * 10);
    assert_eq!(sweep(&lab.hub), 0);
}
