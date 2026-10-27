//! Profile settings over a real hub and a fake node: what a launch of each profile carries with nothing set, with a
//! fleet setting and with a project's override, who may set them, and a model claude refused flagged and left out.
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::effort::{Effort, TaskProfile};
use fleetd_contracts::ids::{MachineId, ProjectId};
use fleetd_contracts::node_link::{HubToNode, NodeToHub};
use fleetd_contracts::sessions::{SessionCall, SessionLaunch};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::executor::{LaunchInput, LaunchOptions};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-19T10:00:00.000Z";
/// After the hub's clock, so a session launched then follows every setting made before.
const LATER: &str = "2026-10-27T10:00:00.000Z";
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

/// What a launch of `profile` in `project` carries: its model, effort and helper model.
async fn launch(
    hub: &Hub,
    launches: &mut mpsc::UnboundedReceiver<SessionLaunch>,
    project: &str,
    profile: TaskProfile,
) -> (Option<String>, Option<Effort>, Option<String>) {
    hub.executors
        .launch(
            &lab(),
            &LaunchInput {
                project_id: ProjectId::unchecked(project),
                prompt: "go".into(),
                profile,
                runtime_mode: fleetd_contracts::model::RuntimeMode::FullAccess,
                title: None,
                client_request_id: format!("req-{}", rand::random::<u64>()),
            },
            LaunchOptions::default(),
        )
        .await
        .unwrap();
    let l = launches.recv().await.unwrap();
    assert_eq!(l.profile, Some(profile));
    (
        l.model.map(|m| m.to_string()),
        l.effort,
        l.helper_model.map(|m| m.to_string()),
    )
}

fn caller(role: &str, kind: KeyKind) -> Caller {
    let c = serde_json::from_value::<Caller>(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": role, "machines": "*" }],
    }))
    .unwrap();
    Caller {
        kind: Some(kind),
        ..c
    }
}

fn admin() -> Caller {
    caller("admin", KeyKind::Human)
}

async fn call(
    hub: &Arc<Hub>,
    caller: &Caller,
    tool: &str,
    input: Value,
) -> Result<Value, CallError> {
    registry().call(hub, caller, tool, input).await
}

fn p(id: &str) -> Value {
    json!({ "machineId": "devbox", "projectId": id })
}

fn some(model: &str) -> Option<String> {
    Some(model.into())
}

#[tokio::test]
async fn with_nothing_set_agents_run_on_the_profile_s_own() {
    let (hub, _home) = hub();
    let mut launches = node(&hub).await;
    // The launch names no model or effort: the node runs the profile's own, claude-opus-5-5 at high or medium.
    for profile in [TaskProfile::High, TaskProfile::Medium] {
        assert_eq!(
            launch(&hub, &mut launches, "p1", profile).await,
            (None, None, None)
        );
    }
    let got = call(
        &hub,
        &admin(),
        "profiles_get",
        json!({ "projectRef": p("p1") }),
    )
    .await
    .unwrap();
    assert_eq!(got["fleet"], json!({ "high": {}, "medium": {} }));
    assert_eq!(got["project"], json!({ "high": {}, "medium": {} }));
    let own = json!({
        "high": { "model": "claude-opus-5-5", "effort": "high" },
        "medium": { "model": "claude-opus-5-5", "effort": "medium" },
    });
    assert_eq!((&got["runs"], &got["defaults"]), (&own, &own));
}

#[tokio::test]
async fn a_fleet_setting_changes_what_new_high_agents_run() {
    let (hub, _home) = hub();
    let mut launches = node(&hub).await;
    let input = json!({ "high": { "model": "claude-sonnet-5-5", "effort": "max" } });
    // Every project follows the fleet's: only an admin key sets it.
    let refused = call(
        &hub,
        &caller("operate", KeyKind::Human),
        "profiles_set",
        input.clone(),
    )
    .await;
    assert!(refused.is_err());
    let set = call(&hub, &admin(), "profiles_set", input).await.unwrap();
    assert_eq!(
        set["runs"]["high"],
        json!({ "model": "claude-sonnet-5-5", "effort": "max" })
    );
    assert!(
        set["next"]
            .as_str()
            .unwrap()
            .contains("high on claude-sonnet-5-5 at max")
    );
    assert_eq!(
        launch(&hub, &mut launches, "p1", TaskProfile::High).await,
        (
            some("claude-sonnet-5-5"),
            Some(Effort::Max),
            some("claude-sonnet-5-5")
        )
    );
    // Medium keeps its own, but claude's helper calls follow high.
    assert_eq!(
        launch(&hub, &mut launches, "p2", TaskProfile::Medium).await,
        (None, None, some("claude-sonnet-5-5"))
    );
    // `{}` unsets it: back to the profile's own.
    call(&hub, &admin(), "profiles_set", json!({ "high": {} }))
        .await
        .unwrap();
    assert_eq!(
        launch(&hub, &mut launches, "p1", TaskProfile::High).await,
        (None, None, None)
    );
}

