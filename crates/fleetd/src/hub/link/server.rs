//! One node link per machine: challenge, hello (signature, enroll token or enrolled key), welcome, then heartbeats,
//! session frames, lead calls and command replies until the socket ends. 45 s of silence takes the machine offline.
//! A linked machine is online while its node's runner is usable (`runner_info`: a supported version, logged in) and
//! degraded with the runner's problem otherwise, or with its network's when it has no IPv4 and GitHub doesn't answer it
//! (link/network.rs).
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::hello::{PROTOCOL_VERSION, ProtocolVersion};
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallFrame, LeadResultFrame};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::model::{Machine, MachineStatus, SleptSpan, duration_text};
use fleetd_contracts::node_link::{
    HEARTBEAT_INTERVAL_SECS, HEARTBEAT_TIMEOUT_SECS, HubToNode, NodeBusy, NodeHello, NodeLoad,
    NodeToHub, close,
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
use crate::link_frames::{BadFrames, Undecodable};

const HEARTBEAT_EVERY: Duration = Duration::from_secs(HEARTBEAT_INTERVAL_SECS);
const SILENCE_TIMEOUT: Duration = Duration::from_secs(HEARTBEAT_TIMEOUT_SECS);
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// How many heartbeats apart the hub re-reads the runner's state, so a fixed or expired login shows within a minute.
const RUNNER_CHECK_EVERY: u32 = 4;
/// How often a link checks that bytes still arrive while no whole frame has (one large frame coming in slowly).
const PROGRESS_EVERY: Duration = Duration::from_secs(5);
/// How long a link may keep heartbeating while its executor isn't live before the hub attaches its sessions again:
/// otherwise a subscription lost on a healthy link leaves the machine offline until its node restarts.
const REATTACH_AFTER: Duration = Duration::from_secs(30);
/// The most one compressed node frame may inflate to: the socket's own message cap, a put_file's 64 MiB.
const MAX_INFLATED: usize = 64 << 20;

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
    /// Every frame after this one goes compressed (`link_deflate`): sent right after the welcome, to a node whose
    /// hello listed it.
    Deflate,
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
    /// What keeps each machine busy, as its node's latest heartbeat said; dropped when the machine goes offline.
    busy: HashMap<MachineId, NodeBusy>,
    /// Machines the guard or the usage soft brake pauses new agents on; dropped when the machine goes offline.
    paused: HashMap<MachineId, Paused>,
    /// What each live link's node said it understands in its hello.
    capabilities: HashMap<MachineId, Vec<String>>,
    /// The runner's problem as its link's last check found it (None: usable); absent until that check answers.
    runner: HashMap<MachineId, Option<String>>,
    /// Machines git can't reach GitHub from, as the landing scanner last found.
    github_down: HashSet<MachineId>,
}

impl State {
    fn network_problem(&self, machine_id: &MachineId) -> Option<String> {
        super::network::problem(
            self.loads.get(machine_id).and_then(|l| l.network.as_ref()),
            self.github_down.contains(machine_id),
        )
    }
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

    /// What keeps the machine busy, as its node's latest heartbeat said (hub/pool stops an idle cloud machine); None from
    /// older nodes, before the first heartbeat, and while it is offline.
    pub fn busy(&self, machine_id: &MachineId) -> Option<NodeBusy> {
        self.state.lock().unwrap().busy.get(machine_id).copied()
    }

    /// Whether the machine is a Mac, as its node last said what it can host: only a Mac's node has its Mac screen (or,
    /// from a node before iOS screens were gone, an iOS simulator) ready, or off for any reason but `unsupported`
    /// (node/hosts.rs). False before its first heartbeat.
    pub fn is_mac(&self, machine_id: &MachineId) -> bool {
        use fleetd_contracts::machine_roles::{HostOff, SessionHost};
        let state = self.state.lock().unwrap();
        let hosts = state.loads.get(machine_id).and_then(|l| l.hosts.as_ref());
        hosts.is_some_and(|hosts| {
            hosts.iter().any(|h| {
                matches!(h.host, SessionHost::Mac | SessionHost::Ios)
                    && (h.ready || h.off.is_some_and(|off| off != HostOff::Unsupported))
            })
        })
    }

    /// What the machine can host, as its node answered a change of its screen settings: kept until its next heartbeat.
    pub fn set_hosts(
        &self,
        machine_id: &MachineId,
        hosts: fleetd_contracts::machine_roles::HostChecks,
    ) {
        if let Some(load) = self.state.lock().unwrap().loads.get_mut(machine_id) {
            load.hosts = Some(hosts);
        }
    }

    /// Why the machine is degraded for its network ("no IPv4 network on enp3s0, …"), with the fix; None while it has
    /// IPv4 or GitHub answers it.
    pub fn network_problem(&self, machine_id: &MachineId) -> Option<String> {
        self.state.lock().unwrap().network_problem(machine_id)
    }

    /// What the landing scanner found of git on the machine reaching GitHub: with no IPv4 there too, the machine is
    /// degraded until either is back.
    pub fn github_reached(&self, machine_id: &MachineId, reached: bool) {
        let changed = {
            let mut state = self.state.lock().unwrap();
            let before = state.network_problem(machine_id);
            match reached {
                true => state.github_down.remove(machine_id),
                false => state.github_down.insert(machine_id.clone()),
            };
            state.network_problem(machine_id) != before
        };
        if changed {
            self.settle(machine_id);
        }
    }

    /// Why new agents wait on the machine, e.g. "Paused new agents: 14 GB free on builder-1"; None while they start.
    pub fn paused(&self, machine_id: &MachineId) -> Option<String> {
        let state = self.state.lock().unwrap();
        state.paused.get(machine_id).map(|p| p.text.clone())
    }

    /// Keeps a heartbeat's `busy`; one without it (an older node) forgets the last.
    pub fn observe_busy(&self, machine_id: &MachineId, busy: Option<NodeBusy>) {
        let mut state = self.state.lock().unwrap();
        match busy {
            Some(busy) => state.busy.insert(machine_id.clone(), busy),
            None => state.busy.remove(machine_id),
        };
    }

