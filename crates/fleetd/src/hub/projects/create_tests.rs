//! A new, empty project over a real hub and a fake node (W123): `project_add` with `create` has the node make its
//! folder (under `projectsRoot` by default, or where it is told), adds it as a plain folder with no repo, and runs git
//! init only when asked; a folder holding files, a node too old to make one and inputs that mix modes are refused,
//! and nothing is registered for them.
use std::collections::BTreeMap;
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::node_link::{CAP_FOLDER_MAKE, CAP_REPOS, HubToNode, NodeToHub};
use fleetd_contracts::sessions::SessionCall;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, WaitInput};

const AT: &str = "2026-10-27T10:00:00.000Z";
const ROOT: &str = "/home/me/fleetd/projects";

fn devbox() -> MachineId {
    MachineId::unchecked("devbox")
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

/// Links a node that lists `capabilities` and answers as a node of this version would: its projects root is
/// /home/me/fleetd/projects, where `full` already holds files; a folder it makes is there after (a git checkout when
/// it ran git init), and a new project shows in its machine stream. Each call goes to the test.
async fn node(hub: &Arc<Hub>, capabilities: &[&str]) -> mpsc::UnboundedReceiver<SessionCall> {
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
    frame(
        json!({ "t": "machine_event", "seq": 1, "at": AT, "event": { "type": "snapshot",
        "projects": [], "sessions": [] } }),
    );
    frame(
        json!({ "t": "session_reply", "id": subscribe.id, "result": { "ok": { "kind": "done" } } }),
    );
    hub.executors.await_live(&devbox()).await;
    hub.link.set_capabilities(&devbox(), capabilities);
    let (calls_tx, calls) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        let mut seq = 1;
        // Each folder made, and whether git init ran in it.
        let mut made: BTreeMap<String, bool> = BTreeMap::new();
        while let Some(f) = rx.recv().await {
            let HubToNode::SessionCall(f) = f else {
                continue;
            };
            let result = match &f.call {
                SessionCall::RepoScan => {
                    json!({ "ok": { "kind": "repos", "cloneRoot": "/home/me/src", "repos": [], "projectsRoot": ROOT } })
                }
                SessionCall::FolderMake { path, .. } if path.as_str() == format!("{ROOT}/full") => {
                    json!({ "err": { "code": "invalid", "message": format!("folder not empty: {path}") } })
                }
                SessionCall::FolderMake {
                    path,
                    git_init,
                    dry_run,
                } => {
                    if !dry_run {
                        made.insert(path.to_string(), *git_init);
                    }
                    json!({ "ok": { "kind": "folder", "path": path } })
                }
                SessionCall::RepoInspect { path } => match made.get(path.as_str()) {
                    Some(true) => {
                        json!({ "ok": { "kind": "repo_facts", "exists": true, "isGit": true,
                        "workflowFiles": [] } })
                    }
                    Some(false) => {
                        json!({ "ok": { "kind": "repo_facts", "exists": true, "isGit": false } })
                    }
                    None => {
                        json!({ "ok": { "kind": "repo_facts", "exists": false, "isGit": false } })
                    }
                },
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
        "keyId": "k1", "name": "laptop", "prefix": "fld_abcdef", "createdAt": AT,
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

async fn ok(hub: &Arc<Hub>, tool: &str, input: Value) -> Value {
    match call(hub, tool, input).await {
        Ok(v) => v,
        Err(e) => panic!("{tool}: {e:?}"),
    }
}

/// A `folder_make`: its path, gitInit and dryRun.
type Made = (String, bool, bool);

/// The node calls so far that make a folder, and register a project, `(title, root)`.
fn drain(calls: &mut mpsc::UnboundedReceiver<SessionCall>) -> (Vec<Made>, Vec<(String, String)>) {
    let (mut folders, mut upserts) = (vec![], vec![]);
    while let Ok(c) = calls.try_recv() {
        match c {
            SessionCall::FolderMake {
                path,
                git_init,
                dry_run,
            } => folders.push((path.to_string(), git_init, dry_run)),
            SessionCall::ProjectUpsert {
                title,
                workspace_root,
                ..
            } => upserts.push((title.to_string(), workspace_root.to_string())),
            _ => {}
        }
    }
    (folders, upserts)
}

fn project(added: &Value) -> ProjectRef {
    ProjectRef {
        machine_id: devbox(),
        project_id: ProjectId::unchecked(added["projectId"].as_str().unwrap()),
    }
}

#[tokio::test]
async fn a_new_project_gets_a_folder_under_the_projects_root_and_no_repo() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, &[CAP_REPOS, CAP_FOLDER_MAKE]).await;
    let discovered = ok(&hub, "project_discover", json!({ "github": false })).await;
    assert_eq!(discovered["machines"][0]["projectsRoot"], ROOT);
    let added = ok(
        &hub,
        "project_add",
        json!({ "machineId": "devbox", "create": true, "title": "Field Notes" }),
    )
    .await;
    let path = format!("{ROOT}/field-notes");
    assert_eq!(
        (&added["path"], &added["created"]),
        (&json!(path), &json!(true))
    );
    assert_eq!(
        added["inspect"]["leadNeeds"],
        crate::hub::projects::inspect::FOLDER_NEEDS
    );
    assert!(added["next"].as_str().unwrap().contains("project_repo_add"));
    let (folders, upserts) = drain(&mut calls);
    assert_eq!(folders, [(path.clone(), false, false)]);
    assert_eq!(upserts, [("Field Notes".to_owned(), path.clone())]);
    // A plain folder: no repo of its own, and the project shows with none.
    let r = project(&added);
    assert!(hub.repos.repos_of(&r).unwrap().is_empty());
    let listed = hub.store.project_get(&r).unwrap().unwrap();
    assert_eq!(
        (listed.title.as_str(), listed.repos.len()),
        ("Field Notes", 0)
    );
    let events = hub
        .events
        .wait(WaitInput {
            cursor: Some(0),
            types: Some(vec![HubEventType::ProjectAdded]),
            machine_id: None,
            timeout_sec: 1,
        })
        .await
        .unwrap();
    let event = events.events.last().unwrap();
    assert_eq!(event.data.as_ref().unwrap()["path"], json!(path));
    assert_eq!(event.data.as_ref().unwrap()["created"], true);
}

#[tokio::test]
async fn a_folder_given_is_made_there_and_git_init_runs_only_when_asked() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, &[CAP_REPOS, CAP_FOLDER_MAKE]).await;
    // A dry run says where it would go and makes nothing.
    let dry = ok(
        &hub,
        "project_add",
        json!({ "machineId": "devbox", "create": true, "title": "Site", "dryRun": true }),
    )
    .await;
    assert_eq!(dry["path"], format!("{ROOT}/site"));
    assert!(dry.get("projectId").is_none());
    let (folders, upserts) = drain(&mut calls);
    assert_eq!(folders, [(format!("{ROOT}/site"), false, true)]);
    assert!(upserts.is_empty());
    // An empty folder is fine; with gitInit the project holds its own repo, with no remote yet.
    let added = ok(
        &hub,
        "project_add",
        json!({ "machineId": "devbox", "create": true, "path": "/home/me/work/site/", "gitInit": true }),
    )
    .await;
    assert_eq!(added["path"], "/home/me/work/site");
    let (folders, upserts) = drain(&mut calls);
    assert_eq!(folders, [("/home/me/work/site".to_owned(), true, false)]);
    // No title: the folder's name.
    assert_eq!(
        upserts,
        [("site".to_owned(), "/home/me/work/site".to_owned())]
    );
    assert!(
        added["inspect"]["leadNeeds"]
            .as_str()
            .unwrap()
            .starts_with("no GitHub remote")
    );
    assert_eq!(hub.repos.repos_of(&project(&added)).unwrap().len(), 1);
    // A name with nothing to keep still gets a folder.
    let added = ok(
        &hub,
        "project_add",
        json!({ "create": true, "title": "✨" }),
    )
    .await;
    assert_eq!(added["path"], format!("{ROOT}/project"));
}

