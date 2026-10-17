//! One WebSocket connection to a stock T3 server. Same handshake T3's own remote clients use: bearer -> one-time
//! ws ticket (`POST /api/auth/websocket-ticket`) -> `/ws?wsTicket=…&orchestrationProtocol=2`, then effect RPC's
//! JSON framing (see `frame`). Reconnecting is the caller's job, with a fresh ticket each time: watch `closed()`.
use std::collections::{HashMap, VecDeque};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, Stream, StreamExt};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;

use crate::frame::{CauseEncoded, ClientMessage, ExitEncoded, ServerMessage, decode_frame};
use crate::methods as m;
use crate::types::*;

const TICKET_TIMEOUT: Duration = Duration::from_secs(10);
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
/// Effect's defaults as fleetd's TS client sets them: ping every 5 s, give up 15 s after the last frame.
const PING_INTERVAL: Duration = Duration::from_secs(5);
const PING_TIMEOUT: Duration = Duration::from_secs(15);
pub const ORCHESTRATION_PROTOCOL_QUERY_PARAM: &str = "orchestrationProtocol";
pub const ORCHESTRATION_PROTOCOL_VERSION: u32 = 2;

/// Error texts never carry the bearer or the one-time ticket.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("bad T3 url: {0}")]
    BadUrl(String),
    #[error("T3 refused the websocket ticket request (HTTP {0})")]
    TicketRefused(u16),
    #[error("could not get a websocket ticket from T3: {0}")]
    Ticket(String),
    #[error("could not open the T3 websocket: {0}")]
    Connect(String),
    #[error("T3 connection closed: {0}")]
    Closed(String),
    #[error("T3 failed {method}: {}{}", error.tag, error.message.as_deref().map(|m| format!(": {m}")).unwrap_or_default())]
    Rpc {
        method: &'static str,
        error: T3Error,
        raw: Value,
    },
    #[error("T3 hit a defect in {method}")]
    Defect { method: &'static str, defect: Value },
    #[error("T3 interrupted {method}")]
    Interrupted { method: &'static str },
    #[error("could not decode T3's {method} response: {message}")]
    Decode {
        method: &'static str,
        message: String,
    },
}

impl Error {
    /// The `_tag` of a typed T3 failure, e.g. `ProjectReadFileError`.
    pub fn rpc_tag(&self) -> Option<&str> {
        match self {
            Error::Rpc { error, .. } => Some(&error.tag),
            _ => None,
        }
    }
}

enum Pending {
    Unary(&'static str, oneshot::Sender<Result<Value, Error>>),
    Stream(&'static str, mpsc::UnboundedSender<StreamEvent>),
}

enum StreamEvent {
    Chunk(Vec<Value>),
    End(Result<(), Error>),
}

struct Shared {
    out: mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<u64, Pending>>,
    next_id: AtomicU64,
    /// `Some(reason)` once the socket is gone.
    closed: watch::Sender<Option<String>>,
}

impl Shared {
    fn send(&self, message: &ClientMessage) {
        let _ = self.out.send(message.encode());
    }

    fn close_reason(&self) -> Option<String> {
        self.closed.borrow().clone()
    }

    /// Fails everything in flight. Idempotent.
    fn shut(&self, reason: String) {
        self.closed.send_if_modified(|c| {
            if c.is_some() {
                return false;
            }
            *c = Some(reason.clone());
            true
        });
        let drained: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, p) in drained {
            match p {
                Pending::Unary(_, tx) => drop(tx.send(Err(Error::Closed(reason.clone())))),
                Pending::Stream(_, tx) => {
                    drop(tx.send(StreamEvent::End(Err(Error::Closed(reason.clone())))))
                }
            }
        }
    }

    fn dispatch(&self, message: ServerMessage) {
        match message {
            ServerMessage::Chunk { request_id, values } => {
                if let Some(Pending::Stream(_, tx)) =
                    self.pending.lock().unwrap().get(&request_id.0)
                {
                    let _ = tx.send(StreamEvent::Chunk(values));
                }
            }
            ServerMessage::Exit { request_id, exit } => {
                let Some(p) = self.pending.lock().unwrap().remove(&request_id.0) else {
                    return;
                };
                match p {
                    Pending::Unary(method, tx) => drop(tx.send(exit_result(method, exit))),
                    Pending::Stream(method, tx) => {
                        drop(tx.send(StreamEvent::End(exit_result(method, exit).map(drop))))
                    }
                }
            }
            ServerMessage::Defect { defect } => {
                let drained: Vec<_> = self.pending.lock().unwrap().drain().collect();
                for (_, p) in drained {
                    match p {
                        Pending::Unary(method, tx) => drop(tx.send(Err(Error::Defect {
                            method,
                            defect: defect.clone(),
                        }))),
                        Pending::Stream(method, tx) => {
                            drop(tx.send(StreamEvent::End(Err(Error::Defect {
                                method,
                                defect: defect.clone(),
                            }))))
                        }
                    }
                }
            }
            ServerMessage::Pong | ServerMessage::Unknown => {}
        }
    }
}

fn exit_result(method: &'static str, exit: ExitEncoded) -> Result<Value, Error> {
    match exit {
        ExitEncoded::Success { value } => Ok(value),
        ExitEncoded::Failure { cause } => {
            // A typed failure wins over a defect, which wins over an interruption, as effect's `Cause.squash`.
            let fail = cause.iter().find_map(|c| match c {
                CauseEncoded::Fail { error } => Some(error.clone()),
                _ => None,
            });
            if let Some(raw) = fail {
                return Err(match serde_json::from_value::<T3Error>(raw.clone()) {
                    Ok(error) => Error::Rpc { method, error, raw },
                    Err(e) => Error::Decode {
                        method,
                        message: format!("error value: {e}"),
                    },
                });
            }
            let defect = cause.into_iter().find_map(|c| match c {
                CauseEncoded::Die { defect } => Some(defect),
                _ => None,
            });
            Err(match defect {
                Some(defect) => Error::Defect { method, defect },
                None => Error::Interrupted { method },
            })
        }
    }
}

struct Connection {
    shared: Arc<Shared>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.shared.shut("client dropped".into());
        for t in &self.tasks {
            t.abort();
        }
    }
}

/// A live T3 connection. Cheap to clone; the socket closes when the last clone and subscription are dropped.
#[derive(Clone)]
pub struct T3Client {
    conn: Arc<Connection>,
}

/// Exchanges the bearer for a one-time ws ticket and builds the socket URL from `t3_url`'s origin.
async fn ws_url(t3_url: &str, bearer: &str) -> Result<String, Error> {
    let base = reqwest::Url::parse(t3_url).map_err(|e| Error::BadUrl(e.to_string()))?;
    let origin = base.origin();
    if !origin.is_tuple() {
        return Err(Error::BadUrl("no host".into()));
    }
    let origin = origin.ascii_serialization();
    let http = reqwest::Client::builder()
        .timeout(TICKET_TIMEOUT)
        .build()
        .map_err(|e| Error::Ticket(e.to_string()))?;
    let res = http
        .post(format!("{origin}/api/auth/websocket-ticket"))
        .bearer_auth(bearer)
        .send()
        .await
        .map_err(|e| Error::Ticket(e.without_url().to_string()))?;
    if !res.status().is_success() {
        return Err(Error::TicketRefused(res.status().as_u16()));
    }
    let ticket: WsTicket = res
        .json()
        .await
        .map_err(|e| Error::Ticket(e.without_url().to_string()))?;
    let mut url = reqwest::Url::parse(&origin).map_err(|e| Error::BadUrl(e.to_string()))?;
    url.set_scheme(if base.scheme() == "https" {
        "wss"
    } else {
        "ws"
    })
    .map_err(|_| Error::BadUrl("scheme".into()))?;
    url.set_path("/ws");
    url.query_pairs_mut()
        .append_pair("wsTicket", &ticket.ticket)
        .append_pair(
            ORCHESTRATION_PROTOCOL_QUERY_PARAM,
            &ORCHESTRATION_PROTOCOL_VERSION.to_string(),
        );
    Ok(url.into())
}

impl T3Client {
    /// `t3_url` is the server's base URL (only its origin is used); `bearer` a T3 session token.
    pub async fn connect(t3_url: &str, bearer: &str) -> Result<Self, Error> {
        let url = ws_url(t3_url, bearer).await?;
        let (socket, _) = tokio::time::timeout(OPEN_TIMEOUT, tokio_tungstenite::connect_async(url))
            .await
            .map_err(|_| Error::Connect("timed out".into()))?
            // Display of a handshake error is its HTTP status or IO cause, never the URL.
            .map_err(|e| Error::Connect(e.to_string()))?;
        let (mut sink, mut source) = socket.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<String>();
        let shared = Arc::new(Shared {
            out,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            closed: watch::channel(None).0,
        });
        let last_frame = Arc::new(Mutex::new(Instant::now()));

        let writer = {
            let shared = shared.clone();
            let mut closed = shared.closed.subscribe();
            tokio::spawn(async move {
                // A `shut` from anywhere (ping timeout, `close`, a failed read) closes the socket here.
                loop {
                    tokio::select! {
                        text = out_rx.recv() => {
                            let Some(text) = text else { break };
                            if let Err(e) = sink.send(Message::text(text)).await {
                                shared.shut(format!("write failed: {e}"));
                                break;
                            }
                        }
                        _ = async { drop(closed.wait_for(Option::is_some).await) } => break,
                    }
                }
                let _ = sink.close().await;
            })
        };
        let reader = {
            let shared = shared.clone();
            let last_frame = last_frame.clone();
            tokio::spawn(async move {
                let reason = loop {
                    let text = match source.next().await {
                        Some(Ok(Message::Text(t))) => t,
                        Some(Ok(Message::Close(f))) => {
                            break format!(
                                "closed by T3{}",
                                f.map(|f| format!(" ({})", f.code)).unwrap_or_default()
                            );
                        }
                        Some(Ok(_)) => continue,
                        Some(Err(e)) => break format!("read failed: {e}"),
                        None => break "socket ended".into(),
                    };
                    *last_frame.lock().unwrap() = Instant::now();
                    match decode_frame(&text) {
                        Ok(messages) => messages.into_iter().for_each(|msg| shared.dispatch(msg)),
                        Err(e) => break format!("undecodable frame: {e}"),
                    }
                };
                shared.shut(reason);
            })
        };
        let pinger = {
            let shared = shared.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(PING_INTERVAL);
                tick.tick().await;
                loop {
                    tick.tick().await;
                    if shared.close_reason().is_some() {
                        return;
                    }
                    if last_frame.lock().unwrap().elapsed() > PING_TIMEOUT {
                        shared.shut("ping timeout".into());
                        return;
                    }
                    shared.send(&ClientMessage::Ping);
                }
            })
        };
        Ok(T3Client {
            conn: Arc::new(Connection {
                shared,
                tasks: vec![writer, reader, pinger],
            }),
        })
    }

    fn shared(&self) -> &Arc<Shared> {
        &self.conn.shared
    }

    /// Resolves once the socket is gone, with why. Reconnect with a fresh `connect`.
    pub async fn closed(&self) -> String {
        let mut rx = self.shared().closed.subscribe();
        loop {
            if let Some(reason) = rx.borrow_and_update().clone() {
                return reason;
            }
            if rx.changed().await.is_err() {
                return "client dropped".into();
            }
        }
    }

    pub fn is_closed(&self) -> bool {
        self.shared().close_reason().is_some()
    }

    /// Closes the socket and fails everything in flight.
    pub fn close(&self) {
        self.shared().shut("closed by fleetd".into());
    }

    fn start(
        &self,
        method: &'static str,
        payload: &impl Serialize,
        pending: Pending,
    ) -> Result<u64, Error> {
        let shared = self.shared();
        let payload = serde_json::to_value(payload).map_err(|e| Error::Decode {
            method,
            message: e.to_string(),
        })?;
        let id = shared.next_id.fetch_add(1, Ordering::Relaxed);
        shared.pending.lock().unwrap().insert(id, pending);
        // Checked after inserting, so a concurrent `shut` either drained the entry or is seen here.
        if let Some(reason) = shared.close_reason() {
            shared.pending.lock().unwrap().remove(&id);
            return Err(Error::Closed(reason));
        }
        shared.send(&ClientMessage::Request {
            id,
            tag: method.into(),
            payload,
            headers: vec![],
        });
        Ok(id)
    }

    async fn call<R: DeserializeOwned>(
        &self,
        method: &'static str,
        payload: &impl Serialize,
    ) -> Result<R, Error> {
        let (tx, rx) = oneshot::channel();
        let id = self.start(method, payload, Pending::Unary(method, tx))?;
        let _guard = InFlight {
            shared: self.shared().clone(),
            id,
        };
        let value = rx
            .await
            .map_err(|_| Error::Closed("client dropped".into()))??;
        serde_json::from_value(value).map_err(|e| Error::Decode {
            method,
            message: e.to_string(),
        })
    }

    fn subscribe<T: DeserializeOwned>(
        &self,
        method: &'static str,
        payload: &impl Serialize,
    ) -> Subscription<T> {
        let (tx, rx) = mpsc::unbounded_channel();
        let state = match self.start(method, payload, Pending::Stream(method, tx)) {
            Ok(id) => SubState::Open { id, rx },
            Err(e) => SubState::Failed(Some(e)),
        };
        Subscription {
            conn: self.conn.clone(),
            method,
            state,
            buffer: VecDeque::new(),
            _t: std::marker::PhantomData,
        }
    }

    pub async fn launch_thread(
        &self,
        input: &LaunchThreadInput,
    ) -> Result<LaunchThreadResult, Error> {
        self.call(m::LAUNCH_THREAD, input).await
    }

    pub async fn dispatch_command(
        &self,
        command: &Command,
    ) -> Result<DispatchCommandResult, Error> {
        self.call(m::DISPATCH_COMMAND, command).await
    }

    pub async fn get_thread_projection(&self, thread_id: &str) -> Result<ThreadProjection, Error> {
        self.call(
            m::GET_THREAD_PROJECTION,
            &ThreadIdInput {
                thread_id: thread_id.into(),
            },
        )
        .await
    }

    pub async fn get_turn_item(
        &self,
        input: &GetTurnItemInput,
    ) -> Result<GetTurnItemResult, Error> {
        self.call(m::GET_TURN_ITEM, input).await
    }

    pub async fn get_turn_diff(&self, input: &GetTurnDiffInput) -> Result<TurnDiff, Error> {
        self.call(m::GET_TURN_DIFF, input).await
    }

    pub async fn get_config(&self) -> Result<ServerConfig, Error> {
        self.call(m::SERVER_GET_CONFIG, &Empty {}).await
    }

    pub async fn get_settings(&self) -> Result<ServerSettings, Error> {
        self.call(m::SERVER_GET_SETTINGS, &Empty {}).await
    }

    pub async fn update_settings(
        &self,
        input: &UpdateSettingsInput,
    ) -> Result<ServerSettings, Error> {
        self.call(m::SERVER_UPDATE_SETTINGS, input).await
    }

    /// Fails with a `ProjectReadFileError` whose `operation` is `realpath-target` when the file does not exist.
    pub async fn read_file(&self, input: &ReadFileInput) -> Result<ReadFileResult, Error> {
        self.call(m::PROJECTS_READ_FILE, input).await
    }

    pub async fn mutate_project(&self, mutation: &ProjectMutation) -> Result<Project, Error> {
        self.call(m::PROJECTS_MUTATE, mutation).await
    }

    pub async fn list_refs(&self, input: &ListRefsInput) -> Result<ListRefsResult, Error> {
        self.call(m::VCS_LIST_REFS, input).await
    }

    /// Without `after_sequence`: a snapshot, then live items. With it: the items after it (or a snapshot when the
    /// cursor is past T3's replay budget), then live items.
    pub fn subscribe_shell(&self, input: &SubscribeShellInput) -> Subscription<ShellStreamItem> {
        self.subscribe(m::SUBSCRIBE_SHELL, input)
    }

    pub fn subscribe_thread(&self, input: &SubscribeThreadInput) -> Subscription<ThreadStreamItem> {
        self.subscribe(m::SUBSCRIBE_THREAD, input)
    }
}

