//! The stall watchdog. Every running thread gets a persistent thread stream; a run with no frame for longer than its
//! threshold is stalled. The hub emits thread.failed{reason:"stalled"} and interrupts the run, once: the task fails, its
//! lead is woken with the reason, and the lead decides whether to continue it. Deterministic, no LLM.
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::ids::ThreadRef;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::clock::Clock;
use crate::hub::executor::{Executors, OpenTool};
use crate::hub::store::{EventLog, HubStore, iso_ms, now_ms};

/// No frame for this long outside a tool is a stall. Inside a tool it is the tool's own timeout (this, when it states
/// none) plus this again.
pub const STALL_MS: u64 = 10 * 60_000;

/// `FLEETD_STALL_SEC` shortens the stall threshold for the lab, which drives a real hub; unset keeps [`STALL_MS`].
pub fn stall_ms_from_env() -> u64 {
    std::env::var("FLEETD_STALL_SEC")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|&s| s > 0)
        .map_or(STALL_MS, |s| s * 1000)
}

/// The threshold for a run in its current state.
fn threshold_ms(stall_ms: u64, tool: Option<OpenTool>) -> u64 {
    match tool {
        None => stall_ms,
        Some(t) => {
            t.stated_timeout_ms
                .unwrap_or(0)
                .max(if t.unstated { stall_ms } else { 0 })
                + stall_ms
        }
    }
}

/// `(machine_id, thread_id)`.
pub type Key = (String, String);

/// What the watchdog reads and drives: the executor's thread watch and interrupt, and the event log.
pub trait WatchPort: Send + Sync {
    fn now_ms(&self) -> u64;
    /// `(key, run_id)` of threads whose shell row says running, on machines with a live node link.
    fn running(&self) -> Vec<(Key, String)>;
    /// `(run_id, running)` as last seen; None for an unknown thread.
    fn latest_run(&self, key: &Key) -> Option<(Option<String>, bool)>;
    /// Opens the thread's stream if needed and keeps it open; false when it could not.
    fn follow(&self, key: &Key) -> impl Future<Output = bool> + Send;
    fn release(&self, key: &Key);
    /// `(last_frame_ms, open tool)`; None when no stream is open.
    fn progress(&self, key: &Key) -> Option<(u64, Option<OpenTool>)>;
    fn interrupt(&self, key: &Key) -> impl Future<Output = Result<(), String>> + Send;
    /// Appends a thread event; the port fills in the thread's title and project from the store.
    fn emit(
        &self,
        key: &Key,
        kind: &'static str,
        detail: String,
        data: Value,
    ) -> impl Future<Output = ()> + Send;
}

#[derive(Default)]
struct State {
    /// The run each thread stalled in: nothing more happens to that run.
    stalled: HashMap<Key, String>,
    /// Threads this watchdog has pinned a stream for.
    followed: HashSet<Key>,
}

fn minutes(ms: u64) -> String {
    if ms.is_multiple_of(60_000) {
        format!("{} min", ms / 60_000)
    } else {
        format!("{} s", (ms as f64 / 1000.0).round() as u64)
    }
}

pub struct Watchdog<P = HubWatch> {
    stall_ms: u64,
    port: P,
    state: Mutex<State>,
}

impl<P: WatchPort> Watchdog<P> {
    pub fn with_port(stall_ms: u64, port: P) -> Self {
        Self {
            stall_ms,
            port,
            state: Mutex::default(),
        }
    }

