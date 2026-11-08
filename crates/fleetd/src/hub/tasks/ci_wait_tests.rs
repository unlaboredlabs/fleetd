//! `wait_ci` over a real hub with a fake node and fake GitHub reads: a task waits on a run or a PR of its project, is
//! woken with one line once it finishes and not before, and a run of another repo, a URL that is no run or PR and a
//! lead's call are refused. With `merged`, a PR's wait wakes its task when the PR merges, fails on the train or closes.
use std::collections::HashMap;
use std::sync::Mutex;

use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::sessions::SessionCall;
use fleetd_contracts::tasks::TaskId;
use serde_json::json;
use tokio::sync::mpsc;

use super::cap_tests::{AT, Node, hub, running};
use super::ci_wait::{CiReads, HubReads, Merge, Read, Target, summary, target_of};
use super::guard_tests::{insert, serve};
use crate::hub::api::Hub;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::work::BoxFut;
use fleetd_contracts::ids::ProjectRef;

const RUN: &str = "https://github.com/acme/shop/actions/runs/4242";
const PR: &str = "https://github.com/acme/shop/pull/7";
const PR2: &str = "https://github.com/acme/shop/pull/8";

/// GitHub as the test sets it: each target's read, running until set; and each PR's way to merging, pending until set.
#[derive(Default)]
struct Reads(
    Mutex<HashMap<String, Result<Read, String>>>,
    Mutex<HashMap<String, Merge>>,
);

impl Reads {
    fn set(&self, url: &str, read: Read) {
        self.0.lock().unwrap().insert(url.to_owned(), Ok(read));
    }

    fn fail(&self, url: &str, error: &str) {
        self.0
            .lock()
            .unwrap()
            .insert(url.to_owned(), Err(error.to_owned()));
    }

    fn merge(&self, url: &str, merge: Merge) {
        self.1.lock().unwrap().insert(url.to_owned(), merge);
    }
}

impl CiReads for Reads {
    fn read<'a>(&'a self, target: &'a Target) -> BoxFut<'a, Result<Read, String>> {
        let read = self.0.lock().unwrap().get(&target.url()).cloned();
        Box::pin(async move { read.unwrap_or(Ok(Read::Running)) })
    }

    fn merge<'a>(&'a self, _: &'a ProjectRef, target: &'a Target) -> BoxFut<'a, Merge> {
        let merge = self.1.lock().unwrap().get(&target.url()).cloned();
        Box::pin(async move { merge.unwrap_or(Merge::Pending) })
    }
}

fn failed_run() -> Read {
    Read::Finished {
        conclusion: Some("failure".into()),
        label: "CI".into(),
        failing: vec!["test (ubuntu)".into(), "site".into()],
        total: 9,
    }
}

/// p1's own repo is github.com/acme/shop.
fn shop_repo(hub: &Hub) {
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id, repo_key)
                 VALUES ('lab-a', 'p1', 'shop', 'lab-a', 'p1', 'github.com/acme/shop')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
}

fn wait(hub: &Hub, agent: CallerAgent, url: &str) -> Result<LeadCallResult, McpToolError> {
    wait_with(hub, agent, json!({ "op": "wait_ci", "url": url }))
}

/// wait_ci with `merged`.
fn wait_merged(hub: &Hub, url: &str) -> Result<LeadCallResult, McpToolError> {
    wait_with(
        hub,
        t1(),
        json!({ "op": "wait_ci", "url": url, "merged": true }),
    )
}

fn wait_with(
    hub: &Hub,
    agent: CallerAgent,
    input: serde_json::Value,
) -> Result<LeadCallResult, McpToolError> {
    let call: LeadCall = serde_json::from_value(input).unwrap();
    crate::hub::tasks::policy::check(&agent, "wait_ci")?;
    let caller = LeadCaller {
        project_ref: hub
            .tasks
            .get(&TaskId::unchecked("T1"))
            .unwrap()
            .unwrap()
            .project_ref,
        by: "lead:lab-a/p1".into(),
        agent,
    };
    let handler = hub.lead_calls.handler("wait_ci").unwrap();
    futures_util::FutureExt::now_or_never(handler.handle(caller, call)).unwrap()
}

fn t1() -> CallerAgent {
    CallerAgent::Task(TaskId::unchecked("T1"))
}