#[tokio::test]
async fn a_folder_holding_files_is_refused_and_nothing_is_added() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, &[CAP_REPOS, CAP_FOLDER_MAKE]).await;
    let Err(CallError::Tool(e)) = call(
        &hub,
        "project_add",
        json!({ "machineId": "devbox", "create": true, "title": "Full" }),
    )
    .await
    else {
        panic!("took over a folder holding files")
    };
    assert_eq!(
        e.message,
        format!("{ROOT}/full on devbox already holds files")
    );
    assert!(e.fix.unwrap().contains("another folder"));
    let (_, upserts) = drain(&mut calls);
    assert!(upserts.is_empty());
    assert!(
        hub.store
            .projects_list(Some(&devbox()), None)
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_node_too_old_to_make_a_folder_is_told_to_update() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, &[CAP_REPOS]).await;
    let Err(CallError::Tool(e)) = call(
        &hub,
        "project_add",
        json!({ "machineId": "devbox", "create": true, "title": "Notes" }),
    )
    .await
    else {
        panic!("asked an older node to make a folder")
    };
    assert!(e.fix.unwrap().contains("fleetd update on devbox"));
    let (folders, _) = drain(&mut calls);
    assert!(folders.is_empty());
}

#[tokio::test]
async fn create_takes_a_name_or_a_folder_and_nothing_of_a_clone() {
    let (hub, _home) = hub();
    let _calls = node(&hub, &[CAP_REPOS, CAP_FOLDER_MAKE]).await;
    for input in [
        json!({ "create": true }),
        json!({ "create": true, "title": "x", "url": "acme/x" }),
        json!({ "create": true, "title": "x", "useExisting": true }),
        json!({ "path": "/home/me/x", "gitInit": true }),
    ] {
        assert!(
            call(&hub, "project_add", input.clone()).await.is_err(),
            "{input}"
        );
    }
}
