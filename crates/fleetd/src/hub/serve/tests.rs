//! The framework over a real HTTP server on an ephemeral port: per-request bearer checks, the role and per-machine
//! grant checks, the error shapes on /mcp and /app, and a prompt stop with sockets open.
use super::build_on;
use crate::clock::SystemClock;
use crate::hub::api::{self, Hub, HubConfig, Listen, Registry};
use crate::hub::http;
use crate::hub::store::{HubDb, NewEvent};
use fleetd_contracts::auth::{Grant, KeyKind};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

struct TestHub {
    hub: Arc<Hub>,
    url: String,
    served: tokio::task::JoinHandle<std::io::Result<()>>,
    operate_calls: Arc<AtomicUsize>,
    // Each test gets its own home, so no two tests share a hub's files.
    _home: tempfile::TempDir,
}

/// The real registry plus an operate tool that counts its calls and a tool that panics.
async fn start() -> TestHub {
    start_on(Arc::new(SystemClock)).await
}

/// [`start`] on `clock`.
async fn start_on(clock: Arc<dyn crate::clock::Clock>) -> TestHub {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let hub = build_on(HubDb::open_memory().unwrap(), config, clock).unwrap();
    let mut tools: Registry = api::registry();
    let operate_calls = Arc::new(AtomicUsize::new(0));
    let counter = operate_calls.clone();
    tools.add_raw("project_add", move |_, _, _| {
        let counter = counter.clone();
        async move {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(json!({ "ok": true }))
        }
    });
    tools.add_raw("wake_cancel", |_, _, _| async { panic!("boom") });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("127.0.0.1:{}", listener.local_addr().unwrap().port());
    let served = tokio::spawn(http::serve(listener, hub.clone(), Arc::new(tools)));
    TestHub {
        hub,
        url,
        served,
        operate_calls,
        _home: home,
    }
}

fn key(hub: &Hub, grants: Value) -> String {
    let grants: Vec<Grant> = serde_json::from_value(grants).unwrap();
    hub.auth
        .create_key("test", &grants, KeyKind::Agent)
        .unwrap()
        .key
}

struct Reply {
    status: u16,
    headers: String,
    body: Value,
}

/// One HTTP/1.1 request on a fresh connection.
async fn request(url: &str, headers: &[(&str, &str)], body: &str) -> Reply {
    let mut stream = tokio::net::TcpStream::connect(url).await.unwrap();
    let mut head = format!(
        "POST /mcp HTTP/1.1\r\nhost: {url}\r\nconnection: close\r\ncontent-length: {}\r\n",
        body.len()
    );
    head.push_str(
        "content-type: application/json\r\naccept: application/json, text/event-stream\r\n",
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    stream
        .write_all(format!("{head}\r\n{body}").as_bytes())
        .await
        .unwrap();
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    let status = head[9..12].parse().unwrap();
    Reply {
        status,
        headers: head.to_ascii_lowercase(),
        body: serde_json::from_str(body).unwrap_or(Value::Null),
    }
}

/// An MCP session for `key`: initialize, then JSON-RPC calls with its session id.
struct Mcp {
    url: String,
    auth: String,
    session: String,
}

impl Mcp {
    async fn connect(url: &str, key: &str) -> Self {
        let auth = format!("Bearer {key}");
        let init = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } } });
        let reply = request(url, &[("authorization", &auth)], &init.to_string()).await;
        assert_eq!(reply.status, 200);
        assert_eq!(reply.body["result"]["protocolVersion"], "2025-06-18");
        let session = reply
            .headers
            .lines()
            .find_map(|l| l.strip_prefix("mcp-session-id: "))
            .unwrap()
            .trim()
            .to_owned();
        Self {
            url: url.to_owned(),
            auth,
            session,
        }
    }

    async fn rpc(&self, method: &str, params: Value) -> Value {
        let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let reply = request(
            &self.url,
            &[
                ("authorization", &self.auth),
                ("mcp-session-id", &self.session),
            ],
            &body.to_string(),
        )
        .await;
        assert_eq!(reply.status, 200, "{}", reply.body);
        reply.body
    }

    /// `(isError, structuredContent)` of a tools/call.
    async fn call(&self, tool: &str, arguments: Value) -> (bool, Value) {
        let reply = self
            .rpc(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
            )
            .await;
        let result = &reply["result"];
        assert_eq!(
            result["content"][0]["text"]
                .as_str()
                .map(|t| serde_json::from_str::<Value>(t).unwrap()),
            Some(result["structuredContent"].clone())
        );
        (
            result["isError"] == true,
            result["structuredContent"].clone(),
        )
    }
}

fn event(machine: &str) -> NewEvent {
    serde_json::from_value(json!({ "at": "2026-10-17T00:00:00.000Z", "type": "machine.offline", "machineId": machine, "summary": machine })).unwrap()
}

#[tokio::test]
async fn mcp_refuses_requests_without_a_live_key_with_401_and_a_fix() {
    let t = start().await;
    let ping = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string();
    let none = request(&t.url, &[], &ping).await;
    assert_eq!(none.status, 401);
    assert!(
        none.headers
            .contains(r#"www-authenticate: bearer error="invalid_token""#)
    );
    assert_eq!(
        none.body,
        json!({ "code": "forbidden", "message": "The MCP endpoint needs an agent key.",
        "fix": "Send Authorization: Bearer fld_… (create one with fleetd hub key create)." })
    );
    let bad = request(&t.url, &[("authorization", "Bearer fld_nope")], &ping).await;
    assert_eq!(
        (bad.status, bad.body["code"].as_str()),
        (401, Some("invalid"))
    );

    // A key stops working on its next request once revoked.
    let created = t
        .hub
        .auth
        .create_key(
            "r",
            &serde_json::from_value::<Vec<Grant>>(json!([{ "role": "read", "machines": "*" }]))
                .unwrap(),
            KeyKind::Agent,
        )
        .unwrap();
    let mcp = Mcp::connect(&t.url, &created.key).await;
    assert!(!mcp.call("events_wait", json!({ "timeoutSec": 0 })).await.0);
    t.hub.auth.revoke(created.info.key_id.as_str()).unwrap();
    let revoked = request(
        &t.url,
        &[
            ("authorization", &mcp.auth),
            ("mcp-session-id", &mcp.session),
        ],
        &ping,
    )
    .await;
    assert_eq!(
        (revoked.status, revoked.body["code"].as_str()),
        (401, Some("forbidden"))
    );
}

/// Claude Code puts `instructions` in the session's system prompt: every session is told to claim work first.
#[tokio::test]
async fn initialize_tells_a_session_to_claim_its_work_and_lists_the_work_tools() {
    let t = start().await;
    let key = key(&t.hub, json!([{ "role": "operate", "machines": "*" }]));
    let init = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "t", "version": "0" } } });
    let reply = request(
        &t.url,
        &[("authorization", &format!("Bearer {key}"))],
        &init.to_string(),
    )
    .await;
    let instructions = reply.body["result"]["instructions"].as_str().unwrap();
    assert_eq!(instructions, crate::hub::mcp::INSTRUCTIONS);
    for tool in ["work_claim", "work_done", "taken or possible_duplicate"] {
        assert!(instructions.contains(tool), "{tool}");
    }
    let mcp = Mcp::connect(&t.url, &key).await;
    let listed = mcp.rpc("tools/list", json!({})).await;
    let tool = |name: &str| {
        listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .cloned()
            .unwrap_or_else(|| panic!("{name} listed"))
    };
    assert_eq!(tool("work_list")["annotations"]["readOnlyHint"], true);
    let claim = tool("work_claim");
    assert!(
        claim["description"]
            .as_str()
            .unwrap()
            .starts_with("Call before you start a code change")
    );
    assert_eq!(claim["inputSchema"]["required"], json!(["title"]));
    assert!(tool("work_done")["inputSchema"]["properties"]["outcome"].is_object());
}