    /// Keeps a heartbeat's load, hands its facts to the slot board, and runs the guard and the usage soft brake over
    /// it. `machine.guard` marks each pause and resume, which starts waiting agents again and refreshes the project
    /// rows; the line's figure updates with every heartbeat. `machine.hosts` marks what the node can host when it
    /// first says it, or says something else: machine.online comes before the first heartbeat, so without it the app
    /// kept saying the node hadn't said.
    /// `node_at` is the heartbeat's time on the node's clock: the soft brake ages a usage reading by it.
    pub fn observe_load(&self, machine_id: &MachineId, load: Option<NodeLoad>, node_at: &str) {
        let now = now_ms(self.deps.clock.as_ref());
        let node_now = crate::hub::store::parse_ms(node_at).unwrap_or(now);
        if let Some(load) = &load {
            let (name, cloud) = match self.deps.store.machine_get(machine_id) {
                Ok(Some(m)) => (m.name, m.cloud == Some(true)),
                _ => (machine_id.to_string(), false),
            };
            if let Err(e) = self
                .deps
                .slots
                .observe_machine(machine_id, &name, load, cloud)
            {
                tracing::warn!(error = %e, "node link: machine facts not applied to the slot board");
            }
        }
        let (was, why, brake, hosts_changed, network_changed) = {
            let mut state = self.state.lock().unwrap();
            let network = state.network_problem(machine_id);
            let was = state.paused.get(machine_id).cloned();
            let hosts_changed = load
                .as_ref()
                .and_then(|l| l.hosts.as_ref())
                .is_some_and(|hosts| {
                    state.loads.get(machine_id).and_then(|l| l.hosts.as_ref()) != Some(hosts)
                });
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
            let network_changed = state.network_problem(machine_id) != network;
            (was.is_some(), why, brake, hosts_changed, network_changed)
        };
        if network_changed {
            self.settle(machine_id);
        }
        if hosts_changed {
            self.append(event(
                &self.now_iso(),
                "machine.hosts",
                machine_id,
                format!("{machine_id} said what it can host"),
                None,
            ));
        }
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

    /// Whether the machine's node is linked and doesn't list `capability`: a node too old for it.
    pub fn node_lacks(&self, machine_id: &MachineId, capability: &str) -> bool {
        self.state
            .lock()
            .unwrap()
            .capabilities
            .get(machine_id)
            .is_some_and(|caps| !caps.iter().any(|c| c == capability))
    }

    /// As a hello listing `capabilities` leaves it.
    #[cfg(test)]
    pub fn set_capabilities(&self, machine_id: &MachineId, capabilities: &[&str]) {
        let caps = capabilities.iter().map(|c| (*c).to_owned()).collect();
        self.state
            .lock()
            .unwrap()
            .capabilities
            .insert(machine_id.clone(), caps);
    }

    /// Sends `frame` to the machine's live node; false when it has none.
    pub fn send_to(&self, machine_id: &MachineId, frame: HubToNode) -> bool {
        let tx = self
            .state
            .lock()
            .unwrap()
            .links
            .get(machine_id)
            .map(|(_, tx)| tx.clone());
        match tx {
            Some(tx) => tx.send(Out::Frame(Box::new(frame))).is_ok(),
            None => false,
        }
    }

    /// A link for a test standing in for a node that lists `capabilities`: the frames the hub sends it, as values.
    #[cfg(test)]
    pub fn test_link(
        &self,
        machine_id: &MachineId,
        capabilities: &[&str],
    ) -> mpsc::UnboundedReceiver<HubToNode> {
        let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
        let (frames, out) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(Out::Frame(frame)) = rx.recv().await {
                if frames.send(*frame).is_err() {
                    return;
                }
            }
        });
        let mut state = self.state.lock().unwrap();
        state.next_link_id += 1;
        let id = state.next_link_id;
        state.links.insert(machine_id.clone(), (id, tx));
        drop(state);
        self.set_capabilities(machine_id, capabilities);
        out
    }

    /// The machine's link `id` ended: it and what its hello listed are forgotten, unless a newer link took over.
    fn unlink(&self, machine_id: &MachineId, id: u64) {
        let mut state = self.state.lock().unwrap();
        if state.links.get(machine_id).map(|l| l.0) == Some(id) {
            state.links.remove(machine_id);
            state.capabilities.remove(machine_id);
        }
    }

    /// The machine's live link ends, as a node's restart ends it.
    #[cfg(test)]
    pub fn test_unlink(&self, machine_id: &MachineId) {
        if let Some(id) = self.link_id(machine_id) {
            self.unlink(machine_id, id);
        }
    }

    /// A frame from a node, as its link hands it on: a browser session's screen.
    pub fn browser_frame(
        &self,
        machine_id: &MachineId,
        frame: fleetd_contracts::browser::BrowserFrame,
    ) {
        self.browser_live.frame(machine_id, frame);
    }

    /// The hub stops (SIGTERM): lead calls that come in from now on are answered as not run, the ones being answered
    /// get up to `wait` to finish and send their answers, and then every link closes with [`close::RESTART`], so each
    /// node redials at once rather than find its socket reset.
    pub async fn stop(&self, wait: Duration) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut calls = self.calls.subscribe();
        let _ = tokio::time::timeout(wait, calls.wait_for(|n| *n == 0)).await;
        let links: Vec<LinkTx> = self
            .state
            .lock()
            .unwrap()
            .links
            .values()
            .map(|(_, tx)| tx.clone())
            .collect();
        for tx in links {
            let _ = tx.send(Out::Close(close::RESTART, "hub restarting".into()));
        }
    }

    /// One lead call being answered, counted until the guard drops; None once the hub is stopping.
    pub(crate) fn call_started(self: &Arc<Self>) -> Option<CallInFlight> {
        if self.stopping.load(std::sync::atomic::Ordering::SeqCst) {
            return None;
        }
        self.calls.send_modify(|n| *n += 1);
        Some(CallInFlight(Arc::clone(self)))
    }

    /// The machine's live link, by its id: a new one each time its node links.
    pub fn link_id(&self, machine_id: &MachineId) -> Option<u64> {
        self.state
            .lock()
            .unwrap()
            .links
            .get(machine_id)
            .map(|(id, _)| *id)
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

/// A frame only an older node sends: `preview_run_result` and `preview_report`, from before Try it was removed.
fn retired_frame(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("t")?.as_str().map(|t| t.starts_with("preview_")))
        .unwrap_or(false)
}

pub struct NodeLinkServer {
    deps: LinkDeps,
    state: Mutex<State>,
    /// Lead calls being answered now, across every link: the hub's stop waits for them ([`Self::stop`]).
    calls: tokio::sync::watch::Sender<usize>,
    /// The hub is stopping: lead calls that come in now aren't run, and say so.
    stopping: std::sync::atomic::AtomicBool,
    /// Browser sessions' live view: who watches which, and their frames.
    pub browser_live: Arc<crate::hub::browser::live::Live>,
    heartbeat_every: Duration,
    silence_timeout: Duration,
    hello_timeout: Duration,
}

