//! The setup steps: their values computed for the hub, their status read from the checks (one way done is enough),
//! and the tools over a real hub: an admin's only, a required step never put off, a skip kept and taken back.
use std::collections::BTreeSet;
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

fn status_of(checks: &[DoctorCheck], skipped: &[SetupStepId]) -> Vec<(SetupStepId, SetupStatus)> {
    let skipped: BTreeSet<_> = skipped.iter().copied().collect();
    read(guides(HUB), checks, &skipped)
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
    // Google: a Desktop app client with the loopback redirect, so a plain-HTTP tailnet hub needs nothing registered.
    let google = steps.iter().find(|s| s.id == SetupStepId::Google).unwrap();
    let values: Vec<_> = google.parts.iter().flat_map(|p| &p.values).collect();
    let find = |label: &str| {
        values
            .iter()
            .find(|v| v.label == label)
            .map(|v| v.value.as_str())
    };
    assert_eq!(find("Project name"), Some("fleetd-devbox"));
    assert_eq!(find("App name"), Some("fleetd on devbox"));
    assert_eq!(find("Redirect URI"), Some("http://127.0.0.1"));
    assert_eq!(find("Subscription ID"), Some("fleetd-gmail-hub"));
    assert_eq!(
        find("Subscriber on the subscription"),
        Some("fleetd-gmail-reader@fleetd-devbox.iam.gserviceaccount.com")
    );
    assert_eq!(google.place.as_deref(), Some("google"));
    // Its secrets are saved where the app seals them, never typed into the step.
    assert!(
        steps
            .iter()
            .all(|s| s.fields.iter().all(|f| f.secret != Some(true)))
    );
    // The Cloud project id keeps to Google's rules, whatever the host is called.
    assert_eq!(super::cloud_project("DevBox"), "fleetd-devbox");
    assert_eq!(
        super::cloud_project("my_very-long-machine-name-here"),
        "fleetd-my-very-long-machine-na"
    );
    assert_eq!(
        super::cloud_project("box-name-that-ends-on-dash-here-x"),
        "fleetd-box-name-that-ends-on-d"
    );
    assert_eq!(
        super::cloud_project("a-b-c-d-e-f-g-h-i-j-k-l-m-"),
        "fleetd-a-b-c-d-e-f-g-h-i-j-k-l"
    );
    // A hub reached by address names itself "hub".
    assert_eq!(
        guides("http://100.64.0.7:4790")[5].parts[0].values[0].value,
        "fleetd-hub"
    );
}

#[test]
fn a_step_is_todo_until_a_check_says_otherwise_and_skipping_is_only_kept_for_todo() {
    use SetupStatus::*;
    use SetupStepId::*;
    assert_eq!(
        status_of(&[], &[Google]),
        [
            (Address, Todo),
            (Machines, Todo),
            (Claude, Todo),
            (Github, Todo),
            (People, Todo),
            (Google, Skipped),
            (Notion, Todo),
        ]
    );
    let checks = [
        check("hub/reachable", DoctorStatus::Ok, "The hub answers."),
        check("hub/https", DoctorStatus::Ok, "Plain HTTP is fine."),
        check("devbox/online", DoctorStatus::Ok, "devbox is online."),
        check("lab/online", DoctorStatus::Fail, "lab is offline."),
        check(
            "hub/gh_auth",
            DoctorStatus::Ok,
            "gh is logged in on the hub as dev.",
        ),
        check(
            "hub/google",
            DoctorStatus::Warn,
            "Google client … but lab lacks its secret.",
        ),
    ];
    let steps = read(guides(HUB), &checks, &[Google].into_iter().collect());
    let get = |id| steps.iter().find(|s| s.id == id).unwrap();
    assert_eq!(get(Address).status, Done);
    // The worst of a way's checks decides: one machine offline wants a look, and says which.
    assert_eq!(get(Machines).status, Look);
    assert_eq!(get(Machines).said.as_deref(), Some("lab is offline."));
    assert_eq!(get(Github).status, Done);
    // Set up but failing is never hidden as "later".
    assert_eq!(get(Google).status, Look);
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
        read(guides(HUB), checks, &BTreeSet::new())
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
async fn the_tools_are_an_admins_and_keep_only_what_was_put_off() {
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
    assert_eq!(steps.len(), 7);
    assert_eq!(steps[0]["parts"][0]["values"][0]["value"], HUB);
    // No machines yet, so machines and Claude are left at least.
    assert!(list["requiredLeft"].as_i64().unwrap() >= 2, "{list}");
    assert_eq!(steps[5]["id"], "google");
    assert_eq!(steps[5]["status"], "todo");

    let why = format!(
        "{:?}",
        call(
            &hub,
            &admin,
            "setup_skip",
            json!({ "step": "machines", "skipped": true })
        )
        .await
        .unwrap_err()
    );
    assert!(why.contains("is required"), "{why}");

    let skipped = call(
        &hub,
        &admin,
        "setup_skip",
        json!({ "step": "google", "skipped": true }),
    )
    .await
    .unwrap();
    assert_eq!(skipped["step"]["status"], "skipped");
    let list = call(&hub, &admin, "setup_list", json!({})).await.unwrap();
    assert_eq!(list["steps"][5]["status"], "skipped");
    let back = call(
        &hub,
        &admin,
        "setup_skip",
        json!({ "step": "google", "skipped": false }),
    )
    .await
    .unwrap();
    assert_eq!(back["step"]["status"], "todo");

    // The hub's API key, saved and tested (Administration › Claude), is enough for Claude though no machine is
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
