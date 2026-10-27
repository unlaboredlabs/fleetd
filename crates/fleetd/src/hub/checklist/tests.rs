use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::ErrorCode;
use serde_json::{Value, json};

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, WaitInput};

const AT: &str = "2026-10-25T10:00:00.000Z";

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
    }
}

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
    for id in ["storefront", "checkout"] {
        hub.store
            .projects_upsert_many(
                &MachineId::unchecked("devbox"),
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": id, "title": id, "workspaceRoot": format!("/work/{id}"),
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
    }
    (hub, home)
}

fn reader() -> Caller {
    serde_json::from_value(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "read", "machines": "*" }],
    }))
    .unwrap()
}

/// The lead's `checklist`, as its session calls it: the items after it, or the refusal's words.
async fn checklist(hub: &Hub, r: &ProjectRef, call: Value) -> Result<Value, String> {
    let mut call = call;
    call["op"] = "checklist".into();
    let call: LeadCall = serde_json::from_value(call).map_err(|e| e.to_string())?;
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: crate::hub::link::lead_calls::lead_by(r),
        agent: CallerAgent::Lead,
    };
    let handler = hub.lead_calls.handler("checklist").unwrap();
    match handler.handle(caller, call).await {
        Ok(LeadCallResult::Checklist(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(other) => Err(format!("not a checklist result: {other:?}")),
        Err(e) => Err(format!(
            "{:?} {}: {}",
            e.code,
            e.message,
            e.fix.unwrap_or_default()
        )),
    }
}

/// A person's device: a human key with operate.
fn person() -> Caller {
    let c: Caller = serde_json::from_value(json!({
        "keyId": "k3", "name": "laptop", "prefix": "fld_abcdeh", "createdAt": AT,
        "grants": [{ "role": "operate", "machines": "*" }],
    }))
    .unwrap();
    Caller {
        kind: Some(KeyKind::Human),
        ..c
    }
}

/// The app's Delete and Clear done.
async fn remove(
    hub: &Arc<Hub>,
    caller: &Caller,
    r: &ProjectRef,
    ids: Value,
) -> Result<Value, CallError> {
    crate::hub::api::registry()
        .call(
            hub,
            caller,
            "checklist_remove",
            json!({ "projectRef": r, "ids": ids }),
        )
        .await
}

async fn get(hub: &Arc<Hub>, r: &ProjectRef) -> Result<Value, CallError> {
    crate::hub::api::registry()
        .call(hub, &reader(), "checklist_get", json!({ "projectRef": r }))
        .await
}

fn shape(items: &Value) -> Vec<(i64, String, String)> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["id"].as_i64().unwrap(),
                i["state"].as_str().unwrap().to_owned(),
                i["text"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn changes(hub: &Hub) -> Vec<Value> {
    let page = futures_util::FutureExt::now_or_never(hub.events.wait(WaitInput {
        cursor: Some(0),
        types: Some(vec![HubEventType::ChecklistChanged]),
        machine_id: None,
        timeout_sec: 0,
    }))
    .unwrap()
    .unwrap();
    page.events
        .into_iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect()
}

#[tokio::test]
async fn the_lead_sets_and_updates_its_projects_list_and_the_app_reads_it_live() {
    let (hub, _home) = hub();
    let r = project("storefront");

    // Before the lead sets one, the app reads an empty list and why.
    let empty = get(&hub, &r).await.unwrap();
    assert_eq!(empty["items"], json!([]));
    assert!(empty.get("updatedAt").is_none());
    assert!(
        empty["next"]
            .as_str()
            .unwrap()
            .contains("lead keeps this list")
    );

    let out = checklist(
        &hub,
        &r,
        json!({ "items": [
            { "text": "Receipts in the shop's time zone", "link": { "workstreamId": "W3" } },
            { "text": "Dark mode", "state": "doing" },
            { "text": "Release notes" },
        ] }),
    )
    .await
    .unwrap();
    assert_eq!(
        shape(&out["items"]),
        [
            (1, "todo".into(), "Receipts in the shop's time zone".into()),
            (2, "doing".into(), "Dark mode".into()),
            (3, "todo".into(), "Release notes".into()),
        ]
    );
    assert_eq!(out["items"][0]["link"], json!({ "workstreamId": "W3" }));

    // Changes by id, in order: one done with its PR, one removed, one added; the removed id is never reused.
    checklist(
        &hub,
        &r,
        json!({ "items": [
            { "id": 2, "state": "done", "link": { "pr": "https://github.com/acme/storefront/pull/11" } },
            { "id": 3, "remove": true },
            { "text": "Ship it", "state": "todo" },
        ] }),
    )
    .await
    .unwrap();
    let list = get(&hub, &r).await.unwrap();
    assert_eq!(
        shape(&list["items"]),
        [
            (1, "todo".into(), "Receipts in the shop's time zone".into()),
            (2, "done".into(), "Dark mode".into()),
            (4, "todo".into(), "Ship it".into()),
        ]
    );
    assert_eq!(
        list["items"][1]["link"]["pr"],
        "https://github.com/acme/storefront/pull/11"
    );
    assert_eq!(list["updatedAt"], "2026-10-14T17:46:40.000Z");

    // Each change is one live event the app reads it again on, with the progress and who changed it.
    let events = changes(&hub);
    assert_eq!(events.len(), 2);
    let last = &events[1];
    assert_eq!(
        (last["machineId"].as_str(), last["projectId"].as_str()),
        (Some("devbox"), Some("storefront"))
    );
    assert_eq!(last["data"]["done"], 1);
    assert_eq!(last["data"]["total"], 3);
    assert_eq!(last["data"]["by"], "lead:devbox/storefront");
    assert_eq!(last["summary"], "checklist: 1 of 3 done");

    // The same state again writes nothing and tells no one.
    let same = checklist(&hub, &r, json!({ "items": [{ "id": 2, "state": "done" }] }))
        .await
        .unwrap();
    assert!(same["next"].as_str().unwrap().starts_with("No change"));
    assert_eq!(changes(&hub).len(), 2);

    // Another project's list is its own.
    let other = get(&hub, &project("checkout")).await.unwrap();
    assert_eq!(other["items"], json!([]));
}

#[tokio::test]
async fn a_refused_call_changes_nothing_and_says_what_is_there() {
    let (hub, _home) = hub();
    let r = project("storefront");
    checklist(
        &hub,
        &r,
        json!({ "items": [{ "text": "One" }, { "text": "Two" }] }),
    )
    .await
    .unwrap();

    // An unknown id late in the call undoes the edits before it.
    let refused = checklist(
        &hub,
        &r,
        json!({ "items": [{ "id": 1, "state": "done" }, { "id": 9, "state": "done" }] }),
    )
    .await
    .unwrap_err();
    assert!(refused.starts_with("NotFound No item 9"), "{refused}");
    assert!(refused.contains("Its items are 1, 2."), "{refused}");
    assert_eq!(shape(&get(&hub, &r).await.unwrap()["items"])[0].1, "todo");

    // Past the cap: refused with how to make room.
    let many: Vec<Value> = (0..49)
        .map(|n| json!({ "text": format!("Item {n}") }))
        .collect();
    let full = checklist(&hub, &r, json!({ "items": many }))
        .await
        .unwrap_err();
    assert!(
        full.contains("holds 50 items") && full.contains("Remove done items"),
        "{full}"
    );
    assert_eq!(
        get(&hub, &r).await.unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    // replace sets the whole list, ids going on from the last; with no items it clears it.
    let replaced = checklist(
        &hub,
        &r,
        json!({ "replace": true, "items": [{ "text": "Fresh" }] }),
    )
    .await
    .unwrap();
    assert_eq!(
        shape(&replaced["items"]),
        [(3, "todo".into(), "Fresh".into())]
    );
    let cleared = checklist(&hub, &r, json!({ "replace": true }))
        .await
        .unwrap();
    assert_eq!(cleared["items"], json!([]));
}

#[tokio::test]
async fn the_app_reads_a_known_project_only_with_read_on_its_machine() {
    let (hub, _home) = hub();
    let Err(CallError::Tool(e)) = get(&hub, &project("nope")).await else {
        panic!("an unknown project reads");
    };
    assert_eq!(e.code, ErrorCode::NotFound);
    let elsewhere: Caller = serde_json::from_value(json!({
        "keyId": "k2", "name": "other", "prefix": "fld_abcdeg", "createdAt": AT,
        "grants": [{ "role": "read", "machines": ["laptop"] }],
    }))
    .unwrap();
    let Err(CallError::Tool(e)) = crate::hub::api::registry()
        .call(
            &hub,
            &elsewhere,
            "checklist_get",
            json!({ "projectRef": project("storefront") }),
        )
        .await
    else {
        panic!("a key without read on devbox reads its checklist");
    };
    assert_eq!(e.code, ErrorCode::Forbidden);
}

#[test]
fn only_the_lead_keeps_the_checklist() {
    let task = CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T3"));
    for op in super::calls::OPS {
        assert!(crate::hub::tasks::policy::check(&task, op).is_err(), "{op}");
        assert!(
            crate::hub::tasks::policy::check(&CallerAgent::Lead, op).is_ok(),
            "{op}"
        );
    }
}

#[tokio::test]
async fn the_leads_digest_shows_what_is_still_open() {
    let (hub, _home) = hub();
    let r = project("storefront");
    assert_eq!(super::digest_lines(&hub.db, &r), None);
    checklist(
        &hub,
        &r,
        json!({ "items": [
            { "text": "Receipts", "state": "done" },
            { "text": "Dark mode", "state": "doing", "link": { "taskId": "T4", "pr": "https://github.com/acme/storefront/pull/12" } },
            { "text": "Release notes" },
        ] }),
    )
    .await
    .unwrap();
    assert_eq!(
        super::digest_lines(&hub.db, &r).unwrap(),
        [
            "1 of 3 done; keep it current with `checklist`",
            "- 2 doing: Dark mode (T4, PR #12)",
            "- 3 todo: Release notes",
        ]
    );
}

#[tokio::test]
async fn a_person_deletes_an_item_and_clears_the_done_ones_and_the_lead_reads_the_new_list() {
    let (hub, _home) = hub();
    let r = project("storefront");
    checklist(
        &hub,
        &r,
        json!({ "items": [
            { "text": "Receipts", "state": "done" },
            { "text": "Dark mode", "state": "doing" },
            { "text": "Release notes" },
            { "text": "Gift cards", "state": "done" },
        ] }),
    )
    .await
    .unwrap();

    // Delete one: the list after it comes back, the app hears of it, and the lead's next wake names what went.
    let out = remove(&hub, &person(), &r, json!([3])).await.unwrap();
    assert_eq!(
        shape(&out["items"]),
        [
            (1, "done".into(), "Receipts".into()),
            (2, "doing".into(), "Dark mode".into()),
            (4, "done".into(), "Gift cards".into()),
        ]
    );
    let last = changes(&hub).pop().unwrap();
    assert_eq!(last["data"]["by"], "human:laptop");
    assert_eq!(last["summary"], "checklist: 2 of 3 done");
    assert_eq!(
        hub.leads.wakes.held(&r),
        [
            "- the human took 1 item off the checklist: 3 \"Release notes\"; leave it off unless they ask again"
        ]
    );

    // Clear done: the app sends the done ids it showed.
    remove(&hub, &person(), &r, json!([1, 4])).await.unwrap();
    assert_eq!(
        shape(&get(&hub, &r).await.unwrap()["items"]),
        [(2, "doing".into(), "Dark mode".into())]
    );
    assert!(
        hub.leads.wakes.held(&r)[1]
            .contains("2 items off the checklist: 1 \"Receipts\", 4 \"Gift cards\"")
    );

    // The lead's checklist reads the same list: an edit by a removed id is refused with what is there, its digest
    // shows only what is left, and a new item takes a fresh id.
    let gone = checklist(
        &hub,
        &r,
        json!({ "items": [{ "id": 3, "state": "doing" }] }),
    )
    .await
    .unwrap_err();
    assert!(
        gone.contains("No item 3") && gone.contains("Its items are 2."),
        "{gone}"
    );
    assert_eq!(
        super::digest_lines(&hub.db, &r).unwrap(),
        [
            "0 of 1 done; keep it current with `checklist`",
            "- 2 doing: Dark mode"
        ]
    );
    let digest = hub.leads.wakes.digest(&r).await.unwrap();
    assert!(
        digest.contains("- 2 doing: Dark mode") && !digest.contains("Release notes"),
        "{digest}"
    );
    let added = checklist(&hub, &r, json!({ "items": [{ "text": "Ship it" }] }))
        .await
        .unwrap();
    assert_eq!(shape(&added["items"])[1].0, 5);

    // Ids already gone (the lead removed them first, or a second window) change nothing and tell no one.
    let before = changes(&hub).len();
    remove(&hub, &person(), &r, json!([1, 3])).await.unwrap();
    assert_eq!(changes(&hub).len(), before);
    assert_eq!(hub.leads.wakes.held(&r).len(), 2);
}

#[tokio::test]
async fn only_a_persons_device_with_operate_removes_items() {
    let (hub, _home) = hub();
    let r = project("storefront");
    checklist(&hub, &r, json!({ "items": [{ "text": "One" }] }))
        .await
        .unwrap();
    let Err(CallError::Tool(e)) = remove(&hub, &reader(), &r, json!([1])).await else {
        panic!("a read key removes an item");
    };
    assert_eq!(e.code, ErrorCode::Forbidden);
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..person()
    };
    let Err(CallError::Tool(e)) = remove(&hub, &agent, &r, json!([1])).await else {
        panic!("an agent key removes an item");
    };
    assert_eq!(e.code, ErrorCode::Forbidden);
    let Err(CallError::Tool(e)) = remove(&hub, &person(), &project("nope"), json!([1])).await
    else {
        panic!("an unknown project's item is removed");
    };
    assert_eq!(e.code, ErrorCode::NotFound);
    assert_eq!(
        get(&hub, &r).await.unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
