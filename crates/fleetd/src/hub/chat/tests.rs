//! The lead chat over a real in-memory hub: messages in order and deduped, paging, streamed text with offsets, the
//! needs-you rule, inline items, the history read, a human's message reaching a project without a lead, the moved
//! tools, chat_stop, project_stop and the lead's brief that opens a workstream.
use std::collections::HashMap;
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::chat::{
    ChatAuthor, ChatDelivery, ChatHistorySource, ChatItem, ChatMessageState, ChatRequestId,
    CommandApprovalItem, CommandApprovalState, SecretRequestState,
};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::ledger::{IntakeChannel, WorkstreamState};
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
    hub_with(db, ManualClock::at(1_792_000_000_000))
}

fn hub_with(db: Arc<HubDb>, clock: Arc<ManualClock>) -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(db, config, clock).unwrap();
    (hub, home)
}

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    with_project(hub_on(HubDb::open_memory().unwrap()))
}

fn with_project((hub, home): (Arc<Hub>, tempfile::TempDir)) -> (Arc<Hub>, tempfile::TempDir) {
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
        key_id: fleetd_contracts::prim::NonEmpty::unchecked("k2"),
        name: "scout".into(),
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
        hub.chat.state(&r, true).unwrap().needs_you,
        "still asked while it works"
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

/// The lead's first turn is the person's message, not an empty chat followed by it.
#[tokio::test]
async fn the_message_that_starts_the_lead_goes_in_with_its_start() {
    use fleetd_contracts::sessions::SessionCall;
    let (hub, _home) = hub();
    let calls = obliging_node(&hub).await;
    hub.executors.set_runner_ready(&project().machine_id, true);
    hub.executors.await_ready(&project().machine_id).await;
    let tools = crate::hub::api::registry();
    let sent = tools
        .call(
            &hub,
            &person(),
            "chat_send",
            say_to_app("add dark mode", "s1", None),
        )
        .await
        .unwrap();
    assert_eq!(sent["message"]["delivery"], "turn", "{sent}");
    assert!(hub.chat.held(&project()).unwrap().is_empty());
    let (launches, sends): (Vec<_>, Vec<_>) = calls
        .lock()
        .unwrap()
        .iter()
        .filter_map(|c| match c {
            SessionCall::Launch(l) => Some(Ok(l.prompt.to_string())),
            SessionCall::Send { text, .. } => Some(Err(text.to_string())),
            _ => None,
        })
        .partition(Result::is_ok);
    assert!(
        (launches.len(), sends.len()) == (1, 0),
        "{launches:?} {sends:?}"
    );
    let first = launches[0].as_ref().unwrap();
    assert!(
        first.starts_with("You are the lead of project app")
            && first.ends_with("The human writes in your chat:\n\nadd dark mode"),
        "{first}"
    );
}

/// What the lead's session took first when `input` started it.
async fn lead_reads(input: Value, hub: &Arc<Hub>) -> String {
    use fleetd_contracts::sessions::SessionCall;
    let calls = obliging_node(hub).await;
    hub.executors.set_runner_ready(&project().machine_id, true);
    hub.executors.await_ready(&project().machine_id).await;
    let sent = crate::hub::api::registry()
        .call(hub, &person(), "chat_send", input)
        .await
        .unwrap();
    assert_eq!(sent["message"]["delivery"], "turn", "{sent}");
    calls
        .lock()
        .unwrap()
        .iter()
        .find_map(|c| match c {
            SessionCall::Launch(l) => Some(l.prompt.to_string()),
            _ => None,
        })
        .unwrap()
}

/// A reply as the app sends it: the bubble's one-line quote over the words, and the bubble it answers.
fn reply_to(quote: &str, words: &str, message: &str, part: i64) -> Value {
    let mut input = say_to_app(&format!("> {quote}\n\n{words}"), "r1", None);
    input["replyTo"] = json!({ "messageId": message, "part": part });
    input
}

/// A reply to a long bubble: the lead reads the whole bubble, not the app's 90-character quote, and when it wrote it.
#[tokio::test]
async fn a_reply_reads_the_whole_bubble_it_answers_and_when_it_was_written() {
    let (hub, _home) = hub();
    let bubble = "I took \"sidebar\" to mean the panel next to the chat. If you meant the projects list on the \
                  left instead, say so and I'll move the filter there.";
    let (asked, _) = hub.chat.add(&project(), lead_says(bubble)).unwrap();
    let quote = "I took \"sidebar\" to mean the panel next to the chat. If you meant the projects list on th…";
    let read = lead_reads(reply_to(quote, "yes", asked.message_id.as_str(), 0), &hub).await;
    let at = &asked.created_at.as_str()[11..16];
    assert!(
        read.ends_with(&format!(
            "The human writes in your chat:\n\nReplying to your message at {at} UTC:\n> {bubble}\n\nyes"
        )),
        "{read}"
    );
    let stored = hub
        .chat
        .by_request(&project(), &format!("{}:r1", person().key_id))
        .unwrap()
        .unwrap();
    assert_eq!(stored.reply_to.unwrap().message_id, asked.message_id);
    assert!(
        stored.text.starts_with(&format!("> {quote}")),
        "the text stays as other clients show it"
    );
}

/// A reply to one bubble of a message of several quotes that bubble only; one past 1,000 characters keeps its start
/// and end.
#[tokio::test]
async fn a_reply_to_one_bubble_quotes_only_that_bubble() {
    let (hub, _home) = hub();
    let long = format!("Plan B starts here {} and ends here.", "word ".repeat(300));
    let text = format!("Two ways to do it.\n\nPlan A: move the filter.\n\n{long}");
    let (asked, _) = hub.chat.add(&project(), lead_says(&text)).unwrap();
    assert_eq!(asked.parts.as_ref().map(|p| p.len()), Some(3));
    let read = lead_reads(
        reply_to(
            "Plan A: move the filter.",
            "this one",
            asked.message_id.as_str(),
            1,
        ),
        &hub,
    )
    .await;
    assert!(
        read.ends_with(", its bubble 2 of 3:\n> Plan A: move the filter.\n\nthis one"),
        "{read}"
    );
    assert!(
        !read.contains("Two ways") && !read.contains("Plan B"),
        "{read}"
    );

    let quote = flow::for_lead(
        crate::hub::prompts::PromptSet::defaults(),
        &{
            let mut m = hub
                .chat
                .by_request(&project(), &format!("{}:r1", person().key_id))
                .unwrap()
                .unwrap();
            m.reply_to.as_mut().unwrap().part = fleetd_contracts::prim::Count::unchecked(2);
            m
        },
        Some(&asked),
        "",
    );
    assert!(
        quote.contains("> Plan B starts here word")
            && quote.contains("characters cut …]\n> word")
            && quote.ends_with("and ends here.\n\nthis one")
            && quote.len() < 1200,
        "{quote}"
    );
}

#[tokio::test]
async fn project_stop_with_nothing_running_says_so() {
    let (hub, _home) = hub();
    let tools = crate::hub::api::registry();
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
    assert_eq!(stop["message"]["text"], "Nothing was running.");
}

#[tokio::test]
async fn a_brief_without_a_workstream_opens_one_with_no_intent_wake() {
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
    let handler = hub.lead_calls.handler("brief_create").unwrap();
    let brief = json!({ "goal": "schedules", "why": "asked", "pointers": [], "constraints": [], "doneWhen": ["schedules ship"] });
    let call: LeadCall = serde_json::from_value(
        json!({ "op": "brief_create", "text": "build schedules", "brief": brief }),
    )
    .unwrap();
    let caller = crate::hub::link::LeadCaller {
        project_ref: r.clone(),
        by: "lead:devbox/app".into(),
        agent: crate::hub::link::lead_calls::CallerAgent::Lead,
    };
    let Ok(LeadCallResult::BriefCreate(opened)) = handler.handle(caller, call).await else {
        panic!("not opened")
    };
    let w = hub
        .leads
        .records
        .workstream_get(&opened.workstream_id)
        .unwrap()
        .unwrap();
    assert_eq!(
        (w.source.channel, w.source.text.as_str(), w.state),
        (
            IntakeChannel::Lead,
            "build schedules",
            WorkstreamState::Open
        )
    );
    assert!(
        !hub.leads.wakes.pending(&r),
        "the lead that opened it is not woken about it"
    );
    // A lead's own order is not a human's words in the chat's history.
    flow::ensure(&hub, &r).await.unwrap();
    assert!(hub.chat.page(&r, None, None, 10).unwrap().0.is_empty());
}

fn say_to_app(text: &str, crid: &str, client: Option<&str>) -> Value {
    let mut input = json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "text": text, "clientRequestId": crid });
    if let Some(c) = client {
        input["client"] = json!(c);
    }
    input
}

