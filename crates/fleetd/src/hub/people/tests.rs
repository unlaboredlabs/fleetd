//! People over a real in-memory hub: an invite redeemed binds the device to its person, members can't administer,
//! an older hub migrates to one owner, the hub keeps its owners, what a person does names them, and the lead reads
//! who wrote only once there is more than one person.
use std::sync::Arc;

use axum::http::StatusCode;
use fleetd_contracts::auth::{KeyKind, Role};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::people::HubRole;
use serde_json::{Value, json};

use super::*;
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::pair::{Limiter, PairCodes, handle};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-19T10:00:00.000Z";

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: Some("http://devbox.example.ts.net:4790".into()),
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    hub.store
        .projects_upsert_many(
            &fleetd_contracts::ids::MachineId::unchecked("devbox"),
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "app", "title": "app", "workspaceRoot": "/work/app",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    (hub, home)
}

/// Trades a code at `POST /pair` as the app does, and returns the key it was given.
fn redeem_key(hub: &Hub, code: &str, device: &str) -> String {
    let body = json!({ "code": code, "deviceName": device }).to_string();
    let (status, out) = handle(hub, &Limiter::default(), None, None, body.as_bytes());
    assert_eq!(status, StatusCode::OK, "{out}");
    out["key"].as_str().unwrap().to_owned()
}

/// [`redeem_key`], verified as the hub sees it on the device's next call.
fn redeem(hub: &Hub, code: &str, device: &str) -> Caller {
    hub.auth.verify(&redeem_key(hub, code, device)).unwrap()
}

/// The owner's app, paired with a plain `fleetd pair` code.
fn owner_device(hub: &Hub) -> Caller {
    let minted = PairCodes::new(hub.db.clone(), hub.clock.clone())
        .create(None, crate::hub::pair::DEFAULT_ROLE)
        .unwrap();
    redeem(hub, &minted.code, "desk")
}

async fn call(
    hub: &Arc<Hub>,
    caller: &Caller,
    tool: &str,
    input: Value,
) -> Result<Value, CallError> {
    registry().call(hub, caller, tool, input).await
}

async fn ok(hub: &Arc<Hub>, caller: &Caller, tool: &str, input: Value) -> Value {
    call(hub, caller, tool, input)
        .await
        .unwrap_or_else(|e| panic!("{tool}: {e:?}"))
}

async fn refused(hub: &Arc<Hub>, caller: &Caller, tool: &str, input: Value) -> ErrorCode {
    match call(hub, caller, tool, input).await {
        Err(CallError::Tool(error)) => error.code,
        other => panic!("{tool}: expected a refusal, got {other:?}"),
    }
}

fn revoked(hub: &Hub, key_id: &str) -> bool {
    hub.auth
        .list()
        .unwrap()
        .iter()
        .any(|k| k.key_id.as_str() == key_id && k.revoked_at.is_some())
}

fn events(
    hub: &Hub,
    of: fleetd_contracts::events::HubEventType,
) -> Vec<fleetd_contracts::events::HubEvent> {
    hub.events.page(0, Some(&[of]), None).unwrap().events
}

/// `who` invites `name` as `role` and that person's app redeems it on `device`: the device's key.
async fn join_key(hub: &Arc<Hub>, who: &Caller, name: &str, role: &str, device: &str) -> String {
    let invite = ok(
        hub,
        who,
        "invite_create",
        json!({ "name": name, "role": role }),
    )
    .await;
    redeem_key(hub, invite["code"].as_str().unwrap(), device)
}

/// [`join_key`], verified.
async fn join(hub: &Arc<Hub>, who: &Caller, name: &str, role: &str, device: &str) -> Caller {
    hub.auth
        .verify(&join_key(hub, who, name, role, device).await)
        .unwrap()
}

