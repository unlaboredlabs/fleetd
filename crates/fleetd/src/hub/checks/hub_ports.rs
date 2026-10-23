//! The hub's `Ports`: this slice's view of the other areas, forwarding to their services on the
//! `Hub`. Built before the `Hub` exists (the services that hold it go into the `Hub`), so it is bound right after.
//! Before `bind` (or after the hub is dropped) each answers as if there were nothing.
use super::ports::{BoxFuture, Ports, Refusal, invalid};
use crate::hub::api::Hub;
use fleetd_contracts::ids::{MachineId, ThreadRef};
use fleetd_contracts::ledger::{MetricValues, Workstream, WorkstreamId};
use fleetd_contracts::model::ActionItem;
use fleetd_contracts::tasks::{Task, TaskId};
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

fn not_linked(machine: &MachineId) -> String {
    format!("{machine}'s node is not linked to the hub")
}

impl Ports for HubPorts {
    fn workstream(&self, id: &WorkstreamId) -> Option<Workstream> {
        let stored = self.hub()?.leads.records.workstream_get(id);
        logged(stored, "reading a workstream").flatten()
    }
    fn research_verdict<'a>(
        &'a self,
        workstream: &'a WorkstreamId,
        values: MetricValues,
    ) -> BoxFuture<'a, Result<String, Refusal>> {
        Box::pin(async move {
            let Some(hub) = self.hub() else {
                return Err(invalid(
                    format!("{workstream} has no research verdict to record."),
                    None,
                ));
            };
            let (_, text) = hub
                .leads
                .research
                .record_verdict(workstream, values)
                .await?;
            Ok(text)
        })
    }
    fn task(&self, id: &TaskId) -> Option<Task> {
        logged(self.hub()?.tasks.get(id), "reading a task").flatten()
    }
    fn thread_actions<'a>(
        &'a self,
        thread: &'a ThreadRef,
        max: usize,
    ) -> BoxFuture<'a, Result<Vec<ActionItem>, String>> {
        Box::pin(async move {
            let Some(hub) = self.hub() else {
                return Err(not_linked(&thread.machine_id));
            };
            let actions = hub
                .executors
                .actions(thread, max, false)
                .await
                .map_err(|e| e.to_string())?;
            // The executor's Action is the contract's ActionItem field for field.
            Ok(actions
                .into_iter()
                .filter_map(|a| {
                    serde_json::to_value(a)
                        .and_then(serde_json::from_value)
                        .map_err(|error| tracing::warn!(%error, "an action did not fit ActionItem"))
                        .ok()
                })
                .collect())
        })
    }
}

/// A failed read or write is logged and answered as "nothing", as the stub did.
fn logged<T, E: std::fmt::Display>(result: Result<T, E>, what: &str) -> Option<T> {
    result
        .map_err(|error| tracing::warn!(%error, "checks: {what} failed"))
        .ok()
}
