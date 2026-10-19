//! Incident detectors that read the event log: stalls, writes outside a task's areas, and a human replacing a lead's
//! decision (override). The
//! other classes are recorded where the hub sees them happen (claims, estimates, the value bar, the train, the inbox).
//! Events from the hub's start on; nothing here reads a model.
use super::{IncidentInput, Incidents};
use crate::hub::store::{EventLog, StoreError, WaitInput};
use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ids::{ProjectRef, ThreadRef};
use fleetd_contracts::ledger::{
    Decision, DecisionId, DecisionKey, DecisionScope, DecisionSource, WorkstreamId,
};
use fleetd_contracts::tasks::{Task, TaskId};
use fleetd_contracts::verification::IncidentClass;
use serde::Deserialize;
use std::sync::Arc;

/// What the detectors read from the ledger and tasks.
pub trait DetectorPorts: Send + Sync + 'static {
    fn task_by_thread(&self, thread: &ThreadRef) -> Option<Task>;
    fn decision(&self, id: &DecisionId) -> Option<Decision>;
    /// Active decisions on `key` that apply in the project (its own, its workstreams', global).
    fn decisions_active_on_key(&self, key: &DecisionKey, project: &ProjectRef) -> Vec<Decision>;
}

const TYPES: [HubEventType; 4] = [
    HubEventType::ThreadStalled,
    HubEventType::ThreadFailed,
    HubEventType::TaskOutOfArea,
    HubEventType::DecisionRecorded,
];

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct EventData {
    reason: Option<String>,
    task_id: Option<TaskId>,
    workstream_id: Option<WorkstreamId>,
    paths: Option<Vec<String>>,
    decision_id: Option<DecisionId>,
    source: Option<String>,
    supersedes: Option<DecisionId>,
}

fn ref_of(event: &HubEvent) -> Option<ProjectRef> {
    Some(ProjectRef {
        machine_id: event.machine_id.clone()?,
        project_id: event.project_id.clone()?,
    })
}

fn short(value: &str) -> String {
    if value.encode_utf16().count() > 80 {
        format!("{}…", crate::hub::checks::utf16_prefix(value, 79))
    } else {
        value.to_owned()
    }
}

fn workstream_of(d: &Decision) -> Option<WorkstreamId> {
    match &d.scope {
        DecisionScope::Workstream { workstream_id } => Some(workstream_id.clone()),
        _ => None,
    }
}

/// `Date.parse` order of two ISO timestamps; equal-width UTC strings compare as text.
fn at_or_before(a: &str, b: &str) -> bool {
    a <= b
}

pub struct Detectors {
    incidents: Arc<Incidents>,
    ports: Arc<dyn DetectorPorts>,
}

impl Detectors {
    pub fn new(incidents: Arc<Incidents>, ports: Arc<dyn DetectorPorts>) -> Self {
        Self { incidents, ports }
    }

    fn record(
        &self,
        class: IncidentClass,
        project_ref: ProjectRef,
        workstream_id: Option<WorkstreamId>,
        task_id: Option<TaskId>,
        evidence: Vec<String>,
    ) -> Result<(), StoreError> {
        self.incidents.record(IncidentInput {
            class,
            project_ref,
            workstream_id,
            task_id,
            evidence,
        })?;
        Ok(())
    }

    /// A stall, or a second stall that failed the chain.
    fn stall(&self, event: &HubEvent, r: ProjectRef) -> Result<(), StoreError> {
        let task = event.thread_id.as_ref().and_then(|t| {
            self.ports.task_by_thread(&ThreadRef {
                machine_id: r.machine_id.clone(),
                thread_id: t.clone(),
            })
        });
        let (w, t) = task.map_or((None, None), |t| (Some(t.workstream_id), Some(t.task_id)));
        self.record(
            IncidentClass::Stall,
            r,
            w,
            t,
            vec![event.summary.as_str().to_owned()],
        )
    }

