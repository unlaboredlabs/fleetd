//! People's own screens (D239), over a real hub and a fake runner node: a person opens one on the machine they pick and
//! has control from its start; only people who may use the project (a Navi: its owner) open one; a Navi's browser is
//! sealed to run on the profile it keeps; a full machine refuses or takes the person in line, ahead of agents, without
//! ending an agent's screen; and an idle one ends.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::{Grant, KeyKind};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::machine_roles::SessionHost;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::node_link::{CAP_BROWSER, CAP_SESSION_HOST, CAP_SESSION_SEAL, HubToNode};
use fleetd_contracts::people::{HubRole, PersonId, PersonName};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::tests::{AT, NOW_MS, hub_at, mid, remote, report_hosts, route, start};
use crate::hub::api::{CallError, Caller, Hub, registry};
use crate::hub::people::People;
use crate::hub::store::test_clock::ManualClock;

/// What the fake runner saw: each hosted call's op, its host key, and for a start what the hub sealed to it.
#[derive(Debug)]
struct Seen {
    op: String,
    key: String,
    seal: Option<Value>,
}

/// Gives `m` a box key the test holds, and links a fake node for it: it opens what the hub seals to it, starts each
/// screen and reports it live in the project's name (as a runner does, under its host key), hands control to a person
/// when asked, and ends a screen.
fn runner(hub: &Arc<Hub>, m: &str) -> mpsc::UnboundedReceiver<Seen> {
    let secret = crypto_box::SecretKey::generate(&mut crypto_box::aead::OsRng);
    let public = B64.encode(secret.public_key().as_bytes());
    let machine = serde_json::from_value(json!({
        "machineId": m, "name": m, "tags": [], "status": "online", "lastSeenAt": AT, "nodeVersion": "0.1.0",
        "boxPubKey": public,
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, None).unwrap();
    let (tx, mut calls) = mpsc::unbounded_channel::<HubToNode>();
    std::mem::forget(hub.node_commands.attach(&mid(m), tx));
    let mut link = hub
        .link
        .test_link(&mid(m), &[CAP_SESSION_HOST, CAP_SESSION_SEAL, CAP_BROWSER]);
    let (seen_tx, seen) = mpsc::unbounded_channel();
    let (hub, m) = (hub.clone(), mid(m));
    tokio::spawn(async move {
        // Each screen's key and kind, by its session.
        let mut screens: HashMap<String, (String, String)> = HashMap::new();
        let mut n = 0u32;
        let report = |key: &str, id: &str, kind: &str, state: &str, control: &str| {
            serde_json::from_value::<fleetd_contracts::lead_calls::LeadCallFrame>(json!({
                "id": "browser", "cwd": "/", "threadId": key,
                "call": {
                    "op": "browser_session", "sessionId": id, "kind": kind, "threadId": key,
                    "purpose": "A screen", "state": state, "control": control,
                    "startedAt": crate::hub::store::iso_ms(NOW_MS as i64),
                },
            }))
            .unwrap()
        };
        loop {
            tokio::select! {
                Some(frame) = calls.recv() => {
                    let HubToNode::SessionHost(host) = frame else { continue };
                    let key = host.host_key.to_string();
                    let op = host.frame.call.op();
                    let mut seal = None;
                    let result = match &host.frame.call {
                        fleetd_contracts::browser::BrowserCall::SessionStart(s) => {
                            // An agent's node's seal is its own (the tests' stand-in opens nowhere); the hub's opens here.
                            let sealed = B64.decode(host.sealed.as_ref().unwrap().as_str()).unwrap();
                            seal = secret
                                .unseal(&sealed)
                                .ok()
                                .map(|plain| serde_json::from_slice::<Value>(&plain).unwrap());
                            n += 1;
                            let id = format!("B{n:032x}");
                            let kind = s.kind.unwrap_or_default().as_str().to_owned();
                            // A node reports its screen live before it answers the start.
                            let answer = hub.link.answer_lead_call(&m, report(&key, &id, &kind, "live", "agent")).await;
                            assert!(answer.error.is_none(), "{:?}", answer.error);
                            screens.insert(id.clone(), (key.clone(), kind));
                            json!({ "op": "session_start", "sessionId": id, "cdp": "ws://127.0.0.1:1/x", "startMs": 5 })
                        }
                        _ => {
                            let found = screens.iter().find(|(_, (k, _))| k == &key).map(|(id, (k, kind))| (id.clone(), k.clone(), kind.clone()));
                            let (id, k, kind) = found.expect("a screen it hosts");
                            let answer = hub.link.answer_lead_call(&m, report(&k, &id, &kind, "uploading", "human")).await;
                            assert!(answer.error.is_none(), "{:?}", answer.error);
                            json!({ "op": "session_end", "sessionId": id, "files": [] })
                        }
                    };
                    let reply = serde_json::from_value(json!({
                        "t": "session_host_result", "id": host.id,
                        "frame": { "id": host.frame.id, "result": result },
                    }))
                    .unwrap();
                    hub.node_commands.resolve(&m, reply);
                    let _ = seen_tx.send(Seen { op: op.to_owned(), key, seal });
                }
                Some(frame) = link.recv() => {
                    if let HubToNode::BrowserControl(c) = frame
                        && let Some((key, kind)) = screens.get(c.session_id.as_str())
                    {
                        let answer = hub.link.answer_lead_call(&m, report(key, c.session_id.as_str(), kind, "live", "human")).await;
                        assert!(answer.error.is_none(), "{:?}", answer.error);
                    }
                }
                else => return,
            }
        }
    });
    seen
}

async fn next(seen: &mut mpsc::UnboundedReceiver<Seen>) -> Seen {
    tokio::time::timeout(Duration::from_secs(5), seen.recv())
        .await
        .expect("the runner hears of it")
        .unwrap()
}

/// A person on the hub, and their desktop's key with `role` everywhere.
fn person(hub: &Hub, name: &str, role: &str) -> (PersonId, Caller) {
    let people = People::new(hub.db.clone(), hub.clock.clone());
    let p = people
        .create(&PersonName::unchecked(name), HubRole::Member)
        .unwrap();
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": role, "machines": "*" }])).unwrap();
    let key = hub
        .auth
        .create_key_for("desk", &grants, KeyKind::Human, Some(&p.person_id))
        .unwrap()
        .info;
    (p.person_id, key)
}

async fn call(hub: &Arc<Hub>, who: &Caller, tool: &str, input: Value) -> Result<Value, CallError> {
    registry().call(hub, who, tool, input).await
}

fn refusal(out: Result<Value, CallError>) -> (ErrorCode, String) {
    match out {
        Err(CallError::Tool(e)) => (e.code, e.message),
        other => panic!("not refused: {other:?}"),
    }
}

fn open(machine: &str, kind: &str) -> Value {
    json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "kind": kind, "machineId": machine })
}

