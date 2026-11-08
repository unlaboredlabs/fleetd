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
    // A hub only this machine reaches stays done, and says what that rules out, with the way to change it.
    let only_here = guides("http://127.0.0.1:4790")[0].parts[0].values[0]
        .note
        .clone()
        .unwrap();
    assert!(
        only_here.starts_with("Only this machine can reach the hub"),
        "{only_here}"
    );
    assert!(
        only_here.contains("fleetd init --listen <ip>:<port>"),
        "{only_here}"
    );
    assert!(
        address
            .note
            .as_deref()
            .is_some_and(|n| n.starts_with("Another address"))
    );
    // The hub's own machine and another one, each with what runs where: no `fleetd init` to send you back to.
    let machines: Vec<_> = steps[1].parts[0]
        .values
        .iter()
        .map(|v| v.value.as_str())
        .collect();
    assert_eq!(
        machines,
        ["fleetd machine add --local", "fleetd pair --worker <name>"]
    );
    let reach = |hub: &str| guides(hub)[1].parts[0].values[1].note.clone();
    assert!(
        reach("http://127.0.0.1:4861").is_some_and(|h| h.contains("no other machine reaches")),
        "a loopback hub says its line works only there"
    );
    assert!(reach(HUB).is_some_and(|h| h.contains("installs fleetd and joins")));
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
            (Onepassword, Todo),
            (People, Todo),
            (Mac, Todo),
            (Cloud, Todo),
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
    // No agents' Mac: its optional step is to do, whatever other machines say.
    assert_eq!(get(Mac).status, Todo);
}

#[test]
fn the_macs_step_is_its_own_checks_and_a_failing_one_wants_a_look() {
    let mac = |checks: &[DoctorCheck]| {
        read(guides(HUB), checks)
            .into_iter()
            .find(|s| s.id == SetupStepId::Mac)
            .unwrap()
    };
    let passing: Vec<_> = fleetd_contracts::node_link::MacCheckId::ALL
        .iter()
        .map(|id| format!("studio/mac_{}", id.as_str()))
        .chain(["studio/mac_one_node".to_owned()])
        .map(|id| check(&id, DoctorStatus::Ok, "fine"))
        .collect();
    assert_eq!(mac(&passing).status, SetupStatus::Done);
    let mut failing = passing.clone();
    failing[1] = check(
        "studio/mac_xcode",
        DoctorStatus::Fail,
        "Xcode's licence isn't accepted, so xcodebuild and simctl refuse to run.",
    );
    let step = mac(&failing);
    assert_eq!((step.status, step.failing), (SetupStatus::Look, Some(true)));
    assert_eq!(
        step.said.as_deref(),
        Some("Xcode's licence isn't accepted, so xcodebuild and simctl refuse to run.")
    );
    // The Xcode block is one paste in the account the Mac joins from, each line said why, and never curl into sudo.
    let block = &step.parts[0].values[0].value;
    assert_eq!(block, super::MAC_ADMIN_BLOCK);
    for line in [
        "sudo xcodebuild -license accept && sudo xcodebuild -runFirstLaunch",
        // Skipped while no Xcode is selected: an empty `xcode-select -p` would test /usr/bin's shim, which every Mac has.
        "d=\"$(xcode-select -p 2>/dev/null)\" && test -x \"$d/usr/bin/xcodebuild\" && sudo",
        "sudo DevToolsSecurity -enable",
        "sudo dseditgroup -o edit -a \"$(id -un)\" -t user _developer",
    ] {
        assert!(block.contains(line), "{line}");
    }
    assert!(!block.contains("curl") && !block.contains("sysadminctl"));
    assert!(block.lines().next().unwrap().starts_with('#'));
    // A user of its own for agents is offered last, and optional (D309).
    let own = step.parts.last().unwrap();
    assert!(own.title.starts_with("Optional"), "{}", own.title);
    assert_eq!(own.values[0].value, super::MAC_USER_BLOCK);
    assert!(super::MAC_USER_BLOCK.contains("sudo sysadminctl -addUser agents"));
    // The hub's own build and channel: the installer installs that version (cli::pair::mac_flags).
    assert!(step.parts[1].values[0].value.ends_with(&format!(
        "--machine-id mac{}",
        crate::cli::pair::mac_flags(crate::version())
    )));
    // So does the other way it offers, `fleetd pair --worker mac` with the flags added.
    let note = step.parts[1].values[0].note.as_deref().unwrap();
    assert!(note.contains(&format!(
        "then add{} to the line",
        crate::cli::pair::mac_flags(crate::version())
    )));
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
    assert_eq!(steps.len(), 8);
    assert_eq!(steps[0]["parts"][0]["values"][0]["value"], HUB);
    // No machines yet, so machines and Claude are left at least.
    assert!(list["requiredLeft"].as_i64().unwrap() >= 2, "{list}");
    assert_eq!(steps[5]["id"], "people");
    assert_eq!(steps[5]["status"], "todo");

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
    assert_eq!(list["steps"][5]["status"], "todo", "{}", list["steps"][5]);
    hub.auth
        .create_key_for(
            "alice's laptop",
            &[],
            KeyKind::Human,
            Some(&alice.person_id),
        )
        .unwrap();
    let list = call(&hub, &admin, "setup_list", json!({})).await.unwrap();
    assert_eq!(list["steps"][5]["status"], "done", "{}", list["steps"][5]);
    assert_eq!(list["steps"][5]["said"], "Alice has joined.");
}

