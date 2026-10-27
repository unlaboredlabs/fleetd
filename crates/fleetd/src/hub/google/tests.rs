//! A Navi's Google connection over a real hub and a fake node: the client's secret relayed and never kept, an account
//! connected only to a Navi with the code going to its node, its lead getting the native server, the node saying when
//! it lapsed, and disconnect revoking there.
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::google::{GoogleAnswer, GoogleCall};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::mcp_servers::McpTransport;
use fleetd_contracts::node_link::{CAP_GOOGLE, HubToNode, NodeToHub};
use fleetd_contracts::sessions::SessionCall;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-19T10:00:00.000Z";
const SEALED: &str =
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+Pw==";
const CLIENT: &str = "123-abc.apps.googleusercontent.com";
const VERIFIER: &str = "verifier-verifier-verifier-verifier-verifier-1";

fn lab() -> MachineId {
    MachineId::unchecked("lab")
}

fn navi() -> ProjectRef {
    ProjectRef {
        machine_id: lab(),
        project_id: ProjectId::unchecked("ana"),
    }
}

fn code_project() -> ProjectRef {
    ProjectRef {
        machine_id: lab(),
        project_id: ProjectId::unchecked("app"),
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
    // Navi core keeps its Navis here; this hub's `ana` is one, `app` a project of code.
    hub.db
        .with(|c| {
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS assistants (machine_id TEXT, project_id TEXT, archived_ms INTEGER);
                 INSERT INTO assistants VALUES ('lab', 'ana', NULL);",
            )?;
            Ok(())
        })
        .unwrap();
    (hub, home)
}

