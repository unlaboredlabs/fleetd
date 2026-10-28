//! Which Claude account each agent runs on: the rules over a hand-made setup, whose work an order, a lead and a Navi
//! are, the tools over a real hub and a fake node (sealed values relayed and never kept), and a task's launch carrying
//! its order starter's account.
use std::collections::BTreeMap;
use std::sync::Arc;

use fleetd_contracts::auth::{Grant, KeyKind};
use fleetd_contracts::claude_accounts::{
    CONNECT_REFUSAL, ClaudeAccount, ClaudeChoice, ClaudeHubApi, ClaudeRunsOn, ClaudeSealedOn,
    ClaudeSettings, ClaudeSubscription,
};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::node_link::{CAP_CLAUDE_ACCOUNTS, HubToNode, NodeToHub};
use fleetd_contracts::people::{HubRole, PersonId, PersonName};
use fleetd_contracts::secrets::SecretFingerprint;
use fleetd_contracts::sessions::SessionCall;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{Setup, Whose, whose_for_lead, whose_for_task};
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::leads::records::NewWorkstream;
use crate::hub::people::People;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::tasks::ports::{LaunchRequest, PortError, TaskPorts};

const AT: &str = "2026-10-27T10:00:00.000Z";
const TOKEN: &str = "sk-ant-oat01-never-on-the-hub";

fn lab() -> MachineId {
    MachineId::unchecked("lab")
}

fn pid(id: &str) -> PersonId {
    PersonId::unchecked(id)
}

fn person(id: &str) -> Whose {
    Whose::Person(pid(id))
}

fn on(machines: &[&str]) -> Vec<ClaudeSealedOn> {
    machines
        .iter()
        .map(|m| ClaudeSealedOn {
            machine_id: MachineId::unchecked(*m),
            fingerprint: SecretFingerprint::unchecked("5ec2e7a1"),
        })
        .collect()
}

fn api(machines: &[&str]) -> ClaudeHubApi {
    ClaudeHubApi {
        endpoint: None,
        sealed_on: on(machines),
        updated_at: Timestamp(AT.into()),
        updated_by: None,
        last_test: None,
    }
}

fn subscription(machines: &[&str]) -> ClaudeSubscription {
    ClaudeSubscription {
        sealed_on: on(machines),
        connected_at: Timestamp(AT.into()),
        last_test: None,
    }
}

fn account(whose: &str) -> ClaudeRunsOn {
    ClaudeRunsOn::Account {
        account: match whose {
            "hub" => ClaudeAccount::Hub,
            id => ClaudeAccount::Person { person_id: pid(id) },
        },
    }
}

/// Ann owns the hub, Ada is an admin, Bob and Cy are members.
fn team() -> Setup {
    Setup {
        owner: Some(pid("p_aaaaaaaa")),
        roles: BTreeMap::from([
            (pid("p_aaaaaaaa"), HubRole::Owner),
            (pid("p_dddddddd"), HubRole::Admin),
            (pid("p_bbbbbbbb"), HubRole::Member),
            (pid("p_cccccccc"), HubRole::Member),
        ]),
        ..Default::default()
    }
}

fn refused(runs_on: &ClaudeRunsOn) -> &str {
    match runs_on {
        ClaudeRunsOn::Refused { message, .. } => message,
        other => panic!("not refused: {other:?}"),
    }
}

#[test]
fn with_nothing_set_up_every_machine_keeps_its_own_login() {
    let setup = team();
    for whose in [Whose::Hub, person("p_aaaaaaaa"), person("p_bbbbbbbb")] {
        assert_eq!(
            setup.runs_on(&whose, Some(&lab())),
            ClaudeRunsOn::MachineLogin
        );
    }
    // A choice made before anything is set up changes nothing either.
    let chose = Setup {
        choices: BTreeMap::from([(pid("p_bbbbbbbb"), ClaudeChoice::Subscription)]),
        ..team()
    };
    assert_eq!(
        chose.runs_on(&person("p_bbbbbbbb"), Some(&lab())),
        ClaudeRunsOn::MachineLogin
    );
}

