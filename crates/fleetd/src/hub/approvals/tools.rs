//! secret_submit (MCP) and the `gated_run` lead call.
use super::{ApprovalRefused, Caller as ApprovalCaller};
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, is_human};
use crate::hub::usage::wire::convert;
use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::mcp::{ErrorCode, SecretSubmitInput};
use serde_json::Value;
use std::sync::Arc;

pub fn register(tools: &mut Registry) {
    tools.add("secret_submit", secret_submit);
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
    let grants = caller.clone();
    let allows_operate = move |m: &str| {
        convert::<_, MachineId>(&m).is_some_and(|m| allows(&grants, Role::Operate, Some(&m)))
    };
    let who = ApprovalCaller {
        human: is_human(&caller),
        name: &caller.name,
        allows_operate: &allows_operate,
    };
    let Some(ask_id) = &input.ask_id else {
        return Err(
            ToolError::new(ErrorCode::NotFound, "This hub has no chat requests yet.")
                .with_fix("Answer the secret ask by its askId."),
        );
    };
    hub.approvals
        .submit_secret(&who, ask_id.as_str(), input.sealed.as_str())
        .await
        .map_err(refusal)
}

/// The `gated_run` lead call: files the approve ask holding exactly the lead's command. A
/// workstream named in the call must be one of the caller's own (`ownWorkstream`), checked before this runs.
pub async fn gated_run_call(
    hub: &Hub,
    project: &fleetd_contracts::ids::ProjectRef,
    by: &str,
    call: fleetd_contracts::lead_calls::GatedRunCall,
) -> Result<fleetd_contracts::lead_calls::GatedRunResult, ToolError> {
    let input = super::GatedRunInput {
        argv: convert(&call.argv).unwrap_or_default(),
        cwd: call.cwd.as_ref().and_then(convert),
        class: convert(&call.class).unwrap_or_default(),
        reason: convert(&call.reason).unwrap_or_default(),
        secret_env: call.secret_env.as_ref().and_then(convert),
        timeout_sec: convert(&call.timeout_sec).unwrap_or(1800),
        workstream_id: call.workstream_id.as_ref().and_then(convert),
    };
    let project = convert(project).expect("a project ref reads back");
    let result = hub
        .approvals
        .gated_run(&project, by, input)
        .await
        .map_err(refusal)?;
    serde_json::from_value(result).map_err(|e| {
        tracing::error!(%e, "gated_run result did not decode");
        crate::hub::api::internal_error()
    })
}

/// Registers `gated_run` in the node link's lead calls, checking a named workstream belongs to the caller's project.
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
                let LeadCall::GatedRun(call) = call else {
                    return Err(ToolError::new(
                        ErrorCode::Invalid,
                        format!(
                            "{} is not a gated run call.",
                            crate::hub::link::lead_calls::op_of(&call)
                        ),
                    ));
                };
                if let Some(w) = &call.workstream_id
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
                gated_run_call(&hub, &caller.project_ref, &caller.by, call)
                    .await
                    .map(LeadCallResult::GatedRun)
            })
        },
    );
    hub.lead_calls.register("gated_run", handler);
}
