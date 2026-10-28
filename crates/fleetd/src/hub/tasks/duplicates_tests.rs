//! The duplicate check at spawn, over a real hub with an in-memory database and no node linked (so spawned writers
//! queue). Two projects on two machines share one repo's main, on a host that isn't GitHub.
use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult, TaskResultFrame, TaskSpawnCall};
use fleetd_contracts::ledger::IntakeChannel;
use fleetd_contracts::prim::{Line, List};
use fleetd_contracts::tasks::{PrUrl, Task, TaskState};
use fleetd_contracts::work::{ClaimOwner, ClaimOwnerKind, RepoKey, WorkKey, WorkPath, WorkScope};
use serde_json::{Value, json};

use super::ports::TaskError;
use super::{TaskCaller, TaskRecords};
use crate::hub::api::{Hub, HubConfig};
use crate::hub::leads::records::NewWorkstream;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::work::NewClaim;

const AT: &str = "2026-10-25T10:00:00.000Z";

fn project(machine: &str, id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked(machine),
        project_id: ProjectId::unchecked(id),
    }
}

fn shop() -> WorkScope {
    WorkScope {
        repo_key: RepoKey::of("git@gitlab.example.com:acme/shop.git").unwrap(),
        base: Line::unchecked("main"),
    }
}