#[test]
fn an_order_runs_on_its_starters_account_and_never_on_anyone_elses_subscription() {
    let mut setup = Setup {
        subscriptions: BTreeMap::from([
            (pid("p_aaaaaaaa"), subscription(&["lab"])),
            (pid("p_cccccccc"), subscription(&["lab"])),
        ]),
        ..team()
    };
    let lab = lab();
    assert_eq!(
        setup.runs_on(&person("p_cccccccc"), Some(&lab)),
        account("p_cccccccc")
    );
    // Bob connected nothing and the hub has no key: refused, though Ann's and Cy's subscriptions are right there.
    let bob = setup.runs_on(&person("p_bbbbbbbb"), Some(&lab));
    assert_eq!(refused(&bob), CONNECT_REFUSAL);
    // Leads and work nobody started: the owner's subscription, as there is no key.
    assert_eq!(
        setup.runs_on(&Whose::Hub, Some(&lab)),
        account("p_aaaaaaaa")
    );
    setup.hub_api = Some(api(&["lab"]));
    assert_eq!(
        setup.runs_on(&person("p_bbbbbbbb"), Some(&lab)),
        account("hub")
    );
    assert_eq!(setup.runs_on(&Whose::Hub, Some(&lab)), account("hub"));
    // Unset, Cy's own subscription goes first; her choice of the hub's API wins over it.
    assert_eq!(
        setup.runs_on(&person("p_cccccccc"), Some(&lab)),
        account("p_cccccccc")
    );
    setup
        .choices
        .insert(pid("p_cccccccc"), ClaudeChoice::HubApi);
    assert_eq!(
        setup.runs_on(&person("p_cccccccc"), Some(&lab)),
        account("hub")
    );
    // Bob chose his own subscription and has none: refused, never the key or anyone's subscription.
    setup
        .choices
        .insert(pid("p_bbbbbbbb"), ClaudeChoice::Subscription);
    assert_eq!(
        refused(&setup.runs_on(&person("p_bbbbbbbb"), Some(&lab))),
        CONNECT_REFUSAL
    );
}

#[test]
fn the_members_switch_turns_the_hubs_api_off_for_members_only() {
    let setup = Setup {
        hub_api: Some(api(&["lab"])),
        settings: ClaudeSettings {
            members_use_hub_api: false,
        },
        subscriptions: BTreeMap::from([(pid("p_cccccccc"), subscription(&["lab"]))]),
        ..team()
    };
    let lab = lab();
    let ClaudeRunsOn::Refused { message, fix } = setup.runs_on(&person("p_bbbbbbbb"), Some(&lab))
    else {
        panic!("a member with no subscription runs on nothing");
    };
    assert_eq!(message, CONNECT_REFUSAL);
    assert!(fix.contains("Members may not use the hub's API"), "{fix}");
    assert_eq!(
        setup.runs_on(&person("p_cccccccc"), Some(&lab)),
        account("p_cccccccc")
    );
    // Owners and admins, leads and work nobody started keep it.
    assert_eq!(
        setup.runs_on(&person("p_dddddddd"), Some(&lab)),
        account("hub")
    );
    assert_eq!(
        setup.runs_on(&person("p_aaaaaaaa"), Some(&lab)),
        account("hub")
    );
    assert_eq!(setup.runs_on(&Whose::Hub, Some(&lab)), account("hub"));
    assert!(!setup.may_use_hub_api(&pid("p_bbbbbbbb")));
    assert!(setup.may_use_hub_api(&pid("p_dddddddd")));
}

