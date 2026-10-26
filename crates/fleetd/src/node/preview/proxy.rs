//! A preview's port on the tailnet. A preview listens on `127.0.0.1:$PORT`; [`Proxy::start`] gives it a port of its
//! own from a range (8400–8499 by default), bound to the node's tailnet address only, never `0.0.0.0`, and returns
//! where it is. For each connection the node asks the local tailscaled who the peer is (`tailscale whois`) and lets
//! it through only when it is a device of the tailnet user who owns the hub; anyone else gets a plain 403 page. The
//! check is per connection and the bytes are then copied as they are, so keep-alive and WebSocket upgrades pass
//! through untouched. [`Proxy::stop`] (or dropping it) closes the port and every connection through it.
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::ops::RangeInclusive;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

use crate::node::util::exec;

/// The preview ports, one per running preview.
pub const PORTS: RangeInclusive<u16> = 8400..=8499;
const TAILSCALE_TIMEOUT: Duration = Duration::from_secs(5);
/// How much of a refused request is read before the answer, and for how long.
const MAX_HEAD: usize = 16 << 10;
const HEAD_TIMEOUT: Duration = Duration::from_secs(2);
const FORBIDDEN: &str =
    "This preview opens only on the devices of the person who owns this fleetd hub.\n";
const NOT_RUNNING: &str =
    "This preview isn't answering. It may still be starting, or it has ended.\n";

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Who a peer on the tailnet is, as tailscaled knows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Peer {
    /// Its user's login, e.g. `me@example.com` (`tagged-devices` for a tagged device).
    pub login: String,
    /// The device's ACL tags. A tagged device belongs to no user, so it is never let in.
    pub tags: Vec<String>,
}

/// Asks who a connection's peer is. An error refuses the connection.
pub trait Whois: Send + Sync {
    fn whois(&self, peer: SocketAddr) -> BoxFuture<'_, io::Result<Peer>>;
}

/// The local tailscaled, through `tailscale whois --json <ip:port>`.
pub struct Tailscale;

impl Whois for Tailscale {
    fn whois(&self, peer: SocketAddr) -> BoxFuture<'_, io::Result<Peer>> {
        Box::pin(async move {
            let argv = ["tailscale", "whois", "--json", &peer.to_string()].map(str::to_owned);
            let out = exec(&argv, TAILSCALE_TIMEOUT).await;
            if let Some(error) = out.error {
                return Err(io::Error::other(error));
            }
            parse_whois(&out.stdout)
                .ok_or_else(|| io::Error::other("tailscale whois: no user in its answer"))
        })
    }
}

/// `tailscale whois --json`: `{"Node": {"Tags": [...]}, "UserProfile": {"LoginName": "..."}}`.
fn parse_whois(json: &str) -> Option<Peer> {
    let whois: Value = serde_json::from_str(json).ok()?;
    let login = whois
        .pointer("/UserProfile/LoginName")?
        .as_str()?
        .to_owned();
    let tags = whois
        .pointer("/Node/Tags")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    Some(Peer { login, tags })
}

/// Only the owner's own devices: their login, and no tags.
fn admits(peer: &Peer, owner: &str) -> bool {
    !owner.is_empty() && peer.tags.is_empty() && peer.login.eq_ignore_ascii_case(owner)
}

/// Where preview ports open and who they let in.
#[derive(Clone)]
pub struct Config {
    /// The node's tailnet address, the only one a preview port listens on.
    pub addr: IpAddr,
    /// The name people open, e.g. `devbox.tail1234.ts.net`; the address when there is none.
    pub host: Option<String>,
    pub ports: RangeInclusive<u16>,
    /// The login of the tailnet user who owns the hub: only their devices get through.
    pub owner: String,
    pub whois: Arc<dyn Whois>,
}

impl Config {
    /// This machine on its tailnet (`tailscale status --json`), with its user as the owner and the [`PORTS`] range.
    /// A caller that knows the hub owner's login sets `owner` to it.
    pub async fn detect() -> io::Result<Self> {
        let argv = ["tailscale", "status", "--json"].map(str::to_owned);
        let out = exec(&argv, TAILSCALE_TIMEOUT).await;
        if let Some(error) = out.error {
            return Err(io::Error::other(error));
        }
        parse_status(&out.stdout).ok_or_else(|| {
            io::Error::other(
                "tailscale isn't running here, or this machine is a tagged device with no user",
            )
        })
    }
}

