//! A project's repos over a real hub and a fake node (W79): a repo added by path and by clone, a project of its own
//! attached and archived, the list, attached checkouts left out of the projects list, the project's environment, MCP
//! servers and skills reaching every checkout, a removal that ends only that repo's tasks, and a deleted project's
//! repos going with it.
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::node_link::{
    CAP_PROJECT_ENV_COPY, CAP_PROJECT_SETTINGS, CAP_REPOS, HubToNode, NodeToHub,
};
use fleetd_contracts::repos::RepoName;
use fleetd_contracts::sessions::SessionCall;
use fleetd_contracts::tasks::{Task, TaskState};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, WaitInput};

const AT: &str = "2026-10-27T10:00:00.000Z";

fn devbox() -> MachineId {
    MachineId::unchecked("devbox")
}

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: devbox(),
        project_id: ProjectId::unchecked(id),
    }
}

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        ManualClock::at(1_792_922_400_000),
    )
    .unwrap();
    let machine = serde_json::from_value(json!({
        "machineId": "devbox", "name": "devbox", "tags": [], "status": "online", "lastSeenAt": AT, "nodeVersion": "0.1.0",
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, None).unwrap();
    (hub, home)
}

/// Links a node holding `app` (a plain folder at /work/app) and `shop` (a project of its own at /work/shop), with git
/// checkouts at /work/api and /work/shop and nothing at /work/web. It answers as a node of this version would: a
/// clone makes /work/web, a new or removed project shows in its machine stream before the call answers. Each call goes to the
/// test.
async fn node(hub: &Arc<Hub>) -> mpsc::UnboundedReceiver<SessionCall> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    hub.executors
        .attach(
            &devbox(),
            crate::hub::executor::NodeSessions {
                link_id: 1,
                send: tx,
            },
        )
        .await;
    let HubToNode::SessionCall(subscribe) = rx.recv().await.unwrap() else {
        panic!("not a subscribe")
    };
    let frame = |v: Value| {
        hub.executors
            .handle_frame(&devbox(), serde_json::from_value::<NodeToHub>(v).unwrap())
    };
    let info = |id: &str, title: &str, root: &str| json!({ "projectId": id, "title": title, "workspaceRoot": root, "updatedAt": AT });
    frame(
        json!({ "t": "machine_event", "seq": 1, "at": AT, "event": { "type": "snapshot",
        "projects": [info("app", "app", "/work/app"), info("shop", "shop", "/work/shop")], "sessions": [] } }),
    );
    frame(
        json!({ "t": "session_reply", "id": subscribe.id, "result": { "ok": { "kind": "done" } } }),
    );
    hub.executors.await_live(&devbox()).await;
    hub.link.set_capabilities(
        &devbox(),
        &[CAP_REPOS, CAP_PROJECT_SETTINGS, CAP_PROJECT_ENV_COPY],
    );
    let git = |remote: &str| {
        json!({ "ok": { "kind": "repo_facts", "exists": true, "isGit": true, "remote": remote,
            "defaultBranch": "main", "workflowFiles": [] } })
    };
    let (calls_tx, calls) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        let mut seq = 1;
        let mut cloned = false;
        while let Some(f) = rx.recv().await {
            let HubToNode::SessionCall(f) = f else {
                continue;
            };
            let result = match &f.call {
                SessionCall::RepoInspect { path } => match path.as_str() {
                    "/work/api" => git("https://github.com/acme/api.git"),
                    "/work/shop" => git("https://github.com/acme/shop.git"),
                    "/work/web" if cloned => git("https://github.com/acme/web.git"),
                    "/work/notes" => {
                        json!({ "ok": { "kind": "repo_facts", "exists": true, "isGit": false } })
                    }
                    _ => json!({ "ok": { "kind": "repo_facts", "exists": false, "isGit": false } }),
                },
                SessionCall::RepoClone { dest, .. } if dest.as_str() == "/work/web" => {
                    cloned = true;
                    git("https://github.com/acme/web.git")
                }
                SessionCall::ProjectUpsert {
                    project_id,
                    title,
                    workspace_root,
                } => {
                    seq += 1;
                    let event = json!({ "t": "machine_event", "seq": seq, "at": AT, "event": {
                        "type": "project_upserted", "projectId": project_id, "title": title,
                        "workspaceRoot": workspace_root, "updatedAt": AT } });
                    hub.executors.handle_frame(
                        &devbox(),
                        serde_json::from_value::<NodeToHub>(event).unwrap(),
                    );
                    json!({ "ok": { "kind": "done" } })
                }
                SessionCall::ProjectEnv { .. } => {
                    json!({ "ok": { "kind": "project_env", "secrets": [] } })
                }
                SessionCall::ProjectRemove { project_id, .. } => {
                    seq += 1;
                    let event = json!({ "t": "machine_event", "seq": seq, "at": AT, "event": {
                        "type": "project_removed", "projectId": project_id } });
                    hub.executors.handle_frame(
                        &devbox(),
                        serde_json::from_value::<NodeToHub>(event).unwrap(),
                    );
                    json!({ "ok": { "kind": "done" } })
                }
                _ => json!({ "ok": { "kind": "done" } }),
            };
            let reply = json!({ "t": "session_reply", "id": f.id, "result": result });
            hub.executors.handle_frame(
                &devbox(),
                serde_json::from_value::<NodeToHub>(reply).unwrap(),
            );
            let _ = calls_tx.send(f.call);
        }
    });
    calls
}