#[test]
fn a_way_missing_from_the_machine_gives_way_to_one_there_or_refuses_the_work_there() {
    let mut setup = Setup {
        hub_api: Some(api(&["lab"])),
        subscriptions: BTreeMap::from([
            (pid("p_cccccccc"), subscription(&["mac"])),
            (pid("p_aaaaaaaa"), subscription(&["lab"])),
        ]),
        ..team()
    };
    let lab = lab();
    // Cy's subscription is on mac only: unset, her work on lab runs on the hub's key there.
    assert_eq!(
        setup.runs_on(&person("p_cccccccc"), Some(&lab)),
        account("hub")
    );
    setup
        .choices
        .insert(pid("p_cccccccc"), ClaudeChoice::Subscription);
    let there = setup.runs_on(&person("p_cccccccc"), Some(&lab));
    assert!(refused(&there).contains("isn't on lab"), "{there:?}");
    // Anywhere, it runs: on mac.
    assert_eq!(
        setup.runs_on(&person("p_cccccccc"), None),
        account("p_cccccccc")
    );
    // The hub's key on mac only: the lead on lab takes the owner's subscription there.
    setup.hub_api = Some(api(&["mac"]));
    assert_eq!(
        setup.runs_on(&Whose::Hub, Some(&lab)),
        account("p_aaaaaaaa")
    );
    setup.subscriptions.remove(&pid("p_aaaaaaaa"));
    assert!(
        refused(&setup.runs_on(&Whose::Hub, Some(&lab))).contains("hub's API key isn't on lab")
    );
}

#[test]
fn with_only_members_subscriptions_leads_keep_the_machines_own_login() {
    let setup = Setup {
        subscriptions: BTreeMap::from([(pid("p_cccccccc"), subscription(&["lab"]))]),
        ..team()
    };
    assert_eq!(
        setup.runs_on(&Whose::Hub, Some(&lab())),
        ClaudeRunsOn::MachineLogin
    );
    assert_eq!(
        refused(&setup.runs_on(&person("p_aaaaaaaa"), Some(&lab()))),
        CONNECT_REFUSAL
    );
}

#[test]
fn a_launch_refuses_an_account_on_a_node_too_old_to_run_one() {
    let setup = Setup {
        hub_api: Some(api(&["lab"])),
        ..team()
    };
    let refused = super::launch_account(&setup, &Whose::Hub, &lab(), || false).unwrap_err();
    assert!(refused.message.contains("too old"), "{refused:?}");
    assert_eq!(
        super::launch_account(&setup, &Whose::Hub, &lab(), || true),
        Ok(Some(ClaudeAccount::Hub))
    );
    // The machine's own login needs nothing new of the node.
    assert_eq!(
        super::launch_account(&team(), &Whose::Hub, &lab(), || false),
        Ok(None)
    );
}

// Over a real hub.

