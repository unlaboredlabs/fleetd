//! The setup steps: their values computed for the hub, their status read from the checks (one way done is enough),
//! and the tools over a real hub: an admin's only.
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::claude_accounts::ClaudeHubApi;
use fleetd_contracts::people::{HubRole, PersonName};
use fleetd_contracts::setup::{SetupStatus, SetupStepId};
use serde_json::{Value, json};

use super::{guides, read};
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::doctor::checks::{DoctorCheck, DoctorStatus};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const HUB: &str = "http://devbox.your-tailnet.ts.net:4790";

fn check(id: &str, status: DoctorStatus, message: &str) -> DoctorCheck {
    DoctorCheck {
        id: id.into(),
        scope: if id.starts_with("hub/") {
            "hub"
        } else {
            "machine"
        }
        .into(),
        machine_id: id
            .split_once('/')
            .filter(|(m, _)| *m != "hub")
            .map(|(m, _)| m.to_owned()),
        status,
        message: message.into(),
        fix: None,
    }
}

fn status_of(checks: &[DoctorCheck]) -> Vec<(SetupStepId, SetupStatus)> {
    read(guides(HUB), checks)
        .into_iter()
        .map(|s| (s.id, s.status))
        .collect()
}

#[test]
fn values_are_computed_for_this_hub_and_work_on_plain_http() {
    let steps = guides(HUB);
    let ids: Vec<_> = steps.iter().map(|s| s.id).collect();
    assert_eq!(ids, SetupStepId::ALL);
    let address = &steps[0].parts[0].values[0];
    assert_eq!(address.value, HUB);
    let machines = &steps[1].parts[0].values[1];
    assert_eq!(
        machines.value,
        format!("fleetd init --join {HUB} --code <code>")
    );
    // The Claude key is named for this hub, and a hub reached by address names itself "hub".
    let key_name = |steps: &[fleetd_contracts::setup::HubSetupStep]| {
        steps[2]
            .parts
            .iter()
            .flat_map(|p| &p.values)
            .find(|v| v.label == "Key name")
            .map(|v| v.value.clone())
    };
    assert_eq!(key_name(&steps).as_deref(), Some("fleetd on devbox"));
    assert_eq!(
        key_name(&guides("http://100.64.0.7:4790")).as_deref(),
        Some("fleetd on hub")
    );
    // Secrets are saved where the app seals them, never typed into a step.
    assert!(
        steps
            .iter()
            .all(|s| s.fields.iter().all(|f| f.secret != Some(true)))
    );
}

#[test]
fn a_step_is_todo_until_a_check_says_otherwise_and_skipping_is_only_kept_for_todo() {
    use SetupStatus::*;
    use SetupStepId::*;
    assert_eq!(
        status_of(&[]),
        [
            (Address, Todo),
            (Machines, Todo),
            (Claude, Todo),
            (Github, Todo),
            (People, Todo),
        ]
    );
    let checks = [
        check("hub/reachable", DoctorStatus::Ok, "The hub answers."),
        check("hub/https", DoctorStatus::Ok, "Plain HTTP is fine."),
        check("devbox/online", DoctorStatus::Ok, "devbox is online."),
        check("lab/online", DoctorStatus::Fail, "lab is offline."),
        check(
            "hub/gh_auth",
            DoctorStatus::Warn,
            "gh's token on the hub expires tomorrow.",
        ),
    ];
    let steps = read(guides(HUB), &checks);
    let get = |id| steps.iter().find(|s| s.id == id).unwrap();
    assert_eq!(get(Address).status, Done);
    // The worst of a way's checks decides: one machine offline wants a look, and says which.
    assert_eq!(get(Machines).status, Look);
    assert_eq!(get(Machines).said.as_deref(), Some("lab is offline."));
    assert_eq!(get(Github).status, Look);
}

#[test]
fn github_is_to_do_not_failing_before_any_project_can_open_a_pr() {
    let gh = [check(
        "hub/gh_auth",
        DoctorStatus::Fail,
        "gh is not logged in on the hub.",
    )];
    let github = |projects| {
        read(guides(HUB), &super::before_first_use(gh.to_vec(), projects))
            .into_iter()
            .find(|s| s.id == SetupStepId::Github)
            .unwrap()
    };
    let fresh = github(0);
    assert_eq!((fresh.status, fresh.failing), (SetupStatus::Todo, None));
    assert_eq!(
        fresh.said.as_deref(),
        Some("gh is not logged in on the hub.")
    );
    // With a project of code, a PR can open: logged out is broken.
    let live = github(1);
    assert_eq!((live.status, live.failing), (SetupStatus::Look, Some(true)));
}

