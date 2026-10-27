//! Nudges over a real in-memory hub: the lead flags the reply it just wrote (or the one still on its way into the
//! chat), the chat state lists it without the lead waiting on you, and it clears once seen, dismissed, a day old or
//! past the cap.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::chat::{ChatAuthor, ChatMessage, ChatNudgeCleared, NudgeCall};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::prim::Line;
use serde_json::json;

use super::nudge;
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen};
use crate::hub::chat::{NewMessage, history};
use crate::hub::executor::LiveParts;
use crate::hub::executor::activity::{DoneText, StreamText};
use crate::hub::leads::records::StoredLead;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, lead_by};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-19T10:00:00.000Z";
const THREAD: &str = "lead-thread";

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("app"),
    }
}

fn hub() -> (Arc<Hub>, Arc<ManualClock>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let clock = ManualClock::at(1_792_000_000_000);
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    hub.leads
        .records
        .lead_put(&StoredLead {
            project_ref: project(),
            thread_id: ThreadId::unchecked(THREAD),
            started_at: AT.into(),
            last_wake_at: None,
            session_generation: 1,
        })
        .unwrap();
    (hub, clock, home)
}

fn person() -> Caller {
    let c = serde_json::from_value::<Caller>(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "operate", "machines": "*" }],
    }))
    .unwrap();
    Caller {
        kind: Some(KeyKind::Human),
        ..c
    }
}

fn lead() -> LeadCaller {
    LeadCaller {
        project_ref: project(),
        by: lead_by(&project()),
        agent: CallerAgent::Lead,
    }
}

/// The lead's session as its node streamed it: the text streaming now, and the replies stored complete.
fn parts(text: Option<&str>, done: &[&str]) -> LiveParts {
    LiveParts {
        activity: None,
        tokens: None,
        spark: serde_json::from_value(json!({ "endAt": AT, "samples": [] })).unwrap(),
        text: text.map(|id| StreamText {
            message_id: id.into(),
            tail: "words".into(),
            total: 5,
        }),
        done: done
            .iter()
            .map(|id| DoneText {
                message_id: (*id).into(),
                text: "words".into(),
            })
            .collect(),
        run_active: true,
    }
}

/// A lead reply in the chat, as the streamer lands it: by its source.
fn reply(hub: &Hub, id: &str, text: &str) -> ChatMessage {
    hub.chat
        .add(
            &project(),
            NewMessage {
                author: Some(ChatAuthor::Lead),
                text: text.into(),
                source: Some(history::lead_source(THREAD, id)),
                ..Default::default()
            },
        )
        .unwrap()
        .0
}

fn reason(text: &str) -> NudgeCall {
    NudgeCall {
        reason: Line::new(text).unwrap(),
    }
}

