//! The ledger's MCP tools (decisions_search, decisions_record, digest_get) and lead calls (decide, decisions_search).
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::lead_calls::{
    DecideResult, DecideScope, DecisionsSearchResult, LeadCall, LeadCallResult,
};
use fleetd_contracts::ledger::{Decision, DecisionScope, DecisionSource, WorkstreamId};
use fleetd_contracts::mcp::{
    DecisionsRecordInput, DecisionsRecordOutput, DecisionsSearchInput, DecisionsSearchOutput,
    DigestGetInput, DigestGetOutput, ErrorCode,
};
use fleetd_contracts::prim::List;

use super::{Actor, DecisionFilter, LedgerCode, LedgerError, RecordInput};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, allows, allows_everywhere, is_human, require, unknown_project,
};

const SEARCH_LIMIT: i64 = 20;

/// The project a workstream belongs to, and a project's open workstreams. The leads area provides it; until then
/// every workstream is unknown.
pub trait WorkstreamLookup: Send + Sync {
    fn project_of(&self, workstream_id: &WorkstreamId) -> Option<ProjectRef>;
    /// Open workstreams in the project, up to `limit`.
    fn open_in(&self, project_ref: &ProjectRef, limit: usize) -> Vec<WorkstreamId>;
}

fn code(code: LedgerCode) -> ErrorCode {
    match code {
        LedgerCode::NotFound => ErrorCode::NotFound,
        LedgerCode::Invalid => ErrorCode::Invalid,
        LedgerCode::Forbidden => ErrorCode::Forbidden,
        LedgerCode::Internal => ErrorCode::Failed,
    }
}

/// Leads and the ledger refuse in the same `{ code, message, fix }` shape.
fn refusal(error: LedgerError) -> ToolError {
    ToolError {
        code: code(error.code),
        message: error.message,
        fix: error.fix,
    }
}

/// Who a decision written with this key comes from: the human for a human key (a person's device), else the agent.
fn actor_of(caller: &Caller) -> Actor {
    if is_human(caller) {
        Actor {
            source: DecisionSource::Human,
            by: format!("human:{}", caller.name),
        }
    } else {
        Actor {
            source: DecisionSource::Agent,
            by: caller.name.to_string(),
        }
    }
}

fn unknown_workstream(workstream_id: &WorkstreamId) -> ToolError {
    ToolError {
        code: ErrorCode::NotFound,
        message: format!("No workstream {workstream_id}."),
        fix: Some("Call workstream_list to see workstreams.".into()),
    }
}

fn workstream_project(hub: &Hub, workstream_id: &WorkstreamId) -> Option<ProjectRef> {
    hub.decisions
        .workstreams()
        .and_then(|lookup| lookup.project_of(workstream_id))
}

/// The project a decision scope belongs to: `None` for global, a not_found for an unknown workstream.
fn decision_project(hub: &Hub, scope: &DecisionScope) -> Result<Option<ProjectRef>, ToolError> {
    match scope {
        DecisionScope::Global => Ok(None),
        DecisionScope::Project { project_ref } => Ok(Some(project_ref.clone())),
        DecisionScope::Workstream { workstream_id } => workstream_project(hub, workstream_id)
            .map(Some)
            .ok_or_else(|| unknown_workstream(workstream_id)),
    }
}

fn can_read_decision(hub: &Hub, caller: &Caller, decision: &Decision) -> bool {
    match decision_project(hub, &decision.scope) {
        Ok(None) => true,
        Ok(Some(r)) => allows(caller, Role::Read, Some(&r.machine_id)),
        Err(_) => false,
    }
}

pub fn register(tools: &mut Registry) {
    tools.add(
        "decisions_search",
        |hub: Arc<Hub>, caller: Caller, input: DecisionsSearchInput| async move {
            if let Some(scope) = &input.scope
                && let Some(r) = decision_project(&hub, scope)?
            {
                require(&caller, Role::Read, Some(&r.machine_id))?;
            }
            let found = hub
                .decisions
                .search(
                    &input.query,
                    &DecisionFilter {
                        scope: input.scope.clone(),
                        limit: Some(input.limit.get()),
                        ..Default::default()
                    },
                )
                .map_err(refusal)?;
            let visible: Vec<Decision> = found
                .into_iter()
                .filter(|d| can_read_decision(&hub, &caller, d))
                .collect();
            let next = visible.is_empty().then(|| {
                "No active decision matches; record one with decisions_record.".to_string()
            });
            Ok::<_, ToolError>(DecisionsSearchOutput {
                decisions: List::unchecked(visible),
                next,
                truncated: None,
            })
        },
    );

    tools.add("decisions_record", |hub: Arc<Hub>, caller: Caller, input: DecisionsRecordInput| async move {
        let project = decision_project(&hub, &input.scope)?;
        match (&input.scope, &project) {
            (DecisionScope::Global, _) => {
                if !allows_everywhere(&caller, Role::Operate) {
                    return Err(ToolError {
                        code: ErrorCode::Forbidden,
                        message: "A global decision applies to every machine; this key has no operate grant on all of them.".into(),
                        fix: Some("Record it at project scope, or use a key with an operate grant on * machines.".into()),
                    });
                }
            }
            (scope, Some(r)) => {
                require(&caller, Role::Operate, Some(&r.machine_id))?;
                if matches!(scope, DecisionScope::Project { .. }) && hub.store.project_get(r)?.is_none() {
                    return Err(unknown_project(r));
                }
            }
            (_, None) => {}
        }
        let decision = hub
            .decisions
            .record(
                RecordInput {
                    key: input.key.clone(),
                    scope: input.scope.clone(),
                    value: input.value.to_string(),
                    why: input.why.as_deref().map(String::from),
                    project_ref: project,
                },
                &actor_of(&caller),
            )
            .map_err(refusal)?;
        let supersedes = decision.supersedes.as_ref().map(|s| format!(" and supersedes {s}")).unwrap_or_default();
        let next = format!(
            "{} is active{supersedes}. Leads use it instead of asking; a project's lead is woken with it.",
            decision.decision_id
        );
        Ok::<_, ToolError>(DecisionsRecordOutput { decision, next: Some(next), truncated: None })
    });

    tools.add("digest_get", |hub: Arc<Hub>, caller: Caller, _input: DigestGetInput| async move {
        let visible = |m: &MachineId| allows(&caller, Role::Read, Some(m));
        let digest = hub.digests.render(Some(&visible)).map_err(refusal)?;
        Ok::<_, ToolError>(DigestGetOutput {
            text: digest.text,
            at: Timestamp(digest.at),
            next: Some("The hub emits digest.ready at 09:00 and 18:00 (policy.tz) as the cue to call this again.".into()),
            truncated: None,
        })
    });
}

