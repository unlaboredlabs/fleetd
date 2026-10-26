//! MCP servers over a real hub and a fake node: who may change them, secrets relayed to the nodes they were sealed to
//! and never kept, a project's server replacing a global one, a launch and a changed send carrying them, and the
//! connection test relayed.
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadRef};
use fleetd_contracts::mcp_servers::{McpAgentRole, McpSessionValue};
use fleetd_contracts::node_link::{CAP_MCP_SERVERS, HubToNode, NodeToHub};
use fleetd_contracts::sessions::SessionCall;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-19T10:00:00.000Z";
const SECRET: &str = "ghp_never_on_the_hub";

fn lab() -> MachineId {
    MachineId::unchecked("lab")
}

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: lab(),
        project_id: ProjectId::unchecked("p1"),
    }
}

fn machine(hub: &Hub, id: &str) {
    let machine = serde_json::from_value(json!({
        "machineId": id, "name": id, "tags": [], "status": "online", "lastSeenAt": AT, "nodeVersion": "0.1.0",
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, None).unwrap();
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
    machine(&hub, "lab");
    (hub, home)
}

/// Links a node holding project p1 that answers MCP calls, handing each call to the test.
async fn node(hub: &Arc<Hub>) -> mpsc::UnboundedReceiver<SessionCall> {
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
    hub.link.set_capabilities(&lab(), &[CAP_MCP_SERVERS]);
    let (calls_tx, calls) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let result = match &f.call {
                SessionCall::McpSecrets { set, keep, .. } => {
                    let held: Vec<Value> = set
                        .iter()
                        .map(|s| json!({ "field": s.field, "name": s.name, "fingerprint": "5ec2e7a1" }))
                        .chain(keep.iter().map(
                            |k| json!({ "field": k.field, "name": k.name, "fingerprint": "5ec2e7a1" }),
                        ))
                        .collect();
                    json!({ "ok": { "kind": "mcp_secrets", "secrets": held } })
                }
                SessionCall::ReadFile { .. } => json!({ "ok": { "kind": "file" } }),
                SessionCall::McpTest { .. } => json!({ "ok": { "kind": "mcp_tested",
                    "server": "fake 1.0", "tools": [{ "name": "search" }] } }),
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

fn project_scope() -> Value {
    json!({ "kind": "project", "machineId": "lab", "projectId": "p1" })
}

fn github(scope: Value, header: Value) -> Value {
    json!({ "scope": scope, "name": "github", "enabled": true,
        "roles": { "lead": true, "writers": true, "reviewers": false },
        "transport": { "type": "http", "url": "https://api.example.com/mcp" },
        "headers": [header, { "kind": "plain", "name": "X-Team", "value": "core" }] })
}

/// Every text value of every row of every table.
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
                        if let rusqlite::types::ValueRef::Text(t) = row.get_ref(i)? {
                            out.push_str(&String::from_utf8_lossy(t));
                            out.push('\n');
                        }
                    }
                }
            }
            Ok(out)
        })
        .unwrap()
}

#[tokio::test]
async fn only_a_person_changes_them_and_fleetd_is_not_a_name() {
    let (hub, _home) = hub();
    let header = json!({ "kind": "plain", "name": "Authorization", "value": "x" });
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..person()
    };
    let error = call(
        &hub,
        &agent,
        "mcp_server_set",
        github(json!({ "kind": "global" }), header.clone()),
    )
    .await
    .unwrap_err();
    assert!(format!("{error:?}").contains("Only a person"), "{error:?}");
    let one_machine = Caller {
        grants: serde_json::from_value(json!([{ "role": "operate", "machines": ["lab"] }]))
            .unwrap(),
        ..person()
    };
    // A global server reaches every machine: operate on one isn't enough.
    assert!(
        call(
            &hub,
            &one_machine,
            "mcp_settings_set",
            json!({ "userServers": false })
        )
        .await
        .is_err()
    );
    // A plain header with a line break is refused at save; a secret one is refused by its node.
    for broken in ["a\r\nX-Evil: 1", "a\nb"] {
        let input = github(
            json!({ "kind": "global" }),
            json!({ "kind": "plain", "name": "Authorization", "value": broken }),
        );
        let error = call(&hub, &person(), "mcp_server_set", input)
            .await
            .unwrap_err();
        assert!(format!("{error:?}").contains("line break"), "{error:?}");
    }
    let mut fleetd = github(json!({ "kind": "global" }), header);
    fleetd["name"] = "FleetD".into();
    let error = call(&hub, &person(), "mcp_server_set", fleetd)
        .await
        .unwrap_err();
    assert!(
        format!("{error:?}").contains("fleetd's own tools server"),
        "{error:?}"
    );
}

