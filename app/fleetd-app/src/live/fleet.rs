//! The staged order as structure, not a log: the writers still writing, then one group per PR with the checkers
//! working on it, and the order's finish. Pure, so every count the stage shows comes from one place: the rows it
//! draws and the PRs it was given.

use fleetd_contracts::live::{AgentLane, AgentRole, LaneStatus, PrRef};
use fleetd_contracts::train::ChangeState;

use super::state::is_final;

/// One PR and the agents around it.
#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub pr: PrRef,
    /// The writer that opened it, once known (it leaves the rows when it finishes).
    pub writer: Option<AgentLane>,
    /// Its checkers still drawn (working, or holding their check before they fold into the group).
    pub rows: Vec<AgentLane>,
    pub checks_done: usize,
    pub checks_needed: usize,
}

impl Group {
    /// The review segment's fill, 0..=1: the checks done of those needed, as the rows under it show them.
    pub fn review_progress(&self) -> f32 {
        if self.checks_needed == 0 {
            return if past_review(self.pr.state) { 1. } else { 0. };
        }
        self.checks_done as f32 / self.checks_needed as f32
    }

    /// "review 1/3", "ready · 2/3 checks", "reviewed", "CI", "merged": the same numbers the track draws.
    pub fn label(&self) -> String {
        let all = self.checks_done >= self.checks_needed;
        match self.pr.state {
            ChangeState::Queued | ChangeState::Reviewing => format!("review {}/{}", self.checks_done, self.checks_needed),
            ChangeState::Ready if all => "reviewed".into(),
            ChangeState::Ready => format!("ready · {}/{} checks", self.checks_done, self.checks_needed),
            s => super::chips::stage_word(s).into(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fleet {
    /// Writers without a PR yet, in row order.
    pub writers: Vec<AgentLane>,
    pub groups: Vec<Group>,
    /// Anyone else drawn: a checker whose PR the card doesn't list.
    pub others: Vec<AgentLane>,
}

fn is_checker(role: AgentRole) -> bool {
    matches!(role, AgentRole::Reviewer | AgentRole::Verifier | AgentRole::Qa)
}

fn past_review(state: ChangeState) -> bool {
    matches!(state, ChangeState::Ready | ChangeState::Rebasing | ChangeState::Ci | ChangeState::Merging | ChangeState::Merged)
}

/// Groups `rows` (the lanes drawn now) under `prs`; `seen` is every lane the order has had, finished ones
/// included, for the counts and the writers that already left the rows.
pub fn fleet(rows: &[AgentLane], seen: &[AgentLane], prs: &[PrRef]) -> Fleet {
    let pr_of = |l: &AgentLane| l.pr.as_ref().map(|p| p.number.get());
    let mut prs: Vec<&PrRef> = prs.iter().collect();
    prs.sort_by_key(|p| p.number.get());
    let groups: Vec<Group> = prs
        .iter()
        .map(|pr| {
            let n = pr.number.get();
            let writer = seen.iter().chain(rows).find(|l| !is_checker(l.role) && pr_of(l) == Some(n)).cloned();
            let checkers: Vec<&AgentLane> = seen.iter().filter(|l| is_checker(l.role) && pr_of(l) == Some(n)).collect();
            // Counted from the lanes, as the rows show them: the hub's verdict count lags a finished check.
            let done = checkers.iter().filter(|l| l.status == LaneStatus::Done).count();
            let working = checkers.iter().filter(|l| !is_final(l.status)).count();
            let needed = (pr.reviews_needed.get().max(0) as usize).max(checkers.len());
            // Past review with no checker left at work (or none seen, e.g. the app joined late): all checks are in.
            let checks_done = if past_review(pr.state) && working == 0 { needed } else { done.min(needed) };
            Group {
                pr: (*pr).clone(),
                writer,
                rows: rows.iter().filter(|l| is_checker(l.role) && pr_of(l) == Some(n)).cloned().collect(),
                checks_done,
                checks_needed: needed,
            }
        })
        .collect();
    let grouped = |l: &AgentLane| pr_of(l).is_some_and(|n| groups.iter().any(|g| g.pr.number.get() == n));
    Fleet {
        writers: rows.iter().filter(|l| !is_checker(l.role) && !grouped(l)).cloned().collect(),
        others: rows.iter().filter(|l| is_checker(l.role) && !grouped(l)).cloned().collect(),
        groups,
    }
}

/// The order is finished on the stage once every PR merged and no agent is left at work.
pub fn finished(rows: &[AgentLane], prs: &[PrRef]) -> bool {
    !prs.is_empty() && prs.iter().all(|p| p.state == ChangeState::Merged) && rows.iter().all(|l| is_final(l.status))
}

/// Once a list is compact it stays compact for the order: a list that switched row height back and forth would
/// jump under the reader's eye as agents come and go.
pub fn latch_compact(was: bool, rows: usize, after: usize) -> bool {
    was || rows > after
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lane(id: &str, role: &str, status: &str, pr: Option<i64>) -> AgentLane {
        serde_json::from_value(serde_json::json!({
            "laneId": id, "role": role, "title": format!("{role} {id}"), "status": status,
            "pr": pr.map(|n| serde_json::json!({
                "changeId": format!("X{n}"), "repo": "o/r", "number": n, "url": format!("https://github.com/o/r/pull/{n}"),
                "state": "reviewing", "reviewsDone": 0, "reviewsNeeded": 3
            })),
        }))
        .unwrap()
    }

    fn pr(n: i64, state: &str, done: i64) -> PrRef {
        serde_json::from_value(serde_json::json!({
            "changeId": format!("X{n}"), "repo": "o/r", "number": n, "url": format!("https://github.com/o/r/pull/{n}"),
            "state": state, "reviewsDone": done, "reviewsNeeded": 3
        }))
        .unwrap()
    }

    #[test]
    fn the_counts_come_from_the_lanes_the_stage_draws() {
        let writer = lane("T1", "implementer", "done", Some(115));
        let r1 = lane("T4", "reviewer", "done", Some(115));
        let r2 = lane("T5", "reviewer", "working", Some(115));
        let v = lane("T6", "verifier", "working", Some(115));
        let w2 = lane("T2", "implementer", "working", None);
        let rows = vec![w2.clone(), r2.clone(), v.clone()];
        let seen = vec![writer.clone(), r1, r2, v, w2.clone()];
        // The hub's verdict count lags (0/3) while a check is already done: the stage counts the done check.
        let f = fleet(&rows, &seen, &[pr(115, "reviewing", 0)]);
        assert_eq!(f.writers, vec![w2]);
        let g = &f.groups[0];
        assert_eq!(g.writer.as_ref().map(|l| l.lane_id.as_str()), Some("T1"));
        assert_eq!(g.rows.len(), 2);
        assert_eq!((g.checks_done, g.checks_needed, g.label()), (1, 3, "review 1/3".to_string()));
        assert!((g.review_progress() - 1. / 3.).abs() < 1e-6);
        // The train calls it ready while a check still runs: the words say so and the bar agrees.
        let g = &fleet(&rows, &seen, &[pr(115, "ready", 2)]).groups[0];
        assert_eq!((g.checks_done, g.label()), (1, "ready · 1/3 checks".to_string()));
        // Every check in: reviewed, the review segment full.
        let all: Vec<AgentLane> = seen.iter().map(|l| AgentLane { status: LaneStatus::Done, ..l.clone() }).collect();
        let g = &fleet(&[], &all, &[pr(115, "ready", 3)]).groups[0];
        assert_eq!((g.checks_done, g.label(), g.review_progress()), (3, "reviewed".to_string(), 1.));
    }

    #[test]
    fn finished_means_every_pr_merged_and_nobody_working() {
        let done = lane("T4", "reviewer", "done", Some(115));
        assert!(finished(std::slice::from_ref(&done), &[pr(115, "merged", 3)]));
        assert!(!finished(std::slice::from_ref(&done), &[pr(115, "ci", 3)]));
        assert!(!finished(&[lane("T5", "reviewer", "working", Some(115))], &[pr(115, "merged", 3)]));
        assert!(!finished(&[done], &[]), "no PRs is not a finish");
    }

    #[test]
    fn compact_rows_never_switch_back_within_an_order() {
        assert!(!latch_compact(false, 6, 6));
        assert!(latch_compact(false, 7, 6));
        assert!(latch_compact(true, 2, 6), "fewer rows later keep the compact height");
    }
}
