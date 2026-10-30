//! A project's or Navi's picture (`project_avatar_set`, `project_avatar_get`): what its chat shows in place of its
//! letters, on the phone and the desktop. The app uploads the picture as it was picked (attachment_put) and names the
//! square to keep; the hub decodes it (png, jpeg or webp), turns it as its EXIF says, crops it, shrinks it to at most
//! [`AVATAR_PX`] a side and keeps that alone, re-encoded as JPEG: nothing of the original's metadata (EXIF, location,
//! color profile) is kept, and the upload itself is forgotten at once. Who may change it is who may change the
//! project's other settings (operate on its machine); a Navi's, only its owner (the guard in `navi/owner.rs`).
//!
//! The project's summary names the picture by `avatar`, its sha256's first 16 hex, so an app fetches its bytes once
//! per picture; a change is a `project.settings` event, which sends every open app back for a fresh snapshot.
use std::io::Cursor;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::Role;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    AVATAR_PX, AttachmentMime, AvatarCrop, ErrorCode, ProjectAvatarGetInput,
    ProjectAvatarGetOutput, ProjectAvatarSetInput, ProjectAvatarSetOutput,
};
use fleetd_contracts::prim::Line;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageDecoder, ImageFormat, ImageReader, RgbImage};
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::hub::api::{Caller, Hub, Registry, ToolError, require, unknown_project};
use crate::hub::store::{NewEvent, StoreError, now_ms};

/// The kept JPEG's most bytes: a busier picture is encoded again at a lower quality until it fits.
pub const AVATAR_MAX_BYTES: usize = 160 * 1024;
/// A picture wider or taller than this is refused before it is decoded.
const SOURCE_MAX_PX: u32 = 12_000;
/// The most memory decoding one picture may take.
const SOURCE_MAX_ALLOC: u64 = 512 * 1024 * 1024;
const QUALITIES: [u8; 4] = [86, 76, 64, 50];

pub fn register(tools: &mut Registry) {
    tools.add("project_avatar_set", set);
    tools.add("project_avatar_get", get);
}

/// The project's picture's id, for its summary.
pub fn of(c: &Connection, r: &ProjectRef) -> Result<Option<String>, StoreError> {
    Ok(c.prepare_cached(
        "SELECT avatar FROM project_avatars WHERE machine_id = ? AND project_id = ?",
    )?
    .query_row(
        params![r.machine_id.as_str(), r.project_id.as_str()],
        |row| row.get(0),
    )
    .optional()?)
}

fn unusable(why: impl std::fmt::Display) -> ToolError {
    ToolError::new(
        ErrorCode::Invalid,
        format!("That picture can't be used: {why}."),
    )
    .with_fix("Pick a photo or a png, jpeg or webp image.")
}

/// The square `crop` names, inside a `w` × `h` picture: moved, then shrunk, to fit. Absent: the largest in the middle.
fn square(w: u32, h: u32, crop: Option<AvatarCrop>) -> (u32, u32, u32) {
    let short = w.min(h);
    let Some(crop) = crop else {
        return ((w - short) / 2, (h - short) / 2, short);
    };
    let px = |n: i64| u32::try_from(n).unwrap_or(u32::MAX);
    let size = px(crop.size.get()).clamp(1, short);
    (
        px(crop.x.get()).min(w - size),
        px(crop.y.get()).min(h - size),
        size,
    )
}

/// The picture as the hub keeps it: decoded, turned upright, cropped, at most [`AVATAR_PX`] a side, on white where it
/// was transparent, and encoded as a JPEG of at most [`AVATAR_MAX_BYTES`] with no metadata.
pub fn render(bytes: &[u8], crop: Option<AvatarCrop>) -> Result<Vec<u8>, ToolError> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(unusable)?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)
    ) {
        return Err(unusable("it isn't a png, jpeg or webp image"));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(SOURCE_MAX_PX);
    limits.max_image_height = Some(SOURCE_MAX_PX);
    limits.max_alloc = Some(SOURCE_MAX_ALLOC);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(unusable)?;
    let orientation = decoder.orientation().map_err(unusable)?;
    let mut picture = DynamicImage::from_decoder(decoder).map_err(unusable)?;
    picture.apply_orientation(orientation);
    let (w, h) = picture.dimensions();
    if w == 0 || h == 0 {
        return Err(unusable("it is empty"));
    }
    let (x, y, size) = square(w, h, crop);
    let mut kept = picture.crop_imm(x, y, size, size);
    if size > AVATAR_PX {
        kept = kept.resize_exact(AVATAR_PX, AVATAR_PX, FilterType::Lanczos3);
    }
    let rgb = on_white(&kept);
    for quality in QUALITIES {
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
            .encode_image(&rgb)
            .map_err(unusable)?;
        if out.len() <= AVATAR_MAX_BYTES {
            return Ok(out);
        }
    }
    Err(unusable("it doesn't shrink small enough"))
}

