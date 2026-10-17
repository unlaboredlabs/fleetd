//! MCP tools this area serves: lead_start, lead_restart, intake_submit, workstream_list, workstream_get,
//! workstream_spawn, inventory. Same grant checks, limits and `next` texts as TS FleetApi.
use std::sync::Arc;

use fleetd_contracts::auth::{AgentKeyInfo, Role};
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::ledger::{AskState, DecisionScope, WorkstreamState};
use fleetd_contracts::mcp::*;
use fleetd_contracts::prim::{Count, List};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::Area;
use super::error::LeadError;
use super::records::{LeadSettings, WorkstreamFilter};
use crate::hub::auth::allows;
use crate::hub::intake::{SubmitInput, SubmitResult};
use crate::hub::ledger::{AskFilter, DecisionFilter};
use crate::hub::playbooks::finish_all::Caller;

pub const TOOLS: [&str; 7] = ["lead_start", "lead_restart", "intake_submit", "workstream_list", "workstream_get", "workstream_spawn", "inventory"];

const WORKSTREAM_ASKS: usize = 50;
const WORKSTREAM_CLAIMS: usize = 20;

fn err(code: ErrorCode, message: String, fix: &str) -> McpToolError {
    McpToolError { code, message, fix: Some(fix.into()) }
}

fn forbidden(role: Role, machine_id: Option<&MachineId>) -> McpToolError {
    let role = super::digest::serde_plain(&role);
    let message = match machine_id {
        None => format!("This key lacks the {role} role."),
        Some(m) => format!("This key has no {role} grant on machine {m}."),
    };
    err(ErrorCode::Forbidden, message, "Ask the hub admin for a key with that grant (fleetd hub key create --role … --machines …).")
}

fn require(caller: &AgentKeyInfo, role: Role, machine_id: Option<&MachineId>) -> Result<(), McpToolError> {
    if allows(caller, role, machine_id) { Ok(()) } else { Err(forbidden(role, machine_id)) }
}

fn unknown_project(r: &ProjectRef) -> McpToolError {
    err(ErrorCode::NotFound, format!("No project {} on {}.", r.project_id, r.machine_id), &format!("Call projects_list with machineId {}.", r.machine_id))
}

fn unknown_workstream(id: &str) -> McpToolError {
    err(ErrorCode::NotFound, format!("No workstream {id}."), "Call workstream_list to see workstreams.")
}

fn decode<T: DeserializeOwned>(input: Value) -> Result<T, McpToolError> {
    serde_json::from_value(input).map_err(|e| McpToolError { code: ErrorCode::Invalid, message: format!("Invalid input: {e}"), fix: None })
}

fn encode<T: Serialize>(output: T) -> Result<Value, McpToolError> {
    serde_json::to_value(output).map_err(|e| McpToolError { code: ErrorCode::Invalid, message: format!("Invalid output: {e}"), fix: None })
}

fn refusal(e: LeadError) -> McpToolError {
    e.into()
}

impl Area {
    /// The framework's Registry calls this for each name in TOOLS, with the caller's verified key.
    pub async fn call_tool(self: &Arc<Self>, name: &str, caller: &AgentKeyInfo, input: Value) -> Result<Value, McpToolError> {
        match name {
            "lead_start" => encode(self.lead_start(caller, decode(input)?, false).await?),
            "lead_restart" => encode(self.lead_start(caller, decode(input)?, true).await?),
            "intake_submit" => encode(self.intake_submit(caller, decode(input)?).await?),
            "workstream_list" => encode(self.workstream_list(caller, decode(input)?)?),
            "workstream_get" => encode(self.workstream_get(caller, decode(input)?)?),
            "workstream_spawn" => encode(self.workstream_spawn(caller, decode(input)?).await?),
            "inventory" => encode(self.inventory_tool(caller, decode(input)?).await?),
            other => Err(err(ErrorCode::NotFound, format!("No tool {other}."), "Call tools/list.")),
        }
    }

