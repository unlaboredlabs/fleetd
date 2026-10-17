//! The hub connection: one WebSocket to `/app`, reconnected with backoff. Frames go to the app as
//! [`Incoming`]; the app's [`ClientMessage`]s go out on the socket. Every (re)connect starts with `auth`,
//! and the app state resyncs from a fresh snapshot, so nothing is replayed across connections.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_tungstenite::tungstenite::Message;
use async_tungstenite::tungstenite::protocol::CloseFrame;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender};
use futures::{FutureExt, StreamExt, select};
use futures_rustls::rustls::{self, pki_types::ServerName};
use rustls_platform_verifier::BuilderVerifierExt;

use crate::protocol::{ClientMessage, ServerMessage};

/// The hub's close code for a refused key.
const CLOSE_UNAUTHORIZED: u16 = 4401;

#[derive(Debug, PartialEq)]
pub enum Incoming {
    /// The key was accepted on a new connection.
    Ready,
    /// The connection dropped; the client is retrying after `retry_in`.
    Disconnected { reason: String, retry_in: Duration },
    /// The hub refused the key. The client has stopped.
    Unauthorized(String),
    Message(ServerMessage),
}

/// Delay before reconnect attempt `attempt` (0-based): 0.5 s doubling to a 30 s cap.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_millis(500u64.saturating_mul(1 << attempt.min(6))).min(Duration::from_secs(30))
}

/// Where to dial for a hub URL the user typed.
#[derive(Debug, PartialEq)]
pub struct HubAddr {
    /// The `/app` WebSocket URL.
    pub url: String,
    /// `host:port` to open the TCP connection to.
    pub addr: String,
    /// The name the TLS certificate must match, when `wss`.
    pub tls_name: Option<String>,
}

/// `http(s)://host[:port]` or `ws(s)://host[:port][/app]` (no scheme means http).
pub fn app_url(input: &str) -> Result<HubAddr, String> {
    let input = input.trim();
    let (tls, rest) = match input.split_once("://") {
        Some(("http" | "ws", rest)) => (false, rest),
        Some(("https" | "wss", rest)) => (true, rest),
        Some(_) => return Err("Use an http://, https://, ws:// or wss:// URL.".into()),
        None => (false, input),
    };
    let rest = rest.trim_end_matches('/');
    let (host, path) = rest.split_once('/').map_or((rest, ""), |(h, p)| (h, p));
    if host.is_empty() {
        return Err("The URL needs a host, e.g. http://127.0.0.1:4790.".into());
    }
    // "[::1]:4790", "hub:4790", "hub", "[::1]"
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) if !name.is_empty() && (name.ends_with(']') || !name.contains(':')) && port.parse::<u16>().is_ok() => (name, Some(port)),
        _ => (host, None),
    };
    let port = port.map_or(if tls { "443" } else { "80" }, |p| p);
    let path = if path.is_empty() { "app" } else { path };
    Ok(HubAddr {
        url: format!("{}://{host}/{path}", if tls { "wss" } else { "ws" }),
        addr: format!("{name}:{port}"),
        tls_name: tls.then(|| name.trim_start_matches('[').trim_end_matches(']').to_string()),
    })
}

/// What the connection does with one text frame.
#[derive(Debug, PartialEq)]
pub enum Step {
    Forward(Incoming),
    /// The key was refused: report it and stop.
    Refused(String),
    Ignore,
}

/// Per-connection frame handling, kept free of I/O so it can be tested.
#[derive(Default)]
pub struct Session {
    pub ready: bool,
}

impl Session {
    pub fn on_text(&mut self, text: &str) -> Step {
        let Ok(message) = serde_json::from_str::<ServerMessage>(text) else {
            // A frame type this build doesn't know (a newer hub): skip it.
            return Step::Ignore;
        };
        match message {
            ServerMessage::Ready(_) => {
                self.ready = true;
                Step::Forward(Incoming::Ready)
            }
            // Before ready, an error can only be about the key.
            ServerMessage::Error(e) if !self.ready && e.id.is_none() => Step::Refused(e.message),
            other => Step::Forward(Incoming::Message(other)),
        }
    }

    pub fn on_close(&self, frame: Option<&CloseFrame>) -> Option<String> {
        frame.filter(|f| u16::from(f.code) == CLOSE_UNAUTHORIZED).map(|f| format!("The hub refused the key ({}).", f.reason))
    }
}