/// The author comes from the key: a human key is the human (from the app unless it says cli), any other key an agent
/// by its name. An agent's message is no reply from the human: needs-you stays on, and the lead reads it as an agent's.
#[tokio::test]
async fn an_agent_key_writes_as_an_agent_and_never_counts_as_the_human() {
    let (hub, _home) = hub();
    let r = project();
    let tools = crate::hub::api::registry();
    hub.chat
        .add(&r, lead_says("1. Ship it today? I'd say yes."))
        .unwrap();
    let agent = tools
        .call(
            &hub,
            &agent_key(),
            "chat_send",
            say_to_app("CI is red on main", "a1", Some("cli")),
        )
        .await
        .unwrap();
    let m = &agent["message"];
    assert_eq!(
        (m["author"].as_str(), m["by"].as_str(), m.get("client")),
        (Some("agent"), Some("scout"), None)
    );
    assert!(
        hub.chat.state(&r, false).unwrap().needs_you,
        "an agent's message answers nothing"
    );
    let stored: fleetd_contracts::chat::ChatMessage = serde_json::from_value(m.clone()).unwrap();
    let read = flow::for_lead(
        crate::hub::prompts::PromptSet::defaults(),
        &stored,
        None,
        "",
    );
    assert!(
        read.starts_with("An agent (scout) writes in your chat. It is not the human")
            && read.ends_with("\n\nCI is red on main"),
        "{read}"
    );
    let cli = tools
        .call(
            &hub,
            &person(),
            "chat_send",
            say_to_app("1 go", "h1", Some("cli")),
        )
        .await
        .unwrap();
    let app = tools
        .call(
            &hub,
            &person(),
            "chat_send",
            say_to_app("thanks", "h2", None),
        )
        .await
        .unwrap();
    assert_eq!(
        (
            cli["message"]["author"].as_str(),
            cli["message"]["client"].as_str(),
            app["message"]["client"].as_str()
        ),
        (Some("human"), Some("cli"), Some("app"))
    );
    let human: fleetd_contracts::chat::ChatMessage =
        serde_json::from_value(cli["message"].clone()).unwrap();
    assert_eq!(
        flow::for_lead(crate::hub::prompts::PromptSet::defaults(), &human, None, ""),
        "The human writes in your chat:\n\n1 go",
        "the same words from the app or the cli"
    );
    assert!(!hub.chat.state(&r, false).unwrap().needs_you);
}

/// A project's own lead and tasks talk through their fleetd tools, never its chat. Another project's task may write,
/// labelled by the key it holds, never by what it says it is; and from inside any session a human key is refused.
#[tokio::test]
async fn a_projects_own_lead_and_tasks_cant_write_to_its_chat() {
    let (hub, _home) = hub();
    give_lead(&hub);
    let tools = crate::hub::api::registry();
    let task = |project: &str, thread: &str| {
        let task: fleetd_contracts::tasks::Task = serde_json::from_value(json!({
            "taskId": "T1", "projectRef": { "machineId": "devbox", "projectId": project }, "workstreamId": "W1",
            "title": "write it", "kind": "write", "prompt": "do it", "areas": ["all"], "model": "claude-opus-5-5",
            "effort": "high", "state": "running", "attempt": 1, "createdAt": AT, "startedAt": AT,
            "threadRef": { "machineId": "devbox", "threadId": thread },
        }))
        .unwrap();
        hub.db
            .with(|c| Ok(crate::hub::tasks::records::TaskRecords::create(c, task)?))
            .unwrap()
    };
    task("app", "own-task");
    task("site", "other-task");
    let from = |who: Caller, session: &str, crid: &str| {
        let mut input = say_to_app("hello", crid, Some("cli"));
        input["session"] = json!(session);
        let tools = &tools;
        let hub = &hub;
        async move { tools.call(hub, &who, "chat_send", input).await }
    };
    for who in [agent_key(), person()] {
        for (session, fix) in [("lead-thread", "message_agent"), ("own-task", "report")] {
            let Err(crate::hub::api::CallError::Tool(e)) =
                from(who.clone(), session, session).await
            else {
                panic!("{session} wrote to its own lead's chat with {}", who.name);
            };
            assert_eq!(e.code, fleetd_contracts::mcp::ErrorCode::Forbidden);
            assert!(e.fix.as_deref().unwrap_or("").contains(fix), "{e:?}");
        }
    }
    let Err(crate::hub::api::CallError::Tool(e)) = from(person(), "other-task", "h1").await else {
        panic!("a session wrote as the human");
    };
    assert_eq!(e.code, fleetd_contracts::mcp::ErrorCode::Forbidden);
    assert!(e.message.contains("can't write as the human"), "{e:?}");
    let sent = from(agent_key(), "other-task", "o1").await.unwrap();
    assert_eq!(
        (
            sent["message"]["author"].as_str(),
            sent["message"]["by"].as_str()
        ),
        (Some("agent"), Some("scout")),
        "the key's name, not the task's"
    );
    assert_eq!(hub.chat.page(&project(), None, None, 5).unwrap().0.len(), 1);
}

/// Agents answering each other through a chat stop at the minute's allowance; a resend of a stored message and the
/// human's own messages never count.
#[tokio::test]
async fn an_agent_key_is_held_to_its_minute_allowance() {
    let clock = ManualClock::at(1_792_000_000_000);
    let (hub, _home) = with_project(hub_with(HubDb::open_memory().unwrap(), clock.clone()));
    let tools = crate::hub::api::registry();
    let send = |who: Caller, crid: String| {
        let input = say_to_app("ping", &crid, None);
        let tools = &tools;
        let hub = &hub;
        async move { tools.call(hub, &who, "chat_send", input).await }
    };
    for n in 0..flow::AGENT_PER_MINUTE {
        send(agent_key(), format!("a{n}")).await.unwrap();
    }
    send(agent_key(), "a0".into())
        .await
        .expect("a resend returns the stored message");
    let Err(crate::hub::api::CallError::Tool(e)) = send(agent_key(), "over".into()).await else {
        panic!("past the allowance");
    };
    assert!(e.message.contains("in the last minute"), "{e:?}");
    send(person(), "h1".into())
        .await
        .expect("the human is not limited");
    clock.advance(std::time::Duration::from_secs(60));
    send(agent_key(), "later".into()).await.unwrap();
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

/// A message of 100,000 characters is taken whole; one more is refused before anything is stored.
#[tokio::test]
async fn a_message_is_at_most_100000_characters() {
    let (hub, _home) = hub();
    let tools = crate::hub::api::registry();
    let message = |text: String, crid: &str| json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "text": text, "clientRequestId": crid });
    let long = "é".repeat(fleetd_contracts::chat::CHAT_TEXT_MAX);
    let sent = tools
        .call(&hub, &person(), "chat_send", message(long.clone(), "c1"))
        .await
        .unwrap();
    assert_eq!(sent["message"]["text"], long);
    let Err(crate::hub::api::CallError::Invalid(why)) = tools
        .call(
            &hub,
            &person(),
            "chat_send",
            message(format!("{long}x"), "c2"),
        )
        .await
    else {
        panic!("a message past the limit was taken")
    };
    assert!(why.contains("100000"), "{why}");
}

