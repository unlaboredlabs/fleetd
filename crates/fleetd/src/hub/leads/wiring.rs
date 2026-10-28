//! The leads area's links into areas already on main: its ports over the executor, the write queue, the
//! ledger and the requests; the ledger's WorkstreamLookup; and its lead calls.
use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::ledger::{
    Decision, DecisionScope, HumanRequest, RequestState, WorkstreamId, WorkstreamState,
};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::sessions::SessionRole;

use super::Area;
use super::error::LeadError;
use super::hooks::BoxFuture;
use super::ports::LeadPorts;
use super::records::{LeadRecords, WorkstreamFilter};
use crate::hub::approvals::store::{RequestFilter, Requests};
use crate::hub::executor::{ExecutorError, Executors, LaunchInput, LaunchOptions};
use crate::hub::ledger::{self, Chain, DecisionFilter, Decisions, LedgerCode, LedgerError};
use crate::hub::link::lead_calls::LeadCallFuture;
use crate::hub::link::{LeadCallHandler, LeadCaller, LeadCalls};
use crate::hub::queue::WriteQueue;

impl From<LedgerError> for LeadError {
    fn from(e: LedgerError) -> Self {
        let code = match e.code {
            LedgerCode::NotFound => fleetd_contracts::mcp::ErrorCode::NotFound,
            LedgerCode::Invalid => fleetd_contracts::mcp::ErrorCode::Invalid,
            LedgerCode::Forbidden => fleetd_contracts::mcp::ErrorCode::Forbidden,
            LedgerCode::Internal => fleetd_contracts::mcp::ErrorCode::Failed,
        };
        LeadError {
            code,
            message: e.message,
            fix: e.fix,
        }
    }
}

fn from_executor(error: ExecutorError) -> LeadError {
    match error {
        ExecutorError::MachineNotConnected { machine_id } => {
            LeadError::machine_offline(&machine_id)
        }
        // The node's own words and fix, e.g. claude not logged in and how to log it in.
        ExecutorError::NodeRequestFailed {
            fix: Some(ref fix), ..
        } => LeadError {
            fix: Some(fix.clone()),
            ..LeadError::failed(error.to_string())
        },
        other => LeadError::failed(other.to_string()),
    }
}

pub struct HubPorts {
    pub executors: Arc<Executors>,
    pub link: Arc<crate::hub::link::NodeLinkServer>,
    pub queue: Arc<WriteQueue>,
    pub requests: Arc<Requests>,
    pub decisions: Arc<Decisions>,
}

impl LeadPorts for HubPorts {
    fn launch(
        &self,
        machine_id: &MachineId,
        input: LaunchInput,
        role: SessionRole,
    ) -> BoxFuture<Result<ThreadId, LeadError>> {
        let executors = Arc::clone(&self.executors);
        let machine_id = machine_id.clone();
        // An older node can't decode the assistant role and would drop its link on the launch.
        let too_old = role == SessionRole::Assistant
            && !self
                .link
                .node_can(&machine_id, fleetd_contracts::node_link::CAP_ASSISTANT);
        // A project's lead runs on the hub's account whoever writes to it, a Navi's on its owner's (teams step 8): the
        // same on every turn, as the session keeps it.
        let project = ProjectRef {
            machine_id: machine_id.clone(),
            project_id: input.project_id.clone(),
        };
        let account =
            crate::hub::claude_accounts::for_lead(self.executors.hub_db(), &self.link, &project);
        Box::pin(async move {
            if too_old {
                return Err(LeadError::new(
                    ErrorCode::Invalid,
                    format!("{machine_id}'s node is too old to run a Navi."),
                    format!(
                        "Run fleetd update on {machine_id}; the Navi's message waits until then."
                    ),
                ));
            }
            let claude_account =
                account.map_err(|r| LeadError::new(ErrorCode::Invalid, r.message, r.fix))?;
            executors
                .launch(
                    &machine_id,
                    &input,
                    LaunchOptions {
                        workspace: None,
                        role,
                        mcp_role: Some(fleetd_contracts::mcp_servers::McpAgentRole::Lead),
                        claude_account,
                        ..Default::default()
                    },
                )
                .await
                .map(|(thread_id, _)| thread_id)
                .map_err(from_executor)
        })
    }

    fn send(
        &self,
        thread: ThreadRef,
        message: String,
        client_request_id: String,
    ) -> BoxFuture<Result<bool, LeadError>> {
        let queue = Arc::clone(&self.queue);
        Box::pin(async move {
            queue
                .send(&thread, &message, &client_request_id, None)
                .await
                .map(|sent| sent.queued)
                .map_err(|error| match error {
                    crate::hub::queue::ports::ExecutorError::MachineNotConnected { machine_id } => {
                        LeadError::machine_offline(&machine_id)
                    }
                    // The node's own words and fix, e.g. claude not logged in and how to log it in.
                    crate::hub::queue::ports::ExecutorError::NodeRequestFailed {
                        fix: Some(ref fix),
                        ..
                    } => LeadError {
                        fix: Some(fix.clone()),
                        ..LeadError::failed(error.to_string())
                    },
                    other => LeadError::failed(other.to_string()),
                })
        })
    }

