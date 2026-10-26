//! The Steers service over a real hub with an in-memory database and no node linked: steers wait in the offline
//! queue, and receipts are fed as the node would send them.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, ThreadId, ThreadRef};
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
        "keyId": key_id, "name": "laptop", "prefix": "fld_abcdef", "createdAt": AT,
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
            .then(|| Text::unchecked("Dropping the docs page")),
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
    // The message the lead gets carries the steer's id, so a plan change can cite it.
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
}

/// A steer of 20,000 characters goes to the agent whole; one more character is refused before anything is sent.
#[tokio::test]
async fn a_steer_is_at_most_20000_characters() {
    let lab = lab();
    let tools = crate::hub::api::registry();
    let steer = |text: String, crid: &str| json!({ "target": { "workstreamId": "W1" }, "text": text, "clientRequestId": crid });
    let long = "x".repeat(STEER_TEXT_MAX);
    let sent = tools
        .call(
            &lab.hub,
            &person("k1"),
            "steer_send",
            steer(long.clone(), "r1"),
        )
        .await
        .unwrap();
    assert_eq!(sent["text"], long);
    let message: String = lab
        .hub
        .db
        .with(|c| Ok(c.query_row("SELECT message FROM queued_writes", [], |r| r.get(0))?))
        .unwrap();
    assert!(message.contains(&long), "the agent gets every character");
    let Err(crate::hub::api::CallError::Invalid(why)) = tools
        .call(
            &lab.hub,
            &person("k1"),
            "steer_send",
            steer(format!("{long}x"), "r2"),
        )
        .await
    else {
        panic!("a steer past the limit was taken")
    };
    assert!(why.contains("20000"), "{why}");
    assert_eq!(events_of(&lab.hub, HubEventType::SteerQueued), 1);
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
    assert_eq!(now.ack_excerpt.as_deref(), Some("Dropping the docs page"));
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
        "title": "write the API", "kind": "write", "prompt": "do it",
        "state": "running", "attempt": 1, "createdAt": AT,
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
    let tag = take_held(&lab.hub.db, "T1", &thread, "next-run").unwrap();
    assert_eq!(tag.id, steer.id);
    assert!(tag.riders.is_empty());
    let (bound, _) = store::get(&lab.hub.db, &tag.id).unwrap().unwrap();
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
    // The next run carries the rest in order: the newest is its tag, the older one rides with it, and each has its
    // own receipts.
    let thread = task.thread_ref.clone().unwrap();
    let tag = take_held(&lab.hub.db, "T1", &thread, "next-run").unwrap();
    assert_eq!(tag.id, sent[2].id);
    assert_eq!(tag.riders, [sent[0].id.clone()]);
    let stage = |s: &Steer| store::get(&lab.hub.db, &s.id).unwrap().unwrap().0;
    let (leader, rider) = (stage(&sent[2]), stage(&sent[0]));
    assert_eq!(leader.run_id, rider.run_id);
    assert!(
        rider
            .detail
            .as_deref()
            .unwrap()
            .contains("together with S3")
    );
    let machine = MachineId::unchecked("lab-a");
    on_receipt(&lab.hub, &machine, &receipt(&leader, SteerStage::Delivered));
    on_receipt(&lab.hub, &machine, &receipt(&rider, SteerStage::Delivered));
    // The agent named only the newest: the older one is not acknowledged by it.
    on_receipt(
        &lab.hub,
        &machine,
        &receipt(&leader, SteerStage::Acknowledged),
    );
    assert_eq!(stage(&sent[2]).stage, SteerStage::Acknowledged);
    assert_eq!(stage(&sent[0]).stage, SteerStage::Delivered);
    on_receipt(
        &lab.hub,
        &machine,
        &receipt(&rider, SteerStage::Unacknowledged),
    );
    assert_eq!(stage(&sent[0]).stage, SteerStage::Unacknowledged);
    assert_eq!(stage(&sent[1]).stage, SteerStage::Withdrawn);
}

#[tokio::test]
async fn the_sweep_closes_every_steer_of_a_batch_whose_receipts_never_came() {
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
    let a = send(
        &lab.hub,
        By::Human(&me),
        to_task(&task, "one", SteerMode::Queue, "r1"),
    )
    .await
    .unwrap();
    let b = send(
        &lab.hub,
        By::Human(&me),
        to_task(&task, "two", SteerMode::Queue, "r2"),
    )
    .await
    .unwrap();
    let thread = task.thread_ref.clone().unwrap();
    take_held(&lab.hub.db, "T1", &thread, "next-run").unwrap();
    // The node restarted before either receipt came.
    lab.clock.advance(RECEIPT_GRACE + Duration::from_secs(1));
    assert_eq!(sweep(&lab.hub), 2);
    for s in [&a, &b] {
        let (now, _) = store::get(&lab.hub.db, &s.id).unwrap().unwrap();
        assert_eq!(now.stage, SteerStage::Failed, "{}", s.id);
    }
}

