//! PORT: everything tasks, slots and leases call in areas that are not on main yet (executor, link, leads). The
//! integration slice implements `TaskPorts` over those areas and passes it to `hub/serve` in place of
//! `UnwiredPorts`. Each method mirrors one TS cross-service call, named in its doc.
use std::future::Future;
use std::pin::Pin;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::ledger::{Brief, Workstream, WorkstreamId};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};

use super::resolve::ModelEffort;

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A refusal in the `{ code, message, fix }` shape: leads' LeadError and the MCP tool error are the same shape.
pub type TaskError = McpToolError;

/// How an executor call failed. TS ExecutorError: MachineNotConnected, or ThreadNotFound / T3RequestFailed.
#[derive(Clone, Debug)]
pub enum PortError {
    Offline,
    Failed(String),
}

impl PortError {
    /// TS leads/LeadError.ts `fromExecutor`.
    pub fn to_task_error(&self, machine_id: &MachineId) -> TaskError {
        match self {
            Self::Offline => McpToolError::new(
                ErrorCode::MachineOffline,
                format!("Machine {} has no live T3 connection.", machine_id.as_str()),
            )
            .with_fix(
                "Wait for the machine to come back online (fleetd_status shows it), then retry.",
            ),
            Self::Failed(message) => McpToolError::new(ErrorCode::T3Error, message.clone())
                .with_fix("Retry; if it keeps failing, check the machine's T3 with fleetd_status."),
        }
    }
}

/// A task's T3 thread launch (TS Executors.launch with ThreadLaunchInput, runtimeMode full-access).
#[derive(Clone, Debug)]
pub struct LaunchRequest {
    pub project_id: ProjectId,
    pub prompt: String,
    pub model: String,
    pub effort: Effort,
    pub title: String,
    pub client_request_id: String,
    /// Write tasks: `{ type: "worktree", baseRef, branch }`.
    pub worktree: Option<Worktree>,
}

#[derive(Clone, Debug)]
pub struct Worktree {
    pub base_ref: String,
    pub branch: String,
}

/// What a finished task thread changed (TS ThreadWorkspace.changes).
#[derive(Clone, Debug, Default)]
pub struct ThreadChanges {
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub paths: Vec<String>,
    pub pull_request_urls: Vec<String>,
}

/// A node command's result (TS NodeCommands.run → cmd_result).
#[derive(Clone, Debug)]
pub struct CmdOutput {
    pub exit_code: Option<i64>,
    pub output_tail: String,
}

/// Which "why you are woken" entry a task trigger is (TS LeadWakes triggers task_result, task_waiting).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeKind {
    TaskResult,
    TaskWaiting,
}

pub trait TaskPorts: Send + Sync {
    /// Executors.isConnected.
    fn is_connected(&self, machine_id: &MachineId) -> bool;
    /// Executors.awaitLive: resolves once the machine has a live T3 connection.
    fn await_live<'a>(&'a self, machine_id: &'a MachineId) -> BoxFut<'a, ()>;
    /// Executors.launch.
    fn launch<'a>(
        &'a self,
        machine_id: &'a MachineId,
        request: LaunchRequest,
    ) -> BoxFut<'a, Result<ThreadId, PortError>>;
    /// Executors.send.
    fn send<'a>(
        &'a self,
        thread: &'a ThreadRef,
        message: &'a str,
        client_request_id: &'a str,
    ) -> BoxFut<'a, Result<(), PortError>>;
    /// Executors.interrupt.
    fn interrupt<'a>(
        &'a self,
        thread: &'a ThreadRef,
        client_request_id: &'a str,
    ) -> BoxFut<'a, Result<(), PortError>>;
    /// Executors.actions(ref, limit): each action's summary and output tail, newest first; empty when unreadable.
    fn action_texts<'a>(
        &'a self,
        thread: &'a ThreadRef,
        limit: usize,
    ) -> BoxFut<'a, Vec<(String, Option<String>)>>;
    /// ThreadWorkspace.defaultBranch.
    fn default_branch<'a>(
        &'a self,
        machine_id: &'a MachineId,
        cwd: &'a str,
    ) -> BoxFut<'a, Result<String, PortError>>;
    /// ThreadWorkspace.changes; `None` when T3 could not say.
    fn changes<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Option<ThreadChanges>>;
    /// ThreadWorkspace.pendingQuestion; `None` when there is none or T3 could not say.
    fn pending_question<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Option<String>>;
    /// WorkspaceFiles.read: `None` when the file does not exist.
    fn read_file<'a>(
        &'a self,
        machine_id: &'a MachineId,
        cwd: &'a str,
        path: &'a str,
    ) -> BoxFut<'a, Result<Option<String>, PortError>>;
    /// NodeCommands.run (cmd_check); `None` when the node could not run it.
    fn run_command<'a>(
        &'a self,
        machine_id: &'a MachineId,
        cwd: &'a str,
        argv: Vec<String>,
        timeout_sec: u32,
    ) -> BoxFut<'a, Option<CmdOutput>>;
    /// LeadRecords.workstreams.get.
    fn workstream(&self, workstream_id: &WorkstreamId) -> Option<Workstream>;
    /// LeadRecords.settings.get: the project's lead model and effort.
    fn lead_settings(&self, project_ref: &ProjectRef) -> Option<ModelEffort>;
    /// LeadWakes.trigger with the entry's rendered lines.
    fn wake(&self, project_ref: &ProjectRef, kind: WakeKind, text: String);
    /// LeadRecords.leads.list: the project whose lead runs in this thread now (the slot board counts it).
    fn lead_of(&self, machine_id: &MachineId, thread_id: &ThreadId) -> Option<ProjectRef>;
    /// leads/digest.ts doneWhenText(brief.doneWhen, undefined, 200), for the task prompt's "Done when:".
    fn done_when_text(&self, brief: &Brief) -> String;
}

