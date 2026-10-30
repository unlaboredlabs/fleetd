//! Each Navi is its owner's (D215), over a real hub and the fake node of `tests`: a teammate and an admin neither see
//! another person's Navi in a list nor reach it through a tool, and an admin deletes it only once its owner was removed.
//! A hub without people reads as before; the migration gives each Navi its maker's person, else the hub's owner.
use std::sync::Arc;

use fleetd_contracts::auth::{Grant, KeyKind};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::node_link::{CAP_ASSISTANT, CAP_REPOS};
use fleetd_contracts::people::{HubRole, PersonId, PersonName};
use serde_json::{Value, json};

use super::tests::{hub, node};
use crate::hub::api::{CallError, Caller, Hub, registry};
use crate::hub::people::People;

fn people(hub: &Hub) -> People {
    People::new(hub.db.clone(), hub.clock.clone())
}

fn device(hub: &Hub, person: Option<&PersonId>, role: &str) -> Caller {
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": role, "machines": "*" }])).unwrap();
    let kind = match person {
        Some(_) => KeyKind::Human,
        None => KeyKind::Agent,
    };
    hub.auth
        .create_key_for("desk", &grants, kind, person)
        .unwrap()
        .info
}

async fn call(hub: &Arc<Hub>, who: &Caller, tool: &str, input: Value) -> Result<Value, CallError> {
    registry().call(hub, who, tool, input).await
}

async fn ok(hub: &Arc<Hub>, who: &Caller, tool: &str, input: Value) -> Value {
    match call(hub, who, tool, input).await {
        Ok(v) => v,
        Err(e) => panic!("{tool}: {e:?}"),
    }
}

/// The call is refused as another person's Navi.
async fn refused(hub: &Arc<Hub>, who: &Caller, tool: &str, input: Value) {
    match call(hub, who, tool, input).await {
        Err(CallError::Tool(e)) if e.code == ErrorCode::Forbidden => {
            assert!(e.message.contains("another person's Navi"), "{tool}: {e:?}");
        }
        other => panic!("{tool}: not refused: {other:?}"),
    }
}

async fn make(hub: &Arc<Hub>, who: &Caller, name: &str) -> Value {
    ok(hub, who, "navi_create", json!({ "name": name })).await["navi"].clone()
}

fn titles(listed: &Value, key: &str) -> Vec<String> {
    let mut out: Vec<String> = listed[key]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["kind"] == "assistant")
        .map(|p| p["title"].as_str().unwrap().to_owned())
        .collect();
    out.sort();
    out
}

fn at(navi: &Value) -> Value {
    json!({ "machineId": navi["machineId"], "projectId": navi["projectId"] })
}

/// Every Navi tool's call on `navi`, by its project, as the app makes them.
fn tool_calls(navi: &Value) -> Vec<(&'static str, Value)> {
    let r = at(navi);
    let flat = |extra: Value| {
        let mut v = r.clone();
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        v
    };
    vec![
        ("navi_rename", flat(json!({ "name": "Mine now" }))),
        ("navi_archive", r.clone()),
        ("navi_sites", r.clone()),
        ("navi_site_revoke", flat(json!({ "site": "example.com" }))),
        ("navi_signins_forget", r.clone()),
        ("project_avatar_set", r.clone()),
        ("project_avatar_get", r.clone()),
        (
            "project_icon_set",
            flat(json!({ "icon": { "face": "wink", "color": "sun" } })),
        ),
        ("navi_asks", json!({ "navi": r })),
        ("mcp_servers_get", json!({ "project": r })),
        ("hub_links_get", json!({ "navi": r })),
        ("events_list", json!({ "projectRef": r })),
        (
            "chat_send",
            json!({ "projectRef": r, "text": "hi", "clientRequestId": "c1" }),
        ),
        ("chat_history", json!({ "projectRef": r })),
        ("project_get", r.clone()),
        ("project_remove", r.clone()),
    ]
}

