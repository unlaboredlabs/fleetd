use std::sync::Arc;

use fleetd_contracts::browser::BrowserSessionState;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::machine_roles::{HostCheck, SessionHost, SessionRouteResult};
use fleetd_contracts::mcp::McpToolError;
use fleetd_contracts::node_link::{CAP_SESSION_HOST, CAP_SESSION_SEAL, HubToNode};
use fleetd_contracts::prim::{Line, List};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{Runner, place};
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

pub(super) const AT: &str = "2026-10-26T10:00:00.000Z";
pub(super) const NOW_MS: u64 = 1_792_000_000_000;
const SESSION: &str = "B0123456789abcdef0123456789abcdef";
/// Each machine's box key, as its hello gave it.
const BOX_KEY: &str = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
/// What the agent's node sealed to the runner: the hub relays it as it is.
const SEALED: &str = "c2VhbGVkIGZvciBtYWMx";

pub(super) fn mid(m: &str) -> MachineId {
    MachineId::unchecked(m)
}

pub(super) fn app() -> ProjectRef {
    ProjectRef {
        machine_id: mid("devbox"),
        project_id: ProjectId::unchecked("app"),
    }
}

/// A hub with devbox (Linux: Chrome and docker) and mac1 (macOS: Chrome and iOS simulators) online, both on a node
/// that hosts others' sessions, and project app on devbox.
fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    hub_at(ManualClock::at(NOW_MS))
}

/// [`hub`] on `clock`.
pub(super) fn hub_at(
    clock: Arc<crate::hub::store::test_clock::ManualClock>,
) -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let hub = crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock).unwrap();
    for m in ["devbox", "mac1"] {
        let machine = serde_json::from_value(json!({
            "machineId": m, "name": m, "tags": [], "status": "online", "lastSeenAt": AT, "nodeVersion": "0.1.0",
            "boxPubKey": BOX_KEY,
        }))
        .unwrap();
        hub.store.machine_upsert(&machine, None).unwrap();
        hub.link
            .set_capabilities(&mid(m), &[CAP_SESSION_HOST, CAP_SESSION_SEAL]);
    }
    hub.store
        .projects_upsert_many(
            &mid("devbox"),
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "app", "title": "app", "workspaceRoot": "/work/app",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    report_hosts(
        &hub,
        "devbox",
        &[SessionHost::Browser, SessionHost::Desktop],
    );
    report_hosts(&hub, "mac1", &[SessionHost::Browser, SessionHost::Ios]);
    (hub, home)
}

/// The machine's heartbeat, 32 CPUs and 64 GB, able to host `ready` and nothing else.
pub(super) fn report_hosts(hub: &Hub, m: &str, ready: &[SessionHost]) {
    let mut load = crate::hub::link::guard::tests::load(500, 1.0);
    load.mem_total_bytes = Some(fleetd_contracts::prim::Count::unchecked(64 << 30));
    load.hosts = Some(List::unchecked(
        SessionHost::ALL
            .into_iter()
            .map(|host| HostCheck {
                host,
                ready: ready.contains(&host),
                detail: Line::unchecked("as tested"),
            })
            .collect(),
    ));
    hub.link.observe_load(&mid(m), Some(load), AT);
}

pub(super) fn admin() -> Caller {
    serde_json::from_value(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "admin", "machines": "*" }],
    }))
    .unwrap()
}

async fn tool(hub: &Arc<Hub>, name: &str, input: Value) -> Result<Value, CallError> {
    crate::hub::api::registry()
        .call(hub, &admin(), name, input)
        .await
}

pub(super) fn task_caller() -> LeadCaller {
    LeadCaller {
        project_ref: app(),
        by: crate::hub::link::lead_calls::lead_by(&app()),
        agent: CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T7")),
    }
}

/// Task T7's node hands the hub one of its agent's session calls, for session `thread`.
pub(super) async fn route(
    hub: &Hub,
    thread: &str,
    host: SessionHost,
    call: Value,
) -> Result<SessionRouteResult, McpToolError> {
    let first = route_once(hub, thread, host, call.clone(), None).await?;
    match &first.seal_to {
        // As the agent's node does: seal to the runner the hub named, and start again.
        Some(key) => {
            let runner = hub.store.machine_get(&first.runner).unwrap().unwrap();
            assert_eq!(Some(key), runner.box_pub_key.as_ref());
            assert!(first.answer.is_none(), "nothing starts before the seal");
            let sealed = json!({ "runner": first.runner, "dataB64": SEALED });
            route_once(hub, thread, host, call, Some(sealed)).await
        }
        None => Ok(first),
    }
}

pub(super) async fn route_once(
    hub: &Hub,
    thread: &str,
    host: SessionHost,
    call: Value,
    sealed: Option<Value>,
) -> Result<SessionRouteResult, McpToolError> {
    let mut call = json!({
        "op": "session_route", "host": host,
        "frame": { "id": "1", "cwd": "/work/app", "call": call, "threadId": thread },
    });
    if let Some(sealed) = sealed {
        call["sealed"] = sealed;
    }
    let call: LeadCall = serde_json::from_value(call).unwrap();
    let handler = hub.lead_calls.handler("session_route").unwrap();
    match handler.handle(task_caller(), call).await? {
        LeadCallResult::SessionRoute(out) => Ok(out),
        other => panic!("not a route: {other:?}"),
    }
}

pub(super) fn start() -> Value {
    json!({ "op": "session_start", "purpose": "Check the signup form" })
}

/// A live browser session of T7's agent session `thread` on devbox, as devbox's node reports it.
async fn live_on_devbox(hub: &Hub, thread: &str, id: &str) {
    let call: LeadCall = serde_json::from_value(json!({
        "op": "browser_session", "sessionId": id, "threadId": thread, "purpose": "Check the signup form",
        "state": "live", "startedAt": crate::hub::store::iso_ms(NOW_MS as i64),
    }))
    .unwrap();
    let handler = hub.lead_calls.handler("browser_session").unwrap();
    handler.handle(task_caller(), call).await.unwrap();
}

