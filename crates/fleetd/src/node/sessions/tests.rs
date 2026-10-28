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
use crate::node::runner::claude::failure::RETRY_MESSAGE;
use crate::node::store::NodeStore;
use crate::node::wire::NodeToHub;
use crate::node::worktree::tests::{cloned, repo, run as git};

#[path = "env_tests.rs"]
mod env_tests;

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
        // As a hub from before profiles sends it: the runner reads the profile off the model and effort.
        profile: None,
        model: Some(NonEmpty::unchecked("claude-haiku-5-5")),
        effort: Some(Effort::Low),
        fast: false,
        helper_model: None,
        runtime_mode: mode,
        workspace,
        prompt: NonEmpty::unchecked("Reply with the word OK and nothing else."),
        run_id: NonEmpty::unchecked("r1"),
        allowed_tools: vec!["Bash(npm test:*)".into()],
        disallowed_tools: vec!["WebFetch".into()],
        allowed_only: false,
        role: fleetd_contracts::sessions::SessionRole::Worker,
        mcp_role: None,
        mcp: None,
        skills: Vec::new(),
        order_id: None,
        setup: None,
        claude_account: None,
    })
}

fn send(id: &str, run_id: &str) -> SessionCall {
    SessionCall::Send {
        session_id: ThreadId::unchecked(id),
        run_id: NonEmpty::unchecked(run_id),
        text: NonEmpty::unchecked("Reply with the word TWO and nothing else."),
        mode: SendMode::Plain,
        steer: None,
        mcp: None,
        skills: None,
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
    assert_eq!(spec.sandbox, None, "only a Navi's session is sandboxed");
    // A task's session gets fleetd's agent MCP server with the worker's tools, naming the session.
    let mcp: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(spec.mcp_config.as_ref().unwrap()).unwrap())
            .unwrap();
    assert_eq!(
        mcp["mcpServers"]["fleetd"]["args"],
        serde_json::json!(["agent-mcp", "--role", "worker"])
    );
    assert_eq!(mcp["mcpServers"]["fleetd"]["env"]["FLEETD_THREAD_ID"], "s1");
    for tool in ALWAYS_DISALLOWED
        .iter()
        .chain(crate::node::runner::claude::AGENT_DISALLOWED)
    {
        assert!(spec.disallowed_tools.iter().any(|t| t == tool), "{tool}");
    }
    // A task's agent edits files; only a lead is kept from it.
    assert!(!spec.disallowed_tools.iter().any(|t| t == "Edit"));
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
    // No one command outlives that cache.
    assert_eq!(last("BASH_MAX_TIMEOUT_MS"), Some("280000"));
    assert_eq!(overlay["env"]["BASH_MAX_TIMEOUT_MS"], "280000");

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
async fn a_session_held_to_its_allowed_tools_has_any_other_refused_by_the_node() {
    let dir = tempfile::tempdir().unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("permission-deny"),
    )
    .await;
    hub.project(dir.path()).await;
    let SessionCall::Launch(held) = launch("s1", RuntimeMode::FullAccess, SessionWorkspace::Root)
    else {
        unreachable!()
    };
    // As the nightly memory refresh starts: its memory tools only.
    hub.ok(SessionCall::Launch(SessionLaunch {
        allowed_tools: vec!["mcp__fleetd__memory_read".into()],
        allowed_only: true,
        ..held
    }))
    .await;
    // claude asks for Bash; the node refuses it at once, and nothing waits on a person.
    let done = hub.settled("r1").await;
    assert_eq!(done.latest_assistant_tail.as_deref(), Some("DENIED"));
    assert_eq!(done.pending_permission, None);
    let answers: Vec<_> = hub
        .runner
        .received()
        .into_iter()
        .filter_map(|c| match c {
            SessionCommand::Answer { decision, by, .. } => Some((decision, by)),
            _ => None,
        })
        .collect();
    assert!(
        matches!(
            answers.as_slice(),
            [(PermissionDecision::Deny { message }, Some(fleetd_contracts::time::DecidedBy::Policy))]
                if message.as_str().contains("Bash")
        ),
        "{answers:?}"
    );
    // claude is told so, and every start of the process is.
    let spec = &hub.runner.spawned()[0];
    assert!(spec.allowed_only);
    assert_eq!(spec.allowed_tools, ["mcp__fleetd__memory_read"]);
    let row = hub.service.store().session("s1").unwrap().unwrap();
    assert!(row.local.allowed_only);
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
    for key in ["TMPDIR", "TMP", "TEMP", "CLAUDE_CODE_TMPDIR"] {
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
        mcp: None,
        skills: None,
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
        remove_worktrees: false,
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

/// A project's plain and secret variables reach the claude of its next session, with only the secret's fingerprint
/// in the answer; the worktree list names one with uncommitted changes; and deleting the project with its worktrees
/// removes them and its variables, keeps its branch, and leaves the checkout exactly as it was.
#[tokio::test]
async fn project_env_reaches_a_new_session_and_deleting_the_project_leaves_the_checkout() {
    use fleetd_contracts::project_settings::{EnvValue, EnvVarName, EnvVarSet};
    let dir = tempfile::tempdir().unwrap();
    let (_, root) = cloned(dir.path(), "repo", "origin");
    // The human's own last fetch and work in progress in the checkout.
    git(&root, &["fetch", "-q", "origin"]);
    std::fs::write(root.join("a.txt"), "edited\n").unwrap();
    std::fs::write(root.join("mine.txt"), "mine\n").unwrap();
    let home = dir.path().join("node");
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&root).await;
    let name = |n: &str| EnvVarName::new(n).unwrap();
    let saved = hub
        .ok(SessionCall::ProjectEnv {
            project_id: ProjectId::unchecked("p1"),
            set: vec![
                EnvVarSet::Plain {
                    name: name("API_URL"),
                    value: EnvValue::new("https://staging.example").unwrap(),
                },
                EnvVarSet::Secret {
                    name: name("STRIPE_KEY"),
                    sealed: crate::node::project_env::seal(&home, "sk_test_4242"),
                },
            ],
            remove: vec![],
        })
        .await;
    let SessionOutput::ProjectEnv { secrets } = &saved else {
        panic!("{saved:?}")
    };
    assert_eq!(secrets.len(), 1);
    assert_eq!(
        secrets[0].fingerprint.as_str(),
        crate::node::secrets::fingerprint_of(b"sk_test_4242")
    );
    assert!(
        !serde_json::to_string(&saved)
            .unwrap()
            .contains("sk_test_4242")
    );

    let branch = "fleetd/T1-env";
    hub.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Worktree {
            base_ref: NonEmpty::unchecked("main"),
            branch: NonEmpty::unchecked(branch),
            from_session: None,
        },
    ))
    .await;
    hub.settled("r1").await;
    let spec = hub.runner.spawned()[0].clone();
    let var = |k: &str| {
        spec.env
            .iter()
            .rev()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(var("API_URL"), Some("https://staging.example"));
    assert_eq!(var("STRIPE_KEY"), Some("sk_test_4242"));
    assert_eq!(var("FLEETD_THREAD_ID"), Some("s1"));

    std::fs::write(spec.cwd.join("wip.txt"), "not committed\n").unwrap();
    let listed = hub
        .ok(SessionCall::ProjectWorktrees {
            project_id: ProjectId::unchecked("p1"),
        })
        .await;
    let SessionOutput::ProjectWorktrees(listed) = listed else {
        panic!("{listed:?}")
    };
    assert_eq!(listed.dir, home.join("worktrees/p1").to_string_lossy());
    assert_eq!(listed.base_branch.as_deref(), Some("main"));
    assert_eq!(listed.worktrees.len(), 1);
    assert_eq!(listed.worktrees[0].branch.as_deref(), Some(branch));
    assert!(listed.worktrees[0].uncommitted);

    // The person's own worktree, on a drive that isn't mounted now: git's record of it must stay.
    let theirs = dir.path().join("usb/storefront-hotfix");
    git(
        &root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "hotfix",
            &theirs.to_string_lossy(),
        ],
    );
    std::fs::remove_dir_all(dir.path().join("usb")).unwrap();
    let before = checkout_state(&root);
    assert_eq!(
        hub.ok(SessionCall::ProjectRemove {
            project_id: ProjectId::unchecked("p1"),
            remove_worktrees: true,
        })
        .await,
        SessionOutput::Done
    );
    assert!(!spec.cwd.exists());
    assert!(!home.join("worktrees/p1").exists());
    assert_eq!(checkout_state(&root), before);
    // Its branch stays, so its commits do; git keeps no record of fleetd's worktree, and still has the person's.
    git(
        &root,
        &["rev-parse", "--verify", &format!("refs/heads/{branch}")],
    );
    let worktrees =
        crate::node::worktree::git(&root, &["worktree", "list", "--porcelain"]).unwrap();
    assert_eq!(worktrees.matches("worktree ").count(), 2, "{worktrees}");
    assert!(worktrees.contains("storefront-hotfix"), "{worktrees}");
    assert!(!worktrees.contains("/worktrees/p1/"), "{worktrees}");
    assert!(crate::node::project_env::vars(&home, "p1").is_empty());
}

