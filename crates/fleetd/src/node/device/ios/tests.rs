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
use super::simctl::{self, Simctl};
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
        xctestrun: "/n/runner/AgentDeviceRunner_iphonesimulator27.0-arm64.xctestrun".into(),
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
fn a_start_with_no_warm_clone_says_whether_a_boot_runs_or_when_the_next_one_does() {
    let words = |failing: Option<&str>, retry_in| {
        super::waiting_words(&super::pool::Waiting {
            secs: 70,
            failing: failing.map(str::to_owned),
            retry_in,
        })
        .0
    };
    assert_eq!(
        words(None, None),
        "Starting a simulator for you; it is ready in about 70 s."
    );
    assert_eq!(
        words(Some("boot timed out"), None),
        "This Mac's last iOS simulator boot failed (boot timed out); another is booting now, ready in about 70 s if \
         it works."
    );
    assert_eq!(
        words(Some("boot timed out"), Some(45)),
        "This Mac's iOS simulators keep failing to boot (boot timed out); it tries again in about 45 s."
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

    // recordVideo says when it has started, stops on SIGINT to its group after that, and leaves an MP4.
    let video = dir.path().join("video.mp4");
    let t = Instant::now();
    let mut recorder = super::session::Recorder::start(&simctl, &source, video.clone()).unwrap();
    let started = recorder.started(Duration::from_secs(30)).await;
    eprintln!(
        "probe: recordVideo said it started: {started}, after {} ms",
        ms(t.elapsed())
    );
    tokio::time::sleep(Duration::from_secs(3)).await;
    let t = Instant::now();
    let finished = recorder.finish().await;
    let mp4 = std::fs::read(&video).unwrap_or_default();
    eprintln!(
        "probe: recordVideo: {finished:?}, finished in {} ms, {} KB for 3 s, ftyp {}",
        ms(t.elapsed()),
        mp4.len() / 1024,
        mp4.get(4..8) == Some(b"ftyp")
    );
    assert!(started, "recordVideo never said it started");
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
    assert_eq!(
        pool::clear(dir.path(), &simctl, None).await,
        1,
        "the source"
    );
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

/// The longest the pool may take to make a clone ready: clone it, boot it, start its runner and stop the daemon that
/// did, leaving the runner to the session's.
const WARM_MAX: Duration = Duration::from_secs(
    pool::BOOT_TIMEOUT.as_secs() + pool::RUNNER_START.as_secs() + 60 + pool::DAEMON_EXIT.as_secs(),
);

/// That the clone a session got from the pool has its XCTest runner up, as the pool started it: leased, its xcodebuild
/// running and the runner listening, so the agent's first command doesn't wait for it to start.
fn runner_up(home: &std::path::Path, udid: &str) -> Result<(), String> {
    let lease =
        super::wrapper::lease(home, udid).ok_or_else(|| format!("no runner lease for {udid}"))?;
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(lease.pid), None)
        .map_err(|e| format!("the runner's xcodebuild {} is gone: {e}", lease.pid))?;
    let at = std::net::SocketAddr::from(([127, 0, 0, 1], lease.port));
    std::net::TcpStream::connect_timeout(&at, Duration::from_secs(5))
        .map(drop)
        .map_err(|e| format!("the runner doesn't listen on {at}: {e}"))
}

/// Runs a session test's `body`, then ends the node's simulators even when it failed: the hosted screen's test, failing,
/// once left its clone being deleted and its agent-device daemon running into the next test (main's run 40885901242).
async fn ending(simulators: &Arc<Simulators>, body: impl Future<Output = ()> + Send + 'static) {
    let ran = tokio::spawn(body).await;
    simulators.shutdown().await;
    if let Err(e) = ran {
        std::panic::resume_unwind(e.into_panic());
    }
}

/// The node's simulators and their states, for a failure's log: whether the session's clone is still there.
async fn set_devices(home: &std::path::Path) -> String {
    match Simctl::new(super::set_dir(home)).devices().await {
        Ok(devices) => devices
            .iter()
            .map(|d| format!("{} {} {}", d.name, d.udid, d.state))
            .collect::<Vec<_>>()
            .join("; "),
        Err(e) => e,
    }
}

/// What the Mac is busy with, for the log: its load, the CPU each booted simulator in the set uses, and free memory.
async fn host_load(home: &std::path::Path) -> String {
    async fn out(program: &str, args: &[&str]) -> String {
        tokio::process::Command::new(program)
            .args(args)
            .output()
            .await
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .unwrap_or_else(|e| format!("{program}: {e}"))
    }
    let ps = out("ps", &["-A", "-o", "pid=,ppid=,%cpu=,command="]).await;
    let all: f64 = ps
        .lines()
        .filter_map(|l| l.split_whitespace().nth(2)?.parse::<f64>().ok())
        .sum();
    let simulators = match Simctl::new(super::set_dir(home)).devices().await {
        Ok(devices) => devices
            .iter()
            .map(|d| match d.state.as_str() {
                "Booted" => format!(
                    "{} booted, {:.0}% CPU",
                    d.name,
                    pool::device_cpu(&ps, &d.udid)
                ),
                state => format!("{} {state}", d.name),
            })
            .collect::<Vec<_>>()
            .join(", "),
        Err(e) => e,
    };
    let memory = out("memory_pressure", &["-Q"]).await;
    format!(
        "load {} on {} CPUs, {all:.0}% CPU in all; {simulators}; {}",
        out("sysctl", &["-n", "vm.loadavg"]).await,
        out("sysctl", &["-n", "hw.ncpu"]).await,
        memory
            .lines()
            .last()
            .unwrap_or("memory_pressure said nothing")
    )
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

/// The session as the hub lists it, once the node's report (sent in the background) is there.
async fn wait_listed(hub: &TestHub, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let listed = sessions(hub).await;
        if let Some(s) = listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["sessionId"] == id)
        {
            return s.clone();
        }
        assert!(Instant::now() < deadline, "not listed: {listed}");
        tokio::time::sleep(Duration::from_millis(200)).await;
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
    ending(&simulators, settings_session(home, hub, simulators.clone())).await;
}

async fn settings_session(home: PathBuf, hub: Arc<TestHub>, simulators: Arc<Simulators>) {
    let t = Instant::now();
    while simulators.warm() == 0 {
        assert!(t.elapsed() < WARM_MAX, "the pool booted no clone");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    eprintln!(
        "the pool's first clone, cloned, booted and its runner started: {} ms",
        ms(t.elapsed())
    );
    let router = Router {
        browser: None,
        devices: None,
        ios: Some(simulators.clone()),
        live: Default::default(),
        desktops: None,
    };

    // The pool refills behind a session, but not yet. GitHub's 3-vCPU, 7 GB macOS VM can't keep a second simulator
    // booted beside the session's while agent-device's XCTest runner starts there: with the refill's clone just booted,
    // the runner never reached its tests in 45 s, three starts in a row, and simctl's calls there timed out at 2, 10
    // and 15 s; on the golden alone it listened 36 s after xcodebuild started. So the refill waits until agent-device
    // is done here, and is measured then.
    simulators.hold_refill(true);
    let started = call(
        &router,
        json!({ "op": "session_start", "purpose": "Check the Settings app", "kind": "ios" }),
    )
    .await;
    let result = &started["result"];
    let id = result["sessionId"].as_str().expect("started").to_owned();
    let start_ms = result["startMs"].as_u64().unwrap();
    eprintln!("ios session_start from the warm pool: {start_ms} ms");
    // No boot: well under a second on a Mac, but GitHub's 3-vCPU VM, running two simulators, measured 139, 1640 and
    // 3011 ms.
    assert!(start_ms < 10_000, "{start_ms} ms");
    let udid = result["udid"].as_str().unwrap().to_owned();
    eprintln!("the session's clone: {udid}");
    runner_up(&home, &udid).unwrap();
    let live = wait_listed(&hub, &id).await;
    assert_eq!(live["kind"], "ios", "{live}");
    let refused = call(&router, json!({ "op": "session_start", "purpose": "Shop" })).await;
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("iOS session"),
        "one session at a time: {refused}"
    );

    // The golden stays shut down once made: its agent-device daemon stopped the XCTest runner on its way out. A runner
    // left running relaunched itself, booted the golden again, and every refill's clone was refused (wrapper.rs).
    let golden = pool::find(&home).unwrap();
    let devices = set_devices(&home).await;
    assert!(
        devices.contains(&format!("{} Shutdown", golden.udid)),
        "the golden {} is booted again: {devices}",
        golden.udid
    );

    // The agent opens Settings and taps a row, with agent-device pointed at the session's clone and the golden's runner.
    let runner = golden.xctestrun;
    let built = std::fs::metadata(&runner)
        .and_then(|m| m.modified())
        .unwrap();
    eprintln!("before agent-device: {}", host_load(&home).await);
    let t = Instant::now();
    let (ok, opened) = agent_device(&router, &["open", "com.apple.Preferences"]).await;
    assert!(ok, "{opened}\n{}", host_load(&home).await);
    eprintln!(
        "agent-device's first command (the runner starts): {} ms",
        ms(t.elapsed())
    );
    router.item(
        THREAD,
        &command_item("agent-device open com.apple.Preferences", &opened, ok),
    );
    // The press goes through agent-device's XCTest runner, started from the golden's build.
    let t = Instant::now();
    let press = ["press", "label=\"General\"", "--settle"];
    let (ok, pressed) = agent_device(&router, &press).await;
    assert!(
        ok,
        "{pressed}\nafter {} ms; {}",
        ms(t.elapsed()),
        host_load(&home).await
    );
    eprintln!("agent-device press --settle: {} ms", ms(t.elapsed()));
    // No session builds the runner: a slow start once had agent-device delete it and build it again in the command.
    assert_eq!(
        std::fs::metadata(&runner).and_then(|m| m.modified()).ok(),
        Some(built),
        "the golden's runner {} was rebuilt or deleted",
        runner.display()
    );
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
    // The loop goes on, as fast as this Mac's simctl takes screenshots: on a busy CI runner, with recordVideo and the
    // XCTest runner on the same simulator, one can take 5 s or time out at 10, so the rate is measured, not asserted.
    let t = Instant::now();
    let mut last = first.seq;
    while last == first.seq || t.elapsed() < Duration::from_secs(10) {
        last = frame_after(&mut frames, last, Duration::from_secs(30))
            .await
            .seq;
    }
    eprintln!(
        "live view: {:.1} frames a second",
        (last - first.seq) as f64 / t.elapsed().as_secs_f64()
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
    // agent-device's home goes through the XCTest runner, and the frame that shows it through simctl's slow screenshots.
    let t = Instant::now();
    assert!(simulators.input(&id, &home_key(true)));
    assert!(simulators.input(&id, &home_key(false)));
    let mut seen = before.seq;
    loop {
        let frame = frame_after(&mut frames, seen, Duration::from_secs(30)).await;
        if frame.jpeg != before.jpeg {
            break;
        }
        seen = frame.seq;
        assert!(
            t.elapsed() < Duration::from_secs(60),
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

    // agent-device is done: the pool refills behind the session now. Beside the session's simulator and its recording,
    // GitHub's runner took 107 to 343 s and at times longer, so the test waits as long as the pool gives a refill (a
    // clone, a boot, then BOOT_TIMEOUT for it to finish, and its runner's start) and only measures it: a boot that ran
    // out of time is logged, and the pool tries again later (pool.rs's tests cover that).
    simulators.hold_refill(false);
    let t = Instant::now();
    let refill = 2 * simctl::CALL + WARM_MAX;
    loop {
        if simulators.warm() > 0 {
            eprintln!("the pool refilled behind it: {} ms", ms(t.elapsed()));
            break;
        }
        if let Some(why) = simulators.refill_failing() {
            eprintln!(
                "the pool's refill failed after {} ms; not asserted, this machine can't boot a second simulator \
                 beside a session in time: {why}",
                ms(t.elapsed())
            );
            break;
        }
        assert!(
            t.elapsed() < refill + Duration::from_secs(30),
            "the pool's refill neither finished nor failed in {} s",
            t.elapsed().as_secs()
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    eprintln!("after the refill: {}", host_load(&home).await);
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
}

/// A screen this Mac hosts for an agent on another machine (node/device/remote.rs): its agent-device commands run on
/// its own clone, in its own folder, and log as the agent's own would; its screenshot comes back; a selector of another
/// device is refused; a person's control holds the commands back until they hand it back; its end takes the folder.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_screen_hosted_for_an_agent_elsewhere_runs_its_agent_device_commands() {
    if let Some(why) = no_xcode() {
        eprintln!("skipped: {why}");
        return;
    }
    let home = install_home();
    if pool::find(&home).is_none() {
        pool::prepare(&home, None).await.unwrap();
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
    ending(&simulators, hosted_screen(home, hub, simulators.clone())).await;
}

async fn hosted_screen(home: PathBuf, hub: Arc<TestHub>, simulators: Arc<Simulators>) {
    use base64::Engine;
    const KEY: &str = "H0123456789abcdef0123456789abcdef";
    let t = Instant::now();
    while simulators.warm() == 0 {
        assert!(t.elapsed() < WARM_MAX, "the pool booted no clone");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // One simulator at a time on CI's VM, as in the session above.
    simulators.hold_refill(true);
    let router = Router {
        browser: None,
        devices: None,
        ios: Some(simulators.clone()),
        live: Default::default(),
        desktops: None,
    };
    let handle = |call: Value| {
        let frame: BrowserCallFrame =
            serde_json::from_value(json!({ "id": "h1", "cwd": "/work/app", "call": call }))
                .unwrap();
        let router = &router;
        async move { serde_json::to_value(router.handle(KEY.to_owned(), frame).await).unwrap() }
    };
    let device = |args: &[&str]| handle(json!({ "op": "device", "step": "run", "args": args }));
    let started =
        handle(json!({ "op": "session_start", "purpose": "The phone app", "kind": "ios" })).await;
    let id = started["result"]["sessionId"]
        .as_str()
        .expect("started")
        .to_owned();
    runner_up(&home, started["result"]["udid"].as_str().unwrap()).unwrap();

    let t = Instant::now();
    let opened = device(&["open", "com.apple.Preferences"]).await;
    assert_eq!(opened["result"]["exitCode"], 0, "{opened}");
    eprintln!("a hosted screen's first command: {} ms", ms(t.elapsed()));
    let shot = device(&["screenshot", "out/1-home.png"]).await;
    assert_eq!(shot["result"]["exitCode"], 0, "{shot}");
    assert_eq!(shot["result"]["files"][0]["name"], "1-home.png", "{shot}");
    let got =
        handle(json!({ "op": "device", "step": "get", "name": "1-home.png", "offset": 0 })).await;
    let png = base64::engine::general_purpose::STANDARD
        .decode(got["result"]["dataB64"].as_str().expect("a piece"))
        .unwrap();
    assert_eq!(png.get(..4), Some(&b"\x89PNG"[..]));

    let golden = pool::find(&home).unwrap();
    let elsewhere = device(&["snapshot", "--udid", &golden.udid]).await;
    assert_eq!(elsewhere["error"]["code"], "invalid", "{elsewhere}");

    simulators.set_control(&id, BrowserControl::Human, "human:desk");
    let paused = device(&["snapshot", "-i"]).await;
    assert_eq!(paused["result"]["exitCode"], 75, "{paused}");
    assert!(
        paused["result"]["stderr"]
            .as_str()
            .unwrap()
            .contains("A person has control")
    );
    simulators.set_control(&id, BrowserControl::HandingBack, "human:desk");
    let after = device(&["snapshot", "-i"]).await;
    assert_eq!(after["result"]["exitCode"], 0, "{after}");
    assert_eq!(
        simulators.live(KEY).unwrap().control(),
        BrowserControl::Agent
    );

    let ended = handle(json!({ "op": "session_end" })).await;
    assert_eq!(ended["result"]["kind"], "ios", "{ended}");
    assert!(!home.join("sessions").join(KEY).join("device-work").exists());
    wait_recorded(&hub, &id).await;
    let actions = String::from_utf8(read_file(&hub, &id, "actions").await).unwrap();
    assert!(
        actions.contains("agent-device screenshot out/1-home.png"),
        "{actions}"
    );
}
