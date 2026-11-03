//! Signing in to an MCP server that only takes OAuth, against a fake service on loopback that is both the MCP server
//! and its authorization server, and a fake node that runs the node's own code: it opens the sealed token with its box
//! key, keeps it as the server's header, and tests the server with it. Covers discovery from the 401, dynamic client
//! registration, the person's own client where there is none, PKCE, the callback page, renewal before the end, a
//! revoked sign-in, a service that is down, and disconnecting.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Form, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::mcp_servers::{McpOauthStatus, McpScope, McpServer, McpServerName};
use fleetd_contracts::node_link::{CAP_MCP_SERVERS, HubToNode, NodeToHub};
use fleetd_contracts::sessions::SessionCall;
use serde_json::{Value, json};
use sha2::Digest;
use tokio::sync::mpsc;

use super::oauth;
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-11-03T10:00:00.000Z";
const HUB_URL: &str = "http://devbox.ts.net:4790";

// ---- the fake service ----

#[derive(Default)]
struct Fake {
    base: String,
    /// It lets apps register themselves.
    dcr: bool,
    expires_in: i64,
    /// Refreshing is refused: the person revoked fleetd's access.
    revoked: bool,
    /// The token endpoint is down.
    down: bool,
    n: u32,
    /// Registered clients: id → redirect.
    clients: HashMap<String, String>,
    /// The person's own client, made by hand: id, secret.
    own: Option<(String, String)>,
    /// Code → (challenge, client id, redirect).
    codes: HashMap<String, (String, String, String)>,
    access: HashSet<String>,
    refresh: HashSet<String>,
    /// Each token request's form, and its basic credentials if any.
    token_calls: Vec<HashMap<String, String>>,
    authorize_calls: Vec<HashMap<String, String>>,
    revoked_tokens: Vec<String>,
}

type Shared = Arc<Mutex<Fake>>;

impl Fake {
    fn next(&mut self, what: &str) -> String {
        self.n += 1;
        format!("{what}-{}", self.n)
    }

    fn tokens(&mut self) -> Value {
        let access = self.next("at");
        let refresh = self.next("rt");
        self.access.insert(access.clone());
        self.refresh.insert(refresh.clone());
        json!({ "access_token": access, "token_type": "Bearer", "expires_in": self.expires_in,
            "refresh_token": refresh })
    }
}

fn refuse(error: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(json!({ "error": error, "error_description": "nope" })),
    )
        .into_response()
}

async fn mcp(State(fake): State<Shared>, headers: HeaderMap, body: String) -> Response {
    let base = fake.lock().unwrap().base.clone();
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned);
    if !bearer.is_some_and(|t| fake.lock().unwrap().access.contains(&t)) {
        let challenge = format!(
            "Bearer error=\"invalid_token\", resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\", scope=\"mail.read\""
        );
        return (
            StatusCode::UNAUTHORIZED,
            [("www-authenticate", challenge)],
            "",
        )
            .into_response();
    }
    let message: Value = serde_json::from_str(&body).unwrap_or_default();
    let id = message["id"].clone();
    let result = match message["method"].as_str() {
        Some("initialize") => {
            json!({ "protocolVersion": "2025-06-18", "capabilities": { "tools": {} },
            "serverInfo": { "name": "fake-mail", "version": "1.0" } })
        }
        Some("tools/list") => json!({ "tools": [
            { "name": "search_mail", "annotations": { "readOnlyHint": true } }, { "name": "send_mail" } ] }),
        _ => return StatusCode::ACCEPTED.into_response(),
    };
    axum::Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
}

async fn resource_metadata(State(fake): State<Shared>) -> Response {
    let base = fake.lock().unwrap().base.clone();
    axum::Json(
        json!({ "resource": format!("{base}/mcp"), "authorization_servers": [base],
        "scopes_supported": ["mail.read", "mail.send"] }),
    )
    .into_response()
}

async fn server_metadata(State(fake): State<Shared>) -> Response {
    let f = fake.lock().unwrap();
    let base = &f.base;
    let mut meta = json!({ "issuer": base, "authorization_endpoint": format!("{base}/authorize"),
        "token_endpoint": format!("{base}/token"), "revocation_endpoint": format!("{base}/revoke"),
        "response_types_supported": ["code"], "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post"] });
    if f.dcr {
        meta["registration_endpoint"] = json!(format!("{base}/register"));
    }
    axum::Json(meta).into_response()
}

