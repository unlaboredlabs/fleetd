//! The native runner: `fleetd node` runs agent sessions itself by spawning the agent's own CLI, never an HTTP API.
//! Each provider is one adapter under its own module; [`claude`] is the only one so far.
//!
//! The boundary, which is all the hub, the train and the app may rely on:
//! - a [`Runner`] spawns one process per live session from a [`SessionSpec`] and hands back a [`SessionHandle`]:
//!   commands in, normalized [`RunnerEvent`]s out; it maps a [`TaskProfile`] onto its own model and effort;
//! - a [`RunnerGuide`] ([`guide`]) says, from a [`RunnerInfo`], what a person reads and runs about that runner;
//! - tool calls arrive classified ([`fleetd_contracts::sessions::ToolClass`]) and usage provider-neutral
//!   ([`RunUsage`]), so no tool name, CLI flag, config path, error text or usage field crosses it.
//!
//! The node session service owns everything durable (session rows, item log, worktrees, retries, the link); a runner
//! owns only the process and its protocol. docs/FOLLOWUPS.md lists what a second runner still needs.
//!
//! `fixtures/` holds stream-json transcripts recorded from real `claude` runs, one JSON object per line:
//! `{"dir":"in"|"out"|"stderr"|"meta","ms":<since start>,"msg":{…}}` (`raw` instead of `msg` for non-JSON lines).
//! Files ending `.documented.jsonl` are built from the Agent SDK's types, not recorded.
pub mod claude;
pub mod process;
pub mod sandbox;
pub mod scope;
pub mod shell;

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use fleetd_contracts::effort::{Effort, TaskProfile};
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::sessions::{
    PermissionDecision, RunFailure, RunUsage, RunnerInfo, RunnerKind, SendMode, SendNow, ThreadItem,
};
use tokio::sync::mpsc;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The model and effort a runner runs one [`TaskProfile`] on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProfileModel {
    pub model: &'static str,
    pub effort: Effort,
}

/// Everything a runner needs to start (or resume) one session's process.
#[derive(Clone, Debug)]
pub struct SessionSpec {
    /// The thread id; passed as `--session-id` on first start and `--resume` after.
    pub session_id: String,
    /// False on the first start, true whenever the session has run before (node restart, idle reap, retry).
    pub resume: bool,
    /// A task's session that has started, with anything but its first message to go: starting it without its
    /// conversation would leave the agent with no idea of its task, so the start is refused instead and the hub
    /// restarts the task fresh.
    pub must_resume: bool,
    /// The project root or the session's worktree. A resume must use the same cwd: claude files sessions by cwd.
    pub cwd: PathBuf,
    /// `--add-dir`, e.g. the project root for a worktree session.
    pub add_dirs: Vec<PathBuf>,
    pub model: String,
    pub effort: Effort,
    /// The model claude's background helper calls run on.
    pub helper_model: String,
    pub runtime_mode: RuntimeMode,
    /// `--allowedTools` rules from policy; anything else asks (ApprovalRequired) or runs (FullAccess).
    pub allowed_tools: Vec<String>,
    /// Only `allowed_tools`: claude gets none of its own tools but those named there (`--tools`), and asks for any
    /// other, which the node refuses (`sessions::state::auto_answer`).
    pub allowed_only: bool,
    /// `--disallowedTools`, always including the tools fleetd keeps from agents.
    pub disallowed_tools: Vec<String>,
    /// fleetd's MCP servers, written by the node; the user's own servers load too.
    pub mcp_config: Option<PathBuf>,
    /// `--strict-mcp-config`: claude loads only `mcp_config`'s servers, none of the person's own.
    pub strict_mcp: bool,
    /// fleetd's settings overlay (`--settings`), which claude merges over the user's own settings.
    pub settings: Option<PathBuf>,
    /// Plugins for this session only (`--plugin-dir`): the session's skills (`node::skills`).
    pub plugin_dirs: Vec<PathBuf>,
    /// The whole child environment. Nothing is inherited: no CLAUDE* variable of the node's own parent leaks in.
    pub env: Vec<(String, String)>,
    /// Raw stdout and stderr lines are appended here for debugging and conformance.
    pub transcript: Option<PathBuf>,
    /// The OS sandbox the process and everything it starts run in: a Navi's ([`sandbox::navi_fence`]). None for every
    /// other session.
    pub sandbox: Option<sandbox::Fence>,
}

