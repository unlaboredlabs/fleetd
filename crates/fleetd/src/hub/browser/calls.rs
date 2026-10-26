//! `browser_session` and `browser_recording_part`: the node reports a session of one of its agents and uploads its
//! recording, as calls in that session's name, so the hub files them under the session's project and task. The node
//! never lets a process in the session send them itself (node/lead.rs).
use std::io::Write;
use std::sync::{Arc, Weak};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::browser::{
    BrowserRecordingPartCall, BrowserRecordingPartResult, BrowserSession, BrowserSessionCall,
    BrowserSessionResult, BrowserSessionState, RECORDING_PART_BYTES,
};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};

use super::{announce, count, dir, file_path, get, put_on, stored_bytes};
use crate::hub::api::Hub;
use crate::hub::link::lead_calls::{CallerAgent, LeadCallFuture, op_of};
use crate::hub::link::{LeadCaller, LeadCalls};
use crate::hub::store::{StoreError, now_ms, parse_ms};

pub const OPS: [&str; 2] = ["browser_session", "browser_recording_part"];

pub fn register_lead_calls(hub: &Arc<Hub>) {
    let weak: Weak<Hub> = Arc::downgrade(hub);
    let handler = Arc::new(
        move |caller: LeadCaller, call: LeadCall| -> LeadCallFuture {
            let hub = weak.upgrade();
            Box::pin(async move {
                let hub = hub.ok_or_else(|| {
                    McpToolError::new(ErrorCode::Invalid, "The hub is shutting down.")
                })?;
                answer(&hub, &caller, call)
            })
        },
    );
    let calls: &LeadCalls = &hub.lead_calls;
    for op in OPS {
        calls.register(op, handler.clone());
    }
}

fn failed(e: StoreError) -> McpToolError {
    tracing::error!(error = %e, "browser store");
    McpToolError::new(ErrorCode::Failed, "The hub failed to answer that request.")
}

fn invalid(message: impl Into<String>) -> McpToolError {
    McpToolError::new(ErrorCode::Invalid, message)
}

fn answer(hub: &Hub, caller: &LeadCaller, call: LeadCall) -> Result<LeadCallResult, McpToolError> {
    if caller.agent == CallerAgent::Person {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            "A browser session belongs to an agent's session, and this call comes from none.",
        ));
    }
    match call {
        LeadCall::BrowserSession(call) => session(hub, caller, call),
        LeadCall::BrowserRecordingPart(call) => part(hub, caller, call),
        other => Err(invalid(format!("{} is not a browser call.", op_of(&other)))),
    }
}

/// The stored session, refused when it is another project's.
fn own(
    hub: &Hub,
    caller: &LeadCaller,
    call_id: &str,
) -> Result<Option<BrowserSession>, McpToolError> {
    let id = fleetd_contracts::browser::BrowserSessionId::unchecked(call_id);
    let stored = get(&hub.db, &id).map_err(failed)?;
    if stored
        .as_ref()
        .is_some_and(|s| s.project_ref != caller.project_ref)
    {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            format!("Browser session {call_id} is another project's."),
        ));
    }
    Ok(stored)
}

