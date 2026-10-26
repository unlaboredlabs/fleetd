//! memory_get, memory_set, memory_undo and memory_caps_set: Settings > Memory and the chat's Undo. Writes are a
//! person's (human keys): an agent changes memory only through its lead's `remember`. The caps are an admin's.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    ErrorCode, MemoryCapsSetInput, MemoryCapsSetOutput, MemoryGetInput, MemoryGetOutput,
    MemorySetInput, MemorySetOutput, MemoryUndoInput, MemoryUndoOutput,
};
use fleetd_contracts::memory::{MemoryScope, RememberedItem};
use fleetd_contracts::prim::{Count, True};

use super::Target;
use super::calls::changed;
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, admin_everywhere_fix, allows_everywhere, require,
    unknown_project,
};
use crate::hub::orders::notes::require_human;

pub fn register(tools: &mut Registry) {
    tools.add("memory_get", memory_get);
    tools.add("memory_set", memory_set);
    tools.add("memory_undo", memory_undo);
    tools.add("memory_caps_set", memory_caps_set);
}

fn known_project(hub: &Hub, caller: &Caller, r: &ProjectRef, role: Role) -> Result<(), ToolError> {
    require(caller, role, Some(&r.machine_id))?;
    if hub.store.project_get(r)?.is_none() {
        return Err(unknown_project(r));
    }
    Ok(())
}

async fn memory_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: MemoryGetInput,
) -> Result<MemoryGetOutput, ToolError> {
    let memory = hub.db.memory();
    let user = memory.file(
        &hub.db,
        &Target {
            project: None,
            topic: None,
        },
    )?;
    let Some(r) = &input.project_ref else {
        return Ok(MemoryGetOutput {
            user,
            files: None,
            project_chars: None,
            project_cap: None,
            caps: Some(memory.caps().clone()),
            next: Some(
                "memory_get with projectRef adds that project's MEMORY.md and topic files.".into(),
            ),
            truncated: None,
        });
    };
    known_project(&hub, &caller, r, Role::Read)?;
    let topics = memory.topics(r);
    let mut files = vec![memory.file(
        &hub.db,
        &Target {
            project: Some(r),
            topic: None,
        },
    )?];
    for topic in &topics {
        files.push(memory.file(
            &hub.db,
            &Target {
                project: Some(r),
                topic: Some(topic),
            },
        )?);
    }
    Ok(MemoryGetOutput {
        user,
        files: Some(files),
        project_chars: Some(Count::unchecked(memory.project_chars(r) as i64)),
        project_cap: Some(Count::unchecked(memory.caps().project.get())),
        caps: Some(memory.caps().clone()),
        next: None,
        truncated: None,
    })
}

async fn memory_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: MemorySetInput,
) -> Result<MemorySetOutput, ToolError> {
    require_human(&caller, "memory_set")?;
    let project = match (input.scope, &input.project_ref) {
        (MemoryScope::Project, Some(r)) => {
            known_project(&hub, &caller, r, Role::Operate)?;
            Some(r)
        }
        _ => None,
    };
    let t = Target {
        project,
        topic: input.topic.as_ref(),
    };
    hub.db.memory().set(&t, input.text.as_str())?;
    changed(&hub, project, input.topic.as_ref(), caller.name.as_str())?;
    Ok(MemorySetOutput {
        file: hub.db.memory().file(&hub.db, &t)?,
        next: None,
        truncated: None,
    })
}

async fn memory_undo(
    hub: Arc<Hub>,
    caller: Caller,
    input: MemoryUndoInput,
) -> Result<MemoryUndoOutput, ToolError> {
    require_human(&caller, "memory_undo")?;
    let r = &input.project_ref;
    require(&caller, Role::Operate, Some(&r.machine_id))?;
    let not_found = || {
        ToolError::new(
            ErrorCode::NotFound,
            format!("No remembered line {} in this chat.", input.message_id),
        )
    };
    let message = hub
        .chat
        .by_id(input.message_id.as_str())?
        .filter(|m| &m.project_ref == r)
        .ok_or_else(not_found)?;
    let Some(item) = message.remembered.clone() else {
        return Err(not_found());
    };
    if item.undone == Some(true) {
        return Ok(MemoryUndoOutput {
            ok: True,
            next: Some("Already undone.".into()),
            truncated: None,
        });
    }
    hub.db.memory().undo(r, &item)?;
    let project = (item.scope == MemoryScope::Project).then_some(r);
    changed(&hub, project, item.topic.as_ref(), caller.name.as_str())?;
    hub.chat.set_remembered(
        message,
        RememberedItem {
            undone: Some(true),
            ..item
        },
    )?;
    Ok(MemoryUndoOutput {
        ok: True,
        next: None,
        truncated: None,
    })
}

async fn memory_caps_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: MemoryCapsSetInput,
) -> Result<MemoryCapsSetOutput, ToolError> {
    // user.md is every project's, so Admin on one machine is not enough.
    if !allows_everywhere(&caller, Role::Admin) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Memory caps are hub-wide: they need Admin on every machine.",
        )
        .with_fix(admin_everywhere_fix(&caller)));
    }
    hub.db.set_memory_caps(&input.caps)?;
    Ok(MemoryCapsSetOutput {
        caps: input.caps,
        next: Some(
            "Writes past a cap are refused from now; a file already over a lowered cap stays as it is.".into(),
        ),
        truncated: None,
    })
}