/// The texts sent to sessions so far.
fn sent(calls: &mut mpsc::UnboundedReceiver<SessionCall>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(call) = calls.try_recv() {
        if let SessionCall::Send { text, .. } = call {
            out.push(text.as_str().to_owned());
        }
    }
    out
}

#[tokio::test]
async fn a_task_waiting_on_ci_is_woken_once_with_the_outcome_when_it_finishes() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    running(&hub, 1);
    let Ok(LeadCallResult::WaitCi(asked)) = wait(&hub, t1(), &format!("{RUN}/job/99")) else {
        panic!("wait_ci was not answered")
    };
    assert_eq!(asked.url.as_str(), RUN);
    assert!(wait(&hub, t1(), PR).is_ok());

    let reads = Reads::default();
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0, "both still run");
    assert!(sent(&mut calls).is_empty());

    reads.set(RUN, failed_run());
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    assert_eq!(
        sent(&mut calls),
        [format!(
            "CI you waited on (wait_ci) finished: {RUN} (CI) ended failure: 2 of 9 jobs failed: test (ubuntu), site."
        )]
    );
    // Each wait wakes its task once.
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);

    reads.set(
        PR,
        Read::Finished {
            conclusion: None,
            label: "3f9c2ab".into(),
            failing: vec![],
            total: 12,
        },
    );
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    assert_eq!(
        sent(&mut calls),
        [format!(
            "CI you waited on (wait_ci) finished: {PR} at 3f9c2ab: all 12 checks passed."
        )]
    );
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
}

/// W373 (#976): a PR's latest review blocked it, and its writer rebased and waits on CI: the wake names the finding,
/// still open, so the writer fixes it instead of reporting nothing open.
#[tokio::test]
async fn a_prs_ci_wake_carries_its_open_blocking_findings() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    running(&hub, 1);
    assert!(wait(&hub, t1(), PR).is_ok());
    let sha = "a".repeat(40);
    let verdict = json!({ "taskId": "T9", "prHeadSha": sha, "blocking": 1, "nonBlocking": 0, "summary": "blocking: src/checker.rs:333 trusts any answer" });
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO review_verdicts (task_id, pr_key, sha, blocking, at_ms, data) VALUES ('T9', ?1, ?2, 1, 0, ?3)",
                rusqlite::params![crate::hub::reviews::verdicts::pr_key(PR), sha, verdict.to_string()],
            )?;
            Ok(())
        })
        .unwrap();

    let reads = Reads::default();
    reads.set(
        PR,
        Read::Finished {
            conclusion: None,
            label: "3f9c2ab".into(),
            failing: vec![],
            total: 12,
        },
    );
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    let woke = sent(&mut calls);
    assert_eq!(woke.len(), 1);
    assert!(
        woke[0].starts_with(&format!(
            "CI you waited on (wait_ci) finished: {PR} at 3f9c2ab: all 12 checks passed.\n\nIts latest review's \
             blocking findings are still open"
        )) && woke[0].contains("src/checker.rs:333"),
        "{}",
        woke[0]
    );
}

#[tokio::test]
async fn wait_ci_takes_only_a_run_or_pr_of_the_tasks_project_and_only_from_a_task() {
    let (hub, _home) = hub();
    shop_repo(&hub);
    running(&hub, 1);
    let not_url = wait(&hub, t1(), "4242").unwrap_err();
    assert_eq!(not_url.code, ErrorCode::Invalid);
    assert!(not_url.fix.unwrap().contains("gh run view"));
    let elsewhere = wait(&hub, t1(), "https://github.com/other/secret/actions/runs/1").unwrap_err();
    assert_eq!(elsewhere.code, ErrorCode::Forbidden, "{elsewhere:?}");
    assert!(elsewhere.message.contains("other/secret"));
    let lead = wait(&hub, CallerAgent::Lead, RUN).unwrap_err();
    assert_eq!(lead.code, ErrorCode::Invalid);
}

/// A wait whose task was cancelled goes without a word; nothing is sent to it.
#[tokio::test]
async fn a_cancelled_tasks_wait_goes_silently() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "watch it", "state": "cancelled", "endedAt": AT }),
    );
    wait(&hub, t1(), RUN).unwrap();
    let reads = Reads::default();
    reads.set(RUN, Read::Over("is not a run GitHub has".into()));
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
    reads.set(RUN, Read::Running);
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
    assert!(sent(&mut calls).is_empty());
}

