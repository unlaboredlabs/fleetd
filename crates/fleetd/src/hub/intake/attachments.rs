//! Files a person attaches to an order or a note. `attachment_put` stores the bytes under `<home>/attachments/<sha256>`
//! with a row; placing the order (or sending the note) writes them into the project's `.fleetd/attachments/<W>/` on
//! its machine and lists them in the lead's wake. Rows never used are deleted after 24 h. A file too large for one
//! call comes in pieces first (`attachment_part`), appended under `<home>/attachments/uploads/<id>`.
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::Role;
use fleetd_contracts::blocks::BlockBody;
use fleetd_contracts::chat::{CHAT_PARTS_MAX, ChatPart};
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::mcp::{
    ATTACHMENT_MAX_BYTES, AttachmentGetInput, AttachmentGetOutput, AttachmentId, AttachmentMime,
    AttachmentPartInput, AttachmentPartOutput, AttachmentPutInput, AttachmentPutOutput, ErrorCode,
    UploadId,
};
use fleetd_contracts::prim::{Count, List, Text};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::hub::api::{Caller, Hub, ToolError, allows_everywhere, is_human};
use crate::hub::store::now_ms;

/// Unreferenced uploads older than this are deleted.
const UNUSED_TTL_MS: i64 = 24 * 3600 * 1000;
/// An upload in pieces untouched this long is deleted.
const PIECES_TTL_MS: i64 = 3600 * 1000;

struct Row {
    sha256: String,
    name: String,
    mime: String,
    bytes: i64,
    by: String,
}

fn dir(hub: &Hub) -> PathBuf {
    hub.config.home.join("attachments")
}

fn mime_str(mime: AttachmentMime) -> String {
    serde_json::to_value(mime)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn kind_of(mime: &str) -> &'static str {
    match mime {
        m if m.starts_with("image/") => "image",
        "application/pdf" => "PDF",
        _ => "text",
    }
}

fn size(bytes: i64) -> String {
    match bytes {
        b if b >= 1024 * 1024 => format!("{:.1} MB", b as f64 / (1024.0 * 1024.0)),
        b if b >= 1024 => format!("{} KB", b / 1024),
        b => format!("{b} B"),
    }
}

/// A file name safe to write under the attachments directory: no separators, no leading dot.
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    if trimmed.is_empty() {
        "file".into()
    } else {
        trimmed.chars().take(100).collect()
    }
}

fn may_attach(caller: &Caller) -> Result<(), ToolError> {
    if !is_human(caller) && !allows_everywhere(caller, Role::Operate) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person's device or an operate key may attach files.",
        )
        .with_fix("Use the desktop app, or a key with operate on every machine."));
    }
    Ok(())
}

fn decode(data_b64: &str) -> Result<Vec<u8>, ToolError> {
    B64.decode(data_b64.as_bytes())
        .map_err(|e| ToolError::new(ErrorCode::Invalid, format!("dataB64 is not base64: {e}.")))
}

fn too_big(len: usize) -> Result<(), ToolError> {
    if len > ATTACHMENT_MAX_BYTES {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "The file is {len} bytes; attachments are at most {} MiB.",
                ATTACHMENT_MAX_BYTES / (1024 * 1024)
            ),
        )
        .with_fix("Attach a smaller file, or a link to it in the text."));
    }
    Ok(())
}

fn uploads_dir(hub: &Hub) -> PathBuf {
    dir(hub).join("uploads")
}

fn no_upload(id: &UploadId) -> ToolError {
    ToolError::new(ErrorCode::NotFound, format!("No upload {id}.")).with_fix(
        "Uploads untouched for an hour are deleted; send the file again from its first piece.",
    )
}