/// A hub where `app` (devbox) and `web` (laptop) both land on acme/shop's main, with open orders W1 and W2.
fn hub() -> (Arc<Hub>, ProjectRef, ProjectRef, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Default::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        ManualClock::at(1_792_922_400_000),
    )
    .unwrap();
    let (app, web) = (project("devbox", "app"), project("laptop", "web"));
    for p in [&app, &web] {
        hub.work.bind_project(p, &shop()).unwrap();
    }
    let (w, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: app.clone(),
            title: "Ship the shop".into(),
            text: "Ship the shop".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    assert_eq!(w.workstream_id.as_str(), "W1");
    let (w, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: web.clone(),
            title: "Web".into(),
            text: "Web".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    assert_eq!(w.workstream_id.as_str(), "W2");
    (hub, app, web, home)
}

/// A live writer of `project`'s, stored as it is.
fn writer_of(hub: &Hub, project: &ProjectRef, title: &str) -> Task {
    let task: Task = serde_json::from_value(json!({
        "taskId": "T1", "projectRef": project, "workstreamId": "W9", "title": title, "kind": "write",
        "prompt": "do it", "state": "running", "attempt": 1, "createdAt": AT,
    }))
    .unwrap();
    hub.db.with(|c| Ok(TaskRecords::create(c, task)?)).unwrap()
}

fn claim_by(hub: &Hub, kind: ClaimOwnerKind, title: &str, keys: Vec<WorkKey>) -> String {
    let claim = hub
        .work
        .claim(NewClaim {
            scope: shop(),
            project_ref: None,
            owner: ClaimOwner {
                kind,
                key_id: Line::unchecked("k7"),
                label: Some(Line::unchecked("laptop")),
            },
            title: Line::new(title).unwrap(),
            keys: List::unchecked(keys),
            branch: None,
            paths: List::unchecked(vec![WorkPath::unchecked("app/billing/invoice.ts")]),
            author_email: None,
        })
        .unwrap();
    claim.claim_id.as_str().to_owned()
}

fn call(title: &str, extra: Value) -> TaskSpawnCall {
    let mut data =
        json!({ "workstreamId": "W1", "title": title, "kind": "write", "prompt": "do it" });
    data.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(data).unwrap()
}

async fn spawn(
    hub: &Arc<Hub>,
    project: &ProjectRef,
    input: TaskSpawnCall,
) -> Result<TaskResultFrame, TaskError> {
    let caller = TaskCaller {
        project_ref: project.clone(),
        by: "lead".into(),
    };
    match super::tools::lead_call(&hub.tasks, &caller, LeadCall::TaskSpawn(input)).await? {
        LeadCallResult::TaskSpawn(frame) => Ok(frame),
        other => panic!("not a spawn result: {other:?}"),
    }
}

fn next(frame: &TaskResultFrame) -> &str {
    frame.next.as_deref().unwrap_or_default()
}

const MR: &str = "https://gitlab.example.com/acme/shop/-/merge_requests/42";

/// A writer named for a merge request another project's writer opened is taken: refused, and nothing is stored. The
/// lead may still say it is different work; over a person's own claim on it, it may not, and has to ask in chat.
#[tokio::test]
async fn an_exact_duplicate_is_refused() {
    let (hub, app, web, _home) = hub();
    let theirs: Task = serde_json::from_value(json!({
        "taskId": "T1", "projectRef": web, "workstreamId": "W9", "title": "login redirects loop", "kind": "write",
        "prompt": "do it", "state": "idle", "attempt": 1, "createdAt": AT,
        "result": { "status": "done", "tail": "opened !42", "prUrl": MR, "at": AT },
    }))
    .unwrap();
    let theirs = hub
        .db
        .with(|c| Ok(TaskRecords::create(c, theirs)?))
        .unwrap();

    let refused = spawn(
        &hub,
        &app,
        call("Finish the login fix", json!({ "pr": MR })),
    )
    .await
    .unwrap_err();
    assert!(
        refused
            .message
            .starts_with("Taken: T1 \"login redirects loop\" (idle, project web): same !42"),
        "{}",
        refused.message
    );
    assert!(
        refused
            .fix
            .as_deref()
            .unwrap()
            .contains("notDuplicateOf: [\"T1\"]")
    );
    assert_eq!(
        hub.tasks.get(&super::TaskId::unchecked("T2")).unwrap(),
        None,
        "nothing spawned"
    );

    let passed = spawn(
        &hub,
        &app,
        call(
            "Finish the login fix",
            json!({ "pr": MR, "notDuplicateOf": [theirs.task_id], "notDuplicateWhy": "web's T1 handed !42 to us" }),
        ),
    )
    .await
    .unwrap();
    assert_eq!(passed.task.state, TaskState::Queued);
    assert!(
        next(&passed).contains("elsewhere: T1 "),
        "{}",
        next(&passed)
    );

    let human = claim_by(
        &hub,
        ClaimOwnerKind::HumanSession,
        "checkout totals",
        vec![WorkKey::Pr(PrUrl::unchecked(
            "https://gitlab.example.com/acme/shop/-/merge_requests/7",
        ))],
    );
    let refused = spawn(
        &hub,
        &app,
        call(
            "Checkout rounding",
            json!({
                "pr": "https://gitlab.example.com/acme/shop/-/merge_requests/7",
                "notDuplicateOf": [human], "notDuplicateWhy": "I think it is different",
            }),
        ),
    )
    .await
    .unwrap_err();
    assert!(
        refused.message.starts_with(
            "Taken by a person: C1 \"checkout totals\" (active, a person's session, laptop): same !7"
        ),
        "{}",
        refused.message
    );
    assert!(
        refused
            .fix
            .as_deref()
            .unwrap()
            .contains("ask them in chat to release it (`fleetd work done`, or drop it)")
    );

    // Only written in the title, the same merge request is a likely duplicate, not taken.
    let refused = spawn(&hub, &app, call("Follow up on !7", json!({})))
        .await
        .unwrap_err();
    assert!(
        refused.message.starts_with("Possible duplicate: C1"),
        "{}",
        refused.message
    );
}

/// A near-identical title is refused once; naming it in `notDuplicateOf`, with a reason, lets the same call through.
#[tokio::test]
async fn a_strong_duplicate_is_refused_once_then_the_override_passes() {
    let (hub, app, _web, _home) = hub();
    writer_of(&hub, &app, "dark mode toggle in settings");
    let ask = "Dark mode toggle for the settings page";

    let refused = spawn(&hub, &app, call(ask, json!({}))).await.unwrap_err();
    assert!(
        refused
            .message
            .starts_with("Possible duplicate: T1 \"dark mode toggle in settings\""),
        "{}",
        refused.message
    );
    assert!(
        refused
            .fix
            .as_deref()
            .unwrap()
            .contains("notDuplicateOf: [\"T1\"] and notDuplicateWhy")
    );

    let without_why = serde_json::from_value::<TaskSpawnCall>(json!({
        "workstreamId": "W1", "title": ask, "kind": "write", "prompt": "do it", "notDuplicateOf": ["T1"],
    }));
    assert!(
        without_why
            .unwrap_err()
            .to_string()
            .contains("notDuplicateOf needs notDuplicateWhy")
    );

    let passed = spawn(
        &hub,
        &app,
        call(ask, json!({ "notDuplicateOf": ["T1"], "notDuplicateWhy": "T1 is the desktop app, this the site" })),
    )
    .await
    .unwrap();
    assert_eq!(passed.task.task_id.as_str(), "T2");
    assert!(
        next(&passed).contains("elsewhere: T1 \"dark mode toggle in settings\""),
        "{}",
        next(&passed)
    );
}

/// Each repo is checked against its own work (W79): a writer in `app`'s second repo `lib` doesn't repeat a writer in
/// `app`'s own repo, a second one in `lib` repeats the first, and the own repo's check doesn't see `lib`'s.
#[tokio::test]
async fn the_duplicate_check_is_per_repo() {
    let (hub, app, _web, _home) = hub();
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id, repo_key,
                 base) VALUES ('devbox', 'app', 'lib', 'devbox', 'lib', 'gitlab.example.com/acme/lib', 'main')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    writer_of(&hub, &app, "dark mode toggle in settings");
    let ask = "Dark mode toggle for the settings page";

    let in_lib = spawn(&hub, &app, call(ask, json!({ "repo": "lib" })))
        .await
        .unwrap();
    assert_eq!(in_lib.task.task_id.as_str(), "T2");
    assert_eq!(in_lib.task.repo_id.as_ref().map(|r| r.as_str()), Some("R1"));
    assert!(!next(&in_lib).contains("elsewhere"), "{}", next(&in_lib));

    let again = spawn(&hub, &app, call(ask, json!({ "repo": "lib" })))
        .await
        .unwrap_err();
    assert!(
        again.message.starts_with("Possible duplicate: T2 "),
        "{}",
        again.message
    );
    assert!(!again.message.contains("T1"), "{}", again.message);

    let own = spawn(&hub, &app, call(ask, json!({}))).await.unwrap_err();
    assert!(
        own.message.starts_with("Possible duplicate: T1 "),
        "{}",
        own.message
    );
    assert!(!own.message.contains("T2"), "{}", own.message);
}

