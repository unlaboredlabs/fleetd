use std::sync::Arc;

use fleetd_contracts::chat::{CHAT_PAGE_MAX, ChatAuthor};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::ErrorCode;
use serde_json::{Value, json};

use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::chat::NewMessage;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, lead_by};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, parse_ms};

const AT: &str = "2026-10-25T10:00:00.000Z";

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
    }
}

/// A hub with two Navis, "Home" (`navi`) and "Work" (`work`), and a coding project.
fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    for (id, title) in [
        ("navi", "Home"),
        ("work", "Work"),
        ("storefront", "Storefront"),
    ] {
        hub.store
            .projects_upsert_many(
                &MachineId::unchecked("devbox"),
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": id, "title": title, "workspaceRoot": format!("/work/{id}"),
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
    }
    hub.db
        .with(|c| {
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS assistants (
                   machine_id TEXT NOT NULL, project_id TEXT NOT NULL, created_ms INTEGER NOT NULL,
                   created_by_key TEXT NOT NULL, created_by_name TEXT NOT NULL, archived_ms INTEGER,
                   PRIMARY KEY (machine_id, project_id)
                 );
                 INSERT INTO assistants (machine_id, project_id, created_ms, created_by_key, created_by_name)
                 VALUES ('devbox', 'navi', 1792000000000, 'k1', 'desk'), ('devbox', 'work', 1792000000000, 'k2', 'laptop');",
            )?;
            Ok(())
        })
        .unwrap();
    (hub, home)
}

fn say(hub: &Hub, r: &ProjectRef, author: ChatAuthor, text: &str, at: &str) -> String {
    let (m, _) = hub
        .chat
        .add(
            r,
            NewMessage {
                author: Some(author),
                text: text.to_owned(),
                created_ms: parse_ms(at),
                ..Default::default()
            },
        )
        .unwrap();
    m.message_id.to_string()
}

