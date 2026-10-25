//! The session service over the fake runner, driven by `session_call` frames and read back from the frames it sends.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::ids::{ProjectId, ThreadId};
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::sessions::{
    FailureClass, ItemKind, ItemStatus, MachineEvent, MessageRole, PermissionDecision, RunEnd,
    RunFailure, RunStatus, SendMode, SendNow, SessionCall, SessionCallFrame, SessionErrorCode,
    SessionLaunch, SessionOutput, SessionResult, SessionStatus, SessionSummary, SessionWorkspace,
    ThreadEvent, WorktreeSource,
};
use fleetd_contracts::steer::{DeliveredHow, SteerId, SteerReceipt, SteerStage, SteerTag};
use tokio::sync::mpsc;

use super::fake::FakeRunner;
use super::{
    Attached, SessionConfig, SessionService, compile_cache_env, mcp_config, parse_env_file,
};
use crate::node::runner::SessionCommand;
use crate::node::runner::claude::ALWAYS_DISALLOWED;
use crate::node::runner::failure::RETRY_MESSAGE;
use crate::node::store::NodeStore;
use crate::node::wire::NodeToHub;
use crate::node::worktree::tests::{cloned, repo, run as git};

struct Hub {
    service: SessionService,
    runner: Arc<FakeRunner>,
    rx: mpsc::UnboundedReceiver<String>,
    _attached: Attached,
}

fn config(dir: &Path) -> SessionConfig {
    SessionConfig {
        home: dir.join("node"),
        config_dir: None,
        claude_env: dir.join("claude.env"),
        base_env: vec![("HOME".into(), dir.to_string_lossy().into_owned())],
        idle_reap: Duration::from_secs(600),
        retry_schedule_ms: vec![1000],
    }
}

async fn hub(dir: &Path, store: NodeStore, runner: FakeRunner) -> Hub {
    hub_with(store, runner, config(dir)).await
}

async fn hub_with(store: NodeStore, runner: FakeRunner, config: SessionConfig) -> Hub {
    let runner = Arc::new(runner);
    let service = SessionService::start(store, runner.clone(), config)
        .await
        .unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    let attached = service.attach(tx);
    let hub = Hub {
        service,
        runner,
        rx,
        _attached: attached,
    };
    hub.ok(SessionCall::Subscribe {
        after: None,
        spans_after: None,
    })
    .await;
    hub
}

fn launch(id: &str, mode: RuntimeMode, workspace: SessionWorkspace) -> SessionCall {
    SessionCall::Launch(SessionLaunch {
        session_id: ThreadId::unchecked(id),
        project_id: ProjectId::unchecked("p1"),
        title: None,
        runner: Default::default(),
        model: NonEmpty::unchecked("claude-haiku-5-5"),
        effort: Effort::Low,
        runtime_mode: mode,
        workspace,
        prompt: NonEmpty::unchecked("Reply with the word OK and nothing else."),
        run_id: NonEmpty::unchecked("r1"),
        allowed_tools: vec!["Bash(npm test:*)".into()],
        disallowed_tools: vec!["WebFetch".into()],
        role: fleetd_contracts::sessions::SessionRole::Worker,
    })
}

fn send(id: &str, run_id: &str) -> SessionCall {
    SessionCall::Send {
        session_id: ThreadId::unchecked(id),
        run_id: NonEmpty::unchecked(run_id),
        text: NonEmpty::unchecked("Reply with the word TWO and nothing else."),
        mode: SendMode::Plain,
        steer: None,
    }
}

impl Hub {
    async fn call(&self, call: SessionCall) -> SessionResult {
        let frame = SessionCallFrame {
            id: NonEmpty::unchecked("c1"),
            call,
        };
        self.service.handle(frame).await.result
    }

    async fn ok(&self, call: SessionCall) -> SessionOutput {
        match self.call(call).await {
            SessionResult::Ok(output) => output,
            SessionResult::Err(e) => panic!("call failed: {e:?}"),
        }
    }

    async fn project(&self, root: &Path) {
        self.ok(SessionCall::ProjectUpsert {
            project_id: ProjectId::unchecked("p1"),
            title: NonEmpty::unchecked("p1"),
            workspace_root: NonEmpty::unchecked(root.to_string_lossy()),
        })
        .await;
    }

    /// The next sent frame `f` picks, skipping the others. The timeout only turns a hang into a failure.
    async fn until<T>(&mut self, mut f: impl FnMut(NodeToHub) -> Option<T>) -> T {
        tokio::time::timeout(Duration::from_secs(600), async {
            loop {
                let raw = self.rx.recv().await.expect("outlet closed");
                if let Some(found) = f(serde_json::from_str(&raw).unwrap()) {
                    return found;
                }
            }
        })
        .await
        .expect("frame never came")
    }

    async fn summary(&mut self, pred: impl Fn(&SessionSummary) -> bool) -> SessionSummary {
        self.until(|frame| match frame {
            NodeToHub::MachineEvent(f) => match f.event {
                MachineEvent::SessionUpdated(s) if pred(&s) => Some(s),
                _ => None,
            },
            _ => None,
        })
        .await
    }

    async fn settled(&mut self, run_id: &str) -> SessionSummary {
        self.summary(|s| {
            s.active_run_id.is_none() && s.latest_run.as_ref().is_some_and(|r| r.id == run_id)
        })
        .await
    }
}

#[test]
fn claude_env_lines_parse_like_a_shell_would_read_them() {
    let text = "# gateway\nexport ANTHROPIC_BASE_URL=\"http://127.0.0.1:8317\"\n\nANTHROPIC_AUTH_TOKEN='a=b'\nnot a pair\n";
    assert_eq!(
        parse_env_file(text),
        [
            (
                "ANTHROPIC_BASE_URL".to_owned(),
                "http://127.0.0.1:8317".to_owned()
            ),
            ("ANTHROPIC_AUTH_TOKEN".to_owned(), "a=b".to_owned()),
        ]
    );
}

#[test]
fn a_sessions_env_has_no_ssh_agent_even_when_the_node_has_one() {
    let node: std::collections::HashMap<&str, &str> = [
        ("HOME", "/home/me"),
        ("PATH", "/usr/bin"),
        ("GIT_AUTHOR_EMAIL", "me@example.com"),
        ("SSH_AUTH_SOCK", "/run/user/1000/ssh-agent.sock"),
        ("SSH_AGENT_PID", "4242"),
        ("GIT_SSH_COMMAND", "ssh -i ~/.ssh/deploy"),
        ("GIT_SSH", "/usr/bin/ssh"),
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
    ]
    .into();
    let env = super::session_env(|key| node.get(key).map(|v| (*v).to_owned()));
    let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["HOME", "PATH", "GIT_AUTHOR_EMAIL"]);
    let config = SessionConfig::for_node(Path::new("/nonexistent-node-home"));
    assert!(
        !config
            .base_env
            .iter()
            .any(|(k, _)| k.starts_with("SSH_") || k.starts_with("GIT_SSH")),
        "{:?}",
        config.base_env
    );
}

#[test]
fn sessions_share_one_compile_cache_when_sccache_is_installed() {
    let dir = tempfile::tempdir().unwrap();
    let path = |p: &std::path::Path| ("PATH".to_owned(), p.to_string_lossy().into_owned());
    assert!(compile_cache_env(&[path(dir.path())]).is_empty());
    std::fs::write(dir.path().join("sccache"), "").unwrap();
    let env = compile_cache_env(&[path(dir.path())]);
    assert_eq!(
        env[0],
        (
            "RUSTC_WRAPPER".to_owned(),
            dir.path().join("sccache").to_string_lossy().into_owned()
        )
    );
    let own = ("RUSTC_WRAPPER".to_owned(), "/opt/wrap".to_owned());
    assert!(
        compile_cache_env(&[path(dir.path()), own]).is_empty(),
        "a wrapper from claude.env wins"
    );
}

