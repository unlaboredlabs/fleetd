//! Commands the hub runs on a machine through its node: a request frame out, the matching reply back by id.
//! `cmd` checks and the merge train's git steps (timeouts up to 30 min), sealed secrets, approved (gated) commands and
//! the doctor's node actions.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::node_link::{
    CmdResult, GatedResult, GatedRun, HubToNode, NodeActionKind, NodeActionResult, NodeToHub,
    SecretDeliver, SecretResult,
};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

pub const DEFAULT_TIMEOUT_SEC: u32 = 120;
/// A command's longest run: a gated run's cap.
pub const MAX_TIMEOUT_SEC: u32 = fleetd_contracts::ledger::GATED_MAX_TIMEOUT_SEC as u32;
/// How long past the command's own timeout the hub waits for the node's answer.
const REPLY_GRACE_SEC: u64 = 30;
/// A node update downloads the new binary before it answers.
const UPDATE_WAIT_SEC: u64 = 600;
/// How long the hub waits for a node to write a secret.
const SECRET_REPLY_SEC: u64 = 30;

#[derive(Debug, Clone)]
pub struct CommandInput {
    /// Absolute, on the machine. The node refuses directories outside its command roots.
    pub cwd: String,
    /// Run as given, never through a shell.
    pub argv: Vec<String>,
    /// Default 120, at most MAX_TIMEOUT_SEC.
    pub timeout_sec: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeCommandErrorReason {
    Offline,
    Lost,
    NoReply,
    Invalid,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct NodeCommandError {
    pub machine_id: MachineId,
    pub reason: NodeCommandErrorReason,
    pub message: String,
}

impl NodeCommandError {
    fn new(machine_id: &MachineId, reason: NodeCommandErrorReason, message: String) -> Self {
        Self {
            machine_id: machine_id.clone(),
            reason,
            message,
        }
    }
    fn offline(machine_id: &MachineId) -> Self {
        Self::new(
            machine_id,
            NodeCommandErrorReason::Offline,
            format!("{machine_id}'s node is not linked to the hub"),
        )
    }
}

struct Link {
    id: u64,
    send: mpsc::UnboundedSender<HubToNode>,
}

struct Pending {
    machine_id: MachineId,
    link_id: u64,
    /// The reply frame's tag this request expects.
    reply: &'static str,
    done: oneshot::Sender<NodeToHub>,
    /// Waits for a second reply to the same id once the first came.
    then: Option<oneshot::Sender<NodeToHub>>,
}

#[derive(Default)]
struct State {
    links: HashMap<MachineId, Link>,
    pending: HashMap<String, Pending>,
    next_link_id: u64,
}

/// Request/reply over each welcomed link. The link server calls `attach` and `resolve`; other areas call the rest.
#[derive(Default)]
pub struct NodeCommands {
    state: Arc<Mutex<State>>,
}

/// Held by the link server while a link is welcomed. Dropping it detaches the link; commands in flight on it fail as
/// lost.
pub struct AttachedLink {
    state: Arc<Mutex<State>>,
    machine_id: MachineId,
    id: u64,
}

impl Drop for AttachedLink {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        if state
            .links
            .get(&self.machine_id)
            .is_some_and(|l| l.id == self.id)
        {
            state.links.remove(&self.machine_id);
        }
        // Dropping their senders wakes the waiters with "lost".
        state.pending.retain(|_, p| p.link_id != self.id);
    }
}

fn reply_of(frame: &NodeToHub) -> Option<(&'static str, &str)> {
    match frame {
        NodeToHub::CmdResult(r) => Some(("cmd_result", r.id.as_str())),
        NodeToHub::SecretResult(r) => Some(("secret_result", r.id.as_str())),
        NodeToHub::GatedResult(r) => Some(("gated_result", r.id.as_str())),
        NodeToHub::NodeActionResult(r) => Some(("node_action_result", r.id.as_str())),
        NodeToHub::SessionHostResult(r) => Some(("session_host_result", r.id.as_str())),
        _ => None,
    }
}

fn new_id() -> String {
    let b: [u8; 16] = rand::random();
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-4{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[13..16],
        &h[16..20],
        &h[20..32]
    )
}

impl NodeCommands {
    /// The node link registers each welcomed link here.
    pub fn attach(
        &self,
        machine_id: &MachineId,
        send: mpsc::UnboundedSender<HubToNode>,
    ) -> AttachedLink {
        let mut state = self.state.lock().unwrap();
        state.next_link_id += 1;
        let id = state.next_link_id;
        state.links.insert(machine_id.clone(), Link { id, send });
        AttachedLink {
            state: self.state.clone(),
            machine_id: machine_id.clone(),
            id,
        }
    }