#[tokio::test]
async fn only_its_owner_sees_and_uses_a_navi_and_an_admin_deletes_a_removed_persons() {
    let (hub, _home) = hub();
    let _calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    let ann = people(&hub).ensure_owner().unwrap().person_id;
    let bob = people(&hub)
        .create(&PersonName::unchecked("Bob"), HubRole::Member)
        .unwrap()
        .person_id;
    let cy = people(&hub)
        .create(&PersonName::unchecked("Cy"), HubRole::Admin)
        .unwrap()
        .person_id;
    let (ann_d, bob_d, cy_d) = (
        device(&hub, Some(&ann), "admin"),
        device(&hub, Some(&bob), "operate"),
        device(&hub, Some(&cy), "admin"),
    );
    let ada = make(&hub, &ann_d, "Ada").await;
    let bee = make(&hub, &bob_d, "Bee").await;
    let owner = |navi: &Value| {
        super::of(&hub.db, &serde_json::from_value(at(navi)).unwrap())
            .unwrap()
            .unwrap()
            .owner
    };
    assert_eq!(owner(&ada), Some(ann.clone()));
    assert_eq!(owner(&bee), Some(bob.clone()));
    // The app reads it on the Navi's summary.
    assert_eq!(ada["owner"], ann.as_str());

    // Each lists only their own: navi_list, the projects of fleetd_status and project_get.
    for (who, mine) in [
        (&ann_d, vec!["Ada"]),
        (&bob_d, vec!["Bee"]),
        (&cy_d, vec![]),
    ] {
        assert_eq!(
            titles(&ok(&hub, who, "navi_list", json!({})).await, "navis"),
            mine
        );
        assert_eq!(
            titles(&ok(&hub, who, "fleetd_status", json!({})).await, "projects"),
            mine
        );
        assert_eq!(
            titles(&ok(&hub, who, "project_get", json!({})).await, "projects"),
            mine
        );
    }
    // A key with no person, minted on the hub's machine, is the hub's owner's.
    let cli = device(&hub, None, "admin");
    assert_eq!(
        titles(&ok(&hub, &cli, "navi_list", json!({})).await, "navis"),
        ["Ada"]
    );

    // Another's Navi's events, approvals and chat don't reach them.
    let events = ok(
        &hub,
        &bob_d,
        "events_wait",
        json!({ "cursor": 0, "timeoutSec": 1 }),
    )
    .await;
    let ada_id = ada["projectId"].as_str().unwrap();
    let bee_id = bee["projectId"].as_str().unwrap();
    let about = |id: &str| {
        events["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["projectId"] == id)
    };
    assert!(about(bee_id) && !about(ada_id));
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO requests (n, project_key, kind, state, created_ms, data) VALUES (7, ?1, 'approval', 'open', 0, ?2)",
                rusqlite::params![
                    format!("devbox/{ada_id}"),
                    json!({ "requestId": "Q7", "projectRef": at(&ada) }).to_string()
                ],
            )?;
            Ok(())
        })
        .unwrap();
    refused(
        &hub,
        &bob_d,
        "approval_answer",
        json!({ "requestId": "Q7", "decision": "approve" }),
    )
    .await;
    refused(
        &hub,
        &cy_d,
        "approval_answer",
        json!({ "requestId": "Q7", "decision": "deny" }),
    )
    .await;

    // A link names no Navi, but removing one of Ada's is Ann's alone.
    let link = crate::hub::hub_links::keep(
        &hub,
        &serde_json::from_value(at(&ada)).unwrap(),
        &serde_json::from_value(json!("work")).unwrap(),
        "http://127.0.0.1:9",
        b"sealed",
        0,
    )
    .unwrap()
    .unwrap();
    refused(&hub, &bob_d, "hub_link_remove", json!({ "linkId": link })).await;
    refused(&hub, &cy_d, "hub_link_remove", json!({ "linkId": link })).await;

    // An automation names no Navi either, but Ada's are Ann's alone: run, edit, pause, rotate, read or delete.
    let made = ok(
        &hub,
        &ann_d,
        "automation_create",
        json!({ "projectRef": at(&ada), "name": "Morning mail", "prompt": "Sum up my new mail.",
                "schedule": { "cron": "0 8 * * *", "tz": "UTC" }, "clientRequestId": "a1" }),
    )
    .await;
    let auto = made["automation"]["automationId"].clone();
    let by_id = [
        (
            "automation_update",
            json!({ "automationId": auto, "name": "Mine now" }),
        ),
        (
            "automation_pause",
            json!({ "automationId": auto, "paused": true }),
        ),
        ("automation_rotate", json!({ "automationId": auto })),
        ("automation_run", json!({ "automationId": auto })),
        (
            "automation_runs",
            json!({ "automationId": auto, "limit": 10 }),
        ),
        ("automation_delete", json!({ "automationId": auto })),
    ];
    for (tool, input) in &by_id {
        refused(&hub, &bob_d, tool, input.clone()).await;
        refused(&hub, &cy_d, tool, input.clone()).await;
    }
    ok(
        &hub,
        &ann_d,
        "automation_pause",
        json!({ "automationId": auto, "paused": true }),
    )
    .await;

    // Every Navi tool refuses a teammate and an admin alike.
    for (tool, input) in tool_calls(&ada) {
        refused(&hub, &bob_d, tool, input.clone()).await;
        refused(&hub, &cy_d, tool, input).await;
    }
    // Its owner goes on as before.
    let renamed = ok(
        &hub,
        &ann_d,
        "navi_rename",
        json!({ "machineId": "devbox", "projectId": ada_id, "name": "Ada 2" }),
    )
    .await;
    assert_eq!(renamed["navi"]["title"], "Ada 2");
    ok(&hub, &ann_d, "navi_sites", at(&ada)).await;
    ok(&hub, &ann_d, "hub_link_remove", json!({ "linkId": link })).await;

    // Once Bob is removed, an admin deletes his Navi, and does nothing else with it.
    people(&hub).remove(&bob).unwrap();
    for (tool, input) in tool_calls(&bee)
        .into_iter()
        .filter(|(tool, _)| *tool != "project_remove")
    {
        refused(&hub, &cy_d, tool, input).await;
    }
    // A member is no admin: still refused.
    let dee = people(&hub)
        .create(&PersonName::unchecked("Dee"), HubRole::Member)
        .unwrap()
        .person_id;
    refused(
        &hub,
        &device(&hub, Some(&dee), "operate"),
        "project_remove",
        at(&bee),
    )
    .await;
    ok(&hub, &cy_d, "project_remove", at(&bee)).await;
    // While its owner is on the hub, an admin can't delete theirs.
    refused(&hub, &cy_d, "project_remove", at(&ada)).await;
}