/// A message carries 20 files, one of them 25 MiB sent in pieces as the app sends it; a 21st file, a byte past
/// 25 MiB, or a piece out of order is refused and says why.
#[tokio::test]
async fn a_message_carries_twenty_files_of_up_to_25_mib() {
    use base64::Engine;
    use fleetd_contracts::mcp::{ATTACHMENT_MAX_BYTES, ATTACHMENT_PART_BYTES};
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let (hub, _home) = hub();
    let tools = crate::hub::api::registry();
    let call = |tool: &'static str, input: Value| {
        let (hub, tools) = (hub.clone(), &tools);
        async move { tools.call(&hub, &person(), tool, input).await }
    };
    let refusal = |e: crate::hub::api::CallError| match e {
        crate::hub::api::CallError::Tool(e) => e.message,
        crate::hub::api::CallError::Invalid(m) => m,
        crate::hub::api::CallError::UnknownTool => "unknown tool".into(),
    };
    // Sends `len` bytes the way the app does: pieces, then the last with attachment_put.
    let send = |len: usize| async move {
        let piece = vec![b'x'; ATTACHMENT_PART_BYTES];
        let mut upload: Option<String> = None;
        let mut at = 0;
        while at + ATTACHMENT_PART_BYTES < len {
            let mut input = json!({ "dataB64": b64(&piece) });
            if let Some(id) = &upload {
                input["uploadId"] = json!(id);
                input["offset"] = json!(at);
            }
            let part = call("attachment_part", input).await.map_err(refusal)?;
            upload = Some(part["uploadId"].as_str().unwrap().to_owned());
            at += ATTACHMENT_PART_BYTES;
        }
        let mut input =
            json!({ "name": "big.txt", "mime": "text/plain", "dataB64": b64(&piece[..len - at]) });
        if let Some(id) = &upload {
            input["uploadId"] = json!(id);
        }
        call("attachment_put", input).await.map_err(refusal)
    };
    let big = send(ATTACHMENT_MAX_BYTES).await.unwrap();
    assert_eq!(big["bytes"], ATTACHMENT_MAX_BYTES);
    let over = send(ATTACHMENT_MAX_BYTES + 1).await.unwrap_err();
    assert_eq!(
        over,
        format!(
            "The file is {} bytes; attachments are at most 25 MiB.",
            ATTACHMENT_MAX_BYTES + 1
        )
    );

    let first = call("attachment_part", json!({ "dataB64": b64(b"one") }))
        .await
        .unwrap();
    let skipped = call(
        "attachment_part",
        json!({ "uploadId": first["uploadId"], "offset": 9, "dataB64": b64(b"two") }),
    )
    .await
    .unwrap_err();
    assert!(refusal(skipped).ends_with("holds 3 bytes, not 9."));

    let mut files = vec![big["attachmentId"].clone()];
    for n in 1..=20 {
        let small = call(
            "attachment_put",
            json!({ "name": format!("note-{n}.txt"), "mime": "text/plain", "dataB64": b64(b"hi") }),
        )
        .await
        .unwrap();
        files.push(small["attachmentId"].clone());
    }
    let message = |files: &[Value], crid: &str| {
        json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "text": "see these",
                "attachments": files, "clientRequestId": crid })
    };
    let sent = call("chat_send", message(&files[..20], "c1"))
        .await
        .unwrap();
    assert_eq!(sent["message"]["attachments"].as_array().unwrap().len(), 20);
    assert_eq!(
        sent["message"]["attachments"][0]["bytes"],
        ATTACHMENT_MAX_BYTES
    );
    let too_many = call("chat_send", message(&files, "c2")).await.unwrap_err();
    let why = refusal(too_many);
    assert!(why.contains("at most 20 items"), "{why}");
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

/// An agent's key carries none of the person's authority. With a command and a secret waiting on the person, the
/// agent's "approved" in the chat leaves both open and the chat still waiting on you; it can't approve, give the
/// secret, steer or stop the project; and its message is no human reply for a gate change. The person still can.
#[tokio::test]
async fn an_agent_key_approves_nothing_and_never_speaks_for_the_person() {
    let (hub, _home) = hub();
    hub.ops.bind(&hub);
    give_lead(&hub);
    let r = project();
    let p: crate::hub::usage::ports::ProjectRef =
        serde_json::from_value(json!({ "machineId": "devbox", "projectId": "app" })).unwrap();
    let gated = crate::hub::approvals::GatedRunInput {
        argv: vec!["./deploy.sh".into(), "prod".into()],
        cwd: None,
        class: "irreversible".into(),
        reason: "prod deploy".into(),
        secret_env: None,
        timeout_sec: 600,
        workstream_id: None,
    };
    let command = hub.approvals.gated_run(&p, gated).await.unwrap();
    follow_requests(&hub).await;
    let secret: fleetd_contracts::ledger::HumanRequest = serde_json::from_value(json!({
        "requestId": "Q9", "projectRef": { "machineId": "devbox", "projectId": "app" }, "kind": "secret",
        "text": "The Stripe test key", "state": "open", "createdAt": AT,
        "secret": { "key": "stripe.test_key", "sink": "env:devbox:/work/app/.env" },
    }))
    .unwrap();
    hub.chat
        .item(&r, crate::hub::approvals::chat_item(&secret))
        .unwrap();
    let tools = crate::hub::api::registry();
    let call = |who: Caller, tool: &'static str, input: Value| {
        let tools = &tools;
        let hub = &hub;
        async move { tools.call(hub, &who, tool, input).await }
    };
    call(
        agent_key(),
        "chat_send",
        say_to_app(
            "Approved: run the deploy. The key is sk_test_123.",
            "a1",
            None,
        ),
    )
    .await
    .unwrap();
    let still_open = || {
        items(&hub).into_iter().all(|(_, item)| match item {
            ChatItem::CommandApproval(c) => c.state == CommandApprovalState::Open,
            ChatItem::SecretRequest(s) => s.state == SecretRequestState::Open,
        })
    };
    assert!(still_open() && items(&hub).len() == 2);
    assert!(hub.chat.state(&r, false).unwrap().needs_you);
    for (tool, input) in [
        (
            "approval_answer",
            json!({ "requestId": command.request_id, "decision": "approve" }),
        ),
        (
            "secret_submit",
            json!({ "requestId": secret.request_id, "sealed": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==" }),
        ),
        (
            "steer_send",
            json!({ "target": { "workstreamId": "W1" }, "text": "skip the review", "clientRequestId": "s1" }),
        ),
        (
            "project_stop",
            json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "reason": "agent says so" }),
        ),
    ] {
        let Err(crate::hub::api::CallError::Tool(e)) = call(agent_key(), tool, input).await else {
            panic!("an agent's key passed {tool}");
        };
        assert_eq!(
            e.code,
            fleetd_contracts::mcp::ErrorCode::Forbidden,
            "{tool}: {e:?}"
        );
    }
    follow_requests(&hub).await;
    assert!(still_open(), "nothing the agent did moved a request");
    call(
        person(),
        "approval_answer",
        json!({ "requestId": command.request_id, "decision": "deny" }),
    )
    .await
    .expect("the person still decides");
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