/// Deletes every upload untouched for PIECES_TTL_MS, and any pieces file without its row (a hub stopped mid-write)
/// once it too is that old, so a piece being written now is never taken. Returns how many uploads went.
pub fn sweep_uploads(hub: &Hub) -> Result<usize, ToolError> {
    let now = now_ms(hub.clock.as_ref());
    let stale: Vec<String> = hub.db.with(|c| {
        let mut stmt =
            c.prepare("DELETE FROM attachment_uploads WHERE touched_ms < ?1 RETURNING id")?;
        Ok(stmt
            .query_map([now - PIECES_TTL_MS], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    })?;
    let root = uploads_dir(hub);
    for id in &stale {
        let _ = std::fs::remove_file(root.join(id));
    }
    let ttl = std::time::Duration::from_millis(PIECES_TTL_MS as u64);
    for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|at| at.elapsed().is_ok_and(|age| age > ttl));
        if !old {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let known: bool = hub.db.with(|c| {
            Ok(c.query_row(
                "SELECT 1 FROM attachment_uploads WHERE id = ?1",
                [&name],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false))
        })?;
        if !known {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(stale.len())
}

/// Sweeps unfinished uploads every ten minutes, so one nobody finishes goes within the hour and ten minutes.
pub async fn run_sweep(hub: std::sync::Arc<Hub>) {
    loop {
        hub.clock.sleep(std::time::Duration::from_secs(600)).await;
        match sweep_uploads(&hub) {
            Ok(0) => {}
            Ok(n) => tracing::info!(n, "unfinished uploads deleted"),
            Err(e) => tracing::warn!(error = %e.message, "unfinished uploads not swept"),
        }
    }
}

/// The bytes upload `id` of `caller` holds so far.
fn upload_bytes(hub: &Hub, caller: &Caller, id: &UploadId) -> Result<usize, ToolError> {
    let row: Option<(String, i64)> = hub.db.with(|c| {
        Ok(c.query_row(
            "SELECT by, bytes FROM attachment_uploads WHERE id = ?1",
            [id.as_str()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
    })?;
    match row {
        Some((by, bytes)) if by == caller.key_id.as_str() => Ok(bytes as usize),
        _ => Err(no_upload(id)),
    }
}

/// `attachment_part`: one piece of a file, appended to its upload (a new one without an id).
pub async fn part(
    hub: &Hub,
    caller: &Caller,
    input: AttachmentPartInput,
) -> Result<AttachmentPartOutput, ToolError> {
    may_attach(caller)?;
    let piece = decode(&input.data_b64)?;
    if input.upload_id.is_none() {
        sweep_uploads(hub)?;
    }
    let offset = input.offset.map_or(0, |o| o.get() as usize);
    let (id, had) = match &input.upload_id {
        Some(id) => (id.clone(), upload_bytes(hub, caller, id)?),
        None => {
            let n: [u8; 16] = rand::random();
            (UploadId::unchecked(format!("U{}", hex(&n))), 0)
        }
    };
    if offset != had {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!("Upload {id} holds {had} bytes, not {offset}."),
        )
        .with_fix("Send the piece that starts at the bytes the upload holds, or the file again."));
    }
    let len = had + piece.len();
    too_big(len)?;
    let upsert = |bytes: usize| {
        let now = now_ms(hub.clock.as_ref());
        hub.db.with(|c| {
            c.execute(
                "INSERT INTO attachment_uploads (id, by, bytes, touched_ms) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (id) DO UPDATE SET bytes = excluded.bytes, touched_ms = excluded.touched_ms",
                params![id.as_str(), caller.key_id.as_str(), bytes as i64, now],
            )?;
            Ok(())
        })
    };
    // The row comes first, so no sweep takes a new upload's file for an orphan while its first piece is written.
    if input.upload_id.is_none() {
        upsert(0)?;
    }
    let root = uploads_dir(hub);
    let path = root.join(id.as_str());
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        std::fs::create_dir_all(&root)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        std::io::Write::write_all(&mut file, &piece)
    })
    .await
    .map_err(|_| crate::hub::api::internal_error())?
    .map_err(|e| {
        tracing::error!(error = %e, "attachment piece not stored");
        crate::hub::api::internal_error()
    })?;
    upsert(len)?;
    Ok(AttachmentPartOutput {
        upload_id: id,
        bytes: Count::unchecked(len as i64),
        next: Some(
            "Send the next piece, or the last one with attachment_put and this uploadId.".into(),
        ),
        truncated: None,
    })
}

pub async fn put(
    hub: &Hub,
    caller: &Caller,
    input: AttachmentPutInput,
) -> Result<AttachmentPutOutput, ToolError> {
    may_attach(caller)?;
    let last = decode(&input.data_b64)?;
    let bytes = match &input.upload_id {
        None => last,
        Some(id) => {
            let had = upload_bytes(hub, caller, id)?;
            too_big(had + last.len())?;
            let path = uploads_dir(hub).join(id.as_str());
            let mut bytes = tokio::fs::read(&path).await.map_err(|_| no_upload(id))?;
            // The pieces on disk must be the ones counted: a file short of them would be stored corrupt.
            if bytes.len() != had {
                return Err(ToolError::new(
                    ErrorCode::Failed,
                    format!(
                        "Upload {id} lost pieces: {} of its {had} bytes are here.",
                        bytes.len()
                    ),
                )
                .with_fix("Send the file again from its first piece."));
            }
            bytes.extend_from_slice(&last);
            hub.db.with(|c| {
                c.execute(
                    "DELETE FROM attachment_uploads WHERE id = ?1",
                    [id.as_str()],
                )?;
                Ok(())
            })?;
            let _ = tokio::fs::remove_file(&path).await;
            bytes
        }
    };
    let name = safe_name(&input.name);
    let (attachment_id, len, sha) =
        store(hub, bytes, &name, input.mime, caller.key_id.as_str()).await?;
    Ok(AttachmentPutOutput {
        attachment_id,
        bytes: Count::unchecked(len as i64),
        sha256: Text::unchecked(sha),
        next: Some("Pass attachmentId in chat_send or steer_send attachments.".into()),
        truncated: None,
    })
}

/// Stores a file's bytes under their sha256 and gives it a row `by` its uploader (a key, or `lead:<project>` for an
/// agent's image), deleting the unused uploads past their 24 h on the way. Its id, size and sha256.
pub(crate) async fn store(
    hub: &Hub,
    bytes: Vec<u8>,
    name: &str,
    mime: AttachmentMime,
    by: &str,
) -> Result<(AttachmentId, usize, String), ToolError> {
    too_big(bytes.len())?;
    let sha = hex(&Sha256::digest(&bytes));
    let root = dir(hub);
    let path = root.join(&sha);
    let len = bytes.len();
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        std::fs::create_dir_all(&root)?;
        if !path.exists() {
            let tmp = path.with_extension("part");
            std::fs::write(&tmp, &bytes)?;
            std::fs::rename(&tmp, &path)?;
        }
        Ok(())
    })
    .await
    .map_err(|_| crate::hub::api::internal_error())?
    .map_err(|e| {
        tracing::error!(error = %e, "attachment not stored");
        crate::hub::api::internal_error()
    })?;
    let now = now_ms(hub.clock.as_ref());
    let n: i64 = hub.db.with(|c| {
        // Unused uploads go here rather than on a timer: every upload checks.
        let stale: Vec<String> = {
            let mut stmt = c.prepare(
                "DELETE FROM attachments WHERE workstream_id IS NULL AND project IS NULL AND created_ms < ?1 RETURNING sha256",
            )?;
            stmt.query_map([now - UNUSED_TTL_MS], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        for sha in stale {
            let used: bool = c
                .query_row("SELECT 1 FROM attachments WHERE sha256 = ?1 LIMIT 1", [&sha], |_| Ok(true))
                .optional()?
                .unwrap_or(false);
            if !used {
                let _ = std::fs::remove_file(dir(hub).join(&sha));
            }
        }
        c.execute(
            "INSERT INTO attachments (sha256, name, mime, bytes, by, created_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![sha, name, mime_str(mime), len as i64, by, now],
        )?;
        Ok(c.last_insert_rowid())
    })?;
    Ok((AttachmentId::unchecked(format!("F{n}")), len, sha))
}

/// Whether attachment `n` was placed in an order of `project`.
fn in_project(hub: &Hub, n: i64, project: &ProjectRef) -> Result<bool, ToolError> {
    Ok(hub.db.with(|c| {
        Ok(c.query_row(
            "SELECT 1 FROM attachments a LEFT JOIN workstreams w ON w.n = CAST(substr(a.workstream_id, 2) AS INTEGER)
             WHERE a.n = ?1 AND (a.project = ?4 OR (w.machine_id = ?2 AND w.project_id = ?3))",
            params![
                n,
                project.machine_id.as_str(),
                project.project_id.as_str(),
                format!("{}/{}", project.machine_id, project.project_id)
            ],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
    })?)
}

/// `attachment_get`: a file of the project, for a caller who reads its machine.
pub async fn get(
    hub: &Hub,
    caller: &Caller,
    input: AttachmentGetInput,
) -> Result<AttachmentGetOutput, ToolError> {
    let project = &input.project_ref;
    if !crate::hub::api::allows(caller, Role::Read, Some(&project.machine_id)) {
        return Err(crate::hub::api::forbidden(
            Role::Read,
            Some(&project.machine_id),
        ));
    }
    let id = input.attachment_id;
    let gone = || {
        ToolError::new(
            ErrorCode::NotFound,
            format!("No attachment {id} in this project."),
        )
        .with_fix("Unused uploads expire after 24 h; attach the file again.")
    };
    let n: i64 = id.as_str()[1..].parse().unwrap_or(0);
    let Some(r) = row(hub, &id)? else {
        return Err(gone());
    };
    if r.by != caller.key_id.as_str() && !in_project(hub, n, project)? {
        return Err(gone());
    }
    let path = dir(hub).join(&r.sha256);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
        .await
        .map_err(|_| crate::hub::api::internal_error())?
        .map_err(|_| gone())?;
    if bytes.len() > ATTACHMENT_MAX_BYTES {
        return Err(gone());
    }
    let mime = serde_json::from_value::<AttachmentMime>(serde_json::Value::String(r.mime))
        .map_err(|_| crate::hub::api::internal_error())?;
    Ok(AttachmentGetOutput {
        attachment_id: id.clone(),
        name: fleetd_contracts::prim::Line::new(r.name.as_str())
            .unwrap_or_else(|_| fleetd_contracts::prim::Line::unchecked("file")),
        mime,
        bytes: Count::unchecked(r.bytes),
        data_b64: B64.encode(bytes),
        next: None,
        truncated: None,
    })
}

/// A file of `project`'s chat, for the hub's own use (a Navi's Telegram bridge sends it on): its name, type and bytes.
/// None when it isn't the project's, or is gone.
pub(crate) async fn read(
    hub: &Hub,
    id: &AttachmentId,
    project: &ProjectRef,
) -> Option<(String, AttachmentMime, Vec<u8>)> {
    let n: i64 = id.as_str().get(1..)?.parse().ok()?;
    let r = row(hub, id).ok()??;
    let key = format!("{}/{}", project.machine_id, project.project_id);
    let ours = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT 1 FROM attachments WHERE n = ?1 AND project = ?2",
                params![n, key],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
        })
        .ok()?;
    if !ours && !in_project(hub, n, project).ok()? {
        return None;
    }
    let path = dir(hub).join(&r.sha256);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
        .await
        .ok()?
        .ok()?;
    let mime = serde_json::from_value::<AttachmentMime>(serde_json::Value::String(r.mime)).ok()?;
    Some((r.name, mime, bytes))
}

/// What a chat message shows of each attachment, from its row.
pub fn refs(
    hub: &Hub,
    ids: &[AttachmentId],
) -> Result<Vec<fleetd_contracts::chat::AttachmentRef>, ToolError> {
    let mut out = Vec::new();
    for id in ids {
        let Some(r) = row(hub, id)? else { continue };
        let Ok(mime) = serde_json::from_value::<AttachmentMime>(serde_json::Value::String(r.mime))
        else {
            continue;
        };
        out.push(fleetd_contracts::chat::AttachmentRef {
            attachment_id: id.clone(),
            name: fleetd_contracts::prim::Line::new(r.name.as_str())
                .unwrap_or_else(|_| fleetd_contracts::prim::Line::unchecked("file")),
            mime,
            bytes: Count::unchecked(r.bytes),
        });
    }
    Ok(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn row(hub: &Hub, id: &AttachmentId) -> Result<Option<Row>, ToolError> {
    let n: i64 = id.as_str()[1..].parse().unwrap_or(0);
    Ok(hub.db.with(|c| {
        Ok(c.query_row(
            "SELECT sha256, name, mime, bytes, by FROM attachments WHERE n = ?1",
            [n],
            |r| {
                Ok(Row {
                    sha256: r.get(0)?,
                    name: r.get(1)?,
                    mime: r.get(2)?,
                    bytes: r.get(3)?,
                    by: r.get(4)?,
                })
            },
        )
        .optional()?)
    })?)
}

/// Checks every attachment exists and was uploaded with the caller's key, before anything is placed.
pub fn check(hub: &Hub, caller: &Caller, ids: &[AttachmentId]) -> Result<(), ToolError> {
    for id in ids {
        match row(hub, id)? {
            Some(r) if r.by == caller.key_id.as_str() => {}
            _ => {
                return Err(
                    ToolError::new(ErrorCode::NotFound, format!("No attachment {id}.")).with_fix(
                        "Upload it with attachment_put first; uploads expire after 24 h unused.",
                    ),
                );
            }
        }
    }
    Ok(())
}

/// An upload of the caller's, its bytes and type, for a tool that keeps its own copy of the file (a project's picture),
/// then forgets the upload: once nothing placed it, its row goes, and its file with the last row naming it.
pub async fn take(
    hub: &Hub,
    caller: &Caller,
    id: &AttachmentId,
) -> Result<(Vec<u8>, String), ToolError> {
    check(hub, caller, std::slice::from_ref(id))?;
    let Some(r) = row(hub, id)? else {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("No attachment {id}."),
        ));
    };
    let path = dir(hub).join(&r.sha256);
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
        .await
        .map_err(|_| crate::hub::api::internal_error())?
        .map_err(|_| {
            ToolError::new(
                ErrorCode::NotFound,
                format!("Attachment {id}'s file is gone."),
            )
            .with_fix("Upload it again with attachment_put.")
        })?;
    let n: i64 = id.as_str()[1..].parse().unwrap_or(0);
    hub.db.with(|c| {
        let gone = c.execute(
            "DELETE FROM attachments WHERE n = ?1 AND workstream_id IS NULL AND project IS NULL",
            [n],
        )?;
        let used = c
            .query_row(
                "SELECT 1 FROM attachments WHERE sha256 = ?1 LIMIT 1",
                [&r.sha256],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if gone > 0 && !used {
            let _ = std::fs::remove_file(dir(hub).join(&r.sha256));
        }
        Ok(())
    })?;
    Ok((bytes, r.mime))
}

/// Writes the attachments into the project under `.fleetd/attachments/<folder>/` (the order's id, or `chat`), marks
/// them as the project's, and returns the lines for the lead, one per
/// file. A file the machine could not take says so in its line instead of failing the order.
pub async fn deliver(
    hub: &Hub,
    caller: &Caller,
    ids: &[AttachmentId],
    project: &ProjectRef,
    folder: &str,
    workstream_id: Option<&WorkstreamId>,
) -> Result<Vec<String>, ToolError> {
    check(hub, caller, ids)?;
    place(hub, ids, project, folder, workstream_id).await
}

/// Marks the attachments as the project's, before they are placed: kept past the unused-upload cleanup, and readable
/// by anyone who reads the project.
pub fn claim(hub: &Hub, ids: &[AttachmentId], project: &ProjectRef) -> Result<(), ToolError> {
    let key = format!("{}/{}", project.machine_id, project.project_id);
    for id in ids {
        let n: i64 = id.as_str()[1..].parse().unwrap_or(0);
        hub.db.with(|c| {
            c.execute(
                "UPDATE attachments SET project = ?1 WHERE n = ?2",
                params![key, n],
            )?;
            Ok(())
        })?;
    }
    Ok(())
}

/// Whether attachment `id` is project `r`'s own (a file a person gave it, or an image its lead or tasks made with
/// `chat_image`); if so it is marked the project's, kept past the unused-upload cleanup and read by the app, as
/// [`show`] marks a message's.
pub fn claim_own(
    c: &rusqlite::Connection,
    r: &ProjectRef,
    id: &AttachmentId,
) -> rusqlite::Result<bool> {
    let key = format!("{}/{}", r.machine_id, r.project_id);
    let lead = crate::hub::link::lead_calls::lead_by(r);
    let n: i64 = id.as_str()[1..].parse().unwrap_or(0);
    let ours = c
        .query_row(
            "SELECT 1 FROM attachments WHERE n = ?1 AND (project = ?2 OR (project IS NULL AND by = ?3))",
            params![n, key, lead],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if ours {
        c.execute(
            "UPDATE attachments SET project = ?1 WHERE n = ?2 AND project IS NULL",
            params![key, n],
        )?;
    }
    Ok(ours)
}

/// A final lead message's parts, each `image` or `clip` block checked against project `r`: one whose attachment is
/// the project's (a file a person gave it, or an image its lead or tasks made with `chat_image`) stays and marks the
/// file the project's, so it is kept past the unused-upload cleanup and the app reads it; any other shows as its text.
pub fn show(
    c: &rusqlite::Connection,
    r: &ProjectRef,
    parts: Option<List<ChatPart, 1, CHAT_PARTS_MAX>>,
) -> rusqlite::Result<Option<List<ChatPart, 1, CHAT_PARTS_MAX>>> {
    let Some(parts) = parts else {
        return Ok(None);
    };
    let key = format!("{}/{}", r.machine_id, r.project_id);
    let lead = crate::hub::link::lead_calls::lead_by(r);
    let mut out = Vec::new();
    for mut part in parts {
        if let Some(BlockBody::Image(media) | BlockBody::Clip(media)) =
            part.block.as_ref().map(|b| &b.body)
        {
            let n: i64 = media.attachment_id.as_str()[1..].parse().unwrap_or(0);
            let ours = c
                .query_row(
                    "SELECT 1 FROM attachments a
                     LEFT JOIN workstreams w ON w.n = CAST(substr(a.workstream_id, 2) AS INTEGER)
                     WHERE a.n = ?1 AND (a.project = ?2 OR (a.project IS NULL AND a.by = ?3)
                       OR (w.machine_id = ?4 AND w.project_id = ?5))",
                    params![n, key, lead, r.machine_id.as_str(), r.project_id.as_str()],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if ours {
                c.execute(
                    "UPDATE attachments SET project = ?1 WHERE n = ?2 AND project IS NULL",
                    params![key, n],
                )?;
            } else {
                part.block = None;
            }
        }
        out.push(part);
    }
    // Back to one plain bubble when no block is left of one.
    if out.len() == 1 && out[0].block.is_none() {
        return Ok(None);
    }
    Ok(List::new(out).ok())
}

/// [`deliver`] for attachments already checked (a held chat message's, sent later).
pub async fn place(
    hub: &Hub,
    ids: &[AttachmentId],
    project: &ProjectRef,
    folder: &str,
    workstream_id: Option<&WorkstreamId>,
) -> Result<Vec<String>, ToolError> {
    let mut lines = Vec::new();
    let mut used = std::collections::HashSet::new();
    for id in ids {
        let Some(r) = row(hub, id)? else { continue };
        let mut name = r.name.clone();
        let mut k = 1;
        while !used.insert(name.clone()) {
            k += 1;
            name = format!("{k}-{}", r.name);
        }
        let rel = format!(".fleetd/attachments/{folder}/{name}");
        let path = dir(hub).join(&r.sha256);
        let data = tokio::fs::read(&path).await.map_err(|e| {
            tracing::error!(error = %e, "attachment file missing");
            crate::hub::api::internal_error()
        })?;
        let what = format!("{rel} ({}, {})", kind_of(&r.mime), size(r.bytes));
        lines.push(
            match hub
                .executors
                .put_file(project, &rel, B64.encode(&data))
                .await
            {
                Ok(()) => format!("  - {what}; open it with Read."),
                Err(e) => format!("  - {what}: not delivered ({e}); ask the human to resend it."),
            },
        );
        let n: i64 = id.as_str()[1..].parse().unwrap_or(0);
        hub.db.with(|c| {
            c.execute(
                "UPDATE attachments SET workstream_id = COALESCE(?1, workstream_id), project = ?2 WHERE n = ?3",
                params![
                    workstream_id.map(|w| w.as_str()),
                    format!("{}/{}", project.machine_id, project.project_id),
                    n
                ],
            )?;
            Ok(())
        })?;
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::api::{HubConfig, Listen};
    use crate::hub::store::HubDb;
    use crate::hub::store::test_clock::ManualClock;
    use fleetd_contracts::auth::KeyKind;
    use serde_json::json;

    fn caller(key: &str, human: bool, role: &str) -> Caller {
        let c = serde_json::from_value::<Caller>(json!({
            "keyId": key, "name": key, "prefix": "fld_abcdef", "createdAt": "2026-10-19T10:00:00.000Z",
            "grants": [{ "role": role, "machines": ["devbox"] }],
        }))
        .unwrap();
        Caller {
            kind: human.then_some(KeyKind::Human),
            ..c
        }
    }

    fn project(p: &str) -> ProjectRef {
        serde_json::from_value(json!({ "machineId": "devbox", "projectId": p })).unwrap()
    }

    /// An upload in pieces nobody finishes is deleted by the hub's own sweep an hour after its last piece, pieces
    /// file and all, and a pieces file left without its row goes too.
    #[tokio::test]
    async fn an_unfinished_upload_expires_on_the_hub() {
        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
        };
        let clock = ManualClock::at(1_792_000_000_000);
        let hub = crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone())
            .unwrap();
        let me = caller("k1", true, "operate");
        let piece = |upload: Option<&UploadId>, offset: i64| -> AttachmentPartInput {
            serde_json::from_value(
                json!({ "uploadId": upload, "offset": offset, "dataB64": B64.encode(b"part") }),
            )
            .unwrap()
        };
        let started = part(&hub, &me, piece(None, 0)).await.unwrap();
        let id = started.upload_id;
        let pieces = uploads_dir(&hub).join(id.as_str());
        let orphan = uploads_dir(&hub).join(format!("U{}", "0".repeat(32)));
        std::fs::write(&orphan, b"left by a stopped hub").unwrap();
        let fresh_orphan = uploads_dir(&hub).join(format!("U{}", "1".repeat(32)));
        std::fs::write(&fresh_orphan, b"a first piece being written").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&orphan)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 3600))
            .unwrap();

        clock.advance(std::time::Duration::from_secs(59 * 60));
        assert_eq!(sweep_uploads(&hub).unwrap(), 0);
        assert!(pieces.exists(), "still within its hour");
        assert!(
            !orphan.exists(),
            "no row for an hour: nothing can finish it"
        );
        assert!(
            fresh_orphan.exists(),
            "a file written just now may be a first piece before its row"
        );
        part(&hub, &me, piece(Some(&id), 4)).await.unwrap();

        clock.advance(std::time::Duration::from_secs(61 * 60));
        assert_eq!(sweep_uploads(&hub).unwrap(), 1);
        assert!(!pieces.exists());
        let gone = part(&hub, &me, piece(Some(&id), 8)).await.unwrap_err();
        assert_eq!(gone.message, format!("No upload {id}."));

        // A new upload has its row before its first piece is on disk; a pieces file short of its count is refused.
        let next = part(&hub, &me, piece(None, 0)).await.unwrap().upload_id;
        part(&hub, &me, piece(Some(&next), 4)).await.unwrap();
        std::fs::write(uploads_dir(&hub).join(next.as_str()), b"part").unwrap();
        let put_input: AttachmentPutInput = serde_json::from_value(json!({
            "name": "a.txt", "mime": "text/plain", "dataB64": B64.encode(b"end"), "uploadId": next,
        }))
        .unwrap();
        let short = put(&hub, &me, put_input).await.unwrap_err();
        assert_eq!(
            short.message,
            format!("Upload {next} lost pieces: 4 of its 8 bytes are here.")
        );
    }

    /// A chat shows an image its sender attached: the uploader reads it back, a reader of another project's file
    /// does not, and no key reads a machine it has no grant on.
    #[tokio::test]
    async fn attachment_get_reads_a_file_of_the_project_only() {
        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
        };
        let hub = crate::hub::serve::build_on(
            HubDb::open_memory().unwrap(),
            config,
            ManualClock::at(1_792_000_000_000),
        )
        .unwrap();
        let me = caller("k1", true, "operate");
        let put_input: AttachmentPutInput = serde_json::from_value(json!({
            "name": "shot.png", "mime": "image/png", "dataB64": B64.encode(b"png bytes"),
        }))
        .unwrap();
        let id = put(&hub, &me, put_input).await.unwrap().attachment_id;
        let get_input = |p: &str| AttachmentGetInput {
            project_ref: project(p),
            attachment_id: id.clone(),
        };
        let got = get(&hub, &me, get_input("app")).await.unwrap();
        assert_eq!(
            (
                got.name.as_str(),
                got.mime,
                got.bytes.get(),
                B64.decode(&got.data_b64).unwrap()
            ),
            ("shot.png", AttachmentMime::Png, 9, b"png bytes".to_vec())
        );
        // Another key, and the file belongs to no order of the project: not found.
        let other = caller("k2", true, "read");
        assert_eq!(
            get(&hub, &other, get_input("app")).await.unwrap_err().code,
            ErrorCode::NotFound
        );
        let elsewhere = AttachmentGetInput {
            project_ref: serde_json::from_value(
                json!({ "machineId": "laptop", "projectId": "app" }),
            )
            .unwrap(),
            attachment_id: id.clone(),
        };
        assert_eq!(
            get(&hub, &me, elsewhere).await.unwrap_err().code,
            ErrorCode::Forbidden
        );
    }

    #[test]
    fn names_cannot_leave_the_attachments_directory() {
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_name(".bashrc"), "bashrc");
        assert_eq!(safe_name("screenshot 1.png"), "screenshot 1.png");
        assert_eq!(safe_name("..."), "file");
    }
}
