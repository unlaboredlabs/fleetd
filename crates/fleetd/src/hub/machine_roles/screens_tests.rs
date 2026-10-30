//! People's own screens (D239), over a real hub and a fake runner node: a person opens one on the machine they pick and
//! has control from its start; only people who may use the project (a Navi: its owner) open one; a Navi's browser is
//! sealed to run on the profile it keeps; a full machine refuses or takes the person in line, ahead of agents, without
//! ending an agent's screen; and an idle one ends. With a PR, its CI build (from a fake `gh`) goes into an iOS or Android
//! screen in steps sealed with the start's relay key before the person gets it; a PR with no build starts nothing.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::{Grant, KeyKind};
use fleetd_contracts::browser::{BrowserCall, BrowserCallResult, DeviceCall, DeviceDone};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::machine_roles::SessionHost;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::node_link::{CAP_BROWSER, CAP_SESSION_HOST, CAP_SESSION_SEAL, HubToNode};
use fleetd_contracts::people::{HubRole, PersonId, PersonName};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::tests::{AT, NOW_MS, hub_at, mid, remote, report_hosts, route, route_once, start};
use crate::hub::api::{CallError, Caller, Hub, registry};
use crate::hub::people::People;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::train::github::{GhOut, GhRunner};
use crate::hub::train::host::BoxFut;
use crate::node::device::remote as device_steps;

/// What the fake runner saw: each hosted call's op, its host key, and for a start what the hub sealed to it.
#[derive(Debug)]
struct Seen {
    op: String,
    key: String,
    seal: Option<Value>,
    /// The Navi the hub's own frame named: the only word a runner takes to open a Navi's profile.
    navi: Option<String>,
    /// What a start said the screen is for.
    purpose: Option<String>,
    /// A device step, opened with the relay key the hub sealed into the screen's start.
    device: Option<DeviceCall>,
}

/// What the fake runner's agent-device says to an install of a file holding this.
const BROKEN: &[u8] = b"not an app";

