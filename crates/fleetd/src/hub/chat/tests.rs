//! The lead chat over a real in-memory hub: messages in order and deduped, paging, streamed text with offsets, the
//! needs-you rule, inline items, the history read, a human's message reaching a project without a lead, the moved
//! tools, project_stop and the lead's workstream_open.
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::chat::{
    ChatAuthor, ChatDelivery, ChatHistorySource, ChatItem, ChatMessageState, ChatRequestId,
    CommandApprovalItem, CommandApprovalState,
};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::ledger::IntakeChannel;
use serde_json::{Value, json};

use super::*;
use crate::hub::api::{Caller, Hub, HubConfig, Listen};
use crate::hub::leads::records::{NewWorkstream, StoredLead};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, WaitInput};

const AT: &str = "2026-10-19T10:00:00.000Z";

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("app"),
    }
}

fn hub_on(db: Arc<HubDb>) -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
        retro_model: None,
    };
    let hub = crate::hub::serve::build_on(db, config, ManualClock::at(1_792_000_000_000)).unwrap();
    (hub, home)
}

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let (hub, home) = hub_on(HubDb::open_memory().unwrap());
    hub.store
        .projects_upsert_many(
            &project().machine_id,
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "app", "title": "app", "workspaceRoot": "/work/app",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    (hub, home)
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

fn agent_key() -> Caller {
    Caller {
        kind: Some(KeyKind::Agent),
        ..person()
    }
}

fn give_lead(hub: &Hub) {
    hub.leads
        .records
        .lead_put(&StoredLead {
            project_ref: project(),
            thread_id: fleetd_contracts::ids::ThreadId::unchecked("lead-thread"),
            started_at: AT.into(),
            last_wake_at: None,
            session_generation: 1,
        })
        .unwrap();
}

fn lead_says(text: &str) -> NewMessage {
    NewMessage {
        author: Some(ChatAuthor::Lead),
        text: text.into(),
        ..Default::default()
    }
}

fn events_of(hub: &Hub, t: HubEventType) -> Vec<Value> {
    let page = futures_util::FutureExt::now_or_never(hub.events.wait(WaitInput {
        cursor: Some(0),
        types: Some(vec![t]),
        machine_id: None,
        timeout_sec: 0,
    }))
    .unwrap()
    .unwrap();
    page.events.into_iter().filter_map(|e| e.data).collect()
}

#[test]
fn the_lead_waits_on_you_when_its_last_word_asks_and_no_turn_runs() {
    assert!(asks_question("Two things:\n1. Ship it today? I'd say yes."));
    assert!(asks_question("**Go ahead?**"));
    assert!(!asks_question("Done. The PR merged."));
    assert!(!asks_question("2. Merged the docs PR."));
    let (hub, _home) = hub();
    let r = project();
    let (asked, _) = hub
        .chat
        .add(
            &r,
            lead_says("1. Public link or image only? I'd pick the link."),
        )
        .unwrap();
    assert!(hub.chat.state(&r, false).unwrap().needs_you);
    assert!(
        !hub.chat.state(&r, true).unwrap().needs_you,
        "not while it works"
    );
    // fleetd's own lines don't answer it; the human does.
    hub.chat.system_line(&r, "PR #12 merged.").unwrap();
    assert!(hub.chat.state(&r, false).unwrap().needs_you);
    hub.chat
        .add(
            &r,
            NewMessage {
                author: Some(ChatAuthor::Human),
                text: "1 go".into(),
                ..Default::default()
            },
        )
        .unwrap();
    let s = hub.chat.state(&r, false).unwrap();
    assert!(!s.needs_you);
    assert_eq!(s.last_seq.get(), asked.seq.get() + 2);
    // chat.waiting says it once per change.
    hub.chat.tell_state(&s).unwrap();
    hub.chat.tell_state(&s).unwrap();
    assert_eq!(events_of(&hub, HubEventType::ChatWaiting).len(), 1);
}

#[test]
fn messages_number_in_order_dedupe_by_request_and_source_and_page_both_ways() {
    let (hub, _home) = hub();
    let r = project();
    for i in 1..=120 {
        hub.chat.add(&r, lead_says(&format!("line {i}"))).unwrap();
    }
    let again = NewMessage {
        source: Some("lead:t:7".into()),
        ..lead_says("once")
    };
    let (first, created) = hub.chat.add(&r, again.clone()).unwrap();
    let (second, created_again) = hub.chat.add(&r, again).unwrap();
    assert!(created && !created_again);
    assert_eq!(first.message_id, second.message_id);
    assert_eq!(first.seq.get(), 121);
    let (newest, more_before, more_after) = hub.chat.page(&r, None, None, 50).unwrap();
    assert_eq!(
        (newest.len(), newest[0].seq.get(), more_before, more_after),
        (50, 72, true, false)
    );
    let (back, more_before, more_after) = hub.chat.page(&r, Some(72), None, 50).unwrap();
    assert_eq!(
        (
            back[0].seq.get(),
            back[49].seq.get(),
            more_before,
            more_after
        ),
        (22, 71, true, true)
    );
    let (caught_up, _, more_after) = hub.chat.page(&r, None, Some(119), 50).unwrap();
    assert_eq!(
        (
            caught_up.iter().map(|m| m.seq.get()).collect::<Vec<_>>(),
            more_after
        ),
        (vec![120, 121], false)
    );
    // Each new message was announced once, with the whole message while it fits.
    let announced: i64 = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT COUNT(*) FROM events WHERE type = 'chat.message'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(announced, 121);
    assert_eq!(
        events_of(&hub, HubEventType::ChatMessage)[0]["message"]["text"],
        "line 1"
    );
}

#[test]
fn streamed_text_carries_its_utf16_offset_and_the_final_text_is_announced() {
    let (hub, _home) = hub();
    let r = project();
    let mut deltas = hub.chat.subscribe();
    let (mut m, _) = hub
        .chat
        .add(
            &r,
            NewMessage {
                streaming: true,
                source: Some("lead:t:m1".into()),
                ..lead_says("")
            },
        )
        .unwrap();
    hub.chat.append(&mut m, "héllo ").unwrap();
    hub.chat.append(&mut m, "😀 ok").unwrap();
    let a = deltas.try_recv().unwrap();
    let b = deltas.try_recv().unwrap();
    assert_eq!((a.offset.get(), a.append.as_str()), (0, "héllo "));
    // "héllo " is 6 UTF-16 units; the emoji is two.
    assert_eq!((b.offset.get(), b.append.as_str()), (6, "😀 ok"));
    let (page, _, _) = hub.chat.page(&r, None, None, 1).unwrap();
    assert_eq!(
        (page[0].text.as_str(), page[0].state),
        ("héllo 😀 ok", ChatMessageState::Streaming)
    );
    hub.chat.finish(&mut m, "héllo 😀 ok, done").unwrap();
    let last = events_of(&hub, HubEventType::ChatMessage).pop().unwrap();
    assert_eq!(
        (last["state"].as_str(), last["message"]["text"].as_str()),
        (Some("final"), Some("héllo 😀 ok, done"))
    );
}

#[test]
fn an_open_inline_item_waits_on_you_until_its_state_moves() {
    let (hub, _home) = hub();
    let r = project();
    let approval = |state| {
        ChatItem::CommandApproval(
            serde_json::from_value::<CommandApprovalItem>(json!({
                "requestId": "Q1", "machineId": "devbox", "state": state,
                "gated": { "argv": ["./deploy.sh", "prod"], "class": "irreversible", "reason": "prod deploy",
                    "timeoutSec": 600 },
            }))
            .unwrap(),
        )
    };
    let shown = hub.chat.item(&r, approval("open")).unwrap();
    assert!(
        hub.chat.state(&r, true).unwrap().needs_you,
        "an item waits even while the lead works"
    );
    let moved = hub
        .chat
        .update_item(&ChatRequestId::unchecked("Q1"), approval("approved"))
        .unwrap()
        .unwrap();
    assert_eq!(moved.message_id, shown.message_id);
    let Some(ChatItem::CommandApproval(item)) = moved.item else {
        panic!()
    };
    assert_eq!(item.state, CommandApprovalState::Approved);
    assert!(!hub.chat.state(&r, true).unwrap().needs_you);
}

#[tokio::test]
async fn a_projects_past_reads_in_once_in_time_order_without_ids() {
    let (hub, _home) = hub();
    let r = project();
    let (w, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: r.clone(),
            title: "Share card".into(),
            text: "add a share card".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: "2026-10-19T08:00:00.000Z".into(),
            client_request_id: None,
            playbook: None,
            parent: None,
        })
        .unwrap();
    hub.db
        .with(|c| {
            let steer = json!({ "by": { "kind": "human" }, "text": "make it blue", "queuedAt": "2026-10-19T08:30:00.000Z" });
            c.execute(
                "INSERT INTO steers (workstream_id, machine_id, thread_id, run_id, by, mode, stage, queued_ms, data)
                 VALUES (?1, 'devbox', 't', 'r', 'human', 'queue', 'delivered', 0, ?2)",
                rusqlite::params![w.workstream_id.as_str(), steer.to_string()],
            )?;
            let ask = json!({ "askId": "A1", "projectRef": { "machineId": "devbox", "projectId": "app" },
                "text": "Public link or image only?", "createdAt": "2026-10-19T08:10:00.000Z",
                "answer": { "value": "link", "raw": "1 go", "at": "2026-10-19T08:20:00.000Z" } });
            c.execute(
                "INSERT INTO legacy_asks (project_key, key, state, filed_by, created_ms, data)
                 VALUES ('devbox/app', 'share.link', 'answered', 'lead', 0, ?1)",
                [ask.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    flow::ensure(&hub, &r).await.unwrap();
    flow::ensure(&hub, &r).await.unwrap();
    let (page, _, _) = hub.chat.page(&r, None, None, 50).unwrap();
    let seen: Vec<(ChatAuthor, &str, Option<ChatHistorySource>)> = page
        .iter()
        .map(|m| (m.author, m.text.as_str(), m.history))
        .collect();
    assert_eq!(
        seen,
        [
            (
                ChatAuthor::Human,
                "add a share card",
                Some(ChatHistorySource::Order)
            ),
            (
                ChatAuthor::Lead,
                "Public link or image only?",
                Some(ChatHistorySource::Question)
            ),
            (ChatAuthor::Human, "1 go", Some(ChatHistorySource::Question)),
            (
                ChatAuthor::Human,
                "make it blue",
                Some(ChatHistorySource::Steer)
            ),
        ]
    );
    assert!(
        page.iter()
            .all(|m| !m.text.contains("W1") && !m.text.contains("A1"))
    );
    // History is no question left open.
    assert!(!hub.chat.state(&r, false).unwrap().needs_you);
}

#[tokio::test]
async fn a_message_to_a_project_without_a_lead_is_kept_once_and_says_why_it_waits() {
    let (hub, _home) = hub();
    let tools = crate::hub::api::registry();
    let send = |crid: &str| json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "text": "add dark mode", "clientRequestId": crid });
    let out = tools
        .call(&hub, &person(), "chat_send", send("c1"))
        .await
        .unwrap();
    let message = &out["message"];
    assert_eq!(
        (
            message["author"].as_str(),
            message["delivery"].as_str(),
            message["by"].as_str()
        ),
        (Some("human"), Some("queued"), Some("desk"))
    );
    assert!(
        out["leadWaiting"].as_str().is_some_and(|w| !w.is_empty()),
        "{out}"
    );
    let again = tools
        .call(&hub, &person(), "chat_send", send("c1"))
        .await
        .unwrap();
    assert_eq!(again["message"]["messageId"], message["messageId"]);
    assert_eq!(
        hub.chat.held(&project()).unwrap().len(),
        1,
        "held for the lead's start"
    );
    let history = tools
        .call(
            &hub,
            &person(),
            "chat_history",
            json!({ "projectRef": { "machineId": "devbox", "projectId": "app" } }),
        )
        .await
        .unwrap();
    assert_eq!(history["messages"].as_array().unwrap().len(), 1);
    let status = tools
        .call(&hub, &person(), "fleetd_status", json!({}))
        .await
        .unwrap();
    assert_eq!(status["chats"][0]["projectRef"]["projectId"], "app");
    let _ = ChatDelivery::Queued;
}

#[tokio::test]
async fn the_tools_the_chat_replaced_say_where_they_went() {
    let (hub, _home) = hub();
    let tools = crate::hub::api::registry();
    for (name, _) in super::tools::MOVED {
        let Err(crate::hub::api::CallError::Tool(e)) =
            tools.call(&hub, &person(), name, json!({})).await
        else {
            panic!("{name} still answers");
        };
        assert!(
            e.message.contains("moved to the project chat"),
            "{name}: {}",
            e.message
        );
        assert!(
            e.fix
                .as_deref()
                .is_some_and(|f| f.contains("chat_send") || f.contains("project_stop"))
        );
    }
    let stop = tools
        .call(
            &hub,
            &person(),
            "project_stop",
            json!({ "projectRef": { "machineId": "devbox", "projectId": "app" } }),
        )
        .await
        .unwrap();
    assert_eq!(
        (stop["stopped"].as_i64(), stop["message"]["author"].as_str()),
        (Some(0), Some("system"))
    );
    assert_eq!(stop["message"]["text"], "Stop: nothing was running.");
}

#[tokio::test]
async fn a_lead_opens_its_own_workstream_as_a_draft_with_no_intent_wake() {
    let (hub, _home) = hub();
    let r = project();
    hub.leads
        .records
        .lead_put(&StoredLead {
            project_ref: r.clone(),
            thread_id: fleetd_contracts::ids::ThreadId::unchecked("lead-thread"),
            started_at: AT.into(),
            last_wake_at: None,
            session_generation: 1,
        })
        .unwrap();
    let handler = hub.lead_calls.handler("workstream_open").unwrap();
    let call: LeadCall = serde_json::from_value(
        json!({ "op": "workstream_open", "text": "build schedules", "template": "feature" }),
    )
    .unwrap();
    let caller = crate::hub::link::LeadCaller {
        project_ref: r.clone(),
        by: "lead:devbox/app".into(),
        cwd: "/work/app".into(),
        thread: None,
        agent: crate::hub::link::lead_calls::CallerAgent::Lead,
    };
    let Ok(LeadCallResult::WorkstreamOpen(opened)) = handler.handle(caller, call).await else {
        panic!("not opened")
    };
    let w = hub
        .leads
        .records
        .workstream_get(&opened.workstream_id)
        .unwrap()
        .unwrap()
        .workstream;
    assert_eq!(
        (w.source.channel, w.source.text.as_str()),
        (IntakeChannel::Lead, "build schedules")
    );
    assert!(
        w.playbook
            .is_some_and(|p| p.as_ref().starts_with("feature@"))
    );
    assert!(
        !hub.leads.wakes.pending(&r),
        "the lead that opened it is not woken about it"
    );
    // A lead's own order is not a human's words in the chat's history.
    flow::ensure(&hub, &r).await.unwrap();
    assert!(hub.chat.page(&r, None, None, 10).unwrap().0.is_empty());
}

/// Run by hand against a copy of a real hub's database: `FLEETD_CHAT_DB=/tmp/copy/hub.sqlite cargo test -p fleetd
/// --lib chat::tests::reads_a_real_hubs_past -- --ignored --nocapture`. The copy is copied again into a temp dir, so
/// the given file is never written either.
#[tokio::test]
#[ignore = "needs FLEETD_CHAT_DB, a copy of a real hub database"]
async fn reads_a_real_hubs_past() {
    let path = std::env::var("FLEETD_CHAT_DB").expect("FLEETD_CHAT_DB");
    let dir = tempfile::tempdir().unwrap();
    // Copied by content: the copy is writable even when the given file is read-only.
    for side in ["", "-wal"] {
        if let Ok(bytes) = std::fs::read(format!("{path}{side}")) {
            std::fs::write(dir.path().join(format!("hub.sqlite{side}")), bytes).unwrap();
        }
    }
    let (hub, _home) = hub_on(HubDb::open(dir.path()).unwrap());
    let ids = regex::Regex::new(r"\b[WAT][0-9]+\b").unwrap();
    for p in hub.store.projects_list(None, None).unwrap() {
        let r = ProjectRef {
            machine_id: p.machine_id.clone(),
            project_id: p.project_id.clone(),
        };
        flow::ensure(&hub, &r).await.unwrap();
        let (page, more, _) = hub.chat.page(&r, None, None, 100).unwrap();
        let by = |s: ChatHistorySource| page.iter().filter(|m| m.history == Some(s)).count();
        println!(
            "{}: {} messages{} (orders {}, outcomes {}, steers {}, questions {}, lead {})",
            p.title,
            page.len(),
            if more { "+" } else { "" },
            by(ChatHistorySource::Order),
            by(ChatHistorySource::OrderOutcome),
            by(ChatHistorySource::Steer),
            by(ChatHistorySource::Question),
            by(ChatHistorySource::LeadMessage),
        );
        assert!(
            page.windows(2)
                .all(|w| w[0].created_at.as_str() <= w[1].created_at.as_str())
        );
        assert!(page.iter().all(|m| m.history.is_some()));
        for m in &page {
            assert!(
                !ids.is_match(&m.text) || m.history == Some(ChatHistorySource::Order),
                "an id in: {}",
                m.text
            );
        }
    }
}

#[tokio::test]
async fn only_a_persons_device_writes_as_the_human() {
    let (hub, _home) = hub();
    let tools = crate::hub::api::registry();
    let input = json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "text": "hi", "clientRequestId": "c1" });
    let Err(crate::hub::api::CallError::Tool(e)) =
        tools.call(&hub, &agent_key(), "chat_send", input).await
    else {
        panic!("an agent key wrote as the human");
    };
    assert_eq!(e.code, fleetd_contracts::mcp::ErrorCode::Forbidden);
    assert!(
        hub.chat
            .page(&project(), None, None, 5)
            .unwrap()
            .0
            .is_empty()
    );
}