/// A question stays open through the lead's later status lines (the lab saw "1. Which day…?" followed by "The
/// unsubscribe link is merged." clear the dot); only the human's reply clears it, and an open item keeps it.
#[test]
fn a_question_stays_open_until_the_human_replies() {
    let (hub, _home) = hub();
    let r = project();
    let human = |text: &str| NewMessage {
        author: Some(ChatAuthor::Human),
        text: text.into(),
        ..Default::default()
    };
    hub.chat.add(&r, human("set up the newsletter")).unwrap();
    hub.chat
        .add(
            &r,
            lead_says("Two things:\n1. Which day should it go out? I'd pick Monday."),
        )
        .unwrap();
    for status in [
        "The unsubscribe link is merged.",
        "The template PR is up and in review.",
    ] {
        hub.chat.add(&r, lead_says(status)).unwrap();
        hub.chat.system_line(&r, "Max agents 40 → 1.").unwrap();
        assert!(
            hub.chat.state(&r, false).unwrap().needs_you,
            "lost after: {status}"
        );
    }
    // A status line streaming in doesn't ask, and doesn't answer.
    hub.chat
        .add(
            &r,
            NewMessage {
                streaming: true,
                source: Some("lead:t:s".into()),
                ..lead_says("Should I")
            },
        )
        .unwrap();
    assert!(hub.chat.state(&r, false).unwrap().needs_you);
    hub.chat.add(&r, human("monday")).unwrap();
    assert!(
        !hub.chat.state(&r, false).unwrap().needs_you,
        "the human replied"
    );
    hub.chat
        .add(&r, lead_says("Monday it is. Shipping it now."))
        .unwrap();
    assert!(!hub.chat.state(&r, false).unwrap().needs_you);
    // Many status lines after a new question: still asked, past any page of recent messages.
    hub.chat
        .add(
            &r,
            lead_says("1. Send a test issue to you first? I'd say yes."),
        )
        .unwrap();
    for i in 0..60 {
        hub.chat
            .add(&r, lead_says(&format!("Agent {i} finished.")))
            .unwrap();
    }
    assert!(hub.chat.state(&r, false).unwrap().needs_you);
}

/// The state read loads only the lead's live messages since the human's last one, never the imported past.
#[test]
fn a_state_read_skips_imported_history() {
    let (hub, _home) = hub();
    let r = project();
    for i in 0..30 {
        hub.chat
            .add(
                &r,
                NewMessage {
                    history: Some(ChatHistorySource::LeadMessage),
                    source: Some(format!("lead:old:{i}")),
                    ..lead_says("Which one? (from before the chat)")
                },
            )
            .unwrap();
    }
    hub.chat.add(&r, lead_says("Shipped the fix.")).unwrap();
    let read = hub.chat.since_human(&r).unwrap();
    assert_eq!(
        read.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["Shipped the fix."]
    );
    assert!(!hub.chat.state(&r, false).unwrap().needs_you);
}

/// A running lead thread and two running agents of the project, as the hub stores them.
fn lead_and_two_agents(hub: &Hub) {
    give_lead(hub);
    let thread: crate::hub::store::StoredThread = serde_json::from_value(json!({
        "machineId": "devbox", "threadId": "lead-thread", "projectId": "app", "title": "lead",
        "status": "running", "headline": "", "latestMessageTail": "", "lastProgressAt": AT,
        "stale": false, "asOf": AT,
    }))
    .unwrap();
    hub.store.thread_upsert(&thread).unwrap();
    for n in [1, 2] {
        let task: fleetd_contracts::tasks::Task = serde_json::from_value(json!({
            "taskId": format!("T{n}"), "projectRef": { "machineId": "devbox", "projectId": "app" },
            "workstreamId": "W9", "title": "write it", "kind": "write", "prompt": "do it", "areas": ["api"],
            "model": "claude-opus-5-5", "effort": "high", "state": "running", "attempt": 1, "createdAt": AT,
            "startedAt": AT, "threadRef": { "machineId": "devbox", "threadId": format!("task-{n}") },
        }))
        .unwrap();
        hub.db
            .with(|c| Ok(crate::hub::tasks::records::TaskRecords::create(c, task)?))
            .unwrap();
    }
}

/// Links a node for the project's machine that does whatever it is asked; returns the calls it got.
async fn obliging_node(
    hub: &Arc<Hub>,
) -> Arc<std::sync::Mutex<Vec<fleetd_contracts::sessions::SessionCall>>> {
    obliging_node_with(hub, None).await
}

/// `obliging_node`, whose sessions answer a follow with `followed` (a thread snapshot) when there is one.
async fn obliging_node_with(
    hub: &Arc<Hub>,
    followed: Option<Value>,
) -> Arc<std::sync::Mutex<Vec<fleetd_contracts::sessions::SessionCall>>> {
    use fleetd_contracts::node_link::{HubToNode, NodeToHub};
    use fleetd_contracts::sessions::SessionCall;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let machine = project().machine_id;
    hub.executors
        .attach(
            &machine,
            crate::hub::executor::NodeSessions {
                link_id: 1,
                send: tx,
            },
        )
        .await;
    let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (seen, executors) = (calls.clone(), hub.executors.clone());
    tokio::spawn(async move {
        while let Some(HubToNode::SessionCall(f)) = rx.recv().await {
            let result = match &f.call {
                SessionCall::Follow { .. } => match &followed {
                    Some(snapshot) => json!({ "ok": snapshot }),
                    None => json!({ "err": { "code": "not_found", "message": "-" } }),
                },
                SessionCall::Send { run_id, .. } => {
                    json!({ "ok": { "kind": "sent", "runId": run_id.as_str(), "queued": false } })
                }
                SessionCall::ReadFile { .. } => json!({ "ok": { "kind": "file" } }),
                _ => json!({ "ok": { "kind": "done" } }),
            };
            seen.lock().unwrap().push(f.call);
            let frame: NodeToHub = serde_json::from_value(
                json!({ "t": "session_reply", "id": f.id, "result": result }),
            )
            .unwrap();
            executors.handle_frame(&machine, frame);
        }
    });
    calls
}

fn live_agents(hub: &Hub) -> usize {
    hub.tasks.live(Some(&project())).len()
}

/// Dogfood: "Stop: nothing was running" while the lead and two agents ran. Stop all now stops all three and says so.
#[tokio::test]
async fn stop_all_stops_the_lead_and_its_agents_and_says_so() {
    let (hub, _home) = hub();
    lead_and_two_agents(&hub);
    let calls = obliging_node(&hub).await;
    let stop = crate::hub::api::registry()
        .call(
            &hub,
            &person(),
            "project_stop",
            json!({ "projectRef": { "machineId": "devbox", "projectId": "app" } }),
        )
        .await
        .unwrap();
    assert_eq!(stop["message"]["text"], "Stopped the lead and 2 agents.");
    assert_eq!(stop["cancelled"], 2);
    assert_eq!(live_agents(&hub), 0);
    let calls = calls.lock().unwrap();
    assert!(calls.iter().any(|c| matches!(c,
        fleetd_contracts::sessions::SessionCall::Interrupt { session_id, run_id: None, .. } if session_id.as_str() == "lead-thread")));
}

