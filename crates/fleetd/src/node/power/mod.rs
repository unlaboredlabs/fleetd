//! Machines that sleep. While any session runs the node holds a sleep inhibitor, named for how many agents run, and
//! drops it when none do. When the machine wakes anyway (a lid, a power button, a desktop that ignores inhibitors)
//! the node notices the jump in time asleep, re-links to the hub at once, has the session service check its live
//! sessions, and reports the sleep to the hub.
pub mod clock;
pub mod inhibit;
pub mod settings;

use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::watch;

pub use clock::Slept;

use super::sessions::SessionService;

/// How often the clocks are read. A wake is noticed within this.
const TICK: Duration = Duration::from_secs(5);
/// Sleeps kept for a hub that is not linked yet; older ones are dropped.
const PENDING_MAX: usize = 8;

/// What the hub link learns of wakes: a counter that moves on each one, and the sleeps not yet sent.
pub struct Wakes {
    woke: watch::Sender<u64>,
    pending: Mutex<Vec<Slept>>,
}

impl Default for Wakes {
    fn default() -> Self {
        Self {
            woke: watch::Sender::new(0),
            pending: Mutex::default(),
        }
    }
}

impl Wakes {
    pub fn woke(&self, slept: Slept) {
        {
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            pending.push(slept);
            let over = pending.len().saturating_sub(PENDING_MAX);
            pending.drain(..over);
        }
        self.woke.send_modify(|n| *n += 1);
    }

    /// Changes on every wake after the call.
    pub fn watch(&self) -> watch::Receiver<u64> {
        self.woke.subscribe()
    }

    /// The sleeps to report, once: a link that drops before they reach the hub loses them.
    pub fn take(&self) -> Vec<Slept> {
        std::mem::take(&mut *self.pending.lock().unwrap_or_else(|p| p.into_inner()))
    }
}

/// The inhibitor for `running` agents: one hold while any run, its name updated when the count changes. Gives up
/// for good (logged once) where there is nothing to hold one with: no logind, no system bus, a container.
#[derive(Default)]
struct Inhibitor {
    held: Option<(usize, inhibit::Hold)>,
    unavailable: bool,
}

impl Inhibitor {
    async fn set(&mut self, running: usize) {
        if running == 0 {
            if self.held.take().is_some() {
                tracing::info!("no agents running; sleep inhibitor released");
            }
            return;
        }
        if self.unavailable || self.held.as_ref().is_some_and(|(n, _)| *n == running) {
            return;
        }
        let why = inhibit::why(running);
        match inhibit::take(&why).await {
            // The old hold is dropped only after the new one is held, so there is no gap.
            Ok(hold) => {
                if self.held.replace((running, hold)).is_none() {
                    tracing::info!(%why, "holding a sleep inhibitor while agents run");
                }
            }
            Err(error) => {
                self.unavailable = true;
                tracing::warn!(%error, "cannot keep this machine awake while agents run; it may sleep under them");
            }
        }
    }
}

/// Runs for the node's lifetime.
pub async fn run(sessions: SessionService, wakes: std::sync::Arc<Wakes>) {
    let mut running = sessions.running();
    let mut inhibitor = Inhibitor::default();
    let mut sleeps = clock::SleepWatch::default();
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if let Some(slept) = clock::sample().and_then(|s| sleeps.observe(s)) {
                    tracing::info!(slept_ms = slept.ms(), "the machine woke from sleep");
                    wakes.woke(slept);
                    sessions.woke();
                }
            }
            changed = running.changed() => {
                if changed.is_err() {
                    return;
                }
            }
        }
        let now = *running.borrow_and_update();
        inhibitor.set(now).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_sleeps_go_out_once_and_stay_bounded() {
        let wakes = Wakes::default();
        let mut seen = wakes.watch();
        for i in 0..10 {
            wakes.woke(Slept {
                from_ms: i,
                to_ms: i + 10_000,
            });
        }
        assert!(seen.has_changed().unwrap());
        seen.borrow_and_update();
        let sent = wakes.take();
        assert_eq!(sent.len(), PENDING_MAX);
        assert_eq!(sent[0].from_ms, 2);
        assert!(wakes.take().is_empty());
        assert!(!seen.has_changed().unwrap());
    }
}