/// Interrupts a unary call whose future was dropped before T3 answered.
struct InFlight {
    shared: Arc<Shared>,
    id: u64,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if self
            .shared
            .pending
            .lock()
            .unwrap()
            .remove(&self.id)
            .is_some()
        {
            self.shared.send(&ClientMessage::Interrupt {
                request_id: self.id,
            });
        }
    }
}

enum SubState {
    Open {
        id: u64,
        rx: mpsc::UnboundedReceiver<StreamEvent>,
    },
    Failed(Option<Error>),
    Done,
}

/// A T3 stream subscription. Each chunk is acked when taken, so T3 sends the next one only as fast as the
/// consumer reads. Ends after T3's exit (an error first if it failed); dropping it early interrupts it on T3.
pub struct Subscription<T> {
    conn: Arc<Connection>,
    method: &'static str,
    state: SubState,
    buffer: VecDeque<Value>,
    _t: std::marker::PhantomData<fn() -> T>,
}

impl<T> Subscription<T> {
    fn interrupt(&mut self) {
        if let SubState::Open { id, .. } = self.state {
            let shared = &self.conn.shared;
            if shared.pending.lock().unwrap().remove(&id).is_some() {
                shared.send(&ClientMessage::Interrupt { request_id: id });
            }
        }
        self.state = SubState::Done;
    }
}

