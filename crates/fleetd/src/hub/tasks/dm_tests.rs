//! Agents write to each other (`agent_message`), over a real hub with a fake node: a running agent takes a message at
//! its next tool boundary, one that has ended keeps it for the turn something else starts (a Monitor of its own, its
//! wait_ci, its lead), and only a question it waits on lets another agent continue it.
use std::sync::Arc;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::AgentMessageResult;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::sessions::SessionCall;
use fleetd_contracts::steer::{AgentMessage, AgentMessageOutcome as Outcome, Steer, SteerBy};
use fleetd_contracts::tasks::{Task, TaskId, TaskState};
use tokio::sync::mpsc;

use super::TaskCaller;
use super::cap_tests::{Node, hub, running};
use super::race_tests::{catch_up, frame, logged, sent, serve, task};
use crate::hub::api::{Hub, ToolError};
use crate::hub::steer::{dm, store};

async fn dm(
    hub: &Hub,
    from: &Task,
    to: &[&str],
    text: &str,
) -> Result<AgentMessageResult, ToolError> {
    let to: Vec<TaskId> = to.iter().map(|t| TaskId::unchecked(*t)).collect();
    dm::send(hub, from, &to, text).await
}

fn steer_of(hub: &Hub, sent: &AgentMessageResult, pos: usize) -> Steer {
    let n: i64 = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT steer_n FROM agent_message_to WHERE message_n = ? AND pos = ?",
                rusqlite::params![sent.message_id.n(), pos as i64],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    store::get(&hub.db, &fleetd_contracts::steer::SteerId::from_n(n))
        .unwrap()
        .unwrap()
        .0
}

fn listed(hub: &Hub, r: &ProjectRef) -> Vec<AgentMessage> {
    dm::list(&hub.db, r, None, None, 50).unwrap().messages
}

/// The node's update of session t1, its latest run `run` in `status`, as race_tests' `push`.
fn push(hub: &Hub, seq: u64, run: &str, status: &str) {
    let active = status == "running";
    let mut event = serde_json::json!({ "type": "session_updated", "sessionId": "t1", "projectId": "p1",
        "title": "t1", "status": if active { "running" } else { "idle" }, "model": "claude-haiku-5-5",
        "effort": "low", "runtimeMode": "approval-required",
        "latestRun": { "id": run, "status": status, "ordinal": 1 },
        "createdAt": super::cap_tests::AT, "updatedAt": super::cap_tests::AT });
    if active {
        event["activeRunId"] = serde_json::json!(run);
    }
    frame(
        hub,
        serde_json::json!({ "t": "machine_event", "seq": seq, "at": super::cap_tests::AT, "event": event }),
    );
}

/// T1 ran turn r1 and ended it.
async fn ended(hub: &Arc<Hub>) {
    push(hub, 1, "r1", "running");
    push(hub, 2, "r1", "completed");
    logged(hub, "thread.completed", "r1").await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(hub).state, TaskState::Done);
}

/// Every call the node was sent so far that is a send.
fn sends(calls: &mut mpsc::UnboundedReceiver<SessionCall>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(call) = calls.try_recv() {
        if let SessionCall::Send { text, .. } = call {
            out.push(text.as_str().to_owned());
        }
    }
    out
}

