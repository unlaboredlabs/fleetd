//! What leads read from areas that merge after them (tasks, train, usage, work). Each area sets
//! its hook once in `hub/serve`; an unset hook reads as "nothing to show".
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::repos::RepoId;
use fleetd_contracts::tasks::TaskId;
use fleetd_contracts::usage::UsageParked;

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

/// Tasks: digest lines, the agents line, and listing and cancelling the tasks of removed projects and closed orders.
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
    /// Live tasks that work in a repo, each with it: for ending a removed repo's.
    fn live_in_repos(&self) -> Vec<(TaskId, ProjectRef, RepoId)> {
        Vec::new()
    }
    /// `Tasks.cancel({projectRef, by: "hub"}, taskId, reason)`, errors ignored.
    fn cancel(&self, project_ref: &ProjectRef, task_id: &TaskId, reason: &str) -> BoxFuture<()>;
    /// The workstream's tasks still queued, running or idle, other than the reviewers the merge train spawned for its
    /// PRs, which the train ends itself.
    fn leftovers(&self, project_ref: &ProjectRef, workstream_id: &WorkstreamId) -> Vec<TaskId>;
}

/// The merge train.
pub trait TrainHook: Send + Sync {
    /// None when the project has no train and no change: the digest leaves the section out.
    fn lead_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
    ) -> Option<Vec<String>>;
    /// The workstream's PRs on the train that are not merged or abandoned, as `#<n> <state>`.
    fn unlanded(&self, project_ref: &ProjectRef, workstream_id: &WorkstreamId) -> Vec<String>;
}

/// The work ledger.
pub trait WorkHook: Send + Sync {
    /// The digest's "Elsewhere" lines; None when the project's repo and base aren't known.
    fn elsewhere(&self, project_ref: &ProjectRef) -> BoxFuture<Option<Vec<String>>>;
}

/// GitHub through `gh api`.
pub trait GitHubHook: Send + Sync {
    fn api(&self, path: &str) -> BoxFuture<Result<serde_json::Value, String>>;
}

#[derive(Default)]
pub struct LeadHooks {
    pub usage: OnceLock<Arc<dyn UsageHook>>,
    pub tasks: OnceLock<Arc<dyn TasksHook>>,
    pub train: OnceLock<Arc<dyn TrainHook>>,
    pub work: OnceLock<Arc<dyn WorkHook>>,
}
