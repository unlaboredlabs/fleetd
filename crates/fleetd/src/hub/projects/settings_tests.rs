//! A project's settings over a real hub and a fake node: the env tools relay to the node and keep no secret value,
//! the name and keepWorktrees save, the node's worktrees show, and a delete asks the node to remove the worktrees.
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::node_link::{CAP_PROJECT_SETTINGS, HubToNode, NodeToHub};
use fleetd_contracts::sessions::SessionCall;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-19T10:00:00.000Z";
const SECRET: &str = "sk_live_do_not_store";

fn lab() -> MachineId {
    MachineId::unchecked("lab")
}

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: lab(),
        project_id: ProjectId::unchecked("p1"),
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
        ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    let machine = serde_json::from_value(json!({
        "machineId": "lab", "name": "lab", "tags": [], "status": "online", "lastSeenAt": AT, "nodeVersion": "0.1.0",
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, None).unwrap();
    (hub, home)
}

/// Links a node holding project p1 and answers its calls as a node of this version would, handing each to the test.
async fn node(hub: &Arc<Hub>, capable: bool) -> mpsc::UnboundedReceiver<SessionCall> {
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
    let frame = |v: Value| {
        hub.executors
            .handle_frame(&lab(), serde_json::from_value::<NodeToHub>(v).unwrap())
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
    hub.executors.await_live(&lab()).await;
    hub.link.set_capabilities(
        &lab(),
        if capable {
            &[CAP_PROJECT_SETTINGS]
        } else {
            &[]
        },
    );
    let (calls_tx, calls) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let result = match &f.call {
                SessionCall::ProjectEnv { set, .. } => {
                    let secrets: Vec<Value> = set
                        .iter()
                        .filter_map(|v| match v {
                            fleetd_contracts::project_settings::EnvVarSet::Secret {
                                name, ..
                            } => Some(json!({ "name": name, "fingerprint": "5ec2e7a1" })),
                            _ => None,
                        })
                        .collect();
                    json!({ "ok": { "kind": "project_env", "secrets": secrets } })
                }
                SessionCall::ProjectWorktrees { .. } => {
                    json!({ "ok": { "kind": "project_worktrees",
                    "dir": "/home/w/.fleetd/node/worktrees/p1", "baseBranch": "main",
                    "worktrees": [{ "sessionId": "t1", "path": "/home/w/.fleetd/node/worktrees/p1/t1",
                        "branch": "fleetd/T1-x", "uncommitted": true }] } })
                }
                _ => json!({ "ok": { "kind": "done" } }),
            };
            let reply = json!({ "t": "session_reply", "id": f.id, "result": result });
            hub.executors
                .handle_frame(&lab(), serde_json::from_value::<NodeToHub>(reply).unwrap());
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

fn agent() -> Caller {
    Caller {
        kind: Some(KeyKind::Agent),
        ..person()
    }
}

async fn call(
    hub: &Arc<Hub>,
    caller: &Caller,
    tool: &str,
    input: Value,
) -> Result<Value, CallError> {
    registry().call(hub, caller, tool, input).await
}

fn sealed(value: &str) -> String {
    let secret = crypto_box::SecretKey::generate(&mut crypto_box::aead::OsRng);
    let boxed = secret
        .public_key()
        .seal(&mut crypto_box::aead::OsRng, value.as_bytes())
        .unwrap();
    B64.encode(boxed)
}

/// Every value of every row of every table of the hub's database, as text.
fn every_row(hub: &Hub) -> String {
    hub.db
        .with(|c| {
            let tables: Vec<String> = c
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut out = String::new();
            for table in tables {
                let mut stmt = c.prepare(&format!("SELECT * FROM \"{table}\""))?;
                let n = stmt.column_count();
                let mut rows = stmt.query([])?;
                while let Some(row) = rows.next()? {
                    for i in 0..n {
                        let cell = match row.get_ref(i)? {
                            rusqlite::types::ValueRef::Text(t)
                            | rusqlite::types::ValueRef::Blob(t) => {
                                String::from_utf8_lossy(t).into_owned()
                            }
                            other => format!("{other:?}"),
                        };
                        out.push_str(&cell);
                        out.push('\n');
                    }
                }
            }
            Ok(out)
        })
        .unwrap()
}

#[tokio::test]
async fn env_vars_go_to_the_node_and_the_hub_keeps_no_secret_value() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, true).await;
    let box_text = sealed(SECRET);
    let input = json!({ "machineId": "lab", "projectId": "p1", "set": [
        { "kind": "plain", "name": "API_URL", "value": "https://staging.example" },
        { "kind": "secret", "name": "STRIPE_KEY", "sealed": box_text },
    ] });

    let refused = call(&hub, &agent(), "project_env_set", input.clone()).await;
    assert!(
        matches!(&refused, Err(CallError::Tool(e)) if e.code == fleetd_contracts::mcp::ErrorCode::Forbidden),
        "{refused:?}"
    );

    let out = call(&hub, &person(), "project_env_set", input)
        .await
        .unwrap();
    let SessionCall::ProjectEnv { set, remove, .. } = calls.recv().await.unwrap() else {
        panic!("not project_env")
    };
    assert!(remove.is_empty());
    // The node got the box exactly as sealed.
    assert!(serde_json::to_string(&set).unwrap().contains(&box_text));
    assert_eq!(
        out["env"],
        json!([
            { "name": "API_URL", "kind": "plain", "value": "https://staging.example", "bytes": 23, "updatedAt": out["env"][0]["updatedAt"] },
            // A secret's size is its sealed box's, less the seal: the hub never sees the value.
            { "name": "STRIPE_KEY", "kind": "secret", "fingerprint": "5ec2e7a1", "bytes": SECRET.len(), "updatedAt": out["env"][1]["updatedAt"] },
        ])
    );
    let settings = call(
        &hub,
        &person(),
        "project_settings_get",
        json!({ "machineId": "lab", "projectId": "p1" }),
    )
    .await
    .unwrap();
    assert_eq!(settings["settings"]["env"], out["env"]);
    // Neither the value nor its box is anywhere in the hub: no row, no event, no answer.
    let rows = every_row(&hub);
    assert!(rows.contains("https://staging.example"));
    assert!(rows.contains("5ec2e7a1"));
    for text in [SECRET, box_text.as_str()] {
        assert!(!rows.contains(text));
        assert!(!out.to_string().contains(text));
        assert!(!settings.to_string().contains(text));
    }

    // A plain value replaces the secret; a removal drops it.
    call(&hub, &person(), "project_env_set", json!({ "machineId": "lab", "projectId": "p1",
        "set": [{ "kind": "plain", "name": "STRIPE_KEY", "value": "pk_test" }], "remove": ["API_URL"] }))
    .await
    .unwrap();
    let env = hub.db.project_settings().env(&project()).unwrap();
    assert_eq!(env.len(), 1);
    assert_eq!(env[0].fingerprint, None);
    assert_eq!(env[0].value.as_ref().unwrap().as_str(), "pk_test");

    let reserved = call(
        &hub,
        &person(),
        "project_env_set",
        json!({ "machineId": "lab", "projectId": "p1",
        "set": [{ "kind": "plain", "name": "FLEETD_THREAD_ID", "value": "x" }] }),
    )
    .await;
    assert!(
        matches!(reserved, Err(CallError::Invalid(_))),
        "{reserved:?}"
    );
}

#[tokio::test]
async fn an_old_or_offline_node_takes_no_env_and_says_why_its_worktrees_are_unknown() {
    let (hub, _home) = hub();
    let input = json!({ "machineId": "lab", "projectId": "p1",
        "set": [{ "kind": "plain", "name": "A", "value": "1" }] });
    let _calls = node(&hub, false).await;
    let Err(CallError::Tool(old)) = call(&hub, &person(), "project_env_set", input).await else {
        panic!("an old node took it")
    };
    assert!(old.message.contains("too old"), "{}", old.message);
    let settings = call(
        &hub,
        &person(),
        "project_settings_get",
        json!({ "machineId": "lab", "projectId": "p1" }),
    )
    .await
    .unwrap();
    assert!(settings["settings"]["worktrees"].is_null());
    assert!(
        settings["settings"]["worktreesUnknown"]
            .as_str()
            .unwrap()
            .contains("update fleetd")
    );
    let remove = call(
        &hub,
        &person(),
        "project_remove",
        json!({ "machineId": "lab", "projectId": "p1", "removeWorktrees": true }),
    )
    .await;
    assert!(matches!(remove, Err(CallError::Tool(_))), "{remove:?}");
    assert!(
        hub.db
            .project_settings()
            .env(&project())
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn the_name_and_keep_worktrees_save_and_a_delete_removes_the_worktrees_and_the_settings() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, true).await;
    let get = json!({ "machineId": "lab", "projectId": "p1" });
    let settings = call(&hub, &person(), "project_settings_get", get.clone())
        .await
        .unwrap();
    let s = &settings["settings"];
    assert_eq!(s["title"], "app");
    assert_eq!(s["keepWorktrees"], false);
    assert_eq!(s["worktrees"]["baseBranch"], "main");
    assert_eq!(s["worktrees"]["worktrees"][0]["uncommitted"], true);
    assert!(matches!(
        calls.recv().await,
        Some(SessionCall::ProjectWorktrees { .. })
    ));

    let set = call(&hub, &person(), "project_settings_set",
        json!({ "machineId": "lab", "projectId": "p1", "title": "Storefront", "keepWorktrees": true }))
    .await
    .unwrap();
    assert_eq!(set["settings"]["title"], "Storefront");
    assert_eq!(set["settings"]["keepWorktrees"], true);
    let Some(SessionCall::ProjectUpsert {
        title,
        workspace_root,
        ..
    }) = calls.recv().await
    else {
        panic!("no rename")
    };
    assert_eq!(
        (title.as_str(), workspace_root.as_str()),
        ("Storefront", "/work/app")
    );
    assert!(
        hub.db
            .project_settings()
            .keep_worktrees(&project())
            .unwrap()
    );
    // Medium stays on, its default, for a row keepWorktrees made.
    assert!(hub.leads.records.medium_allowed(&project()).unwrap());

    call(
        &hub,
        &person(),
        "project_env_set",
        json!({ "machineId": "lab", "projectId": "p1",
        "set": [{ "kind": "plain", "name": "A", "value": "1" }] }),
    )
    .await
    .unwrap();
    call(
        &hub,
        &person(),
        "project_remove",
        json!({ "machineId": "lab", "projectId": "p1", "removeWorktrees": true }),
    )
    .await
    .unwrap();
    let removed = loop {
        if let Some(SessionCall::ProjectRemove {
            remove_worktrees, ..
        }) = calls.recv().await
        {
            break remove_worktrees;
        }
    };
    assert!(removed);
    // The node's project_removed: the hub forgets the project and its settings with it.
    hub.store.project_remove(&project()).unwrap();
    assert!(
        !hub.db
            .project_settings()
            .keep_worktrees(&project())
            .unwrap()
    );
    assert!(
        hub.db
            .project_settings()
            .env(&project())
            .unwrap()
            .is_empty()
    );
}

/// A project's values together stay under 512 KiB, secrets counted by their sealed size: the hub refuses a change past
/// it, naming the total, and the node is never asked.
#[tokio::test]
async fn a_change_past_the_projects_total_is_refused_before_the_node_sees_it() {
    use fleetd_contracts::project_settings::ENV_VALUE_MAX_BYTES;
    let (hub, _home) = hub();
    let mut calls = node(&hub, true).await;
    let big = "x".repeat(ENV_VALUE_MAX_BYTES);
    let set = |names: std::ops::Range<usize>| -> Vec<Value> {
        names
            .map(|i| json!({ "kind": "plain", "name": format!("BIG_{i}"), "value": big }))
            .collect()
    };
    // 7 plain values of 64 KiB and a 64 KiB secret: exactly 512 KiB.
    let mut first = set(0..7);
    first.push(json!({ "kind": "secret", "name": "KEY", "sealed": sealed(&"k".repeat(ENV_VALUE_MAX_BYTES)) }));
    call(
        &hub,
        &person(),
        "project_env_set",
        json!({ "machineId": "lab", "projectId": "p1", "set": first }),
    )
    .await
    .unwrap();
    assert!(matches!(
        calls.recv().await,
        Some(SessionCall::ProjectEnv { .. })
    ));

    let Err(CallError::Tool(over)) = call(&hub, &person(), "project_env_set",
        json!({ "machineId": "lab", "projectId": "p1", "set": [{ "kind": "plain", "name": "ONE_MORE", "value": "x" }] }))
    .await
    else {
        panic!("a value past the total was taken")
    };
    assert_eq!(
        over.message,
        "A project's variables take at most 512 KiB together; these would take 513 KiB."
    );
    // Replacing one keeps the total: taken.
    call(&hub, &person(), "project_env_set",
        json!({ "machineId": "lab", "projectId": "p1", "set": [{ "kind": "plain", "name": "BIG_0", "value": "small" }] }))
    .await
    .unwrap();
    let next = calls.recv().await;
    let Some(SessionCall::ProjectEnv { set, .. }) = next else {
        panic!("{next:?}")
    };
    assert_eq!(
        set[0].name().as_str(),
        "BIG_0",
        "the refused change never reached the node"
    );
}
