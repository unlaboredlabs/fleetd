//! secret_submit (MCP); the `gated_run` lead call registers once the link area has landed. TS: api/FleetApi.ts and leads/LeadCallHandler.ts.
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
    hub.approvals
        .submit_secret(&who, input.ask_id.as_str(), input.sealed.as_str())
        .await
        .map_err(refusal)
}
