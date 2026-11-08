//! The safety-net sweep: every 5 min, deterministic, no LLM. Built in: re-open streams for running threads that lost
//! theirs. A machine that stays offline is hub/outage's to page, once. Other areas add checks with `register` (overdue
//! wakes, the doctor); each check is isolated, so one failing does not stop the rest.
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::clock::Clock;
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
    watchdog: Arc<Watchdog>,
    clock: Arc<dyn Clock>,
    checks: Mutex<Vec<SweepCheck>>,
}

impl Sweep {
    pub fn new(watchdog: Arc<Watchdog>, clock: Arc<dyn Clock>) -> Arc<Self> {
        Arc::new(Self {
            watchdog,
            clock,
            checks: Mutex::default(),
        })
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

    /// One sweep now: the built-in checks, then the registered ones in order. Checks registered after the loop
    /// started are included.
    pub async fn run_once(&self) {
        let report = |name: &str, result: Result<(), String>| {
            if let Err(error) = result {
                tracing::warn!(check = name, error = %error, "sweep: check failed");
            }
        };
        report("streams", self.streams().await);
        let checks = self.checks.lock().unwrap().clone();
        for check in checks {
            // Isolated: a panicking check is a failed check, not a dead sweep.
            let result = tokio::spawn((check.run)())
                .await
                .unwrap_or_else(|e| Err(e.to_string()));
            report(&check.name, result);
        }
    }
}