#[tokio::test]
async fn an_invite_redeemed_binds_the_device_to_its_person_and_the_people_list_shows_both() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    let owner_person = owner
        .person
        .clone()
        .expect("a paired device belongs to the owner");

    let invite = ok(&hub, &owner, "invite_create", json!({ "name": "Alice" })).await;
    assert_eq!(invite["invite"]["state"], "open");
    assert_eq!(invite["invite"]["person"]["name"], "Alice");
    assert_eq!(
        invite["invite"]["createdBy"]["personId"],
        json!(owner_person.person_id)
    );
    let code = invite["code"].as_str().unwrap();
    assert_eq!(
        invite["link"].as_str().unwrap(),
        format!("fleetd://pair?hub=http%3A%2F%2Fdevbox.example.ts.net%3A4790&code={code}")
    );
    // Valid for 7 days, not pairing's 15 minutes.
    let created =
        crate::hub::store::parse_ms(invite["invite"]["createdAt"].as_str().unwrap()).unwrap();
    let expires =
        crate::hub::store::parse_ms(invite["invite"]["expiresAt"].as_str().unwrap()).unwrap();
    assert_eq!(expires - created, 7 * 24 * 60 * 60_000);

    let laptop = redeem(&hub, code, "Alice's laptop");
    let alice = laptop.person.clone().expect("the device is Alice's");
    assert_eq!(alice.name.as_str(), "Alice");
    assert_eq!(
        alice.person_id.as_str(),
        invite["invite"]["person"]["personId"]
    );
    assert_eq!(laptop.kind, Some(KeyKind::Human));
    // A member operates on every machine, and administers nothing.
    assert!(crate::hub::api::allows_everywhere(&laptop, Role::Operate));
    assert!(!crate::hub::api::allows_everywhere(&laptop, Role::Admin));

    // Single use.
    let body = json!({ "code": code, "deviceName": "again" }).to_string();
    let (status, _) = handle(&hub, &Limiter::default(), None, None, body.as_bytes());
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // A second device of Alice's, from an invite for her.
    let more = ok(
        &hub,
        &owner,
        "invite_create",
        json!({ "personId": alice.person_id }),
    )
    .await;
    let phone = redeem(&hub, more["code"].as_str().unwrap(), "Alice's phone");
    assert_eq!(phone.person.as_ref(), Some(&alice));

    let listed = ok(&hub, &owner, "people_list", json!({})).await;
    let people: Vec<(&str, &str)> = listed["people"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["name"].as_str().unwrap(), p["role"].as_str().unwrap()))
        .collect();
    assert_eq!(
        people,
        [(owner_person.name.as_str(), "owner"), ("Alice", "member")]
    );
    // The test clock pairs all three in the same millisecond, so they are compared in name order.
    let mut devices: Vec<(&str, &str)> = listed["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| {
            (
                d["name"].as_str().unwrap(),
                d["person"]["name"].as_str().unwrap(),
            )
        })
        .collect();
    devices.sort();
    assert_eq!(
        devices,
        [
            ("Alice's laptop", "Alice"),
            ("Alice's phone", "Alice"),
            ("desk", owner_person.name.as_str()),
        ]
    );
    assert_eq!(listed["invites"], json!([]), "both invites were used");
    assert_eq!(listed["me"], json!(owner_person.person_id));

    // Each device lists what it may do: Alice's operate, though their invite let them hold admin.
    let grants = |name: &str| {
        listed["devices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["name"] == name)
            .map(|d| d["grants"].clone())
            .unwrap()
    };
    assert_eq!(
        grants("Alice's laptop"),
        json!([{ "role": "operate", "machines": "*" }])
    );
    assert_eq!(
        grants("desk"),
        json!([{ "role": "admin", "machines": "*" }])
    );

    // Alice sees everyone, but only her own devices and no invites.
    let hers = ok(&hub, &laptop, "people_list", json!({})).await;
    assert_eq!(hers["people"].as_array().unwrap().len(), 2);
    assert_eq!(hers["devices"].as_array().unwrap().len(), 2);
    assert_eq!(hers["invites"], json!([]));

    // She signs out her phone; she can't sign out the owner's desk.
    ok(
        &hub,
        &laptop,
        "device_revoke",
        json!({ "keyId": phone.key_id }),
    )
    .await;
    assert!(revoked(&hub, phone.key_id.as_str()));
    assert_eq!(
        refused(
            &hub,
            &laptop,
            "device_revoke",
            json!({ "keyId": owner.key_id })
        )
        .await,
        ErrorCode::NotFound
    );

    let info = ok(&hub, &laptop, "hub_info", json!({})).await;
    assert_eq!(info["me"]["name"], "Alice");
    assert_eq!(info["me"]["role"], "member");
    assert_eq!(info["people"], 2);
    let joined = events(&hub, fleetd_contracts::events::HubEventType::PeopleChanged)
        .into_iter()
        .filter(|e| e.data.as_ref().is_some_and(|d| d["change"] == "joined"))
        .count();
    assert_eq!(joined, 2, "each redeemed invite says who joined");
}