fn live_on(hub: &Hub, m: &str) -> i64 {
    hub.db
        .with(|c| super::live_on(c, &mid(m), NOW_MS as i64 + 1))
        .unwrap()
}

fn setup() -> (Arc<Hub>, tempfile::TempDir, Arc<ManualClock>) {
    let clock = ManualClock::at(NOW_MS);
    let (hub, home) = hub_at(clock.clone());
    (hub, home, clock)
}

#[tokio::test]
async fn a_person_opens_a_screen_on_the_machine_they_pick_and_drives_it_from_the_start() {
    let (hub, _home, _clock) = setup();
    let mut mac1 = runner(&hub, "mac1");
    let (ada, desk) = person(&hub, "Ada", "operate");
    let out = call(&hub, &desk, "screen_open", open("mac1", "ios"))
        .await
        .unwrap();
    let session = &out["session"];
    assert_eq!(session["control"], "human", "{out}");
    assert_eq!(session["state"], "live");
    assert_eq!(session["kind"], "ios");
    assert_eq!(session["openedBy"]["personId"], ada.as_str());
    assert_eq!(session["projectRef"]["projectId"], "app");
    let started = next(&mut mac1).await;
    assert_eq!(started.op, "session_start");
    // Sealed by the hub: nothing to scrub, a relay key, and no Navi's profile.
    let seal = started.seal.unwrap();
    assert_eq!(seal["secrets"], json!([]));
    assert!(seal["relayKey"].is_string());
    assert!(seal.get("navi").is_none());
    // It takes one of mac1's slots, as any screen does, and lists with the caller's project.
    assert_eq!(live_on(&hub, "mac1"), 1);
    let listed = call(
        &hub,
        &desk,
        "browser_sessions",
        json!({ "projectRef": { "machineId": "devbox", "projectId": "app" } }),
    )
    .await
    .unwrap();
    assert_eq!(listed["sessions"][0]["openedBy"]["name"], "Ada");

    // Only its opener ends it; then it closes on mac1 and frees the slot.
    let (_, bee) = person(&hub, "Bee", "operate");
    let id = session["sessionId"].clone();
    let (code, _) = refusal(call(&hub, &bee, "screen_end", json!({ "sessionId": id })).await);
    assert_eq!(code, ErrorCode::Forbidden);
    let ended = call(&hub, &desk, "screen_end", json!({ "sessionId": id }))
        .await
        .unwrap();
    assert_eq!(ended["session"]["state"], "uploading");
    let end = next(&mut mac1).await;
    assert_eq!((end.op.as_str(), end.key), ("session_end", started.key));
    assert_eq!(live_on(&hub, "mac1"), 0);
}

