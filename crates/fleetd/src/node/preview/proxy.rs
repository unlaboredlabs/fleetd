//! A preview's port on the tailnet. A preview listens on `127.0.0.1:$PORT` (or `[::1]:$PORT`); [`Proxy::start`] gives it a port of its
//! own from a range (8400–8499 by default), bound to the node's tailnet address only, never `0.0.0.0`, and returns
//! where it is. For each connection the node asks the local tailscaled who the peer is (`tailscale whois`) and lets
//! it through only when it is a device of the tailnet user who owns the hub; anyone else gets a plain 403 page. Each
//! address's answer is kept for a short while ([`Cached`]), so a page loading 50 assets asks once. The check is per
//! connection and the bytes are then copied as they are, so keep-alive and WebSocket upgrades pass
//! through untouched. [`Proxy::stop`] (or dropping it) closes the port and every connection through it.
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::ops::RangeInclusive;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

use crate::node::util::exec;

/// The preview ports, one per running preview.
pub const PORTS: RangeInclusive<u16> = 8400..=8499;
const TAILSCALE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long [`Config::detect`]'s whois keeps an address's answer. A device removed from the tailnet, or moved to
/// another user, keeps getting in for up to this long after the change.
pub const WHOIS_TTL: Duration = Duration::from_secs(30);
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

impl<W: Whois + ?Sized> Whois for Arc<W> {
    fn whois(&self, peer: SocketAddr) -> BoxFuture<'_, io::Result<Peer>> {
        (**self).whois(peer)
    }
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

/// Each address's answer kept for `ttl` ([`WHOIS_TTL`], 30 s, in [`Config::detect`]), so a page loading 50 assets
/// asks tailscaled once instead of starting 50 `tailscale whois`. Connections from the same address wait for the one
/// question in flight instead of asking again. Errors aren't kept: the next connection asks again.
pub struct Cached<W> {
    inner: W,
    ttl: Duration,
    answers: Mutex<HashMap<IpAddr, Slot>>,
}

/// An address's answer and when it came; locked while the question is in flight.
type Slot = Arc<tokio::sync::Mutex<Option<(Instant, Peer)>>>;

impl<W: Whois> Cached<W> {
    pub fn new(inner: W, ttl: Duration) -> Self {
        Self {
            inner,
            ttl,
            answers: Mutex::default(),
        }
    }
}

