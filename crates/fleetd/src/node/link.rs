//! The hub link: challenge, signed hello, welcome, then the current T3 state and session, heartbeats and the hub's
//! requests until the socket ends or the hub goes silent. Reconnects with backoff (1 s doubling to 30 s, ±20%
//! jitter, reset by each welcome) whether or not T3 is up, and only gives up when the hub refuses the node.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use super::actions::{NodeActionDeps, run_node_action};
use super::cmd::run_cmd_check;
use super::identity::{NodeBoxKey, NodeIdentity};
use super::lead::LeadRelay;
use super::secrets::{SecretsContext, deliver_secret, run_gated};
use super::sessions::{SessionKeeper, SessionService};
use super::supervisor::{Probe, Restart, T3Info, T3State, T3Supervisor, T3Unreachable};
use super::util::now_iso;
use super::wire::{
    Heartbeat, HubToNode, MachineId, NodeHello, NodeT3Endpoint, NodeT3Session, NodeT3State,
    NodeToHub, PROTOCOL_VERSION, ProtocolVersion, T3RunState, Text, Timestamp, close,
    decode_hub_frame, to_json,
};

const HEARTBEAT_EVERY: Duration = Duration::from_secs(15);
const SILENCE_TIMEOUT: Duration = Duration::from_secs(45);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The hub refused this node in a way retrying cannot fix (bad key or token, protocol mismatch).
#[derive(Debug)]
pub struct LinkFatal {
    pub code: u16,
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

/// The commit of the checkout `t3_cmd` runs T3 from source in (`<checkout>/apps/server/src/bin.ts`). T3 from source
/// reports its package version whatever the commit, so the node adds the commit as semver build metadata.
pub fn t3_source_commit(t3_cmd: &[String]) -> Option<String> {
    let bin = t3_cmd
        .iter()
        .find(|arg| arg.ends_with("/apps/server/src/bin.ts"))?;
    let dir = std::path::Path::new(bin).parent()?;
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// fetch()'s useful part: "connect ECONNREFUSED 127.0.0.1:4712", "HTTP 503", a timeout.
fn describe(error: &reqwest::Error, url: &reqwest::Url) -> String {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            let host = url.host_str().unwrap_or_default();
            let port = url.port_or_known_default().unwrap_or_default();
            let why = match io.kind() {
                std::io::ErrorKind::ConnectionRefused => {
                    format!("connect ECONNREFUSED {host}:{port}")
                }
                _ => io.to_string(),
            };
            return why.chars().take(120).collect();
        }
        source = cause.source();
    }
    if error.is_timeout() {
        return "The operation was aborted due to timeout".into();
    }
    error.to_string().chars().take(120).collect()
}

/// T3's version (plus `+<commit>` when run from source) and orchestration protocol from its public environment
/// descriptor.
pub fn t3_info_probe(t3_url: String, source_commit: Option<String>) -> Probe {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        // Like Node's fetch: T3 is local or on the tailnet, never behind the user's HTTP proxy.
        .no_proxy()
        .build()
        .unwrap_or_default();
    Arc::new(move || {
        let client = client.clone();
        let t3_url = t3_url.clone();
        let source_commit = source_commit.clone();
        Box::pin(async move {
            let unreachable = |why: String| T3Unreachable {
                url: t3_url.clone(),
                why,
            };
            let url = reqwest::Url::parse(&t3_url)
                .and_then(|base| base.join("/.well-known/t3/environment"))
                .map_err(|e| unreachable(e.to_string()))?;
            let response = client
                .get(url.clone())
                .send()
                .await
                .map_err(|e| unreachable(describe(&e, &url)))?;
            if !response.status().is_success() {
                return Err(unreachable(format!("HTTP {}", response.status().as_u16())));
            }
            let body: serde_json::Value = response
                .json()
                .await
                .map_err(|e| unreachable(describe(&e, &url)))?;
            let version = body
                .get("serverVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let protocol = body
                .get("orchestrationProtocolVersion")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.0);
            Ok(T3Info {
                version: match &source_commit {
                    Some(commit) => format!("{version}+{commit}"),
                    None => version.to_owned(),
                },
                protocol: protocol as i64,
            })
        })
    })
}

pub struct LinkSettings {
    pub hub: String,
    pub machine_id: String,
    pub name: String,
    pub tags: Vec<String>,
    pub node_version: String,
    pub t3_url: String,
}

pub struct NodeSecrets {
    pub box_key: NodeBoxKey,
    /// Where the node keeps its index of which sink holds which secret.
    pub home: PathBuf,
}

pub struct RunNodeOptions {
    pub settings: LinkSettings,
    pub identity: NodeIdentity,
    pub t3_info: Probe,
    pub t3_restart: Option<Restart>,
    /// Sent on links until the hub first welcomes this node, then forgotten.
    pub enroll_token: Option<zeroize::Zeroizing<String>>,
    /// Runs after the first welcome of a link that carried the enroll token.
    pub on_enrolled: Option<Box<dyn FnOnce() + Send>>,
    pub sessions: Arc<dyn super::sessions::T3Sessions>,
    /// Runs the hub's `session_call`s and feeds the machine and thread streams.
    pub node_sessions: SessionService,
    pub lead_calls: LeadRelay,
    /// Directories `cmd_check` and approved commands may run in (and below), and secret sinks may be written in.
    pub cmd_roots: Vec<String>,
    pub secrets: Option<NodeSecrets>,
}

/// Everything one link needs, shared with the tasks it starts.
struct Shared {
    settings: LinkSettings,
    identity: NodeIdentity,
    t3: T3Supervisor,
    keeper: SessionKeeper,
    node_sessions: SessionService,
    lead_calls: LeadRelay,
    cmd_roots: Vec<String>,
    secrets: Option<NodeSecrets>,
    actions: NodeActionDeps,
}