#[tokio::test]
async fn a_launch_runs_its_turn_streams_it_and_later_sends_continue_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("policy.yaml"), "tools: {}\n").unwrap();
    std::fs::write(
        dir.path().join("claude.env"),
        "ANTHROPIC_AUTH_TOKEN=tok\nDISABLE_AUTOUPDATER=0\n",
    )
    .unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    // Before any project: launch has nowhere to run.
    let missing = hub
        .call(launch(
            "s1",
            RuntimeMode::FullAccess,
            SessionWorkspace::Root,
        ))
        .await;
    assert!(matches!(missing, SessionResult::Err(e) if e.code == SessionErrorCode::NotFound));
    hub.project(&root).await;

    let SessionOutput::Launched { summary, .. } = hub
        .ok(launch(
            "s1",
            RuntimeMode::FullAccess,
            SessionWorkspace::Root,
        ))
        .await
    else {
        panic!("not launched")
    };
    assert_eq!(summary.session_id, "s1");
    let done = hub.settled("r1").await;
    assert_eq!(done.status, SessionStatus::Idle);
    assert_eq!(done.latest_run.unwrap().status, RunStatus::Completed);
    assert_eq!(done.latest_assistant_tail.as_deref(), Some("OK"));

    let spec = &hub.runner.spawned()[0];
    assert!(!spec.resume, "a first start uses --session-id");
    assert_eq!(spec.cwd, root);
    // A task's session gets fleetd's agent MCP server with the worker's tools, naming the session.
    let mcp: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(spec.mcp_config.as_ref().unwrap()).unwrap())
            .unwrap();
    assert_eq!(
        mcp["mcpServers"]["fleetd"]["args"],
        serde_json::json!(["agent-mcp", "--role", "worker"])
    );
    assert_eq!(mcp["mcpServers"]["fleetd"]["env"]["FLEETD_THREAD_ID"], "s1");
    for tool in ALWAYS_DISALLOWED {
        assert!(spec.disallowed_tools.iter().any(|t| t == tool));
    }
    // claude.env is read, but fleetd's own values come last and win.
    let last = |key: &str| {
        spec.env
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(last("ANTHROPIC_AUTH_TOKEN"), Some("tok"));
    // The user's own claude setup: no config dir of fleetd's, so claude reads $HOME/.claude.
    assert_eq!(last("CLAUDE_CONFIG_DIR"), None);
    assert_eq!(
        hub.service.session("s1").unwrap().local.config_dir,
        dir.path().join(".claude")
    );
    // fleetd's overlay rides on top of the user's settings, and its tools stay denied whatever they allow.
    let overlay: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(spec.settings.as_ref().unwrap()).unwrap())
            .unwrap();
    assert_eq!(overlay["env"]["DISABLE_AUTOUPDATER"], "1");
    assert_eq!(overlay["permissions"]["deny"][0], "Task");
    // Claude's own subagents are off by the knobs that work, and agent teams stay off whatever the user set.
    for (key, value) in crate::node::runner::claude::SUBAGENTS_OFF_ENV {
        assert_eq!(overlay["env"][key], *value, "{key}");
    }
    assert_eq!(overlay["env"]["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"], "");
    assert_eq!(last("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"), None);
    assert_eq!(last("FLEETD_THREAD_ID"), Some("s1"));
    assert_eq!(last("FLEETD_PROJECT_ID"), Some("p1"));
    assert_eq!(last("DISABLE_AUTOUPDATER"), Some("1"));
    assert_eq!(last("CLAUDE_CODE_STARTUP_FAILURE_RESULTS"), Some("1"));
    // Claude's auto memory is off by both knobs.
    assert_eq!(overlay["autoMemoryEnabled"], false);
    assert_eq!(overlay["env"]["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1");
    assert_eq!(last("CLAUDE_CODE_DISABLE_AUTO_MEMORY"), Some("1"));
    // Tool search by default, and a task's agent on the 5-minute prompt cache, in its settings too.
    for (key, value) in crate::node::runner::claude::DEFAULT_ENV {
        assert_eq!(last(key), Some(*value), "{key}");
    }
    for key in crate::node::runner::claude::PROMPT_CACHE_TTL_VARS {
        assert_eq!(last(key), Some("5m"), "{key}");
        assert_eq!(overlay["env"][key], "5m", "{key}");
    }

    // A retried launch returns the same session without a second process.
    let again = hub
        .ok(launch(
            "s1",
            RuntimeMode::FullAccess,
            SessionWorkspace::Root,
        ))
        .await;
    assert!(
        matches!(again, SessionOutput::Launched { summary, .. } if summary.latest_run.as_ref().unwrap().id == "r1")
    );
    assert_eq!(hub.runner.spawned().len(), 1);

    hub.ok(SessionCall::Follow {
        session_id: ThreadId::unchecked("s1"),
    })
    .await;
    let snapshot = hub
        .until(|f| match f {
            NodeToHub::ThreadEvent(t) => match t.event {
                ThreadEvent::Snapshot(s) => Some(s),
                _ => None,
            },
            _ => None,
        })
        .await;
    let roles: Vec<_> = snapshot
        .messages
        .iter()
        .map(|m| (m.role, brief(&m.text)))
        .collect();
    assert_eq!(
        roles,
        [
            (
                MessageRole::User,
                "Reply with the word OK and nothing else."
            ),
            (MessageRole::Assistant, "OK")
        ]
    );

    let accepted = hub.ok(send("s1", "r2")).await;
    assert!(matches!(accepted, SessionOutput::Sent(s) if !s.queued));
    let reply = hub
        .until(|f| match f {
            NodeToHub::ThreadEvent(t) => match t.event {
                ThreadEvent::Message(m) if m.role == MessageRole::Assistant => Some(m),
                _ => None,
            },
            _ => None,
        })
        .await;
    assert_eq!(
        (reply.text.as_str(), reply.run_id.as_deref()),
        ("TWO", Some("r2"))
    );
    hub.settled("r2").await;
    // Same process, and a repeated send is the same run.
    assert_eq!(hub.runner.spawned().len(), 1);
    hub.ok(send("s1", "r2")).await;
    assert_eq!(hub.service.store().runs("s1").unwrap().len(), 2);

    let read = |path: &str| SessionCall::ReadFile {
        project_id: ProjectId::unchecked("p1"),
        path: NonEmpty::unchecked(path),
    };
    assert!(
        matches!(hub.ok(read("policy.yaml")).await, SessionOutput::File { contents: Some(c) } if c == "tools: {}\n")
    );
    assert!(matches!(
        hub.ok(read("nope.yaml")).await,
        SessionOutput::File { contents: None }
    ));
    assert!(
        matches!(hub.call(read("../claude.env")).await, SessionResult::Err(e) if e.code == SessionErrorCode::Invalid)
    );
    let unknown = hub.call(send("nope", "r1")).await;
    assert!(matches!(unknown, SessionResult::Err(e) if e.code == SessionErrorCode::NotFound));
}

#[tokio::test]
async fn a_prompt_waits_for_the_hub_unless_policy_answers_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("permission-allow"),
    )
    .await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::ApprovalRequired,
        SessionWorkspace::Root,
    ))
    .await;
    let waiting = hub.summary(|s| s.status == SessionStatus::Waiting).await;
    let pending = waiting.pending_permission.unwrap();
    assert_eq!(pending.tool_name, "Bash");
    assert_eq!(pending.summary.as_str(), "touch perm-test.txt");
    assert_eq!(waiting.latest_run.unwrap().status, RunStatus::Waiting);

    let answer = |request_id: &str| SessionCall::Answer {
        session_id: ThreadId::unchecked("s1"),
        request_id: NonEmpty::unchecked(request_id),
        by: None,
        decision: PermissionDecision::Allow {
            updated_input: None,
        },
    };
    assert!(
        matches!(hub.call(answer("other")).await, SessionResult::Err(e) if e.code == SessionErrorCode::NotFound)
    );
    hub.ok(answer(&pending.request_id)).await;
    let done = hub.settled("r1").await;
    assert_eq!(done.latest_assistant_tail.as_deref(), Some("DONE"));
    let item = hub
        .service
        .store()
        .item("s1", &format!("permission-{}", pending.request_id))
        .unwrap()
        .unwrap();
    assert!(matches!(
        item.kind,
        ItemKind::Permission {
            decision: Some(PermissionDecision::Allow { .. }),
            ..
        }
    ));

    // Full access: answered by the node, nobody is asked.
    hub.ok(launch(
        "s2",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    let done = hub.settled("r1").await;
    assert_eq!(done.session_id, "s2");
    let answers = hub
        .runner
        .received()
        .into_iter()
        .filter(|c| matches!(c, SessionCommand::Answer { .. }))
        .count();
    assert_eq!(answers, 2);
}

#[tokio::test]
async fn a_restarted_node_closes_what_was_running_and_the_next_send_resumes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("sessions.sqlite");
    let mut before = hub(
        dir.path(),
        NodeStore::open(&db).unwrap(),
        FakeRunner::fixture("permission-allow"),
    )
    .await;
    before.project(dir.path()).await;
    before
        .ok(launch(
            "s1",
            RuntimeMode::ApprovalRequired,
            SessionWorkspace::Root,
        ))
        .await;
    let pending = before
        .summary(|s| s.status == SessionStatus::Waiting)
        .await
        .pending_permission
        .unwrap();

    // The previous node's claude, still running: a real process standing in for it.
    let mut orphan = tokio::process::Command::new("sleep")
        .arg("30")
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let store = NodeStore::open(&db).unwrap();
    let mut row = store.session("s1").unwrap().unwrap();
    row.local.pid = orphan.id();
    row.local.pid_start = super::proc::start_time(orphan.id().unwrap());
    store.commit(&row, &[], false).unwrap();

    let mut after = hub(
        dir.path(),
        store,
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    let status = orphan.wait().await.unwrap();
    assert_eq!(
        std::os::unix::process::ExitStatusExt::signal(&status),
        Some(15)
    );
    let row = after.service.store().session("s1").unwrap().unwrap();
    assert_eq!(row.summary.status, SessionStatus::Interrupted);
    assert_eq!(row.summary.pending_permission, None);
    assert_eq!(row.local.pid, None);
    let run = row.summary.latest_run.unwrap();
    assert_eq!(run.status, RunStatus::Interrupted);
    assert_eq!(run.end, Some(RunEnd::NodeRestarted));
    assert_eq!(
        run.failure.unwrap().message.as_str(),
        "node restarted mid-run"
    );
    let prompt = after
        .service
        .store()
        .item("s1", &format!("permission-{}", pending.request_id))
        .unwrap()
        .unwrap();
    assert_eq!(prompt.status, ItemStatus::Cancelled);

    // The node never re-sends on its own; the hub's send resumes the claude session in place.
    assert!(after.runner.spawned().is_empty());
    after.ok(send("s1", "r2")).await;
    let done = after.settled("r2").await;
    assert_eq!(done.status, SessionStatus::Idle);
    let spec = &after.runner.spawned()[0];
    assert!(spec.resume);
    assert_eq!(spec.cwd, dir.path());
}

#[tokio::test(start_paused = true)]
async fn an_unhonoured_interrupt_escalates_to_stopping_the_process() {
    let dir = tempfile::tempdir().unwrap();
    let mut runner = FakeRunner::fixture("permission-allow");
    runner.honour_interrupt = false;
    let mut hub = hub(dir.path(), NodeStore::open_memory(10_000).unwrap(), runner).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::ApprovalRequired,
        SessionWorkspace::Root,
    ))
    .await;
    hub.summary(|s| s.status == SessionStatus::Waiting).await;

    // Only the active run is interrupted.
    hub.ok(SessionCall::Interrupt {
        session_id: ThreadId::unchecked("s1"),
        run_id: Some(NonEmpty::unchecked("r0")),
        reason: None,
    })
    .await;
    hub.ok(SessionCall::Interrupt {
        session_id: ThreadId::unchecked("s1"),
        run_id: None,
        reason: Some("hub asked".into()),
    })
    .await;
    let ended = hub.settled("r1").await;
    assert_eq!(ended.status, SessionStatus::Interrupted);
    assert_eq!(ended.pending_permission, None);
    let run = ended.latest_run.unwrap();
    assert_eq!(run.status, RunStatus::Interrupted);
    assert_eq!(run.end, Some(RunEnd::Requested));
    assert_eq!(run.ended_by.as_ref().unwrap().as_str(), "hub asked");
    assert_eq!(run.failure.unwrap().message.as_str(), "hub asked");
    let received = hub.runner.received();
    assert_eq!(
        received
            .iter()
            .filter(|c| matches!(c, SessionCommand::Interrupt))
            .count(),
        1
    );
    assert!(matches!(received.last(), Some(SessionCommand::Shutdown { grace }) if grace.is_zero()));

    hub.ok(send("s1", "r2")).await;
    assert!(hub.runner.spawned()[1].resume);
}

