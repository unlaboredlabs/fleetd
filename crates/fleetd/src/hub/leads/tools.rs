//! MCP tools this area serves: lead_start, lead_restart, intake_submit, workstream_list, workstream_get,
//! workstream_spawn, inventory. Same grant checks, limits and `next` texts as older hubs.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{IntakeChannel, WorkstreamState};
use fleetd_contracts::mcp::*;
use fleetd_contracts::prim::{Count, List};

use super::Area;
use super::error::LeadError;
use super::records::{LeadSettings, WorkstreamFilter};
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, require, unknown_project};
use crate::hub::intake::{SubmitInput, SubmitResult};
use crate::hub::playbooks::finish_all::Caller as FinishAllCaller;

const WORKSTREAM_ASKS: usize = 50;
const WORKSTREAM_CLAIMS: usize = 20;

pub fn register(tools: &mut Registry) {
    tools.add::<LeadStartInput, LeadStartOutput, _, _>("lead_start", |hub: Arc<Hub>, caller, input| async move {
        hub.leads.lead_start(&caller, input, false).await
    });
    tools.add::<LeadRestartInput, LeadRestartOutput, _, _>("lead_restart", |hub: Arc<Hub>, caller, input| async move {
        hub.leads.lead_start(&caller, input, true).await
    });
    tools.add::<IntakeSubmitInput, IntakeSubmitOutput, _, _>(
        "intake_submit",
        |hub: Arc<Hub>, caller, input| async move { hub.leads.intake_submit(&caller, input).await },
    );
    tools.add::<WorkstreamListInput, WorkstreamListOutput, _, _>(
        "workstream_list",
        |hub: Arc<Hub>, caller, input| async move { hub.leads.workstream_list(&caller, input) },
    );
    tools.add::<WorkstreamGetInput, WorkstreamGetOutput, _, _>(
        "workstream_get",
        |hub: Arc<Hub>, caller, input| async move { hub.leads.workstream_get(&caller, input) },
    );
    tools.add::<WorkstreamSpawnInput, WorkstreamSpawnOutput, _, _>("workstream_spawn", |hub: Arc<Hub>, caller, input| async move {
        hub.leads.workstream_spawn(&caller, input).await
    });
    tools.add::<InventoryInput, InventoryOutput, _, _>("inventory", |hub: Arc<Hub>, caller, input| async move {
        hub.leads.inventory_tool(&caller, input).await
    });
}

fn unknown_workstream(id: &str) -> ToolError {
    ToolError {
        code: ErrorCode::NotFound,
        message: format!("No workstream {id}."),
        fix: Some("Call workstream_list to see workstreams.".into()),
    }
}

fn refusal(e: impl Into<LeadError>) -> ToolError {
    e.into().into()
}

impl Area {
    /// lead_start and lead_restart save a given model or effort as the project's lead settings first.
    pub(crate) async fn lead_start(
        &self,
        caller: &Caller,
        input: LeadStartInput,
        restart: bool,
    ) -> Result<LeadStartOutput, ToolError> {
        require(caller, Role::Operate, Some(&input.machine_id))?;
        let r = ProjectRef {
            machine_id: input.machine_id.clone(),
            project_id: input.project_id.clone(),
        };
        if input.model.is_some() || input.effort.is_some() {
            if self.ctx.store.project_get(&r).map_err(refusal)?.is_none() {
                return Err(unknown_project(&r));
            }
            self.leads
                .configure(
                    &r,
                    &LeadSettings {
                        model: input.model.as_ref().map(|m| m.to_string()),
                        effort: input.effort,
                    },
                )
                .map_err(refusal)?;
        }
        let lead = if restart {
            self.leads.restart(&r).await
        } else {
            self.leads.start(&r).await
        }
        .map_err(refusal)?;
        let next = if restart {
            format!(
                "Fresh lead thread {} (session {}) started from the current digest; the old thread stays on the node as history.",
                lead.thread_id, lead.session_generation
            )
        } else {
            format!(
                "Lead thread {} is {}. Submit work with intake_submit; watch it with project_get or events_wait (lead.woken, ask.created, batch.ready).",
                lead.thread_id,
                super::digest::serde_plain(&lead.state)
            )
        };
        Ok(LeadStartOutput {
            lead,
            next: Some(next),
            truncated: None,
        })
    }

    pub(crate) async fn intake_submit(
        &self,
        caller: &Caller,
        input: IntakeSubmitInput,
    ) -> Result<IntakeSubmitOutput, ToolError> {
        require(caller, Role::Operate, input.machine_id.as_ref())?;
        let gate = caller.clone();
        let project_ref = match (input.machine_id, input.project_id) {
            (Some(machine_id), Some(project_id)) => Some(ProjectRef {
                machine_id,
                project_id,
            }),
            _ => None,
        };
        let result = self
            .intake
            .submit(SubmitInput {
                text: input.text.to_string(),
                template: input.template,
                project_ref,
                client_request_id: input.client_request_id.to_string(),
                channel: IntakeChannel::Mcp,
                by: caller.key_id.to_string(),
                allows: Box::new(move |m| allows(&gate, Role::Operate, Some(m))),
            })
            .await
            .map_err(refusal)?;
        Ok(match result {
            SubmitResult::Placed {
                workstream_id,
                echo,
                next,
            } => IntakeSubmitOutput {
                workstream_id: Some(workstream_id),
                ask_id: None,
                echo: Some(echo),
                next,
                truncated: None,
            },
            SubmitResult::Asked { ask_id, next } => IntakeSubmitOutput {
                workstream_id: None,
                ask_id: Some(ask_id),
                echo: None,
                next: Some(next),
                truncated: None,
            },
        })
    }

