//! retro_proposals and retro_run. TS: their handlers in api/FleetApi.ts.
use super::service::{APPLY_KEY, RunInput};
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows_everywhere, cap, readable};
use crate::hub::usage::wire::convert;
use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::mcp::{ErrorCode, RetroProposalsInput, RetroRunInput};
use serde_json::{Value, json};
use std::sync::Arc;

pub fn register(tools: &mut Registry) {
    tools.add("retro_proposals", retro_proposals);
    tools.add("retro_run", retro_run);
}

async fn retro_proposals(
    hub: Arc<Hub>,
    caller: Caller,
    input: RetroProposalsInput,
) -> Result<Value, ToolError> {
    let state: Option<String> = input.state.as_ref().and_then(convert);
    // A proposal cites incidents; a key sees it only when it may read every machine they came from.
    let listed: Vec<Value> = hub
        .retro
        .proposals(state.as_deref(), 1000)
        .into_iter()
        .filter(|p| {
            p.machines
                .iter()
                .all(|m| convert::<_, MachineId>(m).is_some_and(|m| readable(&caller, &m)))
        })
        .map(|p| json!(p.proposal))
        .collect();
    let shown = cap(listed, input.limit.get() as usize);
    let apply = hub.retro.apply_enabled().await;
    let mut out = json!({
        "proposals": shown.items,
        "apply": apply,
        "next": if apply {
            "Wording changes apply on their own and revert when their metric does not improve; gate changes come to you as asks each Monday.".to_string()
        } else {
            format!("Advise-only: nothing applies until the global decision {APPLY_KEY} = true (decisions_record).")
        },
    });
    if let Some(run) = hub.retro.last_run() {
        out["lastRun"] = json!(run);
    }
    if shown.truncated == Some(true) {
        out["truncated"] = json!(true);
    }
    Ok(out)
}

async fn retro_run(
    hub: Arc<Hub>,
    caller: Caller,
    input: RetroRunInput,
) -> Result<Value, ToolError> {
    if !allows_everywhere(&caller, Role::Admin) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "A retro reads every project's incidents and changes hub-wide playbooks; this key is not admin on every machine.",
        )
        .with_fix("Use a key from fleetd hub key create --role admin --machines '*'."));
    }
    let window_days = input.window_days.get() as u32;
    let (run, proposals) = hub
        .retro
        .run(RunInput {
            window_days,
            advise: input.advise == Some(true),
            trigger: "manual",
            threshold_class: None,
        })
        .await
        .map_err(|r| ToolError::new(ErrorCode::Invalid, r.message).with_fix(r.fix))?;
    let next = if run.usage.is_none() {
        format!("No incidents in the last {window_days} days, so no claude turn ran.")
    } else if run.advise {
        "Suggested only; retro_proposals lists them and the digest shows them.".to_string()
    } else {
        "Wording changes are applied and measured; gate changes wait for Monday's asks. retro_proposals tracks them.".to_string()
    };
    Ok(json!({ "run": run, "proposals": proposals, "next": next }))
}
