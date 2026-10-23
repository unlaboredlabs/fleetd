//! The lead's `plan`, scoped to the caller's project by cwd.
use std::sync::{Arc, Weak};

use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::plan::{PlanCall, PlanResult};

use crate::hub::api::Hub;
use crate::hub::link::lead_calls::{LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};

pub const OPS: [&str; 1] = ["plan"];

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                answer(&hub, &caller, call).map_err(|e| e.0)
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

fn answer(
    hub: &Hub,
    caller: &LeadCaller,
    call: LeadCall,
) -> Result<LeadCallResult, super::PlanError> {
    let r = &caller.project_ref;
    let LeadCall::Plan(PlanCall {
        workstream_id,
        items,
        why,
        steer,
    }) = call
    else {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!("{} is not a plan call.", op_of(&call)),
        )
        .into());
    };
    if let Some(items) = items {
        let Some(ws) = &workstream_id else {
            return Err(
                McpToolError::new(ErrorCode::Invalid, "Say whose items these are.")
                    .with_fix("Add workstreamId.")
                    .into(),
            );
        };
        let steer = match &steer {
            Some(id) => Some(crate::hub::steer::for_plan_call(hub, r, id)?),
            None => None,
        };
        let why = why.as_ref().map(|w| w.to_string()).or_else(|| {
            steer
                .as_ref()
                .map(|s| super::clip(&format!("{}: {}", s.id, s.text.as_str()), 120))
        });
        let changes = hub
            .plans
            .set(r, caller.by.as_str(), ws, &items, why.as_deref())?;
        if let Some(steer) = steer {
            crate::hub::steer::acknowledged_by_plan(hub, r, steer, &changes);
        }
    }
    let plan = hub.plans.view(r, workstream_id.as_ref())?;
    let text = super::plan_text(&plan);
    Ok(LeadCallResult::Plan(PlanResult {
        plan,
        text,
        next: Some(
            "link work with item P<n> on `spawn_agent`; fleetd marks it done when its PR merges through the train."
                .into(),
        ),
    }))
}
