//! What the checks, receipts, value bar and incidents areas need from other hub areas, as one trait.
//! The hub's implementation (`HubPorts`, wired once those areas land) forwards to their services; tests use fakes.
//! Keeping it to this one seam means the claim flow and the value bar run their real logic under test.
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef};
use fleetd_contracts::ledger::{MetricValues, PlaybookRef, Workstream, WorkstreamId};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::model::ActionItem;
use fleetd_contracts::tasks::{Task, TaskId};
use fleetd_contracts::verification::{CheckResult, ClaimId};
use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The lead wakes a claim causes; the leads area renders them with `checks::render`.
#[derive(Debug, Clone, PartialEq)]
pub enum ClaimWake {
    Failed {
        claim_id: ClaimId,
        workstream_id: WorkstreamId,
        failures: Vec<CheckResult>,
    },
    Passed {
        claim_id: ClaimId,
        workstream_id: WorkstreamId,
    },
    /// Every check passed, but write work of it has not landed, so the workstream stays open.
    Held {
        claim_id: ClaimId,
        workstream_id: WorkstreamId,
        work: Vec<crate::hub::orders::open_work::OpenWork>,
    },
}

/// The pinned playbook's numbers the value bar reads.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaybookLimits {
    pub max_review_rounds: u32,
}

/// The human's answer to a `human` check, as the lead logged it after asking in chat: the active `done.<n>`
/// decision in the workstream's own scope.
#[derive(Debug, Clone, PartialEq)]
pub struct HumanConfirmation {
    pub value: String,
    pub decision_id: String,
    pub at_ms: i64,
}

/// A review task the hub spawns for a `judge` check (by = "hub:judge", areas none).
#[derive(Debug, Clone, PartialEq)]
pub struct JudgeSpawn {
    pub project_ref: ProjectRef,
    pub workstream_id: WorkstreamId,
    pub title: String,
    pub prompt: String,
}

/// A `cmd_result` from the node: `exit_code` None when the process did not exit on its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRun {
    pub exit_code: Option<i64>,
    pub output_tail: String,
    pub timed_out: bool,
}

/// A refusal at the wire: `{code, message, fix?}`, with the texts older hubs sent.
pub type Refusal = McpToolError;

pub fn invalid(message: impl Into<String>, fix: Option<&str>) -> Refusal {
    with_fix(McpToolError::new(ErrorCode::Invalid, message), fix)
}

pub fn not_found(message: impl Into<String>, fix: Option<&str>) -> Refusal {
    with_fix(McpToolError::new(ErrorCode::NotFound, message), fix)
}

fn with_fix(error: Refusal, fix: Option<&str>) -> Refusal {
    match fix {
        Some(fix) => error.with_fix(fix),
        None => error,
    }
}

/// A store failure: logged, answered with the generic "The hub failed to answer that request."
pub fn internal(error: crate::hub::store::StoreError) -> Refusal {
    error.into()
}

pub trait Ports: Send + Sync + 'static {
    // leads: LeadRecords.workstreams
    fn workstream(&self, id: &WorkstreamId) -> Option<Workstream>;
    /// Replaces the stored workstream, keeping its amends.
    fn put_workstream(&self, workstream: &Workstream);
    /// `put_workstream` only while the stored one still has `expect`'s state and brief hash; false when it changed.
    fn put_workstream_if(&self, workstream: &Workstream, expect: &Workstream) -> bool;
    // leads: LeadWakes.trigger
    fn wake(&self, project: &ProjectRef, wake: ClaimWake);
    // link: NodeCommands.run (default 120 s timeout); the error is NodeCommandError's message.
    fn run_command(
        &self,
        machine: &MachineId,
        cwd: String,
        argv: Vec<String>,
    ) -> BoxFuture<'_, Result<CommandRun, String>>;
    // store: HubStore.projects
    fn workspace_root(&self, project: &ProjectRef) -> Option<String>;
    // playbooks
    fn playbook_limits(&self, playbook: &PlaybookRef) -> Option<PlaybookLimits>;
    /// Research.recordVerdict: stores the computed research verdict and returns its text.
    fn research_verdict<'a>(
        &'a self,
        workstream: &'a WorkstreamId,
        values: MetricValues,
    ) -> BoxFuture<'a, Result<String, Refusal>>;
    // tasks
    fn task(&self, id: &TaskId) -> Option<Task>;
    /// The workstream's tasks, newest first.
    fn tasks_of(&self, project: &ProjectRef, workstream: &WorkstreamId, limit: usize) -> Vec<Task>;
    /// Its write work that has not landed (`orders::open_work`): a workstream never closes over it by accident.
    fn open_work(&self, workstream: &Workstream) -> Vec<crate::hub::orders::open_work::OpenWork>;
    fn spawn_judge(&self, spawn: JudgeSpawn) -> BoxFuture<'_, Result<Task, Refusal>>;
    // ledger: the decision a `human` check reads, and when the brief it checks was last frozen
    fn human_confirmation(&self, workstream: &WorkstreamId, key: &str)
    -> Option<HumanConfirmation>;
    /// When the workstream's brief was last frozen or amended (its latest `workstream.running`, or a
    /// `workstream.state` that amended it).
    fn brief_frozen_ms(&self, workstream: &WorkstreamId) -> Option<i64>;
    // executor
    fn thread_actions<'a>(
        &'a self,
        thread: &'a ThreadRef,
        max: usize,
    ) -> BoxFuture<'a, Result<Vec<ActionItem>, String>>;
}
