//! The stall ladder, over a port so it runs on a test clock. TS spec: apps/hub/src/watchdog/Watchdog.ts.
use std::collections::HashMap;
use std::future::Future;

use serde_json::{Value, json};
use tokio::sync::Mutex;

/// `(machine_id, thread_id)`.
pub type Key = (String, String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchdogConfig {
    /// No frame for this long outside a tool is a stall.
    pub outside_tool_ms: u64,
    /// A tool's timeout when it states none.
    pub tool_timeout_ms: u64,
    /// Inside a tool, a stall is no frame for the tool's timeout plus this.
    pub inside_tool_grace_ms: u64,
    /// How often running threads are checked.
    pub check_every_ms: u64,
}

const MIN: u64 = 60_000;
pub const DEFAULT_CONFIG: WatchdogConfig = WatchdogConfig {
    outside_tool_ms: 10 * MIN,
    tool_timeout_ms: 10 * MIN,
    inside_tool_grace_ms: 10 * MIN,
    check_every_ms: 30_000,
};

pub const NUDGE: &str = "You seem stalled; continue the task from where you stopped.";

/// Thresholds from `FLEETD_STALL_*` / `FLEETD_WATCHDOG_EVERY_SEC` (seconds); unset or invalid keeps the default.
pub fn config_from_env(get: impl Fn(&str) -> Option<String>) -> WatchdogConfig {
    let mut config = DEFAULT_CONFIG;
    let read = |name: &str, field: &mut u64| {
        if let Some(seconds) = get(name).and_then(|raw| raw.trim().parse::<f64>().ok())
            && seconds.is_finite()
            && seconds > 0.0
        {
            *field = (seconds * 1000.0).round() as u64;
        }
    };
    read("FLEETD_STALL_OUTSIDE_SEC", &mut config.outside_tool_ms);
    read("FLEETD_STALL_TOOL_TIMEOUT_SEC", &mut config.tool_timeout_ms);
    read(
        "FLEETD_STALL_INSIDE_GRACE_SEC",
        &mut config.inside_tool_grace_ms,
    );
    read("FLEETD_WATCHDOG_EVERY_SEC", &mut config.check_every_ms);
    config
}

/// Set while a command or tool call of the run is open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Tool {
    pub stated_timeout_ms: Option<u64>,
    pub unstated: bool,
}

/// The threshold for a run in its current state.
pub fn threshold_ms(config: &WatchdogConfig, tool: Option<Tool>) -> u64 {
    match tool {
        None => config.outside_tool_ms,
        Some(t) => {
            t.stated_timeout_ms.unwrap_or(0).max(if t.unstated {
                config.tool_timeout_ms
            } else {
                0
            }) + config.inside_tool_grace_ms
        }
    }
}

/// What the watchdog reads and drives: the executor's thread watch, interrupt and send, and the event log.
pub trait WatchPort: Send + Sync {
    fn now_ms(&self) -> u64;
    /// `(key, run_id)` of threads whose shell row says running, on machines with a live T3 connection.
    fn running(&self) -> Vec<(Key, String)>;
    /// `(run_id, running)` as last seen; None for an unknown thread.
    fn latest_run(&self, key: &Key) -> Option<(Option<String>, bool)>;
    /// Opens the thread's stream if needed and keeps it open; false when it could not.
    fn follow(&self, key: &Key) -> impl Future<Output = bool> + Send;
    fn release(&self, key: &Key);
    /// `(last_frame_ms, open tool)`; None when no stream is open.
    fn progress(&self, key: &Key) -> Option<(u64, Option<Tool>)>;
    fn interrupt(
        &self,
        key: &Key,
        client_request_id: &str,
    ) -> impl Future<Output = Result<(), String>> + Send;
    fn send(
        &self,
        key: &Key,
        message: &str,
        client_request_id: &str,
    ) -> impl Future<Output = Result<(), String>> + Send;
    /// Appends a thread event; the port fills in the thread's title and project from the store.
    fn emit(
        &self,
        key: &Key,
        kind: &'static str,
        detail: String,
        data: Value,
    ) -> impl Future<Output = ()> + Send;
}

