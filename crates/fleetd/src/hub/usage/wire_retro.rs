//! Usage's owners and the retro's runner, playbooks, ledger and work over the real hub.
use super::ports::{BoxFut, ThreadRef};
use super::service::UsageOwners;
use super::state::{Owner, ParkedKind, ParkedThread};
use super::wire::{OpsPorts, convert};
use crate::hub::incidents::{IncidentFilter, IncidentInput};
use crate::hub::intake::router::OneShot;
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::ledger::{AskInput, DecisionFilter};
use crate::hub::retro::metrics::RetroWork;
use crate::hub::retro::service::{RUN_TIMEOUT_MS, RetroLedger, RetroPlaybooks, RetroRunner};
use crate::hub::retro::types::OrchestratorRun;
use crate::hub::retro::validate::PlaybookParser;
use crate::hub::tasks::TaskFilter;
use crate::hub::tasks::records::{ENDED_STATES, TaskRecords};
use fleetd_contracts::ledger::{DecisionScope, PlaybookName, WorkstreamState};
use serde_json::{Map, Value};
use std::time::Duration;

fn logged<T, E: std::fmt::Display>(result: Result<T, E>, what: &str) -> Option<T> {
    result
        .map_err(|error| tracing::warn!(%error, "ops: {what} failed"))
        .ok()
}

impl OpsPorts {
    /// The thread is a lead's current one.
    fn is_lead_thread(&self, machine_id: &str, thread_id: &str) -> bool {
        logged(self.hub().leads.records.leads_list(), "listing leads")
            .unwrap_or_default()
            .iter()
            .any(|l| {
                l.project_ref.machine_id.as_str() == machine_id && l.thread_id.as_str() == thread_id
            })
    }
}

impl UsageOwners for OpsPorts {
    fn owner_of(&self, thread: &ThreadRef) -> BoxFut<'_, Option<Owner>> {
        let target: Option<fleetd_contracts::ids::ThreadRef> = convert(thread);
        let (machine_id, thread_id) = (thread.machine_id.clone(), thread.thread_id.clone());
        Box::pin(async move {
            let hub = self.hub();
            if let Some(target) = target {
                let task = hub.db.with(|c| Ok(TaskRecords::by_thread(c, &target)?));
                if let Some(stored) = logged(task, "reading a thread's task").flatten() {
                    return Some(Owner {
                        kind: convert(&stored.task.kind)?,
                        task_id: Some(stored.task.task_id.to_string()),
                    });
                }
            }
            self.is_lead_thread(&machine_id, &thread_id)
                .then_some(Owner {
                    kind: ParkedKind::Lead,
                    task_id: None,
                })
        })
    }

    fn still_parked(&self, parked: &ParkedThread) -> BoxFut<'_, bool> {
        let parked = parked.clone();
        Box::pin(async move {
            if parked.kind == ParkedKind::Lead {
                return self.is_lead_thread(&parked.thread.machine_id, &parked.thread.thread_id);
            }
            let Some(task_id) = parked.task_id.as_ref().and_then(convert) else {
                return false;
            };
            let stored = self.hub().db.with(|c| Ok(TaskRecords::get(c, &task_id)?));
            logged(stored, "reading a task")
                .flatten()
                .is_some_and(|s| !ENDED_STATES.contains(&s.task.state))
        })
    }
}

impl OpsPorts {
    /// The router's runner (login, environment allowlist, model) with RUN_TIMEOUT_MS.
    fn retro_runner(&self) -> Result<&OneShot, String> {
        if let Some(runner) = self.retro_runner.get() {
            return Ok(runner);
        }
        let hub = self.hub();
        let env = std::env::vars().collect();
        let runner = OneShot::new(
            &hub.config.home,
            hub.config.router_model.clone(),
            &env,
            Some(Duration::from_millis(RUN_TIMEOUT_MS)),
        )
        .map_err(|e| format!("cannot create the router's directory: {e}"))?;
        Ok(self.retro_runner.get_or_init(|| runner))
    }
}

impl RetroRunner for OpsPorts {
    fn ask(&self, prompt: String) -> BoxFut<'_, (Option<String>, OrchestratorRun)> {
        Box::pin(async move {
            let runner = match self.retro_runner() {
                Ok(runner) => runner,
                Err(error) => {
                    let model = self
                        .hub()
                        .config
                        .router_model
                        .clone()
                        .unwrap_or_else(|| "claude-haiku-5-5".into());
                    let run = OrchestratorRun {
                        kind: "orchestrator".into(),
                        model,
                        duration_ms: 0,
                        ok: false,
                        input_tokens: None,
                        output_tokens: None,
                        error: Some(error),
                    };
                    return (None, run);
                }
            };
            let result = runner.run(&prompt).await;
            let run = OrchestratorRun {
                kind: result.run.kind.into(),
                model: result.run.model,
                duration_ms: result.run.duration_ms,
                ok: result.run.ok,
                input_tokens: result.run.input_tokens,
                output_tokens: result.run.output_tokens,
                error: result.run.error,
            };
            (result.text, run)
        })
    }
}

