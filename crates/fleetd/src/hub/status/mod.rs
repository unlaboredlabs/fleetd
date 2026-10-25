//! Status: one row per project (`rows.rs`), its work in groups (`groups.rs`). A row is read when someone asks, from
//! the event log and the hub's own records, and read again after any event, so it is never older than the last
//! event. One task follows the freshness deadlines, flipping sources stale or fresh with an event. Nothing polls.
pub mod fresh;
pub mod groups;
pub mod rows;
pub mod tools;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::status::ProjectStatusRow;

use crate::hub::api::{Caller, Hub, readable};
use crate::hub::store::{NewEvent, iso_ms, now_ms};

pub struct Status {
    pub fresh: Arc<fresh::Fresh>,
    /// The rows as last read, and the event head they were read at.
    rows: Mutex<Option<(i64, Vec<ProjectStatusRow>)>>,
}

impl Status {
    pub fn new(fresh: Arc<fresh::Fresh>) -> Arc<Self> {
        Arc::new(Self {
            fresh,
            rows: Mutex::default(),
        })
    }

    /// One row per project the caller reads, by title.
    pub fn project_rows(
        &self,
        hub: &Hub,
        caller: &Caller,
    ) -> anyhow::Result<Vec<ProjectStatusRow>> {
        let now = now_ms(hub.clock.as_ref());
        let head = hub.events.head();
        let cached = self
            .rows
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(h, _)| *h == head)
            .map(|(_, r)| r.clone());
        let all = match cached {
            Some(r) => r,
            None => {
                let r = rows::read(hub, &self.fresh, now)?;
                *self.rows.lock().unwrap() = Some((head, r.clone()));
                r
            }
        };
        Ok(all
            .into_iter()
            .filter(|r| readable(caller, &r.project_ref.machine_id))
            .collect())
    }

    /// One project's row; None when the caller reads no such project.
    pub fn project(
        &self,
        hub: &Hub,
        caller: &Caller,
        r: &ProjectRef,
    ) -> anyhow::Result<Option<ProjectStatusRow>> {
        Ok(self
            .project_rows(hub, caller)?
            .into_iter()
            .find(|row| row.project_ref == *r))
    }

    fn emit_flip(&self, hub: &Hub, flip: fresh::Flip) {
        let (t, summary, data) = match flip {
            fresh::Flip::Stale {
                source,
                since_ms,
                reason,
            } => (
                HubEventType::SourceStale,
                format!("{source} stale: {reason}"),
                serde_json::json!({ "source": source, "sinceMs": since_ms, "reason": reason }),
            ),
            fresh::Flip::Fresh { source, stale_ms } => (
                HubEventType::SourceFresh,
                format!("{source} live again"),
                serde_json::json!({ "source": source, "staleMs": stale_ms }),
            ),
        };
        let event = NewEvent {
            at: Timestamp(iso_ms(now_ms(hub.clock.as_ref()))),
            r#type: t,
            machine_id: None,
            project_id: None,
            thread_id: None,
            summary,
            data: Some(data),
            attention: None,
        };
        if let Err(error) = hub.events.append(event) {
            tracing::error!(%error, "status: source event");
        }
    }

    /// The follower: freshness flips and deadlines. Runs until shutdown.
    pub async fn run(self: Arc<Self>, hub: Arc<Hub>) {
        loop {
            let now = now_ms(hub.clock.as_ref());
            for flip in self.fresh.check(now) {
                self.emit_flip(&hub, flip);
            }
            let sleep_ms = self.fresh.next_deadline().map_or(3_600_000, |d| {
                (d - now_ms(hub.clock.as_ref())).clamp(0, 3_600_000)
            });
            tokio::select! {
                () = self.fresh.notify.notified() => {}
                () = hub.clock.sleep(Duration::from_millis(sleep_ms as u64)) => {}
                () = hub.shutdown.wait() => return,
            }
        }
    }
}

#[cfg(test)]
mod tests;
