//! Desktop sessions end to end, with the hub in process: an agent starts a session, launches xterm, clicks into it
//! and types a command, a person watches, takes over, types and hands back, the agent ends the session, and its
//! recording is on the hub with the session's secret scrubbed from it. They run on an Xvfb with xterm on the machine
//! (`FLEETD_TEST_XVFB` names one off the PATH), or in containers with `FLEETD_TEST_DESKTOP_BACKEND=container`, which
//! builds the pinned image first (minutes, from the network). Without either they say so and pass.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::browser::{BrowserCallFrame, DesktopBackend};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, op_name};
use fleetd_contracts::node_link::{HubToNode, NodeToHub};
use serde_json::{Value, json};

use super::x11;
use super::{DesktopConfig, Desktops};
use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::HubDb;
use crate::node::browser::FrameSlot;
use crate::node::browser::upload::{HubCalls, HubFuture};
use crate::node::device::Router;

const THREAD: &str = "th-desktop-1";
const SECRET: &str = "s3cr3t-desk-7781";

#[test]
fn keys_go_by_their_xdotool_names_browser_names_or_characters() {
    assert_eq!(x11::parse_chord("ctrl+s").unwrap(), [0xffe3, 0x73]);
    assert_eq!(
        x11::parse_chord("ctrl+shift+Page_Down").unwrap(),
        [0xffe3, 0xffe1, 0xff56]
    );
    assert_eq!(x11::parse_chord("alt+F4").unwrap(), [0xffe9, 0xffc1]);
    assert_eq!(x11::parse_chord("Return").unwrap(), [0xff0d]);
    assert_eq!(x11::parse_chord("+").unwrap(), [0x2b]);
    assert!(x11::parse_chord("ctrl+").is_err());
    assert!(
        x11::parse_chord("Hyperdrive")
            .unwrap_err()
            .contains("Hyperdrive")
    );
    // The live view's KeyboardEvent names.
    assert_eq!(x11::keysym("ArrowLeft"), Some(0xff51));
    assert_eq!(x11::keysym("Backspace"), Some(0xff08));
    assert_eq!(x11::keysym("Enter"), Some(0xff0d));
    // Characters: Latin-1 as themselves, the rest of Unicode as X maps it.
    assert_eq!(x11::char_keysym('A'), 0x41);
    assert_eq!(x11::char_keysym('é'), 0xe9);
    assert_eq!(x11::char_keysym('€'), 0x0100_20ac);
    assert_eq!(x11::char_keysym('\n'), 0xff0d);
}

#[test]
fn the_cookie_file_names_the_cookie_for_any_display() {
    let cookie = [7u8; 16];
    let file = super::display::xauth(&cookie);
    assert_eq!(&file[..2], &[0xff, 0xff], "FamilyWild");
    assert_eq!(&file[2..6], &[0, 0, 0, 0], "no address, no display number");
    assert_eq!(&file[6..8], &[0, 18]);
    assert_eq!(&file[8..26], b"MIT-MAGIC-COOKIE-1");
    assert_eq!(&file[26..28], &[0, 16]);
    assert_eq!(&file[28..], &cookie);
}

#[test]
fn the_pinned_image_names_its_base_by_digest_and_its_tag_follows_the_file() {
    let from = super::container::DOCKERFILE.lines().next().unwrap();
    assert!(from.contains("@sha256:"), "{from}");
    assert!(super::container::DOCKERFILE.contains("snapshot.debian.org/archive/debian/2026"));
    let image = super::container::image();
    assert!(image.starts_with("localhost/fleetd-desktop:"), "{image}");
    assert_eq!(image, super::container::image(), "stable");
}

