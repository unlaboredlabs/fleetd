//! The hub's `Ports`: this slice's view of the other areas, forwarding to their services on the
//! `Hub`. Built before the `Hub` exists (the services that hold it go into the `Hub`), so it is bound right after.
//! Before `bind` (or after the hub is dropped) each answers as if there were nothing.
use super::ports::{BoxFuture, Ports};
use crate::hub::api::Hub;
use fleetd_contracts::tasks::{Task, TaskId};
use fleetd_contracts::verification::CommitSha;
use std::sync::{Arc, OnceLock, Weak};

#[derive(Default)]
pub struct HubPorts {
    hub: OnceLock<Weak<Hub>>,
}

impl HubPorts {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Called once by `hub::serve::build_on`, after the `Hub` is built.
    pub fn bind(&self, hub: &Arc<Hub>) {
        let _ = self.hub.set(Arc::downgrade(hub));
    }

    fn hub(&self) -> Option<Arc<Hub>> {
        self.hub.get()?.upgrade()
    }
}

impl Ports for HubPorts {
    fn task(&self, id: &TaskId) -> Option<Task> {
        logged(self.hub()?.tasks.get(id), "reading a task").flatten()
    }
    fn reviewed_head<'a>(&'a self, task: &'a Task) -> BoxFuture<'a, Option<CommitSha>> {
        Box::pin(async move {
            let hub = self.hub()?;
            // A train round reviews the head it was spawned for: any head with the round's patch id binds the same.
            let round: Option<String> = hub
                .db
                .with(|c| {
                    Ok(rusqlite::OptionalExtension::optional(c.query_row(
                        "SELECT p.head_sha FROM review_tasks t JOIN review_patch_ids p ON p.change_id = t.change_id AND p.patch_id = t.patch_id WHERE t.task_id = ?1 LIMIT 1",
                        [task.task_id.as_str()],
                        |r| r.get(0),
                    ))?)
                })
                .ok()
                .flatten();
            if let Some(sha) = round {
                return CommitSha::new(sha).ok();
            }
            let pr = fleetd_contracts::train::parse_pr_url(task.pr.as_ref()?.as_str())?;
            let detail = hub.prs.github.detail(&pr.repo, pr.pr_number).await.value?;
            CommitSha::new(detail.pull.head_ref_oid.to_lowercase()).ok()
        })
    }
}

/// A failed read or write is logged and answered as "nothing", as the stub did.
fn logged<T, E: std::fmt::Display>(result: Result<T, E>, what: &str) -> Option<T> {
    result
        .map_err(|error| tracing::warn!(%error, "checks: {what} failed"))
        .ok()
}
