//! hub_info over a real in-memory hub: nothing busy when idle, and each thing a restart would cut off listed once it
//! runs.
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::mcp::{HubBusyKind, HubChannel, HubInfoOutput};
use fleetd_contracts::tasks::Task;
use serde_json::{Value, json};

use crate::hub::api::{Caller, Hub, HubConfig};
use crate::hub::leads::records::StoredLead;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, NewEvent, StoredThread};

const AT: &str = "2026-10-22T10:00:00.000Z";

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Default::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    hub.store
        .projects_upsert_many(
            &project().machine_id,
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "p1", "title": "storefront", "workspaceRoot": "/work/storefront",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    (hub, home)
}

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("p1"),
    }
}

fn reader() -> Caller {
    serde_json::from_value(json!({
        "keyId": "k1", "name": "fleetd-cli", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "read", "machines": "*" }],
    }))
    .unwrap()
}

fn put_thread(hub: &Hub, id: &str, status: &str) {
    hub.store
        .thread_upsert(&StoredThread {
            thread: serde_json::from_value(json!({
                "machineId": "devbox", "threadId": id, "projectId": "p1", "title": id, "status": status,
                "headline": "", "latestMessageTail": "", "lastProgressAt": AT, "stale": false, "asOf": AT,
            }))
            .unwrap(),
            last_sequence: None,
            last_run_id: None,
            last_run_status: None,
        })
        .unwrap();
}

async fn info(hub: &Arc<Hub>, input: Value) -> HubInfoOutput {
    let out = crate::hub::api::registry()
        .call(hub, &reader(), "hub_info", input)
        .await
        .unwrap();
    serde_json::from_value(out).unwrap()
}

#[test]
fn a_build_follows_the_channel_its_version_names() {
    use super::channel;
    assert_eq!(
        channel("0.0.0-edge.202610221107+333368c", true),
        Some(HubChannel::Edge)
    );
    assert_eq!(
        channel("0.0.0-nightly.202610221107+333368c", true),
        Some(HubChannel::Edge)
    );
    assert_eq!(channel("0.4.1", true), Some(HubChannel::Stable));
    assert_eq!(channel("0.0.0", false), None);
}

#[tokio::test]
async fn an_idle_hub_reports_its_version_and_nothing_busy() {
    let (hub, _home) = hub();
    // A lead between turns is not busy.
    hub.leads
        .records
        .lead_put(&StoredLead {
            project_ref: project(),
            thread_id: fleetd_contracts::ids::ThreadId::unchecked("lead-thread"),
            started_at: AT.into(),
            last_wake_at: None,
            session_generation: 1,
        })
        .unwrap();
    put_thread(&hub, "lead-thread", "idle");
    let out = info(&hub, json!({})).await;
    assert_eq!(out.version, crate::version());
    assert_eq!(
        out.protocol,
        fleetd_contracts::hello::ProtocolVersion::CURRENT
    );
    assert!(out.busy.is_empty(), "{:?}", out.busy);
    assert_eq!(out.admin, Some(false), "a read key");
}

/// The app greys out the fleet and machine caps for a key that can't change them.
#[tokio::test]
async fn it_says_whether_the_key_may_change_the_fleet_and_machine_caps() {
    let (hub, _home) = hub();
    let key = |grants: Value| -> Caller {
        serde_json::from_value(json!({
            "keyId": "k2", "name": "laptop", "prefix": "fld_abcdef", "createdAt": AT, "grants": grants,
        }))
        .unwrap()
    };
    let admin_of = |caller: Caller| {
        let hub = hub.clone();
        async move {
            let out = crate::hub::api::registry()
                .call(&hub, &caller, "hub_info", json!({}))
                .await
                .unwrap();
            serde_json::from_value::<HubInfoOutput>(out).unwrap().admin
        }
    };
    let everywhere = key(json!([{ "role": "admin", "machines": "*" }]));
    assert_eq!(admin_of(everywhere).await, Some(true));
    let one_machine = key(json!([{ "role": "admin", "machines": ["devbox"] }]));
    assert_eq!(admin_of(one_machine).await, Some(false));
    let operator = key(json!([{ "role": "operate", "machines": "*" }]));
    assert_eq!(admin_of(operator).await, Some(false));
}

