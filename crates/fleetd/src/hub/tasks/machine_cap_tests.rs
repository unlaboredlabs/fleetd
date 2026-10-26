//! A machine's max agents as a person sets it through `cap_set`: past what its memory is estimated to fit, up to the
//! fleet cap, kept across a restart, and back to auto.
use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::mcp::ErrorCode;
use serde_json::{Value, json};

use crate::hub::api::{CallError, Caller, Hub, HubConfig, ToolError};
use crate::hub::slots::{Grant, MaxSource, SlotPriority, SlotRequest};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-26T10:00:00.000Z";

fn devbox() -> MachineId {
    MachineId::unchecked("devbox")
}

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: devbox(),
        project_id: ProjectId::unchecked("app"),
    }
}

/// A hub over `home`'s database with devbox enrolled and one project on it. Opened again over the same home, it is
/// the same hub after a restart.
fn open(home: &tempfile::TempDir) -> Arc<Hub> {
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Default::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let db = HubDb::open(home.path()).unwrap();
    let hub = crate::hub::serve::build_on(db, config, ManualClock::at(1_792_000_000_000)).unwrap();
    let machine = serde_json::from_value(json!({
        "machineId": "devbox", "name": "devbox", "tags": [], "status": "online", "lastSeenAt": AT,
        "nodeVersion": "0.1.0",
    }))
    .unwrap();
    hub.store.machine_upsert(&machine, None).unwrap();
    hub.store
        .projects_upsert_many(
            &devbox(),
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "app", "title": "app", "workspaceRoot": "/work/app",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    hub
}

/// devbox's heartbeat: 32 CPUs and 60 GB, whose memory term (45 GB after the reserve, at 2 GB an agent) fits 22.
fn heartbeat(hub: &Hub) {
    let mut load = crate::hub::link::guard::tests::load(500, 1.0);
    load.mem_total_bytes = Some(fleetd_contracts::prim::Count::unchecked(60 << 30));
    hub.slots
        .observe_machine(&devbox(), "devbox", &load)
        .unwrap();
}

fn caller(role: &str) -> Caller {
    serde_json::from_value(json!({
        "keyId": "k1", "name": "laptop", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": role, "machines": "*" }],
    }))
    .unwrap()
}

async fn cap_set(hub: &Arc<Hub>, role: &str, input: Value) -> Result<Value, ToolError> {
    match crate::hub::api::registry()
        .call(hub, &caller(role), "cap_set", input)
        .await
    {
        Ok(out) => Ok(out),
        Err(CallError::Tool(error)) => Err(error),
        Err(other) => panic!("cap_set: {other:?}"),
    }
}

fn acquire(hub: &Hub, n: i64) -> Grant {
    hub.slots
        .acquire(SlotRequest {
            holder: &format!("T{n}"),
            project_ref: &project(),
            priority: SlotPriority::Work,
        })
        .unwrap()
}

/// The machine's row in the slot state: its cap, a person's setting, what it fits and why.
fn row(out: &Value) -> Value {
    let row = &out["slots"]["perMachine"][0];
    json!([row["cap"], row["maxAgents"], row["auto"], row["why"]])
}

/// The human's report: a project stopped at 22 on devbox whatever its max, since nothing could raise the machine's
/// own cap past its memory estimate. Its setting does, up to the fleet cap.
#[tokio::test]
async fn devbox_set_to_40_runs_40_of_a_projects_agents_under_a_fleet_cap_of_50() {
    let home = tempfile::tempdir().unwrap();
    let hub = open(&home);
    heartbeat(&hub);
    cap_set(&hub, "admin", json!({ "cap": 50 })).await.unwrap();
    let project_max = json!({ "project": { "projectRef": project(), "maxAgents": 40 } });
    cap_set(&hub, "admin", project_max).await.unwrap();
    for n in 1..=22 {
        assert_eq!(acquire(&hub, n), Grant::Granted, "T{n}");
    }
    assert_eq!(
        acquire(&hub, 23),
        Grant::Queued(
            "machine cap: 22 of 22 running on devbox (memory 60 GB, about 2 GB an agent)"
                .to_owned()
        )
    );

    let machine = json!({ "machine": { "machineId": "devbox", "maxAgents": 40 } });
    let out = cap_set(&hub, "admin", machine).await.unwrap();
    assert_eq!(
        out["next"],
        "Max agents on devbox set to 40 (auto was 22): queued agents start as slots allow."
    );
    assert_eq!(
        row(&out),
        json!([40, 40, 22, "memory 60 GB, about 2 GB an agent"])
    );
    assert_eq!(
        hub.slots.agents(&project()).running,
        23,
        "the queued one starts at once"
    );
    for n in 24..=40 {
        assert_eq!(acquire(&hub, n), Grant::Granted, "T{n}");
    }
    assert_eq!(
        acquire(&hub, 41),
        Grant::Queued("machine cap: 40 of 40 running on devbox (set)".to_owned())
    );

    // A project on the default follows the machine's setting too.
    let follow = json!({ "project": { "projectRef": project(), "followDefault": true } });
    cap_set(&hub, "admin", follow).await.unwrap();
    assert_eq!(hub.slots.agents(&project()).max_agents, 40);
    assert_eq!(hub.slots.agents(&project()).source, MaxSource::Machine);
}

#[tokio::test]
async fn a_machine_setting_is_an_admins_and_stays_within_the_fleet_cap() {
    let home = tempfile::tempdir().unwrap();
    let hub = open(&home);
    heartbeat(&hub);
    let set = |n: i64| json!({ "machine": { "machineId": "devbox", "maxAgents": n } });
    let refused = cap_set(&hub, "operate", set(30)).await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::Forbidden);

    cap_set(&hub, "admin", json!({ "cap": 50 })).await.unwrap();
    let over = cap_set(&hub, "admin", set(51)).await.unwrap_err();
    assert_eq!(
        (over.message.as_str(), over.fix.as_deref()),
        (
            "Max agents 51 on devbox is above the fleet's 50 slots.",
            Some("Pick 1 to 50, or raise the fleet cap first.")
        )
    );
    // Both at once: the fleet cap it is checked against is the new one.
    let both = json!({ "cap": 60, "machine": { "machineId": "devbox", "maxAgents": 55 } });
    cap_set(&hub, "admin", both).await.unwrap();
    assert_eq!(hub.slots.machine_cap(&devbox()), 55);

    let unknown = json!({ "machine": { "machineId": "nowhere", "maxAgents": 4 } });
    let unknown = cap_set(&hub, "admin", unknown).await.unwrap_err();
    assert_eq!(unknown.message, "No machine nowhere.");
}

