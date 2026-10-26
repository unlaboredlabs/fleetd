//! browser_sessions, browser_recording_get, browser_control and browser_retention_set: the app's Sessions view, its
//! replay and its takeover. A recording is read in pieces, as attachments are.
use std::io::{Read, Seek, SeekFrom};
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::Role;
use fleetd_contracts::browser::{
    BrowserControl, BrowserControlFrame, BrowserControlTo, BrowserSessionState,
    RECORDING_PART_BYTES,
};
use fleetd_contracts::mcp::{
    BrowserControlInput, BrowserControlOutput, BrowserRecordingGetInput, BrowserRecordingGetOutput,
    BrowserRetentionSetInput, BrowserRetentionSetOutput, BrowserSessionsInput,
    BrowserSessionsOutput, ErrorCode,
};
use fleetd_contracts::node_link::{CAP_BROWSER, HubToNode};
use fleetd_contracts::prim::{List, Text};

use super::{count, file_path, get, list, retention_on, save, set_retention};
use crate::hub::api::{
    Caller, Hub, Registry, ToolError, admin_everywhere_fix, allows_everywhere, is_human, require,
    unknown_project,
};

pub fn register(tools: &mut Registry) {
    tools.add("browser_sessions", browser_sessions);
    tools.add("browser_recording_get", browser_recording_get);
    tools.add("browser_control", browser_control);
    tools.add("browser_retention_set", browser_retention_set);
}

/// "human:<device>", as the action log names a person's step.
pub fn person(caller: &Caller) -> String {
    format!("human:{}", caller.name)
}

async fn browser_control(
    hub: Arc<Hub>,
    caller: Caller,
    input: BrowserControlInput,
) -> Result<BrowserControlOutput, ToolError> {
    let id = &input.session_id;
    let not_found = || {
        ToolError::new(ErrorCode::NotFound, format!("No browser session {id}."))
            .with_fix("Call browser_sessions for the project's sessions.")
    };
    let mut session = get(&hub.db, id)?.ok_or_else(not_found)?;
    let machine = session.project_ref.machine_id.clone();
    if require(&caller, Role::Read, Some(&machine)).is_err() {
        return Err(not_found());
    }
    if !is_human(&caller) {
        return Err(ToolError::new(
            ErrorCode::Forbidden,
            "Only a person's device takes a browser over or hands it back.",
        )
        .with_fix("Use the desktop app."));
    }
    require(&caller, Role::Operate, Some(&machine))?;
    if session.state != BrowserSessionState::Live {
        return Err(ToolError::new(
            ErrorCode::Invalid,
            format!(
                "Browser session {id} is {}, not live.",
                session.state.as_str()
            ),
        ));
    }
    let next = match (input.control, session.control) {
        (BrowserControlTo::Human, _) => BrowserControl::Human,
        (BrowserControlTo::Agent, BrowserControl::Human) => BrowserControl::HandingBack,
        (BrowserControlTo::Agent, now) => now,
    };
    if next != session.control {
        if !hub.link.node_can(&machine, CAP_BROWSER) {
            return Err(ToolError::new(
                ErrorCode::MachineOffline,
                format!("{machine}'s node isn't connected, or is too old for takeover."),
            )
            .with_fix("Try again once the machine is online on the current fleetd."));
        }
        let frame = HubToNode::BrowserControl(BrowserControlFrame {
            session_id: id.clone(),
            control: input.control,
            by: Text::unchecked(person(&caller)),
        });
        if !hub.link.send_to(&machine, frame) {
            return Err(ToolError::new(
                ErrorCode::MachineOffline,
                format!("{machine}'s node isn't connected."),
            ));
        }
        session.control = next;
        if next == BrowserControl::Human {
            // The agent asked for a person, and one came: no longer waiting on you.
            session.takeover_reason = None;
        }
        save(&hub, &session)?;
    }
    Ok(BrowserControlOutput {
        session,
        next: Some(match next {
            BrowserControl::Human => {
                "You have control: send browser_input; hand it back with control agent.".into()
            }
            _ => "The agent drives again from its next command; it sees the page as you left it."
                .into(),
        }),
        truncated: None,
    })
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
