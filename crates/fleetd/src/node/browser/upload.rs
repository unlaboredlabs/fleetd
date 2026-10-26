//! Reporting sessions to the hub and uploading their recordings, as lead calls in the agent session's name over the
//! node's link. A recording stays on the node until the hub holds all of it; one the node can't send (the hub is away,
//! the node restarted) goes at the next try, and one that never makes it in [`GIVE_UP`] is reported lost.
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::browser::{
    BrowserControl, BrowserRecordingEntry, BrowserRecordingPartCall, BrowserSessionCall,
    BrowserSessionId, BrowserSessionState, RECORDING_PART_BYTES, RecordingFile,
};
use fleetd_contracts::ids::{ThreadId, Timestamp};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallFrame, LeadCallResult};
use fleetd_contracts::mcp::McpToolError;
use fleetd_contracts::prim::{Count, Line, List, NonEmpty, Text};
use fleetd_contracts::tasks::AbsolutePath;

use super::record::{Meta, read_meta, write_meta};
use crate::node::lead::LeadRelay;

/// A recording the hub hasn't taken in this long is given up.
pub const GIVE_UP: Duration = Duration::from_secs(7 * 24 * 3600);

pub type HubFuture = Pin<Box<dyn Future<Output = Result<LeadCallResult, McpToolError>> + Send>>;

/// How the broker reaches the hub: a lead call made in an agent session's name, from its working directory.
pub trait HubCalls: Send + Sync + 'static {
    fn call(&self, thread: &str, cwd: &str, call: LeadCall) -> HubFuture;
}

/// Through the node's link, as the session's own fleetd tools are.
pub struct RelayHub(pub LeadRelay);

impl HubCalls for RelayHub {
    fn call(&self, thread: &str, cwd: &str, call: LeadCall) -> HubFuture {
        let relay = self.0.clone();
        let frame = LeadCallFrame {
            id: NonEmpty::unchecked("browser"),
            cwd: AbsolutePath::unchecked(cwd),
            call,
            thread_id: Some(ThreadId::unchecked(thread)),
        };
        Box::pin(async move {
            let answer = relay.call(frame).await;
            match (answer.result, answer.error) {
                (Some(result), _) => Ok(result),
                (None, Some(error)) => Err(error),
                (None, None) => unreachable!("a result frame has a result or an error"),
            }
        })
    }
}

/// Where the node keeps recordings until the hub has them.
pub fn recordings_dir(home: &Path) -> PathBuf {
    home.join("browser").join("recordings")
}

fn clip<const N: usize>(s: &str) -> Text<0, N> {
    Text::unchecked(s.chars().take(N).collect::<String>())
}

/// The session as the hub should have it now.
pub fn report(
    meta: &Meta,
    state: BrowserSessionState,
    control: BrowserControl,
    files: &[(RecordingFile, u64)],
) -> LeadCall {
    LeadCall::BrowserSession(BrowserSessionCall {
        session_id: BrowserSessionId::unchecked(&meta.session_id),
        kind: meta.kind,
        thread_id: ThreadId::unchecked(&meta.thread_id),
        purpose: Line::unchecked(meta.purpose.chars().take(200).collect::<String>()),
        state,
        control,
        started_at: Timestamp(meta.started_at.clone()),
        ended_at: meta.ended_at.clone().map(Timestamp),
        files: List::unchecked(
            files
                .iter()
                .map(|(file, bytes)| BrowserRecordingEntry {
                    file: *file,
                    bytes: Count::unchecked(*bytes as i64),
                })
                .collect(),
        ),
        credentials_filled: Count::unchecked(meta.credentials_filled as i64),
        note: meta.note.as_deref().map(clip::<500>),
    })
}

/// Sends one file in pieces from offset 0.
async fn send_file(
    hub: &dyn HubCalls,
    meta: &Meta,
    dir: &Path,
    file: RecordingFile,
) -> Result<u64, String> {
    let bytes = tokio::fs::read(dir.join(file.file_name()))
        .await
        .map_err(|e| format!("cannot read {}: {e}", file.file_name()))?;
    let mut offset = 0usize;
    for piece in bytes.chunks(RECORDING_PART_BYTES) {
        let call = LeadCall::BrowserRecordingPart(BrowserRecordingPartCall {
            session_id: BrowserSessionId::unchecked(&meta.session_id),
            file,
            offset: Count::unchecked(offset as i64),
            data_b64: NonEmpty::unchecked(B64.encode(piece)),
        });
        match hub.call(&meta.thread_id, &meta.cwd, call).await {
            Ok(LeadCallResult::BrowserRecordingPart(r))
                if r.bytes.get() as usize == offset + piece.len() => {}
            Ok(other) => return Err(format!("the hub answered a piece with {other:?}")),
            Err(e) => return Err(e.message.to_string()),
        }
        offset += piece.len();
    }
    Ok(bytes.len() as u64)
}

/// Uploads an ended session's recording and reports it recorded, then deletes it from the node.
pub async fn upload(hub: &dyn HubCalls, dir: &Path) -> Result<(), String> {
    let Some(meta) = read_meta(dir) else {
        return Err(format!("{} has no readable session file", dir.display()));
    };
    let files = super::session::files(dir);
    let call = report(
        &meta,
        BrowserSessionState::Uploading,
        BrowserControl::Agent,
        &[],
    );
    hub.call(&meta.thread_id, &meta.cwd, call)
        .await
        .map_err(|e| e.message.to_string())?;
    let mut sent = Vec::new();
    for (file, _) in &files {
        sent.push((*file, send_file(hub, &meta, dir, *file).await?));
    }
    let call = report(
        &meta,
        BrowserSessionState::Recorded,
        BrowserControl::Agent,
        &sent,
    );
    hub.call(&meta.thread_id, &meta.cwd, call)
        .await
        .map_err(|e| e.message.to_string())?;
    let _ = std::fs::remove_dir_all(dir);
    Ok(())
}

/// Reports a recording that will never reach the hub, and deletes it.
pub async fn give_up(hub: &dyn HubCalls, dir: &Path, why: &str) {
    if let Some(mut meta) = read_meta(dir) {
        meta.note = Some(why.to_owned());
        let call = report(&meta, BrowserSessionState::Lost, BrowserControl::Agent, &[]);
        if hub.call(&meta.thread_id, &meta.cwd, call).await.is_err() {
            return;
        }
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// The recordings waiting to go, but `live` ones. One a node stopped during is ended now, with a note.
pub fn waiting(home: &Path, live: &[String]) -> Vec<PathBuf> {
    waiting_in(&recordings_dir(home), live)
}

/// [`waiting`], for the recordings in `root`.
pub fn waiting_in(root: &Path, live: &[String]) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for dir in entries.filter_map(Result::ok).map(|e| e.path()) {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if live.contains(&name) {
            continue;
        }
        match read_meta(&dir) {
            Some(meta) if meta.ended_at.is_none() => {
                let meta = Meta {
                    ended_at: Some(crate::node::util::now_iso()),
                    note: Some(
                        "the node stopped during this session; its video may end early".into(),
                    ),
                    ..meta
                };
                if write_meta(&dir, &meta).is_ok() {
                    out.push(dir);
                }
            }
            Some(_) => out.push(dir),
            // A directory without its session file is a start that never got going.
            None => {
                let _ = std::fs::remove_dir_all(&dir);
            }
        }
    }
    out
}

/// How old a waiting recording is, by its session file.
pub fn age(dir: &Path) -> Duration {
    std::fs::metadata(dir.join(super::record::META))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .unwrap_or_default()
}
