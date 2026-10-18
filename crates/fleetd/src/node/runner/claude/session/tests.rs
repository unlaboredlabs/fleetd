//! The kill ladder against real processes. The fake claude does what made a group kill insufficient: it starts a
//! "tool" child in its own session (so outside claude's process group) that ignores SIGTERM, and it ignores SIGTERM
//! itself. Only the descendant sweep, the SIGKILL step and the subreaper's reaping can end that tree cleanly.
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::model::RuntimeMode;
use nix::sys::signal::{Signal, kill};
use nix::sys::stat::Mode;
use nix::sys::wait::{Id, WaitPidFlag, waitid};
use nix::unistd::{Pid, mkfifo};

use crate::node::runner::claude::ClaudeRunner;
use crate::node::runner::process;
use crate::node::runner::{
    ExitInfo, RunOutcome, Runner, RunnerEvent, SessionCommand, SessionHandle, SessionSpec,
};

const FAKE_CLAUDE: &str = r#"#!/bin/sh
trap '' TERM
setsid sh -c 'trap "" TERM; echo $$ > "$PIDFILE.tmp"; mv "$PIDFILE.tmp" "$PIDFILE"; exec sleep 300' &
while [ ! -s "$PIDFILE" ]; do :; done
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"fake","cwd":"/fake"}'
cat > "$STDIN_LOG"
exec sleep 300
"#;

/// Starts `$TOOL` detached (`setsid`) from a shell that exits at once, so the tool is orphaned to the node while
/// claude still runs, the way an agent's `setsid server &` would be.
const DETACHING_CLAUDE: &str = r#"#!/bin/sh
sh -c 'setsid "$TOOL" &'
while [ ! -s "$PIDFILE" ]; do :; done
echo '{"type":"system","subtype":"init","claude_code_version":"2.1.302","model":"fake","cwd":"/fake"}'
cat > "$STDIN_LOG"
"#;

/// Waits until it has been reparented to the node, says so, then exits on its own once the test writes to `$FIFO`.
const DETACHED_TOOL: &str = r#"#!/bin/sh
while [ "$(cut -d' ' -f4 /proc/$$/stat)" != "$NODE_PID" ]; do :; done
echo $$ > "$PIDFILE.tmp"; mv "$PIDFILE.tmp" "$PIDFILE"
read line < "$FIFO"
"#;

struct Fake {
    dir: tempfile::TempDir,
    handle: SessionHandle,
}

impl Fake {
    async fn start(session: &str, script: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let executable = |name: &str, text: &str| {
            let file = dir.path().join(name);
            std::fs::write(&file, text).unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            file
        };
        let binary = executable("claude", script);
        let tool = executable("tool", DETACHED_TOOL);
        mkfifo(&dir.path().join("fifo"), Mode::S_IRWXU).unwrap();
        let path = |name: &str| dir.path().join(name).display().to_string();
        let mut runner = ClaudeRunner::new(binary);
        runner.classify = Arc::new(|_| None);
        let spec = SessionSpec {
            session_id: session.into(),
            resume: false,
            cwd: dir.path().to_owned(),
            add_dirs: Vec::new(),
            model: "fake".into(),
            effort: Effort::Low,
            runtime_mode: RuntimeMode::FullAccess,
            allowed_tools: Vec::new(),
            disallowed_tools: Vec::new(),
            mcp_config: None,
            settings: None,
            env: vec![
                ("PATH".into(), std::env::var("PATH").unwrap()),
                ("CLAUDE_CONFIG_DIR".into(), path("config")),
                ("PIDFILE".into(), path("tool.pid")),
                ("STDIN_LOG".into(), path("stdin.log")),
                ("TOOL".into(), tool.display().to_string()),
                ("FIFO".into(), path("fifo")),
                ("NODE_PID".into(), std::process::id().to_string()),
            ],
            transcript: Some(dir.path().join("transcript.jsonl")),
        };
        let mut handle = spawn_retrying(&runner, spec);
        // Init comes once the escaping child exists, so nothing below races its start.
        match handle.events.recv().await {
            Some(RunnerEvent::Init { model, .. }) => assert_eq!(model, "fake"),
            other => panic!("expected init, got {other:?}"),
        }
        Self { dir, handle }
    }