async fn register(State(fake): State<Shared>, axum::Json(body): axum::Json<Value>) -> Response {
    let mut f = fake.lock().unwrap();
    if !f.dcr {
        return StatusCode::NOT_FOUND.into_response();
    }
    assert_eq!(body["token_endpoint_auth_method"], "none");
    assert_eq!(
        body["grant_types"],
        json!(["authorization_code", "refresh_token"])
    );
    let id = f.next("client");
    let redirect = body["redirect_uris"][0].as_str().unwrap().to_owned();
    f.clients.insert(id.clone(), redirect);
    (StatusCode::CREATED, axum::Json(json!({ "client_id": id }))).into_response()
}

/// The person signs in and allows it at once: back to the redirect with a code.
async fn authorize(
    State(fake): State<Shared>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let mut f = fake.lock().unwrap();
    f.authorize_calls.push(q.clone());
    let client = &q["client_id"];
    let known = f.clients.get(client).cloned().or_else(|| {
        f.own
            .as_ref()
            .filter(|(id, _)| id == client)
            .map(|_| q["redirect_uri"].clone())
    });
    if known.as_deref() != Some(q["redirect_uri"].as_str()) || q["code_challenge_method"] != "S256"
    {
        return (StatusCode::BAD_REQUEST, "redirect_uri not allowed").into_response();
    }
    let code = f.next("code");
    f.codes.insert(
        code.clone(),
        (
            q["code_challenge"].clone(),
            client.clone(),
            q["redirect_uri"].clone(),
        ),
    );
    let to = format!("{}?code={code}&state={}", q["redirect_uri"], q["state"]);
    (StatusCode::FOUND, [("location", to)]).into_response()
}

async fn token(State(fake): State<Shared>, Form(form): Form<HashMap<String, String>>) -> Response {
    let mut f = fake.lock().unwrap();
    f.token_calls.push(form.clone());
    if f.down {
        return (StatusCode::SERVICE_UNAVAILABLE, "down for maintenance").into_response();
    }
    if form.get("resource").map(String::as_str) != Some(&format!("{}/mcp", f.base)) {
        return refuse("invalid_target");
    }
    if let Some((own, secret)) = &f.own
        && form.get("client_id") == Some(own)
        && form.get("client_secret") != Some(secret)
    {
        return refuse("invalid_client");
    }
    match form.get("grant_type").map(String::as_str) {
        Some("authorization_code") => {
            let Some((challenge, client, redirect)) = f.codes.remove(&form["code"]) else {
                return refuse("invalid_grant");
            };
            let verifier = form.get("code_verifier").cloned().unwrap_or_default();
            let s256 = URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(verifier.as_bytes()));
            if s256 != challenge
                || form.get("client_id") != Some(&client)
                || form["redirect_uri"] != redirect
            {
                return refuse("invalid_grant");
            }
            axum::Json(f.tokens()).into_response()
        }
        Some("refresh_token") => {
            if f.revoked || !f.refresh.remove(&form["refresh_token"]) {
                return refuse("invalid_grant");
            }
            axum::Json(f.tokens()).into_response()
        }
        _ => refuse("unsupported_grant_type"),
    }
}

async fn revoke(State(fake): State<Shared>, Form(form): Form<HashMap<String, String>>) -> Response {
    let mut f = fake.lock().unwrap();
    f.revoked_tokens.push(form["token"].clone());
    StatusCode::OK.into_response()
}

async fn service(dcr: bool) -> Shared {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let fake: Shared = Arc::new(Mutex::new(Fake {
        base,
        dcr,
        expires_in: 3600,
        ..Fake::default()
    }));
    let app = Router::new()
        .route("/mcp", post(mcp))
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(resource_metadata),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(server_metadata),
        )
        .route("/register", post(register))
        .route("/authorize", get(authorize))
        .route("/token", post(token))
        .route("/revoke", post(revoke))
        .with_state(fake.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    fake
}

fn base(fake: &Shared) -> String {
    fake.lock().unwrap().base.clone()
}

// ---- the hub and its node ----

struct Lab {
    hub: Arc<Hub>,
    clock: Arc<ManualClock>,
    node_home: tempfile::TempDir,
    _home: tempfile::TempDir,
}

fn machine() -> MachineId {
    MachineId::unchecked("lab")
}

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: machine(),
        project_id: ProjectId::unchecked("p1"),
    }
}

