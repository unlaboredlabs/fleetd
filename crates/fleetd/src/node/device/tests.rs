//! Android sessions end to end, on a real emulator with the hub in process: an agent starts a session, opens the
//! Settings app with agent-device and takes an action, a person takes over and hands back, the agent ends it, and its
//! recording is on the hub. They need KVM and the node's pinned install: `FLEETD_TEST_DEVICE_HOME` (or
//! `~/.cache/fleetd-test-device`, or the node's own `~/.fleetd/node`) holding it, which
//! `cargo test -p fleetd installs_the_pinned_emulator -- --ignored` makes (about 2 GB). Without them they say so and
//! pass.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::browser::{BrowserCallFrame, BrowserControl};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, op_name};
use fleetd_contracts::sessions::ThreadItem;
use serde_json::{Value, json};

use super::scrcpy::{Input, TouchAction};
use super::{DeviceConfig, Devices, Router, agent_device, sdk};
use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::HubDb;
use crate::node::browser::SessionHooks;
use crate::node::browser::upload::{HubCalls, HubFuture};
use crate::node::mask::Masker;

const THREAD: &str = "th-android-1";

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

/// Where the test install lives.
fn install_home() -> PathBuf {
    std::env::var_os("FLEETD_TEST_DEVICE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::node::util::home_dir().join(".cache/fleetd-test-device"))
}

/// A node home with the pinned install, or None (said why).
fn installed() -> Option<PathBuf> {
    if let Err((why, _)) = sdk::kvm() {
        eprintln!("skipped: no KVM here: {why}");
        return None;
    }
    let found = [
        install_home(),
        crate::node::util::home_dir().join(".fleetd/node"),
    ]
    .into_iter()
    .find(|home| sdk::find(home).is_some() && agent_device::find(home).is_some());
    if found.is_none() {
        eprintln!(
            "skipped: no Android emulator installed for tests (run `cargo test -p fleetd installs_the_pinned_emulator \
             -- --ignored`, or set FLEETD_TEST_DEVICE_HOME)"
        );
    }
    found
}

/// A fresh node home that uses `install`'s SDK, snapshot and agent-device, and keeps its own recordings.
fn node_home(install: &Path) -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let dir = home.path().join("device");
    std::fs::create_dir_all(&dir).unwrap();
    for shared in [
        "sdk",
        "avd",
        "emulator-home",
        "scrcpy-server.jar",
        "ffmpeg",
        "agent-device",
    ] {
        std::os::unix::fs::symlink(install.join("device").join(shared), dir.join(shared)).unwrap();
    }
    for marker in ["INSTALLED", "SNAPSHOT"] {
        std::fs::copy(install.join("device").join(marker), dir.join(marker)).unwrap();
    }
    home
}

async fn call(router: &Router, call: Value) -> Value {
    let frame: BrowserCallFrame = serde_json::from_value(json!({
        "id": "t1", "cwd": "/work/storefront", "threadId": THREAD, "call": call,
    }))
    .unwrap();
    serde_json::to_value(router.handle(THREAD.to_owned(), frame).await).unwrap()
}

/// Runs the session's agent-device as its claude would, with the environment the node gives it.
async fn agent_device(router: &Router, args: &[&str]) -> (bool, String) {
    let path = std::env::var("PATH").ok();
    let out = tokio::process::Command::new("agent-device")
        .args(args)
        .env_clear()
        .env("HOME", crate::node::util::home_dir())
        .envs(router.env(THREAD, path.as_deref()))
        .output()
        .await
        .unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (out.status.success(), text)
}

fn command_item(command: &str, output: &str, ok: bool) -> ThreadItem {
    serde_json::from_value(json!({
        "id": "toolu_1", "status": if ok { "completed" } else { "failed" }, "title": command,
        "startedAt": "2026-10-26T10:00:00.000Z", "completedAt": "2026-10-26T10:00:00.900Z",
        "updatedAt": "2026-10-26T10:00:00.900Z",
        "kind": { "type": "command", "command": command, "output": output, "exitCode": if ok { 0 } else { 1 } },
    }))
    .unwrap()
}