/// PORT: until the executor, link and leads areas are wired. Every machine reads offline, so tasks queue with
/// "machine <id> is offline" and nothing launches; spawns are refused for an unknown workstream.
pub struct UnwiredPorts;

impl TaskPorts for UnwiredPorts {
    fn is_connected(&self, _: &MachineId) -> bool {
        false
    }
    fn await_live<'a>(&'a self, _: &'a MachineId) -> BoxFut<'a, ()> {
        Box::pin(std::future::pending())
    }
    fn launch<'a>(
        &'a self,
        _: &'a MachineId,
        _: LaunchRequest,
    ) -> BoxFut<'a, Result<ThreadId, PortError>> {
        Box::pin(async { Err(PortError::Offline) })
    }
    fn send<'a>(
        &'a self,
        _: &'a ThreadRef,
        _: &'a str,
        _: &'a str,
    ) -> BoxFut<'a, Result<(), PortError>> {
        Box::pin(async { Err(PortError::Offline) })
    }
    fn interrupt<'a>(&'a self, _: &'a ThreadRef, _: &'a str) -> BoxFut<'a, Result<(), PortError>> {
        Box::pin(async { Err(PortError::Offline) })
    }
    fn action_texts<'a>(
        &'a self,
        _: &'a ThreadRef,
        _: usize,
    ) -> BoxFut<'a, Vec<(String, Option<String>)>> {
        Box::pin(async { Vec::new() })
    }
    fn default_branch<'a>(
        &'a self,
        _: &'a MachineId,
        _: &'a str,
    ) -> BoxFut<'a, Result<String, PortError>> {
        Box::pin(async { Err(PortError::Offline) })
    }
    fn changes<'a>(&'a self, _: &'a ThreadRef) -> BoxFut<'a, Option<ThreadChanges>> {
        Box::pin(async { None })
    }
    fn pending_question<'a>(&'a self, _: &'a ThreadRef) -> BoxFut<'a, Option<String>> {
        Box::pin(async { None })
    }
    fn read_file<'a>(
        &'a self,
        _: &'a MachineId,
        _: &'a str,
        _: &'a str,
    ) -> BoxFut<'a, Result<Option<String>, PortError>> {
        Box::pin(async { Err(PortError::Offline) })
    }
    fn run_command<'a>(
        &'a self,
        _: &'a MachineId,
        _: &'a str,
        _: Vec<String>,
        _: u32,
    ) -> BoxFut<'a, Option<CmdOutput>> {
        Box::pin(async { None })
    }
    fn workstream(&self, _: &WorkstreamId) -> Option<Workstream> {
        None
    }
    fn lead_settings(&self, _: &ProjectRef) -> Option<ModelEffort> {
        None
    }
    fn wake(&self, _: &ProjectRef, _: WakeKind, _: String) {}
    fn lead_of(&self, _: &MachineId, _: &ThreadId) -> Option<ProjectRef> {
        None
    }
    fn done_when_text(&self, _: &Brief) -> String {
        String::new()
    }
}
