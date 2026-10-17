//! One node link per machine: challenge, hello (signature, enroll token or enrolled key), welcome, then heartbeats,
//! T3 state and sessions, lead calls and command replies until the socket ends. 45 s of silence takes the machine
//! offline. TS spec: apps/hub/src/link/NodeLinkServer.ts.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::hello::{PROTOCOL_VERSION, ProtocolVersion};
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::lead_calls::{LeadCallFrame, LeadResultFrame};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::model::{Machine, MachineStatus, MachineT3};
use fleetd_contracts::node_link::{HubToNode, NodeHello, NodeT3Endpoint, NodeToHub, T3RunState, close};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::commands::NodeCommands;
use super::lead_calls::{LeadCaller, LeadCalls, lead_by, op_of, outside_every_project, project_for_cwd};
use crate::clock::Clock;
use crate::hub::auth::{Auth, AuthError};
use crate::hub::executor::{Executors, T3Session};
use crate::hub::store::{EventLog, HubStore, NewEvent, iso_ms, now_ms};

pub const HEARTBEAT_EVERY: Duration = Duration::from_secs(15);
pub const SILENCE_TIMEOUT: Duration = Duration::from_secs(45);
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

pub struct LinkDeps {
    pub hub_id: String,
    pub store: Arc<HubStore>,
    pub events: Arc<EventLog>,
    pub auth: Arc<Auth>,
    pub executors: Arc<Executors>,
    pub commands: Arc<NodeCommands>,
    pub lead_calls: Arc<LeadCalls>,
    pub clock: Arc<dyn Clock>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Announced {
    Online,
    Degraded,
}

enum Out {
    Frame(HubToNode),
    Close(u16, String),
}

type LinkTx = mpsc::UnboundedSender<Out>;

#[derive(Default)]
struct State {
    /// The live link per machine; a newer link replaces an older one.
    links: HashMap<MachineId, (u64, LinkTx)>,
    /// What this hub process last announced per machine, until it announces the machine offline.
    announced: HashMap<MachineId, Announced>,
    /// Per-machine silence timers. They outlive the socket, so a quick reconnect never flaps.
    watchdogs: HashMap<MachineId, JoinHandle<()>>,
    next_link_id: u64,
}

pub struct NodeLinkServer {
    deps: LinkDeps,
    state: Mutex<State>,
    heartbeat_every: Duration,
    silence_timeout: Duration,
    hello_timeout: Duration,
}

struct Refused {
    code: u16,
    reason: String,
}

fn refuse<T>(code: u16, reason: impl Into<String>) -> Result<T, Refused> {
    Err(Refused { code, reason: reason.into() })
}

/// WebSocket close reasons are capped at 123 bytes.
fn close_reason(reason: &str) -> String {
    if reason.len() <= 123 {
        return reason.to_owned();
    }
    let mut end = 119;
    while !reason.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &reason[..end])
}

/// Raw 32-byte ed25519 public key (base64) verifying `sig` (base64) over the nonce's UTF-8 bytes.
pub fn verify_nonce_signature(pub_key: &str, nonce: &str, sig: &str) -> bool {
    let Ok(raw) = B64.decode(pub_key) else { return false };
    let Ok(raw): Result<[u8; 32], _> = raw.try_into() else { return false };
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&raw) else { return false };
    let Ok(sig) = B64.decode(sig) else { return false };
    let Ok(sig) = ed25519_dalek::Signature::from_slice(&sig) else { return false };
    key.verify_strict(nonce.as_bytes(), &sig).is_ok()
}

fn nonce() -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

fn send(tx: &LinkTx, frame: HubToNode) {
    let _ = tx.send(Out::Frame(frame));
}

fn event(at: &str, kind: &str, machine_id: &MachineId, summary: String, data: Option<serde_json::Value>) -> Option<NewEvent> {
    let draft = json!({ "at": at, "type": kind, "machineId": machine_id, "summary": summary, "data": data });
    match serde_json::from_value(draft) {
        Ok(e) => Some(e),
        Err(e) => {
            tracing::error!(error = %e, kind, "node link: event does not decode");
            None
        }
    }
}

impl NodeLinkServer {
    /// Arms the silence timer for every machine the store says is not offline (after a hub restart the store still
    /// says online for machines whose nodes may never come back, and only a link arms the timer).
    pub fn start(deps: LinkDeps) -> Arc<Self> {
        Self::with_timings(deps, HEARTBEAT_EVERY, SILENCE_TIMEOUT, HELLO_TIMEOUT)
    }

