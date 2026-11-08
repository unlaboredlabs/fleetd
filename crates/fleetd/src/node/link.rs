//! The hub link: challenge, signed hello, welcome, then heartbeats and the hub's requests until the socket ends or the
//! hub goes silent. Reconnects with backoff (250 ms doubling to 30 s, ±20% jitter, reset by each welcome: a hub that
//! restarts, as its update does, is back within a second), and only gives up when the hub refuses the node.
//! Silence is timed by bytes read, not whole frames, and a quiet link is pinged before it is given up on
//! ([`QUIET_PROBE`], [`QUIET_DEAD`]). With a hub that lists `link_deflate` both ways, frames go compressed
//! (crate::link_deflate).
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use super::actions::run_node_action;
use super::cmd::run_cmd_check_from;
use super::identity::{NodeBoxKey, NodeIdentity};
use super::lead::LeadRelay;
use super::power::Wakes;
use super::secrets::{SecretsContext, deliver_secret};
use super::sessions::SessionService;
use super::util::now_iso;
use super::wire::{
    GatedResult, Heartbeat, HubToNode, MachineId, NodeHello, NodeToHub, PROTOCOL_VERSION,
    ProtocolVersion, SecretResult, Text, Timestamp, close, decode_hub_frame, head_text, to_json,
};
use crate::link_deflate::{Deflater, Inflater, MIN_DEFLATE_BYTES};
use crate::link_frames::{BadFrames, Undecodable};
use fleetd_contracts::model::SleptSpan;
use fleetd_contracts::node_link::{HEARTBEAT_INTERVAL_SECS, HEARTBEAT_TIMEOUT_SECS};
use fleetd_contracts::sessions::{
    SessionCall, SessionError, SessionErrorCode, SessionReplyFrame, SessionResult,
};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const HEARTBEAT_EVERY: Duration = Duration::from_secs(HEARTBEAT_INTERVAL_SECS);
const SILENCE_TIMEOUT: Duration = Duration::from_secs(HEARTBEAT_TIMEOUT_SECS);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The dial and the WebSocket upgrade: a hub that takes the connection but never answers it is as gone as a silent one.
const CONNECT_TIMEOUT: Duration = SILENCE_TIMEOUT;
/// Nothing read for this long, a hub heartbeat 5 s late: the node pings, and any hub answers with a pong.
const QUIET_PROBE: Duration = Duration::from_secs(HEARTBEAT_INTERVAL_SECS + 5);
/// Nothing read for this long, the ping unanswered for 10 s: the link is gone (a dead wifi, a new NAT mapping), and
/// the node dials again 15 s sooner than [`SILENCE_TIMEOUT`] would. A frame still arriving is never silence.
const QUIET_DEAD: Duration = Duration::from_secs(HEARTBEAT_INTERVAL_SECS + 15);
/// How long a node that answered an update reads its watcher's verdict: a refused restart is decided within seconds.
const RESTART_WATCH: Duration = Duration::from_secs(crate::update::finish::HEALTH_WAIT_SECS);
/// The largest frame the node takes from its hub: an attachment's put_file with room to spare.
pub const LINK_MAX_FRAME_BYTES: usize = 64 << 20;
/// The largest frame of any other kind: tungstenite's own default.
pub const LINK_MAX_OTHER_FRAME_BYTES: usize = 16 << 20;

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
    /// The node's sessions (browser, android, desktop), when this machine runs any: its agents' own, and those the
    /// hub places here for agents elsewhere. Live view and takeover reach them over the link.
    pub sessions: Option<Arc<crate::node::device::Router>>,
    /// What agents' nodes sealed to this one for the sessions it hosts for them.
    pub hosted: crate::node::session_route::Hosted,
    /// The agents' Mac (node/agents_mac): a tool, never a runner, and its setup checks for the heartbeat.
    pub agents_mac: Option<crate::node::agents_mac::AgentsMac>,
    /// The agents' Mac's lending of its shell and simulators, while its tool is on (node/mac_tool).
    pub mac_host: Option<Arc<crate::node::mac_tool::host::Host>>,
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
    sessions: Option<Arc<crate::node::device::Router>>,
    hosted: crate::node::session_route::Hosted,
    agents_mac: Option<crate::node::agents_mac::AgentsMac>,
    mac_host: Option<Arc<crate::node::mac_tool::host::Host>>,
    /// Approved commands, which outlive the link they came on (node/gated.rs).
    gated: Arc<super::gated::GatedRuns>,
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
    let gated =
        super::gated::GatedRuns::new(&options.node_sessions.home(), &options.settings.machine_id);
    let shared = Arc::new(Shared {
        gated,
        settings: options.settings,
        identity: options.identity,
        node_sessions: options.node_sessions,
        wakes: options.wakes,
        lead_calls: options.lead_calls,
        cmd_roots: options.cmd_roots,
        secrets: options.secrets,
        sessions: options.sessions,
        hosted: options.hosted,
        agents_mac: options.agents_mac,
        mac_host: options.mac_host,
    });
    let mut enroll_token = options.enroll_token;
    let mut on_enrolled = options.on_enrolled;
    let mut attempt: u32 = 0;
    // One line when the link goes and one when it is back: the tries between log only at debug.
    let mut down = LinkDown::default();
    loop {
        let token_now = enroll_token.clone();
        let end = run_link_once(
            &shared,
            token_now.as_ref().map(|t| t.as_str()),
            &mut |hub_id: &str| {
                attempt = 0;
                down.back(hub_id, &shared.settings.machine_id);
                if enroll_token.take().is_some()
                    && let Some(enrolled) = on_enrolled.take()
                {
                    enrolled();
                }
            },
        )
        .await;
        let lost = match end {
            LinkEnd::Fatal(fatal) => return fatal,
            LinkEnd::Woke => {
                tracing::info!("the machine woke; linking to the hub again");
                continue;
            }
            LinkEnd::Lost(why) => why,
        };
        let jitter: f64 = rand::thread_rng().gen_range(0.8..1.2);
        let delay = reconnect_delay(attempt, jitter);
        attempt = attempt.saturating_add(1);
        down.lost(&lost, delay);
        tokio::time::sleep(delay).await;
    }
}

/// Since when the node has had no hub link, and whether it has had one at all.
#[derive(Default)]
struct LinkDown {
    since: Option<std::time::Instant>,
    linked_once: bool,
}

impl LinkDown {
    /// A try ended; `retry_in` until the next.
    fn lost(&mut self, why: &str, retry_in: Duration) {
        let retry_in_ms = retry_in.as_millis() as u64;
        if self.since.is_some() {
            tracing::debug!(%why, retry_in_ms, "hub link still down");
            return;
        }
        self.since = Some(std::time::Instant::now());
        tracing::warn!(%why, retry_in_ms, "hub link lost; reconnecting until it is back");
    }

    /// A welcome: the first link logs as linked, any later one as back.
    fn back(&mut self, hub_id: &str, machine_id: &str) {
        let since = self.since.take();
        if !std::mem::replace(&mut self.linked_once, true) {
            tracing::info!(%hub_id, %machine_id, "linked to hub");
        } else if let Some(since) = since {
            let down_s = since.elapsed().as_secs();
            tracing::info!(%hub_id, %machine_id, down_s, "hub link back");
        } else {
            // A relink after a wake, which reconnects without counting as a loss.
            tracing::info!(%hub_id, %machine_id, "linked to hub again");
        }
    }
}

