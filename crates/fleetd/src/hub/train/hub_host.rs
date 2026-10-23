//! The hub's `TrainHost`: the train and reviews reach other areas only through here, forwarding to their services on
//! the `Hub`. Built before the `Hub` exists (the train goes into the `Hub`), so it is bound right after; until then
//! the cross-area calls answer as if there were nothing.
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::tasks::Task;
use serde_json::{Value, json};

use super::contract::{MachineId, ProjectRef, TaskId, WorkstreamId};
use super::host::{
    BoxFut, BriefView, CmdOut, EventView, PlaybookView, ProviderView, ReviewSpawn, TaskView,
    TrainHost, WorkstreamView,
};
use crate::clock::Clock;
use crate::hub::api::Hub;
use crate::hub::link::commands::CommandInput;
use crate::hub::store::{EventLog, HubStore, NewEvent, WaitInput, iso_ms, now_ms};
use crate::hub::tasks::TaskCaller;

pub struct HubHost {
    pub clock: Arc<dyn Clock>,
    pub events: Arc<EventLog>,
    pub store: Arc<HubStore>,
    pub hub: OnceLock<Weak<Hub>>,
}

impl HubHost {
    pub fn new(clock: Arc<dyn Clock>, events: Arc<EventLog>, store: Arc<HubStore>) -> Arc<Self> {
        Arc::new(Self {
            clock,
            events,
            store,
            hub: OnceLock::new(),
        })
    }

    /// Called once by `hub::serve::build_on`, after the `Hub` is built.
    pub fn bind(&self, hub: &Arc<Hub>) {
        let _ = self.hub.set(Arc::downgrade(hub));
    }

    fn hub(&self) -> Option<Arc<Hub>> {
        self.hub.get()?.upgrade()
    }
}

fn not_bound() -> String {
    "the hub is shutting down".to_string()
}

fn event_type(name: &str) -> Option<HubEventType> {
    serde_json::from_value(Value::String(name.into())).ok()
}

/// A wire string as its contract type (a brand or enum), checked as the contracts decode it.
fn parse<T: serde::de::DeserializeOwned>(s: &str) -> Option<T> {
    serde_json::from_value(Value::String(s.into())).ok()
}

