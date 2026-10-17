//! The safety-net sweep: every 5 min, deterministic, no LLM. Built in: re-open streams for running threads that lost
//! theirs, and report each machine that is offline with running threads (once per offline spell). Other areas add
//! checks with `register` (webhooks' failing subscriptions, overdue wakes, leases, the doctor); each check is
//! isolated, so one failing does not stop the rest. TS spec: apps/hub/src/sweep/Sweep.ts.
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::model::MachineStatus;
use serde_json::json;

use crate::clock::Clock;
use crate::hub::store::{EventLog, HubStore, iso_ms, now_ms};
use crate::hub::watchdog::Watchdog;

pub const SWEEP_EVERY_MS: u64 = 5 * 60_000;
/// A wake this far past its time is fired by the sweep, per its catch-up rule.
pub const WAKE_OVERDUE_MS: u64 = 2 * 60_000;

pub type CheckFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

#[derive(Clone)]
pub struct SweepCheck {
    /// For logs.
    pub name: String,
    /// Called once per sweep; an `Err` is logged by the check's name and the sweep moves on.
    pub run: Arc<dyn Fn() -> CheckFuture + Send + Sync>,
}

pub struct Sweep {
    store: Arc<HubStore>,
    events: Arc<EventLog>,
    watchdog: Arc<Watchdog>,
    clock: Arc<dyn Clock>,
    checks: Mutex<Vec<SweepCheck>>,
    /// Offline machines already reported, by the lastSeenAt of their offline spell.
    reported: Mutex<HashMap<MachineId, String>>,
}

impl Sweep {
    pub fn new(store: Arc<HubStore>, events: Arc<EventLog>, watchdog: Arc<Watchdog>, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self { store, events, watchdog, clock, checks: Mutex::default(), reported: Mutex::default() })
    }

    /// Sweeps every `every_ms` from now on, in its own task.
    pub fn start(self: &Arc<Self>, every_ms: u64) -> tokio::task::JoinHandle<()> {
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                this.clock.sleep(Duration::from_millis(every_ms)).await;
                this.run_once().await;
            }
        })
    }

    /// Adds a check to every sweep from now on.
    pub fn register(&self, check: SweepCheck) {
        self.checks.lock().unwrap().push(check);
    }

    async fn streams(&self) -> Result<(), String> {
        let opened = self.watchdog.resubscribe().await;
        if opened > 0 {
            tracing::info!(opened, "sweep: re-opened thread streams");
        }
        Ok(())
    }

    async fn offline_machines(&self) -> Result<(), String> {
        let machines = self.store.machines_list().map_err(|e| e.to_string())?;
        let running = self.store.threads_running().map_err(|e| e.to_string())?;
        for machine in machines {
            if machine.status != MachineStatus::Offline {
                self.reported.lock().unwrap().remove(&machine.machine_id);
                continue;
            }
            let threads: Vec<_> = running.iter().filter(|t| t.machine_id == machine.machine_id).collect();
            let since = machine.last_seen_at.0.clone();
            if threads.is_empty() || self.reported.lock().unwrap().get(&machine.machine_id) == Some(&since) {
                continue;
            }
            self.reported.lock().unwrap().insert(machine.machine_id.clone(), since.clone());
            let n = threads.len();
            let event = json!({
                "at": iso_ms(now_ms(self.clock.as_ref())),
                "type": "machine.offline",
                "machineId": machine.machine_id,
                "summary": format!(
                    "{} is still offline with {n} running thread{}; their runs are not being watched",
                    machine.machine_id,
                    if n == 1 { "" } else { "s" }
                ),
                "data": {
                    "since": since,
                    "runningThreads": threads.iter().take(20).map(|t| &t.thread_id).collect::<Vec<_>>(),
                    "count": n,
                },
            });
            let event = serde_json::from_value(event).map_err(|e| e.to_string())?;
            self.events.append(event).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// One sweep now: the built-in checks, then the registered ones in order. Checks registered after the loop
    /// started are included.
    pub async fn run_once(&self) {
        let report = |name: &str, result: Result<(), String>| {
            if let Err(error) = result {
                tracing::warn!(check = name, error = %error, "sweep: check failed");
            }
        };
        report("streams", self.streams().await);
        report("offline-machines", self.offline_machines().await);
        let checks = self.checks.lock().unwrap().clone();
        for check in checks {
            // Isolated: a panicking check is a failed check, not a dead sweep.
            let result = tokio::spawn((check.run)()).await.unwrap_or_else(|e| Err(e.to_string()));
            report(&check.name, result);
        }
    }
}