/// Runs until the key is refused or `outgoing` closes (the app dropped the connection).
pub async fn run(url: String, key: String, mut outgoing: UnboundedReceiver<ClientMessage>, incoming: UnboundedSender<Incoming>) {
    let mut attempt = 0;
    loop {
        let reason = match connect_once(&url, &key, &mut outgoing, &incoming).await {
            Ended::Refused(message) => {
                incoming.unbounded_send(Incoming::Unauthorized(message)).ok();
                return;
            }
            Ended::AppGone => return,
            Ended::Dropped { reason, was_ready } => {
                if was_ready {
                    attempt = 0;
                }
                reason
            }
        };
        let retry_in = backoff(attempt);
        attempt += 1;
        if incoming.unbounded_send(Incoming::Disconnected { reason, retry_in }).is_err() {
            return;
        }
        async_io::Timer::after(retry_in).await;
        // Whatever the app queued meanwhile belongs to the dead connection; it resyncs on Ready.
        while outgoing.try_recv().is_ok() {}
    }
}

enum Ended {
    Refused(String),
    AppGone,
    Dropped { reason: String, was_ready: bool },
}

async fn connect_once(
    url: &str,
    key: &str,
    outgoing: &mut UnboundedReceiver<ClientMessage>,
    incoming: &UnboundedSender<Incoming>,
) -> Ended {
    let dropped = |reason: String, was_ready| Ended::Dropped { reason, was_ready };
    let hub = match app_url(url) {
        Ok(v) => v,
        Err(e) => return Ended::Refused(e),
    };
    let tcp = match async_net::TcpStream::connect(hub.addr.as_str()).await {
        Ok(tcp) => tcp,
        Err(e) => return dropped(format!("Can't reach {}: {e}", hub.addr), false),
    };
    tcp.set_nodelay(true).ok();
    let stream: Box<dyn Io> = match &hub.tls_name {
        None => Box::new(tcp),
        Some(name) => match tls_connect(name, tcp).await {
            Ok(tls) => Box::new(tls),
            Err(e) => return dropped(format!("TLS with {} failed: {e}", hub.addr), false),
        },
    };
    let mut ws = match async_tungstenite::client_async(hub.url.as_str(), stream).await {
        Ok((ws, _)) => ws,
        Err(e) => return dropped(format!("WebSocket handshake with {} failed: {e}", hub.url), false),
    };
    let auth = serde_json::to_string(&ClientMessage::Auth { key: key.to_string() }).unwrap();
    if let Err(e) = ws.send(Message::text(auth)).await {
        return dropped(e.to_string(), false);
    }
    let mut session = Session::default();
    loop {
        select! {
            frame = ws.next().fuse() => match frame {
                Some(Ok(Message::Text(text))) => match session.on_text(text.as_str()) {
                    Step::Forward(event) => {
                        if incoming.unbounded_send(event).is_err() {
                            return Ended::AppGone;
                        }
                    }
                    Step::Refused(message) => return Ended::Refused(message),
                    Step::Ignore => {}
                },
                Some(Ok(Message::Close(frame))) => {
                    if let Some(message) = session.on_close(frame.as_ref()) {
                        return Ended::Refused(message);
                    }
                    return dropped("The hub closed the connection.".into(), session.ready);
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => return dropped(e.to_string(), session.ready),
                None => return dropped("The connection ended.".into(), session.ready),
            },
            message = outgoing.next() => match message {
                Some(message) => {
                    let text = serde_json::to_string(&message).unwrap();
                    if let Err(e) = ws.send(Message::text(text)).await {
                        return dropped(e.to_string(), session.ready);
                    }
                }
                None => {
                    ws.close(None).await.ok();
                    return Ended::AppGone;
                }
            },
        }
    }
}

trait Io: futures::AsyncRead + futures::AsyncWrite + Unpin + Send {}
impl<T: futures::AsyncRead + futures::AsyncWrite + Unpin + Send> Io for T {}

/// The certificate is checked by the OS verifier (Security.framework on macOS, the system roots on Linux,
/// which honor SSL_CERT_FILE). Built once, on first use, so plain ws:// hubs never load any roots.
fn tls_config() -> Result<Arc<rustls::ClientConfig>, String> {
    static CONFIG: OnceLock<Result<Arc<rustls::ClientConfig>, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .and_then(|b| b.with_platform_verifier())
                .map(|b| Arc::new(b.with_no_client_auth()))
                .map_err(|e| e.to_string())
        })
        .clone()
}