    /// Sends one frame that wants no reply over the machine's live link.
    pub fn send(&self, machine_id: &MachineId, frame: HubToNode) -> Result<(), NodeCommandError> {
        let state = self.state.lock().unwrap();
        let link = state
            .links
            .get(machine_id)
            .ok_or_else(|| NodeCommandError::offline(machine_id))?;
        link.send.send(frame).map_err(|_| lost(machine_id))
    }

    /// Whether the machine's node is linked now.
    pub fn linked(&self, machine_id: &MachineId) -> bool {
        self.state.lock().unwrap().links.contains_key(machine_id)
    }

    /// The node link hands over each reply frame. Only the machine a request went to may answer it, and only with the
    /// reply its request expects.
    pub fn resolve(&self, machine_id: &MachineId, frame: NodeToHub) {
        let Some((tag, id)) = reply_of(&frame) else {
            return;
        };
        // Owned: the frame moves to the waiter, and a second reply's waiter may take its place under the same id.
        let id = &id.to_owned();
        let mut state = self.state.lock().unwrap();
        let matches = state
            .pending
            .get(id)
            .is_some_and(|p| &p.machine_id == machine_id && p.reply == tag);
        if matches && let Some(p) = state.pending.remove(id) {
            let _ = p.done.send(frame);
            if let Some(then) = p.then {
                state.pending.insert(
                    id.clone(),
                    Pending {
                        done: then,
                        then: None,
                        ..p
                    },
                );
            }
        }
    }

    /// Sends one request over the machine's live link and waits for its reply, at most `wait`.
    async fn request(
        &self,
        machine_id: &MachineId,
        request: Value,
        reply: &'static str,
        wait: Duration,
    ) -> Result<NodeToHub, NodeCommandError> {
        self.request_then(machine_id, request, reply, wait, None)
            .await
            .map(|(frame, _)| frame)
    }

    /// `request`, and with `then`, a second reply to the same id goes there.
    async fn request_then(
        &self,
        machine_id: &MachineId,
        request: Value,
        reply: &'static str,
        wait: Duration,
        then: Option<oneshot::Sender<NodeToHub>>,
    ) -> Result<(NodeToHub, String), NodeCommandError> {
        let id = new_id();
        let mut request = request;
        request["id"] = json!(id);
        let frame: HubToNode = serde_json::from_value(request).map_err(|e| {
            NodeCommandError::new(machine_id, NodeCommandErrorReason::Invalid, e.to_string())
        })?;
        let rx = {
            let mut state = self.state.lock().unwrap();
            let Some(link) = state.links.get(machine_id) else {
                return Err(NodeCommandError::offline(machine_id));
            };
            let (link_id, send) = (link.id, link.send.clone());
            let (tx, rx) = oneshot::channel();
            state.pending.insert(
                id.clone(),
                Pending {
                    machine_id: machine_id.clone(),
                    link_id,
                    reply,
                    done: tx,
                    then,
                },
            );
            if send.send(frame).is_err() {
                state.pending.remove(&id);
                return Err(lost(machine_id));
            }
            rx
        };
        let outcome = tokio::time::timeout(wait, rx).await;
        // A reply or a lost link already took it out; a waiter for a second reply may stand in its place.
        match outcome {
            Ok(Ok(frame)) => Ok((frame, id)),
            Ok(Err(_)) => Err(lost(machine_id)),
            Err(_) => Err({
                self.state.lock().unwrap().pending.remove(&id);
                NodeCommandError::new(
                    machine_id,
                    NodeCommandErrorReason::NoReply,
                    format!(
                        "{machine_id}'s node did not answer within {} s",
                        wait.as_secs()
                    ),
                )
            }),
        }
    }