/// Links a node holding `ana` and `app` that answers Google calls as a node would, handing each call to the test.
/// `lapsed`: what it says when asked for an account's status.
async fn node(hub: &Arc<Hub>, lapsed: Option<&'static str>) -> mpsc::UnboundedReceiver<GoogleCall> {
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
    let projects = json!([
        { "projectId": "ana", "title": "Ana", "workspaceRoot": "/n/navi/ana", "updatedAt": AT },
        { "projectId": "app", "title": "app", "workspaceRoot": "/work/app", "updatedAt": AT },
    ]);
    frame(
        json!({ "t": "machine_event", "seq": 1, "at": AT, "event": { "type": "snapshot",
        "projects": projects, "sessions": [] } }),
    );
    frame(
        json!({ "t": "session_reply", "id": subscribe.id, "result": { "ok": { "kind": "done" } } }),
    );
    hub.executors.await_live(&lab()).await;
    hub.link.set_capabilities(&lab(), &[CAP_GOOGLE]);
    let (calls_tx, calls) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let SessionCall::Google { call } = &f.call else {
                continue;
            };
            let answer = match call {
                GoogleCall::ClientSet { .. } => GoogleAnswer::ClientSaved {
                    fingerprint: Some(fleetd_contracts::secrets::SecretFingerprint::unchecked(
                        "5ec2e7a1",
                    )),
                },
                GoogleCall::ClientTest => {
                    GoogleAnswer::ClientTested(fleetd_contracts::google::GoogleClientCheck {
                        ok: true,
                        problem: None,
                    })
                }
                GoogleCall::Connect { .. } => GoogleAnswer::Connected {
                    email: fleetd_contracts::prim::Line::new("ana@example.com").unwrap(),
                    scopes: vec![fleetd_contracts::prim::Line::new("openid").unwrap()],
                },
                GoogleCall::Status { .. } => GoogleAnswer::Status {
                    connected: true,
                    lapsed: lapsed.map(str::to_owned),
                },
                GoogleCall::Disconnect { .. } => GoogleAnswer::Disconnected { revoked: true },
            };
            let reply = json!({ "t": "session_reply", "id": f.id,
                "result": { "ok": { "kind": "google", "answer": answer } } });
            hub.executors
                .handle_frame(&lab(), serde_json::from_value::<NodeToHub>(reply).unwrap());
            let _ = calls_tx.send(call.clone());
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

fn refused(result: Result<Value, CallError>) -> String {
    match result {
        Err(e) => format!("{e:?}"),
        Ok(v) => panic!("not refused: {v}"),
    }
}

async fn with_client(hub: &Arc<Hub>) {
    call(
        hub,
        &person(),
        "google_client_set",
        json!({ "clientId": CLIENT, "sealed": [{ "machineId": "lab", "sealed": SEALED }] }),
    )
    .await
    .unwrap();
}

fn connect_input(project: &ProjectRef) -> Value {
    json!({ "project": project, "code": "4/0Ab-code", "codeVerifier": VERIFIER,
            "redirectUri": "http://127.0.0.1:53682/callback" })
}

#[tokio::test]
async fn the_client_secret_goes_to_the_node_and_the_hub_keeps_its_fingerprint() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, None).await;
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..person()
    };
    let input = json!({ "clientId": CLIENT, "sealed": [{ "machineId": "lab", "sealed": SEALED }] });
    let why = refused(call(&hub, &agent, "google_client_set", input.clone()).await);
    assert!(why.contains("Only a person"), "{why}");

    let saved = call(&hub, &person(), "google_client_set", input)
        .await
        .unwrap();
    assert_eq!(saved["client"]["clientId"], CLIENT);
    assert_eq!(
        saved["client"]["sealedOn"],
        json!([{ "machineId": "lab", "fingerprint": "5ec2e7a1" }])
    );
    let GoogleCall::ClientSet { client_id, sealed } = calls.recv().await.unwrap() else {
        panic!("not a client_set")
    };
    assert_eq!(client_id.as_str(), CLIENT);
    assert_eq!(sealed.unwrap().as_str(), SEALED);
    // The hub keeps no box of the secret anywhere.
    let rows = hub
        .db
        .with(|c| {
            Ok(c.query_row("SELECT data FROM google_client", [], |r| {
                r.get::<_, String>(0)
            })?)
        })
        .unwrap();
    assert!(!rows.contains(SEALED));

    let tested = call(&hub, &person(), "google_client_test", json!({}))
        .await
        .unwrap();
    assert_eq!(tested["check"]["ok"], true);
    let got = call(&hub, &person(), "google_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["client"]["clientId"], CLIENT);
    assert_eq!(got["redirect"], "http://127.0.0.1");
    assert!(
        got["scopes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s == "https://www.googleapis.com/auth/gmail.compose")
    );
}

#[tokio::test]
async fn only_a_navi_connects_and_its_code_goes_to_its_node() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, None).await;
    let why = refused(call(&hub, &person(), "google_connect", connect_input(&navi())).await);
    assert!(why.contains("no Google OAuth client"), "{why}");
    with_client(&hub).await;
    calls.recv().await.unwrap();

    let why = refused(
        call(
            &hub,
            &person(),
            "google_connect",
            connect_input(&code_project()),
        )
        .await,
    );
    assert!(why.contains("Google connects only to a Navi"), "{why}");

    let connected = call(&hub, &person(), "google_connect", connect_input(&navi()))
        .await
        .unwrap();
    assert_eq!(connected["account"]["email"], "ana@example.com");
    let GoogleCall::Connect {
        project_id,
        code,
        code_verifier,
        redirect_uri,
        in_use,
    } = calls.recv().await.unwrap()
    else {
        panic!("not a connect")
    };
    assert!(in_use.is_empty());
    assert_eq!(project_id.as_str(), "ana");
    assert_eq!(code.as_str(), "4/0Ab-code");
    assert_eq!(code_verifier.as_str(), VERIFIER);
    assert_eq!(redirect_uri.as_str(), "http://127.0.0.1:53682/callback");

    // Its lead gets the native server; the project of code doesn't.
    let config = hub.db.mcp_servers().session_config(&navi()).unwrap();
    let google = config
        .servers
        .iter()
        .find(|s| s.name.as_str() == "google")
        .unwrap();
    assert!(google.roles.lead && !google.roles.writers && !google.roles.reviewers);
    assert_eq!(
        google.transport,
        McpTransport::Stdio {
            command: fleetd_contracts::mcp_servers::McpArg::unchecked("fleetd"),
            args: vec![fleetd_contracts::mcp_servers::McpArg::unchecked(
                "google-mcp"
            )],
        }
    );
    let other = hub
        .db
        .mcp_servers()
        .session_config(&code_project())
        .unwrap();
    assert!(other.servers.iter().all(|s| s.name.as_str() != "google"));
}

#[tokio::test]
async fn a_lapsed_connection_shows_as_lapsed() {
    let (hub, _home) = hub();
    let _calls = node(&hub, Some("Token has been expired or revoked.")).await;
    with_client(&hub).await;
    call(&hub, &person(), "google_connect", connect_input(&navi()))
        .await
        .unwrap();
    let got = call(&hub, &person(), "google_get", json!({ "project": navi() }))
        .await
        .unwrap();
    assert_eq!(got["account"]["email"], "ana@example.com");
    assert_eq!(
        got["account"]["lapsed"],
        "Token has been expired or revoked."
    );
}