    async fn follow(&self, state: &mut State, key: &Key) -> bool {
        let ok = self.port.follow(key).await;
        if ok {
            state.followed.insert(key.clone());
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

    async fn check_running(&self, state: &mut State, key: &Key, run_id: &str, now: u64) {
        if state.stalled.get(key).is_some_and(|r| r == run_id) {
            return;
        }
        state.stalled.remove(key);
        let Some((last_frame_ms, tool)) = self.port.progress(key) else {
            self.follow(state, key).await;
            return;
        };
        let limit = threshold_ms(self.stall_ms, tool);
        let idle = now.saturating_sub(last_frame_ms);
        if idle < limit {
            return;
        }
        let where_ = if tool.is_some() {
            "inside a tool"
        } else {
            "outside a tool"
        };
        let why = format!(
            "no progress for {} {where_}, so fleetd interrupted it",
            minutes(idle)
        );
        let data = json!({
            "status": "failed",
            "runId": run_id,
            "reason": "stalled",
            "inTool": tool.is_some(),
            "idleSec": (idle as f64 / 1000.0).round() as u64,
            "thresholdSec": (limit as f64 / 1000.0).round() as u64,
            "error": { "class": "stalled", "message": why },
        });
        // Before the interrupt, so the task fails with this reason rather than as a plain interrupt.
        self.port
            .emit(key, "thread.failed", format!("stalled: {why}"), data)
            .await;
        state.stalled.insert(key.clone(), run_id.to_owned());
        if let Err(e) = self.port.interrupt(key).await {
            tracing::warn!(machine_id = %key.0, thread_id = %key.1, error = %e, "watchdog: interrupt failed");
        }
    }

    /// A stalled or followed thread that is no longer running.
    async fn check_ended(&self, state: &mut State, key: &Key) {
        // Running but not listed: its machine is disconnected.
        if self
            .port
            .latest_run(key)
            .is_some_and(|(_, running)| running)
        {
            return;
        }
        state.stalled.remove(key);
        if state.followed.remove(key) {
            self.port.release(key);
        }
    }

    /// One pass over running threads: open missing streams and detect stalls.
    pub async fn check(&self) {
        let mut state = self.state.lock().await;
        let now = self.port.now_ms();
        let running = self.port.running();
        for (key, run_id) in &running {
            self.check_running(&mut state, key, run_id, now).await;
        }
        let ended: Vec<Key> = state
            .followed
            .iter()
            .chain(state.stalled.keys())
            .filter(|k| !running.iter().any(|(r, _)| r == *k))
            .cloned()
            .collect();
        for key in ended {
            self.check_ended(&mut state, &key).await;
        }
    }
}

pub struct HubWatch {
    executors: Arc<Executors>,
    store: Arc<HubStore>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
}

fn thread_ref(key: &Key) -> Option<ThreadRef> {
    serde_json::from_value(json!({ "machineId": key.0, "threadId": key.1 })).ok()
}

impl WatchPort for HubWatch {
    fn now_ms(&self) -> u64 {
        now_ms(self.clock.as_ref()).max(0) as u64
    }
    fn running(&self) -> Vec<(Key, String)> {
        self.executors
            .running()
            .into_iter()
            .map(|r| {
                (
                    (
                        r.thread_ref.machine_id.to_string(),
                        r.thread_ref.thread_id.to_string(),
                    ),
                    r.run_id,
                )
            })
            .collect()
    }
    fn latest_run(&self, key: &Key) -> Option<(Option<String>, bool)> {
        self.executors
            .latest_run(&thread_ref(key)?)
            .map(|l| (l.run_id, l.running))
    }
    async fn follow(&self, key: &Key) -> bool {
        match thread_ref(key) {
            Some(r) => self.executors.follow(&r).await.is_ok(),
            None => false,
        }
    }
    fn release(&self, key: &Key) {
        if let Some(r) = thread_ref(key) {
            self.executors.release(&r);
        }
    }
    fn progress(&self, key: &Key) -> Option<(u64, Option<OpenTool>)> {
        let p = self.executors.progress(&thread_ref(key)?)?;
        Some((p.last_frame_ms, p.tool))
    }
    async fn interrupt(&self, key: &Key) -> Result<(), String> {
        let r = thread_ref(key).ok_or("bad thread ref")?;
        self.executors
            .interrupt(&r, "watchdog")
            .await
            .map_err(|e| e.to_string())
    }
    async fn emit(&self, key: &Key, kind: &'static str, detail: String, data: Value) {
        let summary = thread_ref(key).and_then(|r| self.store.thread_get(&r).ok().flatten());
        let title = summary
            .as_ref()
            .map_or(key.1.as_str(), |s| s.thread.title.as_str());
        let mut event = json!({
            "at": iso_ms(now_ms(self.clock.as_ref())),
            "type": kind,
            "machineId": key.0,
            "threadId": key.1,
            "summary": format!("\"{title}\" on {} {detail}", key.0),
            "data": data,
        });
        if let Some(s) = &summary {
            event["projectId"] = json!(s.thread.project_id);
        }
        match serde_json::from_value(event) {
            Ok(event) => {
                if let Err(e) = self.events.append(event) {
                    tracing::error!(error = %e, "watchdog: event append failed");
                }
            }
            Err(e) => tracing::error!(error = %e, "watchdog: event does not decode"),
        }
    }
}

impl Watchdog {
    pub fn new(
        stall_ms: u64,
        executors: Arc<Executors>,
        store: Arc<HubStore>,
        events: Arc<EventLog>,
        clock: Arc<dyn Clock>,
    ) -> Arc<Self> {
        Arc::new(Self::with_port(
            stall_ms,
            HubWatch {
                executors,
                store,
                events,
                clock,
            },
        ))
    }

    /// Checks every 30 s (sooner under a short lab threshold), in its own task.
    pub fn start(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let this = self.clone();
        let every = Duration::from_millis((self.stall_ms / 20).clamp(1000, 30_000));
        tokio::spawn(async move {
            loop {
                this.port.clock.sleep(every).await;
                this.check().await;
            }
        })
    }
}