#[tokio::test]
async fn a_secret_goes_to_its_node_and_the_hub_keeps_only_its_fingerprint() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    let boxed = sealed(SECRET);
    let out = call(
        &hub,
        &person(),
        "mcp_server_set",
        github(
            project_scope(),
            json!({ "kind": "secret", "name": "Authorization", "sealed": [{ "machineId": "lab", "sealed": boxed }] }),
        ),
    )
    .await
    .unwrap();
    let SessionCall::McpSecrets {
        scope,
        server,
        set,
        keep,
    } = calls.recv().await.unwrap()
    else {
        panic!("not mcp_secrets")
    };
    assert_eq!(
        serde_json::to_value(&scope).unwrap(),
        json!({ "kind": "project", "projectId": "p1" })
    );
    assert_eq!(server.as_str(), "github");
    assert_eq!(set.len(), 1);
    assert_eq!(set[0].sealed.as_str(), boxed);
    assert!(keep.is_empty());
    assert_eq!(
        out["server"]["headers"][0],
        json!({ "name": "Authorization", "kind": "secret",
            "sealedOn": [{ "machineId": "lab", "fingerprint": "5ec2e7a1" }] })
    );
    let rows = every_row(&hub);
    assert!(rows.contains("api.example.com"));
    assert!(!rows.contains(&boxed) && !rows.contains(SECRET));
    assert!(!out.to_string().contains(&boxed));

    // Editing the rest keeps the secret: the node is asked to keep it, and it stays recorded.
    let mut edit = github(
        project_scope(),
        json!({ "kind": "keep", "name": "Authorization" }),
    );
    edit["roles"]["reviewers"] = true.into();
    let out = call(&hub, &person(), "mcp_server_set", edit).await.unwrap();
    let SessionCall::McpSecrets { set, keep, .. } = calls.recv().await.unwrap() else {
        panic!("not mcp_secrets")
    };
    assert!(set.is_empty());
    assert_eq!(keep[0].name.as_str(), "Authorization");
    assert_eq!(
        out["server"]["headers"][0]["sealedOn"][0]["machineId"],
        "lab"
    );

    // A session of the project gets it by name, for its roles.
    let config = hub.db.mcp_servers().session_config(&project()).unwrap();
    assert!(config.user_servers);
    assert_eq!(config.servers.len(), 1);
    assert_eq!(
        config.servers[0].headers[0],
        McpSessionValue::Secret {
            name: fleetd_contracts::mcp_servers::McpValueName::unchecked("Authorization")
        }
    );
    assert!(config.servers[0].roles.has(McpAgentRole::Reviewer));

    // Removing it has the node forget its secrets.
    call(
        &hub,
        &person(),
        "mcp_server_remove",
        json!({ "scope": project_scope(), "name": "github" }),
    )
    .await
    .unwrap();
    let SessionCall::McpSecrets { set, keep, .. } = calls.recv().await.unwrap() else {
        panic!("not mcp_secrets")
    };
    assert!(set.is_empty() && keep.is_empty());
    assert!(
        hub.db
            .mcp_servers()
            .session_config(&project())
            .unwrap()
            .servers
            .is_empty()
    );
}

#[tokio::test]
async fn a_global_servers_secret_missing_on_an_offline_machine_leaves_it_out_there() {
    let (hub, _home) = hub();
    let _calls = node(&hub).await;
    machine(&hub, "laptop");
    let out = call(
        &hub,
        &person(),
        "mcp_server_set",
        github(
            json!({ "kind": "global" }),
            json!({ "kind": "secret", "name": "Authorization", "sealed": [
                { "machineId": "lab", "sealed": sealed(SECRET) },
                { "machineId": "laptop", "sealed": sealed(SECRET) },
            ] }),
        ),
    )
    .await
    .unwrap();
    assert_eq!(out["missingOn"], json!(["laptop"]));
    assert!(out["next"].as_str().unwrap().contains("laptop"), "{out}");
    let on = |m: &str| {
        hub.db
            .mcp_servers()
            .session_config(&ProjectRef {
                machine_id: MachineId::unchecked(m),
                project_id: ProjectId::unchecked("p1"),
            })
            .unwrap()
            .servers
            .len()
    };
    assert_eq!((on("lab"), on("laptop")), (1, 0));

    // Testing it on the laptop says why, without asking a node.
    let tested = call(
        &hub,
        &person(),
        "mcp_server_test",
        json!({ "scope": { "kind": "global" }, "name": "github", "machineId": "lab" }),
    )
    .await
    .unwrap();
    assert_eq!(tested["result"]["tools"], json!([{ "name": "search" }]));
    let offline = call(
        &hub,
        &person(),
        "mcp_server_test",
        json!({ "scope": { "kind": "global" }, "name": "github", "machineId": "laptop" }),
    )
    .await
    .unwrap_err();
    assert!(format!("{offline:?}").contains("offline"), "{offline:?}");
}

