//! What leads read from areas that merge after them (chat, tasks, train, usage, work). `hub/serve` sets the hub and
//! the tasks hook once; while they are unset (a leads area on its own), each reads as "nothing to show".
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock, Weak};

use fleetd_contracts::ids::{ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::repos::RepoId;
use fleetd_contracts::tasks::TaskId;
use fleetd_contracts::usage::UsageParked;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

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

#[derive(Default)]
pub struct LeadHooks {
    /// The chat, for fleetd's own lines about the lead.
    pub chat: OnceLock<Arc<crate::hub::chat::Chat>>,
    /// The hub, for usage, the train and the work ledger.
    pub hub: OnceLock<Weak<crate::hub::api::Hub>>,
    pub tasks: OnceLock<Arc<dyn TasksHook>>,
}

fn usage_ref(thread: &ThreadRef) -> Option<crate::hub::usage::ports::ThreadRef> {
    crate::hub::usage::wire::convert(thread)
}

impl LeadHooks {
    fn hub(&self) -> Option<Arc<crate::hub::api::Hub>> {
        self.hub.get()?.upgrade()
    }

    /// Why no turn may go into the login the project's lead runs on now (its machine's own, or its Claude account
    /// there); None when it may.
    pub fn usage_gate(&self, project: &ProjectRef) -> Option<String> {
        let hub = self.hub()?;
        let account = crate::hub::claude_accounts::lead_account_key(&hub.db, project);
        hub.usage
            .gate_for(project.machine_id.as_str(), account.as_deref())
    }

    /// The thread hit a usage limit and is parked.
    pub fn parked_of(&self, thread: &ThreadRef) -> Option<UsageParked> {
        crate::hub::usage::wire::convert(&self.hub()?.usage.parked_of(&usage_ref(thread)?)?)
    }

    /// Why this thread's next turn must wait (login paused or thread parked); None when it may go.
    pub fn usage_hold(&self, thread: &ThreadRef) -> Option<String> {
        self.hub()?.usage.hold(&usage_ref(thread)?)
    }

    /// Resolves once `usage_hold` would say None.
    pub fn when_clear(&self, thread: &ThreadRef) -> BoxFuture<()> {
        let (hub, r) = (self.hub(), usage_ref(thread));
        Box::pin(async move {
            if let (Some(hub), Some(r)) = (hub, r) {
                hub.usage.when_clear(&r).await;
            }
        })
    }

    /// The digest's train lines; None when the project has no train and no change: the digest leaves the section out.
    pub fn train_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
    ) -> Option<Vec<String>> {
        let hub = self.hub()?;
        let facts = crate::hub::train::digest::train_facts(hub.train.records(), |r| {
            r.machine_id == project_ref.machine_id && r.project_id == project_ref.project_id
        });
        if facts.trains.is_empty() && facts.changes.is_empty() {
            return None;
        }
        Some(crate::hub::train::digest::lead_train_lines(
            &facts,
            since.map(|s| s.0.as_str()),
        ))
    }

    /// The workstream's PRs on the train that are not merged or abandoned, as `#<n> <state>`.
    pub fn unlanded(&self, project_ref: &ProjectRef, workstream_id: &WorkstreamId) -> Vec<String> {
        let Some(hub) = self.hub() else {
            return Vec::new();
        };
        hub.train
            .records()
            .unlanded(project_ref, workstream_id.as_str())
            .iter()
            .map(|c| {
                format!(
                    "#{} {}",
                    c.pr_number.get(),
                    crate::hub::train::contract::state_str(c.state)
                )
            })
            .collect()
    }

    /// The digest's "Elsewhere" lines from the work ledger; None when the project's repo and base aren't known, or
    /// the ledger can't be read.
    pub fn elsewhere(&self, project_ref: &ProjectRef) -> Option<Vec<String>> {
        match self.hub()?.work.elsewhere(project_ref) {
            Ok(lines) => lines,
            Err(error) => {
                tracing::warn!(%error, "the digest's Elsewhere lines");
                None
            }
        }
    }
}