/// Placing sessions on other machines turned on, and devbox's node linked to hear of them.
pub(super) fn remote(hub: &Arc<Hub>) -> crate::hub::link::commands::AttachedLink {
    hub.db.transaction(|c| super::set_remote(c, true)).unwrap();
    let (tx, rx) = mpsc::unbounded_channel::<HubToNode>();
    std::mem::forget(rx);
    hub.node_commands.attach(&mid("devbox"), tx)
}

/// mac1's node: answers each hosted call it gets with `answer(call)`, and says which key it hosted under.
fn mac1_node(
    hub: &Arc<Hub>,
) -> (
    crate::hub::link::commands::AttachedLink,
    mpsc::UnboundedReceiver<(String, String)>,
) {
    let (tx, mut rx) = mpsc::unbounded_channel::<HubToNode>();
    let link = hub.node_commands.attach(&mid("mac1"), tx);
    let (seen_tx, seen) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        // The first session it starts is SESSION, each after it a new one.
        let mut started = 0u32;
        while let Some(frame) = rx.recv().await {
            let HubToNode::SessionHost(host) = frame else {
                continue;
            };
            let op = host.frame.call.op();
            if op == "session_start" {
                // What the agent's node sealed reaches the runner as it was: the hub never opens it.
                assert_eq!(host.sealed.as_ref().map(|s| s.as_str()), Some(SEALED));
            }
            let result = match op {
                "session_start" => {
                    let id = match started {
                        0 => SESSION.to_owned(),
                        n => format!("B{n:032x}"),
                    };
                    started += 1;
                    json!({ "op": "session_start", "sessionId": id, "cdp": "ws://127.0.0.1:1/x", "startMs": 5 })
                }
                "device" => json!({ "op": "device", "step": "sealed", "dataB64": "c2VhbGVk" }),
                _ => json!({ "op": "session_end", "sessionId": SESSION, "files": [] }),
            };
            let _ = seen_tx.send((host.host_key.to_string(), op.to_owned()));
            let reply = serde_json::from_value(json!({
                "t": "session_host_result", "id": host.id,
                "frame": { "id": host.frame.id, "result": result },
            }))
            .unwrap();
            hub.node_commands.resolve(&mid("mac1"), reply);
        }
    });
    (link, seen)
}

#[tokio::test]
async fn a_session_runs_on_its_agents_machine_when_it_can_host_it() {
    let (hub, _home) = hub();
    let routed = route(&hub, "th-1", SessionHost::Browser, start())
        .await
        .unwrap();
    assert!(routed.here);
    assert_eq!(routed.runner, mid("devbox"));
    // A call for a session the hub didn't place elsewhere is the agent's own node's.
    let end = route(
        &hub,
        "th-1",
        SessionHost::Browser,
        json!({ "op": "session_end" }),
    )
    .await
    .unwrap();
    assert!(end.here);
}

