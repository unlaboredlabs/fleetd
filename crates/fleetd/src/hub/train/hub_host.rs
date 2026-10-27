//! The hub's `TrainHost`: the train and reviews reach other areas only through here, forwarding to their services on
//! the `Hub`. Built before the `Hub` exists (the train goes into the `Hub`), so it is bound right after; until then
//! the cross-area calls answer as if there were nothing.
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::tasks::Task;
use serde_json::{Value, json};

use super::contract::{ProjectRef, TaskId, WorkstreamId};
use super::host::{BoxFut, EventView, ReviewSpawn, TaskView, TrainHost, WorkstreamView};
use crate::clock::Clock;
use crate::hub::api::Hub;
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
        pr_url: result.and_then(|r| r.pr_url.as_ref()).map(wire_str),
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

    fn train_settings(
        &self,
        project_ref: &ProjectRef,
    ) -> Option<fleetd_contracts::project_settings::TrainSettings> {
        match self.hub()?.db.project_settings().train(project_ref) {
            Ok(train) => Some(train),
            Err(error) => {
                tracing::warn!(%error, "train: its settings not read");
                None
            }
        }
    }

    fn open_order<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
        text: String,
        request_id: String,
    ) -> BoxFut<'a, Result<WorkstreamId, String>> {
        Box::pin(async move {
            let hub = self.hub().ok_or("the hub is stopping")?;
            hub.leads
                .workstreams
                .intake(crate::hub::leads::workstreams::IntakeInput {
                    project_ref: project_ref.clone(),
                    text,
                    client_request_id: request_id,
                    channel: fleetd_contracts::ledger::IntakeChannel::Train,
                    by: super::service::TRAIN_BY.to_string(),
                })
                .map(|o| o.workstream_id)
                .map_err(|e| e.message)
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

    fn writers(&self, project_ref: &ProjectRef) -> Vec<(TaskId, String)> {
        use fleetd_contracts::tasks::{TaskKind, TaskState};
        let Some(hub) = self.hub() else {
            return Vec::new();
        };
        let filter = crate::hub::tasks::TaskFilter {
            project_ref: Some(project_ref.clone()),
            state: None,
            workstream_id: None,
            limit: 100,
        };
        match hub.tasks.list(&filter) {
            Ok(tasks) => tasks
                .into_iter()
                .filter(|t| t.kind == TaskKind::Write)
                .filter(|t| {
                    matches!(
                        t.state,
                        TaskState::Running | TaskState::Idle | TaskState::Done
                    )
                })
                .filter_map(|t| Some((t.task_id, t.branch?.to_string())))
                .collect(),
            Err(error) => {
                tracing::warn!(%error, "train: writers not read");
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

    fn cancel_task<'a>(
        &'a self,
        project_ref: &'a ProjectRef,
        by: &'static str,
        task_id: &'a TaskId,
        reason: String,
    ) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            let hub = self.hub().ok_or_else(not_bound)?;
            let caller = TaskCaller {
                project_ref: project_ref.clone(),
                by: by.to_string(),
            };
            hub.tasks
                .cancel(&caller, task_id, Some(&reason))
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
                "profile": if spawn.medium { "medium" } else { "high" },
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
            has_brief: w.brief.is_some(),
            open: !crate::hub::leads::records::is_closed(w.state),
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

    fn github_repos(&self, project_ref: &ProjectRef) -> Vec<(String, ProjectRef)> {
        let Some(hub) = self.hub() else {
            return Vec::new();
        };
        match hub.repos.repos_of(project_ref) {
            Ok(repos) => repos
                .into_iter()
                .filter_map(|r| {
                    let name = r.repo_key?.as_str().strip_prefix("github.com/")?.to_owned();
                    Some((name, r.checkout))
                })
                .collect(),
            Err(error) => {
                tracing::warn!(%error, "train: the project's repos not read");
                Vec::new()
            }
        }
    }

    fn landings_watched(&self, repo: &str, base: &str) -> bool {
        let Some(hub) = self.hub() else { return false };
        let scope = fleetd_contracts::work::RepoKey::of(&format!("github.com/{repo}"))
            .zip(fleetd_contracts::prim::Line::new(base).ok())
            .map(|(repo_key, base)| fleetd_contracts::work::WorkScope { repo_key, base });
        scope.is_some_and(|s| hub.work.watches(&s).unwrap_or(false))
    }

    fn wake_lead<'a>(&'a self, project_ref: &'a ProjectRef, line: String) -> BoxFut<'a, ()> {
        if let Some(hub) = self.hub() {
            hub.leads
                .wakes
                .trigger(project_ref, crate::hub::leads::wakes::Trigger::train(&line));
        }
        Box::pin(async {})
    }
}