#[tokio::test]
async fn members_cant_administer_and_a_promotion_reaches_the_device_their_invite_paired() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    let key = join_key(&hub, &owner, "Bob", "member", "bob-mac").await;
    let bob = hub.auth.verify(&key).unwrap();
    for (tool, input) in [
        ("invite_create", json!({ "name": "Eve" })),
        (
            "person_set",
            json!({ "personId": owner.person.as_ref().unwrap().person_id, "role": "member" }),
        ),
        (
            "person_remove",
            json!({ "personId": owner.person.as_ref().unwrap().person_id }),
        ),
    ] {
        assert_eq!(
            refused(&hub, &bob, tool, input).await,
            ErrorCode::Forbidden,
            "{tool}"
        );
    }
    assert_eq!(
        People::new(hub.db.clone(), hub.clock.clone())
            .count()
            .unwrap(),
        2
    );

    // The device Bob's invite paired operates only, as a member's does.
    let bobs_id = bob.person.as_ref().unwrap().person_id.clone();
    assert!(crate::hub::api::allows_everywhere(&bob, Role::Operate));
    assert!(!crate::hub::api::allows_everywhere(&bob, Role::Admin));

    // Made an admin, Bob invites from that same device, with no new pairing; demoted, he can't again.
    ok(
        &hub,
        &owner,
        "person_set",
        json!({ "personId": bobs_id, "role": "admin" }),
    )
    .await;
    let promoted = hub.auth.verify(&key).unwrap();
    assert!(crate::hub::api::allows_everywhere(&promoted, Role::Admin));
    ok(&hub, &promoted, "invite_create", json!({ "name": "Eve" })).await;
    assert_eq!(
        ok(&hub, &promoted, "hub_info", json!({})).await["admin"],
        true,
        "the app shows the Hub pages of the app's Settings"
    );
    ok(
        &hub,
        &owner,
        "person_set",
        json!({ "personId": bobs_id, "role": "member" }),
    )
    .await;
    let demoted = hub.auth.verify(&key).unwrap();
    assert_eq!(
        refused(
            &hub,
            &demoted,
            "invite_create",
            json!({ "name": "Mallory" })
        )
        .await,
        ErrorCode::Forbidden
    );

    // A device paired with less keeps its own cap, whatever its person's role.
    let wall = PairCodes::new(hub.db.clone(), hub.clock.clone())
        .create(None, Role::Read)
        .unwrap();
    let wall = redeem(&hub, &wall.code, "wall");
    assert!(!crate::hub::api::allows_everywhere(&wall, Role::Operate));
}

#[tokio::test]
async fn the_hub_keeps_its_owners_and_a_new_person_needs_a_name() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    let owner_id = owner.person.as_ref().unwrap().person_id.clone();
    let carol = join(&hub, &owner, "Carol", "admin", "carol-mac").await;

    // An admin can't make, unmake or remove an owner.
    assert_eq!(
        refused(
            &hub,
            &carol,
            "invite_create",
            json!({ "name": "Dan", "role": "owner" })
        )
        .await,
        ErrorCode::Forbidden
    );
    for (tool, input) in [
        (
            "person_set",
            json!({ "personId": owner_id, "role": "admin" }),
        ),
        ("person_remove", json!({ "personId": owner_id })),
    ] {
        assert_eq!(
            refused(&hub, &carol, tool, input).await,
            ErrorCode::Forbidden,
            "{tool}"
        );
    }
    // Nor sign out an owner's device; an owner signs out an admin's.
    assert_eq!(
        refused(
            &hub,
            &carol,
            "device_revoke",
            json!({ "keyId": owner.key_id })
        )
        .await,
        ErrorCode::Forbidden
    );
    assert!(!revoked(&hub, owner.key_id.as_str()));
    // Nobody removes or demotes the last owner, the owner included.
    for (tool, input) in [
        (
            "person_set",
            json!({ "personId": owner_id, "role": "member" }),
        ),
        ("person_remove", json!({ "personId": owner_id })),
    ] {
        assert_eq!(
            refused(&hub, &owner, tool, input).await,
            ErrorCode::Invalid,
            "{tool}"
        );
    }
    // A new person needs a name; another device of someone takes none.
    for input in [
        json!({}),
        json!({ "role": "member" }),
        json!({ "personId": owner_id, "name": "x" }),
    ] {
        assert!(
            matches!(
                call(&hub, &owner, "invite_create", input.clone()).await,
                Err(CallError::Invalid(_))
            ),
            "{input}"
        );
    }

    // Removing a person signs out every device of theirs.
    let carols_id = carol.person.as_ref().unwrap().person_id.clone();
    let removed = ok(
        &hub,
        &owner,
        "person_remove",
        json!({ "personId": carols_id }),
    )
    .await;
    assert_eq!(removed["revoked"], 1);
    assert!(revoked(&hub, carol.key_id.as_str()));

    // A revoked invite takes the person who never joined with it.
    let invite = ok(&hub, &owner, "invite_create", json!({ "name": "Dan" })).await;
    let id = invite["invite"]["inviteId"].clone();
    let said = |hub: &Hub| {
        events(hub, fleetd_contracts::events::HubEventType::PeopleChanged)
            .into_iter()
            .filter(|e| {
                e.data
                    .as_ref()
                    .is_some_and(|d| d["change"] == "invite_revoked")
            })
            .count()
    };
    let taken = ok(&hub, &owner, "invite_revoke", json!({ "inviteId": id })).await;
    assert_eq!(taken["invite"]["state"], "revoked");
    // Again: the same answer, and nothing more said.
    let again = ok(&hub, &owner, "invite_revoke", json!({ "inviteId": id })).await;
    assert_eq!(again["invite"]["state"], "revoked");
    assert_eq!(said(&hub), 1);
    let body = json!({ "code": invite["code"], "deviceName": "dan" }).to_string();
    let (status, _) = handle(&hub, &Limiter::default(), None, None, body.as_bytes());
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let names: Vec<String> = People::new(hub.db.clone(), hub.clock.clone())
        .list(false)
        .unwrap()
        .into_iter()
        .map(|p| p.name.to_string())
        .collect();
    assert_eq!(names.len(), 1, "only the owner is left: {names:?}");
}

