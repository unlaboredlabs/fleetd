//! checklist_get: the panel's Checklist tab. Read-only: only the lead's `checklist` changes the list.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::mcp::{ChecklistGetInput, ChecklistGetOutput};
use fleetd_contracts::prim::List;

use crate::hub::api::{Caller, Hub, Registry, ToolError, require, unknown_project};
use crate::hub::store::iso_ms;

pub fn register(tools: &mut Registry) {
    tools.add("checklist_get", checklist_get);
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
