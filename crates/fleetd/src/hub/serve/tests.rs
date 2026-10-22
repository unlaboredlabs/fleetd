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
    interrupts: Arc<AtomicUsize>,
    // Each test gets its own home: the webhook key file is created there, and a shared one races between tests.
    _home: tempfile::TempDir,
}

/// The real registry plus an operate tool that counts its calls and a tool that panics.
async fn start() -> TestHub {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
        retro_model: None,
    };
    let hub = build_on(HubDb::open_memory().unwrap(), config, Arc::new(SystemClock)).unwrap();
    let mut tools: Registry = api::registry();
    let interrupts = Arc::new(AtomicUsize::new(0));
    let counter = interrupts.clone();
    tools.add_raw("thread_interrupt", move |_, _, _| {
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
        interrupts,
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
        .call(
            "thread_interrupt",
            json!({ "machineId": "lab-a", "threadId": "t1" }),
        )
        .await;
    assert!(is_error);
    assert_eq!(
        body,
        json!({ "code": "forbidden", "message": "This key lacks the operate role.",
        "fix": "Ask the hub admin for a key with that grant (fleetd hub key create --role … --machines …)." })
    );
    assert_eq!(t.interrupts.load(Ordering::SeqCst), 0);
    assert!(!a_only.call("thread_interrupt", json!({})).await.0);
    assert_eq!(t.interrupts.load(Ordering::SeqCst), 1);

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
        json!({ "t": "call", "id": "c1", "tool": "thread_interrupt", "input": {} }),
        json!({ "t": "call", "id": "c2", "tool": "nope", "input": {} }),
    ] {
        app.send(Message::text(frame.to_string())).await.unwrap();
    }
    let mut frames = Vec::new();
    while frames.len() < 4 {
        frames.push(
            serde_json::from_str::<Value>(app.next().await.unwrap().unwrap().to_text().unwrap())
                .unwrap(),
        );
    }
    frames.sort_by_key(|f| f["id"].as_str().unwrap_or("").to_owned());
    assert_eq!(frames[0], json!({ "t": "ready", "protocol": 1 }));
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

/// One raw POST to /github with the given signature header.
async fn deliver(url: &str, signature: &str, body: &str) -> u16 {
    let mut stream = tokio::net::TcpStream::connect(url).await.unwrap();
    let request = format!(
        "POST /github HTTP/1.1\r\nhost: {url}\r\nconnection: close\r\nx-github-event: push\r\nx-hub-signature-256: {signature}\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).await.unwrap();
    reply.split(' ').nth(1).unwrap().parse().unwrap()
}

#[tokio::test]
async fn github_deliveries_need_webhooks_on_and_a_valid_signature_then_kick_the_repo() {
    use hmac::{Hmac, Mac};
    let t = start().await;
    let body = r#"{"repository":{"full_name":"Acme/Storefront"}}"#;
    assert_eq!(
        deliver(&t.url, "sha256=00", body).await,
        404,
        "off by default"
    );
    t.hub
        .db
        .with(|c| {
            c.execute(
                "INSERT INTO trains (repo, machine_id, project_id, watch_since_ms) VALUES ('acme/storefront', 'devbox', 'p1', 0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let sealed = crate::hub::train::secret_box::SecretBox::for_home(&t.hub.config.home)
        .unwrap()
        .seal("s3cret");
    std::fs::write(t.hub.config.home.join("github-webhook.secret"), sealed).unwrap();
    t.hub.train.set_webhooks(true);
    assert_eq!(deliver(&t.url, "sha256=00", body).await, 401);
    assert_eq!(t.hub.train.last_delivery("acme/storefront"), None);
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(b"s3cret").unwrap();
    mac.update(body.as_bytes());
    let hex: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(deliver(&t.url, &format!("sha256={hex}"), body).await, 202);
    assert!(t.hub.train.last_delivery("acme/storefront").is_some());
    t.hub.shutdown.trigger();
    let _ = t.served.await;
}

#[tokio::test]
async fn a_new_status_wait_supersedes_the_connection_s_old_one_at_once() {
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
    let read = async |app: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >|
           -> Value {
        serde_json::from_str(app.next().await.unwrap().unwrap().to_text().unwrap()).unwrap()
    };
    assert_eq!(read(&mut app).await["t"], "ready");
    let fleet = json!({ "kind": "fleet" });
    app.send(Message::text(
        json!({ "t": "call", "id": "g", "tool": "status_get", "input": { "scope": fleet } })
            .to_string(),
    ))
    .await
    .unwrap();
    let got = read(&mut app).await;
    let version = got["output"]["doc"]["version"].as_i64().unwrap();
    // Waits past the current version block; the second supersedes the first, which answers at once.
    for id in ["w1", "w2"] {
        let wait = json!({ "t": "call", "id": id, "tool": "status_wait", "input": { "scope": fleet, "after": version, "timeoutSec": 50 } });
        app.send(Message::text(wait.to_string())).await.unwrap();
    }
    let first = tokio::time::timeout(std::time::Duration::from_secs(5), read(&mut app))
        .await
        .expect("w1 answered at once");
    assert_eq!(first["id"], "w1");
    assert_eq!(
        first["output"],
        json!({ "unchanged": true, "version": version })
    );
    // w2 stays open; nothing else arrives for it yet.
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), read(&mut app))
            .await
            .is_err()
    );
}

/// The Status screen's rows over the app socket: every project the key reads, idle with nothing to count, and
/// none from a machine it can't read.
#[tokio::test]
async fn status_projects_lists_one_row_per_readable_project() {
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
            json!({ "t": "call", "id": "p", "tool": "status_projects", "input": {} }).to_string(),
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
