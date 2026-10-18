//! The lead's `fleetd change enqueue|status` (`change_enqueue`, `change_status`). The
//! caller is already attributed to a project by its cwd; both act only within that project.
//! Both are registered in link's `LeadCalls` by [`register_lead_calls`].
use super::contract::{Change, ChangeEnqueueCall, ChangeId, ChangeState, ProjectRef};
use super::service::{Train, TrainError};
use crate::hub::api::Hub;
use crate::hub::link::lead_calls::LeadCallFuture;
use crate::hub::link::{LeadCaller, LeadCalls};
use fleetd_contracts::lead_calls::{ChangeResult, LeadCall, LeadCallResult};
use std::sync::{Arc, Weak};

/// Registers `change_enqueue` and `change_status` in the hub's `LeadCalls`. The handler holds the hub weakly, since
/// the hub holds the registry.
pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    super::tools::tool_error(TrainError {
                        code: "invalid",
                        message: "The hub is shutting down.".into(),
                        fix: None,
                    })
                })?;
                let r = &caller.project_ref;
                let result = |(change, next): (Change, String)| ChangeResult {
                    change,
                    next: Some(next),
                };
                match call {
                    LeadCall::ChangeEnqueue(input) => change_enqueue(&hub.train, r, input)
                        .await
                        .map(|c| LeadCallResult::ChangeEnqueue(result(c))),
                    LeadCall::ChangeStatus(c) => change_status(&hub.train, r, &c.change_id)
                        .map(|c| LeadCallResult::ChangeStatus(result(c))),
                    other => Err(TrainError {
                        code: "invalid",
                        message: format!(
                            "{} is not a merge train call.",
                            crate::hub::link::lead_calls::op_of(&other)
                        ),
                        fix: None,
                    }),
                }
                .map_err(super::tools::tool_error)
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    calls.register("change_enqueue", handler.clone());
    calls.register("change_status", handler);
}

/// What the lead does next about a Change: almost always nothing, since the train and reviews move it on.
pub fn change_next(change: &Change) -> String {
    match change.state {
        ChangeState::Merged => "nothing; it is merged.".into(),
        ChangeState::NeedsRebase | ChangeState::CiFailed => format!(
            "nothing unless its author is gone: the train told {} what to fix, and it retries the new head by itself.",
            change.task_id.as_ref().map_or("you", |t| t.as_str())
        ),
        ChangeState::Refused | ChangeState::Abandoned => "fix what it says and enqueue the PR again, or drop it.".into(),
        _ => "don't merge it yourself or post the fleetd/train status; the train merges it and the outcome arrives in a wake.".into(),
    }
}

/// `change_enqueue`: the Change and what the lead does next.
pub async fn change_enqueue(
    train: &Train,
    project_ref: &ProjectRef,
    call: ChangeEnqueueCall,
) -> Result<(Change, String), TrainError> {
    let change = train.enqueue(project_ref, call).await?;
    let next = change_next(&change);
    Ok((change, next))
}

/// `change_status`: a Change of the caller's own project.
pub fn change_status(
    train: &Train,
    project_ref: &ProjectRef,
    change_id: &ChangeId,
) -> Result<(Change, String), TrainError> {
    match train
        .get(change_id)
        .filter(|c| c.project_ref == *project_ref)
    {
        Some(change) => {
            let next = change_next(&change);
            Ok((change, next))
        }
        None => Err(TrainError {
            code: "not_found",
            message: format!("There is no change {change_id} in your project."),
            fix: Some("Use a change id (X<n>) from your digest.".into()),
        }),
    }
}
