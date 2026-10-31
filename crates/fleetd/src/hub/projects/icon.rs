//! A project's or Navi's built-in icon (`project_icon_set`): a glass being's face on a field of a color, which its
//! chat shows when it has no picture. One a person never picked is derived from its id, so projects and Navis look
//! different from the start and each looks the same on every app and every launch. Picking one forgets its picture,
//! as uploading a picture shows over the icon. Who may change it is who may change its picture (`avatar.rs`).
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{ProjectIconSetInput, ProjectIconSetOutput};
use fleetd_contracts::model::{IconColor, IconFace, ProjectIcon};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::hub::api::{Caller, Hub, Registry, ToolError, require, unknown_project};
use crate::hub::store::{NewEvent, StoreError, now_ms};

pub fn register(tools: &mut Registry) {
    tools.add("project_icon_set", set);
}

/// The icon a project wears until a person picks one: from the first eight bytes of its ref's sha256, so it doesn't
/// change between builds.
pub fn derived(r: &ProjectRef) -> ProjectIcon {
    let digest = Sha256::digest(format!(
        "{}/{}",
        r.machine_id.as_str(),
        r.project_id.as_str()
    ));
    let mut first = [0; 8];
    first.copy_from_slice(&digest[..8]);
    let n = u64::from_be_bytes(first);
    let faces = IconFace::ALL.len() as u64;
    let colors = IconColor::ALL.len() as u64;
    ProjectIcon {
        face: IconFace::ALL[(n % faces) as usize],
        color: IconColor::ALL[(n / faces % colors) as usize],
    }
}

fn word<T: serde::Serialize>(v: T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn parse<T: serde::de::DeserializeOwned>(s: String) -> Option<T> {
    serde_json::from_value(serde_json::Value::String(s)).ok()
}

/// The project's icon, for its summary: the one picked, else its derived one (also for a pick this build doesn't know).
pub fn of(c: &Connection, r: &ProjectRef) -> Result<ProjectIcon, StoreError> {
    let picked: Option<(String, String)> = c
        .prepare_cached(
            "SELECT face, color FROM project_icons WHERE machine_id = ? AND project_id = ?",
        )?
        .query_row(
            params![r.machine_id.as_str(), r.project_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(picked
        .and_then(|(face, color)| {
            Some(ProjectIcon {
                face: parse(face)?,
                color: parse(color)?,
            })
        })
        .unwrap_or_else(|| derived(r)))
}

async fn set(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectIconSetInput,
) -> Result<ProjectIconSetOutput, ToolError> {
    let r = ProjectRef {
        machine_id: input.machine_id,
        project_id: input.project_id,
    };
    require(&caller, Role::Operate, Some(&r.machine_id))?;
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    let at = now_ms(hub.clock.as_ref());
    hub.db.transaction(|c| {
        c.execute(
            "INSERT INTO project_icons (machine_id, project_id, face, color, set_ms) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (machine_id, project_id) DO UPDATE SET face = excluded.face, color = excluded.color,
               set_ms = excluded.set_ms",
            params![r.machine_id.as_str(), r.project_id.as_str(), word(input.icon.face), word(input.icon.color), at],
        )?;
        c.execute(
            "DELETE FROM project_avatars WHERE machine_id = ?1 AND project_id = ?2",
            params![r.machine_id.as_str(), r.project_id.as_str()],
        )?;
        Ok(())
    })?;
    let project = hub
        .store
        .project_get(&r)?
        .ok_or_else(|| unknown_project(&r))?;
    hub.events.append(NewEvent {
        at: crate::hub::checks::now_ts(hub.clock.as_ref()),
        r#type: HubEventType::ProjectSettings,
        machine_id: Some(r.machine_id.clone()),
        project_id: Some(r.project_id.clone()),
        thread_id: None,
        summary: format!("{} has a new icon", project.title),
        data: Some(serde_json::json!({ "icon": input.icon, "avatar": null })),
        attention: None,
    })?;
    Ok(ProjectIconSetOutput {
        project,
        next: None,
        truncated: None,
    })
}
