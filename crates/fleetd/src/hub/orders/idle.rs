//! Order lifecycle follow-ups the hub runs off the event log. When an order is done, its leftover PRs and tasks
//! are closed (`on_done`). And a safety net for a lead that ends its turn with an order frozen and nothing under way: no task running or queued,
//! no PR in the train, no open ask and no wake coming. Nothing would ever wake it again, so the hub wakes it once per
//! order with a plain line. Bounded: a second idle turn on the same order gets no second nudge.
use crate::hub::prompts::PromptSet;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, ThreadRef};
use fleetd_contracts::ledger::{WorkstreamId, WorkstreamState};
use fleetd_contracts::tasks::TaskState;
use fleetd_contracts::train::ChangeState;

use crate::hub::api::Hub;
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::leads::wakes::{LineKind, Trigger};
use crate::hub::store::WaitInput;
use crate::hub::wakes::WakeFilter;

/// One open order of the project, as the decision reads it.
#[derive(Clone, Debug)]
pub struct OrderFacts {
    pub workstream_id: WorkstreamId,
    pub title: String,
    pub state: WorkstreamState,
    pub brief_frozen: bool,
    pub live_tasks: usize,
    pub open_asks: usize,
    pub open_changes: usize,
}

/// The orders to nudge after a lead turn ended: frozen and running with nothing under way, not nudged before. None
/// while something will wake the lead anyway (a scheduled wake, or triggers waiting in the debounce).
pub fn to_nudge(
    orders: &[OrderFacts],
    lead_will_wake: bool,
    nudged: &HashSet<WorkstreamId>,
) -> Vec<WorkstreamId> {
    if lead_will_wake {
        return Vec::new();
    }
    orders
        .iter()
        .filter(|o| {
            o.state == WorkstreamState::Running
                && o.brief_frozen
                && o.live_tasks == 0
                && o.open_asks == 0
                && o.open_changes == 0
                && !nudged.contains(&o.workstream_id)
        })
        .map(|o| o.workstream_id.clone())
        .collect()
}

/// Forgets the nudge of every order that closed or has work under way again, so a later stall is nudged once more.
pub fn forget_settled(nudged: &mut HashSet<WorkstreamId>, orders: &[OrderFacts]) {
    nudged.retain(|id| {
        orders.iter().any(|o| {
            &o.workstream_id == id
                && o.state == WorkstreamState::Running
                && o.live_tasks == 0
                && o.open_asks == 0
                && o.open_changes == 0
        })
    });
}

pub fn nudge_line(set: &PromptSet, id: &WorkstreamId, title: &str) -> String {
    set.render(
        "wake.order_idle",
        &[("workstreamId", id), ("title", &title)],
    )
}

fn facts(hub: &Hub, r: &ProjectRef) -> Vec<OrderFacts> {
    let open = hub
        .leads
        .records
        .workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            open: true,
            limit: 100,
            ..Default::default()
        })
        .unwrap_or_default();
    let asks = super::open_requests_by_order(hub);
    let changes = super::project_changes(hub, r);
    open.into_iter()
        .map(|w| {
            let id = w.workstream_id.clone();
            OrderFacts {
                live_tasks: super::order_tasks(hub, &id)
                    .iter()
                    .filter(|t| {
                        matches!(
                            t.state,
                            TaskState::Queued | TaskState::Running | TaskState::Idle
                        )
                    })
                    .count(),
                open_asks: asks.get(&id).copied().unwrap_or(0),
                open_changes: changes
                    .iter()
                    .filter(|c| c.workstream_id == id)
                    .filter(|c| {
                        !matches!(
                            c.state,
                            ChangeState::Merged | ChangeState::Refused | ChangeState::Abandoned
                        )
                    })
                    .count(),
                brief_frozen: w.brief.is_some(),
                state: w.state,
                title: w.title.to_string(),
                workstream_id: id,
            }
        })
        .collect()
}

