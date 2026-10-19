//! The person's tools on requests (secret_submit, approval_answer, requests_list) and the lead's calls that open and
//! withdraw them (`request_secret`, `gated_run`, `request_withdraw`).
use super::store::RequestFilter;
use super::{ApprovalRefused, Caller as ApprovalCaller};
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, is_human};
use crate::hub::usage::wire::convert;
use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::ledger::HumanRequest;
use fleetd_contracts::lead_calls::RequestResult;
use fleetd_contracts::mcp::{
    ApprovalAnswerInput, ErrorCode, RequestsListInput, SecretSubmitInput,
};
use serde_json::{Value, json};
use std::sync::Arc;

pub fn register(tools: &mut Registry) {
    tools.add("secret_submit", secret_submit);
    tools.add("approval_answer", approval_answer);
    tools.add("requests_list", requests_list);
}

fn grants_of(caller: &Caller) -> impl Fn(&str) -> bool + Sync + use<> {
    let grants = caller.clone();
    move |m: &str| {
        convert::<_, MachineId>(&m).is_some_and(|m| allows(&grants, Role::Operate, Some(&m)))
    }
}

pub fn refusal(r: ApprovalRefused) -> ToolError {
    let code: ErrorCode = convert(&r.code).unwrap_or(ErrorCode::Invalid);
    let e = ToolError::new(code, r.message);
    match r.fix {
        Some(f) => e.with_fix(f),
        None => e,
    }
}

async fn secret_submit(
    hub: Arc<Hub>,
    caller: Caller,
    input: SecretSubmitInput,
) -> Result<Value, ToolError> {
    let allows_operate = grants_of(&caller);
    let who = ApprovalCaller {
        human: is_human(&caller),
        name: &caller.name,
        allows_operate: &allows_operate,
    };
    hub.approvals
        .submit_secret(&who, input.request_id.as_str(), input.sealed.as_str())
        .await
        .map_err(refusal)
}

async fn approval_answer(
    hub: Arc<Hub>,
    caller: Caller,
    input: ApprovalAnswerInput,
) -> Result<Value, ToolError> {
    let allows_operate = grants_of(&caller);
    let who = ApprovalCaller {
        human: is_human(&caller),
        name: &caller.name,
        allows_operate: &allows_operate,
    };
    let approve = input.decision == fleetd_contracts::chat::ApprovalDecision::Approve;
    let request = hub
        .approvals
        .answer(
            &who,
            input.request_id.as_str(),
            approve,
            input.message.as_ref().map(|m| m.to_string()),
        )
        .await
        .map_err(refusal)?;
    Ok(json!({ "request": request }))
}

async fn requests_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: RequestsListInput,
) -> Result<Value, ToolError> {
    if let Some(r) = &input.project_ref {
        crate::hub::api::require(&caller, Role::Read, Some(&r.machine_id))?;
    }
    let listed = hub
        .approvals
        .list(&RequestFilter {
            project_ref: input.project_ref.clone(),
            states: input.state.map(|s| vec![s]),
            kind: None,
            limit: input.limit.get(),
        })
        .map_err(refusal)?;
    let visible: Vec<HumanRequest> = listed
        .into_iter()
        .filter(|r| allows(&caller, Role::Read, Some(&r.project_ref.machine_id)))
        .collect();
    Ok(json!({ "requests": visible }))
}

fn result_of(r: &HumanRequest, next: &str) -> RequestResult {
    RequestResult {
        request_id: r.request_id.clone(),
        state: r.state,
        next: Some(next.into()),
    }
}

fn local(project: &fleetd_contracts::ids::ProjectRef) -> crate::hub::usage::ports::ProjectRef {
    convert(project).expect("a project ref reads back")
}

/// The `gated_run` lead call: opens the approval holding exactly the lead's command.
pub async fn gated_run_call(
    hub: &Hub,
    project: &fleetd_contracts::ids::ProjectRef,
    call: fleetd_contracts::lead_calls::GatedRunCall,
) -> Result<RequestResult, ToolError> {
    let input = super::GatedRunInput {
        argv: convert(&call.argv).unwrap_or_default(),
        cwd: call.cwd.as_ref().and_then(convert),
        class: convert(&call.class).unwrap_or_default(),
        reason: convert(&call.reason).unwrap_or_default(),
        secret_env: call.secret_env.as_ref().and_then(convert),
        timeout_sec: convert(&call.timeout_sec).unwrap_or(1800),
        workstream_id: call.workstream_id.as_ref().and_then(convert),
    };
    let r = hub
        .approvals
        .gated_run(&local(project), input)
        .await
        .map_err(refusal)?;
    Ok(result_of(
        &r,
        "carry on with other work: the person approves or denies it in chat, and the exit code and output tail arrive in a wake.",
    ))
}

/// Registers `gated_run`, `request_secret` and `request_withdraw` in the node link's lead calls, checking a named
/// workstream belongs to the caller's project.
pub fn register_lead_calls(hub: &Arc<Hub>) {
    use crate::hub::link::LeadCaller;
    use crate::hub::link::lead_calls::LeadCallFuture;
    use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
    let weak = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    ToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                let workstream = match &call {
                    LeadCall::GatedRun(c) => c.workstream_id.clone(),
                    LeadCall::RequestSecret(c) => c.workstream_id.clone(),
                    _ => None,
                };
                if let Some(w) = &workstream
                    && hub.leads.records.project_of(w).as_ref() != Some(&caller.project_ref)
                {
                    return Err(ToolError::new(
                        ErrorCode::NotFound,
                        format!("There is no workstream {w} in your project."),
                    )
                    .with_fix(
                        "Use a workstream id from the digest at the top of your last wake.",
                    ));
                }
                match call {
                    LeadCall::GatedRun(call) => gated_run_call(&hub, &caller.project_ref, call)
                        .await
                        .map(LeadCallResult::GatedRun),
                    LeadCall::RequestSecret(call) => {
                        let r = hub
                            .approvals
                            .request_secret(&local(&caller.project_ref), call)
                            .await
                            .map_err(refusal)?;
                        Ok(LeadCallResult::RequestSecret(result_of(
                            &r,
                            "carry on: the person enters it in chat, and only its fingerprint arrives in a wake.",
                        )))
                    }
                    LeadCall::RequestWithdraw(call) => {
                        let r = hub
                            .approvals
                            .withdraw(&local(&caller.project_ref), &caller.by, call.request_id.as_str())
                            .await
                            .map_err(refusal)?;
                        Ok(LeadCallResult::RequestWithdraw(result_of(&r, "withdrawn.")))
                    }
                    other => Err(ToolError::new(
                        ErrorCode::Invalid,
                        format!(
                            "{} is not a request call.",
                            crate::hub::link::lead_calls::op_of(&other)
                        ),
                    )),
                }
            })
        },
    );
    for op in ["gated_run", "request_secret", "request_withdraw"] {
        hub.lead_calls.register(op, handler.clone());
    }
}