/// A lead-side call as `r`'s session `agent` makes it: the result as JSON, or the refusal's code and words.
async fn call_as(
    hub: &Hub,
    r: &ProjectRef,
    agent: CallerAgent,
    call: Value,
) -> Result<Value, (ErrorCode, String)> {
    let op = call["op"].as_str().unwrap().to_owned();
    let call: LeadCall = serde_json::from_value(call).unwrap();
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: lead_by(r),
        agent,
    };
    match hub
        .lead_calls
        .handler(&op)
        .unwrap()
        .handle(caller, call)
        .await
    {
        Ok(LeadCallResult::ChatSearch(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(LeadCallResult::ChatRead(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(other) => panic!("unexpected result {other:?}"),
        Err(e) => Err((
            e.code,
            format!("{} {}", e.message, e.fix.unwrap_or_default()),
        )),
    }
}

async fn call(hub: &Hub, r: &ProjectRef, call: Value) -> Result<Value, (ErrorCode, String)> {
    call_as(hub, r, CallerAgent::Lead, call).await
}

fn ids(out: &Value) -> Vec<String> {
    out["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["messageId"].as_str().unwrap().to_owned())
        .collect()
}

fn texts(out: &Value) -> Vec<String> {
    out["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["text"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_navi_finds_what_the_person_said_long_before_its_recent_chat_and_reads_around_it() {
    let (hub, _home) = hub();
    let navi = project("navi");
    say(
        &hub,
        &navi,
        ChatAuthor::Human,
        "who was that dentist again?",
        "2026-10-14T09:00:00Z",
    );
    let hit = say(
        &hub,
        &navi,
        ChatAuthor::Human,
        "My dentist is Dr. Okafor on Elm Street, Saturdays only.",
        "2026-10-14T09:01:00Z",
    );
    say(
        &hub,
        &navi,
        ChatAuthor::Lead,
        "noted: Dr. Okafor, Saturdays",
        "2026-10-14T09:02:00Z",
    );
    for i in 0..150 {
        say(
            &hub,
            &navi,
            ChatAuthor::Lead,
            &format!("morning brief {i}"),
            "2026-10-20T08:00:00Z",
        );
    }
    // The newest page of the chat no longer holds it.
    let (recent, _, _) = hub.chat.page(&navi, None, None, CHAT_PAGE_MAX).unwrap();
    assert!(recent.iter().all(|m| !m.text.as_str().contains("Okafor")));

    // Any case, any order, every word.
    let out = call(
        &hub,
        &navi,
        json!({ "op": "chat_search", "words": "elm OKAFOR" }),
    )
    .await
    .unwrap();
    assert_eq!(ids(&out), std::slice::from_ref(&hit));
    let found = &out["messages"][0];
    assert_eq!(found["author"], "human");
    assert_eq!(found["at"], "2026-10-14T09:01:00.000Z");
    assert!(out.get("more").is_none(), "{out}");
    assert!(out["next"].as_str().unwrap().contains("chat_read"), "{out}");
    // A word it doesn't hold: nothing, and a hint.
    let none = call(
        &hub,
        &navi,
        json!({ "op": "chat_search", "words": "okafor dermatologist" }),
    )
    .await
    .unwrap();
    assert!(ids(&none).is_empty());
    assert!(
        none["next"]
            .as_str()
            .unwrap()
            .contains("fewer or other words"),
        "{none}"
    );

    // The messages around it, oldest first.
    let around = call(
        &hub,
        &navi,
        json!({ "op": "chat_read", "messageId": hit, "before": 1, "after": 2 }),
    )
    .await
    .unwrap();
    assert_eq!(
        texts(&around),
        [
            "who was that dentist again?",
            "My dentist is Dr. Okafor on Elm Street, Saturdays only.",
            "noted: Dr. Okafor, Saturdays",
            "morning brief 0",
        ]
    );
    assert_eq!(
        (
            around["moreBefore"].as_bool(),
            around["moreAfter"].as_bool()
        ),
        (Some(false), Some(true))
    );
    // Five each way when not told.
    let wide = call(&hub, &navi, json!({ "op": "chat_read", "messageId": hit }))
        .await
        .unwrap();
    assert_eq!(texts(&wide).len(), 1 + 1 + 5);
}

#[tokio::test]
async fn hits_come_a_page_at_a_time_newest_first() {
    let (hub, _home) = hub();
    let navi = project("navi");
    for i in 0..45 {
        say(
            &hub,
            &navi,
            ChatAuthor::Human,
            &format!("groceries list {i}"),
            AT,
        );
        say(&hub, &navi, ChatAuthor::Lead, "ok", AT);
    }
    let page = |before: Option<String>| {
        let mut q = json!({ "op": "chat_search", "words": "groceries" });
        if let Some(b) = before {
            q["before"] = json!(b);
        }
        call(&hub, &navi, q)
    };
    let first = page(None).await.unwrap();
    assert_eq!(texts(&first).len(), 20);
    assert_eq!(texts(&first)[0], "groceries list 44");
    assert_eq!(first["more"], true);
    let last = ids(&first).pop().unwrap();
    assert!(first["next"].as_str().unwrap().contains(&last), "{first}");
    let second = page(Some(last)).await.unwrap();
    assert_eq!(texts(&second)[0], "groceries list 24");
    assert_eq!(texts(&second).len(), 20);
    let third = page(ids(&second).pop()).await.unwrap();
    assert_eq!(
        texts(&third),
        (0..5)
            .rev()
            .map(|i| format!("groceries list {i}"))
            .collect::<Vec<_>>()
    );
    assert!(third.get("more").is_none(), "{third}");
    // LIKE's own signs are only letters here.
    say(&hub, &navi, ChatAuthor::Human, "a 100% refund", AT);
    let percent = call(&hub, &navi, json!({ "op": "chat_search", "words": "0%" }))
        .await
        .unwrap();
    assert_eq!(texts(&percent), ["a 100% refund"]);
    let underscore = call(
        &hub,
        &navi,
        json!({ "op": "chat_search", "words": "groceries_list" }),
    )
    .await
    .unwrap();
    assert!(ids(&underscore).is_empty());
}

#[tokio::test]
async fn a_date_range_keeps_to_its_days() {
    let (hub, _home) = hub();
    let navi = project("navi");
    for (text, at) in [
        ("passport renewal form", "2026-10-01T12:00:00Z"),
        ("passport photo booked", "2026-10-15T00:00:00Z"),
        ("passport arrived", "2026-10-15T23:59:00Z"),
        ("passport in the drawer", "2026-10-16T00:00:00Z"),
    ] {
        say(&hub, &navi, ChatAuthor::Human, text, at);
    }
    let search = |q: Value| call(&hub, &navi, q);
    let day = search(json!({ "op": "chat_search", "words": "passport", "from": "2026-10-15", "to": "2026-10-15" }))
        .await
        .unwrap();
    assert_eq!(texts(&day), ["passport arrived", "passport photo booked"]);
    let since =
        search(json!({ "op": "chat_search", "words": "passport", "from": "2026-10-15T12:00:00Z" }))
            .await
            .unwrap();
    assert_eq!(
        texts(&since),
        ["passport in the drawer", "passport arrived"]
    );
    let until = search(json!({ "op": "chat_search", "words": "passport", "to": "2026-10-14" }))
        .await
        .unwrap();
    assert_eq!(texts(&until), ["passport renewal form"]);
    let (code, why) =
        search(json!({ "op": "chat_search", "words": "passport", "from": "last tuesday" }))
            .await
            .unwrap_err();
    assert_eq!(code, ErrorCode::Invalid);
    assert!(why.contains("2026-10-20"), "{why}");
}

#[tokio::test]
async fn only_a_navi_reads_back_and_only_its_own_chat() {
    let (hub, _home) = hub();
    let navi = project("navi");
    let mine = say(
        &hub,
        &navi,
        ChatAuthor::Human,
        "the wifi password is on the fridge",
        AT,
    );
    let theirs = say(
        &hub,
        &project("work"),
        ChatAuthor::Human,
        "the wifi at the office",
        AT,
    );
    let code_chat = say(
        &hub,
        &project("storefront"),
        ChatAuthor::Human,
        "wifi page copy",
        AT,
    );
    // Another Navi's chat and a project's chat never show up in this Navi's search.
    let out = call(&hub, &navi, json!({ "op": "chat_search", "words": "wifi" }))
        .await
        .unwrap();
    assert_eq!(ids(&out), [mine]);
    // Nor are they read around, or paged from.
    for other in [&theirs, &code_chat] {
        let (code, why) = call(
            &hub,
            &navi,
            json!({ "op": "chat_read", "messageId": other }),
        )
        .await
        .unwrap_err();
        assert_eq!(code, ErrorCode::NotFound, "{why}");
        let (code, _) = call(
            &hub,
            &navi,
            json!({ "op": "chat_search", "words": "wifi", "before": other }),
        )
        .await
        .unwrap_err();
        assert_eq!(code, ErrorCode::NotFound);
    }
    // A coding project's lead has no such call.
    let (code, _) = call(
        &hub,
        &project("storefront"),
        json!({ "op": "chat_search", "words": "wifi" }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    // Nor has a person's shell in the Navi's folder: they read the chat in the app.
    let (code, _) = call_as(
        &hub,
        &navi,
        CallerAgent::Person,
        json!({ "op": "chat_read", "messageId": out["messages"][0]["messageId"] }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    // A task never makes the calls.
    let task = CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T3"));
    for op in super::OPS {
        assert!(crate::hub::tasks::policy::check(&task, op).is_err(), "{op}");
    }
}

#[test]
fn a_long_message_is_cut_around_the_words_and_reads_whole_alone() {
    let text = format!(
        "{} the plumber is Ana Ruiz {}",
        "x".repeat(1000),
        "y".repeat(1000)
    );
    let (cut, was_cut) = super::excerpt(&text, &["ruiz"], 300);
    assert!(was_cut);
    assert!(cut.contains("Ana Ruiz"), "{cut}");
    assert!(cut.starts_with('…') && cut.ends_with('…'), "{cut}");
    assert_eq!(cut.chars().count(), 302);
    let (short, was_cut) = super::excerpt("Ana Ruiz", &["ruiz"], 300);
    assert_eq!((short.as_str(), was_cut), ("Ana Ruiz", false));
}