#[tokio::test(start_paused = true)]
async fn a_retryable_failure_continues_the_same_run_then_fails_loudly() {
    let dir = tempfile::tempdir().unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("overloaded-529"),
    )
    .await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    let failed = hub.settled("r1").await;
    assert_eq!(failed.status, SessionStatus::Failed);
    let run = failed.latest_run.unwrap();
    assert_eq!(run.end, Some(RunEnd::Failed));
    let failure = run.failure.unwrap();
    assert_eq!(
        (failure.class, failure.retries, failure.api_status),
        (FailureClass::Overloaded, 1, Some(529))
    );
    assert!(failure.message.as_str().contains("529 Overloaded"));

    // One run, two messages to claude: the retry went under its own uuid and mapped back to r1.
    assert_eq!(hub.service.store().runs("s1").unwrap().len(), 1);
    let sends: Vec<_> = hub
        .runner
        .received()
        .into_iter()
        .filter_map(|c| match c {
            SessionCommand::Send { run_id, text, .. } => Some((run_id, text)),
            _ => None,
        })
        .collect();
    assert_eq!(sends.len(), 2);
    assert_ne!(sends[1].0, "r1");
    assert_eq!(sends[1].1, RETRY_MESSAGE);
    let retry = hub
        .service
        .store()
        .item("s1", "node-retry-r1-1")
        .unwrap()
        .unwrap();
    assert!(matches!(
        retry.kind,
        ItemKind::NodeRetry {
            attempt: 1,
            of: 1,
            delay_ms: 1000,
            reason: RunFailure {
                class: FailureClass::Overloaded,
                api_status: Some(529),
                ..
            },
        }
    ));
}

#[tokio::test(start_paused = true)]
async fn an_interrupt_during_a_retry_wait_ends_the_run_for_good() {
    let dir = tempfile::tempdir().unwrap();
    let config = SessionConfig {
        retry_schedule_ms: vec![60_000],
        ..config(dir.path())
    };
    let store = NodeStore::open_memory(10_000).unwrap();
    let mut hub = hub_with(store, FakeRunner::fixture("overloaded-529"), config).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    // The 529 came back and the node waits a minute to retry; claude sits idle and ignores the interrupt.
    tokio::time::sleep(Duration::from_secs(1)).await;
    hub.ok(SessionCall::Interrupt {
        session_id: ThreadId::unchecked("s1"),
        run_id: None,
        reason: Some("hub asked".into()),
    })
    .await;
    let ended = hub.settled("r1").await;
    assert_eq!(ended.latest_run.unwrap().status, RunStatus::Interrupted);
    // Past the retry's time: nothing resumes it.
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(hub.runner.spawned().len(), 1);
    assert!(
        !hub.runner
            .received()
            .iter()
            .any(|c| matches!(c, SessionCommand::Send { text, .. } if text == RETRY_MESSAGE))
    );
    let runs = hub.service.store().runs("s1").unwrap();
    assert_eq!(runs[0].status, RunStatus::Interrupted);
    assert_eq!(*hub.service.running().borrow(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_session_whose_init_offers_an_agent_tool_stops_and_later_ones_deny_it() {
    // A claude with an agent tool fleetd's deny list doesn't name yet; the first turn would run for a minute.
    let lines = r#"
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"u1"}}
{"dir":"out","ms":0,"msg":{"type":"command_lifecycle","command_uuid":"u1","state":"started"}}
{"dir":"out","ms":0,"msg":{"type":"system","subtype":"init","tools":["Bash","Task","SwarmSpawn"]}}
{"dir":"out","ms":60000,"msg":{"type":"result","subtype":"success","is_error":false,"result":"too late"}}
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"u2"}}
{"dir":"out","ms":0,"msg":{"type":"command_lifecycle","command_uuid":"u2","state":"started"}}
{"dir":"out","ms":0,"msg":{"type":"system","subtype":"init","tools":["Bash","Task","SwarmSpawn"]}}
{"dir":"out","ms":5,"msg":{"type":"result","subtype":"success","is_error":false,"result":"done"}}
"#;
    let dir = tempfile::tempdir().unwrap();
    let mut runner = FakeRunner::from_lines(lines);
    runner.timed = true;
    let mut hub = hub(dir.path(), NodeStore::open_memory(10_000).unwrap(), runner).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    let stopped = hub.settled("r1").await;
    assert_eq!(stopped.latest_run.unwrap().status, RunStatus::Interrupted);
    let said = hub
        .service
        .store()
        .item("s1", "agent-tools-r1")
        .unwrap()
        .unwrap();
    let ItemKind::Error { failure } = said.kind else {
        panic!("{said:?}")
    };
    assert!(
        failure.message.as_str().contains("(SwarmSpawn)"),
        "{failure:?}"
    );
    assert!(
        hub.runner
            .received()
            .iter()
            .any(|c| matches!(c, SessionCommand::Shutdown { grace } if grace.is_zero()))
    );

    // The next start denies it, so its init offers none and the run completes.
    hub.ok(send("s1", "r2")).await;
    let done = hub.settled("r2").await;
    assert_eq!(done.latest_run.unwrap().status, RunStatus::Completed);
    let spawned = hub.runner.spawned();
    assert_eq!(spawned.len(), 2);
    assert!(
        !spawned[0]
            .disallowed_tools
            .iter()
            .any(|t| t == "SwarmSpawn")
    );
    assert!(
        spawned[1]
            .disallowed_tools
            .iter()
            .any(|t| t == "SwarmSpawn")
    );
    assert_eq!(
        hub.service.store().item("s1", "agent-tools-r2").unwrap(),
        None
    );
}

#[tokio::test(start_paused = true)]
async fn a_run_silent_since_the_machine_woke_is_resumed_as_a_network_retry() {
    // The first turn's stream never comes back (its result is hours away); the retry's turn completes.
    let lines = r#"
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"u1"}}
{"dir":"out","ms":0,"msg":{"type":"command_lifecycle","command_uuid":"u1","state":"started"}}
{"dir":"out","ms":7200000,"msg":{"type":"result","subtype":"success","is_error":false,"result":"too late"}}
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"u2"}}
{"dir":"out","ms":0,"msg":{"type":"command_lifecycle","command_uuid":"u2","state":"started"}}
{"dir":"out","ms":5,"msg":{"type":"result","subtype":"success","is_error":false,"result":"done"}}
"#;
    let dir = tempfile::tempdir().unwrap();
    let mut runner = FakeRunner::from_lines(lines);
    runner.timed = true;
    let mut hub = hub(dir.path(), NodeStore::open_memory(10_000).unwrap(), runner).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    hub.summary(|s| s.status == SessionStatus::Running).await;
    assert_eq!(*hub.service.running().borrow(), 1);

    // The machine slept a while after claude's last word.
    tokio::time::sleep(Duration::from_secs(1)).await;
    hub.service.woke();
    let done = hub.settled("r1").await;
    let run = done.latest_run.unwrap();
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.end, Some(RunEnd::Completed));
    assert_eq!(hub.service.store().runs("s1").unwrap().len(), 1);
    let retry = hub
        .service
        .store()
        .item("s1", "node-retry-r1-1")
        .unwrap()
        .unwrap();
    assert!(matches!(
        retry.kind,
        ItemKind::NodeRetry {
            reason: RunFailure {
                class: FailureClass::Network,
                ..
            },
            ..
        }
    ));
    let received = hub.runner.received();
    assert_eq!(
        received
            .iter()
            .filter(|c| matches!(c, SessionCommand::Interrupt))
            .count(),
        1
    );
    assert!(
        received
            .iter()
            .any(|c| matches!(c, SessionCommand::Send { text, .. } if text == RETRY_MESSAGE))
    );
    // Honoured, so the process stayed: no stop, no respawn.
    assert!(
        !received
            .iter()
            .any(|c| matches!(c, SessionCommand::Shutdown { .. }))
    );
    assert_eq!(hub.runner.spawned().len(), 1);
    assert_eq!(*hub.service.running().borrow(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_run_cut_by_sleep_whose_retries_fail_ended_by_the_sleep() {
    let lines = r#"
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"u1"}}
{"dir":"out","ms":0,"msg":{"type":"command_lifecycle","command_uuid":"u1","state":"started"}}
{"dir":"out","ms":7200000,"msg":{"type":"result","subtype":"success","is_error":false,"result":"too late"}}
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"u2"}}
{"dir":"out","ms":0,"msg":{"type":"command_lifecycle","command_uuid":"u2","state":"started"}}
{"dir":"out","ms":5,"msg":{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: Connection error."}}
"#;
    let dir = tempfile::tempdir().unwrap();
    let mut runner = FakeRunner::from_lines(lines);
    runner.timed = true;
    let mut hub = hub(dir.path(), NodeStore::open_memory(10_000).unwrap(), runner).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    hub.summary(|s| s.status == SessionStatus::Running).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    hub.service.woke();
    let failed = hub.settled("r1").await;
    let run = failed.latest_run.unwrap();
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(run.failure.unwrap().class, FailureClass::Network);
    assert_eq!(run.end, Some(RunEnd::MachineSlept));
}

#[tokio::test(start_paused = true)]
async fn a_node_shutdown_cuts_the_turn_and_never_starts_a_send_queued_behind_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut runner = FakeRunner::from_lines(STEER_TURNS);
    runner.timed = true;
    let mut hub = hub(dir.path(), NodeStore::open_memory(10_000).unwrap(), runner).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    hub.summary(|s| {
        s.latest_run
            .as_ref()
            .is_some_and(|r| r.id == "r1" && r.status == RunStatus::Running)
    })
    .await;
    // Queued behind the 30 s tool, as T19's "pause" message was when its node stopped.
    tokio::time::sleep(Duration::from_millis(100)).await;
    hub.ok(send("s1", "r2")).await;
    hub.service.shutdown().await;

    let runs = hub.service.store().runs("s1").unwrap();
    let (cut, queued) = (&runs[0], &runs[1]);
    assert!(cut.started_at.is_some());
    assert_eq!(cut.status, RunStatus::Interrupted);
    assert_eq!(cut.end, Some(RunEnd::NodeStopping));
    assert_eq!(cut.ended_by, None);
    assert_eq!(
        cut.failure.as_ref().unwrap().message.as_str(),
        "the node stopped"
    );
    // Withdrawn before the interrupt ended the turn ahead of it: claude never took it in.
    assert_eq!(queued.status, RunStatus::Interrupted);
    assert_eq!(queued.started_at, None);
    assert_eq!(queued.end, Some(RunEnd::NodeStopping));
    let received = hub.runner.received();
    let withdraw = received
        .iter()
        .position(|c| matches!(c, SessionCommand::Withdraw { run_id } if run_id == "r2"));
    let interrupt = received
        .iter()
        .position(|c| matches!(c, SessionCommand::Interrupt));
    assert!(withdraw.unwrap() < interrupt.unwrap());
    let summary = hub.service.store().session("s1").unwrap().unwrap().summary;
    assert_eq!(summary.status, SessionStatus::Interrupted);
    assert_eq!(summary.latest_run.unwrap().id, "r1");
}

