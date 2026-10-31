//! A session under the real `fleetd session-host`, started as the node starts one (`ClaudeRunner::spawn` with a host
//! dir): the host is a process of its own, in a session of its own, and claude is its child. This test plays the node:
//! it lets go of the host as a stopping node does, the session runs on, and a second connection (the restarted node)
//! gets each event once.
#![cfg(target_os = "linux")]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::Duration;

use fleetd::node::runner::claude::ClaudeRunner;
use fleetd::node::runner::host::{self, Registration};
use fleetd::node::runner::{Runner, RunnerEvent, SessionCommand, SessionHandle, SessionSpec};
use fleetd_contracts::effort::Effort;
use fleetd_contracts::model::RuntimeMode;

/// Says m1..m3, waits for a line on `$GO`, says m4..m6, then runs until its stdin closes. Whatever claude's arguments.
const TALKING_CLAUDE: &str = r#"#!/bin/sh
init() { echo "{\"type\":\"system\",\"subtype\":\"init\",\"claude_code_version\":\"2.1.302\",\"model\":\"m$1\",\"cwd\":\"/fake\"}"; }
init 1; init 2; init 3
read go < "$GO"
init 4; init 5; init 6
exec cat > /dev/null
"#;

fn spec(dir: &Path) -> SessionSpec {
    SessionSpec {
        session_id: "host-it-1".into(),
        resume: false,
        must_resume: false,
        cwd: dir.to_owned(),
        add_dirs: Vec::new(),
        model: "fake".into(),
        effort: Effort::Low,
        helper_model: "fake".into(),
        runtime_mode: RuntimeMode::FullAccess,
        allowed_tools: Vec::new(),
        allowed_only: false,
        system_prompt: None,
        disallowed_tools: Vec::new(),
        mcp_config: None,
        strict_mcp: false,
        settings: None,
        plugin_dirs: Vec::new(),
        env: vec![
            ("PATH".into(), std::env::var("PATH").unwrap()),
            ("HOME".into(), dir.display().to_string()),
            (
                "CLAUDE_CONFIG_DIR".into(),
                dir.join("config").display().to_string(),
            ),
            ("GO".into(), dir.join("go").display().to_string()),
        ],
        transcript: Some(dir.join("transcript.jsonl")),
        sandbox: None,
        host_dir: Some(dir.join("hosts/s")),
        isolated: false,
    }
}

async fn inits(handle: &mut SessionHandle, n: usize) -> Vec<String> {
    let mut models = Vec::new();
    while models.len() < n {
        let event = tokio::time::timeout(Duration::from_secs(10), handle.events.recv())
            .await
            .expect("an event came")
            .expect("the events go on");
        if let RunnerEvent::Init { model, .. } = event {
            models.push(model);
        }
        handle
            .link
            .as_ref()
            .unwrap()
            .applied
            .fetch_add(1, Ordering::SeqCst);
    }
    models
}

