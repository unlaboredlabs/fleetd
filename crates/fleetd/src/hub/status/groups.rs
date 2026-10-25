//! A project's work in groups, the shape of Claude's Projects: waiting on you, in review, working, landing, idle and
//! done. One item per piece of work, so nothing counts twice: an agent with its PR, a PR no listed agent wrote, an open
//! request, or the lead's question. Only state the hub observed decides a group; nothing is scored or estimated.
use std::collections::HashSet;

use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::HumanRequest;
use fleetd_contracts::live::LaneStatus;
use fleetd_contracts::prim::{Count, Line, Text};
use fleetd_contracts::status::{
    STATUS_ITEMS_PER_GROUP, StatusCounts, StatusGroup, StatusItem, StatusPr,
};
use fleetd_contracts::tasks::{Task, TaskKind, TaskState};
use fleetd_contracts::train::{Change, ChangeState};

use super::rows::clip;
use crate::hub::api::Hub;
use crate::hub::orders;
use crate::hub::store::{iso_ms, parse_ms};
use crate::hub::tasks::TaskFilter;

/// Idle and done items stay listed this long after they last moved.
pub const WINDOW_MS: i64 = 7 * 24 * 3_600_000;
/// Tasks read per state: far above what a project runs at once.
const TASK_SCAN: usize = 500;
/// Ended tasks read per end state, newest first.
const ENDED_SCAN: usize = 100;

/// A PR's group from its train state alone, for a PR nobody is working on now.
pub fn pr_group(state: ChangeState) -> StatusGroup {
    match state {
        ChangeState::Queued | ChangeState::Reviewing => StatusGroup::InReview,
        ChangeState::Ready | ChangeState::Rebasing | ChangeState::Ci | ChangeState::Merging => {
            StatusGroup::Landing
        }
        ChangeState::Merged => StatusGroup::Done,
        ChangeState::NeedsRebase
        | ChangeState::CiFailed
        | ChangeState::Refused
        | ChangeState::Abandoned => StatusGroup::Idle,
    }
}

/// Why a PR the train handed back is idle.
fn pr_why(state: ChangeState) -> Option<&'static str> {
    match state {
        ChangeState::NeedsRebase => Some("needs a rebase"),
        ChangeState::CiFailed => Some("CI failed"),
        ChangeState::Refused => Some("refused by the train"),
        ChangeState::Abandoned => Some("abandoned"),
        _ => None,
    }
}

/// An agent's group: what it does now first (a permission prompt, a run), then where its PR is, then how it ended.
/// A finished agent with no PR is done once its order closed, idle while the order is open.
pub fn agent_group(status: LaneStatus, pr: Option<ChangeState>, order_open: bool) -> StatusGroup {
    match (status, pr) {
        (LaneStatus::Waiting, _) => StatusGroup::WaitingOnYou,
        (
            LaneStatus::Queued | LaneStatus::Starting | LaneStatus::Working | LaneStatus::Stalled,
            _,
        ) => StatusGroup::Working,
        (_, Some(state)) => pr_group(state),
        (LaneStatus::Done, None) if !order_open => StatusGroup::Done,
        _ => StatusGroup::Idle,
    }
}

fn line<const N: usize>(s: &str) -> Line<1, N> {
    let s = clip(s, N);
    Line::unchecked(if s.is_empty() { "—".to_owned() } else { s })
}

fn pr_of(c: &Change) -> StatusPr {
    StatusPr {
        repo: c.repo.clone(),
        number: c.pr_number,
        url: Text::unchecked(clip(c.pr_url.as_str(), 300)),
    }
}

fn ms(t: &Timestamp) -> i64 {
    parse_ms(t.as_str()).unwrap_or(0)
}

/// The project's tasks: every live one, and those that ended within the window.
fn tasks_of(hub: &Hub, r: &ProjectRef, since_ms: i64) -> Vec<Task> {
    let list = |state, limit| {
        hub.tasks
            .list(&TaskFilter {
                project_ref: Some(r.clone()),
                state: Some(state),
                workstream_id: None,
                limit,
            })
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "status: tasks not read");
                Vec::new()
            })
    };
    let mut out = Vec::new();
    for state in [TaskState::Running, TaskState::Queued, TaskState::Idle] {
        out.extend(list(state, TASK_SCAN));
    }
    for state in [TaskState::Done, TaskState::Failed, TaskState::Cancelled] {
        out.extend(
            list(state, ENDED_SCAN)
                .into_iter()
                .filter(|t| t.ended_at.as_ref().is_some_and(|e| ms(e) >= since_ms)),
        );
    }
    out
}