fn scope() -> McpScope {
    McpScope::Project {
        machine_id: machine(),
        project_id: ProjectId::unchecked("p1"),
    }
}

fn name() -> McpServerName {
    McpServerName::unchecked("mail")
}

/// A hub with machine `lab`, whose node runs the node's own MCP code in its own home.
async fn hub() -> Lab {
    let home = tempfile::tempdir().unwrap();
    let node_home = tempfile::tempdir().unwrap();
    let clock = ManualClock::at(1_793_000_000_000);
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    let box_key = crate::node::identity::load_or_create_box_key(node_home.path()).unwrap();
    let machine = serde_json::from_value(json!({
        "machineId": "lab", "name": "lab", "tags": [], "status": "online", "lastSeenAt": AT,
        "nodeVersion": "0.1.0", "boxPubKey": box_key.public_key(),
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, None).unwrap();
    node(&hub, node_home.path().to_path_buf()).await;
    Lab {
        hub,
        clock,
        node_home,
        _home: home,
    }
}

async fn node(hub: &Arc<Hub>, home: std::path::PathBuf) {
    let (tx, mut rx) = mpsc::unbounded_channel();
    hub.executors
        .attach(
            &machine(),
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
            .handle_frame(&machine(), serde_json::from_value::<NodeToHub>(v).unwrap())
    };
    let project = json!({ "projectId": "p1", "title": "home", "workspaceRoot": "/work/home", "updatedAt": AT });
    frame(
        json!({ "t": "machine_event", "seq": 1, "at": AT, "event": { "type": "snapshot",
        "projects": [project], "sessions": [] } }),
    );
    frame(
        json!({ "t": "session_reply", "id": subscribe.id, "result": { "ok": { "kind": "done" } } }),
    );
    hub.executors.await_live(&machine()).await;
    hub.link.set_capabilities(&machine(), &[CAP_MCP_SERVERS]);
    let hub = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let result = match f.call {
                SessionCall::McpSecrets {
                    scope,
                    server,
                    set,
                    keep,
                } => {
                    let key = crate::node::identity::load_or_create_box_key(&home).unwrap();
                    let saved = crate::node::mcp_servers::apply(
                        &home,
                        &scope,
                        &server,
                        &set,
                        &keep,
                        Some(&key),
                    )
                    .unwrap();
                    json!({ "ok": { "kind": "mcp_secrets", "secrets": saved } })
                }
                SessionCall::McpTest { server, .. } => {
                    let tested = match crate::node::mcp_servers::resolve(&home, &server) {
                        Ok(resolved) => crate::node::mcp_probe::probe(&resolved, &home, &[]).await,
                        Err(missing) => fleetd_contracts::mcp_servers::McpTestResult {
                            error: Some(format!("missing {}", missing.join(", "))),
                            ..Default::default()
                        },
                    };
                    let mut out = serde_json::to_value(tested).unwrap();
                    out["kind"] = json!("mcp_tested");
                    json!({ "ok": out })
                }
                _ => json!({ "ok": { "kind": "done" } }),
            };
            let reply = json!({ "t": "session_reply", "id": f.id, "result": result });
            hub.executors.handle_frame(
                &machine(),
                serde_json::from_value::<NodeToHub>(reply).unwrap(),
            );
        }
    });
}

fn person() -> Caller {
    let c = serde_json::from_value::<Caller>(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "admin", "machines": "*" }],
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

/// Saves the fake's MCP server as `mail`, with no key.
async fn save(lab: &Lab, fake: &Shared) {
    call(
        &lab.hub,
        "mcp_server_set",
        json!({ "scope": { "kind": "project", "machineId": "lab", "projectId": "p1" }, "name": "mail",
            "enabled": true, "roles": { "lead": true, "writers": false, "reviewers": false },
            "transport": { "type": "http", "url": format!("{}/mcp", base(fake)) }, "headers": [] }),
    )
    .await
    .unwrap();
}

async fn start(lab: &Lab, extra: Value) -> Value {
    let mut input = json!({ "scope": { "kind": "project", "machineId": "lab", "projectId": "p1" },
        "name": "mail", "hubUrl": HUB_URL });
    for (k, v) in extra.as_object().unwrap() {
        input[k] = v.clone();
    }
    call(&lab.hub, "mcp_oauth_start", input).await.unwrap()
}