    /// The decisions a human one displaced: the one it superseded, and lead decisions still active on its key in the
    /// project, as of the new decision.
    fn displaced(
        &self,
        decision: &Decision,
        r: &ProjectRef,
        supersedes: Option<&DecisionId>,
    ) -> Vec<Decision> {
        // In first-seen order: the superseded one, then the active ones.
        let mut found: Vec<Decision> = Vec::new();
        let candidates = supersedes
            .and_then(|id| self.ports.decision(id))
            .into_iter()
            .chain(
                self.ports
                    .decisions_active_on_key(&decision.key, r)
                    .into_iter()
                    .filter(|d| d.decision_id != decision.decision_id),
            );
        for d in candidates {
            match found.iter_mut().find(|f| f.decision_id == d.decision_id) {
                Some(f) => *f = d,
                None => found.push(d),
            }
        }
        found.retain(|d| at_or_before(&d.at.0, &decision.at.0));
        found
    }

    fn human_decision(&self, event: &HubEvent, data: &EventData) -> Result<(), StoreError> {
        let Some(decision) = data
            .decision_id
            .as_ref()
            .and_then(|id| self.ports.decision(id))
        else {
            return Ok(());
        };
        // Global decisions have no project to charge; leads never decide globally.
        let Some(r) = ref_of(event) else {
            return Ok(());
        };
        let before = self.displaced(&decision, &r, data.supersedes.as_ref());
        let value = decision.value.as_str();
        if let Some(over) = before
            .iter()
            .find(|d| d.source == DecisionSource::Lead && d.value.as_str().trim() != value.trim())
        {
            self.record(
                IncidentClass::Override,
                r.clone(),
                workstream_of(over),
                None,
                vec![format!(
                    "{} by {} set {} = \"{}\" over the lead's {} = \"{}\"",
                    decision.decision_id,
                    decision.by.as_deref().unwrap_or("a human"),
                    decision.key,
                    short(value),
                    over.decision_id,
                    short(over.value.as_str())
                )],
            )?;
        }
        Ok(())
    }

    pub fn on_event(&self, event: &HubEvent) -> Result<(), StoreError> {
        let data: EventData = event
            .data
            .clone()
            .and_then(|d| serde_json::from_value(d).ok())
            .unwrap_or_default();
        let r = ref_of(event);
        match (event.r#type, r) {
            (HubEventType::ThreadStalled, Some(r)) => self.stall(event, r),
            (HubEventType::ThreadFailed, Some(r)) if data.reason.as_deref() == Some("stalled") => {
                self.stall(event, r)
            }
            (HubEventType::TaskOutOfArea, Some(r)) => {
                let mut evidence = vec![event.summary.as_str().to_owned()];
                evidence.extend(data.paths.clone().unwrap_or_default().into_iter().take(10));
                self.record(
                    IncidentClass::OutOfArea,
                    r,
                    data.workstream_id.clone(),
                    data.task_id.clone(),
                    evidence,
                )
            }
            (HubEventType::DecisionRecorded, _) if data.source.as_deref() == Some("human") => {
                self.human_decision(event, &data)
            }
            _ => Ok(()),
        }
    }

    /// Follows the event log from the hub's start until the hub stops.
    pub async fn run(self: Arc<Self>, events: Arc<EventLog>) {
        let mut cursor = events.head();
        loop {
            let input = WaitInput {
                cursor: Some(cursor),
                types: Some(TYPES.to_vec()),
                machine_id: None,
                timeout_sec: 3600,
            };
            let page = match events.wait(input).await {
                Ok(page) => page,
                Err(error) => {
                    tracing::warn!(%error, "incident detectors: event log not readable");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            };
            cursor = page.cursor;
            for event in &page.events {
                if let Err(error) = self.on_event(event) {
                    tracing::warn!(seq = event.seq.get(), r#type = event.r#type.as_str(), %error, "incident detector failed");
                }
            }
        }
    }
}