fn machine(hub: &Hub, id: &str) {
    let machine = serde_json::from_value(json!({
        "machineId": id, "name": id, "tags": [], "status": "online", "lastSeenAt": AT, "nodeVersion": "0.1.0",
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, None).unwrap();
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
    machine(&hub, "lab");
    (hub, home)
}

fn people(hub: &Hub) -> People {
    People::new(hub.db.clone(), hub.clock.clone())
}

/// A device of `person`, an admin's on every machine when they administer, else operate.
fn device(hub: &Hub, person: &PersonId, role: &str) -> Caller {
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": role, "machines": "*" }])).unwrap();
    hub.auth
        .create_key_for("desk", &grants, KeyKind::Human, Some(person))
        .unwrap()
        .info
}

fn member(hub: &Hub, name: &str) -> PersonId {
    people(hub)
        .create(&PersonName::unchecked(name), HubRole::Member)
        .unwrap()
        .person_id
}

fn owner(hub: &Hub) -> PersonId {
    people(hub).ensure_owner().unwrap().person_id
}

fn order(
    hub: &Hub,
    r: &ProjectRef,
    by: Option<&PersonId>,
) -> fleetd_contracts::ledger::WorkstreamId {
    let records = &hub.leads.records;
    let (w, _) = records
        .workstream_create(NewWorkstream {
            project_ref: r.clone(),
            title: "Ship it".into(),
            text: "Ship it".into(),
            channel: fleetd_contracts::ledger::IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    let started_by = by.map(|id| people(hub).person_ref(id).unwrap().unwrap());
    records
        .workstream_put(&fleetd_contracts::ledger::Workstream {
            started_by,
            ..w.clone()
        })
        .unwrap();
    w.workstream_id
}

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: lab(),
        project_id: ProjectId::unchecked("p1"),
    }
}

async fn call(
    hub: &Arc<Hub>,
    caller: &Caller,
    tool: &str,
    input: Value,
) -> Result<Value, CallError> {
    registry().call(hub, caller, tool, input).await
}

/// Every text value of every row of every table.
fn every_row(hub: &Hub) -> String {
    hub.db
        .with(|c| {
            let tables: Vec<String> = c
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            let mut out = String::new();
            for table in tables {
                let mut stmt = c.prepare(&format!("SELECT * FROM \"{table}\""))?;
                let n = stmt.column_count();
                let mut rows = stmt.query([])?;
                while let Some(row) = rows.next()? {
                    for i in 0..n {
                        if let rusqlite::types::ValueRef::Text(t) = row.get_ref(i)? {
                            out.push_str(&String::from_utf8_lossy(t));
                            out.push('\n');
                        }
                    }
                }
            }
            Ok(out)
        })
        .unwrap()
}

fn sealed(value: &str) -> String {
    use base64::Engine;
    let secret = crypto_box::SecretKey::generate(&mut crypto_box::aead::OsRng);
    let boxed = secret
        .public_key()
        .seal(&mut crypto_box::aead::OsRng, value.as_bytes())
        .unwrap();
    base64::engine::general_purpose::STANDARD.encode(boxed)
}

/// Links a node holding project p1 that answers account calls as a node would (a test fails with the token
/// masked), handing each call to the test.
async fn node(hub: &Arc<Hub>, caps: &[&str]) -> mpsc::UnboundedReceiver<SessionCall> {
    let (tx, mut rx) = mpsc::unbounded_channel();
    hub.executors
        .attach(
            &lab(),
            crate::hub::executor::NodeSessions {
                link_id: 1,
                send: tx,
            },
        )
        .await;
    let HubToNode::SessionCall(subscribe) = rx.recv().await.unwrap() else {
        panic!("not a subscribe")
    };
    let frame = |v: Value| {
        hub.executors
            .handle_frame(&lab(), serde_json::from_value::<NodeToHub>(v).unwrap())
    };
    let project =
        json!({ "projectId": "p1", "title": "app", "workspaceRoot": "/work/app", "updatedAt": AT });
    frame(
        json!({ "t": "machine_event", "seq": 1, "at": AT, "event": { "type": "snapshot",
        "projects": [project], "sessions": [] } }),
    );
    frame(
        json!({ "t": "session_reply", "id": subscribe.id, "result": { "ok": { "kind": "done" } } }),
    );
    hub.executors.await_live(&lab()).await;
    hub.link.set_capabilities(&lab(), caps);
    let (calls_tx, calls) = mpsc::unbounded_channel();
    let hub = hub.clone();
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let result = match &f.call {
                SessionCall::ClaudeAccountSecret { set: Some(_), .. } => {
                    json!({ "ok": { "kind": "claude_account_saved", "fingerprint": "5ec2e7a1" } })
                }
                SessionCall::ClaudeAccountSecret { set: None, .. } => {
                    json!({ "ok": { "kind": "claude_account_saved" } })
                }
                SessionCall::ReadFile { .. } => json!({ "ok": { "kind": "file" } }),
                SessionCall::ClaudeAccountTest { .. } => {
                    json!({ "ok": { "kind": "claude_account_tested",
                    "ok": false, "error": "Invalid API key: ***CLAUDE_CODE_OAUTH_TOKEN***" } })
                }
                _ => json!({ "ok": { "kind": "done" } }),
            };
            let reply = json!({ "t": "session_reply", "id": f.id, "result": result });
            hub.executors
                .handle_frame(&lab(), serde_json::from_value::<NodeToHub>(reply).unwrap());
            let _ = calls_tx.send(f.call);
        }
    });
    calls
}

