//! The reads that took over others: a list without an id and one item with it, a reset by `reset: true`, an order's
//! record and steers in `order_get`, and the notify policy in `fleetd_status`.
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::ledger::IntakeChannel;
use fleetd_contracts::steer::Steer;
use serde_json::{Value, json};

use crate::hub::api::{Caller, Hub, HubConfig, Listen, registry};
use crate::hub::leads::records::NewWorkstream;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-19T10:00:00.000Z";

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    // A file-backed hub: prompt edits are files.
    let db = HubDb::open(home.path()).unwrap();
    let hub = crate::hub::serve::build_on(db, config, ManualClock::at(1_792_000_000_000)).unwrap();
    let machine = serde_json::from_value(json!({
        "machineId": "devbox", "name": "devbox", "tags": [], "status": "online", "lastSeenAt": AT,
        "nodeVersion": "0.1.0",
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, None).unwrap();
    hub.store
        .projects_upsert_many(
            &MachineId::unchecked("devbox"),
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "app", "title": "app", "workspaceRoot": "/work/app",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    (hub, home)
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

async fn call(hub: &Arc<Hub>, tool: &str, input: Value) -> Value {
    registry()
        .call(hub, &person(), tool, input)
        .await
        .unwrap_or_else(|e| panic!("{tool}: {e:?}"))
}

#[tokio::test]
async fn a_read_lists_without_an_id_and_answers_one_with_it() {
    let (hub, _home) = hub();
    let all = call(&hub, "project_get", json!({})).await;
    assert_eq!(all["projects"][0]["projectId"], "app");
    assert!(all.get("project").is_none(), "{all}");
    let one = call(
        &hub,
        "project_get",
        json!({ "machineId": "devbox", "projectId": "app" }),
    )
    .await;
    assert_eq!(one["project"]["projectId"], "app");
    assert!(one.get("projects").is_none(), "{one}");
    assert!(
        registry()
            .call(
                &hub,
                &person(),
                "project_get",
                json!({ "projectId": "app" })
            )
            .await
            .is_err()
    );

    let prompts = call(&hub, "prompt_get", json!({})).await;
    assert!(
        prompts["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == "lead.start")
    );
    assert!(
        prompts["orphans"].is_array() && prompts.get("prompt").is_none(),
        "{prompts}"
    );
    let lead = call(&hub, "prompt_get", json!({ "id": "lead.start" })).await;
    assert_eq!(lead["prompt"]["id"], "lead.start");
    assert!(lead.get("prompts").is_none(), "{lead}");
}

#[tokio::test]
async fn prompt_set_resets_only_on_an_explicit_reset() {
    let (hub, _home) = hub();
    let id = json!({ "id": "lead.start" });
    let shipped = call(&hub, "prompt_get", id.clone()).await["prompt"]["default"]["ref"].clone();
    let edit = json!({ "id": "lead.start", "scope": "global", "text": "EDITED {{project}}" });
    let edited = call(&hub, "prompt_set", edit).await["ref"].clone();
    assert_eq!(
        call(&hub, "prompt_get", id.clone()).await["prompt"]["scope"],
        "global"
    );
    // A forgotten text is refused and leaves the person's edit in place.
    for forgot in [
        json!({ "id": "lead.start", "scope": "global" }),
        json!({ "id": "lead.start", "scope": "global", "text": null }),
    ] {
        let refused = registry()
            .call(&hub, &person(), "prompt_set", forgot)
            .await
            .unwrap_err();
        assert!(
            format!("{refused:?}").contains("No text to save"),
            "{refused:?}"
        );
    }
    let kept = call(&hub, "prompt_get", id.clone()).await;
    assert_eq!(kept["prompt"]["scope"], "global");
    assert_eq!(kept["prompt"]["effective"]["ref"], edited);

    // A dry run of the reset answers what would be in effect and writes nothing.
    let dry = call(
        &hub,
        "prompt_set",
        json!({ "id": "lead.start", "scope": "global", "reset": true, "dryRun": true }),
    )
    .await;
    assert_eq!(dry["ref"], shipped);
    assert_eq!(dry["next"], "Not reset: dryRun.");
    let kept = call(&hub, "prompt_get", id.clone()).await;
    assert_eq!(kept["prompt"]["scope"], "global");
    assert_eq!(kept["prompt"]["effective"]["ref"], edited);

    let reset = call(
        &hub,
        "prompt_set",
        json!({ "id": "lead.start", "scope": "global", "reset": true }),
    )
    .await;
    assert_eq!(reset["ref"], shipped);
    let after = call(&hub, "prompt_get", id).await;
    assert_eq!(after["prompt"]["scope"], "default");
    assert_eq!(after["prompt"]["effective"]["ref"], shipped);
}

#[tokio::test]
async fn order_get_carries_the_order_s_record_and_steers() {
    let (hub, _home) = hub();
    let r = ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("app"),
    };
    let (w, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: r,
            title: "Share card".into(),
            text: "add a share card".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
            playbook: None,
        })
        .unwrap();
    let id = w.workstream_id.as_str();
    let steer: Steer = serde_json::from_value(json!({
        "id": "S1", "target": { "workstreamId": id }, "workstreamId": id,
        "thread": { "machineId": "devbox", "threadId": "t1" }, "runId": "r1",
        "by": { "kind": "human", "keyName": "desk" }, "mode": "queue", "text": "make it blue",
        "stage": "queued", "queuedAt": AT,
    }))
    .unwrap();
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO steers (workstream_id, machine_id, thread_id, run_id, by, mode, stage, queued_ms, data)
                 VALUES (?1, 'devbox', 't1', 'r1', 'human', 'queue', 'queued', 0, ?2)",
                rusqlite::params![id, serde_json::to_string(&steer).unwrap()],
            )?;
            Ok(())
        })
        .unwrap();
    let order = call(&hub, "order_get", json!({ "workstreamId": id })).await;
    assert_eq!(order["workstream"]["title"], "Share card");
    assert_eq!(order["decisions"], json!([]));
    assert_eq!(order["steers"][0]["id"], "S1");
    assert_eq!(order["steers"][0]["text"], "make it blue");
}

#[tokio::test]
async fn fleetd_status_says_when_to_notify() {
    let (hub, _home) = hub();
    let status = call(&hub, "fleetd_status", json!({})).await;
    assert_eq!(status["notify"]["coalesceSec"], 1200);
    assert!(status["notify"]["quiet"].is_array(), "{status}");
}