#[tokio::test]
async fn a_machine_setting_outlives_a_restart_and_goes_back_to_auto() {
    let home = tempfile::tempdir().unwrap();
    let hub = open(&home);
    heartbeat(&hub);
    let machine = json!({ "machine": { "machineId": "devbox", "maxAgents": 40 } });
    cap_set(&hub, "admin", machine).await.unwrap();
    drop(hub);

    // No heartbeat yet: the setting and the last measure come back from the database.
    let hub = open(&home);
    assert_eq!(hub.slots.machine_cap(&devbox()), 40);
    assert_eq!(hub.slots.machine_setting(&devbox()), Some(40));
    // A heartbeat measures again and leaves the setting alone.
    heartbeat(&hub);
    assert_eq!(hub.slots.machine_cap(&devbox()), 40);

    let auto = json!({ "machine": { "machineId": "devbox", "auto": true } });
    let out = cap_set(&hub, "admin", auto).await.unwrap();
    assert_eq!(
        out["next"],
        "Max agents on devbox back to auto: 22, was 40: running agents finish; new ones wait."
    );
    assert_eq!(
        row(&out),
        json!([22, null, 22, "memory 60 GB, about 2 GB an agent"])
    );
    drop(hub);

    let hub = open(&home);
    assert_eq!(hub.slots.machine_cap(&devbox()), 22);
    assert_eq!(hub.slots.machine_setting(&devbox()), None);
}

/// A machine set before its node first reports is kept, and its first heartbeat leaves the setting alone.
#[tokio::test]
async fn a_machine_not_measured_yet_takes_a_setting() {
    let home = tempfile::tempdir().unwrap();
    let hub = open(&home);
    let machine = json!({ "machine": { "machineId": "devbox", "maxAgents": 30 } });
    let out = cap_set(&hub, "admin", machine).await.unwrap();
    assert_eq!(row(&out), json!([30, 30, 4, "not measured yet"]));
    heartbeat(&hub);
    assert_eq!(hub.slots.machine_cap(&devbox()), 30);
    assert_eq!(hub.slots.state().per_machine[0].auto.get(), 22);
}