#[tokio::test]
async fn a_resent_request_finds_its_steer_after_it_was_bound_to_a_tasks_run() {
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
    let first = send(
        &lab.hub,
        By::Human(&me),
        to_task(&task, "one", SteerMode::Queue, "r1"),
    )
    .await
    .unwrap();
    // Bound to the task's next run: its run id is that run's now.
    let thread = task.thread_ref.clone().unwrap();
    take_held(&lab.hub.db, "T1", &thread, "next-run").unwrap();
    let again = send(
        &lab.hub,
        By::Human(&me),
        to_task(&task, "one", SteerMode::Queue, "r1"),
    )
    .await
    .unwrap();
    assert_eq!(again.id, first.id);
    let (bound, _) = store::get(&lab.hub.db, &first.id).unwrap().unwrap();
    on_receipt(
        &lab.hub,
        &MachineId::unchecked("lab-a"),
        &receipt(&bound, SteerStage::Delivered),
    );
    let later = send(
        &lab.hub,
        By::Human(&me),
        to_task(&task, "one", SteerMode::Queue, "r1"),
    )
    .await
    .unwrap();
    assert_eq!(later.id, first.id);
    assert_eq!(later.stage, SteerStage::Delivered);
    let rows: i64 = lab
        .hub
        .db
        .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM steers", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 1);
    assert_eq!(events_of(&lab.hub, HubEventType::SteerQueued), 1);
}

/// The hub tells a task's agent from the lead by the session a call names, and a task's agent may only report and
/// ask its lead: `ask_lead` wakes the lead, and a spawn is refused with the reason.
#[tokio::test]
async fn a_tasks_agent_is_a_worker_its_question_wakes_the_lead_and_it_cannot_spawn() {
    use crate::hub::link::lead_calls::CallerAgent;
    use crate::hub::tasks::policy;
    let lab = lab();
    let task = running_task(&lab.hub, "p1");
    let thread = |id: &str| ThreadRef {
        machine_id: MachineId::unchecked("lab-a"),
        thread_id: ThreadId::unchecked(id),
    };
    let p1 = task.project_ref.clone();
    let agent = |id: Option<&str>, project: &ProjectRef| {
        lab.hub
            .lead_calls
            .agent_of(id.map(thread).as_ref(), project)
    };
    let worker = agent(Some("task-thread"), &p1).unwrap();
    assert_eq!(worker, CallerAgent::Task(task.task_id.clone()));
    assert_eq!(agent(Some("lead-thread"), &p1), Ok(CallerAgent::Lead));
    assert_eq!(agent(None, &p1), Ok(CallerAgent::Person));
    // Fails closed: a session that is no lead or task, and a session acting on another project, are refused.
    let unknown = agent(Some("someone-else"), &p1).unwrap_err();
    assert!(
        unknown
            .message
            .contains("neither a project's lead nor a task"),
        "{}",
        unknown.message
    );
    let other = ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: fleetd_contracts::ids::ProjectId::unchecked("p2"),
    };
    let elsewhere = agent(Some("task-thread"), &other).unwrap_err();
    assert!(
        elsewhere.message.contains("works for project lab-a/p1"),
        "{}",
        elsewhere.message
    );
    let refused = policy::check(&worker, "task_spawn").unwrap_err();
    assert!(
        refused.message.starts_with("T1 is a task"),
        "{}",
        refused.message
    );
    assert_eq!(policy::check(&CallerAgent::Lead, "task_spawn"), Ok(()));

    let ask = |agent: CallerAgent| {
        let call: fleetd_contracts::lead_calls::LeadCall =
            serde_json::from_value(json!({ "op": "ask_lead", "question": "Postgres or SQLite?" }))
                .unwrap();
        let caller = crate::hub::link::LeadCaller {
            project_ref: task.project_ref.clone(),
            by: "lead:lab-a/p1".into(),
            agent,
        };
        let handler = lab.hub.lead_calls.handler("ask_lead").unwrap();
        futures_util::FutureExt::now_or_never(handler.handle(caller, call)).unwrap()
    };
    assert!(!lab.hub.leads.wakes.pending(&task.project_ref));
    let Ok(fleetd_contracts::lead_calls::LeadCallResult::AskLead(asked)) = ask(worker) else {
        panic!("ask_lead from a task was not answered")
    };
    assert_eq!(asked.task_id.as_str(), "T1");
    assert!(
        lab.hub.leads.wakes.pending(&task.project_ref),
        "the lead was not woken"
    );
    assert_eq!(
        ask(CallerAgent::Lead).unwrap_err().code,
        fleetd_contracts::mcp::ErrorCode::Invalid
    );
}