    /// `cmd_check` -> `cmd_result`.
    pub async fn run(
        &self,
        machine_id: &MachineId,
        input: CommandInput,
    ) -> Result<CmdResult, NodeCommandError> {
        let timeout_sec = input.timeout_sec.unwrap_or(DEFAULT_TIMEOUT_SEC);
        let invalid =
            |m: String| NodeCommandError::new(machine_id, NodeCommandErrorReason::Invalid, m);
        if !(1..=MAX_TIMEOUT_SEC).contains(&timeout_sec) {
            return Err(invalid(format!(
                "timeout must be 1-{MAX_TIMEOUT_SEC} s, got {timeout_sec}"
            )));
        }
        if !input.cwd.starts_with('/') {
            return Err(invalid(format!("cwd must be absolute, got {}", input.cwd)));
        }
        if input.argv.is_empty() || input.argv.len() > 64 {
            return Err(invalid("argv must have 1-64 entries".into()));
        }
        let request = json!({ "t": "cmd_check", "cwd": input.cwd, "argv": input.argv, "timeoutSec": timeout_sec });
        let wait = Duration::from_secs(u64::from(timeout_sec) + REPLY_GRACE_SEC);
        match self
            .request(machine_id, request, "cmd_result", wait)
            .await?
        {
            NodeToHub::CmdResult(r) => Ok(r),
            _ => unreachable!("resolve matches the reply tag"),
        }
    }

    /// Relays a sealed secret to the sink's node; the node answers with the fingerprint or why it could not write it.
    /// `input.id` is replaced.
    pub async fn deliver_secret(
        &self,
        machine_id: &MachineId,
        input: SecretDeliver,
    ) -> Result<SecretResult, NodeCommandError> {
        let request = serde_json::to_value(HubToNode::SecretDeliver(input)).unwrap_or_default();
        match self
            .request(
                machine_id,
                request,
                "secret_result",
                Duration::from_secs(SECRET_REPLY_SEC),
            )
            .await?
        {
            NodeToHub::SecretResult(r) => Ok(r),
            _ => unreachable!("resolve matches the reply tag"),
        }
    }

    /// Runs an approved command on the node, waiting up to its own timeout plus a grace. `input.id` is replaced.
    pub async fn run_gated(
        &self,
        machine_id: &MachineId,
        input: GatedRun,
    ) -> Result<GatedResult, NodeCommandError> {
        let request = serde_json::to_value(HubToNode::GatedRun(input)).unwrap_or_default();
        let timeout = request["timeoutSec"].as_u64().unwrap_or(0);
        let wait = Duration::from_secs(timeout + REPLY_GRACE_SEC);
        match self
            .request(machine_id, request, "gated_result", wait)
            .await?
        {
            NodeToHub::GatedResult(r) => Ok(r),
            _ => unreachable!("resolve matches the reply tag"),
        }
    }

    /// The doctor's node actions.
    pub async fn run_action(
        &self,
        machine_id: &MachineId,
        action: NodeActionKind,
    ) -> Result<NodeActionResult, NodeCommandError> {
        let wait = match action {
            NodeActionKind::Probe => 30,
            NodeActionKind::Update => UPDATE_WAIT_SEC,
        };
        let request = json!({ "t": "node_action", "action": action });
        self.node_action(machine_id, request, wait).await
    }

    /// A node's update to `update`: it answers once the new build is in place, before its restart, and again only
    /// if the service manager refused that restart ([`Refusal`]).
    pub async fn update_node(
        &self,
        machine_id: &MachineId,
        update: &fleetd_contracts::node_link::NodeUpdate,
    ) -> Result<(NodeActionResult, Refusal), NodeCommandError> {
        let request =
            json!({ "t": "node_action", "action": NodeActionKind::Update, "update": update });
        let (tx, rx) = oneshot::channel();
        let (frame, id) = self
            .request_then(
                machine_id,
                request,
                "node_action_result",
                Duration::from_secs(UPDATE_WAIT_SEC),
                Some(tx),
            )
            .await?;
        let refusal = Refusal {
            state: self.state.clone(),
            id,
            rx,
        };
        match frame {
            NodeToHub::NodeActionResult(r) => Ok((r, refusal)),
            _ => unreachable!("resolve matches the reply tag"),
        }
    }

