//! A person adding to an order (order_note) and stopping one (order_stop). Both reach the order's lead as one wake
//! line; a note marked urgent wakes it now instead of after the debounce.
use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ledger::{Headline, Workstream, WorkstreamState};
use fleetd_contracts::mcp::{
    ErrorCode, IntakeRef, OrderNoteInput, OrderNoteOutput, OrderStopInput, OrderStopOutput,
};
use fleetd_contracts::prim::{Count, Text};
use fleetd_contracts::tasks::TaskState;
use serde_json::json;

use super::tools::unknown_order;
use crate::hub::api::{Caller, Hub, ToolError, allows, require};
use crate::hub::executor::shell_mapper::js_take;
use crate::hub::intake::attachments;
use crate::hub::leads::records::{StoredWorkstream, is_closed};
use crate::hub::leads::wakes::{LineKind, Trigger, WAKE_DEBOUNCE};
use crate::hub::store::{NewEvent, iso_ms, now_ms};
use crate::hub::tasks::TaskCaller;

fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > max {
        format!("{}…", js_take(&flat, max - 1))
    } else {
        flat
    }
}

fn readable_order(hub: &Hub, caller: &Caller, id: &str) -> Result<StoredWorkstream, ToolError> {
    let id = fleetd_contracts::ledger::WorkstreamId::new(id).map_err(|_| unknown_order(id))?;
    match hub.leads.records.workstream_get(&id)? {
        Some(s)
            if allows(
                caller,
                Role::Read,
                Some(&s.workstream.project_ref.machine_id),
            ) =>
        {
            Ok(s)
        }
        _ => Err(unknown_order(id.as_str())),
    }
}

/// The "References:" lines for a lead: file paths verbatim, orders by id, title and state, PRs by URL. Orders and
/// PRs the caller may not read are refused.
pub fn render_refs(
    hub: &Hub,
    caller: &Caller,
    refs: &[IntakeRef],
) -> Result<Vec<String>, ToolError> {
    let mut lines = Vec::new();
    for r in refs {
        lines.push(match r {
            IntakeRef::File { path } => format!("  - `{path}`"),
            IntakeRef::Order { workstream_id } => {
                let w = readable_order(hub, caller, workstream_id.as_str())?.workstream;
                let state = serde_json::to_value(w.state)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default();
                format!(
                    "  - {} '{}' ({state})",
                    w.workstream_id,
                    one_line(&w.title, 120)
                )
            }
            IntakeRef::Pr { url } => {
                let parsed = fleetd_contracts::train::parse_pr_url(url.as_str());
                let change =
                    parsed.and_then(|p| hub.train.records().latest_for(&p.repo, p.pr_number));
                if let Some(c) = &change
                    && !allows(caller, Role::Read, Some(&c.project_ref.machine_id))
                {
                    return Err(ToolError::new(
                        ErrorCode::Forbidden,
                        format!("You may not read {url}."),
                    )
                    .with_fix("Leave the reference out, or use a key with read on its machine."));
                }
                match change {
                    Some(c) => {
                        format!("  - {url} ({}, {})", c.workstream_id, serde_plain(&c.state))
                    }
                    None => format!("  - {url}"),
                }
            }
        });
    }
    Ok(lines)
}

fn serde_plain<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// The wake line for a person's words about an order, with its references and attachments.
pub fn note_line(
    w: &Workstream,
    text: &str,
    refs: &[String],
    attached: &[String],
    steered: bool,
) -> String {
    let verb = if steered { "steered" } else { "added to" };
    let mut line = format!(
        "- The human {verb} {} '{}': '{}'",
        w.workstream_id,
        one_line(&w.title, 80),
        one_line(text, 1500)
    );
    if !refs.is_empty() {
        line.push_str("\n  References:\n");
        line.push_str(&refs.join("\n"));
    }
    if !attached.is_empty() {
        line.push_str("\n  Attached:\n");
        line.push_str(&attached.join("\n"));
    }
    line
}

pub async fn note(
    hub: &Hub,
    caller: &Caller,
    input: OrderNoteInput,
) -> Result<OrderNoteOutput, ToolError> {
    let stored = readable_order(hub, caller, input.workstream_id.as_str())?;
    let w = stored.workstream;
    require(caller, Role::Operate, Some(&w.project_ref.machine_id))?;
    if is_closed(w.state) {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "{} is {}; its lead no longer works on it.",
                w.workstream_id,
                serde_plain(&w.state)
            ),
        )
        .with_fix("Give it as a new order with intake_submit."));
    }
    let refs = render_refs(
        hub,
        caller,
        input.refs.as_ref().map_or(&[][..], |r| r.as_slice()),
    )?;
    let ids: Vec<_> = input.attachments.iter().flatten().cloned().collect();
    let attached =
        attachments::deliver(hub, caller, &ids, &w.project_ref, &w.workstream_id).await?;
    let now = now_ms(hub.clock.as_ref());
    let event = hub.events.append(NewEvent {
        at: iso_ms(now).into(),
        r#type: HubEventType::WorkstreamNote,
        machine_id: Some(w.project_ref.machine_id.clone()),
        project_id: Some(w.project_ref.project_id.clone()),
        thread_id: None,
        summary: format!(
            "You added to {}: {}",
            w.workstream_id,
            one_line(&input.text, 120)
        ),
        data: Some(json!({
            "workstreamId": w.workstream_id,
            "clientRequestId": input.client_request_id.as_str(),
            "urgent": input.urgent,
            "text": js_take(&input.text, 200),
        })),
        attention: None,
    })?;
    let note_id = format!("N{}", event.seq.get());
    let trigger = Trigger::Line {
        kind: LineKind::Human,
        text: note_line(&w, &input.text, &refs, &attached, input.urgent),
    };
    let wakes_at = if input.urgent {
        hub.leads.wakes.trigger_now(&w.project_ref, trigger);
        now
    } else {
        hub.leads.wakes.trigger(&w.project_ref, trigger);
        now + WAKE_DEBOUNCE.as_millis() as i64
    };
    Ok(OrderNoteOutput {
        note_id: Text::unchecked(note_id),
        wakes_at: iso_ms(wakes_at).into(),
        next: Some("The lead reads it at that wake; watch for lead.woken.".into()),
        truncated: None,
    })
}

