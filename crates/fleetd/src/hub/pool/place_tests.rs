//! Which tasks may run on a cloud machine (D306), on a hub: cloud machines on, the project opted in (any of its agents),
//! no secret variables only its own machine holds; and nothing until the hub's first check of boat.dev.
use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::tasks::Task;
use serde_json::json;

use super::ledger::SettingsChange;
use super::place::room;
use crate::hub::api::{Hub, HubConfig};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-11-04T10:00:00.000Z";

fn project(p: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(p),
    }
}

fn task(kind: &str, p: &str) -> Task {
    serde_json::from_value(json!({
        "taskId": "T1", "projectRef": project(p), "workstreamId": "W1", "title": "look", "kind": kind,
        "prompt": "do it", "state": "queued", "attempt": 1, "createdAt": AT,
    }))
    .unwrap()
}

fn hub(home: &tempfile::TempDir) -> Arc<Hub> {
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Default::default(),
        url: None,
    };
    let db = HubDb::open(home.path()).unwrap();
    crate::hub::serve::build_on(db, config, ManualClock::at(1_793_786_400_000)).unwrap()
}

fn opt_in(hub: &Hub, enabled: bool) {
    hub.pool
        .ledger()
        .change_settings(&SettingsChange {
            enabled,
            pool_size: 3,
            machine_type: "large".into(),
            day_budget: 3.0,
            month_budget: None,
            projects: vec![project("app")],
            environment: None,
        })
        .unwrap();
}

#[tokio::test]
async fn only_an_opted_in_projects_agents_may_go_to_a_cloud_machine() {
    let home = tempfile::tempdir().unwrap();
    let hub = hub(&home);
    let app = project("app");
    // Off, and no key: nothing, and nothing to say.
    assert_eq!(room(&hub, &task("read", "app"), &app).eligible, Err(None));
    hub.pool.set_key("boat_test_key").unwrap();
    opt_in(&hub, true);
    let read = room(&hub, &task("read", "app"), &app);
    assert_eq!(read.eligible, Ok(()));
    assert_eq!(
        read.closed.as_deref(),
        Some("cloud machines wait for the hub's first check of boat.dev")
    );
    hub.pool.ready.store(true, SeqCst);
    let review = room(&hub, &task("review", "app"), &app);
    assert_eq!((review.eligible, review.closed), (Ok(()), None));
    assert!(review.awake.is_empty(), "no machine awake");

    // Writers go too: the project's tick and the budget are the controls.
    assert_eq!(room(&hub, &task("write", "app"), &app).eligible, Ok(()));

    // A project that didn't opt in, or the pool off: nothing to say.
    let other = project("other");
    assert_eq!(
        room(&hub, &task("read", "other"), &other).eligible,
        Err(None)
    );
    opt_in(&hub, false);
    assert_eq!(room(&hub, &task("read", "app"), &app).eligible, Err(None));
    opt_in(&hub, true);

    // A secret variable lives only on its own machine.
    hub.db
        .with(|c| {
            Ok(c.execute(
                "INSERT INTO project_env (machine_id, project_id, name, kind, value, fingerprint, bytes, updated_at)
                 VALUES ('devbox', 'app', 'STRIPE_KEY', 'secret', NULL, 'fp', 12, ?1)",
                [AT],
            )?)
        })
        .unwrap();
    assert_eq!(
        room(&hub, &task("read", "app"), &app).eligible,
        Err(Some(
            "not for cloud: its project's secret variables are only on its own machine".into()
        ))
    );
}

/// A clone's token comes from the hub's App only for a github.com repo.
#[test]
fn only_a_github_repo_asks_the_app_for_a_clone_token() {
    use super::place::github_repo;
    assert_eq!(github_repo("github.com/acme/shop"), Some("acme/shop"));
    assert_eq!(github_repo("gitlab.example.com/acme/shop"), None);
    assert_eq!(github_repo("github.com/acme"), None);
}

/// A clone that fails on a machine isn't tried there again until its backoff is over (10 minutes, doubling up to 6
/// hours), and says why meanwhile; it clears once one goes through. So a repo that can't clone never loops.
#[test]
fn a_failed_clone_backs_off_and_says_why() {
    use super::place::{CLONE_BACKOFF_MS, Cloning};
    let cloning = Cloning::default();
    let (boat, app) = (MachineId::unchecked("boat-1"), project("app"));
    let t0 = 1_793_786_400_000; // 10:00 UTC
    assert!(cloning.due(&boat, &app, t0));
    let refused = Err("git clone failed: Repository not found".to_owned());
    cloning.settled(&boat, &app, &refused, t0);
    assert!(!cloning.due(&boat, &app, t0 + CLONE_BACKOFF_MS - 1));
    assert!(
        cloning.due(&MachineId::unchecked("boat-2"), &app, t0),
        "another machine may try"
    );
    assert_eq!(
        cloning.failed_anywhere(&app, t0).as_deref(),
        Some(
            "its repo didn't clone on boat-1, a cloud machine (git clone failed: Repository not found); tried again \
             at 10:10 UTC"
        )
    );
    assert_eq!(cloning.failed_anywhere(&project("other"), t0), None);
    let later = t0 + CLONE_BACKOFF_MS;
    assert!(cloning.due(&boat, &app, later));
    assert_eq!(cloning.failed_anywhere(&app, later), None);
    cloning.settled(&boat, &app, &refused, later);
    assert!(
        !cloning.due(&boat, &app, later + 2 * CLONE_BACKOFF_MS - 1),
        "doubled"
    );
    assert!(cloning.due(&boat, &app, later + 2 * CLONE_BACKOFF_MS));
    cloning.settled(&boat, &app, &Ok(()), later + 2 * CLONE_BACKOFF_MS);
    assert!(cloning.due(&boat, &app, later + 2 * CLONE_BACKOFF_MS));
    assert_eq!(cloning.failed_anywhere(&app, later), None);
}
