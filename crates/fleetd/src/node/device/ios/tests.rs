//! iOS sessions: what runs anywhere (the doctor's facts, the routing, a Mac not set up), then on macOS with Xcode
//! only, the probes the design rests on and a session end to end with the hub in process: an agent starts a session,
//! opens Settings with agent-device and taps, a person watches, takes over and hands back, the agent ends it, and its
//! recording is on the hub. The macOS tests make their golden simulator in `FLEETD_TEST_IOS_HOME` (or
//! `~/.cache/fleetd-test-ios`) the first time, which takes minutes. Elsewhere they say so and pass.
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use fleetd_contracts::browser::{BrowserCallFrame, BrowserControl};
use fleetd_contracts::node_link::IosState;
use serde_json::{Value, json};

use super::pool::{self, Golden};
use super::simctl::Simctl;
use super::{IosConfig, PrepState, Simulators, health_from, xcode_from};
use crate::node::browser::SessionHooks;
use crate::node::device::Router;
use crate::node::device::scrcpy::{Frame, Input};
use crate::node::device::tests::{TestHub, command_item, hub, read_file, sessions};
use crate::node::mask::Secrets;

const THREAD: &str = "th-ios-1";

const RUNTIMES: &str = r#"{ "runtimes": [ { "identifier": "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
    "name": "iOS 27.0", "version": "27.0", "isAvailable": true, "platform": "iOS",
    "supportedDeviceTypes": [ { "identifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17", "name": "iPhone 17",
                                "productFamily": "iPhone" } ] } ] }"#;

fn opted_in() -> IosConfig {
    IosConfig {
        enabled: Some(true),
        ..IosConfig::default()
    }
}