/// What came with a new order: its references and attachments, as one wake line next to the intent.
pub async fn with_intent(
    hub: &Hub,
    caller: &Caller,
    id: &fleetd_contracts::ledger::WorkstreamId,
    refs: &[String],
    files: &[fleetd_contracts::mcp::AttachmentId],
) -> Result<(), ToolError> {
    let Some(stored) = hub.leads.records.workstream_get(id)? else {
        return Ok(());
    };
    let w = stored.workstream;
    let attached = attachments::deliver(hub, caller, files, &w.project_ref, id).await?;
    let mut line = format!("- {id} came with:");
    if !refs.is_empty() {
        line.push_str("\n  References:\n");
        line.push_str(&refs.join("\n"));
    }
    if !attached.is_empty() {
        line.push_str("\n  Attached:\n");
        line.push_str(&attached.join("\n"));
    }
    hub.leads.wakes.trigger(
        &w.project_ref,
        Trigger::Line {
            kind: LineKind::Human,
            text: line,
        },
    );
    Ok(())
}

pub async fn stop(
    hub: &Hub,
    caller: &Caller,
    input: OrderStopInput,
) -> Result<OrderStopOutput, ToolError> {
    let mut stored = readable_order(hub, caller, input.workstream_id.as_str())?;
    let r = stored.workstream.project_ref.clone();
    require(caller, Role::Operate, Some(&r.machine_id))?;
    let id = stored.workstream.workstream_id.clone();
    match stored.workstream.state {
        WorkstreamState::Stopped => {
            return Ok(OrderStopOutput {
                state: WorkstreamState::Stopped,
                cancelled: Count::default(),
                next: Some(format!("{id} was already stopped.")),
                truncated: None,
            });
        }
        WorkstreamState::Done | WorkstreamState::Failed => {
            return Err(ToolError::new(
                ErrorCode::Invalid,
                format!(
                    "{id} already ended ({}); there is nothing to stop.",
                    serde_plain(&stored.workstream.state)
                ),
            ));
        }
        _ => {}
    }
    let by = caller.key_id.to_string();
    let reason = input.reason.as_ref().map(|r| r.to_string());
    let why = reason.as_deref().unwrap_or("stopped by the human");
    let task_caller = TaskCaller {
        project_ref: r.clone(),
        by: by.clone(),
    };
    let mut cancelled = 0;
    for task in super::order_tasks(hub, &id) {
        if !matches!(
            task.state,
            TaskState::Queued | TaskState::Running | TaskState::Idle
        ) {
            continue;
        }
        match hub
            .tasks
            .cancel(
                &task_caller,
                &task.task_id,
                Some(&format!("Cancelled: {id} {why}.")),
            )
            .await
        {
            Ok(_) => cancelled += 1,
            Err(error) => tracing::warn!(task = %task.task_id, ?error, "order_stop: cancel failed"),
        }
    }
    for ask in hub
        .leads
        .ctx
        .ports()
        .open_asks(None, Some(&id), 200)
        .unwrap_or_default()
    {
        let _ = hub
            .leads
            .ctx
            .ports()
            .withdraw_ask(&ask.ask_id, &format!("{id} was stopped."));
    }
    let at = iso_ms(now_ms(hub.clock.as_ref()));
    stored.workstream.state = WorkstreamState::Stopped;
    stored.workstream.headline = Some(Headline::unchecked("Stopped by you"));
    stored.workstream.headline_at = Some(at.clone().into());
    stored.workstream.updated_at = at.clone().into();
    hub.leads.records.workstream_put(&stored)?;
    hub.events.append(NewEvent {
        at: at.into(),
        r#type: HubEventType::WorkstreamState,
        machine_id: Some(r.machine_id.clone()),
        project_id: Some(r.project_id.clone()),
        thread_id: None,
        summary: format!("{id} is stopped: {why}"),
        data: Some(json!({ "workstreamId": id, "state": "stopped", "reason": why, "by": by })),
        attention: None,
    })?;
    hub.leads.wakes.trigger(
        &r,
        Trigger::Line {
            kind: LineKind::Human,
            text: format!(
                "- The human stopped {id} '{}' ({why}); {cancelled} of its tasks were cancelled. Merged PRs stay. Do no more work on it.",
                one_line(&stored.workstream.title, 80)
            ),
        },
    );
    Ok(OrderStopOutput {
        state: WorkstreamState::Stopped,
        cancelled: Count::unchecked(cancelled),
        next: Some("To do it differently, give a new order with intake_submit.".into()),
        truncated: None,
    })
}
