//! Task profiles over a real hub and a fake node: the two a hub migrates to, what a launch of each carries, who may
//! create, change and delete them, what each project allows, and a model claude refused flagged and left out.
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::effort::Effort;
use fleetd_contracts::ids::{MachineId, ProjectId};
use fleetd_contracts::node_link::{HubToNode, NodeToHub};
use fleetd_contracts::sessions::{SessionCall, SessionLaunch};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use fleetd_contracts::auth::Grant;
use fleetd_contracts::people::{HubRole, PersonName};

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::executor::{LaunchInput, LaunchOptions};
use crate::hub::people::People;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-19T10:00:00.000Z";
/// After the hub's clock, so a session launched then followed every change made before.
const LATER: &str = "2027-10-27T10:00:00.000Z";
/// Before it: a session launched then ran on an earlier setting.
const EARLIER: &str = "2026-10-01T10:00:00.000Z";

fn lab() -> MachineId {
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

/// Hands a machine event to the hub as devbox's node sends it.
fn machine_event(hub: &Hub, seq: u64, event: Value) {
    hub.executors.handle_frame(
        &lab(),
        serde_json::from_value::<NodeToHub>(
            json!({ "t": "machine_event", "seq": seq, "at": AT, "event": event }),
        )
        .unwrap(),
    );
}

/// Links devbox's node holding projects p1 and p2, answering every call; each launch goes to the test.
async fn node(hub: &Arc<Hub>) -> mpsc::UnboundedReceiver<SessionLaunch> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    hub.executors
        .attach(
            &lab(),
            crate::hub::executor::NodeSessions {
                link_id: 1,
                send: tx,
            },
        )
        .await;
    let HubToNode::SessionCall(subscribe) = rx.recv().await.unwrap() else {
        panic!("not a subscribe")
    };
    let project = |id: &str| json!({ "projectId": id, "title": id, "workspaceRoot": format!("/work/{id}"), "updatedAt": AT });
    machine_event(
        hub,
        1,
        json!({ "type": "snapshot", "projects": [project("p1"), project("p2")], "sessions": [] }),
    );
    let reply = |id: &str, result: Value| {
        hub.executors.handle_frame(
            &lab(),
            serde_json::from_value::<NodeToHub>(
                json!({ "t": "session_reply", "id": id, "result": result }),
            )
            .unwrap(),
        )
    };
    reply(subscribe.id.as_str(), json!({ "ok": { "kind": "done" } }));
    hub.executors.await_live(&lab()).await;
    let (launches_tx, launches) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let result = match &f.call {
                SessionCall::ReadFile { .. } => json!({ "ok": { "kind": "file" } }),
                _ => json!({ "ok": { "kind": "done" } }),
            };
            hub.executors.handle_frame(
                &lab(),
                serde_json::from_value::<NodeToHub>(
                    json!({ "t": "session_reply", "id": f.id, "result": result }),
                )
                .unwrap(),
            );
            if let SessionCall::Launch(launch) = f.call {
                let _ = launches_tx.send(launch);
            }
        }
    });
    launches
}

/// What a launch on `profile` in `project` carries: the profile, its model, effort, fast mode and helper model.
async fn launch(
    hub: &Hub,
    launches: &mut mpsc::UnboundedReceiver<SessionLaunch>,
    project: &str,
    profile: &str,
) -> (String, Option<String>, Option<Effort>, bool, Option<String>) {
    hub.executors
        .launch(
            &lab(),
            &LaunchInput {
                project_id: ProjectId::unchecked(project),
                prompt: "go".into(),
                system_prompt: None,
                profile: fleetd_contracts::effort::ProfileName::unchecked(profile),
                runtime_mode: fleetd_contracts::model::RuntimeMode::FullAccess,
                title: None,
                client_request_id: format!("req-{}", rand::random::<u64>()),
            },
            LaunchOptions::default(),
        )
        .await
        .unwrap();
    let l = launches.recv().await.unwrap();
    (
        l.profile.unwrap().into_inner(),
        l.model.map(|m| m.to_string()),
        l.effort,
        l.fast,
        l.helper_model.map(|m| m.to_string()),
    )
}

fn people(hub: &Hub) -> People {
    People::new(hub.db.clone(), hub.clock.clone())
}

