//! checklist_get: the panel's Checklist tab. checklist_remove: a person takes items off it (Delete, Clear done); the
//! lead keeps the rest with its `checklist`, and hears of a removal at its next wake so it leaves those items off.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{
    ChecklistGetInput, ChecklistGetOutput, ChecklistRemoveInput, ChecklistRemoveOutput,
};
use fleetd_contracts::prim::List;

use crate::hub::api::{
    Caller, Hub, Registry, ToolError, require, unknown_project,
};
use crate::hub::leads::events::Event;
use crate::hub::leads::wakes::{LineKind, Trigger};
use crate::hub::orders::notes::require_human;
use crate::hub::store::{iso_ms, now_ms};

pub fn register(tools: &mut Registry) {
    tools.add("checklist_get", checklist_get);
    tools.add("checklist_remove", checklist_remove);
}

async fn checklist_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: ChecklistGetInput,
) -> Result<ChecklistGetOutput, ToolError> {
    let r = input.project_ref;
    require(&caller, Role::Read, Some(&r.machine_id))?;
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    let list = super::read(&hub.db, &r)?;
    let next = list.items.is_empty().then(|| {
        "The project's lead keeps this list; it is empty until the lead sets one.".to_owned()
    });
    Ok(ChecklistGetOutput {
        project_ref: r,
        items: List::unchecked(list.items),
        updated_at: list.updated_ms.map(|ms| iso_ms(ms).into()),
        next,
        truncated: None,
    })
}

async fn checklist_remove(
    hub: Arc<Hub>,
    caller: Caller,
    input: ChecklistRemoveInput,
) -> Result<ChecklistRemoveOutput, ToolError> {
    let r = input.project_ref;
    require(&caller, Role::Operate, Some(&r.machine_id))?;
    require_human(&caller, "checklist_remove")?;
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    let now = now_ms(hub.clock.as_ref());
    let (list, removed) = super::remove(&hub.db, &r, &input.ids, now)?;
    if !removed.is_empty() {
        let by = format!("human:{}", caller.name);
        super::calls::changed(&hub, &r, &list, &by, caller.person.as_ref(), now)?;
        let items: Vec<(i64, &str)> = removed
            .iter()
            .map(|i| (i.id.get(), i.text.as_str()))
            .collect();
        hub.leads.wakes.trigger(
            &r,
            Trigger::Line {
                kind: LineKind::Quiet,
                text: Event::ChecklistRemoved { items: &items }.render(),
            },
        );
    }
    Ok(ChecklistRemoveOutput {
        project_ref: r,
        items: List::unchecked(list.items),
        updated_at: list.updated_ms.map(|ms| iso_ms(ms).into()),
        next: None,
        truncated: None,
    })
}
