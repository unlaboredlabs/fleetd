//! The PR views: a project's PRs (`pr_list`) and one PR in detail (`pr_get`, `pr_files`, `pr_diff`). Joins the merge
//! queue's Changes, the review gate's verdicts and the task that wrote each PR with what GitHub says, read through
//! [`github::PrsGitHub`]'s short cache. Read-only; owns no table and runs no loop.
pub mod github;
pub mod join;
pub mod tools;

#[cfg(test)]
mod tests;

use std::collections::BTreeSet;
use std::sync::Arc;

use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::prim::{Count, Text};
use fleetd_contracts::prs::{PrQueueStep, PrReviewEntry, ReviewVerdictKind};
use fleetd_contracts::tasks::Task;
use fleetd_contracts::train::{Change, ChangeState, GitHubRepo};
use fleetd_contracts::verification::ReviewVerdict;

use crate::clock::Clock;
use crate::hub::api::{Hub, clip};
use crate::hub::orders::phase;
use crate::hub::redact::redact;
use crate::hub::store::{StoreError, iso_ms};
use crate::hub::tasks::TaskFilter;
use crate::hub::train::github::GhRunner;
use crate::hub::train::records::ListFilter;
use github::PrsGitHub;
use join::RowCtx;

/// Tasks read per project to name PR writers and reviewers.
const PROJECT_TASKS: usize = 500;
/// Changes read per project.
const PROJECT_CHANGES: i64 = 200;
/// Agent verdicts read per PR.
const PR_VERDICTS: i64 = 30;
/// Queue moves read per PR.
const PR_HISTORY: usize = 30;

pub struct Prs {
    pub github: PrsGitHub,
}

impl Prs {
    pub fn new(gh: Arc<dyn GhRunner>, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self {
            github: PrsGitHub::new(gh, clock),
        })
    }
}

/// The repos a project lands PRs on: those whose merge queue it owns, and those of its Changes.
pub fn project_repos(hub: &Hub, project: &ProjectRef, changes: &[Change]) -> Vec<GitHubRepo> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    let owned = hub
        .train
        .records()
        .trains()
        .into_iter()
        .filter(|t| &t.project_ref == project)
        .filter_map(|t| GitHubRepo::new(t.repo).ok());
    for repo in owned.chain(changes.iter().map(|c| c.repo.clone())) {
        if seen.insert(repo.to_lowercase()) {
            out.push(repo);
        }
    }
    out
}

/// The project a repo's PRs belong to: the one owning its merge queue, else the newest Change's.
pub fn owner_of(hub: &Hub, repo: &str) -> Option<ProjectRef> {
    hub.train
        .records()
        .train(repo)
        .map(|t| t.project_ref)
        .or_else(|| {
            hub.train
                .list(&ListFilter {
                    repo: Some(repo.to_owned()),
                    limit: 1,
                    ..Default::default()
                })
                .into_iter()
                .next()
                .map(|c| c.project_ref)
        })
}

pub fn project_tasks(hub: &Hub, project: &ProjectRef) -> Vec<Task> {
    hub.tasks
        .list(&TaskFilter {
            project_ref: Some(project.clone()),
            state: None,
            workstream_id: None,
            limit: PROJECT_TASKS,
        })
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "prs: tasks not read");
            Vec::new()
        })
}

pub fn project_changes(hub: &Hub, project: &ProjectRef) -> Vec<Change> {
    hub.train.list(&ListFilter {
        project_ref: Some(project.clone()),
        limit: PROJECT_CHANGES,
        ..Default::default()
    })
}

/// The hub's side of the join: each repo's queue.
pub fn fill_ctx(hub: &Hub, ctx: &mut RowCtx<'_>, repos: &[GitHubRepo]) {
    for repo in repos {
        let state = hub.train.records().train_state(repo);
        ctx.queues.insert(repo.to_lowercase(), state.queue.len());
    }
}

/// The default `closedSince`: a week before `now_ms`.
pub fn default_closed_since(now_ms: i64) -> String {
    iso_ms(now_ms - 7 * 24 * 60 * 60 * 1000)
}

