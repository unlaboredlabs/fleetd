//! The hub's `TrainHost` on a real hub: which projects a lead's person sees, for `change_enqueue`'s `after` (D338),
//! and which writers' ready PRs the train takes as their own.
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::ledger::{IntakeChannel, WorkstreamId, WorkstreamState};
use fleetd_contracts::model::ProjectCreator;
use fleetd_contracts::people::PersonId;
use fleetd_contracts::tasks::{Task, TaskId};
use serde_json::json;

use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::leads::records::NewWorkstream;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::tasks::records::TaskRecords;

const AT: &str = "2026-11-08T12:00:00.000Z";

fn hub_in(home: &std::path::Path) -> std::sync::Arc<Hub> {
    let config = HubConfig {
        home: home.to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let db = HubDb::open(home).unwrap();
    crate::hub::serve::build_on(db, config, ManualClock::at(1_792_000_000_000)).unwrap()
}

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
    }
}

/// An Only me project's lead sees its owner's projects and every shared one, never another person's Only me project;
/// a shared project's lead sees only what every person does.
#[test]
fn a_leads_person_sees_shared_projects_and_their_own_only_me_ones() {
    let home = tempfile::tempdir().unwrap();
    let hub = hub_in(home.path());
    let only_me = |r: &ProjectRef, owner: &str| {
        hub.db
            .with(|c| {
                crate::hub::navi::store::put(
                    c,
                    r,
                    &ProjectCreator {
                        key_id: format!("k_{owner}"),
                        name: "desk".into(),
                    },
                    Some(&PersonId::unchecked(owner)),
                    0,
                )?;
                Ok(())
            })
            .unwrap();
    };
    let (ann, ann2, bob, shared) = (
        project("ann"),
        project("ann2"),
        project("bob"),
        project("shared"),
    );
    only_me(&ann, "p_ann");
    only_me(&ann2, "p_ann");
    only_me(&bob, "p_bob");
    let host = hub.train.host();

    assert!(host.sees(&ann, &ann));
    assert!(host.sees(&ann, &ann2));
    assert!(host.sees(&ann, &shared));
    assert!(!host.sees(&ann, &bob));
    assert!(host.sees(&shared, &shared));
    assert!(!host.sees(&shared, &ann));
    assert!(!host.sees(&shared, &bob));
}

fn order(hub: &Hub, project_ref: &ProjectRef) -> WorkstreamId {
    hub.leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: project_ref.clone(),
            title: "an order".into(),
            text: "an order".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap()
        .0
        .workstream_id
}

/// A task of `order`, numbered in turn; a writer gets its branch `fleetd/T<n>-work`.
fn task(
    hub: &Hub,
    project_ref: &ProjectRef,
    order: &WorkstreamId,
    kind: &str,
    state: &str,
) -> Task {
    let task: Task = serde_json::from_value(json!({
        "taskId": "T1", "projectRef": project_ref, "workstreamId": order, "title": "work", "kind": kind,
        "prompt": "do it", "state": state, "attempt": 1, "createdAt": AT,
    }))
    .unwrap();
    hub.db
        .with(|c| {
            let mut task = TaskRecords::create(c, task)?;
            if kind == "write" {
                task.branch = Some(
                    serde_json::from_value(json!(format!("fleetd/{}-work", task.task_id))).unwrap(),
                );
                TaskRecords::put(
                    c,
                    &crate::hub::tasks::records::StoredTask {
                        task: task.clone(),
                        pending_message: None,
                    },
                )?;
            }
            Ok(task)
        })
        .unwrap()
}

/// A writer that runs for hours is still a writer once a hundred newer tasks (reviewers of its own PRs among them)
/// came after it, so the PRs it opens later go on the train by themselves; a closed order's writer and a cancelled one
/// are none.
#[test]
fn a_long_running_writer_behind_a_hundred_newer_tasks_is_still_the_trains_writer() {
    let home = tempfile::tempdir().unwrap();
    let hub = hub_in(home.path());
    let p = project("p1");
    let (open, closed) = (order(&hub, &p), order(&hub, &p));
    let writer = task(&hub, &p, &open, "write", "running");
    let failed = task(&hub, &p, &open, "write", "failed");
    task(&hub, &p, &open, "write", "cancelled");
    task(&hub, &p, &closed, "write", "done");
    for _ in 0..150 {
        task(&hub, &p, &open, "review", "done");
    }
    let mut w = hub.leads.records.workstream_get(&closed).unwrap().unwrap();
    w.state = WorkstreamState::Done;
    hub.leads.records.workstream_put(&w).unwrap();

    let mut writers = hub.train.host().writers(&p);
    writers.sort();
    let branch = |t: &TaskId| format!("fleetd/{t}-work");
    assert_eq!(
        writers,
        [
            (writer.task_id.clone(), branch(&writer.task_id)),
            (failed.task_id.clone(), branch(&failed.task_id)),
        ]
    );
    assert_eq!(hub.train.host().writers(&project("p2")), []);
}