/// Where a thread is on the ladder. No entry means no stall in its current chain.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Chain {
    /// Stalled and interrupted; the nudge goes out once the run has ended.
    Interrupting { run_id: String, at: u64 },
    /// The nudge went out; the next run is its continuation, and its stall fails the chain.
    Nudged { stalled_run_id: String, at: u64 },
    /// Failed for stalling; nothing more until this run ends.
    Failed { run_id: String, at: u64 },
}

impl Chain {
    fn at(&self) -> u64 {
        match self {
            Self::Interrupting { at, .. } | Self::Nudged { at, .. } | Self::Failed { at, .. } => {
                *at
            }
        }
    }
}

#[derive(Default)]
struct State {
    chains: HashMap<Key, Chain>,
    /// Threads this watchdog has pinned a stream for.
    followed: HashMap<Key, ()>,
}

fn minutes(ms: u64) -> String {
    if ms.is_multiple_of(MIN) {
        format!("{} min", ms / MIN)
    } else {
        format!("{} s", (ms as f64 / 1000.0).round() as u64)
    }
}

fn where_(in_tool: bool) -> &'static str {
    if in_tool {
        "inside a tool"
    } else {
        "outside a tool"
    }
}

pub struct Ladder<P> {
    pub config: WatchdogConfig,
    pub port: P,
    state: Mutex<State>,
}

impl<P: WatchPort> Ladder<P> {
    pub fn new(config: WatchdogConfig, port: P) -> Self {
        Self {
            config,
            port,
            state: Mutex::new(State::default()),
        }
    }

    async fn follow(&self, state: &mut State, key: &Key) -> bool {
        let ok = self.port.follow(key).await;
        if ok {
            state.followed.insert(key.clone(), ());
        }
        ok
    }

    /// Opens a stream for every running thread without one; returns how many it opened.
    pub async fn resubscribe(&self) -> usize {
        let mut state = self.state.lock().await;
        let missing: Vec<Key> = self
            .port
            .running()
            .into_iter()
            .map(|(k, _)| k)
            .filter(|k| self.port.progress(k).is_none())
            .collect();
        let mut opened = 0;
        for key in missing {
            if self.follow(&mut state, &key).await {
                opened += 1;
            }
        }
        opened
    }

    #[allow(clippy::too_many_arguments)]
    async fn stall(
        &self,
        state: &mut State,
        key: &Key,
        run_id: &str,
        idle: u64,
        limit: u64,
        in_tool: bool,
        now: u64,
    ) {
        let detail = format!(
            "stalled: no progress for {} {}; interrupting and nudging once",
            minutes(idle),
            where_(in_tool)
        );
        let data = json!({
            "status": "running",
            "runId": run_id,
            "inTool": in_tool,
            "idleSec": (idle as f64 / 1000.0).round() as u64,
            "thresholdSec": (limit as f64 / 1000.0).round() as u64,
        });
        self.port.emit(key, "thread.stalled", detail, data).await;
        state.chains.insert(
            key.clone(),
            Chain::Interrupting {
                run_id: run_id.to_owned(),
                at: now,
            },
        );
        if let Err(e) = self
            .port
            .interrupt(key, &format!("watchdog:{run_id}:interrupt"))
            .await
        {
            tracing::warn!(machine_id = %key.0, thread_id = %key.1, error = %e, "watchdog: interrupt failed");
        }
    }

    async fn fail(
        &self,
        state: &mut State,
        key: &Key,
        run_id: &str,
        idle: u64,
        in_tool: bool,
        now: u64,
    ) {
        let detail = format!(
            "failed: stalled again after a nudge (no progress for {} {})",
            minutes(idle),
            where_(in_tool)
        );
        let data = json!({
            "status": "failed",
            "runId": run_id,
            "reason": "stalled",
            "error": { "class": "stalled", "message": "stalled twice; the watchdog interrupted it and will not retry" },
        });
        self.port.emit(key, "thread.failed", detail, data).await;
        state.chains.insert(
            key.clone(),
            Chain::Failed {
                run_id: run_id.to_owned(),
                at: now,
            },
        );
        if let Err(e) = self
            .port
            .interrupt(key, &format!("watchdog:{run_id}:fail"))
            .await
        {
            tracing::warn!(machine_id = %key.0, thread_id = %key.1, error = %e, "watchdog: interrupt failed");
        }
    }

