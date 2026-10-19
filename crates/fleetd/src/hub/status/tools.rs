//! status_get, status_wait and status_seen.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ErrorCode, StatusGetInput, StatusGetOutput, StatusSeenInput, StatusSeenOutput, StatusWaitInput,
    StatusWaitOutput,
};
use fleetd_contracts::prim::Count;
use fleetd_contracts::status::StatusScope;

use crate::hub::api::{Caller, Hub, Registry, ToolError, require};

pub fn register(tools: &mut Registry) {
    tools.add("status_get", status_get);
    tools.add("status_wait", status_wait);
    tools.add("status_seen", status_seen);
}

/// A project or order scope needs read on its machine; the fleet is filtered to what the key reads.
fn may_read(hub: &Hub, caller: &Caller, scope: &StatusScope) -> Result<(), ToolError> {
    let machine = match scope {
        StatusScope::Fleet => return Ok(()),
        StatusScope::Project { project_ref } => project_ref.machine_id.clone(),
        StatusScope::Order { workstream_id } => {
            let order = hub
                .db
                .with(|c| Ok(crate::hub::plan::order_info(c, workstream_id.as_str())?))?;
            let Some(order) = order else {
                return Err(ToolError::new(
                    ErrorCode::NotFound,
                    format!("There is no order {workstream_id}."),
                )
                .with_fix("orders_board lists them."));
            };
            crate::hub::plan::store::project_ref(&order.pkey).machine_id
        }
    };
    require(caller, Role::Read, Some(&machine))
}

pub(super) fn not_found(hub: &Hub, scope: &StatusScope) -> ToolError {
    if let StatusScope::Order { workstream_id } = scope
        && let Ok(Some(order)) = hub
            .db
            .with(|c| Ok(crate::hub::plan::order_info(c, workstream_id.as_str())?))
        && order.state == fleetd_contracts::ledger::WorkstreamState::Draft
    {
        return ToolError::new(
            ErrorCode::NotFound,
            format!("{workstream_id} is a draft: waiting for the lead's brief."),
        )
        .with_fix("status_wait on it returns its doc once the brief exists.");
    }
    ToolError::new(
        ErrorCode::NotFound,
        format!("Nothing to show for {}.", scope.key()),
    )
    .with_fix("projects_list and orders_board list the scopes there are.")
}

async fn status_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: StatusGetInput,
) -> Result<StatusGetOutput, ToolError> {
    may_read(&hub, &caller, &input.scope)?;
    let since = input.since_seq.map(|s| s.get());
    let doc = hub
        .status
        .get(&hub, &caller, &input.scope, since)
        .ok_or_else(|| not_found(&hub, &input.scope))?;
    Ok(StatusGetOutput {
        doc,
        next: Some("status_wait with after = this version".into()),
        truncated: None,
    })
}

async fn status_wait(
    hub: Arc<Hub>,
    caller: Caller,
    input: StatusWaitInput,
) -> Result<StatusWaitOutput, ToolError> {
    may_read(&hub, &caller, &input.scope)?;
    let since = input.since_seq.map(|s| s.get());
    let after = input.after.map(|a| a.get());
    let (doc, version) = hub
        .status
        .wait(
            &hub,
            &caller,
            &input.scope,
            since,
            after,
            input.timeout_sec.get() as u64,
        )
        .await;
    let unchanged = doc.is_none().then_some(true);
    Ok(StatusWaitOutput {
        doc,
        unchanged,
        version: Count::unchecked(version),
        next: None,
        truncated: None,
    })
}

async fn status_seen(
    hub: Arc<Hub>,
    caller: Caller,
    input: StatusSeenInput,
) -> Result<StatusSeenOutput, ToolError> {
    may_read(&hub, &caller, &input.scope)?;
    let recorded = hub
        .status
        .seen(&hub, &caller, &input.scope, input.seq.get());
    Ok(StatusSeenOutput {
        recorded,
        next: None,
        truncated: None,
    })
}