#[test]
fn a_runtime_that_does_not_answer_is_why_sessions_cant_run() {
    let home = tempfile::tempdir().unwrap();
    let off = DesktopConfig {
        enabled: Some(false),
        ..DesktopConfig::default()
    };
    assert!(super::health(home.path(), &off).is_none(), "off: no check");
    let broken = DesktopConfig {
        backend: Some(DesktopBackend::Container),
        runtime: Some("/nonexistent/docker".into()),
        ..DesktopConfig::default()
    };
    let health = super::health(home.path(), &broken).unwrap();
    assert_eq!(
        health.backend,
        Some(DesktopBackend::Container),
        "what it would use"
    );
    let why = super::prepare(home.path(), &broken, &|_| {}).err().unwrap();
    assert!(why.contains("`docker info` failed"), "{why}");
    let xvfb = DesktopConfig {
        backend: Some(DesktopBackend::Xvfb),
        xvfb: Some("/opt/x/Xvfb".into()),
        ..DesktopConfig::default()
    };
    let settings = super::prepare(home.path(), &xvfb, &|_| {}).unwrap();
    assert_eq!(
        (settings.backend, settings.xvfb.as_deref()),
        (DesktopBackend::Xvfb, Some(Path::new("/opt/x/Xvfb")))
    );
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

fn reader() -> fleetd_contracts::auth::AgentKeyInfo {
    serde_json::from_value(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": "2026-10-26T10:00:00.000Z",
        "grants": [{ "role": "read", "machines": "*" }],
    }))
    .unwrap()
}

async fn sessions(hub: &TestHub) -> Value {
    crate::hub::api::registry()
        .call(
            &hub.hub,
            &reader(),
            "browser_sessions",
            json!({ "projectRef": hub.project }),
        )
        .await
        .unwrap()
}

