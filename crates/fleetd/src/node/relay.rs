//! The node's ends of a session relay (hub/machine_roles/relay.rs), for sessions the hub placed on another machine
//! than their agent's. On the agent's machine, the broker's proxy hands each connection of the agent's driver to
//! [`to_hub`], which connects the session's relay on the hub. On the runner, each `relay_dial` from the hub is a
//! channel [`dial`] connects between the hub and the session's own end (its CDP proxy now; a device's stream later).
//!
//! The two nodes encrypt every message between them, from the session's relay key, which the agent's node made and
//! sealed to the runner with the session's secrets: the hub carries ciphertext alone, never what the agent typed or
//! the page showed. Each channel opens with a fresh salt from each end; each direction has its own key, derived from
//! the relay key and both salts, and each message's nonce is its count in that direction (XSalsa20-Poly1305). So the
//! hub can't replay a message, reflect one back to its sender, or carry one into another channel: none of them opens.
//! Neither end logs a message, a payload or the relay's URL, whose path is its token.
use std::sync::Mutex;
use std::time::Duration;

use crypto_secretbox::aead::{Aead, KeyInit};
use crypto_secretbox::{Key, Nonce, XSalsa20Poly1305};
use fleetd_contracts::machine_roles::{RELAY_PATH, RelayDialFrame, RelayStream};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Bytes, Message};

use super::browser::Broker;
use crate::hub::machine_roles::relay::{GONE_HEADER, gone_proof, hash};

/// As the proxy and the hub's relay allow: a full-page screenshot or a large DOM is several MB.
const MAX_MESSAGE: usize = 128 << 20;
const SALT: usize = 16;
/// How long a channel's end waits for the other's salt.
const SALT_WAIT: Duration = Duration::from_secs(15);

fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_frame_size(Some(MAX_MESSAGE))
        .max_message_size(Some(MAX_MESSAGE))
}

/// A session of this machine's agent that runs on another machine: its relay on the hub, and the key the two nodes
/// encrypt it with.
#[derive(Clone)]
pub struct Remote {
    pub url: String,
    /// Wiped when the last copy goes.
    pub key: zeroize::Zeroizing<[u8; 32]>,
    /// The machine hosting it, and its box key: a fill's value is sealed to it.
    pub runner: fleetd_contracts::ids::MachineId,
    pub runner_key: [u8; 32],
}

impl std::fmt::Debug for Remote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Remote { .. }")
    }
}

/// A new relay key, for a session about to start elsewhere; wiped when dropped.
pub fn new_key() -> zeroize::Zeroizing<[u8; 32]> {
    zeroize::Zeroizing::new(rand::random())
}

/// The hub's relay at `token`, from the hub's URL as node.json names it.
pub fn relay_url(hub: &str, token: &str) -> Result<String, String> {
    let mut url =
        reqwest::Url::parse(hub).map_err(|e| format!("hub URL '{hub}' does not parse: {e}"))?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_path(&format!("{RELAY_PATH}{token}"));
    url.set_query(None);
    url.set_fragment(None);
    let rest = &url.as_str()[url.scheme().len()..];
    Ok(format!("{scheme}{rest}"))
}

async fn connect(
    url: &str,
) -> Result<
    WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::Error,
> {
    tokio_tungstenite::connect_async_with_config(url, Some(config()), false)
        .await
        .map(|(ws, _)| ws)
}

/// Which node a channel's end is on: each sends under a key of its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Agent,
    Runner,
}

/// One channel's crypto: a key per direction, and the count of messages each way, which is each message's nonce.
pub struct Channel {
    send: XSalsa20Poly1305,
    recv: XSalsa20Poly1305,
    sent: u64,
    received: u64,
}

fn direction_key(
    relay_key: &[u8; 32],
    from: Side,
    agent_salt: &[u8],
    runner_salt: &[u8],
) -> XSalsa20Poly1305 {
    let label: &[u8] = match from {
        Side::Agent => b"fleetd relay 1: agent to runner",
        Side::Runner => b"fleetd relay 1: runner to agent",
    };
    let key = Sha256::new()
        .chain_update(label)
        .chain_update(relay_key)
        .chain_update(agent_salt)
        .chain_update(runner_salt)
        .finalize();
    XSalsa20Poly1305::new(Key::from_slice(&key))
}