#[test]
fn claude_is_done_by_any_one_of_its_ways_and_says_which() {
    let logins = [
        check(
            "devbox/claude_login",
            DoctorStatus::Ok,
            "devbox: logged in.",
        ),
        check(
            "lab/claude_login",
            DoctorStatus::Fail,
            "lab: logged out, so its sessions can't start.",
        ),
    ];
    let claude = |checks: &[DoctorCheck]| {
        read(guides(HUB), checks)
            .into_iter()
            .find(|s| s.id == SetupStepId::Claude)
            .unwrap()
    };
    let step = claude(&logins);
    assert_eq!(step.status, SetupStatus::Look);
    assert_eq!(step.way.as_deref(), Some("each machine's own login"));
    assert_eq!(
        step.said.as_deref(),
        Some("lab: logged out, so its sessions can't start.")
    );
    // The hub's key, once its check is there, is enough: logged-out machines don't hold the step back.
    let mut with_key = logins.to_vec();
    with_key.push(check(
        "hub/claude_key",
        DoctorStatus::Ok,
        "The hub's key …abcd works.",
    ));
    let step = claude(&with_key);
    assert_eq!(
        (step.status, step.way.as_deref()),
        (SetupStatus::Done, Some("the hub's API key"))
    );
    assert_eq!(step.fix, None);
    // A key not set up yet ("unknown") leaves the logins deciding.
    let mut unset = logins.to_vec();
    unset.push(check("hub/claude_key", DoctorStatus::Unknown, "No key."));
    assert_eq!(claude(&unset).status, SetupStatus::Look);
}

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    // A port nothing listens on: the doctor's reachability probe stays on this machine and finds nothing.
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen {
            host: "127.0.0.1".into(),
            port: 9,
        },
        url: Some(HUB.into()),
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    hub.ops.bind(&hub);
    (hub, home)
}

fn caller(role: &str) -> Caller {
    serde_json::from_value(json!({
        "keyId": "k1", "name": "cli", "prefix": "fld_abcdef", "createdAt": "2026-10-19T10:00:00.000Z",
        "grants": [{ "role": role, "machines": "*" }],
    }))
    .unwrap()
}

async fn call(
    hub: &Arc<Hub>,
    caller: &Caller,
    tool: &str,
    input: Value,
) -> Result<Value, CallError> {
    registry().call(hub, caller, tool, input).await
}

#[tokio::test]
async fn the_tools_are_an_admins() {
    let (hub, _home) = hub();
    let admin = caller("admin");
    let why = format!(
        "{:?}",
        call(&hub, &caller("operate"), "setup_list", json!({}))
            .await
            .unwrap_err()
    );
    assert!(why.contains("admin role"), "{why}");

    let list = call(&hub, &admin, "setup_list", json!({})).await.unwrap();
    let steps = list["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 5);
    assert_eq!(steps[0]["parts"][0]["values"][0]["value"], HUB);
    // No machines yet, so machines and Claude are left at least.
    assert!(list["requiredLeft"].as_i64().unwrap() >= 2, "{list}");
    assert_eq!(steps[4]["id"], "people");
    assert_eq!(steps[4]["status"], "todo");

    // The hub's API key, saved and tested (Settings › Hub accounts › Claude), is enough for Claude though no machine is
    // logged in: read fresh, without a doctor run.
    let list = call(&hub, &admin, "setup_list", json!({})).await.unwrap();
    assert_eq!(list["steps"][2]["status"], "todo", "{}", list["steps"][2]);
    let api: ClaudeHubApi = serde_json::from_value(json!({
        "sealedOn": [], "updatedAt": "2026-10-19T10:00:00.000Z",
        "lastTest": { "at": "2026-10-19T10:00:00.000Z", "machineId": "devbox", "ok": true },
    }))
    .unwrap();
    hub.db.claude_accounts().put_hub_api(&api).unwrap();
    let list = call(&hub, &admin, "setup_list", json!({})).await.unwrap();
    let claude = &list["steps"][2];
    assert_eq!(claude["status"], "done", "{claude}");
    assert_eq!(claude["way"], "the hub's API key");
    assert_eq!(
        claude["said"],
        "The hub's Claude API key works: tested on devbox."
    );
    assert_eq!(claude["place"], "claude");
    // A failed Test makes it fail, and required again.
    let failed: ClaudeHubApi = serde_json::from_value(json!({
        "sealedOn": [], "updatedAt": "2026-10-19T10:00:00.000Z",
        "lastTest": { "at": "2026-10-19T10:00:00.000Z", "machineId": "devbox", "ok": false, "error": "401" },
    }))
    .unwrap();
    hub.db.claude_accounts().put_hub_api(&failed).unwrap();
    let list = call(&hub, &admin, "setup_list", json!({})).await.unwrap();
    assert_eq!(
        (&list["steps"][2]["status"], &list["steps"][2]["failing"]),
        (&json!("look"), &json!(true))
    );

    // Someone invited hasn't joined until a device of theirs pairs; then People reads done at once, without a doctor
    // run.
    let people = crate::hub::people::People::new(hub.db.clone(), hub.clock.clone());
    people.ensure_owner().unwrap();
    let alice = people
        .create(&PersonName::unchecked("Alice"), HubRole::Member)
        .unwrap();
    let list = call(&hub, &admin, "setup_list", json!({})).await.unwrap();
    assert_eq!(list["steps"][4]["status"], "todo", "{}", list["steps"][4]);
    hub.auth
        .create_key_for(
            "alice's laptop",
            &[],
            KeyKind::Human,
            Some(&alice.person_id),
        )
        .unwrap();
    let list = call(&hub, &admin, "setup_list", json!({})).await.unwrap();
    assert_eq!(list["steps"][4]["status"], "done", "{}", list["steps"][4]);
    assert_eq!(list["steps"][4]["said"], "Alice has joined.");
}