/// Commands to a live session's process.
#[derive(Clone, Debug)]
pub enum SessionCommand {
    /// A user message that starts a run. `run_id` becomes the stream-json user-message uuid, which claude echoes on
    /// `command_lifecycle` and on the run's `result`.
    Send {
        run_id: String,
        text: String,
        mode: SendMode,
    },
    /// Drop a send claude still holds queued (`cancel_async_message`); answered by [`RunnerEvent::Withdrawn`].
    Withdraw { run_id: String },
    /// `control_request` interrupt. The session service escalates to [`SessionCommand::Shutdown`] if the run has
    /// not ended within its grace period.
    Interrupt,
    /// The `control_response` for a `can_use_tool` request.
    Answer {
        request_id: String,
        decision: PermissionDecision,
        /// Who decided; `None` from an older hub.
        by: Option<fleetd_contracts::time::DecidedBy>,
    },
    /// Close stdin, then SIGTERM after `grace`, then SIGKILL the process group and every descendant.
    Shutdown { grace: Duration },
}

/// How a run ended, from claude's `result` message (or its absence).
#[derive(Clone, Debug, PartialEq)]
pub enum RunOutcome {
    Completed {
        text: String,
    },
    /// `error_during_execution` after an interrupt (`terminal_reason` aborted_tools / aborted_streaming).
    Interrupted,
    /// A steer (`boundary` or `now`) ended the run at a tool boundary to get its own turn: run `by`. Not a failure.
    Superseded {
        by: String,
    },
    Failed(RunFailure),
}

/// The process's exit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
    /// The last 4000 characters of stderr, kept for a loud failure.
    pub stderr_tail: String,
}

/// `rate_limit_event`: claude.ai subscription limits (absent behind API keys and gateways).
#[derive(Clone, Debug, PartialEq)]
pub struct RateLimit {
    /// allowed, allowed_warning or rejected.
    pub status: String,
    /// Epoch seconds.
    pub resets_at: Option<i64>,
    pub limit_type: Option<String>,
    pub utilization: Option<f64>,
}

/// Normalized events from one session's process, in stream order.
#[derive(Clone, Debug, PartialEq)]
pub enum RunnerEvent {
    /// `system/init` (claude sends one per run): the version, model and cwd claude actually uses.
    Init {
        version: String,
        model: String,
        cwd: String,
        /// claude's own agent tools the init still offered ([`conformance::agent_like`]): empty when fleetd's deny
        /// list held, `None` when the init lists no tools, so none could be checked.
        agent_tools: Option<Vec<String>>,
    },
    /// `command_lifecycle` started.
    RunStarted {
        run_id: String,
    },
    /// `command_lifecycle` queued: claude holds the message until the running step ends.
    Queued {
        run_id: String,
    },
    /// An older claude merged the message into the running turn instead of giving it a turn of its own: the run
    /// stays filed under the turn's first run and ends with it.
    Joined {
        run_id: String,
    },
    /// `system/status` requesting: a model request carries these runs' messages.
    Seen {
        run_ids: Vec<String>,
    },
    /// The answer to a mode-`now` send's stop: what claude did, and the step it stopped.
    SendNow {
        run_id: String,
        outcome: SendNow,
        stopped_tool: Option<String>,
    },
    /// The answer to a [`SessionCommand::Withdraw`], or a steer claude dropped because the turn it waited on was
    /// stopped (`by_stop`).
    Withdrawn {
        run_id: String,
        cancelled: bool,
        by_stop: bool,
    },
    /// Partial assistant text (`stream_event` text_delta), for live views only.
    Delta {
        message_id: String,
        append: String,
    },
    /// A complete assistant text block.
    AssistantText {
        message_id: String,
        text: String,
    },
    /// A tool call started or finished, or a compaction, retry or error item.
    Item(ThreadItem),
    /// `can_use_tool`. The session service answers from policy or waits for a person.
    PermissionRequest {
        request_id: String,
        tool_use_id: String,
        tool_name: String,
        input: serde_json::Value,
        summary: String,
    },
    /// `system/status` compacting / null.
    Compacting(bool),
    RateLimit(RateLimit),
    /// The active run's usage so far, cumulative, from claude's streamed `message_start` / `message_delta`.
    Usage {
        run_id: String,
        usage: RunUsage,
    },
    /// Every time span of a run, with exclusive times, just before its [`RunnerEvent::RunEnded`].
    Spans(Vec<fleetd_contracts::time::SpanWire>),
    /// The run's `result` (or the process ended without one).
    RunEnded {
        run_id: String,
        outcome: RunOutcome,
        usage: Option<RunUsage>,
    },
    /// The process ended. Always the last event.
    Exited(ExitInfo),
}

