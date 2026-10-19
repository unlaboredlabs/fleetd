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

/// Past this much agent time an item is too big to move the figure steadily.
const MAX_AGENT_MS: i64 = 60 * 60_000;

/// Agent time is the writing stretch: task started to its PR, at the median measured for the item's size.
fn agent_ms(
    cal: &crate::hub::status::model::Calibration,
    pkey: &str,
    size: fleetd_contracts::plan::Size,
) -> i64 {
    use fleetd_contracts::plan::ItemStage;
    let r = cal.resolve(pkey, crate::hub::status::model::UnitKind::Item, size);
    r.durations.p50[ItemStage::TaskStarted.index()..ItemStage::PrOpen.index()]
        .iter()
        .sum()
}

/// The granularity warning, worded by the `plan.granularity` prompt: no size, or likely over an hour of agent time.
fn granularity(
    hub: &Hub,
    r: &fleetd_contracts::ids::ProjectRef,
    item: &fleetd_contracts::plan::PlanItem,
    unsized_item: bool,
) -> Option<String> {
    let pkey = super::store::pkey(r);
    let agent = agent_ms(&hub.status.calibration(), &pkey, item.size);
    let reason = if unsized_item {
        "has no size (counted as m)".to_owned()
    } else if agent > MAX_AGENT_MS {
        let size = serde_json::to_value(item.size)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        format!(
            "is size {size}, about {} of agent time here",
            crate::hub::status::risks::age(agent)
        )
    } else {
        return None;
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
    use super::*;
    use crate::hub::status::model::Calibration;
    use fleetd_contracts::plan::Size;

    #[test]
    fn items_over_an_hour_of_agent_time_warn() {
        let cal = Calibration::default();
        assert!(
            agent_ms(&cal, "p", Size::M) <= MAX_AGENT_MS,
            "m fits an hour by default"
        );
        assert!(agent_ms(&cal, "p", Size::L) > MAX_AGENT_MS, "l is over it");
        let text = crate::hub::prompts::PromptSet::defaults().render(
            "plan.granularity",
            &[("item", &"P4"), ("reason", &"has no size (counted as m)")],
        );
        assert!(text.starts_with("P4 has no size (counted as m). Plan items of about an hour"));
        assert!(text.contains("fleetd plan edit P4 --size"));
    }
}
