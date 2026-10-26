//! Browser sessions end to end, on a real Chrome against a local test site, with the hub in process: an agent starts a
//! session, drives it through the node's proxy as agent-browser does, ends it, and its recording is on the hub. They
//! need a Chrome (FLEETD_TEST_CHROME, Playwright's headless shell in ~/.cache/ms-playwright, or google-chrome) and say
//! so and pass without one; the video also needs an ffmpeg (FLEETD_TEST_FFMPEG, Playwright's, or one on PATH). The
//! agent-browser test runs when FLEETD_TEST_AGENT_BROWSER names its binary.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::browser::{BrowserCallFrame, BrowserControl};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, op_name};
use fleetd_contracts::sessions::ThreadItem;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::Message;

use super::upload::{HubCalls, HubFuture};
use super::{Broker, BrowserConfig, SessionHooks};
use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::HubDb;
use crate::node::mask::Masker;
use crate::node::util::AbortOnDrop;

const THREAD: &str = "th-browser-1";

fn on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

fn playwright_cache() -> PathBuf {
    crate::node::util::home_dir().join(".cache/ms-playwright")
}

fn chrome() -> Option<PathBuf> {
    std::env::var_os("FLEETD_TEST_CHROME")
        .map(PathBuf::from)
        .or_else(|| super::chrome::find_chrome(&playwright_cache()))
        .or_else(|| on_path("google-chrome"))
        .or_else(|| on_path("chromium"))
}

fn ffmpeg() -> Option<PathBuf> {
    std::env::var_os("FLEETD_TEST_FFMPEG")
        .map(PathBuf::from)
        .or_else(|| super::chrome::find_ffmpeg(&playwright_cache()))
        .or_else(|| on_path("ffmpeg"))
}

/// The hub in process, answering the node's calls as a task's session in project storefront.
struct TestHub {
    hub: Arc<Hub>,
    project: ProjectRef,
}

impl HubCalls for TestHub {
    fn call(&self, _thread: &str, _cwd: &str, call: LeadCall) -> HubFuture {
        let handler = self
            .hub
            .lead_calls
            .handler(&op_name(&call))
            .expect("a handler");
        let caller = LeadCaller {
            project_ref: self.project.clone(),
            by: crate::hub::link::lead_calls::lead_by(&self.project),
            agent: CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T1")),
        };
        handler.handle(caller, call)
    }
}

fn hub(home: &Path) -> Arc<TestHub> {
    let config = HubConfig {
        home: home.to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        crate::hub::store::test_clock::ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    let project = ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("storefront"),
    };
    hub.store
        .projects_upsert_many(
            &project.machine_id,
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "storefront", "title": "storefront",
                "workspaceRoot": "/work/storefront", "lastActivityAt": "2026-10-26T10:00:00.000Z",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
            }))
            .unwrap()],
        )
        .unwrap();
    Arc::new(TestHub { hub, project })
}

/// A local site: a login form at /, and /login, which greets whoever signed in.
async fn site() -> (String, AbortOnDrop) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let serving = tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let Ok(n) = tcp.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&request).into_owned();
                    let Some(head_end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let length: usize = text[..head_end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if request.len() < head_end + 4 + length {
                        continue;
                    }
                    let body =
                        String::from_utf8_lossy(&request[head_end + 4..head_end + 4 + length])
                            .into_owned();
                    let page = if text.starts_with("GET /secret") {
                        // A project secret as a page shows it: HTML-escaped, and inside longer base64.
                        let html = PROJECT_SECRET.replace('&', "&amp;").replace('<', "&lt;");
                        let b64 = B64.encode(format!("key={PROJECT_SECRET};"));
                        format!(
                            "<html><body><p title=\"{html}\">{html}</p><p>{b64}</p></body></html>"
                        )
                    } else if text.starts_with("POST /login") {
                        let user = body
                            .split('&')
                            .find_map(|kv| kv.strip_prefix("user="))
                            .unwrap_or_default()
                            .to_owned();
                        format!(
                            "<html><head><title>Welcome</title></head><body><h1>Welcome {user}</h1></body></html>"
                        )
                    } else {
                        "<html><head><title>Sign in</title></head><body><form method=post action=/login>\
                         <input id=user name=user><input id=pw name=pw type=password><button id=go>Sign in</button>\
                         </form></body></html>"
                            .to_owned()
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}",
                        page.len()
                    );
                    let _ = tcp.write_all(response.as_bytes()).await;
                    return;
                }
            });
        }
    });
    (base, AbortOnDrop(serving))
}

struct Rig {
    broker: Arc<Broker>,
    hub: Arc<TestHub>,
    node_home: tempfile::TempDir,
    _hub_home: tempfile::TempDir,
}

/// A broker with a warm Chrome, or None (said why) where this machine has none.
/// A secret of the agent session's project, as the node reads it for the session.
const PROJECT_SECRET: &str = "pa<ss&word-77";

async fn rig() -> Option<Rig> {
    rig_with(Vec::new()).await
}

async fn rig_with(secrets: Vec<(String, String)>) -> Option<Rig> {
    let Some(chrome) = chrome() else {
        eprintln!("skipped: no Chrome on this machine (set FLEETD_TEST_CHROME)");
        return None;
    };
    let node_home = tempfile::tempdir().unwrap();
    let hub_home = tempfile::tempdir().unwrap();
    let hub = hub(hub_home.path());
    let config = BrowserConfig {
        ffmpeg: ffmpeg().map(|p| p.to_string_lossy().into_owned()),
        ..BrowserConfig::default()
    };
    let broker = Broker::open(
        node_home.path(),
        config,
        hub.clone(),
        Arc::new(move |_| Ok(crate::node::mask::Secrets(secrets.clone()))),
    )
    .await;
    broker.ready(chrome);
    let deadline = Instant::now() + Duration::from_secs(20);
    while broker.warm() == 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(broker.warm(), 1, "the pool launched its browser");
    Some(Rig {
        broker,
        hub,
        node_home,
        _hub_home: hub_home,
    })
}

