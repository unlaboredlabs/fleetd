//! Agent messages: one agent's words to one to five others of its project (`agent_message`). Each recipient's delivery
//! is a steer by the sender (`By::Agent`), with its receipts; the message and where it stands for each recipient are
//! kept here whole, for the person to read and audit (`agent_messages`), and every change is an `agent.messaged` or
//! `agent.message_updated` event on the project.
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::AgentMessageResult;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::steer::{
    AgentMessage, AgentMessageAgent, AgentMessageEventData, AgentMessageEventRecipient,
    AgentMessageId, AgentMessageOutcome as Outcome, AgentMessageRecipient, Steer, SteerMode,
    SteerStage, SteerTarget,
};
use fleetd_contracts::tasks::{Task, TaskId, TaskState};
use rusqlite::{OptionalExtension, params};

use super::{By, SteerRequest, one_line};
use crate::hub::api::{Hub, ToolError};
use crate::hub::executor::shell_mapper::js_take;
use crate::hub::leads::events::Event;
use crate::hub::store::{HubDb, NewEvent, StoreError, iso_ms, now_ms, parse_ms};

/// The most recipients one agent's messages reach in a minute: room for any real exchange, a stop for a loop.
pub const PER_MINUTE: i64 = 20;

/// Sends `text` from `from` to each of `to` (repeats dropped), and keeps it. A recipient that can't take it is
/// `refused` in the answer, not an error: the others still get it.
pub async fn send(
    hub: &Hub,
    from: &Task,
    to: &[TaskId],
    text: &str,
) -> Result<AgentMessageResult, ToolError> {
    let mut ids: Vec<&TaskId> = Vec::new();
    for id in to {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let now = now_ms(hub.clock.as_ref());
    let sent = hub.db.with(|c| {
        Ok(c.query_row(
            "SELECT COUNT(*) FROM agent_message_to t JOIN agent_messages m ON m.n = t.message_n
             WHERE m.from_task = ? AND m.sent_ms > ?",
            params![from.task_id.as_str(), now - 60_000],
            |r| r.get::<_, i64>(0),
        )?)
    })?;
    if sent + ids.len() as i64 > PER_MINUTE {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            format!(
                "{}'s messages reached {sent} agents in the last minute; {PER_MINUTE} is the most.",
                from.task_id
            ),
        )
        .with_fix(
            "Put what is left in one message a minute from now. If agents are going back and forth, ask your lead \
             with ask_lead instead.",
        ));
    }
    let r = &from.project_ref;
    let n = hub.db.with(|c| {
        c.execute(
            "INSERT INTO agent_messages (machine_id, project_id, from_task, from_title, text, sent_ms)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                r.machine_id.as_str(),
                r.project_id.as_str(),
                from.task_id.as_str(),
                from.title.as_str(),
                text,
                now
            ],
        )?;
        Ok(c.last_insert_rowid())
    })?;
    let id = AgentMessageId::from_n(n);
    let mut recipients = Vec::new();
    for (pos, task_id) in ids.into_iter().enumerate() {
        let before = hub
            .tasks
            .get(task_id)
            .ok()
            .flatten()
            .filter(|t| t.project_ref == *r);
        let crid = format!("{id}:{task_id}");
        let request = SteerRequest {
            target: SteerTarget::Task {
                task_id: task_id.clone(),
            },
            text,
            mode: SteerMode::Queue,
            refs: vec![],
            attached: vec![],
            client_request_id: &crid,
        };
        let asked = hub.tasks.asked_at(task_id);
        let sent = super::send(hub, By::Agent { from, message: &id }, request).await;
        let was = before.as_ref().map(|t| t.state);
        let (outcome, steer, detail, at) = match sent {
            Ok(steer) if steer.held == Some(true) => {
                let outcome = if was == Some(TaskState::Queued) {
                    Outcome::Held
                } else {
                    Outcome::NotWoken
                };
                (
                    outcome,
                    steer.id.n(),
                    steer.detail.map(|d| d.to_string()),
                    Some(now),
                )
            }
            Ok(steer) if was.is_some_and(|s| s != TaskState::Running) => (
                Outcome::Woke,
                steer.id.n(),
                Some(match asked {
                    Some(ms) => format!("it answers what {task_id} asked at {}", hhmm(ms)),
                    None => format!("it answers what {task_id} asked"),
                }),
                Some(now),
            ),
            Ok(steer) => (Outcome::Delivered, steer.id.n(), None, None),
            Err(e) => (Outcome::Refused, None, Some(e.message), Some(now)),
        };
        let title = before.map(|t| t.title.to_string());
        hub.db.with(|c| {
            c.execute(
                "INSERT INTO agent_message_to (message_n, pos, task_id, title, steer_n, outcome, at_ms, detail)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    n,
                    pos as i64,
                    task_id.as_str(),
                    title,
                    steer,
                    outcome.as_str(),
                    at,
                    detail
                ],
            )?;
            Ok(())
        })?;
        recipients.push(AgentMessageRecipient {
            task_id: task_id.clone(),
            title,
            outcome,
            at: at.map(|ms| iso_ms(ms).into()),
            detail,
        });
    }
    emit(
        hub,
        HubEventType::AgentMessaged,
        r,
        &id,
        &from.task_id,
        &recipients,
        text,
    );
    tell_lead(hub, r, &id, &from.task_id, &recipients, text);
    Ok(AgentMessageResult {
        next: Some(next(&id, &recipients)),
        message_id: id,
        to: recipients,
    })
}