/// The project's open orders, by id.
fn open_orders(hub: &Hub, r: &ProjectRef) -> HashSet<String> {
    hub.db
        .with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT 'W' || n FROM workstreams
                 WHERE machine_id = ?1 AND project_id = ?2 AND state NOT IN ('done', 'stopped', 'failed')",
            )?;
            let ids = stmt
                .query_map([r.machine_id.as_str(), r.project_id.as_str()], |row| row.get(0))?
                .collect::<rusqlite::Result<HashSet<String>>>()?;
            Ok(ids)
        })
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "status: orders not read");
            HashSet::new()
        })
}

/// The project's counts and items at `now`. `needs_you` is the lead chat's own rule, so the row and the chat agree.
pub fn read(
    hub: &Hub,
    r: &ProjectRef,
    needs_you: bool,
    now: i64,
) -> (StatusCounts, Vec<StatusItem>) {
    let since = now - WINDOW_MS;
    let tasks = tasks_of(hub, r, since);
    let changes = orders::project_changes(hub, r);
    let prs: Vec<_> = changes.iter().map(|c| (c, orders::pr_ref(c))).collect();
    let open = open_orders(hub, r);
    let requests = hub
        .leads
        .ctx
        .ports()
        .open_requests(Some(r), 50)
        .unwrap_or_else(|error| {
            tracing::warn!(%error, "status: requests not read");
            Vec::new()
        });
    let mut items = Vec::new();
    let mut covered: HashSet<&str> = HashSet::new();
    let mut threads: HashSet<&str> = HashSet::new();
    let listed: HashSet<&str> = tasks.iter().map(|t| t.task_id.as_str()).collect();
    for task in &tasks {
        let lane = orders::task_lane(task, &prs, hub);
        // A reviewer's work is its PR's review, shown with the PR; it is its own item only while it waits on you.
        let reviewer = task.kind == TaskKind::Review;
        if reviewer && lane.status != LaneStatus::Waiting {
            continue;
        }
        if let Some(t) = &task.thread_ref {
            threads.insert(t.thread_id.as_str());
        }
        let change = (!reviewer)
            .then(|| {
                changes
                    .iter()
                    .find(|c| lane.pr.as_ref().is_some_and(|p| p.change_id == c.change_id))
            })
            .flatten();
        if let Some(c) = change {
            covered.insert(c.change_id.as_str());
        }
        let group = agent_group(
            lane.status,
            change.map(|c| c.state),
            open.contains(task.workstream_id.as_str()),
        );
        let why = lane
            .status_reason
            .as_ref()
            .map(|r| r.as_str().to_owned())
            .or_else(|| change.and_then(|c| pr_why(c.state)).map(str::to_owned));
        let at = [
            Some(&task.created_at),
            task.started_at.as_ref(),
            task.ended_at.as_ref(),
            change.map(|c| &c.updated_at),
        ]
        .into_iter()
        .flatten()
        .max_by_key(|t| ms(t))
        .cloned()
        .unwrap_or_else(|| task.created_at.clone());
        items.push(StatusItem {
            group,
            title: line(task.title.as_str()),
            task_id: Some(task.task_id.clone()),
            pr: change.map(pr_of),
            why: why.as_deref().map(line),
            at,
        });
    }
    // The PRs no listed agent wrote: the lead's own, or a writer that ended before the window.
    for c in &changes {
        if covered.contains(c.change_id.as_str())
            || c.task_id
                .as_ref()
                .is_some_and(|t| listed.contains(t.as_str()))
        {
            continue;
        }
        items.push(StatusItem {
            group: pr_group(c.state),
            title: line(c.branch.as_str()),
            task_id: None,
            pr: Some(pr_of(c)),
            why: pr_why(c.state).map(line),
            at: c.updated_at.clone(),
        });
    }
    let mut asks = 0;
    for req in &requests {
        // A session's tool prompt shows on its agent, which waits on it.
        if req
            .permission
            .as_ref()
            .is_some_and(|p| threads.contains(p.thread_id.as_str()))
        {
            continue;
        }
        asks += 1;
        items.push(request_item(req));
    }
    if needs_you && asks == 0 {
        items.push(StatusItem {
            group: StatusGroup::WaitingOnYou,
            title: line("The lead's question in chat"),
            task_id: None,
            pr: None,
            why: None,
            at: Timestamp(iso_ms(now)),
        });
    }
    // Idle and done stop being news after the window; the rest are listed for as long as they last.
    items.retain(|i| {
        !matches!(i.group, StatusGroup::Idle | StatusGroup::Done) || ms(&i.at) >= since
    });
    grouped(items)
}