fn nonce(count: u64) -> Nonce {
    let mut bytes = [0u8; 24];
    bytes[..8].copy_from_slice(&count.to_le_bytes());
    *Nonce::from_slice(&bytes)
}

impl Channel {
    /// `side`'s end of a channel, from the relay key, its own salt and the other end's.
    pub fn new(relay_key: &[u8; 32], side: Side, mine: &[u8], theirs: &[u8]) -> Self {
        let (agent_salt, runner_salt, other) = match side {
            Side::Agent => (mine, theirs, Side::Runner),
            Side::Runner => (theirs, mine, Side::Agent),
        };
        Self {
            send: direction_key(relay_key, side, agent_salt, runner_salt),
            recv: direction_key(relay_key, other, agent_salt, runner_salt),
            sent: 0,
            received: 0,
        }
    }

    /// A message for the other end: its kind (text 0, binary 1) and payload, sealed under the next count, as binary.
    pub fn seal(&mut self, message: Message) -> Option<Message> {
        let (kind, payload): (u8, Bytes) = match message {
            Message::Text(text) => (0, Bytes::copy_from_slice(text.as_bytes())),
            Message::Binary(bytes) => (1, bytes),
            // Control frames carry nothing of the session's; a close's reason is dropped.
            Message::Close(_) => return Some(Message::Close(None)),
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => return None,
        };
        let mut plain = Vec::with_capacity(payload.len() + 1);
        plain.push(kind);
        plain.extend_from_slice(&payload);
        let sealed = self
            .send
            .encrypt(&nonce(self.sent), plain.as_slice())
            .ok()?;
        self.sent += 1;
        Some(Message::Binary(sealed.into()))
    }

    /// The other end's next message, opened; None for anything else (a replay, a reflection, a message of another
    /// channel or out of order, or one the hub made up): the channel ends.
    pub fn open(&mut self, message: Message) -> Option<Message> {
        let sealed = match message {
            Message::Binary(bytes) => bytes,
            Message::Close(_) => return Some(Message::Close(None)),
            _ => return None,
        };
        let plain = self
            .recv
            .decrypt(&nonce(self.received), sealed.as_ref())
            .ok()?;
        self.received += 1;
        let (kind, payload) = plain.split_first()?;
        match kind {
            0 => String::from_utf8(payload.to_vec())
                .ok()
                .map(|t| Message::Text(t.into())),
            1 => Some(Message::Binary(Bytes::copy_from_slice(payload))),
            _ => None,
        }
    }
}

/// What came of a driver's connection.
#[derive(Debug, PartialEq, Eq)]
pub enum ToHub {
    /// Piped until either side closed.
    Piped,
    /// The relay itself said the session ended, with the proof only it can give for this token.
    Gone,
    /// The hub couldn't be reached, or something in front of it refused.
    Unreachable,
}

/// Whether a refused connection is the relay's own word that the session ended: 410 with the proof of the token
/// (hub/machine_roles/relay.rs). A 403 from a proxy in front of the hub proves nothing.
fn relay_says_gone(error: &tokio_tungstenite::tungstenite::Error, relay_url: &str) -> bool {
    let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
        return false;
    };
    let token = relay_url.rsplit('/').next().unwrap_or_default();
    response.status() == 410
        && response
            .headers()
            .get(GONE_HEADER)
            .and_then(|v| v.to_str().ok())
            == Some(gone_proof(&hash(token)).as_str())
}