/// The wait before reconnect `attempt` (0 first), `jitter` in 0.8..1.2.
fn reconnect_delay(attempt: u32, jitter: f64) -> Duration {
    let ms = 30_000f64.min(250.0 * 2f64.powi(attempt.min(16) as i32)) * jitter;
    Duration::from_millis(ms.round() as u64)
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
        HubToNode::GatedResume(_) => "gated_resume",
        HubToNode::NodeAction(_) => "node_action",
        HubToNode::SessionCall(_) => "session_call",
        HubToNode::SpansAck(_) => "spans_ack",
        HubToNode::BrowserWatch(_) => "browser_watch",
        HubToNode::BrowserInput(_) => "browser_input",
        HubToNode::BrowserControl(_) => "browser_control",
        HubToNode::SessionHost(_) => "session_host",
        HubToNode::RelayDial(_) => "relay_dial",
        HubToNode::SessionStep(_) => "session_step",
        HubToNode::SessionEnd(_) => "session_end",
        HubToNode::MacCall(_) => "mac_call",
    }
}

/// When the link last read a byte from the hub, as ms after `base`: a large frame still arriving keeps it live.
struct Heard {
    base: tokio::time::Instant,
    at_ms: AtomicU64,
}

impl Heard {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            base: tokio::time::Instant::now(),
            at_ms: AtomicU64::new(0),
        })
    }

    fn stamp(&self) {
        let ms = self.base.elapsed().as_millis() as u64;
        self.at_ms.fetch_max(ms, Ordering::Relaxed);
    }

    fn at(&self) -> tokio::time::Instant {
        self.base + Duration::from_millis(self.at_ms.load(Ordering::Relaxed))
    }
}

/// The link's TCP socket, stamping [`Heard`] on every read that brought bytes.
struct Stamped {
    tcp: tokio::net::TcpStream,
    heard: Arc<Heard>,
}

impl tokio::io::AsyncRead for Stamped {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.tcp).poll_read(cx, buf);
        if buf.filled().len() > before {
            self.heard.stamp();
        }
        polled
    }
}

impl tokio::io::AsyncWrite for Stamped {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.tcp).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.tcp).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.tcp).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[std::io::IoSlice<'_>],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.tcp).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.tcp.is_write_vectored()
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<Stamped>>;
type WsStream = futures_util::stream::SplitStream<Ws>;
type WsSink = futures_util::stream::SplitSink<Ws, Message>;

/// A hub message read off the link: its frame, or one that doesn't decode, which a live link refuses alone
/// (crate::link_frames). A frame isn't boxed: nearly every message is one.
#[allow(clippy::large_enum_variant)]
enum Read {
    Frame(HubToNode),
    Undecodable { bytes: usize, bad: Undecodable },
}

/// One hub message as a frame: `Ok(None)` for what isn't one (a ping, a pong, a frame over its cap), `Err` for how
/// the link ends. A Binary message is `link_deflate` data, which only a hub this node told it inflates sends.
fn decode_message(message: Message, inflater: &mut Inflater) -> Result<Option<Read>, LinkEnd> {
    let raw = match message {
        Message::Text(text) => text.to_string(),
        Message::Binary(bytes) => inflater
            .inflate(&bytes, LINK_MAX_FRAME_BYTES)
            .map_err(LinkEnd::Lost)?,
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
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => return Ok(None),
    };
    let frame = match decode_hub_frame(&raw) {
        Ok(frame) => frame,
        Err(e) => {
            let bad = Undecodable::of(&raw, &e);
            return Ok(Some(Read::Undecodable {
                bytes: raw.len(),
                bad,
            }));
        }
    };
    if !size_allowed(&frame, raw.len()) {
        // Never acted on: its sender's wait runs out, and the link stays up for the rest.
        tracing::warn!(
            kind = tag(&frame),
            bytes = raw.len(),
            "hub frame over the cap for anything but a file transfer; ignored"
        );
        return Ok(None);
    }
    Ok(Some(Read::Frame(frame)))
}

/// A hub frame that doesn't decode on a live link: logged, and answered when it was a request the node can answer;
/// the link's end once the minute's limit is past.
fn refused(
    bad_frames: &mut BadFrames,
    now_ms: i64,
    bytes: usize,
    bad: &Undecodable,
) -> Result<Option<NodeToHub>, LinkEnd> {
    if !bad_frames.take(now_ms) {
        tracing::warn!(tag = %bad.tag, bytes, error = %bad.error, "too many hub frames that do not decode; dropping the link");
        return Err(LinkEnd::Lost(
            "the hub sent too many frames that do not decode".into(),
        ));
    }
    tracing::warn!(tag = %bad.tag, bytes, error = %bad.error, "a hub frame does not decode; refused it alone");
    Ok(refusal(bad))
}

/// The error answer to a hub request the node couldn't read, so the hub's wait ends now. A `gated_resume` gets none:
/// the node can't say whether its command ran, and the hub asks again on its own.
fn refusal(bad: &Undecodable) -> Option<NodeToHub> {
    use fleetd_contracts::mcp::{ErrorCode, McpToolError};
    use fleetd_contracts::node_link::{CmdResult, NodeActionResult};
    let id = fleetd_contracts::prim::NonEmpty::unchecked(bad.id.as_deref()?);
    let why = format!(
        "the node could not read this {} (it and the hub may run different fleetd versions): {}",
        bad.tag, bad.error
    );
    Some(match bad.tag.as_str() {
        "cmd_check" => NodeToHub::CmdResult(CmdResult {
            id,
            exit_code: None,
            output_tail: head_text(&why),
            timed_out: false,
        }),
        "secret_deliver" => NodeToHub::SecretResult(SecretResult {
            id,
            fingerprint: None,
            error: Some(head_text(&why)),
        }),
        "gated_run" => NodeToHub::GatedResult(GatedResult {
            id,
            exit_code: None,
            output_tail: Text::unchecked(""),
            timed_out: false,
            error: Some(head_text(&why)),
            unknown: None,
        }),
        "node_action" => NodeToHub::NodeActionResult(NodeActionResult {
            id,
            ok: false,
            message: head_text(&why),
            probe: None,
            stage: None,
            login_url: None,
            steps: None,
            hosts: None,
        }),
        "session_call" => NodeToHub::SessionReply(SessionReplyFrame {
            id,
            result: SessionResult::Err(SessionError {
                code: SessionErrorCode::Invalid,
                message: head_text(&why),
                fix: None,
            }),
        }),
        "mac_call" => NodeToHub::MacResult(fleetd_contracts::mac::MacResultFrame {
            id,
            sealed: None,
            error: Some(McpToolError::new(ErrorCode::Invalid, why)),
        }),
        _ => return None,
    })
}

fn read_end(
    next: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>,
) -> Result<Message, LinkEnd> {
    match next {
        None => Err(LinkEnd::Lost("hub closed the link".into())),
        Some(Err(error)) => Err(LinkEnd::Lost(error.to_string())),
        Some(Ok(message)) => Ok(message),
    }
}

/// The next hub frame within `timeout` (the handshake's), or how the link ended.
async fn next_frame(
    stream: &mut WsStream,
    inflater: &mut Inflater,
    timeout: Duration,
    waiting_for: &str,
) -> Result<HubToNode, LinkEnd> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let Ok(next) = tokio::time::timeout_at(deadline, stream.next()).await else {
            return Err(LinkEnd::Lost(format!(
                "no {waiting_for} from the hub for {} s",
                timeout.as_secs()
            )));
        };
        match decode_message(read_end(next)?, inflater)? {
            Some(Read::Frame(frame)) => return Ok(frame),
            // The handshake has no room for a frame it can't read.
            Some(Read::Undecodable { bad, .. }) => {
                return Err(LinkEnd::Lost(format!(
                    "hub sent a {} frame that does not decode: {}",
                    bad.tag, bad.error
                )));
            }
            None => {}
        }
    }
}