/// The playbooks area's parser: the decoded playbook as plain JSON.
struct AreaParser;

impl PlaybookParser for AreaParser {
    fn parse(
        &self,
        text: &str,
        place: &str,
        expected: Option<&str>,
    ) -> Result<Map<String, Value>, String> {
        let expected: Option<PlaybookName> = match expected {
            None => None,
            Some(name) => Some(convert(&name).ok_or_else(|| format!("{name} is not a playbook"))?),
        };
        let loaded = crate::hub::playbooks::load::parse_playbook(text, place, expected)
            .map_err(|e| e.message)?;
        match serde_json::to_value(&loaded.playbook) {
            Ok(Value::Object(map)) => Ok(map),
            _ => Err(format!("playbook {place} did not read back as an object")),
        }
    }
}

fn playbook_name(name: &str) -> Option<PlaybookName> {
    convert(&name)
}

impl RetroPlaybooks for OpsPorts {
    fn prompts(&self) -> crate::hub::prompts::PromptSet {
        self.hub().db.prompts().current(None)
    }
    fn current(&self, name: &str) -> (String, String) {
        match playbook_name(name) {
            Some(n) => {
                let loaded = self.hub().leads.playbooks.current(n);
                (loaded.text, loaded.r#ref.to_string())
            }
            None => (String::new(), format!("{name}@unknown")),
        }
    }
    fn override_text(&self, name: &str) -> Option<String> {
        let n = playbook_name(name)?;
        logged(
            self.hub().leads.playbooks.override_text(n),
            "reading a playbook override",
        )
        .flatten()
    }
    fn set_override(&self, name: &str, text: Option<&str>) -> Result<String, String> {
        let n = playbook_name(name).ok_or_else(|| format!("{name} is not a playbook"))?;
        self.hub()
            .leads
            .playbooks
            .set_override(n, text)
            .map(|loaded| loaded.r#ref.to_string())
            .map_err(|e| e.message)
    }
    fn parser(&self) -> &dyn PlaybookParser {
        &AreaParser
    }
}

fn field<T: serde::de::DeserializeOwned>(input: &Value, key: &str) -> Result<Option<T>, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("{key}: {e}")),
    }
}

fn required<T: serde::de::DeserializeOwned>(input: &Value, key: &str) -> Result<T, String> {
    field(input, key)?.ok_or_else(|| format!("{key} is required"))
}

/// An `Asks.create` input from its wire JSON.
pub(crate) fn ask_input_of(input: &Value) -> Result<AskInput, String> {
    Ok(AskInput {
        project_ref: field(input, "projectRef")?,
        workstream_id: field(input, "workstreamId")?,
        kind: required(input, "kind")?,
        key: required(input, "key")?,
        class: required(input, "class")?,
        text: required(input, "text")?,
        recommendation: field(input, "recommendation")?,
        options: field(input, "options")?,
        steps: field(input, "steps")?,
        verify: field(input, "verify")?,
        sink: field(input, "sink")?,
        env_name: field(input, "envName")?,
        gated: field(input, "gated")?,
        permission: field(input, "permission")?,
        blocks: required(input, "blocks")?,
        proceeded_on_rec: field(input, "proceededOnRec")?.unwrap_or(false),
    })
}

