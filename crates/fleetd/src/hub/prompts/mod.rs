//! Every prompt fleetd sends a model, visible and editable: the registry of shipped texts, the overrides in the hub
//! home, the per-session pins, and the tools over them.
pub mod fixed;
pub mod registry;
pub mod render;
pub mod retired;
pub mod store;
pub mod tools;

#[cfg(test)]
mod tests;

use fleetd_contracts::events::Attention;
use fleetd_contracts::events::HubEventType;
use serde_json::json;

pub use registry::Audience;
pub use store::PromptSet;

use crate::hub::store::{EventLog, HubDb, NewEvent, StoreError};

/// At hub start: keeps this release's shipped texts and raises one `prompt.default_changed` per override whose
/// default changed since it was edited (once per new default). The override stays in effect.
pub fn start(db: &HubDb, events: &EventLog, at: &str) -> Result<(), StoreError> {
    let prompts = db.prompts();
    prompts.keep_defaults()?;
    for stale in prompts.stale() {
        let e = stale.entry;
        let current = render::ref_of(e.id, e.default);
        let project = stale
            .project
            .as_ref()
            .map(|p| format!("{}/{}", p.machine_id, p.project_id));
        let seen: bool = db.with(|c| {
            Ok(c.query_row(
                "SELECT EXISTS (SELECT 1 FROM events WHERE type = 'prompt.default_changed' AND json_extract(data, '$.data.id') = ? AND json_extract(data, '$.data.current') = ? AND IFNULL(json_extract(data, '$.data.project'), '') = ?)",
                rusqlite::params![e.id, current, project.as_deref().unwrap_or("")],
                |r| r.get(0),
            )?)
        })?;
        if seen {
            continue;
        }
        let scope = if project.is_some() {
            "project"
        } else {
            "global"
        };
        events.append(NewEvent {
            at: at.into(),
            r#type: HubEventType::PromptDefaultChanged,
            machine_id: stale.project.as_ref().map(|p| p.machine_id.clone()),
            project_id: stale.project.as_ref().map(|p| p.project_id.clone()),
            thread_id: None,
            summary: format!(
                "fleetd changed the default of {}, which you edited{}; yours stays in effect until you review it",
                e.id,
                project.as_ref().map(|p| format!(" for {p}")).unwrap_or_default()
            ),
            data: Some(json!({
                "id": e.id,
                "scope": scope,
                "projectRef": stale.project,
                "project": project,
                "base": stale.base,
                "current": current,
            })),
            attention: Some(Attention::Loud),
        })?;
    }
    Ok(())
}

/// `prompt.changed`: an override was saved (`data.ref`, `data.warnings`) or reset. The text stays out of the event.
pub fn changed(
    events: &EventLog,
    at: &str,
    id: &str,
    scope: fleetd_contracts::prompts::PromptScope,
    project: Option<&fleetd_contracts::ids::ProjectRef>,
    mut data: serde_json::Value,
) -> Result<(), StoreError> {
    data["id"] = json!(id);
    data["scope"] = json!(scope);
    if let Some(r) = project {
        data["projectRef"] = json!(r);
    }
    events.append(NewEvent {
        at: at.into(),
        r#type: HubEventType::PromptChanged,
        machine_id: project.map(|r| r.machine_id.clone()),
        project_id: project.map(|r| r.project_id.clone()),
        thread_id: None,
        summary: match project {
            Some(r) => format!("Prompt {id} changed for {}/{}", r.machine_id, r.project_id),
            None => format!("Prompt {id} changed hub-wide"),
        },
        data: Some(data),
        attention: None,
    })?;
    Ok(())
}
