//! What leads read from areas that merge after them (tasks, checks, estimates, train, leases, usage). Each area sets
//! its hook once in `hub/serve`; an unset hook reads as "nothing to show", which is what the TS hub showed before that
//! milestone existed. The calls mirror the TS cross-service calls exactly.
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::ledger::{Workstream, WorkstreamId};
use fleetd_contracts::tasks::TaskId;
use fleetd_contracts::usage::UsageParked;
use fleetd_contracts::verification::{Claim, Eta};

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// M4 usage (TS Usage.gate/parkedOf/hold/whenClear).
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

/// Tasks (TS TaskRecords.forDigest + taskDigestLines, Tasks.list/cancel for removed projects).
pub trait TasksHook: Send + Sync {
    /// The digest's "Tasks" lines: `taskDigestLines(forDigest(ref, since, limit), since)`.
    fn digest_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
        limit: usize,
    ) -> Vec<String>;
    /// Live (queued, running, idle) tasks, in one project or all.
    fn live(&self, project_ref: Option<&ProjectRef>) -> Vec<(TaskId, ProjectRef)>;
    /// `Tasks.cancel({projectRef, by: "hub"}, taskId, reason)`, errors ignored.
    fn cancel(&self, project_ref: &ProjectRef, task_id: &TaskId, reason: &str) -> BoxFuture<()>;
}

/// Checks (TS ClaimRecords.list({workstreamId, limit: 1})).
pub trait ClaimsHook: Send + Sync {
    fn latest(&self, workstream_id: &WorkstreamId) -> Option<Claim>;
    /// Newest first, at most `limit` (workstream_get shows 20).
    fn list(&self, workstream_id: &WorkstreamId, limit: usize) -> Vec<Claim>;
}

/// Estimates (TS Estimates.eta/recordDone, calibration.etaText).
pub trait EstimatesHook: Send + Sync {
    fn eta(&self, workstream: &Workstream) -> Option<Eta>;
    fn eta_text(&self, eta: &Eta) -> String;
    fn record_done(&self, workstream_id: &WorkstreamId);
}

/// The merge train (TS trainFacts + leadTrainLines).
pub trait TrainHook: Send + Sync {
    /// None when the project has no train and no change: the digest leaves the section out.
    fn lead_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
    ) -> Option<Vec<String>>;
}

/// Policies (TS Policies.get(ref).finishAll.maxChildren).
pub trait PolicyHook: Send + Sync {
    /// `Err` when the policy file cannot be read: finish-all fails the call, as TS `Policies.get` did.
    fn max_children(
        &self,
        project_ref: &ProjectRef,
    ) -> BoxFuture<Result<Option<u32>, super::error::LeadError>>;
}

/// GitHub through `gh api` (TS checks/GitHub.ts).
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