impl<T> Drop for Subscription<T> {
    fn drop(&mut self) {
        self.interrupt();
    }
}

impl<T: DeserializeOwned> Stream for Subscription<T> {
    type Item = Result<T, Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        loop {
            if let Some(value) = this.buffer.pop_front() {
                return Poll::Ready(Some(match serde_json::from_value(value) {
                    Ok(item) => Ok(item),
                    Err(e) => {
                        // Like effect's client: an undecodable element ends its own stream only.
                        this.buffer.clear();
                        this.interrupt();
                        Err(Error::Decode {
                            method: this.method,
                            message: e.to_string(),
                        })
                    }
                }));
            }
            match &mut this.state {
                SubState::Done => return Poll::Ready(None),
                SubState::Failed(e) => {
                    let e = e.take();
                    this.state = SubState::Done;
                    return Poll::Ready(e.map(Err));
                }
                SubState::Open { id, rx } => match rx.poll_recv(cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Some(StreamEvent::Chunk(values))) => {
                        this.conn
                            .shared
                            .send(&ClientMessage::Ack { request_id: *id });
                        this.buffer.extend(values);
                    }
                    Poll::Ready(Some(StreamEvent::End(result))) => {
                        this.state = SubState::Done;
                        if let Err(e) = result {
                            return Poll::Ready(Some(Err(e)));
                        }
                    }
                    Poll::Ready(None) => {
                        let reason = this
                            .conn
                            .shared
                            .close_reason()
                            .unwrap_or_else(|| "client dropped".into());
                        this.state = SubState::Done;
                        return Poll::Ready(Some(Err(Error::Closed(reason))));
                    }
                },
            }
        }
    }
}
