//! A browser session on another machine than its agent's, end to end: the hub serves its HTTP routes on a local port,
//! devbox's node routes its agent's session tools as the lead socket does, and mac1's node hosts the session in a
//! real Chrome. Both nodes' lead calls and hosted frames go through the hub's own handlers; only the node links'
//! sockets are stand-ins. The agent's driver connects to devbox's proxy, as agent-browser does, and reaches mac1's
//! browser through the hub's relay. devbox seals the session's secrets and relay key to mac1 first, so mac1 scrubs the
//! recording with them and the two nodes encrypt the relay: a secret the agent types never reaches the hub in the
//! clear. Needs a Chrome, as the browser tests do (on CI it fails without one).
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use fleetd_contracts::browser::{BrowserCallFrame, RecordingFile};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, Timestamp};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallFrame};
use fleetd_contracts::machine_roles::{HostCheck, SessionHost};
use fleetd_contracts::node_link::{
    CAP_SESSION_HOST, CAP_SESSION_SEAL, HUB_CAP_SESSION_ROUTE, HubToNode, NodeToHub,
};
use fleetd_contracts::prim::{Line, List, NonEmpty};
use fleetd_contracts::tasks::AbsolutePath;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::browser::tests::{Driver, chrome_or_skip, command_item, site};
use super::browser::upload::{HubCalls, HubFuture};
use super::browser::{Broker, BrowserConfig, SessionHooks};
use super::identity::NodeBoxKey;
use super::lead::LeadRelay;
use super::mask::{Masker, Secrets};
use super::session_route::{Hosted, Router, host, routed};
use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::store::HubDb;

const AGENT: &str = "th-agent-1";
/// A secret of the agent's session on devbox, which it types into the page on mac1.
const SECRET: &str = "hunter2Zq9sealed";
/// A login in devbox's 1Password, which the agent fills into the page on mac1.
const FILL: &str = "opFilled7Kq2value";
const FILL_REF: &str = "op://Team/Shop/username";
const TOKEN: &str = "ops_test_service_account_token";

/// devbox's 1Password: one login for the test site, for the session's token.
struct OnePassword {
    urls: Vec<String>,
}

impl super::browser::onepassword::Vault for OnePassword {
    fn resolve(&self, reference: &str) -> super::browser::onepassword::CredFuture {
        let (urls, reference) = (self.urls.clone(), reference.to_owned());
        Box::pin(async move {
            assert_eq!(reference, FILL_REF);
            Ok(super::browser::onepassword::Credential {
                value: zeroize::Zeroizing::new(FILL.to_owned()),
                urls,
            })
        })
    }
}

/// The agent session's secrets on devbox: its project's, and its 1Password token.
fn secrets() -> Vec<(String, String)> {
    vec![
        ("SHOP_PASSWORD".to_owned(), SECRET.to_owned()),
        (
            super::browser::onepassword::TOKEN_ENV.to_owned(),
            TOKEN.to_owned(),
        ),
    ]
}

fn mid(m: &str) -> MachineId {
    MachineId::unchecked(m)
}

fn storefront() -> ProjectRef {
    ProjectRef {
        machine_id: mid("devbox"),
        project_id: ProjectId::unchecked("storefront"),
    }
}

/// A node's lead calls as its link sends them: answered by the hub's link server, for that machine.
struct NodeCalls {
    hub: Arc<Hub>,
    machine: MachineId,
}

impl HubCalls for NodeCalls {
    fn call(&self, thread: &str, cwd: &str, call: LeadCall) -> HubFuture {
        let (hub, machine) = (self.hub.clone(), self.machine.clone());
        let frame = LeadCallFrame {
            id: NonEmpty::unchecked("browser"),
            cwd: AbsolutePath::unchecked(cwd),
            call,
            thread_id: Some(ThreadId::unchecked(thread)),
        };
        Box::pin(async move {
            let answer = hub.link.answer_lead_call(&machine, frame).await;
            match (answer.result, answer.error) {
                (Some(result), _) => Ok(result),
                (None, Some(error)) => Err(error),
                (None, None) => unreachable!("a result or an error"),
            }
        })
    }
}