struct Refused {
    code: u16,
    reason: String,
}

/// A lead call being answered ([`NodeLinkServer::call_started`]).
pub(crate) struct CallInFlight(Arc<NodeLinkServer>);

impl Drop for CallInFlight {
    fn drop(&mut self) {
        self.0.calls.send_modify(|n| *n = n.saturating_sub(1));
    }
}

/// The answer to a lead call that came in while the hub stops: not run, so trying it again can't run it twice.
fn stopping_call(id: fleetd_contracts::prim::NonEmpty) -> LeadResultFrame {
    LeadResultFrame {
        id,
        result: None,
        error: Some(
            McpToolError::new(
                ErrorCode::Failed,
                "fleetd hub is restarting, so this call didn't run",
            )
            .with_fix("try it again in a few seconds"),
        ),
    }
}

/// The hub's answer to a node's lead call it couldn't read, so the agent behind it isn't left waiting.
fn refused_call(bad: &Undecodable) -> Option<HubToNode> {
    let id = bad.id.as_deref().filter(|_| bad.tag == "lead_call")?;
    Some(HubToNode::LeadResult(LeadResultFrame {
        id: fleetd_contracts::prim::NonEmpty::unchecked(id),
        result: None,
        error: Some(
            McpToolError::new(
                ErrorCode::Invalid,
                format!("the hub could not read this call: {}", bad.error),
            )
            .with_fix("this machine and the hub may run different fleetd versions: carry on without this call and say so in your result"),
        ),
    }))
}

fn refuse<T>(code: u16, reason: impl Into<String>) -> Result<T, Refused> {
    Err(Refused {
        code,
        reason: reason.into(),
    })
}