fn stat(pid: u32) -> Option<Vec<String>> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = &stat[stat.rfind(')')? + 2..];
    Some(rest.split(' ').map(str::to_owned).collect())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hosted_session_outlives_its_node_and_each_event_arrives_once() {
    let dir = tempfile::tempdir().unwrap();
    let claude = dir.path().join("claude");
    std::fs::write(&claude, TALKING_CLAUDE).unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    nix::unistd::mkfifo(&dir.path().join("go"), nix::sys::stat::Mode::S_IRWXU).unwrap();
    let mut runner = ClaudeRunner::new(claude);
    runner.host = Some(env!("CARGO_BIN_EXE_fleetd").into());

    let mut first = runner.spawn(spec(dir.path())).unwrap();
    let host_dir = dir.path().join("hosts/s");
    let registration = Registration::read(&host_dir).expect("the host registered");
    assert_ne!(registration.host_pid, std::process::id());
    assert_eq!(registration.pid, first.pid);
    // claude is the host's child, and the host leads a session of its own: nothing of the node's reaches it.
    let host_stat = stat(registration.host_pid).unwrap();
    assert_eq!(
        host_stat[3],
        registration.host_pid.to_string(),
        "{host_stat:?}"
    );
    assert_eq!(
        stat(first.pid).unwrap()[1],
        registration.host_pid.to_string()
    );
    assert!(!registration.marker.is_empty());
    // Where systemd's user manager answers, a scope of its own, which no stop of the node's unit takes down.
    if fleetd::node::runner::scope::current().is_some() {
        let cgroup = |pid: u32| std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
        let host = cgroup(registration.host_pid);
        assert_ne!(host, cgroup(std::process::id()));
        assert!(host.trim_end().ends_with(".scope"), "{host}");
        let unit = host.trim_end().rsplit('/').next().unwrap().to_owned();
        let part_of = std::process::Command::new("systemctl")
            .args(["--user", "show", "-p", "PartOf", "--value", &unit])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&part_of.stdout).trim(),
            "",
            "{unit}"
        );
    }

    let mut seen = inits(&mut first, 3).await;
    first.link.as_ref().unwrap().detach().await;
    drop(first);
    let go = dir.path().join("go");
    tokio::task::spawn_blocking(move || std::fs::write(go, "go\n").unwrap())
        .await
        .unwrap();

    let (mut second, again) = host::connect(&host_dir).unwrap();
    assert_eq!(again.pid, registration.pid, "the same claude");
    seen.extend(inits(&mut second, 3).await);
    assert_eq!(seen, ["m1", "m2", "m3", "m4", "m5", "m6"]);
    let more = tokio::time::timeout(Duration::from_millis(300), second.events.recv()).await;
    assert!(more.is_err(), "nothing twice: {more:?}");

    second
        .commands
        .send(SessionCommand::Shutdown {
            grace: Duration::ZERO,
        })
        .await
        .unwrap();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(15), second.events.recv())
            .await
            .expect("an event came")
            .expect("the events go on until the exit");
        second
            .link
            .as_ref()
            .unwrap()
            .applied
            .fetch_add(1, Ordering::SeqCst);
        if matches!(event, RunnerEvent::Exited(_)) {
            break;
        }
    }
    // The host goes once the exit was taken.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while registration.host_alive() {
        assert!(std::time::Instant::now() < deadline, "the host exited");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(stat(registration.pid).is_none());
    // Its transcript is the host's to write, as the node's was.
    let transcript = std::fs::read_to_string(dir.path().join("transcript.jsonl")).unwrap();
    assert!(transcript.contains("\"model\":\"m6\""));
}

/// A machine removed for good: `fleetd session-host stop-all` (a step of `fleetd machine remove`) ends every session
/// the node left running, mid-turn included, with its host.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_all_ends_the_sessions_a_node_left_running() {
    let dir = tempfile::tempdir().unwrap();
    let claude = dir.path().join("claude");
    std::fs::write(&claude, TALKING_CLAUDE).unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    nix::unistd::mkfifo(&dir.path().join("go"), nix::sys::stat::Mode::S_IRWXU).unwrap();
    let mut runner = ClaudeRunner::new(claude);
    runner.host = Some(env!("CARGO_BIN_EXE_fleetd").into());
    let mut node = runner.spawn(spec(dir.path())).unwrap();
    inits(&mut node, 3).await;
    node.link.as_ref().unwrap().detach().await;
    let registration = Registration::read(&dir.path().join("hosts/s")).unwrap();
    assert!(registration.host_alive());

    let stopped = tokio::process::Command::new(env!("CARGO_BIN_EXE_fleetd"))
        .args(["session-host", "stop-all"])
        .arg(dir.path().join("hosts"))
        .output()
        .await
        .unwrap();
    assert!(stopped.status.success(), "{stopped:?}");
    assert_eq!(
        String::from_utf8_lossy(&stopped.stdout).trim(),
        "stopped 1 agent session(s)"
    );
    assert!(!registration.host_alive());
    assert!(stat(registration.pid).is_none(), "its claude went too");
    assert!(!dir.path().join("hosts/s").exists());
}