#[tokio::test]
async fn tools_check_the_role_then_the_machine_grant_and_filter_fleet_wide_reads() {
    let t = start().await;
    let reader = Mcp::connect(
        &t.url,
        &key(&t.hub, json!([{ "role": "read", "machines": "*" }])),
    )
    .await;
    let a_only = Mcp::connect(
        &t.url,
        &key(
            &t.hub,
            json!([{ "role": "operate", "machines": ["lab-a"] }]),
        ),
    )
    .await;

    let (is_error, body) = reader
        .call("project_add", json!({ "machineId": "lab-a", "path": "/w" }))
        .await;
    assert!(is_error);
    assert_eq!(
        body,
        json!({ "code": "forbidden", "message": "This key lacks the operate role.",
        "fix": "Ask the hub admin for a key with that grant (fleetd hub key create --role … --machines …)." })
    );
    assert_eq!(t.operate_calls.load(Ordering::SeqCst), 0);
    assert!(!a_only.call("project_add", json!({})).await.0);
    assert_eq!(t.operate_calls.load(Ordering::SeqCst), 1);

    let (_, body) = a_only
        .call(
            "events_wait",
            json!({ "machineId": "lab-b", "timeoutSec": 0 }),
        )
        .await;
    assert_eq!(
        body["message"],
        "This key has no read grant on machine lab-b."
    );
    t.hub.events.append(event("lab-a")).unwrap();
    t.hub.events.append(event("lab-b")).unwrap();
    let (_, page) = a_only.call("events_wait", json!({ "cursor": 0 })).await;
    assert_eq!(
        page["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["machineId"].clone())
            .collect::<Vec<_>>(),
        [json!("lab-a")]
    );
    assert_eq!(
        (page["cursor"].clone(), page["more"].clone()),
        (json!(2), json!(false))
    );
    assert_eq!(
        reader.call("events_wait", json!({ "cursor": 0 })).await.1["events"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let (is_error, body) = reader
        .call("events_wait", json!({ "timeoutSec": 51 }))
        .await;
    assert!(is_error);
    assert_eq!(body["code"], "invalid");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .starts_with("Invalid events_wait input: ")
    );
    assert_eq!(
        body["fix"],
        "Check the arguments against the tool's input schema."
    );
    // tools/list: object roots with the contracts' schemas, the named input structs looked through.
    let listed = reader.rpc("tools/list", json!({})).await;
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object"));
    let tail = tools.iter().find(|t| t["name"] == "thread_tail").unwrap();
    assert_eq!(
        tail["inputSchema"]["required"],
        json!(["machineId", "threadId"])
    );
    assert_eq!(tail["annotations"]["readOnlyHint"], true);
    let unknown = reader
        .rpc("tools/call", json!({ "name": "nope", "arguments": {} }))
        .await;
    assert_eq!(
        unknown["error"],
        json!({ "code": -32602, "message": "Tool 'nope' not found" })
    );
    let (is_error, body) = reader.call("fleetd_status", json!({})).await;
    assert!(!is_error, "{body}");
    // A panicking handler answers the generic error and the server keeps serving.
    let (_, body) = a_only.call("wake_cancel", json!({})).await;
    assert_eq!(
        body,
        json!({ "code": "failed", "message": "The hub failed to answer that request.", "fix": "Retry; if it keeps failing, check the hub log." })
    );
    assert!(
        !reader
            .call("events_wait", json!({ "timeoutSec": 0 }))
            .await
            .0
    );
}

#[tokio::test]
async fn app_socket_closes_on_a_refused_key_and_calls_through_the_same_checks() {
    let t = start().await;
    let (mut bad, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
        .await
        .unwrap();
    bad.send(Message::text(
        json!({ "t": "auth", "key": "fld_nope" }).to_string(),
    ))
    .await
    .unwrap();
    let refused: Value =
        serde_json::from_str(bad.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(
        (refused["t"].as_str(), refused["code"].as_str()),
        (Some("error"), Some("invalid"))
    );
    match bad.next().await.unwrap().unwrap() {
        Message::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 4401),
        other => panic!("expected a close, got {other:?}"),
    }

    let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
        .await
        .unwrap();
    let reader = key(&t.hub, json!([{ "role": "read", "machines": "*" }]));
    for frame in [
        json!({ "t": "call", "id": "c0", "tool": "events_wait", "input": {} }),
        json!({ "t": "auth", "key": reader }),
        json!({ "t": "call", "id": "c1", "tool": "project_add", "input": {} }),
        json!({ "t": "call", "id": "c2", "tool": "nope", "input": {} }),
        json!({ "t": "call", "id": "c3", "tool": "telegram_get", "input": {} }),
    ] {
        app.send(Message::text(frame.to_string())).await.unwrap();
    }
    let mut frames = Vec::new();
    while frames.len() < 5 {
        frames.push(
            serde_json::from_str::<Value>(app.next().await.unwrap().unwrap().to_text().unwrap())
                .unwrap(),
        );
    }
    frames.sort_by_key(|f| f["id"].as_str().unwrap_or("").to_owned());
    assert_eq!(
        frames[0],
        json!({ "t": "ready", "protocol": 1, "version": crate::version(), "features": ["presence", "browser_sessions", "navi_asks", "screen_open", "navi_skills", "browser_navigate", "screen_thumbs", "artifacts", "deflate", "frame_acks"] })
    );
    assert_eq!(
        frames[1],
        json!({ "t": "error", "id": "c0", "code": "forbidden", "message": "Not authenticated.", "fix": "Send {t:auth,key} first." })
    );
    assert_eq!(
        (frames[2]["id"].as_str(), frames[2]["message"].as_str()),
        (Some("c1"), Some("This key lacks the operate role."))
    );
    assert_eq!(
        frames[3],
        json!({ "t": "error", "id": "c2", "code": "not_found", "message": "No tool nope.", "fix": "Use a tool name from the hub's MCP tool list." })
    );
    // An older app's call to a removed tool is refused in plain words, not as a tool it got wrong.
    assert_eq!(
        frames[4],
        json!({ "t": "error", "id": "c3", "code": "not_found", "message": "Telegram was removed from fleetd.", "fix": "Update the fleetd app: newer ones no longer offer it." })
    );
}

#[tokio::test]
async fn app_presence_is_recorded_for_a_human_key_and_never_answered() {
    let t = start().await;
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": "read", "machines": "*" }])).unwrap();
    let human = t
        .hub
        .auth
        .create_key("desk", &grants, KeyKind::Human)
        .unwrap()
        .key;
    let agent = key(&t.hub, json!([{ "role": "read", "machines": "*" }]));
    let web = json!({ "machineId": "devbox", "projectId": "web" });
    crate::hub::metrics::presence_tests::add_projects(&t.hub, &["web"]);
    // A frame the hub can't read is answered with its own id.
    let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
        .await
        .unwrap();
    for frame in [
        json!({ "t": "auth", "key": human }),
        json!({ "t": "presence", "id": "p1", "focused": "yes" }),
    ] {
        app.send(Message::text(frame.to_string())).await.unwrap();
    }
    let _ready = app.next().await.unwrap().unwrap();
    let refused: Value =
        serde_json::from_str(app.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(
        (
            refused["t"].as_str(),
            refused["id"].as_str(),
            refused["code"].as_str()
        ),
        (Some("error"), Some("p1"), Some("invalid"))
    );
    for key in [agent, human] {
        let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
            .await
            .unwrap();
        for frame in [
            json!({ "t": "auth", "key": key }),
            json!({ "t": "presence", "focused": true, "input": true, "project": web }),
            json!({ "t": "call", "id": "c1", "tool": "events_wait", "input": { "timeoutSec": 0 } }),
        ] {
            app.send(Message::text(frame.to_string())).await.unwrap();
        }
        let ready: Value =
            serde_json::from_str(app.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(ready["t"], "ready");
        // The next frame answers the call: presence has no answer.
        let next: Value =
            serde_json::from_str(app.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(
            (next["t"].as_str(), next["id"].as_str()),
            (Some("result"), Some("c1"))
        );
    }
    // Only the human key's minute is an event.
    let page = t
        .hub
        .events
        .page(
            0,
            Some(&[fleetd_contracts::events::HubEventType::AppPresence]),
            None,
        )
        .unwrap();
    assert_eq!(page.events.len(), 1);
    let data = page.events[0].data.clone().unwrap();
    let mut keys: Vec<&str> = data
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["by", "fromMs", "toMs"]);
    assert_eq!(data["by"], "desk");
    assert_eq!(
        data["toMs"].as_i64().unwrap() - data["fromMs"].as_i64().unwrap(),
        crate::hub::metrics::presence::WINDOW_MS
    );
}

#[tokio::test]
async fn stops_within_a_second_while_an_app_stream_and_an_events_wait_long_poll_are_open() {
    let t = start().await;
    let reader = key(&t.hub, json!([{ "role": "read", "machines": "*" }]));
    let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
        .await
        .unwrap();
    app.send(Message::text(
        json!({ "t": "auth", "key": reader }).to_string(),
    ))
    .await
    .unwrap();
    app.next().await.unwrap().unwrap();
    app.send(Message::text(
        json!({ "t": "events", "cursor": 0 }).to_string(),
    ))
    .await
    .unwrap();
    let mcp = Mcp::connect(&t.url, &reader).await;
    let poll =
        tokio::spawn(async move { mcp.call("events_wait", json!({ "timeoutSec": 50 })).await });
    tokio::task::yield_now().await;

    let started = Instant::now();
    t.hub.shutdown.trigger();
    t.served.await.unwrap().unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "took {:?}",
        started.elapsed()
    );
    match app.next().await {
        Some(Ok(Message::Close(Some(frame)))) => assert_eq!(u16::from(frame.code), 1001),
        other => panic!("expected a 1001 close, got {other:?}"),
    }
    poll.abort();
}

/// The Status screen's rows over the app socket: every project the key reads, idle with nothing to count, and
/// none from a machine it can't read.
#[tokio::test]
async fn status_get_lists_one_row_per_readable_project() {
    let t = start().await;
    for (m, p, title) in [("devbox", "p1", "storefront"), ("other", "p2", "billing")] {
        t.hub
            .store
            .projects_upsert_many(
                &fleetd_contracts::ids::MachineId::unchecked(m),
                &[serde_json::from_value(json!({
                    "machineId": m, "projectId": p, "title": title, "workspaceRoot": "/work/app",
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
                    "lastActivityAt": "2026-10-19T10:00:00.000Z",
                }))
                .unwrap()],
            )
            .unwrap();
    }
    let rows_for = async |grants: Value| -> Vec<Value> {
        let reader = key(&t.hub, grants);
        let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
            .await
            .unwrap();
        app.send(Message::text(
            json!({ "t": "auth", "key": reader }).to_string(),
        ))
        .await
        .unwrap();
        let mut read = async || -> Value {
            serde_json::from_str(app.next().await.unwrap().unwrap().to_text().unwrap()).unwrap()
        };
        assert_eq!(read().await["t"], "ready");
        app.send(Message::text(
            json!({ "t": "call", "id": "p", "tool": "status_get", "input": {} }).to_string(),
        ))
        .await
        .unwrap();
        let mut read = async || -> Value {
            serde_json::from_str(app.next().await.unwrap().unwrap().to_text().unwrap()).unwrap()
        };
        let got = read().await;
        got["output"]["rows"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let all = rows_for(json!([{ "role": "read", "machines": "*" }])).await;
    let titles: Vec<&str> = all.iter().map(|r| r["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["billing", "storefront"], "by title");
    assert_eq!(all[1]["state"], "idle");
    assert_eq!(all[1]["agentsRunning"], 0);
    assert!(
        all[1].get("progress").is_none(),
        "nothing to count: no bar, not 0%"
    );
    let one = rows_for(json!([{ "role": "read", "machines": ["devbox"] }])).await;
    assert_eq!(one.len(), 1);
    assert_eq!(one[0]["projectRef"]["machineId"], "devbox");
}

/// A hub home an earlier fleetd left an owner.key in: once the hub starts, the file is gone and its key no longer works.
#[tokio::test]
async fn a_starting_hub_revokes_the_owner_key_and_deletes_its_file() {
    use fleetd_contracts::auth::{GrantMachines, Role, Star};
    let home = tempfile::tempdir().unwrap();
    let file = home.path().join(crate::hub::auth::RETIRED_OWNER_KEY_FILE);
    let owner =
        crate::hub::auth::Auth::new(HubDb::open(home.path()).unwrap(), Arc::new(SystemClock))
            .create_key(
                "owner",
                &[Grant {
                    role: Role::Admin,
                    machines: GrantMachines::All(Star::Value),
                }],
                KeyKind::Human,
            )
            .unwrap();
    std::fs::write(&file, format!("{}\n", owner.key)).unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let hub = super::build(config, Arc::new(SystemClock)).unwrap();
    assert!(!file.exists());
    assert!(hub.auth.verify(&owner.key).is_err());
}

/// A hub frees its parts once its last handle goes: a cycle among them (a hook one part holds that holds another part
/// back) keeps every test's database, files and runtime handles open until the test process ends.
#[tokio::test]
async fn a_dropped_hub_frees_its_parts() {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let db = HubDb::open(home.path()).unwrap();
    let parts = Arc::downgrade(&db);
    let hub = build_on(db, config, Arc::new(SystemClock)).unwrap();
    let (executors, leads, tasks) = (
        Arc::downgrade(&hub.executors),
        Arc::downgrade(&hub.leads),
        Arc::downgrade(&hub.tasks),
    );
    drop(hub);
    assert_eq!(
        (
            parts.strong_count(),
            executors.strong_count(),
            leads.strong_count(),
            tasks.strong_count()
        ),
        (0, 0, 0, 0),
        "the database, executors, leads and tasks outlive the hub"
    );
}

/// A chat watched on an open socket stops streaming to a teammate once its owner turns Only me on: what the lead says
/// next is the owner's alone, as a new `chat` request would be refused.
#[tokio::test]
async fn a_watched_chat_stops_streaming_to_a_teammate_once_it_is_only_me() {
    use crate::hub::chat::NewMessage;
    use fleetd_contracts::chat::ChatAuthor;
    let t = start().await;
    let people = crate::hub::people::People::new(t.hub.db.clone(), t.hub.clock.clone());
    let ann = people.ensure_owner().unwrap().person_id;
    let bob = people
        .create(
            &fleetd_contracts::people::PersonName::unchecked("Bob"),
            fleetd_contracts::people::HubRole::Member,
        )
        .unwrap()
        .person_id;
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": "operate", "machines": "*" }])).unwrap();
    let bob_key = t
        .hub
        .auth
        .create_key_for("phone", &grants, KeyKind::Human, Some(&bob))
        .unwrap()
        .key;
    let project = json!({ "machineId": "devbox", "projectId": "p1" });
    let r: fleetd_contracts::ids::ProjectRef = serde_json::from_value(project.clone()).unwrap();
    let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
        .await
        .unwrap();
    for frame in [
        json!({ "t": "auth", "key": bob_key }),
        json!({ "t": "chat", "project": project }),
    ] {
        app.send(Message::text(frame.to_string())).await.unwrap();
    }
    app.next().await.unwrap().unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let say = |text: &str| {
        let (mut m, _) = t
            .hub
            .chat
            .add(
                &r,
                NewMessage {
                    author: Some(ChatAuthor::Lead),
                    streaming: true,
                    ..Default::default()
                },
            )
            .unwrap();
        t.hub.chat.append(&mut m, text).unwrap();
    };
    // The next text frame Bob gets: a delta, or the refusal.
    async fn next(
        app: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> String {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match app.next().await {
                    Some(Ok(Message::Text(text))) => return text.to_string(),
                    Some(Ok(_)) => {}
                    other => panic!("the socket ended: {other:?}"),
                }
            }
        })
        .await
        .unwrap()
    }
    say("Booked the 9:40.");
    assert!(next(&mut app).await.contains("chat_delta"));
    while tokio::time::timeout(Duration::from_millis(200), app.next())
        .await
        .is_ok()
    {}

    t.hub
        .db
        .with(|c| {
            c.execute(
                "INSERT INTO project_settings (machine_id, project_id, only_me, owner_person, created_ms, created_by_key, created_by_name)
                 VALUES ('devbox', 'p1', 1, ?, 0, 'k', 'desk')
                 ON CONFLICT (machine_id, project_id) DO UPDATE SET only_me = 1, owner_person = excluded.owner_person",
                [ann.as_str()],
            )?;
            Ok(())
        })
        .unwrap();
    say("Your passport number is on file.");
    let got = next(&mut app).await;
    assert!(!got.contains("chat_delta"), "{got}");
    assert!(got.contains("Only me"), "{got}");
}

/// A client that stops reading (a phone suspended with its socket open) while a lead streams into the chat it watches:
/// the hub holds a bounded queue for it, then closes it, and a client that keeps reading gets every delta.
#[tokio::test]
async fn an_app_connection_that_stops_reading_is_closed_once_too_far_behind() {
    use crate::hub::chat::NewMessage;
    use fleetd_contracts::chat::ChatAuthor;
    let t = start().await;
    let reader = key(&t.hub, json!([{ "role": "read", "machines": "*" }]));
    let project = json!({ "machineId": "devbox", "projectId": "p1" });
    let r: fleetd_contracts::ids::ProjectRef = serde_json::from_value(project.clone()).unwrap();
    let subscribe = || async {
        let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
            .await
            .unwrap();
        app.send(Message::text(
            json!({ "t": "auth", "key": reader }).to_string(),
        ))
        .await
        .unwrap();
        app.next().await.unwrap().unwrap();
        app.send(Message::text(
            json!({ "t": "chat", "project": project }).to_string(),
        ))
        .await
        .unwrap();
        app
    };
    let mut stalled = subscribe().await;
    let mut reading = subscribe().await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let got = tokio::spawn(async move {
        let mut deltas = 0;
        while deltas < 4000 {
            match reading.next().await {
                Some(Ok(Message::Text(text))) if text.contains("chat_delta") => deltas += 1,
                Some(Ok(_)) => {}
                other => panic!("the reading client lost its connection: {other:?}"),
            }
        }
        deltas
    });

    // 4000 deltas of 4000 characters: 16 MB, past the queue's 8 MiB and what the loopback buffers hold.
    let part = "x".repeat(4000);
    for _ in 0..200 {
        let (mut m, _) = t
            .hub
            .chat
            .add(
                &r,
                NewMessage {
                    author: Some(ChatAuthor::Lead),
                    streaming: true,
                    ..Default::default()
                },
            )
            .unwrap();
        for _ in 0..20 {
            t.hub.chat.append(&mut m, &part).unwrap();
            // Let both forwarders run, so the broadcast's 256 slots don't lag either.
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(30), got)
            .await
            .unwrap()
            .unwrap(),
        4000
    );

    // The stalled client finds what was already on its way, then the end of the connection.
    let mut deltas = 0;
    let ended = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match stalled.next().await {
                Some(Ok(Message::Text(text))) if text.contains("chat_delta") => deltas += 1,
                Some(Ok(Message::Close(frame))) => return frame.map(|f| u16::from(f.code)),
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return None,
            }
        }
    })
    .await;
    assert!(ended.is_ok(), "the hub kept the stalled connection open");
    assert!(
        deltas < 4000,
        "the stalled client was sent everything ({deltas} deltas)"
    );
}

#[tokio::test(start_paused = true)]
async fn an_idle_app_link_is_pinged_and_a_busy_one_is_not() {
    use crate::hub::app_ws::KEEPALIVE;
    let t = start().await;
    let reader = key(&t.hub, json!([{ "role": "read", "machines": "*" }]));
    let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
        .await
        .unwrap();
    app.send(Message::text(
        json!({ "t": "auth", "key": reader }).to_string(),
    ))
    .await
    .unwrap();
    let ready = app.next().await.unwrap().unwrap();
    assert!(ready.is_text());
    // Silence from both ends: the hub pings once KEEPALIVE has passed, and again after as long.
    let quiet = tokio::time::Instant::now();
    for n in 1..=2 {
        let next = app.next().await.unwrap().unwrap();
        assert!(matches!(next, Message::Ping(_)), "got {next:?}");
        assert_eq!(quiet.elapsed().as_secs(), KEEPALIVE.as_secs() * n);
    }
    // A client that pings on its own (the desktop app) keeps the flow alive: the hub answers and sends no ping.
    for _ in 0..6 {
        tokio::time::sleep(KEEPALIVE / 2).await;
        app.send(Message::Ping(Default::default())).await.unwrap();
        let next = app.next().await.unwrap().unwrap();
        assert!(matches!(next, Message::Pong(_)), "got {next:?}");
    }
}

#[tokio::test]
async fn an_app_that_asks_for_deflate_gets_compressed_frames_and_an_older_one_text() {
    use crate::link_deflate::{Deflater, Inflater};
    let t = start().await;
    let reader = key(&t.hub, json!([{ "role": "read", "machines": "*" }]));
    // A call whose answer is long enough to compress.
    let big = json!({ "t": "call", "id": "c1", "tool": "prompt_get", "input": {} });

    // An older app names no features: every frame is Text, as before.
    let (mut old, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
        .await
        .unwrap();
    for frame in [json!({ "t": "auth", "key": reader }), big.clone()] {
        old.send(Message::text(frame.to_string())).await.unwrap();
    }
    for _ in 0..2 {
        let frame = old.next().await.unwrap().unwrap();
        assert!(frame.is_text(), "an older app got {frame:?}");
    }

    let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
        .await
        .unwrap();
    for frame in [
        json!({ "t": "auth", "key": reader, "features": ["deflate"] }),
        big.clone(),
    ] {
        app.send(Message::text(frame.to_string())).await.unwrap();
    }
    // `ready` is Text and says the hub reads compressed frames too.
    let ready: Value =
        serde_json::from_str(app.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(ready["t"], "ready");
    assert!(
        ready["features"]
            .as_array()
            .unwrap()
            .contains(&json!("deflate"))
    );
    // What follows is one deflate stream: the same answer twice, the second a fraction of the first on the wire.
    let mut inflater = Inflater::default();
    let mut read = async |app: &mut tokio_tungstenite::WebSocketStream<_>| match app
        .next()
        .await
        .unwrap()
        .unwrap()
    {
        Message::Binary(data) => (
            data.len(),
            serde_json::from_str::<Value>(&inflater.inflate(&data, 64 << 20).unwrap()).unwrap(),
        ),
        other => panic!("expected a compressed frame, got {other:?}"),
    };
    let (first, answer) = read(&mut app).await;
    assert_eq!(
        (answer["t"].as_str(), answer["id"].as_str()),
        (Some("result"), Some("c1"))
    );
    let plain = answer.to_string().len();
    assert!(first * 3 < plain, "{first} bytes for {plain}");
    // The app's own frame, compressed on its stream, is read like Text.
    let mut deflater = Deflater::default();
    let again = json!({ "t": "call", "id": "c2", "tool": "prompt_get", "input": {} }).to_string();
    app.send(Message::Binary(deflater.deflate(&again).into()))
        .await
        .unwrap();
    let (second, answer) = read(&mut app).await;
    assert_eq!(answer["id"], "c2");
    assert!(
        second * 10 < first,
        "a repeat cost {second} bytes after {first}"
    );

    // A Binary frame that isn't deflate data ends the connection.
    app.send(Message::Binary(vec![0xff; 16].into()))
        .await
        .unwrap();
    match app.next().await.unwrap().unwrap() {
        Message::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 1007),
        other => panic!("expected a close, got {other:?}"),
    }
}

/// An /app socket whose upgrade request carries `key` and `features` (`APP_FEATURES_HEADER`).
async fn app_with_upgrade_auth(
    t: &TestHub,
    key: &str,
    features: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = format!("ws://{}/app", t.url).into_client_request().unwrap();
    let headers = request.headers_mut();
    headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
    headers.insert(
        fleetd_contracts::app::APP_FEATURES_HEADER,
        features.parse().unwrap(),
    );
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

#[tokio::test]
async fn an_upgrade_that_carries_the_key_gets_ready_and_the_snapshot_before_any_frame() {
    let t = start().await;
    let reader = key(&t.hub, json!([{ "role": "read", "machines": "*" }]));
    let mut app = app_with_upgrade_auth(&t, &reader, "").await;
    let read = async |app: &mut tokio_tungstenite::WebSocketStream<_>| {
        serde_json::from_str::<Value>(app.next().await.unwrap().unwrap().to_text().unwrap())
            .unwrap()
    };
    // Nothing sent yet: `ready` and the snapshot come anyway.
    assert_eq!(read(&mut app).await["t"], "ready");
    let snapshot = read(&mut app).await;
    assert_eq!(snapshot["t"], "snapshot");
    assert!(snapshot["cursor"].is_number());
    // The client sends its auth and snapshot as it would to any hub: both are taken as answered, so the next frame
    // is the call's.
    for frame in [
        json!({ "t": "auth", "key": reader }),
        json!({ "t": "snapshot" }),
        json!({ "t": "call", "id": "c1", "tool": "events_wait", "input": { "timeoutSec": 0 } }),
    ] {
        app.send(Message::text(frame.to_string())).await.unwrap();
    }
    let answer = read(&mut app).await;
    assert_eq!(
        (answer["t"].as_str(), answer["id"].as_str()),
        (Some("result"), Some("c1"))
    );
    // A snapshot asked for later (a resync) is answered.
    app.send(Message::text(json!({ "t": "snapshot" }).to_string()))
        .await
        .unwrap();
    assert_eq!(read(&mut app).await["t"], "snapshot");

    // A different key in the frame is a new auth, answered as always.
    let other = key(&t.hub, json!([{ "role": "read", "machines": "*" }]));
    let mut app = app_with_upgrade_auth(&t, &reader, "").await;
    for _ in 0..2 {
        read(&mut app).await;
    }
    app.send(Message::text(
        json!({ "t": "auth", "key": other }).to_string(),
    ))
    .await
    .unwrap();
    assert_eq!(read(&mut app).await["t"], "ready");
}

#[tokio::test]
async fn an_upgrade_with_a_refused_key_waits_for_the_auth_frame_and_refuses_it_as_before() {
    let t = start().await;
    let mut app = app_with_upgrade_auth(&t, "fld_nope", "deflate").await;
    assert!(
        tokio::time::timeout(Duration::from_millis(300), app.next())
            .await
            .is_err(),
        "the hub sent a frame for a refused key"
    );
    app.send(Message::text(
        json!({ "t": "auth", "key": "fld_nope" }).to_string(),
    ))
    .await
    .unwrap();
    let refused: Value =
        serde_json::from_str(app.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(refused["t"], "error");
    match app.next().await.unwrap().unwrap() {
        Message::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 4401),
        other => panic!("expected a close, got {other:?}"),
    }
}

#[tokio::test]
async fn an_upgrade_that_asks_for_deflate_gets_ready_as_text_and_the_snapshot_compressed() {
    let t = start().await;
    let reader = key(&t.hub, json!([{ "role": "read", "machines": "*" }]));
    let mut app = app_with_upgrade_auth(&t, &reader, "deflate").await;
    let ready = app.next().await.unwrap().unwrap();
    assert!(ready.is_text(), "ready came as {ready:?}");
    let snapshot = match app.next().await.unwrap().unwrap() {
        Message::Binary(data) => crate::link_deflate::Inflater::default()
            .inflate(&data, 64 << 20)
            .unwrap(),
        other => panic!("expected the snapshot compressed, got {other:?}"),
    };
    assert_eq!(
        serde_json::from_str::<Value>(&snapshot).unwrap()["t"],
        "snapshot"
    );
}

#[tokio::test]
async fn a_compressed_app_resumes_from_an_old_cursor_with_every_event_it_may_see_in_order() {
    use crate::link_deflate::Inflater;
    let t = start().await;
    let a_only = key(&t.hub, json!([{ "role": "read", "machines": ["lab-a"] }]));
    for n in 0..4 {
        t.hub
            .events
            .append(event(if n % 2 == 0 { "lab-a" } else { "lab-b" }))
            .unwrap();
    }
    // The cursor the app last read, before a drop; more happens while it is away.
    let old = t.hub.events.head();
    let mut missed = Vec::new();
    for n in 0..20 {
        let machine = if n % 3 == 0 { "lab-b" } else { "lab-a" };
        let seq = t.hub.events.append(event(machine)).unwrap().seq.get();
        if machine == "lab-a" {
            missed.push(seq);
        }
    }
    let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
        .await
        .unwrap();
    for frame in [
        json!({ "t": "auth", "key": a_only, "features": ["deflate"] }),
        json!({ "t": "events", "cursor": old }),
    ] {
        app.send(Message::text(frame.to_string())).await.unwrap();
    }
    assert!(
        app.next().await.unwrap().unwrap().is_text(),
        "ready is Text"
    );
    let mut inflater = Inflater::default();
    let mut next_event = async || match app.next().await.unwrap().unwrap() {
        Message::Binary(data) => {
            serde_json::from_str::<Value>(&inflater.inflate(&data, 64 << 20).unwrap()).unwrap()
        }
        other => panic!("expected a compressed event, got {other:?}"),
    };
    let mut seen = Vec::new();
    while seen.len() < missed.len() {
        let event = next_event().await;
        assert_eq!(
            (event["t"].as_str(), event["machineId"].as_str()),
            (Some("event"), Some("lab-a"))
        );
        seen.push(event["seq"].as_i64().unwrap());
    }
    assert_eq!(seen, missed);
    // Then it carries on live, on the same stream.
    let live = t.hub.events.append(event("lab-a")).unwrap().seq.get();
    assert_eq!(next_event().await["seq"].as_i64(), Some(live));
}

type NodeSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A node linking as `devbox` with an enroll token, listing `capabilities`: its socket and the hub's welcome.
async fn link_node(t: &TestHub, capabilities: &[&str]) -> (NodeSocket, Value) {
    use base64::Engine;
    use ed25519_dalek::Signer;
    let b64 = base64::engine::general_purpose::STANDARD;
    let devbox = fleetd_contracts::ids::MachineId::unchecked("devbox");
    let token = t
        .hub
        .auth
        .create_enroll_token(&devbox, "test")
        .unwrap()
        .token;
    let key = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let (mut node, _) = tokio_tungstenite::connect_async(format!("ws://{}/node/link", t.url))
        .await
        .unwrap();
    let challenge: Value =
        serde_json::from_str(node.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    let nonce = challenge["nonce"].as_str().unwrap();
    let hello = json!({
        "t": "hello", "machineId": "devbox", "name": "devbox", "nodeVersion": "0.0.0", "protocol": 1,
        "pubKey": b64.encode(key.verifying_key().to_bytes()),
        "sig": b64.encode(key.sign(nonce.as_bytes()).to_bytes()),
        "enrollToken": token, "capabilities": capabilities,
    });
    node.send(Message::text(hello.to_string())).await.unwrap();
    let welcome = match node.next().await.unwrap().unwrap() {
        Message::Text(text) => serde_json::from_str(&text).unwrap(),
        other => panic!("the welcome came as {other:?}"),
    };
    (node, welcome)
}

#[tokio::test]
async fn a_node_that_lists_link_deflate_gets_compressed_frames_and_an_older_one_text() {
    use crate::link_deflate::{Deflater, Inflater};
    use fleetd_contracts::node_link::{CAP_LINK_DEFLATE, HUB_CAP_LINK_DEFLATE};
    let t = start().await;

    // An older node lists nothing: the hub's frames after the welcome are Text, as before.
    let (mut old, welcome) = link_node(&t, &[]).await;
    assert_eq!(welcome["t"], "welcome");
    assert!(
        welcome["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!(HUB_CAP_LINK_DEFLATE))
    );
    let next = old.next().await.unwrap().unwrap();
    assert!(next.is_text(), "an older node got {next:?}");
    drop(old);

    let (mut node, welcome) = link_node(&t, &[CAP_LINK_DEFLATE]).await;
    assert_eq!(welcome["t"], "welcome");
    // The runner check the hub asks every new link: compressed, and it inflates to the same frame.
    let mut inflater = Inflater::default();
    let asked: Value = match node.next().await.unwrap().unwrap() {
        Message::Binary(data) => {
            serde_json::from_str(&inflater.inflate(&data, 1 << 20).unwrap()).unwrap()
        }
        other => panic!("expected a compressed frame, got {other:?}"),
    };
    assert!(asked["t"].is_string(), "{asked}");
    // The node's compressed heartbeat is read like Text; then a frame that won't inflate ends the link.
    let mut deflater = Deflater::default();
    let beat = json!({ "t": "hb", "at": "2026-11-07T10:00:00.000Z" }).to_string();
    node.send(Message::Binary(deflater.deflate(&beat).into()))
        .await
        .unwrap();
    node.send(Message::Binary(vec![0xff; 16].into()))
        .await
        .unwrap();
    loop {
        match node.next().await.unwrap().unwrap() {
            Message::Close(Some(frame)) => {
                assert_eq!(
                    u16::from(frame.code),
                    fleetd_contracts::node_link::close::BAD_FRAME
                );
                assert!(frame.reason.contains("inflate"), "{}", frame.reason);
                break;
            }
            Message::Binary(_) | Message::Text(_) => {}
            other => panic!("unexpected {other:?}"),
        }
    }
}

/// The next lead_result the hub sends a node; a link that closes first fails the test with its close frame.
async fn next_lead_result(node: &mut NodeSocket) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), node.next())
            .await
            .expect("no lead_result within 10 s")
        {
            Some(Ok(Message::Text(text))) => {
                let frame: Value = serde_json::from_str(&text).unwrap();
                if frame["t"] == "lead_result" {
                    return frame;
                }
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            other => panic!("the link ended: {other:?}"),
        }
    }
}

/// One frame from the node that doesn't decode (a newer node's call, a field out of range) is refused alone: the
/// link stays up, a lead call among them is answered with an error so its agent isn't left waiting, and the good
/// frames around them are handled. On Nov 8 one such frame closed the devbox's whole link.
#[tokio::test]
async fn an_undecodable_node_frame_is_refused_alone_and_the_link_stays_up() {
    let t = start().await;
    let devbox = fleetd_contracts::ids::MachineId::unchecked("devbox");
    let (mut node, welcome) = link_node(&t, &[]).await;
    assert_eq!(welcome["t"], "welcome");
    let link = t.hub.link.link_id(&devbox).expect("linked");
    let frames = [
        json!({ "t": "hb", "at": "2026-11-08T16:48:00.000Z" }),
        json!({ "t": "lead_call", "id": "bad-1", "cwd": "/w", "call": { "op": "a_newer_nodes_call" } }),
        json!({ "t": "machine_event", "seq": "not a number" }),
        json!({ "t": "lead_call", "id": "good-1", "cwd": "/w", "call": { "op": "task_list" } }),
        json!({ "t": "hb", "at": "2026-11-08T16:48:15.000Z" }),
    ];
    for frame in frames {
        node.send(Message::text(frame.to_string())).await.unwrap();
    }
    let refused = next_lead_result(&mut node).await;
    assert_eq!(refused["id"], "bad-1");
    assert_eq!(refused["error"]["code"], "invalid", "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("could not read"),
        "{refused}"
    );
    let answered = next_lead_result(&mut node).await;
    assert_eq!(answered["id"], "good-1", "{answered}");
    assert_eq!(
        t.hub.link.link_id(&devbox),
        Some(link),
        "the link was replaced"
    );
}

/// The hub's stop (SIGTERM) waits for the lead calls it is answering: one in flight gets its answer, one that comes in
/// meanwhile is told it didn't run, and only then does the link close, as a restart (1012), so the node redials at
/// once rather than find its socket reset.
#[tokio::test]
async fn a_lead_call_in_flight_at_the_stop_is_answered_then_the_link_closes_as_a_restart() {
    let t = start().await;
    let (mut node, welcome) = link_node(&t, &[]).await;
    assert_eq!(welcome["t"], "welcome");
    // A call the hub is still answering, held open by the test.
    let in_flight = t.hub.link.call_started().expect("not stopping yet");
    let link = t.hub.link.clone();
    let stopped = tokio::spawn(async move { link.stop(Duration::from_secs(2)).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let late =
        json!({ "t": "lead_call", "id": "late-1", "cwd": "/w", "call": { "op": "task_list" } });
    node.send(Message::text(late.to_string())).await.unwrap();
    let refused = next_lead_result(&mut node).await;
    assert_eq!(refused["id"], "late-1");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("restarting, so this call didn't run"),
        "{refused}"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !stopped.is_finished(),
        "the stop waits for the call in flight"
    );
    let started = Instant::now();
    drop(in_flight);
    stopped.await.unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "{:?}",
        started.elapsed()
    );
    loop {
        match tokio::time::timeout(Duration::from_secs(5), node.next())
            .await
            .expect("the link closes")
        {
            Some(Ok(Message::Close(Some(frame)))) => {
                assert_eq!(
                    (u16::from(frame.code), frame.reason.as_str()),
                    (
                        fleetd_contracts::node_link::close::RESTART,
                        "hub restarting"
                    )
                );
                break;
            }
            Some(Ok(Message::Text(_) | Message::Ping(_) | Message::Pong(_))) => {}
            other => panic!("expected a 1012 close, got {other:?}"),
        }
    }
}

/// A call still running when the stop's wait is over doesn't hold the hub up: the link closes anyway.
#[tokio::test]
async fn the_stop_waits_for_lead_calls_only_so_long() {
    let t = start().await;
    let (mut node, _) = link_node(&t, &[]).await;
    let _stuck = t.hub.link.call_started().unwrap();
    let started = Instant::now();
    t.hub.link.stop(Duration::from_millis(300)).await;
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    loop {
        match node.next().await {
            Some(Ok(Message::Close(Some(frame)))) => {
                assert_eq!(u16::from(frame.code), 1012);
                break;
            }
            Some(Ok(_)) => {}
            other => panic!("expected a 1012 close, got {other:?}"),
        }
    }
}

/// A node that sends nothing readable is still cut off: past the minute's limit of bad frames, the link ends.
#[tokio::test]
async fn a_flood_of_undecodable_node_frames_ends_the_link() {
    let t = start().await;
    let (mut node, _) = link_node(&t, &[]).await;
    for _ in 0..=crate::link_frames::BAD_FRAMES_PER_MINUTE {
        let bad = json!({ "t": "machine_event", "seq": "not a number" });
        node.send(Message::text(bad.to_string())).await.unwrap();
    }
    loop {
        match node.next().await.unwrap().unwrap() {
            Message::Close(Some(frame)) => {
                assert_eq!(
                    u16::from(frame.code),
                    fleetd_contracts::node_link::close::BAD_FRAME
                );
                assert!(frame.reason.contains("too many"), "{}", frame.reason);
                break;
            }
            Message::Text(_) | Message::Ping(_) | Message::Pong(_) => {}
            other => panic!("unexpected {other:?}"),
        }
    }
}

/// A 25 MiB put_file over 1 Mbit/s takes minutes as one frame: bytes still arriving keep the link up, and silence
/// is timed from the last of them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_frame_still_coming_in_keeps_the_link_alive() {
    use crate::hub::store::test_clock::ManualClock;
    use fleetd_contracts::events::HubEventType;
    use tokio::io::AsyncWriteExt;
    let clock = ManualClock::at(1_792_000_000_000);
    let t = start_on(clock.clone()).await;
    let devbox = fleetd_contracts::ids::MachineId::unchecked("devbox");
    let (node, _) = link_node(&t, &[]).await;
    let offline = || {
        t.hub
            .events
            .page(0, Some(&[HubEventType::MachineOffline]), None)
            .unwrap()
            .events
            .len()
    };
    // One masked Text frame (a zero mask leaves the payload as it is), its header now and its body bit by bit.
    let mut tcp = match node.into_inner() {
        tokio_tungstenite::MaybeTlsStream::Plain(tcp) => tcp,
        _ => unreachable!("plain ws"),
    };
    let body = 1u64 << 20;
    let mut header = vec![0x81, 0x80 | 127];
    header.extend_from_slice(&body.to_be_bytes());
    header.extend_from_slice(&[0; 4]);
    tcp.write_all(&header).await.unwrap();
    let step = Duration::from_secs(5);
    // Twice the silence timeout, a little of the frame every 5 s.
    for _ in 0..18 {
        tcp.write_all(&[b' '; 1024]).await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        clock.advance(step);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        offline(),
        0,
        "a link whose frame is still coming in went offline"
    );
    assert!(t.hub.link.link_id(&devbox).is_some());
    // The bytes stop: once the timeout passes with none, the machine is offline.
    for _ in 0..10 {
        clock.advance(step);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(offline(), 1);
}

/// An app connection authed as `key`, with its event stream and a chat subscription open.
async fn app_streaming(
    url: &str,
    key: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{url}/app"))
        .await
        .unwrap();
    app.send(Message::text(
        json!({ "t": "auth", "key": key }).to_string(),
    ))
    .await
    .unwrap();
    let ready: Value =
        serde_json::from_str(app.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(ready["t"], "ready", "{ready}");
    for frame in [
        json!({ "t": "events", "cursor": 0 }),
        json!({ "t": "chat", "project": { "machineId": "devbox", "projectId": "p1" } }),
    ] {
        app.send(Message::text(frame.to_string())).await.unwrap();
    }
    app
}

/// The close code the hub ends `app` with, skipping the frames before it; panics if none comes within 5 seconds.
async fn closed_with(
    app: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> u16 {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match app.next().await {
                Some(Ok(Message::Close(Some(frame)))) => return u16::from(frame.code),
                Some(Ok(_)) => {}
                other => panic!("expected a close, got {other:?}"),
            }
        }
    })
    .await
    .expect("the hub kept a revoked key's connection open")
}

/// A signed-out device's open app connection is closed as refused at once: it never goes on streaming the hub's
/// events and chats to a device that no longer has a key.
#[tokio::test]
async fn a_revoked_device_s_open_app_connection_is_closed_at_once() {
    let t = start().await;
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": "operate", "machines": "*" }])).unwrap();
    let device = t
        .hub
        .auth
        .create_key("phone", &grants, KeyKind::Human)
        .unwrap();
    let mut app = app_streaming(&t.url, &device.key).await;
    t.hub.auth.revoke(device.info.key_id.as_str()).unwrap();
    assert_eq!(closed_with(&mut app).await, 4401);
}

/// So is every open connection of a person removed from the hub.
#[tokio::test]
async fn a_removed_person_s_open_app_connections_are_closed_at_once() {
    let t = start().await;
    let people = crate::hub::people::People::new(t.hub.db.clone(), t.hub.clock.clone());
    people.ensure_owner().unwrap();
    let admin: Vec<Grant> =
        serde_json::from_value(json!([{ "role": "admin", "machines": "*" }])).unwrap();
    let owner = t
        .hub
        .auth
        .create_key("laptop", &admin, KeyKind::Human)
        .unwrap();
    let member = people
        .create(
            &fleetd_contracts::people::PersonName::unchecked("Sam"),
            fleetd_contracts::people::HubRole::Member,
        )
        .unwrap();
    let operate: Vec<Grant> =
        serde_json::from_value(json!([{ "role": "operate", "machines": "*" }])).unwrap();
    let device = t
        .hub
        .auth
        .create_key_for("phone", &operate, KeyKind::Human, Some(&member.person_id))
        .unwrap();
    let mut app = app_streaming(&t.url, &device.key).await;
    let mcp = Mcp::connect(&t.url, &owner.key).await;
    let (failed, out) = mcp
        .call(
            "person_remove",
            json!({ "personId": member.person_id.as_str() }),
        )
        .await;
    assert!(!failed, "{out}");
    assert_eq!(closed_with(&mut app).await, 4401);
}

/// A person's device on an open /app socket, authenticated and streaming the event log.
async fn streaming_device(
    t: &TestHub,
    person: Option<&fleetd_contracts::people::PersonId>,
) -> (
    String,
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
) {
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": "admin", "machines": "*" }])).unwrap();
    let created = t
        .hub
        .auth
        .create_key_for("phone", &grants, KeyKind::Human, person)
        .unwrap();
    let (mut app, _) = tokio_tungstenite::connect_async(format!("ws://{}/app", t.url))
        .await
        .unwrap();
    for frame in [
        json!({ "t": "auth", "key": created.key }),
        json!({ "t": "events", "cursor": 0 }),
    ] {
        app.send(Message::text(frame.to_string())).await.unwrap();
    }
    let ready: Value =
        serde_json::from_str(app.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
    assert_eq!(ready["t"], "ready");
    (created.info.key_id.to_string(), app)
}

/// A key revoked outside this hub's process (`fleetd hub key revoke` writes the database itself) is refused at the
/// socket's next frame, whatever it is: a snapshot reads the whole fleet.
#[tokio::test]
async fn a_key_revoked_elsewhere_is_refused_at_the_sockets_next_frame() {
    let t = start().await;
    let (key_id, mut app) = streaming_device(&t, None).await;
    t.hub
        .db
        .with(|c| {
            c.execute(
                "UPDATE agent_keys SET revoked_ms = 1 WHERE key_id = ?",
                [&key_id],
            )?;
            Ok(())
        })
        .unwrap();
    app.send(Message::text(json!({ "t": "snapshot" }).to_string()))
        .await
        .unwrap();
    let mut got_snapshot = false;
    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match app.next().await {
                Some(Ok(Message::Text(text))) if text.contains("\"snapshot\"") => {
                    got_snapshot = true
                }
                Some(Ok(Message::Close(frame))) => return frame.map(|f| u16::from(f.code)),
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return None,
            }
        }
    })
    .await
    .ok()
    .flatten();
    assert!(!got_snapshot, "a revoked key read the snapshot");
    assert_eq!(closed, Some(crate::hub::app_ws::CLOSE_UNAUTHORIZED));
}