/// Gives `m` a box key the test holds, and links a fake node for it: it opens what the hub seals to it, starts each
/// screen and reports it live in the project's name (as a runner does, under its host key), hands control to a person
/// when asked, takes device steps sealed with a screen's relay key (an install fails for a file holding [`BROKEN`]), and
/// ends a screen.
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
        // Each screen's key and kind, by its session; each key's relay key and the files put for it.
        let mut screens: HashMap<String, (String, String)> = HashMap::new();
        let mut relays: HashMap<String, [u8; 32]> = HashMap::new();
        let mut files: HashMap<(String, String), Vec<u8>> = HashMap::new();
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
                    let mut device = None;
                    let mut purpose = None;
                    let result = match &host.frame.call {
                        BrowserCall::SessionStart(s) => {
                            // An agent's node's seal is its own (the tests' stand-in opens nowhere); the hub's opens here.
                            let sealed = B64.decode(host.sealed.as_ref().unwrap().as_str()).unwrap();
                            seal = secret
                                .unseal(&sealed)
                                .ok()
                                .map(|plain| serde_json::from_slice::<Value>(&plain).unwrap());
                            purpose = Some(s.purpose.to_string());
                            if let Some(relay) = seal.as_ref().and_then(|s| s["relayKey"].as_str()) {
                                relays.insert(key.clone(), B64.decode(relay).unwrap().try_into().unwrap());
                            }
                            n += 1;
                            let id = format!("B{n:032x}");
                            let kind = s.kind.unwrap_or_default().as_str().to_owned();
                            // A node reports its screen live before it answers the start.
                            let answer = hub.link.answer_lead_call(&m, report(&key, &id, &kind, "live", "agent")).await;
                            assert!(answer.error.is_none(), "{:?}", answer.error);
                            screens.insert(id.clone(), (key.clone(), kind));
                            json!({ "op": "session_start", "sessionId": id, "cdp": "ws://127.0.0.1:1/x", "startMs": 5 })
                        }
                        BrowserCall::Device(DeviceCall::Sealed { count, data_b64 }) => {
                            let relay = relays.get(&key).expect("a screen it started");
                            let call = device_steps::open_call(relay, *count, data_b64).expect("sealed with its relay key");
                            let done = match &call {
                                DeviceCall::Put { name, offset, data_b64 } => {
                                    let file = files.entry((key.clone(), name.clone())).or_default();
                                    assert_eq!(*offset, file.len() as u64, "each piece follows the last");
                                    file.extend(B64.decode(data_b64).unwrap());
                                    DeviceDone::Put { bytes: file.len() as u64 }
                                }
                                DeviceCall::Run { args } => {
                                    let sent = args.get(1).and_then(|a| a.strip_prefix("in/"));
                                    let broken = sent.is_some_and(|name| files.get(&(key.clone(), name.to_owned())).is_some_and(|f| f == BROKEN));
                                    DeviceDone::Run {
                                        stdout: String::new(),
                                        stderr: if broken { "Error: the app is damaged".into() } else { String::new() },
                                        exit_code: i32::from(broken),
                                        files: Vec::new(),
                                    }
                                }
                                other => panic!("an unexpected step: {other:?}"),
                            };
                            device = Some(call);
                            serde_json::to_value(BrowserCallResult::Device(device_steps::seal_done(relay, *count, &done))).unwrap()
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
                    let navi = host.navi.as_ref().map(|n| n.to_string());
                    let _ = seen_tx.send(Seen { op: op.to_owned(), key, seal, navi, purpose, device });
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
    assert!(started.navi.is_none());
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
    // The hub's own frame names the Navi; its seal doesn't, which any node could make.
    assert_eq!(started.navi.as_deref(), Some("ada-navi"));
    assert!(started.seal.unwrap().get("navi").is_none());
    // A project's browser gets no Navi's profile.
    call(&hub, &desk, "screen_open", open("devbox", "browser"))
        .await
        .unwrap();
    assert!(next(&mut devbox).await.navi.is_none());
}

/// An agent's node seals what it likes to the runner the hub names: a seal that names a Navi reaches the runner as it
/// was, and the hub's frame names no Navi, so the runner opens no Navi's profile for an agent.
#[tokio::test]
async fn an_agents_start_never_names_a_navi_whatever_its_node_sealed() {
    let (hub, _home, _clock) = setup();
    let _devbox = remote(&hub);
    let mut mac1 = runner(&hub, "mac1");
    let (ada, _) = person(&hub, "Ada", "operate");
    navi(&hub, "ada-navi", &ada);
    let first = route_once(&hub, "th-1", SessionHost::Ios, start(), None)
        .await
        .unwrap();
    let to = first.seal_to.expect("sealed to mac1 first");
    let public: [u8; 32] = B64.decode(to.as_str()).unwrap().try_into().unwrap();
    let forged = json!({ "secrets": [], "relayKey": B64.encode([1u8; 32]), "navi": "ada-navi" });
    let sealed = crypto_box::PublicKey::from(public)
        .seal(&mut crypto_box::aead::OsRng, forged.to_string().as_bytes())
        .unwrap();
    let routed = route_once(
        &hub,
        "th-1",
        SessionHost::Ios,
        start(),
        Some(json!({ "runner": "mac1", "dataB64": B64.encode(sealed) })),
    )
    .await
    .unwrap();
    assert_eq!(routed.runner, mid("mac1"));
    let seen = next(&mut mac1).await;
    assert_eq!(seen.op, "session_start");
    assert_eq!(
        seen.seal.unwrap()["navi"],
        "ada-navi",
        "the seal went as it was"
    );
    assert!(seen.navi.is_none(), "the hub's frame names no Navi");
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

/// GitHub as the hub's `gh` reads it for PR #12 of acme/app, head `abc1234…`: its CI runs on the head and each one's
/// artifacts, and `gh run download`, which unwraps an artifact into the folder named (the Mobile workflow's files).
struct FakeGh {
    runs: Value,
    artifacts: HashMap<i64, Value>,
    /// What the downloaded build holds.
    build: Vec<u8>,
    calls: std::sync::Mutex<Vec<String>>,
}

impl GhRunner for FakeGh {
    fn run(&self, args: Vec<String>) -> BoxFut<'_, Result<GhOut, String>> {
        self.calls.lock().unwrap().push(args.join(" "));
        let ok = |stdout: Value| {
            Ok(GhOut {
                exit_code: 0,
                stdout: stdout.to_string(),
                stderr: String::new(),
            })
        };
        let out = match args
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .as_slice()
        {
            ["api", "repos/acme/app/pulls/12"] => {
                ok(json!({ "head": { "sha": "abc1234def5678" } }))
            }
            ["api", path]
                if path.starts_with("repos/acme/app/actions/runs?head_sha=abc1234def5678") =>
            {
                ok(self.runs.clone())
            }
            ["api", path] if path.starts_with("repos/acme/app/actions/runs/") => {
                let id: i64 = path["repos/acme/app/actions/runs/".len()..]
                    .split('/')
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap();
                ok(self
                    .artifacts
                    .get(&id)
                    .cloned()
                    .unwrap_or(json!({ "artifacts": [] })))
            }
            [
                "run",
                "download",
                _,
                "-n",
                name,
                "-D",
                dir,
                "-R",
                "acme/app",
            ] => {
                let file = if name.contains("ios") {
                    "fleetd-ios-simulator.zip"
                } else {
                    "app-release.apk"
                };
                std::fs::write(std::path::Path::new(dir).join(file), &self.build).unwrap();
                ok(json!(""))
            }
            _ => Ok(GhOut {
                exit_code: 1,
                stdout: String::new(),
                stderr: "HTTP 404: Not Found".into(),
            }),
        };
        Box::pin(async move { out })
    }
}

/// A fake GitHub whose PR #12 has `runs` (id and status), each with the `artifacts` (name and whether expired) given,
/// and makes it the hub's; acme/app is the app project's repository.
fn github(
    hub: &Hub,
    runs: &[(i64, &str)],
    artifacts: &[(i64, &str, bool)],
    build: &[u8],
) -> Arc<FakeGh> {
    hub.db
        .with(|c| {
            c.execute_batch(
                "INSERT OR IGNORE INTO work_projects VALUES ('devbox', 'app', 'github.com/acme/app', 'main', 1);",
            )?;
            Ok(())
        })
        .unwrap();
    let mut listed: HashMap<i64, Value> = HashMap::new();
    for (run, name, expired) in artifacts {
        listed
            .entry(*run)
            .or_insert_with(|| json!({ "artifacts": [] }))["artifacts"]
            .as_array_mut()
            .unwrap()
            .push(json!({ "name": name, "expired": expired }));
    }
    let gh = Arc::new(FakeGh {
        runs: json!({ "workflow_runs": runs.iter().map(|(id, status)| json!({ "id": id, "status": status })).collect::<Vec<_>>() }),
        artifacts: listed,
        build: build.to_vec(),
        calls: Default::default(),
    });
    hub.builds.set_gh(gh.clone());
    gh
}

fn with_pr(machine: &str, kind: &str) -> Value {
    let mut input = open(machine, kind);
    input["pr"] = json!({ "repo": "acme/app", "number": 12 });
    input
}

/// The device steps the runner saw next, as `put <name> <bytes>` and `run <args>`, until the person's control (the
/// runner sees no more of those) or `n` of them.
async fn steps(seen: &mut mpsc::UnboundedReceiver<Seen>, n: usize) -> Vec<String> {
    let mut out = Vec::new();
    for _ in 0..n {
        let s = next(seen).await;
        out.push(match s.device {
            Some(DeviceCall::Put { name, data_b64, .. }) => {
                format!("put {name} {}", B64.decode(data_b64).unwrap().len())
            }
            Some(DeviceCall::Run { args }) => format!("run {}", args.join(" ")).trim().to_owned(),
            _ => s.op,
        });
    }
    out
}

#[tokio::test]
async fn a_prs_build_goes_into_the_screen_before_the_person_has_it() {
    let (hub, _home, _clock) = setup();
    report_hosts(
        &hub,
        "devbox",
        &[SessionHost::Browser, SessionHost::Android],
    );
    let mut mac1 = runner(&hub, "mac1");
    let mut devbox = runner(&hub, "devbox");
    let (_, desk) = person(&hub, "Ada", "operate");
    // The Mobile workflow's run on the head has both builds; an older run's are expired.
    let app = vec![7u8; 5 << 20];
    let gh = github(
        &hub,
        &[(41, "completed"), (40, "completed")],
        &[
            (40, "fleetd-ios-simulator", true),
            (41, "fleetd-android-apk", false),
            (41, "fleetd-ios-simulator", false),
        ],
        &app,
    );
    let out = call(&hub, &desk, "screen_open", with_pr("mac1", "ios"))
        .await
        .unwrap();
    assert_eq!(out["session"]["control"], "human", "{out}");
    assert!(
        out["next"]
            .as_str()
            .unwrap()
            .starts_with("PR #12's build is installed."),
        "{out}"
    );
    let downloads: Vec<String> = gh
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.starts_with("run download"))
        .cloned()
        .collect();
    assert!(
        downloads[0].starts_with("run download 41 -n fleetd-ios-simulator -D "),
        "{downloads:?}"
    );
    let started = next(&mut mac1).await;
    assert_eq!(started.op, "session_start");
    assert_eq!(
        started.purpose.as_deref(),
        Some("iOS simulator opened by Ada, with PR #12")
    );
    // A bare agent-device waits out the simulator's runner; the build goes in 4 MiB pieces, sealed, then installs.
    assert_eq!(
        steps(&mut mac1, 4).await,
        [
            "run",
            "put pr-12.zip 4194304",
            "put pr-12.zip 1048576",
            "run install in/pr-12.zip"
        ]
    );

    // Android: the .apk, and no runner to wait for.
    let out = call(&hub, &desk, "screen_open", with_pr("devbox", "android"))
        .await
        .unwrap();
    assert_eq!(out["session"]["kind"], "android", "{out}");
    assert_eq!(out["session"]["control"], "human");
    assert_eq!(next(&mut devbox).await.op, "session_start");
    assert_eq!(
        steps(&mut devbox, 3).await,
        [
            "put pr-12.apk 4194304",
            "put pr-12.apk 1048576",
            "run install in/pr-12.apk"
        ]
    );
}

