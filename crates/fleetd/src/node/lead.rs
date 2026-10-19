//! Lead-side CLI calls: the `fleetd` CLI writes one `lead_call` line to `<node home>/node.sock` and reads one
//! `lead_result` line back. The node forwards each call over whichever link is up under a node-chosen id, so two
//! CLIs picking the same id cannot cross answers, and relays the hub's answer under the CLI's id.
use std::collections::HashMap;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, watch};

use super::config::mkdir_private;
use super::runner::process::PeerSession;
use super::util::AbortOnDrop;
use super::wire::{
    ErrorCode, LeadCallFrame, LeadResultFrame, LeadSocketFrame, McpToolError, NodeToHub, Text,
    to_json,
};
use fleetd_contracts::ids::ThreadId;

pub fn lead_socket_path(home: &Path) -> PathBuf {
    home.join("node.sock")
}

pub const HUB_UNREACHABLE: &str =
    "fleetd hub unreachable; the node keeps retrying — try again shortly";
const LINK_WAIT: Duration = Duration::from_secs(5);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct RelayState {
    send: Option<mpsc::UnboundedSender<String>>,
    pending: HashMap<String, oneshot::Sender<LeadResultFrame>>,
    next_id: u64,
}

/// The node's half of lead-side calls: CLI frames in from the socket, out over whichever link is up.
#[derive(Clone)]
pub struct LeadRelay {
    state: Arc<Mutex<RelayState>>,
    linked: watch::Sender<bool>,
}

fn error_frame(id: &str, error: McpToolError) -> LeadResultFrame {
    LeadResultFrame {
        id: Text::unchecked(id),
        result: None,
        error: Some(error),
    }
}

fn unanswered(id: &str, why: &str) -> LeadResultFrame {
    let error = McpToolError::new(
        ErrorCode::MachineOffline,
        format!("{why}; the call may or may not have gone through"),
    );
    error_frame(id, error.with_fix("try again shortly"))
}

/// While held, calls go out through this link; dropping it fails the calls still waiting.
pub struct Attached {
    relay: LeadRelay,
}

impl Drop for Attached {
    fn drop(&mut self) {
        self.relay.linked.send_replace(false);
        let pending = {
            let mut state = self
                .relay
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.send = None;
            std::mem::take(&mut state.pending)
        };
        for (id, answer) in pending {
            let _ = answer.send(unanswered(
                &id,
                "the link to the fleetd hub dropped before it answered",
            ));
        }
    }
}

impl Default for LeadRelay {
    fn default() -> Self {
        Self::new()
    }
}

