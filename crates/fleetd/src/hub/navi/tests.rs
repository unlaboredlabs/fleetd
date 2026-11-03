//! Navis over a real hub and a fake node: several made from one key, each a plain folder under the node's home and a
//! project of kind assistant; renamed, archived and brought back; refused on a node too old to hold one. A project of
//! code next to them stays as it was. Also `project_add` of any plain folder with no git, the same slice.
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::node_link::{
    CAP_ASSISTANT, CAP_NAVI_SIGNINS, CAP_REPOS, HubToNode, NodeToHub,
};
use fleetd_contracts::sessions::SessionCall;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-27T10:00:00.000Z";
const HOME: &str = "/home/me/.fleetd/node";

pub(super) fn devbox() -> MachineId {
    MachineId::unchecked("devbox")
}

pub(super) fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
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
pub(super) async fn node(
    hub: &Arc<Hub>,
    capabilities: &[&str],
) -> mpsc::UnboundedReceiver<SessionCall> {
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
                // No policy file in the project.
                SessionCall::ReadFile { .. } => json!({ "ok": { "kind": "file" } }),
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
        owner: None,
        archived_at: None,
        avatar: None,
        icon: None,
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

/// Forget sign-ins (D221) asks the Navi's node to delete the browser profile it keeps; a node too old to keep one is
/// told to update, and a project of code has none.
#[tokio::test]
async fn forgetting_a_navis_sign_ins_asks_its_node_to_delete_its_browser_profile() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    let navi = ok(&hub, "navi_create", json!({ "name": "Ada" })).await["navi"].clone();
    let at = json!({ "machineId": "devbox", "projectId": navi["projectId"] });
    let old = call(&hub, "navi_signins_forget", at.clone())
        .await
        .unwrap_err();
    assert!(format!("{old:?}").contains("too old"), "{old:?}");
    hub.link
        .set_capabilities(&devbox(), &[CAP_REPOS, CAP_ASSISTANT, CAP_NAVI_SIGNINS]);
    while calls.try_recv().is_ok() {}
    let out = ok(&hub, "navi_signins_forget", at.clone()).await;
    assert_eq!(out["ok"], true);
    assert!(out["next"].as_str().unwrap().contains("signed out"));
    let sent = calls.recv().await.unwrap();
    assert_eq!(
        sent,
        SessionCall::NaviSigninsForget {
            project_id: ProjectId::unchecked(navi["projectId"].as_str().unwrap()),
        }
    );
    let code = call(
        &hub,
        "navi_signins_forget",
        json!({ "machineId": "devbox", "projectId": "p1" }),
    )
    .await
    .unwrap_err();
    assert!(format!("{code:?}").contains("not a Navi"), "{code:?}");
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

/// Deleting a Navi erases it (D287 navi.delete-erases): its node is asked to erase it, folder too when ticked, and the
/// hub keeps none of its rows in any table (chat and its events, approvals and purchases, asks and decisions, orders
/// and their attachments, automations, sessions' rows) nor its memory, skills, attachment files and recordings. A
/// project of code beside it keeps everything; a project of code's folder is never deleted with it.
#[tokio::test]
async fn deleting_a_navi_erases_everything_it_had_and_its_folder_when_ticked() {
    use crate::hub::chat::NewMessage;
    use fleetd_contracts::chat::ChatAuthor;
    use fleetd_contracts::node_link::{CAP_NAVI_ERASE, CAP_PROJECT_SETTINGS};
    let (hub, home) = hub();
    let mut calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    let navi = ok(&hub, "navi_create", json!({ "name": "Ada" })).await["navi"].clone();
    let id = navi["projectId"].as_str().unwrap().to_owned();
    let r = ProjectRef {
        machine_id: devbox(),
        project_id: ProjectId::unchecked(&id),
    };
    let p1 = ProjectRef {
        machine_id: devbox(),
        project_id: ProjectId::unchecked("p1"),
    };
    // What a Navi and a project of code gather: chat, approvals, decisions, asks, an order with an attachment, a lead
    // with a wake, an automation that ran, a screen recording, memory and a skill.
    for (p, title) in [(&r, "Ada"), (&p1, "app")] {
        let key = format!("devbox/{}", p.project_id);
        let pid = p.project_id.as_str();
        hub.chat
            .add(
                p,
                NewMessage {
                    author: Some(ChatAuthor::Human),
                    text: format!("my passport number is in the drawer, {title}"),
                    ..Default::default()
                },
            )
            .unwrap();
        let sha = format!("{:0>64}", pid.len());
        hub.db
            .with(|c| {
                c.execute_batch(&format!(
                    "INSERT INTO requests (project_key, kind, state, created_ms, data) VALUES ('{key}', 'purchase', 'done', 1, '{{}}');
                     INSERT INTO decisions (key, scope_kind, scope_id, project_key, state, source, at_ms, data)
                       VALUES ('dentist', 'project', '{key}', '{key}', 'active', 'human', 1, '{{}}');
                     INSERT INTO legacy_asks (project_key, key, state, filed_by, created_ms, data)
                       VALUES ('{key}', 'k', 'open', 'lead', 1, '{{}}');
                     INSERT INTO navi_asks (from_machine_id, from_project_id, to_machine_id, to_project_id, text, at_ms)
                       VALUES ('devbox', '{pid}', 'devbox', 'elsewhere', 'how is it going?', 1);
                     INSERT INTO workstreams (machine_id, project_id, state, data) VALUES ('devbox', '{pid}', 'done', '{{}}');
                     INSERT INTO attachments (sha256, name, mime, bytes, by, created_ms, workstream_id)
                       VALUES ('{sha}', 'scan.png', 'image/png', 3, 'k1', 1, 'W' || last_insert_rowid());
                     INSERT INTO attachments (sha256, name, mime, bytes, by, created_ms, project)
                       VALUES ('{sha}', 'photo.png', 'image/png', 3, 'k1', 1, '{key}');
                     INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation)
                       VALUES ('devbox', '{pid}', 'th-{pid}', '{AT}', 1);
                     INSERT INTO wakes (wake_id, created_by, client_request_id, machine_id, thread_id, state, data)
                       VALUES ('wk-{pid}', 'lead', 'c-{pid}', 'devbox', 'th-{pid}', 'active', '{{}}');
                     INSERT INTO session_prompts (machine_id, thread_id, project_id, started_at, refs, text_sha, text)
                       VALUES ('devbox', 'th-{pid}', '{pid}', '{AT}', '[]', 'x', 'You are {title}');
                     INSERT INTO automations (automation_id, machine_id, project_id, created_by, data)
                       VALUES ('au-{pid}', 'devbox', '{pid}', 'lead', '{{}}');
                     INSERT INTO automation_runs (run_id, automation_id, at_ms, state, data)
                       VALUES ('run-{pid}', 'au-{pid}', 1, 'done', '{{}}');
                     INSERT INTO checklists (machine_id, project_id, next_id, items, updated_ms)
                       VALUES ('devbox', '{pid}', 2, '[]', 1);
                     INSERT INTO browser_sessions (session_id, machine_id, project_id, started_ms, state, data)
                       VALUES ('bs-{pid}', 'devbox', '{pid}', 1, 'ended', '{{}}');
                     INSERT INTO time_labels (hash, family, text) VALUES ('h-{pid}', 'bash', 'curl https://{pid}.example/q');
                     INSERT INTO time_spans (src, src_key, kind, cat, start_ms, lane, status, machine_id, project_id,
                       thread_id, label_id)
                       VALUES ('node', 'a-{pid}', 'tool', 'tool', 1, 'lead', 'done', 'devbox', '{pid}', 'th-{pid}',
                         (SELECT id FROM time_labels WHERE hash = 'h-{pid}'));
                     INSERT INTO time_spans (src, src_key, kind, cat, start_ms, lane, status, machine_id, thread_id, label_id)
                       VALUES ('node', 'b-{pid}', 'tool', 'tool', 2, 'lead', 'done', 'devbox', 'th-{pid}',
                         (SELECT id FROM time_labels WHERE hash = 'h-{pid}'));
                     INSERT INTO time_lead_runs (machine_id, thread_id, run_id, workstream_id, n, at_ms)
                       VALUES ('devbox', 'th-{pid}', 'r1', 'W1', 1, 1);
                     INSERT INTO time_wakes (machine_id, thread_id, at_ms, workstreams) VALUES ('devbox', 'th-{pid}', 1, '[]');"
                ))?;
                Ok(())
            })
            .unwrap();
        let blob = crate::hub::intake::attachments::dir(&hub).join(&sha);
        let recording = crate::hub::browser::dir(
            &hub,
            &fleetd_contracts::browser::BrowserSessionId::unchecked(format!("bs-{pid}")),
        );
        let memory = hub.db.memory().project_dir(p).unwrap();
        for (file, text) in [
            (blob, "png"),
            (recording.join("video.webm"), "clip"),
            (memory.join("MEMORY.md"), "- Sam's dentist is Dr Lee"),
        ] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        hub.db
            .skills()
            .set(
                fleetd_contracts::skills::SkillScope::Project,
                Some(p),
                &fleetd_contracts::skills::SkillName::new("invoices").unwrap(),
                "---\nname: invoices\ndescription: Get the invoices.\n---\n\n# invoices\n",
                false,
                &crate::hub::skills::Who::agent(title, "learned it", 1),
            )
            .unwrap();
    }
    let at = json!({ "machineId": "devbox", "projectId": id, "removeWorktrees": true, "removeFolder": true });

    // A node that can't erase is told to update first, and nothing goes.
    hub.link
        .set_capabilities(&devbox(), &[CAP_REPOS, CAP_ASSISTANT, CAP_PROJECT_SETTINGS]);
    let old = call(&hub, "project_remove", at.clone()).await.unwrap_err();
    assert!(format!("{old:?}").contains("too old to erase"), "{old:?}");
    // A project of code's folder is never deleted with it.
    let code = call(
        &hub,
        "project_remove",
        json!({ "machineId": "devbox", "projectId": "p1", "removeFolder": true }),
    )
    .await
    .unwrap_err();
    assert!(
        format!("{code:?}").contains("only a Navi's folder"),
        "{code:?}"
    );

    hub.link.set_capabilities(
        &devbox(),
        &[
            CAP_REPOS,
            CAP_ASSISTANT,
            CAP_PROJECT_SETTINGS,
            CAP_NAVI_ERASE,
        ],
    );
    while calls.try_recv().is_ok() {}
    let out = ok(&hub, "project_remove", at).await;
    assert!(out["next"].as_str().unwrap().contains("erased"), "{out}");
    assert_eq!(
        calls.recv().await.unwrap(),
        SessionCall::ProjectRemove {
            project_id: r.project_id.clone(),
            remove_worktrees: true,
            erase: true,
            remove_folder: true,
        }
    );
    // As the node's project_removed then does.
    hub.store.project_remove(&r).unwrap();

    // No table keeps a row of it; the project of code keeps its own.
    let left = |p: &ProjectRef| -> Vec<String> {
        let (m, pid) = (p.machine_id.as_str(), p.project_id.as_str());
        let key = format!("{m}/{pid}");
        hub.db
            .with(|c| {
                let tables: Vec<String> = c
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?
                    .query_map([], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                let mut left = Vec::new();
                for t in tables {
                    let cols: Vec<String> = c
                        .prepare(&format!("SELECT name FROM pragma_table_info('{t}')"))?
                        .query_map([], |row| row.get(0))?
                        .collect::<rusqlite::Result<_>>()?;
                    let has = |n: &str| cols.iter().any(|c| c == n);
                    let mut wheres = Vec::new();
                    if has("machine_id") && has("project_id") {
                        wheres.push(format!("(machine_id = '{m}' AND project_id = '{pid}')"));
                    }
                    if has("from_project_id") {
                        wheres.push(format!(
                            "from_project_id = '{pid}' OR to_project_id = '{pid}'"
                        ));
                    }
                    for k in ["project_key", "project"] {
                        if has(k) {
                            wheres.push(format!("{k} = '{key}'"));
                        }
                    }
                    if has("thread_id") && has("machine_id") {
                        wheres.push(format!("(machine_id = '{m}' AND thread_id = 'th-{pid}')"));
                    }
                    if has("automation_id") {
                        wheres.push(format!("automation_id = 'au-{pid}'"));
                    }
                    if t == "events" {
                        wheres.push(format!("data LIKE '%{pid}%'"));
                    }
                    if wheres.is_empty() {
                        continue;
                    }
                    let n: i64 = c.query_row(
                        &format!("SELECT COUNT(*) FROM {t} WHERE {}", wheres.join(" OR ")),
                        [],
                        |row| row.get(0),
                    )?;
                    if n > 0 {
                        left.push(t);
                    }
                }
                Ok(left)
            })
            .unwrap()
    };
    assert_eq!(left(&r), Vec::<String>::new());
    let kept = left(&p1);
    for t in [
        "chat_messages",
        "requests",
        "decisions",
        "navi_asks",
        "workstreams",
        "attachments",
        "leads",
        "wakes",
        "automations",
        "automation_runs",
        "browser_sessions",
        "skill_versions",
        "events",
        "time_spans",
        "time_lead_runs",
        "time_wakes",
    ] {
        assert!(kept.iter().any(|k| k == t), "p1 lost its {t}: {kept:?}");
    }
    // Nor the time inspector's labels of its sessions (its commands, searches and pages); p1's stays.
    let labels = |pid: &str| -> i64 {
        hub.db
            .with(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM time_labels WHERE text LIKE ?1",
                    [format!("%{pid}.example%")],
                    |row| row.get(0),
                )?)
            })
            .unwrap()
    };
    assert_eq!((labels(&id), labels("p1")), (0, 1));
    // Nor any file of it: its memory, skills, attachment and recording; p1's stay.
    let files = |p: &ProjectRef| {
        let pid = p.project_id.as_str();
        [
            crate::hub::intake::attachments::dir(&hub).join(format!("{:0>64}", pid.len())),
            crate::hub::browser::dir(
                &hub,
                &fleetd_contracts::browser::BrowserSessionId::unchecked(format!("bs-{pid}")),
            ),
            hub.db.memory().project_dir(p).unwrap(),
            hub.db
                .skills()
                .scope_dir(fleetd_contracts::skills::SkillScope::Project, Some(p))
                .unwrap(),
        ]
        .into_iter()
        .filter(|f| f.exists())
        .count()
    };
    assert_eq!(files(&r), 0);
    assert_eq!(files(&p1), 4);
    assert!(home.path().exists());
}