/// The agent's side: one connection of its driver, piped to the session's relay on the hub, sealed.
pub async fn to_hub<S>(mut driver: WebSocketStream<S>, remote: &Remote) -> ToHub
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    match connect(&remote.url).await {
        Ok(hub) => {
            pipe_sealed(driver, hub, &remote.key, Side::Agent).await;
            ToHub::Piped
        }
        Err(e) => {
            let gone = relay_says_gone(&e, &remote.url);
            // Its error may quote the URL, and with it the token.
            tracing::info!(gone, "session relay: hub refused or not reached");
            let reason = if gone {
                "No browser session is open: call session_start first."
            } else {
                "the browser's machine can't be reached through the hub"
            };
            let _ = driver
                .close(Some(CloseFrame {
                    code: if gone {
                        CloseCode::Policy
                    } else {
                        CloseCode::Again
                    },
                    reason: reason.into(),
                }))
                .await;
            if gone {
                ToHub::Gone
            } else {
                ToHub::Unreachable
            }
        }
    }
}

/// The runner's side: the hub's channel for a session hosted here, piped to the session's own end, sealed with the
/// session's relay key.
pub async fn dial(hub: &str, broker: &Broker, frame: RelayDialFrame, key: &[u8; 32]) {
    let target = match frame.stream {
        RelayStream::Cdp => broker.cdp_url(frame.host_key.as_str()),
    };
    let (Some(target), Ok(relay)) = (target, relay_url(hub, frame.token.as_str())) else {
        tracing::info!("session relay: nothing here to connect");
        return;
    };
    let (session, hub) = match tokio::join!(connect(&target), connect(&relay)) {
        (Ok(session), Ok(hub)) => (session, hub),
        _ => {
            tracing::info!("session relay: channel not connected");
            return;
        }
    };
    pipe_sealed(session, hub, key, Side::Runner).await;
}

