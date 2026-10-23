//! Status: one row per project (`rows.rs`), with the series behind its bar (`credit.rs`). A row is read when someone
//! asks, from the event log and the hub's own records, so it is never older than the read; the rows are read again
//! after an event, at most every 250 ms. One task follows the freshness deadlines (flipping sources stale or fresh
//! with an event) and re-runs the plan's done rule on the events that can change it. Nothing polls.
pub mod credit;
pub mod fresh;
pub mod progress;
pub mod rows;
pub mod tools;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::ledger::WorkstreamState;
use fleetd_contracts::status::{ProgressPoint, ProjectStatusRow};

use crate::hub::api::{Caller, Hub, readable};
use crate::hub::store::{NewEvent, iso_ms, now_ms};

/// Events after which an order's plan items are checked against the done rule again.
const VERIFY_ON: &[HubEventType] = &[
    HubEventType::WorkstreamRunning,
    HubEventType::PrMerged,
    HubEventType::ChangeState,
    HubEventType::TaskStarted,
    HubEventType::WorkstreamDone,
    HubEventType::WorkstreamState,
];

pub struct Status {
    pub fresh: Arc<fresh::Fresh>,
    /// The rows as last read: the event head and time they were read at.
    rows: Mutex<Option<(i64, i64, Vec<ProjectStatusRow>)>>,
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
            .filter(|(h, at, _)| rows::reusable(*h, *at, head, now))
            .map(|(_, _, r)| r.clone());
        let all = match cached {
            Some(r) => r,
            None => {
                let r = rows::read(hub, &self.fresh, now)?;
                *self.rows.lock().unwrap() = Some((head, now, r.clone()));
                r
            }
        };
        Ok(all
            .into_iter()
            .filter(|r| readable(caller, &r.project_ref.machine_id))
            .collect())
    }

    /// One project's row and its series, oldest first; None when the caller reads no such project.
    pub fn project(
        &self,
        hub: &Hub,
        caller: &Caller,
        r: &ProjectRef,
    ) -> anyhow::Result<Option<(ProjectStatusRow, Vec<ProgressPoint>)>> {
        let Some(row) = self
            .project_rows(hub, caller)?
            .into_iter()
            .find(|row| row.project_ref == *r)
        else {
            return Ok(None);
        };
        let key = crate::hub::plan::store::pkey(r);
        let points = hub.db.with(|c| Ok(credit::stored(c, &key)?))?;
        Ok(Some((row, credit::points_out(&points))))
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

    /// Re-runs the done rule where an event may have changed it.
    fn verify_for(&self, hub: &Hub, event: &fleetd_contracts::events::HubEvent) {
        if !VERIFY_ON.contains(&event.r#type) {
            return;
        }
        let data = event.data.as_ref();
        let ws = data
            .and_then(|d| d.get("workstreamId")?.as_str().map(str::to_owned))
            .or_else(|| {
                let change = data?.get("changeId")?.as_str()?.to_owned();
                hub.db
                    .with(|c| {
                        Ok(rusqlite::OptionalExtension::optional(c.query_row(
                            "SELECT json_extract(data, '$.workstreamId') FROM changes WHERE n = ?",
                            [crate::hub::plan::number(&change)],
                            |r| r.get::<_, String>(0),
                        ))?)
                    })
                    .ok()
                    .flatten()
            });
        let Some(ws) = ws else { return };
        if event.r#type == HubEventType::WorkstreamRunning {
            hub.plans.placeholder_enter(&ws, false);
            return;
        }
        hub.plans.verify(&ws);
        let state = match event.r#type {
            HubEventType::WorkstreamDone => Some(WorkstreamState::Done),
            HubEventType::WorkstreamState => match data.and_then(|d| d.get("state")?.as_str()) {
                Some("stopped") => Some(WorkstreamState::Stopped),
                Some("failed") => Some(WorkstreamState::Failed),
                Some("done") => Some(WorkstreamState::Done),
                _ => None,
            },
            _ => None,
        };
        if let Some(state) = state {
            hub.plans.close_order(&ws, state);
            hub.plans.placeholder_order_ended(&ws, state);
        }
    }

    /// The follower: freshness flips and deadlines, the done rule after the events that can change it, and the
    /// placeholders' roll-off. Runs until shutdown.
    pub async fn run(self: Arc<Self>, hub: Arc<Hub>) {
        let mut head = hub.events.subscribe();
        let mut cursor = *head.borrow_and_update();
        // Full rebuild: the done rule for every order with open plan items.
        let orders: Vec<String> = hub
            .db
            .with(|c| {
                let mut stmt = c.prepare(
                    "SELECT DISTINCT workstream_id FROM plan_items WHERE workstream_id IS NOT NULL AND state = 'open'",
                )?;
                Ok(stmt.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?)
            })
            .unwrap_or_default();
        for ws in orders {
            hub.plans.verify(&ws);
        }
        hub.plans.placeholder_backfill();
        loop {
            let now = now_ms(hub.clock.as_ref());
            for flip in self.fresh.check(now) {
                self.emit_flip(&hub, flip);
            }
            loop {
                let page = match hub.events.page(cursor, Some(VERIFY_ON), None) {
                    Ok(p) => p,
                    Err(error) => {
                        tracing::error!(%error, "status: reading events");
                        break;
                    }
                };
                for event in &page.events {
                    self.verify_for(&hub, event);
                }
                cursor = page.cursor;
                if !page.more {
                    break;
                }
            }
            let deadline = [self.fresh.next_deadline(), hub.plans.placeholder_roll_off()]
                .into_iter()
                .flatten()
                .min();
            let sleep_ms = deadline.map_or(3_600_000, |d| {
                (d - now_ms(hub.clock.as_ref())).clamp(0, 3_600_000)
            });
            tokio::select! {
                changed = head.changed() => if changed.is_err() { return },
                () = self.fresh.notify.notified() => {}
                () = hub.clock.sleep(Duration::from_millis(sleep_ms as u64)) => {}
                () = hub.shutdown.wait() => return,
            }
            head.borrow_and_update();
        }
    }
}

#[cfg(test)]
mod tests;