/// A message stays held until it is in the lead's session or the offline queue: a resend tries again, the sweep
/// sends it once a lead exists, and one the queue gave up on is held again.
#[tokio::test]
async fn a_message_never_goes_missing_on_its_way_to_the_lead() {
    let (hub, _home) = hub();
    let r = project();
    let tools = crate::hub::api::registry();
    let input = json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "text": "add dark mode", "clientRequestId": "c1" });
    let first = tools
        .call(&hub, &person(), "chat_send", input.clone())
        .await
        .unwrap();
    let id = first["message"]["messageId"].as_str().unwrap().to_owned();
    let held = || {
        hub.chat
            .held(&r)
            .unwrap()
            .iter()
            .map(|m| m.message_id.to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        held(),
        std::slice::from_ref(&id),
        "no lead could take it: held"
    );
    // The resend finds it held and tries again; still no lead, still held, and still one message.
    let again = tools
        .call(&hub, &person(), "chat_send", input.clone())
        .await
        .unwrap();
    assert_eq!(again["message"]["messageId"], id.as_str());
    assert!(again["leadWaiting"].as_str().is_some());
    assert_eq!(held(), std::slice::from_ref(&id));
    // A lead appears (its machine away): the sweep hands the message to the offline queue and releases it.
    give_lead(&hub);
    flow::send_held(&hub, &r).await;
    assert!(held().is_empty());
    let sent = hub.chat.by_id(&id).unwrap().unwrap();
    assert_eq!(sent.delivery, Some(ChatDelivery::Queued));
    // The queue gives up on it: held again, for the next try.
    flow::expired(
        &hub,
        &json!({ "clientRequestId": format!("chat:{id}"), "reason": "ttl" }),
    );
    assert_eq!(held(), std::slice::from_ref(&id));
    // A resend now sends it once more, without a second message.
    tools
        .call(&hub, &person(), "chat_send", input)
        .await
        .unwrap();
    assert!(held().is_empty());
    assert_eq!(hub.chat.page(&r, None, None, 10).unwrap().0.len(), 1);
}