async fn read_file(hub: &TestHub, id: &str, file: &str) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let piece = crate::hub::api::registry()
            .call(
                &hub.hub,
                &reader(),
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

/// The desktop config to test with, or None (said why).
fn test_config() -> Option<DesktopConfig> {
    let backend = match std::env::var("FLEETD_TEST_DESKTOP_BACKEND").ok().as_deref() {
        Some("container") => DesktopBackend::Container,
        _ => DesktopBackend::Xvfb,
    };
    let ffmpeg = std::env::var("FLEETD_TEST_FFMPEG").ok().or_else(|| {
        let playwright = crate::node::util::home_dir().join(".cache/ms-playwright");
        crate::node::browser::chrome::find_ffmpeg(&playwright)
            .map(|p: PathBuf| p.to_string_lossy().into_owned())
    });
    let config = DesktopConfig {
        enabled: Some(true),
        backend: Some(backend),
        xvfb: std::env::var("FLEETD_TEST_XVFB").ok(),
        ffmpeg,
        ..DesktopConfig::default()
    };
    let home = tempfile::tempdir().unwrap();
    match super::prepare(home.path(), &config, &|_| {}) {
        Ok(settings)
            if settings.backend == DesktopBackend::Xvfb
                && super::display::on_path("xterm").is_none() =>
        {
            eprintln!("skipped: desktop sessions here run on Xvfb, and this machine has no xterm");
            None
        }
        Ok(_) => Some(config),
        Err(why) => {
            eprintln!(
                "skipped: no desktop sessions here: {why} (FLEETD_TEST_DESKTOP_BACKEND=container tests in containers)"
            );
            None
        }
    }
}

async fn call(router: &Router, call: Value) -> Value {
    let frame: BrowserCallFrame = serde_json::from_value(json!({
        "id": "t1", "cwd": "/work/storefront", "threadId": THREAD, "call": call,
    }))
    .unwrap();
    serde_json::to_value(router.handle(THREAD.to_owned(), frame).await).unwrap()
}

async fn act(router: &Router, action: Value) -> Value {
    let mut action = action;
    action["op"] = "desktop".into();
    let answer = call(router, action.clone()).await;
    assert!(answer["result"].is_object(), "{action}: {answer}");
    answer["result"].clone()
}

/// The output of a command run on the desktop, read back with `launch` (it exits at once).
async fn read_back(router: &Router, command: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let done = act(router, json!({ "action": "launch", "text": command })).await;
        let message = done["message"].as_str().unwrap().to_owned();
        if message.contains("exited at once") && !message.contains("No such file") {
            return message;
        }
        assert!(Instant::now() < deadline, "{command}: {message}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// A screenshot, decoded: its JPEG size in bytes.
async fn screenshot(router: &Router) -> usize {
    let shot = act(router, json!({ "action": "screenshot" })).await;
    assert_eq!(
        (shot["width"].as_u64(), shot["height"].as_u64()),
        (Some(1280), Some(800))
    );
    B64.decode(shot["jpegB64"].as_str().unwrap()).unwrap().len()
}

/// The newest frame the session sent the hub's link, within `within`.
async fn next_frame(slot: &FrameSlot, within: Duration) -> Value {
    let deadline = Instant::now() + within;
    loop {
        if let Some(frame) = slot.take().pop() {
            let frame: NodeToHub = serde_json::from_str(&frame).unwrap();
            return serde_json::to_value(frame).unwrap();
        }
        assert!(Instant::now() < deadline, "no frame");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn hub_frame(frame: Value) -> HubToNode {
    serde_json::from_value(frame).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_types_into_xterm_on_a_desktop_session_a_person_takes_over_and_its_recording_is_on_the_hub()
 {
    let Some(config) = test_config() else { return };
    let node_home = tempfile::tempdir().unwrap();
    let hub_home = tempfile::tempdir().unwrap();
    let hub = hub(hub_home.path());
    let with_video = config.ffmpeg.is_some();
    let desktops = Desktops::start(
        node_home.path(),
        config,
        hub.clone(),
        Arc::new(|_| {
            Ok(crate::node::mask::Secrets(vec![(
                "SHOP_TOKEN".into(),
                SECRET.into(),
            )]))
        }),
    )
    .await;
    // Prepared at start (enabled), the pool fills: the session starts from a warm display.
    let deadline = Instant::now() + Duration::from_secs(600);
    while desktops.warm() == 0 {
        assert!(Instant::now() < deadline, "the pool started no display");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let health = super::health(node_home.path(), &DesktopConfig::default()).unwrap();
    assert_eq!(
        health.state,
        fleetd_contracts::node_link::DesktopState::Ready,
        "{health:?}"
    );
    let router = Router {
        browser: None,
        devices: None,
        ios: None,
        desktops: Some(desktops.clone()),
        live: Default::default(),
    };

    let started = call(
        &router,
        json!({ "op": "session_start", "purpose": "Try the terminal", "kind": "linux_desktop" }),
    )
    .await;
    let result = &started["result"];
    assert!(result["desktop"].is_string(), "{started}");
    let id = result["sessionId"].as_str().unwrap().to_owned();
    eprintln!(
        "desktop session ({}) started in {} ms",
        result["desktop"], result["startMs"]
    );
    assert!(
        result["startMs"].as_u64().unwrap() < 1000,
        "from the warm pool: {started}"
    );
    // One session of any kind at a time.
    let second = call(&router, json!({ "op": "session_start", "purpose": "Shop" })).await;
    assert!(
        second["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Desktop session"),
        "{second}"
    );

    let blank = screenshot(&router).await;
    let launched = act(
        &router,
        json!({ "action": "launch", "text": "xterm -geometry 100x30+0+0" }),
    )
    .await;
    assert!(
        launched["message"].as_str().unwrap().starts_with("Started"),
        "{launched}"
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while screenshot(&router).await <= blank + 500 {
        assert!(Instant::now() < deadline, "xterm's window never showed");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // The agent clicks into the terminal and types a command with the secret in it.
    act(
        &router,
        json!({ "action": "left_click", "coordinate": [200, 150] }),
    )
    .await;
    let typed = format!("echo typed-by-agent {SECRET} > \"$HOME/agent.txt\"");
    act(&router, json!({ "action": "type", "text": typed })).await;
    act(&router, json!({ "action": "key", "text": "Return" })).await;
    let said = read_back(&router, "cat \"$HOME/agent.txt\"").await;
    assert!(said.contains("typed-by-agent ***SHOP_TOKEN***"), "{said}");
    assert!(!said.contains(SECRET), "scrubbed: {said}");
    let at = act(&router, json!({ "action": "cursor_position" })).await;
    assert!(
        at["message"].as_str().unwrap().contains("(200, 150)"),
        "{at}"
    );

    // A person watches: the newest frame at once, the screen as it is.
    let slot = Arc::new(FrameSlot::default());
    let watch = hub_frame(json!({ "t": "browser_watch", "sessionId": id, "on": true }));
    router.from_hub(watch, &slot);
    let frame = next_frame(&slot, Duration::from_secs(5)).await;
    assert_eq!(frame["t"], "browser_frame", "{frame}");
    assert_eq!(
        (frame["width"].as_u64(), frame["height"].as_u64()),
        (Some(1280), Some(800))
    );
    assert_eq!(frame["control"], "agent");

    // The agent asks for a person; the hub lists it under waiting on you.
    let asked = call(
        &router,
        json!({ "op": "request_takeover", "reason": "Check the terminal" }),
    )
    .await;
    assert!(
        asked["result"]["message"]
            .as_str()
            .unwrap()
            .contains("waiting on you"),
        "{asked}"
    );
    let waiting = crate::hub::browser::waiting(&hub.hub.db, &hub.project).unwrap();
    assert_eq!(
        waiting[0].takeover_reason.as_ref().unwrap().as_str(),
        "Check the terminal"
    );

    // A person takes over: the agent's actions are refused, and the person's typing goes in.
    let take = hub_frame(json!({
        "t": "browser_control", "sessionId": id, "control": "human", "by": "human:laptop",
    }));
    router.from_hub(take, &slot);
    let refused = call(&router, json!({ "op": "desktop", "action": "screenshot" })).await;
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("A person has control"),
        "{refused}"
    );
    for input in [
        json!({ "kind": "mouse", "action": "moved", "x": 300.0, "y": 200.0 }),
        json!({ "kind": "text", "text": "echo by-person > \"$HOME/person.txt\"" }),
        json!({ "kind": "key", "action": "down", "key": "Enter", "code": "Enter" }),
        json!({ "kind": "key", "action": "up", "key": "Enter", "code": "Enter" }),
    ] {
        let frame = hub_frame(json!({ "t": "browser_input", "sessionId": id, "input": input }));
        router.from_hub(frame, &slot);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let frame = next_frame(&slot, Duration::from_secs(5)).await;
        if frame["control"] == "human" {
            break;
        }
        assert!(Instant::now() < deadline, "no frame says a person drives");
    }

    // They hand it back; the agent's next action takes control again and sees what they did.
    let back = hub_frame(json!({
        "t": "browser_control", "sessionId": id, "control": "agent", "by": "human:laptop",
    }));
    router.from_hub(back, &slot);
    let said = read_back(&router, "cat \"$HOME/person.txt\"").await;
    assert!(said.contains("by-person"), "{said}");
    let scrolled = act(
        &router,
        json!({ "action": "scroll", "coordinate": [300, 200], "scroll_direction": "up", "scroll_amount": 2 }),
    )
    .await;
    assert!(
        scrolled["message"]
            .as_str()
            .unwrap()
            .starts_with("Scrolled 2"),
        "{scrolled}"
    );

    let ended = call(&router, json!({ "op": "session_end" })).await;
    assert_eq!(ended["result"]["kind"], "linux_desktop", "{ended}");
    let files: Vec<&str> = ended["result"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["file"].as_str().unwrap())
        .collect();
    assert!(files.contains(&"actions"), "{ended}");
    if with_video {
        assert!(files.contains(&"video"), "{ended}");
    }
    assert!(desktops.live(THREAD).is_none());

    let deadline = Instant::now() + Duration::from_secs(60);
    let recorded = loop {
        let listed = sessions(&hub).await;
        if listed["sessions"][0]["state"] == "recorded" {
            break listed["sessions"][0].clone();
        }
        assert!(Instant::now() < deadline, "not recorded: {listed}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert_eq!(recorded["kind"], "linux_desktop");
    assert!(
        !super::recordings_dir(node_home.path()).join(&id).exists(),
        "the node let it go"
    );
    let actions = String::from_utf8(read_file(&hub, &id, "actions").await).unwrap();
    assert!(
        !actions.contains(SECRET),
        "the secret never reaches the hub"
    );
    let lines: Vec<Value> = actions
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let steps: Vec<String> = lines
        .iter()
        .map(|l| match l["args"]["action"].as_str() {
            Some(action) => format!("{}:{action}", l["tool"].as_str().unwrap()),
            None => l["tool"].as_str().unwrap().to_owned(),
        })
        .collect();
    for want in [
        "session_start",
        "desktop:launch",
        "desktop:left_click",
        "desktop:type",
        "desktop:key",
        "request_takeover",
        "takeover",
        "handback",
        "agent_resumed",
        "desktop:scroll",
        "session_end",
    ] {
        assert!(steps.iter().any(|s| s == want), "{want} in {steps:?}");
    }
    let typed_line = lines
        .iter()
        .find(|l| l["args"]["action"] == "type")
        .unwrap();
    assert!(
        typed_line["args"]["text"]
            .as_str()
            .unwrap()
            .contains("***SHOP_TOKEN***"),
        "{typed_line}"
    );
    if with_video {
        let video = read_file(&hub, &id, "video").await;
        assert!(video.len() > 1000, "a video of {} bytes", video.len());
        assert_eq!(&video[..4], &[0x1a, 0x45, 0xdf, 0xa3], "WebM");
    }
    desktops.shutdown().await;
}