#[tokio::test]
async fn a_session_its_machine_cannot_host_goes_to_one_that_can_and_its_calls_follow() {
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    let (_link, mut seen) = mac1_node(&hub);
    let routed = route(&hub, "th-1", SessionHost::Ios, start())
        .await
        .unwrap();
    assert!(!routed.here);
    assert_eq!(routed.runner, mid("mac1"));
    let answer = routed.answer.unwrap();
    assert!(answer.error.is_none(), "{answer:?}");
    // The agent's node gets the session's relay token; the hub keeps only its hash.
    let token = routed.relay.expect("a relay token").to_string();
    let stored: Option<String> = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT relay_hash FROM session_places WHERE hosted = 1",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(stored, Some(super::relay::hash(&token)));
    assert_ne!(stored.as_deref(), Some(token.as_str()));
    let (key, op) = seen.recv().await.unwrap();
    assert_eq!(op, "session_start");
    assert!(key.starts_with('H'), "{key}");

    // The runner reports the session it hosts in the agent's name.
    let hosted = hub
        .lead_calls
        .hosted(
            &mid("mac1"),
            &fleetd_contracts::ids::ThreadId::unchecked(&key),
        )
        .unwrap();
    assert_eq!(hosted.project_ref, app());
    assert_eq!(hosted.thread_id.as_str(), "th-1");
    assert!(matches!(hosted.agent, CallerAgent::Task(ref t) if t.as_str() == "T7"));
    assert!(
        hub.lead_calls
            .hosted(
                &mid("devbox"),
                &fleetd_contracts::ids::ThreadId::unchecked(&key)
            )
            .is_none(),
        "only the runner it was given to speaks for it"
    );
    let entry = tool(&hub, "machine_roles", json!({})).await.unwrap();
    let mac1 = entry["machines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["machineId"] == "mac1")
        .unwrap()
        .clone();
    assert_eq!(mac1["sessionsLive"], 1);

    // A second start while it is open is refused; its end goes to mac1 and frees the slot.
    let again = route(&hub, "th-1", SessionHost::Ios, start())
        .await
        .unwrap_err();
    assert!(
        again.message.contains("is open on mac1"),
        "{}",
        again.message
    );
    let end = route(
        &hub,
        "th-1",
        SessionHost::Ios,
        json!({ "op": "session_end" }),
    )
    .await
    .unwrap();
    assert!(!end.here);
    assert_eq!(seen.recv().await.unwrap(), (key, "session_end".to_owned()));
    let live = hub
        .db
        .with(|c| super::live_on(c, &mid("mac1"), NOW_MS as i64))
        .unwrap();
    assert_eq!(live, 0);
}

/// An agent's agent-device steps go to its own iOS screen's runner, as they came; another agent session's go nowhere,
/// whatever they say: the hub knows a screen by the session that started it.
#[tokio::test]
async fn an_agents_device_steps_reach_its_own_screen_and_no_one_elses() {
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    let (_link, mut seen) = mac1_node(&hub);
    let routed = route(&hub, "th-1", SessionHost::Ios, start())
        .await
        .unwrap();
    assert_eq!(routed.runner, mid("mac1"));
    let (key, _) = seen.recv().await.unwrap();
    let step = json!({ "op": "device", "step": "sealed", "count": 1, "dataB64": "b3BhcXVl" });
    let own = route(&hub, "th-1", SessionHost::Browser, step.clone())
        .await
        .unwrap();
    assert!(!own.here);
    assert_eq!(
        own.answer.unwrap().result,
        Some(
            serde_json::from_value(
                json!({ "op": "device", "step": "sealed", "dataB64": "c2VhbGVk" })
            )
            .unwrap()
        )
    );
    assert_eq!(seen.recv().await.unwrap(), (key, "device".to_owned()));
    let other = route(&hub, "th-2", SessionHost::Browser, step)
        .await
        .unwrap();
    assert!(
        other.here,
        "not placed anywhere for th-2: its own node's to refuse"
    );
    assert!(seen.try_recv().is_err(), "nothing reached mac1 for th-2");
}

/// The next frame a node's link gets from the hub.
pub(super) async fn heard(link: &mut mpsc::UnboundedReceiver<HubToNode>) -> HubToNode {
    tokio::time::timeout(std::time::Duration::from_secs(5), link.recv())
        .await
        .expect("the node hears of it")
        .unwrap()
}

/// A person watching an iOS screen mac1 hosts for an agent on devbox: the watch goes to mac1 (the session's row names
/// devbox), mac1's frames reach the watcher, and a takeover and its taps go to mac1 too.
#[tokio::test]
async fn a_hosted_screen_shows_live_from_its_runner_and_takes_a_persons_taps() {
    use fleetd_contracts::browser::{BrowserControl, BrowserSessionId};
    use fleetd_contracts::node_link::CAP_BROWSER;
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    let (_link, mut seen) = mac1_node(&hub);
    route(&hub, "th-1", SessionHost::Ios, start())
        .await
        .unwrap();
    let (key, _) = seen.recv().await.unwrap();
    let caps = [CAP_SESSION_HOST, CAP_SESSION_SEAL, CAP_BROWSER];
    let mut mac1 = hub.link.test_link(&mid("mac1"), &caps);
    let mut devbox = hub.link.test_link(&mid("devbox"), &caps);
    // mac1 reports the screen in the agent's name, as its node does.
    let report = |control: &str| -> fleetd_contracts::lead_calls::LeadCallFrame {
        serde_json::from_value(json!({
            "id": "browser", "cwd": "/work/app", "threadId": key,
            "call": {
                "op": "browser_session", "sessionId": SESSION, "kind": "ios", "threadId": key,
                "purpose": "Check the signup form", "state": "live", "control": control,
                "startedAt": crate::hub::store::iso_ms(NOW_MS as i64),
            },
        }))
        .unwrap()
    };
    let answer = hub
        .link
        .answer_lead_call(&mid("mac1"), report("agent"))
        .await;
    assert!(answer.error.is_none(), "{:?}", answer.error);
    let id = BrowserSessionId::unchecked(SESSION);
    let stored = crate::hub::browser::get(&hub.db, &id).unwrap().unwrap();
    assert_eq!(stored.project_ref.machine_id, mid("devbox"));

    let person = Caller {
        kind: Some(fleetd_contracts::auth::KeyKind::Human),
        ..admin()
    };
    let mut watch = crate::hub::browser::live::start_watch(&hub, &person, &id).unwrap();
    match heard(&mut mac1).await {
        HubToNode::BrowserWatch(w) => assert!(w.on && w.session_id == id),
        other => panic!("not a watch: {other:?}"),
    }
    // Only mac1's frames are this screen's.
    let frame = |seq: u64| {
        serde_json::from_value(json!({
            "sessionId": SESSION, "seq": seq, "jpegB64": "AA==", "width": 4, "height": 3, "control": "agent",
        }))
        .unwrap()
    };
    hub.link.browser_frame(&mid("devbox"), frame(1));
    hub.link.browser_frame(&mid("mac1"), frame(2));
    assert_eq!(watch.frames.recv().await.unwrap().seq, 2);
    assert!(watch.frames.try_recv().is_err());

    // A takeover goes to mac1, which says a person has control; then their tap goes there.
    let registry = crate::hub::api::registry();
    let take = registry.call(
        &hub,
        &person,
        "browser_control",
        json!({ "sessionId": SESSION, "control": "human" }),
    );
    let node = async {
        match heard(&mut mac1).await {
            HubToNode::BrowserControl(c) => assert_eq!(c.session_id, id),
            other => panic!("not a takeover: {other:?}"),
        }
        let answer = hub
            .link
            .answer_lead_call(&mid("mac1"), report("human"))
            .await;
        assert!(answer.error.is_none(), "{:?}", answer.error);
    };
    let (taken, ()) = tokio::join!(take, node);
    assert_eq!(taken.unwrap()["session"]["control"], "human");
    let tap = serde_json::from_value(
        json!({ "kind": "mouse", "action": "pressed", "x": 10.0, "y": 20.0, "button": "left" }),
    )
    .unwrap();
    crate::hub::browser::live::input(&hub, &person, &id, tap).unwrap();
    match heard(&mut mac1).await {
        HubToNode::BrowserInput(i) => assert_eq!(i.session_id, id),
        other => panic!("not input: {other:?}"),
    }
    assert_eq!(
        crate::hub::browser::get(&hub.db, &id)
            .unwrap()
            .unwrap()
            .control,
        BrowserControl::Human
    );
    drop(watch);
    match heard(&mut mac1).await {
        HubToNode::BrowserWatch(w) => assert!(!w.on),
        other => panic!("not the watch's end: {other:?}"),
    }
    assert!(devbox.try_recv().is_err(), "nothing went to devbox");
}

#[tokio::test]
async fn a_machine_without_the_sessions_role_sends_its_sessions_elsewhere() {
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    let (_link, _seen) = mac1_node(&hub);
    let set = tool(
        &hub,
        "machine_roles_set",
        json!({ "machineId": "devbox", "roles": ["agents"] }),
    )
    .await
    .unwrap();
    assert_eq!(set["machine"]["roles"], json!(["agents"]));
    let routed = route(&hub, "th-1", SessionHost::Browser, start())
        .await
        .unwrap();
    assert_eq!(routed.runner, mid("mac1"));
    assert!(!routed.here);
}

#[tokio::test]
async fn no_machine_that_can_host_it_is_a_plain_refusal() {
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    let refused = route(&hub, "th-1", SessionHost::Android, start())
        .await
        .unwrap_err();
    assert_eq!(
        refused.message,
        "No machine can host an Android emulator session: none has the sessions role and an Android emulator ready."
    );
    assert!(refused.fix.unwrap().contains("Settings › Hub › Machines"));
    let rows: i64 = hub
        .db
        .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_places", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 0, "a refused start holds no slot");

    // One that could, offline, is named.
    report_hosts(&hub, "mac1", &[SessionHost::Android]);
    hub.store
        .machine_set_status(
            &mid("mac1"),
            fleetd_contracts::model::MachineStatus::Offline,
            &fleetd_contracts::ids::Timestamp(AT.into()),
        )
        .unwrap();
    let offline = route(&hub, "th-1", SessionHost::Android, start())
        .await
        .unwrap_err();
    assert_eq!(
        offline.message,
        "No machine online can host an Android emulator session: mac1 can, but is offline."
    );
}

#[tokio::test]
async fn session_caps_are_respected_on_every_machine() {
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    let (_link, _seen) = mac1_node(&hub);
    for m in ["devbox", "mac1"] {
        tool(
            &hub,
            "machine_roles_set",
            json!({ "machineId": m, "maxSessions": 1 }),
        )
        .await
        .unwrap();
    }
    // devbox's one slot: a start placed there holds it until its session reports, and then the session does.
    assert!(
        route(&hub, "th-1", SessionHost::Browser, start())
            .await
            .unwrap()
            .here
    );
    live_on_devbox(&hub, "th-1", "Bfedcba9876543210fedcba9876543210").await;
    let live = hub
        .db
        .with(|c| super::live_on(c, &mid("devbox"), NOW_MS as i64))
        .unwrap();
    assert_eq!(live, 1, "the start and its session are one");

    // The next goes to mac1, the one after finds both full.
    let second = route(&hub, "th-2", SessionHost::Browser, start())
        .await
        .unwrap();
    assert_eq!(second.runner, mid("mac1"));
    let third = route(&hub, "th-3", SessionHost::Browser, start())
        .await
        .unwrap_err();
    assert_eq!(
        third.message,
        "Every machine that can host a browser session is full: devbox 1 of 1, mac1 1 of 1."
    );

    // Back to auto: 32 CPUs and 64 GB fit 16, fewer than devbox's agent slots and its lead, which it keeps room for.
    let agents = hub.slots.machine_cap(&mid("devbox")) + 1;
    assert!(agents > 16);
    let auto = tool(
        &hub,
        "machine_roles_set",
        json!({ "machineId": "devbox", "autoSessions": true }),
    )
    .await
    .unwrap();
    assert_eq!(auto["machine"]["maxSessions"], agents);
    assert_eq!(
        auto["machine"]["maxSessionsWhy"],
        format!("auto: one for each agent and lead it runs ({agents})")
    );
    assert!(
        route(&hub, "th-3", SessionHost::Browser, start())
            .await
            .unwrap()
            .here
    );
}

#[tokio::test]
async fn a_machine_without_the_agents_role_runs_none() {
    let (hub, _home) = hub();
    let before = hub.slots.machine_cap(&mid("devbox"));
    assert!(before > 0);
    let set = tool(
        &hub,
        "machine_roles_set",
        json!({ "machineId": "devbox", "roles": ["sessions"] }),
    )
    .await
    .unwrap();
    assert!(
        set["next"]
            .as_str()
            .unwrap()
            .contains("takes no new agents")
    );
    assert_eq!(hub.slots.machine_cap(&mid("devbox")), 0);
    tool(
        &hub,
        "machine_roles_set",
        json!({ "machineId": "devbox", "roles": ["agents", "sessions"] }),
    )
    .await
    .unwrap();
    assert_eq!(hub.slots.machine_cap(&mid("devbox")), before);
}

#[tokio::test]
async fn roles_need_an_admin_and_a_known_machine() {
    let (hub, _home) = hub();
    let reader: Caller = serde_json::from_value(json!({
        "keyId": "k2", "name": "desk", "prefix": "fld_abcdeg", "createdAt": AT,
        "grants": [{ "role": "read", "machines": "*" }],
    }))
    .unwrap();
    let refused = crate::hub::api::registry()
        .call(
            &hub,
            &reader,
            "machine_roles_set",
            json!({ "machineId": "devbox", "roles": ["agents"] }),
        )
        .await;
    assert!(refused.is_err());
    assert!(
        tool(
            &hub,
            "machine_roles_set",
            json!({ "machineId": "nowhere", "roles": ["agents"] })
        )
        .await
        .is_err()
    );
    assert!(
        tool(&hub, "machine_roles_set", json!({ "machineId": "devbox" }))
            .await
            .is_err(),
        "nothing to set"
    );
    let listed = tool(&hub, "machine_roles", json!({})).await.unwrap();
    let devbox = &listed["machines"][0];
    assert_eq!(devbox["machineId"], "devbox");
    assert_eq!(devbox["roles"], json!(["agents", "sessions"]));
    assert_eq!(devbox["hosts"].as_array().unwrap().len(), 4);
    assert_eq!(devbox["hostsOthers"], true);
}

fn runner(m: &str, sessions: bool, ready: bool, live: i64, max: i64) -> Runner {
    Runner {
        machine_id: mid(m),
        name: m.to_owned(),
        online: true,
        sessions,
        hosts: Some(List::unchecked(vec![HostCheck {
            host: SessionHost::Browser,
            ready,
            detail: Line::unchecked("as tested"),
        }])),
        hosts_others: true,
        others_note: None,
        live,
        max,
        held: 0,
    }
}

#[test]
fn placement_prefers_the_agents_machine_then_the_most_free_slots() {
    let own = runner("devbox", true, true, 0, 2);
    let a = runner("lab-a", true, true, 1, 4);
    let b = runner("lab-b", true, true, 0, 4);
    let all = [own.clone(), a.clone(), b.clone()];
    assert_eq!(
        place(&mid("devbox"), SessionHost::Browser, &all, true).unwrap(),
        mid("devbox")
    );
    let full_own = runner("devbox", true, true, 2, 2);
    let all = [full_own, a.clone(), b.clone()];
    assert_eq!(
        place(&mid("devbox"), SessionHost::Browser, &all, true).unwrap(),
        mid("lab-b")
    );
    // An older node, which hosts nobody else's, and one that can't run Chrome, are passed over.
    let older = Runner {
        hosts_others: false,
        others_note: Some("Its fleetd is older.".into()),
        ..runner("lab-c", true, true, 0, 8)
    };
    let no_chrome = runner("lab-d", true, false, 0, 8);
    let all = [runner("devbox", false, true, 0, 2), older, no_chrome, a];
    assert_eq!(
        place(&mid("devbox"), SessionHost::Browser, &all, true).unwrap(),
        mid("lab-a")
    );
    // Its own node that reports nothing yet still runs a browser, as before roles.
    let silent = Runner {
        hosts: None,
        ..runner("devbox", true, false, 0, 2)
    };
    assert_eq!(
        place(&mid("devbox"), SessionHost::Browser, &[silent], true).unwrap(),
        mid("devbox")
    );
    // A slot a person waits for isn't an agent's: a machine whose free slots people wait for is full to agents.
    let held = Runner {
        held: 2,
        ..runner("lab-b", true, true, 2, 4)
    };
    let refused = place(
        &mid("devbox"),
        SessionHost::Browser,
        &[full_own_again(), held],
        true,
    )
    .unwrap_err();
    assert!(
        refused
            .message
            .contains("lab-b 2 of 4, 2 people waiting for a slot"),
        "{}",
        refused.message
    );
}

fn full_own_again() -> Runner {
    runner("devbox", true, true, 2, 2)
}

#[tokio::test]
async fn a_hosted_session_its_runner_ended_or_lost_no_longer_blocks_the_next() {
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    let (link, mut seen) = mac1_node(&hub);
    route(&hub, "th-1", SessionHost::Ios, start())
        .await
        .unwrap();
    let (key, _) = seen.recv().await.unwrap();

    // mac1 ended it as idle and reports it uploading, which the hub files in the agent's name.
    let hosted = hub
        .lead_calls
        .hosted(
            &mid("mac1"),
            &fleetd_contracts::ids::ThreadId::unchecked(&key),
        )
        .unwrap();
    let call: LeadCall = serde_json::from_value(json!({
        "op": "browser_session", "sessionId": SESSION, "threadId": "th-1", "purpose": "Check the signup form",
        "state": "uploading", "startedAt": crate::hub::store::iso_ms(NOW_MS as i64),
    }))
    .unwrap();
    let caller = LeadCaller {
        by: crate::hub::link::lead_calls::lead_by(&hosted.project_ref),
        project_ref: hosted.project_ref,
        agent: hosted.agent,
    };
    hub.lead_calls
        .handler("browser_session")
        .unwrap()
        .handle(caller, call)
        .await
        .unwrap();
    let again = route(&hub, "th-1", SessionHost::Ios, start())
        .await
        .unwrap();
    assert_eq!(
        again.runner,
        mid("mac1"),
        "a new session, not the ended one"
    );

    // mac1 drops off with that one open: ending it says so, and frees the agent to start another.
    drop(link);
    let end = route(
        &hub,
        "th-1",
        SessionHost::Ios,
        json!({ "op": "session_end" }),
    )
    .await
    .unwrap_err();
    assert!(end.message.contains("did not answer"), "{}", end.message);
    let open = hub
        .db
        .with(|c| {
            super::open_hosted(
                c,
                &mid("devbox"),
                &fleetd_contracts::ids::ThreadId::unchecked("th-1"),
                NOW_MS as i64,
            )
        })
        .unwrap();
    assert!(open.is_none());
}

#[tokio::test]
async fn the_runner_reports_a_hosted_session_in_the_agents_name_and_no_one_else_can() {
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    let (_link, mut seen) = mac1_node(&hub);
    route(&hub, "th-1", SessionHost::Ios, start())
        .await
        .unwrap();
    let (key, _) = seen.recv().await.unwrap();
    let report = |cwd: &str| -> fleetd_contracts::lead_calls::LeadCallFrame {
        serde_json::from_value(json!({
            "id": "browser", "cwd": cwd, "threadId": key,
            "call": {
                "op": "browser_session", "sessionId": SESSION, "threadId": key, "purpose": "Check the signup form",
                "state": "live", "startedAt": crate::hub::store::iso_ms(NOW_MS as i64),
            },
        }))
        .unwrap()
    };
    // The runner's cwd is the agent's, on another machine: the key alone says whose it is.
    let answer = hub
        .link
        .answer_lead_call(&mid("mac1"), report("/work/app"))
        .await;
    assert!(answer.error.is_none(), "{:?}", answer.error);
    let stored = crate::hub::browser::get(
        &hub.db,
        &fleetd_contracts::browser::BrowserSessionId::unchecked(SESSION),
    )
    .unwrap()
    .unwrap();
    assert_eq!(stored.project_ref, app());
    assert_eq!(stored.thread_id.as_str(), "th-1");
    assert_eq!(stored.task_id.unwrap().as_str(), "T7");
    // The same key from another machine is nobody's.
    let refused = hub
        .link
        .answer_lead_call(&mid("devbox"), report("/work/app"))
        .await;
    assert!(refused.error.is_some());
}

#[tokio::test]
async fn with_remote_placement_off_a_session_runs_only_on_its_agents_machine() {
    let (hub, _home) = hub();
    assert!(hub.db.with(super::remote_on).unwrap(), "on by default");
    hub.db.transaction(|c| super::set_remote(c, false)).unwrap();
    let (_link, _seen) = mac1_node(&hub);
    // mac1 could host an iOS simulator, but sessions stay on their agent's machine: a plain refusal instead.
    let ios = route(&hub, "th-1", SessionHost::Ios, start())
        .await
        .unwrap_err();
    assert_eq!(
        ios.message,
        "devbox can't host an iOS simulator session: as tested."
    );
    // Full: refused, not sent elsewhere.
    tool(
        &hub,
        "machine_roles_set",
        json!({ "machineId": "devbox", "maxSessions": 1 }),
    )
    .await
    .unwrap();
    assert!(
        route(&hub, "th-1", SessionHost::Browser, start())
            .await
            .unwrap()
            .here
    );
    let full = route(&hub, "th-2", SessionHost::Browser, start())
        .await
        .unwrap_err();
    assert_eq!(full.message, "devbox's session slots are full: 1 of 1.");
    assert!(full.fix.unwrap().contains("Settings › Hub › Machines"));
    // Agents only: refused, with the way to change it.
    tool(
        &hub,
        "machine_roles_set",
        json!({ "machineId": "devbox", "roles": ["agents"] }),
    )
    .await
    .unwrap();
    let agents_only = route(&hub, "th-3", SessionHost::Browser, start())
        .await
        .unwrap_err();
    assert_eq!(
        agents_only.message,
        "devbox hosts no sessions: its role is agents only, and a session runs on its agent's own machine."
    );
    assert!(
        agents_only
            .fix
            .unwrap()
            .contains("fleetd machine set devbox --roles agents,sessions")
    );
}

#[tokio::test(start_paused = true)]
async fn a_remote_start_with_no_answer_is_cancelled_and_holds_no_slot() {
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    // mac1's node takes the start and never answers it; it answers the cancel.
    let (tx, mut rx) = mpsc::unbounded_channel::<HubToNode>();
    let _mac1 = hub.node_commands.attach(&mid("mac1"), tx);
    let (ends_tx, mut ends) = mpsc::unbounded_channel::<String>();
    {
        let hub = hub.clone();
        tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                let HubToNode::SessionHost(host) = frame else {
                    continue;
                };
                if host.frame.call.op() != "session_end" {
                    continue;
                }
                let _ = ends_tx.send(host.host_key.to_string());
                let reply = serde_json::from_value(json!({
                    "t": "session_host_result", "id": host.id,
                    "frame": { "id": host.frame.id, "error": { "code": "not_found", "message": "No browser session is open." } },
                }))
                .unwrap();
                hub.node_commands.resolve(&mid("mac1"), reply);
            }
        });
    }
    let refused = route(&hub, "th-1", SessionHost::Ios, start())
        .await
        .unwrap_err();
    assert!(
        refused.message.contains("did not answer"),
        "{}",
        refused.message
    );
    let ended = ends.recv().await.unwrap();
    assert!(ended.starts_with('H'));
    let rows: i64 = hub
        .db
        .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_places", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(rows, 0);
    let live = hub
        .db
        .with(|c| super::live_on(c, &mid("mac1"), NOW_MS as i64))
        .unwrap();
    assert_eq!(live, 0, "no orphan holds a slot");
    // The agent can start again at once.
    assert!(
        hub.db
            .with(|c| super::open_hosted(
                c,
                &mid("devbox"),
                &fleetd_contracts::ids::ThreadId::unchecked("th-1"),
                NOW_MS as i64
            ))
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn a_hosted_session_that_reports_before_its_start_returns_counts_once() {
    let (hub, _home) = hub();
    let place = super::Place {
        key: super::new_key(),
        runner: mid("mac1"),
        origin: app(),
        origin_thread: fleetd_contracts::ids::ThreadId::unchecked("th-1"),
        task_id: None,
        hosted: true,
        session_id: None,
    };
    hub.db
        .transaction(|c| super::insert_place(c, &place, NOW_MS as i64))
        .unwrap();
    // The runner's report, filed under devbox, lands before the hub has the session's id.
    live_on_devbox(&hub, "th-1", SESSION).await;
    let count = |m: &str| {
        hub.db
            .with(|c| super::live_on(c, &mid(m), NOW_MS as i64))
            .unwrap()
    };
    assert_eq!((count("devbox"), count("mac1")), (0, 1));
    hub.db
        .transaction(|c| super::set_session(c, &place.key, SESSION, &super::relay::hash("t")))
        .unwrap();
    assert_eq!((count("devbox"), count("mac1")), (0, 1));
}

#[tokio::test]
async fn places_nobody_needs_are_pruned() {
    let (hub, _home) = hub();
    let now = NOW_MS as i64;
    let local = super::Place {
        key: super::new_key(),
        runner: mid("devbox"),
        origin: app(),
        origin_thread: fleetd_contracts::ids::ThreadId::unchecked("th-1"),
        task_id: None,
        hosted: false,
        session_id: None,
    };
    let hosted = super::Place {
        key: super::new_key(),
        runner: mid("mac1"),
        hosted: true,
        session_id: Some(SESSION.to_owned()),
        ..local.clone()
    };
    let fresh = super::Place {
        key: super::new_key(),
        ..hosted.clone()
    };
    hub.db
        .transaction(|c| {
            super::insert_place(c, &local, now)?;
            super::insert_place(c, &hosted, now)?;
            super::insert_place(c, &fresh, now)?;
            super::end_place(c, &hosted.key, now)
        })
        .unwrap();
    assert_eq!(hub.db.transaction(|c| super::prune(c, now)).unwrap(), 0);
    // Past the start window the local start goes; a week after its end the hosted one; the open one stays.
    let later = now + 8 * 86_400_000;
    assert_eq!(hub.db.transaction(|c| super::prune(c, later)).unwrap(), 2);
    let left = hub
        .db
        .with(|c| super::hosted(c, fresh.key.as_str()))
        .unwrap();
    assert!(left.is_some());
}

#[tokio::test]
async fn an_agents_node_that_cant_seal_keeps_its_sessions_at_home() {
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    let (_link, _seen) = mac1_node(&hub);
    // devbox's node is older: it can't seal its session's secrets to mac1, which could host an iOS simulator.
    hub.link
        .set_capabilities(&mid("devbox"), &[CAP_SESSION_HOST]);
    let refused = route(&hub, "th-1", SessionHost::Ios, start())
        .await
        .unwrap_err();
    assert_eq!(
        refused.message,
        "devbox can't host an iOS simulator session: as tested."
    );
}

#[tokio::test]
async fn a_sealed_start_goes_only_to_the_runner_it_was_sealed_for_while_it_can_take_it() {
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    let (_link, _seen) = mac1_node(&hub);
    tool(
        &hub,
        "machine_roles_set",
        json!({ "machineId": "mac1", "maxSessions": 1 }),
    )
    .await
    .unwrap();
    // Sealed for devbox itself, which hosts no iOS: refused.
    let wrong = route_once(
        &hub,
        "th-1",
        SessionHost::Ios,
        start(),
        Some(json!({ "runner": "devbox", "dataB64": SEALED })),
    )
    .await
    .unwrap_err();
    assert_eq!(wrong.message, "devbox can't take this session any more.");
    // mac1 fills up between the two steps: the second is refused, and nothing started.
    route(&hub, "th-2", SessionHost::Ios, start())
        .await
        .unwrap();
    let late = route_once(
        &hub,
        "th-1",
        SessionHost::Ios,
        start(),
        Some(json!({ "runner": "mac1", "dataB64": SEALED })),
    )
    .await
    .unwrap_err();
    assert_eq!(late.message, "mac1 can't take this session any more.");
    assert_eq!(late.fix.as_deref(), Some("call session_start again"));
}

/// Task T7's row in `state`, as the tasks area keeps it: done, failed or cancelled at `now`, the end of its turn.
fn task_state(hub: &Hub, state: &str) {
    let now = crate::hub::store::now_ms(hub.clock.as_ref());
    let ended = ["done", "failed", "cancelled"]
        .contains(&state)
        .then(|| crate::hub::store::iso_ms(now));
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, ended_at, data)
                 VALUES (7, 'devbox', 'app', 'W1', ?1, ?2, '{}')
                 ON CONFLICT (n) DO UPDATE SET state = excluded.state, ended_at = excluded.ended_at",
                rusqlite::params![state, ended],
            )?;
            Ok(())
        })
        .unwrap();
}