fn person() -> Caller {
    let c = serde_json::from_value::<Caller>(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "operate", "machines": "*" }],
    }))
    .unwrap();
    Caller {
        kind: Some(KeyKind::Human),
        ..c
    }
}

async fn call(hub: &Arc<Hub>, tool: &str, input: Value) -> Result<Value, CallError> {
    registry().call(hub, &person(), tool, input).await
}

fn refused(result: Result<Value, CallError>) -> String {
    let error = result.expect_err("refused");
    format!("{error:?}")
}

async fn names(hub: &Arc<Hub>, of: &str) -> Vec<String> {
    let listed = call(
        hub,
        "project_repo_list",
        json!({ "machineId": "devbox", "projectId": of }),
    )
    .await
    .unwrap();
    listed["repos"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap().to_owned())
        .collect()
}

fn shown(hub: &Hub) -> Vec<String> {
    let mut ids: Vec<String> = hub
        .store
        .projects_shown(None, None)
        .unwrap()
        .into_iter()
        .map(|p| p.project_id.to_string())
        .collect();
    ids.sort();
    ids
}

fn drain(calls: &mut mpsc::UnboundedReceiver<SessionCall>) -> Vec<SessionCall> {
    let mut out = Vec::new();
    while let Ok(c) = calls.try_recv() {
        out.push(c);
    }
    out
}