/// The hub on a local port, with devbox (agents only) and mac1 (sessions, Chrome) online and storefront's lead on
/// devbox as the agent.
async fn hub(home: &std::path::Path, mac1_key: &str) -> (Arc<Hub>, String) {
    let config = HubConfig {
        home: home.to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    // On disk, so the test can read every byte the hub stored.
    let hub = crate::hub::serve::build_on(
        HubDb::open(home).unwrap(),
        config,
        crate::hub::store::test_clock::ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    let at = "2026-10-26T10:00:00.000Z";
    for m in ["devbox", "mac1"] {
        let machine = serde_json::from_value(json!({
            "machineId": m, "name": m, "tags": [], "status": "online", "lastSeenAt": at, "nodeVersion": "0.1.0",
            "boxPubKey": mac1_key,
        }))
        .unwrap();
        hub.store.machine_upsert(&machine, None).unwrap();
        hub.link
            .set_capabilities(&mid(m), &[CAP_SESSION_HOST, CAP_SESSION_SEAL]);
        let mut load = crate::hub::link::guard::tests::load(500, 1.0);
        load.hosts = Some(List::unchecked(vec![HostCheck {
            host: SessionHost::Browser,
            ready: m == "mac1",
            detail: Line::unchecked("as tested"),
        }]));
        hub.link.observe_load(&mid(m), Some(load), at);
    }
    hub.db
        .transaction(|c| {
            crate::hub::machine_roles::set_roles(
                c,
                &mid("devbox"),
                &crate::hub::machine_roles::Roles {
                    agents: true,
                    sessions: false,
                    max_sessions: None,
                },
            )
        })
        .unwrap();
    hub.store
        .projects_upsert_many(
            &mid("devbox"),
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "storefront", "title": "storefront",
                "workspaceRoot": "/work/storefront", "lastActivityAt": at,
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
            }))
            .unwrap()],
        )
        .unwrap();
    hub.leads
        .records
        .lead_put(&crate::hub::leads::records::StoredLead {
            project_ref: storefront(),
            thread_id: ThreadId::unchecked(AGENT),
            started_at: Timestamp(at.into()),
            last_wake_at: None,
            session_generation: 0,
        })
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let router = crate::hub::http::router(hub.clone(), Arc::new(crate::hub::api::registry()));
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
    });
    (hub, url)
}

/// agent-browser as an install leaves it under `home`, so a node takes it as installed (no npm in tests).
fn agent_browser_installed(home: &std::path::Path) {
    let dir = super::browser::agent_browser::install_dir(home);
    std::fs::create_dir_all(super::browser::agent_browser::bin_dir(home)).unwrap();
    std::fs::write(
        super::browser::agent_browser::bin_dir(home).join("agent-browser"),
        "#!/bin/sh\n",
    )
    .unwrap();
    std::fs::write(dir.join("VERSION"), super::browser::agent_browser::VERSION).unwrap();
}

/// devbox's link: its lead calls to the hub's link server, and the hub's frames to it (none it must answer here).
fn devbox_link(hub: &Arc<Hub>) -> (LeadRelay, Vec<Box<dyn std::any::Any + Send>>) {
    let relay = LeadRelay::new();
    relay.set_hub_caps(vec![HUB_CAP_SESSION_ROUTE.to_owned()]);
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let attached = relay.attach(tx);
    {
        let (hub, relay) = (hub.clone(), relay.clone());
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                let Ok(NodeToHub::LeadCall(frame)) = serde_json::from_str(&line) else {
                    continue;
                };
                let (hub, relay) = (hub.clone(), relay.clone());
                tokio::spawn(async move {
                    relay.resolve(hub.link.answer_lead_call(&mid("devbox"), frame).await);
                });
            }
        });
    }
    let (hub_tx, hub_rx) = mpsc::unbounded_channel::<HubToNode>();
    let linked = hub.node_commands.attach(&mid("devbox"), hub_tx);
    (
        relay,
        vec![Box::new(attached), Box::new(linked), Box::new(hub_rx)],
    )
}