#[tokio::test(start_paused = true)]
async fn deltas_reach_followers_coalesced_and_stop_at_their_message() {
    let lines = r#"
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"u3"}}
{"dir":"out","ms":0,"msg":{"type":"command_lifecycle","command_uuid":"u3","state":"started"}}
{"dir":"out","ms":5,"msg":{"type":"result","subtype":"success","is_error":false,"result":""}}
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"u4"}}
{"dir":"out","ms":0,"msg":{"type":"command_lifecycle","command_uuid":"u4","state":"started"}}
{"dir":"out","ms":0,"msg":{"type":"stream_event","event":{"type":"message_start","message":{"id":"m2"}}}}
{"dir":"out","ms":0,"msg":{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}}}
{"dir":"out","ms":30,"msg":{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"b"}}}}
{"dir":"out","ms":60,"msg":{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"c"}}}}
{"dir":"out","ms":90,"msg":{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"d"}}}}
{"dir":"out","ms":130,"msg":{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"e"}}}}
{"dir":"out","ms":250,"msg":{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"f"}}}}
{"dir":"out","ms":260,"msg":{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"abcdef"}]}}}
{"dir":"out","ms":270,"msg":{"type":"result","subtype":"success","is_error":false,"result":"abcdef"}}
"#;
    let dir = tempfile::tempdir().unwrap();
    let mut runner = FakeRunner::from_lines(lines);
    runner.timed = true;
    let mut hub = hub(dir.path(), NodeStore::open_memory(10_000).unwrap(), runner).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    hub.settled("r1").await;
    hub.ok(SessionCall::Follow {
        session_id: ThreadId::unchecked("s1"),
    })
    .await;
    hub.ok(send("s1", "r2")).await;

    let mut seen = Vec::new();
    hub.until(|f| match f {
        NodeToHub::ThreadEvent(t) => match t.event {
            ThreadEvent::Delta {
                append,
                message_id,
                run_id,
            } => {
                assert_eq!((message_id.as_str(), run_id.as_deref()), ("m2", Some("r2")));
                seen.push(append);
                None
            }
            ThreadEvent::Message(m) if m.role == MessageRole::Assistant => Some(m),
            _ => None,
        },
        _ => None,
    })
    .await;
    // The first delta goes at once, then at most one per 100 ms; "f" was still waiting when its message came.
    assert_eq!(seen, ["a", "bcd", "e"]);
}

#[tokio::test]
async fn a_writers_commits_name_its_task_in_a_trailer_only_in_its_worktree() {
    writer_commits(true).await;
}

/// A repo without `extensions.worktreeConfig` is never given it: its shared config stays as it was, and the agent's
/// commits carry no trailer.
#[tokio::test]
async fn a_writer_in_a_repo_without_worktree_config_sets_nothing_and_names_no_task() {
    writer_commits(false).await;
}

/// A writer on T7 commits in its worktree and in a second repo, with the repo's `extensions.worktreeConfig` on or off.
async fn writer_commits(worktree_config: bool) {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = repo(dir.path());
    if worktree_config {
        git(&root, &["config", "extensions.worktreeConfig", "true"]);
    }
    let shared = std::fs::read(root.join(".git/config")).unwrap();
    // The repo's own hook, which must run in the worktree and nowhere else.
    let log = dir.path().join("hooks.log");
    let hook = root.join(".git/hooks/commit-msg");
    std::fs::write(
        &hook,
        format!("#!/bin/sh\necho ran >> '{}'\n", log.display()),
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&root).await;
    let workspace = SessionWorkspace::Worktree {
        base_ref: NonEmpty::unchecked("main"),
        branch: NonEmpty::unchecked("fleetd/T7-docs"),
        from_session: None,
    };
    hub.ok(launch("s1", RuntimeMode::FullAccess, workspace))
        .await;
    hub.settled("r1").await;
    let spec = hub.runner.spawned()[0].clone();
    // Nothing in the session's environment points git anywhere.
    assert!(
        !spec.env.iter().any(|(k, _)| k.starts_with("GIT_CONFIG")),
        "{:?}",
        spec.env
    );
    // The agent's git, as claude's Bash tool runs it, with the session's environment.
    let agent_git = |cwd: &Path, args: &[&str]| -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .env_clear()
            .envs(spec.env.iter().cloned())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    };
    let commit = |cwd: &Path, msg: &str| {
        std::fs::write(cwd.join(format!("{msg}.md")), "d\n").unwrap();
        agent_git(cwd, &["add", "."]);
        agent_git(cwd, &["commit", "-q", "-m", msg]);
        agent_git(cwd, &["log", "-1", "--format=%B"])
    };
    let named = if worktree_config {
        "docs\n\nFleetd-Task: T7"
    } else {
        "docs"
    };
    assert_eq!(commit(&spec.cwd, "docs"), named);
    assert_eq!(
        std::fs::read(root.join(".git/config")).unwrap(),
        shared,
        "the repo's shared config is never written"
    );
    let ran = || {
        std::fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .count()
    };
    assert_eq!(ran(), 1, "the repo's own hook ran in the worktree");

    // A second repo from the same session: no trailer, and none of the first repo's hooks.
    let other = dir.path().join("scratch");
    std::fs::create_dir_all(&other).unwrap();
    agent_git(&other, &["init", "-q", "-b", "main"]);
    assert_eq!(commit(&other, "scratch"), "scratch");
    assert_eq!(ran(), 1);
}

#[tokio::test]
async fn a_removed_worktree_comes_back_at_the_same_path_when_the_session_resumes() {
    let var = |spec: &crate::node::runner::SessionSpec, key: &str| {
        spec.env
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };
    let dir = tempfile::tempdir().unwrap();
    let root = repo(dir.path());
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&root).await;
    let workspace = SessionWorkspace::Worktree {
        base_ref: NonEmpty::unchecked("main"),
        branch: NonEmpty::unchecked("fleetd/s1"),
        from_session: None,
    };
    hub.ok(launch("s1", RuntimeMode::FullAccess, workspace))
        .await;
    let done = hub.settled("r1").await;
    let path: PathBuf = dir.path().join("node/worktrees/p1/s1");
    assert_eq!(done.worktree_path.as_deref(), path.to_str());
    assert_eq!(done.branch.as_deref(), Some("fleetd/s1"));
    let spec = hub.runner.spawned()[0].clone();
    assert_eq!(
        (spec.cwd.as_path(), spec.add_dirs.as_slice()),
        (path.as_path(), &[root.clone()][..])
    );
    // The project's tool rules reach claude's argv, after the tools fleetd always denies.
    assert_eq!(spec.allowed_tools, ["Bash(npm test:*)"]);
    assert_eq!(
        spec.disallowed_tools.last().map(String::as_str),
        Some("WebFetch")
    );
    assert!(spec.disallowed_tools.iter().any(|t| t == "Task"));
    // Its own scratch dir under the node home, and its share of the CPUs, which its brief names.
    let scratch = super::share::scratch_dir(&dir.path().join("node"), "s1");
    assert!(scratch.is_dir());
    for key in ["TMPDIR", "TMP", "TEMP"] {
        assert_eq!(var(&spec, key).as_deref(), scratch.to_str());
    }
    let jobs = var(&spec, "CARGO_BUILD_JOBS").unwrap();
    assert_eq!(var(&spec, "MAKEFLAGS"), Some(format!("-j{jobs}")));
    assert_eq!(var(&spec, "GOFLAGS"), Some(format!("-p={jobs}")));
    let first = &sends(&hub.runner)[0].1;
    assert!(
        first.contains(&format!("- Builds get {jobs} parallel jobs per agent")),
        "{first}"
    );

    std::fs::write(path.join("work.txt"), "w\n").unwrap();
    git(&path, &["add", "."]);
    git(&path, &["commit", "-q", "-m", "work"]);
    std::fs::write(path.join("draft.txt"), "d\n").unwrap();
    let changes = hub
        .ok(SessionCall::Changes {
            session_id: ThreadId::unchecked("s1"),
        })
        .await;
    assert!(matches!(changes, SessionOutput::Changes(c) if c.paths == ["draft.txt", "work.txt"]));

    // Removal waits until nothing exists only here: no draft, and the work pushed.
    std::fs::remove_file(path.join("draft.txt")).unwrap();
    git(
        &path,
        &["update-ref", "refs/remotes/origin/fleetd/s1", "HEAD"],
    );
    hub.ok(SessionCall::Stop {
        session_id: ThreadId::unchecked("s1"),
        remove_worktree: true,
    })
    .await;
    assert!(!path.exists());
    assert!(!scratch.exists());
    let stopped = hub.summary(|s| s.worktree_path.is_none()).await;
    // Unmerged work keeps its branch.
    assert_eq!(stopped.branch.as_deref(), Some("fleetd/s1"));

    hub.ok(send("s1", "r2")).await;
    let resumed = hub.settled("r2").await;
    assert_eq!(resumed.worktree_path.as_deref(), path.to_str());
    assert!(path.join("work.txt").exists());
    let spec = &hub.runner.spawned()[1];
    assert!(spec.resume);
    assert_eq!(spec.cwd, path);
    assert!(scratch.is_dir());
}

