//! What the train and the review gate take from other hub areas: tasks, workstreams, playbooks, decisions,
//! incidents, the event log, wakes, node commands and the provider list. One port, so the logic tests run on a fake
//! and the hub provides it from its services (`HubHost`).
use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use super::contract::{MachineId, ProjectRef, ReviewRule, TaskId, Tier, WorkstreamId};

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A node's answer to `cmd_check`: no shell, output tail, `exit_code` None when it could not start or timed out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CmdOut {
    pub exit_code: Option<i32>,
    pub output_tail: String,
    pub timed_out: bool,
}

/// The parts of a Task the train and reviews read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskView {
    pub task_id: TaskId,
    pub project_ref: ProjectRef,
    pub workstream_id: WorkstreamId,
    /// "write", "review", ...
    pub kind: String,
    /// "done", "failed", "running", ...
    pub state: String,
    pub serves: Option<String>,
    pub tier: Option<Tier>,
    /// `result.prUrl`.
    pub pr_url: Option<String>,
    /// `result.receipts.commands`, 0 without receipts.
    pub receipt_commands: i64,
    /// `result.claimsUnverified === true`.
    pub claims_unverified: bool,
    /// `result.tail`.
    pub result_tail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BriefView {
    pub tier: Tier,
    /// How many done-when checks it has.
    pub done_when: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkstreamView {
    pub workstream_id: WorkstreamId,
    pub project_ref: ProjectRef,
    pub brief: Option<BriefView>,
    /// The pinned playbook ref, when it has one.
    pub playbook: Option<String>,
}

/// The parts of a pinned playbook the train and reviews read.
#[derive(Clone, Debug, PartialEq)]
pub struct PlaybookView {
    /// `valueBar.requireSource`.
    pub require_source: bool,
    /// `reviewRules`, by tier S, M, L.
    pub review_rules: [ReviewRule; 3],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecisionView {
    pub decision_id: String,
    pub key: String,
    pub value: String,
    pub why: Option<String>,
    /// Global scope (else project or workstream).
    pub global: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IncidentInput {
    pub class: &'static str,
    pub project_ref: ProjectRef,
    pub workstream_id: Option<WorkstreamId>,
    pub task_id: Option<TaskId>,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventView {
    pub seq: i64,
    pub event_type: String,
    pub data: Value,
}

/// A review task as Tasks.spawn takes it (kind "review", no areas), from the caller `by` in `project_ref`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewSpawn {
    pub project_ref: ProjectRef,
    pub by: &'static str,
    pub workstream_id: WorkstreamId,
    pub title: String,
    pub prompt: String,
    pub serves: String,
    pub pr: String,
    pub tier: Tier,
    pub model: Option<String>,
}

/// One runner on a machine as a provider instance (executor/providers, from the node's `runner_info`).
pub use crate::hub::executor::providers::ProviderInstance as ProviderView;

/// One entry of a PR's verdict history, newest first, as the value bar's review rules read it.
pub use crate::hub::valuebar::rules::PrVerdict;

/// The value bar's review refusal (`valuebar::rules::review_refusal`), for a hub-spawned review round.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewRefusal {
    pub message: String,
    /// Set when the polish-loop rule fired.
    pub polish_loop: bool,
}

pub trait TrainHost: Send + Sync + 'static {
    fn task(&self, task_id: &TaskId) -> Option<TaskView>;
    /// The project's running write tasks with their branches, whose PRs the train watches for a draft marked ready.
    fn running_writers(&self, project_ref: &ProjectRef) -> Vec<(TaskId, String)>;
    /// Tasks.message from `by`; the error is its message.
    fn message_task<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
        by: &'static str,
        task_id: &'a TaskId,
        text: String,
    ) -> BoxFut<'a, Result<(), String>>;
    /// Tasks.spawn of a review task; the error is its message.
    fn spawn_review(&self, spawn: ReviewSpawn) -> BoxFut<'_, Result<TaskView, String>>;
    fn workstream(&self, workstream_id: &WorkstreamId) -> Option<WorkstreamView>;
    /// Playbooks.byRef.
    fn playbook(&self, pin: &str) -> Option<PlaybookView>;
    /// Decisions.resolve along the project's chain.
    fn resolve_decision(&self, key: &str, project_ref: &ProjectRef) -> Option<DecisionView>;
    /// Decisions.record of `key = value` at the project's scope, by `by` (`human:<name>` or an agent key's name).
    fn record_decision(
        &self,
        key: &str,
        project_ref: &ProjectRef,
        value: &str,
        why: Option<&str>,
        human: bool,
        by: &str,
    ) -> Result<(), String>;
    /// Decisions.retire.
    fn retire_decision(&self, decision_id: &str) -> Result<(), String>;
    fn record_incident(&self, incident: IncidentInput);
    /// EventLog.append at now, on the project.
    fn append_event(
        &self,
        project_ref: &ProjectRef,
        event_type: &'static str,
        summary: String,
        data: Value,
    );
    fn events_head(&self) -> i64;
    /// EventLog.wait: the events after `cursor` of these types, and the new cursor.
    fn events_wait<'a>(
        &'a self,
        cursor: i64,
        types: &'a [&'static str],
        timeout_sec: u64,
    ) -> BoxFut<'a, (Vec<EventView>, i64)>;
    /// The project's checkout (`workspaceRoot`) on its machine.
    fn project_root(&self, project_ref: &ProjectRef) -> Option<String>;
    /// LeadWakes.trigger(ref, { kind: "train", line }).
    fn wake_lead<'a>(&'a self, project_ref: &'a ProjectRef, line: String) -> BoxFut<'a, ()>;
    /// NodeCommands.run: argv on the machine, through its node.
    fn run_command<'a>(
        &'a self,
        machine_id: &'a MachineId,
        cwd: &'a str,
        argv: Vec<String>,
        timeout_sec: u64,
    ) -> BoxFut<'a, Result<CmdOut, String>>;
    /// ProviderList.instances.
    fn provider_instances<'a>(
        &'a self,
        machine_id: &'a MachineId,
    ) -> BoxFut<'a, Result<Vec<ProviderView>, String>>;
    /// valuebar `reviewRefusal({ workstreamId, kind: "review", pr }, "hub:reviews", headSha, verdicts)`.
    fn review_refusal(
        &self,
        workstream_id: &WorkstreamId,
        pr: &str,
        head_sha: &str,
        verdicts: &[PrVerdict],
    ) -> Option<ReviewRefusal>;
    /// The project's branch prefix (its policy's `branchPrefix`, default `fleetd/`); None when the policy can't be
    /// read now. The train's scratch branches (batches, speculative builds of stacked PRs) live under
    /// `<prefix>train/`, so fleets sharing one repo never collide.
    fn branch_prefix<'a>(&'a self, _project_ref: &'a ProjectRef) -> BoxFut<'a, Option<String>> {
        Box::pin(async { Some(fleetd_contracts::tasks::DEFAULT_BRANCH_PREFIX.to_string()) })
    }
    /// Where the train's state, CI and git spans go; none in tests.
    fn time(&self) -> Option<crate::hub::time::TimeSink> {
        None
    }
}