/// A stop takes the order's waiting PRs off the train, so none merges or waits for a reviewer, and leaves them open
/// on GitHub; the line names them. A PR already in CI is on its way in and keeps going.
#[tokio::test]
async fn a_stop_takes_the_orders_prs_off_the_train_and_says_which() {
    use crate::hub::train::contract::{Change, ChangeState};
    let (hub, _home) = hub();
    let (w, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: project(),
            title: "Dark mode".into(),
            text: "add dark mode".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    let records = hub.train.records();
    let change = |number: i64, state: &str| -> Change {
        serde_json::from_value(json!({
            "changeId": "X1", "projectRef": { "machineId": "devbox", "projectId": "app" }, "repo": "o/app",
            "prNumber": number, "prUrl": format!("https://github.com/o/app/pull/{number}"),
            "branch": format!("fleetd/pr-{number}"), "workstreamId": w.workstream_id, "headSha": "b".repeat(40),
            "state": state, "reviews": [], "createdAt": AT, "updatedAt": AT,
        }))
        .unwrap()
    };
    let [reviewing, ready, in_ci] = [(6, "reviewing"), (7, "ready"), (8, "ci")]
        .map(|(n, state)| records.create(change(n, state)));
    let stop = crate::hub::api::registry()
        .call(
            &hub,
            &person(),
            "project_stop",
            json!({ "projectRef": { "machineId": "devbox", "projectId": "app" } }),
        )
        .await
        .unwrap();
    let text = stop["message"]["text"].as_str().unwrap();
    assert!(
        text.ends_with(" Left open, off the train: #6, #7."),
        "{text}"
    );
    let state = |c: &Change| records.get(&c.change_id).unwrap().state;
    assert_eq!(
        [state(&reviewing), state(&ready), state(&in_ci)],
        [
            ChangeState::Abandoned,
            ChangeState::Abandoned,
            ChangeState::Ci
        ]
    );
}

/// With the machine away nothing can be stopped, and the line says what still runs instead of "nothing was running".
#[tokio::test]
async fn stop_all_says_what_it_could_not_stop() {
    let (hub, _home) = hub();
    lead_and_two_agents(&hub);
    let stop = crate::hub::api::registry()
        .call(
            &hub,
            &person(),
            "project_stop",
            json!({ "projectRef": { "machineId": "devbox", "projectId": "app" } }),
        )
        .await
        .unwrap();
    assert_eq!(
        stop["message"]["text"],
        "Nothing stopped. The lead's turn could not be stopped: its machine didn't answer. 2 agents could not be stopped and are still working."
    );
    assert_eq!(live_agents(&hub), 2);
}

/// Dogfood: Stop in the chat said "nothing was running" while two agents ran, and they kept running. The chat's Stop
/// stops the lead's turn and the project's agents, and its line says so; a retry stops nothing again.
#[tokio::test]
async fn the_chats_stop_stops_the_lead_and_its_agents() {
    let (hub, _home) = hub();
    lead_and_two_agents(&hub);
    let calls = obliging_node(&hub).await;
    let tools = crate::hub::api::registry();
    let input = json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "clientRequestId": "s1" });
    let stop = tools
        .call(&hub, &person(), "chat_stop", input.clone())
        .await
        .unwrap();
    assert_eq!(stop["stopped"], true);
    assert_eq!(
        (
            stop["message"]["author"].as_str(),
            stop["message"]["text"].as_str()
        ),
        (Some("system"), Some("Stopped the lead and 2 agents."))
    );
    assert_eq!(live_agents(&hub), 0);
    let again = tools
        .call(&hub, &person(), "chat_stop", input)
        .await
        .unwrap();
    assert_eq!(again["message"]["messageId"], stop["message"]["messageId"]);
    assert_eq!(again["stopped"], true);
    let interrupts = |calls: &[fleetd_contracts::sessions::SessionCall]| {
        calls
            .iter()
            .filter(|c| matches!(c, fleetd_contracts::sessions::SessionCall::Interrupt { .. }))
            .count()
    };
    assert_eq!(interrupts(&calls.lock().unwrap()), 1);
}

/// The agents run while the lead is idle (the dogfood case): Stop stops them, and says only what it stopped.
#[tokio::test]
async fn stop_with_an_idle_lead_stops_its_agents() {
    let (hub, _home) = hub();
    lead_and_two_agents(&hub);
    let _calls = obliging_node(&hub).await;
    let mut thread = hub
        .store
        .thread_get(&fleetd_contracts::ids::ThreadRef {
            machine_id: project().machine_id,
            thread_id: fleetd_contracts::ids::ThreadId::unchecked("lead-thread"),
        })
        .unwrap()
        .unwrap();
    thread.thread.status = fleetd_contracts::model::ThreadStatus::Idle;
    hub.store.thread_upsert(&thread).unwrap();
    let tools = crate::hub::api::registry();
    let input = |id: &str| json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "clientRequestId": id });
    let stop = tools
        .call(&hub, &person(), "chat_stop", input("s1"))
        .await
        .unwrap();
    assert_eq!(stop["stopped"], true);
    assert_eq!(stop["message"]["text"], "Stopped 2 agents.");
    assert_eq!(live_agents(&hub), 0);
    // Now nothing runs, and only now does it say so.
    let idle = tools
        .call(&hub, &person(), "chat_stop", input("s2"))
        .await
        .unwrap();
    assert_eq!(idle["stopped"], false);
    assert_eq!(idle["message"]["text"], "Nothing was running.");
}

/// Dogfood: chat events read "You in the chat of 320d8829-…". They name the project by its title.
#[tokio::test]
async fn chat_events_name_the_project_by_its_title() {
    let (hub, _home) = hub();
    hub.store
        .projects_upsert_many(
            &project().machine_id,
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "app", "title": "storefront", "workspaceRoot": "/work/app",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    hub.chat.system_line(&project(), "Hello.").unwrap();
    let unknown = ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("320d8829-1aba-4d1d-2ce8-4aaeb96aa43f"),
    };
    hub.chat.system_line(&unknown, "Hello.").unwrap();
    let page = futures_util::FutureExt::now_or_never(hub.events.wait(WaitInput {
        cursor: Some(0),
        types: Some(vec![HubEventType::ChatMessage]),
        machine_id: None,
        timeout_sec: 0,
    }))
    .unwrap()
    .unwrap();
    let summaries: Vec<String> = page
        .events
        .into_iter()
        .map(|e| e.summary.as_str().to_owned())
        .collect();
    assert_eq!(
        summaries,
        [
            "fleetd in the chat of storefront",
            "fleetd in a project's chat"
        ]
    );
}

/// What a lead's session looks like to the streamer: its current text and the replies it stored complete.
fn lead_parts(
    text: Option<(&str, &str)>,
    done: &[(&str, &str)],
) -> crate::hub::executor::LiveParts {
    use crate::hub::executor::activity::{DoneText, StreamText};
    crate::hub::executor::LiveParts {
        activity: None,
        tokens: None,
        spark: serde_json::from_value(json!({ "endAt": AT, "samples": [] })).unwrap(),
        text: text.map(|(id, tail)| StreamText {
            message_id: id.into(),
            tail: tail.into(),
            total: tail.chars().count() as u64,
        }),
        done: done
            .iter()
            .map(|(id, text)| DoneText {
                message_id: (*id).into(),
                text: (*text).into(),
            })
            .collect(),
        run_active: true,
    }
}