/// A chat message's files become the project's when it is stored: kept past the unused-upload cleanup, and readable
/// by another person of the project, not only the uploader.
#[tokio::test]
async fn a_messages_attachments_are_the_projects() {
    use base64::Engine;
    let (hub, _home) = hub();
    let tools = crate::hub::api::registry();
    let put = tools
        .call(
            &hub,
            &person(),
            "attachment_put",
            json!({ "name": "shot.png", "mime": "image/png",
            "dataB64": base64::engine::general_purpose::STANDARD.encode(b"png") }),
        )
        .await
        .unwrap();
    let file = put["attachmentId"].as_str().unwrap().to_owned();
    let input = json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "text": "see this",
        "attachments": [file], "clientRequestId": "c1" });
    let sent = tools
        .call(&hub, &person(), "chat_send", input)
        .await
        .unwrap();
    assert_eq!(sent["message"]["attachments"][0]["name"], "shot.png");
    let other = Caller {
        key_id: fleetd_contracts::prim::NonEmpty::unchecked("k2"),
        ..person()
    };
    let got = tools
        .call(
            &hub,
            &other,
            "attachment_get",
            json!({ "projectRef": { "machineId": "devbox", "projectId": "app" },
            "attachmentId": file }),
        )
        .await
        .unwrap();
    assert_eq!(got["bytes"], 3);
}

