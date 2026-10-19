//! What leads read from areas that merge after them (tasks, checks, estimates, train, leases, usage). Each area sets
//! its hook once in `hub/serve`; an unset hook reads as "nothing to show".
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::ledger::{Workstream, WorkstreamId};
use fleetd_contracts::tasks::TaskId;
use fleetd_contracts::usage::UsageParked;
use fleetd_contracts::verification::{Claim, Eta};

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

/// Tasks: digest lines, and listing and cancelling the tasks of removed projects.
pub trait TasksHook: Send + Sync {
    /// The digest's "Tasks" lines: `taskDigestLines(forDigest(ref, since, limit), since)`.
    fn digest_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
        limit: usize,
        prompts: &crate::hub::prompts::PromptSet,
    ) -> Vec<String>;
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
}

/// Estimates: ETAs and recording a done workstream.
pub trait EstimatesHook: Send + Sync {
    fn eta(&self, workstream: &Workstream) -> Option<Eta>;
    fn record_done(&self, workstream_id: &WorkstreamId);
}

/// The merge train.
pub trait TrainHook: Send + Sync {
    /// None when the project has no train and no change: the digest leaves the section out.
    fn lead_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
        prompts: &crate::hub::prompts::PromptSet,
    ) -> Option<Vec<String>>;
}

/// Policies: finish-all's max children, and whether an order starts the project's lead.
pub trait PolicyHook: Send + Sync {
    /// `Err` when the policy file cannot be read: finish-all fails the call.
    fn max_children(
        &self,
        project_ref: &ProjectRef,
    ) -> BoxFuture<Result<Option<u32>, super::error::LeadError>>;
    /// `lead.autoStart`, true without it; `Err` when the policy file cannot be read.
    fn auto_start(
        &self,
        project_ref: &ProjectRef,
    ) -> BoxFuture<Result<bool, super::error::LeadError>>;
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
    pub estimates: OnceLock<Arc<dyn EstimatesHook>>,
    pub train: OnceLock<Arc<dyn TrainHook>>,
    pub policy: OnceLock<Arc<dyn PolicyHook>>,
    pub github: OnceLock<Arc<dyn GitHubHook>>,
}
