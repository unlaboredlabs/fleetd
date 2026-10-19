//! Review-fix work: what a review asked for that has not landed yet. An order never closes over it. A claim that
//! passes while some is open holds the order open (`checks::claims`), and the done sweep never cancels it
//! (`idle::on_done`). On a live hub, an order's fix task spawned from its review findings was once cancelled as a
//! leftover the moment the order's checks passed, and the fix never shipped.
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::tasks::{Task, TaskId, TaskKind, TaskState};
use fleetd_contracts::train::{Change, ChangeId, ChangeState};

use crate::hub::api::Hub;
use crate::hub::valuebar::rules::PrVerdict;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Fix {
    Task(TaskId),
    Pr(ChangeId),
}

/// One piece of open review-fix work, with a line a person can read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewFix {
    pub fix: Fix,
    pub line: String,
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!("{}…", text.chars().take(max - 1).collect::<String>())
    }
}

/// The order's open review-fix work: write tasks still to run that fix a defect (`serves defect:`), and its PRs not
/// in yet that fix a defect or that a review sent back with blocking findings. `verdicts` is a PR's review history.
pub fn select(
    workstream_id: &WorkstreamId,
    tasks: &[Task],
    changes: &[Change],
    verdicts: impl Fn(&Change) -> Vec<PrVerdict>,
) -> Vec<ReviewFix> {
    let fixes_defect = |serves: Option<&str>| serves.is_some_and(|s| s.starts_with("defect:"));
    let mut out: Vec<ReviewFix> = tasks
        .iter()
        .filter(|t| &t.workstream_id == workstream_id && t.kind == TaskKind::Write)
        .filter(|t| {
            matches!(
                t.state,
                TaskState::Queued | TaskState::Running | TaskState::Idle
            )
        })
        .filter(|t| fixes_defect(t.serves.as_ref().map(|s| s.as_str())))
        .map(|t| {
            let state = match t.state {
                TaskState::Queued => "queued",
                TaskState::Idle => "idle",
                _ => "running",
            };
            ReviewFix {
                fix: Fix::Task(t.task_id.clone()),
                line: format!("{} \"{}\" ({state})", t.task_id, clip(t.title.as_str(), 80)),
            }
        })
        .collect();
    out.extend(
        changes
            .iter()
            .filter(|c| &c.workstream_id == workstream_id)
            .filter(|c| {
                !matches!(
                    c.state,
                    ChangeState::Merged | ChangeState::Refused | ChangeState::Abandoned
                )
            })
            .filter_map(|c| {
                let sent_back = c.reviews.iter().any(|r| r.blocking.get() > 0)
                    || verdicts(c).iter().any(|v| v.blocking > 0);
                let why = if sent_back {
                    "changes requested"
                } else if fixes_defect(Some(c.serves.as_str())) {
                    "fixes a defect"
                } else {
                    return None;
                };
                Some(ReviewFix {
                    fix: Fix::Pr(c.change_id.clone()),
                    line: format!("{}#{} ({why})", c.repo, c.pr_number),
                })
            }),
    );
    out
}

/// `select` over the hub's own records.
pub fn open(hub: &Hub, project: &ProjectRef, workstream_id: &WorkstreamId) -> Vec<ReviewFix> {
    select(
        workstream_id,
        &super::order_tasks(hub, workstream_id),
        &super::project_changes(hub, project),
        |c| {
            hub.value_bar
                .verdicts_for(c.pr_url.as_str())
                .unwrap_or_default()
        },
    )
}

/// The lines, joined for one sentence: "T4 \"…\" (running), acme/web#31 (changes requested)".
pub fn listed(fixes: &[ReviewFix]) -> String {
    fixes
        .iter()
        .map(|f| f.line.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}