#[tokio::test]
async fn only_people_who_may_use_the_project_open_one_and_only_where_it_can_run() {
    let (hub, _home, _clock) = setup();
    let _mac1 = runner(&hub, "mac1");
    let (_, desk) = person(&hub, "Ada", "operate");
    let (_, viewer) = person(&hub, "Cy", "read");
    // An agent's key opens its screens with session_start, not this.
    let agent: Caller = serde_json::from_value(json!({
        "keyId": "k9", "name": "agent", "prefix": "fld_agentz", "createdAt": AT,
        "grants": [{ "role": "admin", "machines": "*" }],
    }))
    .unwrap();
    let (code, _) = refusal(call(&hub, &agent, "screen_open", open("mac1", "ios")).await);
    assert_eq!(code, ErrorCode::Forbidden);
    let (code, _) = refusal(call(&hub, &viewer, "screen_open", open("mac1", "ios")).await);
    assert_eq!(code, ErrorCode::Forbidden);
    // devbox can't run an iOS simulator: said in the machine's own words.
    let (code, message) = refusal(call(&hub, &desk, "screen_open", open("devbox", "ios")).await);
    assert_eq!(code, ErrorCode::Failed);
    assert!(message.contains("devbox can't host"), "{message}");
    let (code, _) = refusal(
        call(
            &hub,
            &desk,
            "screen_open",
            json!({ "projectRef": { "machineId": "devbox", "projectId": "nope" }, "machineId": "mac1" }),
        )
        .await,
    );
    assert_eq!(code, ErrorCode::NotFound);
}

/// Makes `navi` on devbox a Navi of `owner`'s.
fn navi(hub: &Hub, name: &str, owner: &PersonId) -> ProjectRef {
    let r = ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(name),
    };
    hub.store
        .projects_upsert_many(
            &mid("devbox"),
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": name, "title": name, "workspaceRoot": format!("/navis/{name}"),
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    let by = serde_json::from_value(json!({ "keyId": "k1", "name": "desk" })).unwrap();
    hub.db
        .with(|c| Ok(crate::hub::navi::store::put(c, &r, &by, Some(owner), 1)?))
        .unwrap();
    r
}

#[tokio::test]
async fn a_navis_browser_opened_by_its_owner_runs_on_its_kept_profile_on_its_machine() {
    let (hub, _home, _clock) = setup();
    let mut devbox = runner(&hub, "devbox");
    let _mac1 = runner(&hub, "mac1");
    let (ada, desk) = person(&hub, "Ada", "operate");
    let (_, bee) = person(&hub, "Bee", "admin");
    navi(&hub, "ada-navi", &ada);
    let input = |machine: &str| json!({ "projectRef": { "machineId": "devbox", "projectId": "ada-navi" }, "machineId": machine });
    // Its profile is on devbox: a browser for it elsewhere would have none of its sign-ins.
    let (code, message) = refusal(call(&hub, &desk, "screen_open", input("mac1")).await);
    assert_eq!(code, ErrorCode::Invalid);
    assert!(message.contains("runs on its own machine"), "{message}");
    // Another person, an admin too, never reaches it.
    let (code, message) = refusal(call(&hub, &bee, "screen_open", input("devbox")).await);
    assert_eq!(code, ErrorCode::Forbidden);
    assert!(message.contains("another person's Navi"), "{message}");

    let out = call(&hub, &desk, "screen_open", input("devbox"))
        .await
        .unwrap();
    assert_eq!(out["session"]["control"], "human", "{out}");
    let started = next(&mut devbox).await;
    assert_eq!(started.seal.unwrap()["navi"], "ada-navi");
    // A project's browser gets no Navi's profile.
    call(&hub, &desk, "screen_open", open("devbox", "browser"))
        .await
        .unwrap();
    assert!(next(&mut devbox).await.seal.unwrap().get("navi").is_none());
}

