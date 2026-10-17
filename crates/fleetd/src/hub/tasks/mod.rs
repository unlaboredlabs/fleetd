//! fleetd-owned tasks: every subagent a lead runs. Spawn resolves model and effort, takes leases (writers) and a
//! slot or queues with the reason, and launches a T3 thread (writers in a new worktree on `fleetd/<taskId>-<slug>`).
//! The thread's status transitions, read off the event log, end the task: the result goes into the record and,
//! inline, into one lead wake; the slot and leases are released and the queue is tried again.
//! TS spec: apps/hub/src/tasks/Tasks.ts.
pub mod branch_diff;
pub mod glob;
pub mod hooks;
pub mod records;
pub mod render;
pub mod resolve;
pub mod tools;

use std::sync::Arc;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::tasks::{Task, TaskId, TaskState};

use crate::hub::leads::LeadError;

pub use records::{StoredTask, TaskRecords};

/// Who asks: the project's lead, as the lead-call handler attributes it.
#[derive(Clone, Debug)]
pub struct TaskCaller {
    pub project_ref: ProjectRef,
    pub by: String,
}

/// `TaskSpawnCall` without `op`.
pub type SpawnInput = fleetd_contracts::lead_calls::TaskSpawnCall;

#[derive(Clone, Debug, Default)]
pub struct TaskFilter {
    pub project_ref: Option<ProjectRef>,
    pub state: Option<TaskState>,
    pub workstream_id: Option<WorkstreamId>,
    pub limit: usize,
}

pub struct Tasks {/* deps, lock, awaiting set */}

impl Tasks {
    /// Registers the slot release listener and starts following thread events from the log's head.
    pub async fn start(_hub: &crate::hub::api::Hub, _spawn_check: Arc<dyn hooks::SpawnCheck>, _receipts: Arc<dyn hooks::ResultReceipts>) -> Arc<Self> { todo!() }
    /// The task as stored: running, queued with its reason, or failed if T3 refused the launch.
    pub async fn spawn(&self, _caller: &TaskCaller, _input: SpawnInput) -> Result<Task, LeadError> { todo!() }
    /// Steers a running task; continues an ended one in the same thread, which re-takes its slot and leases.
    pub async fn message(&self, _caller: &TaskCaller, _task_id: &TaskId, _message: &str) -> Result<Task, LeadError> { todo!() }
    /// Interrupts a running task and releases its slot and leases.
    pub async fn cancel(&self, _caller: &TaskCaller, _task_id: &TaskId, _reason: Option<&str>) -> Result<Task, LeadError> { todo!() }
    pub async fn get(&self, _task_id: &TaskId) -> Option<Task> { todo!() }
    /// Newest first.
    pub async fn list(&self, _filter: TaskFilter) -> Vec<Task> { todo!() }
}
