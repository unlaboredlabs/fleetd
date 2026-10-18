//! Test kit for the queue, wakes and webhooks: one in-memory database with these areas' tables, a fake event log,
//! fake executors and a clock on tokio's paused time. Advancing by sleeping lets tokio auto-advance timer by timer,
//! so each woken loop sees the time its timer was for, as Effect's TestClock.adjust does.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::watch;

use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ids::{MachineId, ThreadId, ThreadRef};

use super::WriteQueue;
use super::ports::*;
use crate::clock::Clock;
use crate::hub::store::{EventLog, HubDb};

/// 2026-10-17T10:00:00.000Z
pub const NOW: i64 = 1_792_231_200_000;

pub fn tref(machine: &str, thread: &str) -> ThreadRef {
    ThreadRef {
        machine_id: MachineId::unchecked(machine),
        thread_id: ThreadId::unchecked(thread),
    }
}

/// Lets every runnable task go as far as it can without time moving.
pub async fn settle() {
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
}

pub struct TestClock {
    start: tokio::time::Instant,
    base_ms: i64,
}

impl TestClock {
    pub fn at(base_ms: i64) -> Arc<Self> {
        Arc::new(Self {
            start: tokio::time::Instant::now(),
            base_ms,
        })
    }
}

impl Clock for TestClock {
    fn now(&self) -> SystemTime {
        UNIX_EPOCH
            + Duration::from_millis((self.base_ms + self.start.elapsed().as_millis() as i64) as u64)
    }
    fn sleep(
        &self,
        duration: Duration,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(tokio::time::sleep(duration))
    }
}

/// The real event log over the kit's database, with readers for tests.
pub trait EventsExt {
    fn all(&self) -> Vec<HubEvent>;
    fn of(&self, kind: HubEventType) -> Vec<HubEvent>;
}

impl EventsExt for EventLog {
    fn all(&self) -> Vec<HubEvent> {
        self.page(0, None, None).unwrap().events
    }
    fn of(&self, kind: HubEventType) -> Vec<HubEvent> {
        self.page(0, Some(&[kind]), None).unwrap().events
    }
}

#[derive(Default)]
pub struct FakeWriter {
    connected: Mutex<HashSet<MachineId>>,
    live: watch::Sender<u64>,
    sends: Mutex<Vec<(ThreadRef, String, String)>>,
    refused: Mutex<HashSet<String>>,
    behind_run: Mutex<HashSet<String>>,
}

impl FakeWriter {
    pub fn go_live(&self, machine: &str) {
        self.connected
            .lock()
            .unwrap()
            .insert(MachineId::unchecked(machine));
        self.live.send_modify(|v| *v += 1);
    }
    pub fn refuse(&self, client_request_id: &str) {
        self.refused
            .lock()
            .unwrap()
            .insert(client_request_id.into());
    }
    /// The node takes this send behind the thread's active run.
    pub fn behind_run(&self, client_request_id: &str) {
        self.behind_run
            .lock()
            .unwrap()
            .insert(client_request_id.into());
    }
    pub fn sends(&self) -> Vec<(ThreadRef, String, String)> {
        self.sends.lock().unwrap().clone()
    }
    pub fn messages(&self) -> Vec<String> {
        self.sends().into_iter().map(|s| s.1).collect()
    }
}

impl ThreadWriter for FakeWriter {
    fn is_connected(&self, machine_id: &MachineId) -> bool {
        self.connected.lock().unwrap().contains(machine_id)
    }
    fn await_live(&self, machine_id: &MachineId) -> BoxFuture<'_, ()> {
        let machine = machine_id.clone();
        Box::pin(async move {
            let mut rx = self.live.subscribe();
            while !self.is_connected(&machine) {
                let _ = rx.changed().await;
            }
        })
    }
    fn send(
        &self,
        target: &ThreadRef,
        message: &str,
        client_request_id: &str,
    ) -> BoxFuture<'_, Result<Sent, ExecutorError>> {
        let result = if !self.is_connected(&target.machine_id) {
            Err(ExecutorError::MachineNotConnected {
                machine_id: target.machine_id.clone(),
            })
        } else if self.refused.lock().unwrap().contains(client_request_id) {
            Err(ExecutorError::NodeRequestFailed {
                machine_id: target.machine_id.clone(),
                operation: "send",
                message: "claude is not logged in for fleetd on this machine".into(),
                fix: Some("On lab-a: CLAUDE_CONFIG_DIR=~/.fleetd/claude claude auth login".into()),
            })
        } else {
            let mut sends = self.sends.lock().unwrap();
            sends.push((target.clone(), message.into(), client_request_id.into()));
            Ok(Sent {
                run_id: Some(format!("run-{}", sends.len())),
                behind_run: self.behind_run.lock().unwrap().contains(client_request_id),
            })
        };
        Box::pin(async move { result })
    }
}

/// A usage layer whose holds the test sets and releases.
#[derive(Default)]
pub struct FakeUsage {
    held: Mutex<HashMap<ThreadRef, bool>>,
    changed: watch::Sender<u64>,
}

impl FakeUsage {
    pub fn hold_thread(&self, t: &ThreadRef) {
        self.held.lock().unwrap().insert(t.clone(), true);
    }
    pub fn release(&self, t: &ThreadRef) {
        self.held.lock().unwrap().remove(t);
        self.changed.send_modify(|v| *v += 1);
    }
}

impl UsageHold for FakeUsage {
    fn hold(&self, target: &ThreadRef) -> BoxFuture<'_, Option<String>> {
        let held = self.held.lock().unwrap().contains_key(target);
        Box::pin(async move { held.then(|| "usage: paused".to_string()) })
    }
    fn when_clear(&self, target: &ThreadRef) -> BoxFuture<'_, ()> {
        let target = target.clone();
        Box::pin(async move {
            let mut rx = self.changed.subscribe();
            while self.held.lock().unwrap().contains_key(&target) {
                let _ = rx.changed().await;
            }
        })
    }
}

pub struct Kit {
    pub db: Arc<HubDb>,
    pub events: Arc<EventLog>,
    pub writer: Arc<FakeWriter>,
    pub clock: Arc<TestClock>,
}

impl Kit {
    pub fn new() -> Self {
        Self::at(NOW)
    }
    pub fn at(ms: i64) -> Self {
        let db = HubDb::open_memory().unwrap();
        let clock = TestClock::at(ms);
        let events = Arc::new(EventLog::new(db.clone(), clock.clone()).unwrap());
        Self {
            db,
            events,
            writer: Arc::default(),
            clock,
        }
    }
    /// A started queue over this kit's database (a "hub process"; `stop` it to simulate a restart).
    pub fn queue(&self, ttl: Duration) -> Arc<WriteQueue> {
        let q = WriteQueue::new(
            self.db.clone(),
            self.writer.clone(),
            self.events.clone(),
            self.clock.clone(),
            ttl,
        );
        q.start();
        q
    }
    /// TestClock.adjust: time moves timer by timer, then everything woken settles.
    pub async fn advance(&self, by: Duration) {
        settle().await;
        tokio::time::sleep(by).await;
        settle().await;
    }
}
