//! A start, stage by stage: a screen's start or end (W245), or an agent's launch (W363). Each stage's time goes to the
//! log at debug level as it ends, so `FLEETD_LOG=info,fleetd::stages=debug` on a hub or node shows where a start spends
//! its time (docs: Browser sessions, Troubleshooting). An agent's launch that took `SLOW` or more says so at info, with
//! every stage, so it explains itself in the log a hub or node keeps by default.
use std::time::{Duration, Instant};

/// A start this slow logs its stages at info (`Stages::end`).
pub const SLOW: Duration = Duration::from_secs(2);

/// One start's clock: `what` names it in the log (`hub screen_open`, `node launch`), `id` the screen or session once
/// known.
pub struct Stages {
    what: &'static str,
    id: String,
    start: Instant,
    last: Instant,
    /// Each stage so far and its time, for `end`.
    done: Vec<(String, u64)>,
}

impl Stages {
    pub fn new(what: &'static str) -> Self {
        let now = Instant::now();
        Self {
            what,
            id: String::new(),
            start: now,
            last: now,
            done: Vec::new(),
        }
    }

    /// Names the screen or session in the stages logged from now on.
    pub fn id(&mut self, id: &str) {
        id.clone_into(&mut self.id);
    }

    /// Logs `stage` as ending now: its own time, and the start's so far.
    pub fn done(&mut self, stage: &str) {
        let now = Instant::now();
        let ms = now.duration_since(self.last).as_millis() as u64;
        tracing::debug!(
            start = self.what,
            id = %self.id,
            stage,
            ms,
            total_ms = now.duration_since(self.start).as_millis() as u64,
            "start stage"
        );
        self.done.push((stage.to_owned(), ms));
        self.last = now;
    }

    /// Since the start, in ms.
    pub fn total_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    /// The start is over: one that took `SLOW` or more logs each stage's time at info (`fetch 1200 ms, worktree 90 ms`).
    pub fn end(&self) {
        let total_ms = self.total_ms();
        if total_ms < SLOW.as_millis() as u64 {
            return;
        }
        tracing::info!(
            start = self.what,
            id = %self.id,
            total_ms,
            stages = %self.line(),
            "slow start"
        );
    }

    fn line(&self) -> String {
        self.done
            .iter()
            .map(|(stage, ms)| format!("{stage} {ms} ms"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// The hub's and node's log filter: `FLEETD_LOG` (as `RUST_LOG` reads, e.g. `fleetd=debug`), else info.
pub fn log_filter() -> tracing_subscriber::EnvFilter {
    tracing_subscriber::EnvFilter::try_from_env("FLEETD_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_slow_line_lists_each_stage_in_order() {
        let mut stages = Stages::new("node launch");
        stages.done("fetch");
        stages.done("worktree");
        let line = stages.line();
        assert!(line.starts_with("fetch "), "{line}");
        assert!(line.contains(" ms, worktree "), "{line}");
        assert!(line.ends_with(" ms"), "{line}");
    }
}
