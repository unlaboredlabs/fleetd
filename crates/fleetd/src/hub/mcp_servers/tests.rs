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

/// An owner's or admin's device: admin on every machine.
fn person() -> Caller {
    Caller {
        grants: serde_json::from_value(json!([{ "role": "admin", "machines": "*" }])).unwrap(),
        ..member()
    }
}

/// A member's device: operate on every machine, admin nowhere.
fn member() -> Caller {
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
    // A global server, and whether agents get a person's own, reach every teammate's agents: a member's device is
    // refused them (D209).
    for (tool, input) in [
        (
            "mcp_server_set",
            github(json!({ "kind": "global" }), header.clone()),
        ),
        (
            "mcp_server_remove",
            json!({ "scope": { "kind": "global" }, "name": "github" }),
        ),
        ("mcp_settings_set", json!({ "userServers": false })),
    ] {
        let error = call(&hub, &member(), tool, input).await.unwrap_err();
        assert!(
            format!("{error:?}").contains("only the hub's owners and admins"),
            "{tool}: {error:?}"
        );
    }
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
    // Each tool comes back with what the hub's tool policy does with it: a custom server's tool asks.
    assert_eq!(
        tested["result"]["tools"],
        json!([{ "name": "search", "policy": "ask" }])
    );
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
                system_prompt: None,
                profile: fleetd_contracts::effort::ProfileName::legacy(),
                runtime_mode: fleetd_contracts::model::RuntimeMode::FullAccess,
                title: None,
                client_request_id: "req-1".into(),
            },
            crate::hub::executor::LaunchOptions {
                workspace: None,
                role: fleetd_contracts::sessions::SessionRole::Worker,
                mcp_role: Some(McpAgentRole::Writer),
                ..Default::default()
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
                system_prompt: None,
                profile: fleetd_contracts::effort::ProfileName::legacy(),
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

/// A memory refresh's launch: its memory tools only, fleetd's MCP server alone, and no send ever brings it the
/// project's servers.
#[tokio::test]
async fn a_refresh_launch_allows_only_the_memory_tools_and_keeps_its_own_servers() {
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
                prompt: "tidy".into(),
                system_prompt: None,
                profile: fleetd_contracts::effort::ProfileName::legacy(),
                runtime_mode: fleetd_contracts::model::RuntimeMode::FullAccess,
                title: None,
                client_request_id: "req-memory".into(),
            },
            crate::hub::memory::refresh::launch_options(),
        )
        .await
        .unwrap();
    let launch = launched(&mut calls).await;
    // The memory tools and nothing else: the node refuses the rest.
    assert!(launch.allowed_only);
    assert_eq!(
        launch.allowed_tools,
        crate::hub::memory::refresh::allowed_tools()
    );
    let mcp = launch.mcp.unwrap();
    assert!(!mcp.user_servers && mcp.servers.is_empty(), "{mcp:?}");
    let r = ThreadRef {
        machine_id: lab(),
        thread_id: thread,
    };
    let mut moved = github(json!({ "kind": "global" }), plain);
    moved["transport"]["url"] = "https://api2.example.com/mcp".into();
    call(&hub, &person(), "mcp_server_set", moved)
        .await
        .unwrap();
    hub.executors.send(&r, "go on", "s1").await.unwrap();
    assert_eq!(sent_mcp(&mut calls).await, None);
}

/// A Navi's integration (here a custom HTTP server with a key) as the app's connect screen saves it.
fn integration(key: Value) -> Value {
    json!({ "scope": project_scope(), "name": "crm", "enabled": true,
        "roles": { "lead": true, "writers": false, "reviewers": false },
        "transport": { "type": "http", "url": "https://mcp.example.com/mcp" },
        "headers": [key],
        "integration": {} })
}

