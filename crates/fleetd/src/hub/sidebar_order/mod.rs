//! Each person's own order of the projects and Navis in their sidebar (W214), kept on the hub so it is the same on
//! each of their desktops and survives a restart: `sidebar_order_get` and `sidebar_order_set`, from their own
//! devices. A set announces `sidebar.order`, which only that person's devices see (`someone_elses`), so one
//! person's order never moves a teammate's sidebar. A project or Navi the order doesn't name (a new one) goes after
//! the ones it does; the app does the ordering.
#[cfg(test)]
mod tests;

use std::sync::Arc;

use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    ErrorCode, SidebarOrderGetInput, SidebarOrderGetOutput, SidebarOrderSetInput,
    SidebarOrderSetOutput,
};
use fleetd_contracts::people::{PersonId, SidebarOrderData};
use rusqlite::{OptionalExtension, params};

use crate::hub::api::{Caller, Hub, Registry, ToolError, error, is_human};
use crate::hub::store::{HubDb, NewEvent, StoreError, iso_ms, now_ms};

pub fn register(tools: &mut Registry) {
    tools.add("sidebar_order_get", get);
    tools.add("sidebar_order_set", set);
}

/// The person's order; empty until they move something.
pub fn order(db: &HubDb, person: &PersonId) -> Result<Vec<ProjectRef>, StoreError> {
    let refs: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT refs FROM sidebar_orders WHERE person_id = ?",
            [person.as_str()],
            |row| row.get(0),
        )
        .optional()?)
    })?;
    Ok(refs
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_default())
}

fn put_order(db: &HubDb, person: &PersonId, order: &[ProjectRef]) -> Result<(), StoreError> {
    let refs = serde_json::to_string(order)?;
    db.with(|c| {
        c.execute(
            "INSERT INTO sidebar_orders (person_id, refs) VALUES (?, ?)
             ON CONFLICT (person_id) DO UPDATE SET refs = excluded.refs",
            params![person.as_str(), refs],
        )?;
        Ok(())
    })
}

/// The live person behind a human key; none for an agent's key or a removed person's.
pub(crate) fn me(hub: &Hub, caller: &Caller) -> Result<Option<PersonId>, ToolError> {
    let Some(p) = caller.person.as_ref().filter(|_| is_human(caller)) else {
        return Ok(None);
    };
    let person = crate::hub::people::People::new(hub.db.clone(), hub.clock.clone())
        .get(&p.person_id)?
        .filter(|p| p.removed_at.is_none());
    Ok(person.map(|p| p.person_id))
}

/// A `sidebar.order` or `chat.pins` event (W232) about another person than the caller's: theirs alone, never streamed
/// to the caller. Both say whose it is the same way.
pub fn someone_elses(caller: &Caller, event: &HubEvent) -> bool {
    if !matches!(
        event.r#type,
        HubEventType::SidebarOrder | HubEventType::ChatPins
    ) {
        return false;
    }
    let whose = event
        .data
        .as_ref()
        .and_then(|d| serde_json::from_value::<SidebarOrderData>(d.clone()).ok());
    match (whose, caller.person.as_ref().filter(|_| is_human(caller))) {
        (Some(whose), Some(me)) => whose.person_id != me.person_id,
        _ => true,
    }
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    _input: SidebarOrderGetInput,
) -> Result<SidebarOrderGetOutput, ToolError> {
    let order = match me(&hub, &caller)? {
        Some(person) => order(&hub.db, &person)?,
        // Nobody's: the sidebar keeps its own order.
        None => Vec::new(),
    };
    Ok(SidebarOrderGetOutput {
        order,
        next: None,
        truncated: None,
    })
}

async fn set(
    hub: Arc<Hub>,
    caller: Caller,
    input: SidebarOrderSetInput,
) -> Result<SidebarOrderSetOutput, ToolError> {
    let person = me(&hub, &caller)?.ok_or_else(|| {
        error(
            ErrorCode::Forbidden,
            "Only a person keeps a sidebar order, from one of their own devices.",
            "Pair the app as yourself, then drag a project or a Navi in its sidebar.",
        )
    })?;
    let order = input.order.into_inner();
    put_order(&hub.db, &person, &order)?;
    let data = serde_json::to_value(SidebarOrderData {
        person_id: person.clone(),
    })
    .map_err(StoreError::from)?;
    let appended = hub.events.append(NewEvent {
        at: iso_ms(now_ms(hub.clock.as_ref())).into(),
        r#type: HubEventType::SidebarOrder,
        machine_id: None,
        project_id: None,
        thread_id: None,
        summary: "Sidebar order changed".into(),
        data: Some(data),
        attention: None,
    });
    // The order is saved; a missed event only means the person's other desktops catch up at their next read.
    if let Err(e) = appended {
        tracing::warn!(%person, "sidebar.order event not recorded: {e}");
    }
    Ok(SidebarOrderSetOutput {
        order,
        next: None,
        truncated: None,
    })
}
