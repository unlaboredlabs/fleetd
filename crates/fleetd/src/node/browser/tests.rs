//! Browser sessions end to end, on a real Chrome against a local test site, with the hub in process: an agent starts a
//! session, drives it through the node's proxy as agent-browser does, ends it, and its recording is on the hub. They
//! need a Chrome (FLEETD_TEST_CHROME, Playwright's headless shell in ~/.cache/ms-playwright, or google-chrome) and say
//! so and pass without one; the video also needs an ffmpeg (FLEETD_TEST_FFMPEG, Playwright's, or one on PATH). The
//! agent-browser tests run when FLEETD_TEST_AGENT_BROWSER names its binary. CI sets FLEETD_REQUIRE_AGENT_BROWSER too,
//! so that they fail, not pass, without it or a Chrome.
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

/// A Navi's purchases: a fake checkout with a payment provider's card frame, and a fake 1Password.
mod cards;
/// Logins from 1Password, with a fake one.
mod credentials;
/// A Navi's sign-ins, kept between its sessions.
mod kept;
/// What a Navi's browser may touch on this machine: no file pages, uploads and downloads only in its folder.
mod local;
/// agent-browser's own script shapes.
mod shapes;

const THREAD: &str = "th-browser-1";

fn on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

fn playwright_cache() -> PathBuf {
    crate::node::util::home_dir().join(".cache/ms-playwright")
}

/// Whether CI asked for the agent-browser tests to run, not skip.
fn required() -> bool {
    std::env::var_os("FLEETD_REQUIRE_AGENT_BROWSER").is_some()
}

/// The agent-browser binary the agent-browser tests drive, or None (said why).
fn agent_browser() -> Option<PathBuf> {
    let binary = std::env::var_os("FLEETD_TEST_AGENT_BROWSER").map(PathBuf::from);
    assert!(
        binary.is_some() || !required(),
        "FLEETD_REQUIRE_AGENT_BROWSER is set but FLEETD_TEST_AGENT_BROWSER isn't"
    );
    if binary.is_none() {
        eprintln!("skipped: set FLEETD_TEST_AGENT_BROWSER to an agent-browser binary");
    }
    binary
}

pub(crate) fn chrome() -> Option<PathBuf> {
    std::env::var_os("FLEETD_TEST_CHROME")
        .map(PathBuf::from)
        .or_else(|| super::chrome::find_chrome(&playwright_cache()))
        .or_else(|| on_path("google-chrome"))
        .or_else(|| on_path("chromium"))
}

/// A Chrome for these tests, or None (said why) where this machine has none. On CI (`CI` set, as GitHub Actions sets
/// it, or FLEETD_REQUIRE_AGENT_BROWSER) a missing Chrome fails instead: the browser and relay tests must run there, not pass without running.
pub(crate) fn chrome_or_skip() -> Option<PathBuf> {
    let found = chrome();
    if found.is_none() {
        assert!(
            !required() && std::env::var_os("CI").is_none(),
            "no Chrome on CI (or with FLEETD_REQUIRE_AGENT_BROWSER): the browser tests need one (google-chrome on \
             PATH, or FLEETD_TEST_CHROME)"
        );
        eprintln!("skipped: no Chrome on this machine (set FLEETD_TEST_CHROME)");
    }
    found
}

pub(crate) fn ffmpeg() -> Option<PathBuf> {
    std::env::var_os("FLEETD_TEST_FFMPEG")
        .map(PathBuf::from)
        .or_else(|| super::chrome::find_ffmpeg(&playwright_cache()))
        .or_else(|| on_path("ffmpeg"))
}

/// The hub in process, answering the node's calls as a task's session in project storefront.
struct TestHub {
    hub: Arc<Hub>,
    project: ProjectRef,
    /// Who the calls come from: a task of the project's, unless a test makes it the project's lead (a Navi's).
    agent: std::sync::Mutex<CallerAgent>,
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
            agent: self.agent.lock().unwrap().clone(),
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
    Arc::new(TestHub {
        hub,
        project,
        agent: std::sync::Mutex::new(CallerAgent::Task(
            fleetd_contracts::tasks::TaskId::unchecked("T1"),
        )),
    })
}

