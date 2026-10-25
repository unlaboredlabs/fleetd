//! The person's touches on fleetd's own surfaces, folded out of the event log by the projector:
//!
//! - `chat.message` by the person (app or `fleetd chat`), timed when it was written, credited by its length. History
//!   messages from before the chat are not acts, and an agent writing with its own key is not the person;
//! - `request.updated` to approved, denied or stored by a human key: a command approval or a secret answered inline,
//!   once per answer, timed by it. Withdrawals by the lead and closes by the hub never count;
//! - `steer.queued` by a human key;
//! - `decision.recorded` with source human;
//! - `workstream.created` submitted directly by the person (app or MCP), credited by its text's length;
//! - a landed change a human account merged by hand (from `pr.merged_outside`). The event doesn't name the merger
//!   yet, so it stays unattributed and out of the person's minutes until it does (`human::attributed`).
//!
//! The person's local Claude Code transcripts are not read, and app use comes with `app.presence` (metrics PR 7).
use fleetd_contracts::chat::{ChatAuthor, ChatMessage, ChatMessageEventData};
use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ledger::{IntakeChannel, Workstream};
use fleetd_contracts::metrics::{MergeRoute, TouchKind};
use fleetd_contracts::steer::{SteerBy, SteerEventData};
use rusqlite::OptionalExtension;
use serde_json::Value;

use super::human;
use super::project::data;
use super::store::{MergeRow, TouchRow};
use crate::hub::store::{HubDb, StoreError, parse_ms};

/// The answers to a request that are the person's act.
const ANSWERED: [&str; 3] = ["approved", "denied", "stored"];

fn str_at<'a>(data: &'a Option<Value>, key: &str) -> Option<&'a str> {
    data.as_ref()?.get(key)?.as_str()
}

fn number(id: &str) -> i64 {
    id.get(1..).and_then(|n| n.parse().ok()).unwrap_or(-1)
}

fn touch(kind: TouchKind, src: &str, src_key: String, at_ms: i64, credit_ms: i64) -> TouchRow {
    TouchRow {
        src: src.into(),
        src_key,
        kind: kind.as_str().into(),
        at_ms,
        credit_ms,
        ..TouchRow::default()
    }
}

/// The touch one event records, if it is the person's act.
pub fn of_event(db: &HubDb, e: &HubEvent) -> Result<Option<TouchRow>, StoreError> {
    let at = parse_ms(e.at.as_str()).unwrap_or(0);
    let machine_id = e.machine_id.as_ref().map(|m| m.to_string());
    let project_id = e.project_id.as_ref().map(|p| p.to_string());
    Ok(match e.r#type {
        HubEventType::ChatMessage => {
            let Some(d) = data::<ChatMessageEventData>(e) else {
                return Ok(None);
            };
            chat(db, d)?
        }
        HubEventType::RequestUpdated => {
            let (Some(id), Some(state), Some(by)) = (
                str_at(&e.data, "requestId"),
                str_at(&e.data, "state"),
                str_at(&e.data, "by"),
            ) else {
                return Ok(None);
            };
            let Some(name) = by.strip_prefix("human:") else {
                return Ok(None);
            };
            if !ANSWERED.contains(&state) {
                return Ok(None);
            }
            // One answer is one touch: a later update while it stays approved (a note on its run) carries the same
            // answer time. An answer time after this event is a later answer, after the request opened again.
            let answered = answered_ms(db, id)?.filter(|a| *a <= at).unwrap_or(at);
            Some(TouchRow {
                machine_id,
                project_id,
                workstream_id: str_at(&e.data, "workstreamId").map(str::to_owned),
                key_id: Some(name.to_owned()),
                ..touch(
                    TouchKind::ItemAnswered,
                    "request",
                    format!("{id}@{answered}"),
                    answered,
                    human::ITEM_MS,
                )
            })
        }
        HubEventType::SteerQueued => {
            let Some(d) = data::<SteerEventData>(e) else {
                return Ok(None);
            };
            let Some(SteerBy::Human { key_name }) = d.by else {
                return Ok(None);
            };
            let w = d.workstream_id.to_string();
            let (machine_id, project_id) = order_project(db, &w)?.unzip();
            Some(TouchRow {
                machine_id,
                project_id,
                workstream_id: Some(w),
                key_id: Some(key_name),
                ..touch(
                    TouchKind::Steer,
                    "steer",
                    d.steer_id.to_string(),
                    at,
                    human::STEER_MS,
                )
            })
        }
        HubEventType::DecisionRecorded => {
            let (Some(id), Some("human")) =
                (str_at(&e.data, "decisionId"), str_at(&e.data, "source"))
            else {
                return Ok(None);
            };
            let workstream_id = e
                .data
                .as_ref()
                .and_then(|d| d.get("scope")?.get("workstreamId")?.as_str())
                .map(str::to_owned);
            Some(TouchRow {
                machine_id,
                project_id,
                workstream_id,
                ..touch(
                    TouchKind::Decision,
                    "decision",
                    id.to_owned(),
                    at,
                    human::DECISION_MS,
                )
            })
        }
        HubEventType::WorkstreamCreated => {
            let Some(id) = str_at(&e.data, "workstreamId") else {
                return Ok(None);
            };
            workstream(db, id)?.and_then(|w| order(&w))
        }
        _ => None,
    })
}

