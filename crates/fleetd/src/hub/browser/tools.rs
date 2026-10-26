//! browser_sessions, browser_recording_get and browser_retention_set: the app's Sessions view and its replay. A
//! recording is read in pieces, as attachments are.
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::Role;
use fleetd_contracts::browser::RECORDING_PART_BYTES;
use fleetd_contracts::mcp::{
    BrowserRecordingGetInput, BrowserRecordingGetOutput, BrowserRetentionSetInput,
    BrowserRetentionSetOutput, BrowserSessionsInput, BrowserSessionsOutput, ErrorCode,
};
use fleetd_contracts::prim::{List, Text};

use super::{count, file_path, get, list, retention_on, set_retention};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, admin_everywhere_fix, allows_everywhere, require,
    unknown_project,
};

pub fn register(tools: &mut Registry) {
    tools.add("browser_sessions", browser_sessions);
    tools.add("browser_recording_get", browser_recording_get);
    tools.add("browser_retention_set", browser_retention_set);
}

async fn browser_sessions(
    hub: Arc<Hub>,
    caller: Caller,
    input: BrowserSessionsInput,
) -> Result<BrowserSessionsOutput, ToolError> {
    let r = input.project_ref;
    require(&caller, Role::Read, Some(&r.machine_id))?;
    if hub.store.project_get(&r)?.is_none() {
        return Err(unknown_project(&r));
    }
    let sessions = match &input.session_id {
        Some(id) => get(&hub.db, id)?
            .filter(|s| s.project_ref == r)
            .into_iter()
            .collect(),
        None => list(&hub.db, &r, input.limit.get() as usize)?,
    };
    let next = sessions
        .is_empty()
        .then(|| "No browser sessions yet: an agent opens one with session_start.".to_owned());
    Ok(BrowserSessionsOutput {
        sessions: List::unchecked(sessions),
        retention: hub.db.with(retention_on)?,
        next,
        truncated: None,
    })
}

async fn browser_recording_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: BrowserRecordingGetInput,
) -> Result<BrowserRecordingGetOutput, ToolError> {
    let id = &input.session_id;
    let not_found = || {
        ToolError::new(ErrorCode::NotFound, format!("No browser session {id}."))
            .with_fix("Call browser_sessions for the project's sessions.")
    };
    let session = get(&hub.db, id)?.ok_or_else(not_found)?;
    // Knowing an id gives nothing on a machine the key can't read.
    if require(&caller, Role::Read, Some(&session.project_ref.machine_id)).is_err() {
        return Err(not_found());
    }
    if !session.files.iter().any(|f| f.file == input.file) {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!(
                "Browser session {id} has no {} recording ({}).",
                input.file.as_str(),
                session.state.as_str()
            ),
        )
        .with_fix("browser_sessions lists the files each session has."));
    }
    let path = file_path(&hub, id, input.file);
    let offset = input.offset.get() as u64;
    let read = || -> std::io::Result<(Vec<u8>, u64)> {
        let mut file = std::fs::File::open(&path)?;
        let bytes = file.metadata()?.len();
        let mut data = Vec::new();
        if offset < bytes {
            file.seek(SeekFrom::Start(offset))?;
            file.take(RECORDING_PART_BYTES as u64)
                .read_to_end(&mut data)?;
        }
        Ok((data, bytes))
    };
    let (data, bytes) = read().map_err(|e| {
        tracing::warn!(session = %id, error = %e, "browser recording not read");
        ToolError::new(
            ErrorCode::Failed,
            format!("The hub could not read {id}'s recording."),
        )
    })?;
    let done = offset + data.len() as u64 >= bytes;
    Ok(BrowserRecordingGetOutput {
        session_id: id.clone(),
        file: input.file,
        mime: Text::unchecked(input.file.mime()),
        offset: input.offset,
        data_b64: B64.encode(&data),
        bytes: count(bytes),
        done,
        next: (!done).then(|| {
            format!(
                "Read the next piece from offset {}.",
                offset + data.len() as u64
            )
        }),
        truncated: None,
    })
}

async fn browser_retention_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: BrowserRetentionSetInput,
) -> Result<BrowserRetentionSetOutput, ToolError> {
    // Retention prunes every project's recordings, so Admin on one machine is not enough.
    if !allows_everywhere(&caller, Role::Admin) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Browser recording retention is fleet-wide: it needs Admin on every machine.",
        )
        .with_fix(admin_everywhere_fix(&caller)));
    }
    hub.db.transaction(|c| set_retention(c, &input.retention))?;
    Ok(BrowserRetentionSetOutput {
        retention: input.retention,
        next: Some("Recordings past it go at the next hourly prune.".into()),
        truncated: None,
    })
}