/// A live session: send commands, read events until [`RunnerEvent::Exited`].
pub struct SessionHandle {
    pub pid: u32,
    pub commands: mpsc::Sender<SessionCommand>,
    pub events: mpsc::Receiver<RunnerEvent>,
}

#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    #[error("{binary} was not found on PATH")]
    Missing { binary: String },
    #[error("could not start {binary}: {message}")]
    Spawn { binary: String, message: String },
    /// The session must run in a sandbox, and none could start here.
    #[error("{message}")]
    Sandbox { message: String, fix: String },
}

/// One agent runtime, one per [`RunnerKind`].
pub trait Runner: Send + Sync + 'static {
    /// Version, login and a zero-cost conformance check (an `initialize` control request, no model call).
    /// `env` is the environment a session would get now (the user's own setup, plus `claude.env`): the login it reports
    /// depends on exactly that, and the node re-reads it per spawn.
    fn probe<'a>(&'a self, env: &'a [(String, String)]) -> BoxFut<'a, RunnerInfo>;
    /// Makes `spec`'s sandbox ready and checks that it starts, off the async runtime, before [`Runner::spawn`]: a
    /// session whose sandbox can't start is refused here. Nothing to do for a session without one.
    fn fence<'a>(&'a self, spec: &'a SessionSpec) -> BoxFut<'a, Result<(), RunnerError>> {
        let _ = spec;
        Box::pin(async { Ok(()) })
    }
    /// Starts the process for `spec` and returns once it is running; the first run starts with a `Send`.
    fn spawn(&self, spec: SessionSpec) -> Result<SessionHandle, RunnerError>;
    /// The model and effort a session of `profile` runs on when no setting chose them, and where one whose model
    /// claude refused falls back to.
    fn profile(&self, profile: TaskProfile) -> ProfileModel;
    /// The profile of a session stored with `model` and `effort`, or launched by a hub from before profiles.
    fn profile_of(&self, model: &str, effort: Effort) -> TaskProfile;
}

/// What a person reads and runs about one kind of runner, from what its probe reported ([`RunnerInfo`]). The hub's
/// routing, doctor and prompt pages use this and never a runner's own modules.
pub trait RunnerGuide: Sync {
    /// The runner's command as messages name it, e.g. "claude"; also the prefix of its doctor checks.
    fn name(&self) -> &'static str;
    /// What a person installs, e.g. "Claude Code".
    fn product(&self) -> &'static str;
    /// The command that installs it on a machine without it.
    fn install(&self) -> String;
    /// The command that installs exactly the tested version, from nothing.
    fn install_tested(&self) -> String;
    /// The command that puts the tested version over an installed one.
    fn pin_tested(&self) -> String;
    /// How to log it in; behind a proxy, the proxy holds the login.
    fn login_fix(&self, proxy: bool) -> &'static str;
    /// A version fleetd wasn't tested with: what to say about `found` and the command that fixes it. None when
    /// tested.
    fn version_problem(&self, found: &str) -> Option<(String, Option<String>)>;
    /// The setup sessions use, in a person's words: version, login, proxy, config dir.
    fn setup(&self, info: &RunnerInfo) -> String;
    /// The protocol the probe checks it speaks, e.g. "the stream-json protocol".
    fn protocol(&self) -> &'static str;
    /// The tools no session of this runner ever gets.
    fn denied_tools(&self) -> &'static [&'static str];
    /// The model and effort a profile runs on when no setting chose them ([`Runner::profile`]).
    fn profile(&self, profile: TaskProfile) -> ProfileModel;
}

/// The guide for a runner `kind`: the one place the hub turns a runner kind into its words.
pub fn guide(kind: RunnerKind) -> &'static dyn RunnerGuide {
    match kind {
        RunnerKind::Claude => &claude::guide::GUIDE,
    }
}