/// Opens the channel (each end's salt, through the hub), then pipes the plain side's messages sealed to the hub, and
/// the hub's opened to the plain side, until either side closes or a message doesn't open.
pub async fn pipe_sealed<A, B>(
    plain: WebSocketStream<A>,
    mut hub: WebSocketStream<B>,
    relay_key: &[u8; 32],
    side: Side,
) where
    A: AsyncRead + AsyncWrite + Unpin + Send,
    B: AsyncRead + AsyncWrite + Unpin + Send,
{
    let mine: [u8; SALT] = rand::random();
    if hub
        .send(Message::Binary(mine.to_vec().into()))
        .await
        .is_err()
    {
        return;
    }
    let theirs = loop {
        match tokio::time::timeout(SALT_WAIT, hub.next()).await {
            Ok(Some(Ok(Message::Binary(salt)))) if salt.len() == SALT => break salt,
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_)))) => continue,
            _ => {
                tracing::info!("session relay: channel not opened");
                return;
            }
        }
    };
    let channel = Mutex::new(Channel::new(relay_key, side, &mine, &theirs));
    let lock = || {
        channel
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    };
    let (mut plain_out, mut plain_in) = plain.split();
    let (mut hub_out, mut hub_in) = hub.split();
    let out = async {
        while let Some(Ok(message)) = plain_in.next().await {
            let end = matches!(message, Message::Close(_));
            let Some(sealed) = lock().seal(message) else {
                continue;
            };
            if hub_out.send(sealed).await.is_err() || end {
                break;
            }
        }
        let _ = hub_out.close().await;
    };
    let back = async {
        while let Some(Ok(message)) = hub_in.next().await {
            if matches!(
                message,
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_)
            ) {
                continue;
            }
            let Some(opened) = lock().open(message) else {
                tracing::info!("session relay: a message did not open; channel closed");
                break;
            };
            let end = matches!(opened, Message::Close(_));
            if plain_out.send(opened).await.is_err() || end {
                break;
            }
        }
        let _ = plain_out.close().await;
    };
    tokio::select! {
        () = out => {}
        () = back => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both ends of one channel, as the agent's and the runner's nodes make them from the salts they swapped.
    fn channel(key: &[u8; 32]) -> (Channel, Channel) {
        let (agent_salt, runner_salt): ([u8; SALT], [u8; SALT]) = (rand::random(), rand::random());
        (
            Channel::new(key, Side::Agent, &agent_salt, &runner_salt),
            Channel::new(key, Side::Runner, &runner_salt, &agent_salt),
        )
    }

    fn text(s: &str) -> Message {
        Message::Text(s.into())
    }

    #[test]
    fn what_goes_through_the_hub_is_sealed_and_opens_only_at_the_other_end() {
        let key = new_key();
        let (mut agent, mut runner) = channel(&key);
        let typed = text("{\"method\":\"Input.insertText\",\"text\":\"hunter2\"}");
        let sealed = agent.seal(typed.clone()).unwrap();
        let Message::Binary(bytes) = &sealed else {
            panic!("sealed as binary");
        };
        assert!(!bytes.windows(7).any(|w| w == b"hunter2"));
        assert_eq!(runner.open(sealed), Some(typed));
        let answer = text("{\"id\":1,\"result\":{}}");
        assert_eq!(
            agent.open(runner.seal(answer.clone()).unwrap()),
            Some(answer)
        );
        // A plain message from the hub is refused, not passed on.
        assert_eq!(runner.open(text("hi")), None);
    }

    /// The hub holds every sealed message it carried: replaying one, reflecting one back to its sender, or carrying
    /// one into another channel of the same session opens nowhere.
    #[test]
    fn the_hub_can_neither_replay_nor_reflect_a_message() {
        let key = new_key();
        let (mut agent, mut runner) = channel(&key);
        let first = agent.seal(text("Input.insertText hunter2")).unwrap();
        assert!(runner.open(first.clone()).is_some());
        // Replayed to the runner: its count has moved on.
        assert_eq!(runner.open(first.clone()), None);

        let (mut agent, mut runner) = channel(&key);
        let sent = agent.seal(text("Input.insertText hunter2")).unwrap();
        // Reflected back to the agent: the agent's own direction's key isn't the one it opens with.
        assert_eq!(agent.open(sent.clone()), None);
        // Out of order: the runner expects the first message, not the second.
        let (mut agent2, mut runner2) = channel(&key);
        let _skipped = agent2.seal(text("one")).unwrap();
        let second = agent2.seal(text("two")).unwrap();
        assert_eq!(runner2.open(second), None);
        // An earlier channel's first message, carried into this one: fresh salts made fresh keys.
        assert_eq!(runner.open(first), None);
        // The genuine first message still opens: what was refused moved no count on.
        assert!(runner.open(sent).is_some());
    }

    #[test]
    fn the_relay_is_on_the_hubs_own_address() {
        let token = "ab".repeat(32);
        assert_eq!(
            relay_url("http://devbox.example.ts.net:4790", &token).unwrap(),
            format!("ws://devbox.example.ts.net:4790/relay/{token}")
        );
        assert_eq!(
            relay_url("https://hub.example.com/", &token).unwrap(),
            format!("wss://hub.example.com/relay/{token}")
        );
    }

    /// Only the relay's 410 with the proof of the token says a session is gone; a proxy's 403 doesn't.
    #[test]
    fn only_the_relays_own_refusal_forgets_a_session() {
        let token = "cd".repeat(32);
        let url = format!("ws://devbox:4790/relay/{token}");
        let refusal = |status: u16, proof: Option<String>| {
            let mut response =
                tokio_tungstenite::tungstenite::http::Response::builder().status(status);
            if let Some(proof) = proof {
                response = response.header(GONE_HEADER, proof);
            }
            tokio_tungstenite::tungstenite::Error::Http(Box::new(response.body(None).unwrap()))
        };
        assert!(relay_says_gone(
            &refusal(410, Some(gone_proof(&hash(&token)))),
            &url
        ));
        assert!(!relay_says_gone(&refusal(403, None), &url), "a proxy's 403");
        assert!(
            !relay_says_gone(&refusal(410, None), &url),
            "a 410 without the proof"
        );
        let other = "ef".repeat(32);
        assert!(
            !relay_says_gone(&refusal(410, Some(gone_proof(&hash(&other)))), &url),
            "another token's proof"
        );
    }
}
