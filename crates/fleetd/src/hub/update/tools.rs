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

fn next(run: Option<&UpdateRun>, left_over: bool) -> String {
    match run {
        None => "The hub hasn't updated itself yet.".into(),
        Some(r) if r.finished_at.is_none() && left_over => {
            "Left over: nothing in the hub drives this update any more, so it won't change again. Call hub_update to \
             start a new one."
                .into()
        }
        Some(r) if r.finished_at.is_none() => {
            "Going on: the hub restarts while it updates, so the connection drops for a moment. Call \
             hub_update_status again to follow it."
                .into()
        }
        Some(_) => "Finished: each part says how it went.".into(),
    }
}

fn ready(hub: &Hub) -> Option<fleetd_contracts::prim::Text<1, 200>> {
    hub.updates
        .ready()
        .map(|v| crate::node::wire::head_text(&v))
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
    let started = match &input.machine {
        Some(machine) => hub.updates.retry(machine),
        None if input.start_over == Some(true) => hub.updates.start_over(input.channel),
        None => hub.updates.start(input.channel),
    };
    let run = started.map_err(|refused| match refused {
        Refused::NotWired => ToolError::new(
            ErrorCode::Failed,
            "The hub's update isn't ready yet; try again in a moment.",
        ),
        Refused::NothingToRetry => ToolError::new(
            ErrorCode::Failed,
            "There is nothing to retry: the last update didn't update the hub, or didn't have that machine.",
        )
        .with_fix("Press Update to update everything."),
        Refused::HubMovedOn(running) => ToolError::new(
            ErrorCode::Failed,
            format!(
                "The hub runs {} now, not the build that update went to, so retrying it would put this machine behind the hub.",
                crate::version_label(&running)
            ),
        )
        .with_fix("Press Update to bring every machine to the hub's build."),
    })?;
    let left_over = hub.updates.left_over();
    Ok(HubUpdateOutput {
        next: Some(next(Some(&run), left_over)),
        run: Some(run),
        ready: ready(&hub),
        left_over: left_over.then_some(true),
        truncated: None,
    })
}

async fn hub_update_status(
    hub: Arc<Hub>,
    _caller: Caller,
    _input: HubUpdateStatusInput,
) -> Result<HubUpdateOutput, ToolError> {
    let run = hub.updates.status();
    let left_over = hub.updates.left_over();
    Ok(HubUpdateOutput {
        next: Some(next(run.as_ref(), left_over)),
        run,
        ready: ready(&hub),
        left_over: left_over.then_some(true),
        truncated: None,
    })
}
