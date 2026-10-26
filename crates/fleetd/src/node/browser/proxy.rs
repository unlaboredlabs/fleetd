//! The agent's only way to its session's browser: a CDP WebSocket on 127.0.0.1 at
//! `/devtools/browser/<token>`, one token per agent session, which the node puts in the session's
//! `AGENT_BROWSER_CDP` when it starts its claude. Chrome itself has no debugging port; its pipe is the node's
//! (cdp.rs). The proxy forwards the driver's commands under ids of its own, sends back their answers and the events
//! the driver may see, and answers itself instead when the agent may not drive now (a person has control) or when the
//! command is one the session refuses (see [`Session::refusal`](super::session::Session::refusal)).
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use super::Broker;
use super::session::Session;
use crate::node::util::AbortOnDrop;

/// A full-page screenshot or a large DOM is several MB.
const MAX_MESSAGE: usize = 128 << 20;
const PATH: &str = "/devtools/browser/";

/// The proxy's listener and the token of each agent session.
pub struct Proxy {
    pub port: u16,
    /// token -> agent session.
    tokens: Mutex<HashMap<String, String>>,
    _accept: Mutex<Option<AbortOnDrop>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A CDP error answer for command `id`.
pub fn refused(id: &Value, message: &str) -> Value {
    json!({ "id": id, "error": { "code": -32000, "message": message } })
}

impl Proxy {
    pub async fn start(broker: Weak<Broker>) -> std::io::Result<Arc<Self>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let proxy = Arc::new(Self {
            port,
            tokens: Mutex::default(),
            _accept: Mutex::default(),
        });
        let weak = Arc::downgrade(&proxy);
        *lock(&proxy._accept) = Some(AbortOnDrop(tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            while let Ok((tcp, _)) = listener.accept().await {
                while connections.try_join_next().is_some() {}
                connections.spawn(serve(tcp, weak.clone(), broker.clone()));
            }
        })));
        Ok(proxy)
    }

    /// The agent session's URL, made on first ask; the same for as long as the node runs.
    pub fn url(&self, thread: &str) -> String {
        let mut tokens = lock(&self.tokens);
        let token = match tokens.iter().find(|(_, t)| *t == thread) {
            Some((token, _)) => token.clone(),
            None => {
                let mut bytes = [0u8; 24];
                rand::thread_rng().fill_bytes(&mut bytes);
                let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
                tokens.insert(token.clone(), thread.to_owned());
                token
            }
        };
        format!("ws://127.0.0.1:{}{PATH}{token}", self.port)
    }

    fn thread_of(&self, token: &str) -> Option<String> {
        lock(&self.tokens).get(token).cloned()
    }
}

fn reject(status: u16, text: &str) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some(text.to_owned()));
    *response.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::from_u16(status)
        .unwrap_or(tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN);
    response
}

// tungstenite's handshake callback returns its own `ErrorResponse`, an HTTP response, in the `Err`.
#[allow(clippy::result_large_err)]
async fn serve(tcp: tokio::net::TcpStream, proxy: Weak<Proxy>, broker: Weak<Broker>) {
    let mut found: Option<Arc<Session>> = None;
    let config = WebSocketConfig::default()
        .max_frame_size(Some(MAX_MESSAGE))
        .max_message_size(Some(MAX_MESSAGE));
    let pick = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let token = request.uri().path().strip_prefix(PATH).unwrap_or_default();
        let thread = proxy
            .upgrade()
            .and_then(|p| p.thread_of(token))
            .ok_or_else(|| reject(403, "not a fleetd browser session"))?;
        let session = broker
            .upgrade()
            .and_then(|b| b.live(&thread))
            .ok_or_else(|| reject(409, "No browser session is open: call session_start first."))?;
        found = Some(session);
        Ok(response)
    };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async_with_config(tcp, pick, Some(config)).await
    else {
        return;
    };
    let Some(session) = found else {
        return;
    };
    let (mut sink, mut stream) = ws.split();
    let (out, mut outbox) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(text) = outbox.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    let mut events = session.cdp.proxy_events();
    loop {
        tokio::select! {
            message = stream.next() => {
                let text = match message {
                    Some(Ok(Message::Text(text))) => text.to_string(),
                    Some(Ok(Message::Binary(bytes))) => String::from_utf8_lossy(&bytes).into_owned(),
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => continue,
                };
                let Ok(command) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                command_in(&session, command, &out);
            }
            message = events.recv() => {
                let Some(message) = message else { break };
                let _ = out.send(session.outgoing(message).to_string());
            }
        }
    }
    writer.abort();
}

/// One command from the driver: refused here, or forwarded and its answer sent back under the driver's id.
fn command_in(session: &Arc<Session>, command: Value, out: &mpsc::UnboundedSender<String>) {
    let id = command.get("id").cloned().unwrap_or(Value::Null);
    let method = command["method"].as_str().unwrap_or_default();
    if command["sessionId"]
        .as_str()
        .is_some_and(|s| session.cdp.is_own(s))
    {
        let _ = out.send(refused(&id, "No session with given id").to_string());
        return;
    }
    if let Some(why) = session.refusal(method, &command["params"]) {
        let _ = out.send(refused(&id, &why).to_string());
        return;
    }
    if !session.cdp.forward(command) {
        let _ = out.send(refused(&id, "the browser closed").to_string());
    }
}