#[tokio::test]
async fn a_writer_starts_from_a_fresh_fetch_of_origin_not_the_stale_local_main() {
    let dir = tempfile::tempdir().unwrap();
    let seed = repo(dir.path());
    let origin = dir.path().join("origin.git");
    let checkout = dir.path().join("checkout");
    let (o, c) = (origin.to_string_lossy(), checkout.to_string_lossy());
    git(
        dir.path(),
        &["clone", "-q", "--bare", &seed.to_string_lossy(), &o],
    );
    git(dir.path(), &["clone", "-q", &o, &c]);
    // Upstream moves on after the human's last pull.
    std::fs::write(seed.join("upstream.txt"), "u\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-q", "-m", "upstream"]);
    git(&seed, &["push", "-q", &o, "main"]);
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&checkout).await;
    let workspace = SessionWorkspace::Worktree {
        base_ref: NonEmpty::unchecked("main"),
        branch: NonEmpty::unchecked("fleetd/s1"),
        from_session: None,
    };
    let launched = hub
        .ok(launch("s1", RuntimeMode::FullAccess, workspace))
        .await;
    // The launch says where the branch started.
    let SessionOutput::Launched {
        base: Some(base), ..
    } = launched
    else {
        panic!("no base in {launched:?}")
    };
    let upstream = std::process::Command::new("git")
        .arg("-C")
        .arg(&seed)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap()
        .stdout;
    assert_eq!(
        (base.base_ref.as_str(), base.sha.as_str(), &base.error),
        (
            "origin/main",
            String::from_utf8_lossy(&upstream).trim(),
            &None
        )
    );
    assert!(base.fetched_at.is_some());
    hub.settled("r1").await;
    let path: PathBuf = dir.path().join("node/worktrees/p1/s1");
    assert!(path.join("upstream.txt").exists());
    assert!(!checkout.join("upstream.txt").exists());

    std::fs::write(path.join("work.txt"), "w\n").unwrap();
    git(&path, &["add", "."]);
    git(&path, &["commit", "-q", "-m", "work"]);
    let changes = hub
        .ok(SessionCall::Changes {
            session_id: ThreadId::unchecked("s1"),
        })
        .await;
    // Compared with origin/main, so upstream's commit isn't the writer's.
    assert!(matches!(changes, SessionOutput::Changes(c) if c.paths == ["work.txt"]));
}

#[tokio::test]
async fn a_slow_fetch_never_holds_up_a_launch_in_another_project() {
    let dir = tempfile::tempdir().unwrap();
    let seed = repo(dir.path());
    let slow = dir.path().join("slow");
    git(
        dir.path(),
        &[
            "clone",
            "-q",
            &seed.to_string_lossy(),
            &slow.to_string_lossy(),
        ],
    );
    // A remote that takes 3 s to fail.
    git(&slow, &["config", "core.sshCommand", "sleep 3; exit 1 #"]);
    git(&slow, &["config", "ssh.variant", "simple"]);
    git(
        &slow,
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://example.invalid/slow.git",
        ],
    );
    let other = dir.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    let hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&slow).await;
    hub.ok(SessionCall::ProjectUpsert {
        project_id: ProjectId::unchecked("p2"),
        title: NonEmpty::unchecked("p2"),
        workspace_root: NonEmpty::unchecked(other.to_string_lossy()),
    })
    .await;
    let writer = launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Worktree {
            base_ref: NonEmpty::unchecked("main"),
            branch: NonEmpty::unchecked("fleetd/s1"),
            from_session: None,
        },
    );
    let SessionCall::Launch(mut reader) =
        launch("s2", RuntimeMode::FullAccess, SessionWorkspace::Root)
    else {
        unreachable!()
    };
    reader.project_id = ProjectId::unchecked("p2");
    let (_, waited) = tokio::join!(hub.ok(writer), async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let started = std::time::Instant::now();
        hub.ok(SessionCall::Launch(reader)).await;
        started.elapsed()
    });
    assert!(
        waited < Duration::from_secs(2),
        "waited {waited:?} on p1's fetch"
    );
}

/// Every file of the human's checkout outside `.git`, and what git keeps that is theirs: HEAD, the index, FETCH_HEAD
/// and their branches.
fn checkout_state(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(PathBuf, Vec<u8>)>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        entries.sort();
        for path in entries {
            if path == root.join(".git") {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let rel = path.strip_prefix(root).unwrap().to_path_buf();
                out.push((rel, std::fs::read(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    for file in ["HEAD", "index", "FETCH_HEAD"] {
        let at = Path::new(".git").join(file);
        out.push((at.clone(), std::fs::read(root.join(at)).unwrap()));
    }
    let heads = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["for-each-ref", "refs/heads"])
        .output()
        .unwrap();
    out.push(("refs/heads".into(), heads.stdout));
    out
}

fn rev(dir: &Path, rev: &str) -> String {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", rev])
        .output()
        .unwrap();
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// Names `remote` of `checkout` as `url` on a host, which git reaches at the local repo `at` through
/// `url.<at>.insteadOf`, as a real remote would be named.
fn hosted(checkout: &Path, remote: &str, url: &str, at: &Path) {
    let has = std::process::Command::new("git")
        .arg("-C")
        .arg(checkout)
        .args(["remote", "get-url", remote])
        .output()
        .unwrap()
        .status
        .success();
    let verb = if has { "set-url" } else { "add" };
    git(checkout, &["remote", verb, remote, url]);
    let key = format!("url.{}.insteadOf", at.to_string_lossy());
    git(checkout, &["config", "--add", &key, url]);
}

#[tokio::test]
async fn readers_and_reviewers_each_get_a_worktree_of_their_own_and_the_humans_checkout_is_untouched()
 {
    let dir = tempfile::tempdir().unwrap();
    let seed = repo(dir.path());
    let origin = dir.path().join("origin.git");
    let checkout = dir.path().join("checkout");
    let (o, c) = (origin.to_string_lossy(), checkout.to_string_lossy());
    git(
        dir.path(),
        &["clone", "-q", "--bare", &seed.to_string_lossy(), &o],
    );
    git(dir.path(), &["clone", "-q", &o, &c]);
    hosted(&checkout, "origin", "https://github.com/o/r.git", &origin);
    hosted(
        &checkout,
        "mirror",
        "git@gitlab.example.com:o/r.git",
        &origin,
    );
    // Upstream moves on after the human's last pull, and two PRs are open: one on a host with GitHub's PR refs, one
    // with GitLab's.
    std::fs::write(seed.join("upstream.txt"), "u\n").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-q", "-m", "upstream"]);
    git(&seed, &["push", "-q", &o, "main"]);
    let mut heads = Vec::new();
    for (file, pr_ref) in [
        ("pr7.txt", "refs/pull/7/head"),
        ("mr8.txt", "refs/merge-requests/8/head"),
    ] {
        git(&seed, &["checkout", "-q", "-B", file, "main"]);
        std::fs::write(seed.join(file), "pr\n").unwrap();
        git(&seed, &["add", "."]);
        git(&seed, &["commit", "-q", "-m", file]);
        git(&seed, &["push", "-q", &o, &format!("HEAD:{pr_ref}")]);
        heads.push(rev(&seed, "HEAD"));
    }
    let fresh = rev(&origin, "main");
    // The human: their own last fetch, a feature branch, an edit and a new file in progress.
    git(&checkout, &["fetch", "-q", "origin"]);
    git(&checkout, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(checkout.join("a.txt"), "edited\n").unwrap();
    std::fs::write(checkout.join("wip.txt"), "wip\n").unwrap();
    let before = checkout_state(&checkout);

    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&checkout).await;
    let tasks = [
        ("s1", None, fresh.as_str()),
        (
            "s2",
            Some("https://github.com/o/r/pull/7"),
            heads[0].as_str(),
        ),
        (
            "s3",
            Some("https://gitlab.example.com/o/r/-/merge_requests/8/diffs"),
            heads[1].as_str(),
        ),
    ];
    for (n, (id, pr, at)) in tasks.iter().enumerate() {
        let workspace = SessionWorkspace::Detached {
            base_ref: NonEmpty::unchecked("main"),
            pr: pr.map(NonEmpty::unchecked),
        };
        hub.ok(launch(id, RuntimeMode::FullAccess, workspace)).await;
        let done = hub
            .summary(|s| {
                s.session_id.as_str() == *id && s.active_run_id.is_none() && s.latest_run.is_some()
            })
            .await;
        let path = dir.path().join("node/worktrees/p1").join(id);
        assert_eq!(done.worktree_path.as_deref(), path.to_str(), "{id}");
        assert_eq!(done.branch, None, "{id}");
        assert_eq!(hub.runner.spawned()[n].cwd, path, "{id}");
        // Detached, at the fresh base or the PR's head.
        assert_eq!(rev(&path, "HEAD"), *at, "{id}");
        assert!(
            !std::process::Command::new("git")
                .arg("-C")
                .arg(&path)
                .args(["symbolic-ref", "-q", "HEAD"])
                .status()
                .unwrap()
                .success(),
            "{id}"
        );
        assert!(path.join("upstream.txt").exists(), "{id}");
        assert!(!path.join("wip.txt").exists(), "{id}");
        // It may build and run tests there.
        std::fs::create_dir_all(path.join("target")).unwrap();
        std::fs::write(path.join("target/out"), "built\n").unwrap();
    }
    assert_eq!(checkout_state(&checkout), before);

    // The task ended: its worktree goes, build output with it.
    for (id, ..) in &tasks {
        hub.ok(SessionCall::Stop {
            session_id: ThreadId::unchecked(*id),
            remove_worktree: true,
        })
        .await;
        assert!(!dir.path().join("node/worktrees/p1").join(id).exists());
    }
    let listed = std::process::Command::new("git")
        .arg("-C")
        .arg(&checkout)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .unwrap();
    let listed = String::from_utf8(listed.stdout).unwrap();
    assert_eq!(listed.matches("worktree ").count(), 1, "{listed}");
    assert_eq!(checkout_state(&checkout), before);

    // A message after its end brings it back at the same commit, so the session resumes in it.
    hub.ok(send("s2", "r2")).await;
    hub.settled("r2").await;
    let path = dir.path().join("node/worktrees/p1/s2");
    assert_eq!(rev(&path, "HEAD"), heads[0]);
    let spec = hub.runner.spawned().last().unwrap().clone();
    assert!(spec.resume);
    assert_eq!(spec.cwd, path);
}

#[tokio::test]
async fn a_review_whose_host_publishes_no_pr_refs_reads_the_fresh_base() {
    let dir = tempfile::tempdir().unwrap();
    let seed = repo(dir.path());
    let origin = dir.path().join("origin.git");
    let checkout = dir.path().join("checkout");
    let (o, c) = (origin.to_string_lossy(), checkout.to_string_lossy());
    git(
        dir.path(),
        &["clone", "-q", "--bare", &seed.to_string_lossy(), &o],
    );
    git(dir.path(), &["clone", "-q", &o, &c]);
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&checkout).await;
    let workspace = SessionWorkspace::Detached {
        base_ref: NonEmpty::unchecked("main"),
        pr: Some(NonEmpty::unchecked(
            "https://bitbucket.org/o/r/pull-requests/3",
        )),
    };
    hub.ok(launch("s1", RuntimeMode::FullAccess, workspace))
        .await;
    hub.settled("r1").await;
    let path = dir.path().join("node/worktrees/p1/s1");
    assert_eq!(rev(&path, "HEAD"), rev(&origin, "main"));
}

/// A bare repo `name` cloned from `seed`, with a commit `file` pushed to `pr_ref`; returns it and that commit.
fn bare_with_pr(
    dir: &Path,
    seed: &Path,
    name: &str,
    file: &str,
    pr_ref: &str,
) -> (PathBuf, String) {
    let bare = dir.join(name);
    let b = bare.to_string_lossy().into_owned();
    git(dir, &["clone", "-q", "--bare", &seed.to_string_lossy(), &b]);
    git(seed, &["checkout", "-q", "-B", file, "main"]);
    std::fs::write(seed.join(file), "pr\n").unwrap();
    git(seed, &["add", "."]);
    git(seed, &["commit", "-q", "-m", file]);
    git(seed, &["push", "-q", &b, &format!("HEAD:{pr_ref}")]);
    let head = rev(seed, "HEAD");
    git(seed, &["checkout", "-q", "main"]);
    (bare, head)
}

/// In a fork, origin is the human's fork and the PR is upstream's: its head comes from upstream, never from a PR of the
/// same number on the fork. A PR of a repo no remote is reads the fresh base, for the brief to have it fetch the head.
#[tokio::test]
async fn a_review_in_a_fork_reads_the_head_from_the_remote_the_pr_belongs_to() {
    let dir = tempfile::tempdir().unwrap();
    let seed = repo(dir.path());
    let (fork, decoy) = bare_with_pr(
        dir.path(),
        &seed,
        "fork.git",
        "decoy.txt",
        "refs/pull/7/head",
    );
    let (upstream, head) = bare_with_pr(
        dir.path(),
        &seed,
        "upstream.git",
        "pr.txt",
        "refs/pull/7/head",
    );
    let checkout = dir.path().join("checkout");
    git(
        dir.path(),
        &[
            "clone",
            "-q",
            &fork.to_string_lossy(),
            &checkout.to_string_lossy(),
        ],
    );
    hosted(&checkout, "origin", "https://github.com/me/r.git", &fork);
    hosted(&checkout, "upstream", "https://github.com/o/r", &upstream);
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&checkout).await;
    for (id, pr, at) in [
        ("s1", "https://github.com/O/R/pull/7", head.as_str()),
        (
            "s2",
            "https://github.com/someone/else/pull/7",
            &rev(&fork, "main"),
        ),
    ] {
        let workspace = SessionWorkspace::Detached {
            base_ref: NonEmpty::unchecked("main"),
            pr: Some(NonEmpty::unchecked(pr)),
        };
        hub.ok(launch(id, RuntimeMode::FullAccess, workspace)).await;
        hub.summary(|s| s.session_id.as_str() == id && s.latest_run.is_some())
            .await;
        let path = dir.path().join("node/worktrees/p1").join(id);
        assert_eq!(rev(&path, "HEAD"), at, "{id}");
        assert_ne!(rev(&path, "HEAD"), decoy, "{id}");
    }
}

/// A new repo has no commit to start a worktree from, so the node names no default branch: the hub then runs its
/// readers in the project root, as before, rather than failing their start.
#[tokio::test]
async fn a_repo_with_no_commit_yet_has_no_default_branch() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("new");
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    let hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&root).await;
    let ask = || SessionCall::DefaultBranch {
        project_id: ProjectId::unchecked("p1"),
    };
    assert!(matches!(
        hub.ok(ask()).await,
        SessionOutput::DefaultBranch { branch: None }
    ));
    std::fs::write(root.join("a.txt"), "a\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-q", "-m", "first"]);
    assert!(matches!(
        hub.ok(ask()).await,
        SessionOutput::DefaultBranch { branch: Some(b) } if b == "main"
    ));
}