    pub fn with_timings(deps: LinkDeps, heartbeat_every: Duration, silence_timeout: Duration, hello_timeout: Duration) -> Arc<Self> {
        let server = Arc::new(Self { deps, state: Mutex::default(), heartbeat_every, silence_timeout, hello_timeout });
        match server.deps.store.machines_list() {
            Ok(machines) => {
                for m in machines.iter().filter(|m| m.status != MachineStatus::Offline) {
                    server.touch(&m.machine_id);
                }
            }
            Err(e) => tracing::error!(error = %e, "node link: could not list machines"),
        }
        server
    }

    fn now_iso(&self) -> String {
        iso_ms(now_ms(self.deps.clock.as_ref()))
    }

    fn append(&self, e: Option<NewEvent>) {
        if let Some(e) = e
            && let Err(err) = self.deps.events.append(e)
        {
            tracing::error!(error = %err, "node link: event append failed");
        }
    }

    /// Any frame restarts the machine's silence timer.
    fn touch(self: &Arc<Self>, machine_id: &MachineId) {
        let this = self.clone();
        let id = machine_id.clone();
        let timeout = self.silence_timeout;
        let clock = self.deps.clock.clone();
        let handle = tokio::spawn(async move {
            clock.sleep(timeout).await;
            this.mark_offline(&id).await;
        });
        if let Some(old) = self.state.lock().unwrap().watchdogs.insert(machine_id.clone(), handle) {
            old.abort();
        }
    }

    /// Rewrites the stored machine's status (and T3 info, when given); `degraded_reason` is kept only while degraded.
    fn write_status(&self, machine_id: &MachineId, at: &str, status: MachineStatus, reason: Option<&str>, t3: Option<&NodeT3Endpoint>) {
        let stored = match self.deps.store.machine_get(machine_id) {
            Ok(Some(m)) => m,
            Ok(None) => return,
            Err(e) => return tracing::error!(error = %e, "node link: machine read failed"),
        };
        let previous = stored.degraded_reason.clone();
        let mut machine = Machine { status, last_seen_at: Timestamp(at.to_owned()), degraded_reason: None, ..stored };
        if let Some(t3) = t3 {
            machine.t3 = Some(MachineT3 { version: t3.version.clone(), protocol: t3.protocol });
        }
        if status == MachineStatus::Degraded {
            machine.degraded_reason = Some(reason.map(str::to_owned).or(previous).unwrap_or_else(|| "T3 is down".into()));
        }
        if let Err(e) = self.deps.store.machine_upsert(&machine, None) {
            tracing::error!(error = %e, "node link: machine write failed");
        }
    }

    /// Emits machine.online or machine.degraded when the machine's announced status changes.
    fn announce(&self, machine_id: &MachineId, at: &str, status: Announced, reason: Option<&str>) {
        {
            let mut state = self.state.lock().unwrap();
            if state.announced.get(machine_id) == Some(&status) {
                return;
            }
            state.announced.insert(machine_id.clone(), status);
        }
        self.append(match status {
            Announced::Online => event(at, "machine.online", machine_id, format!("{machine_id} is online"), None),
            Announced::Degraded => {
                let reason = reason.unwrap_or_default();
                event(
                    at,
                    "machine.degraded",
                    machine_id,
                    format!("{machine_id} is degraded: {reason}"),
                    Some(json!({ "degradedReason": reason })),
                )
            }
        });
    }

    async fn mark_offline(&self, machine_id: &MachineId) {
        let live = {
            let mut state = self.state.lock().unwrap();
            state.announced.remove(machine_id);
            state.watchdogs.remove(machine_id);
            state.links.remove(machine_id)
        };
        let at = self.now_iso();
        let seconds = self.silence_timeout.as_secs();
        self.write_status(machine_id, &at, MachineStatus::Offline, None, None);
        self.append(event(
            &at,
            "machine.offline",
            machine_id,
            format!("{machine_id} went offline: no word from its node for {seconds} s"),
            None,
        ));
        self.deps.executors.detach(machine_id).await;
        if let Some((_, tx)) = live {
            let _ = tx.send(Out::Close(close::HEARTBEAT_TIMEOUT, format!("no frame for {seconds} s")));
        }
        tracing::info!(machine_id = %machine_id, "node link: machine offline");
    }

