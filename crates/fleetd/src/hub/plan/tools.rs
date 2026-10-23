//! plan_get: a project's plan, or one order's items, with derived state, figures and markers.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{ErrorCode, PlanGetInput, PlanGetOutput};

use crate::hub::api::{Caller, Hub, Registry, ToolError, require};

pub fn register(tools: &mut Registry) {
    tools.add("plan_get", plan_get);
}

async fn plan_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: PlanGetInput,
) -> Result<PlanGetOutput, ToolError> {
    let (project_ref, ws) = match (input.project_ref, input.workstream_id) {
        (Some(r), _) => (r, None),
        (None, Some(ws)) => {
            let order = hub
                .db
                .with(|c| Ok(super::order_info(c, ws.as_str())?))?
                .ok_or_else(|| {
                    ToolError::new(ErrorCode::NotFound, format!("There is no order {ws}."))
                        .with_fix("orders_board lists them.")
                })?;
            (super::store::project_ref(&order.pkey), Some(ws))
        }
        (None, None) => {
            return Err(ToolError::new(
                ErrorCode::Invalid,
                "give projectRef or workstreamId",
            ));
        }
    };
    require(&caller, Role::Read, Some(&project_ref.machine_id))?;
    let plan = hub.plans.view(&project_ref, ws.as_ref()).map_err(|e| e.0)?;
    Ok(PlanGetOutput {
        plan,
        next: None,
        truncated: None,
    })
}