#[tokio::test]
async fn a_message_to_a_running_agent_is_a_peers_note_and_its_lead_gets_a_quiet_copy() {
    let (hub, _home) = hub();
    let _calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    let from = running(&hub, 2);
    let sent_dm = dm(&hub, &from, &["T1"], "My PR #42 renames upload_limit")
        .await
        .unwrap();
    assert_eq!(sent_dm.message_id.as_str(), "M1");
    assert_eq!(sent_dm.to[0].outcome, Outcome::Delivered);
    let steer = steer_of(&hub, &sent_dm, 0);
    assert_eq!(
        steer.by,
        SteerBy::Agent {
            task_id: TaskId::unchecked("T2"),
            message_id: Some(sent_dm.message_id.clone()),
        }
    );
    let text: String = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT message FROM steers WHERE n = ?",
                [steer.id.n()],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert!(
        text.starts_with(
            "M1 · T2 (slice 2) writes to you (T1 (read) for W1): 'My PR #42 renames upload_limit'"
        ),
        "{text}"
    );
    assert!(
        text.contains("your brief and your lead outrank it"),
        "{text}"
    );
    // Quiet: it rides along with the lead's next wake, and wakes no one by itself.
    let r = from.project_ref.clone();
    assert_eq!(
        hub.leads.wakes.held(&r),
        ["- T2 → T1 (M1): \"My PR #42 renames upload_limit\""]
    );
    // The person's audit: the event names the project, and the read has it whole.
    let (project, data): (String, String) = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT json_extract(data, '$.projectId'), json_extract(data, '$.data') FROM events WHERE type = 'agent.messaged'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(project, "p1");
    let data: serde_json::Value = serde_json::from_str(&data).unwrap();
    assert_eq!(data["messageId"], "M1");
    assert_eq!(data["to"][0]["outcome"], "delivered");
    let all = listed(&hub, &r);
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].text, "My PR #42 renames upload_limit");
    assert_eq!(all[0].from.title.as_deref(), Some("slice 2"));
    assert_eq!(all[0].to[0].at, None);
    // Its claude takes it in: delivered at that time, and an update for the apps.
    let mut taken = steer.clone();
    taken.stage = fleetd_contracts::steer::SteerStage::Delivered;
    taken.delivered_at = Some("2026-11-08T10:00:00.000Z".into());
    dm::on_steer(&hub, &taken);
    assert_eq!(
        listed(&hub, &r)[0].to[0].at.as_ref().map(|t| t.as_str()),
        Some("2026-11-08T10:00:00.000Z")
    );
    let updates: i64 = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM events WHERE type = 'agent.message_updated' AND json_extract(data, '$.projectId') = 'p1'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(updates, 1);
}

/// T2606 found a message held for an agent that ended its turn on a Monitor never reached it: the turn the Monitor
/// starts is the node's, not one the hub sends. The hub now gives it the held message as that turn starts.
#[tokio::test]
async fn a_message_to_a_finished_agent_never_restarts_it_and_goes_in_when_its_monitor_wakes_it() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    let from = running(&hub, 2);
    ended(&hub).await;
    let _ = sends(&mut calls);

    let sent_dm = dm(&hub, &from, &["T1"], "Use 1001, not 1012")
        .await
        .unwrap();
    let to = &sent_dm.to[0];
    assert_eq!(to.outcome, Outcome::NotWoken);
    assert!(
        to.detail
            .as_deref()
            .unwrap()
            .starts_with("T1 has finished and isn't waiting on T2"),
        "{:?}",
        to.detail
    );
    assert!(sent_dm.next.as_deref().unwrap().contains("ask your lead"));
    // Not restarted: no run went out, and it takes no slot.
    tokio::task::yield_now().await;
    assert!(sends(&mut calls).is_empty());
    let t1 = task(&hub);
    assert_eq!((t1.state, t1.attempt.get()), (TaskState::Done, 1));
    assert_eq!(store::held_for_task(&hub.db, "T1").unwrap().len(), 1);

    // Its Monitor fires: claude starts a turn of its own, and the held message goes into it.
    let woke = "t1-woke-1792000060000-1";
    push(&hub, 3, woke, "running");
    logged(&hub, "thread.started", woke).await;
    catch_up(&hub.tasks).await;
    assert_eq!(task(&hub).state, TaskState::Running);
    let (run, text) = sent(&mut calls).await;
    assert!(text.contains("T2 (slice 2) writes to you"), "{text}");
    assert!(text.contains("'Use 1001, not 1012'"), "{text}");
    let now = steer_of(&hub, &sent_dm, 0);
    assert_eq!(now.held, None);
    assert_eq!(now.run_id.as_str(), run);
    assert!(store::held_for_task(&hub.db, "T1").unwrap().is_empty());
    // It reads not woken until its claude takes it in.
    assert_eq!(
        listed(&hub, &from.project_ref)[0].to[0].outcome,
        Outcome::NotWoken
    );
}

#[tokio::test]
async fn a_wait_ci_wake_carries_the_messages_held_for_it_first() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    let from = running(&hub, 2);
    ended(&hub).await;
    let sent_dm = dm(&hub, &from, &["T1"], "#7 needs my seam in #8")
        .await
        .unwrap();
    assert_eq!(sent_dm.to[0].outcome, Outcome::NotWoken);
    let _ = sends(&mut calls);

    // What wait_ci sends when the PR it waits on merges.
    let caller = TaskCaller {
        project_ref: from.project_ref.clone(),
        by: "ci".into(),
    };
    hub.tasks
        .message(&caller, &TaskId::unchecked("T1"), "PR #7 merged.")
        .await
        .unwrap();
    let (run, text) = sent(&mut calls).await;
    let (dm_at, ci_at) = (
        text.find("'#7 needs my seam in #8'").unwrap(),
        text.find("PR #7 merged.").unwrap(),
    );
    assert!(dm_at < ci_at, "{text}");
    let now = steer_of(&hub, &sent_dm, 0);
    assert_eq!((now.held, now.run_id.as_str()), (None, run.as_str()));
}

