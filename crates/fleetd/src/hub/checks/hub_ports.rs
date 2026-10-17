//! The hub's `Ports` and `DetectorPorts`: this slice's view of the other areas, forwarding to their services on the
//! `Hub`. Built before the `Hub` exists (the services that hold it go into the `Hub`), so it is bound right after.
//!
//! Each `// PORT:` method's area is not on `main` yet, so it answers as if there were nothing (no workstream, no
//! task, no node link); the integration slice replaces it with a forward to the named call.
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
    // PORT: leads: LeadRecords.workstreams.get
    fn workstream(&self, _: &WorkstreamId) -> Option<Workstream> {
        None
    }
    // PORT: leads: LeadRecords.workstreams.put, keeping amends
    fn put_workstream(&self, _: &Workstream) {}
    // PORT: leads: LeadWakes.trigger(Trigger::Line { ClaimFailed | ClaimPassed, render::claim_* })
    fn wake(&self, _: &ProjectRef, _: ClaimWake) {}
    // PORT: link: NodeCommands.run(machine, CommandInput { cwd, argv, timeout_sec: None })
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
    // PORT: playbooks: Playbooks.by_ref -> valueBar.maxReviewRounds, estimatePrior
    fn playbook_limits(&self, _: &PlaybookRef) -> Option<PlaybookLimits> {
        None
    }
    // PORT: playbooks: Research.record_verdict -> its text
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
    // PORT: tasks: TaskRecords.get
    fn task(&self, _: &TaskId) -> Option<Task> {
        None
    }
    // PORT: tasks: Tasks.list { project_ref, workstream_id, limit }
    fn tasks_of(&self, _: &ProjectRef, _: &WorkstreamId, _: usize) -> Vec<Task> {
        Vec::new()
    }
    // PORT: tasks: Tasks.spawn as by "hub:judge", kind review, areas []
    fn spawn_judge(&self, _: JudgeSpawn) -> BoxFuture<'_, Result<Task, Refusal>> {
        Box::pin(async { Err(invalid("The hub cannot spawn tasks yet.", None)) })
    }
    // PORT: ledger: Asks.create(kind do, class product, by "hub:claims")
    fn file_human_ask(&self, _: HumanAsk) -> BoxFuture<'_, Result<HumanAskFiled, Refusal>> {
        Box::pin(async { Err(invalid("The hub cannot file asks yet.", None)) })
    }
    // PORT: ledger: Asks.get -> answer.value
    fn ask_answer(&self, _: &AskId) -> Option<String> {
        None
    }
    // PORT: executor: Executors.actions(thread, max)
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
    // PORT: tasks: TaskRecords.by_thread
    fn task_by_thread(&self, _: &ThreadRef) -> Option<Task> {
        None
    }
    // PORT: ledger: Decisions.get
    fn decision(&self, _: &DecisionId) -> Option<Decision> {
        None
    }
    // PORT: ledger: Decisions.active_on_key
    fn decisions_active_on_key(&self, _: &DecisionKey, _: &ProjectRef) -> Vec<Decision> {
        Vec::new()
    }
    // PORT: ledger: Asks.get
    fn ask(&self, _: &AskId) -> Option<Ask> {
        None
    }
}