    async fn check_running(&self, state: &mut State, key: &Key, run_id: &str, now: u64) {
        let mut chain = state.chains.get(key).cloned();
        if matches!(&chain, Some(Chain::Failed { run_id: r, .. }) if r != run_id) {
            chain = None;
        }
        // A new run before the nudge went out (T3's own continuation, or a user message) stands in for it.
        if let Some(Chain::Interrupting { run_id: r, at }) = &chain
            && r != run_id
        {
            chain = Some(Chain::Nudged {
                stalled_run_id: r.clone(),
                at: *at,
            });
        }
        match &chain {
            None => {
                state.chains.remove(key);
            }
            Some(c) => {
                state.chains.insert(key.clone(), c.clone());
            }
        }
        if matches!(chain, Some(Chain::Failed { .. })) {
            return;
        }
        let Some((last_frame_ms, tool)) = self.port.progress(key) else {
            self.follow(state, key).await;
            return;
        };
        let limit = threshold_ms(&self.config, tool);
        let idle = now.saturating_sub(last_frame_ms.max(chain.as_ref().map_or(0, Chain::at)));
        if idle < limit {
            return;
        }
        let in_tool = tool.is_some();
        if chain.is_none() {
            self.stall(state, key, run_id, idle, limit, in_tool, now)
                .await;
        } else {
            self.fail(state, key, run_id, idle, in_tool, now).await;
        }
    }

    /// A thread on the ladder or followed that is no longer running.
    async fn check_ended(&self, state: &mut State, key: &Key, now: u64) {
        let chain = state.chains.get(key).cloned();
        let latest = self.port.latest_run(key);
        // Running but not listed: its machine is disconnected.
        if latest.as_ref().is_some_and(|(_, running)| *running) {
            return;
        }
        if let (Some(Chain::Interrupting { run_id, .. }), Some(_)) = (&chain, &latest) {
            match self
                .port
                .send(key, NUDGE, &format!("watchdog:{run_id}:continue"))
                .await
            {
                Ok(()) => {
                    state.chains.insert(
                        key.clone(),
                        Chain::Nudged {
                            stalled_run_id: run_id.clone(),
                            at: now,
                        },
                    );
                }
                Err(e) => {
                    tracing::warn!(machine_id = %key.0, thread_id = %key.1, error = %e, "watchdog: nudge failed; retrying next check");
                }
            }
            return;
        }
        // The continuation has not started yet; give it one outside-tool threshold.
        if let Some(Chain::Nudged { stalled_run_id, at }) = &chain
            && latest.as_ref().and_then(|(r, _)| r.as_ref()) == Some(stalled_run_id)
            && now.saturating_sub(*at) < self.config.outside_tool_ms
        {
            return;
        }
        state.chains.remove(key);
        if state.followed.remove(key).is_some() {
            self.port.release(key);
        }
    }

    /// One pass over running threads: open missing streams, detect stalls, advance the ladder.
    pub async fn check(&self) {
        let mut state = self.state.lock().await;
        let now = self.port.now_ms();
        let running = self.port.running();
        let mut live: Vec<&Key> = vec![];
        for (key, run_id) in &running {
            live.push(key);
            self.check_running(&mut state, key, run_id, now).await;
        }
        let mut idle: Vec<Key> = state.followed.keys().cloned().collect();
        for key in state.chains.keys() {
            if !idle.contains(key) {
                idle.push(key.clone());
            }
        }
        for key in idle {
            if !live.contains(&&key) {
                self.check_ended(&mut state, &key, now).await;
            }
        }
    }
}