/// `close` records the lead's why with `workstream.done` and stops nothing: the order's running task keeps running.
/// Closing it again is refused, and a task's agent may not close.
#[tokio::test]
async fn a_lead_closes_its_work_with_why_and_nothing_is_stopped() {
    use crate::hub::link::lead_calls::CallerAgent;
    use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
    use fleetd_contracts::ledger::WorkstreamState;
    let lab = lab();
    let task = running_task(&lab.hub, "p1");
    let close = || {
        let call: LeadCall = serde_json::from_value(
            json!({ "op": "close", "workstreamId": "W1", "why": "the API is merged and live" }),
        )
        .unwrap();
        let caller = crate::hub::link::LeadCaller {
            project_ref: task.project_ref.clone(),
            by: "lead:lab-a/p1".into(),
            agent: CallerAgent::Lead,
        };
        let handler = lab.hub.lead_calls.handler("close").unwrap();
        futures_util::FutureExt::now_or_never(handler.handle(caller, call)).unwrap()
    };
    let Ok(LeadCallResult::Close(closed)) = close() else {
        panic!("close was not answered")
    };
    assert_eq!(closed.state, WorkstreamState::Done);
    let w1 = fleetd_contracts::ledger::WorkstreamId::unchecked("W1");
    let stored = lab.hub.leads.records.workstream_get(&w1).unwrap().unwrap();
    assert_eq!(stored.state, WorkstreamState::Done);
    let done: Vec<serde_json::Value> = lab
        .hub
        .db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT json_extract(data, '$.data') FROM events WHERE type = 'workstream.done'",
            )?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap()
        .iter()
        .map(|d| serde_json::from_str(d).unwrap())
        .collect();
    assert_eq!(
        done,
        [
            json!({ "workstreamId": "W1", "reason": "the API is merged and live", "by": "lead:lab-a/p1" })
        ]
    );
    let still = lab.hub.tasks.get(&task.task_id).unwrap().unwrap();
    assert_eq!(
        still.state,
        fleetd_contracts::tasks::TaskState::Running,
        "close cancels nothing"
    );
    assert_eq!(
        close().unwrap_err().code,
        fleetd_contracts::mcp::ErrorCode::Invalid,
        "already done"
    );
    let worker = CallerAgent::Task(task.task_id.clone());
    assert_eq!(
        crate::hub::tasks::policy::check(&worker, "close")
            .unwrap_err()
            .code,
        fleetd_contracts::mcp::ErrorCode::Forbidden
    );
}

/// `close` is refused while the workstream still has PRs in the train, and the refusal lists them; once they merged
/// (or were abandoned) it closes.
#[tokio::test]
async fn a_lead_cannot_close_its_work_while_its_prs_are_in_the_train() {
    use crate::hub::link::lead_calls::CallerAgent;
    use crate::hub::train::contract::{Change, ChangeState};
    use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
    use fleetd_contracts::ledger::WorkstreamState;
    let lab = lab();
    let records = lab.hub.train.records();
    let change = |number: i64, state: &str| -> Change {
        let sha = "b".repeat(40);
        serde_json::from_value(json!({
            "changeId": "X1", "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "repo": "o/testbed",
            "prNumber": number, "prUrl": format!("https://github.com/o/testbed/pull/{number}"),
            "branch": format!("fleetd/pr-{number}"), "workstreamId": "W1", "headSha": sha, "state": state,
            "reviews": [], "createdAt": AT, "updatedAt": AT,
        }))
        .unwrap()
    };
    records.create(change(4, "abandoned"));
    records.create(change(5, "merged"));
    let reviewing = records.create(change(6, "reviewing"));
    let ready = records.create(change(7, "ready"));
    let close = || {
        let call: LeadCall = serde_json::from_value(
            json!({ "op": "close", "workstreamId": "W1", "why": "every batched PR is merged" }),
        )
        .unwrap();
        let caller = crate::hub::link::LeadCaller {
            project_ref: ProjectRef {
                machine_id: MachineId::unchecked("lab-a"),
                project_id: fleetd_contracts::ids::ProjectId::unchecked("p1"),
            },
            by: "lead:lab-a/p1".into(),
            agent: CallerAgent::Lead,
        };
        let handler = lab.hub.lead_calls.handler("close").unwrap();
        futures_util::FutureExt::now_or_never(handler.handle(caller, call)).unwrap()
    };
    let refused = close().unwrap_err();
    assert_eq!(refused.code, fleetd_contracts::mcp::ErrorCode::Invalid);
    assert_eq!(
        refused.message,
        "W1 still has PRs in the train: #6 reviewing, #7 ready."
    );
    let w1 = WorkstreamId::unchecked("W1");
    let stored = lab.hub.leads.records.workstream_get(&w1).unwrap().unwrap();
    assert_eq!(stored.state, WorkstreamState::Open);

    for (c, state) in [
        (reviewing, ChangeState::Merged),
        (ready, ChangeState::Abandoned),
    ] {
        records.put(&Change { state, ..c });
    }
    let Ok(LeadCallResult::Close(closed)) = close() else {
        panic!("close was refused once every PR landed or left")
    };
    assert_eq!(closed.state, WorkstreamState::Done);
}

