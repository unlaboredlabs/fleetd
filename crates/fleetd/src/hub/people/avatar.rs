//! A person's own picture (`person_avatar_set`, `person_avatar_get`): what the apps show in place of their initials.
//! It is kept as a project's picture is (`projects/avatar.rs`, whose [`render`] it uses): the crop, upright, at most
//! [`fleetd_contracts::mcp::AVATAR_PX`] a side, re-encoded as JPEG with none of the original's metadata, and the upload
//! forgotten at once. Only a person sets their own, from one of their devices; anyone on the hub reads it.
//!
//! A person names the picture by `avatar`, its sha256's first 16 hex, so an app fetches its bytes once per picture; a
//! change is a `people.changed` event, which sends every open app back to hub_info and people_list.
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::mcp::{
    AttachmentMime, ErrorCode, PersonAvatarGetInput, PersonAvatarSetInput, PersonAvatarSetOutput,
    ProjectAvatarGetOutput,
};
use fleetd_contracts::people::{PeopleChange, Person};
use fleetd_contracts::prim::Line;
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::People;
use super::tools::{announce, change};
use crate::hub::api::{Caller, Hub, Registry, ToolError, error, is_human};
use crate::hub::projects::avatar::{hex, render};
use crate::hub::store::now_ms;

pub fn register(tools: &mut Registry) {
    tools.add("person_avatar_set", set);
    tools.add("person_avatar_get", get);
}

/// The caller's own person, still on the hub.
fn me(hub: &Hub, caller: &Caller) -> Result<Person, ToolError> {
    let person = match caller.person.as_ref().filter(|_| is_human(caller)) {
        Some(p) => People::new(hub.db.clone(), hub.clock.clone())
            .get(&p.person_id)?
            .filter(|p| p.removed_at.is_none()),
        None => None,
    };
    person.ok_or_else(|| {
        error(
            ErrorCode::Forbidden,
            "Only a person sets their own picture, from one of their own devices.",
            "Tap your picture in the phone app's Settings.",
        )
    })
}

async fn set(
    hub: Arc<Hub>,
    caller: Caller,
    input: PersonAvatarSetInput,
) -> Result<PersonAvatarSetOutput, ToolError> {
    let person = me(&hub, &caller)?;
    let id = person.person_id.as_str().to_owned();
    match &input.attachment_id {
        Some(attachment) => {
            let (bytes, _) =
                crate::hub::intake::attachments::take(&hub, &caller, attachment).await?;
            let crop = input.crop;
            let jpeg = tokio::task::spawn_blocking(move || render(&bytes, crop))
                .await
                .map_err(|_| crate::hub::api::internal_error())??;
            let avatar = hex(&Sha256::digest(&jpeg)[..8]);
            let at = now_ms(hub.clock.as_ref());
            hub.db.with(|c| {
                c.execute(
                    "INSERT INTO person_avatars (person_id, avatar, jpeg, set_ms) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT (person_id) DO UPDATE SET avatar = excluded.avatar, jpeg = excluded.jpeg,
                       set_ms = excluded.set_ms",
                    params![id, avatar, jpeg, at],
                )?;
                Ok(())
            })?;
        }
        None => {
            hub.db.with(|c| {
                c.execute("DELETE FROM person_avatars WHERE person_id = ?1", [&id])?;
                Ok(())
            })?;
        }
    }
    let after = People::new(hub.db.clone(), hub.clock.clone())
        .get(&person.person_id)?
        .unwrap_or(person);
    announce(
        &hub.events,
        hub.clock.as_ref(),
        change(
            PeopleChange::PictureChanged,
            &after.as_ref(),
            Some(&after.as_ref()),
        ),
        match after.avatar {
            Some(_) => format!("{} has a new picture", after.name),
            None => format!("{} removed their picture", after.name),
        },
    );
    Ok(PersonAvatarSetOutput {
        person: after,
        next: None,
        truncated: None,
    })
}

async fn get(
    hub: Arc<Hub>,
    _caller: Caller,
    input: PersonAvatarGetInput,
) -> Result<ProjectAvatarGetOutput, ToolError> {
    let kept: Option<(String, Vec<u8>)> = hub.db.with(|c| {
        Ok(c.query_row(
            "SELECT avatar, jpeg FROM person_avatars WHERE person_id = ?1",
            [input.person_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
    })?;
    let Some((avatar, jpeg)) = kept else {
        return Err(error(
            ErrorCode::NotFound,
            format!("{} has no picture.", input.person_id),
            "Their initials show; they set one with person_avatar_set.",
        ));
    };
    Ok(ProjectAvatarGetOutput {
        avatar: Line::unchecked(avatar),
        mime: AttachmentMime::Jpeg,
        data_b64: B64.encode(jpeg),
        next: None,
        truncated: None,
    })
}