#[test]
fn the_doctor_reads_xcode_and_says_what_fixes_it() {
    assert_eq!(
        xcode_from(Ok(RUNTIMES.into()), None, true),
        Ok("iOS 27.0".into())
    );
    let no_runtime = xcode_from(Ok(r#"{ "runtimes": [] }"#.into()), None, true).unwrap_err();
    assert_eq!(
        no_runtime.1.as_deref(),
        Some("xcodebuild -downloadPlatform iOS")
    );
    let tools = xcode_from(
        Err("xcrun: error: unable to find utility \"simctl\"".into()),
        Some("/Library/Developer/CommandLineTools"),
        true,
    )
    .unwrap_err();
    assert_eq!(
        tools.1.as_deref(),
        Some("sudo xcode-select --switch /Applications/Xcode.app")
    );
    let none = xcode_from(Err("not found".into()), None, false).unwrap_err();
    assert!(none.0.contains("no Xcode"), "{none:?}");
    assert_eq!(none.1, None);
}

#[test]
fn the_doctor_hears_of_macs_with_xcode_and_of_macs_opted_in() {
    let fine = || Ok::<_, (String, Option<String>)>("iOS 27.0".to_owned());
    let broken = || Err(("no Xcode: install it from the App Store".to_owned(), None));
    let idle = PrepState::default();
    let off = IosConfig::default();

    let wanted = health_from(&off, None, &idle, fine, || true)
        .map(|(h, _)| h)
        .unwrap();
    assert_eq!(wanted.state, IosState::Wanted);
    assert!(wanted.message.as_str().contains("iOS 27.0"), "{wanted:?}");
    assert_eq!(
        health_from(&off, None, &idle, broken, || true).map(|(h, _)| h),
        None,
        "a Mac without Xcode that didn't opt in: nothing to say"
    );

    let unavailable = health_from(&opted_in(), None, &idle, broken, || true)
        .map(|(h, _)| h)
        .unwrap();
    assert_eq!(unavailable.state, IosState::Unavailable);
    let no_node = health_from(&opted_in(), None, &idle, fine, || false)
        .map(|(h, _)| h)
        .unwrap();
    assert_eq!(no_node.state, IosState::Unavailable);
    assert_eq!(no_node.fix.unwrap().as_str(), "brew install node");
    let failed = PrepState {
        preparing: false,
        failed: Some("xcodebuild failed".into()),
    };
    let failed = health_from(&opted_in(), None, &failed, fine, || true)
        .map(|(h, _)| h)
        .unwrap();
    assert_eq!(failed.state, IosState::Unavailable);
    assert!(failed.message.as_str().contains("xcodebuild failed"));
    let preparing = PrepState {
        preparing: true,
        failed: None,
    };
    let preparing = health_from(&opted_in(), None, &preparing, broken, || false)
        .map(|(h, _)| h)
        .unwrap();
    assert_eq!(preparing.state, IosState::Preparing);

    let golden = Golden {
        udid: "AAAA-1".into(),
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0".into(),
        runtime_name: "iOS 27.0".into(),
        device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17".into(),
        device_type_name: "iPhone 17".into(),
        scale: 3.0,
        agent_device: crate::node::device::agent_device::VERSION.into(),
    };
    let ready = health_from(&off, Some(&golden), &idle, broken, || false)
        .map(|(h, _)| h)
        .unwrap();
    assert_eq!(ready.state, IosState::Ready);
    assert!(
        ready.message.as_str().contains("iOS 27.0 on iPhone 17"),
        "{ready:?}"
    );
}

/// The hub sends an ios session_start only where the host check is ready (machine roles). A Mac opted in whose golden
/// is being made, or failed, must get it: the node answers "still making it", and a failed golden is made again only
/// by the next session_start. A Mac missing Xcode or Node.js, or not opted in, must not.
#[test]
fn the_hub_sends_a_mac_opted_in_its_session_while_the_golden_is_made_or_after_it_failed() {
    let fine = || Ok::<_, (String, Option<String>)>("iOS 27.0".to_owned());
    let broken = || Err(("no Xcode: install it from the App Store".to_owned(), None));
    let placed = |config: &IosConfig, state: &PrepState, xcode: bool, node: bool| {
        let (health, placeable) = match xcode {
            true => health_from(config, None, state, fine, || node),
            false => health_from(config, None, state, broken, || node),
        }
        .unwrap();
        (health.state, placeable)
    };
    let idle = PrepState::default();
    let preparing = PrepState {
        preparing: true,
        failed: None,
    };
    let failed = PrepState {
        preparing: false,
        failed: Some("xcodebuild failed".into()),
    };
    let off = IosConfig::default();
    assert_eq!(
        placed(&opted_in(), &idle, true, true),
        (IosState::Preparing, true)
    );
    assert_eq!(
        placed(&opted_in(), &preparing, true, true),
        (IosState::Preparing, true)
    );
    assert_eq!(
        placed(&opted_in(), &failed, true, true),
        (IosState::Unavailable, true),
        "tried again"
    );
    assert_eq!(
        placed(&opted_in(), &failed, false, true),
        (IosState::Unavailable, false),
        "no Xcode"
    );
    assert_eq!(
        placed(&opted_in(), &idle, true, false),
        (IosState::Unavailable, false),
        "no Node.js"
    );
    assert_eq!(
        placed(&off, &idle, true, true),
        (IosState::Wanted, false),
        "not opted in"
    );
}

#[test]
fn ios_sessions_run_only_on_macos_and_only_ready_ones_are_advertised() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(IosConfig::default().enabled(), cfg!(target_os = "macos"));
    let off = IosConfig {
        enabled: Some(false),
        ..IosConfig::default()
    };
    assert!(!off.enabled());
    assert_eq!(super::health(home.path(), &off), None);
    assert!(
        super::capabilities(home.path()).is_empty(),
        "no golden made"
    );
}

async fn call(router: &Router, call: Value) -> Value {
    let frame: BrowserCallFrame = serde_json::from_value(json!({
        "id": "t1", "cwd": "/work/storefront", "threadId": THREAD, "call": call,
    }))
    .unwrap();
    serde_json::to_value(router.handle(THREAD.to_owned(), frame).await).unwrap()
}

#[tokio::test]
async fn a_machine_without_ios_sessions_says_so() {
    let router = Router {
        browser: None,
        devices: None,
        ios: None,
        live: Default::default(),
        desktops: None,
    };
    let refused = call(
        &router,
        json!({ "op": "session_start", "purpose": "Settings", "kind": "ios" }),
    )
    .await;
    assert_eq!(refused["error"]["code"], "failed");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no iOS sessions: they need a Mac with Xcode"),
        "{refused}"
    );
}

