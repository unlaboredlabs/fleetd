//! What fleetd tells agents that is not a prompt: plain notices and rules that change only with a release. No one
//! edits them, they are not in the registry, and sessions don't pin them. The editable prompts are `registry`; a
//! lead's state block and event lines are `leads::digest` and `leads::events`.
use std::fmt::Display;

macro_rules! fixed {
    ($id:literal) => {
        include_str!(concat!("../../../assets/fixed/", $id, ".md"))
    };
}

/// A read-only task's first message.
pub const TASK_BRIEF_READ: &str = fixed!("task.brief.read");
/// A review task's first message (one the lead spawns, not the train's reviewer).
pub const TASK_BRIEF_REVIEW: &str = fixed!("task.brief.review");
/// Appended to a reviewer's prompt when an earlier round reviewed another head of the PR.
pub const REVIEW_DELTA: &str = fixed!("review.delta");
/// The lead's tool result when a plan item is too big or unsized.
pub const PLAN_GRANULARITY: &str = fixed!("plan.granularity");
/// The message to a thread a usage limit parked, once the limit resets.
pub const USAGE_CONTINUE: &str = fixed!("usage.continue");

/// To a running agent above a lowered max agents, when a person pauses the extras.
pub const TASK_PAUSE: &str = fixed!("task.pause");
/// To a paused agent once a slot frees for it.
pub const TASK_RESUME: &str = fixed!("task.resume");

/// Every fixed text by name, for "What agents are told".
pub const ALL: [(&str, &str); 7] = [
    ("task.brief.read", TASK_BRIEF_READ),
    ("task.brief.review", TASK_BRIEF_REVIEW),
    ("review.delta", REVIEW_DELTA),
    ("plan.granularity", PLAN_GRANULARITY),
    ("usage.continue", USAGE_CONTINUE),
    ("task.pause", TASK_PAUSE),
    ("task.resume", TASK_RESUME),
];

pub fn render(text: &str, vars: &[(&str, &dyn Display)]) -> String {
    super::render::render(text, vars)
}

/// Why a PR goes back to the agent that wrote it.
#[derive(Debug, Clone)]
pub enum FixPr<'a> {
    /// The train could not rebase it onto `base`.
    Rebase { why: &'a str, base: &'a str },
    /// The train did not merge it: CI, or a merge GitHub refused.
    Ci { why: &'a str },
    /// A review found blocking findings.
    Review {
        review_task: &'a str,
        head_sha: &'a str,
        blocking: i64,
        non_blocking: i64,
        summary: &'a str,
    },
}

/// The one "fix your PR" message: what is wrong, what to do on the branch, and that the agent never merges.
pub fn fix_your_pr(pr_url: &str, change: Option<&str>, branch: &str, fix: &FixPr<'_>) -> String {
    let pr = match change {
        Some(c) => format!("{pr_url} ({c})"),
        None => pr_url.to_owned(),
    };
    let (why, body, todo, after) = match fix {
        FixPr::Rebase { why, base } => (
            format!("the merge train could not rebase it: it {why}"),
            String::new(),
            format!("rebase onto origin/{base} and resolve the conflicts"),
            "the train takes the new head by itself",
        ),
        FixPr::Ci { why } => (
            format!("the merge train did not merge it: {why}"),
            String::new(),
            "fix it".to_owned(),
            "the train retries the new head by itself",
        ),
        FixPr::Review {
            review_task,
            head_sha,
            blocking,
            non_blocking,
            summary,
        } => (
            format!(
                "review {review_task} at {} found {blocking} blocking finding{} ({non_blocking} non-blocking)",
                &head_sha[..head_sha.len().min(12)],
                if *blocking == 1 { "" } else { "s" }
            ),
            format!("\n\n{}\n", summary.trim()),
            "fix the blocking findings".to_owned(),
            "it is reviewed again once its patch changes, and the train won't merge it before then",
        ),
    };
    format!(
        "Fix your PR {pr}: {why}.{body}\nOn {branch}: {todo}, push to the same PR, and stop; {after}. Never merge it yourself."
    )
}

