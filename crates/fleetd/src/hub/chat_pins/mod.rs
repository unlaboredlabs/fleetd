//! Each person's own pinned chats (W232), kept on the hub so they are the same on each of their phones and survive a
//! restart: `chat_pins_get` and `chat_pins_set`, from their own devices, at most `CHAT_PINS_MAX`, in their order. A
//! set announces `chat.pins`, which only that person's devices see (`sidebar_order::someone_elses`), so one person's
//! pins never move a teammate's list. A ref to a project that is gone stays until they set the pins again; the app
//! shows only the chats it has.
#[cfg(test)]
mod tests;

use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    ChatPinsGetInput, ChatPinsGetOutput, ChatPinsSetInput, ChatPinsSetOutput, ErrorCode,
};
use fleetd_contracts::people::{ChatPinsData, PersonId};
use rusqlite::{OptionalExtension, params};

use crate::hub::api::{Caller, Hub, Registry, ToolError, error};
use crate::hub::sidebar_order::me;
use crate::hub::store::{HubDb, NewEvent, StoreError, iso_ms, now_ms};

pub fn register(tools: &mut Registry) {
    tools.add("chat_pins_get", get);
    tools.add("chat_pins_set", set);
}

/// The person's pins; none until they first set them.
pub fn pins(db: &HubDb, person: &PersonId) -> Result<Option<Vec<ProjectRef>>, StoreError> {
    let refs: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT refs FROM chat_pins WHERE person_id = ?",
            [person.as_str()],
            |row| row.get(0),
        )
        .optional()?)
    })?;
    Ok(refs.map(|r| serde_json::from_str(&r).unwrap_or_default()))
}

fn put_pins(db: &HubDb, person: &PersonId, pins: &[ProjectRef]) -> Result<(), StoreError> {
    let refs = serde_json::to_string(pins)?;
    db.with(|c| {
        c.execute(
            "INSERT INTO chat_pins (person_id, refs) VALUES (?, ?)
             ON CONFLICT (person_id) DO UPDATE SET refs = excluded.refs",
            params![person.as_str(), refs],
        )?;
        Ok(())
    })
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    _input: ChatPinsGetInput,
) -> Result<ChatPinsGetOutput, ToolError> {
    let kept = match me(&hub, &caller)? {
        Some(person) => pins(&hub.db, &person)?,
        // Nobody's: the phone keeps its own.
        None => None,
    };
    Ok(ChatPinsGetOutput {
        set: kept.is_some(),
        pins: kept.unwrap_or_default(),
        next: None,
        truncated: None,
    })
}

async fn set(
    hub: Arc<Hub>,
    caller: Caller,
    input: ChatPinsSetInput,
) -> Result<ChatPinsSetOutput, ToolError> {
    let person = me(&hub, &caller)?.ok_or_else(|| {
        error(
            ErrorCode::Forbidden,
            "Only a person pins chats, from one of their own devices.",
            "Pair the app as yourself, then pin a chat in its list.",
        )
    })?;
    let pins = input.pins.into_inner();
    put_pins(&hub.db, &person, &pins)?;
    let data = serde_json::to_value(ChatPinsData {
        person_id: person.clone(),
    })
    .map_err(StoreError::from)?;
    let appended = hub.events.append(NewEvent {
        at: iso_ms(now_ms(hub.clock.as_ref())).into(),
        r#type: HubEventType::ChatPins,
        machine_id: None,
        project_id: None,
        thread_id: None,
        summary: "Pinned chats changed".into(),
        data: Some(data),
        attention: None,
    });
    // The pins are saved; a missed event only means the person's other phones catch up at their next read.
    if let Err(e) = appended {
        tracing::warn!(%person, "chat.pins event not recorded: {e}");
    }
    Ok(ChatPinsSetOutput {
        pins,
        next: None,
        truncated: None,
    })
}
