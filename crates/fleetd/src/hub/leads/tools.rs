//! MCP tools this area serves: lead_start, lead_restart, project_set, workstream_list, workstream_get. Same grant checks, limits and `next` texts as older hubs.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::WorkstreamState;
use fleetd_contracts::mcp::*;
use fleetd_contracts::prim::List;

use super::Area;
use super::error::LeadError;
use super::records::WorkstreamFilter;
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, require, unknown_project};

const WORKSTREAM_ASKS: usize = 50;
const WORKSTREAM_CLAIMS: usize = 20;

pub fn register(tools: &mut Registry) {
    tools.add::<LeadStartInput, LeadStartOutput, _, _>("lead_start", |hub: Arc<Hub>, caller, input| async move {
        hub.leads.lead_start(&caller, input, false).await
    });
    tools.add::<LeadRestartInput, LeadRestartOutput, _, _>("lead_restart", |hub: Arc<Hub>, caller, input| async move {
        hub.leads.lead_start(&caller, input, true).await
    });
    tools.add::<ProjectSetInput, ProjectSetOutput, _, _>(
        "project_set",
        |hub: Arc<Hub>, caller, input| async move { hub.leads.project_set(&caller, input) },
    );
    tools.add::<WorkstreamListInput, WorkstreamListOutput, _, _>(
        "workstream_list",
        |hub: Arc<Hub>, caller, input| async move { hub.leads.workstream_list(&caller, input) },
    );
    tools.add::<WorkstreamGetInput, WorkstreamGetOutput, _, _>(
        "workstream_get",
        |hub: Arc<Hub>, caller, input| async move { hub.leads.workstream_get(&caller, input) },
    );
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
                "Lead thread {} is {}. Write to it with chat_send; watch it with project_get or events_wait (lead.woken, request.opened).",
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

    pub(crate) fn project_set(
        &self,
        caller: &Caller,
        input: ProjectSetInput,
    ) -> Result<ProjectSetOutput, ToolError> {
        require(caller, Role::Operate, Some(&input.machine_id))?;
        let r = ProjectRef {
            machine_id: input.machine_id,
            project_id: input.project_id,
        };
        let Some(project) = self.ctx.store.project_get(&r).map_err(refusal)? else {
            return Err(unknown_project(&r));
        };
        self.leads
            .set_medium_allowed(&r, &project.title, input.medium_allowed)
            .map_err(refusal)?;
        let next = if input.medium_allowed {
            "Its lead may run mechanical tasks on medium; everything else stays on high."
        } else {
            "Every new task of the project runs on high; running tasks keep their profile."
        };
        Ok(ProjectSetOutput {
            medium_allowed: input.medium_allowed,
            next: Some(next.into()),
            truncated: None,
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
        let mut requests: Vec<_> = self
            .ctx
            .ports()
            .open_requests(Some(&workstream.project_ref), 200)
            .map_err(refusal)?
            .into_iter()
            .filter(|r| r.workstream_id.as_ref() == Some(id))
            .collect();
        let mut decisions = self
            .ctx
            .ports()
            .decisions_of_workstream(id, WORKSTREAM_ASKS + 1)
            .map_err(refusal)?;
        let truncated = requests.len() > WORKSTREAM_ASKS || decisions.len() > WORKSTREAM_ASKS;
        requests.truncate(WORKSTREAM_ASKS);
        decisions.truncate(WORKSTREAM_ASKS);
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
            _ => "Its open requests (a secret to enter, a command to approve) are answered in the project's chat.".into(),
        };
        Ok(WorkstreamGetOutput {
            workstream,
            requests: List::unchecked(requests),
            decisions: List::unchecked(decisions),
            claims: claims.map(List::unchecked),
            next: Some(next),
            truncated: truncated.then_some(true),
        })
    }
}
