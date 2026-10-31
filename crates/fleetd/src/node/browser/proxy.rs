//! The agent's only way to its session's browser: a CDP WebSocket on 127.0.0.1 at
//! `/devtools/browser/<token>`, one token per agent session, which the node puts in the session's
//! `AGENT_BROWSER_CDP` when it starts its claude. A claude runs on through a node restart and keeps that
//! environment, so the port and the tokens do too: the port is kept in `browser/proxy.json`, with the key each
//! token is signed with. Chrome itself has no debugging port; its pipe is the node's
//! (cdp.rs). The proxy forwards the driver's commands under ids of its own, sends back their answers and the events
//! the driver may see, and answers itself instead when the agent may not drive now (a person has control) or when the
//! command is one the session refuses (see [`Session::refusal`](super::session::Session::refusal)).
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use futures_util::{SinkExt, StreamExt};
use rand::RngCore;
use ring::hmac;
use serde::{Deserialize, Serialize};
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

/// The proxy's listener and the key its tokens are signed with.
pub struct Proxy {
    pub port: u16,
    key: hmac::Key,
    _accept: Mutex<Option<AbortOnDrop>>,
}

/// What a node restart keeps of the proxy, in `browser/proxy.json` (0600): an agent's URL names both.
#[derive(Serialize, Deserialize)]
struct Kept {
    port: u16,
    /// Hex, 32 bytes.
    key: String,
}