/// A plain folder takes its first repo by path: the checkout is registered on the node, gets the project's
/// environment, and stops showing as a project of its own; the list and the lead's first message name it.
#[tokio::test]
async fn a_plain_folder_takes_a_repo_by_path_and_its_checkout_leaves_the_projects_list() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    assert_eq!(names(&hub, "app").await, Vec::<String>::new());

    let out = call(
        &hub,
        "project_repo_add",
        json!({ "machineId": "devbox", "projectId": "app", "path": "/work/api/" }),
    )
    .await
    .unwrap();
    let repo = &out["repo"];
    assert_eq!(repo["name"], "api");
    assert_eq!(repo["path"], "/work/api");
    assert_eq!(repo["repoKey"], "github.com/acme/api");
    assert_eq!(repo["base"], "main");
    assert_eq!(out.get("archived"), None);
    let checkout = repo["checkout"]["projectId"].as_str().unwrap().to_owned();
    assert_ne!(checkout, "app");

    let sent = drain(&mut calls);
    assert!(sent.iter().any(
        |c| matches!(c, SessionCall::ProjectUpsert { project_id, workspace_root, .. }
        if project_id.as_str() == checkout && workspace_root.as_str() == "/work/api")
    ));
    assert!(
        sent.iter()
            .any(|c| matches!(c, SessionCall::ProjectEnvCopy { from, to }
        if from.as_str() == "app" && to.as_str() == checkout))
    );

    assert_eq!(names(&hub, "app").await, ["api"]);
    // The node has the checkout as a project; only the hub's own bookkeeping sees it.
    assert_eq!(shown(&hub), ["app", "shop"]);
    assert_eq!(hub.store.projects_list(None, None).unwrap().len(), 3);
    let listed = call(&hub, "project_get", json!({ "machineId": "devbox" }))
        .await
        .unwrap();
    assert_eq!(listed["projects"].as_array().unwrap().len(), 2);
    let summary = hub.store.project_get(&project("app")).unwrap().unwrap();
    assert_eq!(summary.repos[0].path.as_deref(), Some("/work/api"));
    let block = crate::hub::leads::prompt::repos_block(&project("app"), &summary.repos).unwrap();
    assert!(
        block.contains("- `api`: /work/api, github.com/acme/api on main"),
        "{block}"
    );

    // The project's event says the repo was added to it.
    let added = hub
        .events
        .page(0, Some(&[HubEventType::ProjectAdded]), None)
        .unwrap()
        .events;
    assert_eq!(
        added.last().unwrap().project_id,
        Some(ProjectId::unchecked("app"))
    );

    // The same checkout again, a name taken, a plain folder and the project's own directory are refused.
    let again = json!({ "machineId": "devbox", "projectId": "app", "path": "/work/api" });
    assert!(
        refused(call(&hub, "project_repo_add", again).await)
            .contains("already the project's repo api")
    );
    let taken =
        json!({ "machineId": "devbox", "projectId": "app", "path": "/work/shop", "name": "api" });
    assert!(
        refused(call(&hub, "project_repo_add", taken).await)
            .contains("already has a repo named api")
    );
    let plain = json!({ "machineId": "devbox", "projectId": "app", "path": "/work/notes" });
    assert!(refused(call(&hub, "project_repo_add", plain).await).contains("not a git repository"));
    let own = json!({ "machineId": "devbox", "projectId": "app", "path": "/work/app" });
    assert!(
        refused(call(&hub, "project_repo_add", own).await).contains("the project's own directory")
    );
}

/// A GitHub repo is cloned onto the project's machine and added once the clone ends, with progress on the add id.
#[tokio::test]
async fn a_repo_added_by_clone_lands_when_the_clone_ends() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    let out = call(
        &hub,
        "project_repo_add",
        json!({ "machineId": "devbox", "projectId": "app", "url": "acme/web", "dest": "/work/web", "name": "front" }),
    )
    .await
    .unwrap();
    let add_id = out["addId"].as_str().unwrap().to_owned();
    assert_eq!(out.get("repo"), None);
    let mut cursor = 0;
    let added =
        loop {
            let page = hub
                .events
                .wait(WaitInput {
                    cursor: Some(cursor),
                    types: Some(vec![
                        HubEventType::ProjectAdded,
                        HubEventType::ProjectAddFailed,
                    ]),
                    machine_id: None,
                    timeout_sec: 10,
                })
                .await
                .unwrap();
            cursor = page.cursor;
            if let Some(e) = page.events.into_iter().find(|e| {
                e.data.as_ref().and_then(|d| d["addId"].as_str()) == Some(add_id.as_str())
            }) {
                break e;
            }
        };
    assert_eq!(added.r#type, HubEventType::ProjectAdded, "{added:?}");
    assert_eq!(added.project_id, Some(ProjectId::unchecked("app")));
    assert!(drain(&mut calls).iter().any(
        |c| matches!(c, SessionCall::RepoClone { url, dest, .. } if url.as_str() == "https://github.com/acme/web" && dest.as_str() == "/work/web")
    ));
    assert_eq!(names(&hub, "app").await, ["front"]);
    let repos = hub.repos.repos_of(&project("app")).unwrap();
    assert_eq!(
        repos[0].repo_key.as_ref().map(|k| k.as_str()),
        Some("github.com/acme/web")
    );
    assert_eq!(shown(&hub), ["app", "shop"]);
}