/// The devbox's update waited hours on a session its task left behind: once the task ended, its session counts on no
/// machine, its own or the one hosting it, whatever its row says. Between turns it still counts: a task is done or
/// failed at the end of each turn, and counts as ended once a screen's idle limit has passed since.
#[tokio::test]
async fn a_session_whose_task_ended_fills_no_slot() {
    let (hub, _home) = hub();
    live_on_devbox(&hub, "th-1", "Bfedcba9876543210fedcba9876543210").await;
    let place = super::Place {
        key: super::new_key(),
        runner: mid("mac1"),
        origin: app(),
        origin_thread: fleetd_contracts::ids::ThreadId::unchecked("th-2"),
        task_id: Some(fleetd_contracts::tasks::TaskId::unchecked("T7")),
        hosted: true,
        session_id: None,
    };
    hub.db
        .transaction(|c| super::insert_place(c, &place, NOW_MS as i64))
        .unwrap();
    let live_at = |m: &str, now: i64| hub.db.with(|c| super::live_on(c, &mid(m), now)).unwrap();
    let live = |m: &str| live_at(m, NOW_MS as i64);
    let later = |m: &str| live_at(m, NOW_MS as i64 + super::TURN_WAIT_MS);
    assert_eq!((live("devbox"), live("mac1")), (1, 1), "no task row yet");
    for state in ["running", "idle", "queued", "done", "failed"] {
        task_state(&hub, state);
        assert_eq!((live("devbox"), live("mac1")), (1, 1), "{state}");
    }
    for state in ["done", "failed"] {
        task_state(&hub, state);
        assert_eq!((later("devbox"), later("mac1")), (0, 0), "{state} long ago");
    }
    task_state(&hub, "cancelled");
    assert_eq!((live("devbox"), live("mac1")), (0, 0), "cancelled");
}

