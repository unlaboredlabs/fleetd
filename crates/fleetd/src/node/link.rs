//! The hub link: challenge, signed hello, welcome, then heartbeats and the hub's requests until the socket ends or the
//! hub goes silent. Reconnects with backoff (1 s doubling to 30 s, ±20% jitter, reset by each welcome), and only gives
//! up when the hub refuses the node.
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::actions::run_node_action;
use super::cmd::run_cmd_check;
use super::identity::{NodeBoxKey, NodeIdentity};
use super::lead::LeadRelay;
use super::power::Wakes;
use super::secrets::{SecretsContext, deliver_secret, run_gated};
use super::sessions::SessionService;
use super::util::now_iso;
use super::wire::{
    Heartbeat, HubToNode, MachineId, NodeHello, NodeToHub, PROTOCOL_VERSION, ProtocolVersion, Text,
    Timestamp, close, decode_hub_frame, to_json,
};
use fleetd_contracts::model::SleptSpan;

const HEARTBEAT_EVERY: Duration = Duration::from_secs(15);
const SILENCE_TIMEOUT: Duration = Duration::from_secs(45);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The hub refused this node in a way retrying cannot fix (bad key or token, protocol mismatch).
#[derive(Debug)]
pub struct LinkFatal {
    pub reason: String,
}

impl std::fmt::Display for LinkFatal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "hub refused this node: {}", self.reason)
    }
}

enum LinkEnd {
    Lost(String),
    Fatal(LinkFatal),
    /// The machine woke from sleep: reconnect now, without backoff.
    Woke,
}

/// `<hub>/node/link` as a ws(s) URL.
pub fn link_url(hub: &str) -> Result<String, String> {
    let mut url =
        reqwest::Url::parse(hub).map_err(|e| format!("hub URL '{hub}' does not parse: {e}"))?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_path("/node/link");
    url.set_query(None);
    url.set_fragment(None);
    let rest = &url.as_str()[url.scheme().len()..];
    Ok(format!("{scheme}{rest}"))
}

pub struct LinkSettings {
    pub hub: String,
    pub machine_id: String,
    pub name: String,
    pub tags: Vec<String>,
    pub node_version: String,
}

pub struct NodeSecrets {
    pub box_key: NodeBoxKey,
    /// Where the node keeps its index of which sink holds which secret.
    pub home: PathBuf,
}

pub struct RunNodeOptions {
    pub settings: LinkSettings,
    pub identity: NodeIdentity,
    /// Sent on links until the hub first welcomes this node, then forgotten.
    pub enroll_token: Option<zeroize::Zeroizing<String>>,
    /// Runs after the first welcome of a link that carried the enroll token.
    pub on_enrolled: Option<Box<dyn FnOnce() + Send>>,
    /// Runs the hub's `session_call`s and feeds the machine and thread streams.
    pub node_sessions: SessionService,
    /// A wake ends the link at once (its socket died while asleep) and the next one reports the sleep.
    pub wakes: Arc<Wakes>,
    pub lead_calls: LeadRelay,
    /// Directories `cmd_check` and approved commands may run in (and below), and secret sinks may be written in.
    pub cmd_roots: Vec<String>,
    pub secrets: Option<NodeSecrets>,
}

/// Everything one link needs, shared with the tasks it starts.
struct Shared {
    settings: LinkSettings,
    identity: NodeIdentity,
    node_sessions: SessionService,
    wakes: Arc<Wakes>,
    lead_calls: LeadRelay,
    cmd_roots: Vec<String>,
    secrets: Option<NodeSecrets>,
}

impl Shared {
    fn secrets_ctx(&self) -> SecretsContext<'_> {
        SecretsContext {
            machine_id: &self.settings.machine_id,
            roots: &self.cmd_roots,
            home: self
                .secrets
                .as_ref()
                .map_or(std::path::Path::new(""), |s| s.home.as_path()),
            box_key: self.secrets.as_ref().map(|s| &s.box_key),
        }
    }
}

