//! Commands the hub runs on a machine through its node: a `cmd_check` frame out, the matching `cmd_result` back.
//! `cmd` checks use it; the merge train reuses it for git operations, hence timeouts up to 30 minutes. Sealed secrets
//! (`secret_deliver` / `secret_result`), approved commands (`gated_run` / `gated_result`) and the doctor's node actions
//! (`node_action` / `node_action_result`) go over the same links. TS spec: apps/hub/src/checks/NodeCommands.ts.
//!
//! The link area owns the socket: it calls `attach` for each welcomed link (dropping the guard when the link ends) and
//! hands every reply frame to `resolve`. Frames are JSON values here so this module and the link agree on the wire
//! without sharing a frame enum.
use fleetd_contracts::MachineId;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::oneshot;

pub const DEFAULT_TIMEOUT_SEC: u32 = 120;
pub const MAX_TIMEOUT_SEC: u32 = 1800;
/// How long past the command's own timeout the hub waits for the node's answer.
const REPLY_GRACE: Duration = Duration::from_secs(30);
/// How long the hub waits for a node to write a secret.
const SECRET_REPLY: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandInput {
    /// Absolute, on the machine. The node refuses directories outside its command roots.
    pub cwd: String,
    /// Run as given, never through a shell.
    pub argv: Vec<String>,
    /// Default 120, at most 1800.
    pub timeout_sec: Option<u32>,
}

