//! The hub's `TrainHost`: the train and reviews reach other areas only through here. The event log and the project
//! store are wired; every `// PORT:` method is a stub until its area is on main (the PR's "Unwired" list), and the
//! integration slice replaces the stub with a call into that area's service.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::Timestamp;
use serde_json::Value;

use super::contract::{MachineId, ProjectRef, TaskId, WorkstreamId};
use super::host::{
    BoxFut, CmdOut, DecisionView, EventView, IncidentInput, PlaybookView, PrVerdict, ProviderView,
    ReviewRefusal, ReviewSpawn, TaskView, TrainHost, WorkstreamView,
};
use crate::clock::Clock;
use crate::hub::store::{EventLog, HubStore, NewEvent, WaitInput, iso_ms, now_ms};

pub struct HubHost {
    pub clock: Arc<dyn Clock>,
    pub events: Arc<EventLog>,
    pub store: Arc<HubStore>,
}

fn event_type(name: &str) -> Option<HubEventType> {
    serde_json::from_value(Value::String(name.into())).ok()
}

impl TrainHost for HubHost {
    // PORT: tasks (Tasks::get, mapped to TaskView).
    fn task(&self, _task_id: &TaskId) -> Option<TaskView> {
        None
    }

    // PORT: tasks (Tasks::message with TaskCaller { project_ref, by }).
    fn message_task<'a>(
        &'a self,
        _: &'a ProjectRef,
        _: &'static str,
        task_id: &'a TaskId,
        _: String,
    ) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            Err(format!(
                "tasks are not wired yet; {task_id} was not messaged"
            ))
        })
    }

    // PORT: tasks (Tasks::spawn of a kind "review" TaskSpawnCall with the caller "hub:reviews").
    fn spawn_review(&self, _: ReviewSpawn) -> BoxFut<'_, Result<TaskView, String>> {
        Box::pin(async { Err("tasks are not wired yet".to_string()) })
    }

    // PORT: leads (LeadRecords.workstreams.get: project, brief tier and done-when count, playbook pin).
    fn workstream(&self, _: &WorkstreamId) -> Option<WorkstreamView> {
        None
    }

    // PORT: playbooks (Playbooks::by_ref: valueBar.requireSource and reviewRules).
    fn playbook(&self, _: &str) -> Option<PlaybookView> {
        None
    }

    // PORT: ledger (Decisions::resolve along the project's chain).
    fn resolve_decision(&self, _: &str, _: &ProjectRef) -> Option<DecisionView> {
        None
    }

    // PORT: ledger (Decisions::record at project scope with Actor { source: human|agent, by }).
    fn record_decision(
        &self,
        key: &str,
        _: &ProjectRef,
        _: &str,
        _: Option<&str>,
        _: bool,
        _: &str,
    ) -> Result<(), String> {
        Err(format!(
            "the ledger is not wired yet; {key} was not recorded"
        ))
    }

    // PORT: ledger (Decisions::retire).
    fn retire_decision(&self, decision_id: &str) -> Result<(), String> {
        Err(format!(
            "the ledger is not wired yet; {decision_id} was not retired"
        ))
    }

    // PORT: incidents (Incidents::record).
    fn record_incident(&self, incident: IncidentInput) {
        tracing::warn!(class = incident.class, evidence = ?incident.evidence, "train: incident not recorded (incidents not wired)");
    }

    fn append_event(
        &self,
        project_ref: &ProjectRef,
        event_type_name: &'static str,
        summary: String,
        data: Value,
    ) {
        let Some(r#type) = event_type(event_type_name) else {
            return tracing::warn!(event_type_name, "train: unknown event type");
        };
        let event = NewEvent {
            at: Timestamp(iso_ms(now_ms(self.clock.as_ref()))),
            r#type,
            machine_id: Some(project_ref.machine_id.clone()),
            project_id: Some(project_ref.project_id.clone()),
            thread_id: None,
            summary,
            data: Some(data),
            attention: None,
        };
        if let Err(e) = self.events.append(event) {
            tracing::warn!(error = %e, "train: event not appended");
        }
    }

    fn events_head(&self) -> i64 {
        self.events.head()
    }

    fn events_wait<'a>(
        &'a self,
        cursor: i64,
        types: &'a [&'static str],
        timeout_sec: u64,
    ) -> BoxFut<'a, (Vec<EventView>, i64)> {
        Box::pin(async move {
            let input = WaitInput {
                cursor: Some(cursor),
                types: Some(types.iter().filter_map(|t| event_type(t)).collect()),
                machine_id: None,
                timeout_sec,
            };
            match self.events.wait(input).await {
                Ok(page) => {
                    let events = page
                        .events
                        .into_iter()
                        .map(|e| EventView {
                            seq: e.seq.get(),
                            event_type: e.r#type.as_str().to_string(),
                            data: e.data.unwrap_or(Value::Null),
                        })
                        .collect();
                    (events, page.cursor.max(cursor))
                }
                Err(e) => {
                    tracing::warn!(error = %e, "train: events not read");
                    self.clock.sleep(Duration::from_secs(1)).await;
                    (Vec::new(), cursor)
                }
            }
        })
    }

    fn project_root(&self, project_ref: &ProjectRef) -> Option<String> {
        self.store
            .project_get(project_ref)
            .ok()
            .flatten()
            .map(|p| p.workspace_root)
    }

    // PORT: leads (LeadWakes::trigger(ref, { kind: "train", line })).
    fn wake_lead<'a>(&'a self, project_ref: &'a ProjectRef, line: String) -> BoxFut<'a, ()> {
        tracing::warn!(machine = %project_ref.machine_id, project = %project_ref.project_id, line, "train: lead not woken (leads not wired)");
        Box::pin(async {})
    }

    // PORT: link (NodeCommands::run with CommandInput { cwd, argv, timeout_sec }, CmdResult mapped to CmdOut).
    fn run_command<'a>(
        &'a self,
        machine_id: &'a MachineId,
        _: &'a str,
        _: Vec<String>,
        _: u64,
    ) -> BoxFut<'a, Result<CmdOut, String>> {
        Box::pin(async move {
            Err(format!(
                "node commands are not wired yet; nothing ran on {machine_id}"
            ))
        })
    }

    // PORT: executor (Executors::provider_instances, mapped to ProviderView).
    fn provider_instances<'a>(
        &'a self,
        _: &'a MachineId,
    ) -> BoxFut<'a, Result<Vec<ProviderView>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    // PORT: valuebar (rules::review_refusal(SpawnRequest { workstream_id, kind: Review, pr }, "hub:reviews", head, verdicts, None)).
    fn review_refusal(
        &self,
        _: &WorkstreamId,
        _: &str,
        _: &str,
        _: &[PrVerdict],
    ) -> Option<ReviewRefusal> {
        None
    }
}
