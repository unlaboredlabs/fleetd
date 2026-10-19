//! The ledger's MCP tools (asks_list, inbox_reply, decisions_search, decisions_record, digest_get)
//! and lead calls (ask, ask_withdraw, decide, decisions_search).
use std::collections::HashSet;
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::lead_calls::{
    AskResult, AskWithdrawResult, DecideResult, DecideScope, DecisionsSearchResult, LeadCall,
    LeadCallResult,
};
use fleetd_contracts::ledger::{AskState, Decision, DecisionScope, DecisionSource, WorkstreamId};
use fleetd_contracts::mcp::{
    AsksListInput, AsksListOutput, DecisionsRecordInput, DecisionsRecordOutput,
    DecisionsSearchInput, DecisionsSearchOutput, DigestGetInput, DigestGetOutput, ErrorCode,
    InboxReplyInput,
};
use fleetd_contracts::prim::List;

use super::asks::OutcomeState;
use super::{
    Actor, AskFilter, AskInput, DecisionFilter, LedgerCode, LedgerError, RecordInput, ReplyInput,
};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, allows, allows_everywhere, cap, is_human, require,
    unknown_project,
};

const ASKS_LIMIT: usize = 100;
const BATCHES_LIMIT: usize = 20;
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
    tools.add("asks_list", |hub: Arc<Hub>, caller: Caller, input: AsksListInput| async move {
        let listed: Vec<_> = hub
            .asks
            .list(&AskFilter { state: Some(input.state), batch_id: input.batch_id.clone(), limit: Some(1000), ..Default::default() })
            .map_err(refusal)?
            .into_iter()
            .filter(|ask| allows(&caller, Role::Read, ask.project_ref.as_ref().map(|r| &r.machine_id)))
            .collect();
        let shown_asks = cap(listed, ASKS_LIMIT);
        let ids: HashSet<String> = shown_asks.items.iter().map(|a| a.ask_id.to_string()).collect();
        let in_batch: HashSet<String> = shown_asks.items.iter().filter_map(|a| a.batch_id.as_ref().map(|b| b.to_string())).collect();
        let candidates = match &input.batch_id {
            None => hub.asks.batches(None, None, Some(200)),
            Some(batch_id) => hub.asks.batches(None, Some(batch_id), None),
        }
        .map_err(refusal)?;
        // Only the caller's items are shown; numbers stay as fixed in the batch.
        let batches: Vec<_> = candidates
            .into_iter()
            .filter(|b| in_batch.contains(b.batch_id.as_str()))
            .map(|mut b| {
                b.items.retain(|item| ids.contains(item.ask_id.as_str()));
                b
            })
            .collect();
        let shown_batches = cap(batches, BATCHES_LIMIT);
        let truncated = shown_asks.truncated.or(shown_batches.truncated);
        let next = if shown_asks.items.is_empty() {
            "Nothing to answer. Wait for batch.ready with events_wait."
        } else {
            r##"Answer with inbox_reply, e.g. "1 go 2 nvm 3 b", "recs fine", "2: your own answer"; a leading "#B<n>" picks an older batch."##
        };
        Ok::<_, ToolError>(AsksListOutput {
            batches: List::unchecked(shown_batches.items),
            asks: List::unchecked(shown_asks.items),
            next: Some(next.into()),
            truncated: truncated.filter(|t| *t),
        })
    });

    tools.add(
        "inbox_reply",
        |hub: Arc<Hub>, caller: Caller, input: InboxReplyInput| async move {
            let grants = caller.clone();
            let reply = ReplyInput {
                raw: input.raw.to_string(),
                batch_id: input.batch_id.clone(),
                allows: Some(Box::new(move |r: Option<&ProjectRef>| match r {
                    None => allows_everywhere(&grants, Role::Operate),
                    Some(r) => allows(&grants, Role::Operate, Some(&r.machine_id)),
                })),
            };
            let mut result = hub
                .inbox
                .reply(&reply, &actor_of(&caller))
                .map_err(refusal)?;
            if result.parsed {
                result.next = Some(
                    "Each answer is a Decision now and reaches its lead in its next wake.".into(),
                );
            }
            Ok::<_, ToolError>(result)
        },
    );

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
                    ask_id: None,
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
            next: Some("Answer open items with inbox_reply. The hub emits digest.ready at 09:00 and 18:00 (policy.tz) as the cue to call this again.".into()),
            truncated: None,
        })
    });
}

/// The ledger's lead-side calls (`ask`, `ask_withdraw`, `decide`, `decisions_search`) for a caller already attributed
/// to `project_ref` by its cwd, with `by` = `lead:<machineId>/<projectId>`. The link area's
/// `LeadCalls` registry routes those four ops here and maps a refusal onto `LeadCallRefused` (`code.as_str()`,
/// `message`, `fix`).
pub fn lead_call(
    hub: &Hub,
    project_ref: &ProjectRef,
    by: &str,
    call: LeadCall,
) -> Result<LeadCallResult, LedgerError> {
    let r = project_ref.clone();
    match call {
        LeadCall::Ask(call) => {
            let workstream_id = call
                .workstream_id
                .as_ref()
                .map(|w| own_workstream(hub, &r, w))
                .transpose()?;
            let outcome = hub.asks.create(
                &AskInput {
                    project_ref: Some(r),
                    workstream_id,
                    kind: call.kind.into(),
                    key: call.key,
                    class: call.class.to_string(),
                    text: call.text,
                    context: call.context,
                    recommendation: call.recommendation,
                    recommendation_why: call.recommendation_why,
                    options: call.options,
                    steps: call.steps,
                    verify: call.verify,
                    sink: call.sink,
                    env_name: call.env_name,
                    gated: None,
                    permission: None,
                    blocks: call.blocks,
                    proceeded_on_rec: call.proceeded_on_rec,
                },
                by,
            )?;
            Ok(LeadCallResult::Ask(AskResult {
                state: if outcome.state == OutcomeState::Auto {
                    AskState::Auto
                } else {
                    AskState::Open
                },
                ask_id: outcome.ask.ask_id,
                decision: outcome.decision,
                attached: outcome.attached,
                candidates: outcome
                    .candidates
                    .map(|c| List::unchecked(c.into_iter().take(5).collect())),
                next: None,
            }))
        }
        LeadCall::AskWithdraw(call) => {
            let ask = hub
                .asks
                .withdraw(&call.ask_id, call.r#use.as_ref(), Some(&r), None)?;
            Ok(LeadCallResult::AskWithdraw(AskWithdrawResult {
                ask_id: ask.ask_id,
                state: ask.state,
                next: None,
            }))
        }
        LeadCall::Decide(call) => {
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
                    ask_id: None,
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
            "The ledger handles only ask, ask_withdraw, decide and decisions_search.",
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
        "Pass --workstream W<n> from your digest, or --scope project for a project-wide decision.",
    ))
}