impl<W: Whois> Whois for Cached<W> {
    fn whois(&self, peer: SocketAddr) -> BoxFuture<'_, io::Result<Peer>> {
        Box::pin(async move {
            let slot = {
                let mut answers = lock(&self.answers);
                // Forget answers that are stale (or never came) and that no caller holds: callers take their clone
                // under this lock, so a slot someone is about to ask through is never swapped for a new one.
                answers.retain(|_, slot| {
                    Arc::strong_count(slot) > 1
                        || slot.try_lock().is_ok_and(|answer| {
                            answer
                                .as_ref()
                                .is_some_and(|(at, _)| at.elapsed() < self.ttl)
                        })
                });
                answers.entry(peer.ip()).or_default().clone()
            };
            let mut answer = slot.lock().await;
            if let Some((at, who)) = answer.as_ref()
                && at.elapsed() < self.ttl
            {
                return Ok(who.clone());
            }
            let who = self.inner.whois(peer).await?;
            *answer = Some((Instant::now(), who.clone()));
            Ok(who)
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
    /// This machine on its tailnet (`tailscale status --json`) and the [`PORTS`] range, asking tailscaled through
    /// [`Cached`]. The owner is `owner` when given (the hub owner's login), else this machine's user. A tagged machine
    /// has no user, so it needs `owner`.
    pub async fn detect(owner: Option<&str>) -> io::Result<Self> {
        let argv = ["tailscale", "status", "--json"].map(str::to_owned);
        let out = exec(&argv, TAILSCALE_TIMEOUT).await;
        if let Some(error) = out.error {
            return Err(io::Error::other(error));
        }
        parse_status(&out.stdout, owner).map_err(io::Error::other)
    }
}

/// `tailscale status --json`, when its backend runs. The error says what's missing, in plain words.
fn parse_status(json: &str, owner: Option<&str>) -> Result<Config, String> {
    let status: Value =
        serde_json::from_str(json).map_err(|_| "tailscale status: unreadable answer".to_owned())?;
    if status.get("BackendState").and_then(Value::as_str) != Some("Running") {
        return Err("tailscale isn't running on this machine".to_owned());
    }
    let me = status
        .get("Self")
        .ok_or("tailscale status doesn't describe this machine")?;
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
        .copied()
        .ok_or("this machine has no tailnet address")?;
    let host = me
        .get("DNSName")
        .and_then(Value::as_str)
        .map(|name| name.trim_end_matches('.').to_owned())
        .filter(|name| !name.is_empty());
    let owner = match owner {
        Some(owner) => owner.to_owned(),
        None => own_user(&status, me)?,
    };
    Ok(Config {
        addr,
        host,
        ports: PORTS,
        owner,
        whois: Arc::new(Cached::new(Tailscale, WHOIS_TTL)),
    })
}

/// The login of the user this machine belongs to.
fn own_user(status: &Value, me: &Value) -> Result<String, String> {
    if me
        .get("Tags")
        .and_then(Value::as_array)
        .is_some_and(|tags| !tags.is_empty())
    {
        return Err(
            "this machine is a tagged tailnet device, so it has no user to own its previews: \
             give the hub owner's tailnet login instead"
                .to_owned(),
        );
    }
    let user = me.get("UserID").and_then(Value::as_u64).unwrap_or_default();
    status
        .pointer(&format!("/User/{user}/LoginName"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| "tailscale status names no user for this machine".to_owned())
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
    /// The accept task owns the listener; this is gone once the port is closed.
    listener: Weak<TcpListener>,
    accept: Option<JoinHandle<()>>,
}

impl Proxy {
    /// Exposes the preview on `127.0.0.1:target` (or `[::1]:target` when nothing listens on the first) on the first free port of `config.ports` at `config.addr`.
    pub async fn start(config: &Config, target: u16) -> io::Result<Self> {
        if !bindable(config.addr) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} is not a tailnet address", config.addr),
            ));
        }
        let listener = Arc::new(bind(config).await?);
        let addr = listener.local_addr()?;
        let watched = Arc::downgrade(&listener);
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
            listener: watched,
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

