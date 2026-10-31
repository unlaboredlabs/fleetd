//! `wait_ci` over a real hub with a fake node and fake GitHub reads: a task waits on a run or a PR of its project, is
//! woken with one line once it finishes and not before, and a run of another repo, a URL that is no run or PR and a
//! lead's call are refused.
use std::collections::HashMap;
use std::sync::Mutex;

use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::sessions::SessionCall;
use fleetd_contracts::tasks::TaskId;
use serde_json::json;
use tokio::sync::mpsc;

use super::cap_tests::{AT, Node, hub, running};
use super::ci_wait::{CiReads, Read, Target, summary, target_of};
use super::guard_tests::{insert, serve};
use crate::hub::api::Hub;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::work::BoxFut;

const RUN: &str = "https://github.com/acme/shop/actions/runs/4242";
const PR: &str = "https://github.com/acme/shop/pull/7";

/// GitHub as the test sets it: each target's read, running until set.
#[derive(Default)]
struct Reads(Mutex<HashMap<String, Result<Read, String>>>);

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
}

impl CiReads for Reads {
    fn read<'a>(&'a self, target: &'a Target) -> BoxFut<'a, Result<Read, String>> {
        let read = self.0.lock().unwrap().get(&target.url()).cloned();
        Box::pin(async move { read.unwrap_or(Ok(Read::Running)) })
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
    let call: LeadCall = serde_json::from_value(json!({ "op": "wait_ci", "url": url })).unwrap();
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
