//! The app WebSocket at /app: `auth` with a key, then `snapshot` for the
//! fleetd_status data, `events` to stream HubEvents after a cursor as they happen, `call` to run any MCP tool
//! with the session's key, through the same registry, grants and limits as /mcp, and `live` for ephemeral lane
//! frames (see `live`).
pub mod live;

use crate::hub::api::{CallError, Caller, Hub, Registry, ToolError};
use crate::hub::auth::AuthError;
use crate::hub::mcp::invalid_input;
use crate::hub::store::now_ms;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use fleetd_contracts::app::AppClientMessage;
use fleetd_contracts::auth::Role;
use fleetd_contracts::hello::PROTOCOL_VERSION;
use fleetd_contracts::mcp::ErrorCode;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::JoinSet;

/// Close code for a connection whose key was refused.
pub const CLOSE_UNAUTHORIZED: u16 = 4401;
/// Calls one connection may have running at once; more are refused rather than queued without bound.
pub const MAX_CALLS_IN_FLIGHT: usize = 32;
/// "Going away": the hub is shutting down.
const CLOSE_GOING_AWAY: u16 = 1001;

fn error_frame(error: &ToolError, id: Option<&str>) -> Value {
    let mut frame = json!({ "t": "error" });
    if let Some(id) = id {
        frame["id"] = json!(id);
    }
    frame["code"] = serde_json::to_value(error.code).expect("serializable code");
    frame["message"] = json!(error.message);
    if let Some(fix) = &error.fix {
        frame["fix"] = json!(fix);
    }
    frame
}

fn refused(error: AuthError) -> ToolError {
    match error {
        AuthError::Unauthorized(u) => ToolError {
            code: u.code,
            message: u.message,
            fix: u.fix,
        },
        other => {
            tracing::error!(error = %other, "key check failed");
            crate::hub::api::internal_error()
        }
    }
}

/// One tool call, checked like an MCP request: the key is verified again (so a revoked key stops at its next call),
/// the input decoded against the tool's schema, and the handler applies grants and limits.
async fn call(
    hub: &Arc<Hub>,
    tools: &Registry,
    key: &str,
    tool: &str,
    input: Value,
) -> Result<Value, ToolError> {
    let caller = hub.auth.verify(key).map_err(refused)?;
    match tools.call(hub, &caller, tool, input).await {
        Ok(output) => Ok(output),
        Err(CallError::UnknownTool) => Err(ToolError::new(
            ErrorCode::NotFound,
            format!("No tool {tool}."),
        )
        .with_fix("Use a tool name from the hub's MCP tool list.")),
        Err(CallError::Invalid(detail)) => Err(invalid_input(
            tool,
            &detail,
            "Check the input against the tool's input schema.",
        )),
        Err(CallError::Tool(error)) => Err(error),
    }
}

/// Streams events after `from` until the socket ends or a newer `events` replaces it.
async fn stream_events(
    hub: Arc<Hub>,
    tools: Arc<Registry>,
    caller: Caller,
    from: i64,
    out: mpsc::UnboundedSender<Value>,
) {
    let mut cursor = from;
    loop {
        match tools
            .call(
                &hub,
                &caller,
                "events_wait",
                json!({ "cursor": cursor, "timeoutSec": 50 }),
            )
            .await
        {
            Ok(page) => {
                if let Some(events) = page["events"].as_array() {
                    for event in events {
                        let mut frame = json!({ "t": "event" });
                        if let (Value::Object(frame), Value::Object(event)) = (&mut frame, event) {
                            frame.extend(event.clone());
                        }
                        if out.send(frame).is_err() {
                            return;
                        }
                    }
                }
                cursor = page["cursor"].as_i64().unwrap_or(cursor);
            }
            Err(CallError::Tool(error)) => {
                let _ = out.send(error_frame(&error, None));
                return;
            }
            Err(other) => {
                tracing::error!(?other, "app event stream failed");
                return;
            }
        }
    }
}

