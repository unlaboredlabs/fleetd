//! Each Navi is its owner's (D215), over a real hub and the fake node of `tests`: a teammate and an admin neither see
//! another person's Navi in a list nor reach it through a tool, and an admin deletes it only once its owner was removed.
//! A hub without people reads as before; the migration gives each Navi its maker's person, else the hub's owner.
use std::sync::Arc;

use fleetd_contracts::auth::{Grant, KeyKind};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::node_link::{CAP_ASSISTANT, CAP_NAVI_ERASE, CAP_REPOS};
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
            assert!(
                e.message.contains("another person's Only me project"),
                "{tool}: {e:?}"
            );
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
    let _calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT, CAP_NAVI_ERASE]).await;
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

/// D310: Only me is one switch on any project, set from a person's own device. Only an admin turns it on for a project
/// nobody owns, which becomes theirs; on, every other person loses it from lists and tools, an admin too; its owner
/// turns it off, or an admin with that alone, and then everyone has it again.
#[tokio::test]
async fn only_me_is_one_switch_on_any_project_its_owner_or_an_admin_turns() {
    let (hub, _home) = hub();
    let _calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    let ann = people(&hub).ensure_owner().unwrap().person_id;
    let bob = people(&hub)
        .create(&PersonName::unchecked("Bob"), HubRole::Member)
        .unwrap()
        .person_id;
    let (ann_d, bob_d) = (
        device(&hub, Some(&ann), "admin"),
        device(&hub, Some(&bob), "operate"),
    );
    let r = fleetd_contracts::ids::ProjectRef {
        machine_id: fleetd_contracts::ids::MachineId::unchecked("devbox"),
        project_id: fleetd_contracts::ids::ProjectId::unchecked("p1"),
    };
    let p1 = json!({ "machineId": "devbox", "projectId": "p1" });
    let set = |extra: Value| {
        let mut v = p1.clone();
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        v
    };
    let summary = || hub.store.project_get(&r).unwrap().unwrap();
    assert!(!summary().only_me && summary().owner.is_none());

    // An agent's key never turns it.
    let agent = device(&hub, None, "admin");
    let Err(CallError::Tool(e)) = call(
        &hub,
        &agent,
        "project_settings_set",
        set(json!({ "onlyMe": true })),
    )
    .await
    else {
        panic!("an agent turned Only me on")
    };
    assert_eq!(e.code, ErrorCode::Forbidden);

    // Nobody owns it: Bob, a member, can't take it; Ann, an admin, turns it on, and it is hers alone.
    let Err(CallError::Tool(e)) = call(
        &hub,
        &bob_d,
        "project_settings_set",
        set(json!({ "onlyMe": true })),
    )
    .await
    else {
        panic!("a member took a project nobody owns")
    };
    assert_eq!(e.code, ErrorCode::Forbidden);
    ok(
        &hub,
        &ann_d,
        "project_settings_set",
        set(json!({ "onlyMe": true })),
    )
    .await;
    assert!(summary().only_me);
    assert_eq!(summary().owner, Some(ann.clone()));
    refused(&hub, &bob_d, "project_settings_get", p1.clone()).await;
    // Another admin reaches it only to turn it off, with that alone.
    let cy = people(&hub)
        .create(&PersonName::unchecked("Cy"), HubRole::Admin)
        .unwrap()
        .person_id;
    let cy_d = device(&hub, Some(&cy), "admin");
    refused(
        &hub,
        &cy_d,
        "project_settings_set",
        set(json!({ "onlyMe": false, "title": "Mine now" })),
    )
    .await;

    // Another admin turns it off with that alone: everyone has it again, and it stays Ann's for when she turns it on.
    ok(
        &hub,
        &cy_d,
        "project_settings_set",
        set(json!({ "onlyMe": false })),
    )
    .await;
    assert!(!summary().only_me);
    assert_eq!(summary().owner, Some(ann.clone()));
    ok(&hub, &bob_d, "project_settings_get", p1.clone()).await;

    // Off, only its owner or an admin turns it on again.
    let Err(CallError::Tool(e)) = call(
        &hub,
        &bob_d,
        "project_settings_set",
        set(json!({ "onlyMe": true })),
    )
    .await
    else {
        panic!("someone else took Ann's project")
    };
    assert_eq!(e.code, ErrorCode::Forbidden);
    ok(
        &hub,
        &ann_d,
        "project_settings_set",
        set(json!({ "onlyMe": true })),
    )
    .await;
    assert!(summary().only_me);
}