fn hhmm(ms: i64) -> String {
    super::hhmm(&iso_ms(ms))
}

/// What the sender is told: where it stands for each recipient, and what to do when that isn't enough.
fn next(id: &AgentMessageId, to: &[AgentMessageRecipient]) -> String {
    let mut lines = Vec::new();
    for r in to {
        let t = &r.task_id;
        lines.push(match r.outcome {
            Outcome::Delivered => format!("{t} takes it at its next tool boundary."),
            Outcome::Held => format!("{t} hasn't started yet, and gets it when it does."),
            Outcome::Woke => format!("{t} was waiting for an answer, and this continues it."),
            Outcome::NotWoken => format!(
                "{t} has finished, and an agent can't restart a finished agent: it gets this only if a Monitor or \
                 wait_ci of its own wakes it, or its lead continues it. If you need {t} now, ask your lead with \
                 ask_lead."
            ),
            Outcome::Refused => format!(
                "{t} didn't get it: {}",
                r.detail.as_deref().unwrap_or("refused")
            ),
        });
    }
    format!(
        "{id} sent. {} Replies, if any, arrive as messages: carry on.",
        lines.join(" ")
    )
}

/// The lead's quiet copy, with its next wake: it knows what its agents settle between them without being woken for it.
fn tell_lead(
    hub: &Hub,
    r: &ProjectRef,
    id: &AgentMessageId,
    from: &TaskId,
    to: &[AgentMessageRecipient],
    text: &str,
) {
    let names: Vec<String> = to
        .iter()
        .map(|t| match t.outcome {
            Outcome::Delivered | Outcome::Woke => t.task_id.to_string(),
            other => format!("{} ({})", t.task_id, other.as_str().replace('_', " ")),
        })
        .collect();
    let line = Event::AgentMessaged {
        from: from.as_str(),
        to: &names.join(", "),
        message: id.as_str(),
        text,
    }
    .render();
    hub.leads.wakes.trigger(
        r,
        crate::hub::leads::wakes::Trigger::Line {
            kind: crate::hub::leads::wakes::LineKind::Quiet,
            text: line,
        },
    );
}

fn emit(
    hub: &Hub,
    kind: HubEventType,
    r: &ProjectRef,
    id: &AgentMessageId,
    from: &TaskId,
    to: &[AgentMessageRecipient],
    text: &str,
) {
    let data = AgentMessageEventData {
        message_id: id.clone(),
        from: from.clone(),
        to: to
            .iter()
            .map(|t| AgentMessageEventRecipient {
                task_id: t.task_id.clone(),
                outcome: t.outcome,
                detail: t.detail.clone(),
            })
            .collect(),
        text: js_take(text, 120).to_owned(),
    };
    let names: Vec<&str> = to.iter().map(|t| t.task_id.as_str()).collect();
    let summary = format!(
        "{id} from {from} to {}: '{}'",
        names.join(", "),
        one_line(text, 120)
    );
    let event = NewEvent {
        at: iso_ms(now_ms(hub.clock.as_ref())).into(),
        r#type: kind,
        machine_id: Some(r.machine_id.clone()),
        project_id: Some(r.project_id.clone()),
        thread_id: None,
        summary: js_take(&summary, 200).to_owned(),
        data: serde_json::to_value(data).ok(),
        attention: None,
    };
    if let Err(error) = hub.events.append(event) {
        tracing::error!(%error, "agent message event append failed");
    }
}

