//! Stopping an order, the part of project_stop that stops one: its agents cancelled, what waits on a person
//! withdrawn, and one wake line for the lead. References are rendered here for the steers that carry them.
use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ledger::{Headline, WorkstreamState};
use fleetd_contracts::mcp::{ErrorCode, IntakeRef, OrderStopInput, OrderStopOutput};
use fleetd_contracts::prim::Count;
use fleetd_contracts::tasks::TaskState;
use serde_json::json;

use super::tools::unknown_order;
use crate::hub::api::{Caller, Hub, ToolError, allows, is_human, require};
use crate::hub::executor::shell_mapper::js_take;
use crate::hub::leads::events::Event;
use crate::hub::leads::records::StoredWorkstream;
use crate::hub::leads::wakes::{LineKind, Trigger};
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

/// Notes and stops reach the lead as the human's words, so only a person's device (a human key) sends them.
pub fn require_human(caller: &Caller, tool: &str) -> Result<(), ToolError> {
    if is_human(caller) {
        return Ok(());
    }
    Err(ToolError::new(
        ErrorCode::Forbidden,
        format!("{tool} speaks for the human, and this is an agent key."),
    )
    .with_fix("Send it from the desktop app (a human key from `fleetd pair`)."))
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

pub async fn stop(
    hub: &Hub,
    caller: &Caller,
    input: OrderStopInput,
) -> Result<OrderStopOutput, ToolError> {
    require_human(caller, "order_stop")?;
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
    let project = crate::hub::usage::ports::ProjectRef {
        machine_id: stored.workstream.project_ref.machine_id.to_string(),
        project_id: stored.workstream.project_ref.project_id.to_string(),
    };
    hub.approvals
        .close_open(&project, Some(id.as_str()), &format!("{id} was stopped"))
        .await;
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
            text: Event::OrderStopped {
                workstream: id.as_str(),
                title: &stored.workstream.title,
                why,
                cancelled,
            }
            .render(),
        },
    );
    Ok(OrderStopOutput {
        state: WorkstreamState::Stopped,
        cancelled: Count::unchecked(cancelled),
        next: Some("Tell the lead in the chat what to do instead (chat_send).".into()),
        truncated: None,
    })
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::auth::KeyKind;

    use super::*;

    fn caller(kind: Option<KeyKind>) -> Caller {
        serde_json::from_value(serde_json::json!({
            "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": "2026-10-18T10:00:00.000Z",
            "grants": [{ "role": "operate", "machines": "*" }],
        }))
        .map(|c: Caller| Caller { kind, ..c })
        .unwrap()
    }

    #[test]
    fn only_a_person_s_device_speaks_for_the_human() {
        assert!(require_human(&caller(Some(KeyKind::Human)), "order_stop").is_ok());
        // An operate agent key on every machine is still not the human.
        let refused = require_human(&caller(None), "order_note").unwrap_err();
        assert_eq!(refused.code, ErrorCode::Forbidden);
        assert!(require_human(&caller(Some(KeyKind::Agent)), "order_stop").is_err());
    }
}