#[test]
fn a_run_or_pr_url_names_its_target_whatever_follows() {
    assert_eq!(
        target_of("https://github.com/acme/shop/actions/runs/4242/attempts/2"),
        Some(Target::Run {
            repo: "acme/shop".into(),
            id: 4242
        })
    );
    assert_eq!(
        target_of(" https://github.com/acme/shop/pull/7/checks "),
        Some(Target::Pr {
            repo: "acme/shop".into(),
            number: 7
        })
    );
    for not in [
        "https://github.com/acme/shop/actions/runs/",
        "https://github.com/acme/shop/issues/7",
        "https://gitlab.com/acme/shop/pull/7",
        "https://github.com/acme/shop/pull/0",
    ] {
        assert_eq!(target_of(not), None, "{not}");
    }
}

#[test]
fn the_line_says_the_outcome_and_names_at_most_ten_failing_jobs() {
    let run = target_of(RUN).unwrap();
    let finished = |conclusion: &str, failing: Vec<String>| Read::Finished {
        conclusion: Some(conclusion.into()),
        label: "Release".into(),
        failing,
        total: 14,
    };
    assert_eq!(summary(&run, &Read::Running), None);
    assert_eq!(
        summary(&run, &finished("success", vec![])).unwrap(),
        format!(
            "CI you waited on (wait_ci) finished: {RUN} (Release) succeeded: all 14 jobs passed."
        )
    );
    assert_eq!(
        summary(&run, &finished("cancelled", vec![])).unwrap(),
        format!("CI you waited on (wait_ci) finished: {RUN} (Release) ended cancelled.")
    );
    let many = (1..=12).map(|n| format!("j{n}")).collect();
    assert!(
        summary(&run, &finished("failure", many))
            .unwrap()
            .ends_with(
                "12 of 14 jobs failed: j1, j2, j3, j4, j5, j6, j7, j8, j9, j10, and 2 more."
            )
    );
    let pr = target_of(PR).unwrap();
    assert_eq!(
        summary(&pr, &Read::Over("was merged".into())).unwrap(),
        format!("CI you waited on (wait_ci) finished: {PR} was merged.")
    );
}

/// A wait still running after six hours wakes its task to say so, once.
#[tokio::test]
async fn a_wait_that_never_finishes_wakes_its_task_after_six_hours() {
    let clock = crate::hub::store::test_clock::ManualClock::at(1_792_000_000_000);
    let (hub, _home) = super::cap_tests::hub_on(clock.clone());
    let mut calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    running(&hub, 1);
    wait(&hub, t1(), RUN).unwrap();
    let reads = Reads::default();
    clock.advance(std::time::Duration::from_secs(6 * 3600 - 60));
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
    clock.advance(std::time::Duration::from_secs(60));
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    let said = sent(&mut calls);
    assert_eq!(said.len(), 1);
    assert!(said[0].contains("has not finished after 6 h"), "{said:?}");
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
}

/// The main case: the agent called wait_ci and ended its turn. Its task is done, and the wake continues it in its own
/// thread with the outcome.
#[tokio::test]
async fn a_task_that_ended_its_turn_is_continued_by_the_wake() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "watch the release", "state": "done", "startedAt": AT, "endedAt": AT,
                "threadRef": { "machineId": "lab-a", "threadId": "t9" },
                "result": { "status": "done", "tail": "Waiting on the release run.", "at": AT } }),
    );
    wait(&hub, t1(), RUN).unwrap();
    let reads = Reads::default();
    reads.set(RUN, failed_run());
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    // Continued in its own session t9, whose last run ended: the send carries the outcome (the task reads running
    // once the run starts).
    let mut to_t9 = Vec::new();
    while let Ok(call) = calls.try_recv() {
        if let SessionCall::Send {
            session_id, text, ..
        } = call
        {
            to_t9.push((session_id.as_str().to_owned(), text.as_str().to_owned()));
        }
    }
    assert_eq!(to_t9.len(), 1, "{to_t9:?}");
    assert_eq!(to_t9[0].0, "t9");
    assert!(
        to_t9[0]
            .1
            .contains("2 of 9 jobs failed: test (ubuntu), site."),
        "{to_t9:?}"
    );
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
}

