//! usage_status and usage_resume. TS: their handlers in api/FleetApi.ts.
use super::source::UsageSource;
use crate::hub::api::{Caller, Hub, Registry, ToolError, readable, require, unknown_machine};
use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{UsageResumeInput, UsageStatusInput};
use serde_json::{Value, json};
use std::sync::Arc;

pub fn register(tools: &mut Registry) {
    tools.add("usage_status", usage_status);
    tools.add("usage_resume", usage_resume);
}

async fn usage_status(
    hub: Arc<Hub>,
    caller: Caller,
    input: UsageStatusInput,
) -> Result<Value, ToolError> {
    if let Some(m) = &input.machine_id {
        require(&caller, Role::Read, Some(m))?;
        if hub.store.machine_get(m)?.is_none() {
            return Err(unknown_machine(m));
        }
    }
    let machines: Vec<_> = hub
        .store
        .machines_list()?
        .into_iter()
        .filter(|m| {
            readable(&caller, &m.machine_id)
                && input.machine_id.as_ref().is_none_or(|x| *x == m.machine_id)
        })
        .collect();
    let mut statuses = Vec::new();
    for m in &machines {
        let id = m.machine_id.as_str();
        statuses.push(hub.usage.status(id, hub.ops.read(id).await).await);
    }
    let open: Vec<&str> = statuses
        .iter()
        .filter(|s| s.breaker.state == "open")
        .map(|s| s.machine_id.as_str())
        .collect();
    let next = if open.is_empty() {
        "No login is paused. fleetd never calls a usage API; probes.count must stay 0.".to_string()
    } else {
        format!(
            "Paused: {}. It lifts at the reset, or run usage_resume once the login has capacity.",
            open.join(", ")
        )
    };
    Ok(json!({ "machines": statuses, "next": next }))
}

async fn usage_resume(
    hub: Arc<Hub>,
    caller: Caller,
    input: UsageResumeInput,
) -> Result<Value, ToolError> {
    let m = &input.machine_id;
    require(&caller, Role::Operate, Some(m))?;
    if hub.store.machine_get(m)?.is_none() {
        return Err(unknown_machine(m));
    }
    let resumed = hub.usage.resume(m.as_str(), &caller.name).await;
    let status = hub
        .usage
        .status(m.as_str(), hub.ops.read(m.as_str()).await)
        .await;
    Ok(json!({
        "resumed": resumed,
        "status": status,
        "next": "Queued tasks start as slots allow. If the limit is still there, the breaker trips again on the next failures.",
    }))
}
