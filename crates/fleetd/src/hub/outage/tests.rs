//! Machines down over a real in-memory hub and hub/push's fake relay: a machine offline past 10 minutes pushes once to
//! the admins and once more when it is back; one back sooner, one an update restarts, and a cloud machine asleep push
//! nothing.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::mcp::UpdateRun;
use fleetd_contracts::model::{Machine, MachineStatus};
use fleetd_contracts::push::PushKind;
use serde_json::json;

use super::*;
use crate::hub::api::Hub;
use crate::hub::pool::ledger::Slot;
use crate::hub::push::tests::{
    FakeRelay, fake_relay, hub_with_clock, member, ok, opened, owner_device, phone,
};
use crate::hub::push::{Follow, step};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, NewEvent};

const MINUTE: Duration = Duration::from_secs(60);

struct World {
    hub: Arc<Hub>,
    clock: Arc<ManualClock>,
    relay: FakeRelay,
    owner_key: crypto_box::SecretKey,
    follow: Follow,
    cursor: i64,
    _home: tempfile::TempDir,
}

/// A hub with an owner and a member, each with a phone, and the machine `devbox` online.
async fn world() -> World {
    let home = tempfile::tempdir().unwrap();
    let clock = ManualClock::at(1_792_000_000_000);
    let hub = hub_with_clock(HubDb::open_memory().unwrap(), &home, clock.clone());
    let owner = owner_device(&hub);
    let (owner_key, _) = phone(&hub, &owner, "ios", "aa11").await;
    let ada = member(&hub, &owner, "Ada", "ada-desk").await;
    phone(&hub, &ada, "ios", "bb22").await;
    let (relay, url) = fake_relay().await;
    ok(&hub, &owner, "push_relay_set", json!({ "url": url })).await;
    let w = World {
        cursor: hub.events.head(),
        hub,
        clock,
        relay,
        owner_key,
        follow: Follow::default(),
        _home: home,
    };
    w.set(MachineStatus::Online, "machine.online");
    w
}

impl World {
    fn devbox(&self) -> Machine {
        serde_json::from_value(json!({
            "machineId": "devbox", "name": "devbox", "status": "online",
            "lastSeenAt": iso_ms(now_ms(self.hub.clock.as_ref())), "nodeVersion": "1.0.0",
        }))
        .unwrap()
    }

    /// The machine's status, as the link server writes it and logs `kind`.
    fn set(&self, status: MachineStatus, kind: &str) {
        let at = iso_ms(now_ms(self.hub.clock.as_ref()));
        let stored = self
            .hub
            .store
            .machine_get(&MachineId::unchecked("devbox"))
            .unwrap()
            .unwrap_or_else(|| self.devbox());
        let machine = Machine {
            status,
            last_seen_at: if status == MachineStatus::Offline {
                stored.last_seen_at.clone()
            } else {
                Timestamp(at.clone())
            },
            ..stored
        };
        self.hub.store.machine_upsert(&machine, None).unwrap();
        let e: NewEvent = serde_json::from_value(json!({
            "at": at, "type": kind, "machineId": "devbox", "summary": format!("devbox {kind}"),
        }))
        .unwrap();
        self.hub.events.append(e).unwrap();
    }

    /// Time passes, the sweep looks each 30 s of it.
    fn wait(&self, by: Duration) {
        let mut left = by;
        while !left.is_zero() {
            let step = left.min(Duration::from_secs(30));
            self.clock.advance(step);
            left -= step;
            sweep(&self.hub).unwrap();
        }
    }

    fn logged(&self, kind: HubEventType) -> usize {
        self.hub
            .events
            .page(0, Some(&[kind]), None)
            .unwrap()
            .events
            .len()
    }

    /// What reached the phones since the last look: the pushes' tokens.
    async fn pushed(&mut self) -> Vec<String> {
        let before = self.relay.got.lock().unwrap().len();
        let http = reqwest::Client::new();
        loop {
            let (next, more, _) = step(&self.hub, &http, &mut self.follow, self.cursor)
                .await
                .unwrap();
            self.cursor = next;
            if !more {
                break;
            }
        }
        self.relay.got.lock().unwrap()[before..]
            .iter()
            .map(|p| p.token.clone())
            .collect()
    }

    fn last_body(&self) -> (PushKind, String) {
        let got = self.relay.got.lock().unwrap();
        let p = opened(&self.owner_key, got.last().unwrap());
        (p.kind, p.body.as_str().to_owned())
    }
}

#[tokio::test]
async fn a_machine_offline_past_ten_minutes_pages_its_admins_once_and_says_when_it_is_back() {
    let mut w = world().await;
    w.set(MachineStatus::Offline, "machine.offline");
    w.wait(9 * MINUTE);
    assert_eq!(w.logged(HubEventType::MachineDown), 0);
    assert!(w.pushed().await.is_empty(), "nothing before 10 minutes");

    w.wait(2 * MINUTE);
    // The owner's phone only: a member isn't an admin.
    assert_eq!(w.pushed().await, ["aa11"]);
    let (kind, body) = w.last_body();
    assert_eq!(kind, PushKind::Alert);
    assert!(
        body.starts_with("devbox has been offline for 10m"),
        "{body}"
    );

    // However long it stays down, and across a hub restart (the sweep keeps no state of its own): once.
    w.wait(60 * MINUTE);
    assert_eq!(w.logged(HubEventType::MachineDown), 1);
    assert!(w.pushed().await.is_empty());

    w.set(MachineStatus::Online, "machine.online");
    w.wait(MINUTE);
    assert_eq!(w.pushed().await, ["aa11"]);
    let (_, body) = w.last_body();
    assert_eq!(body, "devbox is back online after 1h11m");
    w.wait(10 * MINUTE);
    assert_eq!(w.logged(HubEventType::MachineBack), 1);

    // A new outage is paged again.
    w.set(MachineStatus::Offline, "machine.offline");
    w.wait(11 * MINUTE);
    assert_eq!(w.pushed().await, ["aa11"]);
}