struct Session {
    hub: Arc<Hub>,
    tools: Arc<Registry>,
    out: mpsc::UnboundedSender<Value>,
    caller: Option<(String, Caller)>,
    stream: Option<tokio::task::JoinHandle<()>>,
    calls: JoinSet<()>,
    /// The live subscription's pump, and the one-frame slot it writes to.
    live: Option<tokio::task::JoinHandle<()>>,
    /// The chat subscription's forwarder of `chat_delta` frames.
    chat: Option<tokio::task::JoinHandle<()>>,
    live_slot: Arc<live::LiveSlot>,
    budget: Arc<live::ConnBudget>,
}

/// What to do with the socket after a frame.
enum After {
    Continue,
    Close(u16, &'static str),
}

impl Session {
    fn send(&self, frame: Value) {
        let _ = self.out.send(frame);
    }

    async fn on_text(&mut self, text: &str) -> After {
        let Ok(message) = serde_json::from_str::<AppClientMessage>(text) else {
            let malformed = ToolError::new(ErrorCode::Invalid, "Unknown or malformed message.")
                .with_fix("Send {t:auth|snapshot|events}.");
            self.send(error_frame(&malformed, None));
            return After::Continue;
        };
        if let AppClientMessage::Auth { key } = &message {
            return match self.hub.auth.verify(key.as_str()) {
                Ok(info) => {
                    self.caller = Some((key.as_str().to_owned(), info));
                    self.send(json!({ "t": "ready", "protocol": PROTOCOL_VERSION, "version": crate::version() }));
                    After::Continue
                }
                Err(error) => {
                    self.send(error_frame(&refused(error), None));
                    After::Close(CLOSE_UNAUTHORIZED, "unauthorized")
                }
            };
        }
        let Some((key, info)) = self.caller.clone() else {
            let id = match &message {
                AppClientMessage::Call { id, .. } => Some(id.as_str().to_owned()),
                _ => None,
            };
            let not_authed = ToolError::new(ErrorCode::Forbidden, "Not authenticated.")
                .with_fix("Send {t:auth,key} first.");
            self.send(error_frame(&not_authed, id.as_deref()));
            return After::Continue;
        };
        match message {
            AppClientMessage::Auth { .. } => unreachable!("handled above"),
            AppClientMessage::Chat { project } => {
                // A new `chat` request replaces the running one; none stops it.
                if let Some(old) = self.chat.take() {
                    old.abort();
                }
                let Some(project) = project else {
                    return After::Continue;
                };
                if !crate::hub::api::allows(&info, Role::Read, Some(&project.machine_id)) {
                    let refused = crate::hub::api::forbidden(Role::Read, Some(&project.machine_id));
                    self.send(error_frame(&refused, None));
                    return After::Continue;
                }
                let mut deltas = self.hub.chat.subscribe();
                let out = self.out.clone();
                self.chat = Some(tokio::spawn(async move {
                    loop {
                        match deltas.recv().await {
                            Ok(delta) if delta.project_ref == project => {
                                let mut frame = serde_json::to_value(&delta).unwrap_or_default();
                                frame["t"] = json!("chat_delta");
                                if out.send(frame).is_err() {
                                    return;
                                }
                            }
                            Ok(_) => {}
                            // A slow connection missed frames: the offsets show the gap, and the app reads again.
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                        }
                    }
                }));
            }
            AppClientMessage::Call { id, tool, input } => {
                // Reap finished calls so the in-flight count is current.
                while self.calls.try_join_next().is_some() {}
                if self.calls.len() >= MAX_CALLS_IN_FLIGHT {
                    let busy = ToolError::new(
                        ErrorCode::Invalid,
                        format!("Over {MAX_CALLS_IN_FLIGHT} calls in flight."),
                    )
                    .with_fix("Wait for a result before sending more calls.");
                    self.send(error_frame(&busy, Some(id.as_str())));
                    return After::Continue;
                }
                let (hub, tools, out) = (self.hub.clone(), self.tools.clone(), self.out.clone());
                let budget = self.budget.clone();
                self.calls.spawn(async move {
                    let frame = match call(&hub, &tools, &key, tool.as_str(), input).await {
                        Ok(output) => json!({ "t": "result", "id": id.as_str(), "output": output }),
                        Err(error) => error_frame(&error, Some(id.as_str())),
                    };
                    // Status answers share the live feed's per-connection budget: one over it waits for the next second.
                    if tool.as_str().starts_with("status_") {
                        let bytes = frame.to_string().len();
                        loop {
                            let wait = budget.reserve(now_ms(hub.clock.as_ref()), bytes);
                            if wait == 0 {
                                break;
                            }
                            hub.clock
                                .sleep(std::time::Duration::from_millis(wait))
                                .await;
                        }
                    }
                    let _ = out.send(frame);
                });
            }
            AppClientMessage::Snapshot {} => match self
                .tools
                .call(&self.hub, &info, "fleetd_status", json!({}))
                .await
            {
                Ok(status) => self.send(json!({
                    "t": "snapshot",
                    "machines": status["machines"],
                    "projects": status["projects"],
                    "attention": status["attention"],
                    "cursor": status["cursor"],
                    "slots": status["slots"],
                    "chats": status["chats"],
                })),
                Err(CallError::Tool(error)) => self.send(error_frame(&error, None)),
                Err(other) => tracing::error!(?other, "app snapshot failed"),
            },
            AppClientMessage::Events { cursor } => {
                // A new `events` request replaces the running stream.
                if let Some(old) = self.stream.take() {
                    old.abort();
                }
                let task = stream_events(
                    self.hub.clone(),
                    self.tools.clone(),
                    info,
                    cursor.get(),
                    self.out.clone(),
                );
                self.stream = Some(tokio::spawn(task));
            }
            AppClientMessage::Live {
                board,
                focus,
                agent,
            } => {
                // A new `live` request replaces the running subscription; its first frame is full.
                if let Some(old) = self.live.take() {
                    old.abort();
                }
                self.live_slot.clear();
                let scope = live::Scope {
                    caller: info,
                    board,
                    focus,
                    agent,
                };
                self.live = Some(tokio::spawn(live::run(
                    self.hub.clone(),
                    scope,
                    self.live_slot.clone(),
                    self.budget.clone(),
                )));
            }
        }
        After::Continue
    }
}

/// Runs one /app connection until the client closes it, its key is refused, or the hub shuts down.
pub async fn handle(hub: Arc<Hub>, tools: Arc<Registry>, mut socket: WebSocket) {
    let (out, mut frames) = mpsc::unbounded_channel::<Value>();
    let shutdown = hub.shutdown.clone();
    let mut session = Session {
        hub,
        tools,
        out,
        caller: None,
        stream: None,
        calls: JoinSet::new(),
        live: None,
        chat: None,
        live_slot: Arc::default(),
        budget: Arc::default(),
    };
    let live_slot = session.live_slot.clone();
    let close = loop {
        tokio::select! {
            () = shutdown.wait() => break Some((CLOSE_GOING_AWAY, "hub shutting down")),
            Some(frame) = frames.recv() => {
                if socket.send(Message::Text(frame.to_string().into())).await.is_err() {
                    break None;
                }
            }
            () = live_slot.notify.notified() => {
                if let Some(frame) = live_slot.take()
                    && socket.send(Message::Text(frame.into())).await.is_err()
                {
                    break None;
                }
            }
            incoming = socket.recv() => {
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text.to_string(),
                    Some(Ok(Message::Binary(bytes))) => String::from_utf8_lossy(&bytes).into_owned(),
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    Some(Ok(Message::Close(_))) => {
                        // Complete the closing handshake so the client sees its own code, not 1006.
                        let _ = socket.send(Message::Close(None)).await;
                        break None;
                    }
                    Some(Err(_)) | None => break None,
                };
                if let After::Close(code, reason) = session.on_text(&text).await {
                    // Flush what this frame produced (the refusal) before closing.
                    while let Ok(frame) = frames.try_recv() {
                        let _ = socket.send(Message::Text(frame.to_string().into())).await;
                    }
                    break Some((code, reason));
                }
            }
        }
    };
    if let Some(stream) = session.stream.take() {
        stream.abort();
    }
    if let Some(live) = session.live.take() {
        live.abort();
    }
    if let Some(chat) = session.chat.take() {
        chat.abort();
    }
    session.calls.abort_all();
    if let Some((code, reason)) = close {
        let _ = socket
            .send(Message::Close(Some(CloseFrame {
                code,
                reason: reason.into(),
            })))
            .await;
    }
}