#[test]
fn an_older_hub_migrates_to_one_owner_with_every_human_key_bound_to_them() {
    let db = HubDb::open_memory().unwrap();
    let clock = ManualClock::at(1_792_000_000_000);
    let auth = crate::hub::auth::Auth::new(db.clone(), clock.clone());
    let all = |role| fleetd_contracts::auth::Grant {
        role,
        machines: fleetd_contracts::auth::GrantMachines::All(fleetd_contracts::auth::Star::Value),
    };
    let desk = auth
        .create_key("desk", &[all(Role::Admin)], KeyKind::Human)
        .unwrap();
    let wall = auth
        .create_key("wall", &[all(Role::Read)], KeyKind::Human)
        .unwrap();
    let scout = auth
        .create_key("scout", &[all(Role::Operate)], KeyKind::Agent)
        .unwrap();
    // As an older hub left them: keys with no person, and no people.
    db.with(|c| {
        c.execute_batch("UPDATE agent_keys SET person_id = NULL; DELETE FROM people;")?;
        Ok(())
    })
    .unwrap();
    assert!(auth.verify(&desk.key).unwrap().person.is_none());

    let people = People::new(db.clone(), clock.clone());
    let owner = people.ensure_owner().unwrap();
    assert_eq!(owner.role, HubRole::Owner);
    assert_eq!(
        people.ensure_owner().unwrap(),
        owner,
        "idempotent at every start"
    );
    assert_eq!(people.list(true).unwrap(), std::slice::from_ref(&owner));

    let desk = auth.verify(&desk.key).unwrap();
    let wall = auth.verify(&wall.key).unwrap();
    let scout = auth.verify(&scout.key).unwrap();
    assert_eq!(desk.person.as_ref(), Some(&owner.as_ref()));
    assert_eq!(wall.person.as_ref(), Some(&owner.as_ref()));
    assert_eq!(scout.person, None, "agent keys belong to no one");
    // Each device keeps exactly the grants it had: the owner's desk still administers, the wall still only reads.
    assert!(crate::hub::api::allows_everywhere(&desk, Role::Admin));
    assert!(!crate::hub::api::allows_everywhere(&wall, Role::Operate));

    // Nothing reads differently with one person.
    assert!(roster(&db).is_empty());
    assert_eq!(writer(&db, desk.person.as_ref()), "The human");
    assert_eq!(lead_people(&db), "");
}