#[tokio::test]
async fn a_mac_not_set_up_refuses_and_gives_agents_nothing() {
    let home = tempfile::tempdir().unwrap();
    let hub_home = tempfile::tempdir().unwrap();
    let hub = hub(hub_home.path());
    let simulators = Simulators::start(
        home.path(),
        IosConfig::default(),
        hub,
        Arc::new(|_| Ok(Secrets::default())),
    )
    .await;
    let router = Router {
        browser: None,
        devices: None,
        ios: Some(simulators.clone()),
        live: Default::default(),
        desktops: None,
    };
    assert!(!simulators.offered());
    assert_eq!(router.env(THREAD, Some("/usr/bin")), Vec::new());
    assert!(router.plugin_dirs().is_empty());
    let refused = call(
        &router,
        json!({ "op": "session_start", "purpose": "Settings", "kind": "ios" }),
    )
    .await;
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("isn't set up for iOS sessions"),
        "{refused}"
    );
    let takeover = call(&router, json!({ "op": "session_end" })).await;
    assert!(takeover["error"].is_object(), "no session: {takeover}");
    assert!(
        !super::ios_dir(home.path()).join("set").exists(),
        "no simulator made"
    );
}

// ---- macOS with Xcode only ----

/// Why this machine can't run the macOS tests, if it can't.
fn no_xcode() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return Some("iOS simulators need macOS".to_owned());
    }
    if let Err((why, _)) = super::xcode() {
        return Some(why);
    }
    if !super::node_runs() {
        return Some("agent-device needs Node.js".to_owned());
    }
    None
}

