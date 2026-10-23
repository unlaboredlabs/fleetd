//! The board join: one order's tasks, PRs and requests become a card with roles, PR links, counts and a phase.
use std::collections::HashMap;

use fleetd_contracts::ids::ThreadRef;
use fleetd_contracts::ledger::Workstream;
use fleetd_contracts::live::{AgentRole, LaneStatus, OrderPhase};
use fleetd_contracts::tasks::Task;
use fleetd_contracts::train::{Change, ChangeState};
use serde_json::{Value, json};

use super::*;

const AT: &str = "2026-10-18T10:00:00.000Z";

struct Fake {
    roles: HashMap<&'static str, ReviewRole>,
    threads: HashMap<&'static str, &'static str>,
}

impl Lookups for Fake {
    fn review_role(&self, task_id: &str) -> Option<ReviewRole> {
        self.roles.get(task_id).copied()
    }
    fn reviews_needed(&self, _: &Change) -> i64 {
        3
    }
    fn thread(&self, r: &ThreadRef) -> Option<ThreadSeen> {
        self.threads.get(r.thread_id.as_str()).map(|s| ThreadSeen {
            status: (*s).into(),
            ..ThreadSeen::default()
        })
    }
    fn live(&self, _: &ThreadRef) -> Option<LiveParts> {
        None
    }
}

fn workstream() -> Workstream {
    serde_json::from_value(json!({
        "workstreamId": "W14", "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "title": "Three pages",
        "source": { "text": "Three pages", "channel": "app", "by": "human", "at": AT },
        "state": "running", "headline": "waiting on reviews", "playbook": format!("feature@{}", "a".repeat(40)),
        "createdAt": AT, "updatedAt": AT,
    }))
    .unwrap()
}

fn task(id: &str, kind: &str, state: &str, extra: Value) -> Task {
    let mut t = json!({
        "taskId": id, "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "workstreamId": "W14",
        "title": format!("{id} work"), "kind": kind, "prompt": "do it", "areas": if kind == "write" { json!(["alpha"]) } else { json!([]) },
        "model": "claude-haiku-5-5", "effort": "low", "state": state, "attempt": 1, "createdAt": AT,
        "startedAt": format!("2026-10-18T10:0{}:00.000Z", &id[1..2]),
        "threadRef": { "machineId": "lab-a", "threadId": format!("s-{id}") },
    });
    if let (Value::Object(t), Value::Object(extra)) = (&mut t, extra) {
        t.extend(extra);
    }
    serde_json::from_value(t).unwrap()
}

fn change(id: &str, number: i64, task: &str, state: &str) -> Change {
    let sha = "b".repeat(40);
    let patch = "c".repeat(40);
    serde_json::from_value(json!({
        "changeId": id, "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "repo": "o/testbed",
        "prNumber": number, "prUrl": format!("https://github.com/o/testbed/pull/{number}"), "branch": format!("fleetd/{task}"),
        "taskId": task, "workstreamId": "W14", "tier": "L", "headSha": sha, "patchId": patch,
        "state": state, "createdAt": AT, "updatedAt": AT,
        "reviews": [
            { "taskId": "T5", "prHeadSha": sha, "patchId": patch, "blocking": 0, "nonBlocking": 1 },
            { "taskId": "T6", "prHeadSha": sha, "patchId": "d".repeat(40), "blocking": 0, "nonBlocking": 0 },
            { "taskId": "T7", "prHeadSha": sha, "patchId": patch, "blocking": 2, "nonBlocking": 0 },
        ],
    }))
    .unwrap()
}

