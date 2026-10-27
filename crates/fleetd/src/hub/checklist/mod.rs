//! Each project's checklist (table `checklists`): the lead's to-do list for the human, one row per project with its
//! items as JSON in order. The lead changes it with `checklist` (calls.rs), the app reads it with `checklist_get`, a
//! person takes items off with `checklist_remove` or ticks, edits or removes them with `checklist_edit` (tools.rs), and
//! the lead's digest shows what is still open.
pub mod calls;
pub mod tools;

#[cfg(test)]
mod tests;

use fleetd_contracts::checklist::{CHECKLIST_MAX, ChecklistCall, TodoItem, TodoLink, TodoState};
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::people::PersonRef;
use fleetd_contracts::prim::Positive;
use rusqlite::{Connection, OptionalExtension, params};

use crate::hub::store::{HubDb, StoreError, iso_ms};

/// A project's list as stored.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Checklist {
    pub items: Vec<TodoItem>,
    /// The id the next new item gets.
    pub next_id: i64,
    /// None while the lead has never set one.
    pub updated_ms: Option<i64>,
}

impl Checklist {
    pub fn done(&self) -> usize {
        self.items
            .iter()
            .filter(|i| i.state == TodoState::Done)
            .count()
    }
}

fn read_on(c: &Connection, r: &ProjectRef) -> Result<Checklist, StoreError> {
    let row: Option<(i64, String, i64)> = c
        .query_row(
            "SELECT next_id, items, updated_ms FROM checklists WHERE machine_id = ? AND project_id = ?",
            params![r.machine_id.as_str(), r.project_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(match row {
        None => Checklist {
            next_id: 1,
            ..Checklist::default()
        },
        Some((next_id, items, updated_ms)) => Checklist {
            items: serde_json::from_str(&items)?,
            next_id,
            updated_ms: Some(updated_ms),
        },
    })
}

pub fn read(db: &HubDb, r: &ProjectRef) -> Result<Checklist, StoreError> {
    db.with(|c| read_on(c, r))
}

/// The call's edits, in order, on `list`; a refusal leaves it as it was. Ids are never reused, so an id the lead
/// still holds from a removed item can't name a new one. Each item added or changed records `person`, who made the
/// change (None: the lead).
pub fn edited(
    list: &Checklist,
    call: &ChecklistCall,
    at: &Timestamp,
    person: Option<&PersonRef>,
) -> Result<Checklist, McpToolError> {
    let mut next = list.clone();
    if call.replace == Some(true) {
        next.items.clear();
    }
    for edit in call.items.iter() {
        let Some(id) = edit.id else {
            // The contract refuses a new item without text.
            let Some(text) = edit.text.clone() else {
                continue;
            };
            next.items.push(TodoItem {
                id: Positive::unchecked(next.next_id),
                text,
                state: edit.state.unwrap_or_default(),
                link: edit.link.clone().filter(|l| !l.is_empty()),
                updated_at: at.clone(),
                person: person.cloned(),
            });
            next.next_id += 1;
            continue;
        };
        let Some(at_index) = next.items.iter().position(|i| i.id == id) else {
            return Err(McpToolError::new(
                ErrorCode::NotFound,
                format!("No item {id} on this project's checklist."),
            )
            .with_fix(ids_fix(&next)));
        };
        if edit.remove == Some(true) {
            next.items.remove(at_index);
            continue;
        }
        let item = &mut next.items[at_index];
        let before = item.clone();
        if let Some(text) = &edit.text {
            item.text = text.clone();
        }
        if let Some(state) = edit.state {
            item.state = state;
        }
        if let Some(link) = &edit.link {
            item.link = Some(link.clone()).filter(|l: &TodoLink| !l.is_empty());
        }
        if *item != before {
            item.updated_at = at.clone();
            item.person = person.cloned();
        }
    }
    if next.items.len() > CHECKLIST_MAX {
        return Err(McpToolError::new(
            ErrorCode::Invalid,
            format!(
                "The checklist holds {CHECKLIST_MAX} items; this would make it {}.",
                next.items.len()
            ),
        )
        .with_fix("Remove done items, or merge small ones into one."));
    }
    Ok(next)
}

fn ids_fix(list: &Checklist) -> String {
    if list.items.is_empty() {
        return "The checklist is empty: add items without an id.".into();
    }
    let ids: Vec<String> = list.items.iter().map(|i| i.id.to_string()).collect();
    format!("Its items are {}.", ids.join(", "))
}

/// Applies the call in one transaction: the list after it, and whether it changed (when it was already so, nothing
/// is written).
pub fn apply(
    db: &HubDb,
    r: &ProjectRef,
    call: &ChecklistCall,
    now_ms: i64,
    person: Option<&PersonRef>,
) -> Result<Result<(Checklist, bool), McpToolError>, StoreError> {
    db.transaction(|c| {
        let list = read_on(c, r)?;
        let next = match edited(&list, call, &Timestamp::from(iso_ms(now_ms)), person) {
            Ok(next) => next,
            Err(refused) => return Ok(Err(refused)),
        };
        if next.items == list.items && list.updated_ms.is_some() {
            return Ok(Ok((list, false)));
        }
        Ok(Ok((write_on(c, r, next, now_ms)?, true)))
    })
}

/// A person's removal, in one transaction: the list after it, and the items it took off in the list's order (none
/// when every id was already gone, and then nothing is written). Ids stay used, so the lead can't hand one out again.
pub fn remove(
    db: &HubDb,
    r: &ProjectRef,
    ids: &[Positive],
    now_ms: i64,
) -> Result<(Checklist, Vec<TodoItem>), StoreError> {
    db.transaction(|c| {
        let list = read_on(c, r)?;
        let (removed, kept): (Vec<TodoItem>, Vec<TodoItem>) = list
            .items
            .iter()
            .cloned()
            .partition(|i| ids.contains(&i.id));
        if removed.is_empty() {
            return Ok((list, removed));
        }
        let next = Checklist {
            items: kept,
            ..list
        };
        Ok((write_on(c, r, next, now_ms)?, removed))
    })
}

fn write_on(
    c: &Connection,
    r: &ProjectRef,
    next: Checklist,
    now_ms: i64,
) -> Result<Checklist, StoreError> {
    c.execute(
        "INSERT INTO checklists (machine_id, project_id, next_id, items, updated_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (machine_id, project_id) DO UPDATE SET
           next_id = excluded.next_id, items = excluded.items, updated_ms = excluded.updated_ms",
        params![
            r.machine_id.as_str(),
            r.project_id.as_str(),
            next.next_id,
            serde_json::to_string(&next.items)?,
            now_ms
        ],
    )?;
    Ok(Checklist {
        updated_ms: Some(now_ms),
        ..next
    })
}

/// The digest's Checklist section: how far along it is, then every item not done, in order. None while it is empty.
pub fn digest_lines(db: &HubDb, r: &ProjectRef) -> Option<Vec<String>> {
    let list = read(db, r)
        .inspect_err(|e| tracing::warn!(error = %e, "checklist read for the digest"))
        .ok()?;
    if list.items.is_empty() {
        return None;
    }
    let mut lines = vec![format!(
        "{} of {} done; keep it current with `checklist`",
        list.done(),
        list.items.len()
    )];
    for item in list.items.iter().filter(|i| i.state != TodoState::Done) {
        let state = match item.state {
            TodoState::Doing => "doing",
            _ => "todo",
        };
        lines.push(format!(
            "- {} {state}: {}{}",
            item.id,
            item.text.as_str(),
            link_words(item.link.as_ref())
        ));
    }
    Some(lines)
}

fn link_words(link: Option<&TodoLink>) -> String {
    let Some(link) = link else {
        return String::new();
    };
    let mut words: Vec<String> = Vec::new();
    if let Some(w) = &link.workstream_id {
        words.push(w.to_string());
    }
    if let Some(t) = &link.task_id {
        words.push(t.to_string());
    }
    if let Some(pr) = &link.pr {
        let pr = pr.as_str();
        words.push(
            pr.rsplit_once("/pull/")
                .map_or(pr.to_owned(), |(_, n)| format!("PR #{n}")),
        );
    }
    format!(" ({})", words.join(", "))
}
