//! The app WebSocket at /app: `auth` with a key, then `snapshot` for the
//! fleetd_status data, `events` to stream HubEvents after a cursor as they happen, `call` to run any MCP tool
//! with the session's key, through the same registry, grants and limits as /mcp, and `live` for ephemeral lane
//! frames (see `live`). `presence` is the app's once-a-minute focus and input, recorded as `app.presence` and
//! never answered (see `metrics::presence`). What waits for the socket is bounded (see `outbox`).
pub mod live;
pub mod outbox;
pub mod pace;

use crate::hub::api::{CallError, Caller, Hub, Registry, ToolError};
use crate::hub::auth::AuthError;
use crate::hub::mcp::invalid_input;
use crate::hub::store::now_ms;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use fleetd_contracts::app::{AppCallId, AppClientMessage};
use fleetd_contracts::auth::Role;
use fleetd_contracts::hello::PROTOCOL_VERSION;
use fleetd_contracts::mcp::ErrorCode;
use outbox::{Behind, Outbox};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::task::JoinSet;

/// Close code for a connection whose key was refused.
pub const CLOSE_UNAUTHORIZED: u16 = 4401;
/// Calls one connection may have running at once; more are refused rather than queued without bound.
pub const MAX_CALLS_IN_FLIGHT: usize = 32;
/// "Going Away": the hub is stopping and comes back within a moment; the reason says when an update restarts it.
const CLOSE_RESTART: u16 = fleetd_contracts::app::APP_CLOSE_RESTART;
/// [`CLOSE_RESTART`]'s reason when no update restarts the hub.
const RESTARTING: &str = "hub restarting";
/// "Try again later": the connection fell too far behind (see `outbox`); the app reconnects and reads again.
const CLOSE_TOO_FAR_BEHIND: u16 = 1013;
/// How long a closing frame may take: a socket too far behind may never take it.
const CLOSE_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
/// "Invalid frame payload data": a compressed frame that doesn't inflate; the stream can't go on without it.
const CLOSE_BAD_DATA: u16 = 1007;
/// The most one compressed frame from the app may inflate to: the socket's own message cap.
const MAX_INFLATED: usize = 64 << 20;
/// After this long without a frame to the app, the hub pings it: the event long-poll is silent when nothing happens,
/// and a cellular or hotel NAT forgets an idle flow in as little as 30 s. The phone can't ping, but answers pongs.
pub const KEEPALIVE: std::time::Duration = std::time::Duration::from_secs(25);
/// How often a connection checks its key again with no revoke on this hub to wake it: a key revoked from the hub's
/// home (`fleetd hub key revoke`, `fleetd people remove`) stops streaming within this.
const KEY_RECHECK: std::time::Duration = std::time::Duration::from_secs(15);

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
    if let Some(reason) = error.reason {
        frame["reason"] = serde_json::to_value(reason).expect("serializable reason");
    }
    frame
}

fn refused(error: AuthError) -> ToolError {
    match error {
        AuthError::Unauthorized(u) => ToolError {
            code: u.code,
            message: u.message,
            fix: u.fix,
            reason: None,
            person_fix: None,
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
    out: Outbox,
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
                        if !out.send(frame.to_string()).await {
                            return;
                        }
                    }
                }
                cursor = page["cursor"].as_i64().unwrap_or(cursor);
            }
            Err(CallError::Tool(error)) => {
                out.push(error_frame(&error, None).to_string());
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
    out: Outbox,
    caller: Option<(String, Caller)>,
    stream: Option<tokio::task::JoinHandle<()>>,
    calls: JoinSet<()>,
    /// The live subscription's pump, and the one-frame slot it writes to.
    live: Option<tokio::task::JoinHandle<()>>,
    /// The chat subscription's forwarder of `chat_delta` frames.
    chat: Option<tokio::task::JoinHandle<()>>,
    /// The browser watch's forwarder, which holds the watch, and the slot for its newest frame.
    browser: Option<tokio::task::JoinHandle<()>>,
    browser_slot: Arc<pace::ScreenSlot>,
    /// The watch's pacing, while its client acks frames (`browser_watch`'s `acks`), and its say in the screen's budget.
    pace: Option<(pace::Pace, crate::hub::browser::live::WatchBudget)>,
    /// The Screens page's pictures' forwarder, which holds the page's showing (browser/thumbs.rs).
    thumbs: Option<tokio::task::JoinHandle<()>>,
    /// The last reason a person's `browser_input` was refused, logged once until it changes: a refused drag would
    /// otherwise log every move.
    input_refused: Option<String>,
    live_slot: Arc<live::LiveSlot>,
    budget: Arc<live::ConnBudget>,
    /// The client's `auth` asked for compressed frames (`APP_DEFLATE`): they start after its `ready`.
    deflate: bool,
    /// What the upgrade's own auth already answered ([`EarlyAuth`]).
    early: Early,
}

