//! The hub's real tunnel (russh) against an SSH server in the test, standing in for a boat machine's: it signs in with
//! the hub's own key, pins the host key boat names, dials where boat's GET says, asks for the forward and carries the
//! machine's loopback connections to the hub's address; it redials after a drop, hangs up when closed, and refuses a
//! server with another host key, or one boat names no host key for.
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, Disconnect};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::boat::{Boat, BoatError, Limits, Sandbox, SshAccess};
use super::lease::Ttl;
use super::tunnel::{MACHINE_PORT, SshTunnels, Tunnel, Tunnels, hub_key, public_line};
use crate::hub::train::host::BoxFut;

fn key(byte: u8) -> PrivateKey {
    PrivateKey::from(Ed25519Keypair::from_seed(&[byte; 32]))
}

/// boat, as far as the tunnel asks it: `POST /sshkey` names the host key to pin, and its GET the test server's
/// endpoint (`/sshkey` names a stale one, as an old wake's would be).
struct SshBoat {
    at: SocketAddr,
    host_key: Option<String>,
    /// The public keys it was asked to let in, one per dial.
    asked: Mutex<Vec<String>>,
}

fn unused<T: Send + 'static>() -> BoxFut<'static, Result<T, BoatError>> {
    Box::pin(async { Err(BoatError::NotFound) })
}

impl Boat for SshBoat {
    fn create<'a>(&'a self, _: &'a str, _: &'a [u8]) -> BoxFut<'a, Result<Sandbox, BoatError>> {
        unused()
    }
    fn get<'a>(&'a self, id: &'a str) -> BoxFut<'a, Result<Sandbox, BoatError>> {
        Box::pin(async move {
            Ok(Sandbox {
                id: id.to_owned(),
                state: "running".into(),
                ssh_endpoint: Some(self.at.to_string()),
                ..Default::default()
            })
        })
    }
    fn list<'a>(
        &'a self,
        _: &'a [(String, String)],
    ) -> BoxFut<'a, Result<Vec<Sandbox>, BoatError>> {
        unused()
    }
    fn set_ttl<'a>(&'a self, _: &'a str, _: Ttl) -> BoxFut<'a, Result<(), BoatError>> {
        unused()
    }
    fn stop<'a>(&'a self, _: &'a str) -> BoxFut<'a, Result<(), BoatError>> {
        unused()
    }
    fn resume<'a>(&'a self, _: &'a str, _: Ttl) -> BoxFut<'a, Result<Sandbox, BoatError>> {
        unused()
    }
    fn delete<'a>(&'a self, _: &'a str) -> BoxFut<'a, Result<(), BoatError>> {
        unused()
    }
    fn limits(&self) -> BoxFut<'_, Result<Limits, BoatError>> {
        unused()
    }
    fn usage<'a>(&'a self, _: &'a str, _: i64) -> BoxFut<'a, Result<f64, BoatError>> {
        unused()
    }
    fn ssh_key<'a>(
        &'a self,
        id: &'a str,
        public_key: &'a str,
    ) -> BoxFut<'a, Result<SshAccess, BoatError>> {
        Box::pin(async move {
            assert_eq!(id, "bx_1");
            self.asked.lock().unwrap().push(public_key.to_owned());
            Ok(SshAccess {
                machine_ip: None,
                ssh_endpoint: Some("192.0.2.1:9".into()),
                ssh_user: Some("user".into()),
                host_key: self.host_key.clone(),
            })
        })
    }
}

/// What the machine's SSH server saw.
#[derive(Default)]
struct Seen {
    /// The forwards asked for: address and port.
    forwards: Vec<(String, u32)>,
    /// Each connection's handle, once it asked for its forward.
    handles: Vec<server::Handle>,
    /// Connections ended.
    ended: usize,
}

#[derive(Clone)]
struct Sshd {
    allowed: PublicKey,
    seen: Arc<Mutex<Seen>>,
}

impl server::Handler for Sshd {
    type Error = russh::Error;

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        Ok(
            if user == "user" && key.public_key.key_data() == self.allowed.key_data() {
                Auth::Accept
            } else {
                Auth::reject()
            },
        )
    }

    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        let mut seen = self.seen.lock().unwrap();
        seen.forwards.push((address.to_owned(), *port));
        seen.handles.push(session.handle());
        Ok(true)
    }
}

