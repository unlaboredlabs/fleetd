//! The nudge over a real hub: a cap someone set holding queued agents back while the machine has room raises one
//! `agents.held` item, raising the cap clears it, and a machine with no room raises none.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::events::{Attention, HubEventType};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::prim::Count;
use fleetd_contracts::tasks::{AgentsHeldData, CapScope, Task};
use serde_json::{Value, json};

use super::cap::{CapChange, ProjectCap};
use super::cap_tests::AT;
use crate::hub::api::{Caller, Hub, HubConfig, registry};
use crate::hub::slots::nudge::HOLD_MS;
use crate::hub::slots::{SlotPriority, SlotRequest};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

/// A hub whose one machine has `mem_gb` of memory and 32 CPUs: 128 GB fits 28 agents, 8 GB fits 2.
fn hub(mem_gb: i64) -> (Arc<Hub>, Arc<ManualClock>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Default::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let clock = ManualClock::at(1_792_000_000_000);
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    let mut load = crate::hub::link::guard::tests::load(500, 1.0);
    load.mem_total_bytes = Some(Count::unchecked(mem_gb << 30));
    hub.slots
        .observe_machine(&MachineId::unchecked("lab-a"), "builder-1", &load)
        .unwrap();
    (hub, clock, home)
}

fn project(p: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: ProjectId::unchecked(p),
    }
}

/// A task of the project asking for a slot; true when it got one.
fn spawn(hub: &Hub, n: u32, p: &str) -> bool {
    let task: Task = serde_json::from_value(json!({
        "taskId": format!("T{n}"), "projectRef": { "machineId": "lab-a", "projectId": p }, "workstreamId": "W1",
        "title": format!("slice {n}"), "kind": "write", "prompt": "do it", "state": "queued", "attempt": 1,
        "createdAt": AT,
    }))
    .unwrap();
    let task = hub
        .db
        .with(|c| Ok(super::TaskRecords::create(c, task)?))
        .unwrap();
    hub.slots
        .acquire(SlotRequest {
            holder: task.task_id.as_str(),
            project_ref: &task.project_ref,
            priority: SlotPriority::Work,
        })
        .unwrap()
        .granted()
}

fn max_agents(p: &str, n: i64) -> CapChange {
    CapChange {
        cap: None,
        project: Some(ProjectCap {
            project_ref: project(p),
            max_agents: Some(n),
            pause_extras: false,
        }),
        machine: None,
    }
}

/// Every `agents.held` event: summary, attention and data.
fn held(hub: &Hub) -> Vec<(String, Option<Attention>, AgentsHeldData)> {
    hub.db
        .with(|c| {
            let mut stmt = c.prepare("SELECT data FROM events WHERE type = ? ORDER BY seq")?;
            let rows = stmt
                .query_map([HubEventType::AgentsHeld.as_str()], |r| {
                    r.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap()
        .into_iter()
        .map(|row| {
            let event: Value = serde_json::from_str(&row).unwrap();
            (
                event["summary"].as_str().unwrap().to_owned(),
                serde_json::from_value(event["attention"].clone()).unwrap(),
                serde_json::from_value(event["data"].clone()).unwrap(),
            )
        })
        .collect()
}

/// The `agents.held` items `fleetd_status` lists as needing attention.
async fn status_items(hub: &Arc<Hub>) -> Vec<String> {
    let person = serde_json::from_value::<Caller>(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "operate", "machines": "*" }],
    }))
    .unwrap();
    let person = Caller {
        kind: Some(KeyKind::Human),
        ..person
    };
    let status = registry()
        .call(hub, &person, "fleetd_status", json!({}))
        .await
        .unwrap();
    status["attention"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["type"] == "agents.held")
        .map(|e| e["summary"].as_str().unwrap().to_owned())
        .collect()
}

fn wait(clock: &ManualClock, ms: i64) {
    clock.advance(Duration::from_millis(ms as u64));
}