impl LeadRelay {
    pub fn new() -> Self {
        Self {
            state: Arc::default(),
            linked: watch::Sender::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RelayState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A welcomed link routes calls through `send` (serialized frames) until the guard drops.
    pub fn attach(&self, send: mpsc::UnboundedSender<String>) -> Attached {
        self.lock().send = Some(send);
        self.linked.send_replace(true);
        Attached {
            relay: self.clone(),
        }
    }

    /// A `lead_result` frame from the hub.
    pub fn resolve(&self, frame: LeadResultFrame) {
        if let Some(answer) = self.lock().pending.remove(frame.id.as_str()) {
            let _ = answer.send(frame);
        }
    }

    /// Forwards one CLI frame and returns the hub's answer under the CLI's id. Never fails: trouble is an error frame.
    pub async fn call(&self, mut frame: LeadCallFrame) -> LeadResultFrame {
        let cli_id = frame.id.clone();
        let mut linked = self.linked.subscribe();
        let up = tokio::time::timeout(LINK_WAIT, linked.wait_for(|up| *up))
            .await
            .is_ok_and(|r| r.is_ok());
        let (id, answer) = {
            let mut state = self.lock();
            let Some(send) = state.send.clone().filter(|_| up) else {
                drop(state);
                return error_frame(
                    &cli_id,
                    McpToolError::new(ErrorCode::MachineOffline, HUB_UNREACHABLE),
                );
            };
            state.next_id += 1;
            let id = format!("lc-{}", state.next_id);
            let (tx, rx) = oneshot::channel();
            state.pending.insert(id.clone(), tx);
            frame.id = Text::unchecked(id.clone());
            if send.send(to_json(&NodeToHub::LeadCall(frame))).is_err() {
                state.pending.remove(&id);
                drop(state);
                let mut dropped =
                    unanswered(&id, "the link to the fleetd hub dropped while sending");
                dropped.id = cli_id;
                return dropped;
            }
            (id, rx)
        };
        let mut result = match tokio::time::timeout(ANSWER_TIMEOUT, answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => unanswered(&id, "the link to the fleetd hub dropped before it answered"),
            Err(_) => unanswered(
                &id,
                &format!(
                    "the fleetd hub did not answer within {} s",
                    ANSWER_TIMEOUT.as_secs()
                ),
            ),
        };
        self.lock().pending.remove(&id);
        result.id = cli_id;
        result
    }
}

/// One CLI frame is a few KB at most; anything near this is not a CLI.
const MAX_FRAME_BYTES: usize = 256 * 1024;

fn bad_frame(message: &str) -> LeadResultFrame {
    error_frame(
        "invalid",
        McpToolError::new(ErrorCode::Invalid, super::util::head_utf16(message, 500)),
    )
}

fn decode_call(line: &str) -> Result<LeadCallFrame, String> {
    match serde_json::from_str::<LeadSocketFrame>(line).map_err(|e| e.to_string())? {
        LeadSocketFrame::LeadCall(frame) => Ok(frame),
        LeadSocketFrame::LeadResult(_) => Err("expected t: \"lead_call\"".into()),
    }
}

/// Which session a calling process runs in, from its pid (blocking).
pub type Identify = Arc<dyn Fn(i32) -> PeerSession + Send + Sync>;

/// Names the session a call comes from by where its process runs, never by what the frame claims: the hub tells a
/// lead from a task by it. A frame naming another session than its process runs in, or naming one from outside every
/// session, is refused; so is a call whose process can't be told.
pub fn attribute(
    mut frame: LeadCallFrame,
    peer: Option<PeerSession>,
) -> Result<LeadCallFrame, LeadResultFrame> {
    let refuse = |message: String, fix: &str| {
        Err(error_frame(
            frame.id.as_str(),
            McpToolError::new(ErrorCode::Forbidden, message).with_fix(fix),
        ))
    };
    let claimed = frame.thread_id.as_ref().map(|t| t.as_str().to_owned());
    match peer {
        None => refuse(
            "the node could not tell which process made this call".into(),
            "run fleetd from a normal shell on this machine",
        ),
        Some(PeerSession::Detached(session)) => refuse(
            format!(
                "this call comes from a process session {session} left running in the background"
            ),
            "make the call from the session itself, through its fleetd tools",
        ),
        Some(PeerSession::Session(session)) => {
            if claimed.as_ref().is_some_and(|c| *c != session) {
                return refuse(
                    format!(
                        "this call names session {} but runs in session {session}",
                        claimed.unwrap_or_default()
                    ),
                    "use your own fleetd tools; a session acts only as itself",
                );
            }
            frame.thread_id = Some(ThreadId::unchecked(session));
            Ok(frame)
        }
        Some(PeerSession::Outside) => match claimed {
            Some(c) => refuse(
                format!("this call names fleetd session {c} but does not run in it"),
                "unset FLEETD_THREAD_ID to act as yourself",
            ),
            None => Ok(frame),
        },
    }
}

/// Reads one line, answers it with one line, and closes. Half-open: a CLI that ends its side after writing still
/// gets the answer.
async fn serve_connection(mut conn: UnixStream, relay: LeadRelay, identify: Identify) {
    let pid = conn.peer_cred().ok().and_then(|c| c.pid());
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let line = loop {
        match conn.read(&mut chunk).await {
            Ok(0) | Err(_) => {
                let text = String::from_utf8_lossy(&buffer).into_owned();
                if text.trim().is_empty() {
                    return;
                }
                break text;
            }
            Ok(n) => {
                buffer.extend_from_slice(&chunk[..n]);
                if let Some(newline) = buffer.iter().position(|&b| b == b'\n') {
                    break String::from_utf8_lossy(&buffer[..newline]).into_owned();
                }
                if buffer.len() > MAX_FRAME_BYTES {
                    reply(
                        &mut conn,
                        &bad_frame(&format!("frame is larger than {MAX_FRAME_BYTES} bytes")),
                    )
                    .await;
                    return;
                }
            }
        }
    };
    let answer = match decode_call(&line) {
        Ok(frame) => {
            let peer = match pid {
                Some(pid) => tokio::task::spawn_blocking(move || identify(pid))
                    .await
                    .ok(),
                None => None,
            };
            match attribute(frame, peer) {
                Ok(frame) => relay.call(frame).await,
                Err(refused) => refused,
            }
        }
        Err(why) => bad_frame(&format!("not a lead_call frame: {why}")),
    };
    reply(&mut conn, &answer).await;
}

async fn reply(conn: &mut UnixStream, frame: &LeadResultFrame) {
    let line = format!(
        "{}\n",
        serde_json::to_string(&LeadSocketFrame::LeadResult(frame.clone())).unwrap_or_default()
    );
    let _ = conn.write_all(line.as_bytes()).await;
    let _ = conn.shutdown().await;
}

/// Removes a socket left by a node that died; refuses to take over one another node is still serving.
async fn clear_stale_socket(path: &Path) -> Result<(), String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    let shown = path.display();
    if !meta.file_type().is_socket() {
        return Err(format!(
            "{shown} exists and is not a socket; move it away and start the node again"
        ));
    }
    if UnixStream::connect(path).await.is_ok() {
        return Err(format!(
            "another fleetd node is already serving {shown}; stop it first"
        ));
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

/// Serves the lead socket until dropped, then removes it.
pub struct LeadSocket {
    path: PathBuf,
    _task: AbortOnDrop,
}

impl Drop for LeadSocket {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Serves lead-side CLI calls on a unix socket (mode 0600, in the node's 0700 home). Every process of the node's OS
/// user can call it; the node names the session a call's process runs in ([`attribute`]) and the hub decides which
/// project it belongs to.
pub async fn serve_lead_socket(
    path: PathBuf,
    relay: LeadRelay,
    identify: Identify,
) -> Result<LeadSocket, String> {
    let parent = path.parent().unwrap_or(Path::new("/"));
    mkdir_private(parent).map_err(|_| format!("cannot create {}", parent.display()))?;
    clear_stale_socket(&path).await?;
    let listener = UnixListener::bind(&path)
        .map_err(|e| format!("cannot listen on {}: {e}", path.display()))?;
    let serving = LeadSocket {
        path: path.clone(),
        _task: AbortOnDrop(tokio::spawn(async move {
            // Connections end with the socket: their calls are cut off when the node stops.
            let mut connections = tokio::task::JoinSet::new();
            while let Ok((conn, _)) = listener.accept().await {
                while connections.try_join_next().is_some() {}
                connections.spawn(serve_connection(conn, relay.clone(), identify.clone()));
            }
        })),
    };
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| format!("cannot restrict {} to mode 0600", path.display()))?;
    tracing::info!(socket_path = %path.display(), "lead socket listening");
    Ok(serving)
}

#[cfg(test)]
mod attribution_tests {
    use super::*;

    fn frame(thread: Option<&str>) -> LeadCallFrame {
        let mut value = serde_json::json!({
            "id": "cli-1", "cwd": "/w", "call": { "op": "task_list" },
        });
        if let Some(t) = thread {
            value["threadId"] = t.into();
        }
        serde_json::from_value(value).unwrap()
    }

    fn named(r: Result<LeadCallFrame, LeadResultFrame>) -> Result<Option<String>, String> {
        r.map(|f| f.thread_id.map(|t| t.as_str().to_owned()))
            .map_err(|e| e.error.unwrap().message)
    }

    #[test]
    fn the_session_comes_from_the_process_never_from_the_frame() {
        let task = || Some(PeerSession::Session("task-1".into()));
        // A task's process is the task whether it names itself or nothing (FLEETD_THREAD_ID unset).
        assert_eq!(
            named(attribute(frame(None), task())),
            Ok(Some("task-1".into()))
        );
        assert_eq!(
            named(attribute(frame(Some("task-1")), task())),
            Ok(Some("task-1".into()))
        );
        // Naming the lead's session from a task's process is refused.
        let forged = named(attribute(frame(Some("lead-1")), task())).unwrap_err();
        assert!(
            forged.contains("names session lead-1 but runs in session task-1"),
            "{forged}"
        );
        // A person's shell names nothing; naming a session from outside it, a detached child or an unknown process
        // is refused.
        assert_eq!(
            named(attribute(frame(None), Some(PeerSession::Outside))),
            Ok(None)
        );
        assert!(named(attribute(frame(Some("lead-1")), Some(PeerSession::Outside))).is_err());
        assert!(
            named(attribute(
                frame(None),
                Some(PeerSession::Detached("task-1".into()))
            ))
            .is_err()
        );
        assert!(named(attribute(frame(None), None)).is_err());
    }
}