    fn open_requests(
        &self,
        project_ref: Option<&ProjectRef>,
        limit: usize,
    ) -> Result<Vec<HumanRequest>, LeadError> {
        self.requests
            .list(&RequestFilter {
                project_ref: project_ref.cloned(),
                states: Some(vec![RequestState::Open]),
                kind: None,
                limit: limit as i64,
            })
            .map_err(|e| LeadError::failed(e.to_string()))
    }

    fn decisions_in_project(
        &self,
        project_ref: &ProjectRef,
        limit: usize,
    ) -> Result<Vec<Decision>, LeadError> {
        Ok(self.decisions.list(&DecisionFilter {
            chain: Some(Chain {
                project_ref: project_ref.clone(),
                workstream_id: None,
            }),
            limit: Some(limit as i64),
            ..Default::default()
        })?)
    }

    fn decisions_of_workstream(
        &self,
        workstream_id: &WorkstreamId,
        limit: usize,
    ) -> Result<Vec<Decision>, LeadError> {
        Ok(self.decisions.list(&DecisionFilter {
            scope: Some(DecisionScope::Workstream {
                workstream_id: workstream_id.clone(),
            }),
            limit: Some(limit as i64),
            ..Default::default()
        })?)
    }
}

struct Lookup(Arc<LeadRecords>);

impl ledger::WorkstreamLookup for Lookup {
    fn project_of(&self, workstream_id: &WorkstreamId) -> Option<ProjectRef> {
        self.0.project_of(workstream_id)
    }
    fn open_in(&self, project_ref: &ProjectRef, limit: usize) -> Vec<WorkstreamId> {
        self.0.open_in(project_ref, limit)
    }
}

struct Calls(Arc<Area>);

impl LeadCallHandler for Calls {
    fn handle(&self, caller: LeadCaller, call: LeadCall) -> LeadCallFuture {
        let area = Arc::clone(&self.0);
        Box::pin(async move {
            area.lead_call(&caller.project_ref, &caller.by, call)
                .await
                .map_err(McpToolError::from)
                .map(|r: LeadCallResult| r)
        })
    }
}

pub struct Links<'a> {
    pub executors: &'a Arc<Executors>,
    pub link: &'a Arc<crate::hub::link::NodeLinkServer>,
    pub queue: &'a Arc<WriteQueue>,
    pub requests: &'a Arc<Requests>,
    pub decisions: &'a Arc<Decisions>,
    pub lead_calls: &'a LeadCalls,
}

const OUTCOME_WORKSTREAMS: usize = 20;

/// Called once in `serve::build_on`, after the areas below leads are built.
pub fn wire_area(area: &Arc<Area>, links: Links<'_>) {
    // project_get shows the project's lead, whether its tasks may run medium, and its open workstreams.
    let outcome = Arc::clone(area);
    links
        .executors
        .hooks
        .extend_project_get(Arc::new(move |_hub, project_ref| {
            let area = Arc::clone(&outcome);
            Box::pin(async move {
                let mut extra = crate::hub::executor::tools::ProjectExtra::default();
                let internal = |e: LeadError| McpToolError::from(e);
                if let Some(lead) = area.leads.get(&project_ref).map_err(internal)? {
                    extra.fields.insert(
                        "lead".into(),
                        serde_json::to_value(lead).unwrap_or_default(),
                    );
                }
                let medium = area.leads.medium_allowed(&project_ref).map_err(internal)?;
                extra.fields.insert("mediumAllowed".into(), medium.into());
                let mut open = area
                    .workstreams
                    .list(&WorkstreamFilter {
                        project_ref: Some(project_ref),
                        state: Some(WorkstreamState::Open),
                        limit: OUTCOME_WORKSTREAMS + 1,
                    })
                    .map_err(internal)?;
                if open.len() > OUTCOME_WORKSTREAMS {
                    open.truncate(OUTCOME_WORKSTREAMS);
                    extra.truncated = Some(true);
                }
                if !open.is_empty() {
                    extra.fields.insert(
                        "workstreams".into(),
                        serde_json::to_value(open).unwrap_or_default(),
                    );
                }
                Ok(extra)
            })
        }));
    area.ctx.set_ports(Arc::new(HubPorts {
        executors: Arc::clone(links.executors),
        link: Arc::clone(links.link),
        queue: Arc::clone(links.queue),
        requests: Arc::clone(links.requests),
        decisions: Arc::clone(links.decisions),
    }));
    links
        .decisions
        .set_workstreams(Arc::new(Lookup(Arc::clone(&area.records))));
    let calls: Arc<dyn LeadCallHandler> = Arc::new(Calls(Arc::clone(area)));
    for op in super::calls::OPS {
        links.lead_calls.register(op, Arc::clone(&calls));
    }
}