/// `tailscale status --json`, when its backend runs and this machine belongs to a user (a tagged one has none).
fn parse_status(json: &str) -> Option<Config> {
    let status: Value = serde_json::from_str(json).ok()?;
    if status.get("BackendState").and_then(Value::as_str) != Some("Running") {
        return None;
    }
    let me = status.get("Self")?;
    if me
        .get("Tags")
        .and_then(Value::as_array)
        .is_some_and(|tags| !tags.is_empty())
    {
        return None;
    }
    let ips: Vec<IpAddr> = me
        .get("TailscaleIPs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|ip| ip.as_str()?.parse().ok())
        .filter(|ip| is_tailnet(*ip))
        .collect();
    let addr = ips
        .iter()
        .find(|ip| ip.is_ipv4())
        .or_else(|| ips.first())
        .copied()?;
    let host = me
        .get("DNSName")
        .and_then(Value::as_str)
        .map(|name| name.trim_end_matches('.').to_owned())
        .filter(|name| !name.is_empty());
    let user = me.get("UserID")?.as_u64()?.to_string();
    let owner = status
        .pointer(&format!("/User/{user}/LoginName"))?
        .as_str()?
        .to_owned();
    Some(Config {
        addr,
        host,
        ports: PORTS,
        owner,
        whois: Arc::new(Tailscale),
    })
}

/// Tailscale's addresses: 100.64.0.0/10 and fd7a:115c:a1e0::/48.
fn is_tailnet(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            a == 100 && (64..128).contains(&b)
        }
        IpAddr::V6(v6) => v6.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

/// A tailnet address, or loopback, which only this machine reaches. Never `0.0.0.0`, `::` or a LAN address.
fn bindable(ip: IpAddr) -> bool {
    is_tailnet(ip) || ip.is_loopback()
}

/// Connections through a proxy: how many are open, and when the last one closed.
struct Activity {
    open: usize,
    last: Instant,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Counts a let-in connection as open for as long as it lives.
struct Open(Arc<Mutex<Activity>>);

impl Open {
    fn new(activity: Arc<Mutex<Activity>>) -> Self {
        lock(&activity).open += 1;
        Self(activity)
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        let mut activity = lock(&self.0);
        activity.open -= 1;
        activity.last = Instant::now();
    }
}

/// One preview's port on the tailnet.
pub struct Proxy {
    /// Where it listens: the tailnet address and its port from the range.
    pub addr: SocketAddr,
    url: String,
    activity: Arc<Mutex<Activity>>,
    accept: Option<JoinHandle<()>>,
}

impl Proxy {
    /// Exposes `127.0.0.1:target` on the first free port of `config.ports` at `config.addr`.
    pub async fn start(config: &Config, target: u16) -> io::Result<Self> {
        if !bindable(config.addr) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} is not a tailnet address", config.addr),
            ));
        }
        let listener = bind(config).await?;
        let addr = listener.local_addr()?;
        let url = match &config.host {
            Some(host) => format!("http://{host}:{}", addr.port()),
            None => format!("http://{addr}"),
        };
        let activity = Arc::new(Mutex::new(Activity {
            open: 0,
            last: Instant::now(),
        }));
        let owner: Arc<str> = config.owner.as_str().into();
        let whois = config.whois.clone();
        let counted = activity.clone();
        let accept = tokio::spawn(async move {
            // Dropped with the task on stop: every connection through the port ends with it.
            let mut connections = JoinSet::new();
            loop {
                let (client, peer) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    // Out of file descriptors, say: wait instead of spinning.
                    Err(_) => {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                };
                while connections.try_join_next().is_some() {}
                connections.spawn(serve(
                    client,
                    peer,
                    target,
                    owner.clone(),
                    whois.clone(),
                    counted.clone(),
                ));
            }
        });
        Ok(Self {
            addr,
            url,
            activity,
            accept: Some(accept),
        })
    }

    /// What the person opens: `http://devbox.tail1234.ts.net:8414`.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// `None` while someone has a connection open; otherwise when the last one closed, or when the proxy started.
    /// Refused connections don't count.
    pub fn idle_since(&self) -> Option<Instant> {
        let activity = lock(&self.activity);
        (activity.open == 0).then_some(activity.last)
    }

    /// Closes the port and every connection through it. The port is free once this returns.
    pub async fn stop(mut self) {
        if let Some(accept) = self.accept.take() {
            accept.abort();
            let _ = accept.await;
        }
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        if let Some(accept) = &self.accept {
            accept.abort();
        }
    }
}