#[tokio::test]
async fn a_machine_back_within_ten_minutes_pages_nobody() {
    let mut w = world().await;
    w.set(MachineStatus::Offline, "machine.offline");
    w.wait(9 * MINUTE);
    // Back degraded (its runner logged out) is back too.
    w.set(MachineStatus::Degraded, "machine.degraded");
    w.wait(30 * MINUTE);
    assert_eq!(w.logged(HubEventType::MachineDown), 0);
    assert_eq!(w.logged(HubEventType::MachineBack), 0);
    assert!(w.pushed().await.is_empty());
}

fn update_run(state: &str) -> UpdateRun {
    serde_json::from_value(json!({
        "id": "u1", "channel": "edge", "startedAt": "2026-10-19T10:00:00.000Z",
        "parts": [
            { "part": "hub", "name": "the hub", "from": "1.0.0", "state": "done" },
            { "part": "node", "machineId": "devbox", "name": "devbox", "from": "1.0.0", "state": state },
        ],
    }))
    .unwrap()
}

#[tokio::test]
async fn a_machine_away_for_an_update_restart_pages_nobody_until_the_update_gives_up_on_it() {
    let mut w = world().await;
    w.hub.updates.drive_for_test(update_run("restarting"));
    w.set(MachineStatus::Offline, "machine.offline");
    w.wait(15 * MINUTE);
    assert_eq!(w.logged(HubEventType::MachineDown), 0);
    assert!(w.pushed().await.is_empty());

    // The update rolled it back and its node still isn't here: that is an outage.
    w.hub.updates.drive_for_test(update_run("rolled_back"));
    w.wait(MINUTE);
    assert_eq!(w.pushed().await, ["aa11"]);
}

#[tokio::test]
async fn an_update_restart_back_in_time_pages_nobody() {
    let mut w = world().await;
    w.hub.updates.drive_for_test(update_run("restarting"));
    w.set(MachineStatus::Offline, "machine.offline");
    w.wait(3 * MINUTE);
    w.set(MachineStatus::Online, "machine.online");
    w.hub.updates.drive_for_test(update_run("done"));
    w.wait(20 * MINUTE);
    assert!(w.pushed().await.is_empty());
}

#[tokio::test]
async fn a_cloud_machine_asleep_pages_nobody_and_a_broken_one_does() {
    let mut w = world().await;
    let mut cloud = w.devbox();
    cloud.cloud = Some(true);
    w.hub.store.machine_upsert(&cloud, None).unwrap();
    let mut slot = Slot::new("devbox", now_ms(w.hub.clock.as_ref()));
    slot.state = State::Asleep;
    w.hub.pool.ledger().put(&slot).unwrap();
    w.set(MachineStatus::Offline, "machine.offline");
    w.wait(30 * MINUTE);
    assert!(w.pushed().await.is_empty());

    slot.state = State::Broken;
    w.hub.pool.ledger().put(&slot).unwrap();
    w.wait(MINUTE);
    assert_eq!(w.pushed().await, ["aa11"]);
}

#[tokio::test]
async fn a_removed_machine_pages_nobody() {
    let mut w = world().await;
    w.set(MachineStatus::Offline, "machine.offline");
    w.hub
        .store
        .machine_remove(&MachineId::unchecked("devbox"))
        .unwrap();
    w.wait(30 * MINUTE);
    assert!(w.pushed().await.is_empty());
}

#[tokio::test]
async fn a_busy_machine_down_pages_once_from_its_first_offline() {
    let mut w = world().await;
    let at = iso_ms(now_ms(w.hub.clock.as_ref()));
    w.hub
        .store
        .thread_upsert(&crate::hub::store::StoredThread {
            thread: serde_json::from_value(json!({
                "machineId": "devbox", "threadId": "t1", "projectId": "app", "title": "T1", "status": "running",
                "headline": "", "latestMessageTail": "", "lastProgressAt": at, "stale": false, "asOf": at,
            }))
            .unwrap(),
            last_sequence: None,
            last_run_id: None,
            last_run_status: None,
        })
        .unwrap();
    w.set(MachineStatus::Offline, "machine.offline");
    w.wait(5 * MINUTE);
    // The hub's own 5-minute sweep says nothing of it, and a hub restart marking it offline again doesn't move when
    // the outage began.
    w.hub.sweep.run_once().await;
    w.set(MachineStatus::Offline, "machine.offline");
    assert!(w.pushed().await.is_empty());
    w.wait(5 * MINUTE);
    assert_eq!(w.pushed().await, ["aa11"]);
    let (_, body) = w.last_body();
    assert!(
        body.starts_with("devbox has been offline for 10m"),
        "{body}"
    );
    w.wait(20 * MINUTE);
    w.hub.sweep.run_once().await;
    w.set(MachineStatus::Online, "machine.online");
    w.wait(MINUTE);
    assert_eq!(w.pushed().await, ["aa11"]);
    let (_, body) = w.last_body();
    assert_eq!(body, "devbox is back online after 30m00s");
}
