//! The readiness gate and the text reviewers and authors get. Pure; the gate feeds them the Change and what its
//! review tasks recorded.
use crate::hub::prompts::PromptSet;
use crate::hub::train::contract::Change;

/// A recorded verdict of one of the Change's review tasks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundReview {
    pub task_id: String,
    pub patch_id: String,
    pub blocking: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gate {
    pub ready: bool,
    /// Not ready because of blocking findings: only a new head moves it.
    pub waiting_for_head: bool,
    pub why: String,
}

/// Ready once a clean verdict is bound to exactly `patch_id`. Any blocking verdict on the patch holds it until a new
/// head changes the patch; a verdict on another patch counts for nothing.
pub fn gate(patch_id: &str, reviews: &[BoundReview]) -> Gate {
    let current: Vec<&BoundReview> = reviews.iter().filter(|r| r.patch_id == patch_id).collect();
    let blocked: Vec<String> = current
        .iter()
        .filter(|r| r.blocking > 0)
        .map(|r| format!("{} ({})", r.task_id, r.blocking))
        .collect();
    let short = &patch_id[..patch_id.len().min(12)];
    if !blocked.is_empty() {
        return Gate {
            ready: false,
            waiting_for_head: true,
            why: format!(
                "blocking findings from {}; waiting for a new head",
                blocked.join(", ")
            ),
        };
    }
    match current.first() {
        Some(clean) => Gate {
            ready: true,
            waiting_for_head: false,
            why: format!("{} reviewed patch {short} clean", clean.task_id),
        },
        None => Gate {
            ready: false,
            waiting_for_head: false,
            why: format!("waiting for a clean review of patch {short}"),
        },
    }
}

/// A reviewer's prompt: the PR diff ref. Tasks adds the brief's goal and done-when. Never the author's narrative, so
/// the PR description and comments are off limits too. `reviewed` is the head an earlier round reviewed, if any: a
/// re-review starts from what changed since.
pub fn review_prompt(set: &PromptSet, change: &Change, reviewed: Option<&str>) -> String {
    let text = set.render(
        "review.reviewer",
        &[
            ("prUrl", &change.pr_url),
            ("repo", &change.repo),
            ("prNumber", &change.pr_number),
            ("headSha", &change.head_sha),
        ],
    );
    match reviewed.filter(|sha| *sha != change.head_sha.as_str()) {
        Some(sha) => {
            let delta = set.render(
                "review.delta",
                &[("reviewedSha", &sha), ("headSha", &change.head_sha)],
            );
            format!("{text}\n\n{delta}")
        }
        None => text,
    }
}

pub struct FindingsVerdict<'a> {
    pub task_id: &'a str,
    pub pr_head_sha: &'a str,
    pub blocking: i64,
    pub non_blocking: i64,
    pub summary: &'a str,
}

/// The message that sends blocking findings back to the task that wrote the code.
pub fn findings_message(set: &PromptSet, change: &Change, v: &FindingsVerdict<'_>) -> String {
    let problem = format!(
        "review {} at {} found {} blocking finding{} ({} non-blocking)",
        v.task_id,
        &v.pr_head_sha[..v.pr_head_sha.len().min(12)],
        v.blocking,
        if v.blocking == 1 { "" } else { "s" },
        v.non_blocking
    );
    crate::hub::train::service::fix_your_pr(set, change, &problem, v.summary)
}

/// One line, at most `max` characters.
pub fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > max {
        format!("{}…", flat.chars().take(max - 1).collect::<String>())
    } else {
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const P: &str = "1111111111111111111111111111111111111111";
    const Q: &str = "2222222222222222222222222222222222222222";

    fn review(task_id: &str, patch_id: &str, blocking: i64) -> BoundReview {
        BoundReview {
            task_id: task_id.into(),
            patch_id: patch_id.into(),
            blocking,
        }
    }

    #[test]
    fn a_patch_with_no_review_is_never_ready() {
        let g = gate(P, &[]);
        assert!(!g.ready && !g.waiting_for_head, "{g:?}");
        // A clean review of another patch counts for nothing: a new head needs a new review.
        assert!(!gate(Q, &[review("T2", P, 0)]).ready);
        assert!(gate(P, &[review("T2", P, 0)]).ready);
    }

    #[test]
    fn blocking_findings_hold_the_patch_until_a_new_head() {
        let blocked = gate(P, &[review("T2", P, 2), review("T3", P, 0)]);
        assert_eq!(
            blocked,
            Gate {
                ready: false,
                waiting_for_head: true,
                why: "blocking findings from T2 (2); waiting for a new head".into()
            }
        );
        let new_head = [review("T2", P, 2)];
        assert!(!gate(Q, &new_head).ready && !gate(Q, &new_head).waiting_for_head);
        assert!(gate(Q, &[review("T2", P, 2), review("T5", Q, 0)]).ready);
    }
}

#[cfg(test)]
mod delta_tests {
    use super::*;

    fn change(head: &str) -> Change {
        serde_json::from_value(serde_json::json!({
            "changeId": "X1", "projectRef": { "machineId": "m", "projectId": "p" }, "repo": "acme/app",
            "prNumber": 7, "prUrl": "https://github.com/acme/app/pull/7", "branch": "fleetd/T1",
            "workstreamId": "W1", "headSha": head, "state": "reviewing",
            "reviews": [], "createdAt": "2026-10-19T10:00:00.000Z", "updatedAt": "2026-10-19T10:00:00.000Z",
        }))
        .unwrap()
    }

    #[test]
    fn a_re_review_starts_from_the_delta_at_the_same_bar() {
        let (old, new) = ("a".repeat(40), "b".repeat(40));
        let set = PromptSet::defaults();
        let first = review_prompt(set, &change(&new), None);
        assert!(!first.contains("reviewed before"));
        let again = review_prompt(set, &change(&new), Some(&old));
        assert!(again.starts_with(&first), "the full review text stays");
        assert!(
            again.contains(&format!("git range-diff {old}...{new}")),
            "{again}"
        );
        assert!(
            again.contains(
                "blocking only for what is wrong, unsafe or fails what it sets out to do"
            )
        );
        // The same head reviewed again is no delta.
        assert_eq!(review_prompt(set, &change(&new), Some(&new)), first);
    }
}
