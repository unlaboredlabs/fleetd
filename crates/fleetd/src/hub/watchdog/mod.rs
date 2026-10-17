//! The stall watchdog. Every running thread gets a persistent thread stream; a run with no frame for longer than its
//! threshold is stalled. The ladder per chain: emit thread.stalled and interrupt; once the run has ended, send one
//! "continue"; a second stall in the chain emits thread.failed{reason:"stalled"} and interrupts again, with no more
//! retries. Deterministic, no LLM. TS spec: apps/hub/src/watchdog/Watchdog.ts.
pub mod ladder;
#[cfg(test)]
mod ladder_tests;

use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::ids::ThreadRef;
use serde_json::{Value, json};

pub use ladder::{DEFAULT_CONFIG, NUDGE, WatchdogConfig, config_from_env, threshold_ms};
use ladder::{Key, Ladder, Tool, WatchPort};

use crate::clock::Clock;
use crate::hub::executor::Executors;
use crate::hub::store::{EventLog, HubStore, iso_ms, now_ms};

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
    fn progress(&self, key: &Key) -> Option<(u64, Option<Tool>)> {
        let p = self.executors.progress(&thread_ref(key)?)?;
        Some((
            p.last_frame_ms,
            p.tool.map(|t| Tool {
                stated_timeout_ms: t.stated_timeout_ms,
                unstated: t.unstated,
            }),
        ))
    }
    async fn interrupt(&self, key: &Key, client_request_id: &str) -> Result<(), String> {
        let r = thread_ref(key).ok_or("bad thread ref")?;
        self.executors
            .interrupt(&r, client_request_id)
            .await
            .map_err(|e| e.to_string())
    }
    async fn send(&self, key: &Key, message: &str, client_request_id: &str) -> Result<(), String> {
        let r = thread_ref(key).ok_or("bad thread ref")?;
        self.executors
            .send(&r, message, client_request_id)
            .await
            .map(|_| ())
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

pub struct Watchdog {
    ladder: Ladder<HubWatch>,
}

impl Watchdog {
    pub fn new(
        config: WatchdogConfig,
        executors: Arc<Executors>,
        store: Arc<HubStore>,
        events: Arc<EventLog>,
        clock: Arc<dyn Clock>,
    ) -> Arc<Self> {
        Arc::new(Self {
            ladder: Ladder::new(
                config,
                HubWatch {
                    executors,
                    store,
                    events,
                    clock,
                },
            ),
        })
    }

    /// Checks every `config.check_every_ms`, in its own task.
    pub fn start(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let this = self.clone();
        tokio::spawn(async move {
            loop {
                let every = Duration::from_millis(this.ladder.config.check_every_ms);
                this.ladder.port.clock.sleep(every).await;
                this.check().await;
            }
        })
    }

    /// One pass over running threads: open missing streams, detect stalls, advance the ladder.
    pub async fn check(&self) {
        self.ladder.check().await;
    }

    /// Opens a stream for every running thread without one; returns how many it opened.
    pub async fn resubscribe(&self) -> usize {
        self.ladder.resubscribe().await
    }
}