/// A project whose root is a plain folder, not a git repository (a Navi's): deleting it with its worktrees stops its
/// claude, removes fleetd's own directory for it and forgets it, with no git worktree cleanup to fail; its folder
/// stays as it was.
#[tokio::test]
async fn deleting_a_plain_folder_project_with_its_worktrees_skips_git() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("navi/adri");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("notes.md"), "mine\n").unwrap();
    let home = dir.path().join("node");
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("permission-allow"),
    )
    .await;
    hub.project(&folder).await;
    hub.ok(launch(
        "s1",
        RuntimeMode::ApprovalRequired,
        SessionWorkspace::Root,
    ))
    .await;
    hub.summary(|s| s.status == SessionStatus::Waiting).await;
    let leftover = home.join("worktrees/p1/T1");
    std::fs::create_dir_all(&leftover).unwrap();

    let remove = || SessionCall::ProjectRemove {
        project_id: ProjectId::unchecked("p1"),
        remove_worktrees: true,
    };
    assert_eq!(hub.ok(remove()).await, SessionOutput::Done);
    assert_eq!(hub.settled("r1").await.status, SessionStatus::Interrupted);
    assert!(!home.join("worktrees/p1").exists());
    assert_eq!(
        std::fs::read_to_string(folder.join("notes.md")).unwrap(),
        "mine\n"
    );
    assert!(!folder.join(".git").exists());
    let SessionResult::Err(gone) = hub.call(remove()).await else {
        panic!("removed the same project twice")
    };
    assert_eq!(gone.code, SessionErrorCode::NotFound);
}

/// A Navi's browser profile (D221): forgetting its sign-ins deletes it, deleting the Navi does too, and another Navi's
/// stays.
#[tokio::test]
async fn forgetting_a_navis_sign_ins_or_deleting_it_deletes_its_browser_profile() {
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("navi/ada");
    std::fs::create_dir_all(&folder).unwrap();
    let home = dir.path().join("node");
    let hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("permission-allow"),
    )
    .await;
    hub.project(&folder).await;
    let kept = |navi: &str| crate::node::browser::chrome::kept_dir(&home, navi).unwrap();
    let sign_in = |navi: &str| {
        std::fs::create_dir_all(kept(navi).join("Default")).unwrap();
        std::fs::write(kept(navi).join("Default/Cookies"), "who=ada").unwrap();
    };
    sign_in("p1");
    sign_in("bee");

    let forget = || SessionCall::NaviSigninsForget {
        project_id: ProjectId::unchecked("p1"),
    };
    assert_eq!(hub.ok(forget()).await, SessionOutput::Done);
    assert!(!kept("p1").exists());
    assert_eq!(
        hub.ok(forget()).await,
        SessionOutput::Done,
        "nothing to forget"
    );
    sign_in("p1");
    assert_eq!(
        hub.ok(SessionCall::ProjectRemove {
            project_id: ProjectId::unchecked("p1"),
            remove_worktrees: false,
        })
        .await,
        SessionOutput::Done
    );
    assert!(!kept("p1").exists());
    assert!(
        kept("bee").join("Default/Cookies").is_file(),
        "another Navi's stays"
    );
    let SessionResult::Err(gone) = hub.call(forget()).await else {
        panic!("forgot a removed project's sign-ins")
    };
    assert_eq!(gone.code, SessionErrorCode::NotFound);
}

/// The recorded `echo hi` turn, as a `printenv` that prints `printed` and a reply that repeats it.
fn printenv_turn(printed: &str) -> String {
    fn swap(v: &mut serde_json::Value, printed: &str) {
        match v {
            serde_json::Value::String(s) if s == "hi" => *s = printed.to_owned(),
            serde_json::Value::String(s) if s == "echo hi" => *s = "printenv".to_owned(),
            serde_json::Value::Array(a) => a.iter_mut().for_each(|v| swap(v, printed)),
            serde_json::Value::Object(o) => o.values_mut().for_each(|v| swap(v, printed)),
            _ => {}
        }
    }
    let fixture = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/node/runner/fixtures/claude-2.1.302-allowlisted-tool.jsonl"),
    )
    .unwrap();
    fixture
        .lines()
        .map(|line| {
            let mut v: serde_json::Value = serde_json::from_str(line).unwrap();
            swap(&mut v, printed);
            format!("{v}\n")
        })
        .collect()
}

/// A secret rotated (or removed) while its session's claude lives on is still in that process's environment: what it
/// prints in a later run is masked as the value it was started with, not only as the file's value now.
#[tokio::test]
async fn a_secret_rotated_mid_session_stays_masked_as_the_process_holds_it() {
    use fleetd_contracts::project_settings::{EnvVarName, EnvVarSet};
    let (old, new) = ("sk_live_old_9f2c41", "sk_live_new_7d03aa");
    let printed = format!("STRIPE_KEY={old}\n");
    // Two runs in one process, each printing the value the process was started with.
    let lines = format!("{}{}", printenv_turn(&printed), printenv_turn(&printed));
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("node");
    let mut node = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::from_lines(&lines),
    )
    .await;
    node.project(dir.path()).await;
    let set = |value: &str| SessionCall::ProjectEnv {
        project_id: ProjectId::unchecked("p1"),
        set: vec![EnvVarSet::Secret {
            name: EnvVarName::new("STRIPE_KEY").unwrap(),
            sealed: crate::node::project_env::seal(&home, value),
        }],
        remove: vec![],
    };
    node.ok(set(old)).await;
    node.ok(launch(
        "s1",
        RuntimeMode::FullAccess,
        SessionWorkspace::Root,
    ))
    .await;
    node.ok(SessionCall::Follow {
        session_id: ThreadId::unchecked("s1"),
    })
    .await;
    node.settled("r1").await;
    node.ok(set(new)).await;
    node.ok(send("s1", "r2")).await;
    let mut frames = Vec::new();
    tokio::time::timeout(Duration::from_secs(600), async {
        loop {
            let raw = node.rx.recv().await.unwrap();
            let done = matches!(serde_json::from_str(&raw).unwrap(), NodeToHub::MachineEvent(f)
                if matches!(&f.event, MachineEvent::SessionUpdated(s)
                    if s.active_run_id.is_none() && s.latest_run.as_ref().is_some_and(|r| r.id == "r2")));
            frames.push(raw);
            if done {
                break;
            }
        }
    })
    .await
    .expect("the second run never settled");
    assert_eq!(
        node.runner.spawned().len(),
        1,
        "the second run is the same process"
    );
    let frames = frames.join("\n");
    assert!(frames.contains("***STRIPE_KEY***"), "{frames}");
    assert!(!frames.contains(old), "the rotated value left the node");
}

