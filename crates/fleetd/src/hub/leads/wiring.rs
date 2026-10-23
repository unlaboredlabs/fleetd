//! The leads area's links into areas already on main: its ports over the executor, the write queue, node commands, the
//! ledger and the requests; the ledger's WorkstreamLookup; and its lead calls.
use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::ledger::{Decision, DecisionScope, HumanRequest, RequestState, WorkstreamId};
use fleetd_contracts::mcp::{McpToolError, ThreadLaunchInput};
use fleetd_contracts::verification::Claim;

use super::Area;
use super::error::LeadError;
use super::hooks::{BoxFuture, ClaimsHook};
use super::ports::{CmdOutcome, LeadPorts};
use super::records::{LeadRecords, WorkstreamFilter};
use crate::hub::approvals::store::{RequestFilter, Requests};
use crate::hub::checks::{ClaimFilter, Claims};
use crate::hub::executor::{ExecutorError, Executors, LaunchInput, LaunchOptions};
use crate::hub::ledger::{self, Chain, DecisionFilter, Decisions, LedgerCode, LedgerError};
use crate::hub::link::commands::CommandInput;
use crate::hub::link::lead_calls::LeadCallFuture;
use crate::hub::link::{LeadCallHandler, LeadCaller, LeadCalls, NodeCommands};
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
    pub queue: Arc<WriteQueue>,
    pub commands: Arc<NodeCommands>,
    pub requests: Arc<Requests>,
    pub decisions: Arc<Decisions>,
}

impl LeadPorts for HubPorts {
    fn launch(
        &self,
        machine_id: &MachineId,
        input: ThreadLaunchInput,
    ) -> BoxFuture<Result<ThreadId, LeadError>> {
        let executors = Arc::clone(&self.executors);
        let machine_id = machine_id.clone();
        Box::pin(async move {
            let profile = input.profile.unwrap_or_default();
            let launch = LaunchInput {
                project_id: input.project_id,
                prompt: input.prompt.to_string(),
                model: profile.model().into(),
                effort: profile.effort(),
                runtime_mode: input.runtime_mode,
                title: input.title,
                client_request_id: input.client_request_id.to_string(),
            };
            executors
                .launch(
                    &machine_id,
                    &launch,
                    LaunchOptions {
                        workspace: None,
                        role: fleetd_contracts::sessions::SessionRole::Lead,
                    },
                )
                .await
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

    fn run_command(
        &self,
        machine_id: &MachineId,
        cwd: String,
        argv: Vec<String>,
        timeout_sec: u32,
    ) -> BoxFuture<Result<CmdOutcome, String>> {
        let commands = Arc::clone(&self.commands);
        let machine_id = machine_id.clone();
        Box::pin(async move {
            let result = commands
                .run(
                    &machine_id,
                    CommandInput {
                        cwd,
                        argv,
                        timeout_sec: Some(timeout_sec),
                    },
                )
                .await
                .map_err(|e| e.message)?;
            Ok(CmdOutcome {
                exit_code: result
                    .exit_code
                    .and_then(|c| serde_json::to_value(c).ok())
                    .and_then(|v| v.as_i64()),
                output_tail: result.output_tail.to_string(),
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

struct ClaimsFromChecks(Arc<Claims>);

impl ClaimsHook for ClaimsFromChecks {
    fn latest(&self, workstream_id: &WorkstreamId) -> Option<Claim> {
        self.list(workstream_id, 1).into_iter().next()
    }
    fn list(&self, workstream_id: &WorkstreamId, limit: usize) -> Vec<Claim> {
        self.0
            .list(&ClaimFilter {
                workstream_id: Some(workstream_id.clone()),
                limit,
                ..Default::default()
            })
            .unwrap_or_default()
    }
    fn void(&self, workstream_id: &WorkstreamId) {
        if let Err(error) = self.0.void(workstream_id) {
            tracing::warn!(%error, "claim not voided");
        }
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
    pub queue: &'a Arc<WriteQueue>,
    pub commands: &'a Arc<NodeCommands>,
    pub requests: &'a Arc<Requests>,
    pub decisions: &'a Arc<Decisions>,
    pub lead_calls: &'a LeadCalls,
    pub claims: &'a Arc<Claims>,
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
                        open: true,
                        limit: OUTCOME_WORKSTREAMS + 1,
                        ..Default::default()
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
        queue: Arc::clone(links.queue),
        commands: Arc::clone(links.commands),
        requests: Arc::clone(links.requests),
        decisions: Arc::clone(links.decisions),
    }));
    let _ = area
        .ctx
        .hooks
        .claims
        .set(Arc::new(ClaimsFromChecks(Arc::clone(links.claims))));
    links
        .decisions
        .set_workstreams(Arc::new(Lookup(Arc::clone(&area.records))));
    let calls: Arc<dyn LeadCallHandler> = Arc::new(Calls(Arc::clone(area)));
    for op in super::calls::OPS {
        links.lead_calls.register(op, Arc::clone(&calls));
    }
}