/// The dogfood bug: the node drops a delta still pending when its complete message lands, so a reply's last words
/// never stream. The chat lands the complete reply, final, as soon as the session has it (not when the turn ends,
/// minutes later), and a reply none of whose words streamed lands too, in its place.
#[tokio::test]
async fn a_reply_lands_whole_and_final_even_when_its_last_delta_never_came() {
    let (hub, _home) = hub();
    give_lead(&hub);
    let r = project();
    hub.chat
        .read_history(&r, || async { Vec::new() })
        .await
        .unwrap();
    let full = "Reading the proposal and the current app code so I can slice all 25 items plus A–C into parallel PRs.";
    let mut sent = HashMap::new();
    let mut deltas = hub.chat.subscribe();
    let tick = |sent: &mut HashMap<String, u64>, parts: crate::hub::executor::LiveParts| {
        flow::stream_pass_with(&hub, sent, |_| Some(parts.clone()));
    };
    let latest = || hub.chat.page(&r, None, None, 10).unwrap().0;

    tick(
        &mut sent,
        lead_parts(Some(("m1", "Reading the proposal and the")), &[]),
    );
    assert_eq!(
        deltas.try_recv().unwrap().append.as_str(),
        "Reading the proposal and the"
    );
    assert_eq!(latest()[0].state, ChatMessageState::Streaming);

    // The rest of the words were in the dropped delta; the complete message came instead.
    let parts = lead_parts(
        Some(("m1", "Reading the proposal and the")),
        &[("m1", full)],
    );
    tick(&mut sent, parts.clone());
    let m = &latest()[0];
    assert_eq!((m.text.as_str(), m.state), (full, ChatMessageState::Final));
    let last = events_of(&hub, HubEventType::ChatMessage).pop().unwrap();
    assert_eq!(
        (last["state"].as_str(), last["message"]["text"].as_str()),
        (Some("final"), Some(full))
    );
    // Landed once: the next ticks announce nothing more.
    let announced = events_of(&hub, HubEventType::ChatMessage).len();
    tick(&mut sent, parts);
    assert_eq!(events_of(&hub, HubEventType::ChatMessage).len(), announced);

    // A short reply sent in one dropped delta, then the next reply already streaming: both, in order.
    tick(
        &mut sent,
        lead_parts(
            Some(("m3", "Now the A/C")),
            &[("m1", full), ("m2", "Opening the workstream.")],
        ),
    );
    let texts: Vec<_> = latest()
        .iter()
        .map(|m| (m.text.as_str().to_owned(), m.state))
        .collect();
    assert_eq!(
        texts,
        [
            (full.to_owned(), ChatMessageState::Final),
            (
                "Opening the workstream.".to_owned(),
                ChatMessageState::Final
            ),
            ("Now the A/C".to_owned(), ChatMessageState::Streaming),
        ]
    );
}

/// Agents never carry the person's authority: an agent key, admin on every machine like the CLI's own, can't stop or
/// steer.
#[tokio::test]
async fn only_a_persons_key_stops_or_steers() {
    let (hub, _home) = hub();
    lead_and_two_agents(&hub);
    let admin_agent = Caller {
        grants: serde_json::from_value(json!([{ "role": "admin", "machines": "*" }])).unwrap(),
        ..agent_key()
    };
    let tools = crate::hub::api::registry();
    let r = json!({ "machineId": "devbox", "projectId": "app" });
    for (tool, input) in [
        (
            "chat_stop",
            json!({ "projectRef": r, "clientRequestId": "s1" }),
        ),
        ("project_stop", json!({ "projectRef": r })),
        (
            "steer_send",
            json!({ "target": { "taskId": "T1" }, "text": "stop", "mode": "now", "clientRequestId": "s1" }),
        ),
        (
            "chat_send",
            json!({ "projectRef": r, "text": "stop", "now": true, "clientRequestId": "s1" }),
        ),
    ] {
        let Err(crate::hub::api::CallError::Tool(e)) =
            tools.call(&hub, &admin_agent, tool, input).await
        else {
            panic!("{tool} let an agent key act as the person");
        };
        assert_eq!(
            e.code,
            fleetd_contracts::mcp::ErrorCode::Forbidden,
            "{tool}"
        );
    }
    assert_eq!(live_agents(&hub), 2);
    // The app's probe with an empty input: forbidden for a key that may not stop, invalid for one that may.
    let probe = async |caller: &Caller| match tools.call(&hub, caller, "chat_stop", json!({})).await
    {
        Err(crate::hub::api::CallError::Tool(e)) => e.code,
        _ => panic!("an empty chat_stop ran"),
    };
    assert_eq!(
        probe(&admin_agent).await,
        fleetd_contracts::mcp::ErrorCode::Forbidden
    );
    assert_eq!(
        probe(&person()).await,
        fleetd_contracts::mcp::ErrorCode::Invalid
    );
}

