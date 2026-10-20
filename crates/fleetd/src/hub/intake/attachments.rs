//! Files a person attaches to an order or a note. `attachment_put` stores the bytes under `<home>/attachments/<sha256>`
//! with a row; placing the order (or sending the note) writes them into the project's `.fleetd/attachments/<W>/` on
//! its machine and lists them in the lead's wake. Rows never used are deleted after 24 h.
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::mcp::{
    ATTACHMENT_MAX_BYTES, AttachmentGetInput, AttachmentGetOutput, AttachmentId, AttachmentMime,
    AttachmentPutInput, AttachmentPutOutput, ErrorCode,
};
use fleetd_contracts::prim::{Count, Text};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use crate::hub::api::{Caller, Hub, ToolError, allows_everywhere, is_human};
use crate::hub::store::now_ms;

/// Unreferenced uploads older than this are deleted.
const UNUSED_TTL_MS: i64 = 24 * 3600 * 1000;

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

pub async fn put(
    hub: &Hub,
    caller: &Caller,
    input: AttachmentPutInput,
) -> Result<AttachmentPutOutput, ToolError> {
    if !is_human(caller) && !allows_everywhere(caller, Role::Operate) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person's device or an operate key may attach files.",
        )
        .with_fix("Use the desktop app, or a key with operate on every machine."));
    }
    let bytes = B64
        .decode(input.data_b64.as_bytes())
        .map_err(|e| ToolError::new(ErrorCode::Invalid, format!("dataB64 is not base64: {e}.")))?;
    if bytes.len() > ATTACHMENT_MAX_BYTES {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "The file is {} bytes; attachments are at most 5 MiB.",
                bytes.len()
            ),
        )
        .with_fix("Attach a smaller file, or a link to it in the text."));
    }
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
    let name = safe_name(&input.name);
    let n: i64 = hub.db.with(|c| {
        // Unused uploads go here rather than on a timer: every upload checks.
        let stale: Vec<String> = {
            let mut stmt = c.prepare(
                "DELETE FROM attachments WHERE workstream_id IS NULL AND created_ms < ?1 RETURNING sha256",
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
            params![sha, name, mime_str(input.mime), len as i64, caller.key_id.as_str(), now],
        )?;
        Ok(c.last_insert_rowid())
    })?;
    Ok(AttachmentPutOutput {
        attachment_id: AttachmentId::unchecked(format!("F{n}")),
        bytes: Count::unchecked(len as i64),
        sha256: Text::unchecked(sha),
        next: Some("Pass attachmentId in intake_submit or order_note attachments.".into()),
        truncated: None,
    })
}

/// Whether attachment `n` was placed in an order of `project`.
fn in_project(hub: &Hub, n: i64, project: &ProjectRef) -> Result<bool, ToolError> {
    Ok(hub.db.with(|c| {
        Ok(c.query_row(
            "SELECT 1 FROM attachments a JOIN workstreams w ON w.n = CAST(substr(a.workstream_id, 2) AS INTEGER)
             WHERE a.n = ?1 AND w.machine_id = ?2 AND w.project_id = ?3",
            params![n, project.machine_id.as_str(), project.project_id.as_str()],
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

/// Writes the attachments into the project under `.fleetd/attachments/<W>/` and returns the wake's lines, one per
/// file. A file the machine could not take says so in its line instead of failing the order.
pub async fn deliver(
    hub: &Hub,
    caller: &Caller,
    ids: &[AttachmentId],
    project: &ProjectRef,
    workstream_id: &WorkstreamId,
) -> Result<Vec<String>, ToolError> {
    check(hub, caller, ids)?;
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
        let rel = format!(".fleetd/attachments/{workstream_id}/{name}");
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
                "UPDATE attachments SET workstream_id = ?1 WHERE n = ?2",
                params![workstream_id.as_str(), n],
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

    /// A chat shows an image its sender attached: the uploader reads it back, a reader of another project's file
    /// does not, and no key reads a machine it has no grant on.
    #[tokio::test]
    async fn attachment_get_reads_a_file_of_the_project_only() {
        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
            queue_ttl_sec: None,
            router_model: None,
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