#[tokio::test]
async fn a_full_machine_takes_people_in_line_ahead_of_agents_and_ends_no_agents_screen() {
    let (hub, _home, _clock) = setup();
    let _devbox = remote(&hub);
    let mut mac1 = runner(&hub, "mac1");
    hub.db
        .transaction(|c| {
            super::set_roles(
                c,
                &mid("mac1"),
                &super::Roles {
                    max_sessions: Some(2),
                    ..Default::default()
                },
            )
        })
        .unwrap();
    let (_, ada) = person(&hub, "Ada", "operate");
    let (bee_id, bee) = person(&hub, "Bee", "operate");
    // An agent's screen and Ada's fill mac1's two simulators.
    let agents = route(&hub, "th-1", SessionHost::Ios, start())
        .await
        .unwrap();
    assert_eq!(agents.runner, mid("mac1"));
    let agent_key = next(&mut mac1).await.key;
    let first = call(&hub, &ada, "screen_open", open("mac1", "ios"))
        .await
        .unwrap();
    next(&mut mac1).await;

    // Full: Bee is told so, and may wait.
    let (code, message) = refusal(call(&hub, &bee, "screen_open", open("mac1", "ios")).await);
    assert_eq!(code, ErrorCode::Failed);
    assert!(message.contains("mac1 is full: 2 of 2"), "{message}");
    let waiting = call(
        &hub,
        &bee,
        "screen_open",
        json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "kind": "ios", "machineId": "mac1", "wait": true }),
    )
    .await
    .unwrap();
    assert!(waiting["session"].is_null());
    assert_eq!(waiting["waiting"]["ahead"], 0);
    let listed = call(
        &hub,
        &bee,
        "browser_sessions",
        json!({ "projectRef": { "machineId": "devbox", "projectId": "app" } }),
    )
    .await
    .unwrap();
    assert_eq!(listed["waits"][0]["machineId"], "mac1");

    // Ada ends hers: the slot is Bee's, not the next agent's.
    call(
        &hub,
        &ada,
        "screen_end",
        json!({ "sessionId": first["session"]["sessionId"] }),
    )
    .await
    .unwrap();
    assert_eq!(next(&mut mac1).await.op, "session_end");
    let refused = route(&hub, "th-2", SessionHost::Ios, start())
        .await
        .unwrap_err();
    assert!(
        refused.message.contains("1 person waiting for a slot"),
        "{}",
        refused.message
    );
    assert_eq!(super::screens::serve_waits(&hub).unwrap(), 1);
    let bees = next(&mut mac1).await;
    assert_eq!(bees.op, "session_start");
    assert_ne!(bees.key, agent_key);
    let opened = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let sessions = hub
                .db
                .with(|c| {
                    let mut stmt = c.prepare(
                        "SELECT data FROM browser_sessions WHERE json_extract(data, '$.control') = 'human'
                           AND json_extract(data, '$.state') = 'live'",
                    )?;
                    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                    Ok(rows.collect::<Result<Vec<_>, _>>()?)
                })
                .unwrap();
            if let Some(s) = sessions.first() {
                return serde_json::from_str::<Value>(s).unwrap();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Bee's screen opens in control");
    assert_eq!(opened["openedBy"]["personId"], bee_id.as_str());
    // The agent's screen ran on throughout; the next agent's start is refused while mac1 is full.
    assert!(
        route(&hub, "th-2", SessionHost::Ios, start())
            .await
            .is_err()
    );
    assert!(mac1.try_recv().is_err(), "nothing ended the agent's screen");
}

#[tokio::test]
async fn a_wait_given_up_holds_no_slot_and_a_persons_idle_screen_ends() {
    let (hub, _home, clock) = setup();
    let mut mac1 = runner(&hub, "mac1");
    report_hosts(&hub, "mac1", &[SessionHost::Browser, SessionHost::Ios]);
    hub.db
        .transaction(|c| {
            super::set_roles(
                c,
                &mid("mac1"),
                &super::Roles {
                    max_sessions: Some(1),
                    ..Default::default()
                },
            )
        })
        .unwrap();
    let (_, ada) = person(&hub, "Ada", "operate");
    let (_, bee) = person(&hub, "Bee", "operate");
    call(&hub, &ada, "screen_open", open("mac1", "browser"))
        .await
        .unwrap();
    next(&mut mac1).await;
    let mut wait = open("mac1", "browser");
    wait["wait"] = json!(true);
    let waiting = call(&hub, &bee, "screen_open", wait).await.unwrap();
    let id = waiting["waiting"]["waitId"].clone();
    // Only its own person gives a wait up.
    let (code, _) = refusal(call(&hub, &ada, "screen_end", json!({ "waitId": id })).await);
    assert_eq!(code, ErrorCode::NotFound);
    call(&hub, &bee, "screen_end", json!({ "waitId": id }))
        .await
        .unwrap();
    let held = hub
        .db
        .with(|c| super::screens::held_on(c, &mid("mac1"), NOW_MS as i64))
        .unwrap();
    assert_eq!(held, 0);

    // Half an hour without Ada's input ends her screen; input keeps it open.
    let since = NOW_MS as i64;
    clock.advance(Duration::from_secs(20 * 60));
    assert_eq!(super::screens::end_idle(&hub, since).await, 0);
    let live = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT session_id FROM browser_sessions WHERE state = 'live'",
                [],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    let live = fleetd_contracts::browser::BrowserSessionId::unchecked(&live);
    hub.link
        .browser_live
        .note_input(&live, crate::hub::store::now_ms(hub.clock.as_ref()));
    clock.advance(Duration::from_secs(20 * 60));
    assert_eq!(super::screens::end_idle(&hub, since).await, 0);
    clock.advance(Duration::from_secs(11 * 60));
    assert_eq!(super::screens::end_idle(&hub, since).await, 1);
    assert_eq!(next(&mut mac1).await.op, "session_end");
}