#[tokio::test]
async fn a_project_override_wins_over_the_fleet_default() {
    let (hub, _home) = hub();
    let mut launches = node(&hub).await;
    call(
        &hub,
        &admin(),
        "profiles_set",
        json!({ "high": { "model": "claude-sonnet-5-5", "effort": "max" }, "medium": { "effort": "low" } }),
    )
    .await
    .unwrap();
    // An operator of the project sets its override; each field it leaves unset follows the fleet's.
    let set = call(
        &hub,
        &caller("operate", KeyKind::Human),
        "profiles_set",
        json!({ "projectRef": p("p1"), "high": { "model": "claude-fable-5-1" }, "medium": { "model": "claude-haiku-5-5", "effort": "medium" } }),
    )
    .await
    .unwrap();
    assert_eq!(
        set["runs"],
        json!({
            "high": { "model": "claude-fable-5-1", "effort": "max" },
            "medium": { "model": "claude-haiku-5-5", "effort": "medium" },
        })
    );
    assert_eq!(
        launch(&hub, &mut launches, "p1", TaskProfile::High).await,
        (
            some("claude-fable-5-1"),
            Some(Effort::Max),
            some("claude-fable-5-1")
        )
    );
    assert_eq!(
        launch(&hub, &mut launches, "p1", TaskProfile::Medium).await,
        (
            some("claude-haiku-5-5"),
            Some(Effort::Medium),
            some("claude-fable-5-1")
        )
    );
    // Another project runs the fleet's.
    assert_eq!(
        launch(&hub, &mut launches, "p2", TaskProfile::High).await,
        (
            some("claude-sonnet-5-5"),
            Some(Effort::Max),
            some("claude-sonnet-5-5")
        )
    );
    assert_eq!(
        launch(&hub, &mut launches, "p2", TaskProfile::Medium).await,
        (None, Some(Effort::Low), some("claude-sonnet-5-5"))
    );
    // A bad model name is refused before it is kept.
    let bad = call(
        &hub,
        &admin(),
        "profiles_set",
        json!({ "projectRef": p("p1"), "high": { "model": "claude opus" } }),
    )
    .await;
    assert!(bad.is_err());
}

/// The node's word that claude refused `model` for a session launched at `created`: it runs on the profile's own.
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
async fn a_model_claude_refused_is_flagged_and_new_agents_run_the_profile_s_own() {
    let (hub, _home) = hub();
    let mut launches = node(&hub).await;
    let bad = json!({ "high": { "model": "claude-does-not-exist-9", "effort": "max" } });
    call(&hub, &admin(), "profiles_set", bad.clone())
        .await
        .unwrap();
    assert_eq!(
        launch(&hub, &mut launches, "p1", TaskProfile::High).await.0,
        some("claude-does-not-exist-9")
    );
    // The node fell back: the setting is flagged with a clear reason.
    refused_session(&hub, 2, "claude-does-not-exist-9", LATER);
    let got = call(&hub, &admin(), "profiles_get", json!({}))
        .await
        .unwrap();
    let why = got["fleet"]["high"]["refused"].as_str().unwrap();
    assert_eq!(
        why,
        format!(
            "claude on devbox refused claude-does-not-exist-9 at {LATER}: agents run on claude-opus-5-5 instead \
             until you set this again."
        )
    );
    // New agents run as if the model were unset; its effort still applies.
    assert_eq!(
        got["runs"]["high"],
        json!({ "model": "claude-opus-5-5", "effort": "max" })
    );
    assert_eq!(
        launch(&hub, &mut launches, "p1", TaskProfile::High).await,
        (None, Some(Effort::Max), None)
    );
    // Setting it again clears the flag, and an earlier session's word doesn't bring it back.
    call(&hub, &admin(), "profiles_set", bad).await.unwrap();
    refused_session(&hub, 3, "claude-does-not-exist-9", EARLIER);
    let got = call(&hub, &admin(), "profiles_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["fleet"]["high"].get("refused"), None);
    // A refusal no caller can make up: one the hub never flagged is dropped.
    let input = json!({ "high": { "model": "claude-sonnet-5-5", "refused": "x" } });
    let set = call(&hub, &admin(), "profiles_set", input).await.unwrap();
    assert_eq!(set["fleet"]["high"].get("refused"), None);
}

#[tokio::test]
async fn changing_only_the_effort_keeps_a_refusal_and_setting_the_model_clears_it() {
    let (hub, _home) = hub();
    let _launches = node(&hub).await;
    let bad = json!({ "high": { "model": "claude-does-not-exist-9", "effort": "max" } });
    call(&hub, &admin(), "profiles_set", bad.clone())
        .await
        .unwrap();
    refused_session(&hub, 2, "claude-does-not-exist-9", LATER);
    let got = call(&hub, &admin(), "profiles_get", json!({}))
        .await
        .unwrap();
    let flagged = got["fleet"]["high"].clone();
    assert!(flagged["refused"].is_string());
    // The effort changed alone, the flag passed back as read (as `fleetd project set --high-effort` does): it stays,
    // and new agents still leave the model out.
    let mut effort_only = flagged.clone();
    effort_only["effort"] = json!("low");
    let set = call(
        &hub,
        &admin(),
        "profiles_set",
        json!({ "high": effort_only }),
    )
    .await
    .unwrap();
    assert_eq!(set["fleet"]["high"]["refused"], flagged["refused"]);
    assert_eq!(
        set["runs"]["high"],
        json!({ "model": "claude-opus-5-5", "effort": "low" })
    );
    // The flag passed back with another model: that model is set, unflagged.
    let mut other = flagged.clone();
    other["model"] = json!("claude-sonnet-5-5");
    let set = call(&hub, &admin(), "profiles_set", json!({ "high": other }))
        .await
        .unwrap();
    assert_eq!(set["fleet"]["high"].get("refused"), None);
    // Back on the refused model, then set again without the flag: cleared.
    call(&hub, &admin(), "profiles_set", bad.clone())
        .await
        .unwrap();
    refused_session(
        &hub,
        3,
        "claude-does-not-exist-9",
        "2026-10-28T10:00:00.000Z",
    );
    let got = call(&hub, &admin(), "profiles_get", json!({}))
        .await
        .unwrap();
    assert!(got["fleet"]["high"]["refused"].is_string());
    let set = call(&hub, &admin(), "profiles_set", bad).await.unwrap();
    assert_eq!(set["fleet"]["high"].get("refused"), None);
}