/// The agents' Mac runs no claude: the doctor never asks its node about one, from its hello on, before its first
/// heartbeat says how its own checks stand, and while it is offline.
#[tokio::test]
async fn the_agents_mac_never_gets_a_runners_checks() {
    let (hub, _home) = hub();
    for status in ["online", "offline"] {
        let machine = serde_json::from_value(json!({
            "machineId": "studio", "name": "studio", "tags": [], "status": status,
            "lastSeenAt": "2026-10-26T10:00:00.000Z", "nodeVersion": "0.1.0", "agentsMac": true,
        }))
        .unwrap();
        hub.store.machine_upsert(&machine, None).unwrap();
        let step = call(
            &hub,
            &caller("admin"),
            "setup_test",
            json!({ "step": "mac" }),
        )
        .await
        .unwrap();
        assert_eq!(step["step"]["id"], "mac");
        let ids: Vec<String> = hub
            .doctor
            .list(false)
            .await
            .checks
            .into_iter()
            .filter(|c| c.machine_id.as_deref() == Some("studio"))
            .map(|c| c.id)
            .collect();
        assert!(
            ids.contains(&"studio/online".to_owned()),
            "{status}: {ids:?}"
        );
        for id in &ids {
            assert!(
                !id.contains("claude") && !id.contains("commit") && !id.contains("usage"),
                "{status}: {id}"
            );
        }
    }
}

/// The cloud step: the boat key's exact actions (ssh for the hub's tunnel), scoped to an environment named for this hub;
/// nothing to set up on the network, whatever address the hub has; done only once the key, the way to the hub, the
/// machines and the budget all pass.
#[test]
fn the_cloud_step_gives_the_exact_values_and_is_done_only_when_every_check_passes() {
    let cloud = |hub: &str, checks: &[DoctorCheck]| {
        read(guides(hub), checks)
            .into_iter()
            .find(|s| s.id == SetupStepId::Cloud)
            .unwrap()
    };
    let step = cloud(HUB, &[]);
    assert_eq!(step.need, fleetd_contracts::setup::SetupNeed::Optional);
    assert_eq!(step.place.as_deref(), Some("cloud"));
    let values: Vec<(&str, &str)> = step
        .parts
        .iter()
        .flat_map(|p| &p.values)
        .map(|v| (v.label.as_str(), v.value.as_str()))
        .collect();
    let value = |label: &str| {
        values
            .iter()
            .find(|(l, _)| *l == label)
            .map(|(_, v)| *v)
            .unwrap_or_else(|| panic!("no value {label}: {values:?}"))
    };
    assert_eq!(
        value("Actions"),
        "sandbox.create sandbox.read sandbox.update sandbox.stop sandbox.resume sandbox.delete ssh account.read"
    );
    for forbidden in ["exec", "file.", "snapshot", "admin", "delete-own"] {
        assert!(!value("Actions").contains(forbidden), "{forbidden}");
    }
    assert_eq!(value("Scope: environment"), "fleetd-devbox");
    // Part 5 names the same environment, where the pool's machines are made.
    assert_eq!(value("boat.dev environment"), "fleetd-devbox");
    assert_eq!(value("Billing › Auto top-up"), "Off");
    assert_eq!(value("Billing › Extra starts on invoice"), "Off");
    // A hub only its tailnet or LAN reaches needs nothing more: no public address, Funnel or proxy to set up.
    for hub in [
        HUB,
        "http://192.168.1.20:4790",
        "https://devbox.your-tailnet.ts.net",
    ] {
        let step = cloud(hub, &[]);
        let text: Vec<String> = step
            .parts
            .iter()
            .flat_map(|p| {
                p.values
                    .iter()
                    .flat_map(|v| [v.label.clone(), v.value.clone()])
                    .chain(p.note.clone())
                    .chain([p.title.clone()])
            })
            .collect();
        for word in [
            "funnel",
            "Funnel",
            "public HTTPS",
            "reverse proxy",
            "fleetd init --url",
        ] {
            assert!(!text.iter().any(|t| t.contains(word)), "{hub}: {word}");
        }
    }

    let ok = |name: &str| check(&format!("hub/{name}"), DoctorStatus::Ok, "fine");
    let all = [
        ok("cloud_key"),
        ok("cloud_network"),
        ok("cloud_machines"),
        ok("cloud_budget"),
    ];
    assert_eq!(cloud(HUB, &all).status, SetupStatus::Done);
    // No machines made yet: still to do.
    let mut none_made = all.clone();
    none_made[2] = check(
        "hub/cloud_machines",
        DoctorStatus::Unknown,
        "No cloud machines yet.",
    );
    assert_eq!(cloud(HUB, &none_made).status, SetupStatus::Todo);
    // A refused key fails, and says why.
    let mut refused = all.clone();
    refused[0] = check(
        "hub/cloud_key",
        DoctorStatus::Fail,
        "boat.dev says the key has expired",
    );
    let step = cloud(HUB, &refused);
    assert_eq!((step.status, step.failing), (SetupStatus::Look, Some(true)));
    assert_eq!(
        step.said.as_deref(),
        Some("boat.dev says the key has expired")
    );
}