    /// Whether the port is open: false only once its listener is closed.
    pub fn listening(&self) -> bool {
        self.listener.strong_count() > 0
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
    // A server started on `localhost` may have bound only ::1.
    let upstream = match TcpStream::connect((Ipv4Addr::LOCALHOST, target)).await {
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => {
            TcpStream::connect((Ipv6Addr::LOCALHOST, target)).await
        }
        upstream => upstream,
    };
    // A preview that isn't answering doesn't keep itself alive: only a connection that reached it counts.
    let Ok(mut upstream) = upstream else {
        return refuse(client, "502 Bad Gateway", NOT_RUNNING).await;
    };
    let _open = Open::new(activity);
    let mut client = client;
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
    use tokio::net::TcpSocket;
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
            Box::pin(async move {
                // Callers asking at once overlap here, as they would on a real tailscaled.
                tokio::task::yield_now().await;
                answer.ok_or_else(|| io::Error::other("no such peer"))
            })
        }
    }

    fn device(login: &str, tags: &[&str]) -> Option<Peer> {
        Some(Peer {
            login: login.to_owned(),
            tags: tags.iter().map(|t| (*t).to_owned()).collect(),
        })
    }

    /// A port that refuses connections on both loopbacks for as long as the sockets live: bound but never
    /// listening, so no listener in another test or test process can take it.
    fn refusing_port() -> (u16, Vec<TcpSocket>) {
        for _ in 0..100 {
            let v4 = TcpSocket::new_v4().unwrap();
            v4.bind((Ipv4Addr::LOCALHOST, 0).into()).unwrap();
            let port = v4.local_addr().unwrap().port();
            let Ok(v6) = TcpSocket::new_v6() else {
                return (port, vec![v4]);
            };
            match v6.bind((Ipv6Addr::LOCALHOST, port).into()) {
                Ok(()) => return (port, vec![v4, v6]),
                // No IPv6 loopback here: nothing listens there either.
                Err(error) if error.kind() == io::ErrorKind::AddrNotAvailable => {
                    return (port, vec![v4]);
                }
                // Taken on ::1: try another.
                Err(_) => {}
            }
        }
        panic!("no port free on both loopbacks");
    }

    /// Its port is the one the OS picks as the proxy binds (`0..=0`), so nothing else can take it between a check
    /// and the bind, however many test processes run at once.
    async fn config(whois: Arc<dyn Whois>) -> Config {
        Config {
            addr: Ipv4Addr::LOCALHOST.into(),
            host: None,
            ports: 0..=0,
            owner: OWNER.to_owned(),
            whois,
        }
    }

    /// A preview that answers every request with `hello`.
    async fn preview() -> u16 {
        preview_on(TcpListener::bind("127.0.0.1:0").await.unwrap())
    }

    fn preview_on(listener: TcpListener) -> u16 {
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
        let (target, _held) = refusing_port();
        let proxy = Proxy::start(&config(FakeWhois::new(device(OWNER, &[]))).await, target)
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
        assert_ne!(proxy.addr.port(), 0);
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
        assert!(proxy.listening());
        let busy = TcpListener::bind(addr).await.err().unwrap();
        assert_eq!(busy.kind(), io::ErrorKind::AddrInUse);

        // A connection held open through the proxy.
        let mut client = TcpStream::connect(addr).await.unwrap();
        let (_held, _) = upstream.accept().await.unwrap();
        // It counts once the proxy's own connect has returned, just after the accept.
        let deadline = Instant::now() + Duration::from_secs(5);
        while proxy.idle_since().is_some() {
            assert!(Instant::now() < deadline, "the connection never counted");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // Checked through the proxy's own listener, never by rebinding or connecting to the released port: another
        // test or test process may take that number the moment it is free.
        let listener = proxy.listener.clone();
        proxy.stop().await;
        assert!(listener.upgrade().is_none(), "the listener outlived stop");
        let mut buf = [0u8; 16];
        let read = tokio::time::timeout(Duration::from_secs(5), client.read(&mut buf))
            .await
            .unwrap();
        assert!(matches!(read, Ok(0) | Err(_)), "{read:?}");
    }

    #[tokio::test]
    async fn the_range_skips_busy_ports_and_says_when_none_is_free() {
        // A port held for the whole test, with room above it for the range.
        let (_taken, busy) = loop {
            let taken = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = taken.local_addr().unwrap().port();
            if port <= 65000 {
                break (taken, port);
            }
        };
        let mut config = config(FakeWhois::new(None)).await;
        config.ports = busy..=busy;
        let error = Proxy::start(&config, 3000).await.err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);
        assert!(error.to_string().contains(&busy.to_string()), "{error}");
        config.ports = busy..=busy + 50;
        let proxy = Proxy::start(&config, 3000).await.unwrap();
        assert_eq!(proxy.addr.ip(), config.addr);
        assert!((busy + 1..=busy + 50).contains(&proxy.addr.port()));
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
        let config = parse_status(json, None).unwrap();
        assert_eq!(config.addr, "100.101.102.103".parse::<IpAddr>().unwrap());
        assert_eq!(config.host.as_deref(), Some("devbox.tail1.ts.net"));
        assert_eq!(config.owner, OWNER);
        assert_eq!(config.ports, PORTS);

        let hub = parse_status(json, Some("hub@example.com")).unwrap();
        assert_eq!(hub.owner, "hub@example.com");
        let stopped = json.replace("Running", "Stopped");
        let error = parse_status(&stopped, None).err().unwrap();
        assert_eq!(error, "tailscale isn't running on this machine");
    }

    #[test]
    fn a_tagged_machine_says_it_needs_the_owner_and_takes_one_given() {
        let json = r#"{"BackendState":"Running",
            "Self":{"TailscaleIPs":["100.101.102.103"],"UserID":9,"Tags":["tag:server"]},
            "User":{"9":{"ID":9,"LoginName":"tagged-devices"}}}"#;
        let error = parse_status(json, None).err().unwrap();
        assert!(error.contains("tagged tailnet device"), "{error}");
        assert!(error.contains("hub owner's tailnet login"), "{error}");
        let config = parse_status(json, Some(OWNER)).unwrap();
        assert_eq!(config.owner, OWNER);
        assert_eq!(config.addr, "100.101.102.103".parse::<IpAddr>().unwrap());
    }

    #[tokio::test]
    async fn a_page_of_many_requests_asks_tailscale_once() {
        let fake = FakeWhois::new(device(OWNER, &[]));
        let mut config = config(fake.clone()).await;
        config.whois = Arc::new(Cached::new(fake.clone(), WHOIS_TTL));
        let proxy = Proxy::start(&config, preview().await).await.unwrap();
        let responses = futures_util::future::join_all((0..20).map(|_| get(proxy.addr))).await;
        for (response, _) in responses {
            assert!(response.ends_with("hello"), "{response}");
        }
        assert_eq!(lock(&fake.asked).len(), 1);
    }

    #[tokio::test]
    async fn the_cache_is_per_address_lapses_and_keeps_no_errors() {
        let at = |ip: &str, port| SocketAddr::new(ip.parse().unwrap(), port);
        let fake = FakeWhois::new(device(OWNER, &[]));
        let cached = Cached::new(fake.clone(), WHOIS_TTL);
        cached.whois(at("100.64.0.2", 50000)).await.unwrap();
        cached.whois(at("100.64.0.2", 50001)).await.unwrap();
        cached.whois(at("100.64.0.3", 50000)).await.unwrap();
        assert_eq!(lock(&fake.asked).len(), 2);

        let lapsed = Cached::new(fake.clone(), Duration::ZERO);
        lapsed.whois(at("100.64.0.2", 50000)).await.unwrap();
        lapsed.whois(at("100.64.0.2", 50000)).await.unwrap();
        assert_eq!(lock(&fake.asked).len(), 4);

        let unknown = FakeWhois::new(None);
        let cached = Cached::new(unknown.clone(), WHOIS_TTL);
        for _ in 0..2 {
            assert!(cached.whois(at("100.64.0.4", 50000)).await.is_err());
        }
        assert_eq!(lock(&unknown.asked).len(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn callers_at_once_share_one_question_while_other_addresses_come_and_go() {
        let fake = FakeWhois::new(device(OWNER, &[]));
        let cached = Arc::new(Cached::new(fake.clone(), WHOIS_TTL));
        let asks = (0..200u16).map(|i| {
            let cached = cached.clone();
            // Every other caller is a new address, which prunes the map on its way in.
            let ip = if i % 2 == 0 {
                "100.64.0.2".to_owned()
            } else {
                format!("100.64.1.{}", i / 2)
            };
            tokio::spawn(async move {
                cached
                    .whois(SocketAddr::new(ip.parse().unwrap(), 50000 + i))
                    .await
                    .unwrap();
            })
        });
        for ask in futures_util::future::join_all(asks).await {
            ask.unwrap();
        }
        let asked = lock(&fake.asked);
        let shared = asked
            .iter()
            .filter(|peer| peer.ip() == "100.64.0.2".parse::<IpAddr>().unwrap())
            .count();
        assert_eq!(shared, 1);
        assert_eq!(asked.len(), 101);
    }

    #[tokio::test]
    async fn a_preview_on_ipv6_loopback_is_reached() {
        // A preview on ::1 only, its port held on 127.0.0.1 so the proxy's first try is refused.
        let (listener, _held) = loop {
            // No IPv6 loopback on this machine: nothing to try.
            let Ok(listener) = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).await else {
                return;
            };
            let port = listener.local_addr().unwrap().port();
            let v4 = TcpSocket::new_v4().unwrap();
            if v4.bind((Ipv4Addr::LOCALHOST, port).into()).is_ok() {
                break (listener, v4);
            }
        };
        let target = preview_on(listener);
        let proxy = Proxy::start(&config(FakeWhois::new(device(OWNER, &[]))).await, target)
            .await
            .unwrap();
        let (response, _) = get(proxy.addr).await;
        assert!(response.ends_with("hello"), "{response}");
    }

    #[tokio::test]
    async fn a_preview_not_answering_still_goes_idle() {
        let (target, _held) = refusing_port();
        let proxy = Proxy::start(&config(FakeWhois::new(device(OWNER, &[]))).await, target)
            .await
            .unwrap();
        let started = proxy.idle_since().unwrap();
        for _ in 0..3 {
            assert!(get(proxy.addr).await.0.starts_with("HTTP/1.1 502"));
        }
        assert_eq!(proxy.idle_since(), Some(started));
    }
}