    /// Attributes a forwarded call to the project its cwd is in, on the machine whose node sent it, and answers it.
    async fn answer_lead_call(&self, machine_id: &MachineId, frame: LeadCallFrame) -> LeadResultFrame {
        let id = frame.id.clone();
        let outcome = async {
            let projects = self
                .deps
                .store
                .projects_list(Some(machine_id), None)
                .map_err(|_| McpToolError::new(ErrorCode::T3Error, "the hub failed while handling this call").with_fix("try again shortly"))?;
            let cwd = frame.cwd.as_str();
            let Some(project) = project_for_cwd(&projects, cwd) else {
                return Err(outside_every_project(machine_id, cwd, &projects));
            };
            let Some(handler) = self.deps.lead_calls.handler(&op_of(&frame.call)) else {
                return Err(McpToolError::new(ErrorCode::Forbidden, "this hub does not take lead-side calls yet")
                    .with_fix("carry on without this call and mention it in your next status line"));
            };
            let project_ref: fleetd_contracts::ids::ProjectRef = serde_json::from_value(json!({
                "machineId": machine_id, "projectId": project.project_id,
            }))
            .expect("a stored project's ref decodes");
            let caller = LeadCaller { by: lead_by(&project_ref), project_ref, cwd: cwd.to_owned() };
            handler.handle(caller, frame.call).await
        }
        .await;
        let frame = match outcome {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        };
        serde_json::from_value(frame).expect("a lead result frame with exactly one of result and error")
    }

    async fn handshake(&self, ws: &mut Rx, tx: &LinkTx) -> Result<NodeHello, Refused> {
        let nonce = nonce();
        send(tx, serde_json::from_value(json!({ "t": "challenge", "nonce": nonce })).expect("challenge frame"));
        let first = match tokio::time::timeout(self.hello_timeout, next_text(ws)).await {
            Err(_) => return refuse(close::BAD_FRAME, format!("no hello within {} s", self.hello_timeout.as_secs())),
            Ok(None) => return refuse(0, "socket ended"),
            Ok(Some(text)) => text,
        };
        let hello = match serde_json::from_str::<NodeToHub>(&first) {
            Ok(NodeToHub::Hello(hello)) => hello,
            _ => return refuse(close::BAD_FRAME, "expected a hello frame"),
        };
        if hello.protocol.get() != PROTOCOL_VERSION {
            return refuse(
                close::PROTOCOL_MISMATCH,
                format!("hub speaks protocol {PROTOCOL_VERSION}, node speaks {}: install matching fleetd versions", hello.protocol.get()),
            );
        }
        let machine_id = hello.machine_id.clone();
        // Checked before the token, so a bad signature cannot burn someone's enroll token.
        if !verify_nonce_signature(hello.pub_key.as_str(), &nonce, hello.sig.as_str()) {
            return refuse(close::UNAUTHORIZED, "signature does not verify against the hello's key");
        }
        if let Some(token) = &hello.enroll_token {
            return match self.deps.auth.consume_enroll_token(token.as_str(), &machine_id, hello.pub_key.as_str()) {
                Ok(()) => Ok(hello),
                Err(AuthError::Unauthorized(e)) => {
                    refuse(close::UNAUTHORIZED, format!("{}: run fleetd hub token create --machine {machine_id}", e.message))
                }
                Err(e) => {
                    tracing::error!(error = %e, "node link: enroll token check failed");
                    refuse(close::UNAUTHORIZED, "the hub could not check the enroll token")
                }
            };
        }
        match self.deps.auth.node_pub_key(&machine_id) {
            Ok(None) => refuse(
                close::UNAUTHORIZED,
                format!("{machine_id} is not enrolled: run fleetd hub token create --machine {machine_id}, then fleetd node join"),
            ),
            Ok(Some(key)) if key != hello.pub_key.as_str() => {
                refuse(close::UNAUTHORIZED, format!("key does not match the key enrolled for {machine_id}"))
            }
            Ok(Some(_)) => Ok(hello),
            Err(e) => {
                tracing::error!(error = %e, "node link: node key read failed");
                refuse(close::UNAUTHORIZED, "the hub could not read the enrolled key")
            }
        }
    }

    async fn attach_executor(&self, machine_id: &MachineId, t3: &Option<NodeT3Endpoint>, bearer: &Option<String>) {
        if let (Some(t3), Some(bearer)) = (t3, bearer) {
            self.deps.executors.attach(machine_id, T3Session { t3_url: t3.url.clone(), bearer: bearer.clone() }).await;
        }
    }

