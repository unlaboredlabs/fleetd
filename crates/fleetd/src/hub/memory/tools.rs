//! memory_get, memory_set, memory_undo and memory_caps_set: Settings > Memory and the chat's Undo. Writes are a
//! person's (human keys): an agent changes memory only through its lead's `remember` and `forget`. The caps are an
//! admin's. memory_refresh_run: Run now on the nightly refresh's row in Settings > Automations.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::chat::ChatMessage;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    ErrorCode, MemoryCapsSetInput, MemoryCapsSetOutput, MemoryGetInput, MemoryGetOutput,
    MemoryRefreshRunInput, MemoryRefreshRunOutput, MemorySetInput, MemorySetOutput,
    MemoryUndoInput, MemoryUndoOutput,
};
use fleetd_contracts::memory::{MemoryRefreshed, MemoryScope, RememberedItem};
use fleetd_contracts::prim::{Count, True};

use super::calls::changed;
use super::{Target, refresh};
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
    tools.add("memory_refresh_run", memory_refresh_run);
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
    if let Some(refreshed) = message.memory_refreshed.clone() {
        return undo_refreshed(
            &hub,
            &caller,
            message,
            refreshed,
            input.item.map(|i| i.get()),
        );
    }
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

/// Undo on a "Memory refreshed" line: the change at `index`, or every change not yet undone (those past what the line
/// lists too), newest first, so a change made on top of an earlier one is taken back before it. Each one undone is
/// marked, even when a later one can't be: that one says why.
fn undo_refreshed(
    hub: &Hub,
    caller: &Caller,
    message: ChatMessage,
    refreshed: MemoryRefreshed,
    index: Option<i64>,
) -> Result<MemoryUndoOutput, ToolError> {
    let r = message.project_ref.clone();
    let id = message.message_id.as_str().to_owned();
    let mut items =
        refresh::line_items(&hub.db, &id)?.unwrap_or_else(|| refreshed.items.into_inner());
    let picked: Vec<usize> = match index {
        Some(i) if (i as usize) < items.len() => vec![i as usize],
        Some(i) => {
            return Err(ToolError::new(
                ErrorCode::NotFound,
                format!("That line has {} changes, not a change {i}.", items.len()),
            ));
        }
        None => (0..items.len()).rev().collect(),
    };
    let mut failed = None;
    let mut done = 0;
    for i in picked {
        let item = &items[i];
        if item.undone == Some(true) {
            continue;
        }
        if let Err(e) = hub.db.memory().undo(&r, item) {
            failed = Some(e);
            break;
        }
        let project = (item.scope == MemoryScope::Project).then_some(&r);
        changed(hub, project, item.topic.as_ref(), caller.name.as_str())?;
        items[i].undone = Some(true);
        done += 1;
    }
    if done > 0 {
        refresh::put_line_items(&hub.db, &r, &id, &items)?;
        hub.chat
            .set_memory_refreshed(message, refresh::listed(&items))?;
    }
    if let Some(e) = failed {
        return Err(e.into());
    }
    Ok(MemoryUndoOutput {
        ok: True,
        next: (done == 0).then(|| "Already undone.".into()),
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

async fn memory_refresh_run(
    hub: Arc<Hub>,
    caller: Caller,
    input: MemoryRefreshRunInput,
) -> Result<MemoryRefreshRunOutput, ToolError> {
    let r = &input.project_ref;
    known_project(&hub, &caller, r, Role::Operate)?;
    let why = refresh::run_now(&hub, &refresh::executors(&hub), r).await?;
    let next = match &why {
        None => {
            "Refreshing: a line in the chat lists what it changed, with Undo; nothing changed posts nothing."
        }
        Some(_) => "Nothing started; the nightly pass goes on as before.",
    };
    Ok(MemoryRefreshRunOutput {
        memory_refresh: refresh::job(&hub, r)?,
        why,
        next: Some(next.into()),
        truncated: None,
    })
}