/// The person's browser: opens the sign-in page, and follows the service back to the hub's callback, whose page it
/// returns.
async fn browse(lab: &Lab, authorize_url: &str) -> (StatusCode, String) {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let answer = client.get(authorize_url).send().await.unwrap();
    assert_eq!(
        answer.status(),
        StatusCode::FOUND,
        "{}",
        answer.text().await.unwrap()
    );
    let to = url::Url::parse(answer.headers()["location"].to_str().unwrap()).unwrap();
    assert_eq!(
        format!("{}{}", HUB_URL, to.path()),
        format!("{HUB_URL}/oauth/callback")
    );
    let query: HashMap<String, String> = to.query_pairs().into_owned().collect();
    callback(lab, query).await
}

async fn callback(lab: &Lab, query: HashMap<String, String>) -> (StatusCode, String) {
    let response = super::callback::handle(lab.hub.clone(), query).await;
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&body).into_owned())
}

fn server(lab: &Lab) -> McpServer {
    lab.hub
        .db
        .mcp_servers()
        .get(&scope(), &name())
        .unwrap()
        .unwrap()
}

/// The `Authorization` header the node holds for `mail`.
fn on_node(lab: &Lab) -> Option<String> {
    let session = crate::hub::mcp_servers::for_session(&server(lab), &machine())?;
    let resolved = crate::node::mcp_servers::resolve(lab.node_home.path(), &session).ok()?;
    resolved
        .values
        .iter()
        .find(|(k, _)| k == "Authorization")
        .map(|(_, v)| v.clone())
}

async fn test_connection(lab: &Lab) -> Value {
    call(
        &lab.hub,
        "mcp_server_test",
        json!({ "scope": { "kind": "project", "machineId": "lab", "projectId": "p1" }, "name": "mail" }),
    )
    .await
    .unwrap()["result"]
        .clone()
}

fn chat(lab: &Lab) -> Vec<String> {
    let (messages, _, _) = lab.hub.chat.page(&project(), None, None, 50).unwrap();
    messages.into_iter().map(|m| m.text.to_string()).collect()
}

/// Every text and blob of every row, as text: no token may be in it.
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
                        match row.get_ref(i)? {
                            rusqlite::types::ValueRef::Text(t)
                            | rusqlite::types::ValueRef::Blob(t) => {
                                out.push_str(&String::from_utf8_lossy(t));
                                out.push('\n');
                            }
                            _ => {}
                        }
                    }
                }
            }
            Ok(out)
        })
        .unwrap()
}