    pub(crate) fn workstream_list(
        &self,
        caller: &Caller,
        input: WorkstreamListInput,
    ) -> Result<WorkstreamListOutput, ToolError> {
        if let Some(m) = &input.machine_id {
            require(caller, Role::Read, Some(m))?;
        }
        let limit = input.limit.get() as usize;
        let r = match (&input.machine_id, &input.project_id) {
            (Some(machine_id), Some(project_id)) => Some(ProjectRef {
                machine_id: machine_id.clone(),
                project_id: project_id.clone(),
            }),
            _ => None,
        };
        let all: Vec<_> = self
            .workstreams
            .list(&WorkstreamFilter {
                limit: if r.is_some() { limit + 1 } else { 1000 },
                project_ref: r,
                state: input.state,
                open: false,
            })
            .map_err(refusal)?
            .into_iter()
            .filter(|w| {
                allows(caller, Role::Read, Some(&w.project_ref.machine_id))
                    && input
                        .machine_id
                        .as_ref()
                        .is_none_or(|m| *m == w.project_ref.machine_id)
                    && input
                        .project_id
                        .as_ref()
                        .is_none_or(|p| *p == w.project_ref.project_id)
            })
            .collect();
        let truncated = all.len() > limit;
        Ok(WorkstreamListOutput {
            workstreams: List::unchecked(all.into_iter().take(limit).collect()),
            next: truncated.then(|| "Narrow the list with machineId, projectId or state.".into()),
            truncated: truncated.then_some(true),
        })
    }

    pub(crate) fn workstream_get(
        &self,
        caller: &Caller,
        input: WorkstreamGetInput,
    ) -> Result<WorkstreamGetOutput, ToolError> {
        let id = &input.workstream_id;
        let workstream = match self.workstreams.get(id).map_err(refusal)? {
            Some(w) if allows(caller, Role::Read, Some(&w.project_ref.machine_id)) => w,
            _ => return Err(unknown_workstream(id.as_str())),
        };
        let mut asks = self
            .ctx
            .ports()
            .open_asks(None, Some(id), WORKSTREAM_ASKS + 1)
            .map_err(refusal)?;
        let mut decisions = self
            .ctx
            .ports()
            .decisions_of_workstream(id, WORKSTREAM_ASKS + 1)
            .map_err(refusal)?;
        let truncated = asks.len() > WORKSTREAM_ASKS || decisions.len() > WORKSTREAM_ASKS;
        asks.truncate(WORKSTREAM_ASKS);
        decisions.truncate(WORKSTREAM_ASKS);
        let eta = self
            .ctx
            .hooks
            .estimates
            .get()
            .and_then(|e| e.eta(&workstream));
        let claims = self
            .ctx
            .hooks
            .claims
            .get()
            .map(|c| c.list(id, WORKSTREAM_CLAIMS))
            .filter(|c| !c.is_empty());
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
    pub(crate) async fn workstream_spawn(
        &self,
        caller: &Caller,
        input: WorkstreamSpawnInput,
    ) -> Result<WorkstreamSpawnOutput, ToolError> {
        require(caller, Role::Operate, Some(&input.machine_id))?;
        let r = ProjectRef {
            machine_id: input.machine_id,
            project_id: input.project_id,
        };
        if self.ctx.store.project_get(&r).map_err(refusal)?.is_none() {
            return Err(unknown_project(&r));
        }
        let finish_caller = FinishAllCaller {
            project_ref: r,
            by: caller.key_id.to_string(),
            channel: Some(IntakeChannel::Mcp),
        };
        let spawned = self
            .finish_all
            .spawn(
                &finish_caller,
                input.text.as_str(),
                input.serves.as_str(),
                input.template,
            )
            .await
            .map_err(refusal)?;
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

    pub(crate) async fn inventory_tool(
        &self,
        caller: &Caller,
        input: InventoryInput,
    ) -> Result<InventoryOutput, ToolError> {
        require(caller, Role::Read, Some(&input.machine_id))?;
        let r = ProjectRef {
            machine_id: input.machine_id,
            project_id: input.project_id,
        };
        if self.ctx.store.project_get(&r).map_err(refusal)?.is_none() {
            return Err(unknown_project(&r));
        }
        let listed = self
            .finish_all
            .inventory(&FinishAllCaller {
                project_ref: r,
                by: caller.key_id.to_string(),
                channel: None,
            })
            .await
            .map_err(refusal)?;
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