/// A failed task stays failed: its lead decides on it, and a wake never restarts it. Its wait goes.
#[tokio::test]
async fn a_failed_tasks_wait_goes_without_restarting_it() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "watch it", "state": "failed", "endedAt": AT,
                "threadRef": { "machineId": "lab-a", "threadId": "t1" } }),
    );
    wait(&hub, t1(), RUN).unwrap();
    let reads = Reads::default();
    reads.set(RUN, failed_run());
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
    let task = hub.tasks.get(&TaskId::unchecked("T1")).unwrap().unwrap();
    assert_eq!(task.state, fleetd_contracts::tasks::TaskState::Failed);
    assert!(sent(&mut calls).is_empty());
}

/// GitHub failing is tried again; a read that works resets the count, and three failures in a row reach the task as
/// an error, once.
#[tokio::test]
async fn github_errors_are_retried_then_reach_the_task_as_an_error() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    running(&hub, 1);
    wait(&hub, t1(), RUN).unwrap();
    let reads = Reads::default();
    reads.fail(RUN, "502: Bad Gateway");
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
    reads.set(RUN, Read::Running);
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
    reads.fail(RUN, "502: Bad Gateway");
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
    assert!(sent(&mut calls).is_empty());
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    assert_eq!(
        sent(&mut calls),
        [format!(
            "CI you waited on (wait_ci) could not be read: GitHub failed 3 times in a row for {RUN} (502: Bad \
             Gateway). Look at it with `gh`, or call wait_ci again."
        )]
    );
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
}

/// A PR head reads green only once every workflow run on it ended, every check completed, and the last one a while
/// ago: a later workflow's jobs register after the first ones end.
#[test]
fn a_pr_head_is_not_green_before_its_later_jobs_register() {
    use super::ci_wait::{Check, SETTLE_MS, head_read};
    let now = 1_792_000_000_000_i64;
    let check = |name: &str, status: &str, conclusion: Option<&str>, ago: Option<i64>| Check {
        name: name.into(),
        status: status.into(),
        conclusion: conclusion.map(str::to_owned),
        completed_ms: ago.map(|a| now - a),
    };
    let done = |runs: &[&str], checks: Vec<Check>| {
        let runs: Vec<String> = runs.iter().map(|r| (*r).to_owned()).collect();
        head_read("3f9c2ab1d", &runs, &checks, now)
    };
    let lint = || check("lint", "completed", Some("success"), Some(SETTLE_MS));
    assert_eq!(done(&[], vec![]), Read::Running, "nothing registered yet");
    assert_eq!(
        done(&["completed", "queued"], vec![lint()]),
        Read::Running,
        "a workflow run whose jobs are not there yet"
    );
    assert_eq!(
        done(
            &["completed"],
            vec![lint(), check("test", "in_progress", None, None)]
        ),
        Read::Running
    );
    assert_eq!(
        done(
            &["completed"],
            vec![check("lint", "completed", Some("success"), Some(1_000))]
        ),
        Read::Running,
        "it just ended: a follow-up workflow may still start"
    );
    assert_eq!(
        done(
            &["completed", "completed"],
            vec![
                lint(),
                check("site", "completed", Some("failure"), Some(SETTLE_MS + 5))
            ]
        ),
        Read::Finished {
            conclusion: None,
            label: "3f9c2ab".into(),
            failing: vec!["site".into()],
            total: 2,
        }
    );
}

/// A task done with an open wait isn't over: its lead's wake digest lists it, with what it waits on, even after the
/// wake that reported its end, so the lead leaves it to wait_ci. The finished run wakes it, and it runs again.
#[tokio::test]
async fn a_done_task_waiting_on_ci_shows_so_in_its_leads_digest_until_the_wait_wakes_it() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "watch it", "state": "done", "startedAt": AT, "endedAt": AT,
                "threadRef": { "machineId": "lab-a", "threadId": "t9" },
                "result": { "status": "done", "tail": "Waiting on the release run.", "at": AT } }),
    );
    wait(&hub, t1(), RUN).unwrap();
    let project = super::recovery_tests::project();
    let later = Timestamp("2026-10-19T11:00:00.000Z".into());
    let lines = hub.tasks.digest_lines(&project, Some(&later), 10);
    assert_eq!(
        lines,
        [format!(
            "- T1 done: watch it; waits on CI, and wait_ci wakes it as each ends: {RUN}"
        )]
    );
    assert!(
        hub.tasks.digest_lines(&project, None, 10)[0]
            .starts_with(&format!(
                "- T1 done since your last wake: watch it; waits on CI, and wait_ci wakes it as each ends: {RUN} →"
            )),
        "{:?}",
        hub.tasks.digest_lines(&project, None, 10)
    );

    let reads = Reads::default();
    reads.set(RUN, failed_run());
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    assert_eq!(sent(&mut calls).len(), 1, "the done task is woken");
    assert_eq!(
        hub.tasks.digest_lines(&project, Some(&later), 10),
        ["- T1 running (read, high): watch it"],
        "woken, it runs, its wait gone"
    );
}

