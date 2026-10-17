//! Per-machine T3 clients. Each attached machine gets one supervised connection that follows T3's shell stream into
//! the store (thread/project caches) and the event log (derived events, on transitions only). Thread transcripts are
//! read on demand (tail, actions, headlines) and dropped after 60 s unused. TS spec: apps/hub/src/executor/**.
//!
//! One `Executors` serves what TS split into Executors, ThreadWatch, WorkspaceFiles, ThreadWorkspace, ProviderList,
//! UsageSource and T3Settings.
pub mod branch_diff;
pub mod limit;
pub mod providers;
pub mod shell_mapper;
pub mod thread_view;
pub mod tools;

use std::sync::Arc;

use fleetd_contracts::{ActionItem, MachineId, TailKind, ThreadId, ThreadLaunchInput, ThreadRef, ThreadTailOutput};

pub use providers::ProviderInstance;

/// Reconnect delay: doubles from 1 s to a 30 s cap, +-25 % jitter so machines don't reconnect in step.
pub fn backoff_ms(attempt: u32, random: f64) -> u64 {
    let base = 1000.0 * 2f64.powi(attempt.min(5) as i32) * (0.75 + random * 0.5);
    (base.round() as u64).min(30_000)
}

pub const WATCH_IDLE_MS: u64 = 60_000;
pub const READ_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum T3Operation {
    Launch,
    Send,
    Interrupt,
    Read,
    Configure,
}

impl T3Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launch => "launch",
            Self::Send => "send",
            Self::Interrupt => "interrupt",
            Self::Read => "read",
            Self::Configure => "configure",
        }
    }
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum ExecutorError {
    #[error("machine {machine_id} has no live T3 connection")]
    MachineNotConnected { machine_id: MachineId },
    #[error("thread {thread_id} is not known on machine {machine_id}")]
    ThreadNotFound { machine_id: MachineId, thread_id: ThreadId },
    /// `cause` is for logs only and never carries the bearer or a ws ticket.
    #[error("T3 on {machine_id} refused or failed the {} request", operation.as_str())]
    T3RequestFailed { machine_id: MachineId, operation: T3Operation, cause: String },
}

/// The T3 session the node minted for the hub.
#[derive(Clone, PartialEq, Eq)]
pub struct T3Session {
    pub t3_url: String,
    pub bearer: String,
}

#[derive(Debug, Clone, Default)]
pub struct LaunchOptions {
    /// Default: the project root. Tasks launch writers in a new worktree on their own branch. T3's
    /// `workspaceStrategy` JSON, e.g. `{"type":"worktree","baseRef":"main","branch":"fleetd/t-1"}`.
    pub workspace: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendOutcome {
    pub run_id: Option<String>,
    pub queued: bool,
}

/// What the watchdog needs (TS ThreadWatch).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunningThread {
    pub thread_ref: ThreadRef,
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestRun {
    pub run_id: Option<String>,
    pub running: bool,
}

/// Set while a command or tool call of the run is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct OpenTool {
    /// The longest timeout an open tool states itself.
    pub stated_timeout_ms: Option<u64>,
    /// Some open tool states none (the watchdog applies its default).
    pub unstated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Progress {
    /// Epoch ms of the stream's last frame, or of its opening.
    pub last_frame_ms: u64,
    pub tool: Option<OpenTool>,
}

/// What a finished task thread changed (TS ThreadWorkspace.changes).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ThreadChanges {
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    /// Repo-relative paths any of the thread's checkpoints touched, sorted and unique.
    pub paths: Vec<String>,
    pub pull_request_urls: Vec<String>,
}

pub struct Executors {
    _private: (),
}

impl Executors {
    /// Needs the store, the event log and the clock from `Hub`; spawns nothing until `attach`.
    pub fn new(_hub_parts: ()) -> Arc<Self> {
        todo!()
    }

