//! The lead's `change_enqueue`, and a writer's ready PR the train takes on its own (a slice). The caller is already
//! attributed to a project by its cwd; it acts only within that project. Registered in link's `LeadCalls` by
//! [`register_lead_calls`].
use super::contract::{Change, ChangeEnqueueCall, ChangeState, GitHubPrUrl, ProjectRef};
use super::service::{Train, TrainError};
use crate::hub::api::Hub;
use crate::hub::link::lead_calls::LeadCallFuture;
use crate::hub::link::{LeadCaller, LeadCalls};
use crate::hub::tasks::records::TaskRecords;
use fleetd_contracts::lead_calls::{ChangeResult, LeadCall, LeadCallResult};
use fleetd_contracts::tasks::{TaskId, TaskKind};
use std::sync::{Arc, Weak};

/// Registers `change_enqueue` in the hub's `LeadCalls`. The handler holds the hub weakly, since the hub holds the
/// registry.
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
                    LeadCall::ChangeEnqueue(input) => {
                        let item = input.item.clone();
                        if let Some(item) = &item {
                            hub.plans.check_item(r, item).map_err(|e| e.0)?;
                        }
                        let enqueued = change_enqueue(&hub.train, r, input).await;
                        enqueued.map(|(change, mut next)| {
                            if let Some(item) = &item
                                && let Err(e) = hub.plans.link_pr(
                                    r,
                                    item,
                                    &change.workstream_id,
                                    &change.pr_url,
                                )
                            {
                                next = format!("{next} Not linked to {item}: {}", e.0.message);
                            }
                            LeadCallResult::ChangeEnqueue(result((change, next)))
                        })
                    }
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
    calls.register("change_enqueue", handler);
}

/// A writer's `gh pr create` (any command of a write task that prints a PR URL) starts the train's ready pass at
/// once, so the slice is queued and reviewed while the writer works on; the pass still picks only the writer's PRs.
pub fn watch_writer_prs(hub: &Arc<Hub>) {
    let weak = Arc::downgrade(hub);
    hub.executors.set_pr_sink(Arc::new(move |thread| {
        let Some(hub) = weak.upgrade() else { return };
        match hub.db.with(|c| Ok(TaskRecords::by_thread(c, thread)?)) {
            Ok(Some(stored)) if stored.task.kind == TaskKind::Write => {
                hub.train.writer_opened_pr(&stored.task.project_ref)
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, "train: a thread's task not read"),
        }
    }));
}

/// A writer's ready PR (a slice): it goes on the train now, as its task's, so the review gate starts the order's
/// reviewers on it at once. Every check of `change_enqueue` applies (open PR in the project's repo); the same PR again
/// is the same Change, so a slice is reviewed once per head.
pub async fn slice_ready(
    train: &Train,
    project_ref: &ProjectRef,
    task_id: &TaskId,
    pr_url: GitHubPrUrl,
) -> Result<Change, TrainError> {
    let writer = train
        .host()
        .task(task_id)
        .filter(|t| t.project_ref == *project_ref);
    if !writer.as_ref().is_some_and(|t| t.kind == "write") {
        return Err(TrainError {
            code: "invalid",
            message: format!("{task_id} is not a write task, and only a writer's PR is a slice."),
            fix: None,
        });
    }
    let input = ChangeEnqueueCall {
        task_id: Some(task_id.clone()),
        pr_url,
        workstream_id: None,
        item: None,
    };
    train.enqueue(project_ref, input).await
}

/// What the lead does next about a Change: almost always nothing, since the train and reviews move it on.
pub fn change_next(change: &Change) -> String {
    match change.state {
        ChangeState::Merged => "nothing; it is merged.".into(),
        ChangeState::CiFailed if super::service::timed_out(change) => format!(
            "nothing: its CI timed out, and {}.",
            super::service::CI_WATCHED
        ),
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