fn request_item(req: &HumanRequest) -> StatusItem {
    let kind = match (&req.secret, &req.permission) {
        (Some(_), _) => "secret",
        (_, Some(_)) => "tool prompt",
        _ => "approval",
    };
    StatusItem {
        group: StatusGroup::WaitingOnYou,
        title: line(req.text.as_str()),
        task_id: None,
        pr: None,
        why: Some(line(kind)),
        at: req.created_at.clone(),
    }
}

/// Counted in full; listed group by group, newest first, at most `STATUS_ITEMS_PER_GROUP` each.
pub fn grouped(mut items: Vec<StatusItem>) -> (StatusCounts, Vec<StatusItem>) {
    let mut counts = StatusCounts::default();
    for i in &items {
        let n = match i.group {
            StatusGroup::WaitingOnYou => &mut counts.waiting_on_you,
            StatusGroup::InReview => &mut counts.in_review,
            StatusGroup::Working => &mut counts.working,
            StatusGroup::Landing => &mut counts.landing,
            StatusGroup::Idle | StatusGroup::Unknown => &mut counts.idle,
            StatusGroup::Done => &mut counts.done,
        };
        *n = Count::unchecked(n.get() + 1);
    }
    items.sort_by(|a, b| {
        a.group
            .cmp(&b.group)
            .then_with(|| ms(&b.at).cmp(&ms(&a.at)))
    });
    let mut out: Vec<StatusItem> = Vec::new();
    for i in items {
        if out.iter().filter(|o| o.group == i.group).count() < STATUS_ITEMS_PER_GROUP {
            out.push(i);
        }
    }
    (counts, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_is_grouped_by_what_it_does_then_its_pr_then_how_it_ended() {
        use LaneStatus as L;
        use StatusGroup as G;
        assert_eq!(
            agent_group(L::Waiting, Some(ChangeState::Ci), true),
            G::WaitingOnYou
        );
        assert_eq!(
            agent_group(L::Working, Some(ChangeState::CiFailed), true),
            G::Working,
            "a writer fixing its red PR is working"
        );
        assert_eq!(agent_group(L::Queued, None, true), G::Working);
        assert_eq!(
            agent_group(L::Done, Some(ChangeState::Reviewing), true),
            G::InReview
        );
        assert_eq!(
            agent_group(L::Idle, Some(ChangeState::Ci), true),
            G::Landing
        );
        assert_eq!(
            agent_group(L::Done, Some(ChangeState::Merged), true),
            G::Done
        );
        assert_eq!(
            agent_group(L::Done, Some(ChangeState::CiFailed), true),
            G::Idle,
            "a red PR with nobody on it is not work"
        );
        assert_eq!(
            agent_group(L::Done, None, true),
            G::Idle,
            "its order is still open"
        );
        assert_eq!(agent_group(L::Done, None, false), G::Done);
        assert_eq!(agent_group(L::Failed, None, false), G::Idle);
        assert_eq!(
            agent_group(L::Parked, None, true),
            G::Idle,
            "it resumes by itself"
        );
    }

    #[test]
    fn counts_are_complete_and_lists_stop_at_the_cap_newest_first() {
        let item = |group, at: i64| StatusItem {
            group,
            title: Line::unchecked("x".to_owned()),
            task_id: None,
            pr: None,
            why: None,
            at: Timestamp(iso_ms(at)),
        };
        let mut items: Vec<_> = (0..10).map(|i| item(StatusGroup::Done, i)).collect();
        items.push(item(StatusGroup::Working, 0));
        let (counts, listed) = grouped(items);
        assert_eq!((counts.done.get(), counts.working.get()), (10, 1));
        assert_eq!(listed[0].group, StatusGroup::Working);
        assert_eq!(listed.len(), 1 + STATUS_ITEMS_PER_GROUP);
        assert_eq!(listed[1].at.as_str(), iso_ms(9));
    }
}