/// The `auth` an upgrade request carried ([`fleetd_contracts::app::APP_FEATURES_HEADER`]): its key and features.
pub struct EarlyAuth {
    key: String,
    features: Vec<String>,
}

impl EarlyAuth {
    pub fn from_headers(headers: &axum::http::HeaderMap) -> Option<Self> {
        let key = headers
            .get(axum::http::header::AUTHORIZATION)?
            .to_str()
            .ok()?
            .strip_prefix("Bearer ")?
            .trim();
        let features = headers
            .get(fleetd_contracts::app::APP_FEATURES_HEADER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        (!key.is_empty()).then(|| EarlyAuth {
            key: key.to_owned(),
            features: features
                .split(',')
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .map(str::to_owned)
                .collect(),
        })
    }
}

/// The frames an upgrade's auth answered before they came: the client's `auth`, then a `snapshot` right after it.
#[derive(Default, PartialEq)]
enum Early {
    #[default]
    None,
    Auth,
    Snapshot,
}

/// What to do with the socket after a frame.
enum After {
    Continue,
    Close(u16, &'static str),
}

impl Session {
    fn send(&self, frame: Value) {
        self.out.push(frame.to_string());
    }

    /// Whether the connection's key was refused since it authed: revoked, or its person removed. Only a refusal
    /// counts; a check that failed otherwise keeps the connection.
    fn key_refused(&self) -> bool {
        let Some((key, _)) = &self.caller else {
            return false;
        };
        match self.hub.auth.verify(key) {
            Err(error @ AuthError::Unauthorized(_)) => {
                self.send(error_frame(&refused(error), None));
                true
            }
            _ => false,
        }
    }

    /// The upgrade's auth: `ready` and a `snapshot` at once, as for an `auth` and a `snapshot` frame. A refused key is
    /// only ignored: the client's `auth` frame is refused as always.
    fn on_early(&mut self, early: EarlyAuth) {
        let Ok(info) = self.hub.auth.verify(&early.key) else {
            return;
        };
        self.ready(early.key, info, early.features.iter().map(String::as_str));
        self.early = Early::Auth;
    }

    fn ready<'a>(
        &mut self,
        key: String,
        info: Caller,
        mut features: impl Iterator<Item = &'a str>,
    ) {
        self.caller = Some((key, info));
        self.deflate |= features.any(|f| f == fleetd_contracts::app::APP_DEFLATE);
        // The vault lives in fleetd's Bun build only: hub/vault answers every vault tool that it needs that build.
        let offered: Vec<&str> = fleetd_contracts::app::APP_FEATURES
            .into_iter()
            .filter(|f| *f != fleetd_contracts::app::APP_VAULT)
            .collect();
        self.send(json!({
            "t": "ready", "protocol": PROTOCOL_VERSION, "version": crate::version(),
            "features": offered,
        }));
    }

    async fn snapshot(&mut self, info: &Caller) {
        match self
            .tools
            .call(&self.hub, info, "fleetd_status", json!({}))
            .await
        {
            Ok(status) => {
                let mut frame = json!({
                    "t": "snapshot",
                    "machines": status["machines"],
                    "projects": status["projects"],
                    "attention": status["attention"],
                    "cursor": status["cursor"],
                    "slots": status["slots"],
                    "chats": status["chats"],
                });
                // Absent, not null, when the hub never updated itself.
                if let Some(update) = self.hub.updates.signal() {
                    frame["update"] = json!(update);
                }
                self.send(frame);
            }
            Err(CallError::Tool(error)) => self.send(error_frame(&error, None)),
            Err(other) => tracing::error!(?other, "app snapshot failed"),
        }
    }