#[tokio::test]
async fn chat_decisions_and_the_checklist_record_the_person() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    let alice = join(&hub, &owner, "Alice", "member", "alice-mac").await;
    let alice_ref = alice.person.clone().unwrap();
    let r = json!({ "machineId": "devbox", "projectId": "app" });

    let sent = ok(
        &hub,
        &alice,
        "chat_send",
        json!({ "projectRef": r, "text": "add dark mode", "clientRequestId": "c1" }),
    )
    .await;
    assert_eq!(sent["message"]["person"], json!(alice_ref));
    assert_eq!(
        sent["message"]["by"], "alice-mac",
        "older apps still read the device"
    );

    let decided = ok(
        &hub,
        &alice,
        "decisions_record",
        json!({ "key": "theme.default", "value": "system", "scope": { "kind": "project", "projectRef": r } }),
    )
    .await;
    let decision = &decided["decision"];
    assert_eq!(decision["person"], json!(alice_ref));
    assert_eq!(decision["by"], "human:alice-mac");
    let overturned = ok(
        &hub,
        &owner,
        "decisions_overturn",
        json!({ "decisionId": decision["decisionId"], "why": "not now" }),
    )
    .await;
    assert_eq!(
        overturned["overturned"]["retired"]["person"],
        json!(owner.person.clone().unwrap())
    );

    let project: fleetd_contracts::ids::ProjectRef = serde_json::from_value(r.clone()).unwrap();
    let call = serde_json::from_value(
        json!({ "items": [{ "text": "Dark mode follows the system" }, { "text": "Toggle in settings" }] }),
    )
    .unwrap();
    crate::hub::checklist::apply(&hub.db, &project, &call, 0)
        .unwrap()
        .unwrap();
    let removed = ok(
        &hub,
        &owner,
        "checklist_remove",
        json!({ "projectRef": r, "ids": [2] }),
    )
    .await;
    assert_eq!(removed["items"].as_array().unwrap().len(), 1);
    let changes: Vec<Value> = events(
        &hub,
        fleetd_contracts::events::HubEventType::ChecklistChanged,
    )
    .into_iter()
    .filter_map(|e| e.data)
    .collect();
    assert_eq!(
        changes.last().unwrap()["person"],
        json!(owner.person.clone().unwrap()),
        "a removal names who"
    );

    // An agent key removes nothing here.
    let agent = hub
        .auth
        .create_key(
            "scout",
            &[fleetd_contracts::auth::Grant {
                role: Role::Operate,
                machines: fleetd_contracts::auth::GrantMachines::All(
                    fleetd_contracts::auth::Star::Value,
                ),
            }],
            KeyKind::Agent,
        )
        .unwrap();
    let agent = hub.auth.verify(&agent.key).unwrap();
    assert_eq!(
        refused(
            &hub,
            &agent,
            "checklist_remove",
            json!({ "projectRef": r, "ids": [1] })
        )
        .await,
        ErrorCode::Forbidden
    );
}

#[tokio::test]
async fn the_lead_reads_who_wrote_once_there_are_two_people_and_reads_as_before_with_one() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    let set = crate::hub::prompts::PromptSet::defaults();
    let message = |person: Option<&PersonRef>| -> fleetd_contracts::chat::ChatMessage {
        serde_json::from_value(json!({
            "messageId": "m1", "projectRef": { "machineId": "devbox", "projectId": "app" }, "seq": 1,
            "author": "human", "text": "ship it", "createdAt": AT, "state": "final", "person": person,
        }))
        .unwrap()
    };
    let r = fleetd_contracts::ids::ProjectRef {
        machine_id: fleetd_contracts::ids::MachineId::unchecked("devbox"),
        project_id: fleetd_contracts::ids::ProjectId::unchecked("app"),
    };
    let lead_start = |people: &str| {
        crate::hub::leads::prompt::render_lead_start(set, &r, "app", &[], "D", "", people, None)
            .whole()
    };
    let shipped = lead_start("");

    // One person: exactly today's words.
    let mine = message(owner.person.as_ref());
    let one = crate::hub::chat::flow::for_lead(
        set,
        &mine,
        None,
        "",
        &writer(&hub.db, mine.person.as_ref()),
    );
    assert_eq!(one, "The human writes in your chat:\n\nship it");
    assert_eq!(lead_start(&lead_people(&hub.db)), shipped);
    assert!(shipped.starts_with(
        "You are the lead of project app (devbox/app) in fleetd. You and the human share one chat: you turn what they \
         ask for into work, run fleetd agents to do it, and tell them only what needs them. You never write code or change \
         files yourself.\n"
    ));

    // Two people: the lead reads each writer's name, and lead.start names who shares the chat.
    let alice = join(&hub, &owner, "Alice", "member", "alice-mac").await;
    let hers = message(alice.person.as_ref());
    let two = crate::hub::chat::flow::for_lead(
        set,
        &hers,
        None,
        "",
        &writer(&hub.db, hers.person.as_ref()),
    );
    assert_eq!(two, "Alice writes in your chat:\n\nship it");
    let owner_name = owner.person.as_ref().unwrap().name.to_string();
    let started = lead_start(&lead_people(&hub.db));
    assert!(
        started.contains(&format!(
            "You never write code or change files yourself. Several people share this hub and its chats: \
             {owner_name} (owner), Alice (member)."
        )),
        "{started}"
    );
    // A message from before people names no one.
    let old = message(None);
    assert_eq!(writer(&hub.db, old.person.as_ref()), "The human");
}