impl Shared {
    fn endpoint(&self, info: &T3Info) -> NodeT3Endpoint {
        NodeT3Endpoint {
            url: self.settings.t3_url.clone(),
            version: info.version.clone(),
            protocol: fleetd_contracts::prim::AnyInt::unchecked(info.protocol),
        }
    }

    fn t3state(&self, current: &T3State) -> NodeToHub {
        let at = Timestamp::from(now_iso());
        NodeToHub::T3State(match current {
            T3State::Up(info) => NodeT3State {
                state: T3RunState::Up,
                reason: None,
                t3: Some(self.endpoint(info)),
                at,
            },
            T3State::Down(reason) => NodeT3State {
                state: T3RunState::Down,
                reason: Some(reason.clone()),
                t3: None,
                at,
            },
            T3State::Restarting(reason) => NodeT3State {
                state: T3RunState::Restarting,
                reason: Some(reason.clone()),
                t3: None,
                at,
            },
        })
    }

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

/// The node's main loop: supervise the local T3 and keep a link to the hub, reconnecting with backoff. Only ends by
/// returning the hub's refusal.
pub async fn run_node(options: RunNodeOptions) -> LinkFatal {
    let (t3, _supervising) =
        super::supervisor::T3Supervisor::start(options.t3_info, options.t3_restart.clone()).await;
    let keeper = SessionKeeper::start(options.sessions, t3.clone());
    let remint_keeper = keeper.remint_handle();
    let shared = Arc::new(Shared {
        settings: options.settings,
        identity: options.identity,
        t3,
        keeper,
        node_sessions: options.node_sessions,
        lead_calls: options.lead_calls,
        cmd_roots: options.cmd_roots,
        secrets: options.secrets,
        actions: NodeActionDeps {
            remint: Box::new(move || Box::pin(remint_keeper.remint_now())),
            restart: options.t3_restart,
        },
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
                    return Err(LinkEnd::Fatal(LinkFatal { code, reason }));
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
    let t3 = shared.t3.current();
    send(NodeToHub::Hello(NodeHello {
        machine_id: MachineId::unchecked(shared.settings.machine_id.clone()),
        name: shared.settings.name.clone(),
        tags: shared.settings.tags.clone(),
        node_version: shared.settings.node_version.clone(),
        protocol: ProtocolVersion::CURRENT,
        t3: match &t3 {
            T3State::Up(info) => Some(shared.endpoint(info)),
            _ => None,
        },
        pub_key: Text::unchecked(shared.identity.pub_key()),
        sig: Text::unchecked(shared.identity.sign(&challenge)),
        enroll_token: enroll_token.filter(|t| !t.is_empty()).map(Text::unchecked),
        box_pub_key: shared
            .secrets
            .as_ref()
            .map(|s| fleetd_contracts::secrets::BoxPublicKey::unchecked(s.box_key.public_key())),
    }));
    let hub_id = match next_frame(&mut stream, HANDSHAKE_TIMEOUT, "welcome").await {
        Ok(HubToNode::Welcome(welcome)) if welcome.protocol.get() != PROTOCOL_VERSION => {
            return LinkEnd::Fatal(LinkFatal {
                code: close::PROTOCOL_MISMATCH,
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

    // An up hello already said it all; a T3-less one still owes the hub the reason. Sends go out under this lock so
    // a session never overtakes the "up" it depends on.
    let reported = Arc::new(Mutex::new(t3.is_up().then_some(t3)));
    let report = {
        let shared = shared.clone();
        let reported = reported.clone();
        let tx = tx.clone();
        move |current: T3State| {
            let mut last = reported
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if last.as_ref() != Some(&current) {
                let _ = tx.send(to_json(&shared.t3state(&current)));
                *last = Some(current);
            }
        }
    };
    {
        let mut changes = shared.t3.subscribe();
        let report = report.clone();
        tasks.spawn(async move {
            loop {
                let current = changes.borrow_and_update().clone();
                report(current);
                if changes.changed().await.is_err() {
                    return;
                }
            }
        });
    }
    {
        let mut sessions = shared.keeper.subscribe();
        let shared = shared.clone();
        let tx = tx.clone();
        tasks.spawn(async move {
            loop {
                let kept = sessions.borrow_and_update().clone();
                if let Some(kept) = kept {
                    // The hub attaches a session only to a T3 it knows is up, so a fresh "up" goes first.
                    report(shared.t3.current());
                    let frame = NodeToHub::T3Session(NodeT3Session {
                        bearer: Text::unchecked(kept.session.bearer.as_str()),
                        expires_at: Timestamp::from(kept.session.expires_at.clone()),
                    });
                    let _ = tx.send(to_json(&frame));
                    kept.mark_delivered();
                }
                if sessions.changed().await.is_err() {
                    return;
                }
            }
        });
    }
    {
        let tx = tx.clone();
        tasks.spawn(async move {
            loop {
                tokio::time::sleep(HEARTBEAT_EVERY).await;
                if tx
                    .send(to_json(&NodeToHub::Heartbeat(Heartbeat {
                        at: Timestamp::from(now_iso()),
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
        let frame = match next_frame(&mut stream, SILENCE_TIMEOUT, "frame").await {
            Ok(frame) => frame,
            Err(end) => return end,
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
                let shared = shared.clone();
                let tx = tx.clone();
                tasks.spawn(async move {
                    let result = run_node_action(action, &shared.actions).await;
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
            HubToNode::Challenge(_) | HubToNode::Welcome(_) | HubToNode::Heartbeat(_) => {}
        }
    }
}
