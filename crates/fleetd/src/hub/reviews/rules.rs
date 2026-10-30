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

/// A rebase's conflict resolution to review: the approved head and its base, the new head's base, and the files whose
/// hunks changed.
pub struct Conflicts<'a> {
    pub reviewed_sha: &'a str,
    pub reviewed_base: &'a str,
    pub base: &'a str,
    pub files: &'a [String],
}

/// The short reviewer's prompt for a rebase that only resolved conflicts with the base: those files' hunks and their
/// resolution against both sides, nothing else of the PR.
pub fn conflicts_prompt(set: &PromptSet, change: &Change, c: &Conflicts<'_>) -> String {
    let files = c
        .files
        .iter()
        .map(|f| format!("`{f}`"))
        .collect::<Vec<_>>()
        .join(", ");
    set.render(
        "review.conflicts",
        &[
            ("prUrl", &change.pr_url),
            ("headSha", &change.head_sha),
            ("reviewedSha", &c.reviewed_sha),
            ("reviewedBase", &c.reviewed_base),
            ("base", &c.base),
            ("files", &files),
        ],
    )
}

/// The start of a Change's `lastError` while its reviewer's fleetd tools failed, followed by what it said and when the
/// next one starts.
pub const TOOLS_FAILED: &str = "review tools failed";

/// Whether a reviewer that ended without a verdict did so because it couldn't use fleetd's tools (its MCP server didn't
/// start, a tool wasn't there, recording the verdict failed), going by its final text: then the next reviewer would
/// fail the same way until they work again, so it is no reviewer's fault and no retry of its own.
pub fn tools_failed(tail: &str) -> bool {
    let t = tail.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| t.contains(w));
    let tools = [
        "mcp",
        "fleetd tool",
        "fleetd's tool",
        "tools server",
        "tool server",
        "report tool",
        "verdict tool",
        "`report`",
        "mcp__fleetd",
    ];
    let failing = [
        "fail",
        "error",
        "unavailable",
        "not available",
        "isn't available",
        "aren't available",
        "not found",
        "no such",
        "missing",
        "not connected",
        "could not connect",
        "couldn't connect",
        "can't connect",
        "cannot connect",
        "could not reach",
        "couldn't reach",
        "can't reach",
        "cannot reach",
    ];
    let unrecorded = [
        "could not record",
        "couldn't record",
        "can't record",
        "cannot record",
        "unable to record",
        "failed to record",
        "no way to record",
        "not able to record",
    ];
    t.contains("enoent") || (has(&tools) && has(&failing)) || has(&unrecorded)
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

/// fleetd's own ids in a PR title, such as "(W41)" or "[D128, T7]": the human never needs them.
static INTERNAL_IDS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"\s*[(\[]\s*[WTXDSQ]\d+(?:\s*[,/;]?\s*[WTXDSQ]\d+)*\s*[)\]]")
        .expect("internal id pattern")
});

/// A review task's title in plain words: what it checks, by the PR's title, or by its number when GitHub didn't say.
pub fn review_title(pr_title: Option<&str>, pr_number: i64) -> String {
    let plain = pr_title.map(|t| INTERNAL_IDS.replace_all(t, ""));
    match plain.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(title) => one_line(&format!("Checking: {title}"), 80),
        None => format!("Checking PR #{pr_number}"),
    }
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

    /// The 10-25 outage's words, and others like them, read as broken tools; a reviewer that simply stopped, or one
    /// whose findings mention a failing tool of the code under review while it recorded nothing, mostly don't.
    #[test]
    fn a_reviewer_whose_tools_failed_is_told_apart_by_its_final_text() {
        for broken in [
            "Error: spawn stdio ENOENT",
            "The fleetd MCP server failed to start, so I can't record the verdict.",
            "I couldn't record my verdict: the report tool isn't available in this session.",
            "mcp__fleetd__report is not available; the review found nothing blocking.",
            "The fleetd tools server is not connected.",
        ] {
            assert!(tools_failed(broken), "{broken}");
        }
        for not in [
            "",
            "Reviewed the diff; looks fine.",
            "I ran out of turns before finishing the review.",
        ] {
            assert!(!tools_failed(not), "{not}");
        }
    }

    /// A review task is titled by what it checks, never by the train's ids.
    #[test]
    fn a_review_is_titled_by_its_pr_in_plain_words() {
        let id = regex::Regex::new(r"\b[WTXDSQ]\d+\b|acme/").unwrap();
        for (title, want) in [
            (
                Some("Receipts use the shop's time zone"),
                "Checking: Receipts use the shop's time zone",
            ),
            (
                Some("feat(lead): plain words from the lead (W41)"),
                "Checking: feat(lead): plain words from the lead",
            ),
            (
                Some("[D128] Receipts (T7, X12) use the shop's time zone"),
                "Checking: Receipts use the shop's time zone",
            ),
            (Some("(S3) [Q44]"), "Checking PR #31"),
            (Some("  "), "Checking PR #31"),
            (None, "Checking PR #31"),
        ] {
            let got = review_title(title, 31);
            assert_eq!(got, want);
            assert!(!id.is_match(&got), "{got}");
        }
        let long = review_title(Some(&"word ".repeat(40)), 31);
        assert!(
            long.starts_with("Checking: word") && long.chars().count() == 80,
            "{long}"
        );
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
        assert!(again.contains(
            "blocking for what is wrong, unsafe, fails what it sets out to do or is a bug a person would hit"
        ));
        // The same head reviewed again is no delta.
        assert_eq!(review_prompt(set, &change(&new), Some(&new)), first);
    }

    /// A bug a person would hit in normal use blocks, and the reviewer runs the tests nearest the change and names
    /// them: tonight's reviewers filed a dead tap and raw JSON in search as non-blocking, and ran no tests.
    #[test]
    fn a_user_visible_bug_blocks_and_the_reviewer_runs_the_nearest_tests() {
        let text = review_prompt(PromptSet::defaults(), &change(&"a".repeat(40)), None);
        for needle in [
            "any bug a person would hit in normal use: a dead tap or click, raw JSON or an internal error shown, \
             data lost or shown wrong, a crash, a flow that doesn't finish",
            "Non-blocking is only for style, docs, naming and rare edge cases",
            "when unsure whether people would hit it, it is blocking",
            "Run the tests nearest the change, and name each one you ran",
            "`cargo test -p <crate> <filter>`",
            "a warm build in `target/`",
            "and the tests you ran",
        ] {
            assert!(text.contains(needle), "{needle}\n---\n{text}");
        }
        assert!(!text.contains("never a long or exhaustive suite"), "{text}");
        let brief = crate::hub::prompts::registry::get("task.brief.review")
            .unwrap()
            .default;
        assert!(
            brief.contains("Run the tests nearest the change"),
            "{brief}"
        );
        assert!(
            brief.contains("any bug a person would hit in normal use is one: a dead tap or click"),
            "{brief}"
        );
    }
}
