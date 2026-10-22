//! Review tiers, the readiness gate, and the text reviewers and authors get. Pure; the gate feeds them the Change, its
//! review tasks and what those recorded.
use std::collections::{HashMap, HashSet};

use crate::hub::prompts::PromptSet;
use crate::hub::prompts::fixed::{self, FixPr, fix_your_pr};
use crate::hub::train::contract::{Change, ReviewRule, Tier, tier_str};
use crate::hub::train::host::{PlaybookView, TaskView};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ReviewRole {
    Reviewer,
    Verifier,
}

impl ReviewRole {
    pub fn as_str(self) -> &'static str {
        match self {
            ReviewRole::Reviewer => "reviewer",
            ReviewRole::Verifier => "verifier",
        }
    }
    pub fn parse(s: &str) -> Self {
        if s == "verifier" {
            ReviewRole::Verifier
        } else {
            ReviewRole::Reviewer
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReviewProvider {
    Claude,
    Codex,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlannedReview {
    pub role: ReviewRole,
    pub provider: ReviewProvider,
}

fn rule(reviewers: i64, verifier: bool, plan_first: bool) -> ReviewRule {
    ReviewRule {
        reviewers: fleetd_contracts::prim::Int::unchecked(reviewers),
        verifier,
        plan_first,
    }
}

/// Without a pinned playbook. S: none. M: one reviewer. L: two reviewers plus a verifier.
pub fn coded_rules() -> [ReviewRule; 3] {
    [
        rule(0, false, false),
        rule(1, false, false),
        rule(2, true, true),
    ]
}

fn tier_index(tier: Tier) -> usize {
    match tier {
        Tier::S => 0,
        Tier::M => 1,
        Tier::L => 2,
    }
}

/// The pinned playbook's `reviewRules` for the tier, else the coded ones.
pub fn rule_for(tier: Tier, playbook: Option<&PlaybookView>) -> ReviewRule {
    let rules = playbook.map_or_else(coded_rules, |p| p.review_rules.clone());
    rules[tier_index(tier)].clone()
}

/// The rule's reviewers from fresh sessions, the second on Codex when there is one, plus its verifier.
pub fn review_plan(rule: &ReviewRule, codex_available: bool) -> Vec<PlannedReview> {
    let mut plan: Vec<PlannedReview> = (0..rule.reviewers.get())
        .map(|i| PlannedReview {
            role: ReviewRole::Reviewer,
            provider: if i == 1 && codex_available {
                ReviewProvider::Codex
            } else {
                ReviewProvider::Claude
            },
        })
        .collect();
    if rule.verifier {
        plan.push(PlannedReview {
            role: ReviewRole::Verifier,
            provider: ReviewProvider::Claude,
        });
    }
    plan
}

/// Nothing to review: the Change may be taken as soon as it is enqueued.
pub fn needs_no_review(rule: &ReviewRule) -> bool {
    rule.reviewers.get() == 0 && !rule.verifier
}

/// The planned reviews not yet spawned for this patch, given the roles already spawned for it.
pub fn missing_reviews(plan: &[PlannedReview], spawned: &[ReviewRole]) -> Vec<PlannedReview> {
    let mut left: HashMap<ReviewRole, usize> = HashMap::new();
    for role in spawned {
        *left.entry(*role).or_default() += 1;
    }
    plan.iter()
        .filter(|p| match left.get_mut(&p.role) {
            Some(n) if *n > 0 => {
                *n -= 1;
                false
            }
            _ => true,
        })
        .copied()
        .collect()
}

/// A recorded verdict of one of the Change's review tasks, with its role.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleReview {
    pub task_id: String,
    pub role: ReviewRole,
    pub patch_id: String,
    pub blocking: i64,
    /// Verifiers only: their task ended with commands run, so the verdict rests on receipts.
    pub receipts: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gate {
    pub ready: bool,
    /// Not ready because of blocking findings: only a new head moves it.
    pub waiting_for_head: bool,
    pub why: String,
}

fn ready(why: String) -> Gate {
    Gate {
        ready: true,
        waiting_for_head: false,
        why,
    }
}

fn not_ready(waiting_for_head: bool, why: String) -> Gate {
    Gate {
        ready: false,
        waiting_for_head,
        why,
    }
}

/// The rule is satisfied for `patch_id` when its required clean verdicts are bound to exactly that patch: its number
/// of distinct reviewers, plus a verifier with receipts when it has one. Any blocking verdict on the patch holds it
/// until a new head changes the patch. `waived` is set when the polish-loop rule ended review for this patch.
pub fn gate(
    tier: Tier,
    rule: &ReviewRule,
    patch_id: Option<&str>,
    reviews: &[RoleReview],
    waived: Option<&str>,
) -> Gate {
    if needs_no_review(rule) {
        return ready(format!("tier {} needs no review", tier_str(tier)));
    }
    let Some(patch_id) = patch_id else {
        return not_ready(false, "the patch id is not known yet".into());
    };
    let current: Vec<&RoleReview> = reviews.iter().filter(|r| r.patch_id == patch_id).collect();
    let blocked: Vec<String> = current
        .iter()
        .filter(|r| r.blocking > 0)
        .map(|r| format!("{} ({})", r.task_id, r.blocking))
        .collect();
    if !blocked.is_empty() {
        return not_ready(
            true,
            format!(
                "blocking findings from {}; waiting for a new head",
                blocked.join(", ")
            ),
        );
    }
    if let Some(waived) = waived {
        return ready(waived.to_string());
    }
    let reviewers = current
        .iter()
        .filter(|r| r.role == ReviewRole::Reviewer)
        .map(|r| r.task_id.as_str())
        .collect::<HashSet<_>>()
        .len() as i64;
    let verified = current
        .iter()
        .any(|r| r.role == ReviewRole::Verifier && r.receipts);
    if reviewers < rule.reviewers.get() {
        return not_ready(
            false,
            format!("{reviewers}/{} clean reviews on this patch", rule.reviewers),
        );
    }
    if rule.verifier && !verified {
        return not_ready(
            false,
            "waiting for the verifier's clean verdict with receipts".into(),
        );
    }
    ready(format!(
        "tier {} reviews are clean on patch {}",
        tier_str(tier),
        &patch_id[..patch_id.len().min(12)]
    ))
}

/// A verifier's verdict counts once its task ended done with commands run and no unverified claim.
pub fn has_receipts(task: Option<&TaskView>) -> bool {
    task.is_some_and(|t| t.state == "done" && t.receipt_commands > 0 && !t.claims_unverified)
}

pub use crate::hub::executor::providers::{codex_instance, other_codex};

/// A reviewer's or verifier's prompt: the PR diff ref and the tier rules. Tasks adds the brief's goal and done-when.
/// Never the author's narrative, so the PR description and comments are off limits too.
/// `reviewed` is the head an earlier round reviewed, if any: a re-review starts from what changed since.
pub fn review_prompt(
    set: &PromptSet,
    change: &Change,
    role: ReviewRole,
    reviewed: Option<&str>,
) -> String {
    let id = if role == ReviewRole::Verifier {
        "review.verifier"
    } else {
        "review.reviewer"
    };
    let text = set.render(
        id,
        &[
            ("prUrl", &change.pr_url),
            ("repo", &change.repo),
            ("prNumber", &change.pr_number),
            ("tier", &tier_str(change.tier)),
            ("headSha", &change.head_sha),
            ("serves", &change.serves),
        ],
    );
    match reviewed.filter(|sha| *sha != change.head_sha.as_str()) {
        Some(sha) => {
            let delta = fixed::render(
                fixed::REVIEW_DELTA,
                &[
                    ("reviewedSha", &sha),
                    ("headSha", &change.head_sha),
                    ("serves", &change.serves),
                ],
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
pub fn findings_message(change: &Change, v: &FindingsVerdict<'_>) -> String {
    fix_your_pr(
        change.pr_url.as_str(),
        None,
        change.branch.as_str(),
        &FixPr::Review {
            review_task: v.task_id,
            head_sha: v.pr_head_sha,
            blocking: v.blocking,
            non_blocking: v.non_blocking,
            summary: v.summary,
        },
    )
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
    use std::sync::LazyLock;

    const P: &str = "1111111111111111111111111111111111111111";
    const Q: &str = "2222222222222222222222222222222222222222";
    static S: LazyLock<ReviewRule> = LazyLock::new(|| coded_rules()[0].clone());
    static M: LazyLock<ReviewRule> = LazyLock::new(|| coded_rules()[1].clone());
    static L: LazyLock<ReviewRule> = LazyLock::new(|| coded_rules()[2].clone());

    fn review(
        task_id: &str,
        role: ReviewRole,
        blocking: i64,
        patch_id: &str,
        receipts: bool,
    ) -> RoleReview {
        RoleReview {
            task_id: task_id.into(),
            role,
            patch_id: patch_id.into(),
            blocking,
            receipts,
        }
    }
    fn reviewer(task_id: &str) -> RoleReview {
        review(task_id, ReviewRole::Reviewer, 0, P, false)
    }
    fn verifier(task_id: &str) -> RoleReview {
        review(task_id, ReviewRole::Verifier, 0, P, true)
    }
    fn names(plan: &[PlannedReview]) -> Vec<String> {
        plan.iter()
            .map(|p| {
                format!(
                    "{}/{}",
                    p.role.as_str(),
                    if p.provider == ReviewProvider::Codex {
                        "codex"
                    } else {
                        "claude"
                    }
                )
            })
            .collect()
    }

    #[test]
    fn plans_none_for_s_one_for_m_and_two_plus_a_verifier_for_l_with_codex_second() {
        assert!(review_plan(&S, true).is_empty());
        assert_eq!(names(&review_plan(&M, true)), ["reviewer/claude"]);
        assert_eq!(
            names(&review_plan(&L, true)),
            ["reviewer/claude", "reviewer/codex", "verifier/claude"]
        );
        assert_eq!(
            names(&review_plan(&L, false)),
            ["reviewer/claude", "reviewer/claude", "verifier/claude"]
        );
        assert_eq!(
            names(&missing_reviews(
                &review_plan(&L, true),
                &[ReviewRole::Reviewer]
            )),
            ["reviewer/codex", "verifier/claude"]
        );
        assert!(
            missing_reviews(
                &review_plan(&L, true),
                &[
                    ReviewRole::Reviewer,
                    ReviewRole::Verifier,
                    ReviewRole::Reviewer
                ]
            )
            .is_empty()
        );
    }

    #[test]
    fn is_ready_only_with_the_tiers_clean_verdicts_bound_to_the_current_patch() {
        assert!(gate(Tier::S, &S, None, &[], None).ready);
        let g = gate(Tier::M, &M, Some(P), &[], None);
        assert!(!g.ready && !g.waiting_for_head);
        assert!(gate(Tier::M, &M, Some(P), &[reviewer("T2")], None).ready);
        // A clean review of another patch counts for nothing.
        assert!(!gate(Tier::M, &M, Some(Q), &[reviewer("T2")], None).ready);

        let two = [reviewer("T2"), reviewer("T3")];
        assert_eq!(
            gate(Tier::L, &L, Some(P), &two, None).why,
            "waiting for the verifier's clean verdict with receipts"
        );
        let unreceipted = [
            two.clone().as_slice(),
            &[review("T4", ReviewRole::Verifier, 0, P, false)],
        ]
        .concat();
        assert!(!gate(Tier::L, &L, Some(P), &unreceipted, None).ready);
        assert!(
            gate(
                Tier::L,
                &L,
                Some(P),
                &[two.as_slice(), &[verifier("T4")]].concat(),
                None
            )
            .ready
        );
        // The same reviewer twice is one review.
        assert!(
            !gate(
                Tier::L,
                &L,
                Some(P),
                &[reviewer("T2"), reviewer("T2"), verifier("T4")],
                None
            )
            .ready
        );
    }

    #[test]
    fn holds_a_patch_with_any_blocking_verdict_until_the_patch_changes_and_lets_a_waiver_through() {
        let blocked = gate(
            Tier::M,
            &M,
            Some(P),
            &[
                review("T2", ReviewRole::Reviewer, 2, P, false),
                reviewer("T3"),
            ],
            None,
        );
        assert_eq!(
            blocked,
            Gate {
                ready: false,
                waiting_for_head: true,
                why: "blocking findings from T2 (2); waiting for a new head".into()
            }
        );
        assert!(
            gate(
                Tier::M,
                &M,
                Some(Q),
                &[
                    review("T2", ReviewRole::Reviewer, 2, P, false),
                    review("T5", ReviewRole::Reviewer, 0, Q, false)
                ],
                None
            )
            .ready
        );
        assert!(gate(Tier::M, &M, Some(Q), &[], Some("waived")).ready);
    }

    #[test]
    fn takes_the_pinned_playbooks_rule_and_gates_on_it() {
        let strict = PlaybookView {
            require_source: true,
            review_rules: [
                rule(1, false, false),
                rule(2, true, false),
                rule(3, true, true),
            ],
        };
        assert_eq!(rule_for(Tier::M, Some(&strict)), strict.review_rules[1]);
        assert_eq!(rule_for(Tier::M, None), *M);
        assert_eq!(
            names(&review_plan(&rule_for(Tier::S, Some(&strict)), false)),
            ["reviewer/claude"]
        );
        assert_eq!(
            names(&review_plan(&strict.review_rules[2], true)),
            [
                "reviewer/claude",
                "reviewer/codex",
                "reviewer/claude",
                "verifier/claude"
            ]
        );

        let (ss, sm) = (
            strict.review_rules[0].clone(),
            strict.review_rules[1].clone(),
        );
        // A playbook that reviews S: tier S is no longer ready by itself.
        assert_eq!(
            gate(Tier::S, &ss, Some(P), &[], None).why,
            "0/1 clean reviews on this patch"
        );
        assert!(gate(Tier::S, &ss, Some(P), &[reviewer("T2")], None).ready);
        assert!(!gate(Tier::M, &sm, Some(P), &[reviewer("T2")], None).ready);
        assert_eq!(
            gate(
                Tier::M,
                &sm,
                Some(P),
                &[reviewer("T2"), reviewer("T3")],
                None
            )
            .why,
            "waiting for the verifier's clean verdict with receipts"
        );
        assert!(
            gate(
                Tier::M,
                &sm,
                Some(P),
                &[reviewer("T2"), reviewer("T3"), verifier("T4")],
                None
            )
            .ready
        );
        // And one that waives M review lets it through with none.
        assert_eq!(
            gate(Tier::M, &rule(0, false, false), None, &[], None),
            ready("tier M needs no review".into())
        );
    }

    #[test]
    fn uses_only_a_usable_fleetd_codex_instance_with_a_model() {
        use crate::hub::train::host::ProviderView;
        let p = |id: &str, driver: &str, usable: bool, model: Option<&str>| ProviderView {
            instance_id: id.into(),
            driver: driver.into(),
            usable,
            models: model.into_iter().map(String::from).collect(),
            default_model: model.map(String::from),
        };
        let claude = p("fleetd", "claudeAgent", true, Some("claude-opus-5-5"));
        let codex = p("fleetd-codex", "codex", true, Some("gpt-6-astra"));
        let theirs = p("codex", "codex", true, Some("gpt-6-astra"));
        assert_eq!(
            codex_instance(&[claude.clone(), codex.clone()]).map(|i| i.instance_id.as_str()),
            Some("fleetd-codex")
        );
        assert!(codex_instance(std::slice::from_ref(&claude)).is_none());
        assert!(
            codex_instance(&[claude.clone(), p("fleetd-codex", "codex", false, Some("x"))])
                .is_none()
        );
        assert!(
            codex_instance(&[claude.clone(), p("fleetd-codex", "codex", true, None)]).is_none()
        );
        assert!(codex_instance(&[claude.clone(), theirs.clone()]).is_none());
        assert_eq!(other_codex(&[claude, theirs, codex]), ["codex"]);
    }
}

#[cfg(test)]
mod delta_tests {
    use super::*;

    fn change(head: &str) -> Change {
        serde_json::from_value(serde_json::json!({
            "changeId": "X1", "projectRef": { "machineId": "m", "projectId": "p" }, "repo": "acme/app",
            "prNumber": 7, "prUrl": "https://github.com/acme/app/pull/7", "branch": "fleetd/T1",
            "workstreamId": "W1", "serves": "done:0", "tier": "M", "headSha": head, "state": "reviewing",
            "reviews": [], "createdAt": "2026-10-19T10:00:00.000Z", "updatedAt": "2026-10-19T10:00:00.000Z",
        }))
        .unwrap()
    }

    #[test]
    fn a_re_review_starts_from_the_delta_at_the_same_bar() {
        let (old, new) = ("a".repeat(40), "b".repeat(40));
        let set = PromptSet::defaults();
        let first = review_prompt(set, &change(&new), ReviewRole::Reviewer, None);
        assert!(!first.contains("reviewed before"));
        let again = review_prompt(set, &change(&new), ReviewRole::Reviewer, Some(&old));
        assert!(again.starts_with(&first), "the full review text stays");
        assert!(
            again.contains(&format!("git range-diff {old}...{new}")),
            "{again}"
        );
        assert!(again.contains("blocking only for what is wrong, unsafe or fails done:0"));
        // The same head reviewed again is no delta.
        assert_eq!(
            review_prompt(set, &change(&new), ReviewRole::Reviewer, Some(&new)),
            first
        );
    }
}