    /// `session_host` -> `session_host_result`: one of an agent's session calls, answered by the runner's node for a
    /// session it hosts under `host_key`. Waits at most `wait` (a start launches a browser or a device).
    pub async fn host_session(
        &self,
        machine_id: &MachineId,
        host_key: &fleetd_contracts::machine_roles::HostKey,
        frame: &fleetd_contracts::browser::BrowserCallFrame,
        wait: Duration,
    ) -> Result<fleetd_contracts::browser::BrowserResultFrame, NodeCommandError> {
        let request = json!({ "t": "session_host", "hostKey": host_key, "frame": frame });
        match self
            .request(machine_id, request, "session_host_result", wait)
            .await?
        {
            NodeToHub::SessionHostResult(r) => Ok(r.frame),
            _ => unreachable!("resolve matches the reply tag"),
        }
    }

    async fn node_action(
        &self,
        machine_id: &MachineId,
        request: serde_json::Value,
        wait: u64,
    ) -> Result<NodeActionResult, NodeCommandError> {
        match self
            .request(
                machine_id,
                request,
                "node_action_result",
                Duration::from_secs(wait),
            )
            .await?
        {
            NodeToHub::NodeActionResult(r) => Ok(r),
            _ => unreachable!("resolve matches the reply tag"),
        }
    }
}

/// A node's second answer to its update, sent only when its restart was refused. Dropping it stops the wait.
pub struct Refusal {
    state: Arc<Mutex<State>>,
    id: String,
    rx: oneshot::Receiver<NodeToHub>,
}

impl Refusal {
    /// The refusal, once the node sent it.
    pub fn try_take(&mut self) -> Option<NodeActionResult> {
        match self.rx.try_recv() {
            Ok(NodeToHub::NodeActionResult(r)) => Some(r),
            _ => None,
        }
    }
}

impl Drop for Refusal {
    fn drop(&mut self) {
        self.state.lock().unwrap().pending.remove(&self.id);
    }
}

fn lost(machine_id: &MachineId) -> NodeCommandError {
    NodeCommandError::new(
        machine_id,
        NodeCommandErrorReason::Lost,
        format!("the link to {machine_id}'s node dropped while the command ran"),
    )
}

#[cfg(test)]
mod tests {
    use fleetd_contracts::node_link::NodeUpdate;
    use fleetd_contracts::prim::Text;

    use super::*;

    fn answer(id: &str, ok: bool, message: &str) -> NodeToHub {
        NodeToHub::NodeActionResult(NodeActionResult {
            id: Text::unchecked(id.to_owned()),
            ok,
            message: Text::unchecked(message.to_owned()),
            probe: None,
            stage: None,
        })
    }

    /// A node whose restart was refused answers its update twice; the second answer reaches the update's wait.
    #[tokio::test]
    async fn an_update_hears_a_second_answer_when_the_restart_was_refused() {
        let commands = Arc::new(NodeCommands::default());
        let builder = MachineId::unchecked("builder");
        let (tx, mut rx) = mpsc::unbounded_channel();
        let _link = commands.attach(&builder, tx);
        let update = NodeUpdate {
            version: Text::unchecked("0.0.0-nightly.202610261056+1b563d7".to_owned()),
            channel: fleetd_contracts::mcp::HubChannel::Nightly,
        };
        let asking = {
            let commands = commands.clone();
            let builder = builder.clone();
            tokio::spawn(async move { commands.update_node(&builder, &update).await })
        };
        let Some(HubToNode::NodeAction(action)) = rx.recv().await else {
            panic!("no node action");
        };
        let id = action.id.as_str();
        commands.resolve(&builder, answer(id, true, "restarting"));
        let (first, mut refusal) = asking.await.unwrap().unwrap();
        assert!(first.ok);
        assert_eq!(refusal.try_take(), None);
        // Only the machine asked may answer.
        commands.resolve(&MachineId::unchecked("laptop"), answer(id, false, "no"));
        assert_eq!(refusal.try_take(), None);
        commands.resolve(&builder, answer(id, false, "restart refused"));
        let second = refusal.try_take().unwrap();
        assert_eq!(
            (second.ok, second.message.as_str()),
            (false, "restart refused")
        );
        drop(refusal);
        assert!(commands.state.lock().unwrap().pending.is_empty());
    }
}