/// Once T7 is cancelled, the hub ends its live session and tells its node to close it and kill its processes; while
/// it runs, the session stays as it is.
#[tokio::test]
async fn the_hub_ends_a_session_whose_task_ended_and_tells_its_node() {
    let (hub, _home) = hub();
    let mut devbox = hub.link.test_link(
        &mid("devbox"),
        &[fleetd_contracts::node_link::CAP_SESSION_END],
    );
    let id = "Bfedcba9876543210fedcba9876543210";
    live_on_devbox(&hub, "th-1", id).await;
    let state = |hub: &Hub| {
        let s = crate::hub::browser::list(&hub.db, &app(), 10).unwrap();
        (
            s[0].state,
            s[0].note.as_ref().map(|n| n.as_str().to_owned()),
        )
    };
    for task in ["running", "idle"] {
        task_state(&hub, task);
        assert_eq!(
            crate::hub::browser::end_outlived(&hub).unwrap(),
            0,
            "{task}"
        );
        assert_eq!(state(&hub).0, BrowserSessionState::Live);
    }
    task_state(&hub, "cancelled");
    let mut told = crate::hub::browser::Told::new();
    assert_eq!(crate::hub::browser::end_outlived(&hub).unwrap(), 1);
    assert_eq!(crate::hub::browser::tell_nodes(&hub, &mut told).unwrap(), 1);
    assert_eq!(
        state(&hub),
        (
            BrowserSessionState::Lost,
            Some(crate::hub::browser::OUTLIVED_NOTE.to_owned())
        )
    );
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), devbox.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        frame,
        HubToNode::SessionEnd(fleetd_contracts::node_link::SessionEndFrame {
            thread_id: fleetd_contracts::ids::ThreadId::unchecked("th-1"),
            session_id: fleetd_contracts::browser::BrowserSessionId::unchecked(id),
        })
    );
    assert_eq!(crate::hub::browser::end_outlived(&hub).unwrap(), 0, "once");
    assert_eq!(
        crate::hub::browser::tell_nodes(&hub, &mut told).unwrap(),
        0,
        "once per link"
    );

    // The node linked again (the frame may have been lost with its last link): it hears of it again.
    let mut devbox = hub.link.test_link(
        &mid("devbox"),
        &[fleetd_contracts::node_link::CAP_SESSION_END],
    );
    assert_eq!(crate::hub::browser::tell_nodes(&hub, &mut told).unwrap(), 1);
    assert!(matches!(
        devbox.recv().await,
        Some(HubToNode::SessionEnd(_))
    ));

    // Its node reported the session since (it closed it): nothing more to say, however often it links.
    let call: LeadCall = serde_json::from_value(json!({
        "op": "browser_session", "sessionId": id, "threadId": "th-1", "purpose": "Check the signup form",
        "state": "uploading", "startedAt": crate::hub::store::iso_ms(NOW_MS as i64),
        "endedAt": crate::hub::store::iso_ms(NOW_MS as i64),
    }))
    .unwrap();
    let handler = hub.lead_calls.handler("browser_session").unwrap();
    handler.handle(task_caller(), call).await.unwrap();
    let _devbox = hub.link.test_link(
        &mid("devbox"),
        &[fleetd_contracts::node_link::CAP_SESSION_END],
    );
    assert_eq!(crate::hub::browser::tell_nodes(&hub, &mut told).unwrap(), 0);
    assert_eq!(state(&hub).0, BrowserSessionState::Uploading);
}

