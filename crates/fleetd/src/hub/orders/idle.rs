//! Order lifecycle follow-ups the hub runs off the event log: when an order is done, its leftover PRs and tasks are
//! closed (`on_done`).
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::tasks::TaskState;

use crate::hub::api::Hub;
use crate::hub::store::WaitInput;

/// Follows orders that are done, from now on, and closes what they left running.
pub async fn run(hub: Arc<Hub>) {
    let mut cursor = hub.events.head();
    loop {
        let page = match hub
            .events
            .wait(WaitInput {
                cursor: Some(cursor),
                types: Some(vec![HubEventType::WorkstreamDone]),
                machine_id: None,
                timeout_sec: 3600,
            })
            .await
        {
            Ok(page) => page,
            Err(error) => {
                tracing::warn!(%error, "done orders: event log read failed");
                hub.clock.sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        cursor = page.cursor;
        for event in page.events {
            on_done(&hub, &event).await;
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