/// The cloud tools over a real hub: anyone reads the pool, with the environment the step names as its default; only an
/// admin changes it; Create refuses while no environment is saved, before any start, since the key is scoped to one.
#[tokio::test]
async fn cloud_create_waits_for_the_environment_the_key_is_scoped_to() {
    let (hub, _home) = hub();
    let got = call(&hub, &caller("operate"), "cloud_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["cloud"]["environmentDefault"], "fleetd-devbox");
    assert!(got["cloud"].get("environment").is_none(), "{got}");
    let settings =
        json!({ "enabled": false, "poolSize": 3, "machineType": "large", "dayBudget": 3.0 });
    assert!(
        call(&hub, &caller("operate"), "cloud_set", settings.clone())
            .await
            .is_err()
    );
    let why = format!(
        "{:?}",
        call(&hub, &caller("admin"), "cloud_create", json!({}))
            .await
            .unwrap_err()
    );
    assert!(why.contains("No boat.dev environment is saved"), "{why}");
    assert!(why.contains("fleetd-devbox"), "{why}");
    // Saved, it is what the pool creates in.
    let saved = call(
        &hub,
        &caller("admin"),
        "cloud_set",
        json!({ "enabled": false, "poolSize": 3, "machineType": "large", "dayBudget": 3.0, "environment": "fleetd-devbox" }),
    )
    .await
    .unwrap();
    assert_eq!(saved["cloud"]["environment"], "fleetd-devbox");
}

/// Create while starts are held (a backoff, a pause) asks boat nothing and mints no enroll code: each press used to mint
/// one, 13 in 75 seconds while a refusal's hold lasted (W468).
#[tokio::test]
async fn cloud_create_mints_no_enroll_code_while_starts_are_held() {
    let (hub, _home) = hub();
    hub.pool.set_key("boat_test_key").unwrap();
    call(
        &hub,
        &caller("admin"),
        "cloud_set",
        json!({ "enabled": true, "poolSize": 1, "machineType": "large", "dayBudget": 3.0, "environment": "fleetd-devbox" }),
    )
    .await
    .unwrap();
    hub.pool
        .ledger()
        .set_paused(Some(("billing", "boat.dev needs billing attention")))
        .unwrap();
    for _ in 0..3 {
        let out = call(&hub, &caller("admin"), "cloud_create", json!({}))
            .await
            .unwrap();
        assert_eq!(
            out["lines"],
            json!(["boat-1: not created: boat.dev needs billing attention"])
        );
    }
    assert!(hub.auth.open_enroll_tokens().unwrap().is_empty());
}

/// Cloud machines are the hub's, as its other Hub settings are: a key with admin on some machines only changes none of
/// them, nor spends a start, nor stops them.
#[tokio::test]
async fn the_cloud_tools_take_admin_on_every_machine() {
    let (hub, _home) = hub();
    hub.pool.set_key("boat_test_key").unwrap();
    let one_machine: Caller = serde_json::from_value(json!({
        "keyId": "k2", "name": "cli", "prefix": "fld_abcdeg", "createdAt": "2026-10-19T10:00:00.000Z",
        "grants": [{ "role": "admin", "machines": ["devbox"] }],
    }))
    .unwrap();
    let settings = json!({ "enabled": true, "poolSize": 1, "machineType": "large", "dayBudget": 3.0, "environment": "fleetd-devbox" });
    for (tool, input) in [
        ("cloud_set", settings.clone()),
        (
            "cloud_key_set",
            json!({ "sealed": "A".repeat(64) + "AA==" }),
        ),
        ("cloud_test", json!({})),
        ("cloud_create", json!({})),
        ("cloud_reset", json!({ "machineId": "boat-1" })),
        ("cloud_resume", json!({})),
        ("cloud_stop", json!({})),
    ] {
        let why = format!(
            "{:?}",
            call(&hub, &one_machine, tool, input).await.unwrap_err()
        );
        assert!(why.contains("Forbidden"), "{tool}: {why}");
    }
    assert!(
        call(&hub, &caller("admin"), "cloud_set", settings)
            .await
            .is_ok()
    );
}