/// Signs `mail` in with a client fleetd registers.
async fn signed_in(lab: &Lab, fake: &Shared) {
    save(lab, fake).await;
    let out = start(lab, json!({})).await;
    let (status, _) = browse(lab, out["authorizeUrl"].as_str().unwrap()).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn signs_in_with_a_registered_client_and_pkce_and_its_tools_reach_the_navi() {
    let fake = service(true).await;
    let lab = hub().await;
    save(&lab, &fake).await;
    // With no key, the test finds the server asks for sign-in.
    let tested = test_connection(&lab).await;
    assert_eq!(tested["signIn"], true, "{tested}");
    assert!(
        tested["error"]
            .as_str()
            .unwrap()
            .contains("asks you to sign in"),
        "{tested}"
    );

    let out = start(&lab, json!({})).await;
    assert_eq!(out["redirectUri"], format!("{HUB_URL}/oauth/callback"));
    assert!(out.get("needsClient").is_none());
    // fleetd registered itself for the hub's own callback, and opened the sign-in with PKCE, the 401's scope and the
    // server as the resource.
    let authorize = url::Url::parse(out["authorizeUrl"].as_str().unwrap()).unwrap();
    let q: HashMap<String, String> = authorize.query_pairs().into_owned().collect();
    assert_eq!(
        fake.lock()
            .unwrap()
            .clients
            .get(&q["client_id"])
            .map(String::as_str),
        Some(format!("{HUB_URL}/oauth/callback").as_str())
    );
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["scope"], "mail.read");
    assert_eq!(q["resource"], format!("{}/mcp", base(&fake)));
    let oauth = server(&lab).oauth.unwrap();
    assert!(oauth.signing_in && oauth.status == McpOauthStatus::SignedOut);
    // Not signed in yet: agents don't get it.
    assert!(crate::hub::mcp_servers::for_session(&server(&lab), &machine()).is_none());

    let (status, page) = browse(&lab, out["authorizeUrl"].as_str().unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert!(page.contains("Signed in to mail"), "{page}");
    // The code went back with the verifier whose challenge opened the sign-in (the fake checks it).
    let form = fake.lock().unwrap().token_calls.last().cloned().unwrap();
    assert_eq!(form["grant_type"], "authorization_code");
    assert!(form["code_verifier"].len() >= 43);

    let oauth = server(&lab).oauth.unwrap();
    assert_eq!(oauth.status, McpOauthStatus::Connected);
    assert!(!oauth.signing_in && oauth.problem.is_none() && oauth.expires_at.is_some());
    // The node holds the token as the server's header; the hub keeps no token in the clear.
    let header = on_node(&lab).unwrap();
    let token = header.strip_prefix("Bearer ").unwrap();
    assert!(fake.lock().unwrap().access.contains(token));
    let rows = every_row(&lab.hub);
    assert!(
        !rows.contains(token),
        "the access token is in the hub's database"
    );
    assert!(
        !rows.contains("rt-"),
        "the refresh token is in the hub's database"
    );
    // The Navi's next turn gets it, and the test lists its tools through the node.
    let config = lab.hub.db.mcp_servers().session_config(&project()).unwrap();
    assert!(config.servers.iter().any(|s| s.name.as_str() == "mail"));
    assert!(
        lab.hub
            .db
            .mcp_servers()
            .lead_set(&project())
            .unwrap()
            .servers
            .contains_key("mail")
    );
    let tested = test_connection(&lab).await;
    assert!(tested.get("error").is_none(), "{tested}");
    assert_eq!(tested["server"], "fake-mail 1.0");
    assert_eq!(tested["tools"][0]["name"], "search_mail");

    // Saving it again (the tools the person ticked) keeps the sign-in and the token on the machine.
    call(
        &lab.hub,
        "mcp_server_set",
        json!({ "scope": { "kind": "project", "machineId": "lab", "projectId": "p1" }, "name": "mail",
            "enabled": true, "roles": { "lead": true, "writers": false, "reviewers": false },
            "transport": { "type": "http", "url": format!("{}/mcp", base(&fake)) }, "headers": [] }),
    )
    .await
    .unwrap();
    assert_eq!(
        server(&lab).oauth.unwrap().status,
        McpOauthStatus::Connected
    );
    assert_eq!(on_node(&lab).as_deref(), Some(header.as_str()));
}

#[tokio::test]
async fn renews_before_the_end_without_restarting_the_navi() {
    let fake = service(true).await;
    let lab = hub().await;
    signed_in(&lab, &fake).await;
    let first = on_node(&lab).unwrap();
    let set = lab.hub.db.mcp_servers().lead_set(&project()).unwrap();
    let ends = server(&lab).oauth.unwrap().expires_at.unwrap();

    // An hour's token is left alone with more than half its life.
    lab.clock.advance(Duration::from_secs(20 * 60));
    super::renew_due(&lab.hub).await;
    assert_eq!(on_node(&lab).unwrap(), first);

    // With half its life left, it is renewed, and the machine gets the new one.
    lab.clock.advance(Duration::from_secs(11 * 60));
    super::renew_due(&lab.hub).await;
    let form = fake.lock().unwrap().token_calls.last().cloned().unwrap();
    assert_eq!(form["grant_type"], "refresh_token");
    let second = on_node(&lab).unwrap();
    assert_ne!(second, first);
    assert!(
        fake.lock()
            .unwrap()
            .access
            .contains(second.strip_prefix("Bearer ").unwrap())
    );
    assert!(server(&lab).oauth.unwrap().expires_at.unwrap() > ends);
    // A renewal isn't a new server: the Navi's session goes on.
    assert_eq!(lab.hub.db.mcp_servers().lead_set(&project()).unwrap(), set);
    assert!(chat(&lab).is_empty(), "{:?}", chat(&lab));
}

#[tokio::test]
async fn a_revoked_sign_in_shows_reconnect_and_says_so_in_the_chat() {
    let fake = service(true).await;
    let lab = hub().await;
    signed_in(&lab, &fake).await;
    fake.lock().unwrap().revoked = true;
    lab.clock.advance(Duration::from_secs(31 * 60));
    super::renew_due(&lab.hub).await;

    let oauth = server(&lab).oauth.unwrap();
    assert_eq!(oauth.status, McpOauthStatus::SignedOut);
    let problem = oauth.problem.unwrap();
    assert!(
        problem.contains("ended the sign-in (nope)") && problem.contains("sign in again"),
        "{problem}"
    );
    let lines = chat(&lab);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(
        lines[0].starts_with("mail is signed out:") && lines[0].contains("Reconnect"),
        "{lines:?}"
    );
    // Agents go without it, and the test says why and offers sign-in.
    assert!(crate::hub::mcp_servers::for_session(&server(&lab), &machine()).is_none());
    let tested = test_connection(&lab).await;
    assert_eq!(tested["signIn"], true);
    assert_eq!(tested["error"], problem);
    // A later round says nothing more.
    lab.clock.advance(Duration::from_secs(60 * 60));
    super::renew_due(&lab.hub).await;
    assert_eq!(chat(&lab).len(), 1);

    // Reconnect: the same registered client, a new sign-in.
    fake.lock().unwrap().revoked = false;
    let registered = fake.lock().unwrap().clients.len();
    let out = start(&lab, json!({})).await;
    browse(&lab, out["authorizeUrl"].as_str().unwrap()).await;
    assert_eq!(fake.lock().unwrap().clients.len(), registered);
    let oauth = server(&lab).oauth.unwrap();
    assert_eq!(oauth.status, McpOauthStatus::Connected);
    assert!(oauth.problem.is_none());
    assert!(on_node(&lab).is_some());
}

#[tokio::test]
async fn a_server_turning_the_token_away_is_renewed_at_its_test() {
    let fake = service(true).await;
    let lab = hub().await;
    signed_in(&lab, &fake).await;
    // The service dropped the token early (it restarted, say): the test renews it and tests again.
    fake.lock().unwrap().access.clear();
    let tested = test_connection(&lab).await;
    assert!(tested.get("error").is_none(), "{tested}");
    assert_eq!(tested["tools"][1]["name"], "send_mail");
}

#[tokio::test]
async fn a_service_without_registration_takes_the_persons_own_client() {
    let fake = service(false).await;
    fake.lock().unwrap().own = Some(("my-client".into(), "my-secret".into()));
    let lab = hub().await;
    save(&lab, &fake).await;
    let out = start(&lab, json!({})).await;
    assert!(out.get("authorizeUrl").is_none());
    assert_eq!(out["redirectUri"], format!("{HUB_URL}/oauth/callback"));
    let needs = &out["needsClient"];
    assert_eq!(needs["issuer"], base(&fake));
    let hub_key = crate::hub::hub_links::box_key(&lab.hub).unwrap();
    assert_eq!(needs["boxPubKey"], hub_key.public_key());

    // The app seals the secret to the hub's key.
    let public: [u8; 32] = B64
        .decode(needs["boxPubKey"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let sealed = crypto_box::PublicKey::from(public)
        .seal(&mut crypto_box::aead::OsRng, b"my-secret\n")
        .unwrap();
    let out = start(
        &lab,
        json!({ "client": { "clientId": "my-client", "sealedSecret": B64.encode(sealed) } }),
    )
    .await;
    let (status, page) = browse(&lab, out["authorizeUrl"].as_str().unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{page}");
    // The service lists only client_secret_post: the secret went in the form, trimmed.
    let form = fake.lock().unwrap().token_calls.last().cloned().unwrap();
    assert_eq!(form["client_secret"], "my-secret");
    let oauth = server(&lab).oauth.unwrap();
    assert_eq!(oauth.status, McpOauthStatus::Connected);
    assert_eq!(oauth.client_id.as_deref(), Some("my-client"));
    assert!(!every_row(&lab.hub).contains("my-secret"));
    // Renewing uses it too.
    lab.clock.advance(Duration::from_secs(31 * 60));
    super::renew_due(&lab.hub).await;
    let form = fake.lock().unwrap().token_calls.last().cloned().unwrap();
    assert_eq!(
        (form["grant_type"].as_str(), form["client_secret"].as_str()),
        ("refresh_token", "my-secret")
    );
    assert_eq!(
        server(&lab).oauth.unwrap().status,
        McpOauthStatus::Connected
    );
}

#[tokio::test]
async fn a_failed_sign_in_says_why() {
    let fake = service(true).await;
    let lab = hub().await;
    save(&lab, &fake).await;
    let out = start(&lab, json!({})).await;
    let q: HashMap<String, String> = url::Url::parse(out["authorizeUrl"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect();
    // The person said no.
    let refused: HashMap<String, String> = [
        ("state", q["state"].as_str()),
        ("error", "access_denied"),
        ("error_description", "The user denied access"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let (status, page) = callback(&lab, refused.clone()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(page.contains("Signing in to mail failed"), "{page}");
    let oauth = server(&lab).oauth.unwrap();
    assert!(!oauth.signing_in);
    assert_eq!(
        oauth.problem.as_deref(),
        Some(
            format!(
                "{} didn't sign you in (The user denied access).",
                oauth::host_of(&base(&fake))
            )
            .as_str()
        )
    );
    // The same link again, or one that was never issued.
    let (_, page) = callback(&lab, refused).await;
    assert!(page.contains("already used"), "{page}");
    // A code the service doesn't know.
    let out = start(&lab, json!({})).await;
    let state = url::Url::parse(out["authorizeUrl"].as_str().unwrap())
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let forged: HashMap<String, String> = [
        ("state".to_owned(), state),
        ("code".to_owned(), "code-999".to_owned()),
    ]
    .into_iter()
    .collect();
    let (_, page) = callback(&lab, forged).await;
    assert!(page.contains("refused the sign-in (nope)"), "{page}");
    assert_eq!(
        server(&lab).oauth.unwrap().status,
        McpOauthStatus::SignedOut
    );
    // A sign-in left open ends after 15 minutes.
    start(&lab, json!({})).await;
    lab.clock.advance(Duration::from_secs(16 * 60));
    super::renew_due(&lab.hub).await;
    let oauth = server(&lab).oauth.unwrap();
    assert!(!oauth.signing_in && oauth.problem.unwrap().contains("15 minutes"));
}

#[tokio::test]
async fn a_service_that_is_down_is_retried_and_the_chat_hears_once() {
    let fake = service(true).await;
    let lab = hub().await;
    signed_in(&lab, &fake).await;
    fake.lock().unwrap().down = true;
    lab.clock.advance(Duration::from_secs(31 * 60));
    super::renew_due(&lab.hub).await;
    // Still signed in, nothing said while the token lasts.
    let oauth = server(&lab).oauth.unwrap();
    assert_eq!(oauth.status, McpOauthStatus::Connected);
    assert!(oauth.problem.is_none() && chat(&lab).is_empty());
    // Once it ended, the chat hears it once.
    for _ in 0..3 {
        lab.clock.advance(Duration::from_secs(15 * 60));
        super::renew_due(&lab.hub).await;
    }
    let lines = chat(&lab);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(
        lines[0].starts_with("mail isn't working: fleetd can't renew its sign-in"),
        "{lines:?}"
    );
    assert_eq!(
        server(&lab).oauth.unwrap().status,
        McpOauthStatus::Connected
    );
    // Back up: renewed, and said.
    fake.lock().unwrap().down = false;
    lab.clock.advance(Duration::from_secs(3 * 60));
    super::renew_due(&lab.hub).await;
    let lines = chat(&lab);
    assert_eq!(lines.last().unwrap(), "mail works again: Navi can use it.");
    assert!(server(&lab).oauth.unwrap().problem.is_none());
}

#[tokio::test]
async fn disconnecting_revokes_the_sign_in() {
    let fake = service(true).await;
    let lab = hub().await;
    signed_in(&lab, &fake).await;
    call(
        &lab.hub,
        "mcp_server_remove",
        json!({ "scope": { "kind": "project", "machineId": "lab", "projectId": "p1" }, "name": "mail" }),
    )
    .await
    .unwrap();
    let revoked = fake.lock().unwrap().revoked_tokens.clone();
    assert_eq!(revoked.len(), 1);
    assert!(revoked[0].starts_with("rt-"));
    assert!(
        super::get(&lab.hub.db, &scope(), &name())
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn only_a_project_server_by_url_signs_in() {
    let lab = hub().await;
    call(
        &lab.hub,
        "mcp_server_set",
        json!({ "scope": { "kind": "project", "machineId": "lab", "projectId": "p1" }, "name": "local",
            "enabled": true, "roles": { "lead": true, "writers": false, "reviewers": false },
            "transport": { "type": "stdio", "command": "mail-mcp" } }),
    )
    .await
    .unwrap();
    let error = call(
        &lab.hub,
        "mcp_oauth_start",
        json!({ "scope": { "kind": "project", "machineId": "lab", "projectId": "p1" }, "name": "local" }),
    )
    .await
    .unwrap_err();
    assert!(
        format!("{error:?}").contains("only a server reached by URL signs in"),
        "{error:?}"
    );
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..person()
    };
    let error = registry()
        .call(
            &lab.hub,
            &agent,
            "mcp_oauth_start",
            json!({ "scope": { "kind": "project", "machineId": "lab", "projectId": "p1" }, "name": "local" }),
        )
        .await
        .unwrap_err();
    assert!(format!("{error:?}").contains("Only a person"), "{error:?}");
}

#[test]
fn reads_the_challenge() {
    let header = r#"Bearer error="invalid_token", resource_metadata="https://a.example/.well-known/oauth-protected-resource/mcp", scope="files:read files:write""#;
    assert_eq!(
        oauth::challenge_param(header, "resource_metadata").as_deref(),
        Some("https://a.example/.well-known/oauth-protected-resource/mcp")
    );
    assert_eq!(
        oauth::challenge_param(header, "scope").as_deref(),
        Some("files:read files:write")
    );
    assert_eq!(oauth::challenge_param(header, "realm"), None);
    assert_eq!(oauth::challenge_param(r#"Basic realm="x""#, "realm"), None);
}

#[test]
fn signs_in_only_where_tokens_stay_private() {
    for ok in [
        "https://auth.example.com/token",
        "http://127.0.0.1:8080/token",
        "http://localhost/token",
        "http://devbox.tail1234.ts.net:4790/oauth/callback",
        "http://100.101.102.103/token",
    ] {
        assert!(oauth::secure(ok).is_ok(), "{ok}");
    }
    for bad in [
        "http://auth.example.com/token",
        "http://192.168.1.4/token",
        "ftp://x/y",
    ] {
        assert!(oauth::secure(bad).is_err(), "{bad}");
    }
}

#[test]
fn renews_at_half_life_at_most_thirty_minutes_before_the_end() {
    let record = |life_min: Option<i64>| super::Record {
        expires_ms: Some(100 * 60_000),
        lifetime_ms: life_min.map(|m| m * 60_000),
        ..Default::default()
    };
    let at = |min: i64| min * 60_000;
    // An hour's token: from 30 minutes left.
    assert!(!super::due(&record(Some(60)), at(69)));
    assert!(super::due(&record(Some(60)), at(70)));
    // A day's: 30 minutes, not 12 hours.
    assert!(!super::due(&record(Some(24 * 60)), at(60)));
    assert!(super::due(&record(Some(24 * 60)), at(70)));
    // Ten minutes': from five left. Unknown: five.
    assert!(super::due(&record(Some(10)), at(95)) && !super::due(&record(Some(10)), at(94)));
    assert!(super::due(&record(None), at(95)) && !super::due(&record(None), at(94)));
    // A token that doesn't end is never due.
    assert!(!super::due(&super::Record::default(), at(1_000)));
}

#[tokio::test]
async fn a_wrong_verifier_is_refused() {
    let fake = service(true).await;
    let b = base(&fake);
    let found = oauth::discover(&format!("{b}/mcp"), false).await.unwrap();
    assert_eq!(found.issuer, b);
    assert_eq!(found.registration_endpoint, Some(format!("{b}/register")));
    let registered = oauth::register(&found, "http://127.0.0.1:4790/oauth/callback")
        .await
        .unwrap();
    let (_verifier, challenge) = oauth::pkce();
    let url = oauth::authorize_url(
        &found.authorization_endpoint,
        &registered.client_id,
        "http://127.0.0.1:4790/oauth/callback",
        &challenge,
        "s",
        None,
        &found.resource,
    )
    .unwrap();
    let to = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .get(url)
        .send()
        .await
        .unwrap()
        .headers()["location"]
        .to_str()
        .unwrap()
        .to_owned();
    let code = url::Url::parse(&to)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .into_owned();
    let (other, _) = oauth::pkce();
    let error = oauth::token(
        &found.token_endpoint,
        &oauth::Client {
            id: &registered.client_id,
            secret: None,
            auth: None,
        },
        &found.resource,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", "http://127.0.0.1:4790/oauth/callback"),
            ("code_verifier", &other),
        ],
    )
    .await
    .err()
    .unwrap();
    assert!(matches!(error, oauth::TokenError::Refused(_)), "{error:?}");
}
