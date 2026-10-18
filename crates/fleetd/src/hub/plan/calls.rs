//! The lead's `fleetd plan milestone|add|edit|drop|show`, scoped to the caller's project by cwd.
use std::sync::{Arc, Weak};

use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::plan::{PlanMilestoneResult, PlanShowResult};

use crate::hub::api::Hub;
use crate::hub::link::lead_calls::{LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};

pub const OPS: [&str; 5] = [
    "plan_milestone",
    "plan_add",
    "plan_edit",
    "plan_drop",
    "plan_show",
];

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
    let (r, by) = (&caller.project_ref, caller.by.as_str());
    let plans = &hub.plans;
    Ok(match call {
        LeadCall::PlanMilestone(c) => {
            let milestone = plans.milestone(r, c)?;
            let next = format!(
                "add items with `fleetd plan add \"<title>\" --milestone {}`.",
                milestone.milestone_id
            );
            LeadCallResult::PlanMilestone(PlanMilestoneResult {
                milestone,
                next: Some(next),
            })
        }
        LeadCall::PlanAdd(c) => LeadCallResult::PlanAdd(plans.add(r, by, c)?),
        LeadCall::PlanEdit(c) => LeadCallResult::PlanEdit(plans.edit(r, by, c)?),
        LeadCall::PlanDrop(c) => LeadCallResult::PlanDrop(plans.drop_item(r, by, c)?),
        LeadCall::PlanShow(c) => {
            let plan = hub.status.plan_view(hub, r, c.workstream_id.as_ref())?;
            let text = super::plan_text(&plan);
            LeadCallResult::PlanShow(PlanShowResult {
                plan,
                text,
                next: None,
            })
        }
        other => {
            return Err(McpToolError::new(
                ErrorCode::Invalid,
                format!("{} is not a plan call.", op_of(&other)),
            )
            .into());
        }
    })
}
