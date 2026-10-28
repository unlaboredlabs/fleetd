//! MCP tools this area serves: lead_start, project_set, workstream_list. Same grant checks, limits and `next` texts as older hubs.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::*;
use fleetd_contracts::prim::List;

use super::Area;
use super::error::LeadError;
use super::records::WorkstreamFilter;
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, require, unknown_project};

pub fn register(tools: &mut Registry) {
    tools.add::<LeadStartInput, LeadStartOutput, _, _>(
        "lead_start",
        |hub: Arc<Hub>, caller, input| async move { hub.leads.lead_start(&caller, input).await },
    );
    tools.add::<ProjectSetInput, ProjectSetOutput, _, _>(
        "project_set",
        |hub: Arc<Hub>, caller, input| async move { hub.leads.project_set(&caller, input) },
    );
    tools.add::<WorkstreamListInput, WorkstreamListOutput, _, _>(
        "workstream_list",
        |hub: Arc<Hub>, caller, input| async move { hub.leads.workstream_list(&caller, input) },
    );
}

fn refusal(e: impl Into<LeadError>) -> ToolError {
    e.into().into()
}

impl Area {
    pub(crate) async fn lead_start(
        &self,
        caller: &Caller,
        input: LeadStartInput,
    ) -> Result<LeadStartOutput, ToolError> {
        let restart = input.fresh == Some(true);
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
        let allowed = self
            .leads
            .set_allowed_profiles(&r, &project.title, &input.profiles)
            .map_err(refusal)?;
        let next = format!(
            "Its lead may run new tasks on {}; {} is the default. Running tasks keep their profile.",
            allowed
                .iter()
                .map(|p| p.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            allowed[0]
        );
        Ok(ProjectSetOutput {
            profiles: List::unchecked(allowed),
            next: Some(next),
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
}