    fn tool_pid(&self) -> i32 {
        std::fs::read_to_string(self.dir.path().join("tool.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    /// Every event up to and including the exit.
    async fn until_exit(&mut self) -> (Vec<RunnerEvent>, ExitInfo) {
        let mut events = Vec::new();
        while let Some(event) = self.handle.events.recv().await {
            if let RunnerEvent::Exited(exit) = event {
                return (events, exit);
            }
            events.push(event);
        }
        panic!("events ended without an exit: {events:?}");
    }
}

/// A failing test must not leak its tree: claude dies with the runtime (kill_on_drop), its tool by its recorded pid.
impl Drop for Fake {
    fn drop(&mut self) {
        let pidfile = self.dir.path().join("tool.pid");
        let Some(pid) = std::fs::read_to_string(&pidfile)
            .ok()
            .and_then(|p| p.trim().parse().ok())
        else {
            return;
        };
        // Only while it is still this fake's tool (its env names this test's own temp dir), never a reused pid.
        let ours = format!("PIDFILE={}", pidfile.display());
        let env = std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default();
        if env.split(|b| *b == 0).any(|var| var == ours.as_bytes()) {
            let _ = kill(Pid::from_raw(pid), Signal::SIGKILL);
        }
    }
}

/// Spawns, retrying ETXTBSY: a test that forks while another has just written its script holds the script's write
/// fd until that child execs, and exec of a file open for writing fails. A test-harness race, not the runner's.
fn spawn_retrying(runner: &ClaudeRunner, spec: SessionSpec) -> SessionHandle {
    for _ in 0..1000 {
        match runner.spawn(spec.clone()) {
            Err(e) if e.to_string().contains("Text file busy") => std::thread::yield_now(),
            other => return other.unwrap(),
        }
    }
    panic!("the fake claude stayed busy");
}

/// A handle to nothing, to move the real one out of a [`Fake`].
fn detached() -> SessionHandle {
    let (commands, _) = tokio::sync::mpsc::channel(1);
    let (_, events) = tokio::sync::mpsc::channel(1);
    SessionHandle {
        pid: 0,
        commands,
        events,
    }
}

/// Gone entirely: killed and reaped, not left as a zombie.
fn gone(pid: i32) -> bool {
    !Path::new(&format!("/proc/{pid}")).exists()
}

/// Running (not a zombie).
fn alive(pid: i32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .is_ok_and(|stat| process::parse_stat(pid, &stat).is_some_and(|p| !p.zombie))
}

#[tokio::test]
async fn a_tool_that_detaches_and_exits_on_its_own_does_not_linger() {
    let mut fake = Fake::start("00000000-0000-4000-8000-0000000000a3", DETACHING_CLAUDE).await;
    // The tool wrote its pid only once it was the node's child.
    let tool = fake.tool_pid();
    let fifo = fake.dir.path().join("fifo");
    tokio::task::spawn_blocking(move || {
        std::fs::write(&fifo, "go\n").unwrap();
        // Returns once it has exited, without reaping it; ECHILD if the node's reaper already did.
        let _ = waitid(
            Id::Pid(Pid::from_raw(tool)),
            WaitPidFlag::WEXITED | WaitPidFlag::WNOWAIT,
        );
    })
    .await
    .unwrap();
    // What the reaper runs on SIGCHLD, run here so the test needn't wait for it.
    process::reap_adopted();
    assert!(gone(tool), "the detached tool {tool} lingers as a zombie");

    let grace = Duration::from_secs(10);
    fake.handle
        .commands
        .send(SessionCommand::Shutdown { grace })
        .await
        .unwrap();
    let (_, exit) = fake.until_exit().await;
    assert_eq!(exit.code, Some(0));
}

#[tokio::test(start_paused = true)]
async fn nobody_reading_the_events_ends_the_session_and_its_tree() {
    let mut fake = Fake::start("00000000-0000-4000-8000-0000000000a4", FAKE_CLAUDE).await;
    let tool = fake.tool_pid();
    let SessionHandle {
        commands, events, ..
    } = std::mem::replace(&mut fake.handle, detached());
    drop(events);
    // The session task drops its command receiver last, after the kill and the reaping.
    commands.closed().await;
    assert!(gone(tool), "the tool child {tool} survived");
}

#[tokio::test(start_paused = true)]
async fn two_spawns_of_one_session_never_sweep_each_other() {
    let session = "00000000-0000-4000-8000-0000000000a5";
    let mut old = Fake::start(session, FAKE_CLAUDE).await;
    let mut new = Fake::start(session, FAKE_CLAUDE).await;
    let (old_tool, new_tool) = (old.tool_pid(), new.tool_pid());
    kill(Pid::from_raw(old.handle.pid as i32), Signal::SIGKILL).unwrap();
    old.until_exit().await;
    assert!(gone(old_tool));
    assert!(
        alive(new_tool),
        "the old spawn's sweep killed the new spawn's tool"
    );

    let grace = Duration::ZERO;
    new.handle
        .commands
        .send(SessionCommand::Shutdown { grace })
        .await
        .unwrap();
    new.until_exit().await;
    assert!(gone(new_tool));
}

/// Paused time: the grace periods elapse as soon as everything else is idle, so the ladder runs without waiting.
#[tokio::test(start_paused = true)]
async fn shutdown_interrupts_the_run_then_escalates_to_sigkill_and_takes_escaped_children_along() {
    let mut fake = Fake::start("00000000-0000-4000-8000-0000000000a1", FAKE_CLAUDE).await;
    let tool = fake.tool_pid();
    let run_id = "00000000-0000-4000-8000-0000000000r1".to_owned();
    let send = SessionCommand::Send {
        run_id: run_id.clone(),
        text: "Run `sleep 300`.".into(),
        mode: fleetd_contracts::sessions::SendMode::Plain,
    };
    fake.handle.commands.send(send).await.unwrap();
    let shutdown = SessionCommand::Shutdown {
        grace: Duration::from_secs(1),
    };
    fake.handle.commands.send(shutdown).await.unwrap();

    let (events, exit) = fake.until_exit().await;
    // SIGTERM is ignored by both, so only the SIGKILL step ends them.
    assert_eq!((exit.code, exit.signal), (None, Some(9)));
    assert!(
        gone(tool),
        "the escaped tool child {tool} survived its session"
    );
    // The node stopped it: the cut run is interrupted, not failed.
    assert_eq!(
        events,
        vec![RunnerEvent::RunEnded {
            run_id: run_id.clone(),
            outcome: RunOutcome::Interrupted,
            usage: None,
        }]
    );
    // The interrupt went in before stdin closed.
    let stdin = std::fs::read_to_string(fake.dir.path().join("stdin.log")).unwrap();
    let lines: Vec<serde_json::Value> = stdin
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(lines.len(), 2, "{stdin}");
    assert_eq!(lines[0]["uuid"], run_id.as_str());
    assert_eq!(lines[1]["request"]["subtype"], "interrupt");
}

#[tokio::test]
async fn a_crashed_claude_leaves_no_orphan_behind() {
    let mut fake = Fake::start("00000000-0000-4000-8000-0000000000a2", FAKE_CLAUDE).await;
    let tool = fake.tool_pid();
    // A crash: claude dies at once and its tool child, in another session, is orphaned to the node.
    kill(Pid::from_raw(fake.handle.pid as i32), Signal::SIGKILL).unwrap();

    let (events, exit) = fake.until_exit().await;
    assert_eq!(exit.signal, Some(9));
    assert!(events.is_empty(), "{events:?}");
    assert!(gone(tool), "the orphaned tool child {tool} survived");
    // The raw stream is kept in the fixtures' format.
    let transcript = std::fs::read_to_string(fake.dir.path().join("transcript.jsonl")).unwrap();
    let first: serde_json::Value =
        serde_json::from_str(transcript.lines().next().unwrap()).unwrap();
    assert_eq!(
        (first["dir"].as_str(), first["msg"]["subtype"].as_str()),
        (Some("out"), Some("init"))
    );
}

/// The real binary, at no cost: with an empty config dir claude fails at its login check before any API call.
/// Proves the argv parses, a run starts and ends through stdin/stdout, and a second start of the same session resumes
/// it. `FLEETD_CLAUDE_BIN=… cargo test -p fleetd --lib real_claude -- --ignored`
#[tokio::test]
#[ignore = "needs the claude binary"]
async fn real_claude_without_a_login_fails_loudly_at_no_cost() {
    use fleetd_contracts::sessions::FailureClass;

    let bin = std::env::var("FLEETD_CLAUDE_BIN").unwrap_or_else(|_| "claude".into());
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().join("project");
    std::fs::create_dir(&cwd).unwrap();
    let runner = ClaudeRunner::new(bin.into());
    let spec = SessionSpec {
        session_id: "00000000-0000-4000-8000-0000000000b1".into(),
        resume: false,
        cwd: cwd.clone(),
        add_dirs: Vec::new(),
        model: "claude-haiku-5-5".into(),
        effort: Effort::Low,
        runtime_mode: RuntimeMode::ApprovalRequired,
        allowed_tools: vec!["Bash(echo:*)".into()],
        disallowed_tools: Vec::new(),
        mcp_config: None,
        settings: None,
        env: vec![
            ("HOME".into(), dir.path().display().to_string()),
            ("PATH".into(), std::env::var("PATH").unwrap()),
            (
                "CLAUDE_CONFIG_DIR".into(),
                dir.path().join("config").display().to_string(),
            ),
            (
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(),
                "1".into(),
            ),
        ],
        transcript: Some(dir.path().join("transcript.jsonl")),
    };
    for (run, resumed) in [
        ("00000000-0000-4000-8000-0000000000c1", false),
        ("00000000-0000-4000-8000-0000000000c2", true),
    ] {
        let config = dir.path().join("config");
        assert_eq!(
            super::super::session_file(&config, &cwd, &spec.session_id)
                .unwrap()
                .exists(),
            resumed
        );
        let mut handle = runner.spawn(spec.clone()).unwrap();
        let send = SessionCommand::Send {
            run_id: run.into(),
            text: "Reply OK.".into(),
            mode: fleetd_contracts::sessions::SendMode::Plain,
        };
        handle.commands.send(send).await.unwrap();
        let mut events = Vec::new();
        while let Some(event) = handle.events.recv().await {
            let ended = matches!(event, RunnerEvent::RunEnded { .. });
            events.push(event);
            if ended {
                // Idle now: closing stdin is all it takes.
                handle
                    .commands
                    .send(SessionCommand::Shutdown {
                        grace: Duration::from_secs(10),
                    })
                    .await
                    .unwrap();
            }
        }
        let Some(RunnerEvent::Exited(exit)) = events.last() else {
            panic!("{events:?}")
        };
        assert_eq!((exit.code, exit.signal), (Some(1), None), "{events:?}");
        let failure = events.iter().find_map(|e| match e {
            RunnerEvent::RunEnded {
                run_id,
                outcome: RunOutcome::Failed(f),
                ..
            } if run_id == run => Some(f),
            _ => None,
        });
        let failure = failure.unwrap_or_else(|| panic!("{events:?}"));
        assert_eq!(
            failure.class,
            FailureClass::Auth,
            "{}",
            failure.message.as_str()
        );
        assert!(
            failure.message.starts_with("Not logged in"),
            "{}",
            failure.message.as_str()
        );
        assert!(events.iter().any(|e| matches!(e, RunnerEvent::Init { .. })));
    }
}