/// A live task the queue leaves alone: idle, its turn over.
fn idle(hub: &Hub, of: &str, repo: Option<&str>) -> Task {
    let mut task = json!({
        "taskId": "T1", "projectRef": { "machineId": "devbox", "projectId": of }, "workstreamId": "W1",
        "title": "write it", "kind": "write", "prompt": "do it", "state": "idle", "attempt": 1, "createdAt": AT,
    });
    if let Some(repo) = repo {
        task["repoId"] = repo.into();
    }
    let task: Task = serde_json::from_value(task).unwrap();
    hub.db
        .with(|c| Ok(crate::hub::tasks::records::TaskRecords::create(c, task)?))
        .unwrap()
}

fn state(hub: &Hub, task: &Task) -> TaskState {
    hub.tasks.get(&task.task_id).unwrap().unwrap().state
}

/// A directory that is a project of its own is archived as it is attached: it leaves the projects list, keeps its
/// history, its lead's session stops, and its lead, chat and spawns are refused from then on, as is a repo for it; it is
/// refused while its agents run.
#[tokio::test]
async fn attaching_a_project_of_its_own_archives_it_read_only() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    // shop has a lead, running in its session on the node.
    hub.leads
        .records
        .lead_put(&crate::hub::leads::records::StoredLead {
            project_ref: project("shop"),
            thread_id: fleetd_contracts::ids::ThreadId::unchecked("shop-lead"),
            started_at: AT.to_owned().into(),
            last_wake_at: None,
            session_generation: 0,
        })
        .unwrap();
    let busy = idle(&hub, "shop", None);
    let add = json!({ "machineId": "devbox", "projectId": "app", "path": "/work/shop" });
    assert!(
        refused(call(&hub, "project_repo_add", add.clone()).await).contains("its agents still run")
    );
    hub.db
        .with(|c| {
            Ok(c.execute(
                "UPDATE tasks SET state = 'cancelled', data = json_set(data, '$.state', 'cancelled')",
                [],
            )?)
        })
        .unwrap();
    assert_eq!(state(&hub, &busy), TaskState::Cancelled);

    let out = call(&hub, "project_repo_add", add).await.unwrap();
    assert_eq!(
        out["archived"],
        json!({ "machineId": "devbox", "projectId": "shop" })
    );
    assert_eq!(out["repo"]["name"], "shop");
    assert_eq!(out["repo"]["checkout"]["projectId"], "shop");
    assert_eq!(shown(&hub), ["app"]);
    // Its lead's session is stopped, and its lead is refused from now on, record and all.
    assert!(drain(&mut calls).iter().any(
        |c| matches!(c, SessionCall::Stop { session_id, .. } if session_id.as_str() == "shop-lead")
    ));
    assert!(
        hub.leads
            .records
            .lead_get(&project("shop"))
            .unwrap()
            .is_some()
    );
    // Its own record stays readable.
    assert!(hub.store.project_get(&project("shop")).unwrap().is_some());

    let message = json!({ "projectRef": { "machineId": "devbox", "projectId": "shop" }, "text": "hello",
        "clientRequestId": "c1" });
    let spawn: crate::hub::tasks::SpawnInput = serde_json::from_value(json!({
        "workstreamId": "W1", "title": "write it", "kind": "write", "prompt": "do it", "serves": "done:0",
    }))
    .unwrap();
    let as_lead = crate::hub::tasks::TaskCaller {
        project_ref: project("shop"),
        by: "lead:devbox/shop".into(),
    };
    assert!(
        hub.tasks
            .spawn(&as_lead, spawn)
            .await
            .unwrap_err()
            .message
            .contains("archived")
    );
    assert!(refused(call(&hub, "chat_send", message).await).contains("archived"));
    let more = json!({ "machineId": "devbox", "projectId": "shop", "path": "/work/api" });
    assert!(refused(call(&hub, "project_repo_add", more).await).contains("archived"));
    assert!(
        hub.leads
            .leads
            .start(&project("shop"))
            .await
            .unwrap_err()
            .message
            .contains("archived")
    );
}