/// A message to a reader right as its task ends, before or while the hub removes its worktree: either the message
/// lands first and the worktree stays, or it waits for the removal and the worktree comes back. Its run completes,
/// and the session never runs in a directory that is gone.
#[tokio::test]
async fn a_message_as_a_readers_task_ends_never_resumes_in_a_worktree_being_removed() {
    for message_first in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = repo(dir.path());
        let mut hub = hub(
            dir.path(),
            NodeStore::open_memory(10_000).unwrap(),
            FakeRunner::fixture("init-partial-two-turns"),
        )
        .await;
        hub.project(&root).await;
        let workspace = SessionWorkspace::Detached {
            base_ref: NonEmpty::unchecked("main"),
            pr: None,
        };
        hub.ok(launch("s1", RuntimeMode::FullAccess, workspace))
            .await;
        hub.settled("r1").await;
        let path = dir.path().join("node/worktrees/p1/s1");
        // Build output, so the removal takes a while.
        for n in 0..2000 {
            let at = path.join(format!("target/{}", n % 20));
            std::fs::create_dir_all(&at).unwrap();
            std::fs::write(at.join(n.to_string()), "o").unwrap();
        }
        let remove = SessionCall::Stop {
            session_id: ThreadId::unchecked("s1"),
            remove_worktree: true,
        };
        if message_first {
            let (sent, _) = tokio::join!(hub.call(send("s1", "r2")), async {
                tokio::task::yield_now().await;
                hub.call(remove).await
            });
            assert!(matches!(sent, SessionResult::Ok(_)), "{sent:?}");
        } else {
            let (_, sent) = tokio::join!(hub.call(remove), async {
                tokio::task::yield_now().await;
                hub.call(send("s1", "r2")).await
            });
            assert!(matches!(sent, SessionResult::Ok(_)), "{sent:?}");
        }
        let done = hub.settled("r2").await;
        assert_eq!(
            done.latest_run.as_ref().map(|r| r.status),
            Some(RunStatus::Completed),
            "message first: {message_first}"
        );
        let live = hub.service.st().live.contains_key("s1");
        assert!(
            path.is_dir() || !live,
            "message first: {message_first}: a live session in a removed worktree"
        );
        for spec in hub.runner.spawned() {
            assert_eq!(spec.cwd, path);
        }
    }
}

#[tokio::test]
async fn a_lost_worktree_and_branch_come_back_from_the_pushed_branch_and_the_agent_is_told() {
    let dir = tempfile::tempdir().unwrap();
    let (_, root) = cloned(dir.path(), "repo", "origin");
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&root).await;
    let workspace = SessionWorkspace::Worktree {
        base_ref: NonEmpty::unchecked("main"),
        branch: NonEmpty::unchecked("fleetd/s1"),
        from_session: None,
    };
    hub.ok(launch("s1", RuntimeMode::FullAccess, workspace))
        .await;
    let done = hub.settled("r1").await;
    assert_eq!(done.recreated_from, None);
    let path: PathBuf = dir.path().join("node/worktrees/p1/s1");
    std::fs::write(path.join("work.txt"), "w\n").unwrap();
    git(&path, &["add", "."]);
    git(&path, &["commit", "-q", "-m", "work"]);
    git(&path, &["push", "-q", "origin", "fleetd/s1"]);
    hub.ok(SessionCall::Stop {
        session_id: ThreadId::unchecked("s1"),
        remove_worktree: false,
    })
    .await;
    // The worktree's directory and its local branch are deleted behind the node's back.
    std::fs::remove_dir_all(&path).unwrap();
    git(&root, &["worktree", "prune"]);
    git(&root, &["branch", "-q", "-D", "fleetd/s1"]);

    hub.ok(send("s1", "r2")).await;
    let resumed = hub.settled("r2").await;
    assert_eq!(resumed.recreated_from, Some(WorktreeSource::Remote));
    assert!(resumed.recreated_at.is_some());
    assert_eq!(resumed.worktree_path.as_deref(), path.to_str());
    assert!(path.join("work.txt").exists());
    let spec = &hub.runner.spawned()[1];
    assert!(spec.resume, "same path, so claude still finds its session");
    let sent = sends(&hub.runner);
    let (note, message) = sent[1].1.split_once("\n\n").unwrap();
    assert!(
        note.contains("recreated at the same path from origin/fleetd/s1"),
        "{note}"
    );
    assert_eq!(message, "Reply with the word TWO and nothing else.");
    // The run's own message stays the hub's text.
    let recorded = hub.service.store().message("s1", "r2").unwrap().unwrap();
    assert_eq!(recorded.text, message);
}

/// A task restarted fresh: its new session takes over the earlier one's worktree as it was left, uncommitted work
/// included, and starts a conversation of its own there.
#[tokio::test]
async fn a_session_taking_over_a_branch_works_in_the_earlier_sessions_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let (_, root) = cloned(dir.path(), "repo", "origin");
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&root).await;
    let workspace = |from: Option<&str>| SessionWorkspace::Worktree {
        base_ref: NonEmpty::unchecked("main"),
        branch: NonEmpty::unchecked("fleetd/s1"),
        from_session: from.map(ThreadId::unchecked),
    };
    hub.ok(launch("s1", RuntimeMode::FullAccess, workspace(None)))
        .await;
    hub.settled("r1").await;
    let path: PathBuf = dir.path().join("node/worktrees/p1/s1");
    std::fs::write(path.join("draft.txt"), "not committed\n").unwrap();

    let SessionCall::Launch(mut fresh) =
        launch("s2", RuntimeMode::FullAccess, workspace(Some("s1")))
    else {
        unreachable!()
    };
    fresh.run_id = NonEmpty::unchecked("q1");
    hub.ok(SessionCall::Launch(fresh)).await;
    let started = hub.settled("q1").await;
    assert_eq!(started.worktree_path.as_deref(), path.to_str());
    assert_eq!(started.branch.as_deref(), Some("fleetd/s1"));
    assert_eq!(started.recreated_from, None);
    assert!(path.join("draft.txt").exists());
    assert!(!dir.path().join("node/worktrees/p1/s2").exists());
    let spec = &hub.runner.spawned()[1];
    assert_eq!((spec.cwd.as_path(), spec.resume), (path.as_path(), false));
}

/// A task's session restarted after its process went must resume its conversation for anything but its first message:
/// without it, a recovery note alone would reach an agent that knows nothing of its task, so claude's start is refused
/// when the conversation is gone (the hub then restarts the task with its brief). The first message again may start
/// over.
#[tokio::test]
async fn a_task_session_must_resume_for_anything_but_its_first_message() {
    let dir = tempfile::tempdir().unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    hub.settled("r1").await;
    let stop = || SessionCall::Stop {
        session_id: ThreadId::unchecked("s1"),
        remove_worktree: false,
    };
    hub.ok(stop()).await;
    hub.ok(send("s1", "r2")).await;
    hub.settled("r2").await;
    hub.ok(stop()).await;
    hub.ok(SessionCall::Send {
        session_id: ThreadId::unchecked("s1"),
        run_id: NonEmpty::unchecked("r3"),
        text: NonEmpty::unchecked("Reply with the word OK and nothing else."),
        mode: SendMode::Plain,
        steer: None,
    })
    .await;
    let spawned: Vec<(bool, bool)> = hub
        .runner
        .spawned()
        .iter()
        .map(|s| (s.resume, s.must_resume))
        .collect();
    assert_eq!(spawned, [(false, false), (true, true), (true, false)]);
}