async fn call(broker: &Arc<Broker>, call: Value) -> Value {
    let frame: BrowserCallFrame = serde_json::from_value(json!({
        "id": "t1", "cwd": "/work/storefront", "threadId": THREAD, "call": call,
    }))
    .unwrap();
    serde_json::to_value(broker.handle(THREAD.to_owned(), frame).await).unwrap()
}

/// A raw CDP client, as agent-browser is one, on the session's proxy URL.
struct Driver {
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    next: u64,
    /// Every event seen so far.
    events: Vec<Value>,
}

impl Driver {
    async fn connect(url: &str) -> Result<Self, String> {
        let (ws, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Self {
            ws,
            next: 0,
            events: Vec::new(),
        })
    }

    /// The whole answer: `result` or `error`.
    async fn send(&mut self, session: Option<&str>, method: &str, params: Value) -> Value {
        self.next += 1;
        let mut message = json!({ "id": self.next, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        self.ws
            .send(Message::Text(message.to_string().into()))
            .await
            .unwrap();
        loop {
            let next = tokio::time::timeout(Duration::from_secs(20), self.ws.next())
                .await
                .expect("an answer in 20 s");
            let Some(Ok(Message::Text(text))) = next else {
                panic!("the proxy closed");
            };
            let value: Value = serde_json::from_str(&text).unwrap();
            if value["id"] == self.next {
                return value;
            }
            self.events.push(value);
        }
    }

    async fn ok(&mut self, session: Option<&str>, method: &str, params: Value) -> Value {
        let answer = self.send(session, method, params).await;
        assert!(answer.get("error").is_none(), "{method}: {answer}");
        answer["result"].clone()
    }

    async fn eval(&mut self, page: &str, expression: &str) -> Value {
        let result = self
            .ok(
                Some(page),
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await;
        result["result"]["value"].clone()
    }

    /// Attaches to the page as a driver does, and returns its session.
    async fn page(&mut self) -> String {
        let targets = self.ok(None, "Target.getTargets", json!({})).await;
        let page = targets["targetInfos"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["type"] == "page")
            .expect("a page")["targetId"]
            .clone();
        let attached = self
            .ok(
                None,
                "Target.attachToTarget",
                json!({ "targetId": page, "flatten": true }),
            )
            .await;
        attached["sessionId"].as_str().unwrap().to_owned()
    }

    async fn wait_for(&mut self, page: &str, expression: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        while self.eval(page, expression).await != true {
            assert!(Instant::now() < deadline, "never true: {expression}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

fn command_item(command: &str, output: &str) -> ThreadItem {
    serde_json::from_value(json!({
        "id": "toolu_1", "status": "completed", "title": command,
        "startedAt": "2026-10-26T10:00:00.000Z", "completedAt": "2026-10-26T10:00:00.120Z",
        "updatedAt": "2026-10-26T10:00:00.120Z",
        "kind": { "type": "command", "command": command, "output": output, "exitCode": 0 },
    }))
    .unwrap()
}

async fn sessions(hub: &TestHub) -> Value {
    let reader = serde_json::from_value(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": "2026-10-26T10:00:00.000Z",
        "grants": [{ "role": "read", "machines": "*" }],
    }))
    .unwrap();
    crate::hub::api::registry()
        .call(
            &hub.hub,
            &reader,
            "browser_sessions",
            json!({ "projectRef": hub.project }),
        )
        .await
        .unwrap()
}

async fn read_file(hub: &TestHub, id: &str, file: &str) -> Vec<u8> {
    let reader = serde_json::from_value(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": "2026-10-26T10:00:00.000Z",
        "grants": [{ "role": "read", "machines": "*" }],
    }))
    .unwrap();
    let mut out = Vec::new();
    loop {
        let piece = crate::hub::api::registry()
            .call(
                &hub.hub,
                &reader,
                "browser_recording_get",
                json!({ "sessionId": id, "file": file, "offset": out.len() }),
            )
            .await
            .unwrap();
        out.extend(B64.decode(piece["dataB64"].as_str().unwrap()).unwrap());
        if piece["done"] == true {
            return out;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_starts_a_session_uses_a_site_and_ends_it_and_its_recording_is_on_the_hub() {
    let Some(rig) = rig().await else { return };
    let (site, _site) = site().await;

    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Sign in to the test shop" }),
    )
    .await;
    let result = &started["result"];
    let id = result["sessionId"].as_str().expect("started").to_owned();
    let start_ms = result["startMs"].as_u64().unwrap();
    eprintln!("session_start from the warm pool: {start_ms} ms");
    assert!(start_ms < 1_000, "{start_ms} ms");
    let url = result["cdp"].as_str().unwrap().to_owned();
    assert_eq!(
        SessionHooks::env(rig.broker.as_ref(), THREAD, None)[1].1,
        url,
        "the URL its env names"
    );
    // The node reports the session to the hub in the background, in order.
    let deadline = Instant::now() + Duration::from_secs(10);
    let live = loop {
        let listed = sessions(&rig.hub).await;
        if listed["sessions"][0]["state"] == "live" {
            break listed;
        }
        assert!(Instant::now() < deadline, "never live: {listed}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(live["sessions"][0]["taskId"], "T1");
    assert_eq!(live["sessions"][0]["purpose"], "Sign in to the test shop");

    // The agent's driver, on the proxy: open the site, sign in.
    let mut driver = Driver::connect(&url).await.unwrap();
    let page = driver.page().await;
    driver.ok(Some(&page), "Page.enable", json!({})).await;
    driver
        .ok(Some(&page), "Page.navigate", json!({ "url": site }))
        .await;
    driver
        .wait_for(
            &page,
            "document.readyState === 'complete' && !!document.querySelector('#user')",
        )
        .await;
    rig.broker.item(
        THREAD,
        &command_item(&format!("agent-browser open {site}"), "✓ Sign in"),
    );
    driver
        .eval(&page, "document.querySelector('#user').focus()")
        .await;
    driver
        .ok(Some(&page), "Input.insertText", json!({ "text": "ada" }))
        .await;
    driver
        .eval(&page, "document.querySelector('#go').click()")
        .await;
    driver
        .wait_for(&page, "document.body.innerText.includes('Welcome ada')")
        .await;
    rig.broker
        .item(THREAD, &command_item("agent-browser click @e3", "✓ Done"));
    // A command that didn't drive the browser isn't in its log.
    rig.broker.item(THREAD, &command_item("cargo test", "ok"));
    tokio::time::sleep(Duration::from_millis(800)).await;

    let ended = call(&rig.broker, json!({ "op": "session_end" })).await;
    let files: Vec<&str> = ended["result"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["file"].as_str().unwrap())
        .collect();
    let video = ffmpeg().is_some();
    assert_eq!(
        files,
        if video {
            vec!["actions", "dom", "video"]
        } else {
            vec!["actions", "dom"]
        }
    );
    // The browser and its profile are gone, and the driver with them.
    assert!(
        std::fs::read_dir(rig.node_home.path().join("browser/profiles"))
            .unwrap()
            .filter_map(Result::ok)
            .count()
            <= 1,
        "only the warm browser's profile is left"
    );
    assert!(
        Driver::connect(&url).await.is_err(),
        "no session: the proxy refuses"
    );

    // The recording reaches the hub.
    let deadline = Instant::now() + Duration::from_secs(30);
    let recorded = loop {
        let listed = sessions(&rig.hub).await;
        if listed["sessions"][0]["state"] == "recorded" {
            break listed["sessions"][0].clone();
        }
        assert!(Instant::now() < deadline, "not recorded: {listed}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(recorded["sessionId"], id.as_str());
    assert!(
        !rig.node_home
            .path()
            .join("browser/recordings")
            .join(&id)
            .exists(),
        "the node let it go"
    );

    let actions = String::from_utf8(read_file(&rig.hub, &id, "actions").await).unwrap();
    let lines: Vec<Value> = actions
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let tools: Vec<&str> = lines.iter().map(|l| l["tool"].as_str().unwrap()).collect();
    assert_eq!(
        tools,
        [
            "session_start",
            "agent-browser",
            "agent-browser",
            "session_end"
        ]
    );
    assert_eq!(
        lines[1]["args"]["command"],
        format!("agent-browser open {site}")
    );
    assert_eq!(lines[1]["durationMs"], 120);
    let dom = String::from_utf8(read_file(&rig.hub, &id, "dom").await).unwrap();
    assert!(dom.contains("Welcome ada"), "{dom}");
    assert!(dom.contains("Sign in"), "the page after the first step too");
    if video {
        let webm = read_file(&rig.hub, &id, "video").await;
        assert_eq!(&webm[..4], &[0x1a, 0x45, 0xdf, 0xa3], "a webm");
        assert!(webm.len() > 1_000, "{} bytes", webm.len());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_proxy_lets_in_only_its_sessions_driver_and_hides_the_brokers_own_connection() {
    let Some(rig) = rig().await else { return };
    let url = rig.broker.cdp_url(THREAD).unwrap();
    // No session yet: refused; nor does another token get in.
    assert!(Driver::connect(&url).await.err().unwrap().contains("409"));
    let other = format!("{}x", url);
    assert!(Driver::connect(&other).await.err().unwrap().contains("403"));
    assert_ne!(
        rig.broker.cdp_url("th-other").unwrap(),
        url,
        "each agent session has its own"
    );

    call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Look" }),
    )
    .await;
    let session = rig.broker.live(THREAD).unwrap();
    let (_, own) = session.page().expect("the broker follows the page");
    let mut driver = Driver::connect(&url).await.unwrap();
    // A driver's auto-attach sees the page under a session of its own, never the broker's.
    driver
        .ok(
            None,
            "Target.setAutoAttach",
            json!({ "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }),
        )
        .await;
    driver.ok(None, "Target.getTargets", json!({})).await;
    let attached: Vec<&Value> = driver
        .events
        .iter()
        .filter(|e| e["method"] == "Target.attachedToTarget")
        .collect();
    assert!(!attached.is_empty(), "{:?}", driver.events);
    assert!(
        attached
            .iter()
            .all(|e| e["params"]["sessionId"] != own.as_str())
    );
    // Nor can it use the broker's session.
    let refused = driver
        .send(Some(&own), "Runtime.evaluate", json!({ "expression": "1" }))
        .await;
    assert_eq!(refused["error"]["message"], "No session with given id");
    // No screencast frame of the broker's reaches it.
    assert!(
        !driver
            .events
            .iter()
            .any(|e| e["method"] == "Page.screencastFrame")
    );

    // While a person has control, every command is answered with that.
    session.set_control(BrowserControl::Human);
    let paused = driver.send(None, "Target.getTargets", json!({})).await;
    assert!(
        paused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("A person has control"),
        "{paused}"
    );
    session.set_control(BrowserControl::Agent);
    driver.ok(None, "Target.getTargets", json!({})).await;
    call(&rig.broker, json!({ "op": "session_end" })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_session_per_agent_session_and_none_to_end_twice() {
    let Some(rig) = rig().await else { return };
    let first = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "One" }),
    )
    .await;
    assert!(first["result"]["sessionId"].is_string());
    let again = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Two" }),
    )
    .await;
    assert!(
        again["error"]["message"]
            .as_str()
            .unwrap()
            .contains("is open"),
        "{again}"
    );
    call(&rig.broker, json!({ "op": "session_end" })).await;
    let twice = call(&rig.broker, json!({ "op": "session_end" })).await;
    assert_eq!(twice["error"]["code"], "not_found");
}

/// agent-browser itself, attached through the proxy: it drives the session, and its policy file's internal action
/// names block reading a value back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_browser_drives_the_session_through_the_proxy_and_its_policy_blocks_reads() {
    let Some(binary) = std::env::var_os("FLEETD_TEST_AGENT_BROWSER").map(PathBuf::from) else {
        eprintln!("skipped: set FLEETD_TEST_AGENT_BROWSER to an agent-browser binary");
        return;
    };
    let Some(rig) = rig().await else { return };
    let (site, _site) = site().await;
    call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "agent-browser" }),
    )
    .await;
    let env = SessionHooks::env(rig.broker.as_ref(), THREAD, Some("/usr/bin:/bin"));
    let socket_dir = tempfile::tempdir().unwrap();
    let run = |args: Vec<String>| {
        let binary = binary.clone();
        let env = env.clone();
        let socket_dir = socket_dir.path().to_owned();
        async move {
            let out = tokio::process::Command::new(&binary)
                .args(&args)
                .envs(env)
                .env("AGENT_BROWSER_SOCKET_DIR", socket_dir)
                .output()
                .await
                .unwrap();
            format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )
        }
    };
    let opened = run(vec!["open".into(), site.clone()]).await;
    assert!(opened.contains('✓'), "{opened}");
    run(vec!["fill".into(), "#pw".into(), "Sekr3t-pass".into()]).await;
    let snapshot = run(vec!["snapshot".into(), "-i".into()]).await;
    assert!(
        snapshot.contains("textbox") && !snapshot.contains("Sekr3t-pass"),
        "{snapshot}"
    );
    // Before a credential is filled the policy lets a read through; after, it doesn't.
    let read = run(vec!["get".into(), "value".into(), "#pw".into()]).await;
    assert!(read.contains("Sekr3t-pass"), "{read}");
    super::agent_browser::write_policy(rig.node_home.path(), THREAD, true).unwrap();
    for args in [
        vec!["get".to_owned(), "value".into(), "#pw".into()],
        vec![
            "eval".to_owned(),
            "document.querySelector('#pw').value".into(),
        ],
    ] {
        let refused = run(args.clone()).await;
        assert!(
            refused.contains("denied by policy") && !refused.contains("Sekr3t-pass"),
            "{args:?}: {refused}"
        );
    }
    run(vec!["click".into(), "#go".into()]).await;
    let title = run(vec!["get".into(), "title".into()]).await;
    assert!(title.contains("Welcome"), "{title}");
    run(vec!["close".into()]).await;
    call(&rig.broker, json!({ "op": "session_end" })).await;
}

/// One line to the node's socket as `peer`, and its answer.
async fn over_socket(peer: crate::node::runner::process::PeerSession, line: Value) -> Value {
    use crate::node::lead::{LeadRelay, serve_lead_socket};
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("node.sock");
    let handler: super::BrowserHandler = Arc::new(|thread, frame| {
        Box::pin(async move {
            serde_json::from_value(json!({
                "id": frame.id, "result": { "op": "request_takeover", "message": format!("broker for {thread}") },
            }))
            .unwrap()
        })
    });
    let _serving = serve_lead_socket(
        socket.clone(),
        LeadRelay::new(),
        Arc::new(move |_| peer.clone()),
        Arc::new(|_| Ok(Masker::default())),
        Some(handler),
    )
    .await
    .unwrap();
    let mut conn = tokio::net::UnixStream::connect(&socket).await.unwrap();
    conn.write_all(format!("{line}\n").as_bytes())
        .await
        .unwrap();
    let mut answer = String::new();
    conn.read_to_string(&mut answer).await.unwrap();
    serde_json::from_str(answer.trim()).unwrap()
}

#[tokio::test]
async fn only_the_node_reports_a_browser_session_and_a_browser_call_is_its_callers_sessions() {
    use crate::node::runner::process::PeerSession;
    let forged = json!({
        "t": "lead_call", "id": "c1", "cwd": "/work/storefront",
        "call": { "op": "browser_recording_part", "sessionId": "B0123456789abcdef0123456789abcdef", "file": "video",
                  "offset": 0, "dataB64": "AA==" },
    });
    let refused = over_socket(PeerSession::Session("s1".into()), forged).await;
    assert_eq!(refused["error"]["code"], "forbidden", "{refused}");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("the node's own call")
    );

    let start = json!({
        "t": "browser_call", "id": "c2", "cwd": "/work/storefront",
        "call": { "op": "session_start", "purpose": "Look" },
    });
    let answered = over_socket(PeerSession::Session("s1".into()), start.clone()).await;
    assert_eq!(answered["t"], "browser_result");
    assert_eq!(
        answered["result"]["message"], "broker for s1",
        "the session its process runs in"
    );
    let outside = over_socket(PeerSession::Outside, start.clone()).await;
    assert_eq!(outside["error"]["code"], "forbidden", "{outside}");
    let mut claims_another = start;
    claims_another["threadId"] = "s2".into();
    let refused = over_socket(PeerSession::Session("s1".into()), claims_another).await;
    assert_eq!(refused["error"]["code"], "forbidden", "{refused}");
}

/// The newest `browser_frame` waiting for the hub's link.
async fn next_frame(frames: &Arc<super::FrameSlot>) -> Value {
    let line = loop {
        tokio::time::timeout(Duration::from_secs(10), frames.notify.notified())
            .await
            .expect("a frame in 10 s");
        if let Some(line) = frames.take().pop() {
            break line;
        }
    };
    let frame: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(frame["t"], "browser_frame");
    frame
}

#[test]
fn a_slow_link_gets_each_watched_sessions_newest_screen_and_no_backlog() {
    let slot = super::FrameSlot::default();
    for n in 0..1_000 {
        slot.replace("B1", format!("b1-{n}"));
    }
    slot.replace("B2", "b2-0".into());
    let mut waiting = slot.take();
    waiting.sort();
    assert_eq!(waiting, ["b1-999", "b2-0"], "one per session, the newest");
    assert!(slot.take().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_person_watches_takes_over_and_types_and_the_agent_sees_it_after_the_handback() {
    use fleetd_contracts::browser::{BrowserControlTo, BrowserInput, BrowserSessionId};
    let Some(rig) = rig().await else { return };
    let (site, _site) = site().await;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Sign up" }),
    )
    .await;
    let id = BrowserSessionId::unchecked(started["result"]["sessionId"].as_str().unwrap());
    let url = started["result"]["cdp"].as_str().unwrap().to_owned();
    let mut driver = Driver::connect(&url).await.unwrap();
    let page = driver.page().await;
    driver
        .ok(Some(&page), "Page.navigate", json!({ "url": site }))
        .await;
    driver
        .wait_for(
            &page,
            "document.readyState === 'complete' && !!document.querySelector('#user')",
        )
        .await;

    // The agent asks for a person; the hub lists it until one comes.
    let asked = call(
        &rig.broker,
        json!({ "op": "request_takeover", "reason": "Type the user name" }),
    )
    .await;
    assert!(
        asked["result"]["message"]
            .as_str()
            .unwrap()
            .contains("waiting on you"),
        "{asked}"
    );
    let waiting = crate::hub::browser::waiting(&rig.hub.hub.db, &rig.hub.project).unwrap();
    assert_eq!(
        waiting[0].takeover_reason.as_ref().unwrap().as_str(),
        "Type the user name"
    );

    // Watching: the newest frame at once, then each new one.
    let frames = Arc::new(super::FrameSlot::default());
    rig.broker.watch(&id, Some(frames.clone()));
    let frame = next_frame(&frames).await;
    assert_eq!(frame["sessionId"], id.as_str());
    assert_eq!(frame["control"], "agent");
    // The frame says which page it shows: the site, once the node has heard where the page went.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut shown = frame["url"].clone();
    while !shown.as_str().is_some_and(|u| u.starts_with(&site)) {
        assert!(
            Instant::now() < deadline,
            "the page the frame shows: {shown}"
        );
        rig.broker.watch(&id, Some(frames.clone()));
        shown = next_frame(&frames).await["url"].clone();
    }
    let (width, height) = (
        frame["width"].as_f64().unwrap(),
        frame["height"].as_f64().unwrap(),
    );
    assert!(width > 100.0 && height > 100.0, "{width}x{height}");
    let jpeg = B64.decode(frame["jpegB64"].as_str().unwrap()).unwrap();
    assert_eq!(
        super::session::jpeg_size(&jpeg),
        Some((width as u32, height as u32))
    );

    // A person takes over: the agent's commands wait, and the person's input reaches the page.
    rig.broker
        .control(&id, BrowserControlTo::Human, "human:desk");
    let paused = driver
        .send(
            Some(&page),
            "Runtime.evaluate",
            json!({ "expression": "1" }),
        )
        .await;
    assert!(
        paused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("A person has control")
    );
    let rect = rig.broker.live(THREAD).unwrap();
    let (_, own) = rect.page().unwrap();
    let box_ = rect
        .cdp
        .call(Some(&own), "Runtime.evaluate", json!({
            "expression": "(() => { const r = document.querySelector('#user').getBoundingClientRect(); \
                            return [r.x + r.width / 2, r.y + r.height / 2, innerWidth]; })()",
            "returnByValue": true,
        }))
        .await
        .unwrap();
    let at = box_["result"]["value"].as_array().unwrap().clone();
    let scale = width / at[2].as_f64().unwrap();
    let (x, y) = (
        at[0].as_f64().unwrap() * scale,
        at[1].as_f64().unwrap() * scale,
    );
    for action in ["pressed", "released"] {
        let click: BrowserInput = serde_json::from_value(json!({
            "kind": "mouse", "action": action, "x": x, "y": y, "button": "left", "clickCount": 1,
        }))
        .unwrap();
        rig.broker.input(&id, click);
    }
    let typed: BrowserInput =
        serde_json::from_value(json!({ "kind": "text", "text": "typed-by-human" })).unwrap();
    rig.broker.input(&id, typed);
    // The frames say who drives now.
    let deadline = Instant::now() + Duration::from_secs(10);
    while next_frame(&frames).await["control"] != "human" {
        assert!(Instant::now() < deadline, "no frame said human");
    }

    // The typing lands (a person's input goes out in order, in the background).
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let value = rect
            .cdp
            .call(
                Some(&own),
                "Runtime.evaluate",
                json!({
                    "expression": "document.querySelector('#user').value", "returnByValue": true,
                }),
            )
            .await
            .unwrap()["result"]["value"]
            .clone();
        if value == "typed-by-human" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the person's typing never reached the page"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Handed back: the agent's next command takes control again and sees what the person typed.
    rig.broker
        .control(&id, BrowserControlTo::Agent, "human:desk");
    assert_eq!(
        rect.control(),
        fleetd_contracts::browser::BrowserControl::HandingBack
    );
    let value = driver
        .eval(&page, "document.querySelector('#user').value")
        .await;
    assert_eq!(value, "typed-by-human");
    assert_eq!(
        rect.control(),
        fleetd_contracts::browser::BrowserControl::Agent
    );

    // The hub followed: no longer waiting on anyone, and the agent drives.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let listed = sessions(&rig.hub).await;
        let s = &listed["sessions"][0];
        if s["control"] == "agent" && s.get("takeoverReason").is_none() {
            break;
        }
        assert!(Instant::now() < deadline, "{s}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        crate::hub::browser::waiting(&rig.hub.hub.db, &rig.hub.project)
            .unwrap()
            .is_empty()
    );
    rig.broker.watch(&id, None);
    call(&rig.broker, json!({ "op": "session_end" })).await;
    let deadline = Instant::now() + Duration::from_secs(30);
    while sessions(&rig.hub).await["sessions"][0]["state"] != "recorded" {
        assert!(Instant::now() < deadline, "not recorded");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let actions = String::from_utf8(read_file(&rig.hub, id.as_str(), "actions").await).unwrap();
    let steps: Vec<String> = actions
        .lines()
        .map(|l| {
            serde_json::from_str::<Value>(l).unwrap()["tool"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(
        steps,
        [
            "session_start",
            "request_takeover",
            "takeover",
            "handback",
            "agent_resumed",
            "session_end"
        ]
    );
    assert!(actions.contains("human:desk"), "who took over");
    assert!(
        !actions.contains("typed-by-human"),
        "a person's keys aren't logged one by one"
    );
}

async fn recorded(hub: &TestHub) -> String {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let listed = sessions(hub).await;
        if listed["sessions"][0]["state"] == "recorded" {
            return listed["sessions"][0]["sessionId"]
                .as_str()
                .unwrap()
                .to_owned();
        }
        assert!(Instant::now() < deadline, "not recorded: {listed}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_project_secret_is_scrubbed_from_the_dom_trace_in_every_form_the_page_shows_it() {
    let Some(rig) = rig_with(vec![("SHOP_KEY".into(), PROJECT_SECRET.into())]).await else {
        return;
    };
    let (site, _site) = site().await;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Read" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{site}/secret") }),
        )
        .await;
    driver
        .wait_for(
            &page,
            "document.readyState === 'complete' && !!document.querySelector('p')",
        )
        .await;
    rig.broker.item(
        THREAD,
        &command_item(&format!("agent-browser open {site}/secret"), "✓"),
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    call(&rig.broker, json!({ "op": "session_end" })).await;
    let id = recorded(&rig.hub).await;
    let dom = String::from_utf8(read_file(&rig.hub, &id, "dom").await).unwrap();
    assert!(dom.contains("***SHOP_KEY***"), "{dom}");
    let b64 = B64.encode(format!("key={PROJECT_SECRET};"));
    for form in ["pa&lt;ss&amp;word-77", "pa<ss&word-77", &b64[4..16]] {
        assert!(!dom.contains(form), "{form} in {dom}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_starts_at_once_open_one_session_and_leave_one_recording() {
    let Some(rig) = rig().await else { return };
    let (a, b) = tokio::join!(
        call(
            &rig.broker,
            json!({ "op": "session_start", "purpose": "One" })
        ),
        call(
            &rig.broker,
            json!({ "op": "session_start", "purpose": "Two" })
        ),
    );
    let opened = [&a, &b]
        .iter()
        .filter(|r| r["result"]["sessionId"].is_string())
        .count();
    assert_eq!(opened, 1, "{a} {b}");
    let refused = if a.get("error").is_some() { &a } else { &b };
    let why = refused["error"]["message"].as_str().unwrap();
    assert!(why.contains("starting") || why.contains("is open"), "{why}");
    let folders = std::fs::read_dir(rig.node_home.path().join("browser/recordings"))
        .unwrap()
        .count();
    assert_eq!(folders, 1, "the refused start made no recording");
    call(&rig.broker, json!({ "op": "session_end" })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_browser_session_ends_with_its_agents_session() {
    let Some(rig) = rig().await else { return };
    call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Look" }),
    )
    .await;
    SessionHooks::ended(rig.broker.as_ref(), "th-someone-else");
    assert!(
        rig.broker.live(THREAD).is_some(),
        "another agent's exit changes nothing"
    );
    SessionHooks::ended(rig.broker.as_ref(), THREAD);
    assert!(rig.broker.live(THREAD).is_none());
    let id = recorded(&rig.hub).await;
    let actions = String::from_utf8(read_file(&rig.hub, &id, "actions").await).unwrap();
    assert!(actions.contains("agent_session_ended"), "{actions}");
}

/// The hub's link to this node, for a test: what the hub sends goes to the broker as the node's link hands it on, and
/// what the node sends goes to the hub as its link server does.
fn bridge(rig: &Rig) {
    let hub = rig.hub.hub.clone();
    let devbox = MachineId::unchecked("devbox");
    let mut to_node = hub
        .link
        .test_link(&devbox, &[fleetd_contracts::node_link::CAP_BROWSER]);
    let frames = Arc::new(super::FrameSlot::default());
    let broker = rig.broker.clone();
    let slot = frames.clone();
    tokio::spawn(async move {
        while let Some(frame) = to_node.recv().await {
            broker.from_hub(frame, &slot);
        }
    });
    tokio::spawn(async move {
        loop {
            frames.notify.notified().await;
            for line in frames.take() {
                if let Ok(fleetd_contracts::node_link::NodeToHub::BrowserFrame(frame)) =
                    serde_json::from_str(&line)
                {
                    hub.link.browser_frame(&devbox, frame);
                }
            }
        }
    });
}

fn person(role: &str) -> crate::hub::api::Caller {
    let caller: crate::hub::api::Caller = serde_json::from_value(json!({
        "keyId": "k2", "name": "desk", "prefix": "fld_abcdef", "createdAt": "2026-10-26T10:00:00.000Z",
        "grants": [{ "role": role, "machines": "*" }],
    }))
    .unwrap();
    crate::hub::api::Caller {
        kind: Some(fleetd_contracts::auth::KeyKind::Human),
        ..caller
    }
}

/// Live view and takeover end to end, through the hub's own entry points: the app's watch and input, browser_control,
/// the hub's link to the node, and the node's broker.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_app_watches_takes_over_types_and_hands_back_through_the_hub() {
    use fleetd_contracts::browser::{BrowserInput, BrowserSessionId};
    let Some(rig) = rig().await else { return };
    bridge(&rig);
    let hub = rig.hub.hub.clone();
    let (site, _site) = site().await;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Sign up" }),
    )
    .await;
    let id = BrowserSessionId::unchecked(started["result"]["sessionId"].as_str().unwrap());
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    driver
        .ok(Some(&page), "Page.navigate", json!({ "url": site }))
        .await;
    driver
        .wait_for(
            &page,
            "document.readyState === 'complete' && !!document.querySelector('#user')",
        )
        .await;
    // The hub has the session live once the node reported it.
    let deadline = Instant::now() + Duration::from_secs(10);
    while sessions(&rig.hub).await["sessions"][0]["state"] != "live" {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // The app watches: frames arrive through the hub.
    let mut watch = crate::hub::browser::live::start_watch(&hub, &person("read"), &id).unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(10), watch.frames.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(frame.session_id, id);
    let width = frame.width.get() as f64;

    // Typing before taking over is refused at the hub.
    let text: BrowserInput =
        serde_json::from_value(json!({ "kind": "text", "text": "typed-by-human" })).unwrap();
    let early =
        crate::hub::browser::live::input(&hub, &person("operate"), &id, text.clone()).unwrap_err();
    assert!(
        early.message.contains("its agent has control"),
        "{}",
        early.message
    );

    let control = |to: &str| {
        let hub = hub.clone();
        let input = json!({ "sessionId": id.as_str(), "control": to });
        async move {
            crate::hub::api::registry()
                .call(&hub, &person("operate"), "browser_control", input)
                .await
        }
    };
    let took = control("human").await.unwrap();
    assert_eq!(took["session"]["control"], "human");
    let deadline = Instant::now() + Duration::from_secs(10);
    while rig.broker.live(THREAD).unwrap().control()
        != fleetd_contracts::browser::BrowserControl::Human
    {
        assert!(Instant::now() < deadline, "the node never heard");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // A click on the field and typing, in frame pixels, through the hub.
    let session = rig.broker.live(THREAD).unwrap();
    let (_, own) = session.page().unwrap();
    let at = session
        .cdp
        .call(Some(&own), "Runtime.evaluate", json!({
            "expression": "(() => { const r = document.querySelector('#user').getBoundingClientRect(); \
                            return [r.x + r.width / 2, r.y + r.height / 2, innerWidth]; })()",
            "returnByValue": true,
        }))
        .await
        .unwrap()["result"]["value"]
        .clone();
    let scale = width / at[2].as_f64().unwrap();
    for action in ["pressed", "released"] {
        let click: BrowserInput = serde_json::from_value(json!({
            "kind": "mouse", "action": action, "x": at[0].as_f64().unwrap() * scale,
            "y": at[1].as_f64().unwrap() * scale, "button": "left", "clickCount": 1,
        }))
        .unwrap();
        crate::hub::browser::live::input(&hub, &person("operate"), &id, click).unwrap();
    }
    crate::hub::browser::live::input(&hub, &person("operate"), &id, text).unwrap();

    // The typing lands (input goes out in the background), read on the node's own connection.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let value = session
            .cdp
            .call(
                Some(&own),
                "Runtime.evaluate",
                json!({
                    "expression": "document.querySelector('#user').value", "returnByValue": true,
                }),
            )
            .await
            .unwrap()["result"]["value"]
            .clone();
        if value == "typed-by-human" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the person's typing never reached the page"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    // Handed back: the agent's next command sees what the person typed.
    let back = control("agent").await.unwrap();
    assert_eq!(back["session"]["control"], "handing_back");
    let deadline = Instant::now() + Duration::from_secs(10);
    while session.control() != fleetd_contracts::browser::BrowserControl::HandingBack {
        assert!(
            Instant::now() < deadline,
            "the node never heard the handback"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        driver
            .eval(&page, "document.querySelector('#user').value")
            .await,
        "typed-by-human"
    );
    assert_eq!(
        session.control(),
        fleetd_contracts::browser::BrowserControl::Agent
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while sessions(&rig.hub).await["sessions"][0]["control"] != "agent" {
        assert!(
            Instant::now() < deadline,
            "the hub never heard the agent drives again"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    drop(watch);
    call(&rig.broker, json!({ "op": "session_end" })).await;
}

#[test]
fn a_command_names_its_element_by_ref() {
    use super::session::element_ref;
    assert_eq!(
        element_ref("agent-browser click @e3").as_deref(),
        Some("@e3")
    );
    assert_eq!(
        element_ref("agent-browser fill \"@e12\" 'ada'").as_deref(),
        Some("@e12")
    );
    assert_eq!(element_ref("agent-browser click '#go'"), None);
    assert_eq!(element_ref("echo me@example.com"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_step_records_the_element_it_acted_on_with_its_box_in_frame_pixels() {
    let Some(rig) = rig().await else { return };
    let (site, _site) = site().await;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Sign in" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    driver
        .ok(Some(&page), "Page.navigate", json!({ "url": site }))
        .await;
    driver
        .wait_for(
            &page,
            "document.readyState === 'complete' && !!document.querySelector('#user')",
        )
        .await;
    let center = |selector: &str| {
        format!(
            "(() => {{ const r = document.querySelector('{selector}').getBoundingClientRect(); \
             return [r.x + r.width / 2, r.y + r.height / 2]; }})()"
        )
    };
    // fill @e1: a click on the field, then the text, as agent-browser sends them.
    let at = driver.eval(&page, &center("#user")).await;
    for kind in ["mousePressed", "mouseReleased"] {
        driver
            .ok(
                Some(&page),
                "Input.dispatchMouseEvent",
                json!({
                    "type": kind, "x": at[0], "y": at[1], "button": "left", "clickCount": 1,
                }),
            )
            .await;
    }
    driver
        .ok(Some(&page), "Input.insertText", json!({ "text": "ada" }))
        .await;
    rig.broker.item(
        THREAD,
        &command_item("agent-browser fill @e1 ada", "✓ Done"),
    );
    // A command that only reads acts on nothing.
    rig.broker.item(
        THREAD,
        &command_item("agent-browser snapshot -i", "- textbox [ref=e1]: ada"),
    );
    // click @e3: the sign-in button.
    let at = driver.eval(&page, &center("#go")).await;
    for kind in ["mousePressed", "mouseReleased"] {
        driver
            .ok(
                Some(&page),
                "Input.dispatchMouseEvent",
                json!({
                    "type": kind, "x": at[0], "y": at[1], "button": "left", "clickCount": 1,
                }),
            )
            .await;
    }
    rig.broker
        .item(THREAD, &command_item("agent-browser click @e3", "✓ Done"));
    driver
        .wait_for(&page, "document.body.innerText.includes('Welcome ada')")
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    call(&rig.broker, json!({ "op": "session_end" })).await;
    let id = recorded(&rig.hub).await;

    let actions: Vec<Value> = String::from_utf8(read_file(&rig.hub, &id, "actions").await)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let fill = &actions[1]["target"];
    assert_eq!(fill["ref"], "@e1");
    assert_eq!(fill["selector"], "#user");
    assert!(fill["backendNodeId"].as_u64().is_some(), "{fill}");
    let boxed = &fill["frameBox"];
    let (x, y) = (boxed["x"].as_f64().unwrap(), boxed["y"].as_f64().unwrap());
    let (w, h) = (
        boxed["width"].as_f64().unwrap(),
        boxed["height"].as_f64().unwrap(),
    );
    assert!(
        w > 10.0 && h > 5.0 && x >= 0.0 && y >= 0.0 && x + w <= 1280.0,
        "{boxed}"
    );
    assert!(
        actions[2].get("target").is_none(),
        "a snapshot acts on nothing: {}",
        actions[2]
    );
    assert_eq!(actions[3]["target"]["ref"], "@e3");
    assert_eq!(actions[3]["target"]["selector"], "#go");

    // The DOM trace carries the same element for its step.
    let dom: Vec<Value> = String::from_utf8(read_file(&rig.hub, &id, "dom").await)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let after_fill = dom
        .iter()
        .find(|d| d["seq"] == actions[1]["seq"])
        .expect("the page after the fill");
    assert_eq!(after_fill["target"], *fill);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reading_a_steps_element_never_holds_up_the_agents_input() {
    let Some(rig) = rig().await else { return };
    let (site, _site) = site().await;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Dialog" }),
    )
    .await;
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    driver.ok(Some(&page), "Page.enable", json!({})).await;
    driver
        .ok(Some(&page), "Page.navigate", json!({ "url": site }))
        .await;
    driver
        .wait_for(
            &page,
            "document.readyState === 'complete' && !!document.querySelector('#user')",
        )
        .await;
    // A dialog holds the page's main thread: nothing evaluates until someone answers it.
    driver
        .ok(
            Some(&page),
            "Runtime.evaluate",
            json!({ "expression": "setTimeout(() => alert('hold'), 0); 1" }),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let session = rig.broker.live(THREAD).unwrap();
    let click = json!({ "method": "Input.dispatchMouseEvent", "params": { "type": "mousePressed", "x": 20, "y": 20 } });
    let started = Instant::now();
    session.note_target(&click).await;
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
    driver
        .ok(
            Some(&page),
            "Page.handleJavaScriptDialog",
            json!({ "accept": true }),
        )
        .await;
    call(&rig.broker, json!({ "op": "session_end" })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_takeover_asked_for_at_once_reaches_the_hub_after_its_session() {
    let Some(rig) = rig().await else { return };
    call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Captcha" }),
    )
    .await;
    let asked = call(
        &rig.broker,
        json!({ "op": "request_takeover", "reason": "Solve the captcha" }),
    )
    .await;
    assert!(asked["result"]["message"].is_string(), "{asked}");
    let waiting = crate::hub::browser::waiting(&rig.hub.hub.db, &rig.hub.project).unwrap();
    assert_eq!(waiting.len(), 1);
    call(&rig.broker, json!({ "op": "session_end" })).await;
}