    async fn serve(self: &Arc<Self>, ws: &mut Rx, tx: &LinkTx) -> Result<(), Refused> {
        let hello = self.handshake(ws, tx).await?;
        let machine_id = hello.machine_id.clone();

        let (id, previous) = {
            let mut state = self.state.lock().unwrap();
            state.next_link_id += 1;
            let id = state.next_link_id;
            (id, state.links.insert(machine_id.clone(), (id, tx.clone())))
        };
        if let Some((_, previous)) = previous {
            let _ = previous.send(Out::Close(close::REPLACED, "a newer link for this machine took over".into()));
        }
        let _unlink = Unlink { server: self.clone(), machine_id: machine_id.clone(), id };

        // The T3 to attach while the node reports it up; None while it is down.
        let mut t3 = hello.t3.clone();
        let mut bearer: Option<String> = None;

        let at = self.now_iso();
        let stored = self.deps.store.machine_get(&machine_id).ok().flatten();
        let hello_reason = "its node cannot reach T3";
        let machine: Machine = serde_json::from_value(json!({
            "machineId": machine_id,
            "name": hello.name,
            "tags": hello.tags,
            "status": if t3.is_none() { "degraded" } else { "online" },
            "lastSeenAt": at,
            // A machine whose T3 is down keeps the version it last reported.
            "t3": match &t3 {
                Some(t3) => json!({ "version": t3.version, "protocol": t3.protocol }),
                None => json!(stored.and_then(|m| m.t3)),
            },
            "nodeVersion": hello.node_version,
            // Browsers seal this machine's secrets to it; a node from before M8 sends none and takes none.
            "boxPubKey": hello.box_pub_key,
            "degradedReason": if t3.is_none() { Some(hello_reason) } else { None },
        }))
        .map_err(|e| Refused { code: close::BAD_FRAME, reason: format!("hello does not make a machine: {e}") })?;
        if let Err(e) = self.deps.store.machine_upsert(&machine, None) {
            tracing::error!(error = %e, "node link: machine write failed");
        }
        self.touch(&machine_id);
        send(tx, HubToNode::Welcome(serde_json::from_value(json!({ "hubId": self.deps.hub_id, "protocol": ProtocolVersion::CURRENT })).expect("welcome")));
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<HubToNode>();
        let forward = {
            let tx = tx.clone();
            tokio::spawn(async move {
                while let Some(frame) = cmd_rx.recv().await {
                    send(&tx, frame);
                }
            })
        };
        let _forward = AbortOnDrop(forward);
        let _commands = self.deps.commands.attach(&machine_id, cmd_tx);
        // After the attach, so whoever acts on the announcement can already run commands on the machine.
        if t3.is_none() {
            self.announce(&machine_id, &at, Announced::Degraded, Some(hello_reason));
        } else {
            self.announce(&machine_id, &at, Announced::Online, None);
        }
        tracing::info!(machine_id = %machine_id, link_id = id, "node link: welcomed");

        let heartbeat = {
            let tx = tx.clone();
            let clock = self.deps.clock.clone();
            let every = self.heartbeat_every;
            tokio::spawn(async move {
                loop {
                    clock.sleep(every).await;
                    let at = iso_ms(now_ms(clock.as_ref()));
                    send(&tx, serde_json::from_value(json!({ "t": "hb", "at": at })).expect("hb frame"));
                }
            })
        };
        let _heartbeat = AbortOnDrop(heartbeat);

        loop {
            let Some(text) = next_text(ws).await else { return Ok(()) };
            let frame = match serde_json::from_str::<NodeToHub>(&text) {
                Ok(f) => f,
                Err(_) => return refuse(close::BAD_FRAME, "frame does not decode"),
            };
            // A replaced or timed-out link must not keep the machine alive.
            if self.state.lock().unwrap().links.get(&machine_id).map(|l| l.0) != Some(id) {
                return Ok(());
            }
            self.touch(&machine_id);
            match frame {
                NodeToHub::Heartbeat(_) => {
                    let status = match self.state.lock().unwrap().announced.get(&machine_id) {
                        Some(Announced::Degraded) => MachineStatus::Degraded,
                        _ => MachineStatus::Online,
                    };
                    let at = Timestamp(self.now_iso());
                    if let Err(e) = self.deps.store.machine_set_status(&machine_id, status, &at) {
                        tracing::error!(error = %e, "node link: status write failed");
                    }
                }
                NodeToHub::T3Session(session) => {
                    bearer = Some(session.bearer.as_str().to_owned());
                    // Kept for when T3 is back if it is down now.
                    if t3.is_none() {
                        continue;
                    }
                    self.attach_executor(&machine_id, &t3, &bearer).await;
                    tracing::info!(machine_id = %machine_id, expires_at = %session.expires_at.0, "node link: t3 session attached");
                }
                NodeToHub::T3State(state) => {
                    let at = self.now_iso();
                    if state.state == T3RunState::Up {
                        t3 = state.t3.clone().or_else(|| hello.t3.clone());
                        self.write_status(&machine_id, &at, MachineStatus::Online, None, t3.as_ref());
                        self.announce(&machine_id, &at, Announced::Online, None);
                        // The node re-mints right after this, and that session reattaches; the last one may still work.
                        self.attach_executor(&machine_id, &t3, &bearer).await;
                    } else {
                        t3 = None;
                        let reason = state.reason.clone().unwrap_or_else(|| {
                            if state.state == T3RunState::Restarting { "T3 is restarting" } else { "T3 is down" }.into()
                        });
                        self.write_status(&machine_id, &at, MachineStatus::Degraded, Some(&reason), None);
                        self.announce(&machine_id, &at, Announced::Degraded, Some(&reason));
                        self.deps.executors.detach(&machine_id).await;
                    }
                    tracing::info!(machine_id = %machine_id, state = ?state.state, "node link: t3 state");
                }
                NodeToHub::LeadCall(call) => {
                    // Off the frame loop: a slow call must not hold up heartbeats or other calls.
                    let this = self.clone();
                    let tx = tx.clone();
                    let machine_id = machine_id.clone();
                    tokio::spawn(async move {
                        let result = this.answer_lead_call(&machine_id, call).await;
                        send(&tx, HubToNode::LeadResult(result));
                    });
                }
                reply @ (NodeToHub::CmdResult(_)
                | NodeToHub::SecretResult(_)
                | NodeToHub::GatedResult(_)
                | NodeToHub::NodeActionResult(_)) => self.deps.commands.resolve(&machine_id, reply),
                NodeToHub::Hello(_) => return refuse(close::BAD_FRAME, "hello after welcome"),
            }
        }
    }

