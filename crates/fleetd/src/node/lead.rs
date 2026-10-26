//! Lead-side CLI calls: the `fleetd` CLI writes one `lead_call` line to `<node home>/node.sock` and reads one
//! `lead_result` line back. The node forwards each call over whichever link is up under a node-chosen id, so two
//! CLIs picking the same id cannot cross answers, and relays the hub's answer under the CLI's id. A call from a
//! session (its `report`, `ask_lead`, any agent tool) leaves the machine with its project's and order's secrets
//! masked, as what the session reports does (mask.rs).
use std::collections::HashMap;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot, watch};

use super::browser::BrowserHandler;
use super::config::mkdir_private;
use super::mask::Masker;
use super::runner::process::PeerSession;
use super::util::AbortOnDrop;
use super::wire::{
    ErrorCode, LeadCallFrame, LeadResultFrame, LeadSocketFrame, McpToolError, NodeToHub, Text,
    to_json,
};
use fleetd_contracts::browser::{BrowserCallFrame, BrowserResultFrame};
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
/// A browser-mcp frame carries a driver result's text (a page snapshot) to be scrubbed.
const MAX_BROWSER_FRAME_BYTES: usize = 8 << 20;

/// Lead calls only the node makes, for a session's browser (node/browser): a process in a session can't send them.
const NODE_OPS: &[&str] = &["browser_session", "browser_recording_part"];

fn bad_frame(message: &str) -> LeadResultFrame {
    error_frame(
        "invalid",
        McpToolError::new(ErrorCode::Invalid, super::util::head_utf16(message, 500)),
    )
}

enum Incoming {
    Lead(LeadCallFrame),
    Browser(BrowserCallFrame),
}

fn decode_call(line: &str) -> Result<Incoming, String> {
    match serde_json::from_str::<LeadSocketFrame>(line).map_err(|e| e.to_string())? {
        LeadSocketFrame::LeadCall(frame) if line.len() > MAX_FRAME_BYTES => Err(format!(
            "frame is larger than {MAX_FRAME_BYTES} bytes ({} for lead_call {})",
            line.len(),
            frame.id
        )),
        LeadSocketFrame::LeadCall(frame) => Ok(Incoming::Lead(frame)),
        LeadSocketFrame::BrowserCall(frame) => Ok(Incoming::Browser(frame)),
        LeadSocketFrame::LeadResult(_) | LeadSocketFrame::BrowserResult(_) => {
            Err("expected t: \"lead_call\" or \"browser_call\"".into())
        }
    }
}

/// Which session a calling process runs in, from its pid (blocking).
pub type Identify = Arc<dyn Fn(i32) -> PeerSession + Send + Sync>;

/// The masker for a session's calls, by its id (blocking: it reads the secrets); `Err` is why there is none.
pub type MaskFor = Arc<dyn Fn(&str) -> Result<Masker, String> + Send + Sync>;

/// The call with every secret of its session masked; refused when masking broke its shape (a length limit), so the
/// value never goes out.
pub fn mask_call(
    mut frame: LeadCallFrame,
    masker: &Masker,
) -> Result<LeadCallFrame, Box<LeadResultFrame>> {
    match masker.serde(frame.call) {
        Some(call) => {
            frame.call = call;
            Ok(frame)
        }
        None => Err(Box::new(error_frame(
            frame.id.as_str(),
            McpToolError::new(
                ErrorCode::Invalid,
                "this call holds a secret value, and masking it left the call too long to send",
            )
            .with_fix("send it again without the value: name the variable instead"),
        ))),
    }
}

