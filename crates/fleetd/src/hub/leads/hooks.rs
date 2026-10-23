//! What leads read from areas that merge after them (tasks, checks, train, usage). Each area sets
//! its hook once in `hub/serve`; an unset hook reads as "nothing to show".
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::tasks::TaskId;
use fleetd_contracts::usage::UsageParked;
use fleetd_contracts::verification::Claim;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// M4 usage.
pub trait UsageHook: Send + Sync {
    /// Why no turn may go into this machine's login now; None when it may.
    fn gate(&self, machine_id: &MachineId) -> Option<String>;
    /// The thread hit a usage limit and is parked.
    fn parked_of(&self, thread: &ThreadRef) -> Option<UsageParked>;
    /// Why this thread's next turn must wait (login paused or thread parked); None when it may go.
    fn hold(&self, thread: &ThreadRef) -> Option<String>;
    /// Resolves once `hold` would say None.
    fn when_clear(&self, thread: &ThreadRef) -> BoxFuture<()>;
}

/// Tasks: digest lines, the agents line, and listing and cancelling the tasks of removed projects.
pub trait TasksHook: Send + Sync {
    /// The digest's "Tasks" lines: `taskDigestLines(forDigest(ref, since, limit), since)`.
    fn digest_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
        limit: usize,
    ) -> Vec<String>;
    /// The project's agents against its cap, for the state block.
    fn agents(&self, project_ref: &ProjectRef) -> super::events::AgentsLine;
    /// Live (queued, running, idle) tasks, in one project or all.
    fn live(&self, project_ref: Option<&ProjectRef>) -> Vec<(TaskId, ProjectRef)>;
    /// `Tasks.cancel({projectRef, by: "hub"}, taskId, reason)`, errors ignored.
    fn cancel(&self, project_ref: &ProjectRef, task_id: &TaskId, reason: &str) -> BoxFuture<()>;
}

/// Checks: a workstream's latest claim.
pub trait ClaimsHook: Send + Sync {
    fn latest(&self, workstream_id: &WorkstreamId) -> Option<Claim>;
    /// Newest first, at most `limit` (workstream_get shows 20).
    fn list(&self, workstream_id: &WorkstreamId, limit: usize) -> Vec<Claim>;
    /// The brief changed: a claim still checking the old done-when stops and never counts.
    fn void(&self, workstream_id: &WorkstreamId);
}

/// The merge train.
pub trait TrainHook: Send + Sync {
    /// None when the project has no train and no change: the digest leaves the section out.
    fn lead_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
    ) -> Option<Vec<String>>;
}

/// GitHub through `gh api`.
pub trait GitHubHook: Send + Sync {
    fn api(&self, path: &str) -> BoxFuture<Result<serde_json::Value, String>>;
}

#[derive(Default)]
pub struct LeadHooks {
    pub usage: OnceLock<Arc<dyn UsageHook>>,
    pub tasks: OnceLock<Arc<dyn TasksHook>>,
    pub claims: OnceLock<Arc<dyn ClaimsHook>>,
    pub train: OnceLock<Arc<dyn TrainHook>>,
}