/// The lead's `agents` says the same of a done task with open waits, listed whole or by its id, until the wait ends.
#[tokio::test]
async fn the_leads_agents_list_says_a_done_task_waits_on_ci() {
    let (hub, _home) = hub();
    let _calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    insert(
        &hub,
        json!({ "taskId": "T1", "title": "watch it", "state": "done", "startedAt": AT, "endedAt": AT,
                "threadRef": { "machineId": "lab-a", "threadId": "t9" },
                "result": { "status": "done", "tail": "Waiting on the release run.", "at": AT } }),
    );
    wait(&hub, t1(), RUN).unwrap();
    wait(&hub, t1(), PR).unwrap();
    let agents = |input: serde_json::Value| {
        let call: LeadCall = serde_json::from_value(input).unwrap();
        let caller = LeadCaller {
            project_ref: super::recovery_tests::project(),
            by: "lead:lab-a/p1".into(),
            agent: CallerAgent::Lead,
        };
        let handler = hub.lead_calls.handler("task_list").unwrap();
        match futures_util::FutureExt::now_or_never(handler.handle(caller, call)).unwrap() {
            Ok(LeadCallResult::TaskList(list)) => list.next,
            other => panic!("{other:?}"),
        }
    };
    let note = format!("T1 waits on CI, and wait_ci wakes it as each ends: {RUN} {PR}.");
    assert_eq!(agents(json!({ "op": "task_list" })), Some(note.clone()));
    assert_eq!(
        agents(json!({ "op": "task_list", "taskId": "T1" })),
        Some(note)
    );

    let reads = Reads::default();
    reads.set(RUN, Read::Over("is not a run GitHub has".into()));
    reads.set(PR, Read::Over("was merged".into()));
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 2);
    assert_eq!(agents(json!({ "op": "task_list" })), None);
}

/// T1 ended its turn waiting.
fn ended_t1(hub: &Hub) {
    insert(
        hub,
        json!({ "taskId": "T1", "title": "build on the seam", "state": "done", "startedAt": AT, "endedAt": AT,
                "threadRef": { "machineId": "lab-a", "threadId": "t9" },
                "result": { "status": "done", "tail": "Waiting on #7 and #8 to merge.", "at": AT } }),
    );
}

/// W520: a writer whose next step builds on two other PRs waits on each to merge and ends its turn. Their checks
/// finishing doesn't wake it; each merge does, and once both merged nothing is left to wake it.
#[tokio::test]
async fn an_ended_task_waiting_on_two_prs_to_merge_is_woken_as_they_merge() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    ended_t1(&hub);
    let Ok(LeadCallResult::WaitCi(asked)) = wait_merged(&hub, &format!("{PR}/files")) else {
        panic!("wait_ci was not answered")
    };
    assert_eq!(asked.url.as_str(), PR);
    assert!(asked.next.unwrap().contains("when the PR merges"));
    wait_merged(&hub, PR2).unwrap();

    let reads = Reads::default();
    let green = Read::Finished {
        conclusion: None,
        label: "3f9c2ab".into(),
        failing: vec![],
        total: 12,
    };
    reads.set(PR, green.clone());
    reads.set(PR2, green);
    assert_eq!(
        hub.tasks.poll_ci_waits(&reads).await,
        0,
        "green but not merged"
    );
    assert!(sent(&mut calls).is_empty());

    reads.merge(PR, Merge::Merged);
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    reads.merge(PR2, Merge::Merged);
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    assert_eq!(
        sent(&mut calls),
        [
            format!("A PR you waited on to merge (wait_ci merged) has merged: {PR}."),
            format!("A PR you waited on to merge (wait_ci merged) has merged: {PR2}."),
        ]
    );
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0, "both waits ended");
}