#[tokio::test]
async fn on_a_hub_without_people_every_key_shares_the_navis_until_the_owner_takes_them() {
    let (hub, _home) = hub();
    let _calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    let (one, two) = (device(&hub, None, "operate"), device(&hub, None, "operate"));
    let ada = make(&hub, &one, "Ada").await;
    let r = serde_json::from_value(at(&ada)).unwrap();
    assert_eq!(super::of(&hub.db, &r).unwrap().unwrap().owner, None);
    assert_eq!(
        titles(&ok(&hub, &two, "navi_list", json!({})).await, "navis"),
        ["Ada"]
    );
    ok(
        &hub,
        &two,
        "navi_rename",
        json!({ "machineId": "devbox", "projectId": ada["projectId"], "name": "Ada 2" }),
    )
    .await;

    // The hub's next start makes its owner, who takes the Navis from before people.
    let ann = people(&hub).ensure_owner().unwrap().person_id;
    assert_eq!(
        super::of(&hub.db, &r).unwrap().unwrap().owner,
        Some(ann.clone())
    );
    let bob = people(&hub)
        .create(&PersonName::unchecked("Bob"), HubRole::Admin)
        .unwrap()
        .person_id;
    assert!(
        titles(
            &ok(
                &hub,
                &device(&hub, Some(&bob), "admin"),
                "navi_list",
                json!({})
            )
            .await,
            "navis"
        )
        .is_empty()
    );
    let mine = ok(
        &hub,
        &device(&hub, Some(&ann), "operate"),
        "navi_list",
        json!({}),
    )
    .await;
    assert_eq!(titles(&mine, "navis"), ["Ada 2"]);
}

/// A hub from before owners: a Navi made by a person's device is theirs, one made by a key with no person (or one
/// since deleted) the hub's first owner's. With no people yet, none has an owner.
#[test]
fn the_migration_gives_each_navi_its_makers_person_else_the_hubs_owner() {
    use crate::hub::store::migrations::MIGRATIONS;
    let owners_at = MIGRATIONS
        .iter()
        .position(|m| m.contains("ADD COLUMN owner_person"))
        .expect("the Navi owner migration");
    let before = || {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for m in &MIGRATIONS[..owners_at] {
            conn.execute_batch(m).unwrap();
        }
        conn.execute_batch(
            "INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind, person_id) VALUES
               ('k_bob', 'h1', 'fld_a', 'desk', '[]', 0, 'human', 'p_bbbbbbbb'),
               ('k_cli', 'h2', 'fld_b', 'fleetd-cli', '[]', 0, 'agent', NULL);
             INSERT INTO assistants (machine_id, project_id, created_ms, created_by_key, created_by_name) VALUES
               ('devbox', 'bobs', 1, 'k_bob', 'desk'), ('devbox', 'clis', 2, 'k_cli', 'fleetd-cli'),
               ('devbox', 'gone', 3, 'k_gone', 'old');",
        )
        .unwrap();
        conn
    };
    let owners = |conn: &rusqlite::Connection| -> Vec<(String, Option<String>)> {
        conn.execute_batch(MIGRATIONS[owners_at]).unwrap();
        conn.prepare("SELECT project_id, owner_person FROM assistants ORDER BY created_ms")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let some = |p: &str| Some(p.to_owned());

    let conn = before();
    conn.execute_batch(
        "INSERT INTO people (person_id, name, role, created_ms, removed_ms) VALUES
           ('p_xxxxxxxx', 'Gone', 'owner', 0, 5), ('p_aaaaaaaa', 'Ann', 'owner', 1, NULL),
           ('p_bbbbbbbb', 'Bob', 'member', 2, NULL);",
    )
    .unwrap();
    assert_eq!(
        owners(&conn),
        [
            ("bobs".to_owned(), some("p_bbbbbbbb")),
            ("clis".to_owned(), some("p_aaaaaaaa")),
            ("gone".to_owned(), some("p_aaaaaaaa")),
        ]
    );

    let conn = before();
    conn.execute("DELETE FROM agent_keys WHERE key_id = 'k_bob'", [])
        .unwrap();
    assert!(owners(&conn).iter().all(|(_, owner)| owner.is_none()));
}