#[tokio::test]
async fn a_slow_fetch_for_a_lost_worktree_never_holds_up_another_sessions_start() {
    let dir = tempfile::tempdir().unwrap();
    let (_, root) = cloned(dir.path(), "repo", "origin");
    let other = dir.path().join("other");
    std::fs::create_dir_all(&other).unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&root).await;
    hub.ok(SessionCall::ProjectUpsert {
        project_id: ProjectId::unchecked("p2"),
        title: NonEmpty::unchecked("p2"),
        workspace_root: NonEmpty::unchecked(other.to_string_lossy()),
    })
    .await;
    let workspace = SessionWorkspace::Worktree {
        base_ref: NonEmpty::unchecked("main"),
        branch: NonEmpty::unchecked("fleetd/s1"),
        from_session: None,
    };
    hub.ok(launch("s1", RuntimeMode::FullAccess, workspace))
        .await;
    hub.settled("r1").await;
    let SessionCall::Launch(mut reader) =
        launch("s2", RuntimeMode::FullAccess, SessionWorkspace::Root)
    else {
        unreachable!()
    };
    reader.project_id = ProjectId::unchecked("p2");
    reader.run_id = NonEmpty::unchecked("q1");
    hub.ok(SessionCall::Launch(reader)).await;
    hub.settled("q1").await;
    for id in ["s1", "s2"] {
        hub.ok(SessionCall::Stop {
            session_id: ThreadId::unchecked(id),
            remove_worktree: false,
        })
        .await;
    }
    // s1's worktree and branch are gone, and its remote takes 3 s to fail.
    let path: PathBuf = dir.path().join("node/worktrees/p1/s1");
    std::fs::remove_dir_all(&path).unwrap();
    git(&root, &["worktree", "prune"]);
    git(&root, &["branch", "-q", "-D", "fleetd/s1"]);
    git(&root, &["config", "core.sshCommand", "sleep 3; exit 1 #"]);
    git(&root, &["config", "ssh.variant", "simple"]);
    git(
        &root,
        &[
            "remote",
            "set-url",
            "origin",
            "ssh://example.invalid/slow.git",
        ],
    );

    let (_, waited) = tokio::join!(hub.ok(send("s1", "r2")), async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let started = std::time::Instant::now();
        hub.ok(send("s2", "q2")).await;
        started.elapsed()
    });
    assert!(
        waited < Duration::from_secs(2),
        "s2 waited {waited:?} on s1's fetch"
    );
    // Offline and never pushed: s1 starts again from the last fetched origin/main.
    assert!(path.join("a.txt").exists());
}

#[tokio::test]
async fn a_first_start_that_claude_already_knows_resumes_instead() {
    let dir = tempfile::tempdir().unwrap();
    let runner = FakeRunner::fixture("init-partial-two-turns");
    *runner.refuse_next.lock().unwrap() = Some("Error: Session ID s1 is already in use.".into());
    let mut hub = hub(dir.path(), NodeStore::open_memory(10_000).unwrap(), runner).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    // claude's refusal fails the first process's send; the run itself completes on a resumed process.
    let done = hub.settled("r1").await;
    assert_eq!(done.status, SessionStatus::Idle);
    assert_eq!(done.latest_run.unwrap().status, RunStatus::Completed);
    let spawned = hub.runner.spawned();
    assert_eq!(spawned.len(), 2);
    assert!(!spawned[0].resume);
    assert!(spawned[1].resume);
    let prompt = "Reply with the word OK and nothing else.";
    let sends = sends(&hub.runner);
    assert_eq!(sends.len(), 2);
    assert_eq!((sends[0].0.as_str(), brief(&sends[0].1)), ("r1", prompt));
    assert_eq!(brief(&sends[1].1), prompt);
    assert_eq!(hub.service.store().runs("s1").unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_retry_of_a_message_claude_never_took_in_sends_the_message_again() {
    // The first turn fails before claude says `started`; the retry's turn completes.
    let lines = r#"
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"u1"}}
{"dir":"out","ms":0,"msg":{"type":"assistant","error":"overloaded","message":{"id":"m1","content":[]}}}
{"dir":"out","ms":0,"msg":{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 529 Overloaded"}}
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"u2"}}
{"dir":"out","ms":0,"msg":{"type":"command_lifecycle","command_uuid":"u2","state":"started"}}
{"dir":"out","ms":0,"msg":{"type":"result","subtype":"success","is_error":false,"result":"OK"}}
"#;
    let dir = tempfile::tempdir().unwrap();
    let config = SessionConfig {
        retry_schedule_ms: vec![1000],
        ..config(dir.path())
    };
    let store = NodeStore::open_memory(10_000).unwrap();
    let mut hub = hub_with(store, FakeRunner::from_lines(lines), config).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    let done = hub.settled("r1").await;
    assert_eq!(done.latest_run.unwrap().status, RunStatus::Completed);
    let prompt = "Reply with the word OK and nothing else.";
    let sends = sends(&hub.runner);
    assert_eq!(sends.len(), 2);
    assert_ne!(sends[1].0, "r1");
    assert_eq!(brief(&sends[1].1), prompt);
    assert_eq!(hub.service.store().runs("s1").unwrap().len(), 1);
}

/// A worker's first message without the node's note on its share of the machine.
fn brief(text: &str) -> &str {
    text.split_once("\n\n## This machine\n")
        .map_or(text, |(brief, _)| brief)
}

fn sends(runner: &FakeRunner) -> Vec<(String, String)> {
    runner
        .received()
        .into_iter()
        .filter_map(|c| match c {
            SessionCommand::Send { run_id, text, .. } => Some((run_id, text)),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn removing_a_project_stops_its_claude_processes_first() {
    let dir = tempfile::tempdir().unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("permission-allow"),
    )
    .await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::ApprovalRequired,
        SessionWorkspace::Root,
    ))
    .await;
    hub.summary(|s| s.status == SessionStatus::Waiting).await;

    let remove = || SessionCall::ProjectRemove {
        project_id: ProjectId::unchecked("p1"),
    };
    assert_eq!(hub.ok(remove()).await, SessionOutput::Done);
    let ended = hub.settled("r1").await;
    assert_eq!(ended.status, SessionStatus::Interrupted);
    assert_eq!(
        ended.latest_run.unwrap().failure.unwrap().message.as_str(),
        "its project was removed"
    );
    assert!(matches!(
        hub.runner.received().last(),
        Some(SessionCommand::Shutdown { .. })
    ));
    let SessionResult::Err(gone) = hub.call(remove()).await else {
        panic!("removed the same project twice")
    };
    assert_eq!(gone.code, SessionErrorCode::NotFound);
}

#[test]
fn tool_search_by_default_yields_to_the_nodes_env_and_claude_env() {
    let dir = tempfile::tempdir().unwrap();
    let own = config(dir.path());
    let get = |env: &[(String, String)]| -> Vec<String> {
        env.iter()
            .filter(|(k, _)| k == "ENABLE_TOOL_SEARCH")
            .map(|(_, v)| v.clone())
            .collect()
    };
    assert_eq!(get(&own.runner_env()), ["true"]);
    std::fs::write(dir.path().join("claude.env"), "ENABLE_TOOL_SEARCH=false\n").unwrap();
    assert_eq!(get(&own.runner_env()), ["false"]);
}

#[test]
fn the_prompt_cache_ttl_follows_the_role_then_the_env_then_node_json() {
    use crate::node::runner::claude::PROMPT_CACHE_TTL_VARS;
    use fleetd_contracts::sessions::SessionRole::{Lead, Plain, Worker};
    let dir = tempfile::tempdir().unwrap();
    let mut own = config(dir.path());
    let ttls = |config: &SessionConfig, role| -> Vec<String> {
        let env = config.runner_env();
        let cache = config.prompt_cache_env(role, &env);
        assert_eq!(
            cache.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            PROMPT_CACHE_TTL_VARS
        );
        cache.into_iter().map(|(_, v)| v).collect()
    };
    // The lead idles between wakes, a person's thread between replies: the hour. A task's agent: 5 minutes.
    assert_eq!(ttls(&own, Lead), ["1h", "1h"]);
    assert_eq!(ttls(&own, Plain), ["1h", "1h"]);
    assert_eq!(ttls(&own, Worker), ["5m", "5m"]);

    // The node's environment or claude.env outrank the role's default, one variable at a time.
    own.base_env
        .push(("CLAUDE_CODE_PROMPT_CACHE_TTL".into(), "1h".into()));
    std::fs::write(
        dir.path().join("claude.env"),
        "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=5m\n",
    )
    .unwrap();
    assert_eq!(ttls(&own, Worker), ["1h", "5m"]);
    assert_eq!(ttls(&own, Lead), ["1h", "5m"]);

    // node.json's setting for a role outranks both; the roles it leaves out keep theirs.
    let node = crate::node::config::NodeConfig {
        hub: "http://hub".into(),
        machine_id: "m1".into(),
        name: "m1".into(),
        tags: Vec::new(),
        cmd_roots: None,
        claude_config_dir: None,
        min_free_gb: None,
        mem_per_agent_gb: None,
        disk_per_agent_gb: None,
        prompt_cache_ttl: [(Worker, crate::node::runner::claude::CacheTtl::FiveMinutes)].into(),
        enrolled: true,
    };
    crate::node::config::write_config(&own.home, &node).unwrap();
    let written = std::fs::read_to_string(own.home.join("node.json")).unwrap();
    assert!(written.contains(r#""promptCacheTtl": {"#) && written.contains(r#""worker": "5m""#));
    assert_eq!(ttls(&own, Worker), ["5m", "5m"]);
    assert_eq!(ttls(&own, Lead), ["1h", "5m"]);
}

#[test]
fn sessions_get_a_config_dir_only_when_the_machine_has_a_dedicated_one() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("claude.env"),
        "ANTHROPIC_BASE_URL=http://127.0.0.1:9\n",
    )
    .unwrap();
    let own = config(dir.path());
    let env = own.runner_env();
    assert!(!env.iter().any(|(k, _)| k == "CLAUDE_CONFIG_DIR"));
    let setup = crate::node::runner::claude_setup::proxy_of(&env).unwrap();
    assert_eq!(setup.0, "http://127.0.0.1:9");
    assert!(setup.1.ends_with("claude.env"), "{}", setup.1);

    let dedicated = SessionConfig {
        config_dir: Some(dir.path().join("profile")),
        ..own
    };
    assert_eq!(
        crate::node::runner::claude_setup::config_dir(&dedicated.runner_env()),
        dir.path().join("profile")
    );
}