#[test]
fn an_order_joins_its_agents_prs_and_asks() {
    let review_pr = json!({ "pr": "https://github.com/o/testbed/pull/12", "qa": false });
    let tasks = vec![
        task(
            "T1",
            "write",
            "done",
            json!({ "endedAt": "2026-10-18T10:05:00.000Z" }),
        ),
        task("T2", "write", "running", json!({})),
        task("T3", "review", "running", review_pr.clone()),
        task(
            "T4",
            "review",
            "queued",
            json!({ "pr": "https://github.com/o/testbed/pull/12", "queuedReason": "slots: 40/40 in use", "threadRef": null }),
        ),
        task(
            "T5",
            "review",
            "running",
            json!({ "pr": "https://github.com/o/testbed/pull/12", "qa": true }),
        ),
    ];
    let changes = vec![change("X2", 12, "T1", "reviewing")];
    let fake = Fake {
        roles: HashMap::from([("T3", ReviewRole::Reviewer), ("T4", ReviewRole::Verifier)]),
        threads: HashMap::from([
            ("s-T2", "running"),
            ("s-T3", "waiting"),
            ("s-T5", "running"),
        ]),
    };
    let w = workstream();
    let joined = card(
        &OrderParts {
            workstream: &w,
            tasks: &tasks,
            changes: &changes,
            open_requests: 0,
            lead_working: true,
        },
        &fake,
    );
    let c = &joined.card;
    // T3 waits on a permission: the order needs you even with no open request.
    assert_eq!(c.phase, OrderPhase::WaitingOnYou);
    assert_eq!(c.phase_detail.as_deref(), Some("1 approval"));
    assert_eq!((c.settled.get(), c.total.get()), (1, 5));
    assert_eq!(c.template, Some(PlaybookName::Feature));
    assert_eq!(c.next.as_deref(), Some("waiting on reviews"));
    let lanes: Vec<_> = c
        .lanes
        .iter()
        .map(|l| (l.lane_id.as_str(), l.role, l.status))
        .collect();
    // Active lanes only, newest first.
    assert_eq!(
        lanes,
        vec![
            ("T5", AgentRole::Qa, LaneStatus::Working),
            ("T4", AgentRole::Verifier, LaneStatus::Queued),
            ("T3", AgentRole::Reviewer, LaneStatus::Waiting),
            ("T2", AgentRole::Implementer, LaneStatus::Working),
        ]
    );
    let t4 = c.lanes.iter().find(|l| l.lane_id == "T4").unwrap();
    assert_eq!(t4.status_reason.as_deref(), Some("40 of 40 agents busy"));
    // Review lanes link the PR they review; the writer's finished lane links the PR it opened.
    assert_eq!(t4.pr.as_ref().map(|p| p.number.get()), Some(12));
    // Checkers are named by what they check; a writer keeps its task's title.
    let titles: Vec<_> = c.lanes.iter().map(|l| l.title.as_str()).collect();
    assert_eq!(titles, ["QA #12", "verify #12", "review #12", "T2 work"]);
    assert_eq!(joined.done.len(), 1);
    assert_eq!(joined.done[0].pr.as_ref().map(|p| p.number.get()), Some(12));
    // One clean review of the current patch: T6 reviewed an older patch, T7 found blocking issues.
    let pr = &c.prs[0];
    assert_eq!((pr.reviews_done.get(), pr.reviews_needed.get()), (1, 3));
    assert_eq!(pr.state, ChangeState::Reviewing);
}

#[test]
fn trains_list_head_then_queue_then_todays_merges() {
    let mut ci = change("X1", 10, "T1", "ci");
    ci.updated_at = "2026-10-18T10:03:00.000Z".into();
    let mut second = change("X3", 13, "T3", "queued");
    second.position = Some(Count::unchecked(1));
    let mut first = change("X2", 12, "T2", "reviewing");
    first.position = Some(Count::unchecked(0));
    let mut merged = change("X4", 9, "T4", "merged");
    merged.updated_at = "2026-10-18T09:00:00.000Z".into();
    let mut old = change("X5", 8, "T5", "merged");
    old.updated_at = "2026-10-17T23:00:00.000Z".into();
    let repo = ci.repo.clone();
    let train = train_live(
        &repo,
        false,
        None,
        &[second, merged, ci, old, first],
        "2026-10-18T00:00:00.000Z",
    );
    let chips: Vec<_> = train.chips.iter().map(|c| c.number.get()).collect();
    assert_eq!(chips, vec![10, 12, 13, 9]);
    assert_eq!(train.merged_today.get(), 1);
}

#[test]
fn a_done_order_leaves_only_its_open_prs_that_are_not_on_their_way_in() {
    let mut other = change("X9", 19, "T9", "reviewing");
    other.workstream_id = fleetd_contracts::ledger::WorkstreamId::new("W99").unwrap();
    let changes = vec![
        change("X1", 11, "T1", "reviewing"),
        change("X2", 12, "T2", "merged"),
        change("X3", 13, "T3", "ci"),
        change("X4", 14, "T4", "needs_rebase"),
        other,
    ];
    let id = fleetd_contracts::ledger::WorkstreamId::new("W14").unwrap();
    let left: Vec<i64> = crate::hub::train::service::leftovers(&changes, &id)
        .iter()
        .map(|c| c.pr_number.get())
        .collect();
    // Merged stays merged, the PR in CI may still land, another order's PR is not touched.
    assert_eq!(left, vec![11, 14]);
}