#[tokio::test]
async fn a_projects_server_replaces_the_global_one_and_off_ones_stay_out() {
    let (hub, _home) = hub();
    let _calls = node(&hub).await;
    let plain = json!({ "kind": "plain", "name": "Authorization", "value": "public" });
    let global = github(json!({ "kind": "global" }), plain.clone());
    call(&hub, &person(), "mcp_server_set", global)
        .await
        .unwrap();
    let mut docs = github(json!({ "kind": "global" }), plain.clone());
    docs["name"] = "docs".into();
    docs["roles"] = json!({ "lead": false, "writers": false, "reviewers": false });
    call(&hub, &person(), "mcp_server_set", docs).await.unwrap();
    let names = || -> Vec<String> {
        hub.db
            .mcp_servers()
            .session_config(&project())
            .unwrap()
            .servers
            .iter()
            .map(|s| s.name.to_string())
            .collect()
    };
    // No role chosen: nobody gets docs.
    assert_eq!(names(), ["github"]);
    // The project's own github, turned off, turns the global one off there.
    let mut own = github(project_scope(), plain);
    own["enabled"] = false.into();
    call(&hub, &person(), "mcp_server_set", own).await.unwrap();
    assert!(names().is_empty());
    call(
        &hub,
        &person(),
        "mcp_settings_set",
        json!({ "userServers": false }),
    )
    .await
    .unwrap();
    assert!(
        !hub.db
            .mcp_servers()
            .session_config(&project())
            .unwrap()
            .user_servers
    );
}

async fn launched(
    calls: &mut mpsc::UnboundedReceiver<SessionCall>,
) -> fleetd_contracts::sessions::SessionLaunch {
    loop {
        if let SessionCall::Launch(launch) = calls.recv().await.unwrap() {
            return launch;
        }
    }
}

async fn sent_mcp(
    calls: &mut mpsc::UnboundedReceiver<SessionCall>,
) -> Option<fleetd_contracts::mcp_servers::McpSessionConfig> {
    loop {
        if let SessionCall::Send { mcp, .. } = calls.recv().await.unwrap() {
            return mcp;
        }
    }
}

/// A launch carries the session's servers; a send carries them again only once they changed.
#[tokio::test]
async fn a_launch_carries_them_and_a_send_only_a_change() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    let plain = json!({ "kind": "plain", "name": "Authorization", "value": "public" });
    call(
        &hub,
        &person(),
        "mcp_server_set",
        github(json!({ "kind": "global" }), plain.clone()),
    )
    .await
    .unwrap();
    let (thread, _) = hub
        .executors
        .launch(
            &lab(),
            &crate::hub::executor::LaunchInput {
                project_id: ProjectId::unchecked("p1"),
                prompt: "go".into(),
                profile: Default::default(),
                runtime_mode: fleetd_contracts::model::RuntimeMode::FullAccess,
                title: None,
                client_request_id: "req-1".into(),
            },
            crate::hub::executor::LaunchOptions {
                workspace: None,
                role: fleetd_contracts::sessions::SessionRole::Worker,
                mcp_role: Some(McpAgentRole::Writer),
            },
        )
        .await
        .unwrap();
    let launch = launched(&mut calls).await;
    assert_eq!(launch.mcp_role, Some(McpAgentRole::Writer));
    assert_eq!(launch.mcp.unwrap().servers[0].name.as_str(), "github");
    let r = ThreadRef {
        machine_id: lab(),
        thread_id: thread,
    };
    hub.executors.send(&r, "one", "s1").await.unwrap();
    assert_eq!(sent_mcp(&mut calls).await, None);
    let mut moved = github(json!({ "kind": "global" }), plain);
    moved["transport"]["url"] = "https://api2.example.com/mcp".into();
    call(&hub, &person(), "mcp_server_set", moved)
        .await
        .unwrap();
    hub.executors.send(&r, "two", "s2").await.unwrap();
    let changed = sent_mcp(&mut calls).await.expect("the change");
    assert_eq!(
        serde_json::to_value(&changed.servers[0].transport).unwrap()["url"],
        "https://api2.example.com/mcp"
    );
    hub.executors.send(&r, "three", "s3").await.unwrap();
    assert_eq!(sent_mcp(&mut calls).await, None);

    // A plain thread a person starts gets none.
    hub.executors
        .launch(
            &lab(),
            &crate::hub::executor::LaunchInput {
                project_id: ProjectId::unchecked("p1"),
                prompt: "hi".into(),
                profile: Default::default(),
                runtime_mode: fleetd_contracts::model::RuntimeMode::FullAccess,
                title: None,
                client_request_id: "req-2".into(),
            },
            Default::default(),
        )
        .await
        .unwrap();
    let launch = launched(&mut calls).await;
    assert_eq!((launch.mcp_role, launch.mcp), (None, None));
}