/// A stop reaches the lead as a line that says the order is over: no more work on it.
#[tokio::test(flavor = "current_thread")]
async fn a_stopped_order_tells_its_lead_to_do_no_more_work_on_it() {
    let clock = ManualClock::at(1_792_000_000_000);
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
        retro_model: None,
    };
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    hub.store
        .projects_upsert_many(
            &project().machine_id,
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "app", "title": "app", "workspaceRoot": "/work/app",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    give_lead(&hub);
    let r = project();
    hub.leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: r.clone(),
            title: "Dark mode".into(),
            text: "add dark mode".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
            playbook: None,
            parent: None,
        })
        .unwrap();
    crate::hub::api::registry()
        .call(
            &hub,
            &person(),
            "project_stop",
            json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "reason": "not needed" }),
        )
        .await
        .unwrap();
    assert!(hub.leads.wakes.pending(&r));
    clock.advance(crate::hub::leads::wakes::WAKE_DEBOUNCE);
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    // The lead's machine is away, so the wake waits in the offline queue.
    let wake: String = hub
        .db
        .with(|c| Ok(c.query_row("SELECT message FROM queued_writes", [], |r| r.get(0))?))
        .unwrap();
    assert!(
        wake.contains(
            "- W1 stopped by the human (not needed): Dark mode; 0 agents cancelled, merged PRs stay; do no more work on it"
        ),
        "{wake}"
    );
}