fn session(
    hub: &Hub,
    caller: &LeadCaller,
    call: BrowserSessionCall,
) -> Result<LeadCallResult, McpToolError> {
    let stored = own(hub, caller, call.session_id.as_str())?;
    if let Some(s) = &stored
        && matches!(
            s.state,
            BrowserSessionState::Recorded | BrowserSessionState::Expired
        )
    {
        // Final: a late or repeated report changes nothing.
        return Ok(LeadCallResult::BrowserSession(BrowserSessionResult {
            session_id: s.session_id.clone(),
            state: s.state,
        }));
    }
    if call.state == BrowserSessionState::Expired {
        return Err(invalid("Only the hub expires a recording."));
    }
    if call.state == BrowserSessionState::Recorded {
        for entry in call.files.iter() {
            let held = stored_bytes(hub, &call.session_id, entry.file);
            if held != entry.bytes.get() as u64 {
                return Err(invalid(format!(
                    "The hub holds {held} bytes of {}'s {}, not {}.",
                    call.session_id,
                    entry.file.as_str(),
                    entry.bytes
                ))
                .with_fix("upload the file again from offset 0"));
            }
        }
    }
    let started_ms = parse_ms(call.started_at.as_str())
        .ok_or_else(|| invalid("startedAt is not an ISO time."))?;
    let task_id = match &caller.agent {
        CallerAgent::Task(t) => Some(t.clone()),
        _ => None,
    };
    let next = BrowserSession {
        session_id: call.session_id.clone(),
        project_ref: caller.project_ref.clone(),
        kind: call.kind,
        thread_id: call.thread_id,
        task_id,
        purpose: call.purpose,
        state: call.state,
        control: call.control,
        started_at: call.started_at,
        ended_at: call.ended_at,
        files: call.files,
        takeover_reason: stored.as_ref().and_then(|s| s.takeover_reason.clone()),
        credentials_filled: call.credentials_filled,
        note: call.note,
    };
    if next.state == BrowserSessionState::Lost {
        // What arrived of a recording that can't be finished is no use to anyone.
        let _ = std::fs::remove_dir_all(dir(hub, &next.session_id));
    }
    let changed = stored.as_ref().is_none_or(|s| {
        s.state != next.state
            || s.control != next.control
            || s.credentials_filled != next.credentials_filled
    });
    hub.db
        .transaction(|c| put_on(c, &next, started_ms))
        .map_err(failed)?;
    if changed {
        announce(hub, &next, now_ms(hub.clock.as_ref())).map_err(failed)?;
    }
    Ok(LeadCallResult::BrowserSession(BrowserSessionResult {
        session_id: next.session_id,
        state: next.state,
    }))
}

fn part(
    hub: &Hub,
    caller: &LeadCaller,
    call: BrowserRecordingPartCall,
) -> Result<LeadCallResult, McpToolError> {
    let id = call.session_id.as_str();
    let Some(stored) = own(hub, caller, id)? else {
        return Err(
            McpToolError::new(ErrorCode::NotFound, format!("No browser session {id}."))
                .with_fix("report the session with browser_session first"),
        );
    };
    if !matches!(
        stored.state,
        BrowserSessionState::Live | BrowserSessionState::Uploading
    ) {
        return Err(invalid(format!(
            "Browser session {id} is {}: its recording takes no more pieces.",
            stored.state.as_str()
        )));
    }
    let data = B64
        .decode(call.data_b64.as_str())
        .map_err(|e| invalid(format!("dataB64 is not base64: {e}.")))?;
    if data.len() > RECORDING_PART_BYTES {
        return Err(invalid(format!(
            "A piece is at most {RECORDING_PART_BYTES} bytes; this one is {}.",
            data.len()
        )));
    }
    let held = stored_bytes(hub, &call.session_id, call.file);
    let offset = call.offset.get() as u64;
    if offset > held {
        return Err(invalid(format!(
            "The hub holds {held} bytes of {id}'s {}; a piece at {offset} would leave a gap.",
            call.file.as_str()
        ))
        .with_fix(format!("send the piece at offset {held}")));
    }
    let write = || -> std::io::Result<u64> {
        std::fs::create_dir_all(dir(hub, &call.session_id))?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(file_path(hub, &call.session_id, call.file))?;
        // A piece sent again after a lost answer replaces what it wrote the first time.
        file.set_len(offset)?;
        file.write_all(&data)?;
        file.sync_data()?;
        Ok(offset + data.len() as u64)
    };
    let bytes = write().map_err(|e| {
        tracing::error!(session = id, error = %e, "browser recording not written");
        McpToolError::new(ErrorCode::Failed, "The hub could not write that piece.")
            .with_fix("try again shortly")
    })?;
    Ok(LeadCallResult::BrowserRecordingPart(
        BrowserRecordingPartResult {
            session_id: call.session_id,
            file: call.file,
            bytes: count(bytes),
        },
    ))
}