/// The node's main loop: keep a link to the hub, reconnecting with backoff. Only ends by returning the hub's refusal.
pub async fn run_node(options: RunNodeOptions) -> LinkFatal {
    let shared = Arc::new(Shared {
        settings: options.settings,
        identity: options.identity,
        node_sessions: options.node_sessions,
        wakes: options.wakes,
        lead_calls: options.lead_calls,
        cmd_roots: options.cmd_roots,
        secrets: options.secrets,
    });
    let mut enroll_token = options.enroll_token;
    let mut on_enrolled = options.on_enrolled;
    let mut attempt: u32 = 0;
    loop {
        let token_now = enroll_token.clone();
        let end = run_link_once(&shared, token_now.as_ref().map(|t| t.as_str()), &mut || {
            attempt = 0;
            if enroll_token.take().is_some()
                && let Some(enrolled) = on_enrolled.take()
            {
                enrolled();
            }
        })
        .await;
        match end {
            LinkEnd::Fatal(fatal) => return fatal,
            LinkEnd::Woke => {
                tracing::info!("the machine woke; linking to the hub again");
                continue;
            }
            LinkEnd::Lost(why) => tracing::warn!(%why, "hub link lost"),
        }
        let jitter: f64 = rand::thread_rng().gen_range(0.8..1.2);
        let delay = Duration::from_millis(
            (30_000f64.min(1_000.0 * 2f64.powi(attempt as i32)) * jitter).round() as u64,
        );
        attempt = attempt.saturating_add(1);
        tracing::info!(in_ms = delay.as_millis() as u64, "reconnecting to hub");
        tokio::time::sleep(delay).await;
    }
}

fn tag(frame: &HubToNode) -> &'static str {
    match frame {
        HubToNode::Challenge(_) => "challenge",
        HubToNode::Welcome(_) => "welcome",
        HubToNode::Heartbeat(_) => "hb",
        HubToNode::LeadResult(_) => "lead_result",
        HubToNode::CmdCheck(_) => "cmd_check",
        HubToNode::SecretDeliver(_) => "secret_deliver",
        HubToNode::GatedRun(_) => "gated_run",
        HubToNode::NodeAction(_) => "node_action",
        HubToNode::SessionCall(_) => "session_call",
        HubToNode::SpansAck(_) => "spans_ack",
    }
}

type WsStream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

/// The next hub frame within `timeout`, or how the link ended.
async fn next_frame(
    stream: &mut WsStream,
    timeout: Duration,
    waiting_for: &str,
) -> Result<HubToNode, LinkEnd> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let message = match tokio::time::timeout_at(deadline, stream.next()).await {
            Err(_) => {
                return Err(LinkEnd::Lost(format!(
                    "no {waiting_for} from the hub for {} s",
                    timeout.as_secs()
                )));
            }
            Ok(None) => return Err(LinkEnd::Lost("hub closed the link".into())),
            Ok(Some(Err(error))) => return Err(LinkEnd::Lost(error.to_string())),
            Ok(Some(Ok(message))) => message,
        };
        let raw = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Message::Close(frame) => {
                let (code, reason) = frame.map_or((1005, String::new()), |f| {
                    (u16::from(f.code), f.reason.to_string())
                });
                if code == close::UNAUTHORIZED || code == close::PROTOCOL_MISMATCH {
                    let reason = if reason.is_empty() {
                        format!("closed with {code}")
                    } else {
                        reason
                    };
                    return Err(LinkEnd::Fatal(LinkFatal { reason }));
                }
                return Err(LinkEnd::Lost(
                    format!("hub closed the link ({code} {reason})")
                        .trim()
                        .to_owned(),
                ));
            }
            // Pings are answered by tungstenite; neither counts as a frame.
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
        };
        return decode_hub_frame(&raw)
            .ok_or_else(|| LinkEnd::Lost("hub sent a frame that does not decode".into()));
    }
}