/// A command that prints a project's secret (`printenv`), or its order's, gets it to neither the hub nor the app: the
/// node masks the value, its base64 and its URL encoding in the tool's output, the live text and the reply before any
/// frame leaves, and a real hub fed every frame the node sent keeps it in no row and returns it in no answer.
#[tokio::test]
async fn a_printed_secret_never_leaves_the_node() {
    use base64::Engine;
    use fleetd_contracts::project_settings::{EnvVarName, EnvVarSet};
    let secret = "sk_live_51/Hx+Qe9=";
    let forms = [
        secret.to_owned(),
        base64::engine::general_purpose::STANDARD.encode(secret),
        "sk_live_51%2FHx%2BQe9%3D".to_owned(),
    ];
    let chain = crate::node::project_env::tests::PEM;
    let order_secret = "pw-order-only-6f1d";
    let printed = format!(
        "HOME=/home/w\nSTRIPE_KEY={}\nSTRIPE_KEY_B64={}\nCALLBACK=https://pay.test/cb?key={}\nTLS_CHAIN={chain}\nDB_PASSWORD={order_secret}\n",
        forms[0], forms[1], forms[2]
    );
    // Every line of the chain but its armor is secret, and so is the chain whole.
    let forms: Vec<String> = forms
        .into_iter()
        .chain([chain.to_owned(), order_secret.to_owned()])
        .chain(
            chain
                .lines()
                .filter(|l| !l.starts_with("-----"))
                .map(str::to_owned),
        )
        .collect();
    let lines = printenv_turn(&printed);
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("node");
    let mut node = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::from_lines(&lines),
    )
    .await;
    node.project(dir.path()).await;
    node.ok(SessionCall::ProjectEnv {
        project_id: ProjectId::unchecked("p1"),
        set: vec![
            EnvVarSet::Secret {
                name: EnvVarName::new("STRIPE_KEY").unwrap(),
                sealed: crate::node::project_env::seal(&home, secret),
            },
            EnvVarSet::Secret {
                name: EnvVarName::new("TLS_CHAIN").unwrap(),
                sealed: crate::node::project_env::seal(&home, chain),
            },
        ],
        remove: vec![],
    })
    .await;
    env_tests::deliver(&home, "W1", "DB_PASSWORD", order_secret);

    // A real hub on the other end of the link: its calls go to the node, and every frame the node sends goes to it.
    let hub_home = tempfile::tempdir().unwrap();
    let central = crate::hub::serve::build_on(
        crate::hub::store::HubDb::open_memory().unwrap(),
        crate::hub::api::HubConfig {
            home: hub_home.path().to_path_buf(),
            listen: Default::default(),
            url: None,
            queue_ttl_sec: None,
        },
        crate::hub::store::test_clock::ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    let lab = fleetd_contracts::ids::MachineId::unchecked("lab");
    let at = "2026-10-19T10:00:00.000Z";
    central
        .store
        .machine_upsert(
            &serde_json::from_value(
                serde_json::json!({ "machineId": "lab", "name": "lab", "tags": [],
                "status": "online", "lastSeenAt": at, "nodeVersion": "0.1.0" }),
            )
            .unwrap(),
            None,
        )
        .unwrap();
    let (to_node, mut calls) = mpsc::unbounded_channel();
    let (service, answer, m) = (node.service.clone(), central.clone(), lab.clone());
    tokio::spawn(async move {
        while let Some(frame) = calls.recv().await {
            let fleetd_contracts::node_link::HubToNode::SessionCall(call) = frame else {
                continue;
            };
            let (service, answer, m) = (service.clone(), answer.clone(), m.clone());
            tokio::spawn(async move {
                let reply = service.handle(call).await;
                answer
                    .executors
                    .handle_frame(&m, NodeToHub::SessionReply(reply));
            });
        }
    });
    let (sent_tx, mut sent) = mpsc::unbounded_channel::<String>();
    let mut outlet = std::mem::replace(&mut node.rx, mpsc::unbounded_channel().1);
    let (forward, m) = (central.clone(), lab.clone());
    tokio::spawn(async move {
        while let Some(raw) = outlet.recv().await {
            forward
                .executors
                .handle_frame(&m, serde_json::from_str(&raw).unwrap());
            let _ = sent_tx.send(raw);
        }
    });
    central
        .executors
        .attach(
            &lab,
            crate::hub::executor::NodeSessions {
                link_id: 1,
                send: to_node,
            },
        )
        .await;
    central.executors.await_live(&lab).await;

    let mut started = launch("s1", RuntimeMode::FullAccess, SessionWorkspace::Root);
    if let SessionCall::Launch(l) = &mut started {
        l.order_id = Some(fleetd_contracts::ledger::WorkstreamId::unchecked("W1"));
    }
    node.ok(started).await;
    node.ok(SessionCall::Follow {
        session_id: ThreadId::unchecked("s1"),
    })
    .await;
    let mut frames = Vec::new();
    tokio::time::timeout(Duration::from_secs(600), async {
        loop {
            let raw = sent.recv().await.unwrap();
            let done = matches!(serde_json::from_str(&raw).unwrap(), NodeToHub::MachineEvent(f)
                if matches!(&f.event, MachineEvent::SessionUpdated(s)
                    if s.active_run_id.is_none() && s.latest_run.as_ref().is_some_and(|r| r.id == "r1")));
            frames.push(raw);
            if done {
                break;
            }
        }
    })
    .await
    .expect("the run never settled");

    let person = {
        let c = serde_json::from_value::<crate::hub::api::Caller>(serde_json::json!({
            "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": at,
            "grants": [{ "role": "operate", "machines": "*" }],
        }))
        .unwrap();
        crate::hub::api::Caller {
            kind: Some(fleetd_contracts::auth::KeyKind::Human),
            ..c
        }
    };
    let mut answers = String::new();
    for (tool, input) in [
        (
            "thread_tail",
            serde_json::json!({ "machineId": "lab", "threadId": "s1", "n": 50 }),
        ),
        (
            "actions_list",
            serde_json::json!({ "machineId": "lab", "threadId": "s1" }),
        ),
    ] {
        let out = crate::hub::api::registry()
            .call(&central, &person, tool, input)
            .await
            .unwrap();
        answers.push_str(&out.to_string());
    }
    let rows = central
        .db
        .with(|c| {
            let tables: Vec<String> = c
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut out = String::new();
            for table in tables {
                let mut stmt = c.prepare(&format!("SELECT * FROM \"{table}\""))?;
                let n = stmt.column_count();
                let mut rows = stmt.query([])?;
                while let Some(row) = rows.next()? {
                    for i in 0..n {
                        if let rusqlite::types::ValueRef::Text(t) = row.get_ref(i)? {
                            out.push_str(&String::from_utf8_lossy(t));
                        }
                    }
                }
            }
            Ok(out)
        })
        .unwrap();
    let frames = frames.join("\n");
    // The output got through, named.
    assert!(frames.contains("***STRIPE_KEY***"), "{frames}");
    assert!(frames.contains("***TLS_CHAIN***"), "{frames}");
    assert!(frames.contains("***DB_PASSWORD***"), "{frames}");
    assert!(answers.contains("***STRIPE_KEY***"), "{answers}");
    for form in &forms {
        assert!(!frames.contains(form.as_str()), "a frame carried {form}");
        assert!(!answers.contains(form.as_str()), "the hub answered {form}");
        assert!(!rows.contains(form.as_str()), "a hub row holds {form}");
    }
    // The agent itself still got the real values, newlines and all.
    assert!(
        node.runner.spawned()[0]
            .env
            .iter()
            .any(|(k, v)| k == "STRIPE_KEY" && v == secret)
    );
    assert!(
        node.runner.spawned()[0]
            .env
            .iter()
            .any(|(k, v)| k == "TLS_CHAIN" && v == chain)
    );
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
fn the_prompt_cache_ttl_follows_the_role_then_the_env() {
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
    let setup = crate::node::runner::claude::setup::proxy_of(&env).unwrap();
    assert_eq!(setup.0, "http://127.0.0.1:9");
    assert!(setup.1.ends_with("claude.env"), "{}", setup.1);

    let dedicated = SessionConfig {
        config_dir: Some(dir.path().join("profile")),
        ..own
    };
    assert_eq!(
        crate::node::runner::claude::setup::config_dir(&dedicated.runner_env()),
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
        mcp: None,
        skills: None,
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
        mcp: None,
        skills: None,
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

/// `fleetd update` replaces the binary while the node runs on (W23): every session spawned after that still gets a
/// fleetd agent server claude can start, the node's own binary, not the one now at its path. This test binary plays
/// the node: a copy of it runs [`agent_server_child`], and the copy is replaced on disk under it.
#[cfg(target_os = "linux")]
#[test]
fn the_agent_server_starts_after_an_update_replaced_the_node_binary() {
    use std::io::Write;
    // A hard link, not a copy: a copy's write fd leaks into whatever another test thread forks meanwhile, and exec
    // of a file open for writing fails (`ETXTBSY`). The link lives beside this binary, on its filesystem.
    let exe = std::env::current_exe().unwrap();
    let dir = tempfile::tempdir_in(exe.parent().unwrap()).unwrap();
    let node = dir.path().join("fleetd");
    std::fs::hard_link(&exe, &node).unwrap();
    let child = format!(
        "{}::agent_server_child",
        module_path!().split_once("::").unwrap().1
    );
    let mut run = std::process::Command::new(&node)
        .args([
            &child,
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("FLEETD_TEST_AGENT_SERVER_CHILD", "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    // As `fleetd update` installs: a new file renamed over the running one. What runs at the path now fails.
    let new = dir.path().join("fleetd.new");
    std::fs::write(&new, "#!/bin/sh\nexit 3\n").unwrap();
    std::fs::set_permissions(&new, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    std::fs::rename(&new, &node).unwrap();
    run.stdin.take().unwrap().write_all(b"go\n").unwrap();
    let out = run.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success() && text.contains("1 passed"),
        "{text}{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// The node's side of the test above: once its binary is replaced, the command its sessions get starts, and it is
/// this binary still (a test binary lists its tests).
#[test]
#[ignore = "run by the_agent_server_starts_after_an_update_replaced_the_node_binary"]
fn agent_server_child() {
    use fleetd_contracts::sessions::SessionRole;
    if std::env::var_os("FLEETD_TEST_AGENT_SERVER_CHILD").is_none() {
        return;
    }
    std::io::stdin().read_line(&mut String::new()).unwrap();
    let config: serde_json::Value = serde_json::from_str(&mcp_config(
        SessionRole::Worker,
        Path::new("/n/node.sock"),
        "s1",
    ))
    .unwrap();
    let command = config["mcpServers"]["fleetd"]["command"].as_str().unwrap();
    let listed = std::process::Command::new(command)
        .args(["--list", "--ignored"])
        .output()
        .unwrap_or_else(|e| panic!("claude can't start {command:?}: {e}"));
    assert!(
        listed.status.success(),
        "{command:?} is not this binary: {listed:?}"
    );
    assert!(String::from_utf8_lossy(&listed.stdout).contains("agent_server_child"));
}

/// The `--mcp-config` a session's claude starts with, as the node wrote it.
fn mcp_written(spec: &crate::node::runner::SessionSpec) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(spec.mcp_config.as_ref().unwrap()).unwrap())
        .unwrap()
}

fn mcp_session_config(
    user_servers: bool,
    url: &str,
) -> fleetd_contracts::mcp_servers::McpSessionConfig {
    serde_json::from_value(serde_json::json!({
        "userServers": user_servers,
        "servers": [{ "name": "docs", "secrets": { "kind": "global" },
            "roles": { "lead": false, "writers": true, "reviewers": false },
            "transport": { "type": "http", "url": url },
            "headers": [{ "kind": "plain", "name": "X-Team", "value": "core" }] }]
    }))
    .unwrap()
}

/// A launch's MCP servers are the session's from its first start; ones a later send carries apply at its next start,
/// while the claude running keeps the servers it started with. Off, the person's own servers stay out
/// (`--strict-mcp-config`) and fleetd's own tools are still there.
#[tokio::test]
async fn a_sessions_mcp_servers_change_at_its_next_start() {
    use fleetd_contracts::mcp_servers::McpAgentRole;
    let dir = tempfile::tempdir().unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(dir.path()).await;
    let SessionCall::Launch(mut l) = launch("s1", RuntimeMode::FullAccess, SessionWorkspace::Root)
    else {
        unreachable!()
    };
    l.mcp_role = Some(McpAgentRole::Writer);
    l.mcp = Some(mcp_session_config(true, "https://docs.example.com/mcp"));
    hub.ok(SessionCall::Launch(l)).await;
    hub.settled("r1").await;
    let first = hub.runner.spawned()[0].clone();
    let written = mcp_written(&first);
    assert_eq!(
        written["mcpServers"]["docs"],
        serde_json::json!({ "type": "http", "url": "https://docs.example.com/mcp", "headers": { "X-Team": "core" } })
    );
    assert_eq!(
        written["mcpServers"]["fleetd"]["args"],
        serde_json::json!(["agent-mcp", "--role", "worker"])
    );
    assert!(!first.strict_mcp);

    // The person turns their own servers off and moves the docs server; the session is stopped meanwhile.
    hub.ok(SessionCall::Stop {
        session_id: ThreadId::unchecked("s1"),
        remove_worktree: false,
    })
    .await;
    let SessionCall::Send {
        session_id,
        run_id,
        text,
        mode,
        steer,
        ..
    } = send("s1", "r2")
    else {
        unreachable!()
    };
    hub.ok(SessionCall::Send {
        session_id,
        run_id,
        text,
        mode,
        steer,
        mcp: Some(mcp_session_config(false, "https://docs2.example.com/mcp")),
        skills: None,
    })
    .await;
    hub.settled("r2").await;
    let spawned = hub.runner.spawned();
    assert_eq!(spawned.len(), 2, "the next start");
    let second = &spawned[1];
    assert!(second.strict_mcp, "--strict-mcp-config");
    let written = mcp_written(second);
    assert_eq!(
        written["mcpServers"]["docs"]["url"],
        "https://docs2.example.com/mcp"
    );
    assert_eq!(
        written["mcpServers"]["fleetd"]["args"],
        serde_json::json!(["agent-mcp", "--role", "worker"])
    );
    assert_eq!(
        crate::node::runner::claude::ClaudeRunner::new("claude".into())
            .args(second)
            .iter()
            .filter(|a| *a == "--strict-mcp-config")
            .count(),
        1
    );
}

/// done:0 end to end, a real hub on the link: a global and a project MCP server set through the hub's tools reach a
/// newly launched agent's `--mcp-config` for their roles only, a project's server replacing the global one of its name,
/// each secret resolved by the node, and neither secret in any hub row or answer.
#[tokio::test]
async fn configured_mcp_servers_reach_each_role_with_secrets_resolved_on_the_node_only() {
    use fleetd_contracts::mcp_servers::McpAgentRole;
    const TOKEN: &str = "Bearer ghp_only_on_the_node";
    const PASSWORD: &str = "pg-only-on-the-node";
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("node");
    let node = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    node.project(dir.path()).await;

    let hub_home = tempfile::tempdir().unwrap();
    let central = crate::hub::serve::build_on(
        crate::hub::store::HubDb::open_memory().unwrap(),
        crate::hub::api::HubConfig {
            home: hub_home.path().to_path_buf(),
            listen: Default::default(),
            url: None,
            queue_ttl_sec: None,
        },
        crate::hub::store::test_clock::ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    let lab = fleetd_contracts::ids::MachineId::unchecked("lab");
    let at = "2026-10-19T10:00:00.000Z";
    central
        .store
        .machine_upsert(
            &serde_json::from_value(
                serde_json::json!({ "machineId": "lab", "name": "lab", "tags": [],
                "status": "online", "lastSeenAt": at, "nodeVersion": "0.1.0" }),
            )
            .unwrap(),
            None,
        )
        .unwrap();
    let (to_node, mut calls) = mpsc::unbounded_channel();
    let (service, answer, m) = (node.service.clone(), central.clone(), lab.clone());
    tokio::spawn(async move {
        while let Some(frame) = calls.recv().await {
            let fleetd_contracts::node_link::HubToNode::SessionCall(call) = frame else {
                continue;
            };
            let (service, answer, m) = (service.clone(), answer.clone(), m.clone());
            tokio::spawn(async move {
                let reply = service.handle(call).await;
                answer
                    .executors
                    .handle_frame(&m, NodeToHub::SessionReply(reply));
            });
        }
    });
    let mut outlet = node.rx;
    let (forward, m) = (central.clone(), lab.clone());
    tokio::spawn(async move {
        while let Some(raw) = outlet.recv().await {
            forward
                .executors
                .handle_frame(&m, serde_json::from_str(&raw).unwrap());
        }
    });
    central
        .executors
        .attach(
            &lab,
            crate::hub::executor::NodeSessions {
                link_id: 1,
                send: to_node,
            },
        )
        .await;
    central.executors.await_live(&lab).await;
    central
        .link
        .set_capabilities(&lab, &[fleetd_contracts::node_link::CAP_MCP_SERVERS]);
    // Global servers are an owner's or admin's to save (D209): a device with admin on every machine.
    let person = {
        let c = serde_json::from_value::<crate::hub::api::Caller>(serde_json::json!({
            "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": at,
            "grants": [{ "role": "admin", "machines": "*" }],
        }))
        .unwrap();
        crate::hub::api::Caller {
            kind: Some(fleetd_contracts::auth::KeyKind::Human),
            ..c
        }
    };
    let mut answers = String::new();
    let project = serde_json::json!({ "kind": "project", "machineId": "lab", "projectId": "p1" });
    for input in [
        // Global, for the lead and writers, a secret header sealed to the machine as the app seals it.
        serde_json::json!({ "scope": { "kind": "global" }, "name": "github", "enabled": true,
            "roles": { "lead": true, "writers": true, "reviewers": false },
            "transport": { "type": "http", "url": "https://api.example.com/mcp" },
            "headers": [{ "kind": "secret", "name": "Authorization",
                "sealed": [{ "machineId": "lab", "sealed": crate::node::project_env::seal(&home, TOKEN) }] }] }),
        // Global search for everyone, which the project replaces with its own for writers only.
        serde_json::json!({ "scope": { "kind": "global" }, "name": "search", "enabled": true,
            "roles": { "lead": true, "writers": true, "reviewers": true },
            "transport": { "type": "sse", "url": "https://search.example.com/sse" } }),
        serde_json::json!({ "scope": project, "name": "search", "enabled": true,
            "roles": { "lead": false, "writers": true, "reviewers": false },
            "transport": { "type": "http", "url": "https://search.internal/mcp" } }),
        // The project's database for reviewers, a secret env variable.
        serde_json::json!({ "scope": project, "name": "db", "enabled": true,
            "roles": { "lead": false, "writers": false, "reviewers": true },
            "transport": { "type": "stdio", "command": "db-mcp", "args": ["--read-only"] },
            "env": [{ "kind": "secret", "name": "DB_PASSWORD",
                "sealed": [{ "machineId": "lab", "sealed": crate::node::project_env::seal(&home, PASSWORD) }] },
                { "kind": "plain", "name": "DB_HOST", "value": "localhost" }] }),
        // Off: nobody gets it.
        serde_json::json!({ "scope": { "kind": "global" }, "name": "off", "enabled": false,
            "roles": { "lead": true, "writers": true, "reviewers": true },
            "transport": { "type": "http", "url": "https://off.example.com/mcp" } }),
    ] {
        let out = crate::hub::api::registry()
            .call(&central, &person, "mcp_server_set", input)
            .await
            .unwrap();
        assert_eq!(out["missingOn"], serde_json::json!(null), "{out}");
        answers.push_str(&out.to_string());
    }
    let got = crate::hub::api::registry()
        .call(
            &central,
            &person,
            "mcp_servers_get",
            serde_json::json!({ "project": { "machineId": "lab", "projectId": "p1" } }),
        )
        .await
        .unwrap();
    assert_eq!(got["global"].as_array().unwrap().len(), 3);
    assert_eq!(got["project"].as_array().unwrap().len(), 2);
    answers.push_str(&got.to_string());

    let fleetd = |role: &str| -> serde_json::Value {
        let config: serde_json::Value = serde_json::from_str(&mcp_config(
            if role == "lead" {
                fleetd_contracts::sessions::SessionRole::Lead
            } else {
                fleetd_contracts::sessions::SessionRole::Worker
            },
            &crate::node::lead::lead_socket_path(&home),
            "SESSION",
        ))
        .unwrap();
        config["mcpServers"]["fleetd"].clone()
    };
    let mut written = std::collections::BTreeMap::new();
    for (n, (role, mcp_role)) in [
        ("lead", McpAgentRole::Lead),
        ("writer", McpAgentRole::Writer),
        ("reviewer", McpAgentRole::Reviewer),
    ]
    .into_iter()
    .enumerate()
    {
        let (thread, _) = central
            .executors
            .launch(
                &lab,
                &crate::hub::executor::LaunchInput {
                    project_id: ProjectId::unchecked("p1"),
                    prompt: "Reply with the word OK and nothing else.".into(),
                    profile: fleetd_contracts::effort::ProfileName::legacy(),
                    runtime_mode: RuntimeMode::FullAccess,
                    title: Some(role.into()),
                    client_request_id: format!("req-{role}"),
                },
                crate::hub::executor::LaunchOptions {
                    workspace: None,
                    role: if role == "lead" {
                        fleetd_contracts::sessions::SessionRole::Lead
                    } else {
                        fleetd_contracts::sessions::SessionRole::Worker
                    },
                    mcp_role: Some(mcp_role),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let spec = node.runner.spawned()[n].clone();
        assert_eq!(spec.session_id, thread.as_str());
        let mut config = mcp_written(&spec);
        // fleetd's own server names its session; compare it apart.
        let own = config["mcpServers"]
            .as_object_mut()
            .unwrap()
            .remove("fleetd")
            .unwrap();
        let mut expected = fleetd(role);
        expected["env"]["FLEETD_THREAD_ID"] = thread.as_str().into();
        assert_eq!(own, expected, "{role}");
        written.insert(role, config["mcpServers"].clone());
    }
    // The project's search replaces the global one in the project, for every role: the lead gets neither.
    assert_eq!(
        written["lead"],
        serde_json::json!({
            "github": { "type": "http", "url": "https://api.example.com/mcp", "headers": { "Authorization": TOKEN } },
        })
    );
    assert_eq!(
        written["writer"],
        serde_json::json!({
            "github": { "type": "http", "url": "https://api.example.com/mcp", "headers": { "Authorization": TOKEN } },
            "search": { "type": "http", "url": "https://search.internal/mcp", "headers": {} },
        })
    );
    assert_eq!(
        written["reviewer"],
        serde_json::json!({
            "db": { "type": "stdio", "command": "db-mcp", "args": ["--read-only"],
                    "env": { "DB_PASSWORD": PASSWORD, "DB_HOST": "localhost" } },
        })
    );
    // The file claude reads holds the secrets, so only the node's user may read it.
    let mode = std::os::unix::fs::PermissionsExt::mode(
        &std::fs::metadata(node.runner.spawned()[0].mcp_config.as_ref().unwrap())
            .unwrap()
            .permissions(),
    );
    assert_eq!(mode & 0o777, 0o600);

    let rows = central
        .db
        .with(|c| {
            let tables: Vec<String> = c
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut out = String::new();
            for table in tables {
                let mut stmt = c.prepare(&format!("SELECT * FROM \"{table}\""))?;
                let n = stmt.column_count();
                let mut rows = stmt.query([])?;
                while let Some(row) = rows.next()? {
                    for i in 0..n {
                        if let rusqlite::types::ValueRef::Text(t) = row.get_ref(i)? {
                            out.push_str(&String::from_utf8_lossy(t));
                            out.push('\n');
                        }
                    }
                }
            }
            Ok(out)
        })
        .unwrap();
    assert!(rows.contains("search.internal"), "the servers are stored");
    for secret in [TOKEN, PASSWORD] {
        assert!(!rows.contains(secret), "a hub row holds {secret}");
        assert!(!answers.contains(secret), "an answer holds {secret}");
    }
}

/// A new session gets a skill of the repo's `.agents/skills`, one of its `.claude/skills` and the hub's, from one
/// plugin claude loads for that session only, the first source winning on a name clash; claude's own copy of a name the
/// plugin has is turned off. The checkout is left as it was.
#[tokio::test]
async fn a_new_session_gets_the_repos_and_the_hubs_skills_the_first_source_winning() {
    use fleetd_contracts::skills::{SkillBundle, SkillFile, SkillOrigin};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("project");
    let put = |rel: &str, says: &str| {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let name = rel.split('/').nth(2).unwrap();
        std::fs::write(
            path,
            format!("---\nname: {name}\ndescription: {says}\n---\n"),
        )
        .unwrap();
    };
    put(".agents/skills/release/SKILL.md", "repo agents");
    put(".claude/skills/release/SKILL.md", "repo claude");
    put(".claude/skills/triage/SKILL.md", "repo claude");
    let bundle = |name: &str, origin, says: &str| SkillBundle {
        name: fleetd_contracts::skills::SkillName::unchecked(name),
        origin,
        files: fleetd_contracts::prim::List::unchecked(vec![SkillFile {
            path: fleetd_contracts::prim::Line::unchecked("SKILL.md"),
            text: fleetd_contracts::prim::Text::unchecked(format!(
                "---\nname: {name}\ndescription: {says}\n---\n"
            )),
        }]),
    };
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(&root).await;
    let mut call = launch("s1", RuntimeMode::FullAccess, SessionWorkspace::Root);
    if let SessionCall::Launch(l) = &mut call {
        l.skills = vec![
            bundle("triage", SkillOrigin::Project, "hub project"),
            bundle("release", SkillOrigin::Global, "hub global"),
            bundle("standup", SkillOrigin::Global, "hub global"),
        ];
    }
    hub.ok(call).await;
    hub.settled("r1").await;

    let spec = &hub.runner.spawned()[0];
    let plugin = dir.path().join("node/sessions/s1/plugin");
    assert_eq!(spec.plugin_dirs, std::slice::from_ref(&plugin));
    let args = crate::node::runner::claude::ClaudeRunner::new("claude".into()).args(spec);
    let at = args.iter().position(|a| a == "--plugin-dir").unwrap();
    assert_eq!(args[at + 1], plugin.display().to_string());
    let says = |name: &str| {
        let text =
            std::fs::read_to_string(plugin.join("skills").join(name).join("SKILL.md")).unwrap();
        fleetd_contracts::skills::description_of(&text)
    };
    assert_eq!(says("release"), "repo agents");
    assert_eq!(says("triage"), "repo claude");
    assert_eq!(says("standup"), "hub global");
    let overlay: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(spec.settings.as_ref().unwrap()).unwrap())
            .unwrap();
    assert_eq!(
        overlay["skillOverrides"],
        serde_json::json!({ "release": "off", "standup": "off", "triage": "off" })
    );
    // An agent keeps the Skill tool.
    assert!(!spec.disallowed_tools.iter().any(|t| t == "Skill"));
    // Nothing of fleetd's in the checkout.
    let mut top: Vec<_> = std::fs::read_dir(&root)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    top.sort();
    assert_eq!(top, [".agents", ".claude"]);

    // Settings > Skills reads the same checkout.
    let SessionOutput::Skills { skills } = hub
        .ok(SessionCall::SkillsList {
            project_id: ProjectId::unchecked("p1"),
        })
        .await
    else {
        panic!("no skills")
    };
    let listed: Vec<_> = skills
        .iter()
        .map(|s| (s.origin, s.name.as_str(), s.path.as_str()))
        .collect();
    assert_eq!(
        listed,
        [
            (
                SkillOrigin::RepoAgents,
                "release",
                ".agents/skills/release/SKILL.md"
            ),
            (
                SkillOrigin::RepoClaude,
                "release",
                ".claude/skills/release/SKILL.md"
            ),
            (
                SkillOrigin::RepoClaude,
                "triage",
                ".claude/skills/triage/SKILL.md"
            ),
        ]
    );
    // The session reads its skills folder by name.
    let skills_dir = plugin.join("skills");
    assert!(
        spec.env
            .iter()
            .any(|(k, v)| k == "FLEETD_SKILLS_DIR" && *v == skills_dir.to_string_lossy())
    );
    // A skill the hub adds later rides on the next send: in the folder at once, and kept for the next start; one
    // the hub dropped goes.
    let mut next = send("s1", "r2");
    if let SessionCall::Send { skills, .. } = &mut next {
        *skills = Some(vec![bundle(
            "deploy-check",
            SkillOrigin::Global,
            "hub global, later",
        )]);
    }
    hub.ok(next).await;
    hub.settled("r2").await;
    assert_eq!(says("deploy-check"), "hub global, later");
    assert!(!plugin.join("skills/standup").exists());
    assert_eq!(says("release"), "repo agents");
    let kept =
        std::fs::read_to_string(dir.path().join("node/sessions/s1/hub-skills.json")).unwrap();
    assert!(kept.contains("deploy-check") && !kept.contains("standup"));
}

/// A launch on `profile` with its model and effort, as a hub with profiles sends it.
fn profile_launch(
    id: &str,
    profile: &str,
    model: Option<&str>,
    effort: Option<Effort>,
) -> SessionCall {
    let SessionCall::Launch(launch) = launch(id, RuntimeMode::FullAccess, SessionWorkspace::Root)
    else {
        unreachable!()
    };
    SessionCall::Launch(SessionLaunch {
        profile: Some(fleetd_contracts::effort::ProfileName::unchecked(profile)),
        model: model.map(NonEmpty::unchecked),
        effort,
        helper_model: model.map(NonEmpty::unchecked),
        ..launch
    })
}

/// A spawn's settings overlay.
fn overlay(spec: &crate::node::runner::SessionSpec) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(spec.settings.as_ref().unwrap()).unwrap())
        .unwrap()
}

/// The model in a spawn's settings overlay for claude's helper calls.
fn helper_model(spec: &crate::node::runner::SessionSpec) -> String {
    overlay(spec)["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn a_profile_runs_on_what_its_settings_chose_else_on_its_own() {
    let (high, medium) = ("high", "medium");
    for (profile, model, effort, runs) in [
        // Nothing set: exactly as before settings.
        (high, None, None, ("claude-opus-5-5", Effort::High)),
        (medium, None, None, ("claude-opus-5-5", Effort::Medium)),
        // A setting's model and effort, and one field alone over the profile's own.
        (
            high,
            Some("claude-sonnet-5-5"),
            Some(Effort::Max),
            ("claude-sonnet-5-5", Effort::Max),
        ),
        (
            medium,
            None,
            Some(Effort::Low),
            ("claude-opus-5-5", Effort::Low),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let mut hub = hub(
            dir.path(),
            NodeStore::open_memory(10_000).unwrap(),
            FakeRunner::fixture("init-partial-two-turns"),
        )
        .await;
        hub.project(dir.path()).await;
        hub.ok(profile_launch("s1", profile, model, effort)).await;
        let done = hub.settled("r1").await;
        assert_eq!((done.model.as_str(), done.effort), runs, "{profile:?}");
        assert_eq!(done.model_refused, None);
        let spec = &hub.runner.spawned()[0];
        assert_eq!((spec.model.as_str(), spec.effort), runs);
        // claude's helper calls follow the default profile's model.
        let helper = model.unwrap_or("claude-opus-5-5");
        assert_eq!(
            (spec.helper_model.as_str(), helper_model(spec).as_str()),
            (helper, helper)
        );
        // Fast mode is left to the user's own settings.
        assert_eq!(overlay(spec).get("fastMode"), None);
    }
}

#[tokio::test]
async fn a_fast_profile_turns_claude_s_fast_mode_on_at_every_start() {
    let dir = tempfile::tempdir().unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    hub.project(dir.path()).await;
    let SessionCall::Launch(launch) =
        profile_launch("s1", "quick", Some("claude-opus-5-5"), Some(Effort::Low))
    else {
        unreachable!()
    };
    hub.ok(SessionCall::Launch(SessionLaunch {
        fast: true,
        ..launch
    }))
    .await;
    hub.settled("r1").await;
    let spec = &hub.runner.spawned()[0];
    assert_eq!(overlay(spec)["fastMode"], serde_json::Value::Bool(true));
    assert_eq!(
        (spec.model.as_str(), spec.effort),
        ("claude-opus-5-5", Effort::Low)
    );
}

#[tokio::test]
async fn a_model_claude_refuses_runs_the_profile_s_own_in_the_same_run_and_says_so() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = |name: &str| {
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "src/node/runner/fixtures/claude-2.1.302-{name}.jsonl"
        )))
        .unwrap()
    };
    // claude refuses the model, then answers on the profile's own.
    let lines = format!(
        "{}\n{}",
        fixture("invalid-model"),
        fixture("init-partial-two-turns")
    );
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::from_lines(&lines),
    )
    .await;
    hub.project(dir.path()).await;
    hub.ok(profile_launch(
        "s1",
        "high",
        Some("claude-does-not-exist-9"),
        Some(Effort::Max),
    ))
    .await;
    let done = hub.settled("r1").await;
    assert_eq!(done.latest_run.unwrap().status, RunStatus::Completed);
    // It runs on the profile's own model at its setting's effort, and names the model claude refused.
    assert_eq!(
        (
            done.model.as_str(),
            done.effort,
            done.model_refused.as_deref()
        ),
        (
            "claude-opus-5-5",
            Effort::Max,
            Some("claude-does-not-exist-9")
        )
    );
    let spawned = hub.runner.spawned();
    assert_eq!(spawned.len(), 2, "a new process for the new model");
    assert_eq!(spawned[0].model, "claude-does-not-exist-9");
    assert_eq!(spawned[1].model, "claude-opus-5-5");
    assert!(
        hub.service
            .store()
            .item("s1", "node-retry-r1-1")
            .unwrap()
            .is_some(),
        "the thread shows why"
    );
}

#[tokio::test]
async fn a_session_on_the_profile_s_own_model_fails_as_before() {
    let dir = tempfile::tempdir().unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("invalid-model"),
    )
    .await;
    hub.project(dir.path()).await;
    // A hub from before profiles names the model itself: nothing to fall back from.
    let SessionCall::Launch(old) = launch("s1", RuntimeMode::FullAccess, SessionWorkspace::Root)
    else {
        unreachable!()
    };
    hub.ok(SessionCall::Launch(SessionLaunch {
        model: Some(NonEmpty::unchecked("claude-does-not-exist-9")),
        ..old
    }))
    .await;
    let done = hub.settled("r1").await;
    assert_eq!(done.status, SessionStatus::Failed);
    assert_eq!(done.model_refused, None);
    assert_eq!(hub.runner.spawned().len(), 1);
}

#[tokio::test]
async fn a_refusal_of_another_model_than_the_session_s_never_falls_back() {
    let dir = tempfile::tempdir().unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("invalid-model"),
    )
    .await;
    hub.project(dir.path()).await;
    // The failure names claude-does-not-exist-9; the session runs on a gateway's own name.
    hub.ok(profile_launch("s1", "high", Some("gw-opus"), None))
        .await;
    let done = hub.settled("r1").await;
    assert_eq!(done.status, SessionStatus::Failed);
    assert_eq!((done.model.as_str(), done.model_refused), ("gw-opus", None));
    assert_eq!(hub.runner.spawned().len(), 1);
}

#[tokio::test]
async fn a_new_projects_folder_is_made_where_the_hub_says_and_a_relative_one_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    let folder = dir.path().join("fleetd/projects/notes");
    let path = folder.to_string_lossy().into_owned();
    let made = hub
        .ok(SessionCall::FolderMake {
            path: NonEmpty::unchecked(path.clone()),
            git_init: false,
            dry_run: false,
        })
        .await;
    assert_eq!(made, SessionOutput::Folder { path: path.clone() });
    assert!(folder.is_dir() && !folder.join(".git").exists());
    std::fs::write(folder.join("a.md"), "").unwrap();
    for bad in [path.as_str(), "notes", "/tmp/../etc/x"] {
        let refused = hub
            .call(SessionCall::FolderMake {
                path: NonEmpty::unchecked(bad),
                git_init: false,
                dry_run: true,
            })
            .await;
        assert!(matches!(refused, SessionResult::Err(_)), "{bad}");
    }
}