/// A device of a person: the hub's owner's, or a member's.
fn device(hub: &Hub, owner: bool) -> Caller {
    let person = if owner {
        people(hub).ensure_owner().unwrap().person_id
    } else {
        people(hub)
            .create(&PersonName::unchecked("Bea"), HubRole::Member)
            .unwrap()
            .person_id
    };
    let role = if owner { "admin" } else { "operate" };
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": role, "machines": "*" }])).unwrap();
    hub.auth
        .create_key_for("desk", &grants, KeyKind::Human, Some(&person))
        .unwrap()
        .info
}

async fn call(
    hub: &Arc<Hub>,
    caller: &Caller,
    tool: &str,
    input: Value,
) -> Result<Value, CallError> {
    registry().call(hub, caller, tool, input).await
}

fn some(model: &str) -> Option<String> {
    Some(model.into())
}

/// The id of the profile named `name`.
async fn id_of(hub: &Arc<Hub>, admin: &Caller, name: &str) -> i64 {
    let list = call(hub, admin, "profiles_list", json!({})).await.unwrap();
    list["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == name)
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

#[tokio::test]
async fn a_new_hub_has_high_the_default_and_medium_on_today_s_model_and_effort() {
    let (hub, _home) = hub();
    let mut launches = node(&hub).await;
    let admin = device(&hub, true);
    let list = call(&hub, &admin, "profiles_list", json!({}))
        .await
        .unwrap();
    let names: Vec<(&str, &str, &str, bool)> = list["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p["name"].as_str().unwrap(),
                p["model"].as_str().unwrap(),
                p["effort"].as_str().unwrap(),
                p["default"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        names,
        [
            ("high", "claude-opus-5-5", "high", true),
            ("medium", "claude-opus-5-5", "medium", false)
        ]
    );
    assert!(
        list["profiles"][1]["note"]
            .as_str()
            .unwrap()
            .starts_with("Only for mechanical work")
    );
    // No API key: fleetd's own list of models, fast mode only on the Opus line.
    assert_eq!(list["modelsFrom"], "builtin");
    let fast: Vec<&str> = list["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["fast"] == true)
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(
        fast,
        ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]
    );
    assert_eq!(
        list["efforts"],
        json!(["low", "medium", "high", "xhigh", "max"])
    );
    assert_eq!(
        launch(&hub, &mut launches, "p1", "high").await,
        (
            "high".into(),
            some("claude-opus-5-5"),
            Some(Effort::High),
            false,
            some("claude-opus-5-5")
        )
    );
    assert_eq!(
        launch(&hub, &mut launches, "p1", "medium").await,
        (
            "medium".into(),
            some("claude-opus-5-5"),
            Some(Effort::Medium),
            false,
            some("claude-opus-5-5")
        )
    );
    // A name no profile has any more runs on the default.
    assert_eq!(launch(&hub, &mut launches, "p1", "gone").await.0, "high");
}

#[tokio::test]
async fn only_owners_and_admins_change_profiles_and_anyone_lists_them() {
    let (hub, _home) = hub();
    let member = device(&hub, false);
    let new = json!({ "name": "quick", "note": "", "model": "claude-opus-5-5", "effort": "low" });
    for (tool, input) in [
        ("profile_create", new.clone()),
        ("profile_update", json!({ "id": 2, "effort": "low" })),
        ("profile_delete", json!({ "id": 2 })),
    ] {
        let refused = call(&hub, &member, tool, input).await.unwrap_err();
        assert!(
            format!("{refused:?}").contains("Forbidden")
                || format!("{refused:?}").contains("forbidden"),
            "{tool}: {refused:?}"
        );
    }
    let list = call(&hub, &member, "profiles_list", json!({}))
        .await
        .unwrap();
    assert_eq!(list["profiles"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn profiles_are_created_changed_and_deleted_with_clear_refusals() {
    let (hub, _home) = hub();
    let mut launches = node(&hub).await;
    let admin = device(&hub, true);
    let refusal = |e: CallError| format!("{e:?}");
    // A model off the list, fast mode on a model without it, a name taken: each refused, saying why.
    let off_list = json!({ "name": "x", "note": "", "model": "claude-nope", "effort": "low" });
    let e = refusal(
        call(&hub, &admin, "profile_create", off_list)
            .await
            .unwrap_err(),
    );
    assert!(
        e.contains("claude-nope is not among the models this hub offers"),
        "{e}"
    );
    let slow = json!({ "name": "x", "note": "", "model": "claude-sonnet-5-5", "effort": "low", "fast": true });
    let e = refusal(
        call(&hub, &admin, "profile_create", slow)
            .await
            .unwrap_err(),
    );
    assert!(e.contains("claude-sonnet-5-5 has no fast mode"), "{e}");
    let taken =
        json!({ "name": "medium", "note": "", "model": "claude-opus-5-5", "effort": "low" });
    let e = refusal(
        call(&hub, &admin, "profile_create", taken)
            .await
            .unwrap_err(),
    );
    assert!(e.contains("a profile is already named medium"), "{e}");

    let quick = json!({ "name": "quick", "note": "Small fixes, fast.", "model": "claude-opus-5-5", "effort": "low",
        "fast": true });
    let made = call(&hub, &admin, "profile_create", quick).await.unwrap();
    assert_eq!(made["profile"]["fast"], true);
    assert_eq!(
        launch(&hub, &mut launches, "p1", "quick").await,
        (
            "quick".into(),
            some("claude-opus-5-5"),
            Some(Effort::Low),
            true,
            some("claude-opus-5-5")
        )
    );
    // A rename and a model without fast mode: fast goes off by itself.
    let id = id_of(&hub, &admin, "quick").await;
    let changed = call(
        &hub,
        &admin,
        "profile_update",
        json!({ "id": id, "name": "small", "model": "claude-sonnet-5-5", "effort": "xhigh" }),
    )
    .await
    .unwrap();
    assert_eq!(
        (
            &changed["profile"]["name"],
            &changed["profile"]["model"],
            &changed["profile"]["fast"]
        ),
        (&json!("small"), &json!("claude-sonnet-5-5"), &json!(false))
    );
    assert_eq!(
        launch(&hub, &mut launches, "p1", "small").await,
        (
            "small".into(),
            some("claude-sonnet-5-5"),
            Some(Effort::Xhigh),
            false,
            some("claude-opus-5-5")
        )
    );

    // Making it the default moves the default, and the helper calls with it; the default can't be unset or deleted.
    call(
        &hub,
        &admin,
        "profile_update",
        json!({ "id": id, "default": true }),
    )
    .await
    .unwrap();
    let high = id_of(&hub, &admin, "high").await;
    let list = call(&hub, &admin, "profiles_list", json!({}))
        .await
        .unwrap();
    assert_eq!(list["profiles"][0]["name"], "small");
    assert_eq!(list["profiles"][0]["default"], true);
    assert_eq!(
        launch(&hub, &mut launches, "p1", "high").await.4,
        some("claude-sonnet-5-5")
    );
    let e = refusal(
        call(&hub, &admin, "profile_delete", json!({ "id": id }))
            .await
            .unwrap_err(),
    );
    assert!(e.contains("small is the default"), "{e}");
    let e = refusal(
        call(
            &hub,
            &admin,
            "profile_update",
            json!({ "id": id, "default": false }),
        )
        .await
        .unwrap_err(),
    );
    assert!(e.contains("small is the default"), "{e}");
    call(
        &hub,
        &admin,
        "profile_update",
        json!({ "id": high, "default": true }),
    )
    .await
    .unwrap();

    // One a task not yet ended runs on can't go; once it ended, it can, and no project allows it any more.
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO tasks (machine_id, project_id, workstream_id, state, data)
                 VALUES ('devbox', 'p1', 'W1', 'running', '{\"profile\":\"small\"}')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    call(
        &hub,
        &admin,
        "project_set",
        json!({ "machineId": "devbox", "projectId": "p1", "profiles": ["small"] }),
    )
    .await
    .unwrap();
    let e = refusal(
        call(&hub, &admin, "profile_delete", json!({ "id": id }))
            .await
            .unwrap_err(),
    );
    assert!(e.contains("small is in use by T1"), "{e}");
    // A rename takes the task with it: it starts again on the renamed profile, and delete still sees it.
    call(
        &hub,
        &admin,
        "profile_update",
        json!({ "id": id, "name": "tiny" }),
    )
    .await
    .unwrap();
    assert_eq!(
        launch(&hub, &mut launches, "p1", "tiny").await.1,
        some("claude-sonnet-5-5")
    );
    let profile_of_t1: String = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT json_extract(data, '$.profile') FROM tasks",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(profile_of_t1, "tiny");
    let e = refusal(
        call(&hub, &admin, "profile_delete", json!({ "id": id }))
            .await
            .unwrap_err(),
    );
    assert!(e.contains("tiny is in use by T1"), "{e}");
    hub.db
        .with(|c| {
            c.execute("UPDATE tasks SET state = 'done'", [])?;
            Ok(())
        })
        .unwrap();
    call(&hub, &admin, "profile_delete", json!({ "id": id }))
        .await
        .unwrap();
    let list = call(
        &hub,
        &admin,
        "profiles_list",
        json!({ "projectRef": { "machineId": "devbox", "projectId": "p1" } }),
    )
    .await
    .unwrap();
    assert_eq!(list["allowed"], json!(["high"]));
    assert_eq!(list["profiles"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn a_project_allows_what_project_set_picks_besides_the_default() {
    let (hub, _home) = hub();
    let _launches = node(&hub).await;
    let admin = device(&hub, true);
    let p1 = json!({ "machineId": "devbox", "projectId": "p1" });
    let list = call(&hub, &admin, "profiles_list", json!({ "projectRef": p1 }))
        .await
        .unwrap();
    assert_eq!(list["allowed"], json!(["high"]));
    let set = call(
        &hub,
        &admin,
        "project_set",
        json!({ "machineId": "devbox", "projectId": "p1", "profiles": ["medium"] }),
    )
    .await
    .unwrap();
    assert_eq!(set["profiles"], json!(["high", "medium"]));
    let got = call(
        &hub,
        &admin,
        "project_get",
        json!({ "machineId": "devbox", "projectId": "p1" }),
    )
    .await
    .unwrap();
    assert_eq!(got["profiles"], json!(["high", "medium"]));
    let e = call(
        &hub,
        &admin,
        "project_set",
        json!({ "machineId": "devbox", "projectId": "p1", "profiles": ["nope"] }),
    )
    .await
    .unwrap_err();
    assert!(
        format!("{e:?}").contains("no profile is named nope"),
        "{e:?}"
    );
}

/// The node's word that claude refused `model` for a session launched at `created`: it runs on the runner's own.
fn refused_session(hub: &Hub, seq: u64, model: &str, created: &str) {
    machine_event(
        hub,
        seq,
        json!({ "type": "session_updated", "sessionId": format!("s{seq}"), "projectId": "p1", "title": "T1",
            "status": "idle", "model": "claude-opus-5-5", "effort": "max", "modelRefused": model,
            "runtimeMode": "full-access", "createdAt": created, "updatedAt": created }),
    );
}

#[tokio::test]
async fn a_model_claude_refused_is_flagged_and_new_agents_run_the_runner_s_own() {
    let (hub, _home) = hub();
    let mut launches = node(&hub).await;
    let admin = device(&hub, true);
    let medium = id_of(&hub, &admin, "medium").await;
    call(
        &hub,
        &admin,
        "profile_update",
        json!({ "id": medium, "model": "claude-haiku-5-5" }),
    )
    .await
    .unwrap();
    // The node fell back: the profile is flagged with a clear reason, new agents leave its model out.
    refused_session(&hub, 2, "claude-haiku-5-5", LATER);
    let list = call(&hub, &admin, "profiles_list", json!({}))
        .await
        .unwrap();
    assert_eq!(
        list["profiles"][1]["refused"],
        format!(
            "claude on devbox refused claude-haiku-5-5 at {LATER}: agents run on claude-opus-5-5 instead until you \
             set this again."
        )
    );
    assert_eq!(
        launch(&hub, &mut launches, "p1", "medium").await,
        (
            "medium".into(),
            None,
            Some(Effort::Medium),
            false,
            some("claude-opus-5-5")
        )
    );
    // Changing only the effort keeps the flag; setting the model again clears it, and an earlier session's word
    // doesn't bring it back.
    call(
        &hub,
        &admin,
        "profile_update",
        json!({ "id": medium, "effort": "low" }),
    )
    .await
    .unwrap();
    let list = call(&hub, &admin, "profiles_list", json!({}))
        .await
        .unwrap();
    assert!(list["profiles"][1]["refused"].is_string());
    call(
        &hub,
        &admin,
        "profile_update",
        json!({ "id": medium, "model": "claude-sonnet-5-5" }),
    )
    .await
    .unwrap();
    call(
        &hub,
        &admin,
        "profile_update",
        json!({ "id": medium, "model": "claude-haiku-5-5" }),
    )
    .await
    .unwrap();
    refused_session(&hub, 3, "claude-haiku-5-5", EARLIER);
    let list = call(&hub, &admin, "profiles_list", json!({}))
        .await
        .unwrap();
    assert_eq!(list["profiles"][1].get("refused"), None);
}
