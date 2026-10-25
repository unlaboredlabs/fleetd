//! One node link per machine: challenge, hello (signature, enroll token or enrolled key), welcome, then heartbeats,
//! session frames, lead calls and command replies until the socket ends. 45 s of silence takes the machine offline.
//! A linked machine is online while its node's runner is usable (`runner_info`: a supported version, logged in) and
//! degraded with the runner's problem otherwise.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::events::Attention;
use fleetd_contracts::hello::{PROTOCOL_VERSION, ProtocolVersion};
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::lead_calls::{LeadCallFrame, LeadResultFrame};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::model::{Machine, MachineStatus, SleptSpan, duration_text};
use fleetd_contracts::node_link::{
    HEARTBEAT_INTERVAL_SECS, HEARTBEAT_TIMEOUT_SECS, HubToNode, NodeHello, NodeLoad, NodeToHub,
    close,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::commands::NodeCommands;
use super::lead_calls::{LeadCaller, LeadCalls, lead_by, op_of};
use crate::clock::Clock;
use crate::hub::auth::{Auth, AuthError};
use crate::hub::executor::providers::runner_problem;
use crate::hub::executor::{Executors, NodeSessions};
use crate::hub::store::{EventLog, HubStore, NewEvent, iso_ms, now_ms};

const HEARTBEAT_EVERY: Duration = Duration::from_secs(HEARTBEAT_INTERVAL_SECS);
const SILENCE_TIMEOUT: Duration = Duration::from_secs(HEARTBEAT_TIMEOUT_SECS);
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// How many heartbeats apart the hub re-reads the runner's state, so a fixed or expired login shows within a minute.
const RUNNER_CHECK_EVERY: u32 = 4;

pub struct LinkDeps {
    pub hub_id: String,
    pub store: Arc<HubStore>,
    pub events: Arc<EventLog>,
    pub auth: Arc<Auth>,
    pub executors: Arc<Executors>,
    pub commands: Arc<NodeCommands>,
    pub lead_calls: Arc<LeadCalls>,
    pub clock: Arc<dyn Clock>,
    pub time: Arc<crate::hub::time::Time>,
    /// Sizes each machine's cap from its heartbeat's facts.
    pub slots: Arc<crate::hub::slots::Slots>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Announced {
    Online,
    Degraded,
}

enum Out {
    Frame(Box<HubToNode>),
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
    /// The latest load each node reported with its heartbeat; dropped when the machine goes offline.
    loads: HashMap<MachineId, NodeLoad>,
    /// Machines the guard or the usage soft brake pauses new agents on; dropped when the machine goes offline.
    paused: HashMap<MachineId, Paused>,
    /// What each live link's node said it understands in its hello.
    capabilities: HashMap<MachineId, Vec<String>>,
}

/// Why a machine takes no new agents: the line that says so, and which of the two holds it (each resumes past its own
/// margin).
#[derive(Clone)]
struct Paused {
    text: String,
    guard: bool,
    brake: bool,
}

impl NodeLinkServer {
    /// The load the machine's node last reported; None from older nodes, offline machines or a failed read.
    pub fn load(&self, machine_id: &MachineId) -> Option<NodeLoad> {
        self.state.lock().unwrap().loads.get(machine_id).cloned()
    }

    /// Why new agents wait on the machine, e.g. "Paused new agents: 14 GB free on builder-1"; None while they start.
    pub fn paused(&self, machine_id: &MachineId) -> Option<String> {
        let state = self.state.lock().unwrap();
        state.paused.get(machine_id).map(|p| p.text.clone())
    }

    /// Keeps a heartbeat's load, hands its facts to the slot board, and runs the guard and the usage soft brake over
    /// it. `machine.guard` marks each pause and resume, which starts waiting agents again and refreshes the project
    /// rows; the line's figure updates with every heartbeat.
    /// `node_at` is the heartbeat's time on the node's clock: the soft brake ages a usage reading by it.
    pub fn observe_load(&self, machine_id: &MachineId, load: Option<NodeLoad>, node_at: &str) {
        let now = now_ms(self.deps.clock.as_ref());
        let node_now = crate::hub::store::parse_ms(node_at).unwrap_or(now);
        if let Some(load) = &load {
            let name = match self.deps.store.machine_get(machine_id) {
                Ok(Some(m)) => m.name,
                _ => machine_id.to_string(),
            };
            if let Err(e) = self.deps.slots.observe_machine(machine_id, &name, load) {
                tracing::warn!(error = %e, "node link: machine facts not applied to the slot board");
            }
        }
        let (was, why, brake) = {
            let mut state = self.state.lock().unwrap();
            let was = state.paused.get(machine_id).cloned();
            let why = load
                .as_ref()
                .and_then(|l| super::guard::why(l, was.as_ref().is_some_and(|p| p.guard)));
            let brake = load.as_ref().and_then(|l| {
                crate::hub::usage::state::brake(
                    &l.limits,
                    was.as_ref().is_some_and(|p| p.brake),
                    now,
                    node_now,
                )
            });
            match load {
                Some(load) => state.loads.insert(machine_id.clone(), load),
                None => state.loads.remove(machine_id),
            };
            (was.is_some(), why, brake)
        };
        if why.is_none() && brake.is_none() && !was {
            return;
        }
        let name = match self.deps.store.machine_get(machine_id) {
            Ok(Some(m)) => m.name,
            _ => machine_id.to_string(),
        };
        // The guard's line first: a full disk outlasts a usage window.
        let text = why
            .as_ref()
            .map(|why| super::guard::paused_text(why, &name))
            .or_else(|| brake.as_ref().map(|b| b.text(&name)));
        {
            let mut state = self.state.lock().unwrap();
            match &text {
                Some(text) => state.paused.insert(
                    machine_id.clone(),
                    Paused {
                        text: text.clone(),
                        guard: why.is_some(),
                        brake: brake.is_some(),
                    },
                ),
                None => state.paused.remove(machine_id),
            };
        }
        if was != text.is_some() {
            let summary = text.unwrap_or_else(|| format!("New agents start again on {name}"));
            self.append(event(
                &self.now_iso(),
                "machine.guard",
                machine_id,
                summary,
                Some(json!({ "paused": !was })),
            ));
        }
    }

    /// Whether the machine's live node listed `capability` in its hello.
    pub fn node_can(&self, machine_id: &MachineId, capability: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .capabilities
            .get(machine_id)
            .is_some_and(|caps| caps.iter().any(|c| c == capability))
    }
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
    Err(Refused {
        code,
        reason: reason.into(),
    })
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
    let Ok(raw) = B64.decode(pub_key) else {
        return false;
    };
    let Ok(raw): Result<[u8; 32], _> = raw.try_into() else {
        return false;
    };
    let Ok(key) = ed25519_dalek::VerifyingKey::from_bytes(&raw) else {
        return false;
    };
    let Ok(sig) = B64.decode(sig) else {
        return false;
    };
    let Ok(sig) = ed25519_dalek::Signature::from_slice(&sig) else {
        return false;
    };
    key.verify_strict(nonce.as_bytes(), &sig).is_ok()
}

fn nonce() -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

fn send(tx: &LinkTx, frame: HubToNode) {
    let _ = tx.send(Out::Frame(Box::new(frame)));
}

fn event(
    at: &str,
    kind: &str,
    machine_id: &MachineId,
    summary: String,
    data: Option<serde_json::Value>,
) -> Option<NewEvent> {
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
    pub fn new(deps: LinkDeps) -> Arc<Self> {
        Self::with_timings(deps, HEARTBEAT_EVERY, SILENCE_TIMEOUT, HELLO_TIMEOUT)
    }

    pub fn with_timings(
        deps: LinkDeps,
        heartbeat_every: Duration,
        silence_timeout: Duration,
        hello_timeout: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            deps,
            state: Mutex::default(),
            heartbeat_every,
            silence_timeout,
            hello_timeout,
        })
    }

    /// Arms the silence timer for every machine the store says is not offline: after a hub restart the store still
    /// says online for machines whose nodes may never come back, and only a link arms the timer.
    pub fn start(self: &Arc<Self>) {
        match self.deps.store.machines_list() {
            Ok(machines) => {
                for m in machines
                    .iter()
                    .filter(|m| m.status != MachineStatus::Offline)
                {
                    self.touch(&m.machine_id);
                }
            }
            Err(e) => tracing::error!(error = %e, "node link: could not list machines"),
        }
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
        if let Some(old) = self
            .state
            .lock()
            .unwrap()
            .watchdogs
            .insert(machine_id.clone(), handle)
        {
            old.abort();
        }
    }

    /// Rewrites the stored machine's status; `degraded_reason` is kept only while degraded.
    fn write_status(
        &self,
        machine_id: &MachineId,
        at: &str,
        status: MachineStatus,
        reason: Option<&str>,
    ) {
        let stored = match self.deps.store.machine_get(machine_id) {
            Ok(Some(m)) => m,
            Ok(None) => return,
            Err(e) => return tracing::error!(error = %e, "node link: machine read failed"),
        };
        let previous = stored.degraded_reason.clone();
        // Going offline is silence, not a sighting: keep the last heartbeat's time.
        let last_seen_at = if status == MachineStatus::Offline {
            stored.last_seen_at.clone()
        } else {
            Timestamp(at.to_owned())
        };
        let mut machine = Machine {
            status,
            last_seen_at,
            degraded_reason: None,
            ..stored
        };
        if status == MachineStatus::Degraded {
            machine.degraded_reason = Some(
                reason
                    .map(str::to_owned)
                    .or(previous)
                    .unwrap_or_else(|| "its node's runner is unavailable".into()),
            );
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
            Announced::Online => event(
                at,
                "machine.online",
                machine_id,
                format!("{machine_id} is online"),
                None,
            ),
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

    /// The node woke from sleep: kept on the machine for the status views, and logged as machine.slept.
    fn slept(&self, machine_id: &MachineId, span: SleptSpan) {
        let stored = match self.deps.store.machine_get(machine_id) {
            Ok(Some(m)) => m,
            Ok(None) => return,
            Err(e) => return tracing::error!(error = %e, "node link: machine read failed"),
        };
        let machine = Machine {
            last_slept: Some(span),
            ..stored
        };
        if let Err(e) = self.deps.store.machine_upsert(&machine, None) {
            tracing::error!(error = %e, "node link: machine write failed");
        }
        self.append(event(
            &self.now_iso(),
            "machine.slept",
            machine_id,
            format!("{machine_id} slept {}", duration_text(span.ms())),
            Some(json!({ "fromMs": span.from_ms, "toMs": span.to_ms })),
        ));
    }

    async fn mark_offline(&self, machine_id: &MachineId) {
        let live = {
            let mut state = self.state.lock().unwrap();
            state.announced.remove(machine_id);
            state.watchdogs.remove(machine_id);
            state.loads.remove(machine_id);
            state.paused.remove(machine_id);
            state.links.remove(machine_id)
        };
        let at = self.now_iso();
        let seconds = self.silence_timeout.as_secs();
        self.write_status(machine_id, &at, MachineStatus::Offline, None);
        // It needs the human only while runs were going there: nobody is watching them now.
        let running = match self.deps.store.threads_running() {
            Ok(threads) => threads.iter().any(|t| &t.machine_id == machine_id),
            Err(e) => {
                tracing::error!(error = %e, "node link: running threads read failed");
                false
            }
        };
        let mut offline = event(
            &at,
            "machine.offline",
            machine_id,
            format!("{machine_id} went offline: no word from its node for {seconds} s"),
            None,
        );
        if let Some(e) = offline.as_mut()
            && running
        {
            e.attention = Some(Attention::Loud);
        }
        self.append(offline);
        self.deps.executors.detach(machine_id).await;
        if let Some((_, tx)) = live {
            let _ = tx.send(Out::Close(
                close::HEARTBEAT_TIMEOUT,
                format!("no frame for {seconds} s"),
            ));
        }
        tracing::info!(machine_id = %machine_id, "node link: machine offline");
    }

    /// Attributes a forwarded call to the project its cwd is in, on the machine whose node sent it, and answers it.
    async fn answer_lead_call(
        &self,
        machine_id: &MachineId,
        frame: LeadCallFrame,
    ) -> LeadResultFrame {
        let id = frame.id.clone();
        let outcome = async {
            let projects = self
                .deps
                .store
                .projects_list(Some(machine_id), None)
                .map_err(|_| {
                    McpToolError::new(ErrorCode::Failed, "the hub failed while handling this call")
                        .with_fix("try again shortly")
                })?;
            let cwd = frame.cwd.as_str();
            let thread = frame
                .thread_id
                .map(|thread_id| fleetd_contracts::ids::ThreadRef {
                    machine_id: machine_id.clone(),
                    thread_id,
                });
            let project_ref =
                self.deps
                    .lead_calls
                    .call_project(machine_id, &projects, cwd, thread.as_ref())?;
            let Some(handler) = self.deps.lead_calls.handler(&op_of(&frame.call)) else {
                return Err(McpToolError::new(
                    ErrorCode::Forbidden,
                    "this hub does not take lead-side calls yet",
                )
                .with_fix("carry on without this call and say so in your result"));
            };
            let agent = self
                .deps
                .lead_calls
                .agent_of(thread.as_ref(), &project_ref)?;
            crate::hub::tasks::policy::check(&agent, &op_of(&frame.call))?;
            let caller = LeadCaller {
                by: lead_by(&project_ref),
                project_ref,
                agent,
            };
            handler.handle(caller, frame.call).await
        }
        .await;
        let frame = match outcome {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(error) => json!({ "id": id, "error": error }),
        };
        serde_json::from_value(frame)
            .expect("a lead result frame with exactly one of result and error")
    }

    async fn handshake(&self, ws: &mut Rx, tx: &LinkTx) -> Result<NodeHello, Refused> {
        let nonce = nonce();
        send(
            tx,
            serde_json::from_value(json!({ "t": "challenge", "nonce": nonce }))
                .expect("challenge frame"),
        );
        let first = match tokio::time::timeout(self.hello_timeout, next_text(ws)).await {
            Err(_) => {
                return refuse(
                    close::BAD_FRAME,
                    format!("no hello within {} s", self.hello_timeout.as_secs()),
                );
            }
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
                format!(
                    "hub speaks protocol {PROTOCOL_VERSION}, node speaks {}: install matching fleetd versions",
                    hello.protocol.get()
                ),
            );
        }
        let machine_id = hello.machine_id.clone();
        // Checked before the token, so a bad signature cannot burn someone's enroll token.
        if !verify_nonce_signature(hello.pub_key.as_str(), &nonce, hello.sig.as_str()) {
            return refuse(
                close::UNAUTHORIZED,
                "signature does not verify against the hello's key",
            );
        }
        if let Some(token) = &hello.enroll_token {
            return match self.deps.auth.consume_enroll_token(
                token.as_str(),
                &machine_id,
                hello.pub_key.as_str(),
            ) {
                Ok(()) => Ok(hello),
                Err(AuthError::Unauthorized(e)) => refuse(
                    close::UNAUTHORIZED,
                    format!(
                        "{}: run fleetd pair --worker {machine_id} on the hub",
                        e.message
                    ),
                ),
                Err(e) => {
                    tracing::error!(error = %e, "node link: enroll token check failed");
                    refuse(
                        close::UNAUTHORIZED,
                        "the hub could not check the enroll token",
                    )
                }
            };
        }
        match self.deps.auth.node_pub_key(&machine_id) {
            Ok(None) => refuse(
                close::UNAUTHORIZED,
                format!(
                    "{machine_id} is not enrolled: run fleetd pair --worker {machine_id} on the hub"
                ),
            ),
            Ok(Some(key)) if key != hello.pub_key.as_str() => refuse(
                close::UNAUTHORIZED,
                format!("key does not match the key enrolled for {machine_id}"),
            ),
            Ok(Some(_)) => Ok(hello),
            Err(e) => {
                tracing::error!(error = %e, "node link: node key read failed");
                refuse(
                    close::UNAUTHORIZED,
                    "the hub could not read the enrolled key",
                )
            }
        }
    }

    /// Asks the node how its runner is, and announces the machine online or degraded by the answer.
    fn check_runner(self: &Arc<Self>, machine_id: &MachineId) {
        let this = self.clone();
        let machine_id = machine_id.clone();
        tokio::spawn(async move {
            let problem = match this.deps.executors.runner_info(&machine_id).await {
                Ok(info) => runner_problem(&info),
                Err(e) => Some(e.to_string()),
            };
            this.apply_runner(&machine_id, problem);
        });
    }

    /// Follows the runner the node pushes (a probe, a login that expired or came back) while the link lives.
    fn follow_runner(self: &Arc<Self>, machine_id: &MachineId) -> JoinHandle<()> {
        let this = self.clone();
        let machine_id = machine_id.clone();
        let mut runner = self.deps.executors.runner_watch(&machine_id);
        tokio::spawn(async move {
            while runner.changed().await.is_ok() {
                let problem = runner.borrow_and_update().as_ref().map(runner_problem);
                if let Some(problem) = problem {
                    this.apply_runner(&machine_id, problem);
                }
            }
        })
    }

    /// Online when `problem` is None, else degraded with it.
    fn apply_runner(&self, machine_id: &MachineId, problem: Option<String>) {
        // A link that went away meanwhile must not announce anything.
        if !self.state.lock().unwrap().links.contains_key(machine_id) {
            return;
        }
        let at = self.now_iso();
        match problem {
            None => {
                self.write_status(machine_id, &at, MachineStatus::Online, None);
                self.announce(machine_id, &at, Announced::Online, None);
                // After machine.online is logged, so no queued write reaches the machine before it.
                self.deps.executors.set_runner_ready(machine_id, true);
            }
            Some(reason) => {
                self.deps.executors.set_runner_ready(machine_id, false);
                let status = MachineStatus::Degraded;
                self.write_status(machine_id, &at, status, Some(&reason));
                self.announce(machine_id, &at, Announced::Degraded, Some(&reason));
            }
        }
    }

    async fn serve(self: &Arc<Self>, ws: &mut Rx, tx: &LinkTx) -> Result<(), Refused> {
        let hello = self.handshake(ws, tx).await?;
        let machine_id = hello.machine_id.clone();

        let (id, previous) = {
            let mut state = self.state.lock().unwrap();
            state.next_link_id += 1;
            let id = state.next_link_id;
            state
                .capabilities
                .insert(machine_id.clone(), hello.capabilities.clone());
            (id, state.links.insert(machine_id.clone(), (id, tx.clone())))
        };
        if let Some((_, previous)) = previous {
            let _ = previous.send(Out::Close(
                close::REPLACED,
                "a newer link for this machine took over".into(),
            ));
        }
        let _unlink = Unlink {
            server: self.clone(),
            machine_id: machine_id.clone(),
            id,
        };

        let at = self.now_iso();
        let hello_reason = "checking the node's claude runner";
        let last_slept = match self.deps.store.machine_get(&machine_id) {
            Ok(stored) => stored.and_then(|m| m.last_slept),
            Err(_) => None,
        };
        let machine: Machine = serde_json::from_value(json!({
            "machineId": machine_id,
            "name": hello.name,
            "tags": hello.tags,
            // Until the runner check answers.
            "status": "degraded",
            "lastSeenAt": at,
            "nodeVersion": hello.node_version,
            // Browsers seal this machine's secrets to it; a node from before M8 sends none and takes none.
            "boxPubKey": hello.box_pub_key,
            "degradedReason": hello_reason,
            "lastSlept": last_slept,
        }))
        .map_err(|e| Refused {
            code: close::BAD_FRAME,
            reason: format!("hello does not make a machine: {e}"),
        })?;
        if let Err(e) = self.deps.store.machine_upsert(&machine, None) {
            tracing::error!(error = %e, "node link: machine write failed");
        }
        self.touch(&machine_id);
        send(
            tx,
            HubToNode::Welcome(
                serde_json::from_value(
                    json!({ "hubId": self.deps.hub_id, "protocol": ProtocolVersion::CURRENT }),
                )
                .expect("welcome"),
            ),
        );
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
        self.deps
            .executors
            .attach(
                &machine_id,
                NodeSessions {
                    link_id: id,
                    send: cmd_tx.clone(),
                },
            )
            .await;
        let _sessions = DetachSessions {
            executors: self.deps.executors.clone(),
            machine_id: machine_id.clone(),
            link_id: id,
        };
        let _commands = self.deps.commands.attach(&machine_id, cmd_tx);
        // After the attaches, so whoever acts on the announcement can already run commands and sessions there.
        let _runner = AbortOnDrop(self.follow_runner(&machine_id));
        self.check_runner(&machine_id);
        tracing::info!(machine_id = %machine_id, link_id = id, "node link: welcomed");

        let heartbeat = {
            let tx = tx.clone();
            let clock = self.deps.clock.clone();
            let every = self.heartbeat_every;
            tokio::spawn(async move {
                loop {
                    clock.sleep(every).await;
                    let at = iso_ms(now_ms(clock.as_ref()));
                    send(
                        &tx,
                        serde_json::from_value(json!({ "t": "hb", "at": at })).expect("hb frame"),
                    );
                }
            })
        };
        let _heartbeat = AbortOnDrop(heartbeat);
        let mut beats: u32 = 0;

        loop {
            let Some(text) = next_text(ws).await else {
                return Ok(());
            };
            let frame = match serde_json::from_str::<NodeToHub>(&text) {
                Ok(f) => f,
                Err(_) => return refuse(close::BAD_FRAME, "frame does not decode"),
            };
            // A replaced or timed-out link must not keep the machine alive.
            if self
                .state
                .lock()
                .unwrap()
                .links
                .get(&machine_id)
                .map(|l| l.0)
                != Some(id)
            {
                return Ok(());
            }
            self.touch(&machine_id);
            match frame {
                NodeToHub::Heartbeat(beat) => {
                    self.deps
                        .time
                        .heartbeat(machine_id.as_str(), beat.at.as_str());
                    self.observe_load(&machine_id, beat.load, beat.at.as_str());
                    let status = {
                        let state = self.state.lock().unwrap();
                        match state.announced.get(&machine_id) {
                            Some(Announced::Degraded) => MachineStatus::Degraded,
                            _ => MachineStatus::Online,
                        }
                    };
                    let at = Timestamp(self.now_iso());
                    if let Err(e) = self.deps.store.machine_set_status(&machine_id, status, &at) {
                        tracing::error!(error = %e, "node link: status write failed");
                    }
                    beats = beats.wrapping_add(1);
                    if beats.is_multiple_of(RUNNER_CHECK_EVERY) {
                        self.check_runner(&machine_id);
                    }
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
                frame @ (NodeToHub::SessionReply(_)
                | NodeToHub::MachineEvent(_)
                | NodeToHub::ThreadEvent(_)
                | NodeToHub::CloneProgress(_)) => {
                    self.deps.executors.handle_frame(&machine_id, frame)
                }
                NodeToHub::Slept(span) => self.slept(&machine_id, span),
                NodeToHub::Spans(frame) => {
                    let tx = tx.clone();
                    self.deps.time.node_spans(crate::hub::time::NodeBatch {
                        machine_id: machine_id.to_string(),
                        frame,
                        ack: Box::new(move |ack: crate::hub::time::Ack| {
                            send(
                                &tx,
                                HubToNode::SpansAck(fleetd_contracts::node_link::SpansAck {
                                    upto: ack.upto,
                                    rewind: ack.rewind.then_some(true),
                                }),
                            )
                        }),
                    });
                }
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
                    Out::Frame(frame) => match serde_json::to_string(&*frame) {
                        Ok(text) => Message::Text(text.into()),
                        Err(_) => continue,
                    },
                    Out::Close(code, reason) => {
                        let reason = Utf8Bytes::from(close_reason(&reason));
                        let _ = sink
                            .send(Message::Close(Some(CloseFrame { code, reason })))
                            .await;
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
            Ok(Message::Binary(bytes)) => {
                return Some(String::from_utf8_lossy(&bytes).into_owned());
            }
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
            state.capabilities.remove(&self.machine_id);
        }
    }
}

/// Hands the executor's hold on this link back when the link ends, however it ends.
struct DetachSessions {
    executors: Arc<Executors>,
    machine_id: MachineId,
    link_id: u64,
}

impl Drop for DetachSessions {
    fn drop(&mut self) {
        let executors = self.executors.clone();
        let (machine_id, link_id) = (self.machine_id.clone(), self.link_id);
        tokio::spawn(async move { executors.detach_link(&machine_id, link_id).await });
    }
}

struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// `fleetd-<hostname>`, the name the hub gives itself in its welcome.
pub fn hub_id() -> String {
    let host = std::fs::read_to_string("/proc/sys/kernel/hostname")
        .or_else(|_| std::fs::read_to_string("/etc/hostname"))
        .map(|h| h.trim().to_owned())
        .unwrap_or_default();
    format!(
        "fleetd-{}",
        if host.is_empty() { "localhost" } else { &host }
    )
}