/// A chat message the person wrote. A message too long for its event is read from the chat.
fn chat(db: &HubDb, d: ChatMessageEventData) -> Result<Option<TouchRow>, StoreError> {
    if d.author != ChatAuthor::Human {
        return Ok(None);
    }
    let message = match d.message {
        Some(m) => Some(m),
        None => {
            let data: Option<String> = db.with(|c| {
                Ok(c.query_row(
                    "SELECT data FROM chat_messages WHERE n = ?1",
                    [number(d.message_id.as_str())],
                    |r| r.get(0),
                )
                .optional()?)
            })?;
            data.and_then(|s| serde_json::from_str::<ChatMessage>(&s).ok())
        }
    };
    let Some(m) = message.filter(|m| m.history.is_none() && m.item.is_none()) else {
        return Ok(None);
    };
    let Some(at) = parse_ms(m.created_at.as_str()) else {
        return Ok(None);
    };
    Ok(Some(TouchRow {
        machine_id: Some(m.project_ref.machine_id.to_string()),
        project_id: Some(m.project_ref.project_id.to_string()),
        key_id: m.by.map(|b| b.to_string()),
        ..touch(
            TouchKind::ChatMessage,
            "chat",
            m.message_id.to_string(),
            at,
            human::typed_ms(m.text.chars().count()),
        )
    }))
}

/// An order the person submitted directly; one the lead opened is the lead's act (its chat message counts instead).
fn order(w: &Workstream) -> Option<TouchRow> {
    let direct = matches!(w.source.channel, IntakeChannel::App | IntakeChannel::Mcp);
    if !direct || w.source.by != "human" {
        return None;
    }
    Some(TouchRow {
        machine_id: Some(w.project_ref.machine_id.to_string()),
        project_id: Some(w.project_ref.project_id.to_string()),
        workstream_id: Some(w.workstream_id.to_string()),
        ..touch(
            TouchKind::OrderSubmitted,
            "order",
            w.workstream_id.to_string(),
            parse_ms(w.source.at.as_str())?,
            human::typed_ms(w.source.text.chars().count()),
        )
    })
}

/// A human account merged a PR by hand: fleetd's or an outside one. It is recorded with no account, because
/// `pr.merged_outside` doesn't name the merger yet, so `human::attributed` leaves it out of the person's minutes
/// until the git host reader records who merged.
pub fn merged_by_hand(m: &MergeRow) -> Option<TouchRow> {
    let route = MergeRoute::parse(&m.route)?;
    if m.merged_by_kind.as_deref() != Some("human")
        || !matches!(route, MergeRoute::FleetdByHand | MergeRoute::Outside)
    {
        return None;
    }
    Some(TouchRow {
        machine_id: m.machine_id.clone(),
        project_id: m.project_id.clone(),
        repo: Some(m.repo.clone()),
        workstream_id: m.workstream_id.clone(),
        pr_number: m.pr_number,
        outside: route == MergeRoute::Outside,
        ..touch(
            TouchKind::MergeByHand,
            "merge",
            format!("{}#{}", m.repo, m.unit_key),
            m.merged_ms,
            human::MERGE_BY_HAND_MS,
        )
    })
}

fn workstream(db: &HubDb, id: &str) -> Result<Option<Workstream>, StoreError> {
    let data: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT data FROM workstreams WHERE n = ?1",
            [number(id)],
            |r| r.get(0),
        )
        .optional()?)
    })?;
    Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
}

/// When a request was last answered, from its record.
fn answered_ms(db: &HubDb, id: &str) -> Result<Option<i64>, StoreError> {
    let at: Option<Option<String>> = db.with(|c| {
        Ok(c.query_row(
            "SELECT json_extract(data, '$.answeredAt') FROM requests WHERE n = ?1",
            [number(id)],
            |r| r.get(0),
        )
        .optional()?)
    })?;
    Ok(at.flatten().as_deref().and_then(parse_ms))
}

fn order_project(db: &HubDb, id: &str) -> Result<Option<(String, String)>, StoreError> {
    db.with(|c| {
        Ok(c.query_row(
            "SELECT machine_id, project_id FROM workstreams WHERE n = ?1",
            [number(id)],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
    })
}