    /// lead_start and lead_restart save a given model or effort as the project's lead settings first.
    async fn lead_start(&self, caller: &AgentKeyInfo, input: LeadStartInput, restart: bool) -> Result<LeadStartOutput, McpToolError> {
        require(caller, Role::Operate, Some(&input.machine_id))?;
        let r = ProjectRef { machine_id: input.machine_id.clone(), project_id: input.project_id.clone() };
        if input.model.is_some() || input.effort.is_some() {
            if self.ctx.store.project_get(&r).map_err(|e| refusal(e.into()))?.is_none() {
                return Err(unknown_project(&r));
            }
            self.leads
                .configure(&r, &LeadSettings { model: input.model.as_ref().map(|m| m.to_string()), effort: input.effort })
                .map_err(refusal)?;
        }
        let lead = if restart { self.leads.restart(&r).await } else { self.leads.start(&r).await }.map_err(refusal)?;
        let next = if restart {
            format!(
                "Fresh lead thread {} (session {}) started from the current digest; the old thread stays in T3 as history.",
                lead.thread_id, lead.session_generation
            )
        } else {
            format!(
                "Lead thread {} is {}. Submit work with intake_submit; watch it with project_get or events_wait (lead.woken, ask.created, batch.ready).",
                lead.thread_id,
                super::digest::serde_plain(&lead.state)
            )
        };
        Ok(LeadStartOutput { lead, next: Some(next), truncated: None })
    }

    async fn intake_submit(&self, caller: &AgentKeyInfo, input: IntakeSubmitInput) -> Result<IntakeSubmitOutput, McpToolError> {
        require(caller, Role::Operate, input.machine_id.as_ref())?;
        let gate = caller.clone();
        let project_ref = match (input.machine_id, input.project_id) {
            (Some(machine_id), Some(project_id)) => Some(ProjectRef { machine_id, project_id }),
            _ => None,
        };
        let result = self
            .intake
            .submit(SubmitInput {
                text: input.text.to_string(),
                template: input.template,
                project_ref,
                client_request_id: input.client_request_id.to_string(),
                channel: fleetd_contracts::ledger::IntakeChannel::Mcp,
                by: caller.key_id.to_string(),
                allows: Box::new(move |m| allows(&gate, Role::Operate, Some(m))),
            })
            .await
            .map_err(refusal)?;
        Ok(match result {
            SubmitResult::Placed { workstream_id, echo, next } => {
                IntakeSubmitOutput { workstream_id: Some(workstream_id), ask_id: None, echo: Some(echo), next, truncated: None }
            }
            SubmitResult::Asked { ask_id, next } => IntakeSubmitOutput { workstream_id: None, ask_id: Some(ask_id), echo: None, next: Some(next), truncated: None },
        })
    }

    fn workstream_list(&self, caller: &AgentKeyInfo, input: WorkstreamListInput) -> Result<WorkstreamListOutput, McpToolError> {
        if let Some(m) = &input.machine_id {
            require(caller, Role::Read, Some(m))?;
        }
        let limit = input.limit.get() as usize;
        let r = match (&input.machine_id, &input.project_id) {
            (Some(machine_id), Some(project_id)) => Some(ProjectRef { machine_id: machine_id.clone(), project_id: project_id.clone() }),
            _ => None,
        };
        let all: Vec<_> = self
            .workstreams
            .list(&WorkstreamFilter { limit: if r.is_some() { limit + 1 } else { 1000 }, project_ref: r, state: input.state, open: false })
            .map_err(refusal)?
            .into_iter()
            .filter(|w| {
                allows(caller, Role::Read, Some(&w.project_ref.machine_id))
                    && input.machine_id.as_ref().is_none_or(|m| *m == w.project_ref.machine_id)
                    && input.project_id.as_ref().is_none_or(|p| *p == w.project_ref.project_id)
            })
            .collect();
        let truncated = all.len() > limit;
        Ok(WorkstreamListOutput {
            workstreams: List::unchecked(all.into_iter().take(limit).collect()),
            next: truncated.then(|| "Narrow the list with machineId, projectId or state.".into()),
            truncated: truncated.then_some(true),
        })
    }

