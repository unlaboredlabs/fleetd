//! The keyed decision log, scoped workstream → project → global (TS `Decisions.ts`).
use std::sync::{Arc, RwLock};

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{Decision, DecisionScope};
use serde_json::json;

use super::repo::{self, DecisionFilter, RecordInput};
use super::tools::WorkstreamLookup;
use super::{Actor, Chain, Ctx, LedgerError, project_fields};
use crate::clock::Clock;
use crate::hub::store::{EventLog, HubDb, NewEvent};

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
    if let Some(ask_id) = &decision.ask_id {
        data["askId"] = json!(ask_id);
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
        self.ctx.write(|db| repo::retire_decision(db, decision_id))
    }

    pub fn get(&self, decision_id: &str) -> Result<Option<Decision>, LedgerError> {
        self.ctx.read(|db| repo::get_decision(db, decision_id))
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

    // PORT: leads (Workstreams) calls this; until then workstream scopes and --workstream are refused as unknown.
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
