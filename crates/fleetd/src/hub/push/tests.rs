//! Push over a real in-memory hub and a fake relay: a sealed payload opens with the device's secret key, each person's
//! devices get only what is theirs, a dead token's device is dropped but most of a person's phones never are at once,
//! the relay's key is kept sealed and sent, and the tools keep phones to their person.
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::events::{Attention, HubEventType};
use fleetd_contracts::ids::{MachineId, ProjectId};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::push::{PUSH_PAYLOAD_MAX, PushKind, PushPayload};
use serde_json::{Value, json};

use super::*;
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::pair::{Limiter, PairCodes, handle};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, NewEvent};
use crate::push_relay::{RelayAnswer, RelayPush};

const AT: &str = "2026-10-19T10:00:00.000Z";

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    (hub_on(HubDb::open_memory().unwrap(), &home), home)
}

/// A hub over `db`, its home in `home`: the same home again is the same hub after a restart.
fn hub_on(db: Arc<HubDb>, home: &tempfile::TempDir) -> Arc<Hub> {
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: Some("http://devbox:4790".into()),
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(db, config, ManualClock::at(1_792_000_000_000)).unwrap();
    let project = |id: &str, title: &str| -> fleetd_contracts::model::ProjectSummary {
        serde_json::from_value(json!({
            "machineId": "devbox", "projectId": id, "title": title, "workspaceRoot": format!("/work/{id}"),
            "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
        }))
        .unwrap()
    };
    hub.store
        .projects_upsert_many(
            &MachineId::unchecked("devbox"),
            &[project("app", "app"), project("navi", "Ada")],
        )
        .unwrap();
    hub
}

fn redeem(hub: &Hub, code: &str, device: &str) -> Caller {
    let body = json!({ "code": code, "deviceName": device }).to_string();
    let (status, out) = handle(hub, &Limiter::default(), None, None, body.as_bytes());
    assert_eq!(status, StatusCode::OK, "{out}");
    hub.auth.verify(out["key"].as_str().unwrap()).unwrap()
}

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

/// `owner` invites a member who pairs `device`.
async fn member(hub: &Arc<Hub>, owner: &Caller, name: &str, device: &str) -> Caller {
    let invite = ok(
        hub,
        owner,
        "invite_create",
        json!({ "name": name, "role": "member" }),
    )
    .await;
    redeem(hub, invite["code"].as_str().unwrap(), device)
}

/// A phone's key pair, as the app makes one at pairing.
fn keys() -> (crypto_box::SecretKey, String) {
    let secret = crypto_box::SecretKey::generate(&mut crypto_box::aead::OsRng);
    let public = B64.encode(secret.public_key().as_bytes());
    (secret, public)
}

async fn phone(
    hub: &Arc<Hub>,
    who: &Caller,
    platform: &str,
    token: &str,
) -> (crypto_box::SecretKey, Value) {
    let (secret, public) = keys();
    let out = ok(
        hub,
        who,
        "push_device_register",
        json!({ "platform": platform, "token": token, "publicKey": public, "name": format!("{token} phone") }),
    )
    .await;
    (secret, out)
}

/// A relay that takes every push, answering `dead` for a token starting "dead".
#[derive(Clone, Default)]
struct FakeRelay {
    got: Arc<Mutex<Vec<RelayPush>>>,
    /// Each push's Authorization header.
    auth: Arc<Mutex<Vec<Option<String>>>>,
}