/// Marks p1 a Navi, as creating one from the app does: a row in `assistants`, while the node's report of the project
/// keeps no kind.
fn make_navi(hub: &Hub) {
    hub.db
        .with(|c| {
            crate::hub::navi::store::put(
                c,
                &project(),
                &fleetd_contracts::model::ProjectCreator {
                    key_id: "k1".into(),
                    name: "desk".into(),
                },
                None,
                0,
            )?;
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn an_integration_connects_to_a_navi_only() {
    let (hub, _home) = hub();
    let _calls = node(&hub).await;
    let plain = json!({ "kind": "plain", "name": "X-Team", "value": "core" });
    let error = call(
        &hub,
        &person(),
        "mcp_server_set",
        integration(plain.clone()),
    )
    .await
    .unwrap_err();
    let said = format!("{error:?}");
    assert!(said.contains("isn't a Navi"), "{said}");
    assert!(said.contains("under MCP servers"), "{said}");
    for word in ["lead", "ntegration", "read-only"] {
        assert!(!said.contains(word), "{word}: {said}");
    }
    let mut global = integration(plain.clone());
    global["scope"] = json!({ "kind": "global" });
    assert!(
        call(&hub, &person(), "mcp_server_set", global)
            .await
            .is_err()
    );
    // The same server without an integration is a plain MCP server, as before.
    let mut bare = integration(plain.clone());
    bare.as_object_mut().unwrap().remove("integration");
    call(&hub, &person(), "mcp_server_set", bare).await.unwrap();
    make_navi(&hub);
    call(&hub, &person(), "mcp_server_set", integration(plain))
        .await
        .unwrap();
}

/// The person's case: a Navi made in the app (so only `assistants` says it is one), and a URL server with its
/// Authorization key, saved from the Navi's Integrations as the app sends it. It once failed as "not a Navi".
#[tokio::test]
async fn a_navi_made_in_the_app_takes_a_url_server_with_its_key() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    make_navi(&hub);
    let mut server = integration(json!({ "kind": "secret", "name": "Authorization",
        "sealed": [{ "machineId": "lab", "sealed": sealed("Bearer fake-key-for-a-test") }] }));
    server["name"] = "xaq".into();
    server["transport"]["url"] = "https://macbook.example.ts.net/mcp".into();
    let saved = call(&hub, &person(), "mcp_server_set", server)
        .await
        .unwrap();
    assert_eq!(saved["server"]["name"], "xaq");
    assert!(matches!(
        calls.recv().await.unwrap(),
        SessionCall::McpSecrets { ref set, .. } if set.len() == 1
    ));
    let tested = call(
        &hub,
        &person(),
        "mcp_server_test",
        json!({ "scope": project_scope(), "name": "xaq" }),
    )
    .await
    .unwrap();
    assert_eq!(tested["machineId"], "lab");
    assert_eq!(tested["result"].get("error"), None, "{tested}");
}

#[tokio::test]
async fn an_integration_connects_with_its_key_sealed_and_revoking_forgets_the_key() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    make_navi(&hub);
    const KEY: &str = "Bearer crm_never_on_the_hub_0123456789";
    let saved = call(
        &hub,
        &person(),
        "mcp_server_set",
        integration(json!({ "kind": "secret", "name": "Authorization",
            "sealed": [{ "machineId": "lab", "sealed": sealed(KEY) }] })),
    )
    .await
    .unwrap();
    assert_eq!(saved["server"]["integration"], json!({}));
    assert!(matches!(
        calls.recv().await.unwrap(),
        SessionCall::McpSecrets { ref set, .. } if set.len() == 1
    ));

    // Connected: the app reads it back as an integration, with the key only as a fingerprint on Navi's machine.
    let got = call(
        &hub,
        &person(),
        "mcp_servers_get",
        json!({ "project": { "machineId": "lab", "projectId": "p1" } }),
    )
    .await
    .unwrap();
    let server = &got["project"][0];
    assert_eq!(server["integration"], json!({}));
    assert_eq!(server["headers"][0]["sealedOn"][0]["machineId"], "lab");
    assert!(server["headers"][0].get("value").is_none());
    for text in [got.to_string(), saved.to_string(), every_row(&hub)] {
        assert!(!text.contains("crm_never_on_the_hub"), "{text}");
    }
    // The test lists each tool with what the policy does with it.
    let tested = call(
        &hub,
        &person(),
        "mcp_server_test",
        json!({ "scope": project_scope(), "name": "crm" }),
    )
    .await
    .unwrap();
    assert!(
        tested["result"]["tools"][0]["policy"].is_string(),
        "{tested}"
    );
    let _ = calls.recv().await;

    // Revoked: gone from the hub, and the node is told to forget the key.
    call(
        &hub,
        &person(),
        "mcp_server_remove",
        json!({ "scope": project_scope(), "name": "crm" }),
    )
    .await
    .unwrap();
    assert!(matches!(
        calls.recv().await.unwrap(),
        SessionCall::McpSecrets { ref set, ref keep, .. } if set.is_empty() && keep.is_empty()
    ));
    let after = call(
        &hub,
        &person(),
        "mcp_servers_get",
        json!({ "project": { "machineId": "lab", "projectId": "p1" } }),
    )
    .await
    .unwrap();
    assert_eq!(after["project"], json!([]));
}

/// A Navi's lead launches with its integrations' reads allowed, so it never asks for them; its sends still ask. Other
/// sessions get no such rules.
#[tokio::test]
async fn a_navis_lead_launches_with_its_integrations_reads_allowed() {
    let (hub, _home) = hub();
    let mut calls = node(&hub).await;
    let plain = json!({ "kind": "plain", "name": "Authorization", "value": "public" });
    // What reads is what the person marked as reading; an older app's kind is no matter.
    let mut docs = integration(plain);
    docs["name"] = "docs".into();
    docs["integration"] = json!({ "kind": "custom", "readTools": ["search_pages"] });
    make_navi(&hub);
    call(&hub, &person(), "mcp_server_set", docs).await.unwrap();
    for (n, role) in [
        (1, fleetd_contracts::sessions::SessionRole::Assistant),
        (2, fleetd_contracts::sessions::SessionRole::Lead),
    ] {
        hub.executors
            .launch(
                &lab(),
                &crate::hub::executor::LaunchInput {
                    project_id: ProjectId::unchecked("p1"),
                    prompt: "hi".into(),
                    system_prompt: None,
                    profile: fleetd_contracts::effort::ProfileName::legacy(),
                    runtime_mode: fleetd_contracts::model::RuntimeMode::ApprovalRequired,
                    title: None,
                    client_request_id: format!("navi-{n}"),
                },
                crate::hub::executor::LaunchOptions {
                    role,
                    mcp_role: Some(McpAgentRole::Lead),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let launch = launched(&mut calls).await;
        let reads = launch
            .allowed_tools
            .iter()
            .any(|t| t == "mcp__docs__search_pages");
        assert_eq!(reads, n == 1, "{role:?}: {:?}", launch.allowed_tools);
        assert!(
            !launch
                .allowed_tools
                .iter()
                .any(|t| t.contains("send_message"))
        );
    }
}

/// A server of an older hub's built-in integration, dropped by the upgrade: once its node is online, the node is told
/// to forget its token, and is asked no more.
#[tokio::test]
async fn the_secrets_of_a_server_the_upgrade_dropped_are_forgotten_once_its_node_is_online() {
    let (hub, _home) = hub();
    hub.db
        .with(|c| {
            c.execute_batch(
                "INSERT INTO mcp_secret_forgets (machine_id, project_id, name) VALUES ('lab', 'p1', 'docs');
                 INSERT INTO mcp_secret_forgets (machine_id, project_id, name) VALUES ('away', 'p2', 'docs');",
            )?;
            Ok(())
        })
        .unwrap();
    let mut calls = node(&hub).await;
    super::tools::forget_queued(&hub).await;
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
        (serde_json::to_value(&scope).unwrap(), server.as_str()),
        (json!({ "kind": "project", "projectId": "p1" }), "docs")
    );
    assert!(set.is_empty() && keep.is_empty());
    // The machine still offline keeps its place in the queue.
    let left: Vec<String> = hub
        .db
        .mcp_servers()
        .forgets()
        .unwrap()
        .into_iter()
        .map(|(m, _, _)| m.to_string())
        .collect();
    assert_eq!(left, ["away"]);
}