impl RetroLedger for OpsPorts {
    fn global_value(&self, key: &str) -> BoxFut<'_, Option<String>> {
        let key = key.to_owned();
        Box::pin(async move {
            let all = logged(
                self.hub().decisions.list(&DecisionFilter {
                    scope: Some(DecisionScope::Global),
                    limit: Some(500),
                    ..Default::default()
                }),
                "listing global decisions",
            )?;
            all.into_iter()
                .find(|d| d.key.as_str() == key)
                .map(|d| d.value.as_str().trim().to_string())
        })
    }
    fn decision_value(&self, decision_id: &str) -> BoxFut<'_, Option<String>> {
        let id = decision_id.to_owned();
        Box::pin(async move {
            logged(self.hub().decisions.get(&id), "reading a decision")
                .flatten()
                .map(|d| d.value.as_str().to_string())
        })
    }
    fn ask_state(&self, ask_id: &str) -> BoxFut<'_, Option<(String, Option<String>)>> {
        let id = ask_id.to_owned();
        Box::pin(async move {
            let ask = logged(self.hub().asks.get(&id), "reading an ask").flatten()?;
            let state = serde_json::to_value(ask.state).ok()?.as_str()?.to_string();
            Some((state, ask.decision_id.map(|d| d.to_string())))
        })
    }
    fn create_ask(&self, input: Value, by: &str) -> BoxFut<'_, Result<String, String>> {
        let by = by.to_owned();
        Box::pin(async move {
            let input = ask_input_of(&input)?;
            self.hub()
                .asks
                .create(&input, &by)
                .map(|outcome| outcome.ask.ask_id.to_string())
                .map_err(|e| e.message)
        })
    }
    fn incident(&self, incident_id: &str) -> BoxFut<'_, Option<Value>> {
        let id = convert(&incident_id);
        Box::pin(async move {
            let incident =
                logged(self.hub().incidents.get(&id?), "reading an incident").flatten()?;
            serde_json::to_value(incident).ok()
        })
    }
    fn incident_count(&self, class: &str, since_ms: i64) -> BoxFut<'_, u64> {
        let class = convert(&class);
        Box::pin(async move {
            let Some(class) = class else { return 0 };
            let filter = IncidentFilter {
                class: Some(class),
                since_ms: Some(since_ms),
                ..Default::default()
            };
            logged(self.hub().incidents.counts(&filter), "counting incidents")
                .and_then(|counts| counts.into_iter().next())
                .map_or(0, |(_, n)| n)
        })
    }
    fn record_incident(&self, input: Value) -> BoxFut<'_, ()> {
        Box::pin(async move {
            let parsed = (|| -> Result<IncidentInput, String> {
                Ok(IncidentInput {
                    class: required(&input, "class")?,
                    project_ref: required(&input, "projectRef")?,
                    workstream_id: field(&input, "workstreamId")?,
                    task_id: field(&input, "taskId")?,
                    evidence: field(&input, "evidence")?.unwrap_or_default(),
                })
            })();
            match parsed {
                Ok(input) => {
                    logged(self.hub().incidents.record(input), "recording an incident");
                }
                Err(error) => tracing::warn!(%error, "retro: incident not recorded"),
            }
        })
    }
}

impl RetroWork for OpsPorts {
    fn incidents(&self, from_ms: i64, to_ms: Option<i64>, limit: usize) -> BoxFut<'_, Vec<Value>> {
        Box::pin(async move {
            let filter = IncidentFilter {
                since_ms: Some(from_ms),
                until_ms: to_ms,
                ..Default::default()
            };
            logged(
                self.hub().incidents.list(&filter, limit),
                "listing incidents",
            )
            .unwrap_or_default()
            .iter()
            .filter_map(|i| serde_json::to_value(i).ok())
            .collect()
        })
    }
    fn workstream_playbook(&self, workstream_id: &str) -> BoxFut<'_, Option<String>> {
        let id = convert(&workstream_id);
        Box::pin(async move {
            let stored = logged(
                self.hub().leads.records.workstream_get(&id?),
                "reading a workstream",
            )
            .flatten()?;
            stored.workstream.playbook.map(|p| p.to_string())
        })
    }
    fn done_workstreams(&self, limit: usize) -> BoxFut<'_, Vec<(String, Option<String>, String)>> {
        Box::pin(async move {
            let filter = WorkstreamFilter {
                state: Some(WorkstreamState::Done),
                limit,
                ..Default::default()
            };
            logged(
                self.hub().leads.records.workstreams_list(&filter),
                "listing done workstreams",
            )
            .unwrap_or_default()
            .into_iter()
            .map(|w| {
                (
                    w.workstream_id.to_string(),
                    w.playbook.map(|p| p.to_string()),
                    w.updated_at.to_string(),
                )
            })
            .collect()
        })
    }
    fn task_spans(&self, workstream_id: &str) -> BoxFut<'_, Vec<(Option<String>, Option<String>)>> {
        let id = convert(&workstream_id);
        Box::pin(async move {
            let Some(id) = id else { return Vec::new() };
            let filter = TaskFilter {
                workstream_id: Some(id),
                limit: 500,
                ..Default::default()
            };
            logged(
                self.hub().tasks.list(&filter),
                "listing a workstream's tasks",
            )
            .unwrap_or_default()
            .into_iter()
            .map(|t| {
                (
                    t.started_at.map(|s| s.to_string()),
                    t.ended_at.map(|s| s.to_string()),
                )
            })
            .collect()
        })
    }
}
