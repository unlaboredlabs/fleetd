//! The figure (verified must points over must points) and the done rule. Pure: callers load the rows.
use std::collections::HashMap;

use fleetd_contracts::plan::{PlanItemState, Size, Weight};
use fleetd_contracts::train::ChangeState;

/// Sums of one scope's items. Dropped items are never added.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Figure {
    pub must_done_pts: i64,
    pub must_total_pts: i64,
    pub polish_done_pts: i64,
    pub polish_total_pts: i64,
    pub must_done: i64,
    pub must_total: i64,
    pub polish_done: i64,
    pub polish_total: i64,
}

impl Figure {
    pub fn add(&mut self, weight: Weight, size: Size, state: PlanItemState) {
        let done = state == PlanItemState::Done;
        if state == PlanItemState::Dropped {
            return;
        }
        let pts = size.points();
        match weight {
            Weight::Must => {
                self.must_total_pts += pts;
                self.must_total += 1;
                if done {
                    self.must_done_pts += pts;
                    self.must_done += 1;
                }
            }
            Weight::Polish => {
                self.polish_total_pts += pts;
                self.polish_total += 1;
                if done {
                    self.polish_done_pts += pts;
                    self.polish_done += 1;
                }
            }
        }
    }

    pub fn merge(&mut self, o: &Figure) {
        self.must_done_pts += o.must_done_pts;
        self.must_total_pts += o.must_total_pts;
        self.polish_done_pts += o.polish_done_pts;
        self.polish_total_pts += o.polish_total_pts;
        self.must_done += o.must_done;
        self.must_total += o.must_total;
        self.polish_done += o.polish_done;
        self.polish_total += o.polish_total;
    }

    /// floor, so 100 shows only when every must item is verified. With no must items, the polish figure.
    pub fn pct(&self) -> i64 {
        if self.must_total_pts > 0 {
            100 * self.must_done_pts / self.must_total_pts
        } else {
            self.polish_pct().unwrap_or(0)
        }
    }

    pub fn polish_pct(&self) -> Option<i64> {
        (self.polish_total_pts > 0).then(|| 100 * self.polish_done_pts / self.polish_total_pts)
    }

    pub fn remaining_must_pts(&self) -> i64 {
        self.must_total_pts - self.must_done_pts
    }
}

/// A Change linked to an item (by one of its tasks or its PR URL).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkedChange {
    pub change_id: String,
    pub pr_number: i64,
    pub state: ChangeState,
}

/// One check index's result in the order's latest claim that ran it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckPass {
    pub pass: bool,
    pub claim_id: String,
}

/// The done rule (§1): `Some(evidence)` when the item is verified. An item needs a link. Every linked Change that
/// is not abandoned or refused must be merged by the train (only `finish_merged` sets Merged, so a bypass merge
/// never counts), and every listed check must pass in the latest claim that ran it. An item that links only checks
/// is done when they pass.
pub fn verified(
    linked_tasks_or_prs: bool,
    changes: &[LinkedChange],
    checks: &[i64],
    latest: &HashMap<i64, CheckPass>,
) -> Option<String> {
    if !linked_tasks_or_prs && checks.is_empty() {
        return None;
    }
    let live: Vec<&LinkedChange> = changes
        .iter()
        .filter(|c| !matches!(c.state, ChangeState::Abandoned | ChangeState::Refused))
        .collect();
    if linked_tasks_or_prs
        && (live.is_empty() || live.iter().any(|c| c.state != ChangeState::Merged))
    {
        return None;
    }
    let mut passed = Vec::new();
    for i in checks {
        let r = latest.get(i)?;
        if !r.pass {
            return None;
        }
        passed.push(format!("check {i} passed {}", r.claim_id));
    }
    let mut parts: Vec<String> = live
        .iter()
        .map(|c| format!("#{} merged by the train", c.pr_number))
        .collect();
    parts.extend(passed);
    Some(parts.join(" · "))
}

/// Whether a done item reopens: one of its checks failed in a later claim.
pub fn reopened(checks: &[i64], latest: &HashMap<i64, CheckPass>) -> Option<i64> {
    checks
        .iter()
        .copied()
        .find(|i| latest.get(i).is_some_and(|r| !r.pass))
}

