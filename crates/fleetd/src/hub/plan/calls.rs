//! The lead's `plan`, scoped to the caller's project by cwd.
use std::sync::{Arc, Weak};

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::plan::{PlanCall, PlanCover, PlanCoveredBy, PlanItemId, PlanResult};

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
        covered,
    }) = call
    else {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!("{} is not a plan call.", op_of(&call)),
        )
        .into());
    };
    // Every landing is looked up before anything is written, and `covered` and `items` are written in one
    // transaction, so a refusal of either writes nothing.
    let covers = match &covered {
        Some(covered) => covers_of(hub, r, covered)?,
        None => Vec::new(),
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
        let changes = hub.plans.apply(
            r,
            caller.by.as_str(),
            Some((ws, &items)),
            why.as_deref(),
            &covers,
        )?;
        if let Some(steer) = steer {
            crate::hub::steer::acknowledged_by_plan(hub, r, steer, &changes);
        }
    } else if !covers.is_empty() {
        hub.plans.cover(r, &covers)?;
    }
    let plan = hub.plans.view(r, workstream_id.as_ref())?;
    let text = super::plan_text(&plan);
    Ok(LeadCallResult::Plan(PlanResult {
        plan,
        text,
        next: Some(
            "link work with item P<n> on `spawn_agent`; fleetd marks it done when its PR merges through the train. \
             Work Elsewhere shows already landed: mark its items `covered` by that commit, don't rebuild it."
                .into(),
        ),
    }))
}

/// Each `covered` entry with the landing it names, found among the landings on the project's repo and base.
fn covers_of(
    hub: &Hub,
    r: &ProjectRef,
    covered: &[PlanCover],
) -> Result<Vec<(PlanItemId, PlanCoveredBy, String)>, super::PlanError> {
    let failed = |e: crate::hub::store::StoreError| super::failed(e);
    let Some(scope) = hub.work.scope_of(r).map_err(failed)? else {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            "fleetd doesn't know yet which repo and branch this project's work lands on, so it has seen no landings.",
        )
        .with_fix("Leave out covered; link the item's work on `spawn_agent` instead.")
        .into());
    };
    let mut out: Vec<(PlanItemId, PlanCoveredBy, String)> = Vec::new();
    for cover in covered {
        if out.iter().any(|(item, ..)| *item == cover.item) {
            return Err(McpToolError::new(
                ErrorCode::Invalid,
                format!("{} is listed twice in covered.", cover.item),
            )
            .with_fix("List each item once.")
            .into());
        }
        let Some(landed) = hub
            .work
            .landing(&scope, cover.landing.as_str())
            .map_err(failed)?
        else {
            return Err(McpToolError::new(
                ErrorCode::NotFound,
                format!(
                    "{} is not one commit fleetd saw land on {} of {}.",
                    cover.landing, scope.base, scope.repo_key
                ),
            )
            .with_fix("Use a commit from Elsewhere in your digest, with enough of its sha to name one commit.")
            .into());
        };
        let evidence = crate::hub::work::elsewhere::evidence(&landed, scope.base.as_str());
        let covered_by = PlanCoveredBy {
            sha: landed.sha,
            route: landed.route,
        };
        out.push((cover.item.clone(), covered_by, evidence));
    }
    Ok(out)
}