fn install_home() -> PathBuf {
    std::env::var_os("FLEETD_TEST_IOS_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::node::util::home_dir().join(".cache/fleetd-test-ios"))
}

fn ms(d: Duration) -> u128 {
    d.as_millis()
}

/// What the design assumes of simctl, measured: that `clone` needs its source shut down, how long boots take, how
/// fast a screenshot loop gives frames (and idb's video, where idb is installed), and that `recordVideo` finishes an
/// MP4 on SIGINT to its process group. Prints `probe:` lines for the PR.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn probes_what_ios_sessions_rest_on() {
    if let Some(why) = no_xcode() {
        eprintln!("skipped: {why}");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let simctl = Simctl::new(dir.path().join("set"));
    let runtimes = simctl.runtimes().await.unwrap();
    let (runtime, device_type) = super::simctl::pick(&runtimes, None).unwrap();
    eprintln!(
        "probe: {} on {} (scale {})",
        device_type.name,
        runtime.name,
        super::simctl::scale(&device_type).await
    );
    let source = simctl
        .create("probe-source", &device_type.identifier, &runtime.identifier)
        .await
        .unwrap();
    let t = Instant::now();
    simctl
        .boot(&source, Duration::from_secs(900))
        .await
        .unwrap();
    eprintln!(
        "probe: first boot of a new simulator: {} ms",
        ms(t.elapsed())
    );

    // The screenshot loop, as the live view runs it.
    let shot = dir.path().join("shot.jpg");
    let mut took = Vec::new();
    let mut bytes = 0;
    let mut size = None;
    let mut failed = Vec::new();
    for _ in 0..20 {
        let t = Instant::now();
        match simctl.screenshot(&source, &shot).await {
            Ok(()) => {
                let jpeg = std::fs::read(&shot).unwrap();
                took.push(t.elapsed());
                bytes += jpeg.len();
                size = crate::node::device::scrcpy::jpeg_size(&jpeg);
            }
            Err(why) => failed.push(why),
        }
    }
    took.sort();
    let at = |q: usize| took.get(took.len() * q / 100).map_or(0, |d| ms(*d));
    eprintln!(
        "probe: screenshot loop: {} of 20 taken, median {} ms, p90 {} ms, {} KB a frame, {:?} px{}",
        took.len(),
        at(50),
        at(90),
        bytes / took.len().max(1) / 1024,
        size,
        failed
            .first()
            .map(|why| format!("; failed: {why}"))
            .unwrap_or_default()
    );
    probe_idb(&source).await;

    // recordVideo stops on SIGINT to its group and leaves an MP4.
    let video = dir.path().join("video.mp4");
    let mut recorder = simctl
        .record(&source, &video)
        .process_group(0)
        .spawn()
        .unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    let t = Instant::now();
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(recorder.id().unwrap() as i32),
        nix::sys::signal::Signal::SIGINT,
    );
    let status = tokio::time::timeout(Duration::from_secs(20), recorder.wait())
        .await
        .expect("recordVideo finishes on SIGINT")
        .unwrap();
    let mp4 = std::fs::read(&video).unwrap_or_default();
    eprintln!(
        "probe: recordVideo: {status}, finished in {} ms, {} KB for 3 s, ftyp {}",
        ms(t.elapsed()),
        mp4.len() / 1024,
        mp4.get(4..8) == Some(b"ftyp")
    );
    assert_eq!(mp4.get(4..8), Some(&b"ftyp"[..]), "an MP4");

    let t = Instant::now();
    let cloned_booted = simctl.clone_device(&source, "probe-from-booted").await;
    eprintln!(
        "probe: clone of a booted simulator: {} in {} ms",
        match &cloned_booted {
            Ok(_) => "works".to_owned(),
            Err(why) => format!("refused ({why})"),
        },
        ms(t.elapsed())
    );
    if let Ok(udid) = &cloned_booted {
        let _ = simctl.delete(udid).await;
    }

    simctl.shutdown(&source).await.unwrap();
    let t = Instant::now();
    let clone = simctl.clone_device(&source, "probe-clone").await.unwrap();
    eprintln!(
        "probe: clone of the shut-down simulator: {} ms",
        ms(t.elapsed())
    );
    let t = Instant::now();
    simctl.boot(&clone, pool::BOOT_TIMEOUT).await.unwrap();
    eprintln!("probe: boot of the clone: {} ms", ms(t.elapsed()));
    let t = Instant::now();
    simctl.shutdown(&clone).await.unwrap();
    simctl.delete(&clone).await.unwrap();
    eprintln!(
        "probe: shutdown and delete of the clone: {} ms",
        ms(t.elapsed())
    );
    assert_eq!(pool::clear(&simctl, None).await, 1, "the source");
}

