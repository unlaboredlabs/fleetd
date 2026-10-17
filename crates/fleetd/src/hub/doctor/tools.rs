//! doctor_list and doctor_fix. TS: their handlers in api/FleetApi.ts.
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, is_human, readable, require};
use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::mcp::{DoctorFixInput, DoctorListInput, ErrorCode};
use serde_json::{Value, json};
use std::sync::Arc;

pub fn register(tools: &mut Registry) {
    tools.add("doctor_list", doctor_list);
    tools.add("doctor_fix", doctor_fix);
}

async fn doctor_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: DoctorListInput,
) -> Result<Value, ToolError> {
    if let Some(m) = &input.machine_id {
        require(&caller, Role::Read, Some(m))?;
    }
    let results = hub.doctor.list(input.rerun == Some(true)).await;
    let wanted = input.machine_id.as_ref().map(|m| m.as_str().to_string());
    let checks: Vec<_> = results
        .checks
        .into_iter()
        .filter(|c| match &c.machine_id {
            None => wanted.is_none(),
            Some(id) => {
                crate::hub::usage::wire::convert::<_, MachineId>(id)
                    .is_some_and(|m| readable(&caller, &m))
                    && wanted.as_ref().is_none_or(|w| w == id)
            }
        })
        .collect();
    let failing: Vec<_> = checks
        .iter()
        .filter(|c| matches!(c.status.as_str(), "fail" | "warn"))
        .collect();
    let next = if failing
        .iter()
        .any(|c| c.fix.as_ref().is_some_and(|f| f.kind == "auto"))
    {
        "Run doctor_fix with a checkId to apply its automatic fix; manual fixes name the command to run."
    } else if !failing.is_empty() {
        "Each failing check names the command that fixes it."
    } else {
        "Every check passes. rerun: true runs them now; the hub also runs them every 15 minutes and emits doctor.changed."
    };
    Ok(json!({ "checks": checks, "checkedAt": results.checked_at, "next": next }))
}

async fn doctor_fix(
    hub: Arc<Hub>,
    caller: Caller,
    input: DoctorFixInput,
) -> Result<Value, ToolError> {
    let check_id = input.check_id.as_str().to_string();
    let scope = &check_id[..check_id.find('/').unwrap_or(0)];
    let machine: Option<MachineId> = if scope == "hub" {
        None
    } else {
        crate::hub::usage::wire::convert(&scope)
    };
    // The fixes are safe but act on machines: admin keys, or a person's own device (a human key).
    if !allows(&caller, Role::Admin, machine.as_ref())
        && !(is_human(&caller) && allows(&caller, Role::Operate, machine.as_ref()))
    {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "doctor_fix needs an admin key, or a person's device (a human key) with operate on the machine.",
        )
        .with_fix("Run it from the desktop app, or with a key from fleetd hub key create --role admin."));
    }
    let (ran, check) = hub.doctor.fix(&check_id).await.map_err(|r| {
        let e = ToolError::new(ErrorCode::Invalid, r.message);
        match r.fix {
            Some(f) => e.with_fix(f),
            None => e,
        }
    })?;
    let next = if check.status.as_str() == "ok" {
        "Fixed: the check passes now.".to_string()
    } else {
        format!("Still {}: {}", check.status.as_str(), check.message)
    };
    Ok(json!({ "ran": ran, "check": check, "next": next }))
}