/// mac1's link: the hub's frames for the sessions it hosts, answered by the node's own handler.
fn mac1_link(
    hub: &Arc<Hub>,
    broker: &Arc<Broker>,
    url: &str,
    hosted: &Hosted,
    box_key: Arc<NodeBoxKey>,
) -> crate::hub::link::commands::AttachedLink {
    let (tx, mut rx) = mpsc::unbounded_channel::<HubToNode>();
    let linked = hub.node_commands.attach(&mid("mac1"), tx);
    let (hub, broker, url, hosted) = (hub.clone(), broker.clone(), url.to_owned(), hosted.clone());
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let (hub, broker, url, hosted, box_key) = (
                hub.clone(),
                broker.clone(),
                url.clone(),
                hosted.clone(),
                box_key.clone(),
            );
            tokio::spawn(async move {
                if let Some(result) = host(
                    Some(broker),
                    None,
                    &url,
                    frame,
                    &hosted,
                    Some(&box_key),
                    |_| None,
                )
                .await
                {
                    hub.node_commands
                        .resolve(&mid("mac1"), NodeToHub::SessionHostResult(result));
                }
            });
        }
    });
    linked
}

async fn tool(router: &Arc<Router>, call: Value) -> Value {
    let frame: BrowserCallFrame = serde_json::from_value(json!({
        "id": "t1", "cwd": "/work/storefront", "threadId": AGENT, "call": call,
    }))
    .unwrap();
    serde_json::to_value(routed(router.clone())(AGENT.to_owned(), frame).await).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_agent_on_one_node_drives_a_browser_on_another_through_the_hub() {
    let Some(chrome) = chrome_or_skip() else {
        return;
    };
    let mac1_home = tempfile::tempdir().unwrap();
    let mac1_key = Arc::new(super::identity::load_or_create_box_key(mac1_home.path()).unwrap());
    let hub_home = tempfile::tempdir().unwrap();
    let (hub, url) = hub(hub_home.path(), &mac1_key.public_key()).await;
    let (site, _site) = site().await;

    // mac1: a broker with a warm Chrome, reporting to the hub as mac1, which reads a hosted session's secrets from
    // what devbox sealed to it, as the node does.
    let hosted = Hosted::default();
    let mac1 = Broker::open(
        mac1_home.path(),
        BrowserConfig::default(),
        hosted.watch(Arc::new(NodeCalls {
            hub: hub.clone(),
            machine: mid("mac1"),
        })),
        hosted.secrets_for(Arc::new(|session| {
            Err(format!("no session {session} on this machine"))
        })),
    )
    .await;
    mac1.ready(chrome);
    let deadline = Instant::now() + Duration::from_secs(20);
    while mac1.warm() == 0 && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let _mac1_link = mac1_link(&hub, &mac1, &url, &hosted, mac1_key.clone());

    // devbox: a broker with no browser of its own (its role is agents only), and the agent's session tools.
    let devbox_home = tempfile::tempdir().unwrap();
    let devbox = Broker::open(
        devbox_home.path(),
        BrowserConfig::default(),
        Arc::new(NodeCalls {
            hub: hub.clone(),
            machine: mid("devbox"),
        }),
        // The agent session's secrets on devbox: its project's, and its 1Password token.
        Arc::new(|_| Ok(Secrets(secrets()))),
    )
    .await;
    // devbox never ran a session: the start makes sure its agent has agent-browser to drive the one on mac1 with.
    agent_browser_installed(devbox_home.path());
    let (relay, _devbox_link) = devbox_link(&hub);
    let router = Arc::new(Router {
        broker: Some(devbox.clone()),
        devices: None,
        ios: None,
        desktops: None,
        relay,
        hub: url.clone(),
        secrets_for: Arc::new(|_| Ok(Secrets(secrets()))),
        mask_for: Arc::new(|_| Ok(Masker::new(&secrets()))),
        filled_elsewhere: super::session_route::FilledElsewhere::default(),
        hosted_ids: Default::default(),
        home: devbox_home.path().to_path_buf(),
        worktree_of: Arc::new(|_| None),
        remotes: Default::default(),
    });
    // 1Password is devbox's alone: mac1 never gets the token, and never makes a vault.
    devbox.set_vaults(Arc::new({
        let urls = vec![format!("{site}/")];
        move |token| {
            assert_eq!(token.as_str(), TOKEN, "the session's token, on devbox");
            Arc::new(OnePassword { urls: urls.clone() })
                as Arc<dyn super::browser::onepassword::Vault>
        }
    }));
    mac1.set_vaults(Arc::new(|_| {
        panic!("mac1 read 1Password: it never holds the token")
    }));

    let started = tool(
        &router,
        json!({ "op": "session_start", "purpose": "Sign in to the test shop" }),
    )
    .await;
    let id = started["result"]["sessionId"]
        .as_str()
        .unwrap_or_else(|| panic!("started: {started}"))
        .to_owned();
    assert!(devbox.live(AGENT).is_none(), "the browser is not on devbox");
    assert!(devbox.remote(AGENT).is_some(), "devbox relays its driver");
    assert!(super::browser::agent_browser::find(devbox_home.path()).is_some());
    // The agent hears its own address for it, as its environment names it: never mac1's.
    let cdp = devbox.cdp_url(AGENT).unwrap();
    assert_eq!(started["result"]["cdp"], cdp.as_str());

    // The agent's driver, on devbox's proxy at the URL its environment names, reaches mac1's Chrome.
    let mut driver = Driver::connect(&cdp).await.unwrap();
    let page = driver.page().await;
    driver.ok(Some(&page), "Page.enable", json!({})).await;
    driver
        .ok(Some(&page), "Page.navigate", json!({ "url": site }))
        .await;
    driver
        .wait_for(
            &page,
            "document.readyState === 'complete' && !!document.querySelector('#user')",
        )
        .await;
    SessionHooks::item(
        router.as_ref(),
        AGENT,
        &command_item(&format!("agent-browser open {site}"), "✓ Sign in"),
    );
    driver
        .eval(&page, "document.querySelector('#user').focus()")
        .await;
    // The agent types its session's secret: the page shows it back once signed in.
    driver
        .ok(Some(&page), "Input.insertText", json!({ "text": SECRET }))
        .await;
    driver
        .eval(&page, "document.querySelector('#go').click()")
        .await;
    driver
        .wait_for(
            &page,
            &format!("document.body.innerText.includes('Welcome {SECRET}')"),
        )
        .await;
    SessionHooks::item(
        router.as_ref(),
        AGENT,
        &command_item(
            &format!("agent-browser fill @e1 {SECRET}"),
            &format!("✓ Filled {SECRET}"),
        ),
    );
    tokio::time::sleep(Duration::from_millis(800)).await;

    // Another agent session's address on devbox reaches nothing, and neither does a made-up relay token.
    assert!(
        Driver::connect(&devbox.cdp_url("th-other").unwrap())
            .await
            .is_err()
    );
    let forged = format!(
        "{}/relay/{}",
        url.replacen("http", "ws", 1),
        "ab".repeat(32)
    );
    assert!(Driver::connect(&forged).await.is_err());

    // A login filled from devbox's 1Password into the page on mac1: devbox reads it, mac1 fills it (the form submits),
    // and devbox masks it in its agent's reports from now on.
    driver
        .ok(Some(&page), "Page.navigate", json!({ "url": site }))
        .await;
    driver
        .wait_for(
            &page,
            "document.readyState === 'complete' && !!document.querySelector('#user')",
        )
        .await;
    let filled = tool(
        &router,
        json!({ "op": "fill_credential", "ref": FILL_REF, "target": "#user" }),
    )
    .await;
    let message = filled["result"]["message"]
        .as_str()
        .unwrap_or_else(|| panic!("filled: {filled}"));
    assert!(
        message.starts_with(&format!("Filled #user from {FILL_REF}")),
        "{message}"
    );
    assert!(
        !filled.to_string().contains(FILL),
        "the agent never hears the value"
    );
    let masked = SessionHooks::filled_since(router.as_ref(), AGENT, 0).unwrap();
    assert!(
        masked.0.iter().any(|(_, v)| v == FILL),
        "devbox masks it in its agent's reports"
    );
    tokio::time::sleep(Duration::from_millis(800)).await;
    // The agent's next command records the page the submit loaded.
    SessionHooks::item(
        router.as_ref(),
        AGENT,
        &command_item("agent-browser get title", "Welcome"),
    );
    tokio::time::sleep(Duration::from_millis(1200)).await;

    // The hub's end of an earlier screen of the agent's leaves this one: devbox knows its hosted screen's id.
    assert_eq!(
        router.hosted_ids.lock().unwrap().get(AGENT),
        Some(&id),
        "devbox knows which screen it holds on mac1"
    );
    SessionHooks::screen_ended(router.as_ref(), AGENT, "B00000000000000000000000000000000");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        devbox.remote(AGENT).is_some(),
        "another screen's end leaves it"
    );

    let relay_before_end = devbox.remote(AGENT).unwrap();
    let ended = tool(&router, json!({ "op": "session_end" })).await;
    assert!(ended["error"].is_null(), "{ended}");
    assert!(devbox.remote(AGENT).is_none());
    assert!(router.hosted_ids.lock().unwrap().get(AGENT).is_none());

    // The recording lands on the hub, filed under the agent's project and session, with the agent's steps in it.
    let session_id = fleetd_contracts::browser::BrowserSessionId::unchecked(&id);
    let deadline = Instant::now() + Duration::from_secs(30);
    let session = loop {
        let session = crate::hub::browser::get(&hub.db, &session_id).unwrap();
        if let Some(s) = session.filter(|s| s.state.as_str() == "recorded") {
            break s;
        }
        assert!(Instant::now() < deadline, "never recorded");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(session.project_ref, storefront());
    assert_eq!(session.thread_id.as_str(), AGENT);
    // mac1 forgot what devbox sealed to it for the session, its relay key with it.
    let host_key = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT place_id FROM session_places WHERE hosted = 1",
                [],
                |r| r.get::<_, String>(0),
            )?)
        })
        .unwrap();
    assert!(!hosted.holds(&host_key));
    let read = |file| {
        std::fs::read_to_string(crate::hub::browser::file_path(&hub, &session_id, file)).unwrap()
    };
    let actions = read(RecordingFile::Actions);
    assert!(actions.contains("agent-browser open"), "{actions}");
    assert!(
        actions.contains("agent-browser fill @e1 ***SHOP_PASSWORD***"),
        "{actions}"
    );
    // mac1 scrubbed the trace with the secret devbox sealed to it: the page after the steps, masked.
    let dom = read(RecordingFile::Dom);
    assert!(
        dom.contains(&format!("Welcome ***{FILL_REF}***")),
        "the filled login, masked on mac1, is in the trace: {}",
        dom.lines()
            .last()
            .unwrap_or_default()
            .chars()
            .take(600)
            .collect::<String>()
    );
    assert!(
        dom.contains("Welcome ***SHOP_PASSWORD***"),
        "the masked page is in the trace"
    );

    // Nothing the hub relayed or stored holds the secret: the relay carried what the nodes encrypted, the recording
    // was scrubbed on mac1, the steps on devbox, and the secrets went sealed to mac1.
    let found = |bytes: &[u8]| {
        [SECRET, FILL, TOKEN]
            .iter()
            .any(|s| bytes.windows(s.len()).any(|w| w == s.as_bytes()))
    };
    let piped = hub.relays.piped.lock().unwrap().clone();
    assert!(!piped.is_empty(), "the relay carried the driver's messages");
    assert!(!found(&piped), "the relay carried the secret in the clear");
    for entry in walk(hub_home.path()) {
        let bytes = std::fs::read(&entry).unwrap();
        assert!(!found(&bytes), "{} holds the secret", entry.display());
    }

    // A relay devbox still holds for a session that ended elsewhere (idle, a person, a lost runner) is dropped on the
    // driver's next connection, which hears to start a session.
    devbox.set_remote(AGENT, Some(relay_before_end));
    let _ = Driver::connect(&cdp).await;
    let deadline = Instant::now() + Duration::from_secs(5);
    while devbox.remote(AGENT).is_some() {
        assert!(Instant::now() < deadline, "the stale relay stayed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Every file under `dir`.
fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

/// A remote start makes sure the agent's machine has agent-browser; one that has it keeps it as it is.
#[tokio::test]
async fn the_driver_is_installed_once() {
    let home = tempfile::tempdir().unwrap();
    agent_browser_installed(home.path());
    let broker = Broker::open(
        home.path(),
        BrowserConfig::default(),
        Arc::new(NodeCalls {
            hub: {
                let key = super::identity::load_or_create_box_key(home.path()).unwrap();
                hub(tempfile::tempdir().unwrap().path(), &key.public_key())
                    .await
                    .0
            },
            machine: mid("devbox"),
        }),
        Arc::new(|_| Ok(Secrets(Vec::new()))),
    )
    .await;
    let bin = super::browser::agent_browser::find(home.path()).unwrap();
    let before = std::fs::metadata(&bin).unwrap().modified().unwrap();
    broker.ensure_driver().await.unwrap();
    assert_eq!(std::fs::metadata(&bin).unwrap().modified().unwrap(), before);
}