/// The nudges the chat state lists: message ids and reasons, oldest first.
fn listed(hub: &Hub) -> Vec<(String, String)> {
    hub.chat
        .state(&project(), false)
        .unwrap()
        .nudges
        .map(|l| {
            l.iter()
                .map(|n| (n.message_id.to_string(), n.reason.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn cleared(hub: &Hub, m: &ChatMessage) -> Option<ChatNudgeCleared> {
    let m = hub.chat.by_id(m.message_id.as_str()).unwrap().unwrap();
    m.nudge.and_then(|n| n.cleared)
}

#[test]
fn the_lead_flags_the_reply_it_just_wrote_without_waiting_on_you() {
    let (hub, _clock, _home) = hub();
    reply(&hub, "a1", "The login fix is live.");
    let shown = reply(
        &hub,
        "a2",
        "The Machines page redesign is up: a row per machine.",
    );

    let out = nudge(&hub, &lead(), reason("the Machines page redesign"), |_| {
        Some(parts(None, &["a1", "a2"]))
    })
    .unwrap();
    assert_eq!(out.message_id.as_ref(), Some(&shown.message_id));
    assert_eq!(
        listed(&hub),
        [(
            shown.message_id.to_string(),
            "the Machines page redesign".to_owned()
        )]
    );
    // Something to look at is not something the lead waits on.
    assert!(!hub.chat.state(&project(), false).unwrap().needs_you);
    // Ranked below what it asks: a question still makes it wait, with the nudge beside it.
    reply(&hub, "a3", "1. Ship it today?");
    let state = hub.chat.state(&project(), false).unwrap();
    assert!(state.needs_you);
    assert_eq!(state.nudges.map(|l| l.len()), Some(1));
}

#[test]
fn a_reply_still_streaming_is_flagged_as_it_lands() {
    let (hub, _clock, _home) = hub();
    reply(&hub, "a1", "Earlier news.");
    let out = nudge(&hub, &lead(), reason("the new checkout"), |_| {
        Some(parts(Some("a2"), &["a1"]))
    })
    .unwrap();
    assert_eq!(out.message_id, None, "not in the chat yet");
    assert!(listed(&hub).is_empty());

    let landed = reply(&hub, "a2", "The new checkout is up.");
    assert_eq!(
        landed.nudge.as_ref().map(|n| n.reason.as_str()),
        Some("the new checkout"),
        "announced flagged"
    );
    assert_eq!(listed(&hub).len(), 1);
}

#[test]
fn only_the_lead_nudges_and_only_once_it_wrote_something() {
    let (hub, _clock, _home) = hub();
    let quiet = nudge(&hub, &lead(), reason("nothing"), |_| Some(parts(None, &[]))).unwrap_err();
    assert_eq!(quiet.code, ErrorCode::Invalid);
    assert!(quiet.fix.unwrap().contains("Write the message"));

    reply(&hub, "a1", "Done.");
    let task = LeadCaller {
        agent: CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T4")),
        ..lead()
    };
    let refused = nudge(&hub, &task, reason("mine"), |_| Some(parts(None, &["a1"]))).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Forbidden);
    assert!(listed(&hub).is_empty());
}

#[test]
fn past_three_the_oldest_nudge_goes() {
    let (hub, clock, _home) = hub();
    let mut flagged = Vec::new();
    for i in 1..=4 {
        let id = format!("a{i}");
        flagged.push(reply(&hub, &id, &format!("Showcase {i}")));
        nudge(&hub, &lead(), reason(&format!("showcase {i}")), |_| {
            Some(parts(None, &[id.as_str()]))
        })
        .unwrap();
        clock.advance(Duration::from_secs(60));
    }
    assert_eq!(
        listed(&hub)
            .iter()
            .map(|(_, r)| r.as_str())
            .collect::<Vec<_>>(),
        ["showcase 2", "showcase 3", "showcase 4"]
    );
    assert_eq!(cleared(&hub, &flagged[0]), Some(ChatNudgeCleared::Replaced));
    // Flagging one again is new news for it, not a fourth.
    nudge(&hub, &lead(), reason("showcase 2, again"), |_| {
        Some(parts(None, &["a2"]))
    })
    .unwrap();
    assert_eq!(
        listed(&hub)
            .iter()
            .map(|(_, r)| r.as_str())
            .collect::<Vec<_>>(),
        ["showcase 3", "showcase 4", "showcase 2, again"]
    );
}

#[tokio::test]
async fn a_nudge_clears_once_seen_or_dismissed_and_fades_after_a_day() {
    let (hub, clock, _home) = hub();
    let tools = crate::hub::api::registry();
    let flag = |id: &str| {
        let m = reply(&hub, id, &format!("Look at {id}"));
        let id = id.to_owned();
        nudge(&hub, &lead(), reason(&format!("look at {id}")), move |_| {
            Some(parts(None, &[id.as_str()]))
        })
        .unwrap();
        m
    };
    let seen = flag("a1");
    let dismissed = flag("a2");
    let clear = |m: &ChatMessage, dismissed: bool| json!({ "projectRef": project(), "messageId": m.message_id, "dismissed": dismissed });

    // Only a person clears one.
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..person()
    };
    let Err(CallError::Tool(e)) = tools
        .call(&hub, &agent, "chat_nudge_clear", clear(&seen, false))
        .await
    else {
        panic!("an agent cleared a nudge")
    };
    assert_eq!(e.code, ErrorCode::Forbidden);

    tools
        .call(&hub, &person(), "chat_nudge_clear", clear(&seen, false))
        .await
        .unwrap();
    tools
        .call(&hub, &person(), "chat_nudge_clear", clear(&dismissed, true))
        .await
        .unwrap();
    assert_eq!(cleared(&hub, &seen), Some(ChatNudgeCleared::Seen));
    assert_eq!(cleared(&hub, &dismissed), Some(ChatNudgeCleared::Dismissed));
    assert!(listed(&hub).is_empty());
    // Again is fine, and changes nothing.
    tools
        .call(&hub, &person(), "chat_nudge_clear", clear(&seen, true))
        .await
        .unwrap();
    assert_eq!(cleared(&hub, &seen), Some(ChatNudgeCleared::Seen));

    let old = flag("a3");
    clock.advance(Duration::from_secs(23 * 3600));
    assert_eq!(listed(&hub).len(), 1, "still waiting within the day");
    clock.advance(Duration::from_secs(3600));
    assert!(listed(&hub).is_empty(), "faded after a day");
    // A faded one makes no room: the cap counts only those still waiting.
    for id in ["a4", "a5", "a6"] {
        flag(id);
    }
    assert_eq!(listed(&hub).len(), 3);
    assert_eq!(cleared(&hub, &old), None);
}

#[test]
fn a_reason_is_one_line_cut_to_fit() {
    assert_eq!(
        super::reason_of("the new\n  checkout").unwrap().as_str(),
        "the new checkout"
    );
    let long = super::reason_of(&"x".repeat(300)).unwrap();
    assert_eq!(long.as_str().chars().count(), 200);
    assert!(long.as_str().ends_with('…'));
}
