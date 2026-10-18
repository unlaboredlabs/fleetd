//! When a project is removed from its node, the executor drops it from the hub's cache and emits project.removed. Nothing can run
//! there any more, so the project's live work ends: open asks are withdrawn (they leave the inbox), live tasks are
//! cancelled (their slots and leases go back), and open workstreams stop. Its lead reads as stopped (`lead_state`).
//!
//! The reaction is keyed on the cache, not the event: live work whose project the cache no longer has is ended. That
//! makes it idempotent, so the hub runs it once at start for every such project, and a stop between the event and the
//! reaction loses nothing.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::WorkstreamState;

use super::error::LeadError;
use super::records::{LeadRecords, WorkstreamFilter};
use super::{Ctx, now_iso};
use crate::hub::store::{NewEvent, WaitInput};

pub const STOPPED_REASON: &str = "its project was removed";
pub const ASK_REASON: &str = "project deleted";
const SCAN_LIMIT: usize = 10_000;

pub struct ProjectRemovals {
    ctx: Arc<Ctx>,
    records: Arc<LeadRecords>,
}

impl ProjectRemovals {
    pub fn new(ctx: Arc<Ctx>, records: Arc<LeadRecords>) -> Arc<Self> {
        Arc::new(Self { ctx, records })
    }

    /// Ends the project's live work if the cache no longer has the project; a no-op otherwise.
    pub async fn reconcile(&self, r: &ProjectRef) -> Result<(), LeadError> {
        if self.ctx.store.project_get(r)?.is_some() {
            return Ok(());
        }
        let asks = self.ctx.ports().open_asks(Some(r), None, SCAN_LIMIT)?;
        for ask in asks {
            let _ = self.ctx.ports().withdraw_ask(&ask.ask_id, ASK_REASON);
        }
        if let Some(tasks) = self.ctx.hooks.tasks.get() {
            for (task_id, _) in tasks.live(Some(r)) {
                tasks
                    .cancel(r, &task_id, &format!("Cancelled: {STOPPED_REASON}."))
                    .await;
            }
        }
        let open = self.records.workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            open: true,
            limit: SCAN_LIMIT,
            ..Default::default()
        })?;
        for w in open {
            let Some(mut stored) = self.records.workstream_get(&w.workstream_id)? else {
                continue;
            };
            let at = now_iso(&self.ctx);
            let headline = format!("Stopped: {STOPPED_REASON}.");
            stored.workstream.state = WorkstreamState::Stopped;
            stored.workstream.headline =
                Some(fleetd_contracts::ledger::Headline::unchecked(headline));
            stored.workstream.headline_at = Some(at.clone().into());
            stored.workstream.updated_at = at.clone().into();
            self.records.workstream_put(&stored)?;
            self.ctx.events.append(NewEvent {
                at: at.into(),
                r#type: HubEventType::WorkstreamState,
                machine_id: Some(r.machine_id.clone()),
                project_id: Some(r.project_id.clone()),
                thread_id: None,
                summary: format!("{} is stopped: {STOPPED_REASON}", w.workstream_id),
                data: Some(serde_json::json!({ "workstreamId": w.workstream_id, "state": "stopped", "reason": STOPPED_REASON })),
                attention: None,
            })?;
        }
        Ok(())
    }

    /// Every project with live work, as the records name them.
    fn projects_with_live_work(&self) -> Result<Vec<ProjectRef>, LeadError> {
        let mut refs = BTreeMap::new();
        let mut add = |r: ProjectRef| {
            refs.insert(format!("{}/{}", r.machine_id, r.project_id), r);
        };
        for ask in self.ctx.ports().open_asks(None, None, SCAN_LIMIT)? {
            if let Some(r) = ask.project_ref {
                add(r);
            }
        }
        if let Some(tasks) = self.ctx.hooks.tasks.get() {
            for (_, r) in tasks.live(None) {
                add(r);
            }
        }
        for w in self.records.workstreams_list(&WorkstreamFilter {
            open: true,
            limit: SCAN_LIMIT,
            ..Default::default()
        })? {
            add(w.project_ref);
        }
        Ok(refs.into_values().collect())
    }

    /// Catches up at start, then follows project.removed from there.
    pub async fn run(self: Arc<Self>) {
        let events = Arc::clone(&self.ctx.events);
        let mut cursor = events.head();
        match self.projects_with_live_work() {
            Ok(refs) => {
                for r in refs {
                    if let Err(error) = self.reconcile(&r).await {
                        tracing::warn!(%error, "project removal catch-up failed");
                    }
                }
            }
            Err(error) => tracing::warn!(%error, "project removal catch-up failed"),
        }
        loop {
            let page = match events
                .wait(WaitInput {
                    cursor: Some(cursor),
                    types: Some(vec![HubEventType::ProjectRemoved]),
                    machine_id: None,
                    timeout_sec: 3600,
                })
                .await
            {
                Ok(page) => page,
                Err(error) => {
                    tracing::warn!(%error, "project removals: event log read failed");
                    self.ctx.clock.sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };
            cursor = page.cursor;
            for event in page.events {
                if let (Some(machine_id), Some(project_id)) = (event.machine_id, event.project_id)
                    && let Err(error) = self
                        .reconcile(&ProjectRef {
                            machine_id,
                            project_id,
                        })
                        .await
                {
                    tracing::warn!(%error, "project removal failed");
                }
            }
        }
    }
}