/// Agent verdicts on the PR, newest first: `(task id, head sha, at, verdict)`.
pub fn verdicts(hub: &Hub, pr_url: &str) -> Vec<(String, String, String, ReviewVerdict)> {
    let key = crate::hub::reviews::verdicts::pr_key(pr_url);
    let read = hub.db.with(|conn| {
        let mut stmt = conn.prepare_cached(
            "SELECT task_id, sha, at_ms, data FROM review_verdicts WHERE pr_key = ?1 ORDER BY n DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![key, PR_VERDICTS], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    });
    read.unwrap_or_else(|error: StoreError| {
        tracing::warn!(%error, "prs: verdicts not read");
        Vec::new()
    })
    .into_iter()
    .filter_map(|(task, sha, at, data)| {
        let verdict = serde_json::from_str::<ReviewVerdict>(&data).ok()?;
        Some((task, sha, iso_ms(at), verdict))
    })
    .collect()
}

/// An agent verdict as a review entry. `current`: it reviewed the PR's current change.
pub fn agent_review(
    verdict: &ReviewVerdict,
    at: String,
    reviewer: Option<&Task>,
    current: bool,
) -> PrReviewEntry {
    PrReviewEntry {
        verdict: if verdict.blocking.get() > 0 {
            ReviewVerdictKind::ChangesRequested
        } else {
            ReviewVerdictKind::Approved
        },
        agent: reviewer.map(|t| join::agent_of(t, phase::role(t.kind, t.qa == Some(true)))),
        login: None,
        blocking: Some(verdict.blocking),
        non_blocking: Some(verdict.non_blocking),
        text: Text::unchecked(clip(&redact(&verdict.summary), 2000)),
        current,
        at: Timestamp(at),
    }
}

/// A person's review on GitHub as a review entry; None for a pending (unsubmitted) one.
pub fn person_review(r: &github::GhReview, head: &str) -> Option<PrReviewEntry> {
    let verdict = match r.state.to_uppercase().as_str() {
        "APPROVED" => ReviewVerdictKind::Approved,
        "CHANGES_REQUESTED" => ReviewVerdictKind::ChangesRequested,
        "COMMENTED" => ReviewVerdictKind::Commented,
        "DISMISSED" => ReviewVerdictKind::Dismissed,
        _ => return None,
    };
    Some(PrReviewEntry {
        verdict,
        agent: None,
        login: r
            .author
            .as_ref()
            .and_then(|a| Text::new(clip(&a.login, 100)).ok()),
        blocking: None,
        non_blocking: None,
        text: Text::unchecked(clip(&redact(&r.body), 2000)),
        current: r.commit.as_ref().is_some_and(|c| c.oid == head),
        at: join::iso(r.submitted_at.as_deref().unwrap_or("")),
    })
}

/// The PR's moves through the merge queue, newest first, from the `change.state` events of its Changes.
pub fn history(hub: &Hub, change_ids: &[String]) -> Vec<PrQueueStep> {
    #[derive(serde::Deserialize)]
    struct Stored {
        at: Timestamp,
        data: Option<Move>,
    }
    #[derive(serde::Deserialize)]
    struct Move {
        from: ChangeState,
        to: ChangeState,
    }
    let mut out: Vec<PrQueueStep> = Vec::new();
    for id in change_ids {
        let read = hub.events.db().with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT data FROM events WHERE type = 'change.state'
                   AND json_extract(data, '$.data.changeId') = ?1 ORDER BY seq DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(rusqlite::params![id, PR_HISTORY as i64], |r| {
                r.get::<_, String>(0)
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        });
        for data in read.unwrap_or_default() {
            if let Ok(Stored {
                at,
                data: Some(Move { from, to }),
            }) = serde_json::from_str::<Stored>(&data)
            {
                out.push(PrQueueStep { at, from, to });
            }
        }
    }
    out.sort_by(|a, b| b.at.cmp(&a.at));
    out.truncate(PR_HISTORY);
    out
}

/// Changes of one PR, newest first.
pub fn pr_changes(hub: &Hub, repo: &str, number: i64) -> Vec<Change> {
    hub.train
        .list(&ListFilter {
            repo: Some(repo.to_owned()),
            limit: PROJECT_CHANGES,
            ..Default::default()
        })
        .into_iter()
        .filter(|c| c.pr_number.get() == number)
        .collect()
}

pub fn count(n: i64) -> Count {
    Count::unchecked(n.max(0))
}
