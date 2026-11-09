//! `review_read`: an author reads every finding of its PRs' latest reviews, whole, and of any other PR of its project it
//! names (one it builds on), a reviewer those of the one PR it reviews, and a lead its project's. Read-only; another
//! project's PR is refused, and so is any PR but its own for a reviewer.
use std::collections::HashSet;

use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::lead_calls::{PrReviews, ReviewFindings, ReviewReadCall, ReviewReadResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::prim::Text;
use fleetd_contracts::tasks::{PrUrl, TaskId, TaskKind};
use fleetd_contracts::train::ChangeState;
use fleetd_contracts::verification::ReviewVerdict;

use super::verdicts::pr_key;
use crate::hub::api::{Hub, clip};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::redact::redact;
use crate::hub::store::{HubDb, iso_ms};
use crate::hub::train::service::short;

pub fn review_read(
    hub: &Hub,
    caller: &LeadCaller,
    call: &ReviewReadCall,
) -> Result<ReviewReadResult, McpToolError> {
    let task = match &caller.agent {
        CallerAgent::Task(task_id) => Some(task_id),
        _ => None,
    };
    let picked = call.pr.as_ref().map(|p| p.as_str().trim());
    let (mine, reviewer) = caller_prs(hub, caller, task, picked.is_some())?;
    let prs = match picked {
        None => mine,
        Some(wanted) => {
            let matching: Vec<PrUrl> = mine.into_iter().filter(|pr| names(wanted, pr)).collect();
            if matching.is_empty() {
                let whose = match task {
                    Some(id) if reviewer => format!("{id}'s"),
                    _ => "this project's".to_owned(),
                };
                return Err(McpToolError::new(
                    ErrorCode::Forbidden,
                    format!("PR {wanted} is not one of {whose} PRs; another project's reviews are not yours to read."),
                )
                .with_fix("Leave out pr to list the PRs you can read."));
            }
            matching
        }
    };
    let next = prs.is_empty().then(|| match task {
        Some(_) => "You have no PR yet: open it and the train reviews it.".to_owned(),
        None => "No PR of this project is in the merge queue: pass pr to read an earlier one."
            .to_owned(),
    });
    let prs = prs
        .into_iter()
        .map(|pr| PrReviews {
            reviews: latest(&hub.db, pr.as_str()),
            pr,
        })
        .collect();
    Ok(ReviewReadResult { prs, next })
}

/// The caller's PRs, newest first, and whether it is a reviewer: a task's own (its PR and the Changes it wrote; a review
/// task's, the PR it reviews), a lead's project's (those in the merge queue). With `all`, a lead and an author get every
/// PR the project knows too, after an author's own; a reviewer still gets only the PR it reviews.
fn caller_prs(
    hub: &Hub,
    caller: &LeadCaller,
    task: Option<&TaskId>,
    all: bool,
) -> Result<(Vec<PrUrl>, bool), McpToolError> {
    let project = &caller.project_ref;
    let changes = crate::hub::prs::project_changes(hub, project);
    let mut prs: Vec<PrUrl> = Vec::new();
    match task {
        Some(task_id) => {
            let own = hub
                .tasks
                .get(task_id)
                .map_err(|e| McpToolError::new(ErrorCode::Failed, e.to_string()))?
                .filter(|t| &t.project_ref == project);
            let Some(own) = own else {
                return Err(McpToolError::new(
                    ErrorCode::NotFound,
                    format!("No task {task_id} in this project."),
                ));
            };
            // A reviewer reads the earlier reviews of the one PR it reviews, to check its blocking findings were
            // fixed, and no other PR's.
            if own.kind == TaskKind::Review {
                return Ok((own.pr.into_iter().collect(), true));
            }
            prs.extend(
                changes
                    .iter()
                    .filter(|c| c.task_id.as_ref() == Some(task_id))
                    .filter_map(|c| PrUrl::new(c.pr_url.as_str()).ok()),
            );
            prs.extend(own.pr);
        }
        None if !all => {
            let queued = |s: ChangeState| {
                !matches!(
                    s,
                    ChangeState::Merged | ChangeState::Refused | ChangeState::Abandoned
                )
            };
            prs.extend(
                changes
                    .iter()
                    .filter(|c| queued(c.state))
                    .filter_map(|c| PrUrl::new(c.pr_url.as_str()).ok()),
            );
        }
        None => {}
    }
    // A PR named, the lead and an author may read any of the project's: an author the one it is stacked on, say.
    if all {
        prs.extend(
            changes
                .iter()
                .filter_map(|c| PrUrl::new(c.pr_url.as_str()).ok()),
        );
        let tasks = crate::hub::prs::project_tasks(hub, project);
        prs.extend(tasks.into_iter().filter_map(|t| t.pr));
    }
    let mut seen = HashSet::new();
    prs.retain(|pr| seen.insert(pr_key(pr.as_str())));
    Ok((prs, false))
}

/// Whether `wanted`, a PR's URL or its number (`#7`, `7`), names `pr`.
fn names(wanted: &str, pr: &PrUrl) -> bool {
    let key = pr_key(pr.as_str());
    match wanted.trim_start_matches('#').parse::<u64>() {
        Ok(n) => key.ends_with(&format!("/pull/{n}")),
        Err(_) => key == pr_key(wanted),
    }
}

/// The PR's still-open blocking findings, for a message about it: each blocking verdict of its latest review, under its
/// reviewer and head. Empty when its latest review blocks nothing. A rebase since doesn't close them: only a review of a
/// newer head does, or the lead resolving them (`change_enqueue` again) or the reviewer being superseded.
pub fn open_blocking(db: &HubDb, pr: &str) -> String {
    let closed = |task: &TaskId| {
        db.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "SELECT 1 FROM review_tasks WHERE task_id = ?1 AND role IN ('resolved', 'superseded')",
                )?
                .exists([task.as_str()])?)
        })
        .unwrap_or(false)
    };
    let open: Vec<String> = latest(db, pr)
        .into_iter()
        .filter(|r| r.blocking.get() > 0 && !closed(&r.task_id))
        .map(|r| {
            let at = r
                .pr_head_sha
                .as_ref()
                .map(|s| s.as_str())
                .unwrap_or_default();
            format!(
                "{} at {} ({} blocking, {} non-blocking):\n{}",
                r.task_id,
                short(at),
                r.blocking.get(),
                r.non_blocking.get(),
                r.findings
            )
        })
        .collect();
    if open.is_empty() {
        return String::new();
    }
    format!(
        "Its latest review's blocking findings are still open: fix them too, unless your head already does \
         (`review_read` reads them whole).\n\n{}",
        open.join("\n\n")
    )
}

/// The PR's latest reviews: each review task's newest verdict on the newest head reviewed, newest first.
fn latest(db: &HubDb, pr: &str) -> Vec<ReviewFindings> {
    let read = db.with(|conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT task_id, sha, at_ms, data FROM review_verdicts WHERE pr_key = ?1 ORDER BY n DESC",
        )?;
        let rows = stmt.query_map([pr_key(pr)], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    });
    let rows = read.unwrap_or_else(|error| {
        tracing::warn!(%error, "review_read: verdicts not read");
        Vec::new()
    });
    let Some(head) = rows.first().map(|(_, sha, _, _)| sha.clone()) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    rows.into_iter()
        .filter(|(task, sha, _, _)| *sha == head && seen.insert(task.clone()))
        .filter_map(|(task, _, at, data)| {
            let verdict = serde_json::from_str::<ReviewVerdict>(&data).ok()?;
            Some(ReviewFindings {
                task_id: TaskId::unchecked(task),
                pr_head_sha: verdict.pr_head_sha,
                blocking: verdict.blocking,
                non_blocking: verdict.non_blocking,
                findings: Text::unchecked(clip(&redact(verdict.summary.as_str()), 4000)),
                at: Timestamp(iso_ms(at)),
            })
        })
        .collect()
}
