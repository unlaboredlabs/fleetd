//! A lead whose turn was cut off carries on by itself. Its node stopping or restarting under it (an update, a crash, a
//! reboot) wakes it every time: never the lead's own doing. Its own turn ending badly (the stall guard cut it, its
//! claude exited unasked, its machine slept) wakes it once per run of such turns, so an order it was working on doesn't
//! wait for the next message, and a turn that keeps hanging doesn't loop: a completed turn ends the run. The wake goes
//! through the offline write queue like any other, so it reaches the lead in its own thread once the node is back.
//! Tasks have their own recovery (`tasks::recovery`); this is the lead's.
use std::collections::HashSet;
use std::sync::Arc;

use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ids::ProjectRef;

use super::Area;
use super::records::StoredLead;
use super::wakes::{LineKind, Trigger};
use crate::hub::store::WaitInput;
use crate::hub::tasks::recovery::{Kind, death};

/// How a lead's thread ended, as its wakes see it.
#[derive(Debug, PartialEq)]
pub enum End {
    /// Its node cut the turn off: the wake's line.
    NodeLost(String),
    /// Its own turn ended badly, in a way a new turn may get past: the wake's line.
    Own(String),
    /// A turn that completed.
    Completed,
}

/// The project and how its lead's thread ended; None for another thread, or an end that wakes nothing (a stop someone
/// asked for, a failure a new turn doesn't fix, like the login).
pub fn end(event: &HubEvent, leads: &[StoredLead]) -> Option<(ProjectRef, End)> {
    if !matches!(
        event.r#type,
        HubEventType::ThreadFailed
            | HubEventType::ThreadInterrupted
            | HubEventType::ThreadCompleted
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
    if event.r#type == HubEventType::ThreadCompleted {
        return Some((lead.project_ref.clone(), End::Completed));
    }
    let died = death(event.r#type, event.data.as_ref(), machine.as_str(), None);
    let end = match died.kind {
        Kind::NodeLost => End::NodeLost(format!(
            "- Your last turn was cut off: {}, and it is back. Carry on from where you were; a step you were taking \
             may be half done, so check it before you repeat it.",
            died.text
        )),
        Kind::Stalled | Kind::Exited | Kind::Unreachable => End::Own(format!(
            "- Your last turn was cut off: {}. Carry on from where you were; a step you were taking may be half \
             done, so check it before you repeat it, and don't retry a step that hung the same way.",
            died.text
        )),
        _ => return None,
    };
    Some((lead.project_ref.clone(), end))
}

impl Area {
    /// Follows thread ends from the hub's start and wakes each lead whose turn was cut off. Runs until aborted.
    pub async fn run_cut_off(self: Arc<Self>) {
        let events = Arc::clone(&self.ctx.events);
        let mut cursor = events.head();
        // Leads woken after their own turn ended badly, until one of their turns completes.
        let mut carried_on: HashSet<ProjectRef> = HashSet::new();
        loop {
            let page = match events
                .wait(WaitInput {
                    cursor: Some(cursor),
                    types: Some(vec![
                        HubEventType::ThreadFailed,
                        HubEventType::ThreadInterrupted,
                        HubEventType::ThreadCompleted,
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
                let Some((project, end)) = end(event, &leads) else {
                    continue;
                };
                let text = match end {
                    End::Completed => {
                        carried_on.remove(&project);
                        continue;
                    }
                    End::NodeLost(text) => {
                        tracing::info!(project = %project.project_id, "lead cut off by its node; waking it to carry on");
                        text
                    }
                    End::Own(text) if carried_on.insert(project.clone()) => {
                        tracing::info!(project = %project.project_id, "lead's turn cut off; waking it to carry on");
                        text
                    }
                    End::Own(_) => {
                        tracing::info!(project = %project.project_id, "lead's carried-on turn was cut off too; leaving it for its next wake");
                        continue;
                    }
                };
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
