//! Pure rules of the orders board: an order's phase (first match wins, worst child rolls up), a lane's status and
//! role, and the board's order.
use std::cmp::Reverse;

use fleetd_contracts::ledger::{LeadState, WorkstreamState};
use fleetd_contracts::live::{AgentRole, LaneStatus, OrderCard, OrderPhase};
use fleetd_contracts::tasks::{Task, TaskKind, TaskState};
use fleetd_contracts::train::ChangeState;

/// One PR of the order, as the phase reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrState {
    pub state: ChangeState,
    pub number: i64,
}

pub struct PhaseInput<'a> {
    pub state: WorkstreamState,
    pub headline: Option<&'a str>,
    pub open_requests: usize,
    pub lanes: &'a [(AgentRole, LaneStatus, Option<&'a str>)],
    pub prs: &'a [PrState],
    pub lead_working: bool,
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn implementing(role: AgentRole) -> bool {
    matches!(role, AgentRole::Implementer | AgentRole::Reader)
}

fn active(status: LaneStatus) -> bool {
    matches!(status, LaneStatus::Starting | LaneStatus::Working)
}

/// The order's phase and its chip detail ("3 working", "#212 in CI", "1 request").
pub fn phase(i: &PhaseInput<'_>) -> (OrderPhase, Option<String>) {
    let waiting = i
        .lanes
        .iter()
        .filter(|(_, s, _)| *s == LaneStatus::Waiting)
        .count();
    if i.open_requests > 0 || waiting > 0 {
        let detail = if i.open_requests > 0 {
            plural(i.open_requests, "request", "requests")
        } else {
            plural(waiting, "approval", "approvals")
        };
        return (OrderPhase::WaitingOnYou, Some(detail));
    }
    match i.state {
        WorkstreamState::Failed => {
            return (OrderPhase::Failed, i.headline.map(str::to_owned));
        }
        WorkstreamState::Stopped => return (OrderPhase::Stopped, None),
        WorkstreamState::Done => {
            let merged = i
                .prs
                .iter()
                .filter(|p| p.state == ChangeState::Merged)
                .count();
            let detail = (merged > 0).then(|| plural(merged, "PR merged", "PRs merged"));
            return (OrderPhase::Done, detail);
        }
        _ => {}
    }
    let working = i
        .lanes
        .iter()
        .filter(|(r, s, _)| implementing(*r) && active(*s))
        .count();
    if working > 0 {
        return (OrderPhase::Working, Some(format!("{working} working")));
    }
    let reviewing_pr = i.prs.iter().find(|p| p.state == ChangeState::Reviewing);
    let reviewing_lanes = i
        .lanes
        .iter()
        .filter(|(r, s, _)| !implementing(*r) && *r != AgentRole::Lead && active(*s))
        .count();
    if reviewing_pr.is_some() || reviewing_lanes > 0 {
        let detail = match reviewing_pr {
            Some(pr) => format!("reviewing #{}", pr.number),
            None => format!("{reviewing_lanes} reviewing"),
        };
        return (OrderPhase::Reviewing, Some(detail));
    }
    if let Some(pr) = i.prs.iter().find(|p| {
        matches!(
            p.state,
            ChangeState::Ready | ChangeState::Rebasing | ChangeState::Ci | ChangeState::Merging
        )
    }) {
        let detail = match pr.state {
            ChangeState::Ready => format!("#{} ready to merge", pr.number),
            ChangeState::Rebasing => format!("rebasing #{}", pr.number),
            ChangeState::Ci => format!("#{} in CI", pr.number),
            _ => format!("merging #{}", pr.number),
        };
        return (OrderPhase::Merging, Some(detail));
    }
    let live: Vec<_> = i
        .lanes
        .iter()
        .filter(|(_, s, _)| !settled(*s) && *s != LaneStatus::Idle)
        .collect();
    if !live.is_empty() && live.iter().all(|(_, s, _)| *s == LaneStatus::Queued) {
        let reason = live
            .iter()
            .find_map(|(_, _, why)| *why)
            .map_or_else(|| "queued".to_owned(), |why| format!("queued: {why}"));
        return (OrderPhase::Queued, Some(reason));
    }
    let tasks = i.lanes.iter().any(|(r, _, _)| *r != AgentRole::Lead);
    if i.state == WorkstreamState::Draft || (!tasks && i.lead_working) {
        return (OrderPhase::Planning, None);
    }
    (OrderPhase::Idle, Some("waiting for the lead".into()))
}