#[tokio::test]
async fn a_navi_gets_its_folder_under_the_node_home_and_its_lead_the_assistant_rules() {
    let dir = tempfile::tempdir().unwrap();
    let mut hub = hub(
        dir.path(),
        NodeStore::open_memory(10_000).unwrap(),
        FakeRunner::fixture("init-partial-two-turns"),
    )
    .await;
    let navis = Arc::new(NaviHooks::default());
    hub.service.set_browser(navis.clone());
    // A relative root is a folder under the node's home, made on demand; one that would leave it is refused.
    let made = hub
        .ok(SessionCall::ProjectUpsert {
            project_id: ProjectId::unchecked("p1"),
            title: NonEmpty::unchecked("Ada"),
            workspace_root: NonEmpty::unchecked("navi/ada"),
        })
        .await;
    let folder = dir.path().join("node/navi/ada");
    assert_eq!(
        made,
        SessionOutput::Folder {
            path: folder.to_string_lossy().into_owned()
        }
    );
    assert!(folder.is_dir());
    assert!(!folder.join(".git").exists());
    // The same Navi again keeps its folder; another project never takes it over.
    hub.ok(SessionCall::ProjectUpsert {
        project_id: ProjectId::unchecked("p1"),
        title: NonEmpty::unchecked("Ada"),
        workspace_root: NonEmpty::unchecked("navi/ada"),
    })
    .await;
    std::fs::create_dir_all(dir.path().join("node/navi/left")).unwrap();
    for (id, root) in [("p3", "navi/ada"), ("p4", "navi/left")] {
        let SessionResult::Err(e) = hub
            .call(SessionCall::ProjectUpsert {
                project_id: ProjectId::unchecked(id),
                title: NonEmpty::unchecked("x"),
                workspace_root: NonEmpty::unchecked(root),
            })
            .await
        else {
            panic!("{root} was taken over")
        };
        assert!(
            e.message
                .starts_with(fleetd_contracts::sessions::FOLDER_TAKEN),
            "{}",
            e.message
        );
    }
    for bad in ["../ada", "navi/../../ada", "navi/.hidden"] {
        let refused = hub
            .call(SessionCall::ProjectUpsert {
                project_id: ProjectId::unchecked("p2"),
                title: NonEmpty::unchecked("x"),
                workspace_root: NonEmpty::unchecked(bad),
            })
            .await;
        assert!(matches!(refused, SessionResult::Err(_)), "{bad}");
    }
    let SessionCall::Launch(mut navi) =
        launch("s1", RuntimeMode::ApprovalRequired, SessionWorkspace::Root)
    else {
        unreachable!()
    };
    navi.role = fleetd_contracts::sessions::SessionRole::Assistant;
    navi.disallowed_tools = vec![];
    hub.ok(SessionCall::Launch(navi)).await;
    hub.settled("r1").await;
    let spec = hub.runner.spawned()[0].clone();
    assert_eq!(spec.cwd, folder);
    // Its browser sessions run on the profile Navi p1 keeps (D221).
    assert_eq!(
        *navis.0.lock().unwrap(),
        [("s1".to_owned(), "p1".to_owned())]
    );
    assert_eq!(spec.runtime_mode, RuntimeMode::ApprovalRequired);
    // Nothing reads files or fetches unasked: every such call asks, above any allow rule, and the node or the hub
    // answers it.
    assert!(
        !spec
            .allowed_tools
            .iter()
            .any(|t| t == "Read" || t == "WebFetch")
    );
    let overlay: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(spec.settings.as_ref().unwrap()).unwrap())
            .unwrap();
    for tool in ["Read", "Write", "WebFetch"] {
        assert!(
            overlay["permissions"]["ask"]
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t == tool),
            "{tool}: {overlay}"
        );
    }
    // The project's own rules come first, then the role's.
    assert_eq!(spec.allowed_tools[0], "Bash(npm test:*)");
    assert!(spec.allowed_tools.iter().any(|t| t == "WebSearch"));
    for tool in ["Edit", "Write", "WebFetch", "WebSearch"] {
        assert!(!spec.disallowed_tools.iter().any(|t| t == tool), "{tool}");
    }
    // Its agent-browser reads only fleetd's empty config, outside its folder, never `./agent-browser.json`.
    let config = spec
        .env
        .iter()
        .find(|(k, _)| k == "AGENT_BROWSER_CONFIG")
        .map(|(_, v)| PathBuf::from(v))
        .expect("AGENT_BROWSER_CONFIG");
    assert!(!config.starts_with(&folder));
    assert_eq!(std::fs::read_to_string(&config).unwrap().trim(), "{}");
    // A lead's fleetd tools.
    let mcp: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(spec.mcp_config.as_ref().unwrap()).unwrap())
            .unwrap();
    assert_eq!(
        mcp["mcpServers"]["fleetd"]["args"],
        serde_json::json!(["agent-mcp", "--role", "lead"])
    );
    // It runs in its sandbox: writing its folder and scratch dir, never the node's home or another session's state.
    let fence = spec
        .sandbox
        .as_ref()
        .expect("a Navi's session is sandboxed");
    let real = crate::node::runner::sandbox::real;
    assert!(fence.write.contains(&real(&folder)));
    // Hidden by name, or by the home's tmpfs on Linux when the node's home is in it.
    let node = real(&dir.path().join("node"));
    assert!(fence.hide.iter().any(|h| node.starts_with(h)));
    assert!(!fence.write.iter().any(|w| w.ends_with(".claude")));
    let sockets = spec
        .env
        .iter()
        .find(|(k, _)| k == "AGENT_BROWSER_SOCKET_DIR")
        .map(|(_, v)| PathBuf::from(v))
        .expect("AGENT_BROWSER_SOCKET_DIR");
    assert!(fence.write.iter().any(|w| sockets.starts_with(w)));
    // Nor any variable naming a socket outside it: D-Bus, systemd, an SSH agent, the person's X server.
    assert!(
        !spec
            .env
            .iter()
            .any(|(k, _)| crate::node::runner::sandbox::NO_ENV.contains(&k.as_str()))
    );
}

