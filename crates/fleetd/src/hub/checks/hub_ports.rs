//! The hub's `Ports` and `DetectorPorts`: this slice's view of the other areas, forwarding to their services on the
//! `Hub`. Built before the `Hub` exists (the services that hold it go into the `Hub`), so it is bound right after.
//!
//! The parts whose areas are not on `main` yet answer as if there were nothing (no workstream, no task, no node
//! link); each is replaced by a one-line forward as its area lands: leads (workstreams, wakes), tasks, ledger
//! (asks, decisions), playbooks (limits, research verdicts), link (node commands) and executor (thread actions).
use super::ports::{
    BoxFuture, ClaimWake, CommandRun, HumanAsk, HumanAskFiled, JudgeSpawn, PlaybookLimits, Ports,
    Refusal, invalid,
};
use crate::hub::api::Hub;
use crate::hub::incidents::detectors::DetectorPorts;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef};
use fleetd_contracts::ledger::{
    Ask, AskId, Decision, DecisionId, DecisionKey, MetricValues, PlaybookRef, Workstream,
    WorkstreamId,
};
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
    fn workstream(&self, _: &WorkstreamId) -> Option<Workstream> {
        None
    }
    fn put_workstream(&self, _: &Workstream) {}
    fn wake(&self, _: &ProjectRef, _: ClaimWake) {}
    fn run_command(
        &self,
        machine: &MachineId,
        _: String,
        _: Vec<String>,
    ) -> BoxFuture<'_, Result<CommandRun, String>> {
        let error = not_linked(machine);
        Box::pin(async move { Err(error) })
    }
    fn workspace_root(&self, project: &ProjectRef) -> Option<String> {
        let summary = self.hub()?.store.project_get(project).ok()??;
        Some(summary.workspace_root)
    }
    fn playbook_limits(&self, _: &PlaybookRef) -> Option<PlaybookLimits> {
        None
    }
    fn research_verdict<'a>(
        &'a self,
        workstream: &'a WorkstreamId,
        _: MetricValues,
    ) -> BoxFuture<'a, Result<String, Refusal>> {
        let error = invalid(
            format!("{workstream} has no research verdict to record."),
            None,
        );
        Box::pin(async move { Err(error) })
    }
    fn task(&self, _: &TaskId) -> Option<Task> {
        None
    }
    fn tasks_of(&self, _: &ProjectRef, _: &WorkstreamId, _: usize) -> Vec<Task> {
        Vec::new()
    }
    fn spawn_judge(&self, _: JudgeSpawn) -> BoxFuture<'_, Result<Task, Refusal>> {
        Box::pin(async { Err(invalid("The hub cannot spawn tasks yet.", None)) })
    }
    fn file_human_ask(&self, _: HumanAsk) -> BoxFuture<'_, Result<HumanAskFiled, Refusal>> {
        Box::pin(async { Err(invalid("The hub cannot file asks yet.", None)) })
    }
    fn ask_answer(&self, _: &AskId) -> Option<String> {
        None
    }
    fn thread_actions<'a>(
        &'a self,
        thread: &'a ThreadRef,
        _: usize,
    ) -> BoxFuture<'a, Result<Vec<ActionItem>, String>> {
        let error = not_linked(&thread.machine_id);
        Box::pin(async move { Err(error) })
    }
}

impl DetectorPorts for HubPorts {
    fn task_by_thread(&self, _: &ThreadRef) -> Option<Task> {
        None
    }
    fn decision(&self, _: &DecisionId) -> Option<Decision> {
        None
    }
    fn decisions_active_on_key(&self, _: &DecisionKey, _: &ProjectRef) -> Vec<Decision> {
        Vec::new()
    }
    fn ask(&self, _: &AskId) -> Option<Ask> {
        None
    }
}
