//! Everything tasks and slots call in the executor, node link and leads. `wire::HubTaskPorts` implements it
//! over those areas; tests use a fake. Each method is one cross-area call.
use std::future::Future;
use std::pin::Pin;

use fleetd_contracts::effort::TaskProfile;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::ledger::{Brief, Workstream, WorkstreamId};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::sessions::WorktreeBase;
use fleetd_contracts::work::{WorkMatch, WorkScope};

use crate::hub::store::StoreError;
use crate::hub::work::{Observed, matcher};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A refusal in the `{ code, message, fix }` shape: leads' LeadError and the MCP tool error are the same shape.
pub type TaskError = McpToolError;

/// How an executor call failed: the machine is not connected, or anything else.
#[derive(Clone, Debug)]
pub enum PortError {
    Offline,
    Failed(String),
}

impl PortError {
    pub fn to_task_error(&self, machine_id: &MachineId) -> TaskError {
        match self {
            Self::Offline => McpToolError::new(
                ErrorCode::MachineOffline,
                format!("Machine {} has no live node link.", machine_id.as_str()),
            )
            .with_fix(
                "Wait for the machine to come back online (fleetd_status shows it), then retry.",
            ),
            Self::Failed(message) => McpToolError::new(ErrorCode::Failed, message.clone())
                .with_fix("Retry; if it keeps failing, check the machine with fleetd_status."),
        }
    }
}

/// A task's thread launch (runtime mode full-access).
#[derive(Clone, Debug)]
pub struct LaunchRequest {
    pub project_id: ProjectId,
    pub prompt: String,
    pub profile: TaskProfile,
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

/// What a finished task thread changed.
#[derive(Clone, Debug, Default)]
pub struct ThreadChanges {
    pub branch: Option<String>,
    pub worktree_path: Option<String>,
    pub paths: Vec<String>,
    pub pull_request_urls: Vec<String>,
}

/// A node command's result (`cmd_result`).
#[derive(Clone, Debug)]
pub struct CmdOutput {
    pub exit_code: Option<i64>,
    pub output_tail: String,
}

/// Which "why you are woken" entry a task trigger is (`task_result`, `task_waiting`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WakeKind {
    TaskResult,
    TaskWaiting,
    CapRaised,
}

pub trait TaskPorts: Send + Sync {
    /// Executors.isConnected.
    fn is_connected(&self, machine_id: &MachineId) -> bool;
    /// Executors.awaitLive: resolves once the machine has a live node link.
    fn await_live<'a>(&'a self, machine_id: &'a MachineId) -> BoxFut<'a, ()>;
    /// Executors.launch: the thread, and where its worktree's branch started when it has one.
    fn launch<'a>(
        &'a self,
        machine_id: &'a MachineId,
        request: LaunchRequest,
    ) -> BoxFut<'a, Result<(ThreadId, Option<WorktreeBase>), PortError>>;
    /// Executors.send.
    fn send<'a>(
        &'a self,
        thread: &'a ThreadRef,
        message: &'a str,
        client_request_id: &'a str,
    ) -> BoxFut<'a, Result<(), PortError>>;
    /// Executors.send as a steer's run: `mode` and its tag. Plain ports send it plainly.
    fn send_steer<'a>(
        &'a self,
        thread: &'a ThreadRef,
        message: &'a str,
        client_request_id: &'a str,
        _steer: fleetd_contracts::steer::SteerTag,
    ) -> BoxFut<'a, Result<(), PortError>> {
        self.send(thread, message, client_request_id)
    }
    /// Executors.startedRun: the run the thread is on, not a send queued behind it; None when unknown.
    fn started_run(&self, thread: &ThreadRef) -> Option<String>;
    /// Executors.stop(ref): ends the thread's claude process; `Ok` only once the node saw it exit.
    fn stop<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Result<(), PortError>>;
    /// Executors.stop(ref, removeWorktree): the node deletes the thread's worktree and the build output in it.
    fn remove_worktree<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Result<(), PortError>>;
    /// NodeLinkServer.paused: why the disk and load guard holds new agents on the machine.
    fn paused(&self, machine_id: &MachineId) -> Option<String>;
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
    /// ThreadWorkspace.changes; `None` when the node could not say.
    fn changes<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Option<ThreadChanges>>;
    /// ThreadWorkspace.pendingQuestion; `None` when there is none or the node could not say.
    fn pending_question<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Option<String>>;
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
    /// Leads.medium_allowed: whether the project's tasks may run on medium; false when it can't be read.
    fn medium_allowed(&self, project_ref: &ProjectRef) -> bool;
    /// LeadWakes.trigger with the entry's rendered lines.
    fn wake(&self, project_ref: &ProjectRef, kind: WakeKind, text: String);
    /// `leads::digest::done_when_text` of the brief's lines, at most 200 units each, for the task prompt's "Done
    /// when:".
    fn done_when_text(&self, brief: &Brief) -> String;
    /// Work.scope_of: the repo and base the project's work lands on, as recorded. Plain ports record none, so
    /// nothing is checked.
    fn work_scope<'a>(
        &'a self,
        _project_ref: &'a ProjectRef,
    ) -> BoxFut<'a, Result<Option<WorkScope>, StoreError>> {
        Box::pin(async { Ok(None) })
    }
    /// `work::bind_from_root`: reads and records them from the project's root, which asks its node and may wait on
    /// its remote. `'static`, so the tasks can leave it running in the background.
    fn work_bind(
        &self,
        _project_ref: &ProjectRef,
    ) -> BoxFut<'static, Result<Option<WorkScope>, StoreError>> {
        Box::pin(async { Ok(None) })
    }
    /// Work.observe: the scope's writers' changed paths, asked of their nodes at once, none waited on past
    /// `timeout`.
    fn work_observe<'a>(
        &'a self,
        _scope: &'a WorkScope,
        _timeout: std::time::Duration,
    ) -> BoxFut<'a, Result<Observed, StoreError>> {
        Box::pin(async { Ok(Observed::default()) })
    }
    /// Work.check_observed: what the intent may repeat among the scope's work in flight, strongest first, with the
    /// writers' paths already gathered. Reads the store only, so it may run under the tasks lock.
    fn work_match(
        &self,
        _scope: &WorkScope,
        _intent: &matcher::Work,
        _paths: &std::collections::HashMap<fleetd_contracts::tasks::TaskId, Vec<String>>,
    ) -> Result<Vec<WorkMatch>, StoreError> {
        Ok(Vec::new())
    }
}