#[tokio::test]
async fn a_pr_with_no_build_is_refused_plainly_and_starts_nothing() {
    let (hub, _home, _clock) = setup();
    let mut mac1 = runner(&hub, "mac1");
    let (_, desk) = person(&hub, "Ada", "operate");
    let refused = |hub: &Arc<Hub>, input: Value| {
        let (hub, desk) = (hub.clone(), desk.clone());
        async move { refusal(call(&hub, &desk, "screen_open", input).await) }
    };
    // CI still running on the head.
    github(&hub, &[(41, "in_progress")], &[], b"app");
    let (code, message) = refused(&hub, with_pr("mac1", "ios")).await;
    assert_eq!(code, ErrorCode::Failed);
    assert!(
        message.contains("CI is still running on its head (abc1234)"),
        "{message}"
    );
    // Its build expired.
    github(
        &hub,
        &[(41, "completed")],
        &[(41, "fleetd-ios-simulator", true)],
        b"app",
    );
    let (_, message) = refused(&hub, with_pr("mac1", "ios")).await;
    assert!(
        message.contains("iOS simulator build has expired"),
        "{message}"
    );
    // No run uploaded one: an Android build is no iOS build.
    github(
        &hub,
        &[(41, "completed")],
        &[(41, "fleetd-android-apk", false)],
        b"app",
    );
    let (_, message) = refused(&hub, with_pr("mac1", "ios")).await;
    assert!(message.contains("has no iOS simulator build"), "{message}");
    // Only a PR of the project's own repositories, and only into a phone screen.
    let mut elsewhere = with_pr("mac1", "ios");
    elsewhere["pr"]["repo"] = json!("stranger/app");
    let (code, message) = refused(&hub, elsewhere).await;
    assert_eq!(code, ErrorCode::Invalid);
    assert!(
        message.contains("isn't a repository of this project"),
        "{message}"
    );
    let (code, _) = refused(&hub, with_pr("mac1", "browser")).await;
    assert_eq!(code, ErrorCode::Invalid);
    // Nothing started, nothing waits, no slot taken.
    assert!(mac1.try_recv().is_err());
    assert_eq!(live_on(&hub, "mac1"), 0);
}