/// How long a linked hub may be quiet: past `probe` the node pings it once, past `dead` the link is gone.
#[derive(Clone, Copy)]
struct Quiet {
    probe: Duration,
    dead: Duration,
}

/// The next frame of a linked hub. Quiet is timed from the last byte read ([`Heard`]), so a large frame arriving
/// slowly keeps the link; `ping` runs once per quiet spell (`pinged` holds which), and a pong ends the spell.
async fn next_live_frame(
    stream: &mut WsStream,
    inflater: &mut Inflater,
    heard: &Heard,
    quiet: Quiet,
    pinged: &mut Option<tokio::time::Instant>,
    ping: &dyn Fn(),
) -> Result<Read, LinkEnd> {
    loop {
        let last = heard.at();
        let now = tokio::time::Instant::now();
        if now >= last + quiet.dead {
            return Err(LinkEnd::Lost(format!(
                "nothing from the hub for {} s, and no answer to a ping",
                quiet.dead.as_secs()
            )));
        }
        if now >= last + quiet.probe && *pinged != Some(last) {
            *pinged = Some(last);
            ping();
        }
        let wake = if *pinged == Some(last) {
            last + quiet.dead
        } else {
            last + quiet.probe
        };
        tokio::select! {
            next = stream.next() => {
                if let Some(read) = decode_message(read_end(next)?, inflater)? {
                    return Ok(read);
                }
            }
            () = tokio::time::sleep_until(wake) => {}
        }
    }
}

/// An attachment (at most 25 MiB, base64 in one put_file frame) is over tungstenite's 16 MiB frame default, so the
/// socket takes LINK_MAX_FRAME_BYTES; `next_frame` holds every other frame to LINK_MAX_OTHER_FRAME_BYTES.
fn link_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_frame_size(Some(LINK_MAX_FRAME_BYTES))
        .max_message_size(Some(LINK_MAX_FRAME_BYTES))
}

/// Whether a frame of `len` bytes may be this large: only a file transfer goes past LINK_MAX_OTHER_FRAME_BYTES.
fn size_allowed(frame: &HubToNode, len: usize) -> bool {
    len <= LINK_MAX_OTHER_FRAME_BYTES
        || matches!(
            frame,
            HubToNode::SessionCall(c) if matches!(c.call, SessionCall::PutFile { .. })
        )
}

/// Dials the hub's link and upgrades it to a WebSocket within `within`. Without a bound, a hub that took the
/// connection and never answered it (one stalled, or stopped) held the node here for good, and it logged nothing.
async fn connect(url: &str, within: Duration) -> Result<(Ws, Arc<Heard>), String> {
    let dial = async {
        let request = url
            .into_client_request()
            .map_err(|e| format!("cannot reach the hub: {e}"))?;
        let host = request
            .uri()
            .host()
            .unwrap_or_default()
            .trim_matches(['[', ']'])
            .to_owned();
        let port =
            request
                .uri()
                .port_u16()
                .unwrap_or(if request.uri().scheme_str() == Some("wss") {
                    443
                } else {
                    80
                });
        let tcp = tokio::net::TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| format!("cannot reach the hub: {e}"))?;
        // Nagle off: the link's frames are small and answer each other, and holding one back for the last's ack costs
        // a delayed ack (40 ms) per round trip, as a screen's start and its first frame have several.
        let _ = tcp.set_nodelay(true);
        let heard = Heard::new();
        let stamped = Stamped {
            tcp,
            heard: heard.clone(),
        };
        let (ws, _) = tokio_tungstenite::client_async_tls_with_config(
            request,
            stamped,
            Some(link_config()),
            None,
        )
        .await
        .map_err(|e| format!("cannot reach the hub: {e}"))?;
        Ok((ws, heard))
    };
    match tokio::time::timeout(within, dial).await {
        Err(_) => Err(format!(
            "the hub did not answer the link within {} s",
            within.as_secs()
        )),
        Ok(result) => result,
    }
}

