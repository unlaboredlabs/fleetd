//! The session service over the fake runner, driven by `session_call` frames and read back from the frames it sends.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::ids::{ProjectId, ThreadId};
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::sessions::{
    FailureClass, ItemKind, ItemStatus, MachineEvent, MessageRole, PermissionDecision, RunFailure,
    RunStatus, SendMode, SendNow, SessionCall, SessionCallFrame, SessionErrorCode, SessionLaunch,
    SessionOutput, SessionResult, SessionStatus, SessionSummary, SessionWorkspace, ThreadEvent,
};
use fleetd_contracts::steer::{DeliveredHow, SteerId, SteerReceipt, SteerStage, SteerTag};
use tokio::sync::mpsc;

use super::fake::FakeRunner;
use super::{
    Attached, CONTINUE_PROMPT, SessionConfig, SessionService, compile_cache_env, mcp_config,
    parse_env_file,
};
use crate::node::runner::SessionCommand;
use crate::node::runner::claude::ALWAYS_DISALLOWED;
use crate::node::store::NodeStore;
use crate::node::wire::NodeToHub;
use crate::node::worktree::tests::{repo, run as git};

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
        auto_memory: false,
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
async fn a_project_that_opts_into_auto_memory_gets_neither_knob() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(
        dir.path().join("claude.env"),
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY=0\n",
    )
    .unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&root).await;
    let SessionCall::Launch(mut opted_in) =
        launch("s1", RuntimeMode::FullAccess, SessionWorkspace::Root)
    else {
        unreachable!()
    };
    opted_in.auto_memory = true;
    hub.ok(SessionCall::Launch(opted_in)).await;
    hub.settled("r1").await;
    let spec = &hub.runner.spawned()[0];
    let overlay: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(spec.settings.as_ref().unwrap()).unwrap())
            .unwrap();
    assert_eq!(overlay.get("autoMemoryEnabled"), None);
    assert_eq!(overlay["env"].get("CLAUDE_CODE_DISABLE_AUTO_MEMORY"), None);
    // The user's own value passes through untouched.
    let ours: Vec<_> = spec
        .env
        .iter()
        .filter(|(k, _)| k == "CLAUDE_CODE_DISABLE_AUTO_MEMORY")
        .collect();
    assert_eq!(
        ours,
        [&("CLAUDE_CODE_DISABLE_AUTO_MEMORY".to_owned(), "0".to_owned())]
    );
    // Its memory dir is the project's choice, not a broken knob.
    let SessionOutput::RunnerInfo(info) = hub.ok(SessionCall::RunnerInfo).await else {
        panic!("no runner info")
    };
    assert_eq!(info.auto_memory, None);
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

    let SessionOutput::Launched { summary } = hub
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
    // The fixture was recorded with auto memory on: its init names a memory dir, and runner_info says so.
    let SessionOutput::RunnerInfo(info) = hub.ok(SessionCall::RunnerInfo).await else {
        panic!("no runner info")
    };
    assert_eq!(info.auto_memory, Some(true));

    // A retried launch returns the same session without a second process.
    let again = hub
        .ok(launch(
            "s1",
            RuntimeMode::FullAccess,
            SessionWorkspace::Root,
        ))
        .await;
    assert!(
        matches!(again, SessionOutput::Launched { summary } if summary.latest_run.as_ref().unwrap().id == "r1")
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
        .map(|m| (m.role, m.text.as_str()))
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
    let failure = failed.latest_run.unwrap().failure.unwrap();
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
    assert_eq!(sends[1].1, CONTINUE_PROMPT);
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
            .any(|c| matches!(c, SessionCommand::Send { text, .. } if text == CONTINUE_PROMPT))
    );
    let runs = hub.service.store().runs("s1").unwrap();
    assert_eq!(runs[0].status, RunStatus::Interrupted);
    assert_eq!(*hub.service.running().borrow(), 0);
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
    assert_eq!(done.latest_run.unwrap().status, RunStatus::Completed);
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
            .any(|c| matches!(c, SessionCommand::Send { text, .. } if text == CONTINUE_PROMPT))
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
async fn a_removed_worktree_comes_back_at_the_same_path_when_the_session_resumes() {
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
    hub.settled("r1").await;
    let spawned = hub.runner.spawned();
    assert_eq!(spawned.len(), 1);
    assert!(spawned[0].resume);
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
{"dir":"out","ms":5,"msg":{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":"S1: dropping the docs page"}]}}}
{"dir":"out","ms":6,"msg":{"type":"result","subtype":"success","is_error":false,"result":"S1: dropping the docs page"}}
{"dir":"in","ms":0,"msg":{"type":"user","uuid":"s3"}}
{"dir":"out","ms":1,"msg":{"type":"command_lifecycle","command_uuid":"s3","state":"started"}}
{"dir":"out","ms":5,"msg":{"type":"assistant","message":{"id":"m3","content":[{"type":"text","text":"OK"}]}}}
{"dir":"out","ms":6,"msg":{"type":"result","subtype":"success","is_error":false,"result":"OK"}}
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
        Some("S1: dropping the docs page")
    );
    hub.settled("r2").await;
    let runs = hub.service.store().runs("s1").unwrap();
    assert_eq!(runs[0].status, RunStatus::Interrupted);
    assert_eq!(runs[0].superseded_by.as_deref(), Some("r2"));

    // A steer whose reply does not name it is unacknowledged, with that reply.
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
    assert_eq!(receipts[1].excerpt.as_deref(), Some("OK"));
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
    // One message carrying S2 and, held before it, S1; the reply names only S1.
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
    assert_eq!(finals["S2"], SteerStage::Unacknowledged);
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
}