fn wire_str(value: impl serde::Serialize) -> String {
    match serde_json::to_value(value) {
        Ok(Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}

fn task_view(task: Task) -> TaskView {
    let result = task.result.as_ref();
    TaskView {
        task_id: task.task_id.clone(),
        project_ref: task.project_ref.clone(),
        workstream_id: task.workstream_id.clone(),
        kind: wire_str(task.kind),
        state: wire_str(task.state),
        tier: task.tier,
        pr_url: result.and_then(|r| r.pr_url.as_ref()).map(wire_str),
        receipt_commands: result
            .and_then(|r| r.receipts.as_ref())
            .map_or(0, |r| r.commands.get()),
        claims_unverified: result.and_then(|r| r.claims_unverified) == Some(true),
        result_tail: result.map(|r| r.tail.to_string()),
    }
}

impl TrainHost for HubHost {
    fn time(&self) -> Option<crate::hub::time::TimeSink> {
        self.hub().map(|h| h.time.sink())
    }

    fn branch_prefix<'a>(&'a self, project_ref: &'a ProjectRef) -> BoxFut<'a, Option<String>> {
        Box::pin(async move {
            let policy = self.hub()?.policies.get(project_ref).await;
            match policy {
                Ok(policy) => Some(policy.branch_prefix.map_or_else(
                    || fleetd_contracts::tasks::DEFAULT_BRANCH_PREFIX.to_string(),
                    |p| p.as_str().to_string(),
                )),
                Err(error) => {
                    tracing::warn!(?error, "train: policy not read for the branch prefix");
                    None
                }
            }
        })
    }

    fn task(&self, task_id: &TaskId) -> Option<TaskView> {
        match self.hub()?.tasks.get(task_id) {
            Ok(task) => task.map(task_view),
            Err(error) => {
                tracing::warn!(%error, %task_id, "train: task not read");
                None
            }
        }
    }

    fn running_writers(&self, project_ref: &ProjectRef) -> Vec<(TaskId, String)> {
        let Some(hub) = self.hub() else {
            return Vec::new();
        };
        let filter = crate::hub::tasks::TaskFilter {
            project_ref: Some(project_ref.clone()),
            state: Some(fleetd_contracts::tasks::TaskState::Running),
            workstream_id: None,
            limit: 100,
        };
        match hub.tasks.list(&filter) {
            Ok(tasks) => tasks
                .into_iter()
                .filter(|t| t.kind == fleetd_contracts::tasks::TaskKind::Write)
                .filter_map(|t| Some((t.task_id, t.branch?.to_string())))
                .collect(),
            Err(error) => {
                tracing::warn!(%error, "train: running writers not read");
                Vec::new()
            }
        }
    }

    fn message_task<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
        by: &'static str,
        task_id: &'a TaskId,
        text: String,
    ) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            let hub = self.hub().ok_or_else(not_bound)?;
            let caller = TaskCaller {
                project_ref: project_ref.clone(),
                by: by.to_string(),
            };
            hub.tasks
                .message(&caller, task_id, &text)
                .await
                .map(|_| ())
                .map_err(|e| e.message.to_string())
        })
    }

    fn spawn_review(&self, spawn: ReviewSpawn) -> BoxFut<'_, Result<TaskView, String>> {
        Box::pin(async move {
            let hub = self.hub().ok_or_else(not_bound)?;
            let call = json!({
                "workstreamId": spawn.workstream_id,
                "title": spawn.title,
                "kind": "review",
                "prompt": spawn.prompt,
                "pr": spawn.pr,
                "tier": spawn.tier,
            });
            let input = serde_json::from_value(call).map_err(|e| e.to_string())?;
            let caller = TaskCaller {
                project_ref: spawn.project_ref,
                by: spawn.by.to_string(),
            };
            hub.tasks
                .spawn(&caller, input)
                .await
                .map(task_view)
                .map_err(|e| e.message.to_string())
        })
    }

    fn workstream(&self, workstream_id: &WorkstreamId) -> Option<WorkstreamView> {
        let stored = match self.hub()?.leads.records.workstream_get(workstream_id) {
            Ok(stored) => stored?,
            Err(error) => {
                tracing::warn!(%error, %workstream_id, "train: workstream not read");
                return None;
            }
        };
        let w = stored;
        Some(WorkstreamView {
            workstream_id: w.workstream_id.clone(),
            project_ref: w.project_ref.clone(),
            brief: w.brief.as_ref().map(|b| BriefView { tier: b.tier }),
            playbook: w.playbook.as_ref().map(wire_str),
        })
    }

    fn playbook(&self, pin: &str) -> Option<PlaybookView> {
        let pin = parse(pin)?;
        let loaded = match self.hub()?.leads.playbooks.by_ref(&pin) {
            Ok(loaded) => loaded?,
            Err(error) => {
                tracing::warn!(%error, "train: playbook not read");
                return None;
            }
        };
        let p = loaded.playbook;
        let rules = &p.review_rules;
        Some(PlaybookView {
            review_rules: [rules.s.clone(), rules.m.clone(), rules.l.clone()],
        })
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

    fn wake_lead<'a>(&'a self, project_ref: &'a ProjectRef, line: String) -> BoxFut<'a, ()> {
        if let Some(hub) = self.hub() {
            hub.leads
                .wakes
                .trigger(project_ref, crate::hub::leads::wakes::Trigger::train(&line));
        }
        Box::pin(async {})
    }

    fn run_command<'a>(
        &'a self,
        machine_id: &'a MachineId,
        cwd: &'a str,
        argv: Vec<String>,
        timeout_sec: u64,
    ) -> BoxFut<'a, Result<CmdOut, String>> {
        Box::pin(async move {
            let hub = self.hub().ok_or_else(not_bound)?;
            let input = CommandInput {
                cwd: cwd.to_string(),
                argv,
                timeout_sec: Some(u32::try_from(timeout_sec).unwrap_or(u32::MAX)),
            };
            let result = hub
                .node_commands
                .run(machine_id, input)
                .await
                .map_err(|e| e.message)?;
            Ok(CmdOut {
                exit_code: result
                    .exit_code
                    .and_then(|c| serde_json::to_value(c).ok())
                    .and_then(|v| v.as_i64())
                    .and_then(|c| i32::try_from(c).ok()),
                output_tail: result.output_tail.to_string(),
                timed_out: result.timed_out,
            })
        })
    }

    fn provider_instances<'a>(
        &'a self,
        machine_id: &'a MachineId,
    ) -> BoxFut<'a, Result<Vec<ProviderView>, String>> {
        Box::pin(async move {
            let hub = self.hub().ok_or_else(not_bound)?;
            hub.executors
                .provider_instances(machine_id)
                .await
                .map_err(|e| e.to_string())
        })
    }
}