#[tokio::test]
async fn a_working_lead_running_agents_and_a_clone_are_busy() {
    let (hub, _home) = hub();
    hub.leads
        .records
        .lead_put(&StoredLead {
            project_ref: project(),
            thread_id: fleetd_contracts::ids::ThreadId::unchecked("lead-thread"),
            started_at: AT.into(),
            last_wake_at: None,
            session_generation: 1,
        })
        .unwrap();
    put_thread(&hub, "lead-thread", "running");
    let task: Task = serde_json::from_value(json!({
        "taskId": "T1", "projectRef": { "machineId": "devbox", "projectId": "p1" }, "workstreamId": "W1",
        "title": "the checkout page", "kind": "read", "prompt": "do it",
        "model": "claude-opus-5-5", "effort": "high", "state": "running", "attempt": 1, "createdAt": AT,
        "startedAt": AT, "threadRef": { "machineId": "devbox", "threadId": "t1" },
    }))
    .unwrap();
    hub.db
        .with(|c| Ok(crate::hub::tasks::records::TaskRecords::create(c, task)?))
        .unwrap();
    hub.events
        .append(NewEvent {
            at: AT.into(),
            r#type: HubEventType::ProjectCloneProgress,
            machine_id: Some(MachineId::unchecked("buildbox")),
            project_id: None,
            thread_id: None,
            summary: "cloning".into(),
            data: Some(json!({
                "addId": "a1", "repo": "acme/shop", "path": "/src/shop", "phase": "receiving",
            })),
            attention: None,
        })
        .unwrap();

    let out = info(&hub, json!({})).await;
    let busy: Vec<(HubBusyKind, String)> = out
        .busy
        .iter()
        .map(|i| (i.kind, i.text.to_string()))
        .collect();
    assert_eq!(
        busy,
        [
            (HubBusyKind::Lead, "the storefront lead is working".into()),
            (
                HubBusyKind::Agent,
                "T1 in storefront: the checkout page".into()
            ),
            (HubBusyKind::Clone, "cloning acme/shop on buildbox".into()),
        ]
    );
    assert_eq!(out.busy[1].since.as_ref().map(|t| t.0.as_str()), Some(AT));

    // Before restarting buildbox's node: only the clone there.
    let on = info(&hub, json!({ "machineId": "buildbox" })).await;
    assert_eq!(on.busy.len(), 1);
    assert_eq!(on.busy[0].kind, HubBusyKind::Clone);
}

#[test]
fn a_merge_counts_only_while_the_hub_rebases_or_merges_it() {
    let change = |state: &str| -> fleetd_contracts::train::Change {
        serde_json::from_value(json!({
            "changeId": "X1", "projectRef": { "machineId": "devbox", "projectId": "p1" }, "repo": "acme/shop",
            "prNumber": 251, "prUrl": "https://github.com/acme/shop/pull/251", "branch": "fleetd/T1-checkout",
            "workstreamId": "W1", "serves": "done:0",
            "headSha": "0123456789abcdef0123456789abcdef01234567", "state": state, "reviews": [],
            "createdAt": AT, "updatedAt": AT,
        }))
        .unwrap()
    };
    assert_eq!(
        super::hub_step(&change("merging")).as_deref(),
        Some("merging PR #251 into acme/shop")
    );
    assert_eq!(
        super::hub_step(&change("rebasing")).as_deref(),
        Some("updating PR #251 in acme/shop before it merges")
    );
    // CI runs on GitHub and outlives a hub restart.
    assert_eq!(super::hub_step(&change("ci")), None);
    assert_eq!(super::hub_step(&change("ready")), None);
}