/// Edits within this long of a milestone's first item shape the plan and carry no marker.
pub const PLANNING_WINDOW_MS: i64 = 10 * 60_000;

pub fn in_planning_window(first_item_ms: Option<i64>, now_ms: i64) -> bool {
    first_item_ms.is_none_or(|f| now_ms - f <= PLANNING_WINDOW_MS)
}

/// "+3 items", "−1 item", "+5 points".
pub fn delta_text(delta_items: i64, delta_size: i64) -> String {
    let sign = |n: i64| if n < 0 { "−" } else { "+" };
    if delta_items != 0 {
        let n = delta_items.abs();
        format!(
            "{}{n} item{}",
            sign(delta_items),
            if n == 1 { "" } else { "s" }
        )
    } else {
        let n = delta_size.abs();
        format!(
            "{}{n} point{}",
            sign(delta_size),
            if n == 1 { "" } else { "s" }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fig(items: &[(Weight, Size, PlanItemState)]) -> Figure {
        let mut f = Figure::default();
        for (w, s, st) in items {
            f.add(*w, *s, *st);
        }
        f
    }

    #[test]
    fn the_figure_counts_verified_must_points_only_and_floors() {
        use PlanItemState::*;
        let f = fig(&[
            (Weight::Must, Size::L, Done),
            (Weight::Must, Size::M, Open),
            (Weight::Must, Size::S, Done),
            (Weight::Polish, Size::M, Done),
            (Weight::Must, Size::L, Dropped),
        ]);
        assert_eq!(f.pct(), 75, "9 of 12 points");
        assert_eq!(f.polish_pct(), Some(100));
        assert_eq!((f.must_done, f.must_total), (2, 3));
        let almost = fig(&[(Weight::Must, Size::L, Done); 199]
            .iter()
            .copied()
            .chain([(Weight::Must, Size::S, Open)])
            .collect::<Vec<_>>());
        assert_eq!(
            almost.pct(),
            99,
            "100 only when every must item is verified"
        );
        let polish_only = fig(&[
            (Weight::Polish, Size::S, Done),
            (Weight::Polish, Size::S, Open),
        ]);
        assert_eq!(polish_only.pct(), 50);
    }

    #[test]
    fn done_needs_a_train_merge_and_the_latest_check_passes() {
        let merged = |n| LinkedChange {
            change_id: format!("X{n}"),
            pr_number: n,
            state: ChangeState::Merged,
        };
        let mut latest = HashMap::new();
        latest.insert(
            2,
            CheckPass {
                pass: true,
                claim_id: "C9".into(),
            },
        );
        assert_eq!(verified(false, &[], &[], &latest), None, "no link");
        assert_eq!(
            verified(true, &[], &[], &latest),
            None,
            "a task without a Change"
        );
        assert_eq!(
            verified(true, &[merged(212)], &[2], &latest).as_deref(),
            Some("#212 merged by the train · check 2 passed C9")
        );
        let ci = LinkedChange {
            state: ChangeState::Ci,
            ..merged(213)
        };
        assert_eq!(
            verified(true, &[merged(212), ci], &[], &latest),
            None,
            "every live Change merged"
        );
        let abandoned = LinkedChange {
            state: ChangeState::Abandoned,
            ..merged(214)
        };
        assert!(verified(true, &[merged(212), abandoned], &[], &latest).is_some());
        assert_eq!(
            verified(true, &[merged(212)], &[3], &latest),
            None,
            "check 3 never ran"
        );
        latest.insert(
            2,
            CheckPass {
                pass: false,
                claim_id: "C10".into(),
            },
        );
        assert_eq!(verified(true, &[merged(212)], &[2], &latest), None);
        assert_eq!(reopened(&[2], &latest), Some(2));
    }

    #[test]
    fn markers_and_the_window() {
        assert!(in_planning_window(None, 0));
        assert!(in_planning_window(Some(0), PLANNING_WINDOW_MS));
        assert!(!in_planning_window(Some(0), PLANNING_WINDOW_MS + 1));
        assert_eq!(delta_text(3, 9), "+3 items");
        assert_eq!(delta_text(-1, -3), "−1 item");
        assert_eq!(delta_text(0, 5), "+5 points");
    }
}