/// An automation run on an archived project opens its order but reaches no lead: the old lead record stays, and nothing
/// starts or resumes it.
#[tokio::test]
async fn an_automation_run_on_an_archived_project_reaches_no_lead() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    hub.leads
        .records
        .lead_put(&crate::hub::leads::records::StoredLead {
            project_ref: project("shop"),
            thread_id: fleetd_contracts::ids::ThreadId::unchecked("shop-lead"),
            started_at: AT.to_owned().into(),
            last_wake_at: None,
            session_generation: 0,
        })
        .unwrap();
    call(
        &hub,
        "project_repo_add",
        json!({ "machineId": "devbox", "projectId": "app", "path": "/work/shop" }),
    )
    .await
    .unwrap();
    let made = call(
        &hub,
        "automation_create",
        json!({ "projectRef": { "machineId": "devbox", "projectId": "shop" }, "name": "Nightly",
            "prompt": "Check the shop.", "clientRequestId": "a1" }),
    )
    .await
    .unwrap();
    drain(&mut calls);
    call(
        &hub,
        "automation_run",
        json!({ "automationId": made["automation"]["automationId"] }),
    )
    .await
    .unwrap();
    let ran = hub
        .events
        .page(0, Some(&[HubEventType::AutomationRun]), None)
        .unwrap()
        .events;
    let summary = &ran.last().unwrap().summary;
    assert!(
        summary.contains("it waits for the lead: This project is archived"),
        "{summary}"
    );
    // No turn went to the old lead's session, and no new one started.
    assert!(
        !drain(&mut calls)
            .iter()
            .any(|c| matches!(c, SessionCall::Send { .. } | SessionCall::Launch(_))),
    );
    let held = hub
        .leads
        .leads
        .auto_start(&project("shop"), Some("hello"))
        .await;
    assert!(
        matches!(held, crate::hub::leads::lead::AutoStart::Held(e) if e.message.contains("archived"))
    );
}

/// A steer at an archived project's order gives its stopped lead no turn: refused with why, and any send to that lead
/// (a steer queued before, a wake, the write queue) is refused where it goes out to the node.
#[tokio::test]
async fn a_steer_at_an_archived_projects_order_reaches_no_lead() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    hub.leads
        .records
        .lead_put(&crate::hub::leads::records::StoredLead {
            project_ref: project("shop"),
            thread_id: fleetd_contracts::ids::ThreadId::unchecked("shop-lead"),
            started_at: AT.to_owned().into(),
            last_wake_at: None,
            session_generation: 0,
        })
        .unwrap();
    let (order, _) = hub
        .leads
        .records
        .workstream_create(crate::hub::leads::records::NewWorkstream {
            project_ref: project("shop"),
            title: "Ship the cart".into(),
            text: "Ship the cart".into(),
            channel: fleetd_contracts::ledger::IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    call(
        &hub,
        "project_repo_add",
        json!({ "machineId": "devbox", "projectId": "app", "path": "/work/shop" }),
    )
    .await
    .unwrap();
    drain(&mut calls);
    let steered = call(
        &hub,
        "steer_send",
        json!({ "target": { "workstreamId": order.workstream_id }, "text": "skip the review", "clientRequestId": "s1" }),
    )
    .await;
    let sent = drain(&mut calls);
    assert!(
        !sent.iter().any(|c| matches!(c, SessionCall::Send { .. })),
        "{steered:?} {sent:?}"
    );
    assert!(refused(steered).contains("archived"));
    // The same holds for any send to that thread, whichever path it takes.
    let thread = fleetd_contracts::ids::ThreadRef {
        machine_id: devbox(),
        thread_id: fleetd_contracts::ids::ThreadId::unchecked("shop-lead"),
    };
    let error = hub
        .executors
        .send(&thread, "hello", "c1")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("archived"), "{error}");
    assert!(drain(&mut calls).is_empty());
}