/// Every request event the chat follows, handled as the follower handles it.
async fn follow_requests(hub: &Hub) {
    for t in [HubEventType::RequestOpened, HubEventType::RequestUpdated] {
        for data in events_of(hub, t) {
            flow::show_request(hub, data["requestId"].as_str().unwrap()).await;
        }
    }
}

fn items(hub: &Hub) -> Vec<(fleetd_contracts::chat::ChatMessageId, ChatItem)> {
    hub.chat
        .page(&project(), None, None, 50)
        .unwrap()
        .0
        .into_iter()
        .filter_map(|m| m.item.map(|i| (m.message_id, i)))
        .collect()
}

/// End to end for a gated command: the lead's gated_run shows as its inline item and the chat waits on you; the
/// person denies it with approval_answer, the same item says so, the lead is woken with the outcome, and the wait
/// is over. Following the same events again changes nothing.
#[tokio::test]
async fn a_gated_command_is_an_inline_item_from_request_to_answer() {
    let (hub, _home) = hub();
    hub.ops.bind(&hub);
    give_lead(&hub);
    let r = project();
    let p: crate::hub::usage::ports::ProjectRef =
        serde_json::from_value(json!({ "machineId": "devbox", "projectId": "app" })).unwrap();
    let input = crate::hub::approvals::GatedRunInput {
        argv: vec!["./deploy.sh".into(), "prod".into()],
        cwd: None,
        class: "irreversible".into(),
        reason: "prod deploy".into(),
        secret_env: None,
        timeout_sec: 600,
        workstream_id: None,
    };
    let open = hub.approvals.gated_run(&p, input).await.unwrap();
    follow_requests(&hub).await;
    follow_requests(&hub).await;
    let shown = items(&hub);
    assert_eq!(shown.len(), 1, "once per request");
    let ChatItem::CommandApproval(item) = &shown[0].1 else {
        panic!("not an approval")
    };
    assert_eq!(
        (item.state, item.gated.as_ref().map(|g| g.argv.len())),
        (CommandApprovalState::Open, Some(2))
    );
    assert!(
        hub.chat.state(&r, true).unwrap().needs_you,
        "an open request waits on you, even mid-turn"
    );
    let tools = crate::hub::api::registry();
    tools
        .call(
            &hub,
            &person(),
            "approval_answer",
            json!({ "requestId": open.request_id, "decision": "deny",
            "message": "not today" }),
        )
        .await
        .unwrap();
    follow_requests(&hub).await;
    let after = items(&hub);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].0, shown[0].0, "updated in place");
    let ChatItem::CommandApproval(item) = &after[0].1 else {
        panic!("not an approval")
    };
    assert_eq!(item.state, CommandApprovalState::Denied);
    assert!(hub.leads.wakes.pending(&r), "the lead hears the outcome");
    assert!(!hub.chat.state(&r, false).unwrap().needs_you);
}