/// A recipient's steer moved: taken in, it is delivered (a woken one stays woke); one that failed or expired was
/// never sent. A change is an `agent.message_updated` with every recipient as it stands.
pub fn on_steer(hub: &Hub, steer: &Steer) {
    let Some(steer_n) = steer.id.n() else {
        return;
    };
    let row = hub.db.with(|c| {
        Ok(c.query_row(
            "SELECT message_n, pos, outcome, at_ms FROM agent_message_to WHERE steer_n = ?",
            [steer_n],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .optional()?)
    });
    let Ok(Some((n, pos, outcome, at_ms))) = row else {
        return;
    };
    let was = Outcome::parse(&outcome).unwrap_or(Outcome::Delivered);
    let now = now_ms(hub.clock.as_ref());
    let (outcome, detail, at) = match steer.stage {
        SteerStage::Delivered | SteerStage::Acknowledged | SteerStage::Unacknowledged => {
            if was == Outcome::Woke || (was == Outcome::Delivered && at_ms.is_some()) {
                return;
            }
            let at = steer
                .delivered_at
                .as_ref()
                .and_then(|t| parse_ms(t.as_str()))
                .unwrap_or(now);
            (Outcome::Delivered, None, at)
        }
        SteerStage::Failed | SteerStage::Expired | SteerStage::Withdrawn => {
            if was == Outcome::Refused {
                return;
            }
            let why = steer
                .detail
                .as_ref()
                .map_or_else(|| steer.stage.as_str().to_owned(), |d| d.to_string());
            (Outcome::Refused, Some(why), now)
        }
        SteerStage::Queued => return,
    };
    let updated = hub.db.with(|c| {
        c.execute(
            "UPDATE agent_message_to SET outcome = ?, at_ms = ?, detail = ? WHERE message_n = ? AND pos = ?",
            params![outcome.as_str(), at, detail, n, pos],
        )?;
        Ok(())
    });
    if let Err(error) = updated {
        return tracing::error!(%error, "agent message outcome not stored");
    }
    let Ok(Some((r, message))) = get(&hub.db, n) else {
        return;
    };
    emit(
        hub,
        HubEventType::AgentMessageUpdated,
        &r,
        &message.id,
        &message.from.task_id,
        &message.to,
        &message.text,
    );
}

/// A page of a project's agent messages, newest first.
pub struct Page {
    pub messages: Vec<AgentMessage>,
    pub more: bool,
    pub total: i64,
}

/// The project's agent messages (only those `task_id` sent or got, with one) older than `before`, newest first, at
/// most `limit`.
pub fn list(
    db: &HubDb,
    r: &ProjectRef,
    task_id: Option<&TaskId>,
    before: Option<&AgentMessageId>,
    limit: usize,
) -> Result<Page, StoreError> {
    let task = task_id.map(|t| t.as_str());
    let filter = "machine_id = ?1 AND project_id = ?2 AND (?3 IS NULL OR from_task = ?3
        OR n IN (SELECT message_n FROM agent_message_to WHERE task_id = ?3))";
    let (total, ns) = db.with(|c| {
        let total: i64 = c.query_row(
            &format!("SELECT COUNT(*) FROM agent_messages WHERE {filter}"),
            params![r.machine_id.as_str(), r.project_id.as_str(), task],
            |row| row.get(0),
        )?;
        let mut stmt = c.prepare(&format!(
            "SELECT n FROM agent_messages WHERE {filter} AND (?4 IS NULL OR n < ?4) ORDER BY n DESC LIMIT ?5"
        ))?;
        let ns = stmt
            .query_map(
                params![
                    r.machine_id.as_str(),
                    r.project_id.as_str(),
                    task,
                    before.and_then(|b| b.n()),
                    limit as i64 + 1
                ],
                |row| row.get::<_, i64>(0),
            )?
            .collect::<rusqlite::Result<Vec<i64>>>()?;
        Ok((total, ns))
    })?;
    let more = ns.len() > limit;
    let mut messages = Vec::new();
    for n in ns.into_iter().take(limit) {
        if let Some((_, message)) = get(db, n)? {
            messages.push(message);
        }
    }
    Ok(Page {
        messages,
        more,
        total,
    })
}

/// One agent message, with its project.
pub fn get(db: &HubDb, n: i64) -> Result<Option<(ProjectRef, AgentMessage)>, StoreError> {
    db.with(|c| {
        let head = c
            .query_row(
                "SELECT machine_id, project_id, from_task, from_title, text, sent_ms FROM agent_messages WHERE n = ?",
                [n],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((machine, project, from, from_title, text, sent_ms)) = head else {
            return Ok(None);
        };
        let mut stmt = c.prepare(
            "SELECT task_id, title, outcome, at_ms, detail FROM agent_message_to WHERE message_n = ? ORDER BY pos",
        )?;
        let to = stmt
            .query_map([n], |row| {
                Ok(AgentMessageRecipient {
                    task_id: TaskId::unchecked(row.get::<_, String>(0)?),
                    title: row.get(1)?,
                    outcome: Outcome::parse(&row.get::<_, String>(2)?)
                        .unwrap_or(Outcome::Delivered),
                    at: row.get::<_, Option<i64>>(3)?.map(|ms| iso_ms(ms).into()),
                    detail: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let r = ProjectRef {
            machine_id: fleetd_contracts::ids::MachineId::unchecked(machine),
            project_id: fleetd_contracts::ids::ProjectId::unchecked(project),
        };
        Ok(Some((
            r,
            AgentMessage {
                id: AgentMessageId::from_n(n),
                from: AgentMessageAgent {
                    task_id: TaskId::unchecked(from),
                    title: Some(from_title),
                },
                text,
                sent_at: iso_ms(sent_ms).into(),
                to,
            },
        )))
    })
}
