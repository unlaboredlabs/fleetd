use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::machine_roles::{HostCheck, SessionHost, SessionRouteResult};
use fleetd_contracts::mcp::McpToolError;
use fleetd_contracts::node_link::{CAP_SESSION_HOST, HubToNode};
use fleetd_contracts::prim::{Line, List};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{Runner, place};
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-26T10:00:00.000Z";
const NOW_MS: u64 = 1_792_000_000_000;
const SESSION: &str = "B0123456789abcdef0123456789abcdef";

fn mid(m: &str) -> MachineId {
    MachineId::unchecked(m)
}

fn app() -> ProjectRef {
    ProjectRef {
        machine_id: mid("devbox"),
        project_id: ProjectId::unchecked("app"),
    }
}

/// A hub with devbox (Linux: Chrome and docker) and mac1 (macOS: Chrome and iOS simulators) online, both on a node
/// that hosts others' sessions, and project app on devbox.
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
        ManualClock::at(NOW_MS),
    )
    .unwrap();
    for m in ["devbox", "mac1"] {
        let machine = serde_json::from_value(json!({
            "machineId": m, "name": m, "tags": [], "status": "online", "lastSeenAt": AT, "nodeVersion": "0.1.0",
        }))
        .unwrap();
        hub.store.machine_upsert(&machine, None).unwrap();
        hub.link.set_capabilities(&mid(m), &[CAP_SESSION_HOST]);
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
fn report_hosts(hub: &Hub, m: &str, ready: &[SessionHost]) {
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

fn admin() -> Caller {
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

fn task_caller() -> LeadCaller {
    LeadCaller {
        project_ref: app(),
        by: crate::hub::link::lead_calls::lead_by(&app()),
        agent: CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T7")),
    }
}

/// Task T7's node hands the hub one of its agent's session calls, for session `thread`.
async fn route(
    hub: &Hub,
    thread: &str,
    host: SessionHost,
    call: Value,
) -> Result<SessionRouteResult, McpToolError> {
    let call: LeadCall = serde_json::from_value(json!({
        "op": "session_route", "host": host,
        "frame": { "id": "1", "cwd": "/work/app", "call": call, "threadId": thread },
    }))
    .unwrap();
    let handler = hub.lead_calls.handler("session_route").unwrap();
    match handler.handle(task_caller(), call).await? {
        LeadCallResult::SessionRoute(out) => Ok(out),
        other => panic!("not a route: {other:?}"),
    }
}

fn start() -> Value {
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

/// Placing sessions on other machines turned on, as the relay will, and devbox's node linked to hear of them.
fn remote(hub: &Arc<Hub>) -> crate::hub::link::commands::AttachedLink {
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
            let result = match op {
                "session_start" => {
                    let id = match started {
                        0 => SESSION.to_owned(),
                        n => format!("B{n:032x}"),
                    };
                    started += 1;
                    json!({ "op": "session_start", "sessionId": id, "cdp": "ws://127.0.0.1:1/x", "startMs": 5 })
                }
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
    assert!(refused.fix.unwrap().contains("Settings > Machines"));
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
        live,
        max,
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
async fn until_the_relay_a_session_runs_only_on_its_agents_machine() {
    let (hub, _home) = hub();
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
    assert!(full.fix.unwrap().contains("Settings > Machines"));
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
        .transaction(|c| super::set_session(c, &place.key, SESSION))
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
