//! Order lifecycle follow-ups the hub runs off the event log. When an order is done, its leftover PRs and tasks
//! are closed (`on_done`), except its unlanded write work, which keeps going and the lead is told.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ledger::WorkstreamId;

use super::open_work::{self, CLOSED_ON_PURPOSE, ids, listed, sweep};
use crate::hub::api::Hub;
use crate::hub::leads::events::Event;
use crate::hub::leads::wakes::{LineKind, Trigger};
use crate::hub::store::WaitInput;

/// Follows orders finishing, from now on.
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
                tracing::warn!(%error, "order follow-ups: event log read failed");
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
/// their way in leave the train and close on GitHub with a note, and its live tasks are cancelled. Its unlanded write
/// work is never dropped silently: a claim holds the order open over it, and what a different path left (a research
/// verdict) keeps going while the lead is told in one line. Only an order closed on purpose drops it, with its why.
async fn on_done(hub: &Hub, event: &fleetd_contracts::events::HubEvent) {
    let data = event.data.as_ref();
    let Some(id) = data
        .and_then(|d| d.get("workstreamId"))
        .and_then(|v| v.as_str())
        .and_then(|s| WorkstreamId::new(s).ok())
    else {
        return;
    };
    let Some(w) = hub.leads.records.workstream_get(&id).ok().flatten() else {
        return;
    };
    let r = w.project_ref;
    let on_purpose = data
        .and_then(|d| d.get("reason"))
        .and_then(|v| v.as_str())
        .filter(|reason| reason.starts_with(CLOSED_ON_PURPOSE));
    let why = match on_purpose {
        Some(reason) => format!("{id} was {reason}"),
        None => format!("{id} is done: its done-when checks passed without this PR"),
    };
    let tasks = super::order_tasks(hub, &id);
    let plan = sweep(&tasks, open_work::open(hub, &r, &id), on_purpose.is_some());
    for change in hub
        .train
        .close_leftovers(&r, &id, &why, &plan.keep_prs)
        .await
    {
        tracing::info!(change = %change.change_id, pr = %change.pr_url, "order done: closed its leftover PR");
    }
    let caller = crate::hub::tasks::TaskCaller {
        project_ref: r.clone(),
        by: "hub".into(),
    };
    for task_id in &plan.cancel {
        if let Err(error) = hub
            .tasks
            .cancel(&caller, task_id, Some(&format!("Cancelled: {why}.")))
            .await
        {
            tracing::warn!(task = %task_id, ?error, "order done: task not cancelled");
        }
    }
    if !plan.kept.is_empty() {
        tracing::info!(workstream = %id, work = %listed(&plan.kept), "order done: unlanded write work kept");
        let text = Event::OrderDoneWorkKept {
            workstream: id.as_str(),
            work: &listed(&plan.kept),
            ids: &ids(&plan.kept),
        }
        .render();
        hub.leads.wakes.trigger(
            &r,
            Trigger::Line {
                kind: LineKind::ClaimPassed,
                text,
            },
        );
    }
}
