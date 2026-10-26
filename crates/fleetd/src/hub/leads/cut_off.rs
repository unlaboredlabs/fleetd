//! A lead whose turn its node cut off carries on by itself: the node stopped or restarted under it (an update, a crash,
//! a reboot), never the lead's own doing. Its project gets a wake saying so, which goes through the offline write
//! queue like any other, so it reaches the lead in its own thread once the node is back. Tasks have their own
//! recovery (`tasks::recovery`); this is the lead's.
use std::sync::Arc;

use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ids::ProjectRef;

use super::Area;
use super::records::StoredLead;
use super::wakes::{LineKind, Trigger};
use crate::hub::store::WaitInput;
use crate::hub::tasks::recovery::{Kind, death};

/// The wake's line for a lead thread's end, when its node cut the turn off; None for any other end, or another thread.
pub fn line(event: &HubEvent, leads: &[StoredLead]) -> Option<(ProjectRef, String)> {
    if !matches!(
        event.r#type,
        HubEventType::ThreadFailed | HubEventType::ThreadInterrupted
    ) {
        return None;
    }
    let machine = event.machine_id.as_ref()?;
    let thread = event.thread_id.as_ref().map(|t| t.as_str()).or_else(|| {
        event
            .data
            .as_ref()
            .and_then(|d| d.get("threadId"))
            .and_then(|t| t.as_str())
    })?;
    let lead = leads
        .iter()
        .find(|l| &l.project_ref.machine_id == machine && l.thread_id.as_str() == thread)?;
    let died = death(event.r#type, event.data.as_ref(), machine.as_str(), None);
    (died.kind == Kind::NodeLost).then(|| {
        (
            lead.project_ref.clone(),
            format!(
                "- Your last turn was cut off: {}, and it is back. Carry on from where you were; a step you \
                 were taking may be half done, so check it before you repeat it.",
                died.text
            ),
        )
    })
}

impl Area {
    /// Follows thread ends from the hub's start and wakes each lead its node cut off. Runs until aborted.
    pub async fn run_cut_off(self: Arc<Self>) {
        let events = Arc::clone(&self.ctx.events);
        let mut cursor = events.head();
        loop {
            let page = match events
                .wait(WaitInput {
                    cursor: Some(cursor),
                    types: Some(vec![
                        HubEventType::ThreadFailed,
                        HubEventType::ThreadInterrupted,
                    ]),
                    machine_id: None,
                    timeout_sec: 3600,
                })
                .await
            {
                Ok(page) => page,
                Err(error) => {
                    tracing::warn!(%error, "cut-off leads: event log read failed");
                    self.ctx
                        .clock
                        .sleep(std::time::Duration::from_secs(1))
                        .await;
                    continue;
                }
            };
            cursor = page.cursor;
            if page.events.is_empty() {
                continue;
            }
            let leads = self.records.leads_list().unwrap_or_default();
            for event in &page.events {
                if let Some((project, text)) = line(event, &leads) {
                    tracing::info!(project = %project.project_id, "lead cut off by its node; waking it to carry on");
                    self.wakes.trigger(
                        &project,
                        Trigger::Line {
                            kind: LineKind::CutOff,
                            text,
                        },
                    );
                }
            }
        }
    }
}