async fn fake_relay() -> (FakeRelay, String) {
    let relay = FakeRelay::default();
    let seen = relay.clone();
    let app = axum::Router::new().route(
        "/v1/push",
        axum::routing::post(
            move |headers: axum::http::HeaderMap, axum::Json(push): axum::Json<RelayPush>| {
                let seen = seen.clone();
                async move {
                    let dead = push.token.starts_with("dead");
                    seen.got.lock().unwrap().push(push);
                    seen.auth.lock().unwrap().push(
                        headers
                            .get("authorization")
                            .map(|v| v.to_str().unwrap().to_owned()),
                    );
                    axum::Json(if dead {
                        RelayAnswer::Dead
                    } else {
                        RelayAnswer::Sent
                    })
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (relay, url)
}

fn lead_message(hub: &Hub, project: &str, seq: i64, text: &str) {
    let r = json!({ "machineId": "devbox", "projectId": project });
    hub.events
        .append(NewEvent {
            at: AT.to_owned().into(),
            r#type: HubEventType::ChatMessage,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: Some(ProjectId::unchecked(project)),
            thread_id: None,
            summary: "The lead in the chat".into(),
            data: Some(json!({
                "projectRef": r, "messageId": format!("m{seq}"), "seq": seq, "author": "lead", "state": "final",
                "message": {
                    "messageId": format!("m{seq}"), "projectRef": r, "seq": seq, "author": "lead", "text": text,
                    "createdAt": AT, "state": "final",
                },
            })),
            attention: None,
        })
        .unwrap();
}

/// A human message from `person` in `project`'s chat, as the chat stores one.
fn human_wrote(hub: &Hub, project: &str, seq: i64, person: &Caller) {
    let p = person.person.as_ref().unwrap();
    let data = json!({ "author": "human", "person": { "personId": p.person_id, "name": p.name } });
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, data) VALUES ('devbox', ?, ?, 1, ?)",
                params![project, seq, data.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
}

fn opened(secret: &crypto_box::SecretKey, push: &RelayPush) -> PushPayload {
    let sealed = B64.decode(&push.ciphertext).unwrap();
    serde_json::from_slice(&secret.unseal(&sealed).unwrap()).unwrap()
}

#[test]
fn a_sealed_payload_opens_with_the_devices_secret_key_only() {
    let (secret, _) = keys();
    let payload = PushPayload {
        v: 1,
        kind: PushKind::Message,
        title: "Ada".into(),
        body: "Your flight moved to 9:40.".into(),
        hub: "http://devbox:4790".into(),
        machine_id: Some(MachineId::unchecked("devbox")),
        project_id: Some(ProjectId::unchecked("navi")),
        thread_id: None,
        message_id: Some(ChatMessageId::unchecked("m3")),
        request_id: None,
        urgent: None,
        quiet: None,
        at: AT.to_owned().into(),
    };
    let plain = payload_json(&payload);
    let sealed = B64
        .decode(seal(secret.public_key().as_bytes(), &plain))
        .unwrap();
    // A sealed box: an ephemeral public key and the tag around the text.
    assert_eq!(sealed.len(), plain.len() + 48);
    let opened: PushPayload = serde_json::from_slice(&secret.unseal(&sealed).unwrap()).unwrap();
    assert_eq!(opened, payload);
    let (other, _) = keys();
    assert!(other.unseal(&sealed).is_err());

    // A long body is cut so the payload fits under APNs's and FCM's 4 KB once sealed.
    let long = PushPayload {
        body: "naïve ".repeat(2000),
        ..payload
    };
    let plain = payload_json(&long);
    assert!(plain.len() <= PUSH_PAYLOAD_MAX);
    let cut: PushPayload = serde_json::from_slice(&plain).unwrap();
    assert!(cut.body.ends_with('…') && cut.body.chars().count() <= 1000);
}

#[tokio::test]
async fn each_persons_devices_get_only_what_is_theirs() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    let alice = member(&hub, &owner, "Alice", "alice-phone").await;
    let (owner_key, _) = phone(&hub, &owner, "ios", "aa11").await;
    let (alice_key, _) = phone(&hub, &alice, "android", "bb22:x").await;
    let (relay, url) = fake_relay().await;
    ok(&hub, &owner, "push_relay_set", json!({ "url": url })).await;
    // Alice's Navi Ada.
    hub.db
        .with(|c| {
            crate::hub::navi::store::put(
                c,
                &ProjectRef {
                    machine_id: MachineId::unchecked("devbox"),
                    project_id: ProjectId::unchecked("navi"),
                },
                &fleetd_contracts::model::ProjectCreator {
                    key_id: alice.key_id.to_string(),
                    name: "alice-phone".into(),
                },
                alice.person.as_ref().map(|p| &p.person_id),
                1,
            )?;
            Ok(())
        })
        .unwrap();
    let http = reqwest::Client::new();
    let mut follow = Follow::default();
    let cursor = hub.events.head();

    lead_message(&hub, "navi", 1, "Your  flight\nmoved to 9:40.");
    let (cursor, _, sent) = step(&hub, &http, &mut follow, cursor).await.unwrap();
    assert_eq!(sent.len(), 1, "{sent:?}");
    let got = relay.got.lock().unwrap().clone();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].platform, PushPlatform::Android);
    assert_eq!(got[0].token, "bb22:x");
    assert_eq!(got[0].collapse_key, None);
    let payload = opened(&alice_key, &got[0]);
    assert_eq!(payload.kind, PushKind::Message);
    assert_eq!(payload.title, "Ada");
    assert_eq!(payload.body, "Your flight moved to 9:40.");
    assert_eq!(payload.hub, "http://devbox:4790");
    assert_eq!(payload.message_id.as_ref().map(|m| m.as_str()), Some("m1"));
    assert!(
        owner_key
            .unseal(&B64.decode(&got[0].ciphertext).unwrap())
            .is_err()
    );

    // The same final message announced again isn't sent twice.
    lead_message(&hub, "navi", 1, "Your flight moved to 9:40.");
    let (cursor, _, sent) = step(&hub, &http, &mut follow, cursor).await.unwrap();
    assert!(sent.is_empty());

    // A project's lead answers whoever wrote to it last; nobody has, so the owner.
    lead_message(&hub, "app", 2, "PR #12 is ready.");
    let (cursor, _, _) = step(&hub, &http, &mut follow, cursor).await.unwrap();
    human_wrote(&hub, "app", 3, &alice);
    lead_message(&hub, "app", 4, "On it.");
    let (cursor, _, _) = step(&hub, &http, &mut follow, cursor).await.unwrap();
    {
        let got = relay.got.lock().unwrap();
        assert_eq!(got.len(), 3);
        assert_eq!(got[1].token, "aa11");
        assert_eq!(opened(&owner_key, &got[1]).body, "PR #12 is ready.");
        assert_eq!(got[2].token, "bb22:x");
    }

    // An approval names its request and collapses by it; an event about no project goes to the owners and admins.
    hub.events
        .append(NewEvent {
            at: AT.to_owned().into(),
            r#type: HubEventType::RequestOpened,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: Some(ProjectId::unchecked("navi")),
            thread_id: None,
            summary: "Q7 open: send the email to Bob".into(),
            data: Some(json!({ "requestId": "Q7", "kind": "command_approval", "state": "open" })),
            attention: Some(Attention::Urgent),
        })
        .unwrap();
    hub.events
        .append(NewEvent {
            at: AT.to_owned().into(),
            r#type: HubEventType::MachineRecoveryPaused,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: None,
            thread_id: None,
            summary: "devbox keeps failing: recovery paused".into(),
            data: None,
            attention: Some(Attention::Loud),
        })
        .unwrap();
    // Routine events push nothing.
    hub.events
        .append(NewEvent {
            at: AT.to_owned().into(),
            r#type: HubEventType::ThreadStarted,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: Some(ProjectId::unchecked("app")),
            thread_id: None,
            summary: "an agent started".into(),
            data: None,
            attention: None,
        })
        .unwrap();
    step(&hub, &http, &mut follow, cursor).await.unwrap();
    let got = relay.got.lock().unwrap().clone();
    assert_eq!(got.len(), 5);
    let approval = opened(&alice_key, &got[3]);
    assert_eq!(approval.kind, PushKind::Approval);
    assert_eq!(approval.request_id.as_ref().map(|r| r.as_str()), Some("Q7"));
    assert_eq!(approval.urgent, Some(true));
    assert!(
        got[3]
            .collapse_key
            .as_ref()
            .is_some_and(|k| k.len() == 16 && !k.contains("Q7"))
    );
    assert_eq!(got[4].token, "aa11");
    let alert = opened(&owner_key, &got[4]);
    assert_eq!(
        (alert.kind, alert.title.as_str()),
        (PushKind::Alert, "fleetd")
    );
}

#[tokio::test]
async fn a_dead_token_drops_its_device_and_a_signed_out_one_gets_nothing() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    let tablet = {
        let minted = PairCodes::new(hub.db.clone(), hub.clock.clone())
            .create(None, crate::hub::pair::DEFAULT_ROLE)
            .unwrap();
        redeem(&hub, &minted.code, "tablet")
    };
    phone(&hub, &owner, "ios", "dead0001").await;
    phone(&hub, &owner, "ios", "cc33").await;
    phone(&hub, &tablet, "android", "dd44").await;
    let (relay, url) = fake_relay().await;
    ok(
        &hub,
        &owner,
        "push_relay_set",
        json!({ "url": format!("{url}/") }),
    )
    .await;
    hub.auth.revoke(tablet.key_id.as_str()).unwrap();

    let http = reqwest::Client::new();
    let mut follow = Follow::default();
    lead_message(&hub, "app", 1, "Done.");
    let (_, _, sent) = step(&hub, &http, &mut follow, 0).await.unwrap();
    assert_eq!(
        sent.iter().map(|(_, o)| o.clone()).collect::<Vec<_>>(),
        [Outcome::Dead, Outcome::Sent]
    );
    let tokens: Vec<String> = relay
        .got
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.token.clone())
        .collect();
    assert_eq!(tokens, ["dead0001", "cc33"]);

    let listed = ok(&hub, &owner, "push_devices_list", json!({})).await;
    let names: Vec<&str> = listed["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["cc33 phone", "dd44 phone"]);
    assert!(listed["devices"][0]["lastSentAt"].is_string());
    assert_eq!(listed["relay"], true);

    // Turned off, nothing is sent.
    ok(&hub, &owner, "push_relay_set", json!({ "url": "" })).await;
    lead_message(&hub, "app", 2, "Again.");
    let (_, _, sent) = step(&hub, &http, &mut follow, 0).await.unwrap();
    assert!(sent.is_empty());
}

