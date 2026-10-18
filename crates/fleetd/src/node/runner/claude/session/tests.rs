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
use nix::unistd::Pid;

use crate::node::runner::claude::ClaudeRunner;
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

struct Fake {
    dir: tempfile::TempDir,
    handle: SessionHandle,
}

impl Fake {
    /// `session` must differ per test: tests run in parallel, and a sweep finds every process marked with it.
    async fn start(session: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("claude");
        std::fs::write(&binary, FAKE_CLAUDE).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = |name: &str| dir.path().join(name).display().to_string();
        let mut runner = ClaudeRunner::new(binary, Vec::new());
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
            env: vec![
                ("PATH".into(), std::env::var("PATH").unwrap()),
                ("CLAUDE_CONFIG_DIR".into(), path("config")),
                ("PIDFILE".into(), path("tool.pid")),
                ("STDIN_LOG".into(), path("stdin.log")),
            ],
            transcript: Some(dir.path().join("transcript.jsonl")),
        };
        let mut handle = runner.spawn(spec).unwrap();
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

/// Gone entirely: killed and reaped, not left as a zombie.
fn gone(pid: i32) -> bool {
    !Path::new(&format!("/proc/{pid}")).exists()
}

/// Paused time: the grace periods elapse as soon as everything else is idle, so the ladder runs without waiting.
#[tokio::test(start_paused = true)]
async fn shutdown_interrupts_the_run_then_escalates_to_sigkill_and_takes_escaped_children_along() {
    let mut fake = Fake::start("00000000-0000-4000-8000-0000000000a1").await;
    let tool = fake.tool_pid();
    let run_id = "00000000-0000-4000-8000-0000000000r1".to_owned();
    let send = SessionCommand::Send {
        run_id: run_id.clone(),
        text: "Run `sleep 300`.".into(),
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
    let mut fake = Fake::start("00000000-0000-4000-8000-0000000000a2").await;
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
    let runner = ClaudeRunner::new(bin.into(), Vec::new());
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