#[test]
fn a_machine_given_a_config_dir_keeps_it_in_its_node_config() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("node.json"),
        r#"{"hub":"h","machineId":"m","name":"m","tags":[],"enrolled":true,"claudeConfigDir":"/srv/claude-profile"}"#,
    )
    .unwrap();
    assert_eq!(
        SessionConfig::for_node(dir.path()).config_dir,
        Some(PathBuf::from("/srv/claude-profile"))
    );
}

/// Three turns: a 30 s Bash call, then a reply naming S1, then a plain reply.
const STEER_TURNS: &str = r#"{"dir":"in","ms":0,"msg":{"type":"user","uuid":"s1"}}
{"dir":"out","ms":1,"msg":{"type":"command_lifecycle","command_uuid":"s1","state":"started"}}
{"dir":"out","ms":5,"msg":{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"sleep 30"}}]}}}
{"dir":"out","ms":30000,"msg":{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"","is_error":false}]}}}
{"dir":"out","ms":30010,"msg":{"type":"result","subtype":"success","is_error":false,"result":"slept"}}
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"s2"}}
{"dir":"out","ms":1,"msg":{"type":"command_lifecycle","command_uuid":"s2","state":"started"}}
{"dir":"out","ms":5,"msg":{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"Dropping the docs page"}]}}}
{"dir":"out","ms":6,"msg":{"type":"result","subtype":"success","is_error":false,"result":"Dropping the docs page"}}
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"s3"}}
{"dir":"out","ms":1,"msg":{"type":"command_lifecycle","command_uuid":"s3","state":"started"}}
{"dir":"out","ms":5,"msg":{"type":"assistant","message":{"id":"m3","content":[{"type":"tool_use","id":"tu3","name":"Bash","input":{"command":"true"}}]}}}
{"dir":"out","ms":6,"msg":{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu3","content":"","is_error":false}]}}}
{"dir":"out","ms":7,"msg":{"type":"result","subtype":"success","is_error":false,"result":""}}
"#;

fn steer(id: &str, run_id: &str, mode: SendMode, tag: Option<&str>) -> SessionCall {
    SessionCall::Send {
        session_id: ThreadId::unchecked(id),
        run_id: NonEmpty::unchecked(run_id),
        text: NonEmpty::unchecked("S1 · the human steers you: skip the docs page"),
        mode,
        steer: tag.map(|t| SteerTag {
            id: SteerId::unchecked(t),
            riders: vec![],
        }),
    }
}

impl Hub {
    /// Every steer receipt up to the first final one.
    async fn receipts_until_final(&mut self) -> Vec<SteerReceipt> {
        let mut receipts = Vec::new();
        self.until(|frame| match frame {
            NodeToHub::MachineEvent(f) => match f.event {
                MachineEvent::Steer(r) => {
                    let last = r.stage.is_final();
                    receipts.push(r);
                    last.then_some(())
                }
                _ => None,
            },
            _ => None,
        })
        .await;
        receipts
    }
}

#[tokio::test(start_paused = true)]
async fn a_steer_mid_turn_supersedes_the_run_and_its_receipts_follow_claudes_frames() {
    let dir = tempfile::tempdir().unwrap();
    let mut runner = FakeRunner::from_lines(STEER_TURNS);
    runner.timed = true;
    let mut hub = hub(dir.path(), NodeStore::open_memory(10_000).unwrap(), runner).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    hub.summary(|s| s.active_run_id.as_deref() == Some("r1"))
        .await;
    tokio::time::sleep(Duration::from_secs(2)).await;

    let SessionOutput::Sent(sent) = hub.ok(steer("s1", "r2", SendMode::Now, Some("S1"))).await
    else {
        panic!("not sent")
    };
    assert!(sent.queued);
    assert_eq!(sent.send_now, Some(SendNow::Stopped));
    let receipts = hub.receipts_until_final().await;
    let stages: Vec<_> = receipts.iter().map(|r| (r.stage, r.how)).collect();
    assert_eq!(
        stages,
        [
            (SteerStage::Delivered, Some(DeliveredHow::Stopped)),
            (SteerStage::Acknowledged, None),
        ]
    );
    assert_eq!(
        receipts[1].excerpt.as_deref(),
        Some("Dropping the docs page")
    );
    hub.settled("r2").await;
    let runs = hub.service.store().runs("s1").unwrap();
    assert_eq!(runs[0].status, RunStatus::Interrupted);
    assert_eq!(runs[0].superseded_by.as_deref(), Some("r2"));

    // A steer whose run ends without a reply is unacknowledged.
    hub.ok(steer("s1", "r3", SendMode::Boundary, Some("S2")))
        .await;
    let receipts = hub.receipts_until_final().await;
    let stages: Vec<_> = receipts.iter().map(|r| (r.stage, r.how)).collect();
    assert_eq!(
        stages,
        [
            (SteerStage::Delivered, Some(DeliveredHow::Turn)),
            (SteerStage::Unacknowledged, None),
        ]
    );
    assert_eq!(receipts[1].excerpt, None);
}

#[tokio::test(start_paused = true)]
async fn a_queued_steer_can_be_withdrawn_and_the_session_does_not_read_as_interrupted() {
    let dir = tempfile::tempdir().unwrap();
    let mut runner = FakeRunner::from_lines(STEER_TURNS);
    runner.timed = true;
    let mut hub = hub(dir.path(), NodeStore::open_memory(10_000).unwrap(), runner).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    hub.summary(|s| s.active_run_id.as_deref() == Some("r1"))
        .await;
    // Plain, so the fake keeps it queued behind the turn.
    hub.ok(steer("s1", "r2", SendMode::Plain, Some("S1"))).await;
    let withdraw = SessionCall::Withdraw {
        session_id: ThreadId::unchecked("s1"),
        run_id: NonEmpty::unchecked("r2"),
    };
    assert_eq!(
        hub.ok(withdraw.clone()).await,
        SessionOutput::Withdrawn { cancelled: true }
    );
    let receipt = hub
        .until(|f| match f {
            NodeToHub::MachineEvent(f) => match f.event {
                MachineEvent::Steer(r) => Some(r),
                _ => None,
            },
            _ => None,
        })
        .await;
    assert_eq!(receipt.stage, SteerStage::Withdrawn);
    let done = hub.settled("r1").await;
    assert_eq!(done.status, SessionStatus::Idle);
    // Once it is gone (or started) there is nothing to withdraw.
    assert_eq!(
        hub.ok(withdraw).await,
        SessionOutput::Withdrawn { cancelled: false }
    );
}

#[tokio::test(start_paused = true)]
async fn a_steer_still_open_when_claude_exits_gets_its_final_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let mut runner = FakeRunner::from_lines(STEER_TURNS);
    runner.timed = true;
    let mut hub = hub(dir.path(), NodeStore::open_memory(10_000).unwrap(), runner).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    hub.summary(|s| s.active_run_id.as_deref() == Some("r1"))
        .await;
    // Plain, so the fake keeps it queued behind the turn; then the process goes.
    hub.ok(steer("s1", "r2", SendMode::Plain, Some("S1"))).await;
    hub.ok(SessionCall::Stop {
        session_id: ThreadId::unchecked("s1"),
        remove_worktree: false,
    })
    .await;
    let receipts = hub.receipts_until_final().await;
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].stage, SteerStage::Failed);
    assert!(
        receipts[0]
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("before taking it in")),
        "{receipts:?}"
    );
    assert!(hub.service.st().steers.is_empty());
}

#[tokio::test(start_paused = true)]
async fn each_steer_a_run_carries_gets_its_own_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let mut runner = FakeRunner::from_lines(STEER_TURNS);
    runner.timed = true;
    let mut hub = hub(dir.path(), NodeStore::open_memory(10_000).unwrap(), runner).await;
    hub.project(dir.path()).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    hub.summary(|s| s.active_run_id.as_deref() == Some("r1"))
        .await;
    // One message carrying S2 and, held before it, S1; its one reply acknowledges both.
    let SessionCall::Send {
        session_id,
        run_id,
        text,
        mode,
        ..
    } = steer("s1", "r2", SendMode::Now, None)
    else {
        unreachable!()
    };
    hub.ok(SessionCall::Send {
        session_id,
        run_id,
        text,
        mode,
        steer: Some(SteerTag {
            id: SteerId::unchecked("S2"),
            riders: vec![SteerId::unchecked("S1")],
        }),
    })
    .await;
    let mut finals = std::collections::BTreeMap::new();
    while finals.len() < 2 {
        let r = hub
            .until(|f| match f {
                NodeToHub::MachineEvent(f) => match f.event {
                    MachineEvent::Steer(r) => Some(r),
                    _ => None,
                },
                _ => None,
            })
            .await;
        assert_eq!(r.run_id, "r2");
        if r.stage.is_final() {
            finals.insert(r.steer_id.to_string(), r.stage);
        }
    }
    assert_eq!(finals["S1"], SteerStage::Acknowledged);
    assert_eq!(finals["S2"], SteerStage::Acknowledged);
}

#[test]
fn only_leads_and_workers_get_fleetds_agent_tools() {
    use fleetd_contracts::sessions::SessionRole;
    let sock = std::path::Path::new("/n/node.sock");
    let servers = |role| -> serde_json::Value {
        serde_json::from_str::<serde_json::Value>(&mcp_config(role, sock, "s1")).unwrap()["mcpServers"].clone()
    };
    assert_eq!(servers(SessionRole::Plain), serde_json::json!({}));
    let lead = servers(SessionRole::Lead);
    assert_eq!(
        lead["fleetd"]["args"],
        serde_json::json!(["agent-mcp", "--role", "lead"])
    );
    assert_eq!(lead["fleetd"]["env"]["FLEETD_NODE_SOCK"], "/n/node.sock");
    // Loaded at start, never behind tool search, for every role that has them.
    for role in [SessionRole::Lead, SessionRole::Worker] {
        assert_eq!(servers(role)["fleetd"]["alwaysLoad"], true);
    }
}