#[tokio::test]
async fn a_set_cap_holding_agents_behind_free_room_raises_one_item_and_raising_it_clears_it() {
    let (hub, clock, _home) = hub(128);
    hub.tasks.set_caps(max_agents("p1", 1)).await.unwrap();
    assert!(spawn(&hub, 1, "p1"));
    for n in 2..=4 {
        assert!(!spawn(&hub, n, "p1"), "T{n} waits behind max agents 1");
    }
    hub.slots.check_nudges().unwrap();
    assert_eq!(held(&hub), [], "not before the hold has lasted");

    wait(&clock, HOLD_MS);
    hub.slots.check_nudges().unwrap();
    let line = "Max agents 1 on lab-a/p1 is holding 3 agents back; builder-1 has room for 27 more. \
                Raise it: fleetd project set lab-a/p1 --max-agents auto";
    let items = held(&hub);
    assert_eq!(items.len(), 1, "{items:?}");
    let (summary, attention, data) = &items[0];
    assert_eq!(summary, line);
    assert_eq!(*attention, Some(Attention::Loud));
    assert_eq!(
        (data.held, data.scope, data.cap.get(), data.queued.get()),
        (true, CapScope::Project, 1, 3)
    );
    assert_eq!(data.room.map(|r| r.get()), Some(27));
    assert_eq!(data.project_ref, Some(project("p1")));
    assert_eq!(status_items(&hub).await, [line]);

    // Nothing changes: no second item, at the next sweeps or on another spawn behind the same cap.
    wait(&clock, 3 * HOLD_MS);
    hub.slots.check_nudges().unwrap();
    assert!(!spawn(&hub, 5, "p1"));
    hub.slots.check_nudges().unwrap();
    assert_eq!(held(&hub).len(), 1);

    hub.tasks.set_caps(max_agents("p1", 8)).await.unwrap();
    let items = held(&hub);
    assert_eq!(items.len(), 2, "{items:?}");
    let (summary, attention, data) = &items[1];
    assert_eq!(
        summary,
        "Max agents 1 on lab-a/p1 is now 8; it no longer holds agents back"
    );
    assert_eq!(*attention, None, "a clear needs no one");
    assert!(!data.held);
    assert_eq!(status_items(&hub).await, Vec::<String>::new());

    wait(&clock, 3 * HOLD_MS);
    hub.slots.check_nudges().unwrap();
    assert_eq!(held(&hub).len(), 2);
}

#[tokio::test]
async fn a_machine_with_no_free_room_raises_no_item() {
    // 8 GB fits 2: one agent of p1 and one of p2 fill it, so max agents 1 is not what holds p1's next one back.
    let (hub, clock, _home) = hub(8);
    hub.tasks.set_caps(max_agents("p1", 1)).await.unwrap();
    assert!(spawn(&hub, 1, "p1"));
    assert!(spawn(&hub, 2, "p2"));
    assert!(!spawn(&hub, 3, "p1"));
    hub.slots.check_nudges().unwrap();
    wait(&clock, 3 * HOLD_MS);
    hub.slots.check_nudges().unwrap();
    assert_eq!(held(&hub), []);
    assert_eq!(status_items(&hub).await, Vec::<String>::new());
}

#[tokio::test]
async fn a_restarted_hub_does_not_raise_an_open_item_again() {
    let home = tempfile::tempdir().unwrap();
    let db = HubDb::open(home.path()).unwrap();
    let clock = ManualClock::at(1_792_000_000_000);
    let config = || HubConfig {
        home: home.path().to_path_buf(),
        listen: Default::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let mut load = crate::hub::link::guard::tests::load(500, 1.0);
    load.mem_total_bytes = Some(Count::unchecked(128 << 30));
    let first = crate::hub::serve::build_on(db.clone(), config(), clock.clone()).unwrap();
    first
        .slots
        .observe_machine(&MachineId::unchecked("lab-a"), "builder-1", &load)
        .unwrap();
    first.tasks.set_caps(max_agents("p1", 1)).await.unwrap();
    spawn(&first, 1, "p1");
    spawn(&first, 2, "p1");
    first.slots.check_nudges().unwrap();
    wait(&clock, HOLD_MS);
    first.slots.check_nudges().unwrap();
    assert_eq!(held(&first).len(), 1);
    drop(first);

    let again = crate::hub::serve::build_on(db, config(), clock.clone()).unwrap();
    wait(&clock, 2 * HOLD_MS);
    again.slots.check_nudges().unwrap();
    again.slots.check_nudges().unwrap();
    assert_eq!(held(&again).len(), 1);
}