#[tokio::test]
async fn a_build_that_doesnt_install_closes_its_screen() {
    let (hub, _home, _clock) = setup();
    let mut mac1 = runner(&hub, "mac1");
    let (_, desk) = person(&hub, "Ada", "operate");
    github(
        &hub,
        &[(41, "completed")],
        &[(41, "fleetd-ios-simulator", false)],
        BROKEN,
    );
    let (code, message) = refusal(call(&hub, &desk, "screen_open", with_pr("mac1", "ios")).await);
    assert_eq!(code, ErrorCode::Failed);
    assert!(
        message.contains(
            "PR #12's build didn't install, so the screen was closed: Error: the app is damaged"
        ),
        "{message}"
    );
    assert_eq!(next(&mut mac1).await.op, "session_start");
    assert_eq!(
        steps(&mut mac1, 3).await,
        ["run", "put pr-12.zip 10", "run install in/pr-12.zip"]
    );
    assert_eq!(next(&mut mac1).await.op, "session_end");
    assert_eq!(live_on(&hub, "mac1"), 0);
}

#[tokio::test]
async fn a_wait_with_a_pr_gets_its_build_when_its_slot_frees() {
    let (hub, _home, _clock) = setup();
    let mut mac1 = runner(&hub, "mac1");
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
    github(
        &hub,
        &[(41, "completed")],
        &[(41, "fleetd-ios-simulator", false)],
        b"an app",
    );
    let first = call(&hub, &ada, "screen_open", open("mac1", "ios"))
        .await
        .unwrap();
    next(&mut mac1).await;
    let mut wait = with_pr("mac1", "ios");
    wait["wait"] = json!(true);
    let waiting = call(&hub, &bee, "screen_open", wait).await.unwrap();
    assert_eq!(
        waiting["waiting"]["pr"],
        json!({ "repo": "acme/app", "number": 12 }),
        "{waiting}"
    );
    call(
        &hub,
        &ada,
        "screen_end",
        json!({ "sessionId": first["session"]["sessionId"] }),
    )
    .await
    .unwrap();
    assert_eq!(next(&mut mac1).await.op, "session_end");
    assert_eq!(super::screens::serve_waits(&hub).unwrap(), 1);
    assert_eq!(next(&mut mac1).await.op, "session_start");
    assert_eq!(
        steps(&mut mac1, 3).await,
        ["run", "put pr-12.zip 6", "run install in/pr-12.zip"]
    );
}