/// A secret request's item carries where the value goes and, once stored, its fingerprint: never the value.
#[test]
fn a_secret_request_item_never_carries_the_value() {
    let (hub, _home) = hub();
    let request: fleetd_contracts::ledger::HumanRequest = serde_json::from_value(json!({
        "requestId": "Q7", "projectRef": { "machineId": "devbox", "projectId": "app" }, "kind": "secret",
        "text": "Need the Stripe test key", "state": "stored", "createdAt": AT, "answeredAt": AT,
        "secret": { "key": "stripe.test_key", "sink": "env:devbox:/work/app/.env", "fingerprint": "ab12cd34" },
    }))
    .unwrap();
    let item = crate::hub::approvals::chat_item(&request);
    let message = hub.chat.item(&project(), item).unwrap();
    let text = serde_json::to_string(&message).unwrap();
    assert!(text.contains("ab12cd34") && text.contains("stripe.test_key"));
    for leak in ["\"value\"", "sealed", "sk_test"] {
        assert!(!text.contains(leak), "{leak} in {text}");
    }
    assert!(
        !hub.chat.state(&project(), false).unwrap().needs_you,
        "a stored secret waits on no one"
    );
}

/// A project's max-agents change is one quiet line in its chat, once per event; a fleet-wide one is in no chat.
#[tokio::test]
async fn a_max_agents_change_is_one_quiet_line() {
    let (hub, _home) = hub();
    let data =
        json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "from": 3, "to": 12 });
    let line = "Max agents 3 → 12: 3 queued agents start now.";
    flow::cap_line(&hub, 41, Some(&data), line).await;
    flow::cap_line(&hub, 41, Some(&data), line).await;
    flow::cap_line(
        &hub,
        42,
        Some(&json!({ "from": 40, "to": 20 })),
        "Fleet cap 40 → 20.",
    )
    .await;
    let page = hub.chat.page(&project(), None, None, 10).unwrap().0;
    assert_eq!(
        page.iter()
            .map(|m| (m.author, m.text.as_str()))
            .collect::<Vec<_>>(),
        [(ChatAuthor::System, line)]
    );
}