/// Two shared words and a shared file only list the claim; the spawn goes through.
#[tokio::test]
async fn a_weak_duplicate_is_listed() {
    let (hub, app, _web, _home) = hub();
    let claim = claim_by(
        &hub,
        ClaimOwnerKind::AgentKey,
        "billing invoice export to csv",
        vec![],
    );

    let passed = spawn(
        &hub,
        &app,
        call(
            "Billing invoice email reminders",
            json!({ "paths": ["app/mail/remind.ts"] }),
        ),
    )
    .await
    .unwrap();
    assert_eq!(passed.task.state, TaskState::Queued);
    assert!(
        next(&passed).contains(&format!(
            "elsewhere: {claim} \"billing invoice export to csv\" (active, an agent key, laptop): 2 shared words: billing, invoice"
        )),
        "{}",
        next(&passed)
    );
}

/// A project fleetd has no repo and base for (none recorded, and no node to read its root) isn't checked, and says so.
#[tokio::test]
async fn a_project_with_no_binding_passes_with_a_note() {
    let (hub, _app, _web, _home) = hub();
    let loose = project("devbox", "loose");
    let (w, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: loose.clone(),
            title: "Tidy".into(),
            text: "Tidy".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    let passed = spawn(
        &hub,
        &loose,
        serde_json::from_value(json!({ "workstreamId": w.workstream_id, "title": "tidy the readme", "prompt": "do it" }))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(passed.task.state, TaskState::Queued);
    assert!(
        next(&passed).contains("no repo bound; duplicate check skipped"),
        "{}",
        next(&passed)
    );
}

/// Reviews aren't work in flight of their own: a review of a PR another writer holds is never refused.
#[tokio::test]
async fn only_writers_are_checked() {
    let (hub, app, _web, _home) = hub();
    writer_of(&hub, &app, "dark mode toggle in settings");
    let review = spawn(
        &hub,
        &app,
        call(
            "dark mode toggle in settings",
            json!({ "kind": "review", "pr": "https://gitlab.example.com/acme/shop/-/merge_requests/3" }),
        ),
    )
    .await
    .unwrap();
    assert!(!next(&review).contains("elsewhere"), "{}", next(&review));
}

/// What a spawn declares is kept on the task: a later spawn in another project meets the first writer's files (as a
/// weak match) and its PR (as taken) before that writer has changed anything.
#[tokio::test]
async fn a_spawns_declared_paths_and_pr_are_matched_by_later_spawns() {
    let (hub, app, web, _home) = hub();
    let first = spawn(
        &hub,
        &web,
        call(
            "Theme tokens",
            json!({ "workstreamId": "W2", "paths": ["app/theme.ts"], "pr": MR }),
        ),
    )
    .await
    .unwrap();
    let kept: Vec<&str> = first
        .task
        .paths
        .iter()
        .flatten()
        .map(|p| p.as_str())
        .collect();
    assert_eq!(kept, ["app/theme.ts"]);

    let weak = spawn(
        &hub,
        &app,
        call(
            "Settings page layout",
            json!({ "paths": ["app/theme.ts", "app/settings.ts"] }),
        ),
    )
    .await
    .unwrap();
    assert!(
        next(&weak).contains(
            "elsewhere: T1 \"Theme tokens\" (queued, project web): same file app/theme.ts"
        ),
        "{}",
        next(&weak)
    );

    let taken = spawn(
        &hub,
        &app,
        call("Settle the review comments", json!({ "pr": MR })),
    )
    .await
    .unwrap_err();
    assert!(
        taken
            .message
            .starts_with("Taken: T1 \"Theme tokens\" (queued, project web): same !42"),
        "{}",
        taken.message
    );
}

/// A writer whose node can't say what it changed (here, no node is linked) is listed as "changes unknown" rather
/// than waited on.
#[tokio::test]
async fn a_writer_whose_node_does_not_answer_is_listed_as_changes_unknown() {
    let (hub, app, web, _home) = hub();
    let task: Task = serde_json::from_value(json!({
        "taskId": "T1", "projectRef": web, "workstreamId": "W2", "title": "billing invoice export to csv",
        "kind": "write", "prompt": "do it", "state": "running", "attempt": 1, "createdAt": AT,
        "threadRef": { "machineId": "laptop", "threadId": "th1" },
    }))
    .unwrap();
    hub.db.with(|c| Ok(TaskRecords::create(c, task)?)).unwrap();

    let passed = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        spawn(
            &hub,
            &app,
            call("Billing invoice email reminders", json!({})),
        ),
    )
    .await
    .expect("not held by the node")
    .unwrap();
    assert!(
        next(&passed).contains("elsewhere: T1 \"billing invoice export to csv\" (running, project web, changes unknown)"),
        "{}",
        next(&passed)
    );
}

/// A Navi works through its own tools and approvals: its lead can't start an agent that would run unasked.
#[tokio::test]
async fn a_navi_starts_no_agents_of_its_own() {
    let (hub, app, _web, _home) = hub();
    let by = fleetd_contracts::model::ProjectCreator {
        key_id: "k1".into(),
        name: "laptop".into(),
    };
    hub.db
        .with(|c| Ok(crate::hub::navi::store::put(c, &app, &by, None, 0)?))
        .unwrap();
    let refused = spawn(
        &hub,
        &app,
        call("Book the dentist", json!({ "kind": "read" })),
    )
    .await
    .unwrap_err();
    assert!(
        refused.message.contains("A Navi doesn't start agents"),
        "{}",
        refused.message
    );
    assert!(hub.tasks.list(&Default::default()).unwrap().is_empty());
}