/// Names the session a call comes from by where its process runs, never by what the frame claims: the hub tells a
/// lead from a task by it. A frame naming another session than its process runs in, or naming one from outside every
/// session, is refused; so is a call whose process can't be told.
pub fn attribute(
    mut frame: LeadCallFrame,
    peer: Option<PeerSession>,
) -> Result<LeadCallFrame, Box<LeadResultFrame>> {
    let refuse = |message: String, fix: &str| {
        Err(Box::new(error_frame(
            frame.id.as_str(),
            McpToolError::new(ErrorCode::Forbidden, message).with_fix(fix),
        )))
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
async fn serve_connection(
    mut conn: UnixStream,
    relay: LeadRelay,
    identify: Identify,
    mask_for: MaskFor,
    browser: Option<BrowserHandler>,
) {
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
                if buffer.len() > MAX_BROWSER_FRAME_BYTES {
                    reply(
                        &mut conn,
                        &bad_frame(&format!(
                            "frame is larger than {MAX_BROWSER_FRAME_BYTES} bytes"
                        )),
                    )
                    .await;
                    return;
                }
            }
        }
    };
    let frame = match decode_call(&line) {
        Ok(Incoming::Lead(frame)) => frame,
        Ok(Incoming::Browser(frame)) => {
            let answer = browser_call(frame, pid, identify, browser).await;
            let line = format!(
                "{}\n",
                serde_json::to_string(&LeadSocketFrame::BrowserResult(answer)).unwrap_or_default()
            );
            let _ = conn.write_all(line.as_bytes()).await;
            let _ = conn.shutdown().await;
            return;
        }
        Err(why) => {
            reply(
                &mut conn,
                &bad_frame(&format!("not a lead_call frame: {why}")),
            )
            .await;
            return;
        }
    };
    let op = fleetd_contracts::lead_calls::op_name(&frame.call);
    if NODE_OPS.contains(&op.as_str()) {
        let refused = error_frame(
            frame.id.as_str(),
            McpToolError::new(
                ErrorCode::Forbidden,
                format!("{op} is the node's own call for a browser session"),
            )
            .with_fix("use session_start and session_end; the node reports the session itself"),
        );
        reply(&mut conn, &refused).await;
        return;
    }
    let answer = {
        {
            let peer = match pid {
                Some(pid) => tokio::task::spawn_blocking(move || identify(pid))
                    .await
                    .ok(),
                None => None,
            };
            match attribute(frame, peer) {
                Ok(frame) => match frame.thread_id.as_ref().map(|t| t.to_string()) {
                    Some(session) => {
                        // No masker, no call: a session's call goes out masked or not at all.
                        let masker = tokio::task::spawn_blocking(move || mask_for(&session))
                            .await
                            .unwrap_or_else(|_| Err("reading them failed".to_owned()));
                        match masker {
                            Ok(masker) => match mask_call(frame, &masker) {
                                Ok(frame) => relay.call(frame).await,
                                Err(refused) => *refused,
                            },
                            Err(why) => error_frame(
                                frame.id.as_str(),
                                McpToolError::new(
                                    ErrorCode::Failed,
                                    format!(
                                        "the node could not read the session's secrets to mask this call ({why}), so it was not sent"
                                    ),
                                )
                                .with_fix("try again; if it keeps failing, check the node's log and restart it"),
                            ),
                        }
                    }
                    None => relay.call(frame).await,
                },
                Err(refused) => *refused,
            }
        }
    };
    reply(&mut conn, &answer).await;
}

/// A browser-mcp call, answered by the node's broker for the session its process runs in.
async fn browser_call(
    frame: BrowserCallFrame,
    pid: Option<i32>,
    identify: Identify,
    browser: Option<BrowserHandler>,
) -> BrowserResultFrame {
    let refuse = |error: McpToolError| -> BrowserResultFrame {
        serde_json::from_value(serde_json::json!({ "id": frame.id, "error": error }))
            .expect("an error frame")
    };
    let Some(browser) = browser else {
        return refuse(
            McpToolError::new(ErrorCode::Invalid, "this machine runs no browser sessions")
                .with_fix("do without a browser and say so in your result"),
        );
    };
    let peer = match pid {
        Some(pid) => tokio::task::spawn_blocking(move || identify(pid))
            .await
            .ok(),
        None => None,
    };
    match peer {
        Some(PeerSession::Session(session))
            if frame
                .thread_id
                .as_ref()
                .is_none_or(|t| t.as_str() == session) =>
        {
            browser(session, frame).await
        }
        _ => refuse(
            McpToolError::new(
                ErrorCode::Forbidden,
                "a browser session belongs to an agent's session, and this call comes from none",
            )
            .with_fix("use the browser tools of a fleetd agent"),
        ),
    }
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
    mask_for: MaskFor,
    browser: Option<BrowserHandler>,
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
                connections.spawn(serve_connection(
                    conn,
                    relay.clone(),
                    identify.clone(),
                    mask_for.clone(),
                    browser.clone(),
                ));
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

    fn named(r: Result<LeadCallFrame, Box<LeadResultFrame>>) -> Result<Option<String>, String> {
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