/// The browser's hooks, keeping only which agent sessions are a Navi's.
#[derive(Default)]
struct NaviHooks(std::sync::Mutex<Vec<(String, String)>>);

impl crate::node::browser::SessionHooks for NaviHooks {
    fn env(&self, _thread: &str, _path: Option<&str>) -> Vec<(String, String)> {
        Vec::new()
    }
    fn plugin_dirs(&self) -> Vec<PathBuf> {
        Vec::new()
    }
    fn item(&self, _thread: &str, _item: &fleetd_contracts::sessions::ThreadItem) {}
    fn ended(&self, _thread: &str) {}
    fn screen_ended(&self, _thread: &str, _session: &str) {}
    fn filled_since(&self, _thread: &str, _known: usize) -> Option<crate::node::mask::Secrets> {
        None
    }
    fn navi(&self, thread: &str, navi: &str, _folder: &std::path::Path) {
        self.0
            .lock()
            .unwrap()
            .push((thread.to_owned(), navi.to_owned()));
    }
}

#[test]
fn a_session_whose_sandbox_cant_start_says_how_to_fix_it() {
    let e = super::runner_error(crate::node::runner::RunnerError::Sandbox {
        message: "A Navi runs only inside a sandbox, and this machine has no bubblewrap (bwrap)."
            .into(),
        fix: "Install bubblewrap on this machine".into(),
    });
    assert!(e.message.contains("no bubblewrap"), "{}", e.message);
    assert_eq!(e.fix.as_deref(), Some("Install bubblewrap on this machine"));
}
