//! The keyed decision log, scoped workstream → project → global.
use std::sync::{Arc, RwLock};

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::{Decision, DecisionRetired, DecisionScope, DecisionState};
use serde_json::json;

use super::repo::{self, DecisionFilter, RecordInput};
use super::tools::WorkstreamLookup;
use super::{Actor, Chain, Ctx, LedgerError, project_fields};
use crate::clock::Clock;
use crate::hub::store::{EventLog, HubDb, NewEvent, iso_ms};

pub struct Decisions {
    ctx: Ctx,
    workstreams: RwLock<Option<Arc<dyn WorkstreamLookup>>>,
}

/// The `decision.recorded` event; `project` names the project of a workstream-scoped decision.
pub fn recorded_event(decision: &Decision, project: Option<&ProjectRef>) -> NewEvent {
    let project_ref = match &decision.scope {
        DecisionScope::Project { project_ref } => Some(project_ref),
        _ => project,
    };
    let (machine_id, project_id) = project_fields(project_ref);
    let mut data = json!({
        "decisionId": decision.decision_id,
        "key": decision.key,
        "scope": decision.scope,
        "source": decision.source,
    });
    if let Some(supersedes) = &decision.supersedes {
        data["supersedes"] = json!(supersedes);
    }
    NewEvent {
        at: decision.at.clone(),
        r#type: HubEventType::DecisionRecorded,
        machine_id,
        project_id,
        thread_id: None,
        summary: format!(
            "{} {} = {}",
            decision.decision_id, decision.key, &*decision.value
        ),
        data: Some(data),
        attention: None,
    }
}

/// The `decision.retired` event: a person revoked the decision, and its key goes unanswered again.
pub fn retired_event(decision: &Decision, project: Option<&ProjectRef>) -> NewEvent {
    let (machine_id, project_id) = project_fields(project);
    NewEvent {
        at: decision
            .retired
            .as_ref()
            .map_or_else(|| decision.at.clone(), |r| r.at.clone()),
        r#type: HubEventType::DecisionRetired,
        machine_id,
        project_id,
        thread_id: None,
        summary: format!("{} {} revoked", decision.decision_id, decision.key),
        data: Some(json!({
            "decisionId": decision.decision_id,
            "key": decision.key,
            "scope": decision.scope,
        })),
        attention: None,
    }
}

/// What `overturn` did: the decision taken back, and the one that replaced it, if any.
#[derive(Clone, Debug)]
pub struct Overturned {
    pub overturned: Decision,
    pub replacement: Option<Decision>,
}

impl Decisions {
    pub fn new(db: Arc<HubDb>, events: Arc<EventLog>, clock: Arc<dyn Clock>) -> Self {
        Self {
            ctx: Ctx { db, events, clock },
            workstreams: RwLock::new(None),
        }
    }

    /// Writes an active decision; an active one on the same key and scope becomes superseded.
    pub fn record(&self, input: RecordInput, actor: &Actor) -> Result<Decision, LedgerError> {
        let now = self.ctx.now_ms();
        let decision = self
            .ctx
            .write(|db| repo::record_decision(db, &input, actor, now))?;
        self.ctx
            .emit(recorded_event(&decision, input.project_ref.as_ref()));
        Ok(decision)
    }

    /// `forget Dn`: an active decision stops answering its key.
    pub fn retire(&self, decision_id: &str) -> Result<Decision, LedgerError> {
        self.ctx
            .write(|db| repo::retire_decision(db, decision_id, None))
    }

    /// A person overturns an active decision in one write: with `value`, a new decision on its key and scope
    /// supersedes it; without, it is retired with who and why. `project` is the decision's project.
    pub fn overturn(
        &self,
        decision_id: &str,
        value: Option<&str>,
        why: &str,
        project: Option<&ProjectRef>,
        actor: &Actor,
    ) -> Result<Overturned, LedgerError> {
        let now = self.ctx.now_ms();
        let done = self.ctx.write(|db| {
            let Some(old) = repo::get_decision(db, decision_id)? else {
                return Err(LedgerError::not_found(format!("No decision {decision_id}.")).into());
            };
            if old.state != DecisionState::Active {
                return Err(LedgerError::invalid_fix(
                    format!(
                        "{decision_id} is already {}.",
                        repo::decision_state_text(&old.state)
                    ),
                    "Overturn the decision that answers its key now.",
                )
                .into());
            }
            let Some(value) = value else {
                let retired = DecisionRetired {
                    by: actor.by.clone(),
                    person: actor.person.clone(),
                    at: Timestamp(iso_ms(now)),
                    why: Some(super::text(why)),
                };
                return Ok(Overturned {
                    overturned: repo::retire_decision(db, decision_id, Some(retired))?,
                    replacement: None,
                });
            };
            let input = RecordInput {
                key: old.key.clone(),
                scope: old.scope.clone(),
                value: value.to_string(),
                why: Some(why.to_string()),
                project_ref: project.cloned(),
            };
            let replacement = repo::record_decision(db, &input, actor, now)?;
            let overturned =
                repo::get_decision(db, decision_id)?.expect("superseded in this write");
            Ok(Overturned {
                overturned,
                replacement: Some(replacement),
            })
        })?;
        self.ctx.emit(match &done.replacement {
            Some(new) => recorded_event(new, project),
            None => retired_event(&done.overturned, project),
        });
        Ok(done)
    }