/// Follows lead turns ending, from now on, and nudges idle orders once each.
pub async fn run(hub: Arc<Hub>) {
    let nudged: Mutex<HashSet<WorkstreamId>> = Mutex::default();
    let mut cursor = hub.events.head();
    loop {
        let page = match hub
            .events
            .wait(WaitInput {
                cursor: Some(cursor),
                types: Some(vec![
                    HubEventType::ThreadCompleted,
                    HubEventType::WorkstreamDone,
                ]),
                machine_id: None,
                timeout_sec: 3600,
            })
            .await
        {
            Ok(page) => page,
            Err(error) => {
                tracing::warn!(%error, "idle orders: event log read failed");
                hub.clock.sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        cursor = page.cursor;
        for event in page.events {
            if event.r#type == HubEventType::WorkstreamDone {
                on_done(&hub, &event).await;
                continue;
            }
            let (Some(machine_id), Some(project_id), Some(thread_id)) =
                (event.machine_id, event.project_id, event.thread_id)
            else {
                continue;
            };
            let r = ProjectRef {
                machine_id,
                project_id,
            };
            let Some(lead) = hub.leads.leads.get(&r).ok().flatten() else {
                continue;
            };
            if lead.thread_id != thread_id {
                continue;
            }
            let thread = ThreadRef {
                machine_id: r.machine_id.clone(),
                thread_id,
            };
            let scheduled = !hub
                .wakes
                .list(&WakeFilter {
                    machine_id: Some(r.machine_id.clone()),
                    thread_id: Some(thread.thread_id.clone()),
                    state: Some(fleetd_contracts::wakes::WakeState::Active),
                })
                .is_empty();
            let will_wake = scheduled || hub.leads.wakes.pending(&r);
            let orders = facts(&hub, &r);
            let ids = {
                let mut nudged = nudged.lock().unwrap();
                forget_settled(&mut nudged, &orders);
                to_nudge(&orders, will_wake, &nudged)
            };
            for id in ids {
                let title = orders
                    .iter()
                    .find(|o| o.workstream_id == id)
                    .map_or("", |o| o.title.as_str());
                tracing::info!(workstream = %id, "idle order: nudging its lead once");
                hub.leads.wakes.trigger(
                    &r,
                    Trigger::Line {
                        kind: LineKind::Idle,
                        text: nudge_line(&hub.db.prompts().for_lead(&r), &id, title),
                    },
                );
                nudged.lock().unwrap().insert(id);
            }
        }
    }
}

/// An order is done when its done-when passed (the design's rule), so what it left running is closed: PRs not on
/// their way in leave the train and close on GitHub with a note, and its live tasks are cancelled.
async fn on_done(hub: &Hub, event: &fleetd_contracts::events::HubEvent) {
    let Some(id) = event
        .data
        .as_ref()
        .and_then(|d| d.get("workstreamId"))
        .and_then(|v| v.as_str())
        .and_then(|s| WorkstreamId::new(s).ok())
    else {
        return;
    };
    let Some(w) = hub.leads.records.workstream_get(&id).ok().flatten() else {
        return;
    };
    let r = w.workstream.project_ref;
    let why = format!("{id} is done: its done-when checks passed without this PR");
    for change in hub.train.close_leftovers(&r, &id, &why).await {
        tracing::info!(change = %change.change_id, pr = %change.pr_url, "order done: closed its leftover PR");
    }
    let caller = crate::hub::tasks::TaskCaller {
        project_ref: r.clone(),
        by: "hub".into(),
    };
    for task in super::order_tasks(hub, &id) {
        if matches!(
            task.state,
            TaskState::Queued | TaskState::Running | TaskState::Idle
        ) && let Err(error) = hub
            .tasks
            .cancel(&caller, &task.task_id, Some(&format!("Cancelled: {why}.")))
            .await
        {
            tracing::warn!(task = %task.task_id, ?error, "order done: task not cancelled");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn order(id: &str) -> OrderFacts {
        OrderFacts {
            workstream_id: WorkstreamId::new(id).unwrap(),
            title: "three pages".into(),
            state: WorkstreamState::Running,
            brief_frozen: true,
            live_tasks: 0,
            open_asks: 0,
            open_changes: 0,
        }
    }

    #[test]
    fn a_frozen_order_with_nothing_under_way_is_nudged_once() {
        let idle = order("W1");
        let none = HashSet::new();
        assert_eq!(
            to_nudge(std::slice::from_ref(&idle), false, &none),
            vec![idle.workstream_id.clone()]
        );
        // Once only.
        let nudged = HashSet::from([idle.workstream_id.clone()]);
        assert!(to_nudge(std::slice::from_ref(&idle), false, &nudged).is_empty());
        // Something will wake the lead anyway.
        assert!(to_nudge(std::slice::from_ref(&idle), true, &none).is_empty());
    }

    #[test]
    fn an_order_that_got_going_again_can_be_nudged_again() {
        let mut nudged = HashSet::from([
            WorkstreamId::new("W1").unwrap(),
            WorkstreamId::new("W2").unwrap(),
            WorkstreamId::new("W3").unwrap(),
        ]);
        // W1 has a task again, W2 closed (not open any more), W3 is still idle.
        forget_settled(
            &mut nudged,
            &[
                OrderFacts {
                    live_tasks: 1,
                    ..order("W1")
                },
                order("W3"),
            ],
        );
        assert_eq!(nudged, HashSet::from([WorkstreamId::new("W3").unwrap()]));
    }

    #[test]
    fn work_under_way_or_a_question_is_not_idle() {
        let none = HashSet::new();
        let busy = [
            OrderFacts {
                live_tasks: 1,
                ..order("W1")
            },
            OrderFacts {
                open_asks: 1,
                ..order("W2")
            },
            OrderFacts {
                open_changes: 1,
                ..order("W3")
            },
            OrderFacts {
                brief_frozen: false,
                state: WorkstreamState::Draft,
                ..order("W4")
            },
            OrderFacts {
                state: WorkstreamState::Verifying,
                ..order("W5")
            },
        ];
        assert!(to_nudge(&busy, false, &none).is_empty());
    }
}