/// A writer's session works in a worktree under the node's home, outside every workspace: its calls act on its own
/// project, known by the session. Without a session such a cwd is still refused, and a session never reaches a
/// project its machine doesn't have.
#[tokio::test]
async fn a_writers_call_from_its_worktree_acts_on_its_own_project() {
    let lab = lab();
    let task = running_task(&lab.hub, "p1");
    let machine = MachineId::unchecked("lab-a");
    let summary = |id: &str, root: &str| -> fleetd_contracts::model::ProjectSummary {
        serde_json::from_value(json!({
            "machineId": "lab-a", "projectId": id, "title": id, "workspaceRoot": root,
            "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
        }))
        .unwrap()
    };
    let projects = [summary("p1", "/work/project"), summary("p2", "/work/other")];
    let thread = |id: &str| ThreadRef {
        machine_id: machine.clone(),
        thread_id: ThreadId::unchecked(id),
    };
    let calls = &lab.hub.lead_calls;
    let worktree = "/home/me/.fleetd/node/worktrees/abc/task-thread";
    assert_eq!(
        calls.call_project(&machine, &projects, worktree, Some(&thread("task-thread"))),
        Ok(task.project_ref.clone())
    );
    let other = calls
        .call_project(
            &machine,
            &projects,
            "/work/other/src",
            Some(&thread("task-thread")),
        )
        .unwrap();
    assert_eq!(
        other.project_id.as_str(),
        "p2",
        "a cwd inside a workspace decides, as before"
    );
    let person = calls
        .call_project(&machine, &projects, worktree, None)
        .unwrap_err();
    assert!(
        person
            .message
            .contains("is not inside any project workspace"),
        "{}",
        person.message
    );
    assert!(
        calls
            .call_project(&machine, &projects, worktree, Some(&thread("someone-else")))
            .is_err()
    );
    assert!(
        calls
            .call_project(
                &machine,
                &projects[1..],
                worktree,
                Some(&thread("task-thread"))
            )
            .is_err(),
        "its project is not on this machine"
    );
}

/// `stop_agent` frees the slot only once the agent's claude has exited. With the machine away the node
/// can't stop it, so the task stays running and holding its slot, and the refusal says so.
#[tokio::test]
async fn a_cancel_the_node_cannot_carry_out_keeps_the_task_and_its_slot() {
    let lab = lab();
    let task = running_task(&lab.hub, "p1");
    lab.hub
        .slots
        .acquire(crate::hub::slots::SlotRequest {
            holder: "T1",
            project_ref: &task.project_ref,
            priority: crate::hub::slots::priority_of(task.kind),
        })
        .unwrap();
    let used = lab.hub.slots.state().used.get();
    assert_eq!(used, 1);
    let caller = crate::hub::tasks::TaskCaller {
        project_ref: task.project_ref.clone(),
        by: "lead:lab-a/p1".into(),
    };
    let refused = lab
        .hub
        .tasks
        .cancel(&caller, &task.task_id, None)
        .await
        .unwrap_err();
    assert!(
        refused
            .message
            .contains("T1 could not be stopped (machine lab-a has no live node link)"),
        "{}",
        refused.message
    );
    assert_eq!(
        refused.fix.as_deref(),
        Some("Call stop_agent again shortly.")
    );
    assert_eq!(
        lab.hub.tasks.get(&task.task_id).unwrap().unwrap().state,
        TaskState::Running
    );
    assert_eq!(
        lab.hub.slots.state().used.get(),
        used,
        "the slot stays held"
    );
}
