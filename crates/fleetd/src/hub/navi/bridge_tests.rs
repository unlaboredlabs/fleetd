use std::sync::Arc;

use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::ErrorCode;
use serde_json::{Value, json};

use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, lead_by};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, NewEvent};

const AT: &str = "2026-10-25T10:00:00.000Z";

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
    }
}

/// A hub with a Navi called "Home" (`navi`, in `assistants`) and two coding projects.
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
        ("storefront", "Storefront"),
        ("checkout", "Checkout"),
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
            // Navi core's table (its migration makes it on a hub that has it).
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS assistants (
                   machine_id TEXT NOT NULL, project_id TEXT NOT NULL, created_ms INTEGER NOT NULL,
                   created_by_key TEXT NOT NULL, created_by_name TEXT NOT NULL, archived_ms INTEGER,
                   PRIMARY KEY (machine_id, project_id)
                 );
                 INSERT INTO assistants (machine_id, project_id, created_ms, created_by_key, created_by_name)
                 VALUES ('devbox', 'navi', 1792000000000, 'k1', 'desk');",
            )?;
            Ok(())
        })
        .unwrap();
    (hub, home)
}

/// A lead-side call as `r`'s lead makes it: the result as JSON, or the refusal's code and words.
async fn call(hub: &Hub, r: &ProjectRef, call: Value) -> Result<Value, (ErrorCode, String)> {
    let op = call["op"].as_str().unwrap().to_owned();
    let call: LeadCall = serde_json::from_value(call).unwrap();
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: lead_by(r),
        agent: CallerAgent::Lead,
    };
    let handler = hub.lead_calls.handler(&op).unwrap();
    match handler.handle(caller, call).await {
        Ok(LeadCallResult::ProjectMessage(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(LeadCallResult::FactoryStatus(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(LeadCallResult::BriefCreate(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(LeadCallResult::Close(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(LeadCallResult::Checklist(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(other) => panic!("unexpected result {other:?}"),
        Err(e) => Err((
            e.code,
            format!("{} {}", e.message, e.fix.unwrap_or_default()),
        )),
    }
}

fn brief() -> Value {
    json!({ "goal": "Gift cards at checkout", "why": "Asked by the person", "pointers": [], "constraints": [],
            "doneWhen": ["A gift card pays at checkout"] })
}

/// The bridge's wakes from the event log since `cursor`, and the cursor after them.
fn follow(hub: &Hub, cursor: i64) -> (i64, Vec<(ProjectRef, String)>) {
    let (cursor, more, sent) = super::step(hub, cursor).unwrap();
    assert!(!more);
    (cursor, sent)
}

#[tokio::test]
async fn a_navi_writes_to_another_lead_as_itself_never_as_the_person() {
    let (hub, _home) = hub();
    let out = call(
        &hub,
        &project("navi"),
        json!({ "op": "project_message", "project": "storefront", "text": "Please add gift cards at checkout." }),
    )
    .await
    .unwrap();
    assert_eq!(out["handle"], "N1");
    assert_eq!(out["title"], "Storefront");
    assert_eq!(out["projectRef"]["projectId"], "storefront");
    assert!(
        out["next"]
            .as_str()
            .unwrap()
            .contains("never as the person's approval"),
        "{out}"
    );
    let (messages, _, _) = hub
        .chat
        .page(&project("storefront"), None, None, 50)
        .unwrap();
    let said = messages.last().unwrap();
    assert_eq!(said.author, ChatAuthor::Agent);
    assert_eq!(said.by.as_deref(), Some("Navi Home"));
    assert_eq!(
        said.text,
        "Please add gift cards at checkout.\n\n(Ask N1. If you open an order for it, pass asked: \"N1\" to brief, \
         so Navi hears when it lands.)"
    );
    // What the lead reads says it is an agent's, not the person's.
    let set = hub.db.prompts().current(Some(&project("storefront")));
    let for_lead = crate::hub::chat::flow::for_lead(&set, said, None, "", "The human");
    assert!(for_lead.contains("Navi Home"), "{for_lead}");
}

#[tokio::test]
async fn only_a_navi_uses_the_bridge_and_only_toward_other_projects() {
    let (hub, _home) = hub();
    let message = |to: &str| json!({ "op": "project_message", "project": to, "text": "hi" });
    // A coding project's lead keeps to its own project.
    let (code, why) = call(&hub, &project("checkout"), message("storefront"))
        .await
        .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden, "{why}");
    let (code, _) = call(
        &hub,
        &project("checkout"),
        json!({ "op": "factory_status" }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    // Not its own project, and not one the hub doesn't have.
    let (code, why) = call(&hub, &project("navi"), message("Home"))
        .await
        .unwrap_err();
    assert_eq!(code, ErrorCode::Invalid);
    assert!(why.contains("own project"), "{why}");
    let (code, why) = call(&hub, &project("navi"), message("payroll"))
        .await
        .unwrap_err();
    assert_eq!(code, ErrorCode::NotFound);
    assert!(why.contains("factory_status"), "{why}");
    // Nothing was written anywhere.
    for r in ["storefront", "navi"] {
        let (messages, _, _) = hub.chat.page(&project(r), None, None, 50).unwrap();
        assert!(messages.iter().all(|m| m.author != ChatAuthor::Agent));
    }
    // An archived Navi no longer does.
    hub.db
        .with(|c| {
            c.execute("UPDATE assistants SET archived_ms = 1792000001000", [])?;
            Ok(())
        })
        .unwrap();
    let (code, _) = call(&hub, &project("navi"), message("storefront"))
        .await
        .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    // A task never makes the calls.
    let task = CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T3"));
    for op in super::OPS {
        assert!(crate::hub::tasks::policy::check(&task, op).is_err(), "{op}");
    }
}

#[tokio::test]
async fn factory_status_reads_every_other_project_or_the_one_named() {
    let (hub, _home) = hub();
    let navi = project("navi");
    call(&hub, &navi, json!({ "op": "project_message", "project": "Storefront", "text": "Gift cards, please.\nSoon." }))
        .await
        .unwrap();
    call(
        &hub,
        &project("storefront"),
        json!({ "op": "brief_create", "text": "Gift cards", "brief": brief(), "asked": "N1" }),
    )
    .await
    .unwrap();
    follow(&hub, 0);
    call(
        &hub,
        &project("storefront"),
        json!({ "op": "checklist", "items": [{ "text": "Receipts", "state": "done" }, { "text": "Gift cards" }] }),
    )
    .await
    .unwrap();
    let all = call(&hub, &navi, json!({ "op": "factory_status" }))
        .await
        .unwrap();
    let titles: Vec<&str> = all["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles.len(), 2, "{titles:?}");
    assert!(titles.contains(&"Storefront") && titles.contains(&"Checkout"));
    assert!(!titles.contains(&"Home"), "a Navi doesn't read itself");

    let one = call(
        &hub,
        &navi,
        json!({ "op": "factory_status", "project": "storefront" }),
    )
    .await
    .unwrap();
    let projects = one["projects"].as_array().unwrap();
    assert_eq!(projects.len(), 1);
    let store = &projects[0];
    assert_eq!(store["state"], "idle");
    assert_eq!(store["agentsRunning"], 0);
    assert_eq!(store["openOrders"][0]["workstreamId"], "W1");
    assert_eq!(store["openOrders"][0]["asked"], "N1");
    assert_eq!(store["asks"][0]["handle"], "N1");
    assert_eq!(store["asks"][0]["text"], "Gift cards, please.");
    assert_eq!(store["asks"][0]["orders"], json!(["W1"]));
    let todo: Vec<&str> = store["checklist"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["text"].as_str().unwrap())
        .collect();
    assert_eq!(todo, ["Gift cards"], "done items are left out");
}

#[tokio::test]
async fn the_navi_hears_when_its_order_opens_closes_and_its_pr_merges_or_fails() {
    let (hub, _home) = hub();
    let navi = project("navi");
    let shop = project("storefront");
    let start = hub.events.head();
    call(
        &hub,
        &navi,
        json!({ "op": "project_message", "project": "storefront", "text": "Gift cards, please." }),
    )
    .await
    .unwrap();
    // An order the shop's lead opens on its own wakes no Navi.
    call(
        &hub,
        &shop,
        json!({ "op": "brief_create", "text": "Dark mode", "brief": brief() }),
    )
    .await
    .unwrap();
    // Nor does one in another project that names the ask: only the project asked can answer it.
    call(
        &hub,
        &project("checkout"),
        json!({ "op": "brief_create", "text": "Gift cards", "brief": brief(), "asked": "N1" }),
    )
    .await
    .unwrap();
    let (cursor, sent) = follow(&hub, start);
    assert_eq!(sent, []);

    let opened = call(
        &hub,
        &shop,
        json!({ "op": "brief_create", "text": "Gift cards", "brief": brief(), "asked": "N1" }),
    )
    .await
    .unwrap();
    let w = opened["workstreamId"].as_str().unwrap().to_owned();
    assert_eq!(w, "W3");
    let (cursor, sent) = follow(&hub, cursor);
    assert_eq!(
        sent,
        [(
            navi.clone(),
            "- N1 to Storefront: its lead opened order W3 \"Gift cards\"".to_owned()
        )]
    );
    assert!(hub.leads.wakes.pending(&navi), "the Navi's lead is woken");

    let change = |to: &str, pr: i64| NewEvent {
        at: Timestamp(AT.into()),
        r#type: HubEventType::ChangeState,
        machine_id: Some(shop.machine_id.clone()),
        project_id: Some(shop.project_id.clone()),
        thread_id: None,
        summary: format!("#{pr} {to}"),
        data: Some(
            json!({ "changeId": "X4", "workstreamId": w, "repo": "acme/storefront", "prNumber": pr,
                           "from": "ci", "to": to }),
        ),
        attention: None,
    };
    hub.events.append(change("reviewing", 41)).unwrap();
    hub.events.append(change("ci_failed", 41)).unwrap();
    hub.events.append(change("merged", 42)).unwrap();
    let (cursor, sent) = follow(&hub, cursor);
    let lines: Vec<&str> = sent.iter().map(|(_, l)| l.as_str()).collect();
    assert_eq!(
        lines,
        [
            "- N1 to Storefront: PR #41 (acme/storefront) of order W3 \"Gift cards\" failed CI",
            "- N1 to Storefront: PR #42 (acme/storefront) of order W3 \"Gift cards\" merged",
        ]
    );

    call(
        &hub,
        &shop,
        json!({ "op": "close", "workstreamId": w, "why": "Gift cards pay at checkout" }),
    )
    .await
    .unwrap();
    let (_, sent) = follow(&hub, cursor);
    assert_eq!(
        sent,
        [(
            navi.clone(),
            "- N1 to Storefront: order W3 \"Gift cards\" is done: Gift cards pay at checkout"
                .to_owned()
        )]
    );
}

#[tokio::test]
async fn a_retried_message_is_the_first_ask_not_a_second_post() {
    let (hub, _home) = hub();
    let navi = project("navi");
    let message =
        |text: &str| json!({ "op": "project_message", "project": "storefront", "text": text });
    let agent_posts = |hub: &Hub| {
        let (messages, _, _) = hub
            .chat
            .page(&project("storefront"), None, None, 50)
            .unwrap();
        messages
            .iter()
            .filter(|m| m.author == ChatAuthor::Agent)
            .count()
    };
    let first = call(&hub, &navi, message("Gift cards, please."))
        .await
        .unwrap();
    let again = call(&hub, &navi, message("Gift cards, please."))
        .await
        .unwrap();
    assert_eq!(first["handle"], "N1");
    assert_eq!(again["handle"], "N1", "a retry returns the first handle");
    assert_eq!(agent_posts(&hub), 1, "and posts nothing new");
    // Other words are a new ask.
    let other = call(&hub, &navi, message("And dark mode.")).await.unwrap();
    assert_eq!(other["handle"], "N2");
    assert_eq!(agent_posts(&hub), 2);
    // The same words after the retry window are a new ask too.
    hub.db
        .with(|c| {
            c.execute("UPDATE navi_asks SET at_ms = at_ms - 11 * 60 * 1000", [])?;
            Ok(())
        })
        .unwrap();
    let later = call(&hub, &navi, message("Gift cards, please."))
        .await
        .unwrap();
    assert_eq!(later["handle"], "N3");
    assert_eq!(agent_posts(&hub), 3);
}

fn key(machines: Value) -> crate::hub::api::Caller {
    serde_json::from_value(json!({
        "keyId": "k1", "name": "desk", "kind": "human", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "read", "machines": machines }],
    }))
    .unwrap()
}

#[tokio::test]
async fn the_app_reads_a_navis_asks_with_their_orders_and_states() {
    use crate::hub::api::CallError;
    assert!(fleetd_contracts::app::APP_FEATURES.contains(&"navi_asks"));
    let (hub, _home) = hub();
    let navi = project("navi");
    let shop = project("storefront");
    let tools = crate::hub::api::registry();
    let (person, elsewhere) = (key(json!("*")), key(json!(["laptop"])));
    let read = |caller, navi: &str| {
        tools.call(
            &hub,
            caller,
            "navi_asks",
            json!({ "navi": { "machineId": "devbox", "projectId": navi } }),
        )
    };
    let none = read(&person, "navi").await.unwrap();
    assert_eq!(none["asks"], json!([]));
    assert!(
        none["next"]
            .as_str()
            .unwrap()
            .contains("asked no other project")
    );

    call(
        &hub,
        &navi,
        json!({ "op": "project_message", "project": "storefront", "text": "Gift cards, please." }),
    )
    .await
    .unwrap();
    call(
        &hub,
        &navi,
        json!({ "op": "project_message", "project": "checkout", "text": "Is Apple Pay on?" }),
    )
    .await
    .unwrap();
    let opened = call(
        &hub,
        &shop,
        json!({ "op": "brief_create", "text": "Gift cards", "brief": brief(), "asked": "N1" }),
    )
    .await
    .unwrap();
    let w = opened["workstreamId"].as_str().unwrap().to_owned();
    follow(&hub, 0);
    call(
        &hub,
        &shop,
        json!({ "op": "close", "workstreamId": w, "why": "Shipped" }),
    )
    .await
    .unwrap();

    let out = read(&person, "navi").await.unwrap();
    let asks = out["asks"].as_array().unwrap();
    assert_eq!(asks.len(), 2);
    // Newest first; the words are the Navi's own, without the line for the lead.
    assert_eq!(asks[0]["handle"], "N2");
    assert_eq!(asks[0]["toTitle"], "Checkout");
    assert_eq!(asks[0]["text"], "Is Apple Pay on?");
    assert_eq!(asks[0]["orders"], json!([]));
    assert_eq!(asks[1]["handle"], "N1");
    assert_eq!(asks[1]["to"]["projectId"], "storefront");
    assert_eq!(
        asks[1]["orders"],
        json!([{ "workstreamId": w, "title": "Gift cards", "state": "done" }])
    );

    // A key that can't read the Navi's machine reads nothing, and an unknown project is not found.
    let Err(CallError::Tool(e)) = read(&elsewhere, "navi").await else {
        panic!("a key without read on devbox reads a Navi's asks");
    };
    assert_eq!(e.code, ErrorCode::Forbidden);
    let Err(CallError::Tool(e)) = read(&person, "payroll").await else {
        panic!("an unknown project has asks");
    };
    assert_eq!(e.code, ErrorCode::NotFound);
    let Err(CallError::Tool(e)) = read(&person, "checkout").await else {
        panic!("a coding project has asks");
    };
    assert_eq!(e.code, ErrorCode::NotFound);
    assert!(e.message.contains("not a Navi"), "{}", e.message);
}

#[tokio::test]
async fn the_app_reads_another_machines_orders_only_with_read_there() {
    let (hub, _home) = hub();
    let navi = project("navi");
    let laptop = ProjectRef {
        machine_id: MachineId::unchecked("laptop"),
        project_id: ProjectId::unchecked("payroll"),
    };
    hub.store
        .projects_upsert_many(
            &laptop.machine_id,
            &[serde_json::from_value(json!({
                "machineId": "laptop", "projectId": "payroll", "title": "Payroll", "workspaceRoot": "/work/payroll",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    call(&hub, &navi, json!({ "op": "project_message", "project": "Payroll", "text": "Run the October payslips." }))
        .await
        .unwrap();
    call(
        &hub,
        &laptop,
        json!({ "op": "brief_create", "text": "October payslips", "brief": brief(), "asked": "N1" }),
    )
    .await
    .unwrap();
    follow(&hub, 0);
    let tools = crate::hub::api::registry();
    let (everywhere, devbox) = (key(json!("*")), key(json!(["devbox"])));
    let read = |caller| {
        tools.call(
            &hub,
            caller,
            "navi_asks",
            json!({ "navi": { "machineId": "devbox", "projectId": "navi" } }),
        )
    };
    let all = read(&everywhere).await.unwrap();
    assert_eq!(all["asks"][0]["toTitle"], "Payroll");
    assert_eq!(all["asks"][0]["orders"][0]["title"], "October payslips");
    // A key that reads only devbox sees the Navi's own words, but not laptop's project title or orders.
    let mine = read(&devbox).await.unwrap();
    let ask = &mine["asks"][0];
    assert_eq!(ask["handle"], "N1");
    assert_eq!(ask["text"], "Run the October payslips.");
    assert_eq!(ask["toTitle"], "payroll");
    assert_eq!(ask["orders"], json!([]));
    assert!(!mine.to_string().contains("Payroll"), "{mine}");
    assert!(!mine.to_string().contains("\"title\""), "{mine}");
}
