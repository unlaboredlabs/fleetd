//! The relay for sessions hosted on another machine than their agent's: what a session streams (a browser's CDP now,
//! a device's screen later) between the agent's node and the runner's, through the hub, one WebSocket channel per
//! connection the agent's driver makes.
//!
//! Each hosted session has one token for its agent's side, minted at its start and given only to the agent's node
//! (the hub keeps its SHA-256). A connection on `/relay/<token>` names the session; the hub then mints a one-time
//! channel token, asks the runner's node to connect it (`relay_dial`), and pipes the two sockets frame for frame
//! until either ends. Nothing here logs a frame, a payload or a token.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use fleetd_contracts::machine_roles::{RelayDialFrame, RelayStream, RelayToken};
use fleetd_contracts::node_link::HubToNode;
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use super::{Place, place_by_relay};
use crate::hub::api::Hub;

/// How long the runner's node has to connect its side of a channel.
const DIAL_WAIT: Duration = Duration::from_secs(15);
/// A full-page screenshot or a large DOM is several MB; as the node's own proxy allows.
pub const MAX_MESSAGE: usize = 128 << 20;

/// Channels waiting for their runner's side, by their one-time token.
#[derive(Default)]
pub struct Relays {
    waiting: Mutex<HashMap<String, (Instant, oneshot::Sender<WebSocket>)>>,
    /// Every payload the hub piped, for tests that it carried only what the nodes encrypted.
    #[cfg(test)]
    pub piped: Mutex<Vec<u8>>,
}

impl Relays {
    fn wait_for(&self, token: &RelayToken) -> oneshot::Receiver<WebSocket> {
        let (tx, rx) = oneshot::channel();
        let mut waiting = self.waiting.lock().unwrap_or_else(|p| p.into_inner());
        waiting.retain(|_, (by, _)| by.elapsed() < DIAL_WAIT);
        waiting.insert(token.to_string(), (Instant::now(), tx));
        rx
    }

    fn take(&self, token: &str) -> Option<oneshot::Sender<WebSocket>> {
        let mut waiting = self.waiting.lock().unwrap_or_else(|p| p.into_inner());
        let (by, tx) = waiting.remove(token)?;
        (by.elapsed() < DIAL_WAIT).then_some(tx)
    }

    fn forget(&self, token: &RelayToken) {
        let mut waiting = self.waiting.lock().unwrap_or_else(|p| p.into_inner());
        waiting.remove(token.as_str());
    }
}

pub fn new_token() -> RelayToken {
    let bytes: [u8; 32] = rand::random();
    RelayToken::unchecked(bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// What the hub keeps of a session's token.
pub fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The header of the relay's own refusal of a session that ended.
pub const GONE_HEADER: &str = "x-fleetd-relay-gone";

/// What the relay's refusal of a session that ended carries, from the SHA-256 of its token: only a party that knows
/// the token makes it, so the agent's node tells it from a refusal by something in front of the hub.
pub fn gone_proof(token_hash: &str) -> String {
    Sha256::new()
        .chain_update(b"fleetd relay 1: gone ")
        .chain_update(token_hash.as_bytes())
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A token of no session open now: 410, with the proof the agent's node checks before it forgets the session.
fn gone(token_hash: &str) -> Response {
    (
        StatusCode::GONE,
        [(GONE_HEADER, gone_proof(token_hash))],
        "no session open at this relay",
    )
        .into_response()
}

fn refused() -> Response {
    (StatusCode::FORBIDDEN, "not a fleetd session relay").into_response()
}

/// `/relay/<token>`: the runner's side of a channel the hub asked it for, or an agent's node opening one.
pub async fn route(hub: Arc<Hub>, token: String, upgrade: WebSocketUpgrade) -> Response {
    if RelayToken::new(token.as_str()).is_err() {
        return refused();
    }
    let upgrade = upgrade
        .max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE);
    if let Some(waiting) = hub.relays.take(&token) {
        return upgrade.on_upgrade(move |runner| async move {
            let _ = waiting.send(runner);
        });
    }
    let hashed = hash(&token);
    let place = match hub.db.with(|c| place_by_relay(c, &hashed)) {
        Ok(Some(place)) => place,
        Ok(None) => return gone(&hashed),
        Err(e) => {
            tracing::warn!(error = %e, "session relay: lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, "the hub failed").into_response();
        }
    };
    upgrade.on_upgrade(move |agent| channel(hub, place, agent))
}

/// One connection of the agent's driver: the runner connects its side, and the two are piped until either ends.
async fn channel(hub: Arc<Hub>, place: Place, agent: WebSocket) {
    let token = new_token();
    let runner = hub.relays.wait_for(&token);
    let dial = HubToNode::RelayDial(RelayDialFrame {
        host_key: place.key.clone(),
        token: token.clone(),
        stream: RelayStream::Cdp,
    });
    if let Err(e) = hub.node_commands.send(&place.runner, dial) {
        hub.relays.forget(&token);
        tracing::info!(runner = %place.runner, error = %e, "session relay: runner not linked");
        let _ = close(agent).await;
        return;
    }
    match tokio::time::timeout(DIAL_WAIT, runner).await {
        Ok(Ok(runner)) => pipe(&hub.relays, agent, runner).await,
        _ => {
            hub.relays.forget(&token);
            tracing::info!(runner = %place.runner, "session relay: runner did not connect");
            let _ = close(agent).await;
        }
    }
}

async fn close(mut socket: WebSocket) -> Result<(), axum::Error> {
    socket.send(Message::Close(None)).await
}

/// Each side's frames to the other, as they come, until either side closes.
async fn pipe(relays: &Relays, a: WebSocket, b: WebSocket) {
    #[cfg(not(test))]
    let _ = relays;
    #[cfg(test)]
    let tap = |message: &Message| {
        if let Message::Text(_) | Message::Binary(_) = message {
            let bytes = message.clone().into_data();
            relays
                .piped
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .extend_from_slice(&bytes);
        }
    };
    #[cfg(not(test))]
    let tap = |_: &Message| {};
    let (mut a_out, mut a_in) = a.split();
    let (mut b_out, mut b_in) = b.split();
    let a_to_b = async {
        while let Some(Ok(message)) = a_in.next().await {
            tap(&message);
            let end = matches!(message, Message::Close(_));
            if b_out.send(message).await.is_err() || end {
                break;
            }
        }
        let _ = b_out.close().await;
    };
    let b_to_a = async {
        while let Some(Ok(message)) = b_in.next().await {
            tap(&message);
            let end = matches!(message, Message::Close(_));
            if a_out.send(message).await.is_err() || end {
                break;
            }
        }
        let _ = a_out.close().await;
    };
    tokio::select! {
        () = a_to_b => {}
        () = b_to_a => {}
    }
}