/// The next frame after `seq`, within `within`.
async fn frame_after(
    frames: &mut tokio::sync::watch::Receiver<Option<super::scrcpy::Frame>>,
    seq: u64,
    within: Duration,
) -> super::scrcpy::Frame {
    let deadline = Instant::now() + within;
    loop {
        if let Some(frame) = frames.borrow_and_update().clone()
            && frame.seq > seq
        {
            return frame;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        assert!(!left.is_zero(), "no frame after {seq}");
        let _ = tokio::time::timeout(left, frames.changed()).await;
    }
}

#[tokio::test]
#[ignore = "downloads about 2 GB and boots the emulator; run on a KVM machine to install the test emulator"]
async fn installs_the_pinned_emulator() {
    if let Err((why, _)) = sdk::kvm() {
        eprintln!("skipped: no KVM here: {why}");
        return;
    }
    let home = install_home();
    if agent_device::find(&home).is_none() {
        agent_device::install(&home).await.unwrap();
    }
    let started = Instant::now();
    sdk::install(&home).await.unwrap();
    eprintln!("installed in {} s", started.elapsed().as_secs());
    assert!(sdk::find(&home).is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_opens_settings_on_an_android_session_and_its_recording_is_on_the_hub() {
    let Some(install) = installed() else { return };
    let node_home = node_home(&install);
    let hub_home = tempfile::tempdir().unwrap();
    let hub = hub(hub_home.path());
    let devices = Devices::start(
        node_home.path(),
        DeviceConfig::default(),
        hub.clone(),
        Arc::new(|_| Ok(Masker::default())),
    )
    .await;
    let deadline = Instant::now() + Duration::from_secs(180);
    while devices.warm() == 0 {
        assert!(Instant::now() < deadline, "the pool booted no emulator");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let router = Router {
        browser: None,
        devices: Some(devices.clone()),
        live: Default::default(),
    };

    // A browser session needs a browser broker, which this node lacks; an android one starts from the pool.
    let refused = call(&router, json!({ "op": "session_start", "purpose": "Shop" })).await;
    assert_eq!(refused["error"]["code"], "failed", "{refused}");
    let started = call(
        &router,
        json!({ "op": "session_start", "purpose": "Check the Settings app", "kind": "android" }),
    )
    .await;
    let result = &started["result"];
    let id = result["sessionId"].as_str().expect("started").to_owned();
    let start_ms = result["startMs"].as_u64().unwrap();
    eprintln!("android session_start from the warm pool: {start_ms} ms");
    assert!(start_ms < 2_000, "{start_ms} ms");
    let serial = result["serial"].as_str().unwrap().to_owned();
    assert!(serial.starts_with("emulator-"), "{serial}");
    assert!(result.get("cdp").is_none());
    let live = sessions(&hub).await;
    assert_eq!(live["sessions"][0]["state"], "live");
    assert_eq!(live["sessions"][0]["kind"], "android");
    assert_eq!(live["sessions"][0]["purpose"], "Check the Settings app");

    // The agent opens Settings and takes an action, with agent-device pointed at the session's emulator.
    let (ok, opened) = agent_device(&router, &["open", "settings"]).await;
    assert!(ok, "{opened}");
    router.item(
        THREAD,
        &command_item("agent-device open settings", &opened, ok),
    );
    let (ok, snapshot) = agent_device(&router, &["snapshot", "-i"]).await;
    assert!(
        ok && snapshot.contains("com.android.settings"),
        "{snapshot}"
    );
    let (ok, pressed) =
        agent_device(&router, &["press", "label=\"Search settings\"", "--settle"]).await;
    assert!(ok, "{pressed}");
    router.item(
        THREAD,
        &command_item(
            "agent-device press label=\"Search settings\" --settle",
            &pressed,
            ok,
        ),
    );

    // A person watches and takes over: the agent's agent-device waits, the person's key reaches the device.
    let mut frames = devices.frames(&id).expect("live");
    let first = frame_after(&mut frames, 0, Duration::from_secs(15)).await;
    assert_eq!((first.width, first.height), (576, 1280));
    assert_eq!(&first.jpeg[..2], &[0xff, 0xd8], "a JPEG");
    assert!(
        !devices.input(&id, &Input::Text("x".into())),
        "not theirs yet"
    );
    assert_eq!(
        devices.set_control(&id, BrowserControl::Human, "human:desk"),
        Some(BrowserControl::Human)
    );
    let (ok, paused) = agent_device(&router, &["snapshot", "-i"]).await;
    assert!(!ok && paused.contains("A person has control"), "{paused}");
    let before = frames.borrow().as_ref().map_or(0, |f| f.seq);
    let back = Input::Key {
        down: true,
        key: "BrowserBack".into(),
        modifiers: 0,
    };
    assert!(devices.input(&id, &back));
    assert!(devices.input(
        &id,
        &Input::Key {
            down: false,
            key: "BrowserBack".into(),
            modifiers: 0
        }
    ));
    let tap = |action| Input::Touch {
        action,
        x: 288.0,
        y: 300.0,
    };
    assert!(devices.input(&id, &tap(TouchAction::Down)));
    assert!(devices.input(&id, &tap(TouchAction::Up)));
    frame_after(&mut frames, before, Duration::from_secs(10)).await;
    assert_eq!(
        devices.set_control(&id, BrowserControl::HandingBack, "human:desk"),
        Some(BrowserControl::HandingBack)
    );
    let (ok, after) = agent_device(&router, &["snapshot", "-i"]).await;
    assert!(ok, "{after}");
    router.item(
        THREAD,
        &command_item("agent-device snapshot -i", &after, ok),
    );
    assert_eq!(
        devices.live(THREAD).unwrap().control(),
        BrowserControl::Agent
    );
    // A command that didn't drive the device isn't in its log.
    router.item(THREAD, &command_item("cargo test", "ok", true));
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let ended = call(&router, json!({ "op": "session_end" })).await;
    assert_eq!(ended["result"]["kind"], "android", "{ended}");
    let files: Vec<&str> = ended["result"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["file"].as_str().unwrap())
        .collect();
    assert_eq!(files, ["actions", "video"], "{ended}");
    // The copy is gone with everything done in it.
    let adb = sdk::Sdk::at(node_home.path());
    let deadline = Instant::now() + Duration::from_secs(10);
    // adb notices a killed emulator within a moment.
    while adb
        .adb(&serial)
        .arg("get-state")
        .output()
        .unwrap()
        .status
        .success()
    {
        assert!(Instant::now() < deadline, "{serial} still answers");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    let deadline = Instant::now() + Duration::from_secs(60);
    let recorded = loop {
        let listed = sessions(&hub).await;
        if listed["sessions"][0]["state"] == "recorded" {
            break listed["sessions"][0].clone();
        }
        assert!(Instant::now() < deadline, "not recorded: {listed}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert_eq!(recorded["sessionId"], id.as_str());
    assert_eq!(recorded["kind"], "android");
    assert!(
        !super::session::recordings_dir(node_home.path())
            .join(&id)
            .exists(),
        "the node let it go"
    );
    let actions = String::from_utf8(read_file(&hub, &id, "actions").await).unwrap();
    let lines: Vec<Value> = actions
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let tools: Vec<&str> = lines.iter().map(|l| l["tool"].as_str().unwrap()).collect();
    assert_eq!(
        tools,
        [
            "session_start",
            "agent-device",
            "agent-device",
            "takeover",
            "handback",
            "agent-device",
            "session_end"
        ]
    );
    assert_eq!(lines[0]["args"]["serial"], serial.as_str());
    assert_eq!(lines[1]["args"]["command"], "agent-device open settings");
    let webm = read_file(&hub, &id, "video").await;
    assert_eq!(&webm[..4], &[0x1a, 0x45, 0xdf, 0xa3], "a webm");
    assert!(webm.len() > 1_000, "{} bytes", webm.len());
    if let Some(keep) = std::env::var_os("FLEETD_TEST_KEEP_VIDEO") {
        std::fs::write(keep, &webm).unwrap();
    }
    eprintln!(
        "recording on the hub: {} actions, {} bytes of video",
        lines.len(),
        webm.len()
    );
    devices.shutdown().await;
}

#[tokio::test]
async fn a_machine_without_android_sessions_says_so_and_one_session_kind_at_a_time() {
    let router = Router {
        browser: None,
        devices: None,
        live: Default::default(),
    };
    let refused = call(
        &router,
        json!({ "op": "session_start", "purpose": "Settings", "kind": "android" }),
    )
    .await;
    assert_eq!(refused["error"]["code"], "failed");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no Android sessions"),
        "{refused}"
    );
    let none = call(&router, json!({ "op": "session_end" })).await;
    assert!(none["error"].is_object(), "{none}");
}

#[test]
fn the_doctor_hears_only_of_machines_opted_in_or_installed() {
    use fleetd_contracts::node_link::AndroidState;
    let home = tempfile::tempdir().unwrap();
    let off = DeviceConfig {
        enabled: Some(false),
        ..DeviceConfig::default()
    };
    let opted_in = DeviceConfig {
        enabled: Some(true),
        ..DeviceConfig::default()
    };
    assert_eq!(super::health(home.path(), &off), None);
    assert_eq!(
        super::health(home.path(), &DeviceConfig::default()),
        None,
        "neither opted in nor installed: nothing to say"
    );
    assert!(
        super::capabilities(home.path()).is_empty(),
        "nothing installed"
    );
    let asked = super::health(home.path(), &opted_in).unwrap();
    if sdk::kvm().is_err() {
        assert_eq!(asked.state, AndroidState::Unavailable, "KVM doesn't open");
        return;
    }
    assert_eq!(asked.state, AndroidState::Wanted);
    super::write_state(
        home.path(),
        &super::InstallState {
            installing: false,
            failed: Some("no network".into()),
        },
    );
    let failed = super::health(home.path(), &opted_in).unwrap();
    assert_eq!(failed.state, AndroidState::Unavailable);
    assert!(failed.message.as_str().contains("no network"));
}

#[tokio::test]
async fn a_machine_not_set_up_keeps_agents_sdk_and_path_and_installs_nothing() {
    let home = tempfile::tempdir().unwrap();
    let hub_home = tempfile::tempdir().unwrap();
    let hub = hub(hub_home.path());
    // A node that stopped during an install left this; nothing installs at the start, so it is cleared.
    super::write_state(
        home.path(),
        &super::InstallState {
            installing: true,
            failed: None,
        },
    );
    let devices = Devices::start(
        home.path(),
        DeviceConfig::default(),
        hub.clone(),
        Arc::new(|_| Ok(Masker::default())),
    )
    .await;
    assert_eq!(
        std::fs::read_to_string(super::state_path(home.path())).unwrap(),
        r#"{"installing":false,"failed":null}"#
    );
    let router = Router {
        browser: None,
        devices: Some(devices.clone()),
        live: Default::default(),
    };
    assert!(!devices.offered());
    assert_eq!(router.env(THREAD, Some("/usr/bin")), Vec::new());
    assert!(router.plugin_dirs().is_empty());
    let refused = call(
        &router,
        json!({ "op": "session_start", "purpose": "Settings", "kind": "android" }),
    )
    .await;
    assert_eq!(refused["error"]["code"], "failed", "{refused}");
    let message = refused["error"]["message"].as_str().unwrap();
    assert!(
        message.contains("isn't set up") || message.contains("/dev/kvm"),
        "{message}"
    );
    assert!(
        !sdk::device_dir(home.path()).join("downloads").exists(),
        "nothing downloads"
    );
}

#[test]
fn one_start_at_a_time_per_agent_session() {
    let set = Arc::default();
    let first = super::Starting::claim(&set, THREAD).expect("the first");
    assert!(super::Starting::claim(&set, THREAD).is_none());
    assert!(super::Starting::claim(&set, "another").is_some());
    drop(first);
    assert!(
        super::Starting::claim(&set, THREAD).is_some(),
        "given up when dropped"
    );
}