async fn tls_connect(name: &str, tcp: async_net::TcpStream) -> Result<futures_rustls::client::TlsStream<async_net::TcpStream>, String> {
    let server = ServerName::try_from(name.to_string()).map_err(|e| format!("bad host name {name}: {e}"))?;
    futures_rustls::TlsConnector::from(tls_config()?).connect(server, tcp).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

    #[test]
    fn backoff_doubles_to_a_cap() {
        let ms: Vec<u64> = (0..9).map(|a| backoff(a).as_millis() as u64).collect();
        assert_eq!(ms, [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    }

    #[test]
    fn app_url_accepts_http_and_ws_forms() {
        let plain = |ws: &str, addr: &str| HubAddr { url: ws.into(), addr: addr.into(), tls_name: None };
        assert_eq!(app_url("http://127.0.0.1:4790").unwrap(), plain("ws://127.0.0.1:4790/app", "127.0.0.1:4790"));
        assert_eq!(app_url(" ws://hub:4790/app/ ").unwrap(), plain("ws://hub:4790/app", "hub:4790"));
        assert_eq!(app_url("100.1.2.3:4790").unwrap().url, "ws://100.1.2.3:4790/app");
        assert_eq!(app_url("http://hub").unwrap().addr, "hub:80");
        assert!(app_url("ftp://hub").is_err());
        assert!(app_url("http://").is_err());
    }

    #[test]
    fn app_url_takes_tls_forms_with_the_name_to_verify() {
        assert_eq!(
            app_url("https://forge.tail1234.ts.net").unwrap(),
            HubAddr {
                url: "wss://forge.tail1234.ts.net/app".into(),
                addr: "forge.tail1234.ts.net:443".into(),
                tls_name: Some("forge.tail1234.ts.net".into()),
            }
        );
        let v6 = app_url("wss://[::1]:4790/app").unwrap();
        assert_eq!((v6.addr.as_str(), v6.tls_name.as_deref()), ("[::1]:4790", Some("::1")));
    }

    #[test]
    fn tls_config_builds_with_the_platform_verifier() {
        tls_config().unwrap();
    }

    #[test]
    fn error_before_ready_is_a_refused_key() {
        let mut s = Session::default();
        let step = s.on_text(r#"{"t":"error","code":"forbidden","message":"Unknown agent key."}"#);
        assert_eq!(step, Step::Refused("Unknown agent key.".into()));
    }

    #[test]
    fn frames_after_ready_are_forwarded() {
        let mut s = Session::default();
        assert_eq!(s.on_text(r#"{"t":"ready","protocol":1}"#), Step::Forward(Incoming::Ready));
        let Step::Forward(Incoming::Message(ServerMessage::Error(e))) =
            s.on_text(r#"{"t":"error","id":"c3","code":"forbidden","message":"This key lacks the operate role."}"#)
        else {
            panic!("call errors are forwarded");
        };
        assert_eq!(e.id.as_deref(), Some("c3"));
        let Step::Forward(Incoming::Message(ServerMessage::Result(r))) = s.on_text(r#"{"t":"result","id":"c4","output":{"ok":true}}"#) else {
            panic!("results are forwarded");
        };
        assert_eq!(r.output["ok"], true);
    }

    #[test]
    fn unknown_frames_are_skipped() {
        let mut s = Session { ready: true };
        assert_eq!(s.on_text(r#"{"t":"hello-from-the-future"}"#), Step::Ignore);
        assert_eq!(s.on_text("not json"), Step::Ignore);
    }

    #[test]
    fn close_4401_is_a_refused_key() {
        let s = Session { ready: true };
        let refused = CloseFrame { code: CloseCode::from(4401), reason: "unauthorized".into() };
        assert!(s.on_close(Some(&refused)).is_some());
        let normal = CloseFrame { code: CloseCode::Away, reason: "".into() };
        assert_eq!(s.on_close(Some(&normal)), None);
        assert_eq!(s.on_close(None), None);
    }
}