    async fn on_text(&mut self, text: &str) -> After {
        let Ok(message) = serde_json::from_str::<AppClientMessage>(text) else {
            let malformed = ToolError::new(ErrorCode::Invalid, "Unknown or malformed message.")
                .with_fix("Send {t:auth|snapshot|events}.");
            // The frame's own id, when it has one, so the client knows which frame this answers.
            let id = serde_json::from_str::<Value>(text)
                .ok()
                .and_then(|v| v.get("id")?.as_str().map(str::to_owned))
                .filter(|id| AppCallId::new(id.as_str()).is_ok());
            self.send(error_frame(&malformed, id.as_deref()));
            return After::Continue;
        };
        // The upgrade's auth answered the client's first `auth` with this key, and the `snapshot` right after it.
        match (std::mem::take(&mut self.early), &message) {
            (Early::Auth, AppClientMessage::Auth { key, .. })
                if self.caller.as_ref().is_some_and(|(k, _)| k == key.as_str()) =>
            {
                self.early = Early::Snapshot;
                return After::Continue;
            }
            (Early::Snapshot, AppClientMessage::Snapshot {}) => return After::Continue,
            _ => {}
        }
        if let AppClientMessage::Auth { key, features } = &message {
            return match self.hub.auth.verify(key.as_str()) {
                Ok(info) => {
                    let features = features.iter().flatten().map(|f| f.as_str());
                    self.ready(key.as_str().to_owned(), info, features);
                    After::Continue
                }
                Err(error) => {
                    self.send(error_frame(&refused(error), None));
                    After::Close(CLOSE_UNAUTHORIZED, "unauthorized")
                }
            };
        }
        // Every frame goes on the key as it is now: one revoked from the CLI since the last recheck reads nothing more.
        if self.key_refused() {
            return After::Close(CLOSE_UNAUTHORIZED, "unauthorized");
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
            AppClientMessage::BrowserWatch { session, acks, fps } => {
                // A new watch replaces the running one; none stops it.
                if let Some(old) = self.browser.take() {
                    old.abort();
                }
                self.browser_slot.clear();
                self.pace = None;
                let Some(session) = session else {
                    return After::Continue;
                };
                match crate::hub::browser::live::start_watch(&self.hub, &info, &session) {
                    Ok(mut watch) => {
                        if acks {
                            let fps = fps.and_then(|f| u32::try_from(f.get()).ok());
                            self.pace = Some((pace::Pace::new(fps), watch.budget()));
                        }
                        let slot = self.browser_slot.clone();
                        let hub = self.hub.clone();
                        let project = hub
                            .db
                            .with(|c| crate::hub::navi::owner::screen_project(c, session.as_str()))
                            .ok()
                            .flatten();
                        self.browser = Some(tokio::spawn(async move {
                            // The node sends its newest frame again for each `on` (another watcher, a budget): not
                            // again to a connection that has it, where it would cost a slow link a frame's time.
                            let mut last = None;
                            loop {
                                match watch.frames.recv().await {
                                    Ok(frame) if frame.session_id == session => {
                                        // Its project turned Only me since, by another person: theirs alone to watch.
                                        if let Some(p) = &project
                                            && !crate::hub::navi::owner::may_use(&hub.db, &info, p)
                                                .unwrap_or(false)
                                        {
                                            return;
                                        }
                                        if last.replace(frame.seq) == Some(frame.seq) {
                                            continue;
                                        }
                                        let (seq, bytes) =
                                            (frame.seq, frame.jpeg_b64.len() / 4 * 3);
                                        let mut value =
                                            serde_json::to_value(&frame).unwrap_or_default();
                                        value["t"] = json!("browser_frame");
                                        slot.replace(pace::Outgoing {
                                            text: value.to_string(),
                                            seq,
                                            bytes,
                                        });
                                    }
                                    Ok(_) => {}
                                    // Behind: the next frame is the newest anyway.
                                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                                }
                            }
                        }));
                    }
                    Err(refused) => self.send(error_frame(&refused, None)),
                }
            }
            AppClientMessage::BrowserFrameAck { seq } => {
                if let Some((pace, budget)) = self.pace.as_mut() {
                    pace.acked(seq, std::time::Instant::now());
                    budget.set(pace.kbps());
                    // Room again, maybe, for the frame that waited.
                    if self.browser_slot.pending() {
                        self.browser_slot.notify.notify_one();
                    }
                }
            }
            AppClientMessage::ScreenThumbs { on } => {
                // The page shows again (a reconnect, a second window) or no more: the running one ends either way.
                if let Some(old) = self.thumbs.take() {
                    old.abort();
                }
                if on {
                    self.thumbs = Some(tokio::spawn(crate::hub::browser::thumbs::forward(
                        self.hub.clone(),
                        info,
                        self.out.clone(),
                    )));
                }
            }
            AppClientMessage::BrowserInput { session, input } => {
                match crate::hub::browser::live::input(&self.hub, &info, &session, input) {
                    Ok(()) => self.input_refused = None,
                    Err(refused) => {
                        // The reason only: never the input, which may be typed text.
                        if self.input_refused.as_deref() != Some(refused.message.as_str()) {
                            tracing::warn!(session = %session, code = ?refused.code, reason = %refused.message, "a person's browser input refused");
                            self.input_refused = Some(refused.message.clone());
                        }
                        self.send(error_frame(&refused, None));
                    }
                }
            }
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
                // Another person's Navi's chat is theirs alone (D215).
                if !crate::hub::navi::owner::may_use(&self.hub.db, &info, &project).unwrap_or(false)
                {
                    self.send(error_frame(
                        &crate::hub::navi::owner::refused(&project),
                        None,
                    ));
                    return After::Continue;
                }
                let mut deltas = self.hub.chat.subscribe();
                let out = self.out.clone();
                let hub = self.hub.clone();
                self.chat = Some(tokio::spawn(async move {
                    loop {
                        match deltas.recv().await {
                            Ok(delta) if delta.project_ref == project => {
                                // Turned Only me since by another person: its chat streams to them alone.
                                if !crate::hub::navi::owner::may_use(&hub.db, &info, &project)
                                    .unwrap_or(false)
                                {
                                    out.push(
                                        error_frame(
                                            &crate::hub::navi::owner::refused(&project),
                                            None,
                                        )
                                        .to_string(),
                                    );
                                    return;
                                }
                                let mut frame = serde_json::to_value(&delta).unwrap_or_default();
                                frame["t"] = json!("chat_delta");
                                if !out.push(frame.to_string()) {
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
                    let frame = frame.to_string();
                    // Status answers share the live feed's per-connection budget: one over it waits for the next second.
                    if tool.as_str().starts_with("status_") {
                        let bytes = frame.len();
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
                    out.send(frame).await;
                });
            }
            AppClientMessage::Presence {
                focused,
                input,
                project,
                ..
            } => {
                if let Err(e) = crate::hub::metrics::presence::record(
                    &self.hub,
                    &info,
                    focused,
                    input,
                    project.as_ref(),
                ) {
                    tracing::warn!(error = %e, "app presence not recorded");
                }
            }
            AppClientMessage::Snapshot {} => self.snapshot(&info).await,
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
/// One /app connection; `early`, the auth its upgrade request carried, is answered before any frame is read.
pub async fn handle(
    hub: Arc<Hub>,
    tools: Arc<Registry>,
    mut socket: WebSocket,
    early: Option<EarlyAuth>,
) {
    let (out, mut frames) = outbox::outbox();
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
        browser: None,
        browser_slot: Arc::default(),
        pace: None,
        thumbs: None,
        input_refused: None,
        live_slot: Arc::default(),
        budget: Arc::default(),
        deflate: false,
        early: Early::None,
    };
    let live_slot = session.live_slot.clone();
    let browser_slot = session.browser_slot.clone();
    let behind = frames.behind();
    let mut keepalive =
        tokio::time::interval_at(tokio::time::Instant::now() + KEEPALIVE, KEEPALIVE);
    // Each direction's compression stream, from the `ready` of an `auth` that asked for it to the socket's end.
    let mut wire = Wire::default();
    let mut revokes = session.hub.auth.revokes();
    let mut recheck = tokio::time::interval(KEY_RECHECK);
    recheck.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    if let Some(early) = early {
        session.on_early(early);
        if let Some((_, info)) = session.caller.clone() {
            // `ready` goes as Text, as after an `auth` frame; the snapshot may come compressed.
            if session.deflate {
                while let Some(frame) = frames.try_recv() {
                    if !wire.send(&mut socket, &behind, frame).await {
                        break;
                    }
                }
                wire.start();
            }
            session.snapshot(&info).await;
        }
    }
    // A paced watch's frame held back for its client's frame rate or the link, until when.
    let mut deferred: Option<std::time::Instant> = None;
    let close = loop {
        tokio::select! {
            () = shutdown.wait() => break Some((CLOSE_RESTART, RESTARTING)),
            // A revoked key's connection streams nothing more: it closes as refused, as at `auth`. A check is no
            // traffic, so it leaves the keepalive's clock alone.
            Ok(()) = revokes.changed() => {
                if session.key_refused() {
                    break Some(refuse(&mut wire, &mut socket, &behind, &mut frames).await);
                }
                continue;
            }
            _ = recheck.tick() => {
                if session.key_refused() {
                    break Some(refuse(&mut wire, &mut socket, &behind, &mut frames).await);
                }
                continue;
            }
            () = behind.wait() => break Some(too_far_behind(&behind)),
            _ = keepalive.tick() => {
                if socket.send(Message::Ping(Default::default())).await.is_err() {
                    break stopped(&behind);
                }
                continue;
            }
            Some(frame) = frames.recv() => {
                if !wire.send(&mut socket, &behind, frame).await {
                    break stopped(&behind);
                }
            }
            () = live_slot.notify.notified() => {
                if let Some(frame) = live_slot.take()
                    && !wire.send(&mut socket, &behind, frame).await
                {
                    break stopped(&behind);
                }
            }
            () = tokio::time::sleep_until(tokio::time::Instant::from_std(deferred.unwrap_or_else(std::time::Instant::now))), if deferred.is_some() => {
                deferred = None;
                browser_slot.notify.notify_one();
                continue;
            }
            () = browser_slot.notify.notified() => {
                let now = std::time::Instant::now();
                if let Some((pace, _)) = session.pace.as_mut() {
                    // It waits in the slot, replaced by any newer, until its time or an ack's room.
                    if let Some(at) = pace.not_before(now) {
                        deferred = Some(at);
                        continue;
                    }
                    if let Err(at) = pace.room(now) {
                        pace.waited(now);
                        if let Some(at) = at {
                            deferred = Some(deferred.map_or(at, |d| d.min(at)));
                        }
                        continue;
                    }
                }
                let Some(frame) = browser_slot.take() else {
                    continue;
                };
                if let Some((pace, _)) = session.pace.as_mut() {
                    if pace.ping(now)
                        && socket.send(Message::Ping(pace::PING.into())).await.is_err()
                    {
                        break stopped(&behind);
                    }
                    pace.sent(frame.seq, frame.bytes, now);
                }
                if !wire.send(&mut socket, &behind, frame.text).await {
                    break stopped(&behind);
                }
            }
            incoming = socket.recv() => {
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text.to_string(),
                    Some(Ok(Message::Binary(bytes))) => match wire.inflater.as_mut() {
                        Some(inflater) => match inflater.inflate(&bytes, MAX_INFLATED) {
                            Ok(text) => text,
                            Err(e) => {
                                tracing::warn!(error = %e, "an app connection sent a frame that does not inflate");
                                break Some((CLOSE_BAD_DATA, "a compressed frame does not inflate"));
                            }
                        },
                        None => String::from_utf8_lossy(&bytes).into_owned(),
                    },
                    Some(Ok(Message::Pong(payload))) => {
                        keepalive.reset();
                        if let Some((pace, _)) = session.pace.as_mut()
                            && payload.as_ref() == pace::PING
                        {
                            pace.pong(std::time::Instant::now());
                        }
                        continue;
                    }
                    Some(Ok(Message::Ping(_))) => {
                        keepalive.reset();
                        continue;
                    }
                    Some(Ok(Message::Close(_))) => {
                        // Complete the closing handshake so the client sees its own code, not 1006.
                        let _ = socket.send(Message::Close(None)).await;
                        break None;
                    }
                    Some(Err(_)) | None => break None,
                };
                if let After::Close(code, reason) = session.on_text(&text).await {
                    // Flush what this frame produced (the refusal) before closing.
                    wire.flush(&mut socket, &behind, &mut frames).await;
                    break Some((code, reason));
                }
                if session.deflate && wire.deflater.is_none() {
                    // What the auth queued (its `ready`, refusals before it) goes as Text; everything after may not.
                    while let Some(frame) = frames.try_recv() {
                        if !wire.send(&mut socket, &behind, frame).await {
                            break;
                        }
                    }
                    wire.start();
                }
            }
        }
        // Traffic either way keeps the flow alive: the ping is only for a silent link.
        keepalive.reset();
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
    if let Some(browser) = session.browser.take() {
        browser.abort();
    }
    if let Some(thumbs) = session.thumbs.take() {
        thumbs.abort();
    }
    session.calls.abort_all();
    if let Some((code, reason)) = close {
        // A stop an update asked for says so, read as the hub stops: its `hub.update` event may not reach the app first.
        let reason = match session.hub.updates.restart_reason() {
            Some(updating) if code == CLOSE_RESTART => updating,
            _ => reason.to_owned(),
        };
        let closing = socket.send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })));
        let _ = tokio::time::timeout(CLOSE_WAIT, closing).await;
    }
}

/// One connection's compression ([`fleetd_contracts::app::APP_DEFLATE`]): off until [`Wire::start`].
#[derive(Default)]
struct Wire {
    deflater: Option<crate::link_deflate::Deflater>,
    inflater: Option<crate::link_deflate::Inflater>,
}

impl Wire {
    fn start(&mut self) {
        self.deflater = Some(Default::default());
        self.inflater = Some(Default::default());
    }

    /// Sends one frame, compressed once started and worth it. False when the socket failed, or the connection fell
    /// too far behind while the frame was going out (a client that stopped reading never takes it).
    async fn send(&mut self, socket: &mut WebSocket, behind: &Behind, text: String) -> bool {
        let message = match self.deflater.as_mut() {
            Some(deflater) if text.len() >= crate::link_deflate::MIN_DEFLATE_BYTES => {
                Message::Binary(deflater.deflate(&text).into())
            }
            _ => Message::Text(text.into()),
        };
        tokio::select! {
            sent = socket.send(message) => sent.is_ok(),
            () = behind.wait() => false,
        }
    }

    /// Sends what waits in the outbox, until the socket fails.
    async fn flush(
        &mut self,
        socket: &mut WebSocket,
        behind: &Behind,
        frames: &mut outbox::Frames,
    ) {
        while let Some(frame) = frames.try_recv() {
            if !self.send(socket, behind, frame).await {
                break;
            }
        }
    }
}

/// How a connection whose key was refused ends: the refusal sent, then closed as unauthorized.
async fn refuse(
    wire: &mut Wire,
    socket: &mut WebSocket,
    behind: &Behind,
    frames: &mut outbox::Frames,
) -> (u16, &'static str) {
    wire.flush(socket, behind, frames).await;
    (CLOSE_UNAUTHORIZED, "unauthorized")
}

/// How a connection whose send failed ends: closed with a reason when it fell behind, else just dropped.
fn stopped(behind: &Behind) -> Option<(u16, &'static str)> {
    behind.is().then(|| too_far_behind(behind))
}

fn too_far_behind(behind: &Behind) -> (u16, &'static str) {
    tracing::warn!(
        waiting_bytes = behind.waiting(),
        "an app connection stopped reading: closed it, the app reconnects and reads again"
    );
    (CLOSE_TOO_FAR_BEHIND, "it stopped reading what the hub sent")
}
