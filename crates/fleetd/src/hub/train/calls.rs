//! The lead's `fleetd change enqueue|status` (leads/LeadCallHandler.ts `change_enqueue`, `change_status`). The
//! caller is already attributed to a project by its cwd; both act only within that project.
use super::contract::{Change, ChangeEnqueueCall, ChangeId, ChangeState, ProjectRef};
use super::service::{Train, TrainError};

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