/// Removing a repo ends that repo's live tasks only, deletes nothing, and the checkout no project holds shows as its
/// own project again. The project's own repo can't be removed.
#[tokio::test]
async fn removing_a_repo_ends_only_its_tasks() {
    let (hub, _home) = hub();
    let _calls = node(&hub).await;
    call(
        &hub,
        "project_repo_add",
        json!({ "machineId": "devbox", "projectId": "app", "path": "/work/api" }),
    )
    .await
    .unwrap();
    let shop = call(
        &hub,
        "project_repo_add",
        json!({ "machineId": "devbox", "projectId": "app", "path": "/work/shop" }),
    )
    .await
    .unwrap();
    let [api, _] = hub
        .repos
        .repos_of(&project("app"))
        .unwrap()
        .try_into()
        .unwrap();
    let in_api = idle(&hub, "app", Some(api.repo_id.as_str()));
    let in_shop = idle(&hub, "app", shop["repo"]["repoId"].as_str());
    let in_folder = idle(&hub, "app", None);

    let out = call(
        &hub,
        "project_repo_remove",
        json!({ "machineId": "devbox", "projectId": "app", "name": "api" }),
    )
    .await
    .unwrap();
    assert_eq!(out["removed"]["name"], "api");
    assert_eq!(out["cancelled"], json!([in_api.task_id]));
    assert!(out["next"].as_str().unwrap().contains("stays at /work/api"));
    assert_eq!(state(&hub, &in_api), TaskState::Cancelled);
    assert_eq!(state(&hub, &in_shop), TaskState::Idle);
    assert_eq!(state(&hub, &in_folder), TaskState::Idle);
    assert_eq!(names(&hub, "app").await, ["shop"]);
    // No project holds the api checkout now: it is a project of its own again.
    assert_eq!(shown(&hub).len(), 2);
    assert!(shown(&hub).contains(&api.checkout.project_id.to_string()));

    let unknown = json!({ "machineId": "devbox", "projectId": "app", "name": "api" });
    assert!(refused(call(&hub, "project_repo_remove", unknown).await).contains("shop"));
    let own = json!({ "machineId": "devbox", "projectId": "shop", "name": "shop" });
    assert!(refused(call(&hub, "project_repo_remove", own).await).contains("archived"));
}

/// The project's variables, MCP servers and skills reach the checkouts of its repos.
#[tokio::test]
async fn the_projects_env_mcp_servers_and_skills_reach_every_checkout() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    let out = call(
        &hub,
        "project_repo_add",
        json!({ "machineId": "devbox", "projectId": "app", "path": "/work/api" }),
    )
    .await
    .unwrap();
    let checkout = out["repo"]["checkout"]["projectId"]
        .as_str()
        .unwrap()
        .to_owned();
    drain(&mut calls);

    call(
        &hub,
        "project_env_set",
        json!({ "machineId": "devbox", "projectId": "app",
            "set": [{ "kind": "plain", "name": "REGISTRY", "value": "https://npm.devbox.test" }] }),
    )
    .await
    .unwrap();
    let to: Vec<String> = drain(&mut calls)
        .into_iter()
        .filter_map(|c| match c {
            SessionCall::ProjectEnv { project_id, .. } => Some(project_id.to_string()),
            _ => None,
        })
        .collect();
    assert_eq!(to, ["app".to_owned(), checkout.clone()]);

    let server: fleetd_contracts::mcp_servers::McpServer = serde_json::from_value(json!({
        "scope": { "kind": "project", "machineId": "devbox", "projectId": "app" }, "name": "docs", "enabled": true,
        "roles": { "lead": true, "writers": true, "reviewers": true },
        "transport": { "type": "http", "url": "https://docs.devbox.test/mcp" }, "updatedAt": AT,
    }))
    .unwrap();
    hub.db.mcp_servers().put(&server).unwrap();
    let names = hub
        .db
        .mcp_servers()
        .session_config(&project(&checkout))
        .unwrap()
        .servers
        .into_iter()
        .map(|s| s.name.to_string())
        .collect::<Vec<_>>();
    assert_eq!(names, ["docs"]);

    // A skill kept for the project rides on a launch in its repo's checkout, over the checkout's own of that name.
    let skill = |says: &str| format!("---\nname: release\ndescription: {says}\n---\n\n# release\n");
    let release = fleetd_contracts::skills::SkillName::new("release").unwrap();
    let skills = hub.db.skills();
    for (of, says) in [
        ("app", "the project's"),
        (checkout.as_str(), "the checkout's"),
    ] {
        skills
            .set(
                fleetd_contracts::skills::SkillScope::Project,
                Some(&project(of)),
                &release,
                &skill(says),
                true,
                &crate::hub::skills::Who::person("test", None, 0),
            )
            .unwrap();
    }
    let bundles = hub
        .executors
        .skill_bundles(&devbox(), &ProjectId::unchecked(&checkout));
    assert_eq!(bundles.len(), 1);
    assert!(bundles[0].files[0].text.contains("the project's"));
}

