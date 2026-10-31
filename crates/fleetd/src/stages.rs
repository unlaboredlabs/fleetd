//! A screen's start, stage by stage (W245): each stage's time goes to the log at debug level as it ends, so
//! `FLEETD_LOG=fleetd=debug` on a hub or node shows where a start spends its time (docs: Browser sessions).
use std::time::Instant;

/// One start's clock: `what` names it in the log (`hub screen_open`, `node browser`), `id` the screen once known.
pub struct Stages {
    what: &'static str,
    id: String,
    start: Instant,
    last: Instant,
}

impl Stages {
    pub fn new(what: &'static str) -> Self {
        let now = Instant::now();
        Self {
            what,
            id: String::new(),
            start: now,
            last: now,
        }
    }

    /// Names the screen in the stages logged from now on.
    pub fn id(&mut self, id: &str) {
        id.clone_into(&mut self.id);
    }

    /// Logs `stage` as ending now: its own time, and the start's so far.
    pub fn done(&mut self, stage: &str) {
        let now = Instant::now();
        tracing::debug!(
            start = self.what,
            screen = %self.id,
            stage,
            ms = now.duration_since(self.last).as_millis() as u64,
            total_ms = now.duration_since(self.start).as_millis() as u64,
            "screen start stage"
        );
        self.last = now;
    }

    /// Since the start, in ms.
    pub fn total_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
}

/// The hub's and node's log filter: `FLEETD_LOG` (as `RUST_LOG` reads, e.g. `fleetd=debug`), else info.
pub fn log_filter() -> tracing_subscriber::EnvFilter {
    tracing_subscriber::EnvFilter::try_from_env("FLEETD_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"))
}
