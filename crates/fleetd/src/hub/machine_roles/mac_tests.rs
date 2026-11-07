//! The agents' Mac as the hub sees it (mac.rs): never a runner, its switch, and what reaches it.
use std::sync::Arc;

use fleetd_contracts::machine_roles::SessionHost;
use fleetd_contracts::node_link::{
    CAP_AGENTS_MAC, CAP_MAC_TOOL, CAP_SESSION_HOST, CAP_SESSION_SEAL, MacCheck, MacCheckId,
    MacCheckState, MacHealth,
};
use fleetd_contracts::prim::{List, Text};
use serde_json::json;

use super::tests::{AT, NOW_MS, admin, hub_at, mid, remote, route_once, start};
use crate::hub::api::{CallError, Hub};
use crate::hub::store::test_clock::ManualClock;

/// The hub of tests.rs, with mac1 joined as the agents' Mac: its hello listed `agents_mac`, and `mac_tool` too.
fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let (hub, home) = hub_at(ManualClock::at(NOW_MS));
    let machine = serde_json::from_value(json!({
        "machineId": "mac1", "name": "mac1", "tags": [], "status": "online", "lastSeenAt": AT, "nodeVersion": "0.1.0",
        "boxPubKey": "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=", "agentsMac": true,
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, None).unwrap();
    hub.link.set_capabilities(
        &mid("mac1"),
        &[
            CAP_AGENTS_MAC,
            CAP_MAC_TOOL,
            CAP_SESSION_HOST,
            CAP_SESSION_SEAL,
        ],
    );
    hub.slots.keep_tool_only(&mid("mac1")).unwrap();
    (hub, home)
}

async fn tool(
    hub: &Arc<Hub>,
    name: &str,
    input: serde_json::Value,
) -> Result<serde_json::Value, CallError> {
    crate::hub::api::registry()
        .call(hub, &admin(), name, input)
        .await
}

fn message(e: CallError) -> String {
    format!("{e:?}")
}

#[tokio::test]
async fn the_agents_mac_never_runs_agents_whatever_its_roles_say() {
    let (hub, _home) = hub();
    assert_eq!(hub.slots.machine_cap(&mid("mac1")), 0);
    let roles = hub.db.with(|c| super::roles_on(c, &mid("mac1"))).unwrap();
    assert!(
        !roles.agents,
        "kept off in the database, for the hub's next start"
    );
    let refused = tool(
        &hub,
        "machine_roles_set",
        json!({ "machineId": "mac1", "roles": ["agents", "sessions"] }),
    )
    .await
    .unwrap_err();
    assert!(message(refused).contains("never runs agents"));
    assert_eq!(hub.slots.machine_cap(&mid("mac1")), 0);
    // Nor does a project live there.
    let refused = tool(
        &hub,
        "project_add",
        json!({ "machineId": "mac1", "path": "/Users/agents/app" }),
    )
    .await
    .unwrap_err();
    assert!(message(refused).contains("the agents' Mac"));
}

#[tokio::test]
async fn mac_calls_go_to_the_agents_mac_while_its_switch_is_on() {
    let (hub, _home) = hub();
    assert_eq!(super::mac_machine(&hub), Some(mid("mac1")));
    let listed = tool(&hub, "machine_roles", json!({})).await.unwrap();
    let row = |listed: &serde_json::Value, m: &str| {
        listed["machines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["machineId"] == m)
            .cloned()
            .unwrap()
    };
    assert_eq!(
        row(&listed, "mac1")["mac"],
        json!({ "on": true, "ready": true })
    );
    assert!(row(&listed, "devbox").get("mac").is_none());

    let off = tool(
        &hub,
        "machine_roles_set",
        json!({ "machineId": "mac1", "macTool": false }),
    )
    .await
    .unwrap();
    assert!(off["next"].as_str().unwrap().contains("turned off"));
    assert_eq!(super::mac_machine(&hub), None);
    assert!(
        off["machine"]["mac"]["note"]
            .as_str()
            .unwrap()
            .starts_with("Off")
    );
    tool(
        &hub,
        "machine_roles_set",
        json!({ "machineId": "mac1", "macTool": true }),
    )
    .await
    .unwrap();
    assert_eq!(super::mac_machine(&hub), Some(mid("mac1")));

    // A node that doesn't offer the tool (an admin user, say) gets no calls, and its row says why.
    hub.link
        .set_capabilities(&mid("mac1"), &[CAP_AGENTS_MAC, CAP_SESSION_HOST]);
    assert_eq!(super::mac_machine(&hub), None);
    let listed = tool(&hub, "machine_roles", json!({})).await.unwrap();
    let mac = &row(&listed, "mac1")["mac"];
    assert_eq!(mac["ready"], false);
    assert!(
        mac["note"]
            .as_str()
            .unwrap()
            .contains("it runs on macOS only")
    );

    // Any other machine has no switch.
    let refused = tool(
        &hub,
        "machine_roles_set",
        json!({ "machineId": "devbox", "macTool": true }),
    )
    .await
    .unwrap_err();
    assert!(message(refused).contains("isn't the agents' Mac"));
}

/// A screen an agent elsewhere opens on the agents' Mac gets its relay key sealed there, never the session's secrets.
#[tokio::test]
async fn a_screen_on_the_agents_mac_is_sealed_its_relay_key_alone() {
    let (hub, _home) = hub();
    let _devbox = remote(&hub);
    let first = route_once(&hub, "th-1", SessionHost::Mac, start(), None)
        .await
        .unwrap();
    assert_eq!(first.runner, mid("mac1"));
    assert!(first.seal_to.is_some());
    assert_eq!(first.relay_only, Some(true));
}

#[test]
fn the_macs_checks_are_the_doctors_with_where_and_what_to_run() {
    let check = |id, state, fix: Option<&str>, command: Option<&str>| MacCheck {
        id,
        state,
        message: Text::unchecked("said"),
        fix: fix.map(Text::unchecked),
        command: command.map(Text::unchecked),
    };
    let health = MacHealth {
        user: Text::unchecked("agents"),
        checks: List::unchecked(vec![
            check(MacCheckId::StandardUser, MacCheckState::Ok, None, None),
            check(
                MacCheckId::Xcode,
                MacCheckState::Fail,
                Some("In your own (admin) account's Terminal"),
                Some("sudo xcodebuild -license accept"),
            ),
            check(MacCheckId::GuiSession, MacCheckState::Warn, None, None),
            check(MacCheckId::Tools, MacCheckState::Unknown, None, None),
        ]),
    };
    let entries = crate::hub::doctor::checks::mac_setup("mac1", false, Some(&health));
    let seen: Vec<_> = entries
        .iter()
        .map(|e| (e.check.id.as_str(), e.check.status.as_str()))
        .collect();
    assert_eq!(
        seen,
        [
            ("mac1/mac_standard_user", "ok"),
            ("mac1/mac_xcode", "fail"),
            ("mac1/mac_gui_session", "warn"),
            ("mac1/mac_tools", "unknown"),
        ]
    );
    let fix = entries[1].check.fix.as_ref().unwrap();
    assert_eq!(
        fix.command.as_deref(),
        Some("sudo xcodebuild -license accept")
    );
    assert_eq!(fix.on.as_deref(), Some("machine"));
    assert!(
        fix.label
            .starts_with("In your own (admin) account's Terminal")
    );
    assert!(crate::hub::doctor::checks::mac_setup("mac1", true, Some(&health)).is_empty());
}

/// An older node on the agents' Mac, enrolled under another name (in another account, or in this one before it joined
/// again), runs on the same computer: its fingerprint names it, and the Mac's `mac_one_node` check fails with how to
/// revoke it. Once revoked, nothing else runs there.
#[test]
fn another_node_on_the_agents_mac_fails_its_one_node_check() {
    let (hub, _home) = hub();
    let enroll = |id: &str, fingerprint: &str| {
        let machine = serde_json::from_value(json!({
            "machineId": id, "name": id, "tags": [], "status": "online", "lastSeenAt": AT, "nodeVersion": "0.1.0",
        }))
        .unwrap();
        hub.store.machine_upsert(&machine, None).unwrap();
        let token = hub.auth.create_enroll_token(&mid(id)).unwrap().token;
        hub.auth
            .enroll_node(&token, &mid(id), &format!("key-{id}"), Some(fingerprint))
            .unwrap();
    };
    let same = |id| crate::hub::usage::wire::same_computer(&hub, id);
    enroll("mac1", "the-mac");
    enroll("macbook", "the-mac");
    enroll("devbox", "another-computer");
    assert_eq!(same("mac1"), ["macbook"]);

    let failing = crate::hub::doctor::checks::mac_one_node("mac1", &same("mac1"));
    assert_eq!(failing.check.id.as_str(), "mac1/mac_one_node");
    assert_eq!(failing.check.status.as_str(), "fail");
    assert!(
        failing
            .check
            .message
            .starts_with("macbook is enrolled from this Mac too"),
        "{}",
        failing.check.message
    );
    let fix = failing.check.fix.as_ref().unwrap();
    assert_eq!(
        fix.command.as_deref(),
        Some("fleetd machine remove macbook")
    );
    assert_eq!(fix.on.as_deref(), Some("hub"));
    assert!(fix.label.contains("launchctl bootout"), "{}", fix.label);

    hub.auth.revoke_node(&mid("macbook")).unwrap();
    assert!(same("mac1").is_empty());
    let passing = crate::hub::doctor::checks::mac_one_node("mac1", &[]);
    assert_eq!(passing.check.status.as_str(), "ok");
}
