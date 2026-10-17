//! The ledger's MCP tools (asks_list, inbox_reply, decisions_search, decisions_record, digest_get)
//! and lead calls (ask, ask_withdraw, decide, decisions_search). TS: the matching handlers in api/FleetApi.ts and
//! leads/LeadCallHandler.ts.
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
use crate::hub::link::{LeadCallHandler, LeadCallRefused, LeadCaller, LeadCalls};

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
        LedgerCode::Internal => ErrorCode::T3Error,
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

fn refused(error: LedgerError) -> LeadCallRefused {
    LeadCallRefused {
        code: error.code.as_str().to_string(),
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

/// The ledger's lead calls; `register_lead_calls(&hub.lead_calls, hub.clone())` from serve.
pub fn register_lead_calls(calls: &LeadCalls, hub: Arc<Hub>) {
    let handler: Arc<dyn LeadCallHandler> = Arc::new(LedgerLeadCalls { hub });
    for op in ["ask", "ask_withdraw", "decide", "decisions_search"] {
        calls.register(op, handler.clone());
    }
}

struct LedgerLeadCalls {
    hub: Arc<Hub>,
}

impl LedgerLeadCalls {
    /// A workstream named in a call must be one of the caller's own.
    fn own_workstream(
        &self,
        project_ref: &ProjectRef,
        workstream_id: &WorkstreamId,
    ) -> Result<WorkstreamId, LeadCallRefused> {
        match workstream_project(&self.hub, workstream_id) {
            Some(r) if &r == project_ref => Ok(workstream_id.clone()),
            _ => Err(LeadCallRefused {
                code: "not_found".into(),
                message: format!("There is no workstream {workstream_id} in your project."),
                fix: Some(
                    "Use a workstream id from the digest at the top of your last wake.".into(),
                ),
            }),
        }
    }

    /// `fleetd decide` without --workstream: the project's only open workstream, else the caller must say.
    fn decide_workstream(
        &self,
        project_ref: &ProjectRef,
        workstream_id: Option<&WorkstreamId>,
    ) -> Result<WorkstreamId, LeadCallRefused> {
        if let Some(workstream_id) = workstream_id {
            return self.own_workstream(project_ref, workstream_id);
        }
        let open = self
            .hub
            .decisions
            .workstreams()
            .map(|lookup| lookup.open_in(project_ref, 2))
            .unwrap_or_default();
        if let [only] = open.as_slice() {
            return Ok(only.clone());
        }
        Err(LeadCallRefused {
            code: "invalid".into(),
            message: if open.is_empty() {
                "Your project has no open workstream to scope this decision to.".into()
            } else {
                "Your project has several open workstreams.".into()
            },
            fix: Some("Pass --workstream W<n> from your digest, or --scope project for a project-wide decision.".into()),
        })
    }

    fn handle_now(
        &self,
        caller: LeadCaller,
        call: LeadCall,
    ) -> Result<LeadCallResult, LeadCallRefused> {
        let r = caller.project_ref.clone();
        match call {
            LeadCall::Ask(call) => {
                let workstream_id = call
                    .workstream_id
                    .as_ref()
                    .map(|w| self.own_workstream(&r, w))
                    .transpose()?;
                let outcome = self
                    .hub
                    .asks
                    .create(
                        &AskInput {
                            project_ref: Some(r),
                            workstream_id,
                            kind: call.kind.into(),
                            key: call.key,
                            class: call.class.to_string(),
                            text: call.text,
                            recommendation: call.recommendation,
                            options: call.options,
                            steps: call.steps,
                            verify: call.verify,
                            sink: call.sink,
                            env_name: call.env_name,
                            gated: None,
                            blocks: call.blocks,
                            proceeded_on_rec: call.proceeded_on_rec,
                        },
                        &caller.by,
                    )
                    .map_err(refused)?;
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
                let ask = self
                    .hub
                    .asks
                    .withdraw(&call.ask_id, call.r#use.as_ref(), Some(&r), None)
                    .map_err(refused)?;
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
                        workstream_id: self.decide_workstream(&r, call.workstream_id.as_ref())?,
                    }
                };
                let decision = self
                    .hub
                    .decisions
                    .record(
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
                            by: caller.by.clone(),
                        },
                    )
                    .map_err(refused)?;
                Ok(LeadCallResult::Decide(DecideResult {
                    decision,
                    next: None,
                }))
            }
            LeadCall::DecisionsSearch(call) => {
                let decisions = self
                    .hub
                    .decisions
                    .search(
                        &call.query,
                        &DecisionFilter {
                            chain: Some(super::Chain {
                                project_ref: r,
                                workstream_id: None,
                            }),
                            limit: Some(SEARCH_LIMIT),
                            ..Default::default()
                        },
                    )
                    .map_err(refused)?;
                Ok(LeadCallResult::DecisionsSearch(DecisionsSearchResult {
                    decisions: List::unchecked(decisions),
                    next: None,
                }))
            }
            other => Err(LeadCallRefused {
                code: "invalid".into(),
                message: format!("The ledger does not handle {other:?}."),
                fix: None,
            }),
        }
    }
}

impl LeadCallHandler for LedgerLeadCalls {
    fn handle(&self, caller: LeadCaller, call: LeadCall) -> crate::hub::link::LeadCallFuture {
        let result = self.handle_now(caller, call);
        Box::pin(async move { result })
    }
}
