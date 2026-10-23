//! Prompts a release retired: merged into another, replaced by facts the code fills in, or made obsolete by the lead
//! chat or a feature that went. An override of one is never applied and never deleted by fleetd: `prompts_list`
//! returns it under `orphans`, so the human can copy what they wrote into the prompt that holds it now, and
//! `prompt_reset` on its id deletes it.
//!
//! None is migrated by itself: its words now sit in another prompt, where pasting them in blind would be wrong more
//! often than right.

pub struct Retired {
    pub id: &'static str,
    pub title: &'static str,
    pub why: &'static str,
    /// The editable prompt that now covers what this one said.
    pub target: Option<&'static str>,
}

const STATE: &str = "the state block at the top of the lead's messages is fixed text now";
const EVENTS: &str = "wakes are a fixed event format now, one line per event";
const CHAT: &str = "the lead hears the human in its chat now";
const DENIED: &str = "one Tool call denied prompt, with the reason filled in, replaces it";
const FIX_PR: &str = "one Fix your PR prompt replaces it";
const LATE: &str = "a late or held wake is your own wake text, with how late it is in front";
const STALL: &str =
    "a stalled run fails and its lead decides whether to continue it; nothing nudges it";
const ROUTER: &str = "one lead per project: an order goes to its project's lead, no router";
const HEADLINE: &str = "the status view has no generated headline";
const RETRO: &str = "fleetd no longer runs a retro; edit the lead prompt or a playbook yourself";
const CLOSE: &str = "fleetd no longer checks a claim of done; the lead closes work and says why";
const PLAYBOOK: &str = "the playbooks are sections of the lead prompt now; this file's rules still apply, its instructions don't";
const ONE_REVIEW: &str = "every PR gets one fresh reviewer now, and nothing verifies it apart";
const PLAN: &str =
    "the lead sets a workstream's items with one plan call; nothing nags it about item sizes";
const FINISH_ALL: &str =
    "finish-all went: a lead lists the open work and opens an order per item itself";

const fn r(
    id: &'static str,
    title: &'static str,
    why: &'static str,
    target: Option<&'static str>,
) -> Retired {
    Retired {
        id,
        title,
        why,
        target,
    }
}