/// A hub from before owners: a Navi made by a person's device is theirs, one made by a key with no person (or one
/// since deleted) the hub's first owner's. With no people yet, none has an owner.
#[test]
fn the_migration_gives_each_navi_its_makers_person_else_the_hubs_owner() {
    use crate::hub::store::migrations::MIGRATIONS;
    let owners_at = MIGRATIONS
        .iter()
        .position(|m| m.sql.contains("ADD COLUMN owner_person"))
        .expect("the Navi owner migration");
    let before = || {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        for m in &MIGRATIONS[..owners_at] {
            conn.execute_batch(m.sql).unwrap();
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
        conn.execute_batch(MIGRATIONS[owners_at].sql).unwrap();
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

/// D310: each Navi becomes an Only me project, keeping its owner, maker, archive and card, and its other settings;
/// each owner's sidebar puts their own Navis first (the ones the order named in its order, then the rest oldest first),
/// and nothing keyed by the project moves.
#[test]
fn the_migration_makes_each_navi_an_only_me_project_first_in_its_owners_sidebar() {
    use crate::hub::store::migrations::MIGRATIONS;
    let at = MIGRATIONS
        .iter()
        .position(|m| m.name.ends_with("_navis_are_projects"))
        .expect("the Navis-are-projects migration");
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    for m in &MIGRATIONS[..at] {
        conn.execute_batch(m.sql).unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO assistants (machine_id, project_id, created_ms, created_by_key, created_by_name, archived_ms,
             owner_person, card_ref) VALUES
           ('devbox', 'home', 1, 'k_ann', 'desk', NULL, 'p_aaaaaaaa', 'op://Personal/Visa'),
           ('devbox', 'mail', 2, 'k_ann', 'desk', 7, 'p_aaaaaaaa', NULL),
           ('devbox', 'bobs', 3, 'k_bob', 'laptop', NULL, 'p_bbbbbbbb', NULL),
           ('devbox', 'cli', 4, 'k_cli', 'fleetd-cli', NULL, NULL, NULL);
         INSERT INTO project_settings (machine_id, project_id, memory_refresh) VALUES ('devbox', 'mail', 0),
           ('devbox', 'code', 1);
         INSERT INTO navi_sites (machine_id, project_id, site, allowed_ms, allowed_by) VALUES
           ('devbox', 'home', 'example.com', 1, 'Ann');
         INSERT INTO sidebar_orders (person_id, refs) VALUES
           ('p_aaaaaaaa', '[{"machineId":"devbox","projectId":"code"},{"machineId":"devbox","projectId":"mail"},
             {"machineId":"devbox","projectId":"bobs"}]'),
           ('p_cccccccc', '[{"machineId":"devbox","projectId":"code"}]');"#,
    )
    .unwrap();
    conn.execute_batch(MIGRATIONS[at].sql).unwrap();

    type Row = (
        String,
        bool,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        bool,
    );
    let rows: Vec<Row> = conn
        .prepare(
            "SELECT project_id, only_me, owner_person, archived_ms, card_ref, created_by_key, memory_refresh
             FROM project_settings ORDER BY project_id",
        )
        .unwrap()
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let some = |s: &str| Some(s.to_owned());
    assert_eq!(
        rows,
        [
            (
                "bobs".into(),
                true,
                some("p_bbbbbbbb"),
                None,
                None,
                some("k_bob"),
                true
            ),
            ("cli".into(), true, None, None, None, some("k_cli"), true),
            ("code".into(), false, None, None, None, None, true),
            (
                "home".into(),
                true,
                some("p_aaaaaaaa"),
                None,
                some("op://Personal/Visa"),
                some("k_ann"),
                true
            ),
            (
                "mail".into(),
                true,
                some("p_aaaaaaaa"),
                Some(7),
                None,
                some("k_ann"),
                false
            ),
        ]
    );
    let order = |person: &str| -> Vec<String> {
        let refs: String = conn
            .query_row(
                "SELECT refs FROM sidebar_orders WHERE person_id = ?",
                [person],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str::<Vec<fleetd_contracts::ids::ProjectRef>>(&refs)
            .unwrap()
            .into_iter()
            .map(|r| r.project_id.to_string())
            .collect()
    };
    assert_eq!(order("p_aaaaaaaa"), ["mail", "home", "code", "bobs"]);
    assert_eq!(order("p_bbbbbbbb"), ["bobs"]);
    assert_eq!(order("p_cccccccc"), ["code"]);
    let kept: i64 = conn
        .query_row(
            "SELECT count(*) FROM navi_sites WHERE project_id = 'home'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(kept, 1);
    let gone: bool = conn
        .query_row(
            "SELECT NOT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'assistants')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(gone);
}

#[tokio::test]
async fn only_its_owner_watches_takes_over_or_replays_a_navis_screen() {
    use fleetd_contracts::browser::{BrowserInput, BrowserSession, BrowserSessionId};
    let (hub, _home) = hub();
    let _calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    let ann = people(&hub).ensure_owner().unwrap().person_id;
    let bob = people(&hub)
        .create(&PersonName::unchecked("Bob"), HubRole::Admin)
        .unwrap()
        .person_id;
    let (ann_d, bob_d) = (
        device(&hub, Some(&ann), "admin"),
        device(&hub, Some(&bob), "admin"),
    );
    let ada = make(&hub, &ann_d, "Ada").await;
    let id = "B0123456789abcdef0123456789abcdef";
    let session: BrowserSession = serde_json::from_value(json!({
        "sessionId": id, "projectRef": at(&ada), "threadId": "th-1", "purpose": "Book the hotel",
        "state": "live", "control": "human", "startedAt": "2026-10-31T10:00:00.000Z",
    }))
    .unwrap();
    crate::hub::browser::save(&hub, &session).unwrap();
    // By its sessionId alone, the tools find it is Ada's.
    for (tool, input) in [
        (
            "browser_control",
            json!({ "sessionId": id, "control": "human" }),
        ),
        (
            "browser_recording_get",
            json!({ "sessionId": id, "file": "actions" }),
        ),
        ("screen_end", json!({ "sessionId": id })),
    ] {
        refused(&hub, &bob_d, tool, input).await;
    }
    // And the app socket's live view and input.
    let sid = BrowserSessionId::unchecked(id);
    let watch = crate::hub::browser::live::start_watch(&hub, &bob_d, &sid);
    assert!(
        watch.is_err_and(|e| e.message.contains("another person's Only me project")),
        "watch"
    );
    let click: BrowserInput =
        serde_json::from_value(json!({ "kind": "mouse", "action": "pressed", "x": 1, "y": 1 }))
            .unwrap();
    let input = crate::hub::browser::live::input(&hub, &bob_d, &sid, click.clone());
    assert!(
        input.is_err_and(|e| e.message.contains("another person's Only me project")),
        "input"
    );
    // Its owner gets past the owner check (here, to the node, which has no browser).
    let watch = crate::hub::browser::live::start_watch(&hub, &ann_d, &sid);
    assert!(
        watch.is_err_and(|e| !e.message.contains("another person's Only me project")),
        "owner's watch"
    );
}

/// What a call that names another person's Only me project by its order, task or steer reads as: refused by the
/// gate, or (a handler that checks first) not found. Either way it never runs.
async fn kept_out(hub: &Arc<Hub>, who: &Caller, tool: &str, input: Value) {
    match call(hub, who, tool, input).await {
        Err(CallError::Tool(e)) if matches!(e.code, ErrorCode::Forbidden | ErrorCode::NotFound) => {
        }
        other => panic!("{tool}: not refused: {other:?}"),
    }
}

/// An Only me project's orders, agents, steers, changes and decisions are its owner's too: another person reaches
/// them neither by their own ids (an order's W, a task's T, a steer's S, a decision's D) nor in any list.
#[tokio::test]
async fn an_only_me_projects_orders_agents_steers_changes_and_decisions_are_its_owners_alone() {
    let (hub, _home) = hub();
    let _calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    let ann = people(&hub).ensure_owner().unwrap().person_id;
    let bob = people(&hub)
        .create(&PersonName::unchecked("Bob"), HubRole::Member)
        .unwrap()
        .person_id;
    let (ann_d, bob_d) = (
        device(&hub, Some(&ann), "admin"),
        device(&hub, Some(&bob), "operate"),
    );
    let p1 = json!({ "machineId": "devbox", "projectId": "p1" });
    let at = "2026-11-08T10:00:00.000Z";
    hub.db
        .with(|c| {
            let order = json!({
                "workstreamId": "W1", "projectRef": p1, "title": "Ann's plans",
                "source": { "text": "Ann's plans", "channel": "app", "by": "human", "at": at },
                "state": "open", "createdAt": at, "updatedAt": at,
            });
            c.execute(
                "INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (1, 'devbox', 'p1', 'open', ?)",
                [order.to_string()],
            )?;
            let task = json!({
                "taskId": "T1", "projectRef": p1, "workstreamId": "W1", "title": "Ann's errand",
                "kind": "write", "prompt": "Book it.", "model": "claude-opus-5-5", "effort": "high",
                "state": "running", "attempt": 1, "createdAt": at, "startedAt": at,
            });
            c.execute(
                "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (1, 'devbox', 'p1', 'W1', 'running', ?)",
                [task.to_string()],
            )?;
            let change = json!({
                "changeId": "X1", "projectRef": p1, "repo": "acme/app", "prNumber": 7,
                "prUrl": "https://github.com/acme/app/pull/7", "branch": "fleetd/T1", "taskId": "T1",
                "workstreamId": "W1", "headSha": "b".repeat(40), "state": "queued", "reviews": [],
                "createdAt": at, "updatedAt": at,
            });
            c.execute(
                "INSERT INTO changes (n, repo, pr_number, state, machine_id, project_id, train_order, data)
                 VALUES (1, 'acme/app', 7, 'queued', 'devbox', 'p1', 1, ?)",
                [change.to_string()],
            )?;
            let steer = json!({
                "id": "S1", "target": { "workstreamId": "W1" }, "workstreamId": "W1",
                "thread": { "machineId": "devbox", "threadId": "th1" }, "runId": "r1",
                "by": { "kind": "human", "keyName": "desk" }, "mode": "queue", "text": "Window seat.",
                "stage": "queued", "queuedAt": at,
            });
            c.execute(
                "INSERT INTO steers (n, workstream_id, machine_id, thread_id, run_id, by, mode, stage, queued_ms, data)
                 VALUES (1, 'W1', 'devbox', 'th1', 'r1', ?, 'queue', 'queued', 0, ?)",
                [format!("key:{}", ann_d.key_id), steer.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    let decision = ok(
        &hub,
        &ann_d,
        "decisions_record",
        json!({ "key": "trip.seat", "value": "aisle", "scope": { "kind": "project", "projectRef": p1 } }),
    )
    .await["decision"]["decisionId"]
        .clone();

    // While p1 is everyone's, Bob sees all of it.
    let orders = |v: &Value| v["orders"].as_array().unwrap().len();
    let tasks = |v: &Value| v["tasks"].as_array().unwrap().len();
    let changes = |v: &Value| v["changes"].as_array().unwrap().len();
    let decisions = |v: &Value| v["decisions"].as_array().unwrap().len();
    assert_eq!(
        orders(&ok(&hub, &bob_d, "orders_board", json!({})).await),
        1
    );
    assert_eq!(tasks(&ok(&hub, &bob_d, "tasks_list", json!({})).await), 1);
    assert_eq!(
        changes(&ok(&hub, &bob_d, "changes_list", json!({})).await),
        1
    );
    let search = json!({ "query": "aisle" });
    assert_eq!(
        decisions(&ok(&hub, &bob_d, "decisions_search", search.clone()).await),
        1
    );
    ok(&hub, &bob_d, "order_get", json!({ "workstreamId": "W1" })).await;
    ok(&hub, &bob_d, "task_get", json!({ "taskId": "T1" })).await;
    let live = |who: &Caller| {
        let board = crate::hub::app_ws::live::board_lanes(&hub, who);
        let agent = crate::hub::app_ws::live::agent_lanes(&hub, who, "T1");
        (board.len(), agent.len())
    };
    assert_eq!(live(&bob_d), (1, 1));

    // Ann turns Only me on: none of it is Bob's to see or steer any more, by any id or in any list.
    ok(
        &hub,
        &ann_d,
        "project_settings_set",
        json!({ "machineId": "devbox", "projectId": "p1", "onlyMe": true }),
    )
    .await;
    assert_eq!(
        orders(&ok(&hub, &bob_d, "orders_board", json!({})).await),
        0
    );
    assert_eq!(tasks(&ok(&hub, &bob_d, "tasks_list", json!({})).await), 0);
    assert_eq!(
        changes(&ok(&hub, &bob_d, "changes_list", json!({})).await),
        0
    );
    assert_eq!(
        decisions(&ok(&hub, &bob_d, "decisions_search", search.clone()).await),
        0
    );
    assert_eq!(live(&bob_d), (0, 0));
    for (tool, input) in [
        ("order_get", json!({ "workstreamId": "W1" })),
        ("task_get", json!({ "taskId": "T1" })),
        (
            "steer_send",
            json!({ "target": { "workstreamId": "W1" }, "text": "Cancel the trip.", "clientRequestId": "s1" }),
        ),
        (
            "steer_send",
            json!({ "target": { "taskId": "T1" }, "text": "Cancel the trip.", "clientRequestId": "s2" }),
        ),
        ("steer_withdraw", json!({ "steerId": "S1" })),
        (
            "decisions_record",
            json!({ "key": "trip.seat", "value": "middle", "scope": { "kind": "workstream", "workstreamId": "W1" } }),
        ),
        (
            "decisions_overturn",
            json!({ "decisionId": decision, "value": "middle", "why": "I like it." }),
        ),
    ] {
        kept_out(&hub, &bob_d, tool, input).await;
    }

    // Ann still has all of it.
    assert_eq!(
        orders(&ok(&hub, &ann_d, "orders_board", json!({})).await),
        1
    );
    assert_eq!(tasks(&ok(&hub, &ann_d, "tasks_list", json!({})).await), 1);
    assert_eq!(
        changes(&ok(&hub, &ann_d, "changes_list", json!({})).await),
        1
    );
    assert_eq!(
        decisions(&ok(&hub, &ann_d, "decisions_search", search).await),
        1
    );
    ok(&hub, &ann_d, "order_get", json!({ "workstreamId": "W1" })).await;
    ok(&hub, &ann_d, "task_get", json!({ "taskId": "T1" })).await;
    assert_eq!(live(&ann_d), (1, 1));
}

/// What round 2 found past the ids the gate reads: an Only me project's PRs (by repo and number), its orders in
/// workstream_list, its wakes (by wake id), and the events that name its thread but no project (a steer's, a wake's)
/// are its owner's alone too. While the project is shared, Bob sees them.
#[tokio::test]
async fn an_only_me_projects_prs_order_list_wakes_and_thread_events_are_its_owners_alone() {
    let (hub, _home) = hub();
    let _calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT]).await;
    let ann = people(&hub).ensure_owner().unwrap().person_id;
    let bob = people(&hub)
        .create(&PersonName::unchecked("Bob"), HubRole::Member)
        .unwrap()
        .person_id;
    let (ann_d, bob_d) = (
        device(&hub, Some(&ann), "admin"),
        device(&hub, Some(&bob), "operate"),
    );
    let p1 = json!({ "machineId": "devbox", "projectId": "p1" });
    let at = "2026-11-08T10:00:00.000Z";
    hub.db
        .with(|c| {
            let order = json!({
                "workstreamId": "W1", "projectRef": p1, "title": "Ann's plans",
                "source": { "text": "Ann's plans", "channel": "app", "by": "human", "at": at },
                "state": "open", "createdAt": at, "updatedAt": at,
            });
            c.execute(
                "INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (1, 'devbox', 'p1', 'open', ?)",
                [order.to_string()],
            )?;
            let change = json!({
                "changeId": "X1", "projectRef": p1, "repo": "acme/app", "prNumber": 7,
                "prUrl": "https://github.com/acme/app/pull/7", "branch": "fleetd/T1", "taskId": "T1",
                "workstreamId": "W1", "headSha": "b".repeat(40), "state": "queued", "reviews": [],
                "createdAt": at, "updatedAt": at,
            });
            c.execute(
                "INSERT INTO changes (n, repo, pr_number, state, machine_id, project_id, train_order, data)
                 VALUES (1, 'acme/app', 7, 'queued', 'devbox', 'p1', 1, ?)",
                [change.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    hub.store
        .thread_upsert(&crate::hub::store::StoredThread {
            thread: serde_json::from_value(json!({
                "machineId": "devbox", "threadId": "th1", "projectId": "p1", "title": "lead", "status": "idle",
                "headline": "", "latestMessageTail": "", "lastProgressAt": at, "stale": false, "asOf": at,
            }))
            .unwrap(),
            last_sequence: None,
            last_run_id: None,
            last_run_status: None,
        })
        .unwrap();
    let wake = ok(
        &hub,
        &ann_d,
        "wake_set",
        json!({
            "target": { "machineId": "devbox", "threadId": "th1" },
            "schedule": { "kind": "at", "at": "2026-12-01T10:00:00.000Z", "tz": "UTC" },
            "message": "Check in for the flight.", "clientRequestId": "w1",
        }),
    )
    .await["wakeId"]
        .clone();
    // A steer's event names the thread it went to, not its project.
    hub.events
        .append(crate::hub::store::NewEvent {
            at: fleetd_contracts::ids::Timestamp(at.into()),
            r#type: fleetd_contracts::events::HubEventType::SteerQueued,
            machine_id: Some(fleetd_contracts::ids::MachineId::unchecked("devbox")),
            project_id: None,
            thread_id: Some(fleetd_contracts::ids::ThreadId::unchecked("th1")),
            summary: "Cancel the trip.".into(),
            data: None,
            attention: None,
        })
        .unwrap();

    let orders = |v: &Value| v["workstreams"].as_array().unwrap().len();
    let wakes = |v: &Value| v["wakes"].as_array().unwrap().len();
    let steers = |v: &Value| {
        v["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "steer.queued")
            .count()
    };
    let events = json!({ "cursor": 0, "timeoutSec": 0, "types": ["steer.queued"] });
    assert_eq!(
        orders(&ok(&hub, &bob_d, "workstream_list", json!({})).await),
        1
    );
    assert_eq!(wakes(&ok(&hub, &bob_d, "wake_list", json!({})).await), 1);
    assert_eq!(
        steers(&ok(&hub, &bob_d, "events_wait", events.clone()).await),
        1
    );

    ok(
        &hub,
        &ann_d,
        "project_settings_set",
        json!({ "machineId": "devbox", "projectId": "p1", "onlyMe": true }),
    )
    .await;
    assert_eq!(
        orders(&ok(&hub, &bob_d, "workstream_list", json!({})).await),
        0
    );
    assert_eq!(wakes(&ok(&hub, &bob_d, "wake_list", json!({})).await), 0);
    assert_eq!(
        steers(&ok(&hub, &bob_d, "events_wait", events.clone()).await),
        0
    );
    // The PR tools refuse before they read GitHub.
    for (tool, input) in [
        ("pr_get", json!({ "repo": "acme/app", "number": 7 })),
        ("pr_files", json!({ "repo": "acme/app", "number": 7 })),
        (
            "pr_diff",
            json!({ "repo": "acme/app", "number": 7, "path": "src/main.rs" }),
        ),
    ] {
        refused(&hub, &bob_d, tool, input).await;
    }
    kept_out(&hub, &bob_d, "wake_cancel", json!({ "wakeId": wake })).await;

    assert_eq!(
        orders(&ok(&hub, &ann_d, "workstream_list", json!({})).await),
        1
    );
    assert_eq!(wakes(&ok(&hub, &ann_d, "wake_list", json!({})).await), 1);
    assert_eq!(steers(&ok(&hub, &ann_d, "events_wait", events).await), 1);
    ok(&hub, &ann_d, "wake_cancel", json!({ "wakeId": wake })).await;
}
