//! hub_update and hub_update_status.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ErrorCode, HubUpdateInput, HubUpdateOutput, HubUpdateStatusInput, UpdateRun,
};

use super::Refused;
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, admin_everywhere_fix, allows_everywhere, is_human,
};

pub fn register(tools: &mut Registry) {
    tools.add("hub_update", hub_update);
    tools.add("hub_update_status", hub_update_status);
}

fn next(run: Option<&UpdateRun>) -> String {
    match run {
        None => "The hub hasn't updated itself yet.".into(),
        Some(r) if r.finished_at.is_none() => {
            "Going on: the hub restarts while it updates, so the connection drops for a moment. Call \
             hub_update_status again to follow it."
                .into()
        }
        Some(_) => "Finished: each part says how it went.".into(),
    }
}

async fn hub_update(
    hub: Arc<Hub>,
    caller: Caller,
    input: HubUpdateInput,
) -> Result<HubUpdateOutput, ToolError> {
    // It restarts the hub and every node, so Admin on one machine is not enough; and a person decides it.
    if !allows_everywhere(&caller, Role::Admin) || !is_human(&caller) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Updating fleetd restarts the hub and every node: it needs a person's key with Admin on every machine.",
        )
        .with_fix(admin_everywhere_fix(&caller)));
    }
    let run = hub
        .updates
        .start(input.channel)
        .map_err(|Refused::NotWired| {
            ToolError::new(
                ErrorCode::Failed,
                "The hub's update isn't ready yet; try again in a moment.",
            )
        })?;
    Ok(HubUpdateOutput {
        next: Some(next(Some(&run))),
        run: Some(run),
        truncated: None,
    })
}

async fn hub_update_status(
    hub: Arc<Hub>,
    _caller: Caller,
    _input: HubUpdateStatusInput,
) -> Result<HubUpdateOutput, ToolError> {
    let run = hub.updates.status();
    Ok(HubUpdateOutput {
        next: Some(next(run.as_ref())),
        run,
        truncated: None,
    })
}