/// T1485's iOS screen was ended as its turn did, while it waited on wait_ci: a task is done at the end of each turn,
/// and a wake continues it. Its screen stays through the wait and serves its next turn; only once the task stays done
/// past a screen's idle limit does the hub end it.
#[tokio::test]
async fn a_task_waiting_between_turns_keeps_its_screen() {
    let clock = ManualClock::at(NOW_MS);
    let (hub, _home) = hub_at(clock.clone());
    let id = "Bfedcba9876543210fedcba9876543210";
    live_on_devbox(&hub, "th-1", id).await;
    let state = |hub: &Hub| crate::hub::browser::list(&hub.db, &app(), 10).unwrap()[0].state;
    let wait = std::time::Duration::from_millis(super::TURN_WAIT_MS as u64);

    // Its turn ends, waiting on CI.
    task_state(&hub, "running");
    task_state(&hub, "done");
    clock.advance(wait - std::time::Duration::from_secs(60));
    assert_eq!(
        crate::hub::browser::end_outlived(&hub).unwrap(),
        0,
        "waiting"
    );
    assert_eq!(state(&hub), BrowserSessionState::Live);

    // The wake continues it, and it uses the screen again: its node's report of it still counts.
    task_state(&hub, "running");
    clock.advance(wait);
    assert_eq!(crate::hub::browser::end_outlived(&hub).unwrap(), 0, "woken");
    live_on_devbox(&hub, "th-1", id).await;
    assert_eq!(state(&hub), BrowserSessionState::Live);

    // Done for good: nothing woke it within a screen's idle limit, so the hub ends the screen.
    task_state(&hub, "done");
    clock.advance(wait - std::time::Duration::from_secs(60));
    assert_eq!(crate::hub::browser::end_outlived(&hub).unwrap(), 0);
    clock.advance(std::time::Duration::from_secs(60));
    assert_eq!(
        crate::hub::browser::end_outlived(&hub).unwrap(),
        1,
        "finished"
    );
    assert_eq!(state(&hub), BrowserSessionState::Lost);
}