    fn workstream_get(&self, caller: &AgentKeyInfo, input: WorkstreamGetInput) -> Result<WorkstreamGetOutput, McpToolError> {
        let id = &input.workstream_id;
        let workstream = match self.workstreams.get(id).map_err(refusal)? {
            Some(w) if allows(caller, Role::Read, Some(&w.project_ref.machine_id)) => w,
            _ => return Err(unknown_workstream(id.as_str())),
        };
        let store = |e: crate::hub::store::StoreError| refusal(e.into());
        let mut asks = self
            .ctx
            .asks
            .list(&AskFilter { workstream_id: Some(id.clone()), state: Some(AskState::Open), limit: WORKSTREAM_ASKS + 1, ..Default::default() })
            .map_err(store)?;
        let mut decisions = self
            .ctx
            .decisions
            .list(&DecisionFilter { scope: Some(DecisionScope::Workstream { workstream_id: id.clone() }), limit: WORKSTREAM_ASKS + 1, ..Default::default() })
            .map_err(store)?;
        let truncated = asks.len() > WORKSTREAM_ASKS || decisions.len() > WORKSTREAM_ASKS;
        asks.truncate(WORKSTREAM_ASKS);
        decisions.truncate(WORKSTREAM_ASKS);
        let eta = self.ctx.hooks.estimates.get().and_then(|e| e.eta(&workstream));
        let claims = self.ctx.hooks.claims.get().map(|c| c.list(id, WORKSTREAM_CLAIMS)).filter(|c| !c.is_empty());
        let next = match workstream.state {
            WorkstreamState::Draft => "The lead has not registered its brief yet; wait for workstream.running with events_wait.".to_string(),
            WorkstreamState::Done => {
                format!("Done: its latest claim passed every done-when check (claims_list with workstreamId {}).", workstream.workstream_id)
            }
            _ => "Open asks are answered with asks_list and inbox_reply.".into(),
        };
        Ok(WorkstreamGetOutput {
            workstream,
            asks: List::unchecked(asks),
            decisions: List::unchecked(decisions),
            eta,
            claims: claims.map(List::unchecked),
            next: Some(next),
            truncated: truncated.then_some(true),
        })
    }

    /// The finish-all lead's own calls, for an outside orchestrator: same service, same limits, recorded as this key.
    async fn workstream_spawn(&self, caller: &AgentKeyInfo, input: WorkstreamSpawnInput) -> Result<WorkstreamSpawnOutput, McpToolError> {
        require(caller, Role::Operate, Some(&input.machine_id))?;
        let r = ProjectRef { machine_id: input.machine_id, project_id: input.project_id };
        if self.ctx.store.project_get(&r).map_err(|e| refusal(e.into()))?.is_none() {
            return Err(unknown_project(&r));
        }
        let finish_caller = Caller { project_ref: r, by: caller.key_id.to_string(), channel: Some(fleetd_contracts::ledger::IntakeChannel::Mcp) };
        let spawned = self.finish_all.spawn(&finish_caller, input.text.as_str(), input.serves.as_str(), input.template).await.map_err(refusal)?;
        Ok(WorkstreamSpawnOutput {
            next: Some(format!(
                "{} is a draft child of {}; its lead writes the brief. Watch it with workstream_get or events_wait (workstream.running, workstream.done).",
                spawned.workstream_id, spawned.parent
            )),
            workstream_id: spawned.workstream_id,
            parent: spawned.parent,
            playbook: spawned.playbook,
            truncated: None,
        })
    }

    async fn inventory_tool(&self, caller: &AgentKeyInfo, input: InventoryInput) -> Result<InventoryOutput, McpToolError> {
        require(caller, Role::Read, Some(&input.machine_id))?;
        let r = ProjectRef { machine_id: input.machine_id, project_id: input.project_id };
        if self.ctx.store.project_get(&r).map_err(|e| refusal(e.into()))?.is_none() {
            return Err(unknown_project(&r));
        }
        let listed = self.finish_all.inventory(&Caller { project_ref: r, by: caller.key_id.to_string(), channel: None }).await.map_err(refusal)?;
        let next = if listed.idle {
            "Nothing is left with a value source: the finish-all workstream is idle."
        } else if listed.spawnable > 0 {
            "Start a child for an unserved item with workstream_spawn, passing its serves value; that needs the project's open finish-all workstream (intake_submit \"finish: ...\" starts one)."
        } else {
            "Every item with a value source is in progress; wait for workstream.done with events_wait."
        };
        Ok(InventoryOutput {
            text: listed.text,
            spawnable: Count::unchecked(listed.spawnable as i64),
            idle: listed.idle,
            next: Some(next.into()),
            truncated: None,
        })
    }
}
