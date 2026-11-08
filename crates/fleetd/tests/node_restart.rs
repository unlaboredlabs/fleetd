//! A node restart for an update, run on the real binary: `fleetd node run` exits right after its own shutdown (no
//! fixed grace on top, which was most of the node's blackout), and the next one re-adopts the hosted session that ran
//! on meanwhile. The node's hub is unreachable throughout: neither needs it.
#![cfg(target_os = "linux")]
use std::io::{BufRead, BufReader};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use fleetd::node::runner::claude::ClaudeRunner;
use fleetd::node::runner::host::Registration;
use fleetd::node::runner::{Runner, SessionSpec};
use fleetd::node::store::{NodeStore, SessionLocal, SessionRow};
use fleetd_contracts::effort::Effort;
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::sessions::{ProjectInfo, SessionSummary};

/// The fleetd under test: `FLEETD_BIN` when set (another build of it, run side by side by experimental/compare),
/// else this build's own binary.
fn fleetd_bin() -> PathBuf {
    std::env::var_os("FLEETD_BIN").map_or_else(|| env!("CARGO_BIN_EXE_fleetd").into(), Into::into)
}

/// Answers `--version`; as a session, says it started, then runs until its stdin closes.
const CLAUDE: &str = r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.302 (Claude Code)"; exit 0; fi
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"fake","cwd":"/fake","tools":["Bash","Read"]}'
exec cat > /dev/null
"#;

const SESSION: &str = "node-restart-1";

struct Machine {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl Machine {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        for sub in ["user", "bin", "work", "node"] {
            std::fs::create_dir_all(root.join(sub)).unwrap();
        }
        let claude = root.join("bin/claude");
        std::fs::write(&claude, CLAUDE).unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            root.join("node/node.json"),
            r#"{"hub":"http://127.0.0.1:1","machineId":"m-restart","name":"devbox","tags":[],"enrolled":true}"#,
        )
        .unwrap();
        Machine { _dir: dir, root }
    }

    fn home(&self) -> PathBuf {
        self.root.join("node")
    }

    fn path_var(&self) -> String {
        format!(
            "{}:{}",
            self.root.join("bin").display(),
            std::env::var("PATH").unwrap()
        )
    }

    /// A session the node hosts, as a node that stopped left it: its claude running under its host, and its row.
    fn hosted_session(&self) -> Registration {
        let home = self.home();
        let work = self.root.join("work");
        let mut runner = ClaudeRunner::new(self.root.join("bin/claude"));
        runner.host = Some(fleetd_bin());
        let spec = SessionSpec {
            session_id: SESSION.into(),
            resume: false,
            must_resume: false,
            cwd: work.clone(),
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
                ("PATH".into(), self.path_var()),
                ("HOME".into(), self.root.join("user").display().to_string()),
            ],
            host_dir: Some(home.join("hosts").join(SESSION)),
            isolated: false,
        };
        let registration = tokio::runtime::Runtime::new().unwrap().block_on(async {
            let handle = runner.spawn(spec).unwrap();
            handle.link.as_ref().unwrap().detach().await;
            Registration::read(&home.join("hosts").join(SESSION)).expect("the host registered")
        });

        let store = NodeStore::open(&home.join("sessions.sqlite")).unwrap();
        let project: ProjectInfo = serde_json::from_value(serde_json::json!({
            "projectId": "p1",
            "title": "p1",
            "workspaceRoot": work,
            "updatedAt": "2026-11-08T00:00:00Z",
        }))
        .unwrap();
        store.upsert_project(&project).unwrap();
        let summary: SessionSummary = serde_json::from_value(serde_json::json!({
            "sessionId": SESSION,
            "projectId": "p1",
            "title": "restart",
            "status": "idle",
            "model": "claude-haiku-5-5",
            "effort": "low",
            "runtimeMode": "full-access",
            "createdAt": "2026-11-08T00:00:00Z",
            "updatedAt": "2026-11-08T00:00:00Z",
        }))
        .unwrap();
        let local: SessionLocal = serde_json::from_value(serde_json::json!({
            "cwd": work,
            "addDirs": [],
            "configDir": self.root.join("user/.claude"),
            "workspaceRoot": work,
            "started": true,
            "pid": registration.pid,
        }))
        .unwrap();
        store
            .commit(&SessionRow { summary, local }, &[], false)
            .unwrap();
        registration
    }

    /// `fleetd node run` on this machine's home, and its log lines as they come.
    fn node(&self) -> (Child, mpsc::Receiver<String>) {
        let mut child = Command::new(fleetd_bin())
            .args(["node", "run", "--home"])
            .arg(self.home())
            .env("HOME", self.root.join("user"))
            .env("PATH", self.path_var())
            .env("FLEETD_HOME", self.root.join("fleet"))
            .env_remove("FLEETD_LOG")
            .env_remove("CLAUDE_CONFIG_DIR")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let (tx, rx) = mpsc::channel();
        let out = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        (child, rx)
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        let _ = Command::new(fleetd_bin())
            .args(["session-host", "stop-all"])
            .arg(self.home().join("hosts"))
            .output();
    }
}

/// Waits for a log line with each of `words`; panics with the lines read meanwhile if none comes.
fn said(lines: &mpsc::Receiver<String>, words: &[&str]) {
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut seen = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match lines.recv_timeout(left) {
            Ok(line) if words.iter().all(|w| line.contains(w)) => return,
            Ok(line) => seen.push(line),
            Err(_) => break,
        }
    }
    panic!(
        "the node never said {words:?}; it said:\n{}",
        seen.join("\n")
    );
}

/// The node re-adopted the session, then is up: its first try to link (the hub is unreachable) comes after it listens
/// for SIGTERM.
fn up_with_the_session(lines: &mpsc::Receiver<String>) {
    said(lines, &["re-adopted a session", SESSION]);
    said(lines, &["hub link lost"]);
}

fn sigterm(child: &Child) {
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
}

/// Kills the node if an assertion fails while it runs, so no test leaves one behind.
struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// SIGTERMs the node and waits for it to exit: it stops gracefully, in under a second.
fn stop(mut node: Running) {
    let stopping = Instant::now();
    sigterm(&node.0);
    let status = node.0.wait().unwrap();
    let took = stopping.elapsed();
    assert!(status.success(), "{status:?}");
    assert!(
        took < Duration::from_secs(1),
        "the node took {took:?} to exit"
    );
}

#[test]
fn a_node_exits_at_once_on_sigterm_and_its_next_start_re_adopts_the_session() {
    let machine = Machine::new();
    let registration = machine.hosted_session();
    assert!(registration.host_alive());

    let (first, lines) = machine.node();
    let first = Running(first);
    up_with_the_session(&lines);
    stop(first);
    assert!(
        registration.host_alive(),
        "the session ran on without its node"
    );

    let (second, lines) = machine.node();
    let second = Running(second);
    up_with_the_session(&lines);
    stop(second);
    assert!(registration.host_alive());
}