    /// Runs one node link until the socket ends (the framework's node WebSocket route calls this). Never fails:
    /// refusals close the socket with a NodeLinkClose code.
    pub async fn handle(self: &Arc<Self>, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
        let writer = tokio::spawn(async move {
            while let Some(out) = rx.recv().await {
                let message = match out {
                    Out::Frame(frame) => match serde_json::to_string(&frame) {
                        Ok(text) => Message::Text(text.into()),
                        Err(_) => continue,
                    },
                    Out::Close(code, reason) => {
                        let reason = Utf8Bytes::from(close_reason(&reason));
                        let _ = sink.send(Message::Close(Some(CloseFrame { code, reason }))).await;
                        return;
                    }
                };
                if sink.send(message).await.is_err() {
                    return;
                }
            }
        });
        let result = self.serve(&mut stream, &tx).await;
        if let Err(refused) = result
            && refused.code != 0
        {
            tracing::info!(code = refused.code, reason = %refused.reason, "node link: refused");
            let _ = tx.send(Out::Close(refused.code, refused.reason));
        }
        drop(tx);
        let _ = writer.await;
    }
}

type Rx = futures_util::stream::SplitStream<WebSocket>;

/// The next text frame; None once the socket closes or fails.
async fn next_text(rx: &mut Rx) -> Option<String> {
    while let Some(message) = rx.next().await {
        match message {
            Ok(Message::Text(text)) => return Some(text.to_string()),
            Ok(Message::Binary(bytes)) => return Some(String::from_utf8_lossy(&bytes).into_owned()),
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            Ok(Message::Close(_)) | Err(_) => return None,
        }
    }
    None
}

/// Keeps the link's registration and command attachment for as long as `serve` runs.
struct Unlink {
    server: Arc<NodeLinkServer>,
    machine_id: MachineId,
    id: u64,
}

impl Drop for Unlink {
    fn drop(&mut self) {
        let mut state = self.server.state.lock().unwrap();
        if state.links.get(&self.machine_id).map(|l| l.0) == Some(self.id) {
            state.links.remove(&self.machine_id);
        }
    }
}

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}