#[tokio::test]
async fn a_relay_that_calls_most_of_a_persons_phones_dead_at_once_drops_none() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    let alice = member(&hub, &owner, "Alice", "alice-phone").await;
    phone(&hub, &owner, "ios", "dead0001").await;
    phone(&hub, &owner, "ios", "dead0002").await;
    phone(&hub, &owner, "ios", "cc33").await;
    phone(&hub, &alice, "android", "dead0003").await;
    let (_, url) = fake_relay().await;
    ok(&hub, &owner, "push_relay_set", json!({ "url": url })).await;
    let http = reqwest::Client::new();
    let mut follow = Follow::default();

    // Two of the owner's three phones: more than half, so a relay set up wrong is likelier than two lost phones.
    lead_message(&hub, "app", 1, "Done.");
    let (_, _, sent) = step(&hub, &http, &mut follow, 0).await.unwrap();
    let outcomes: Vec<&Outcome> = sent.iter().map(|(_, o)| o).collect();
    assert!(
        matches!(
            outcomes[..],
            [Outcome::Failed(_), Outcome::Failed(_), Outcome::Sent]
        ),
        "{outcomes:?}"
    );
    let Outcome::Failed(why) = outcomes[0] else {
        unreachable!()
    };
    assert!(why.contains("2 of") && why.contains("kept them"), "{why}");
    let listed = ok(&hub, &owner, "push_devices_list", json!({})).await;
    assert_eq!(listed["devices"].as_array().unwrap().len(), 3);
    // Logged once, not once a phone or a notification.
    assert_eq!(follow.warned.len(), 1);
    lead_message(&hub, "app", 2, "Again.");
    step(&hub, &http, &mut follow, 0).await.unwrap();
    assert_eq!(follow.warned.len(), 1);

    // A person's only phone is all of them: kept too.
    human_wrote(&hub, "app", 3, &alice);
    let cursor = hub.events.head();
    lead_message(&hub, "app", 4, "On it.");
    let (_, _, sent) = step(&hub, &http, &mut follow, cursor).await.unwrap();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(
        matches!(&sent[0].1, Outcome::Failed(why) if why.contains("1 of")),
        "{sent:?}"
    );
    let alices = ok(&hub, &alice, "push_devices_list", json!({})).await;
    assert_eq!(alices["devices"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn the_relays_key_is_kept_sealed_and_sent_as_a_bearer_token() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    phone(&hub, &owner, "ios", "aa11").await;
    let (relay, url) = fake_relay().await;
    let box_pub_key = ok(&hub, &owner, "hub_links_get", json!({})).await["boxPubKey"]
        .as_str()
        .unwrap()
        .to_owned();
    let to_hub: [u8; 32] = B64.decode(&box_pub_key).unwrap().try_into().unwrap();
    let set = ok(
        &hub,
        &owner,
        "push_relay_set",
        json!({ "url": url, "key": seal(&to_hub, b"relay-key-1\n") }),
    )
    .await;
    assert_eq!(set["key"], true);
    // Kept sealed, never in the clear.
    let kept = hub.db.with(relay_setting).unwrap();
    assert!(!kept.key_sealed.as_deref().unwrap().contains("relay-key-1"));

    let http = reqwest::Client::new();
    lead_message(&hub, "app", 1, "Done.");
    let (_, _, sent) = step(&hub, &http, &mut Follow::default(), 0).await.unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(
        relay.auth.lock().unwrap().clone(),
        [Some("Bearer relay-key-1".to_owned())]
    );

    // A key not sealed to this hub is refused; a URL set again without one sends none.
    let elsewhere = crypto_box::SecretKey::generate(&mut crypto_box::aead::OsRng);
    assert_eq!(
        refused(
            &hub,
            &owner,
            "push_relay_set",
            json!({ "url": url, "key": seal(elsewhere.public_key().as_bytes(), b"relay-key-1") }),
        )
        .await,
        ErrorCode::Invalid
    );
    let set = ok(&hub, &owner, "push_relay_set", json!({ "url": url })).await;
    assert_eq!(set["key"], false);
    lead_message(&hub, "app", 2, "Again.");
    step(&hub, &http, &mut Follow::default(), 0).await.unwrap();
    assert_eq!(relay.auth.lock().unwrap().last().unwrap(), &None);
}

fn relay_setting(c: &Connection) -> Result<RelaySetting, StoreError> {
    Ok(relay(c, DEFAULT_RELAY)?.unwrap())
}

#[tokio::test]
async fn phones_are_their_persons_and_the_relay_is_an_admins() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    let alice = member(&hub, &owner, "Alice", "alice-phone").await;
    let (_, mine) = phone(&hub, &owner, "ios", "ee55").await;
    // Never set, the default relay sends.
    assert_eq!(mine["relay"], true);
    assert!(mine["next"].is_null());
    let id = mine["device"]["deviceId"].as_str().unwrap().to_owned();
    assert!(id.starts_with("pd_"));

    // The same token from Alice's device moves the phone to her.
    let (_, moved) = phone(&hub, &alice, "ios", "ee55").await;
    assert_eq!(moved["device"]["deviceId"], id.as_str());
    assert_eq!(
        ok(&hub, &owner, "push_devices_list", json!({})).await["devices"],
        json!([])
    );
    assert_eq!(
        refused(
            &hub,
            &owner,
            "push_device_remove",
            json!({ "deviceId": id })
        )
        .await,
        ErrorCode::NotFound
    );
    ok(
        &hub,
        &alice,
        "push_device_remove",
        json!({ "deviceId": id }),
    )
    .await;
    assert_eq!(
        ok(&hub, &alice, "push_devices_list", json!({})).await["devices"],
        json!([])
    );

    // A bad key or token is refused; an agent key has no phones; a member sets no relay.
    let bad = |key: &str, token: &str| json!({ "platform": "ios", "token": token, "publicKey": key, "name": "x" });
    let (_, good_key) = keys();
    assert_eq!(
        refused(&hub, &alice, "push_device_register", bad("AAAA", "ff66")).await,
        ErrorCode::Invalid
    );
    assert_eq!(
        refused(
            &hub,
            &alice,
            "push_device_register",
            bad(&good_key, "ff 66")
        )
        .await,
        ErrorCode::Invalid
    );
    let agent = Caller {
        kind: Some(fleetd_contracts::auth::KeyKind::Agent),
        person: None,
        ..owner.clone()
    };
    assert_eq!(
        refused(&hub, &agent, "push_devices_list", json!({})).await,
        ErrorCode::Forbidden
    );
    assert_eq!(
        refused(
            &hub,
            &alice,
            "push_relay_set",
            json!({ "url": "https://push.example.com" })
        )
        .await,
        ErrorCode::Forbidden
    );
    assert_eq!(
        refused(
            &hub,
            &owner,
            "push_relay_set",
            json!({ "url": "ftp://push.example.com" })
        )
        .await,
        ErrorCode::Invalid
    );
    let set = ok(
        &hub,
        &owner,
        "push_relay_set",
        json!({ "url": "https://push.example.com/" }),
    )
    .await;
    assert_eq!(set["url"], "https://push.example.com");
}