/// ⌘Enter is chat_send with now: a working lead's running step stops for it through steer_send's own interrupt
/// (SendMode::Now to the node), and it stays an ordinary chat message that says so. An idle lead takes it as any
/// message, a plain new turn.
#[tokio::test]
async fn now_stops_a_working_leads_step_and_stays_a_chat_message() {
    use fleetd_contracts::sessions::{SendMode, SessionCall};
    let (hub, _home) = hub();
    lead_and_two_agents(&hub);
    let calls = obliging_node(&hub).await;
    hub.executors.set_runner_ready(&project().machine_id, true);
    hub.executors.await_ready(&project().machine_id).await;
    let tools = crate::hub::api::registry();
    let mut input = say_to_app("stop, the schema changed", "n1", None);
    input["now"] = json!(true);
    let sent = tools
        .call(&hub, &person(), "chat_send", input)
        .await
        .unwrap();
    assert_eq!(sent["message"]["delivery"], "now");
    let modes = || {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter_map(|c| match c {
                SessionCall::Send { mode, steer, .. } => Some((*mode, steer.is_some())),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(modes(), [(SendMode::Now, false)]);
    let (page, _, _) = hub.chat.page(&project(), None, None, 10).unwrap();
    assert_eq!(
        page.iter()
            .map(|m| (m.text.as_str(), m.delivery))
            .collect::<Vec<_>>(),
        [("stop, the schema changed", Some(ChatDelivery::Now))],
        "in the chat like any message, and the only record of it"
    );
    assert_eq!(steers_stored(&hub), 0);
    // The lead's turn ended: now changes nothing, it starts the next turn.
    let mut thread = hub
        .store
        .thread_get(&fleetd_contracts::ids::ThreadRef {
            machine_id: project().machine_id,
            thread_id: fleetd_contracts::ids::ThreadId::unchecked("lead-thread"),
        })
        .unwrap()
        .unwrap();
    thread.thread.status = fleetd_contracts::model::ThreadStatus::Idle;
    hub.store.thread_upsert(&thread).unwrap();
    let mut idle = say_to_app("and then the docs", "n2", None);
    idle["now"] = json!(true);
    let idle = tools
        .call(&hub, &person(), "chat_send", idle)
        .await
        .unwrap();
    assert_eq!(idle["message"]["delivery"], "turn");
    assert_eq!(modes()[1..], [(SendMode::Plain, false)]);
}

fn steers_stored(hub: &Hub) -> i64 {
    hub.db
        .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM steers", [], |r| r.get(0))?))
        .unwrap()
}

/// A reply cut off mid-text (the run stopped, interrupted or crashed before the session stored it complete) is
/// finished with what streamed once the run is over, so it never says it is still writing. Not while the run goes on.
#[tokio::test]
async fn a_reply_cut_off_mid_text_lands_final_once_its_run_is_over() {
    let (hub, _home) = hub();
    give_lead(&hub);
    let r = project();
    hub.chat
        .read_history(&r, || async { Vec::new() })
        .await
        .unwrap();
    let thread_ref = fleetd_contracts::ids::ThreadRef {
        machine_id: r.machine_id.clone(),
        thread_id: fleetd_contracts::ids::ThreadId::unchecked("lead-thread"),
    };
    let thread = |status: &str| {
        crate::hub::store::StoredThread {
        thread: serde_json::from_value(json!({
            "machineId": "devbox", "threadId": "lead-thread", "projectId": "app", "title": "lead", "status": status,
            "headline": "", "latestMessageTail": "", "lastProgressAt": AT, "stale": false, "asOf": AT,
        }))
        .unwrap(),
        last_sequence: None,
        last_run_id: None,
        last_run_status: None,
    }
    };
    let mut sent = HashMap::new();
    let parts = lead_parts(Some(("m1", "Reading the proposal and ")), &[]);
    flow::stream_pass_with(&hub, &mut sent, |_| Some(parts.clone()));
    let latest = || hub.chat.page(&r, None, None, 10).unwrap().0;
    assert_eq!(latest()[0].state, ChatMessageState::Streaming);

    // Paused on a request, the run resumes: the reply may still go on.
    for status in ["running", "waiting"] {
        hub.store.thread_upsert(&thread(status)).unwrap();
        flow::mirror(&hub, &r, &thread_ref).await;
        assert_eq!(latest()[0].state, ChatMessageState::Streaming, "{status}");
    }

    // Stopped mid-text: no complete message ever comes.
    hub.store.thread_upsert(&thread("interrupted")).unwrap();
    flow::mirror(&hub, &r, &thread_ref).await;
    let m = &latest()[0];
    assert_eq!(
        (m.text.as_str(), m.state),
        ("Reading the proposal and", ChatMessageState::Final)
    );
    let last = events_of(&hub, HubEventType::ChatMessage).pop().unwrap();
    assert_eq!(
        (last["state"].as_str(), last["message"]["text"].as_str()),
        (Some("final"), Some("Reading the proposal and"))
    );
    let announced = events_of(&hub, HubEventType::ChatMessage).len();
    flow::mirror(&hub, &r, &thread_ref).await;
    assert_eq!(events_of(&hub, HubEventType::ChatMessage).len(), announced);
}

/// The chat says what a working lead is doing from its lane, so the board scope carries a working lead's lane before
/// its turn opens any order, and not an idle one's.
#[test]
fn a_working_lead_has_a_live_lane_before_it_opens_an_order() {
    let (hub, _home) = hub();
    give_lead(&hub);
    let lead_lane = || {
        crate::hub::app_ws::live::board_lanes(&hub, &person())
            .iter()
            .map(|l| l.lane.lane_id.as_str().to_owned())
            .collect::<Vec<_>>()
    };
    let thread = |status: &str| {
        crate::hub::store::StoredThread {
        thread: serde_json::from_value(json!({
            "machineId": "devbox", "threadId": "lead-thread", "projectId": "app", "title": "lead", "status": status,
            "headline": "", "latestMessageTail": "", "lastProgressAt": AT, "stale": false, "asOf": AT,
        }))
        .unwrap(),
        last_sequence: None,
        last_run_id: None,
        last_run_status: None,
    }
    };
    hub.store.thread_upsert(&thread("completed")).unwrap();
    assert!(
        lead_lane().is_empty(),
        "an idle lead with no order has no lane"
    );
    hub.store.thread_upsert(&thread("running")).unwrap();
    assert_eq!(lead_lane(), ["lead:devbox/app"]);
}

/// The lead's thread row as the node last reported it.
fn lead_thread_row(status: &str) -> crate::hub::store::StoredThread {
    serde_json::from_value(json!({
        "machineId": "devbox", "threadId": "lead-thread", "projectId": "app", "title": "lead", "status": status,
        "headline": "", "latestMessageTail": "", "lastProgressAt": AT, "stale": false, "asOf": AT,
    }))
    .unwrap()
}

/// The lead's session as the node answers a follow: `runs` and `messages` of it.
fn lead_session(status: &str, runs: Value, messages: Value) -> Value {
    json!({
        "kind": "snapshot", "truncated": false, "items": [], "runs": runs, "messages": messages,
        "summary": { "sessionId": "lead-thread", "projectId": "app", "title": "lead", "status": status,
            "model": "claude-opus-5-5", "effort": "high", "runtimeMode": "full-access",
            "createdAt": AT, "updatedAt": AT },
    })
}

fn said(id: &str, run: &str, role: &str, text: &str, at: &str) -> Value {
    json!({ "id": id, "runId": run, "role": role, "text": text, "createdAt": at })
}

fn lead_texts(hub: &Hub) -> Vec<(String, ChatMessageState)> {
    let (page, _, _) = hub.chat.page(&project(), None, None, 50).unwrap();
    page.into_iter()
        .filter(|m| m.author == ChatAuthor::Lead)
        .map(|m| (m.text.as_str().to_owned(), m.state))
        .collect()
}

const ASKED: &str = "how can this be improved?";
const ANSWER: &str = "W8 is closed. What would make it a factory, in priority order: …";

/// The live bug: a person's message resumed the lead, whose session first ran claude's own turn for a background
/// task's notice, so the node reported the run over before the turn began. The lead then closed its order and
/// replied, after the run had ended and the chat had read the thread for that end. The reply still lands, once.
#[tokio::test]
async fn a_resumed_lead_turn_that_closes_its_order_lands_its_reply() {
    use fleetd_contracts::node_link::NodeToHub;
    let (hub, _home) = hub();
    give_lead(&hub);
    let r = project();
    hub.chat
        .read_history(&r, || async { Vec::new() })
        .await
        .unwrap();
    let (order, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: r.clone(),
            title: "UX items".into(),
            text: "build the approved UX items".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    hub.store
        .thread_upsert(&lead_thread_row("completed"))
        .unwrap();
    let turn = "r68";
    obliging_node_with(
        &hub,
        Some(lead_session(
            "running",
            json!([{ "id": turn, "status": "running", "ordinal": 68 }]),
            json!([said(turn, turn, "user", ASKED, "2026-10-19T10:00:01.000Z")]),
        )),
    )
    .await;
    hub.executors.set_runner_ready(&r.machine_id, true);
    hub.executors.await_ready(&r.machine_id).await;
    let tools = crate::hub::api::registry();
    let sent = tools
        .call(&hub, &person(), "chat_send", say_to_app(ASKED, "q1", None))
        .await
        .unwrap();
    assert_eq!(sent["message"]["delivery"], "turn", "{sent}");

    let thread = fleetd_contracts::ids::ThreadRef {
        machine_id: r.machine_id.clone(),
        thread_id: fleetd_contracts::ids::ThreadId::unchecked("lead-thread"),
    };
    // The hub follows the lead's session.
    hub.executors.messages(&thread).await.unwrap();
    let frame = |event: Value| {
        let frame =
            serde_json::from_value(json!({ "sessionId": "lead-thread", "at": AT, "event": event }))
                .unwrap();
        hub.executors
            .handle_frame(&r.machine_id, NodeToHub::ThreadEvent(frame));
    };
    // The lead closes its order...
    frame(
        json!({ "type": "item", "id": "close-1", "runId": turn, "status": "completed", "title": "",
        "startedAt": AT, "completedAt": AT, "updatedAt": AT,
        "kind": { "type": "tool", "toolName": "mcp__fleetd__close", "input": { "workstreamId": order.workstream_id },
            "output": "Closed." } }),
    );
    hub.leads
        .records
        .workstream_put(&fleetd_contracts::ledger::Workstream {
            state: WorkstreamState::Done,
            ..order
        })
        .unwrap();
    // ...its run reads as over (the notice turn's end), and the chat reads the thread for that end...
    frame(json!({ "type": "run", "id": turn, "status": "completed", "ordinal": 68 }));
    hub.store
        .thread_upsert(&lead_thread_row("completed"))
        .unwrap();
    flow::mirror(&hub, &r, &thread).await;
    assert!(lead_texts(&hub).is_empty(), "no reply yet");
    // ...and its reply comes after.
    frame(
        json!({ "type": "message", "id": "msg_reply", "runId": turn, "role": "assistant", "text": ANSWER,
        "createdAt": "2026-10-19T10:00:48.000Z" }),
    );
    let mut sent = HashMap::new();
    let live = |t: &fleetd_contracts::ids::ThreadRef| hub.executors.live(t);
    flow::stream_pass_with(&hub, &mut sent, live);
    assert_eq!(
        lead_texts(&hub),
        [(ANSWER.to_owned(), ChatMessageState::Final)]
    );
    let (page, _, _) = hub.chat.page(&r, None, None, 50).unwrap();
    assert_eq!(
        page.iter().map(|m| m.author).collect::<Vec<_>>(),
        [ChatAuthor::Human, ChatAuthor::Lead],
        "the reply follows the message it answers"
    );
    // Once: later ticks, the next turn's read and a re-delivery add nothing.
    let announced = events_of(&hub, HubEventType::ChatMessage).len();
    flow::stream_pass_with(&hub, &mut sent, live);
    flow::mirror(&hub, &r, &thread).await;
    flow::land_missed(&hub, None).await;
    assert_eq!(lead_texts(&hub).len(), 1);
    assert_eq!(events_of(&hub, HubEventType::ChatMessage).len(), announced);
}

/// A reply the chat never got (lost as above, or said while the hub was down) lands when the hub next reads the lead:
/// not on its start, when the node hasn't linked yet, but when its machine comes online. Once, by its source, after
/// the person's message it answers; a reply already in the chat isn't added again.
#[tokio::test]
async fn a_missed_lead_reply_is_redelivered_once() {
    let (hub, _home) = hub();
    give_lead(&hub);
    let r = project();
    hub.chat
        .read_history(&r, || async { Vec::new() })
        .await
        .unwrap();
    hub.store
        .thread_upsert(&lead_thread_row("completed"))
        .unwrap();
    let earlier = "#398 has merged.";
    hub.chat
        .add(
            &r,
            NewMessage {
                author: Some(ChatAuthor::Lead),
                text: earlier.into(),
                source: Some(history::lead_source("lead-thread", "msg_earlier")),
                ..Default::default()
            },
        )
        .unwrap();
    hub.chat
        .add(
            &r,
            NewMessage {
                author: Some(ChatAuthor::Human),
                text: ASKED.into(),
                ..Default::default()
            },
        )
        .unwrap();
    // The hub starts before the node links: nothing to read, nothing lands.
    flow::land_missed(&hub, None).await;
    assert_eq!(lead_texts(&hub).len(), 1);

    obliging_node_with(
        &hub,
        Some(lead_session(
            "idle",
            json!([{ "id": "r67", "status": "completed", "ordinal": 67 },
                   { "id": "r68", "status": "completed", "ordinal": 68 }]),
            json!([
                said(
                    "msg_earlier",
                    "r67",
                    "assistant",
                    earlier,
                    "2026-10-19T09:00:00.000Z"
                ),
                said("r68", "r68", "user", ASKED, "2026-10-19T10:00:01.000Z"),
                said(
                    "msg_reply",
                    "r68",
                    "assistant",
                    ANSWER,
                    "2026-10-19T10:00:48.000Z"
                ),
            ]),
        )),
    )
    .await;
    hub.executors.await_live(&r.machine_id).await;
    flow::land_missed(&hub, Some(&r.machine_id)).await;
    let (page, _, _) = hub.chat.page(&r, None, None, 50).unwrap();
    let last = page.last().unwrap();
    assert_eq!(
        (last.author, last.text.as_str(), last.state, last.history),
        (ChatAuthor::Lead, ANSWER, ChatMessageState::Final, None)
    );
    assert_eq!(last.created_at.as_str(), "2026-10-19T10:00:48.000Z");
    assert_eq!(page.len(), 3, "the earlier reply isn't added again");
    let announced = events_of(&hub, HubEventType::ChatMessage).len();
    flow::land_missed(&hub, Some(&r.machine_id)).await;
    flow::land_missed(&hub, None).await;
    assert_eq!(hub.chat.page(&r, None, None, 50).unwrap().0.len(), 3);
    assert_eq!(events_of(&hub, HubEventType::ChatMessage).len(), announced);
}

/// A reply in bubbles is one message with ordered parts: none while it streams, its bubbles and block once final, and
/// the same message (parts and all) however often it is landed again by its source. An ask block waits on the human.
#[tokio::test]
async fn a_reply_in_bubbles_lands_once_with_its_parts_and_its_ask_waits_on_you() {
    let (hub, _home) = hub();
    give_lead(&hub);
    let r = project();
    hub.chat
        .read_history(&r, || async { Vec::new() })
        .await
        .unwrap();
    let full = "nice, #412 is green\n\n```fleetd-block\n{\"v\":1,\"kind\":\"ask\",\"question\":\"merge it tonight?\"}\n```";
    let mut sent = HashMap::new();
    let tick = |sent: &mut HashMap<String, u64>, parts: crate::hub::executor::LiveParts| {
        flow::stream_pass_with(&hub, sent, |_| Some(parts.clone()));
    };
    let latest = || hub.chat.page(&r, None, None, 10).unwrap().0;

    tick(
        &mut sent,
        lead_parts(Some(("m1", "nice, #412 is green\n\n")), &[]),
    );
    assert_eq!(latest()[0].state, ChatMessageState::Streaming);
    assert!(latest()[0].parts.is_none(), "no parts while it streams");

    let done = lead_parts(Some(("m1", "nice, #412 is green\n\n")), &[("m1", full)]);
    tick(&mut sent, done.clone());
    let m = latest().remove(0);
    let parts = m.parts.clone().expect("a final reply in bubbles has parts");
    assert_eq!(parts.len(), 2);
    assert_eq!((parts[0].start.get(), parts[0].end.get()), (0, 19));
    assert!(parts[0].block.is_none());
    assert!(matches!(
        parts[1].block.as_ref().map(|b| &b.body),
        Some(fleetd_contracts::blocks::BlockBody::Ask(_))
    ));
    assert!(hub.chat.state(&r, false).unwrap().needs_you);

    // Landed again: by the stream pass, and by a re-read of the thread (the missed-reply path adds by source).
    let announced = events_of(&hub, HubEventType::ChatMessage).len();
    tick(&mut sent, done);
    let source = history::lead_source("lead-thread", "m1");
    let (again, new) = hub
        .chat
        .add(
            &r,
            NewMessage {
                author: Some(ChatAuthor::Lead),
                text: full.into(),
                source: Some(source),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(!new);
    assert_eq!((again.message_id, again.parts), (m.message_id, m.parts));
    assert_eq!(latest().len(), 1);
    assert_eq!(events_of(&hub, HubEventType::ChatMessage).len(), announced);

    // The human's tap is a chat reply, and it answers.
    hub.chat
        .add(
            &r,
            NewMessage {
                author: Some(ChatAuthor::Human),
                text: "Approve".into(),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(!hub.chat.state(&r, false).unwrap().needs_you);
}