fn kept_path(home: &Path) -> PathBuf {
    home.join("browser").join("proxy.json")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A CDP error answer for command `id`.
pub fn refused(id: &Value, message: &str) -> Value {
    json!({ "id": id, "error": { "code": -32000, "message": message } })
}

impl Proxy {
    /// Listens on the port the node's last run did, so the claudes that ran on through its restart still reach
    /// it; on a new one only when that port is taken.
    pub async fn start(home: &Path, broker: Weak<Broker>) -> std::io::Result<Arc<Self>> {
        let path = kept_path(home);
        let kept = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Kept>(&text).ok())
            .filter(|kept| kept.key.len() == 64);
        let listener = match &kept {
            Some(kept) => match TcpListener::bind(("127.0.0.1", kept.port)).await {
                Ok(listener) => listener,
                Err(e) => {
                    tracing::warn!(port = kept.port, error = %e, "browser proxy: its port is taken; the agents that ran on through the restart lose their browser");
                    TcpListener::bind("127.0.0.1:0").await?
                }
            },
            None => TcpListener::bind("127.0.0.1:0").await?,
        };
        let port = listener.local_addr()?.port();
        let key = match kept {
            Some(kept) => kept.key,
            None => {
                let mut bytes = [0u8; 32];
                rand::rngs::OsRng.fill_bytes(&mut bytes);
                hex(&bytes)
            }
        };
        if let Some(dir) = path.parent() {
            crate::node::config::mkdir_private(dir)?;
        }
        let text = serde_json::to_string(&Kept {
            port,
            key: key.clone(),
        })
        .map_err(std::io::Error::other)?;
        crate::node::secrets::write_atomic(&path, format!("{text}\n").as_bytes())?;
        let proxy = Arc::new(Self {
            port,
            key: hmac::Key::new(hmac::HMAC_SHA256, key.as_bytes()),
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

    /// The agent session's URL: `<thread>.<its signature>`, the same across node restarts.
    pub fn url(&self, thread: &str) -> String {
        let signature = hex(hmac::sign(&self.key, thread.as_bytes()).as_ref());
        format!("ws://127.0.0.1:{}{PATH}{thread}.{signature}", self.port)
    }

    fn thread_of(&self, token: &str) -> Option<String> {
        let (thread, signature) = token.rsplit_once('.')?;
        let signature = (0..signature.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(signature.get(i..i + 2)?, 16).ok())
            .collect::<Option<Vec<u8>>>()?;
        hmac::verify(&self.key, thread.as_bytes(), &signature).ok()?;
        Some(thread.to_owned())
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
    let mut remote: Option<(String, crate::node::relay::Remote)> = None;
    let config = WebSocketConfig::default()
        .max_frame_size(Some(MAX_MESSAGE))
        .max_message_size(Some(MAX_MESSAGE));
    let pick = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let token = request.uri().path().strip_prefix(PATH).unwrap_or_default();
        let thread = proxy
            .upgrade()
            .and_then(|p| p.thread_of(token))
            .ok_or_else(|| reject(403, "not a fleetd browser session"))?;
        let broker = broker.upgrade();
        match broker.as_ref().and_then(|b| b.live(&thread)) {
            Some(session) => found = Some(session),
            // On another machine: the hub's relay carries the driver there, sealed.
            None => {
                let relay = broker.and_then(|b| b.remote(&thread)).ok_or_else(|| {
                    reject(409, "No browser session is open: call session_start first.")
                })?;
                remote = Some((thread, relay));
            }
        }
        Ok(response)
    };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async_with_config(tcp, pick, Some(config)).await
    else {
        return;
    };
    if let Some((thread, relay)) = remote {
        // A session that ended there by itself (idle, a person, a lost runner): forget its relay here too.
        if crate::node::relay::to_hub(ws, &relay).await == crate::node::relay::ToHub::Gone
            && let Some(broker) = broker.upgrade()
        {
            broker.set_remote(&thread, None);
        }
        return;
    }
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
                let Ok(mut command) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                // A Navi's session: nothing on this machine outside its folder.
                if let Some(fence) = &session.fence {
                    let id = command.get("id").cloned().unwrap_or(Value::Null);
                    match fence.check(command).await {
                        Ok(checked) => command = checked,
                        Err(why) => {
                            let _ = out.send(refused(&id, &why).to_string());
                            continue;
                        }
                    }
                }
                // Before the input goes: what it is about to act on, for the action log and the replay.
                if session.control() != fleetd_contracts::browser::BrowserControl::Human {
                    session.note_target(&command).await;
                }
                // A write to a field the session filled: the browser says which node it names first.
                if let Some(why) = super::credentials::filled_field_refusal(&session, &command).await {
                    let id = command.get("id").cloned().unwrap_or(Value::Null);
                    let _ = out.send(refused(&id, &why).to_string());
                    continue;
                }
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
    // The broker's sessions, whether the command goes to one or names one (`Target.detachFromTarget`,
    // `Target.sendMessageToTarget`), are as if they didn't exist.
    if [&command["sessionId"], &command["params"]["sessionId"]]
        .iter()
        .any(|s| s.as_str().is_some_and(|s| session.cdp.is_own(s)))
    {
        let _ = out.send(refused(&id, "No session with given id").to_string());
        return;
    }
    // A command wrapped in another (`Target.sendMessageToTarget`, the only way into a session that isn't flattened)
    // would pass every check here unread: the fence, the sealed session's refusals. agent-browser flattens.
    if method == "Target.sendMessageToTarget"
        || (method == "Target.attachToTarget" && command["params"]["flatten"] != true)
    {
        let why = format!(
            "{method} is refused here: attach with flatten: true and send each command with its sessionId."
        );
        let _ = out.send(refused(&id, &why).to_string());
        return;
    }
    // The protocol handed to a page's script would carry commands past every check here too, the site's own as well.
    if method == "Target.exposeDevToolsProtocol" {
        let why = "Target.exposeDevToolsProtocol is refused here: a page's script would reach the browser around \
                   fleetd's checks. Send each command yourself.";
        let _ = out.send(refused(&id, why).to_string());
        return;
    }
    // By target, a detach could take the broker's session on it rather than the driver's.
    if method == "Target.detachFromTarget"
        && command["params"]["targetId"]
            .as_str()
            .is_some_and(|t| session.cdp.is_own_target(t))
    {
        let why = "Target.detachFromTarget by targetId is refused here: detach your own session by its sessionId.";
        let _ = out.send(refused(&id, why).to_string());
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::Error;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// What the proxy at `url` answers a driver's handshake: the HTTP status it refuses with.
    async fn status(url: &str) -> Result<u16, String> {
        match tokio_tungstenite::connect_async(url).await {
            Err(Error::Http(response)) => Ok(response.status().as_u16()),
            Err(e) => Err(e.to_string()),
            Ok(_) => Ok(101),
        }
    }

    #[test]
    fn an_agents_url_still_reaches_the_proxy_after_a_node_restart() {
        let home = tempfile::tempdir().unwrap();
        // The node's last run: dropping its runtime closes its listener, as its exit does.
        let before = runtime().block_on(async {
            let proxy = Proxy::start(home.path(), Weak::new()).await.unwrap();
            proxy.url("thread-1")
        });
        runtime().block_on(async {
            let proxy = Proxy::start(home.path(), Weak::new()).await.unwrap();
            assert_eq!(proxy.url("thread-1"), before, "same port, same token");
            // Known (no session open here, so 409), where it used to be a refused connection.
            assert_eq!(status(&before).await, Ok(409));
            let token = before.rsplit_once('/').unwrap().1;
            let (_, signature) = token.rsplit_once('.').unwrap();
            assert_eq!(proxy.thread_of(token).as_deref(), Some("thread-1"));
            assert_eq!(proxy.thread_of(&format!("thread-2.{signature}")), None);
            assert_eq!(proxy.thread_of("thread-1"), None);
            assert_eq!(proxy.thread_of("thread-1.zz"), None);
            let forged = before.replace(&format!(".{signature}"), ".00");
            assert_eq!(status(&forged).await, Ok(403));
        });
        let text = std::fs::read_to_string(kept_path(home.path())).unwrap();
        assert!(text.contains(&format!(
            "\"port\":{}",
            before.split(':').nth(2).unwrap().split('/').next().unwrap()
        )));
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(kept_path(home.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_taken_port_gives_a_new_one() {
        let home = tempfile::tempdir().unwrap();
        runtime().block_on(async {
            let first = Proxy::start(home.path(), Weak::new()).await.unwrap();
            // Still listening: the next start can't have its port.
            let second = Proxy::start(home.path(), Weak::new()).await.unwrap();
            assert_ne!(first.port, second.port);
            assert_eq!(status(&second.url("t")).await, Ok(409));
        });
    }
}