/// A `cmd_result` without `t` and `id`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    /// None when the process did not exit on its own: it timed out, was killed by a signal, or could not start.
    pub exit_code: Option<i64>,
    pub output_tail: String,
    pub timed_out: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeCommandReason {
    Offline,
    Lost,
    NoReply,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct NodeCommandError {
    pub machine_id: MachineId,
    pub reason: NodeCommandReason,
    pub message: String,
}

impl NodeCommandError {
    pub fn offline(machine_id: &MachineId) -> Self {
        Self { machine_id: machine_id.clone(), reason: NodeCommandReason::Offline, message: format!("{machine_id}'s node is not linked to the hub") }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeAction {
    RemintSession,
    RestartT3,
    Probe,
}

impl NodeAction {
    fn name(self) -> &'static str {
        match self {
            Self::RemintSession => "remint_session",
            Self::RestartT3 => "restart_t3",
            Self::Probe => "probe",
        }
    }
    /// The node caps its restart command at 3 min and its re-mint at 30 s.
    fn wait(self) -> Duration {
        match self {
            Self::Probe => Duration::from_secs(30),
            Self::RemintSession => Duration::from_secs(45),
            Self::RestartT3 => Duration::from_secs(210),
        }
    }
}

/// Sends one frame on the link; false when the link is gone.
pub type NodeSend = Arc<dyn Fn(Value) -> bool + Send + Sync>;

struct Link {
    id: u64,
    send: NodeSend,
}

struct Pending {
    machine_id: MachineId,
    link_id: u64,
    /// The reply frame's `t` this request expects.
    reply: &'static str,
    done: oneshot::Sender<Result<Value, NodeCommandError>>,
}

#[derive(Default)]
struct State {
    links: HashMap<MachineId, Link>,
    pending: HashMap<String, Pending>,
    next_link_id: u64,
}

#[derive(Default)]
pub struct NodeCommands {
    state: Mutex<State>,
}

/// Held by the link while it is up. Dropping it detaches the link and fails the commands in flight on it.
pub struct LinkGuard {
    commands: Weak<NodeCommands>,
    machine_id: MachineId,
    id: u64,
}

impl Drop for LinkGuard {
    fn drop(&mut self) {
        let Some(commands) = self.commands.upgrade() else { return };
        let mut state = commands.lock();
        if state.links.get(&self.machine_id).is_some_and(|l| l.id == self.id) {
            state.links.remove(&self.machine_id);
        }
        let lost: Vec<String> = state.pending.iter().filter(|(_, p)| p.link_id == self.id).map(|(k, _)| k.clone()).collect();
        for id in lost {
            if let Some(p) = state.pending.remove(&id) {
                let _ = p.done.send(Err(NodeCommandError {
                    machine_id: self.machine_id.clone(),
                    reason: NodeCommandReason::Lost,
                    message: format!("the link to {}'s node dropped while the command ran", self.machine_id),
                }));
            }
        }
    }
}

fn reply_of(t: &str) -> &'static str {
    match t {
        "cmd_check" => "cmd_result",
        "secret_deliver" => "secret_result",
        "gated_run" => "gated_result",
        _ => "node_action_result",
    }
}

fn new_id() -> String {
    let b: [u8; 16] = rand::random();
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-4{}-a{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

impl NodeCommands {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Registers a welcomed link to `machine_id`'s node, replacing any earlier one.
    pub fn attach(self: &Arc<Self>, machine_id: MachineId, send: NodeSend) -> LinkGuard {
        let mut state = self.lock();
        state.next_link_id += 1;
        let id = state.next_link_id;
        state.links.insert(machine_id.clone(), Link { id, send });
        LinkGuard { commands: Arc::downgrade(self), machine_id, id }
    }

    /// The link hands over each reply frame (`cmd_result`, `secret_result`, `gated_result`, `node_action_result`).
    /// Only the machine it was sent to may answer a request, and only with the reply its request expects.
    pub fn resolve(&self, machine_id: &MachineId, frame: &Value) {
        let (Some(id), Some(t)) = (frame.get("id").and_then(Value::as_str), frame.get("t").and_then(Value::as_str)) else { return };
        let mut state = self.lock();
        let matches = state.pending.get(id).is_some_and(|p| &p.machine_id == machine_id && p.reply == t);
        if !matches {
            return;
        }
        if let Some(p) = state.pending.remove(id) {
            let _ = p.done.send(Ok(frame.clone()));
        }
    }

    /// Sends `frame` (an object with `t`, without `id`) over the machine's live link and waits for its reply, at most
    /// `wait`. Returns the reply without `t` and `id`, decoded as `R`.
    pub async fn request<R: DeserializeOwned>(&self, machine_id: &MachineId, mut frame: Value, wait: Duration) -> Result<R, NodeCommandError> {
        let id = new_id();
        frame["id"] = json!(id);
        let reply = reply_of(frame.get("t").and_then(Value::as_str).unwrap_or_default());
        let (tx, rx) = oneshot::channel();
        let send = {
            let mut state = self.lock();
            let Some(link) = state.links.get(machine_id) else { return Err(NodeCommandError::offline(machine_id)) };
            let (link_id, send) = (link.id, link.send.clone());
            state.pending.insert(id.clone(), Pending { machine_id: machine_id.clone(), link_id, reply, done: tx });
            send
        };
        // A send on a closed link is answered by the guard's drop, or else by the wait running out.
        send(frame);
        let outcome = tokio::time::timeout(wait, rx).await;
        self.lock().pending.remove(&id);
        let no_reply = || NodeCommandError {
            machine_id: machine_id.clone(),
            reason: NodeCommandReason::NoReply,
            message: format!("{machine_id}'s node did not answer within {} s", wait.as_secs()),
        };
        let mut value = match outcome {
            Ok(Ok(result)) => result?,
            Ok(Err(_)) | Err(_) => return Err(no_reply()),
        };
        if let Some(obj) = value.as_object_mut() {
            obj.remove("t");
            obj.remove("id");
        }
        serde_json::from_value(value).map_err(|e| NodeCommandError {
            machine_id: machine_id.clone(),
            reason: NodeCommandReason::Invalid,
            message: format!("{machine_id}'s node answered with an unexpected frame: {e}"),
        })
    }

    pub async fn run(&self, machine_id: &MachineId, input: CommandInput) -> Result<CommandOutcome, NodeCommandError> {
        let timeout_sec = input.timeout_sec.unwrap_or(DEFAULT_TIMEOUT_SEC);
        let invalid = |message: String| NodeCommandError { machine_id: machine_id.clone(), reason: NodeCommandReason::Invalid, message };
        if !(1..=MAX_TIMEOUT_SEC).contains(&timeout_sec) {
            return Err(invalid(format!("timeout must be 1-{MAX_TIMEOUT_SEC} s, got {timeout_sec}")));
        }
        if !input.cwd.starts_with('/') {
            return Err(invalid(format!("cwd must be absolute, got {}", input.cwd)));
        }
        if input.argv.is_empty() || input.argv.len() > 64 {
            return Err(invalid("argv must have 1-64 entries".into()));
        }
        let frame = json!({ "t": "cmd_check", "cwd": input.cwd, "argv": input.argv, "timeoutSec": timeout_sec });
        self.request(machine_id, frame, Duration::from_secs(u64::from(timeout_sec)) + REPLY_GRACE).await
    }

    /// Relays a sealed secret to the sink's node. `deliver` is a `secret_deliver` frame's fields without `t` and `id`;
    /// the answer is the `secret_result`'s (`fingerprint` or `error`).
    pub async fn deliver_secret<R: DeserializeOwned>(&self, machine_id: &MachineId, mut deliver: Value) -> Result<R, NodeCommandError> {
        deliver["t"] = json!("secret_deliver");
        self.request(machine_id, deliver, SECRET_REPLY).await
    }

    /// Runs an approved command on the node, waiting up to its own `timeoutSec` plus a grace. `run` is a `gated_run`
    /// frame's fields without `t` and `id`.
    pub async fn run_gated<R: DeserializeOwned>(&self, machine_id: &MachineId, mut run: Value) -> Result<R, NodeCommandError> {
        let timeout_sec = run.get("timeoutSec").and_then(Value::as_u64).unwrap_or(0);
        run["t"] = json!("gated_run");
        self.request(machine_id, run, Duration::from_secs(timeout_sec) + REPLY_GRACE).await
    }

    /// The doctor's node actions: re-mint the hub's T3 session, restart T3, or probe commit email and free disk.
    pub async fn node_action<R: DeserializeOwned>(&self, machine_id: &MachineId, action: NodeAction) -> Result<R, NodeCommandError> {
        self.request(machine_id, json!({ "t": "node_action", "action": action.name() }), action.wait()).await
    }
}