pub fn settled(status: LaneStatus) -> bool {
    matches!(
        status,
        LaneStatus::Done | LaneStatus::Failed | LaneStatus::Cancelled
    )
}

/// A task's lane status from its record and its thread's status as the hub last saw it.
pub fn task_lane_status(task: &Task, thread_status: Option<&str>) -> LaneStatus {
    match task.state {
        TaskState::Queued => LaneStatus::Queued,
        TaskState::Done => LaneStatus::Done,
        TaskState::Failed => LaneStatus::Failed,
        TaskState::Cancelled => LaneStatus::Cancelled,
        TaskState::Idle if task.parked.is_some() => LaneStatus::Parked,
        TaskState::Idle => LaneStatus::Idle,
        TaskState::Running if task.parked.is_some() => LaneStatus::Parked,
        TaskState::Running => match (task.thread_ref.as_ref(), thread_status) {
            (None, _) => LaneStatus::Starting,
            (Some(_), Some("waiting")) => LaneStatus::Waiting,
            (Some(_), Some("running")) => LaneStatus::Working,
            (Some(_), Some("idle" | "completed")) => LaneStatus::Idle,
            (Some(_), Some("failed" | "interrupted")) => LaneStatus::Stalled,
            (Some(_), _) => LaneStatus::Starting,
        },
    }
}

pub fn lead_lane_status(state: LeadState, parked: bool, thread_status: Option<&str>) -> LaneStatus {
    match state {
        _ if parked => LaneStatus::Parked,
        LeadState::Starting => LaneStatus::Starting,
        LeadState::Stalled => LaneStatus::Stalled,
        LeadState::Stopped => LaneStatus::Cancelled,
        LeadState::Working | LeadState::Idle => match thread_status {
            Some("waiting") => LaneStatus::Waiting,
            Some("running") => LaneStatus::Working,
            _ if state == LeadState::Working => LaneStatus::Working,
            _ => LaneStatus::Idle,
        },
    }
}

/// A task's role: write tasks implement, read tasks read; review tasks are QA runs when spawned with `--qa`, and
/// otherwise review.
pub fn role(kind: TaskKind, qa: bool) -> AgentRole {
    match kind {
        TaskKind::Write => AgentRole::Implementer,
        TaskKind::Read => AgentRole::Reader,
        TaskKind::Review if qa => AgentRole::Qa,
        TaskKind::Review => AgentRole::Reviewer,
    }
}