/// One link: succeeds (`Lost`) when it ends after or before a welcome, `Fatal` on a refusal.
async fn run_link_once(
    shared: &Arc<Shared>,
    enroll_token: Option<&str>,
    on_welcome: &mut dyn FnMut(),
) -> LinkEnd {
    let url = match link_url(&shared.settings.hub) {
        Ok(url) => url,
        Err(why) => return LinkEnd::Lost(why),
    };
    let ws = match tokio_tungstenite::connect_async(url.as_str()).await {
        Ok((ws, _)) => ws,
        Err(error) => return LinkEnd::Lost(format!("cannot reach the hub: {error}")),
    };
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    // Everything this link starts ends with it: a lost link kills its commands, and the hub fails its waits.
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(async move {
        while let Some(frame) = rx.recv().await {
            if sink.send(Message::Text(frame.into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let send = {
        let tx = tx.clone();
        move |frame: NodeToHub| {
            let _ = tx.send(to_json(&frame));
        }
    };

    let challenge = match next_frame(&mut stream, HANDSHAKE_TIMEOUT, "challenge").await {
        Ok(HubToNode::Challenge(challenge)) => challenge.nonce,
        Ok(other) => return LinkEnd::Lost(format!("expected a challenge, got {}", tag(&other))),
        Err(end) => return end,
    };
    send(NodeToHub::Hello(NodeHello {
        machine_id: MachineId::unchecked(shared.settings.machine_id.clone()),
        name: shared.settings.name.clone(),
        tags: shared.settings.tags.clone(),
        node_version: shared.settings.node_version.clone(),
        protocol: ProtocolVersion::CURRENT,
        pub_key: Text::unchecked(shared.identity.pub_key()),
        sig: Text::unchecked(shared.identity.sign(&challenge)),
        enroll_token: enroll_token.filter(|t| !t.is_empty()).map(Text::unchecked),
        box_pub_key: shared
            .secrets
            .as_ref()
            .map(|s| fleetd_contracts::secrets::BoxPublicKey::unchecked(s.box_key.public_key())),
        capabilities: vec![fleetd_contracts::node_link::CAP_REPOS.to_owned()],
    }));
    let hub_id = match next_frame(&mut stream, HANDSHAKE_TIMEOUT, "welcome").await {
        Ok(HubToNode::Welcome(welcome)) if welcome.protocol.get() != PROTOCOL_VERSION => {
            return LinkEnd::Fatal(LinkFatal {
                reason: format!(
                    "hub speaks protocol {}, node speaks {PROTOCOL_VERSION}: install matching fleetd versions",
                    welcome.protocol.get()
                ),
            });
        }
        Ok(HubToNode::Welcome(welcome)) => welcome.hub_id,
        Ok(other) => return LinkEnd::Lost(format!("expected a welcome, got {}", tag(&other))),
        Err(end) => return end,
    };
    on_welcome();
    tracing::info!(%hub_id, machine_id = %shared.settings.machine_id, "linked to hub");
    let mut woke = shared.wakes.watch();
    woke.borrow_and_update();
    for slept in shared.wakes.take() {
        if let Ok(span) = SleptSpan::new(slept.from_ms, slept.to_ms) {
            send(NodeToHub::Slept(span));
        }
    }

    {
        let tx = tx.clone();
        let sessions = shared.node_sessions.clone();
        tasks.spawn(async move {
            loop {
                tokio::time::sleep(HEARTBEAT_EVERY).await;
                let limits = sessions.login_limits();
                let load = tokio::task::spawn_blocking(move || super::load::read(limits))
                    .await
                    .ok()
                    .flatten();
                if tx
                    .send(to_json(&NodeToHub::Heartbeat(Heartbeat {
                        at: Timestamp::from(now_iso()),
                        load,
                    })))
                    .is_err()
                {
                    return;
                }
            }
        });
    }
    let _attached = shared.lead_calls.attach(tx.clone());
    let _sessions_attached = shared.node_sessions.attach(tx.clone());

    loop {
        while tasks.try_join_next().is_some() {}
        let frame = tokio::select! {
            next = next_frame(&mut stream, SILENCE_TIMEOUT, "frame") => match next {
                Ok(frame) => frame,
                Err(end) => return end,
            },
            _ = woke.changed() => return LinkEnd::Woke,
        };
        match frame {
            HubToNode::LeadResult(result) => shared.lead_calls.resolve(result),
            HubToNode::CmdCheck(check) => {
                let shared = shared.clone();
                let tx = tx.clone();
                tasks.spawn(async move {
                    let result = run_cmd_check(check, &shared.cmd_roots).await;
                    let _ = tx.send(to_json(&NodeToHub::CmdResult(result)));
                });
            }
            // Synchronous and short: written and wiped before the next frame is read.
            HubToNode::SecretDeliver(deliver) => send(NodeToHub::SecretResult(deliver_secret(
                &deliver,
                &shared.secrets_ctx(),
            ))),
            HubToNode::GatedRun(gated) => {
                let shared = shared.clone();
                let tx = tx.clone();
                tasks.spawn(async move {
                    let result = run_gated(gated, &shared.secrets_ctx()).await;
                    let _ = tx.send(to_json(&NodeToHub::GatedResult(result)));
                });
            }
            HubToNode::NodeAction(action) => {
                let tx = tx.clone();
                tasks.spawn(async move {
                    let result = run_node_action(action).await;
                    let _ = tx.send(to_json(&NodeToHub::NodeActionResult(result)));
                });
            }
            // Not on the link's task set: a call that started (a launch half way through a spawn) finishes even if
            // the link drops, and only its reply is lost.
            HubToNode::SessionCall(call) => {
                let service = shared.node_sessions.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let reply = service.handle(call).await;
                    let _ = tx.send(to_json(&NodeToHub::SessionReply(reply)));
                });
            }
            HubToNode::SpansAck(ack) => shared
                .node_sessions
                .spans_acked(ack.upto, ack.rewind == Some(true)),
            HubToNode::Challenge(_) | HubToNode::Welcome(_) | HubToNode::Heartbeat(_) => {}
        }
    }
}