/// idb's MJPEG stream, where idb is installed: frames in 5 s and the first frame's wait.
async fn probe_idb(udid: &str) {
    let Ok(mut idb) = tokio::process::Command::new("idb")
        .args([
            "video-stream",
            "--udid",
            udid,
            "--format",
            "mjpeg",
            "--fps",
            "30",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        eprintln!("probe: idb: not installed here, not measured");
        return;
    };
    use tokio::io::AsyncReadExt;
    let mut out = idb.stdout.take().unwrap();
    let t = Instant::now();
    let mut buf = vec![0u8; 1 << 16];
    let (mut frames, mut bytes, mut first) = (0usize, 0usize, None);
    let mut last = 0u8;
    while t.elapsed() < Duration::from_secs(5) {
        let read = tokio::time::timeout(Duration::from_secs(5), out.read(&mut buf)).await;
        let Ok(Ok(n)) = read else { break };
        if n == 0 {
            break;
        }
        bytes += n;
        for &b in &buf[..n] {
            if last == 0xff && b == 0xd9 {
                frames += 1;
                first.get_or_insert(t.elapsed());
            }
            last = b;
        }
    }
    let _ = idb.kill().await;
    eprintln!(
        "probe: idb video-stream mjpeg: {frames} frames in 5 s, first after {:?} ms, {} KB a frame",
        first.map(ms),
        bytes / frames.max(1) / 1024
    );
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

async fn frame_after(
    frames: &mut tokio::sync::watch::Receiver<Option<Frame>>,
    seq: u64,
    within: Duration,
) -> Frame {
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

async fn wait_recorded(hub: &TestHub, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let listed = sessions(hub).await;
        let ours = listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["sessionId"] == id)
            .cloned();
        if let Some(s) = ours.filter(|s| s["state"] == "recorded") {
            return s;
        }
        assert!(Instant::now() < deadline, "not recorded: {listed}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_agent_opens_settings_on_an_ios_session_and_its_recording_is_on_the_hub() {
    if let Some(why) = no_xcode() {
        eprintln!("skipped: {why}");
        return;
    }
    let home = install_home();
    if pool::find(&home).is_none() {
        let t = Instant::now();
        let golden = pool::prepare(&home, None).await.unwrap();
        eprintln!(
            "golden {} on {} made in {} s",
            golden.device_type_name,
            golden.runtime_name,
            t.elapsed().as_secs()
        );
    }
    let hub_home = tempfile::tempdir().unwrap();
    let hub = hub(hub_home.path());
    let simulators = Simulators::start(
        &home,
        opted_in(),
        hub.clone(),
        Arc::new(|_| Ok(Secrets::default())),
    )
    .await;
    let t = Instant::now();
    while simulators.warm() == 0 {
        assert!(
            t.elapsed() < Duration::from_secs(300),
            "the pool booted no clone"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    eprintln!(
        "the pool's first clone, cloned and booted: {} ms",
        ms(t.elapsed())
    );
    let router = Router {
        browser: None,
        devices: None,
        ios: Some(simulators.clone()),
        live: Default::default(),
        desktops: None,
    };

    let started = call(
        &router,
        json!({ "op": "session_start", "purpose": "Check the Settings app", "kind": "ios" }),
    )
    .await;
    let result = &started["result"];
    let id = result["sessionId"].as_str().expect("started").to_owned();
    let start_ms = result["startMs"].as_u64().unwrap();
    eprintln!("ios session_start from the warm pool: {start_ms} ms");
    assert!(start_ms < 2_000, "{start_ms} ms");
    let udid = result["udid"].as_str().unwrap().to_owned();
    let live = sessions(&hub).await;
    assert_eq!(live["sessions"][0]["kind"], "ios", "{live}");
    let refused = call(&router, json!({ "op": "session_start", "purpose": "Shop" })).await;
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("iOS session"),
        "one session at a time: {refused}"
    );

    // A small CI machine can't boot the pool's next clone and start agent-device's runner at once (its own xcrun
    // calls time out at 15 s): let the refill finish first, as long as it takes there (a minute and a half or more).
    let t = Instant::now();
    while simulators.warm() == 0 && t.elapsed() < Duration::from_secs(360) {
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    match simulators.warm() {
        0 => eprintln!(
            "the pool had not refilled after {} ms; going on",
            ms(t.elapsed())
        ),
        _ => eprintln!("the pool refilled behind it: {} ms", ms(t.elapsed())),
    }

    // The agent opens Settings and taps a row, with agent-device pointed at the session's clone.
    let t = Instant::now();
    let (mut ok, mut opened) = agent_device(&router, &["open", "com.apple.Preferences"]).await;
    if !ok {
        eprintln!("agent-device open failed once, trying again: {opened}");
        (ok, opened) = agent_device(&router, &["open", "com.apple.Preferences"]).await;
    }
    assert!(ok, "{opened}");
    eprintln!(
        "agent-device's first command (the runner starts): {} ms",
        ms(t.elapsed())
    );
    router.item(
        THREAD,
        &command_item("agent-device open com.apple.Preferences", &opened, ok),
    );
    let t = Instant::now();
    let (ok, pressed) = agent_device(&router, &["press", "label=\"General\"", "--settle"]).await;
    assert!(ok, "{pressed}");
    eprintln!("agent-device press --settle: {} ms", ms(t.elapsed()));
    router.item(
        THREAD,
        &command_item(
            "agent-device press label=\"General\" --settle",
            &pressed,
            ok,
        ),
    );

    // A person watches and takes over: the agent's agent-device waits, the person's Home reaches the simulator.
    let mut frames = simulators.frames(&id).expect("live");
    let t = Instant::now();
    let first = frame_after(&mut frames, 0, Duration::from_secs(15)).await;
    eprintln!(
        "live view: first frame after {} ms, {}x{} px, {} KB",
        ms(t.elapsed()),
        first.width,
        first.height,
        first.jpeg.len() / 1024
    );
    let t = Instant::now();
    let tenth = frame_after(&mut frames, first.seq + 8, Duration::from_secs(30)).await;
    eprintln!(
        "live view: {:.1} frames a second",
        (tenth.seq - first.seq) as f64 / t.elapsed().as_secs_f64()
    );
    assert!(
        !simulators.input(&id, &Input::Text("x".into())),
        "not theirs yet"
    );
    assert_eq!(
        simulators.set_control(&id, BrowserControl::Human, "human:desk"),
        Some(BrowserControl::Human)
    );
    let (ok, paused) = agent_device(&router, &["snapshot", "-i"]).await;
    assert!(!ok && paused.contains("A person has control"), "{paused}");
    let before = frames.borrow().clone().unwrap();
    let home_key = |down| Input::Key {
        down,
        key: "BrowserHome".into(),
        modifiers: 0,
    };
    let t = Instant::now();
    assert!(simulators.input(&id, &home_key(true)));
    assert!(simulators.input(&id, &home_key(false)));
    loop {
        let frame = frame_after(&mut frames, before.seq, Duration::from_secs(30)).await;
        if frame.jpeg != before.jpeg {
            break;
        }
        assert!(
            t.elapsed() < Duration::from_secs(30),
            "the screen never changed"
        );
    }
    eprintln!(
        "a person's Home, to a changed frame: {} ms",
        ms(t.elapsed())
    );
    drop(frames);
    assert_eq!(
        simulators.set_control(&id, BrowserControl::HandingBack, "human:desk"),
        Some(BrowserControl::HandingBack)
    );
    let (ok, after) = agent_device(&router, &["snapshot", "-i"]).await;
    assert!(ok, "{after}");
    router.item(
        THREAD,
        &command_item("agent-device snapshot -i", &after, ok),
    );
    assert_eq!(
        simulators.live(THREAD).unwrap().control(),
        BrowserControl::Agent
    );
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let ended = call(&router, json!({ "op": "session_end" })).await;
    assert_eq!(ended["result"]["kind"], "ios", "{ended}");
    let files: Vec<&str> = ended["result"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["file"].as_str().unwrap())
        .collect();
    assert_eq!(files, ["actions", "video_mp4"], "{ended}");
    // The clone goes with everything done in it.
    let simctl = Simctl::new(super::set_dir(&home));
    let t = Instant::now();
    while simctl
        .devices()
        .await
        .unwrap()
        .iter()
        .any(|d| d.udid == udid)
    {
        assert!(
            t.elapsed() < Duration::from_secs(60),
            "{udid} is still there"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let recorded = wait_recorded(&hub, &id).await;
    assert_eq!(recorded["kind"], "ios");
    let actions = String::from_utf8(read_file(&hub, &id, "actions").await).unwrap();
    let tools: Vec<String> = actions
        .lines()
        .map(|l| {
            serde_json::from_str::<Value>(l).unwrap()["tool"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
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
    let mp4 = read_file(&hub, &id, "video_mp4").await;
    assert_eq!(mp4.get(4..8), Some(&b"ftyp"[..]), "an MP4");
    eprintln!(
        "recording on the hub: {} actions, {} KB of video",
        tools.len(),
        mp4.len() / 1024
    );
    simulators.shutdown().await;
}