/// Board order: phase first, then the most recently updated.
pub fn sort_cards(cards: &mut [OrderCard]) {
    cards.sort_by(|a, b| {
        (a.phase, Reverse(&b.updated_at.0))
            .cmp(&(b.phase, Reverse(&a.updated_at.0)))
            .then_with(|| a.workstream_id.as_str().cmp(b.workstream_id.as_str()))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(
        state: WorkstreamState,
        lanes: &'a [(AgentRole, LaneStatus, Option<&'a str>)],
        prs: &'a [PrState],
    ) -> PhaseInput<'a> {
        PhaseInput {
            state,
            headline: None,
            open_requests: 0,
            lanes,
            prs,
            lead_working: false,
        }
    }

    const W: WorkstreamState = WorkstreamState::Running;

    #[test]
    fn the_worst_child_rolls_up_in_table_order() {
        use AgentRole::*;
        use LaneStatus::*;
        let busy = [
            (Implementer, Working, None),
            (Reviewer, Working, None),
            (Reviewer, Queued, Some("fleet cap: 40 of 40 running")),
        ];
        let pr = [PrState {
            state: ChangeState::Ci,
            number: 208,
        }];
        // An open secret or approval request beats everything.
        let mut waiting = input(W, &busy, &pr);
        waiting.open_requests = 1;
        assert_eq!(
            phase(&waiting),
            (OrderPhase::WaitingOnYou, Some("1 request".into()))
        );
        // A lane waiting on a permission is the same phase.
        let approve = [(Implementer, Waiting, None), (Implementer, Working, None)];
        assert_eq!(phase(&input(W, &approve, &[])).0, OrderPhase::WaitingOnYou);
        // Implementers working beat reviewers and PRs in CI.
        assert_eq!(
            phase(&input(W, &busy, &pr)),
            (OrderPhase::Working, Some("1 working".into()))
        );
        // Then reviewers.
        let reviewing = [(Implementer, Done, None), (Reviewer, Working, None)];
        assert_eq!(
            phase(&input(W, &reviewing, &pr)),
            (OrderPhase::Reviewing, Some("1 reviewing".into()))
        );
        // Then the train.
        let done = [(Implementer, Done, None), (Reviewer, Done, None)];
        assert_eq!(
            phase(&input(W, &done, &pr)),
            (OrderPhase::Merging, Some("#208 in CI".into()))
        );
        // Only queued lanes left: say why.
        let queued = [
            (Implementer, Queued, Some("slots: 4/4 in use")),
            (Reader, Done, None),
        ];
        assert_eq!(
            phase(&input(W, &queued, &[])),
            (OrderPhase::Queued, Some("queued: slots: 4/4 in use".into()))
        );
        // No tasks yet while the lead works: planning; a draft always is.
        let mut planning = input(W, &[], &[]);
        planning.lead_working = true;
        assert_eq!(phase(&planning).0, OrderPhase::Planning);
        assert_eq!(
            phase(&input(WorkstreamState::Draft, &[], &[])).0,
            OrderPhase::Planning
        );
        assert_eq!(phase(&input(W, &done, &[])).0, OrderPhase::Idle);
    }

    #[test]
    fn closed_orders_say_how_they_ended() {
        let merged = [
            PrState {
                state: ChangeState::Merged,
                number: 211,
            },
            PrState {
                state: ChangeState::Merged,
                number: 212,
            },
        ];
        assert_eq!(
            phase(&input(WorkstreamState::Done, &[], &merged)),
            (OrderPhase::Done, Some("2 PRs merged".into()))
        );
        let mut failed = input(
            WorkstreamState::Failed,
            &[(AgentRole::Implementer, LaneStatus::Working, None)],
            &[],
        );
        failed.headline = Some("tests failed");
        assert_eq!(
            phase(&failed),
            (OrderPhase::Failed, Some("tests failed".into()))
        );
        assert_eq!(
            phase(&input(WorkstreamState::Stopped, &[], &[])).0,
            OrderPhase::Stopped
        );
    }

    #[test]
    fn review_tasks_review_unless_they_are_qa_runs() {
        assert_eq!(role(TaskKind::Write, false), AgentRole::Implementer);
        assert_eq!(role(TaskKind::Read, false), AgentRole::Reader);
        assert_eq!(role(TaskKind::Review, false), AgentRole::Reviewer);
        assert_eq!(role(TaskKind::Review, true), AgentRole::Qa);
    }

    #[test]
    fn lead_lanes_follow_their_thread() {
        assert_eq!(
            lead_lane_status(LeadState::Idle, false, Some("running")),
            LaneStatus::Working
        );
        assert_eq!(
            lead_lane_status(LeadState::Working, false, Some("waiting")),
            LaneStatus::Waiting
        );
        assert_eq!(
            lead_lane_status(LeadState::Idle, false, Some("completed")),
            LaneStatus::Idle
        );
        assert_eq!(
            lead_lane_status(LeadState::Working, true, Some("running")),
            LaneStatus::Parked
        );
        assert_eq!(
            lead_lane_status(LeadState::Stopped, false, None),
            LaneStatus::Cancelled
        );
    }
}