async fn bind(config: &Config) -> io::Result<TcpListener> {
    for port in config.ports.clone() {
        match TcpListener::bind(SocketAddr::new(config.addr, port)).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AddrInUse,
        format!(
            "no free preview port in {}–{}",
            config.ports.start(),
            config.ports.end()
        ),
    ))
}

async fn serve(
    client: TcpStream,
    peer: SocketAddr,
    target: u16,
    owner: Arc<str>,
    whois: Arc<dyn Whois>,
    activity: Arc<Mutex<Activity>>,
) {
    match whois.whois(peer).await {
        Ok(who) if admits(&who, &owner) => {}
        Ok(who) => {
            tracing::info!(%peer, login = %who.login, tags = ?who.tags, "preview: refused a device that isn't the owner's");
            return refuse(client, "403 Forbidden", FORBIDDEN).await;
        }
        Err(error) => {
            tracing::info!(%peer, %error, "preview: refused a peer tailscale doesn't know");
            return refuse(client, "403 Forbidden", FORBIDDEN).await;
        }
    }
    let _open = Open::new(activity);
    let mut client = client;
    let Ok(mut upstream) = TcpStream::connect((Ipv4Addr::LOCALHOST, target)).await else {
        return refuse(client, "502 Bad Gateway", NOT_RUNNING).await;
    };
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
}

