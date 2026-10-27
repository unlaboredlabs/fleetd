//! The lead's `checklist`, scoped to the caller's project by its session. A task can't make it (`tasks::policy`).
use std::sync::{Arc, Weak};

use fleetd_contracts::checklist::{ChecklistChangedData, ChecklistResult};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::prim::{Count, List};

use super::Checklist;
use crate::hub::api::Hub;
use crate::hub::link::lead_calls::{LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};
use crate::hub::store::{NewEvent, StoreError, iso_ms, now_ms};

pub const OPS: [&str; 1] = ["checklist"];

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                answer(&hub, &caller, call)
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

fn failed(e: StoreError) -> McpToolError {
    tracing::error!(error = %e, "checklist store");
    McpToolError::new(ErrorCode::Failed, "The hub failed to answer that request.")
}

fn answer(hub: &Hub, caller: &LeadCaller, call: LeadCall) -> Result<LeadCallResult, McpToolError> {
    let LeadCall::Checklist(call) = call else {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!("{} is not a checklist call.", op_of(&call)),
        ));
    };
    let r = &caller.project_ref;
    let now = now_ms(hub.clock.as_ref());
    let (list, changed_now) = super::apply(&hub.db, r, &call, now).map_err(failed)??;
    let next = if changed_now {
        changed(hub, r, &list, &caller.by, now).map_err(failed)?;
        "The human sees it in the panel's Checklist tab."
    } else {
        "No change: the checklist was already so."
    };
    Ok(LeadCallResult::Checklist(ChecklistResult {
        items: List::unchecked(list.items),
        next: Some(next.into()),
    }))
}

/// `checklist.changed`, which tells the app to read the list again.
pub(super) fn changed(
    hub: &Hub,
    r: &ProjectRef,
    list: &Checklist,
    by: &str,
    now: i64,
) -> Result<(), StoreError> {
    let (done, total) = (list.done(), list.items.len());
    let data = ChecklistChangedData {
        project_ref: r.clone(),
        done: Count::unchecked(done as i64),
        total: Count::unchecked(total as i64),
        by: by.to_owned(),
        person: None,
    };
    hub.events.append(NewEvent {
        at: iso_ms(now).into(),
        r#type: HubEventType::ChecklistChanged,
        machine_id: Some(r.machine_id.clone()),
        project_id: Some(r.project_id.clone()),
        thread_id: None,
        summary: format!("checklist: {done} of {total} done"),
        data: Some(serde_json::to_value(data)?),
        attention: None,
    })?;
    Ok(())
}