#[tokio::test]
async fn whose_work_an_order_a_lead_and_a_navi_are() {
    let (hub, _home) = hub();
    owner(&hub);
    let bob = member(&hub, "Bob");
    let gone = member(&hub, "Gone");
    let setup = hub.db.claude_accounts().setup().unwrap();
    let r = project();
    let mine = order(&hub, &r, Some(&bob));
    assert_eq!(
        whose_for_task(&hub.db, &setup, &r, Some(&mine)).unwrap(),
        Whose::Person(bob.clone())
    );
    // An automation's or a train fix's order has no starter: the hub's.
    let nobodys = order(&hub, &r, None);
    assert_eq!(
        whose_for_task(&hub.db, &setup, &r, Some(&nobodys)).unwrap(),
        Whose::Hub
    );
    // Someone since removed counts as nobody.
    let theirs = order(&hub, &r, Some(&gone));
    people(&hub).remove(&gone).unwrap();
    let setup = hub.db.claude_accounts().setup().unwrap();
    assert_eq!(
        whose_for_task(&hub.db, &setup, &r, Some(&theirs)).unwrap(),
        Whose::Hub
    );
    // A project's lead serves everyone; a Navi's is its owner's, whoever's key made it.
    assert_eq!(whose_for_lead(&hub.db, &setup, &r).unwrap(), Whose::Hub);
    let key = device(&hub, &bob, "operate");
    let navi = ProjectRef {
        machine_id: lab(),
        project_id: ProjectId::unchecked("navi-bob"),
    };
    hub.db
        .with(|c| {
            crate::hub::navi::store::put(
                c,
                &navi,
                &fleetd_contracts::model::ProjectCreator {
                    key_id: key.key_id.to_string(),
                    name: "desk".into(),
                },
                Some(&bob),
                0,
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        whose_for_lead(&hub.db, &setup, &navi).unwrap(),
        Whose::Person(bob)
    );
}

#[tokio::test]
async fn only_admins_set_the_hubs_api_and_its_key_reaches_the_nodes_sealed_never_the_hub() {
    let (hub, _home) = hub();
    let ann = owner(&hub);
    let bob = member(&hub, "Bob");
    let mut calls = node(&hub, &[CAP_CLAUDE_ACCOUNTS]).await;
    let boxed = sealed("sk-ant-api03-never-on-the-hub");
    let input = json!({ "sealed": [{ "machineId": "lab", "sealed": boxed }],
        "endpoint": "https://gateway.devbox.example" });
    let error = call(
        &hub,
        &device(&hub, &bob, "operate"),
        "claude_hub_api_set",
        input.clone(),
    )
    .await
    .unwrap_err();
    assert!(format!("{error:?}").contains("Forbidden"), "{error:?}");
    let admin = device(&hub, &ann, "admin");
    let out = call(&hub, &admin, "claude_hub_api_set", input)
        .await
        .unwrap();
    assert_eq!(out["hubApi"]["sealedOn"][0]["fingerprint"], "5ec2e7a1");
    assert_eq!(out["hubApi"]["endpoint"], "https://gateway.devbox.example");
    let SessionCall::ClaudeAccountSecret { account, set } = calls.recv().await.unwrap() else {
        panic!("not an account secret");
    };
    assert_eq!(account, ClaudeAccount::Hub);
    assert_eq!(set.unwrap().sealed.unwrap().as_str(), boxed);
    assert!(!every_row(&hub).contains(&boxed), "the box is never kept");
    // Leads run on it now; members may use it by default, until the switch says otherwise.
    let got = call(
        &hub,
        &device(&hub, &bob, "operate"),
        "claude_accounts_get",
        json!({}),
    )
    .await
    .unwrap();
    assert_eq!(
        got["leadsRunOn"],
        json!({ "kind": "account", "account": { "kind": "hub" } })
    );
    assert_eq!(got["me"]["runsOn"]["account"]["kind"], "hub");
    assert_eq!(got["people"], json!([]), "a member sees only their own");
    call(
        &hub,
        &admin,
        "claude_settings_set",
        json!({ "membersUseHubApi": false }),
    )
    .await
    .unwrap();
    let got = call(
        &hub,
        &device(&hub, &bob, "operate"),
        "claude_accounts_get",
        json!({}),
    )
    .await
    .unwrap();
    assert_eq!(got["me"]["runsOn"]["kind"], "refused");
    assert_eq!(got["me"]["runsOn"]["message"], CONNECT_REFUSAL);
    // Removing it makes each node forget it.
    call(&hub, &admin, "claude_hub_api_remove", json!({}))
        .await
        .unwrap();
    assert!(matches!(
        calls.recv().await.unwrap(),
        SessionCall::ClaudeAccountSecret {
            account: ClaudeAccount::Hub,
            set: None
        }
    ));
}

#[tokio::test]
async fn a_person_connects_their_own_subscription_tests_it_and_it_goes_with_them() {
    let (hub, _home) = hub();
    let ann = owner(&hub);
    let bob = member(&hub, "Bob");
    let mut calls = node(&hub, &[CAP_CLAUDE_ACCOUNTS]).await;
    let desk = device(&hub, &bob, "operate");
    // An agent's key has no person: it never connects anything.
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..desk.clone()
    };
    let boxed = sealed(TOKEN);
    let input = json!({ "sealed": [{ "machineId": "lab", "sealed": boxed }] });
    assert!(
        call(&hub, &agent, "claude_subscription_set", input.clone())
            .await
            .is_err()
    );
    let out = call(&hub, &desk, "claude_subscription_set", input)
        .await
        .unwrap();
    assert_eq!(out["me"]["runsOn"]["account"]["personId"], bob.as_str());
    let SessionCall::ClaudeAccountSecret { account, .. } = calls.recv().await.unwrap() else {
        panic!("not an account secret");
    };
    assert_eq!(
        account,
        ClaudeAccount::Person {
            person_id: bob.clone()
        }
    );
    assert!(!every_row(&hub).contains(&boxed));
    // Test: one claude -p call on the node, its words masked there, recorded on the subscription.
    let tested = call(
        &hub,
        &desk,
        "claude_account_test",
        json!({ "account": "mine" }),
    )
    .await
    .unwrap();
    assert_eq!(tested["test"]["ok"], false);
    assert_eq!(
        tested["test"]["error"],
        "Invalid API key: ***CLAUDE_CODE_OAUTH_TOKEN***"
    );
    assert!(matches!(
        calls.recv().await.unwrap(),
        SessionCall::ClaudeAccountTest { .. }
    ));
    let subscription = hub
        .db
        .claude_accounts()
        .subscription(&bob)
        .unwrap()
        .unwrap();
    assert!(!subscription.last_test.unwrap().ok);
    // The hub's key is the admins' to test.
    assert!(
        call(
            &hub,
            &desk,
            "claude_account_test",
            json!({ "account": "hub_api" })
        )
        .await
        .is_err()
    );
    // The choice: the hub's API, which Bob may not use while there is none.
    let chose = call(
        &hub,
        &desk,
        "claude_choice_set",
        json!({ "choice": "hub_api" }),
    )
    .await
    .unwrap();
    assert_eq!(chose["me"]["runsOn"]["message"], CONNECT_REFUSAL);
    // Removed from the hub, his subscription is forgotten everywhere.
    call(
        &hub,
        &device(&hub, &ann, "admin"),
        "person_remove",
        json!({ "personId": bob.as_str() }),
    )
    .await
    .unwrap();
    assert!(matches!(
        calls.recv().await.unwrap(),
        SessionCall::ClaudeAccountSecret { set: None, .. }
    ));
    assert!(
        hub.db
            .claude_accounts()
            .subscription(&bob)
            .unwrap()
            .is_none()
    );
}

fn request(order: fleetd_contracts::ledger::WorkstreamId, id: &str) -> LaunchRequest {
    LaunchRequest {
        project_id: ProjectId::unchecked("p1"),
        project_ref: project(),
        repo_id: None,
        prompt: "go".into(),
        profile: fleetd_contracts::effort::ProfileName::legacy(),
        title: "T1: go".into(),
        client_request_id: id.into(),
        kind: fleetd_contracts::tasks::TaskKind::Write,
        worktree: None,
        order_id: Some(order),
    }
}

async fn launched(
    calls: &mut mpsc::UnboundedReceiver<SessionCall>,
) -> fleetd_contracts::sessions::SessionLaunch {
    loop {
        if let SessionCall::Launch(launch) = calls.recv().await.unwrap() {
            return launch;
        }
    }
}

#[tokio::test]
async fn each_task_runs_on_its_order_starters_account_recorded_for_its_usage() {
    let (hub, _home) = hub();
    owner(&hub);
    let bob = member(&hub, "Bob");
    let cy = member(&hub, "Cy");
    let store = hub.db.claude_accounts();
    store
        .put_subscription(&cy, &subscription(&["lab"]))
        .unwrap();
    let mut calls = node(&hub, &[CAP_CLAUDE_ACCOUNTS]).await;
    let ports = crate::hub::tasks::wire::HubTaskPorts::new(
        hub.executors.clone(),
        hub.node_commands.clone(),
    );
    ports.bind(&hub);
    let r = project();
    // Cy's order runs on her subscription, and the thread is recorded as hers.
    let cys = order(&hub, &r, Some(&cy));
    let (thread, _) = ports
        .launch(&lab(), request(cys.clone(), "c1"))
        .await
        .unwrap();
    let launch = launched(&mut calls).await;
    assert_eq!(
        launch.claude_account,
        Some(ClaudeAccount::Person {
            person_id: cy.clone()
        })
    );
    assert_eq!(
        store.thread_account("lab", thread.as_str()).unwrap(),
        Some(ClaudeAccount::Person {
            person_id: cy.clone()
        })
    );
    assert_eq!(
        ports.claude_account_key(&r, &cys, &lab()).as_deref(),
        Some(cy.as_str())
    );
    // Bob's order: refused in plain words before any agent starts, and at a launch; never Cy's subscription.
    let bobs = order(&hub, &r, Some(&bob));
    let (message, fix) = ports.claude_refusal(&r, &bobs).unwrap();
    assert_eq!(message, CONNECT_REFUSAL);
    assert!(fix.contains("claude setup-token"), "{fix}");
    let Err(PortError::Failed(why)) = ports.launch(&lab(), request(bobs, "b1")).await else {
        panic!("Bob's order launched");
    };
    assert!(why.starts_with(CONNECT_REFUSAL), "{why}");
    // Work nobody started takes the hub's way: with no key and no owner's subscription, the machine's own login.
    let nobodys = order(&hub, &r, None);
    assert!(ports.claude_refusal(&r, &nobodys).is_none());
    ports.launch(&lab(), request(nobodys, "n1")).await.unwrap();
    assert_eq!(launched(&mut calls).await.claude_account, None);
}

#[tokio::test]
async fn a_node_too_old_for_accounts_never_runs_one_persons_work_on_its_own_login() {
    let (hub, _home) = hub();
    owner(&hub);
    let cy = member(&hub, "Cy");
    hub.db
        .claude_accounts()
        .put_subscription(&cy, &subscription(&["lab"]))
        .unwrap();
    let _calls = node(&hub, &[]).await;
    let ports = crate::hub::tasks::wire::HubTaskPorts::new(
        hub.executors.clone(),
        hub.node_commands.clone(),
    );
    ports.bind(&hub);
    let cys = order(&hub, &project(), Some(&cy));
    let Err(PortError::Failed(why)) = ports.launch(&lab(), request(cys, "c1")).await else {
        panic!("launched on an old node");
    };
    assert!(why.contains("too old"), "{why}");
}