/// The approvals service may reopen an approved command while the chat's follower starts. The follower takes its
/// cursor before it shows anything, and the start brings every item still reading open or approved in line with its
/// request: a reopen it never saw as an event still shows as open, with the dot.
#[tokio::test]
async fn a_request_reopened_while_the_follower_starts_shows_open() {
    let (hub, _home) = hub();
    hub.ops.bind(&hub);
    give_lead(&hub);
    let r = project();
    let p: crate::hub::usage::ports::ProjectRef =
        serde_json::from_value(json!({ "machineId": "devbox", "projectId": "app" })).unwrap();
    let input = crate::hub::approvals::GatedRunInput {
        argv: vec!["./deploy.sh".into(), "prod".into()],
        cwd: None,
        class: "irreversible".into(),
        reason: "prod deploy".into(),
        secret_env: None,
        timeout_sec: 600,
        workstream_id: None,
    };
    let open = hub.approvals.gated_run(&p, input).await.unwrap();
    let n: i64 = open.request_id.as_str()[1..].parse().unwrap();
    // As the approvals service's own writes do, with no event the chat reads.
    let set = |state: &str| {
        hub.db
            .with(|c| {
                c.execute(
                    "UPDATE requests SET state = ?1, data = json_set(data, '$.state', ?1) WHERE n = ?2",
                    rusqlite::params![state, n],
                )?;
                Ok(())
            })
            .unwrap();
    };
    set("approved");
    flow::show_request(&hub, open.request_id.as_str()).await;
    let state_of = || match &items(&hub)[0].1 {
        ChatItem::CommandApproval(item) => item.state,
        _ => panic!("not an approval"),
    };
    assert_eq!(state_of(), CommandApprovalState::Approved);
    assert!(!hub.chat.state(&r, false).unwrap().needs_you);
    // Reopened with no event the follower reads: the start repairs it, and follows from before it began.
    set("open");
    let head = hub.events.head();
    let cursor = flow::startup(&hub).await;
    assert_eq!(cursor, head, "the cursor is taken before anything is shown");
    assert_eq!(state_of(), CommandApprovalState::Open);
    assert!(hub.chat.state(&r, false).unwrap().needs_you);
    assert_eq!(items(&hub).len(), 1, "the same item, in place");
}