/// The machine's SSH server, with `host` as its host key, letting in only `allowed`.
async fn sshd(host: PrivateKey, allowed: PublicKey) -> (SocketAddr, Arc<Mutex<Seen>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let at = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let config = Arc::new(server::Config {
        keys: vec![host],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let handler = Sshd {
        allowed,
        seen: seen.clone(),
    };
    tokio::spawn(async move {
        loop {
            let (tcp, _) = listener.accept().await.unwrap();
            let (config, handler) = (config.clone(), handler.clone());
            tokio::spawn(async move {
                let seen = handler.seen.clone();
                if let Ok(running) = server::run_stream(config, tcp, handler).await {
                    let _ = running.await;
                }
                seen.lock().unwrap().ended += 1;
            });
        }
    });
    (at, seen)
}

/// The hub's own address: answers each connection's bytes with `hub:` before them.
async fn hub() -> (String, u16) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut tcp, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buf = [0u8; 64];
                while let Ok(n) = tcp.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let _ = tcp.write_all(&[b"hub:", &buf[..n]].concat()).await;
                }
            });
        }
    });
    ("127.0.0.1".into(), port)
}

async fn until(what: &str, mut ok: impl FnMut() -> bool) {
    for _ in 0..500 {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("never: {what}");
}

/// A program on the machine connects to its 127.0.0.1:47900: the server opens the forwarded channel to the hub.
async fn call_hub(handle: &server::Handle, port: u32, said: &[u8]) -> Result<Vec<u8>, String> {
    let channel: Channel<Msg> = handle
        .channel_open_forwarded_tcpip("127.0.0.1", port, "127.0.0.1", 40000)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = channel.into_stream();
    stream.write_all(said).await.map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 4 + said.len()];
    stream
        .read_exact(&mut buf)
        .await
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

struct Rig {
    tunnels: SshTunnels,
    boat: Arc<SshBoat>,
    seen: Arc<Mutex<Seen>>,
    hub_key: PublicKey,
}

async fn rig(host: PrivateKey, named: Option<String>) -> Rig {
    let ours = Arc::new(key(7));
    let (at, seen) = sshd(host, ours.public_key().clone()).await;
    let boat = Arc::new(SshBoat {
        at,
        host_key: named,
        asked: Mutex::default(),
    });
    let hub_key = ours.public_key().clone();
    let tunnels = SshTunnels::with_backoff(
        boat.clone(),
        Arc::new(move || Ok(ours.clone())),
        hub().await,
        Duration::from_millis(50),
        Duration::from_millis(200),
    );
    Rig {
        tunnels,
        boat,
        seen,
        hub_key,
    }
}

/// Up at the wake: boat lets the hub's key in, the host key boat names is pinned, the forward of 127.0.0.1:47900 is
/// asked for, and a connection to it on the machine reaches the hub. A connection to any other port is refused.
/// Dropped: redialled (boat asked again) and up again. Closed: hung up, never redialled.
#[tokio::test]
async fn the_tunnel_comes_up_carries_the_node_to_the_hub_redials_after_a_drop_and_closes() {
    let host = key(1);
    let named = host.public_key().to_openssh().unwrap();
    let r = rig(host, Some(named)).await;
    r.tunnels.open("boat-1", "bx_1");
    until("up", || r.tunnels.status("boat-1") == Some(Tunnel::Up)).await;
    assert_eq!(
        r.seen.lock().unwrap().forwards,
        [("127.0.0.1".to_owned(), u32::from(MACHINE_PORT))]
    );
    let asked = r.boat.asked.lock().unwrap().clone();
    assert_eq!(asked, [r.hub_key.to_openssh().unwrap()]);
    assert!(
        !asked[0].contains("PRIVATE"),
        "only the public half leaves the hub"
    );
    let first = r.seen.lock().unwrap().handles[0].clone();
    assert_eq!(
        call_hub(&first, MACHINE_PORT.into(), b"hello")
            .await
            .unwrap(),
        b"hub:hello"
    );
    assert!(
        call_hub(&first, 22, b"x").await.is_err(),
        "only the forward asked for"
    );
    // Opening it again for the same machine changes nothing.
    r.tunnels.open("boat-1", "bx_1");
    assert_eq!(r.boat.asked.lock().unwrap().len(), 1);

    // The machine drops the connection: redialled with backoff, and up again.
    first
        .disconnect(Disconnect::ByApplication, "bye".into(), "en".into())
        .await
        .unwrap();
    until("redialled", || r.seen.lock().unwrap().handles.len() == 2).await;
    until("up again", || {
        r.tunnels.status("boat-1") == Some(Tunnel::Up)
    })
    .await;
    assert_eq!(
        r.boat.asked.lock().unwrap().len(),
        2,
        "boat asked at each dial"
    );
    let second = r.seen.lock().unwrap().handles[1].clone();
    assert_eq!(
        call_hub(&second, MACHINE_PORT.into(), b"again")
            .await
            .unwrap(),
        b"hub:again"
    );

    // Closed (the machine sleeps): hung up, and nothing dials it again.
    r.tunnels.close("boat-1");
    assert_eq!(r.tunnels.status("boat-1"), None);
    until("hung up", || r.seen.lock().unwrap().ended == 2).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(r.boat.asked.lock().unwrap().len(), 2);
    assert_eq!(r.seen.lock().unwrap().handles.len(), 2);
}

/// A server showing a host key other than the one boat named is refused, again at every redial: never up.
#[tokio::test]
async fn a_host_key_other_than_the_one_boat_named_is_refused() {
    let named = key(2).public_key().to_openssh().unwrap();
    let r = rig(key(1), Some(named)).await;
    r.tunnels.open("boat-1", "bx_1");
    until("refused", || {
        matches!(r.tunnels.status("boat-1"), Some(Tunnel::Down(why)) if why.contains("host key other than the one pinned"))
    })
    .await;
    until("tried again", || r.boat.asked.lock().unwrap().len() >= 2).await;
    assert!(r.seen.lock().unwrap().forwards.is_empty());
    assert_ne!(r.tunnels.status("boat-1"), Some(Tunnel::Up));
    r.tunnels.close("boat-1");
}

/// boat naming no host key: nothing is dialled (no trust on first use), and the tunnel says why.
#[tokio::test]
async fn with_no_host_key_named_nothing_is_dialled() {
    let r = rig(key(1), None).await;
    r.tunnels.open("boat-1", "bx_1");
    until("refused", || {
        matches!(r.tunnels.status("boat-1"), Some(Tunnel::Down(why)) if why.contains("named no host key"))
    })
    .await;
    until("tried again", || r.boat.asked.lock().unwrap().len() >= 2).await;
    assert_eq!(r.seen.lock().unwrap().ended, 0, "never connected");
    r.tunnels.close("boat-1");
}

/// A machine that doesn't let the hub's key in: the tunnel says so, and isn't up.
#[tokio::test]
async fn a_refused_key_leaves_the_tunnel_down_saying_so() {
    let host = key(1);
    let (at, seen) = sshd(host.clone(), key(9).public_key().clone()).await;
    let boat = Arc::new(SshBoat {
        at,
        host_key: Some(host.public_key().to_openssh().unwrap()),
        asked: Mutex::default(),
    });
    let ours = Arc::new(key(7));
    let tunnels = SshTunnels::with_backoff(
        boat,
        Arc::new(move || Ok(ours.clone())),
        hub().await,
        Duration::from_millis(50),
        Duration::from_millis(200),
    );
    tunnels.open("boat-1", "bx_1");
    until("refused", || {
        matches!(tunnels.status("boat-1"), Some(Tunnel::Down(why)) if why.ends_with("refused the hub's SSH key"))
    })
    .await;
    assert!(seen.lock().unwrap().forwards.is_empty());
    tunnels.close("boat-1");
}

/// The hub's key is made once, kept sealed to its box key in the ledger, and the same at every use; only its public
/// half is ever written out.
#[test]
fn the_hubs_ssh_key_is_made_once_and_kept_sealed() {
    let db = crate::hub::store::HubDb::open_memory().unwrap();
    let home = tempfile::tempdir().unwrap();
    let ledger = super::ledger::Ledger::new(db);
    assert_eq!(ledger.sealed_ssh_key().unwrap(), None);
    let first = hub_key(&ledger, home.path()).unwrap();
    let sealed = ledger.sealed_ssh_key().unwrap().unwrap();
    let again = hub_key(&ledger, home.path()).unwrap();
    assert_eq!(first.public_key(), again.public_key());
    assert_eq!(ledger.sealed_ssh_key().unwrap().unwrap(), sealed);
    let line = public_line(&first).unwrap();
    assert!(
        line.starts_with("ssh-ed25519 ") && line.ends_with(" fleetd-hub"),
        "{line}"
    );
    // A second key offered later never replaces the kept one.
    assert_eq!(ledger.ssh_key_or(b"another").unwrap(), sealed);
}