/// The projects the node was asked to remove, each with `removeWorktrees`.
fn removed(calls: &mut mpsc::UnboundedReceiver<SessionCall>) -> Vec<(String, bool)> {
    drain(calls)
        .into_iter()
        .filter_map(|c| match c {
            SessionCall::ProjectRemove {
                project_id,
                remove_worktrees,
            } => Some((project_id.to_string(), remove_worktrees)),
            _ => None,
        })
        .collect()
}

/// Deleting a project with several repos removes their checkouts from the node with it, the way the project itself
/// goes: none shows as a project of its own afterwards, the one archived when it was added included.
#[tokio::test]
async fn removing_a_project_removes_the_checkouts_of_its_repos() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    for path in ["/work/api", "/work/shop"] {
        call(
            &hub,
            "project_repo_add",
            json!({ "machineId": "devbox", "projectId": "app", "path": path }),
        )
        .await
        .unwrap();
    }
    let api = hub
        .repos
        .repo_by_name(&project("app"), &RepoName::new("api").unwrap())
        .unwrap()
        .unwrap()
        .checkout
        .project_id
        .to_string();
    assert_eq!(names(&hub, "app").await, ["api", "shop"]);
    assert_eq!(shown(&hub), ["app"]);
    drain(&mut calls);

    call(
        &hub,
        "project_remove",
        json!({ "machineId": "devbox", "projectId": "app", "removeWorktrees": true }),
    )
    .await
    .unwrap();
    assert_eq!(shown(&hub), Vec::<String>::new());
    assert!(hub.store.projects_list(None, None).unwrap().is_empty());
    assert_eq!(
        removed(&mut calls),
        [("app".into(), true), (api, true), ("shop".into(), true)]
    );
}

/// A project with no repo but its own goes alone, as before; a checkout another project also holds stays with it.
#[tokio::test]
async fn removing_a_project_leaves_a_checkout_another_project_holds() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    for project_id in ["shop", "app"] {
        call(
            &hub,
            "project_repo_add",
            json!({ "machineId": "devbox", "projectId": project_id, "path": "/work/api" }),
        )
        .await
        .unwrap();
    }
    drain(&mut calls);

    call(
        &hub,
        "project_remove",
        json!({ "machineId": "devbox", "projectId": "app" }),
    )
    .await
    .unwrap();
    assert_eq!(removed(&mut calls), [("app".into(), false)]);
    assert_eq!(shown(&hub), ["shop"]);
    assert_eq!(names(&hub, "shop").await, ["api"]);

    let (hub, _home) = self::hub();
    let mut calls = node(&hub).await;
    call(
        &hub,
        "project_remove",
        json!({ "machineId": "devbox", "projectId": "shop" }),
    )
    .await
    .unwrap();
    assert_eq!(removed(&mut calls), [("shop".into(), false)]);
    assert_eq!(shown(&hub), ["app"]);
}