/// A plain-text answer, then the connection closes.
async fn refuse(mut client: TcpStream, status: &str, body: &str) {
    // Read the request head first: closing with bytes unread resets the connection, and the browser would show its
    // own error instead of this page.
    let mut head = Vec::new();
    let mut buf = [0u8; 4096];
    let _ = tokio::time::timeout(HEAD_TIMEOUT, async {
        while head.len() < MAX_HEAD && !head.windows(4).any(|w| w == b"\r\n\r\n") {
            match client.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => head.extend_from_slice(&buf[..n]),
            }
        }
    })
    .await;
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = client.write_all(response.as_bytes()).await;
    let _ = client.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::net::Ipv6Addr;
    use tokio_tungstenite::tungstenite::Message;

    const OWNER: &str = "me@example.com";

    /// Answers every whois with `answer` (`None`: tailscale doesn't know the peer) and keeps who was asked about.
    struct FakeWhois {
        answer: Option<Peer>,
        asked: Mutex<Vec<SocketAddr>>,
    }

    impl FakeWhois {
        fn new(answer: Option<Peer>) -> Arc<Self> {
            Arc::new(Self {
                answer,
                asked: Mutex::default(),
            })
        }
    }

    impl Whois for FakeWhois {
        fn whois(&self, peer: SocketAddr) -> BoxFuture<'_, io::Result<Peer>> {
            lock(&self.asked).push(peer);
            let answer = self.answer.clone();
            Box::pin(async move { answer.ok_or_else(|| io::Error::other("no such peer")) })
        }
    }

    fn device(login: &str, tags: &[&str]) -> Option<Peer> {
        Some(Peer {
            login: login.to_owned(),
            tags: tags.iter().map(|t| (*t).to_owned()).collect(),
        })
    }

    /// A port nothing listens on right now.
    async fn free_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap().port()
    }

    async fn config(whois: Arc<dyn Whois>) -> Config {
        let port = free_port().await;
        Config {
            addr: Ipv4Addr::LOCALHOST.into(),
            host: None,
            ports: port..=port,
            owner: OWNER.to_owned(),
            whois,
        }
    }

    /// A preview that answers every request with `hello`.
    async fn preview() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut tcp, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = tcp.read(&mut buf).await;
                    let _ = tcp
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello")
                        .await;
                    let _ = tcp.shutdown().await;
                });
            }
        });
        port
    }

    /// `GET /` through the proxy: what came back, and the address the request left from.
    async fn get(addr: SocketAddr) -> (String, SocketAddr) {
        let mut tcp = TcpStream::connect(addr).await.unwrap();
        let from = tcp.local_addr().unwrap();
        tcp.write_all(b"GET / HTTP/1.1\r\nHost: devbox\r\n\r\n")
            .await
            .unwrap();
        let mut response = String::new();
        tokio::time::timeout(Duration::from_secs(5), tcp.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        (response, from)
    }

    #[tokio::test]
    async fn lets_the_owners_devices_through_and_asks_about_each_peer() {
        let whois = FakeWhois::new(device("Me@Example.com", &[]));
        let proxy = Proxy::start(&config(whois.clone()).await, preview().await)
            .await
            .unwrap();
        let (response, from) = get(proxy.addr).await;
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.ends_with("hello"), "{response}");
        assert_eq!(*lock(&whois.asked), vec![from]);
        proxy.stop().await;
    }

    #[tokio::test]
    async fn refuses_other_users_tagged_devices_and_peers_tailscale_doesnt_know() {
        for answer in [
            device("someone@example.com", &[]),
            device(OWNER, &["tag:ci"]),
            device("tagged-devices", &["tag:server"]),
            None,
        ] {
            let whois = FakeWhois::new(answer.clone());
            let proxy = Proxy::start(&config(whois.clone()).await, preview().await)
                .await
                .unwrap();
            let (response, _) = get(proxy.addr).await;
            assert!(
                response.starts_with("HTTP/1.1 403 Forbidden"),
                "{answer:?}: {response}"
            );
            assert!(response.ends_with(FORBIDDEN), "{answer:?}: {response}");
            assert!(!response.contains("hello"));
            assert!(proxy.idle_since().is_some());
            proxy.stop().await;
        }
    }

    #[tokio::test]
    async fn no_owner_lets_no_one_in() {
        let whois = FakeWhois::new(device("", &[]));
        let mut config = config(whois).await;
        config.owner = String::new();
        let proxy = Proxy::start(&config, preview().await).await.unwrap();
        assert!(get(proxy.addr).await.0.starts_with("HTTP/1.1 403"));
    }

    #[tokio::test]
    async fn a_preview_not_listening_gets_a_502_page() {
        let proxy = Proxy::start(
            &config(FakeWhois::new(device(OWNER, &[]))).await,
            free_port().await,
        )
        .await
        .unwrap();
        let (response, _) = get(proxy.addr).await;
        assert!(
            response.starts_with("HTTP/1.1 502 Bad Gateway"),
            "{response}"
        );
    }

    #[tokio::test]
    async fn never_binds_to_every_interface_or_a_non_tailnet_address() {
        for addr in [
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
            "192.168.1.20".parse().unwrap(),
            "100.128.0.1".parse().unwrap(),
        ] {
            let mut config = config(FakeWhois::new(None)).await;
            config.addr = addr;
            let error = Proxy::start(&config, 3000)
                .await
                .err()
                .unwrap_or_else(|| panic!("{addr} was bound"));
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{addr}");
        }
        let config = config(FakeWhois::new(None)).await;
        let proxy = Proxy::start(&config, 3000).await.unwrap();
        assert_eq!(proxy.addr.ip(), config.addr);
        assert_eq!(proxy.addr.port(), *config.ports.start());
        assert_eq!(proxy.url(), format!("http://{}", proxy.addr));
    }

    #[test]
    fn tailnet_addresses() {
        for ip in [
            "100.64.0.1",
            "100.104.1.2",
            "100.127.255.255",
            "fd7a:115c:a1e0::1",
        ] {
            assert!(is_tailnet(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "100.63.255.255",
            "100.128.0.0",
            "0.0.0.0",
            "::",
            "10.0.0.1",
            "fd7a:115c:a1e1::1",
        ] {
            assert!(!is_tailnet(ip.parse().unwrap()), "{ip}");
            assert!(!bindable(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn stop_frees_the_port_and_ends_open_connections() {
        let config = config(FakeWhois::new(device(OWNER, &[]))).await;
        let upstream = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = upstream.local_addr().unwrap().port();
        let proxy = Proxy::start(&config, target).await.unwrap();
        let addr = proxy.addr;
        let busy = TcpListener::bind(addr).await.err().unwrap();
        assert_eq!(busy.kind(), io::ErrorKind::AddrInUse);

        // A connection held open through the proxy.
        let mut client = TcpStream::connect(addr).await.unwrap();
        let (_held, _) = upstream.accept().await.unwrap();
        assert_eq!(proxy.idle_since(), None);

        proxy.stop().await;
        TcpListener::bind(addr).await.unwrap();
        let mut buf = [0u8; 16];
        let read = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buf))
            .await
            .unwrap();
        assert!(matches!(read, Ok(0) | Err(_)), "{read:?}");
    }

    #[tokio::test]
    async fn the_range_skips_busy_ports_and_says_when_none_is_free() {
        let config = config(FakeWhois::new(None)).await;
        let taken = TcpListener::bind(SocketAddr::new(config.addr, *config.ports.start()))
            .await
            .unwrap();
        let error = Proxy::start(&config, 3000).await.err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);
        drop(taken);
        Proxy::start(&config, 3000).await.unwrap();
    }

    #[tokio::test]
    async fn idle_since_counts_only_let_in_connections() {
        let proxy = Proxy::start(
            &config(FakeWhois::new(device(OWNER, &[]))).await,
            preview().await,
        )
        .await
        .unwrap();
        let started = proxy.idle_since().unwrap();
        get(proxy.addr).await;
        // The proxy's side of the connection closes just after the client has read everything.
        let deadline = Instant::now() + Duration::from_secs(5);
        while proxy.idle_since().is_none_or(|t| t == started) {
            assert!(Instant::now() < deadline, "the connection never counted");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn a_websocket_passes_through() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            while let Some(Ok(message)) = ws.next().await {
                if message.is_text() && ws.send(message).await.is_err() {
                    break;
                }
            }
        });
        let proxy = Proxy::start(&config(FakeWhois::new(device(OWNER, &[]))).await, target)
            .await
            .unwrap();
        let (mut ws, response) =
            tokio_tungstenite::connect_async(format!("ws://{}/hmr", proxy.addr))
                .await
                .unwrap();
        assert_eq!(response.status(), 101);
        for text in ["one", "two"] {
            ws.send(Message::text(text)).await.unwrap();
            let echo = tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(echo.into_text().unwrap().as_str(), text);
        }
        assert_eq!(proxy.idle_since(), None);
    }

    #[tokio::test]
    async fn a_websocket_from_someone_else_is_refused() {
        let proxy = Proxy::start(
            &config(FakeWhois::new(device("someone@example.com", &[]))).await,
            preview().await,
        )
        .await
        .unwrap();
        let error = tokio_tungstenite::connect_async(format!("ws://{}/hmr", proxy.addr))
            .await
            .err()
            .unwrap();
        let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
            panic!("{error:?}");
        };
        assert_eq!(response.status(), 403);
    }

    #[test]
    fn reads_whois() {
        let json = r#"{"Node":{"Name":"phone.tail1.ts.net.","Tags":null},
            "UserProfile":{"ID":7,"LoginName":"me@example.com","DisplayName":"Me"}}"#;
        assert_eq!(parse_whois(json), device(OWNER, &[]));
        let json = r#"{"Node":{"Tags":["tag:ci"]},"UserProfile":{"LoginName":"tagged-devices"}}"#;
        assert_eq!(parse_whois(json), device("tagged-devices", &["tag:ci"]));
        assert_eq!(parse_whois(r#"{"Node":{}}"#), None);
        assert_eq!(parse_whois("not json"), None);
    }

    #[test]
    fn reads_this_machine_and_its_owner_from_status() {
        let json = r#"{"BackendState":"Running",
            "Self":{"DNSName":"devbox.tail1.ts.net.","TailscaleIPs":["fd7a:115c:a1e0::5","100.101.102.103"],"UserID":7},
            "User":{"7":{"ID":7,"LoginName":"me@example.com"},"8":{"ID":8,"LoginName":"other@example.com"}}}"#;
        let config = parse_status(json).unwrap();
        assert_eq!(config.addr, "100.101.102.103".parse::<IpAddr>().unwrap());
        assert_eq!(config.host.as_deref(), Some("devbox.tail1.ts.net"));
        assert_eq!(config.owner, OWNER);
        assert_eq!(config.ports, PORTS);

        let tagged = json.replace(r#""UserID":7"#, r#""UserID":7,"Tags":["tag:server"]"#);
        assert!(parse_status(&tagged).is_none());
        let stopped = json.replace("Running", "Stopped");
        assert!(parse_status(&stopped).is_none());
    }
}