    /// The project's project- and workstream-scoped decisions in every state, newest first.
    pub fn history(
        &self,
        project_ref: &ProjectRef,
        limit: i64,
    ) -> Result<Vec<Decision>, LedgerError> {
        self.ctx
            .read(|db| repo::history_in_project(db, project_ref, limit))
    }

    pub fn get(&self, decision_id: &str) -> Result<Option<Decision>, LedgerError> {
        self.ctx.read(|db| repo::get_decision(db, decision_id))
    }

    /// The decision `decision_id` when it is global or `project_ref`'s; another project's reads as `None`.
    pub fn get_in(
        &self,
        decision_id: &str,
        project_ref: &ProjectRef,
    ) -> Result<Option<Decision>, LedgerError> {
        self.ctx
            .read(|db| repo::get_decision_in(db, decision_id, project_ref))
    }

    /// The decisions `text` cites, oldest first: by id (`D12`), when global or the project's, and the active ones in
    /// the project's chain by dotted key (`api.health.path`).
    pub fn cited(
        &self,
        project_ref: &ProjectRef,
        text: &str,
    ) -> Result<Vec<Decision>, LedgerError> {
        let words: Vec<&str> = text
            .split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')))
            .map(|w| w.trim_end_matches('.'))
            .filter(|w| !w.is_empty())
            .collect();
        let mut cited = Vec::new();
        for id in words.iter().filter(|w| repo::decision_n(w).is_some()) {
            if let Some(decision) = self.get_in(id, project_ref)? {
                cited.push(decision);
            }
        }
        let active = self.list(&DecisionFilter {
            chain: Some(Chain {
                project_ref: project_ref.clone(),
                workstream_id: None,
            }),
            limit: Some(500),
            ..Default::default()
        })?;
        cited.extend(active.into_iter().filter(|d| {
            let key = d.key.as_str();
            key.contains('.') && words.contains(&key)
        }));
        cited.sort_by_key(|d| repo::decision_n(d.decision_id.as_str()));
        cited.dedup_by(|a, b| a.decision_id == b.decision_id);
        Ok(cited)
    }

    /// The active decision for `key`, looked up in the workstream, then the project, then globally.
    pub fn resolve(&self, key: &str, chain: &Chain) -> Result<Option<Decision>, LedgerError> {
        self.ctx.read(|db| repo::resolve(db, key, chain))
    }

    /// Active decisions on `key` at project or workstream scope in the project, oldest first.
    pub fn active_on_key(
        &self,
        key: &str,
        project_ref: &ProjectRef,
    ) -> Result<Vec<Decision>, LedgerError> {
        self.ctx
            .read(|db| repo::active_on_key(db, key, project_ref))
    }

    /// FTS5 over key, value and why; best match first, active only.
    pub fn search(
        &self,
        query: &str,
        filter: &DecisionFilter,
    ) -> Result<Vec<Decision>, LedgerError> {
        self.ctx
            .read(|db| repo::search_decisions(db, query, filter))
    }

    /// Active decisions, newest first.
    pub fn list(&self, filter: &DecisionFilter) -> Result<Vec<Decision>, LedgerError> {
        self.ctx.read(|db| repo::list_decisions(db, filter))
    }

    /// The trimmed value of the active global decision on `key` (`policy.tz`, `policy.quiet_hours`, ...).
    pub fn global_value(&self, key: &str) -> Result<Option<String>, LedgerError> {
        let global = self.list(&DecisionFilter {
            scope: Some(DecisionScope::Global),
            limit: Some(500),
            ..Default::default()
        })?;
        Ok(global
            .into_iter()
            .find(|d| d.key.as_str() == key)
            .map(|d| d.value.trim().to_string()))
    }

    /// The leads area's workstream lookup, for workstream-scoped decisions in tools and lead calls.
    pub fn set_workstreams(&self, lookup: Arc<dyn WorkstreamLookup>) {
        *self.workstreams.write().unwrap_or_else(|p| p.into_inner()) = Some(lookup);
    }

    pub fn workstreams(&self) -> Option<Arc<dyn WorkstreamLookup>> {
        self.workstreams
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}
