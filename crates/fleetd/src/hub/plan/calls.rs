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

/// `--steer S12`: refused unless S12 is a delivered steer of this project; it stands in for a missing `--why`.
fn steered(
    hub: &Hub,
    r: &fleetd_contracts::ids::ProjectRef,
    steer: Option<&fleetd_contracts::steer::SteerId>,
    why: &mut Option<fleetd_contracts::plan::PlanWhy>,
) -> Result<Option<fleetd_contracts::steer::Steer>, super::PlanError> {
    let Some(id) = steer else {
        return Ok(None);
    };
    let steer = crate::hub::steer::for_plan_call(hub, r, id)?;
    if why.is_none() {
        *why = Some(fleetd_contracts::prim::Line::unchecked(super::clip(
            &format!("{id}: {}", steer.text.as_str()),
            120,
        )));
    }
    Ok(Some(steer))
}

/// The change carried out the steer: its marker names it, and the steer counts as acknowledged.
fn acknowledge(
    hub: &Hub,
    r: &fleetd_contracts::ids::ProjectRef,
    steer: Option<fleetd_contracts::steer::Steer>,
    out: fleetd_contracts::plan::PlanItemResult,
) -> fleetd_contracts::plan::PlanItemResult {
    if let Some(steer) = steer {
        crate::hub::steer::acknowledged_by_plan(hub, r, steer, &out);
    }
    out
}

/// The granularity warning, worded by the `plan.granularity` prompt: an item with no size, or bigger than m.
fn granularity(
    hub: &Hub,
    r: &fleetd_contracts::ids::ProjectRef,
    item: &fleetd_contracts::plan::PlanItem,
    unsized_item: bool,
) -> Option<String> {
    let reason = match (unsized_item, item.size) {
        (true, _) => "has no size (counted as m)",
        (false, fleetd_contracts::plan::Size::L) => "is size l",
        _ => return None,
    };
    Some(hub.db.prompts().for_lead(r).render(
        "plan.granularity",
        &[("item", &item.item_id), ("reason", &reason)],
    ))
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
        LeadCall::PlanAdd(mut c) => {
            let steer = steered(hub, r, c.steer.as_ref(), &mut c.why)?;
            let unsized_item = c.size.is_none();
            let mut out = plans.add(r, by, c)?;
            out.warning = granularity(hub, r, &out.item, unsized_item);
            LeadCallResult::PlanAdd(acknowledge(hub, r, steer, out))
        }
        LeadCall::PlanEdit(mut c) => {
            let steer = steered(hub, r, c.steer.as_ref(), &mut c.why)?;
            let resized = c.size.is_some();
            let mut out = plans.edit(r, by, c)?;
            if resized {
                out.warning = granularity(hub, r, &out.item, false);
            }
            LeadCallResult::PlanEdit(acknowledge(hub, r, steer, out))
        }
        LeadCall::PlanDrop(mut c) => {
            let steer = steered(hub, r, c.steer.as_ref(), &mut c.why)?;
            if c.why.is_none() {
                return Err(
                    McpToolError::new(ErrorCode::Invalid, "Say why the item goes.")
                        .with_fix(
                            "Add --why \"<reason>\", or --steer S<n> when a steer asked for it.",
                        )
                        .into(),
                );
            }
            let out = plans.drop_item(r, by, c)?;
            LeadCallResult::PlanDrop(acknowledge(hub, r, steer, out))
        }
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

#[cfg(test)]
mod tests {
    #[test]
    fn the_granularity_warning_asks_to_split_anything_bigger_than_m() {
        let text = crate::hub::prompts::PromptSet::defaults().render(
            "plan.granularity",
            &[("item", &"P4"), ("reason", &"has no size (counted as m)")],
        );
        assert!(text.starts_with("P4 has no size (counted as m). Split anything bigger than m"));
        assert!(text.contains("fleetd plan edit P4 --size"));
        assert!(!text.contains("hour"), "sizes, never hours");
    }
}
