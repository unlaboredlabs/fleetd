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

/// What the train logs on this thread, for tests that count its lines.
#[derive(Clone, Default)]
pub(super) struct Logs(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for Logs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Logs {
    type Writer = Logs;
    fn make_writer(&'a self) -> Logs {
        self.clone()
    }
}

impl Logs {
    /// Logs everything from INFO up on this thread while the guard lives.
    pub(super) fn capture(&self) -> tracing::subscriber::DefaultGuard {
        let subscriber = tracing_subscriber::fmt()
            .with_writer(self.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::INFO)
            .finish();
        tracing::subscriber::set_default(subscriber)
    }

    pub(super) fn count(&self, line: &str) -> usize {
        String::from_utf8_lossy(&self.0.lock().unwrap())
            .matches(line)
            .count()
    }
}

/// The train asks for the branch prefix every pass. A project the hub no longer has is skipped without a word; one
/// whose machine is offline warns once, then at most hourly, with how many it held back.
#[tokio::test(flavor = "current_thread")]
async fn the_branch_prefix_of_a_removed_project_is_skipped_and_an_unread_one_warns_hourly() {
    use fleetd_contracts::ids::Timestamp;
    use fleetd_contracts::model::{ProjectSummary, ThreadCounts};

    let logs = Logs::default();
    let _guard = logs.capture();
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let clock = ManualClock::at(1_792_000_000_000);
    let db = HubDb::open(home.path()).unwrap();
    let hub = crate::hub::serve::build_on(db, config, clock.clone()).unwrap();
    let offline = project("offline");
    hub.store
        .projects_upsert_many(
            &offline.machine_id,
            &[ProjectSummary {
                machine_id: offline.machine_id.clone(),
                project_id: offline.project_id.clone(),
                title: "repo-a".into(),
                workspace_root: "/lab/repo-a".into(),
                threads: ThreadCounts::default(),
                last_activity_at: Timestamp::from("2026-10-17T10:00:00.000Z".to_owned()),
                repos: Vec::new(),
                kind: None,
                only_me: false,
                created_by: None,
                owner: None,
                archived_at: None,
                avatar: None,
                icon: None,
            }],
        )
        .unwrap();
    let host = hub.train.host();

    for _ in 0..5 {
        assert_eq!(host.branch_prefix(&project("removed")).await, None);
        assert_eq!(host.branch_prefix(&offline).await, None);
    }
    assert_eq!(logs.count("project=removed"), 0);
    assert_eq!(logs.count("policy not read"), 1);
    assert_eq!(logs.count("repeats=0"), 1);

    clock.advance(std::time::Duration::from_secs(60 * 60));
    assert_eq!(host.branch_prefix(&offline).await, None);
    assert_eq!(logs.count("policy not read"), 2);
    assert_eq!(logs.count("repeats=4"), 1);
}

/// A project the store can't read is taken as still there: its PR stays on the train, and the sweep looks again on
/// its next run. Only a project the store says is gone takes its PRs off.
#[tokio::test(flavor = "current_thread")]
async fn a_failed_project_read_never_takes_a_pr_off_the_train() {
    use fleetd_contracts::train::{Change, ChangeState};

    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let db = HubDb::open(home.path()).unwrap();
    let hub = crate::hub::serve::build_on(db, config, ManualClock::at(1_792_000_000_000)).unwrap();
    let change: Change = serde_json::from_value(json!({
        "changeId": "X1",
        "projectRef": { "machineId": "devbox", "projectId": "live" },
        "repo": "acme/app",
        "prNumber": 7,
        "prUrl": "https://github.com/acme/app/pull/7",
        "branch": "fleetd/T1-app",
        "workstreamId": "W1",
        "headSha": "0123456789abcdef0123456789abcdef01234567",
        "state": "ready",
        "reviews": [],
        "createdAt": "2026-11-08T10:00:00.000Z",
        "updatedAt": "2026-11-08T10:00:00.000Z"
    }))
    .unwrap();
    let change = hub.train.records().create(change);
    let rename = |from: &str, to: &str| {
        let sql = format!("ALTER TABLE {from} RENAME TO {to}");
        hub.db.with(|c| Ok(c.execute_batch(&sql)?)).unwrap();
    };
    let state = || hub.train.records().get(&change.change_id).unwrap().state;

    rename("projects", "projects_away");
    assert!(hub.store.project_get(&change.project_ref).is_err());
    assert!(!hub.train.host().project_removed(&change.project_ref));
    hub.train.drop_removed();
    assert_eq!(state(), ChangeState::Ready);

    // Read again, the store has no such project: now it leaves.
    rename("projects_away", "projects");
    hub.train.drop_removed();
    assert_eq!(state(), ChangeState::Abandoned);
}