/// The ledger's lead-side calls (`decide`, `decisions_search`) for a caller already attributed to `project_ref` by its
/// cwd, with `by` = `lead:<machineId>/<projectId>`. The link area's `LeadCalls` registry routes those ops here and maps a refusal onto `LeadCallRefused` (`code.as_str()`,
/// `message`, `fix`).
/// A playbook gate change is hub-wide. A lead may log only one that tightens, and only as the human's answer: the
/// project's chat must have a human message since the change was proposed. A relaxing one is the human's approve.
fn gate_answered_in_chat(hub: &Hub, r: &ProjectRef, key: &str) -> Result<(), LedgerError> {
    let proposed = hub.retro.gate_waiting_on_chat(key).map_err(|why| {
        LedgerError::invalid_fix(
            why,
            "Don't log it: a settled change needs no decision, and a relaxing one is the human's approve in chat.",
        )
    })?;
    let replied = hub
        .chat
        .last_human_ms(r)
        .map_err(|e| LedgerError::invalid(e.to_string()))?
        .is_some_and(|at| at > proposed);
    if !replied {
        return Err(LedgerError::invalid_fix(
            format!("The human has not answered {key} in this project's chat yet."),
            "Ask in chat first: put the change to the human as a numbered item with your recommendation, then log their answer.",
        ));
    }
    Ok(())
}

pub fn lead_call(
    hub: &Hub,
    project_ref: &ProjectRef,
    by: &str,
    call: LeadCall,
) -> Result<LeadCallResult, LedgerError> {
    let r = project_ref.clone();
    match call {
        LeadCall::Decide(call) => {
            if call
                .key
                .as_str()
                .starts_with(crate::hub::retro::types::PLAYBOOK_KEY_PREFIX)
            {
                gate_answered_in_chat(hub, &r, call.key.as_str())?;
            }
            let scope = if call.scope == DecideScope::Project {
                DecisionScope::Project {
                    project_ref: r.clone(),
                }
            } else {
                DecisionScope::Workstream {
                    workstream_id: decide_workstream(hub, &r, call.workstream_id.as_ref())?,
                }
            };
            let decision = hub.decisions.record(
                RecordInput {
                    key: call.key,
                    scope,
                    value: call.value.to_string(),
                    why: call.why.as_deref().map(String::from),
                    project_ref: Some(r),
                },
                &Actor {
                    source: DecisionSource::Lead,
                    by: by.to_string(),
                },
            )?;
            Ok(LeadCallResult::Decide(DecideResult {
                decision,
                next: None,
            }))
        }
        LeadCall::DecisionsSearch(call) => {
            let decisions = hub.decisions.search(
                &call.query,
                &DecisionFilter {
                    chain: Some(super::Chain {
                        project_ref: r,
                        workstream_id: None,
                    }),
                    limit: Some(SEARCH_LIMIT),
                    ..Default::default()
                },
            )?;
            Ok(LeadCallResult::DecisionsSearch(DecisionsSearchResult {
                decisions: List::unchecked(decisions),
                next: None,
            }))
        }
        _ => Err(LedgerError::invalid(
            "The ledger handles only decide and decisions_search.",
        )),
    }
}

/// A workstream named in a call must be one of the caller's own.
fn own_workstream(
    hub: &Hub,
    project_ref: &ProjectRef,
    workstream_id: &WorkstreamId,
) -> Result<WorkstreamId, LedgerError> {
    match workstream_project(hub, workstream_id) {
        Some(r) if &r == project_ref => Ok(workstream_id.clone()),
        _ => Err(LedgerError {
            code: LedgerCode::NotFound,
            message: format!("There is no workstream {workstream_id} in your project."),
            fix: Some("Use a workstream id from the digest at the top of your last wake.".into()),
        }),
    }
}

/// `fleetd decide` without --workstream: the project's only open workstream, else the caller must say.
fn decide_workstream(
    hub: &Hub,
    project_ref: &ProjectRef,
    workstream_id: Option<&WorkstreamId>,
) -> Result<WorkstreamId, LedgerError> {
    if let Some(workstream_id) = workstream_id {
        return own_workstream(hub, project_ref, workstream_id);
    }
    let open = hub
        .decisions
        .workstreams()
        .map(|lookup| lookup.open_in(project_ref, 2))
        .unwrap_or_default();
    if let [only] = open.as_slice() {
        return Ok(only.clone());
    }
    Err(LedgerError::invalid_fix(
        if open.is_empty() {
            "Your project has no open workstream to scope this decision to."
        } else {
            "Your project has several open workstreams."
        },
        "Pass workstreamId W<n> from your digest, or scope project for a project-wide decision.",
    ))
}