#[tokio::test]
async fn disconnect_revokes_on_the_node_and_the_lead_loses_the_server() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, None).await;
    with_client(&hub).await;
    call(&hub, &person(), "google_connect", connect_input(&navi()))
        .await
        .unwrap();
    calls.recv().await.unwrap();
    calls.recv().await.unwrap();

    let gone = call(
        &hub,
        &person(),
        "google_disconnect",
        json!({ "project": navi() }),
    )
    .await
    .unwrap();
    assert_eq!(gone["revoked"], true);
    let GoogleCall::Disconnect { project_id, revoke } = calls.recv().await.unwrap() else {
        panic!("not a disconnect")
    };
    assert_eq!((project_id.as_str(), revoke), ("ana", true));
    let config = hub.db.mcp_servers().session_config(&navi()).unwrap();
    assert!(config.servers.iter().all(|s| s.name.as_str() != "google"));
    let got = call(&hub, &person(), "google_get", json!({ "project": navi() }))
        .await
        .unwrap();
    assert!(got.get("account").is_none());
}

/// Google revokes a whole grant (one account, one client): while another Navi uses the account, connecting names it
/// and disconnecting leaves the grant.
#[tokio::test]
async fn an_account_two_navis_share_keeps_its_grant() {
    let (hub, _home) = hub();
    let mut calls = node(&hub, None).await;
    with_client(&hub).await;
    calls.recv().await.unwrap();
    let bea = fleetd_contracts::google::GoogleAccount {
        project_ref: ProjectRef {
            machine_id: lab(),
            project_id: ProjectId::unchecked("bea"),
        },
        email: fleetd_contracts::prim::Line::new("ANA@example.com").unwrap(),
        scopes: Vec::new(),
        connected_at: serde_json::from_value(json!(AT)).unwrap(),
        lapsed: None,
    };
    hub.db.google().put_account(&bea).unwrap();

    call(&hub, &person(), "google_connect", connect_input(&navi()))
        .await
        .unwrap();
    let GoogleCall::Connect { in_use, .. } = calls.recv().await.unwrap() else {
        panic!("not a connect")
    };
    assert_eq!(
        in_use.iter().map(|e| e.as_str()).collect::<Vec<_>>(),
        ["ANA@example.com"]
    );

    let gone = call(
        &hub,
        &person(),
        "google_disconnect",
        json!({ "project": navi() }),
    )
    .await
    .unwrap();
    let GoogleCall::Disconnect { revoke, .. } = calls.recv().await.unwrap() else {
        panic!("not a disconnect")
    };
    assert!(!revoke);
    assert!(
        gone["next"]
            .as_str()
            .unwrap()
            .contains("Another Navi still uses"),
        "{gone}"
    );
    assert!(hub.db.google().account(&navi()).unwrap().is_none());
    assert!(hub.db.google().account(&bea.project_ref).unwrap().is_some());
}

/// What the tool policy reads a connected Navi's calls against: its servers, the native one tagged as Google. A read
/// runs; a send asks with its card; the reads are in the lead's allowed tools.
#[tokio::test]
async fn a_connected_navis_reads_run_and_its_sends_ask() {
    use crate::hub::integrations::policy::{Verdict, launch_rules, verdict};
    let (hub, _home) = hub();
    let mut calls = node(&hub, None).await;
    with_client(&hub).await;
    calls.recv().await.unwrap();
    call(&hub, &person(), "google_connect", connect_input(&navi()))
        .await
        .unwrap();
    let servers = hub.db.mcp_servers().servers_for(&navi()).unwrap();
    assert_eq!(
        verdict(
            "mcp__google__get_thread",
            &json!({ "thread_id": "t1" }),
            &servers
        ),
        Some(Verdict::Allow)
    );
    let Some(Verdict::Ask(card)) = verdict(
        "mcp__google__send_message",
        &json!({ "to": ["bo@vendor.test"], "subject": "Lunch", "body": "Noon?" }),
        &servers,
    ) else {
        panic!("a send doesn't ask")
    };
    assert_eq!(card.to[0].as_str(), "bo@vendor.test");
    assert_eq!(card.body.as_deref(), Some("Noon?"));
    let rules = launch_rules(&servers);
    assert!(
        rules
            .allowed
            .contains(&"mcp__google__search_threads".to_owned())
    );
    assert!(!rules.allowed.iter().any(|r| r.ends_with("send_message")));
    // A project of code has no such server.
    assert!(
        hub.db
            .mcp_servers()
            .servers_for(&code_project())
            .unwrap()
            .iter()
            .all(|s| s.name.as_str() != "google")
    );
}