    /// (Re)connects. Idempotent for the same URL and bearer; a new bearer reconnects with it.
    pub async fn attach(self: &Arc<Self>, _machine_id: &MachineId, _session: T3Session) {
        todo!()
    }
    /// Drops the connection. The machine's shell state is kept, so a later attach resumes from its cursor.
    pub async fn detach(&self, _machine_id: &MachineId) {
        todo!()
    }
    pub fn is_connected(&self, _machine_id: &MachineId) -> bool {
        todo!()
    }
    /// Returns once the machine has a live T3 connection, at once if it has one now.
    pub async fn await_live(&self, _machine_id: &MachineId) {
        todo!()
    }

    pub async fn launch(
        &self,
        _machine_id: &MachineId,
        _input: &ThreadLaunchInput,
        _options: LaunchOptions,
    ) -> Result<ThreadId, ExecutorError> {
        todo!()
    }
    pub async fn send(&self, _r: &ThreadRef, _message: &str, _client_request_id: &str) -> Result<SendOutcome, ExecutorError> {
        todo!()
    }
    pub async fn interrupt(&self, _r: &ThreadRef, _client_request_id: &str) -> Result<(), ExecutorError> {
        todo!()
    }
    /// Newest first.
    pub async fn tail(&self, _r: &ThreadRef, _n: usize, _kinds: Option<&[TailKind]>) -> Result<ThreadTailOutput, ExecutorError> {
        todo!()
    }
    /// Newest first.
    pub async fn actions(&self, _r: &ThreadRef, _limit: usize, _failed_only: bool) -> Result<Vec<ActionItem>, ExecutorError> {
        todo!()
    }

    // ThreadWatch (watchdog)
    /// Threads whose shell row says running, on machines with a live T3 connection.
    pub fn running(&self) -> Vec<RunningThread> {
        todo!()
    }
    pub fn latest_run(&self, _r: &ThreadRef) -> Option<LatestRun> {
        todo!()
    }
    /// Opens the thread's stream if needed and keeps it open until `release`.
    pub async fn follow(&self, _r: &ThreadRef) -> Result<(), ExecutorError> {
        todo!()
    }
    /// The stream then closes 60 s from now unless something reads it.
    pub fn release(&self, _r: &ThreadRef) {
        todo!()
    }
    pub fn progress(&self, _r: &ThreadRef) -> Option<Progress> {
        todo!()
    }

    // ProviderList, UsageSource, T3Settings (usage, reviews and the doctor)
    pub async fn provider_instances(&self, _machine_id: &MachineId) -> Result<Vec<ProviderInstance>, ExecutorError> {
        todo!()
    }
    /// T3's `server.getConfig` as JSON (usage reads the fleetd instance's login kind and the logs dir from it).
    pub async fn server_config(&self, _machine_id: &MachineId) -> Result<serde_json::Value, ExecutorError> {
        todo!()
    }
    /// The T3 URL the machine is attached with, if any (usage's `local` check).
    pub fn t3_url(&self, _machine_id: &MachineId) -> Option<String> {
        todo!()
    }
    pub async fn settings_read(&self, _machine_id: &MachineId) -> Result<serde_json::Value, ExecutorError> {
        todo!()
    }
    pub async fn settings_update(
        &self,
        _machine_id: &MachineId,
        _update: serde_json::Value,
    ) -> Result<serde_json::Value, ExecutorError> {
        todo!()
    }

    // WorkspaceFiles, ThreadWorkspace (leads, tasks)
    /// None when the file does not exist. `cwd` must be a T3 workspace root.
    pub async fn read_file(&self, _machine_id: &MachineId, _cwd: &str, _relative_path: &str) -> Result<Option<String>, ExecutorError> {
        todo!()
    }
    /// The repo's default local branch at `cwd`, else its current branch.
    pub async fn default_branch(&self, _machine_id: &MachineId, _cwd: &str) -> Result<String, ExecutorError> {
        todo!()
    }
    pub async fn changes(&self, _r: &ThreadRef) -> Result<ThreadChanges, ExecutorError> {
        todo!()
    }
    /// What the thread is waiting on a human for, if anything: a question or an approval prompt.
    pub async fn pending_question(&self, _r: &ThreadRef) -> Result<Option<String>, ExecutorError> {
        todo!()
    }
}
