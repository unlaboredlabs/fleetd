//! What the checks, receipts, value bar, estimates and incidents areas need from other hub areas, as one trait.
//! The hub's implementation (`HubPorts`, wired once those areas land) forwards to their services; tests use fakes.
//! Keeping it to this one seam means the claim flow and the value bar run their real logic under test.
use fleetd_contracts::{
    ActionItem, AskId, CheckResult, ClaimId, MetricValues, PlaybookRef, ProjectRef, Task, TaskId, ThreadRef, Workstream,
    WorkstreamId,
};
use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The lead wakes a claim causes; the leads area renders them with `checks::render`.
#[derive(Debug, Clone, PartialEq)]
pub enum ClaimWake {
    Failed { claim_id: ClaimId, workstream_id: WorkstreamId, failures: Vec<CheckResult> },
    Passed { claim_id: ClaimId, workstream_id: WorkstreamId },
}

/// The pinned playbook's numbers the value bar and estimates read.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaybookLimits {
    pub max_review_rounds: u32,
    pub estimate_prior: f64,
}

/// A `do` ask a `human` check files (Asks.create with by = "hub:claims").
#[derive(Debug, Clone, PartialEq)]
pub struct HumanAsk {
    pub project_ref: ProjectRef,
    pub workstream_id: WorkstreamId,
    /// `<workstream>.<claim>.done-<i>`, lowercase.
    pub key: String,
    pub text: String,
    pub step_text: String,
    pub step_expect: String,
    pub blocks: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HumanAskFiled {
    pub ask_id: AskId,
    /// Set when the ledger answered it at once from an existing decision (state "auto").
    pub auto_value: Option<String>,
}

/// A review task the hub spawns for a `judge` check (by = "hub:judge", areas none).
#[derive(Debug, Clone, PartialEq)]
pub struct JudgeSpawn {
    pub project_ref: ProjectRef,
    pub workstream_id: WorkstreamId,
    pub title: String,
    pub prompt: String,
}

/// A refusal at the wire (TS LeadError): `code` is "invalid", "not_found", ...; the same texts as TS.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
    pub fix: Option<String>,
}

impl Refusal {
    pub fn invalid(message: impl Into<String>, fix: Option<&str>) -> Self {
        Self { code: "invalid", message: message.into(), fix: fix.map(str::to_owned) }
    }
    pub fn not_found(message: impl Into<String>, fix: Option<&str>) -> Self {
        Self { code: "not_found", message: message.into(), fix: fix.map(str::to_owned) }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub trait Ports: Send + Sync + 'static {
    // leads: LeadRecords.workstreams
    fn workstream(&self, id: &WorkstreamId) -> Option<Workstream>;
    /// Replaces the stored workstream, keeping its amends.
    fn put_workstream(&self, workstream: &Workstream);
    // leads: LeadWakes.trigger
    fn wake(&self, project: &ProjectRef, wake: ClaimWake);
    // store: HubStore.projects
    fn workspace_root(&self, project: &ProjectRef) -> Option<String>;
    // playbooks
    fn playbook_limits(&self, playbook: &PlaybookRef) -> Option<PlaybookLimits>;
    /// Research.recordVerdict: stores the computed research verdict and returns its text.
    fn research_verdict<'a>(&'a self, workstream: &'a WorkstreamId, values: MetricValues) -> BoxFuture<'a, Result<String, Refusal>>;
    // tasks
    fn task(&self, id: &TaskId) -> Option<Task>;
    /// The workstream's tasks, newest first.
    fn tasks_of(&self, project: &ProjectRef, workstream: &WorkstreamId, limit: usize) -> Vec<Task>;
    fn spawn_judge(&self, spawn: JudgeSpawn) -> BoxFuture<'_, Result<Task, Refusal>>;
    // ledger: Asks
    fn file_human_ask(&self, ask: HumanAsk) -> BoxFuture<'_, Result<HumanAskFiled, Refusal>>;
    fn ask_answer(&self, id: &AskId) -> Option<String>;
    // executor
    fn thread_actions<'a>(&'a self, thread: &'a ThreadRef, max: usize) -> BoxFuture<'a, Result<Vec<ActionItem>, String>>;
}