#[test]
fn cards_get_a_short_title() {
    let mut w = workstream();
    w.title = Text::unchecked(
        "Tier L. Add three short pages, lab/20261018153639/alpha.md, beta.md and gamma.md, each one paragraph on what fleetd's merge train does. One writer per page.",
    );
    assert_eq!(
        short_title(&w),
        "Add three short pages, lab/20261018153639/alpha.md…"
    );
    w.title = Text::unchecked("@storefront fix: rounding of cart totals");
    assert_eq!(short_title(&w), "rounding of cart totals");
    // Once the brief is frozen its goal names the order.
    w.brief = Some(
        serde_json::from_value(json!({ "goal": "Three pages on the merge train. One per writer.", "why": "demo", "pointers": [], "constraints": [],
            "doneWhen": [{ "type": "pr_merged", "repo": "o/testbed" }], "tier": "L" }))
        .unwrap(),
    );
    assert_eq!(short_title(&w), "Three pages on the merge train");
}

#[test]
fn an_orders_open_work_is_its_unlanded_write_work() {
    use super::open_work::{Item, select};
    let id = fleetd_contracts::ledger::WorkstreamId::new("W14").unwrap();
    let tasks = vec![
        task("T1", "write", "done", json!({ "title": "Share card" })),
        // A fix of non-blocking review findings.
        task(
            "T4",
            "write",
            "running",
            json!({ "title": "Fresh link after changes" }),
        ),
        // The original writer, continued by a message.
        task("T5", "write", "idle", json!({ "title": "Uncap counts" })),
        task(
            "T6",
            "write",
            "failed",
            json!({ "title": "Flag unpriced tokens" }),
        ),
        task("T7", "write", "cancelled", json!({})),
        task("T8", "review", "running", json!({})),
    ];
    // A review found nothing blocking; it still has not landed.
    let mut in_review = change("X1", 11, "T5", "reviewing");
    in_review.reviews.clear();
    let changes = vec![
        in_review,
        change("X2", 12, "T1", "merged"),
        change("X3", 13, "T4", "ci"),
        change("X4", 14, "T9", "needs_rebase"),
    ];

    let open = select(&id, &tasks, &changes);
    assert_eq!(
        open.iter().map(|w| w.item.clone()).collect::<Vec<_>>(),
        [
            Item::Task(fleetd_contracts::tasks::TaskId::new("T4").unwrap()),
            Item::Task(fleetd_contracts::tasks::TaskId::new("T5").unwrap()),
            Item::Task(fleetd_contracts::tasks::TaskId::new("T6").unwrap()),
            Item::Pr(fleetd_contracts::train::ChangeId::new("X1").unwrap()),
            Item::Pr(fleetd_contracts::train::ChangeId::new("X4").unwrap()),
        ],
        "never what landed, was cancelled, is on its way in, or isn't write work"
    );
    let lines: Vec<&str> = open.iter().map(|w| w.line.as_str()).collect();
    assert_eq!(
        lines,
        [
            "\"Fresh link after changes\" (running)",
            "\"Uncap counts\" (waiting for a message)",
            "\"Flag unpriced tokens\" (failed)",
            "the pull request for \"Uncap counts\" (in review)",
            "a pull request in o/testbed (needs a rebase)",
        ]
    );
    let id_like = regex::Regex::new(r"\b[TXWC][0-9]+\b|#[0-9]+").unwrap();
    assert!(
        lines.iter().all(|l| !id_like.is_match(l)),
        "plain words, no ids: {lines:?}"
    );
}

#[test]
fn the_done_sweep_keeps_unlanded_write_work_and_cancels_the_rest_unless_closed_on_purpose() {
    use super::open_work::{select, sweep};
    let id = fleetd_contracts::ledger::WorkstreamId::new("W14").unwrap();
    let tasks = vec![
        task("T3", "review", "running", json!({})),
        task("T4", "write", "running", json!({})),
    ];
    let mut open_pr = change("X1", 11, "T4", "reviewing");
    open_pr.reviews.clear();
    let changes = vec![open_pr];
    let t = |s: &str| fleetd_contracts::tasks::TaskId::new(s).unwrap();
    let x1 = fleetd_contracts::train::ChangeId::new("X1").unwrap();

    // The W1/T4 sweep: the judge goes, the fix and its PR stay, and the lead is told about them.
    let kept = sweep(&tasks, select(&id, &tasks, &changes), false);
    assert_eq!(kept.cancel, [t("T3")]);
    assert_eq!(kept.keep_prs, [x1]);
    assert_eq!(kept.kept.len(), 2);

    // Closed on purpose: all of it goes.
    let dropped = sweep(&tasks, select(&id, &tasks, &changes), true);
    assert_eq!(dropped.cancel, [t("T3"), t("T4")]);
    assert!(dropped.keep_prs.is_empty() && dropped.kept.is_empty());
}