pub const RETIRED: &[Retired] = &[
    r(
        "lead.digest",
        "Lead: project digest",
        STATE,
        Some("lead.start"),
    ),
    r(
        "digest.workstream.no_brief",
        "Digest: order without a brief",
        STATE,
        Some("lead.start"),
    ),
    r(
        "digest.finish_all_idle",
        "Digest: finish-all is idle",
        FINISH_ALL,
        Some("lead.start"),
    ),
    r(
        "digest.answer.withdrawn",
        "Digest: an ask the human dropped",
        CHAT,
        Some("lead.start"),
    ),
    r(
        "digest.answer.skipped",
        "Digest: an ask the human skipped for now",
        CHAT,
        Some("lead.start"),
    ),
    r(
        "digest.tasks.running",
        "Digest: running task",
        STATE,
        Some("lead.start"),
    ),
    r(
        "digest.tasks.idle",
        "Digest: task waiting for input",
        STATE,
        Some("lead.start"),
    ),
    r(
        "digest.tasks.queued",
        "Digest: queued task",
        STATE,
        Some("lead.start"),
    ),
    r(
        "digest.tasks.ended",
        "Digest: task ended",
        STATE,
        Some("lead.start"),
    ),
    r(
        "digest.train.repo",
        "Digest: a repo's merge train",
        STATE,
        Some("lead.start"),
    ),
    r(
        "digest.train.merged",
        "Digest: merged PR",
        STATE,
        Some("lead.start"),
    ),
    r(
        "digest.train.parked",
        "Digest: PR back with its author",
        STATE,
        Some("lead.start"),
    ),
    r(
        "digest.train.waived",
        "Digest: waived PR",
        STATE,
        Some("lead.start"),
    ),
    r("wake.frame", "Wake: frame", STATE, Some("lead.wake")),
    r("wake.intent", "Wake: new order", EVENTS, Some("lead.start")),
    r(
        "wake.intent.playbook",
        "Wake: the order's playbook",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.intent.playbook_listed",
        "Wake: the order's playbook, listed above",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.decision",
        "Wake: a human decision",
        CHAT,
        Some("lead.start"),
    ),
    r("wake.answers", "Wake: answers", CHAT, Some("lead.start")),
    r(
        "wake.task_result",
        "Wake: task finished",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.task_cancelled",
        "Wake: task cancelled",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.task_waiting",
        "Wake: task asks a question",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.task_start_failed",
        "Task could not start",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.claim_failed",
        "Wake: claim failed",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.claim_passed",
        "Wake: claim passed",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.train.line",
        "Wake: train message for the lead",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.train.left",
        "Wake: PR left the train",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.train.merged",
        "Wake: PR merged",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.train.gave_up",
        "Wake: train gave up",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.train.refused",
        "Wake: train refused a PR",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.research_verdict.go",
        "Wake: research verdict GO",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.research_verdict.stop",
        "Wake: research verdict STOP",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.research_verdict.inconclusive",
        "Wake: research verdict INCONCLUSIVE",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.agent_steer",
        "Wake: the human steered one of your tasks directly",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.order_refs",
        "Wake: what came with a new order",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.order_stopped",
        "Wake: the human stopped an order",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.runnable",
        "Wake: a free slot and approved work",
        EVENTS,
        Some("lead.start"),
    ),
    r(
        "wake.order_idle",
        "Wake: an order nobody works on",
        EVENTS,
        Some("lead.start"),
    ),
    r("wake.scheduled_late", "Scheduled wake, late", LATE, None),
    r(
        "wake.scheduled_held",
        "Scheduled wake, held by a usage pause",
        LATE,
        None,
    ),
    r(
        "task.review_findings",
        "Blocking findings to the author",
        FIX_PR,
        Some("pr.fix"),
    ),
    r(
        "task.train_rebase",
        "PR needs a rebase",
        FIX_PR,
        Some("pr.fix"),
    ),
    r(
        "task.train_ci_failed",
        "PR's CI is red",
        FIX_PR,
        Some("pr.fix"),
    ),
    r("watchdog.nudge", "Stall nudge", STALL, None),
    r(
        "plan.granularity",
        "Plan item too big or unsized",
        PLAN,
        None,
    ),
    r(
        "permission.denied.policy",
        "Tool denied by policy",
        DENIED,
        Some("tool.denied"),
    ),
    r(
        "permission.denied.withdrawn",
        "Tool ask withdrawn",
        DENIED,
        Some("tool.denied"),
    ),
    r(
        "permission.denied.human",
        "Tool denied by the human",
        DENIED,
        Some("tool.denied"),
    ),
    r(
        "permission.denied.answer",
        "Tool denied with thread_answer",
        DENIED,
        Some("tool.denied"),
    ),
    r("router", "Order router", ROUTER, None),
    r("status.headline", "Status headline", HEADLINE, None),
    r("router.retry", "Order router, second try", ROUTER, None),
    r("retro", "Retro / triage", RETRO, None),
    r("judge", "Judge", CLOSE, None),
    r("judge.research", "Research judge", CLOSE, None),
    r(
        "playbook.bugfix",
        "Playbook: bugfix",
        PLAYBOOK,
        Some("lead.start"),
    ),
    r(
        "playbook.feature",
        "Playbook: feature",
        PLAYBOOK,
        Some("lead.start"),
    ),
    r(
        "playbook.research",
        "Playbook: research",
        PLAYBOOK,
        Some("lead.start"),
    ),
    r(
        "playbook.finish-all",
        "Playbook: finish-all",
        FINISH_ALL,
        Some("lead.start"),
    ),
    r(
        "review.verifier",
        "Verifier",
        ONE_REVIEW,
        Some("review.reviewer"),
    ),
];

pub fn get(id: &str) -> Option<&'static Retired> {
    RETIRED.iter().find(|r| r.id == id)
}

impl Retired {
    /// A playbook's override is its file under `<hub home>/playbooks`, hub-wide only.
    pub fn playbook(&self) -> Option<&'static str> {
        self.id.strip_prefix("playbook.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::prompts::registry::{ENTRIES, get as registry_get};

    #[test]
    fn retired_ids_are_gone_from_the_registry_and_point_at_live_prompts() {
        for r in RETIRED {
            assert!(registry_get(r.id).is_none(), "{} is retired and live", r.id);
            if let Some(t) = r.target {
                assert!(registry_get(t).is_some(), "{} points at {t}", r.id);
            }
        }
        assert_eq!(
            ENTRIES.len() + RETIRED.len(),
            77,
            "the 69 prompts of an earlier release, lead.profiles, and eight fixed texts made prompts"
        );
    }
}