/// One link: succeeds (`Lost`) when it ends after or before a welcome, `Fatal` on a refusal.
async fn run_link_once(
    shared: &Arc<Shared>,
    enroll_token: Option<&str>,
    on_welcome: &mut dyn FnMut(&str),
) -> LinkEnd {
    let url = match link_url(&shared.settings.hub) {
        Ok(url) => url,
        Err(why) => return LinkEnd::Lost(why),
    };
    let (ws, heard) = match connect(&url, CONNECT_TIMEOUT).await {
        Ok(linked) => linked,
        Err(why) => return LinkEnd::Lost(why),
    };
    let (sink, mut stream) = ws.split();
    let mut inflater = Inflater::default();
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    // Answered once every frame queued before it is written: what an update's answer waits on before its restart.
    let (flush, flushes) = mpsc::unbounded_channel::<tokio::sync::oneshot::Sender<()>>();
    let (pings, pings_rx) = mpsc::unbounded_channel::<()>();
    // Browser sessions' screens wait in a slot of their own, newest only: they go when nothing else waits.
    let frames = Arc::new(crate::node::browser::FrameSlot::default());
    // On once a welcome lists `link_deflate`: the hello and anything before it always go as Text.
    let deflate = Arc::new(AtomicBool::new(false));
    // Everything this link starts ends with it: a lost link kills its commands, and the hub fails its waits.
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(write_frames(
        sink,
        Outgoing {
            rx,
            frames: frames.clone(),
            flushes,
            pings: pings_rx,
        },
        deflate.clone(),
    ));
    let send = {
        let tx = tx.clone();
        move |frame: NodeToHub| {
            let _ = tx.send(to_json(&frame));
        }
    };

    let challenge = match next_frame(&mut stream, &mut inflater, HANDSHAKE_TIMEOUT, "challenge")
        .await
    {
        Ok(HubToNode::Challenge(challenge)) => challenge.nonce,
        Ok(other) => return LinkEnd::Lost(format!("expected a challenge, got {}", tag(&other))),
        Err(end) => return end,
    };
    let hello = NodeHello {
        machine_id: MachineId::unchecked(shared.settings.machine_id.clone()),
        name: shared.settings.name.clone(),
        // Tags are gone; an older hub still reads the list.
        tags: Vec::new(),
        node_version: shared.settings.node_version.clone(),
        protocol: ProtocolVersion::CURRENT,
        pub_key: Text::unchecked(shared.identity.pub_key()),
        sig: Text::unchecked(shared.identity.sign(&challenge)),
        enroll_token: enroll_token.filter(|t| !t.is_empty()).map(Text::unchecked),
        box_pub_key: shared
            .secrets
            .as_ref()
            .map(|s| fleetd_contracts::secrets::BoxPublicKey::unchecked(s.box_key.public_key())),
        machine_fingerprint: crate::fingerprint::machine(),
        capabilities: vec![
            fleetd_contracts::node_link::CAP_REPOS.to_owned(),
            fleetd_contracts::node_link::CAP_DETACHED.to_owned(),
            fleetd_contracts::node_link::CAP_LANDED_LOG.to_owned(),
            fleetd_contracts::node_link::CAP_PROJECT_SETTINGS.to_owned(),
            fleetd_contracts::node_link::CAP_PROJECT_ENV_COPY.to_owned(),
            fleetd_contracts::node_link::CAP_MCP_SERVERS.to_owned(),
            fleetd_contracts::node_link::CAP_SKILLS.to_owned(),
            fleetd_contracts::node_link::CAP_ORDER_ENV.to_owned(),
            fleetd_contracts::node_link::CAP_WORKTREE_SETUP.to_owned(),
            fleetd_contracts::node_link::CAP_ALLOWED_ONLY.to_owned(),
            fleetd_contracts::node_link::CAP_SELF_UPDATE.to_owned(),
            fleetd_contracts::node_link::CAP_UPDATE_FETCH.to_owned(),
            fleetd_contracts::node_link::CAP_UPDATE_HOLD.to_owned(),
            fleetd_contracts::node_link::CAP_CLAUDE_INSTALL.to_owned(),
            fleetd_contracts::node_link::CAP_CLAUDE_LOGIN.to_owned(),
            fleetd_contracts::node_link::CAP_SESSION_SEAL.to_owned(),
            fleetd_contracts::node_link::CAP_CLAUDE_ACCOUNTS.to_owned(),
            fleetd_contracts::node_link::CAP_CLAUDE_RESEAL.to_owned(),
            fleetd_contracts::node_link::CAP_ONEPASSWORD.to_owned(),
            fleetd_contracts::node_link::CAP_ONEPASSWORD_CARDS.to_owned(),
            fleetd_contracts::node_link::CAP_CLAUDE_MODELS.to_owned(),
            fleetd_contracts::node_link::CAP_PROFILE_NAMES.to_owned(),
            fleetd_contracts::node_link::CAP_SYSTEM_PROMPT.to_owned(),
            fleetd_contracts::node_link::CAP_ASSISTANT.to_owned(),
            fleetd_contracts::node_link::CAP_FOLDER_MAKE.to_owned(),
            fleetd_contracts::node_link::CAP_SESSION_END.to_owned(),
            fleetd_contracts::node_link::CAP_NAVI_SIGNINS.to_owned(),
            fleetd_contracts::node_link::CAP_ISOLATED.to_owned(),
            fleetd_contracts::node_link::CAP_SCREEN_SETTINGS.to_owned(),
            fleetd_contracts::node_link::CAP_NAVI_ERASE.to_owned(),
            fleetd_contracts::node_link::CAP_ONE_LEAD_MODE.to_owned(),
            fleetd_contracts::node_link::CAP_PROJECT_ERASE.to_owned(),
            fleetd_contracts::node_link::CAP_NO_ASK_FILL.to_owned(),
            fleetd_contracts::node_link::CAP_PROJECT_SIGNINS.to_owned(),
            fleetd_contracts::node_link::CAP_LINK_DEFLATE.to_owned(),
            fleetd_contracts::node_link::CAP_GATED_RESUME.to_owned(),
            fleetd_contracts::node_link::CAP_HAS_FILE.to_owned(),
        ]
        .into_iter()
        .chain(
            // Live view and takeover, for a browser's, an emulator's or a desktop's sessions.
            shared
                .sessions
                .as_ref()
                .map(|_| fleetd_contracts::node_link::CAP_BROWSER.to_owned()),
        )
        .chain(
            shared
                .sessions
                .as_ref()
                .map(|_| fleetd_contracts::node_link::CAP_SESSION_HOST.to_owned()),
        )
        .chain(super::device::capabilities(&shared.node_sessions.home()))
        .chain(super::device::ios::capabilities(
            &shared.node_sessions.home(),
        ))
        .chain(
            shared
                .sessions
                .as_ref()
                .filter(|s| s.desktops.is_some())
                .map(|_| super::desktop::capabilities(&shared.node_sessions.home()))
                .unwrap_or_default(),
        )
        .collect(),
    };
    let hello = tool_only(shared.agents_mac.as_ref(), hello);
    // The hub inflates only for a hello that listed link_deflate (the agents' Mac keeps only some caps).
    let asked = hello.capabilities.clone();
    send(NodeToHub::Hello(hello));
    let hub_id = match next_frame(&mut stream, &mut inflater, HANDSHAKE_TIMEOUT, "welcome").await {
        Ok(HubToNode::Welcome(welcome)) if welcome.protocol.get() != PROTOCOL_VERSION => {
            return LinkEnd::Fatal(LinkFatal {
                reason: crate::protocol_behind(welcome.protocol.get(), PROTOCOL_VERSION).into(),
            });
        }
        Ok(HubToNode::Welcome(welcome)) => {
            deflate.store(compresses(&asked, &welcome.capabilities), Ordering::Relaxed);
            shared.lead_calls.set_hub_caps(welcome.capabilities);
            welcome.hub_id
        }
        Ok(other) => return LinkEnd::Lost(format!("expected a welcome, got {}", tag(&other))),
        Err(end) => return end,
    };
    on_welcome(hub_id.as_str());
    // For the watcher of an update's restart: this build came up and its hub took it.
    crate::update::finish::mark_up(&shared.node_sessions.home(), &shared.settings.node_version);
    let mut woke = shared.wakes.watch();
    woke.borrow_and_update();
    for slept in shared.wakes.take() {
        if let Ok(span) = SleptSpan::new(slept.from_ms, slept.to_ms) {
            send(NodeToHub::Slept(span));
        }
    }

    {
        let tx = tx.clone();
        let mac = shared.agents_mac.clone();
        let sessions = shared.node_sessions.clone();
        let running = shared.node_sessions.running();
        let screens = shared.sessions.clone();
        let hosted = shared.hosted.clone();
        tasks.spawn(async move {
            loop {
                tokio::time::sleep(HEARTBEAT_EVERY).await;
                let (limits, home) = (sessions.login_limits(), sessions.home());
                let (runs, live, hosted) = (
                    *running.borrow(),
                    screens.as_ref().map_or(0, |s| s.count()),
                    hosted.count(),
                );
                let (mut load, steps, busy) = tokio::task::spawn_blocking(move || {
                    (
                        super::load::read(limits, &home),
                        super::browser::record::steps::latest(),
                        Some(super::busy::read(runs, live, hosted, &home)),
                    )
                })
                .await
                .unwrap_or_default();
                if let (Some(load), Some(mac)) = (load.as_mut(), mac.as_ref()) {
                    load.mac = mac.health();
                }
                if tx
                    .send(to_json(&NodeToHub::Heartbeat(Heartbeat {
                        at: Timestamp::from(now_iso()),
                        load,
                        steps: fleetd_contracts::prim::List::unchecked(steps),
                        busy,
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

    let quiet = Quiet {
        probe: QUIET_PROBE,
        dead: QUIET_DEAD,
    };
    let mut pinged = None;
    let ping = move || {
        let _ = pings.send(());
    };
    let linked_at = tokio::time::Instant::now();
    let mut bad_frames = BadFrames::default();
    loop {
        while tasks.try_join_next().is_some() {}
        let frame = tokio::select! {
            next = next_live_frame(&mut stream, &mut inflater, &heard, quiet, &mut pinged, &ping) => match next {
                Ok(Read::Frame(frame)) => frame,
                Ok(Read::Undecodable { bytes, bad }) => {
                    let now_ms = i64::try_from(linked_at.elapsed().as_millis()).unwrap_or(i64::MAX);
                    match refused(&mut bad_frames, now_ms, bytes, &bad) {
                        Ok(Some(answer)) => send(answer),
                        Ok(None) => {}
                        Err(end) => return end,
                    }
                    continue;
                }
                Err(end) => return end,
            },
            _ = woke.changed() => return LinkEnd::Woke,
        };
        match frame {
            // Only to nodes listing CAP_BROWSER: a browser session's go to its broker, an Android session's to its
            // device (node/device/live.rs), a desktop's to the desktop sessions.
            frame @ (HubToNode::BrowserWatch(_)
            | HubToNode::BrowserInput(_)
            | HubToNode::BrowserControl(_)) => {
                if let HubToNode::BrowserWatch(watch) = &frame {
                    frames.set_budget(watch.session_id.as_str(), watch.kbps.filter(|_| watch.on));
                }
                if let Some(router) = &shared.sessions {
                    router.from_hub(frame, &frames);
                }
            }
            HubToNode::LeadResult(result) => shared.lead_calls.resolve(result),
            HubToNode::CmdCheck(check) => {
                let shared = shared.clone();
                let tx = tx.clone();
                tasks.spawn(async move {
                    let home = shared.secrets.as_ref().map(|s| s.home.as_path());
                    let result = run_cmd_check_from(check, &shared.cmd_roots, home).await;
                    let _ = tx.send(to_json(&NodeToHub::CmdResult(result)));
                });
            }
            // The agents' Mac takes no secret and runs no approved command: the hub sends none, and one that comes
            // anyway is refused unopened.
            HubToNode::SecretDeliver(deliver) if shared.agents_mac.is_some() => {
                send(NodeToHub::SecretResult(SecretResult {
                    id: deliver.id,
                    fingerprint: None,
                    error: Some(Text::unchecked(crate::node::agents_mac::TOOL_ONLY)),
                }))
            }
            HubToNode::GatedRun(gated) if shared.agents_mac.is_some() => {
                send(NodeToHub::GatedResult(GatedResult {
                    id: gated.id,
                    exit_code: None,
                    output_tail: Text::unchecked(""),
                    timed_out: false,
                    error: Some(Text::unchecked(crate::node::agents_mac::TOOL_ONLY)),
                    unknown: None,
                }))
            }
            HubToNode::SessionCall(call)
                if shared.agents_mac.is_some()
                    && !crate::node::agents_mac::session_call_allowed(&call.call) =>
            {
                send(NodeToHub::SessionReply(SessionReplyFrame {
                    id: call.id,
                    result: SessionResult::Err(SessionError {
                        code: SessionErrorCode::RunnerUnavailable,
                        message: Text::unchecked(crate::node::agents_mac::TOOL_ONLY),
                        fix: Some(
                            "start agents and projects on another machine; they use this Mac with `mac run` and `mac sim`"
                                .into(),
                        ),
                    }),
                }))
            }
            // A Navi's secure input: opened here and typed into its browser session's field by the broker.
            HubToNode::SecretDeliver(deliver)
                if deliver.sink.starts_with("fill:")
                    && let Some(broker) =
                        shared.sessions.as_ref().and_then(|r| r.browser.clone()) =>
            {
                let shared = shared.clone();
                let tx = tx.clone();
                tasks.spawn(async move {
                    let box_key = shared.secrets.as_ref().map(|s| &s.box_key);
                    let result = crate::node::browser::secure_input::deliver(
                        &broker,
                        &deliver,
                        box_key,
                        &shared.settings.machine_id,
                    )
                    .await;
                    let _ = tx.send(to_json(&NodeToHub::SecretResult(result)));
                });
            }
            // Synchronous and short: written and wiped before the next frame is read.
            HubToNode::SecretDeliver(deliver) => send(NodeToHub::SecretResult(deliver_secret(
                &deliver,
                &shared.secrets_ctx(),
            ))),
            // Not one of the link's tasks: an approved command runs to its end when the link drops, and the hub asks
            // for its kept result on the next (`gated_resume`).
            HubToNode::GatedRun(gated) => {
                let (shared, tx, hub_id) = (shared.clone(), tx.clone(), hub_id.clone());
                tokio::spawn(async move {
                    let result = shared.gated.run(gated, &hub_id, &shared.secrets_ctx()).await;
                    let _ = tx.send(to_json(&NodeToHub::GatedResult(result)));
                });
            }
            HubToNode::GatedResume(resume) => {
                let (shared, tx, hub_id) = (shared.clone(), tx.clone(), hub_id.clone());
                tasks.spawn(async move {
                    let result = shared.gated.resume(resume, &hub_id).await;
                    let _ = tx.send(to_json(&NodeToHub::GatedResult(result)));
                });
            }
            // The agents' Mac runs no claude: none is installed or logged in there.
            HubToNode::NodeAction(action)
                if shared.agents_mac.is_some()
                    && matches!(
                        action.action,
                        super::wire::NodeActionKind::Claude
                            | super::wire::NodeActionKind::ClaudeLogin
                            | super::wire::NodeActionKind::ClaudeLoginCode
                    ) =>
            {
                send(NodeToHub::NodeActionResult(
                    fleetd_contracts::node_link::NodeActionResult {
                        id: action.id,
                        ok: false,
                        message: Text::unchecked(crate::node::agents_mac::TOOL_ONLY),
                        probe: None,
                        stage: None,
                        login_url: None,
                        steps: None,
                        hosts: None,
                    },
                ))
            }
            HubToNode::NodeAction(action) => {
                let tx = tx.clone();
                let flush = flush.clone();
                let sessions = shared.node_sessions.clone();
                tasks.spawn(async move {
                    // A screen setting's answer is pending from now until it is on the link (node/screens.rs).
                    let screens = (action.action == super::wire::NodeActionKind::Screens)
                        .then(super::screens::ask);
                    let (result, watch) = run_node_action(action, &sessions).await;
                    let id = result.id.clone();
                    let _ = tx.send(to_json(&NodeToHub::NodeActionResult(result)));
                    if let Some(ask) = screens {
                        // A screen setting's restart waits for its answer to be on the link, as an update's does.
                        let (done, written) = tokio::sync::oneshot::channel();
                        if flush.send(done).is_ok() {
                            let _ =
                                tokio::time::timeout(crate::update::finish::ANSWER_WAIT, written)
                                    .await;
                        }
                        drop(ask);
                        return;
                    }
                    let Some(watch) = watch else { return };
                    // The answer is on the link: the watcher restarts this node now.
                    let (done, written) = tokio::sync::oneshot::channel();
                    if flush.send(done).is_ok() {
                        let _ =
                            tokio::time::timeout(crate::update::finish::ANSWER_WAIT, written).await;
                    }
                    crate::update::finish::mark_answered(&watch.answered);
                    // Still running once the watcher decided: the restart was refused, and the hub hears so now.
                    if let Some(f) =
                        super::update::not_restarted(&watch.verdict, RESTART_WATCH).await
                    {
                        let refused = super::actions::failed(id, &f);
                        let _ = tx.send(to_json(&NodeToHub::NodeActionResult(refused)));
                    }
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
            // Sessions hosted here for agents on other machines. Off the link's task set: a browser that started is
            // the broker's, and a relay channel lives as long as the agent's driver keeps it open.
            frame @ (HubToNode::SessionHost(_)
            | HubToNode::RelayDial(_)
            | HubToNode::SessionStep(_)) => {
                let (shared, tx) = (shared.clone(), tx.clone());
                tokio::spawn(async move {
                    let box_key = shared.secrets.as_ref().map(|s| &s.box_key);
                    let projects = shared.node_sessions.clone();
                    let hosted = super::session_route::host(
                        shared.sessions.as_ref().and_then(|s| s.browser.clone()),
                        shared.sessions.clone(),
                        &shared.settings.hub,
                        frame,
                        &shared.hosted,
                        box_key,
                        move |navi| projects.navi_folder(navi),
                    );
                    if let Some(result) = hosted.await {
                        let _ = tx.send(to_json(&NodeToHub::SessionHostResult(result)));
                    }
                });
            }
            // A step of an agent's for this Mac (node/mac_tool): off the link's task set, as a run may take a while.
            HubToNode::MacCall(call) => {
                let (shared, tx) = (shared.clone(), tx.clone());
                tokio::spawn(async move {
                    let result = super::mac_tool::answer(&shared.mac_host, call).await;
                    let _ = tx.send(to_json(&NodeToHub::MacResult(result)));
                });
            }
            HubToNode::SpansAck(ack) => shared
                .node_sessions
                .spans_acked(ack.upto, ack.rewind == Some(true)),
            // Only to nodes listing CAP_SESSION_END: the session's task ended, and that screen goes with it.
            HubToNode::SessionEnd(end) => {
                tracing::info!(session = %end.session_id, thread = %end.thread_id, "the hub ended a screen whose task ended");
                shared
                    .node_sessions
                    .end_screen(end.thread_id.as_str(), end.session_id.as_str());
            }
            HubToNode::Challenge(_) | HubToNode::Welcome(_) | HubToNode::Heartbeat(_) => {}
        }
    }
}

/// What the link's writer sends: frames in order, browser screens when nothing else waits, flush marks and pings.
struct Outgoing {
    rx: mpsc::UnboundedReceiver<String>,
    frames: Arc<crate::node::browser::FrameSlot>,
    flushes: mpsc::UnboundedReceiver<tokio::sync::oneshot::Sender<()>>,
    pings: mpsc::UnboundedReceiver<()>,
}

/// Writes the link's frames until the link ends: Text, or once `deflate` is on (the hub inflates), Binary
/// `link_deflate` data for any frame of at least [`MIN_DEFLATE_BYTES`].
async fn write_frames(mut sink: WsSink, mut out: Outgoing, deflate: Arc<AtomicBool>) {
    let mut deflater = Deflater::default();
    loop {
        let next = tokio::select! {
            biased;
            next = out.rx.recv() => match next {
                Some(frame) => vec![frame],
                None => break,
            },
            Some(()) = out.pings.recv() => {
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
                continue;
            }
            () = out.frames.notify.notified() => out.frames.take(),
            // Only with no frame waiting (`biased`): every frame queued before it went out.
            Some(done) = out.flushes.recv() => {
                let _ = done.send(());
                continue;
            }
        };
        for frame in next {
            let message = if frame.len() >= MIN_DEFLATE_BYTES && deflate.load(Ordering::Relaxed) {
                Message::Binary(deflater.deflate(&frame).into())
            } else {
                Message::Text(frame.into())
            };
            if sink.send(message).await.is_err() {
                let _ = sink.close().await;
                return;
            }
        }
    }
    let _ = sink.close().await;
}

/// The agents' Mac lists only a tool's calls (node/agents_mac); any other node, all it takes.
/// Whether the node sends compressed frames: only when its own hello listed `link_deflate`, so the hub keeps an
/// inflater for the link, and the welcome says the hub inflates.
fn compresses(hello: &[String], welcome: &[String]) -> bool {
    hello
        .iter()
        .any(|c| c == fleetd_contracts::node_link::CAP_LINK_DEFLATE)
        && welcome
            .iter()
            .any(|c| c == fleetd_contracts::node_link::HUB_CAP_LINK_DEFLATE)
}

fn tool_only(mac: Option<&crate::node::agents_mac::AgentsMac>, mut hello: NodeHello) -> NodeHello {
    if let Some(mac) = mac {
        hello.capabilities = crate::node::agents_mac::capabilities(hello.capabilities, mac.tool());
    }
    hello
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::mcp::ATTACHMENT_MAX_BYTES;

    /// The largest attachment reaches the node in the one frame the hub sends it in.
    #[tokio::test]
    async fn the_link_takes_a_put_file_of_the_largest_attachment() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/link", listener.local_addr().unwrap());
        // Base64 of 25 MiB, with room for the frame around it.
        let frame = "A".repeat(ATTACHMENT_MAX_BYTES.div_ceil(3) * 4 + 4096);
        let sent = frame.len();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            ws.send(Message::Text(frame.into())).await.unwrap();
            let _ = ws.next().await;
        });
        let (mut ws, _) =
            tokio_tungstenite::connect_async_with_config(url.as_str(), Some(link_config()), false)
                .await
                .unwrap();
        let Some(Ok(Message::Text(got))) = ws.next().await else {
            panic!("the frame did not arrive whole")
        };
        assert_eq!(got.len(), sent);
    }

    /// A hub that took the connection and never answered it (stalled, or stopped) held the node in its dial for good,
    /// so it never noticed the link was gone. The dial now gives up within its bound, and the next one links once the
    /// hub answers again.
    #[tokio::test]
    async fn a_hub_that_never_answers_the_link_is_given_up_on_and_dialled_again() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/node/link", listener.local_addr().unwrap());
        tokio::spawn(async move {
            // The stalled hub: the kernel takes the connection, and nothing ever answers its upgrade.
            let (_stalled, _) = listener.accept().await.unwrap();
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let _ = ws.next().await;
        });
        let started = tokio::time::Instant::now();
        let why = match connect(&url, Duration::from_millis(300)).await {
            Ok(_) => panic!("a hub that never answered linked"),
            Err(why) => why,
        };
        assert!(why.contains("did not answer the link"), "{why}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(connect(&url, Duration::from_secs(10)).await.is_ok());
    }

    /// A spell without the hub logs one line when the link goes and one when it is back, however many tries fail
    /// between.
    #[test]
    fn a_lost_link_logs_once_when_it_goes_and_once_when_it_is_back() {
        #[derive(Clone, Default)]
        struct Logs(Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Logs {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let logs = Logs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);

        let mut down = LinkDown::default();
        down.back("fleetd-devbox", "devbox");
        down.lost("no frame from the hub for 45 s", Duration::from_millis(250));
        for _ in 0..5 {
            down.lost(
                "cannot reach the hub: connection refused",
                Duration::from_secs(30),
            );
        }
        down.back("fleetd-devbox", "devbox");

        let text = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3, "{text}");
        assert!(lines[0].contains("linked to hub"), "{text}");
        assert!(lines[1].contains("hub link lost"), "{text}");
        assert!(
            lines[1].contains("no frame from the hub for 45 s"),
            "{text}"
        );
        assert!(lines[2].contains("hub link back"), "{text}");
    }

    /// A hub that restarts (its update) is dialled again within a quarter second, then less and less often.
    #[test]
    fn reconnects_start_fast_and_back_off_to_30_s() {
        let waits: Vec<u64> = (0..10)
            .map(|a| reconnect_delay(a, 1.0).as_millis() as u64)
            .collect();
        assert_eq!(
            waits,
            [
                250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000
            ]
        );
        assert_eq!(reconnect_delay(u32::MAX, 1.2), Duration::from_secs(36));
        assert_eq!(reconnect_delay(0, 0.8), Duration::from_millis(200));
    }

    /// A hub on a local socket: its side of the link, once the node dialled it with [`connect`].
    async fn linked() -> (
        Ws,
        Arc<Heard>,
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/node/link", listener.local_addr().unwrap());
        let hub = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(tcp).await.unwrap()
        });
        let (ws, heard) = connect(&url, Duration::from_secs(10)).await.unwrap();
        (ws, heard, hub.await.unwrap())
    }

    fn outgoing() -> (
        Outgoing,
        mpsc::UnboundedSender<String>,
        mpsc::UnboundedSender<()>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        let (_flush, flushes) = mpsc::unbounded_channel();
        let (pings, pings_rx) = mpsc::unbounded_channel();
        let out = Outgoing {
            rx,
            frames: Arc::default(),
            flushes,
            pings: pings_rx,
        };
        (out, tx, pings)
    }

    const ACK: &str = r#"{"t":"spans_ack","upto":7}"#;

    /// An older hub (no `link_deflate` in its welcome) gets Text, as before. A hub that lists it gets each frame of 64
    /// bytes or more as Binary that inflates, on one stream, and the short ones still as Text.
    #[tokio::test]
    async fn frames_go_compressed_only_once_the_hub_says_it_inflates() {
        let (ws, _heard, mut hub) = linked().await;
        let (sink, _stream) = ws.split();
        let (out, tx, _pings) = outgoing();
        let deflate = Arc::new(AtomicBool::new(false));
        tokio::spawn(write_frames(sink, out, deflate.clone()));
        let long = serde_json::json!({ "t": "heartbeat", "at": "2026-11-07T10:00:00Z", "pad": "x".repeat(500) })
            .to_string();

        tx.send(long.clone()).unwrap();
        match hub.next().await.unwrap().unwrap() {
            Message::Text(text) => assert_eq!(text.as_str(), long),
            other => panic!("an older hub got {other:?}"),
        }

        deflate.store(true, Ordering::Relaxed);
        let mut inflater = Inflater::default();
        for _ in 0..2 {
            tx.send(long.clone()).unwrap();
            let Message::Binary(data) = hub.next().await.unwrap().unwrap() else {
                panic!("a long frame went uncompressed")
            };
            assert!(
                data.len() < long.len() / 4,
                "{} of {}",
                data.len(),
                long.len()
            );
            assert_eq!(inflater.inflate(&data, 1 << 20).unwrap(), long);
        }
        tx.send(r#"{"t":"hb"}"#.to_owned()).unwrap();
        assert!(matches!(
            hub.next().await.unwrap().unwrap(),
            Message::Text(_)
        ));
    }

    /// Compressed only when both sides listed it: a hello without the cap (an agents' Mac before it kept it) never
    /// compresses toward a hub that has no inflater for it, whatever the welcome says.
    #[test]
    fn the_node_compresses_only_when_its_hello_asked_and_the_hub_inflates() {
        use fleetd_contracts::node_link::{
            CAP_LINK_DEFLATE, HUB_CAP_LINK_DEFLATE, HUB_CAP_SESSION_ROUTE,
        };
        let caps = |cs: &[&str]| cs.iter().map(|c| (*c).to_owned()).collect::<Vec<_>>();
        let hub = caps(&[HUB_CAP_SESSION_ROUTE, HUB_CAP_LINK_DEFLATE]);
        assert!(compresses(&caps(&[CAP_LINK_DEFLATE]), &hub));
        assert!(!compresses(&caps(&[]), &hub));
        assert!(!compresses(
            &caps(&[CAP_LINK_DEFLATE]),
            &caps(&[HUB_CAP_SESSION_ROUTE])
        ));
    }

    /// A hub's Binary frame is `link_deflate` data and reads as its frame; Text still reads as JSON; data that
    /// doesn't inflate ends the link instead of being taken as a frame.
    #[test]
    fn a_compressed_hub_frame_reads_as_its_frame() {
        let (mut deflater, mut inflater) = (Deflater::default(), Inflater::default());
        let binary = Message::Binary(deflater.deflate(ACK).into());
        assert!(matches!(
            decode_message(binary, &mut inflater),
            Ok(Some(Read::Frame(HubToNode::SpansAck(_))))
        ));
        assert!(matches!(
            decode_message(Message::Text(ACK.into()), &mut inflater),
            Ok(Some(Read::Frame(HubToNode::SpansAck(_))))
        ));
        let garbage = Message::Binary(vec![0xff; 16].into());
        assert!(matches!(
            decode_message(garbage, &mut Inflater::default()),
            Err(LinkEnd::Lost(_))
        ));
    }

    /// One hub frame that doesn't decode (a newer hub's request, a field out of range) is refused alone on a live
    /// link: the frames around it still read, and a request among them is answered with an error so the hub's wait
    /// ends. Only a flood of them within a minute drops the link.
    #[tokio::test]
    async fn an_undecodable_hub_frame_is_refused_alone_and_the_link_stays_up() {
        let (ws, heard, mut hub) = linked().await;
        let (_sink, mut stream) = ws.split();
        // An argv must hold at least one word.
        let bad = serde_json::json!({ "t": "cmd_check", "id": "c1", "cwd": "/w", "argv": [], "timeoutSec": 5 })
            .to_string();
        for frame in [ACK.to_owned(), bad.clone(), ACK.to_owned()] {
            hub.send(Message::Text(frame.into())).await.unwrap();
        }
        let mut bad_frames = BadFrames::default();
        let mut read = Vec::new();
        for _ in 0..3 {
            match next_live_frame(
                &mut stream,
                &mut Inflater::default(),
                &heard,
                QUICK,
                &mut None,
                &|| {},
            )
            .await
            {
                Ok(Read::Frame(frame)) => read.push(tag(&frame).to_owned()),
                Ok(Read::Undecodable {
                    bytes,
                    bad: refused_frame,
                }) => {
                    assert_eq!(
                        (bytes, refused_frame.tag.as_str()),
                        (bad.len(), "cmd_check")
                    );
                    let Ok(Some(NodeToHub::CmdResult(answer))) =
                        refused(&mut bad_frames, 0, bytes, &refused_frame)
                    else {
                        panic!("the cmd_check went unanswered")
                    };
                    assert_eq!(answer.id.as_str(), "c1");
                    assert_eq!(answer.exit_code, None);
                    assert!(
                        answer
                            .output_tail
                            .as_str()
                            .contains("could not read this cmd_check")
                    );
                    read.push("refused".into());
                }
                Err(_) => panic!("the link ended on one bad frame"),
            }
        }
        assert_eq!(read, ["spans_ack", "refused", "spans_ack"]);

        // A frame that names no request is refused without an answer; past the minute's limit, the link ends.
        let e = decode_hub_frame(r#"{"t":"spans_ack"}"#).unwrap_err();
        let unasked = Undecodable::of(r#"{"t":"spans_ack"}"#, &e);
        for _ in 1..crate::link_frames::BAD_FRAMES_PER_MINUTE {
            assert!(matches!(
                refused(&mut bad_frames, 1_000, 17, &unasked),
                Ok(None)
            ));
        }
        assert!(matches!(
            refused(&mut bad_frames, 2_000, 17, &unasked),
            Err(LinkEnd::Lost(_))
        ));
    }

    /// Each hub request the node can answer gets its own reply kind back, which the hub's wait for it takes.
    #[test]
    fn every_request_the_node_cannot_read_is_answered_in_its_reply_kind() {
        let e = decode_hub_frame("{}").unwrap_err();
        for (asked, reply) in [
            ("cmd_check", "cmd_result"),
            ("secret_deliver", "secret_result"),
            ("gated_run", "gated_result"),
            ("node_action", "node_action_result"),
            ("session_call", "session_reply"),
            ("mac_call", "mac_result"),
        ] {
            let text = serde_json::json!({ "t": asked, "id": "r1" }).to_string();
            let answer = refusal(&Undecodable::of(&text, &e)).expect(asked);
            let json: serde_json::Value = serde_json::from_str(&to_json(&answer)).unwrap();
            assert_eq!(
                (json["t"].as_str(), json["id"].as_str()),
                (Some(reply), Some("r1"))
            );
            // It decodes as the hub reads it.
            serde_json::from_value::<NodeToHub>(json).expect(reply);
        }
        let text = serde_json::json!({ "t": "gated_resume", "id": "r1" }).to_string();
        assert!(refusal(&Undecodable::of(&text, &e)).is_none());
    }

    const QUICK: Quiet = Quiet {
        probe: Duration::from_millis(300),
        dead: Duration::from_millis(700),
    };

    /// A frame that takes far longer than the quiet bound to arrive (a large one on a slow link) keeps the link: it
    /// counts from the last byte, not the last whole frame.
    #[tokio::test]
    async fn a_frame_arriving_slowly_keeps_the_link() {
        use tokio::io::AsyncWriteExt;
        let (ws, heard, mut hub) = linked().await;
        let (_sink, mut stream) = ws.split();
        let mut payload = ACK.to_owned();
        payload.push_str(&" ".repeat(300 - ACK.len()));
        let mut raw = vec![0x81, 126, 0, 0];
        raw[2..4].copy_from_slice(&(payload.len() as u16).to_be_bytes());
        raw.extend_from_slice(payload.as_bytes());
        tokio::spawn(async move {
            // 2 s in all, 100 ms between bytes, under the 300 ms probe bound each time.
            for chunk in raw.chunks(16) {
                hub.get_mut().write_all(chunk).await.unwrap();
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            std::future::pending::<()>().await;
        });
        let pings = std::sync::atomic::AtomicUsize::new(0);
        let started = tokio::time::Instant::now();
        let frame = next_live_frame(
            &mut stream,
            &mut Inflater::default(),
            &heard,
            QUICK,
            &mut None,
            &|| {
                pings.fetch_add(1, Ordering::Relaxed);
            },
        )
        .await;
        assert!(matches!(frame, Ok(Read::Frame(HubToNode::SpansAck(_)))));
        assert!(started.elapsed() > Duration::from_millis(1500));
        assert_eq!(pings.load(Ordering::Relaxed), 0);
    }

    /// A quiet link is pinged once; a hub that answers keeps it however long nothing else comes, and one that never
    /// does is given up on at the dead bound, not the 45 s a missing frame took before.
    #[tokio::test]
    async fn a_quiet_hub_is_pinged_and_dropped_only_if_it_never_answers() {
        // Answers: the hub reads, so tungstenite pongs each ping.
        let (ws, heard, mut hub) = linked().await;
        let (sink, mut stream) = ws.split();
        let (out, _tx, pings) = outgoing();
        tokio::spawn(write_frames(sink, out, Arc::new(AtomicBool::new(false))));
        tokio::spawn(async move { while hub.next().await.is_some() {} });
        let sent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ping = {
            let sent = sent.clone();
            move || {
                sent.fetch_add(1, Ordering::Relaxed);
                let _ = pings.send(());
            }
        };
        let quiet = tokio::time::timeout(
            Duration::from_secs(3),
            next_live_frame(
                &mut stream,
                &mut Inflater::default(),
                &heard,
                QUICK,
                &mut None,
                &ping,
            ),
        )
        .await;
        assert!(quiet.is_err(), "a hub answering its pings was given up on");
        assert!(
            sent.load(Ordering::Relaxed) >= 3,
            "one ping per quiet spell"
        );

        // Never answers: the hub took the link and reads nothing.
        let (ws, heard, _hub) = linked().await;
        let (_sink, mut stream) = ws.split();
        let pinged = std::sync::atomic::AtomicUsize::new(0);
        // Quiet counts from the last byte the handshake read, which comes a little before this line: time it from there.
        let started = heard.at();
        let end = next_live_frame(
            &mut stream,
            &mut Inflater::default(),
            &heard,
            QUICK,
            &mut None,
            &|| {
                pinged.fetch_add(1, Ordering::Relaxed);
            },
        )
        .await;
        assert!(matches!(&end, Err(LinkEnd::Lost(why)) if why.contains("no answer to a ping")));
        assert_eq!(pinged.load(Ordering::Relaxed), 1);
        let took = started.elapsed();
        assert!(
            took >= QUICK.dead && took < Duration::from_secs(2),
            "{took:?}"
        );
    }

    /// The live bounds sit between the hub's heartbeat and the old silence timeout: a heartbeat late by 5 s probes,
    /// and a link is given up on 15 s sooner than before.
    #[test]
    fn a_dead_link_is_noticed_sooner_than_it_was() {
        assert!(QUIET_PROBE > HEARTBEAT_EVERY);
        assert!(QUIET_DEAD > QUIET_PROBE);
        assert_eq!(SILENCE_TIMEOUT - QUIET_DEAD, Duration::from_secs(15));
    }

    /// Only a file transfer may use the room the socket has for one: any other frame over 16 MiB is ignored.
    #[test]
    fn only_a_put_file_frame_goes_past_16_mib() {
        let frame = |call: serde_json::Value| {
            decode_hub_frame(
                &serde_json::json!({ "t": "session_call", "id": "1", "call": call }).to_string(),
            )
            .unwrap()
        };
        let put = frame(serde_json::json!({ "op": "put_file", "projectId": "app",
            "relPath": ".fleetd/attachments/W1/a.txt", "dataB64": "aGk=" }));
        let read = frame(serde_json::json!({ "op": "default_branch", "projectId": "app" }));
        let big = LINK_MAX_OTHER_FRAME_BYTES + 1;
        assert!(size_allowed(&put, big));
        assert!(size_allowed(&read, LINK_MAX_OTHER_FRAME_BYTES));
        assert!(!size_allowed(&read, big));
    }
}