/// Why fleetd refused a tool call.
#[derive(Debug, Clone)]
pub enum DenyReason<'a> {
    /// A `tools.deny` rule in the project's policy file.
    Policy { rule: &'a str, file: &'a str },
    /// A person said no; `said` is what they wrote, if anything.
    Human {
        by: &'a str,
        request: &'a str,
        said: Option<&'a str>,
    },
    /// The approval was withdrawn before anyone answered it.
    Withdrawn { by: &'a str, request: &'a str },
}

/// The tool result of a denied call.
pub fn denied(reason: &DenyReason<'_>) -> String {
    let reason = match reason {
        DenyReason::Policy { rule, file } => format!("the tools.deny rule `{rule}` in {file}"),
        DenyReason::Human { by, request, said } => format!(
            "{by} said no ({request}){}",
            said.map(|s| format!(": {s}")).unwrap_or_default()
        ),
        DenyReason::Withdrawn { by, request } => format!(
            "{by} withdrew {request} before anyone answered it. Don't retry this call; ask for another way"
        ),
    };
    format!("Denied: {reason}.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fix_your_pr_for_each_reason() {
        let url = "https://github.com/o/r/pull/12";
        assert_eq!(
            fix_your_pr(
                url,
                Some("C4"),
                "fleetd/T4-x",
                &FixPr::Rebase {
                    why: "conflicts with origin/main in a.rs",
                    base: "main"
                }
            ),
            "Fix your PR https://github.com/o/r/pull/12 (C4): the merge train could not rebase it: it conflicts with origin/main in a.rs.\nOn fleetd/T4-x: rebase onto origin/main and resolve the conflicts, push to the same PR, and stop; the train takes the new head by itself. Never merge it yourself."
        );
        assert_eq!(
            fix_your_pr(
                url,
                Some("C4"),
                "fleetd/T4-x",
                &FixPr::Ci {
                    why: "CI failed on abc1234: rust (macos) (failure)"
                }
            ),
            "Fix your PR https://github.com/o/r/pull/12 (C4): the merge train did not merge it: CI failed on abc1234: rust (macos) (failure).\nOn fleetd/T4-x: fix it, push to the same PR, and stop; the train retries the new head by itself. Never merge it yourself."
        );
        assert_eq!(
            fix_your_pr(
                url,
                None,
                "fleetd/T4-x",
                &FixPr::Review {
                    review_task: "T9",
                    head_sha: "0123456789abcdef",
                    blocking: 1,
                    non_blocking: 2,
                    summary: " The lock is never released. \n"
                }
            ),
            "Fix your PR https://github.com/o/r/pull/12: review T9 at 0123456789ab found 1 blocking finding (2 non-blocking).\n\nThe lock is never released.\n\nOn fleetd/T4-x: fix the blocking findings, push to the same PR, and stop; it is reviewed again once its patch changes, and the train won't merge it before then. Never merge it yourself."
        );
    }

    #[test]
    fn denied_for_each_reason() {
        assert_eq!(
            denied(&DenyReason::Policy {
                rule: "Bash(rm *)",
                file: ".fleetd/policy.yaml"
            }),
            "Denied: the tools.deny rule `Bash(rm *)` in .fleetd/policy.yaml."
        );
        assert_eq!(
            denied(&DenyReason::Human {
                by: "ada-lovelace",
                request: "Q3",
                said: Some("not on prod")
            }),
            "Denied: ada-lovelace said no (Q3): not on prod."
        );
        assert_eq!(
            denied(&DenyReason::Human {
                by: "ada-lovelace",
                request: "Q3",
                said: None
            }),
            "Denied: ada-lovelace said no (Q3)."
        );
        assert_eq!(
            denied(&DenyReason::Withdrawn {
                by: "ada-lovelace",
                request: "Q3"
            }),
            "Denied: ada-lovelace withdrew Q3 before anyone answered it. Don't retry this call; ask for another way."
        );
    }

    #[test]
    fn the_granularity_warning_asks_to_split_anything_bigger_than_m() {
        let text = render(
            PLAN_GRANULARITY,
            &[("item", &"P4"), ("reason", &"has no size (counted as m)")],
        );
        assert!(text.starts_with("P4 has no size (counted as m). Split anything bigger than m"));
        assert!(text.contains("`plan_edit` P4 and size s, m or l"));
        assert!(!text.contains("hour"), "sizes, never hours");
    }
}