/// Its pixels laid on white: a JPEG has no transparency, and a logo's clear background reads best as white.
fn on_white(picture: &DynamicImage) -> RgbImage {
    if !picture.color().has_alpha() {
        return picture.to_rgb8();
    }
    let rgba = picture.to_rgba8();
    RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let [r, g, b, a] = rgba.get_pixel(x, y).0;
        let over = |c: u8| ((u16::from(c) * u16::from(a) + 255 * (255 - u16::from(a))) / 255) as u8;
        image::Rgb([over(r), over(g), over(b)])
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn set(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectAvatarSetInput,
) -> Result<ProjectAvatarSetOutput, ToolError> {
    let r = ProjectRef {
        machine_id: input.machine_id,
        project_id: input.project_id,
    };
    require(&caller, Role::Operate, Some(&r.machine_id))?;
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    let kept = match &input.attachment_id {
        Some(id) => {
            let (bytes, _) = crate::hub::intake::attachments::take(&hub, &caller, id).await?;
            let crop = input.crop;
            let jpeg = tokio::task::spawn_blocking(move || render(&bytes, crop))
                .await
                .map_err(|_| crate::hub::api::internal_error())??;
            let avatar = hex(&Sha256::digest(&jpeg)[..8]);
            let at = now_ms(hub.clock.as_ref());
            hub.db.with(|c| {
                c.execute(
                    "INSERT INTO project_avatars (machine_id, project_id, avatar, jpeg, set_ms) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT (machine_id, project_id) DO UPDATE SET avatar = excluded.avatar, jpeg = excluded.jpeg,
                       set_ms = excluded.set_ms",
                    params![r.machine_id.as_str(), r.project_id.as_str(), avatar, jpeg, at],
                )?;
                Ok(())
            })?;
            Some(avatar)
        }
        None => {
            hub.db.with(|c| {
                c.execute(
                    "DELETE FROM project_avatars WHERE machine_id = ?1 AND project_id = ?2",
                    params![r.machine_id.as_str(), r.project_id.as_str()],
                )?;
                Ok(())
            })?;
            None
        }
    };
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
        summary: match &kept {
            Some(_) => format!("{} has a new picture", project.title),
            None => format!("{}'s picture removed", project.title),
        },
        data: Some(serde_json::json!({ "avatar": kept })),
        attention: None,
    })?;
    Ok(ProjectAvatarSetOutput {
        project,
        next: None,
        truncated: None,
    })
}

async fn get(
    hub: Arc<Hub>,
    caller: Caller,
    input: ProjectAvatarGetInput,
) -> Result<ProjectAvatarGetOutput, ToolError> {
    let r = ProjectRef {
        machine_id: input.machine_id,
        project_id: input.project_id,
    };
    require(&caller, Role::Read, Some(&r.machine_id))?;
    let kept: Option<(String, Vec<u8>)> = hub.db.with(|c| {
        Ok(c.query_row(
            "SELECT avatar, jpeg FROM project_avatars WHERE machine_id = ?1 AND project_id = ?2",
            params![r.machine_id.as_str(), r.project_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
    })?;
    let Some((avatar, jpeg)) = kept else {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("{} on {} has no picture.", r.project_id, r.machine_id),
        )
        .with_fix("Its letters show; project_avatar_set gives it one."));
    };
    Ok(ProjectAvatarGetOutput {
        avatar: Line::unchecked(avatar),
        mime: AttachmentMime::Jpeg,
        data_b64: B64.encode(jpeg),
        next: None,
        truncated: None,
    })
}