#[tokio::test]
async fn a_message_continues_a_finished_agent_only_when_it_waits_for_an_answer() {
    let (hub, _home) = hub();
    let mut calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    let from = running(&hub, 2);
    hub.tasks
        .ask_lead(&TaskId::unchecked("T1"), "Which close code does iOS take?")
        .unwrap();
    ended(&hub).await;
    let _ = sends(&mut calls);

    let sent_dm = dm(&hub, &from, &["T1"], "1001: SocketRocket rejects 1012")
        .await
        .unwrap();
    assert_eq!(sent_dm.to[0].outcome, Outcome::Woke);
    let (run, text) = sent(&mut calls).await;
    assert!(text.contains("'1001: SocketRocket rejects 1012'"), "{text}");
    let now = steer_of(&hub, &sent_dm, 0);
    assert_eq!((now.held, now.run_id.as_str()), (None, run.as_str()));
    assert_eq!(task(&hub).attempt.get(), 2);
}

#[tokio::test]
async fn one_message_reaches_each_of_its_recipients_and_refuses_those_outside_the_project() {
    let (hub, _home) = hub();
    let _calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    let from = running(&hub, 2);
    running(&hub, 3);
    let sent_dm = dm(
        &hub,
        &from,
        &["T1", "T3", "T1", "T9", "T2"],
        "rebase on #42",
    )
    .await
    .unwrap();
    let outcomes: Vec<(&str, Outcome)> = sent_dm
        .to
        .iter()
        .map(|t| (t.task_id.as_str(), t.outcome))
        .collect();
    assert_eq!(
        outcomes,
        [
            ("T1", Outcome::Delivered),
            ("T3", Outcome::Delivered),
            ("T9", Outcome::Refused),
            ("T2", Outcome::Refused),
        ]
    );
    assert_eq!(sent_dm.to[2].title, None);
    // One message, read by either side of it.
    let r = from.project_ref.clone();
    for who in ["T2", "T3"] {
        let page = dm::list(&hub.db, &r, Some(&TaskId::unchecked(who)), None, 50).unwrap();
        assert_eq!((page.messages.len(), page.total), (1, 1), "{who}");
    }
    let elsewhere = ProjectRef {
        project_id: fleetd_contracts::ids::ProjectId::unchecked("p2"),
        ..r.clone()
    };
    assert!(listed(&hub, &elsewhere).is_empty());
    let mut outside = from.clone();
    outside.project_ref = elsewhere;
    let refused = dm(&hub, &outside, &["T1"], "hi").await.unwrap();
    assert_eq!(refused.to[0].outcome, Outcome::Refused);
    assert!(
        refused.to[0]
            .detail
            .as_deref()
            .unwrap()
            .contains("no agent T1 in your project"),
        "{:?}",
        refused.to[0].detail
    );
}

#[tokio::test]
async fn an_agents_messages_reach_at_most_20_agents_a_minute_and_page_newest_first() {
    let (hub, _home) = hub();
    let _calls = serve(&hub, Node::link(&hub).await);
    running(&hub, 1);
    let from = running(&hub, 2);
    for i in 0..dm::PER_MINUTE {
        dm(&hub, &from, &["T1"], &format!("note {i}"))
            .await
            .unwrap();
    }
    let refused = dm(&hub, &from, &["T1"], "one more").await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Forbidden);
    assert!(refused.fix.as_deref().unwrap().contains("ask_lead"));

    let r = from.project_ref.clone();
    let first = dm::list(&hub.db, &r, None, None, 15).unwrap();
    assert_eq!(
        (first.messages.len(), first.more, first.total),
        (15, true, 20)
    );
    assert_eq!(first.messages[0].id.as_str(), "M20");
    let oldest = first.messages.last().unwrap().id.clone();
    let rest = dm::list(&hub.db, &r, None, Some(&oldest), 15).unwrap();
    assert_eq!((rest.messages.len(), rest.more), (5, false));
    assert_eq!(rest.messages[0].id.as_str(), "M5");
}