/// One of the two PRs closes unmerged: the task is woken at once, told which and why, and that wait ends; the other
/// still waits. A failure on the train wakes it once and the wait goes on, as its writer fixes the PR; a new failure
/// after the PR is back on its way wakes it again.
#[tokio::test]
async fn a_merge_wait_wakes_early_when_its_pr_closes_unmerged_or_fails_on_the_train() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    ended_t1(&hub);
    wait_merged(&hub, PR).unwrap();
    wait_merged(&hub, PR2).unwrap();
    let reads = Reads::default();

    reads.merge(PR2, Merge::Over("it was closed without merging".into()));
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    assert_eq!(
        sent(&mut calls),
        [format!(
            "A PR you waited on to merge (wait_ci merged) won't merge: {PR2}: it was closed without merging. Ask \
             your lead what to build on instead."
        )]
    );
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);

    reads.merge(PR, Merge::Failed("its CI failed".into()));
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    let woke = sent(&mut calls);
    assert_eq!(woke.len(), 1);
    assert!(
        woke[0].starts_with(&format!(
            "A PR you waited on to merge (wait_ci merged) failed on the merge train: {PR}: its CI failed."
        )),
        "{woke:?}"
    );
    assert_eq!(
        hub.tasks.poll_ci_waits(&reads).await,
        0,
        "the same failure once"
    );
    // Asked again while it still fails, it isn't told again.
    wait_merged(&hub, PR).unwrap();
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
    reads.merge(PR, Merge::Pending);
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
    reads.merge(PR, Merge::Failed("its CI failed".into()));
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1, "failed again");
    reads.merge(PR, Merge::Merged);
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 1);
    assert_eq!(sent(&mut calls).len(), 2);
    assert_eq!(hub.tasks.poll_ci_waits(&reads).await, 0);
}

/// The hub's reads take a PR's merge from its Change on the merge train, which a batch merges by closing the PR:
/// merged there is merged, CI failed there is a failure.
#[tokio::test]
async fn the_hubs_merge_read_is_the_trains() {
    use fleetd_contracts::train::{Change, ChangeState};
    let (hub, _home) = hub();
    let project = super::recovery_tests::project();
    let change = |n: i64, state: &str| -> Change {
        serde_json::from_value(json!({
            "changeId": "X1", "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "repo": "acme/shop",
            "prNumber": n, "prUrl": format!("https://github.com/acme/shop/pull/{n}"),
            "branch": format!("fleetd/T{n}-seam"), "taskId": format!("T{n}"), "workstreamId": "W1",
            "headSha": "a".repeat(40), "state": state, "reviews": [],
            "createdAt": AT, "updatedAt": AT,
        }))
        .unwrap()
    };
    hub.train.records().create(change(7, "merged"));
    let failed = hub.train.records().create(change(8, "ci_failed"));
    assert_eq!(failed.state, ChangeState::CiFailed);
    let reads = HubReads(hub.clone());
    let merge = |url: &str| {
        let target = target_of(url).unwrap();
        futures_util::FutureExt::now_or_never(reads.merge(&project, &target)).unwrap()
    };
    assert_eq!(merge(PR), Merge::Merged);
    assert_eq!(merge(PR2), Merge::Failed("its CI failed".into()));
}

/// `merged` takes only a PR, and the lead's digest says a done task waits on one merging.
#[tokio::test]
async fn merged_takes_only_a_pr_and_the_digest_says_so() {
    let (hub, _home) = hub();
    let _calls = serve(&hub, Node::link(&hub).await);
    shop_repo(&hub);
    ended_t1(&hub);
    let run = wait_merged(&hub, RUN).unwrap_err();
    assert_eq!(run.code, ErrorCode::Invalid);
    assert!(run.message.contains("only a PR merges"), "{}", run.message);
    wait_merged(&hub, PR).unwrap();
    let project = super::recovery_tests::project();
    let later = Timestamp("2026-10-19T11:00:00.000Z".into());
    assert_eq!(
        hub.tasks.digest_lines(&project, Some(&later), 10),
        [format!(
            "- T1 done: build on the seam; waits on CI, and wait_ci wakes it as each ends: {PR} (until it merges)"
        )]
    );
}