/// WebSocket close reasons are capped at 123 bytes (close::REASON_MAX_BYTES).
fn close_reason(reason: &str) -> String {
    if reason.len() <= close::REASON_MAX_BYTES {
        return reason.to_owned();
    }
    let mut end = close::REASON_MAX_BYTES - 4;
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
            calls: tokio::sync::watch::Sender::new(0),
            stopping: std::sync::atomic::AtomicBool::new(false),
            browser_live: Arc::default(),
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

    /// Any frame restarts the machine's silence timer, armed for the link it came on.
    fn touch(self: &Arc<Self>, machine_id: &MachineId) {
        let this = self.clone();
        let id = machine_id.clone();
        let link = self.link_id(machine_id);
        // Armed here, not in the task: its deadline counts from this frame, however late the task first runs.
        let silence = self.deps.clock.sleep(self.silence_timeout);
        let handle = tokio::spawn(async move {
            silence.await;
            this.mark_offline(&id, link).await;
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

    /// A node linked while this hub still counts its machine online (it restarted, onto a new build or to apply a
    /// screen setting): logged as machine.linked, since its status doesn't change. The views that read what its link
    /// says read it again; without it, one read while the node was away kept saying it couldn't take screen settings.
    fn relinked(&self, machine_id: &MachineId, node_version: &str) {
        if !self
            .state
            .lock()
            .unwrap()
            .announced
            .contains_key(machine_id)
        {
            return;
        }
        self.append(event(
            &self.now_iso(),
            "machine.linked",
            machine_id,
            format!("{machine_id}'s node linked again, on fleetd {node_version}"),
            Some(json!({ "nodeVersion": node_version })),
        ));
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

    /// The machine went silent on `armed_for`, the link its timer was armed on (None: none yet, after a hub start).
    async fn mark_offline(&self, machine_id: &MachineId, armed_for: Option<u64>) {
        let live = {
            let mut state = self.state.lock().unwrap();
            // A timer that fired as a newer link came in: that link has a timer of its own.
            if let Some((id, _)) = state.links.get(machine_id)
                && Some(*id) != armed_for
            {
                return;
            }
            state.announced.remove(machine_id);
            state.watchdogs.remove(machine_id);
            state.loads.remove(machine_id);
            state.busy.remove(machine_id);
            state.paused.remove(machine_id);
            state.runner.remove(machine_id);
            state.links.remove(machine_id)
        };
        let at = self.now_iso();
        let seconds = self.silence_timeout.as_secs();
        self.write_status(machine_id, &at, MachineStatus::Offline, None);
        // No attention: a node back within minutes (a restart, an update) needs nobody. One still away after
        // hub/outage's 10 minutes pages the admins then, once.
        self.append(event(
            &at,
            "machine.offline",
            machine_id,
            format!("{machine_id} went offline: no word from its node for {seconds} s"),
            None,
        ));
        // Only the silent link's sessions: a node that linked again while this ran keeps its new link's. Detaching
        // the machine's left that link up with no sessions on it, so every task queued as offline until a restart.
        if let Some((id, tx)) = live {
            self.deps.executors.detach_link(machine_id, id).await;
            let _ = tx.send(Out::Close(
                close::HEARTBEAT_TIMEOUT,
                format!("no frame for {seconds} s"),
            ));
        }
        tracing::info!(machine_id = %machine_id, "node link: machine offline");
    }

    /// On each heartbeat of a link: once its executor hasn't been live for `REATTACH_AFTER` while heartbeats kept
    /// coming, its sessions are attached again, off the frame loop. `dark_since` is when this link's heartbeats first
    /// found it not live.
    fn reattach_if_dark(
        &self,
        machine_id: &MachineId,
        sessions: NodeSessions,
        dark_since: &mut Option<i64>,
    ) {
        if self.deps.executors.is_connected(machine_id) {
            *dark_since = None;
            return;
        }
        let now = now_ms(self.deps.clock.as_ref());
        let since = *dark_since.get_or_insert(now);
        if now - since < REATTACH_AFTER.as_millis() as i64 {
            return;
        }
        tracing::warn!(machine_id = %machine_id, link_id = sessions.link_id, dark_ms = now - since, "node link: heartbeats arrive but its sessions aren't live; attaching them again");
        *dark_since = Some(now);
        let executors = self.deps.executors.clone();
        let machine_id = machine_id.clone();
        tokio::spawn(async move { executors.reattach(&machine_id, sessions).await });
    }

    /// A node whose key was revoked since its hello (`fleetd machine remove`, which may run outside this hub's
    /// process) is ended at its next heartbeat: its sessions are detached first, so nothing it reports is written
    /// after, then, with its machine record gone too, what its link wrote since the remove is forgotten again. A
    /// machine the hub still has keeps its rows. True when the link must close.
    pub(crate) async fn forget_if_revoked(&self, machine_id: &MachineId, link: u64) -> bool {
        if !matches!(self.deps.auth.node_pub_key(machine_id), Ok(None)) {
            return false;
        }
        self.deps.executors.detach_link(machine_id, link).await;
        if matches!(self.deps.store.machine_get(machine_id), Ok(None)) {
            // `fleetd machine remove` ran outside this hub, so no open app has heard yet.
            self.append(Some(crate::hub::machine_setup::removed_event(
                machine_id,
                self.now_iso(),
            )));
            match self.deps.store.machine_remove(machine_id) {
                Ok(0) => {}
                Ok(rows) => {
                    tracing::info!(machine_id = %machine_id, rows, "node link: a removed machine's rows forgotten again")
                }
                Err(e) => {
                    tracing::error!(error = %e, "node link: a removed machine's rows weren't forgotten")
                }
            }
        }
        tracing::info!(machine_id = %machine_id, "node link: its key was revoked, so its link ends");
        true
    }

    /// Attributes a forwarded call to the project its cwd is in, on the machine whose node sent it, and answers it.
    pub(crate) async fn answer_lead_call(
        &self,
        machine_id: &MachineId,
        frame: LeadCallFrame,
    ) -> LeadResultFrame {
        let id = frame.id.clone();
        let outcome = async {
            if let Some(answer) = self.answer_hosted(machine_id, &frame) {
                return answer.await;
            }
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
            crate::hub::tasks::policy::check_call(&agent, &frame.call)?;
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

    /// A runner's report of a session it hosts for an agent on another machine: answered in that agent's name, as
    /// if its own node had sent it. Only the node's own browser calls; None for every other call.
    fn answer_hosted(
        &self,
        machine_id: &MachineId,
        frame: &LeadCallFrame,
    ) -> Option<crate::hub::link::lead_calls::LeadCallFuture> {
        let op = op_of(&frame.call);
        if !crate::hub::browser::calls::OPS.contains(&op.as_str()) {
            return None;
        }
        let hosted = self
            .deps
            .lead_calls
            .hosted(machine_id, frame.thread_id.as_ref()?)?;
        let mut call = frame.call.clone();
        if let LeadCall::BrowserSession(session) = &mut call {
            session.thread_id = hosted.thread_id.clone();
        }
        let handler = self.deps.lead_calls.handler(&op)?;
        let caller = LeadCaller {
            by: lead_by(&hosted.project_ref),
            project_ref: hosted.project_ref,
            agent: hosted.agent,
        };
        Some(handler.handle(caller, call))
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
                crate::protocol_behind(PROTOCOL_VERSION, hello.protocol.get()),
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
        let fingerprint = hello.machine_fingerprint.as_deref();
        if let Some(token) = &hello.enroll_token {
            return match self.deps.auth.enroll_node(
                token.as_str(),
                &machine_id,
                hello.pub_key.as_str(),
                fingerprint,
            ) {
                Ok(()) => Ok(hello),
                Err(AuthError::Unauthorized(e)) => refuse(close::UNAUTHORIZED, e.reason()),
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
            Ok(Some(_)) => {
                // A node enrolled before fingerprints: its first hello since records its computer.
                if let Some(fingerprint) = fingerprint
                    && matches!(self.deps.auth.node_fingerprint(&machine_id), Ok(None))
                    && let Err(e) = self
                        .deps
                        .auth
                        .set_node_fingerprint(&machine_id, fingerprint)
                {
                    tracing::warn!(error = %e, "node link: could not record {machine_id}'s fingerprint");
                }
                Ok(hello)
            }
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

    /// Keeps the runner's verdict (`problem`: None when usable) and announces the machine by it.
    fn apply_runner(&self, machine_id: &MachineId, problem: Option<String>) {
        // The agents' Mac runs no claude: it is online whatever its runner says.
        let problem = problem
            .filter(|_| !self.node_can(machine_id, fleetd_contracts::node_link::CAP_AGENTS_MAC));
        {
            let mut state = self.state.lock().unwrap();
            // A link that went away meanwhile must not announce anything.
            if !state.links.contains_key(machine_id) {
                return;
            }
            state.runner.insert(machine_id.clone(), problem);
        }
        self.settle(machine_id);
    }

    /// Online while the runner is usable and the network is fine, else degraded with the runner's problem, or the
    /// network's. Only the runner decides whether sessions start there: without IPv4, claude may still reach its API
    /// over IPv6. Nothing before the link's first runner check answers.
    fn settle(&self, machine_id: &MachineId) {
        let (runner, network) = {
            let state = self.state.lock().unwrap();
            if !state.links.contains_key(machine_id) {
                return;
            }
            let Some(runner) = state.runner.get(machine_id).cloned() else {
                return;
            };
            (runner, state.network_problem(machine_id))
        };
        let at = self.now_iso();
        match (runner, network) {
            (None, None) => {
                self.write_status(machine_id, &at, MachineStatus::Online, None);
                self.announce(machine_id, &at, Announced::Online, None);
                // After machine.online is logged, so no queued write reaches the machine before it.
                self.deps.executors.set_runner_ready(machine_id, true);
            }
            (Some(reason), _) => {
                self.deps.executors.set_runner_ready(machine_id, false);
                let status = MachineStatus::Degraded;
                self.write_status(machine_id, &at, status, Some(&reason));
                self.announce(machine_id, &at, Announced::Degraded, Some(&reason));
            }
            (None, Some(reason)) => {
                let status = MachineStatus::Degraded;
                self.write_status(machine_id, &at, status, Some(&reason));
                self.announce(machine_id, &at, Announced::Degraded, Some(&reason));
                self.deps.executors.set_runner_ready(machine_id, true);
            }
        }
    }

    async fn serve(
        self: &Arc<Self>,
        ws: &mut Rx,
        tx: &LinkTx,
        read: Option<crate::hub::http::ReadCount>,
    ) -> Result<(), Refused> {
        let hello = self.handshake(ws, tx).await?;
        let machine_id = hello.machine_id.clone();

        let (id, previous) = {
            let mut state = self.state.lock().unwrap();
            state.next_link_id += 1;
            let id = state.next_link_id;
            state
                .capabilities
                .insert(machine_id.clone(), hello.capabilities.clone());
            // Until this link's runner check answers.
            state.runner.remove(&machine_id);
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
        let hello_reason = "checking the node's runner";
        // The agents' Mac is a tool, never a runner: its agents role stays off, and clients seal nothing to it.
        let agents_mac = hello
            .capabilities
            .iter()
            .any(|c| c == fleetd_contracts::node_link::CAP_AGENTS_MAC);
        if agents_mac && let Err(e) = self.deps.slots.keep_tool_only(&machine_id) {
            tracing::error!(error = %e, "node link: the agents' Mac's agents role didn't go off");
        }
        // A cloud machine (hub/pool) enrolled with a pool enroll token: asleep is its rest, not a fault.
        let cloud = self.deps.auth.is_pool(&machine_id).unwrap_or(false);
        let last_slept = match self.deps.store.machine_get(&machine_id) {
            Ok(stored) => stored.and_then(|m| m.last_slept),
            Err(_) => None,
        };
        let machine: Machine = serde_json::from_value(json!({
            "machineId": machine_id,
            "name": hello.name,
            // Until the runner check answers.
            "status": "degraded",
            "lastSeenAt": at,
            "nodeVersion": hello.node_version,
            // Browsers seal this machine's secrets to it; a node from before M8 sends none and takes none.
            "boxPubKey": hello.box_pub_key,
            "degradedReason": hello_reason,
            "lastSlept": last_slept,
            "agentsMac": agents_mac.then_some(true),
            "cloud": cloud.then_some(true),
        }))
        .map_err(|e| Refused {
            code: close::BAD_FRAME,
            reason: format!("hello does not make a machine: {e}"),
        })?;
        if let Err(e) = self.deps.store.machine_upsert(&machine, None) {
            tracing::error!(error = %e, "node link: machine write failed");
        }
        self.relinked(&machine_id, &hello.node_version);
        self.touch(&machine_id);
        send(
            tx,
            HubToNode::Welcome(
                serde_json::from_value(json!({
                    "hubId": self.deps.hub_id, "protocol": ProtocolVersion::CURRENT,
                    "capabilities": [
                        fleetd_contracts::node_link::HUB_CAP_SESSION_ROUTE,
                        fleetd_contracts::node_link::HUB_CAP_LINK_DEFLATE,
                    ],
                }))
                .expect("welcome"),
            ),
        );
        // Compressed both ways from here on, for a node that asked: the hub sends so after its welcome, and reads what
        // the node sends after it.
        let deflate = hello
            .capabilities
            .iter()
            .any(|c| c == fleetd_contracts::node_link::CAP_LINK_DEFLATE);
        let mut inflater = deflate.then(crate::link_deflate::Inflater::default);
        if deflate {
            let _ = tx.send(Out::Deflate);
        }
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
        let _commands = self.deps.commands.attach(&machine_id, id, cmd_tx.clone());
        // After the attaches, so whoever acts on the announcement can already run commands and sessions there.
        let _runner = AbortOnDrop(self.follow_runner(&machine_id));
        self.check_runner(&machine_id);
        tracing::info!(machine_id = %machine_id, link_id = id, "node link: welcomed");
        for watch in self.browser_live.rewatch(&machine_id) {
            send(tx, watch);
        }

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
        // Bytes still arriving keep the link alive while one large frame comes in slowly, as frames would.
        let progress = read.map(|read| {
            let this = self.clone();
            let machine_id = machine_id.clone();
            AbortOnDrop(tokio::spawn(async move {
                let mut seen = read.load(std::sync::atomic::Ordering::Relaxed);
                loop {
                    this.deps.clock.sleep(PROGRESS_EVERY).await;
                    let now = read.load(std::sync::atomic::Ordering::Relaxed);
                    if now != seen && this.link_id(&machine_id) == Some(id) {
                        this.touch(&machine_id);
                    }
                    seen = now;
                }
            }))
        });
        let _progress = progress;
        let mut beats: u32 = 0;
        let mut dark_since = None;
        let mut bad_frames = BadFrames::default();

        loop {
            let text = match next_frame(ws, inflater.as_mut()).await {
                None => return Ok(()),
                Some(Err(e)) => return refuse(close::BAD_FRAME, e),
                Some(Ok(text)) => text,
            };
            let frame = match serde_json::from_str::<NodeToHub>(&text) {
                Ok(f) => f,
                // An older node's word on a preview it still runs: previews are gone from the hub.
                Err(_) if retired_frame(&text) => continue,
                // That frame alone is refused (crate::link_frames): the rest of the link carries on.
                Err(e) => {
                    let bad = Undecodable::of(&text, &e);
                    if !bad_frames.take(now_ms(self.deps.clock.as_ref())) {
                        tracing::warn!(machine_id = %machine_id, link_id = id, tag = %bad.tag, bytes = text.len(), error = %bad.error, "node link: too many frames that do not decode; closing the link");
                        return refuse(close::BAD_FRAME, "too many frames that do not decode");
                    }
                    tracing::warn!(machine_id = %machine_id, link_id = id, tag = %bad.tag, bytes = text.len(), error = %bad.error, "node link: a frame does not decode; refused it alone");
                    if let Some(answer) = refused_call(&bad) {
                        send(tx, answer);
                    }
                    continue;
                }
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
                    if self.forget_if_revoked(&machine_id, id).await {
                        return refuse(
                            close::UNAUTHORIZED,
                            format!(
                                "{machine_id} was removed from this hub: its node key is revoked"
                            ),
                        );
                    }
                    self.deps
                        .time
                        .heartbeat(machine_id.as_str(), beat.at.as_str());
                    self.observe_busy(&machine_id, beat.busy);
                    self.observe_load(&machine_id, beat.load, beat.at.as_str());
                    self.browser_live
                        .steps_reported(&machine_id, beat.steps.into_inner());
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
                    self.reattach_if_dark(
                        &machine_id,
                        NodeSessions {
                            link_id: id,
                            send: cmd_tx.clone(),
                        },
                        &mut dark_since,
                    );
                }
                NodeToHub::LeadCall(call) => {
                    let Some(in_flight) = self.call_started() else {
                        send(tx, HubToNode::LeadResult(stopping_call(call.id)));
                        continue;
                    };
                    // Off the frame loop: a slow call must not hold up heartbeats or other calls.
                    let this = self.clone();
                    let tx = tx.clone();
                    let machine_id = machine_id.clone();
                    tokio::spawn(async move {
                        let result = this.answer_lead_call(&machine_id, call).await;
                        send(&tx, HubToNode::LeadResult(result));
                        // Counted until its answer is queued ahead of the link's close.
                        drop(in_flight);
                    });
                }
                reply @ (NodeToHub::CmdResult(_)
                | NodeToHub::SecretResult(_)
                | NodeToHub::GatedResult(_)
                | NodeToHub::NodeActionResult(_)
                | NodeToHub::SessionHostResult(_)
                | NodeToHub::MacResult(_)) => self.deps.commands.resolve(&machine_id, reply),
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
                NodeToHub::BrowserFrame(frame) => self.browser_frame(&machine_id, frame),
                NodeToHub::Hello(_) => return refuse(close::BAD_FRAME, "hello after welcome"),
            }
        }
    }

    /// Runs one node link until the socket ends (the framework's node WebSocket route calls this), with the count of
    /// bytes its connection read (see `hub::http`), which keeps a link whose frame is still coming in alive. Never
    /// fails: refusals close the socket with a NodeLinkClose code.
    pub async fn handle_counted(
        self: &Arc<Self>,
        socket: WebSocket,
        read: Option<crate::hub::http::ReadCount>,
    ) {
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Out>();
        let writer = tokio::spawn(async move {
            let mut deflater: Option<crate::link_deflate::Deflater> = None;
            while let Some(out) = rx.recv().await {
                let message = match out {
                    Out::Frame(frame) => match serde_json::to_string(&*frame) {
                        Ok(text) => match deflater.as_mut() {
                            Some(d) if text.len() >= crate::link_deflate::MIN_DEFLATE_BYTES => {
                                Message::Binary(d.deflate(&text).into())
                            }
                            _ => Message::Text(text.into()),
                        },
                        Err(_) => continue,
                    },
                    Out::Deflate => {
                        deflater = Some(Default::default());
                        continue;
                    }
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
        let result = self.serve(&mut stream, &tx, read).await;
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

/// The next frame's text, a Binary one inflated once the link is compressed; None once the socket closes or fails, an
/// error for a frame that won't inflate.
async fn next_frame(
    rx: &mut Rx,
    inflater: Option<&mut crate::link_deflate::Inflater>,
) -> Option<Result<String, String>> {
    let Some(inflater) = inflater else {
        return next_text(rx).await.map(Ok);
    };
    while let Some(message) = rx.next().await {
        match message {
            Ok(Message::Text(text)) => return Some(Ok(text.to_string())),
            Ok(Message::Binary(bytes)) => return Some(inflater.inflate(&bytes, MAX_INFLATED)),
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            Ok(Message::Close(_)) | Err(_) => return None,
        }
    }
    None
}

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
        self.server.unlink(&self.machine_id, self.id);
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

#[cfg(test)]
mod tests {
    use fleetd_contracts::ids::MachineId;

    use crate::hub::api::{HubConfig, Listen};
    use crate::hub::store::HubDb;
    use crate::hub::store::test_clock::ManualClock;

    /// A refusal reaches the node as the link's close reason, cut at 123 bytes: the one for a node enrolled under
    /// another id arrives whole, both ways out in it (a code to rejoin under its id, or removing it first), whatever
    /// the ids' length.
    #[test]
    fn a_node_enrolled_under_another_id_reads_its_whole_fix() {
        let auth = crate::hub::auth::Auth::new(
            HubDb::open_memory().unwrap(),
            ManualClock::at(1_792_000_000_000),
        );
        for (theirs, ours) in [
            ("devbox", "worker"),
            (&*"d".repeat(16), &*"w".repeat(16)),
            (&*"d".repeat(32), &*"w".repeat(32)),
        ] {
            let token = auth
                .create_enroll_token(&MachineId::unchecked(theirs), "test")
                .unwrap()
                .token;
            auth.enroll_node(&token, &MachineId::unchecked(theirs), "pub-1", None)
                .unwrap();
            let token = auth
                .create_enroll_token(&MachineId::unchecked(ours), "test")
                .unwrap()
                .token;
            let Err(crate::hub::auth::AuthError::Unauthorized(refused)) =
                auth.enroll_node(&token, &MachineId::unchecked(ours), "pub-1", None)
            else {
                panic!("{ours} enrolled with {theirs}'s key");
            };
            let sent = refused.reason();
            let read = super::close_reason(&sent);
            assert_eq!(read, sent, "cut short");
            assert!(
                read.starts_with(&format!("enrolled as {theirs}. Fix: ")),
                "{read}"
            );
            assert!(
                read.contains(&format!("Fix: fleetd pair --worker {theirs}")),
                "{read}"
            );
            assert!(read.contains(", or "), "{read}");
            assert!(read.contains("remove"), "{read}");
            auth.revoke_node(&MachineId::unchecked(theirs)).unwrap();
        }
    }

    /// A node that links again while its machine still counts as online (it restarted onto a new build) logs
    /// machine.linked, so the app reads what its link says again; its first link after a hub start doesn't, since
    /// machine.online marks that one.
    #[tokio::test]
    async fn a_node_linking_again_without_going_offline_is_logged() {
        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
        };
        let hub = crate::hub::serve::build_on(
            HubDb::open_memory().unwrap(),
            config,
            ManualClock::at(1_792_000_000_000),
        )
        .unwrap();
        let devbox = MachineId::unchecked("devbox");
        let linked = || {
            hub.db
                .with(|c| {
                    let mut stmt = c.prepare(
                        "SELECT data FROM events WHERE type = 'machine.linked' ORDER BY seq",
                    )?;
                    let rows = stmt
                        .query_map([], |r| r.get::<_, String>(0))?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    Ok(rows)
                })
                .unwrap()
        };

        let _first = hub.link.test_link(&devbox, &[]);
        hub.link.relinked(&devbox, "0.1.0");
        assert!(linked().is_empty(), "the first link is machine.online's");

        hub.link.apply_runner(&devbox, None);
        hub.link.test_unlink(&devbox);
        let _again = hub.link.test_link(&devbox, &[]);
        hub.link.relinked(&devbox, "0.2.0");
        let events = linked();
        assert_eq!(events.len(), 1, "{events:?}");
        let event: serde_json::Value = serde_json::from_str(&events[0]).unwrap();
        assert_eq!(event["machineId"], "devbox");
        assert_eq!(event["data"]["nodeVersion"], "0.2.0");
        assert_eq!(
            event["summary"],
            "devbox's node linked again, on fleetd 0.2.0"
        );
    }

    /// The Nov 8 outage: DHCP timed out and the machine kept only a link-local IPv4, so git there couldn't reach
    /// GitHub. Both at once degrade it with the fix naming its interface; sessions still start there. Its address
    /// coming back clears it at the next heartbeat.
    #[tokio::test]
    async fn a_machine_with_no_ipv4_and_no_github_is_degraded_until_its_address_is_back() {
        use fleetd_contracts::model::{Machine, MachineStatus};

        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
        };
        let hub = crate::hub::serve::build_on(
            HubDb::open_memory().unwrap(),
            config,
            ManualClock::at(1_792_000_000_000),
        )
        .unwrap();
        let devbox = MachineId::unchecked("devbox");
        let machine: Machine = serde_json::from_value(serde_json::json!({
            "machineId": "devbox", "name": "devbox", "status": "online",
            "lastSeenAt": "2026-11-08T06:00:00.000Z", "nodeVersion": "0.1.0",
        }))
        .unwrap();
        hub.store
            .machine_upsert(&machine, Some("node-key"))
            .unwrap();
        let _link = hub.link.test_link(&devbox, &[]);
        hub.link.apply_runner(&devbox, None);
        let beat = |addrs: &[(&str, &str)]| {
            let addrs: Vec<_> = addrs
                .iter()
                .map(|(n, ip)| ((*n).to_owned(), ip.parse().unwrap()))
                .collect();
            let mut load = super::super::guard::tests::load(500, 1.0);
            load.network = crate::node::network::verdict(&addrs, &["enp3s0".to_owned()]);
            hub.link
                .observe_load(&devbox, Some(load), "2026-11-08T06:30:00.000Z");
        };
        let status = || {
            let m = hub.store.machine_get(&devbox).unwrap().unwrap();
            (m.status, m.degraded_reason)
        };

        beat(&[("enp3s0", "169.254.77.12"), ("tailscale0", "100.64.0.7")]);
        assert_eq!(
            status(),
            (MachineStatus::Online, None),
            "GitHub not found down yet"
        );
        hub.link.github_reached(&devbox, false);
        let reason = "no IPv4 network on enp3s0, so GitHub can't be reached. Fix: run \
                      `sudo networkctl reconfigure enp3s0` or `sudo netplan apply`";
        assert_eq!(status(), (MachineStatus::Degraded, Some(reason.into())));
        assert!(
            hub.executors.runner_ready(&devbox),
            "sessions still start there"
        );
        assert_eq!(hub.link.network_problem(&devbox).as_deref(), Some(reason));

        beat(&[("enp3s0", "192.168.1.20"), ("tailscale0", "100.64.0.7")]);
        assert_eq!(status(), (MachineStatus::Online, None));
        assert_eq!(hub.link.network_problem(&devbox), None);
    }

    /// `fleetd machine remove` of a node that is still linked: the hub revokes its key and forgets its rows, then the
    /// node reports its projects again. Its next heartbeat ends the link and forgets those too, and devbox's project
    /// under the same id stays. A machine whose record the hub still has keeps its rows.
    #[tokio::test]
    async fn a_removed_machine_still_linked_is_cut_off_and_what_it_reports_after_is_forgotten() {
        use fleetd_contracts::model::{Machine, ProjectSummary};

        use crate::hub::executor::NodeSessions;

        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
        };
        let hub = crate::hub::serve::build_on(
            HubDb::open_memory().unwrap(),
            config,
            ManualClock::at(1_792_000_000_000),
        )
        .unwrap();
        let (devbox, worker) = (
            MachineId::unchecked("devbox"),
            MachineId::unchecked("worker"),
        );
        let machine = |id: &MachineId| -> Machine {
            serde_json::from_value(serde_json::json!({
                "machineId": id, "name": id, "status": "online", "lastSeenAt": "2026-11-07T10:00:00.000Z",
                "nodeVersion": "0.1.0",
            }))
            .unwrap()
        };
        let reports = |id: &MachineId| {
            let project: ProjectSummary = serde_json::from_value(serde_json::json!({
                "machineId": id, "projectId": "p-shared", "title": "fleetd", "workspaceRoot": "/srv/fleetd",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
                "lastActivityAt": "2026-11-07T10:00:00.000Z",
            }))
            .unwrap();
            hub.store.projects_upsert_many(id, &[project]).unwrap();
        };
        let projects = |id: &MachineId| hub.store.projects_list(Some(id), None).unwrap().len();
        for id in [&devbox, &worker] {
            hub.store
                .machine_upsert(&machine(id), Some("node-key"))
                .unwrap();
            reports(id);
        }
        let _link = hub.link.test_link(&worker, &[]);
        let link = hub.link.link_id(&worker).unwrap();
        let (send, _calls) = tokio::sync::mpsc::unbounded_channel();
        hub.executors
            .attach(
                &worker,
                NodeSessions {
                    link_id: link,
                    send,
                },
            )
            .await;
        assert!(
            !hub.link.forget_if_revoked(&worker, link).await,
            "an enrolled node stays"
        );

        assert!(hub.auth.revoke_node(&worker).unwrap());
        hub.store.machine_remove(&worker).unwrap();
        reports(&worker);
        assert_eq!(
            projects(&worker),
            1,
            "the linked node wrote its project back"
        );

        assert!(hub.link.forget_if_revoked(&worker, link).await);
        assert_eq!(projects(&worker), 0);
        assert_eq!(projects(&devbox), 1);
        assert!(hub.executors.live_since(&worker).is_none());
        // The CLI's remove ran outside this hub, so it tells the open apps now: they drop the machine and its projects.
        let removed = |id: &MachineId| {
            hub.events
                .page(0, None, None)
                .unwrap()
                .events
                .iter()
                .map(|e| serde_json::to_value(e).unwrap())
                .filter(|e| e["type"] == "machine.removed" && e["machineId"] == id.as_str())
                .count()
        };
        assert_eq!(removed(&worker), 1);

        // Revoked, but the hub still has the machine (its remove hasn't forgotten it yet): its rows are left alone.
        assert!(hub.auth.revoke_node(&devbox).unwrap());
        let _devbox_link = hub.link.test_link(&devbox, &[]);
        let devbox_link = hub.link.link_id(&devbox).unwrap();
        assert!(hub.link.forget_if_revoked(&devbox, devbox_link).await);
        assert_eq!(projects(&devbox), 1);
        assert_eq!(removed(&devbox), 0);
    }

    /// The 2026-11-03 outage: a stalled hub ran a quiet link's silence timer out just as the node linked again. Its
    /// offline pass detached the machine's sessions after the new link had attached them, leaving that link up and
    /// heartbeating with nothing on it: the node never heard, and every task queued as offline until a restart. The
    /// pass ends only the link that went quiet, so the new one stays connected.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn a_silence_timer_that_runs_out_as_the_node_links_again_leaves_the_new_link_connected() {
        use std::time::Duration;

        use fleetd_contracts::node_link::{HubToNode, NodeToHub};
        use tokio::time::timeout;

        use crate::hub::executor::NodeSessions;

        const WAIT: Duration = Duration::from_secs(10);
        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
        };
        let clock = ManualClock::at(1_792_000_000_000);
        let hub = crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone())
            .unwrap();
        let devbox = MachineId::unchecked("devbox");

        // The old link goes quiet and ends; its timer runs on, as one that already fired does.
        let _old = hub.link.test_link(&devbox, &[]);
        hub.link.touch(&devbox);
        let timer = {
            let mut state = hub.link.state.lock().unwrap();
            state
                .announced
                .insert(devbox.clone(), super::Announced::Online);
            state.watchdogs.remove(&devbox).unwrap()
        };
        hub.link.test_unlink(&devbox);

        // The stalled hub: its database is busy, so the offline pass waits on it part way through.
        let (held, is_held) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let db = hub.db.clone();
        let holder = std::thread::spawn(move || {
            db.with(|_| {
                held.send(()).unwrap();
                released.recv().unwrap();
                Ok(())
            })
            .unwrap();
        });
        is_held.recv().unwrap();
        clock.advance(hub.link.silence_timeout + Duration::from_secs(1));
        // Waited out on this thread, not with tokio's timers: the pass blocks the worker it runs on, and when that
        // worker was the one driving the timers, nothing fires them until it is released.
        let deadline = std::time::Instant::now() + WAIT;
        while hub
            .link
            .state
            .lock()
            .unwrap()
            .announced
            .contains_key(&devbox)
        {
            assert!(
                std::time::Instant::now() < deadline,
                "the offline pass starts"
            );
            std::thread::sleep(Duration::from_millis(5));
        }

        // Meanwhile the node links again, as serve links it.
        let _new = hub.link.test_link(&devbox, &[]);
        let new_id = hub.link.link_id(&devbox).unwrap();
        let (send, mut calls) = tokio::sync::mpsc::unbounded_channel();
        hub.executors
            .attach(
                &devbox,
                NodeSessions {
                    link_id: new_id,
                    send,
                },
            )
            .await;
        hub.link.touch(&devbox);

        release.send(()).unwrap();
        holder.join().unwrap();
        timeout(WAIT, timer)
            .await
            .expect("the offline pass ends")
            .unwrap();

        let Ok(Some(HubToNode::SessionCall(call))) = timeout(WAIT, calls.recv()).await else {
            panic!("the hub dropped the new link's sessions")
        };
        let reply: NodeToHub = serde_json::from_value(serde_json::json!({
            "t": "session_reply", "id": call.id, "result": { "ok": { "kind": "done" } }
        }))
        .unwrap();
        hub.executors.handle_frame(&devbox, reply);
        timeout(WAIT, hub.executors.await_live(&devbox))
            .await
            .expect("the new link goes live");
        assert!(hub.executors.is_connected(&devbox));
        assert_eq!(hub.link.link_id(&devbox), Some(new_id));
    }

    /// After the 2026-11-08 outage: a link whose heartbeats keep coming while its executor isn't live (there, an old
    /// link's supervisor had cleared it) gets its sessions attached again after about 30 s, so the machine is back
    /// online without a node restart. A live link is left alone.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_heartbeating_link_whose_sessions_arent_live_is_attached_again() {
        use std::time::Duration;

        use fleetd_contracts::node_link::{HubToNode, NodeToHub};
        use fleetd_contracts::sessions::SessionCall;
        use tokio::time::timeout;

        use crate::hub::executor::NodeSessions;

        const WAIT: Duration = Duration::from_secs(10);
        let home = tempfile::tempdir().unwrap();
        let config = HubConfig {
            home: home.path().to_path_buf(),
            listen: Listen::default(),
            url: None,
        };
        let clock = ManualClock::at(1_792_000_000_000);
        let hub = crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone())
            .unwrap();
        let devbox = MachineId::unchecked("devbox");
        let _link = hub.link.test_link(&devbox, &[]);
        let link_id = hub.link.link_id(&devbox).unwrap();
        let (send, mut calls) = tokio::sync::mpsc::unbounded_channel();
        let sessions = || NodeSessions {
            link_id,
            send: send.clone(),
        };
        // Answers the hub's next call, which must be a subscription.
        async fn subscribed(
            executors: &crate::hub::executor::Executors,
            devbox: &MachineId,
            calls: &mut tokio::sync::mpsc::UnboundedReceiver<HubToNode>,
        ) {
            let Ok(Some(HubToNode::SessionCall(call))) = timeout(WAIT, calls.recv()).await else {
                panic!("the hub never subscribed")
            };
            assert!(
                matches!(call.call, SessionCall::Subscribe { .. }),
                "{:?}",
                call.call
            );
            let reply: NodeToHub = serde_json::from_value(serde_json::json!({
                "t": "session_reply", "id": call.id, "result": { "ok": { "kind": "done" } }
            }))
            .unwrap();
            executors.handle_frame(devbox, reply);
            timeout(WAIT, executors.await_live(devbox))
                .await
                .expect("the link goes live");
        }
        hub.executors.attach(&devbox, sessions()).await;
        subscribed(&hub.executors, &devbox, &mut calls).await;

        // Live: heartbeats leave it be, however long they come.
        let mut dark_since = None;
        hub.link
            .reattach_if_dark(&devbox, sessions(), &mut dark_since);
        clock.advance(Duration::from_secs(60));
        hub.link
            .reattach_if_dark(&devbox, sessions(), &mut dark_since);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(calls.try_recv().is_err(), "a live link was attached again");

        // Its executor goes dark while the link stays up: heartbeats wait about 30 s, then attach it again.
        hub.executors.test_go_dark(&devbox);
        assert!(!hub.executors.is_connected(&devbox));
        hub.link
            .reattach_if_dark(&devbox, sessions(), &mut dark_since);
        clock.advance(Duration::from_secs(20));
        hub.link
            .reattach_if_dark(&devbox, sessions(), &mut dark_since);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(calls.try_recv().is_err(), "attached again too soon");
        clock.advance(Duration::from_secs(11));
        hub.link
            .reattach_if_dark(&devbox, sessions(), &mut dark_since);
        subscribed(&hub.executors, &devbox, &mut calls).await;
        assert!(hub.executors.is_connected(&devbox));
    }
}
