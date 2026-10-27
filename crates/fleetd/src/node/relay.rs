//! The node's ends of a session relay (hub/machine_roles/relay.rs), for sessions the hub placed on another machine
//! than their agent's. On the agent's machine, the broker's proxy hands each connection of the agent's driver to
//! [`to_hub`], which connects the session's relay on the hub. On the runner, each `relay_dial` from the hub is a
//! channel [`dial`] connects between the hub and the session's own end (its CDP proxy now; a device's stream later).
//!
//! The two nodes encrypt every message between them with the session's relay key (XSalsa20-Poly1305, a fresh nonce
//! each), which the agent's node made and sealed to the runner with the session's secrets: the hub carries ciphertext
//! alone, never what the agent typed or the page showed. Neither end logs a message, a payload or the relay's URL,
//! whose path is its token.
use crypto_secretbox::aead::{Aead, AeadCore, KeyInit, OsRng};
use crypto_secretbox::{Nonce, XSalsa20Poly1305};
use fleetd_contracts::machine_roles::{RELAY_PATH, RelayDialFrame, RelayStream};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Bytes, Message};

use super::browser::Broker;

/// As the proxy and the hub's relay allow: a full-page screenshot or a large DOM is several MB.
const MAX_MESSAGE: usize = 128 << 20;
const NONCE: usize = 24;

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
    pub key: [u8; 32],
    /// The machine hosting it, and its box key: a fill's value is sealed to it.
    pub runner: fleetd_contracts::ids::MachineId,
    pub runner_key: [u8; 32],
}

impl std::fmt::Debug for Remote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Remote { .. }")
    }
}

/// A new relay key, for a session about to start elsewhere.
pub fn new_key() -> [u8; 32] {
    rand::random()
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

/// A message for the hub: its kind (text 0, binary 1) and payload, sealed under a fresh nonce, as binary.
fn seal(cipher: &XSalsa20Poly1305, message: Message) -> Option<Message> {
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
    let nonce = XSalsa20Poly1305::generate_nonce(&mut OsRng);
    let sealed = cipher.encrypt(&nonce, plain.as_slice()).ok()?;
    let mut out = Vec::with_capacity(NONCE + sealed.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Some(Message::Binary(out.into()))
}

/// A message from the hub, opened; None for one that doesn't open under the session's key (the channel ends).
fn open(cipher: &XSalsa20Poly1305, message: Message) -> Option<Message> {
    let bytes = match message {
        Message::Binary(bytes) => bytes,
        Message::Close(_) => return Some(Message::Close(None)),
        _ => return None,
    };
    if bytes.len() <= NONCE {
        return None;
    }
    let (nonce, sealed) = bytes.split_at(NONCE);
    let plain = cipher.decrypt(Nonce::from_slice(nonce), sealed).ok()?;
    let (kind, payload) = plain.split_first()?;
    match kind {
        0 => String::from_utf8(payload.to_vec())
            .ok()
            .map(|t| Message::Text(t.into())),
        1 => Some(Message::Binary(Bytes::copy_from_slice(payload))),
        _ => None,
    }
}

/// What came of a driver's connection.
#[derive(Debug, PartialEq, Eq)]
pub enum ToHub {
    /// Piped until either side closed.
    Piped,
    /// The hub knows no such session any more: it ended.
    Gone,
    /// The hub couldn't be reached.
    Unreachable,
}

/// The agent's side: one connection of its driver, piped to the session's relay on the hub, sealed.
pub async fn to_hub<S>(mut driver: WebSocketStream<S>, remote: &Remote) -> ToHub
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    match connect(&remote.url).await {
        Ok(hub) => {
            pipe_sealed(driver, hub, &remote.key).await;
            ToHub::Piped
        }
        Err(e) => {
            let gone =
                matches!(&e, tokio_tungstenite::tungstenite::Error::Http(r) if r.status() == 403);
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
    pipe_sealed(session, hub, key).await;
}

/// The plain side's messages sealed to the hub, and the hub's opened to the plain side, until either side closes or
/// a message doesn't open.
pub async fn pipe_sealed<A, B>(plain: WebSocketStream<A>, hub: WebSocketStream<B>, key: &[u8; 32])
where
    A: AsyncRead + AsyncWrite + Unpin + Send,
    B: AsyncRead + AsyncWrite + Unpin + Send,
{
    let cipher = XSalsa20Poly1305::new(key.into());
    let (mut plain_out, mut plain_in) = plain.split();
    let (mut hub_out, mut hub_in) = hub.split();
    let out = async {
        while let Some(Ok(message)) = plain_in.next().await {
            let end = matches!(message, Message::Close(_));
            let Some(sealed) = seal(&cipher, message) else {
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
            let Some(opened) = open(&cipher, message) else {
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

    #[test]
    fn what_goes_through_the_hub_is_sealed_and_opens_only_under_its_key() {
        let key = new_key();
        let cipher = XSalsa20Poly1305::new((&key).into());
        let text = Message::Text("{\"method\":\"Input.insertText\",\"text\":\"hunter2\"}".into());
        let sealed = seal(&cipher, text.clone()).unwrap();
        let Message::Binary(bytes) = &sealed else {
            panic!("sealed as binary");
        };
        assert!(!bytes.windows(7).any(|w| w == b"hunter2"));
        assert_eq!(open(&cipher, sealed.clone()), Some(text));
        let other = XSalsa20Poly1305::new((&new_key()).into());
        assert_eq!(open(&other, sealed), None);
        // A plain message from the hub is refused, not passed on.
        assert_eq!(open(&cipher, Message::Text("hi".into())), None);
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
}
