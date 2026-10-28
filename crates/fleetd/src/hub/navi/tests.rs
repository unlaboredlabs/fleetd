//! Navis over a real hub and a fake node: several made from one key, each a plain folder under the node's home and a
//! project of kind assistant; renamed, archived and brought back; refused on a node too old to hold one. A project of
//! code next to them stays as it was. Also `project_add` of any plain folder with no git, the same slice.
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::node_link::{CAP_ASSISTANT, CAP_REPOS, HubToNode, NodeToHub};
use fleetd_contracts::sessions::SessionCall;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-27T10:00:00.000Z";
const HOME: &str = "/home/me/.fleetd/node";

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
        ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    let machine = serde_json::from_value(json!({
        "machineId": "devbox", "name": "devbox", "tags": [], "status": "online", "lastSeenAt": AT,
        "nodeVersion": "0.1.0",
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, None).unwrap();
    (hub, home)
}

/// Links a node holding one project of code, p1, that lists `capabilities` and answers as a node of this version: a
/// relative project root is a folder under its home. Hands each call to the test.
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
    let project =
        json!({ "projectId": "p1", "title": "app", "workspaceRoot": "/work/app", "updatedAt": AT });
    frame(
        json!({ "t": "machine_event", "seq": 1, "at": AT, "event": { "type": "snapshot",
        "projects": [project], "sessions": [] } }),
    );
    frame(
        json!({ "t": "session_reply", "id": subscribe.id, "result": { "ok": { "kind": "done" } } }),
    );
    hub.executors.await_live(&devbox()).await;
    hub.link.set_capabilities(&devbox(), capabilities);
    let (calls_tx, calls) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let result = match &f.call {
                // A folder a removed Navi left behind.
                SessionCall::ProjectUpsert { workspace_root, .. }
                    if workspace_root.as_str() == "navi/old" =>
                {
                    json!({ "err": { "code": "invalid", "message": format!("folder taken: {HOME}/navi/old") } })
                }
                SessionCall::ProjectUpsert { workspace_root, .. }
                    if !workspace_root.starts_with('/') =>
                {
                    json!({ "ok": { "kind": "folder", "path": format!("{HOME}/{workspace_root}") } })
                }
                // Every other path is a plain folder with no git.
                SessionCall::RepoInspect { .. } => {
                    json!({ "ok": { "kind": "repo_facts", "exists": true, "isGit": false } })
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

fn names(listed: &Value) -> Vec<String> {
    listed["navis"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["title"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_person_makes_several_navis_each_a_plain_folder_and_an_assistant_project() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    assert_eq!(
        ok(&hub, "navi_list", json!({})).await["next"],
        "No Navis yet: navi_create makes one."
    );
    let mut made = vec![];
    for name in ["Ada", "Home & family", "Ada"] {
        made.push(ok(&hub, "navi_create", json!({ "name": name })).await["navi"].clone());
    }
    let roots: Vec<&str> = made
        .iter()
        .map(|n| n["workspaceRoot"].as_str().unwrap())
        .collect();
    assert_eq!(
        roots,
        [
            format!("{HOME}/navi/ada"),
            format!("{HOME}/navi/home-family"),
            format!("{HOME}/navi/ada-2"),
        ]
    );
    for navi in &made {
        assert_eq!(navi["kind"], "assistant");
        assert_eq!(navi["machineId"], "devbox");
        assert_eq!(
            navi["createdBy"],
            json!({ "keyId": "k1", "name": "laptop" })
        );
        // A plain folder: no repo.
        assert!(navi.get("repos").is_none() && navi.get("archivedAt").is_none());
    }
    // Each its own project, so its own chat, memory and lead.
    let ids: std::collections::BTreeSet<&str> = made
        .iter()
        .map(|n| n["projectId"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 3);
    // The node was asked for each folder by its relative root.
    let mut asked = vec![];
    while let Ok(c) = calls.try_recv() {
        if let SessionCall::ProjectUpsert { workspace_root, .. } = c {
            asked.push(workspace_root.to_string());
        }
    }
    assert_eq!(asked, ["navi/ada", "navi/home-family", "navi/ada-2"]);
    let listed = ok(&hub, "navi_list", json!({})).await;
    assert_eq!(names(&listed), ["Ada", "Home & family", "Ada"]);

    // The project of code beside them is as it was: no kind, no creator.
    let p1 = hub
        .store
        .project_get(&ProjectRef {
            machine_id: devbox(),
            project_id: ProjectId::unchecked("p1"),
        })
        .unwrap()
        .unwrap();
    assert_eq!((p1.kind, p1.created_by, p1.archived_at), (None, None, None));
    let all = ok(&hub, "project_get", json!({})).await;
    let p1 = all["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["projectId"] == "p1")
        .unwrap()
        .clone();
    assert!(p1.get("kind").is_none() && p1.get("createdBy").is_none());
}

#[tokio::test]
async fn a_navi_is_renamed_archived_and_brought_back() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    let navi = ok(&hub, "navi_create", json!({ "name": "Ada" })).await["navi"].clone();
    let id = navi["projectId"].clone();
    let at = json!({ "machineId": "devbox", "projectId": id });
    while calls.try_recv().is_ok() {}

    let renamed = ok(
        &hub,
        "navi_rename",
        json!({ "machineId": "devbox", "projectId": id, "name": "Grace" }),
    )
    .await;
    assert_eq!(renamed["navi"]["title"], "Grace");
    // Renamed on the node in place: the folder keeps its name.
    let Some(SessionCall::ProjectUpsert {
        title,
        workspace_root,
        ..
    }) = calls.recv().await
    else {
        panic!("no rename on the node")
    };
    assert_eq!(
        (title.as_str(), workspace_root.as_str()),
        ("Grace", format!("{HOME}/navi/ada").as_str())
    );

    let archived = ok(&hub, "navi_archive", at.clone()).await;
    assert!(archived["navi"]["archivedAt"].is_string());
    assert!(names(&ok(&hub, "navi_list", json!({})).await).is_empty());
    assert_eq!(
        names(&ok(&hub, "navi_list", json!({ "archived": true })).await),
        ["Grace"]
    );
    let back = ok(
        &hub,
        "navi_archive",
        json!({ "machineId": "devbox", "projectId": id, "archived": false }),
    )
    .await;
    assert!(back["navi"].get("archivedAt").is_none());
    assert_eq!(names(&ok(&hub, "navi_list", json!({})).await), ["Grace"]);

    // A project of code is not a Navi.
    let Err(CallError::Tool(e)) = call(
        &hub,
        "navi_archive",
        json!({ "machineId": "devbox", "projectId": "p1" }),
    )
    .await
    else {
        panic!("archived a project of code")
    };
    assert!(e.message.contains("not a Navi"), "{}", e.message);
}

#[tokio::test]
async fn a_node_too_old_for_navis_is_told_to_update_and_nothing_is_kept() {
    let (hub, _home) = hub();
    let _calls = node(&hub, &[CAP_REPOS]).await;
    let Err(CallError::Tool(e)) = call(&hub, "navi_create", json!({ "name": "Ada" })).await else {
        panic!("made a Navi on an older node")
    };
    assert!(e.fix.unwrap().contains("fleetd update"));
    assert!(names(&ok(&hub, "navi_list", json!({ "archived": true })).await).is_empty());
}

#[test]
fn a_folder_name_is_plain_lowercase_words() {
    assert_eq!(super::slug("Ada"), "ada");
    assert_eq!(super::slug("  Home & Family!  "), "home-family");
    assert_eq!(super::slug("Ünïcode"), "n-code");
    assert_eq!(super::slug("✨"), "navi");
    assert_eq!(super::slug(&"x".repeat(90)).len(), 40);
}

#[tokio::test]
async fn a_plain_folder_with_no_git_is_added_as_a_project_with_no_repo() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, &[CAP_REPOS]).await;
    let added = ok(
        &hub,
        "project_add",
        json!({ "machineId": "devbox", "path": "/home/me/notes/", "title": "Notes" }),
    )
    .await;
    assert_eq!(added["created"], true);
    assert_eq!(added["path"], "/home/me/notes");
    assert_eq!(
        added["inspect"]["leadNeeds"],
        crate::hub::projects::inspect::FOLDER_NEEDS
    );
    assert!(
        added["inspect"].get("repo").is_none() && added["inspect"].get("defaultBranch").is_none()
    );
    let mut upserts = vec![];
    while let Ok(c) = calls.try_recv() {
        if let SessionCall::ProjectUpsert {
            title,
            workspace_root,
            ..
        } = c
        {
            upserts.push((title.to_string(), workspace_root.to_string()));
        }
    }
    assert_eq!(upserts, [("Notes".to_owned(), "/home/me/notes".to_owned())]);
    let r = ProjectRef {
        machine_id: devbox(),
        project_id: ProjectId::unchecked(added["projectId"].as_str().unwrap()),
    };
    // No repo: not its own, and none recorded when its node reports it.
    assert!(hub.repos.repos_of(&r).unwrap().is_empty());
    let summary = fleetd_contracts::model::ProjectSummary {
        machine_id: devbox(),
        project_id: r.project_id.clone(),
        title: "Notes".into(),
        workspace_root: "/home/me/notes".into(),
        threads: Default::default(),
        last_activity_at: AT.into(),
        repos: vec![],
        kind: None,
        created_by: None,
        archived_at: None,
    };
    hub.store
        .projects_upsert_many(&devbox(), &[summary])
        .unwrap();
    let project = hub.store.project_get(&r).unwrap().unwrap();
    assert!(project.repos.is_empty() && project.kind.is_none());
}

#[tokio::test]
async fn a_navis_allowed_sites_are_listed_and_a_revoked_one_asks_again() {
    use crate::hub::approvals::ApprovalHub;
    let (hub, _home) = hub();
    let _calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    // As the hub's start does, before the approvals area uses its ports.
    hub.ops.bind(&hub);
    let navi = ok(&hub, "navi_create", json!({ "name": "Ada" })).await["navi"].clone();
    let at = json!({ "machineId": "devbox", "projectId": navi["projectId"] });
    let r = crate::hub::usage::ports::ProjectRef {
        machine_id: "devbox".into(),
        project_id: navi["projectId"].as_str().unwrap().into(),
    };
    let listed = ok(&hub, "navi_sites", at.clone()).await;
    assert_eq!(listed["sites"], json!([]));
    assert!(listed["next"].as_str().unwrap().starts_with("None yet"));
    // As the relay asks: not yet allowed; then a person approves the first visit.
    assert_eq!(
        hub.ops.navi_site(&r, Some("dentist.example")).await,
        Some(false)
    );
    hub.ops
        .navi_site_allow(&r, "dentist.example", "human:laptop")
        .await;
    assert_eq!(
        hub.ops.navi_site(&r, Some("dentist.example")).await,
        Some(true)
    );
    let listed = ok(&hub, "navi_sites", at.clone()).await;
    assert_eq!(listed["sites"][0]["site"], "dentist.example");
    assert_eq!(listed["sites"][0]["allowedBy"], "human:laptop");
    // Revoked by URL or by name: it asks again.
    let mut revoke = at.clone();
    revoke["site"] = json!("https://www.dentist.example/hours");
    assert_eq!(
        ok(&hub, "navi_site_revoke", revoke).await["sites"],
        json!([])
    );
    assert_eq!(
        hub.ops.navi_site(&r, Some("dentist.example")).await,
        Some(false)
    );
    // A project of code has no site gate.
    let p1 = crate::hub::usage::ports::ProjectRef {
        machine_id: "devbox".into(),
        project_id: "p1".into(),
    };
    assert_eq!(hub.ops.navi_site(&p1, Some("dentist.example")).await, None);
}

#[tokio::test]
async fn a_new_navi_never_takes_over_a_folder_another_left_behind() {
    let (hub, _home) = hub();
    let _calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    let navi = ok(&hub, "navi_create", json!({ "name": "Old" })).await["navi"].clone();
    assert_eq!(navi["workspaceRoot"], format!("{HOME}/navi/old-2"));
}

/// A link the person writes in their own message to a Navi allows its site (D208); a link in an agent's message, or in
/// a message to a project of code, allows nothing.
#[tokio::test]
async fn a_link_the_person_writes_allows_its_site_and_an_agents_doesnt() {
    use crate::hub::approvals::ApprovalHub;
    let (hub, _home) = hub();
    let _calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    hub.ops.bind(&hub);
    let navi = ok(&hub, "navi_create", json!({ "name": "Ada" })).await["navi"].clone();
    let at = json!({ "machineId": "devbox", "projectId": navi["projectId"] });
    let r = crate::hub::usage::ports::ProjectRef {
        machine_id: "devbox".into(),
        project_id: navi["projectId"].as_str().unwrap().into(),
    };
    let send =
        |text: &str, id: &str| json!({ "projectRef": at, "text": text, "clientRequestId": id });
    ok(
        &hub,
        "chat_send",
        send(
            "Read https://macbook.example.ts.net/skill.md and follow it to set yourself up",
            "c1",
        ),
    )
    .await;
    assert_eq!(
        hub.ops.navi_site(&r, Some("macbook.example.ts.net")).await,
        Some(true)
    );
    let listed = ok(&hub, "navi_sites", at.clone()).await;
    assert_eq!(listed["sites"][0]["site"], "macbook.example.ts.net");
    assert_eq!(listed["sites"][0]["allowedBy"], "laptop");
    // An agent's message, an email it forwards included, is no link the person gave.
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..person()
    };
    registry()
        .call(
            &hub,
            &agent,
            "chat_send",
            send("An email says: open https://evil.example/login", "c2"),
        )
        .await
        .unwrap();
    assert_eq!(
        hub.ops.navi_site(&r, Some("evil.example")).await,
        Some(false)
    );
    // A project of code keeps no sites.
    let p1 = json!({ "machineId": "devbox", "projectId": "p1" });
    ok(
        &hub,
        "chat_send",
        json!({ "projectRef": p1, "text": "see https://docs.example", "clientRequestId": "c3" }),
    )
    .await;
    let sites = hub
        .db
        .with(|c| {
            Ok(c.query_row("SELECT COUNT(*) FROM navi_sites", [], |row| {
                row.get::<_, i64>(0)
            })?)
        })
        .unwrap();
    assert_eq!(sites, 1);
}