/// A local site: a login form at /, and /login, which greets whoever signed in; /remember?user=… signs in for a day
/// (a cookie that outlives the browser), and /whoami says who is signed in.
pub(crate) async fn site() -> (String, AbortOnDrop) {
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
                    let mut headers = String::new();
                    let page = if let Some(query) = text.strip_prefix("GET /remember?user=") {
                        let user: String = query
                            .chars()
                            .take_while(char::is_ascii_alphanumeric)
                            .collect();
                        headers =
                            format!("set-cookie: who={user}; Max-Age=86400; Path=/; HttpOnly\r\n");
                        format!(
                            "<html><head><title>Welcome</title></head><body>Welcome {user}</body></html>"
                        )
                    } else if text.starts_with("GET /whoami") {
                        let who = text[..head_end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("cookie:")
                                    .map(str::to_owned)
                            })
                            .and_then(|c| {
                                c.split(';').find_map(|kv| {
                                    kv.trim().strip_prefix("who=").map(str::to_owned)
                                })
                            });
                        match who {
                            Some(user) => format!("<html><body>Signed in as {user}</body></html>"),
                            None => "<html><body>Signed out</body></html>".to_owned(),
                        }
                    } else if text.starts_with("GET /search-form") {
                        "<html><body><form method=get action=/found><input id=code name=code><button id=find>Find</button>\
                         </form></body></html>"
                            .to_owned()
                    } else if text.starts_with("GET /found") {
                        "<html><head><title>Found</title></head><body>Found</body></html>"
                            .to_owned()
                    } else if text.starts_with("GET /secret") {
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
                        "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{page}",
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

impl Rig {
    /// Makes agent session `thread` Navi `navi`'s, with a folder of its own under the node's home: its path.
    fn navi(&self, thread: &str, navi: &str) -> PathBuf {
        let folder = self.node_home.path().join("navi").join(navi);
        std::fs::create_dir_all(&folder).unwrap();
        SessionHooks::navi(self.broker.as_ref(), thread, navi, &folder);
        folder
    }
}

/// A broker with a warm Chrome, or None (said why) where this machine has none.
/// A secret of the agent session's project, as the node reads it for the session.
const PROJECT_SECRET: &str = "pa<ss&word-77";

async fn rig() -> Option<Rig> {
    rig_with(Vec::new()).await
}

async fn rig_with(secrets: Vec<(String, String)>) -> Option<Rig> {
    let chrome = chrome_or_skip()?;
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
    // A cold runner's first Chromes can use a sandboxed launch's whole 20s LAUNCH_TIMEOUT and then the unsandboxed
    // retry's: wait out both.
    let deadline = Instant::now() + Duration::from_secs(60);
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

/// What real Chrome answers for a moment under load: a node or execution context that was just replaced, a page
/// between loads, a box not laid out yet. Never one of fleetd's refusals.
const TRANSIENT: &[&str] = &[
    "Could not find node with given id",
    "No node with given id found",
    "Cannot find context with specified id",
    "Execution context was destroyed",
    "Inspected target navigated or closed",
    "Could not compute box model",
];

/// Whether `answer` (a CDP answer, or a tool result) failed with a [`TRANSIENT`] error.
pub(crate) fn transient(answer: &Value) -> bool {
    let text = answer.to_string();
    !text.contains("1Password") && TRANSIENT.iter().any(|t| text.contains(t))
}

/// A raw CDP client, as agent-browser is one, on the session's proxy URL.
pub(crate) struct Driver {
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    next: u64,
    /// Every event seen so far.
    events: Vec<Value>,
}

impl Driver {
    pub(crate) async fn connect(url: &str) -> Result<Self, String> {
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
    pub(crate) async fn send(
        &mut self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Value {
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

    pub(crate) async fn ok(&mut self, session: Option<&str>, method: &str, params: Value) -> Value {
        let answer = self.send(session, method, params).await;
        assert!(answer.get("error").is_none(), "{method}: {answer}");
        answer["result"].clone()
    }

    /// As [`Driver::ok`], but tries again, for up to 10 s, while real Chrome's answer is one it gives for a moment
    /// under load ([`transient`]); any other error fails as `ok` does.
    pub(crate) async fn ok_settled(
        &mut self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let answer = self.send(session, method, params.clone()).await;
            if answer.get("error").is_none() {
                return answer["result"].clone();
            }
            assert!(
                transient(&answer) && Instant::now() < deadline,
                "{method}: {answer}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub(crate) async fn eval(&mut self, page: &str, expression: &str) -> Value {
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
    pub(crate) async fn page(&mut self) -> String {
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

    /// Waits for the first event from `seen` on that `wanted` picks, reading on while none has come yet; `seen` moves
    /// past it, so a later wait picks only what came after.
    pub(crate) async fn event(
        &mut self,
        seen: &mut usize,
        wanted: impl Fn(&Value) -> bool,
    ) -> Value {
        loop {
            while *seen < self.events.len() {
                *seen += 1;
                if wanted(&self.events[*seen - 1]) {
                    return self.events[*seen - 1].clone();
                }
            }
            let next = tokio::time::timeout(Duration::from_secs(20), self.ws.next())
                .await
                .expect("an event in 20 s");
            let Some(Ok(Message::Text(text))) = next else {
                panic!("the proxy closed");
            };
            self.events.push(serde_json::from_str(&text).unwrap());
        }
    }

    /// Waits until `expression` is true on the page. A page between documents (a submit navigating) answers with an
    /// error meanwhile, which only means not yet.
    pub(crate) async fn wait_for(&mut self, page: &str, expression: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let answer = self
                .send(
                    Some(page),
                    "Runtime.evaluate",
                    json!({ "expression": expression, "returnByValue": true }),
                )
                .await;
            if answer["result"]["result"]["value"] == true {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "never true: {expression} ({answer})"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

pub(crate) fn command_item(command: &str, output: &str) -> ThreadItem {
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
    // A warm start takes milliseconds; the margin is for a loaded test run, with other tests' Chrome starting alongside.
    assert!(start_ms < 3_000, "{start_ms} ms");
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
    // The node lets its copy go once the hub has said so.
    let kept = rig.node_home.path().join("browser/recordings").join(&id);
    let deadline = Instant::now() + Duration::from_secs(10);
    while kept.exists() {
        assert!(Instant::now() < deadline, "the node never let it go");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

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

/// A broker on devbox whose browser is still installing: no pool yet.
async fn installing(home: &Path, hub: Arc<TestHub>) -> Arc<Broker> {
    let config = BrowserConfig {
        ffmpeg: ffmpeg().map(|p| p.to_string_lossy().into_owned()),
        ..BrowserConfig::default()
    };
    Broker::open(
        home,
        config,
        hub,
        Arc::new(|_| Ok(crate::node::mask::Secrets(Vec::new()))),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_session_start_waits_for_the_browser_install_and_opens_its_session() {
    let Some(chrome) = chrome_or_skip() else {
        return;
    };
    let node_home = tempfile::tempdir().unwrap();
    let hub_home = tempfile::tempdir().unwrap();
    let broker = installing(node_home.path(), hub(hub_home.path())).await;
    let start = tokio::spawn({
        let broker = broker.clone();
        async move {
            call(
                &broker,
                json!({ "op": "session_start", "purpose": "First" }),
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!start.is_finished(), "{}", start.await.unwrap());
    broker.ready(chrome);
    let started = start.await.unwrap();
    assert!(started["result"]["sessionId"].is_string(), "{started}");
    call(&broker, json!({ "op": "session_end" })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_start_waiting_for_an_install_that_fails_gets_its_real_error() {
    let node_home = tempfile::tempdir().unwrap();
    let hub_home = tempfile::tempdir().unwrap();
    let broker = installing(node_home.path(), hub(hub_home.path())).await;
    let start = tokio::spawn({
        let broker = broker.clone();
        async move {
            call(
                &broker,
                json!({ "op": "session_start", "purpose": "First" }),
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!start.is_finished(), "{}", start.await.unwrap());
    broker.set_install(super::Install::Missing {
        why: "installing agent-browser failed: npm ERR! network".to_owned(),
        owed: true,
    });
    let refused = start.await.unwrap();
    let why = refused["error"]["message"].as_str().unwrap();
    assert!(why.contains("npm ERR! network"), "{why}");
}

#[tokio::test(start_paused = true)]
async fn a_session_start_waits_for_an_install_only_so_long_and_says_how_far_it_is() {
    let node_home = tempfile::tempdir().unwrap();
    let hub_home = tempfile::tempdir().unwrap();
    let broker = installing(node_home.path(), hub(hub_home.path())).await;
    broker.set_install(super::Install::Installing(super::Progress {
        step: "step 2 of 2, Chrome's headless shell and ffmpeg".to_owned(),
        since: Instant::now() - Duration::from_secs(95),
    }));
    let asked = tokio::time::Instant::now();
    let refused = call(
        &broker,
        json!({ "op": "session_start", "purpose": "First" }),
    )
    .await;
    assert_eq!(asked.elapsed(), super::INSTALL_WAIT);
    let why = refused["error"]["message"].as_str().unwrap();
    assert!(
        why.contains(
            "still installing its browser (step 2 of 2, Chrome's headless shell and ffmpeg, 1 min 3"
        ),
        "{why}"
    );
    let fix = refused["error"]["fix"].as_str().unwrap();
    assert!(
        fix.contains("again") && fix.contains("opens the session"),
        "{fix}"
    );
}

/// Installs of agent-browser so far by [`agent_browser_slow_then_failing`], and whether the slow one may end.
static SLOW_TRIES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static SLOW_ENDS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// An install of agent-browser on devbox that runs past a start's wait, then fails, as does every one after it.
fn agent_browser_slow_then_failing(_home: &Path) -> Result<PathBuf, String> {
    use std::sync::atomic::Ordering::SeqCst;
    let n = SLOW_TRIES.fetch_add(1, SeqCst) + 1;
    while !SLOW_ENDS.load(SeqCst) {
        std::thread::sleep(Duration::from_millis(5));
    }
    Err(format!(
        "installing agent-browser failed: npm ERR! ECONNRESET (try {n})"
    ))
}

#[tokio::test(start_paused = true)]
async fn an_install_that_fails_after_the_wait_gives_its_error_to_the_next_start_before_another_download()
 {
    use std::sync::atomic::Ordering::SeqCst;
    let node_home = tempfile::tempdir().unwrap();
    let hub_home = tempfile::tempdir().unwrap();
    let config = BrowserConfig {
        chrome: Some("/opt/devbox/chrome".to_owned()),
        ..BrowserConfig::default()
    };
    let broker = Broker::open_with(
        node_home.path(),
        config,
        hub(hub_home.path()),
        Arc::new(|_| Ok(crate::node::mask::Secrets(Vec::new()))),
        super::Installer {
            agent_browser: agent_browser_slow_then_failing,
            chrome: |_| Err("Chrome is set in node.json".to_owned()),
        },
    )
    .await;
    // devbox's install as the node started failed: the first start installs again.
    broker.set_install(super::Install::Missing {
        why: "installing agent-browser failed: npm ERR! network ENOTFOUND".to_owned(),
        owed: false,
    });
    let start = || {
        call(
            &broker,
            json!({ "op": "session_start", "purpose": "First" }),
        )
    };
    let first = tokio::spawn({
        let broker = broker.clone();
        async move {
            call(
                &broker,
                json!({ "op": "session_start", "purpose": "First" }),
            )
            .await
        }
    });
    while SLOW_TRIES.load(SeqCst) == 0 {
        std::thread::sleep(Duration::from_millis(1));
        tokio::task::yield_now().await;
    }
    // The clock doesn't move by itself while the install runs on a blocking thread.
    tokio::time::advance(super::INSTALL_WAIT).await;
    let waited = first.await.unwrap();
    assert!(
        waited["error"]["message"]
            .as_str()
            .unwrap()
            .contains("still installing its browser"),
        "{waited}"
    );
    assert_eq!(SLOW_TRIES.load(SeqCst), 1);
    // The install fails after that start stopped waiting.
    SLOW_ENDS.store(true, SeqCst);
    for _ in 0..5000 {
        if matches!(
            *super::lock(&broker.install),
            super::Install::Missing { .. }
        ) {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
        tokio::task::yield_now().await;
    }
    let told = start().await;
    let why = told["error"]["message"].as_str().unwrap();
    assert!(why.contains("npm ERR! ECONNRESET (try 1)"), "{why}");
    assert_eq!(
        SLOW_TRIES.load(SeqCst),
        1,
        "its error, not another download"
    );
    let again = start().await;
    let why = again["error"]["message"].as_str().unwrap();
    assert!(why.contains("npm ERR! ECONNRESET (try 2)"), "{why}");
    assert_eq!(
        SLOW_TRIES.load(SeqCst),
        2,
        "the start after it installs again"
    );
}

/// agent-browser as the install leaves it, without npm: a stand-in binary, linked and versioned.
fn installed_agent_browser(home: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let bin = super::agent_browser::bin_dir(home);
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let link = bin.join("agent-browser");
    std::fs::write(&link, "#!/bin/sh\n").map_err(|e| e.to_string())?;
    std::fs::set_permissions(&link, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;
    std::fs::write(
        super::agent_browser::install_dir(home).join("VERSION"),
        super::agent_browser::VERSION,
    )
    .map_err(|e| e.to_string())?;
    Ok(link)
}

/// agent-browser's install on devbox as it boots, before the network is up: it fails the first time only.
fn agent_browser_offline_at_boot(home: &Path) -> Result<PathBuf, String> {
    static TRIES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    match TRIES.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
        0 => Err("installing agent-browser failed: npm ERR! network ENOTFOUND".to_owned()),
        _ => installed_agent_browser(home),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_install_that_failed_as_the_node_started_is_tried_again_by_the_first_session() {
    let Some(chrome) = chrome_or_skip() else {
        return;
    };
    let node_home = tempfile::tempdir().unwrap();
    let hub_home = tempfile::tempdir().unwrap();
    let config = BrowserConfig {
        chrome: Some(chrome.to_string_lossy().into_owned()),
        ffmpeg: ffmpeg().map(|p| p.to_string_lossy().into_owned()),
        ..BrowserConfig::default()
    };
    let broker = Broker::start_with(
        node_home.path(),
        config,
        hub(hub_home.path()),
        Arc::new(|_| Ok(crate::node::mask::Secrets(Vec::new()))),
        super::Installer {
            agent_browser: agent_browser_offline_at_boot,
            chrome: |_| Err("Chrome is set in node.json".to_owned()),
        },
    )
    .await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while !matches!(
        *super::lock(&broker.install),
        super::Install::Missing { .. }
    ) && Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        matches!(
            *super::lock(&broker.install),
            super::Install::Missing { .. }
        ),
        "the install as the node started failed"
    );
    let started = call(
        &broker,
        json!({ "op": "session_start", "purpose": "First" }),
    )
    .await;
    assert!(started["result"]["sessionId"].is_string(), "{started}");
    call(&broker, json!({ "op": "session_end" })).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_node_installs_the_browser_as_it_starts_so_the_first_session_finds_it_ready() {
    let Some(chrome) = chrome_or_skip() else {
        return;
    };
    let node_home = tempfile::tempdir().unwrap();
    let hub_home = tempfile::tempdir().unwrap();
    // devbox starts with Chrome but without agent-browser, and no agent has asked for a session.
    let config = BrowserConfig {
        chrome: Some(chrome.to_string_lossy().into_owned()),
        ffmpeg: ffmpeg().map(|p| p.to_string_lossy().into_owned()),
        ..BrowserConfig::default()
    };
    let broker = Broker::start_with(
        node_home.path(),
        config,
        hub(hub_home.path()),
        Arc::new(|_| Ok(crate::node::mask::Secrets(Vec::new()))),
        super::Installer {
            agent_browser: installed_agent_browser,
            chrome: |_| Err("Chrome is set in node.json".to_owned()),
        },
    )
    .await;
    let deadline = Instant::now() + Duration::from_secs(20);
    while broker.warm() == 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        broker.warm(),
        1,
        "installed and launched with no session asked for"
    );
    assert!(super::agent_browser::find(node_home.path()).is_some());
    let asked = Instant::now();
    let started = call(
        &broker,
        json!({ "op": "session_start", "purpose": "First" }),
    )
    .await;
    assert!(started["result"]["sessionId"].is_string(), "{started}");
    assert!(
        asked.elapsed() < Duration::from_secs(10),
        "from the warm pool"
    );
    call(&broker, json!({ "op": "session_end" })).await;
}

/// agent-browser itself, attached through the proxy: it drives the session, and its policy file's internal action
/// names block reading a value back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_browser_drives_the_session_through_the_proxy_and_its_policy_blocks_reads() {
    let Some(binary) = agent_browser() else {
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

/// The longest a test waits for a screencast frame.
const FRAME_WAIT: Duration = Duration::from_secs(30);

/// Makes the followed page repaint, over the node's own connection (the driver's commands wait while a person has
/// control): its background flips between two whites nobody sees apart.
async fn repaint(rig: &Rig) {
    let Some(session) = rig.broker.live(THREAD) else {
        return;
    };
    let Some((_, page)) = session.page() else {
        return;
    };
    let flip = "(() => { const s = document.documentElement.style; \
                s.backgroundColor = s.backgroundColor === 'rgb(255, 255, 254)' ? 'rgb(255, 255, 255)' : 'rgb(255, 255, 254)'; })()";
    let _ = session
        .cdp
        .call(
            Some(&page),
            "Runtime.evaluate",
            json!({ "expression": flip }),
        )
        .await;
}

/// The newest `browser_frame` waiting for the hub's link.
/// Waits up to [`FRAME_WAIT`], repainting the page every half second meanwhile: Chrome sends a screencast frame only
/// when something repaints, which a page at rest on a loaded machine may not do for a long while.
async fn next_frame(rig: &Rig, frames: &Arc<super::FrameSlot>) -> Value {
    let deadline = Instant::now() + FRAME_WAIT;
    let line = loop {
        if let Some(line) = frames.take().pop() {
            break line;
        }
        assert!(Instant::now() < deadline, "no frame in {FRAME_WAIT:?}");
        if tokio::time::timeout(Duration::from_millis(500), frames.notify.notified())
            .await
            .is_err()
        {
            repaint(rig).await;
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

#[test]
fn a_persons_address_bar_goes_only_to_web_pages() {
    use super::session::navigable;
    assert_eq!(
        navigable(" https://example.com/a?b=1 ").unwrap(),
        "https://example.com/a?b=1"
    );
    assert_eq!(
        navigable("http://localhost:5173").unwrap(),
        "http://localhost:5173/"
    );
    for refused in [
        "file:///etc/passwd",
        "view-source:file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hi",
        "chrome://settings",
        "about:blank",
        "https://",
        "example.com",
    ] {
        assert!(navigable(refused).is_err(), "{refused}");
    }
}

#[test]
fn back_and_forward_take_the_history_entry_beside_the_current_one() {
    use super::session::history_entry;
    let history = json!({ "currentIndex": 1, "entries": [{ "id": 4 }, { "id": 7 }, { "id": 9 }] });
    assert_eq!(history_entry(&history, -1), Some(4));
    assert_eq!(history_entry(&history, 1), Some(9));
    let first = json!({ "currentIndex": 0, "entries": [{ "id": 4 }] });
    assert_eq!(history_entry(&first, -1), None);
    assert_eq!(history_entry(&first, 1), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_person_in_control_goes_to_an_address_back_forward_and_reloads_but_never_to_a_file() {
    use fleetd_contracts::browser::{BrowserControlTo, BrowserInput, BrowserSessionId};
    let Some(rig) = rig().await else { return };
    let (site, _site) = site().await;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Look around" }),
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
        .wait_for(&page, "document.readyState === 'complete'")
        .await;
    let live = rig.broker.live(THREAD).unwrap();
    let (_, own) = live.page().unwrap();
    let input = |v: Value| -> BrowserInput { serde_json::from_value(v).unwrap() };
    // Where the page is, once it gets to `want` (or says where it stayed).
    let at = |want: String| {
        let (live, own) = (live.clone(), own.clone());
        async move {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let href = live
                    .cdp
                    .call(
                        Some(&own),
                        "Runtime.evaluate",
                        json!({ "expression": "document.readyState === 'complete' ? location.href : ''", "returnByValue": true }),
                    )
                    .await
                    // Between documents the page has none to ask: not there yet.
                    .unwrap_or_default()["result"]["value"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                if href == want || Instant::now() > deadline {
                    return href;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    };
    let home = format!("{site}/");
    let other = format!("{site}/whoami");

    // While the agent drives, a person's address goes nowhere.
    rig.broker.input(
        &id,
        input(json!({ "kind": "navigate", "url": other.clone() })),
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(at(home.clone()).await, home);

    rig.broker
        .control(&id, BrowserControlTo::Human, "human:desk");
    rig.broker.input(
        &id,
        input(json!({ "kind": "navigate", "url": other.clone() })),
    );
    assert_eq!(at(other.clone()).await, other);
    rig.broker.input(&id, input(json!({ "kind": "back" })));
    assert_eq!(at(home.clone()).await, home);
    rig.broker.input(&id, input(json!({ "kind": "forward" })));
    assert_eq!(at(other.clone()).await, other);
    // Reloaded: the same address, a fresh document.
    live.cdp
        .call(
            Some(&own),
            "Runtime.evaluate",
            json!({ "expression": "window.__before = 1" }),
        )
        .await
        .unwrap();
    rig.broker.input(&id, input(json!({ "kind": "reload" })));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let gone = live
            .cdp
            .call(
                Some(&own),
                "Runtime.evaluate",
                json!({ "expression": "document.readyState === 'complete' && window.__before === undefined", "returnByValue": true }),
            )
            .await
            .unwrap_or_default()["result"]["value"]
            == true;
        if gone {
            break;
        }
        assert!(Instant::now() < deadline, "never reloaded");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Never the node's own files: refused before it goes, and the page stays where it is.
    rig.broker.input(
        &id,
        input(json!({ "kind": "navigate", "url": "file:///etc/passwd" })),
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(at(other.clone()).await, other);
    rig.broker
        .control(&id, BrowserControlTo::Agent, "human:desk");
    call(&rig.broker, json!({ "op": "session_end" })).await;
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
    let frame = next_frame(&rig, &frames).await;
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
        shown = next_frame(&rig, &frames).await["url"].clone();
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
    while next_frame(&rig, &frames).await["control"] != "human" {
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

/// Serves `/` (a page framing `/frame` from `localhost`, another site, as
/// reCAPTCHA's box is) and `/frame` (a big checkbox that tells its parent when it changes).
async fn framing_site() -> (String, AbortOnDrop) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let serving = tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut chunk = [0u8; 4096];
                while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                    match tcp.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend_from_slice(&chunk[..n]),
                    }
                }
                let page = if head.starts_with(b"GET /frame") {
                    "<html><body style=margin:0><input type=checkbox id=box style=width:300px;height:300px;margin:0 \
                     onchange=\"parent.postMessage('checked:' + this.checked, '*')\"></body></html>"
                        .to_owned()
                } else {
                    format!(
                        "<html><head><title>Framing</title></head><body style=margin:0>\
                         <iframe id=f src=http://localhost:{port}/frame \
                         style=position:absolute;left:0;top:0;width:300px;height:300px;border:0></iframe>\
                         <script>addEventListener('message', e => {{ document.title = e.data; }});</script>\
                         </body></html>"
                    )
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{page}",
                    page.len()
                );
                let _ = tcp.write_all(response.as_bytes()).await;
            });
        }
    });
    (format!("http://127.0.0.1:{port}/"), AbortOnDrop(serving))
}

/// The next frame that comes by itself (nothing here repaints the page), or None in `wait`.
async fn frame_within(frames: &Arc<super::FrameSlot>, wait: Duration) -> Option<Value> {
    let deadline = Instant::now() + wait;
    loop {
        if let Some(line) = frames.take().pop() {
            return Some(serde_json::from_str(&line).unwrap());
        }
        let left = deadline.checked_duration_since(Instant::now())?;
        let _ = tokio::time::timeout(left, frames.notify.notified()).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_persons_tap_in_another_sites_frame_lands_and_the_page_keeps_streaming() {
    use fleetd_contracts::browser::{BrowserControlTo, BrowserInput, BrowserSessionId};
    let Some(rig) = rig().await else { return };
    let (site, _site) = framing_site().await;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Tick the box" }),
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
        .wait_for(&page, "document.readyState === 'complete'")
        .await;
    // The box's frame has loaded, from the other site: in the page's process (the headless shell), or in one of its
    // own (Chrome, with site isolation, as reCAPTCHA's box is on a Chrome).
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let tree = driver.ok(Some(&page), "Page.getFrameTree", json!({})).await;
        let targets = driver.ok(None, "Target.getTargets", json!({})).await;
        let inside = tree["frameTree"]["childFrames"][0]["frame"]["url"]
            .as_str()
            .is_some_and(|u| u.starts_with("http://localhost:"));
        let own = targets["targetInfos"].as_array().unwrap().iter().any(|t| {
            t["type"] == "iframe"
                && t["url"]
                    .as_str()
                    .is_some_and(|u| u.starts_with("http://localhost:"))
        });
        if inside || own {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the frame never loaded: {tree} {targets}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let frames = Arc::new(super::FrameSlot::default());
    rig.broker.watch(&id, Some(frames.clone()));
    let first = next_frame(&rig, &frames).await;
    let width = first["width"].as_f64().unwrap();
    rig.broker
        .control(&id, BrowserControlTo::Human, "human:phone");
    let session = rig.broker.live(THREAD).unwrap();
    let (_, own) = session.page().unwrap();
    let inner = session
        .cdp
        .call(
            Some(&own),
            "Runtime.evaluate",
            json!({ "expression": "innerWidth", "returnByValue": true }),
        )
        .await
        .unwrap()["result"]["value"]
        .as_f64()
        .unwrap();
    // Settled: what the page sent before the tap is gone.
    while frame_within(&frames, Duration::from_millis(500))
        .await
        .is_some()
    {}

    // A tap as the phone sends one: pressed and released, no move before, in the frame's pixels.
    let at = 150.0 * width / inner;
    for action in ["pressed", "released"] {
        let tap: BrowserInput = serde_json::from_value(json!({
            "kind": "mouse", "action": action, "x": at, "y": at, "button": "left", "clickCount": 1,
        }))
        .unwrap();
        rig.broker.input(&id, tap);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let title = session
            .cdp
            .call(
                Some(&own),
                "Runtime.evaluate",
                json!({ "expression": "document.title", "returnByValue": true }),
            )
            .await
            .unwrap()["result"]["value"]
            .clone();
        if title == "checked:true" {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the tap never reached the frame's box: {title}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The ticked box repainted the page: its frame reaches the watcher, saying the person drives.
    let after = frame_within(&frames, FRAME_WAIT)
        .await
        .expect("no frame after the person's tap");
    assert_eq!(after["control"], "human");
    assert!(after["seq"].as_u64() > first["seq"].as_u64(), "{after}");

    rig.broker
        .control(&id, BrowserControlTo::Agent, "human:phone");
    rig.broker.watch(&id, None);
    call(&rig.broker, json!({ "op": "session_end" })).await;
}

/// Once the hub lists the session live: the node reports it in the background, so a loaded run (CI) can call the hub
/// before the report lands.
async fn live_on_hub(hub: &TestHub) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let listed = sessions(hub).await;
        if listed["sessions"][0]["state"] == "live" {
            return;
        }
        assert!(Instant::now() < deadline, "never live: {listed}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
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

/// The devbox's case: the session's recording folder went while it was live (the upload's sweep took a session still
/// opening for a start that never got going), so every write failed. Its end reaches the hub all the same.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_whose_recording_folder_went_still_ends_on_the_hub() {
    let Some(rig) = rig().await else { return };
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Look" }),
    )
    .await;
    let id = started["result"]["sessionId"].as_str().unwrap().to_owned();
    let dir = super::upload::recordings_dir(rig.node_home.path()).join(&id);
    std::fs::remove_dir_all(&dir).unwrap();
    call(&rig.broker, json!({ "op": "session_end" })).await;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let listed = sessions(&rig.hub).await;
        // Reported in the background: on a loaded run the hub may not have it yet.
        let state = listed["sessions"][0]["state"]
            .as_str()
            .unwrap_or("not reported yet")
            .to_owned();
        if state == "recorded" {
            assert!(listed["sessions"][0]["endedAt"].is_string(), "{listed}");
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the hub kept it {state}: {listed}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // The node clears it once the hub has answered the upload's last report, a moment after the hub says recorded.
    while dir.exists() {
        assert!(Instant::now() < deadline, "the upload left what it remade");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Its session file can't be written at all (its folder's name taken by a file): the upload has nothing to go on,
/// and the hub still hears the session ended, so it counts as live nowhere.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_with_no_session_file_still_ends_on_the_hub() {
    let Some(rig) = rig().await else { return };
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Look" }),
    )
    .await;
    let id = started["result"]["sessionId"].as_str().unwrap().to_owned();
    // Live on the hub first, so what follows is its end and not a report still on its way.
    live_on_hub(&rig.hub).await;
    let dir = super::upload::recordings_dir(rig.node_home.path()).join(&id);
    std::fs::remove_dir_all(&dir).unwrap();
    std::fs::write(&dir, b"not a folder").unwrap();
    call(&rig.broker, json!({ "op": "session_end" })).await;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let listed = sessions(&rig.hub).await;
        let session = &listed["sessions"][0];
        if session["state"] != "live" {
            assert!(session["endedAt"].is_string(), "{listed}");
            break;
        }
        assert!(Instant::now() < deadline, "the hub kept it live: {listed}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// T1 was cancelled with its browser still open: the hub ends the session and tells the node, which closes the browser
/// as when the agent's claude exits, and its recording still reaches the hub.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hub_ends_a_browser_whose_task_ended() {
    let Some(rig) = rig().await else { return };
    call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Look" }),
    )
    .await;
    live_on_hub(&rig.hub).await;
    let hub = rig.hub.hub.clone();
    let mut to_node = hub.link.test_link(
        &MachineId::unchecked("devbox"),
        &[fleetd_contracts::node_link::CAP_SESSION_END],
    );
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data)
                 VALUES (1, 'devbox', 'storefront', 'W1', 'cancelled', '{}')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(crate::hub::browser::end_outlived(&hub).unwrap(), 1);
    crate::hub::browser::tell_nodes(&hub, &mut Default::default()).unwrap();
    let Some(fleetd_contracts::node_link::HubToNode::SessionEnd(end)) = to_node.recv().await else {
        panic!("no session_end for the node");
    };
    // As the node's link hands it on (SessionService::end_screen).
    SessionHooks::screen_ended(
        rig.broker.as_ref(),
        end.thread_id.as_str(),
        end.session_id.as_str(),
    );
    assert!(rig.broker.live(THREAD).is_none());
    let id = recorded(&rig.hub).await;
    assert_eq!(id, end.session_id.as_str());
}

/// The hub names the screen it ended: the agent session's screen goes only when it is that one, so a frame for an
/// earlier screen of the same agent session (a node that linked again, say) leaves the one it opened since alone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_hub_ends_only_the_screen_it_names() {
    let Some(rig) = rig().await else { return };
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Look" }),
    )
    .await;
    let id = started["result"]["sessionId"].as_str().unwrap().to_owned();
    let here = crate::node::device::Router {
        browser: Some(rig.broker.clone()),
        devices: None,
        ios: None,
        live: Default::default(),
        desktops: None,
    };
    SessionHooks::screen_ended(&here, THREAD, "B00000000000000000000000000000000");
    SessionHooks::screen_ended(&here, "th-someone-else", &id);
    assert!(
        rig.broker.live(THREAD).is_some(),
        "another screen's end leaves it"
    );
    SessionHooks::screen_ended(&here, THREAD, &id);
    assert!(rig.broker.live(THREAD).is_none());
    assert_eq!(recorded(&rig.hub).await, id);
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
    // As the node's link hands them on: through the router, which knows the session is a browser's.
    let router = Arc::new(crate::node::device::Router {
        browser: Some(rig.broker.clone()),
        devices: None,
        ios: None,
        live: Default::default(),
        desktops: None,
    });
    let slot = frames.clone();
    tokio::spawn(async move {
        while let Some(frame) = to_node.recv().await {
            router.from_hub(frame, &slot);
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
    let deadline = Instant::now() + FRAME_WAIT;
    let frame = loop {
        match tokio::time::timeout(Duration::from_millis(500), watch.frames.recv()).await {
            Ok(frame) => break frame.unwrap(),
            Err(_) => {
                assert!(Instant::now() < deadline, "no frame in {FRAME_WAIT:?}");
                repaint(&rig).await;
            }
        }
    };
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

#[test]
fn a_url_loses_its_query_and_fragment() {
    use super::session::without_query;
    assert_eq!(
        without_query("https://shop.test/a/b?code=1#x"),
        "https://shop.test/a/b"
    );
    assert_eq!(
        without_query("https://shop.test/a#frag"),
        "https://shop.test/a"
    );
    assert_eq!(without_query("https://shop.test/a"), "https://shop.test/a");
}

/// A value filled into a form that submits by GET lands in the page's address: the frames the app watches carry
/// it scrubbed, and once a credential was filled, without the query at all.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_frames_address_never_carries_a_value_a_get_form_submitted() {
    let Some(rig) = rig_with(vec![("SHOP_KEY".into(), PROJECT_SECRET.into())]).await else {
        return;
    };
    let (site, _site) = site().await;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Search" }),
    )
    .await;
    let id = fleetd_contracts::browser::BrowserSessionId::unchecked(
        started["result"]["sessionId"].as_str().unwrap(),
    );
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{site}/search-form") }),
        )
        .await;
    driver
        .wait_for(
            &page,
            "document.readyState === 'complete' && !!document.querySelector('#code')",
        )
        .await;
    // The secret typed into the GET form and submitted: the next page's address holds it, percent-encoded.
    driver
        .eval(&page, "document.querySelector('#code').focus()")
        .await;
    driver
        .ok(
            Some(&page),
            "Input.insertText",
            json!({ "text": PROJECT_SECRET }),
        )
        .await;
    driver
        .eval(&page, "document.querySelector('#find').click()")
        .await;
    driver
        .wait_for(
            &page,
            "location.pathname === '/found' && document.readyState === 'complete'",
        )
        .await;
    let address = driver.eval(&page, "location.href").await;
    assert!(
        address.as_str().unwrap().contains("code=pa%3Css%26word-77"),
        "{address}"
    );

    let frames = Arc::new(super::FrameSlot::default());
    let deadline = Instant::now() + Duration::from_secs(10);
    let shown = loop {
        rig.broker.watch(&id, Some(frames.clone()));
        let url = next_frame(&rig, &frames).await["url"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if url.contains("/found") {
            break url;
        }
        assert!(
            Instant::now() < deadline,
            "the frame never showed the page: {url}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(shown.contains("code=***SHOP_KEY***"), "scrubbed: {shown}");
    assert!(
        !shown.contains("pa%3Css") && !shown.contains("word-77"),
        "{shown}"
    );

    // Once a credential was filled, the query goes altogether.
    let session = rig.broker.live(THREAD).unwrap();
    session
        .credentials_filled
        .store(1, std::sync::atomic::Ordering::Relaxed);
    rig.broker.watch(&id, Some(frames.clone()));
    let sealed = next_frame(&rig, &frames).await["url"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert_eq!(
        sealed,
        format!("{site}/found"),
        "no query once a credential was filled"
    );
    call(&rig.broker, json!({ "op": "session_end" })).await;
}

/// A secret with the characters a form escapes and encodeURIComponent doesn't (`!~'()`), and spaces, submitted by a
/// GET form: masked in the action log, the DOM trace and the frames' address, as the browser encoded it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_secret_a_get_form_encoded_is_masked_everywhere_it_goes() {
    const CODE: &str = "it's (a) top~secret!";
    let Some(rig) = rig_with(vec![("SHOP_CODE".into(), CODE.into())]).await else {
        return;
    };
    let (site, _site) = site().await;
    let started = call(
        &rig.broker,
        json!({ "op": "session_start", "purpose": "Search" }),
    )
    .await;
    let id = fleetd_contracts::browser::BrowserSessionId::unchecked(
        started["result"]["sessionId"].as_str().unwrap(),
    );
    let mut driver = Driver::connect(started["result"]["cdp"].as_str().unwrap())
        .await
        .unwrap();
    let page = driver.page().await;
    driver
        .ok(
            Some(&page),
            "Page.navigate",
            json!({ "url": format!("{site}/search-form") }),
        )
        .await;
    driver
        .wait_for(
            &page,
            "document.readyState === 'complete' && !!document.querySelector('#code')",
        )
        .await;
    driver
        .eval(&page, "document.querySelector('#code').focus()")
        .await;
    driver
        .ok(Some(&page), "Input.insertText", json!({ "text": CODE }))
        .await;
    driver
        .eval(&page, "document.querySelector('#find').click()")
        .await;
    driver
        .wait_for(
            &page,
            "location.pathname === '/found' && document.readyState === 'complete'",
        )
        .await;
    // The browser encoded it as a form does.
    let encoded = "it%27s+%28a%29+top%7Esecret%21";
    let href = driver
        .eval(&page, "location.href")
        .await
        .as_str()
        .unwrap()
        .to_owned();
    assert!(href.contains(&format!("code={encoded}")), "{href}");

    // The agent reads the address back: its step's line in the log, and the page after it in the trace.
    rig.broker
        .item(THREAD, &command_item("agent-browser get url", &href));
    let frames = Arc::new(super::FrameSlot::default());
    let deadline = Instant::now() + Duration::from_secs(10);
    let shown = loop {
        rig.broker.watch(&id, Some(frames.clone()));
        let url = next_frame(&rig, &frames).await["url"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if url.contains("/found") {
            break url;
        }
        assert!(
            Instant::now() < deadline,
            "the frame never showed the page: {url}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(
        shown.ends_with("code=***SHOP_CODE***"),
        "the frame's address: {shown}"
    );
    call(&rig.broker, json!({ "op": "session_end" })).await;
    let recorded = recorded(&rig.hub).await;
    for file in ["actions", "dom"] {
        let text = String::from_utf8(read_file(&rig.hub, &recorded, file).await).unwrap();
        assert!(text.contains("code=***SHOP_CODE***"), "{file}: {text}");
        for leak in [encoded, "top%7Esecret", "top~secret"] {
            assert!(!text.contains(leak), "{file} has {leak}: {text}");
        }
    }
}
