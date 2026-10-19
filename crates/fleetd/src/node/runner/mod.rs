//! The native runner: `fleetd node` runs agent sessions itself by spawning the agent's own CLI. Claude only through
//! the `claude` binary with stream-json on stdin and stdout; never an HTTP API.
//!
//! A [`Runner`] spawns one process per live session and hands back a [`SessionHandle`]: commands in, normalized
//! [`RunnerEvent`]s out. The node session service owns everything durable (session rows, item log, worktrees,
//! retries, the link); a runner owns only the process and its protocol. See docs/build/native-runner-spec.md in the
//! plan repo.
//!
//! `fixtures/` holds stream-json transcripts recorded from real `claude` runs, one JSON object per line:
//! `{"dir":"in"|"out"|"stderr"|"meta","ms":<since start>,"msg":{…}}` (`raw` instead of `msg` for non-JSON lines).
//! Files ending `.documented.jsonl` are built from the Agent SDK's types, not recorded.
pub mod claude;
pub mod claude_setup;
pub mod conformance;
pub mod failure;
pub mod process;
pub mod version;

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::sessions::{
    PermissionDecision, RunFailure, RunUsage, RunnerInfo, RunnerKind, SendMode, SendNow, ThreadItem,
};
use tokio::sync::mpsc;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Everything a runner needs to start (or resume) one session's process.
#[derive(Clone, Debug)]
pub struct SessionSpec {
    /// The thread id; passed as `--session-id` on first start and `--resume` after.
    pub session_id: String,
    /// False on the first start, true whenever the session has run before (node restart, idle reap, retry).
    pub resume: bool,
    /// The project root or the session's worktree. A resume must use the same cwd: claude files sessions by cwd.
    pub cwd: PathBuf,
    /// `--add-dir`, e.g. the project root for a worktree session.
    pub add_dirs: Vec<PathBuf>,
    pub model: String,
    pub effort: Effort,
    pub runtime_mode: RuntimeMode,
    /// `--allowedTools` rules from policy; anything else asks (ApprovalRequired) or runs (FullAccess).
    pub allowed_tools: Vec<String>,
    /// `--disallowedTools`, always including the tools fleetd keeps from agents.
    pub disallowed_tools: Vec<String>,
    /// fleetd's MCP servers, written by the node; the user's own servers load too.
    pub mcp_config: Option<PathBuf>,
    /// fleetd's settings overlay (`--settings`), which claude merges over the user's own settings.
    pub settings: Option<PathBuf>,
    /// The whole child environment. Nothing is inherited: no CLAUDE* variable of the node's own parent leaks in.
    pub env: Vec<(String, String)>,
    /// Raw stdout and stderr lines are appended here for debugging and conformance.
    pub transcript: Option<PathBuf>,
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
        /// The init named an auto memory dir ([`conformance::auto_memory_on`]).
        auto_memory: bool,
        /// Claude's own subagents the init still offered ([`conformance::subagent_leaks`]); empty when off.
        subagent_leaks: Vec<String>,
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
    #[error("{binary} {found} is outside the supported range {supported}")]
    UnsupportedVersion {
        binary: String,
        found: String,
        supported: String,
    },
    #[error("could not start {binary}: {message}")]
    Spawn { binary: String, message: String },
    /// claude refused before running (e.g. "Session ID … is already in use."), with its stderr.
    #[error("{0}")]
    Refused(String),
}

/// One agent runtime. Claude now; Codex later as its own adapter.
pub trait Runner: Send + Sync + 'static {
    fn kind(&self) -> RunnerKind;
    /// Version, login and a zero-cost conformance check (an `initialize` control request, no model call).
    /// `env` is the environment a session would get now (the user's own setup, plus `claude.env`): the login it reports
    /// depends on exactly that, and the node re-reads it per spawn.
    fn probe<'a>(&'a self, env: &'a [(String, String)]) -> BoxFut<'a, RunnerInfo>;
    /// Starts the process for `spec` and returns once it is running; the first run starts with a `Send`.
    fn spawn(&self, spec: SessionSpec) -> Result<SessionHandle, RunnerError>;
}