/// The app's Navi dialog reads each machine's Navi sandbox as its node last reported it, whether the caller may make
/// a Navi there, and where the hub puts one by default.
#[tokio::test]
async fn machine_roles_say_where_a_navi_can_live() {
    let (hub, _home) = hub();
    let info = serde_json::from_value(json!({
        "runner": "claude", "supported": "", "versionOk": true, "login": "logged_in",
        "sandbox": { "status": "gap", "line": "Navis run in bubblewrap, but…", "fix": "Update the kernel." },
    }))
    .unwrap();
    hub.executors.handle_frame(
        &mid("devbox"),
        fleetd_contracts::node_link::NodeToHub::MachineEvent(
            fleetd_contracts::sessions::MachineEventFrame {
                seq: 1,
                at: fleetd_contracts::ids::Timestamp::from(AT),
                event: fleetd_contracts::sessions::MachineEvent::RunnerInfo(info),
            },
        ),
    );
    let listed = tool(&hub, "machine_roles", json!({})).await.unwrap();
    let on = |m: &str| {
        listed["machines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["machineId"] == m)
            .unwrap()
            .clone()
    };
    assert_eq!(on("devbox")["naviSandbox"]["status"], "gap");
    assert_eq!(on("devbox")["naviSandbox"]["fix"], "Update the kernel.");
    assert_eq!(on("devbox")["operates"], true);
    assert!(on("mac1").get("naviSandbox").is_none(), "nothing reported");

    // A key that only reads sees the machines, and that it can't make a Navi on them.
    let reader: Caller = serde_json::from_value(json!({
        "keyId": "k2", "name": "phone", "prefix": "fld_ghijkl", "createdAt": AT,
        "grants": [{ "role": "read", "machines": "*" }],
    }))
    .unwrap();
    let read = crate::hub::api::registry()
        .call(&hub, &reader, "machine_roles", json!({}))
        .await
        .unwrap();
    assert_eq!(read["machines"][0]["operates"], false);
    assert_eq!(read["best"], listed["best"]);
}