/// The hub's Follow with the default relay at `url`, a fake standing in for push.fleetd.sh.
fn follow_with_default(url: &str) -> Follow {
    Follow {
        default_relay: url.to_owned(),
        ..Follow::default()
    }
}

#[tokio::test]
async fn a_hub_with_no_relay_set_sends_to_the_default_without_a_key() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    let (_, registered) = phone(&hub, &owner, "ios", "aa11").await;
    assert_eq!(registered["relay"], true);
    assert_eq!(
        ok(&hub, &owner, "push_devices_list", json!({})).await["relay"],
        true
    );
    assert_eq!(hub.db.with(|c| relay(c, DEFAULT_RELAY)).unwrap(), {
        Some(RelaySetting {
            url: "https://push.fleetd.sh".into(),
            key_sealed: None,
        })
    });
    let (fake, url) = fake_relay().await;
    let http = reqwest::Client::new();
    lead_message(&hub, "app", 1, "Done.");
    let (_, _, sent) = step(&hub, &http, &mut follow_with_default(&url), 0)
        .await
        .unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(fake.got.lock().unwrap()[0].token, "aa11");
    assert_eq!(fake.auth.lock().unwrap().clone(), [None]);

    // A relay set overrides it, with or without a key; the default URL without a key is the default again.
    let (other, other_url) = fake_relay().await;
    let set = ok(&hub, &owner, "push_relay_set", json!({ "url": other_url })).await;
    assert_eq!(
        (set["url"].as_str(), set["default"].as_bool()),
        (Some(other_url.as_str()), Some(false))
    );
    lead_message(&hub, "app", 2, "Again.");
    step(&hub, &http, &mut follow_with_default(&url), 0)
        .await
        .unwrap();
    assert_eq!(other.got.lock().unwrap().len(), 2);
    assert_eq!(fake.got.lock().unwrap().len(), 1);
    let set = ok(
        &hub,
        &owner,
        "push_relay_set",
        json!({ "url": "https://push.fleetd.sh/" }),
    )
    .await;
    assert_eq!(
        set,
        json!({ "url": "https://push.fleetd.sh", "key": false, "default": true })
    );
    assert_eq!(
        hub.db
            .with(
                |c| Ok(c.query_row("SELECT count(*) FROM push_relay", [], |r| r
                    .get::<_, i64>(0))?)
            )
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn pushes_turned_off_stay_off_after_a_restart() {
    let home = tempfile::tempdir().unwrap();
    let data = tempfile::tempdir().unwrap();
    let hub = hub_on(HubDb::open(data.path()).unwrap(), &home);
    let owner = owner_device(&hub);
    phone(&hub, &owner, "ios", "aa11").await;
    let off = ok(&hub, &owner, "push_relay_set", json!({ "url": "" })).await;
    assert_eq!(off, json!({ "key": false, "default": false }));
    assert_eq!(
        ok(&hub, &owner, "push_devices_list", json!({})).await["relay"],
        false
    );
    drop(hub);

    let hub = hub_on(HubDb::open(data.path()).unwrap(), &home);
    let (fake, url) = fake_relay().await;
    lead_message(&hub, "app", 1, "Done.");
    let (_, _, sent) = step(
        &hub,
        &reqwest::Client::new(),
        &mut follow_with_default(&url),
        0,
    )
    .await
    .unwrap();
    assert!(sent.is_empty());
    assert!(fake.got.lock().unwrap().is_empty());
    let (_, registered) = phone(&hub, &owner, "ios", "bb22").await;
    assert_eq!(registered["relay"], false);
    assert!(registered["next"].as_str().unwrap().contains("off"));
}

#[tokio::test]
async fn the_default_relay_gets_no_key_and_nothing_in_the_clear() {
    let (hub, _home) = hub();
    let owner = owner_device(&hub);
    let box_pub_key = ok(&hub, &owner, "hub_links_get", json!({})).await["boxPubKey"]
        .as_str()
        .unwrap()
        .to_owned();
    let to_hub: [u8; 32] = B64.decode(&box_pub_key).unwrap().try_into().unwrap();
    for url in ["http://push.fleetd.sh", "https://PUSH.fleetd.sh/"] {
        let input = if url.starts_with("http:") {
            json!({ "url": url })
        } else {
            json!({ "url": url, "key": seal(&to_hub, b"relay-key-1") })
        };
        assert_eq!(
            refused(&hub, &owner, "push_relay_set", input).await,
            ErrorCode::Invalid,
            "{url}"
        );
    }

    // A setting kept from before (or written by hand) is still never sent a key, nor sent to over http.
    let kept = |url: &str| RelaySetting {
        url: url.into(),
        key_sealed: Some("c2VhbGVk".into()),
    };
    assert_eq!(sendable(&kept("https://push.fleetd.sh")), Ok(None));
    assert_eq!(sendable(&kept("https://push.fleetd.sh:443/x")), Ok(None));
    assert!(sendable(&kept("http://push.fleetd.sh")).is_err());
    assert_eq!(
        sendable(&kept("https://push.example.com")),
        Ok(Some("c2VhbGVk"))
    );
    assert_eq!(
        sendable(&kept("https://push.fleetd.sh.example.com")),
        Ok(Some("c2VhbGVk"))
    );
    hub.db
        .with(|c| set_relay(c, Some(&kept("http://push.fleetd.sh"))))
        .unwrap();
    phone(&hub, &owner, "ios", "aa11").await;
    lead_message(&hub, "app", 1, "Done.");
    let mut follow = Follow::default();
    let (_, _, sent) = step(&hub, &reqwest::Client::new(), &mut follow, 0)
        .await
        .unwrap();
    assert!(sent.is_empty());
    assert!(follow.warned.keys().any(|w| w.contains("https only")));
}
