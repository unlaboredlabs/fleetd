//! The way cloud machines reach the hub (D307): the hub dials out, so it never needs a public address. While a pool
//! machine is up (creating, waking, awake, stopping) the hub holds an SSH connection to it with one reverse forward:
//! the machine's `127.0.0.1:47900` ([`MACHINE_PORT`]) goes to the hub's own listen address, and the machine's node uses
//! [`machine_hub_url`] as its hub URL.
//!
//! - **The key**: the hub's own ed25519 key ([`hub_key`]), made the first time it is needed and kept in the ledger
//!   sealed to the hub's box key. It is never pasted, never written out in the clear and never logged; only its
//!   public half leaves the hub.
//! - **The way in**: at each dial, boat's `POST /sshkey` lets that public key in on the running machine and names its
//!   SSH server's host key, which is pinned: a server showing another key is refused, and a dial boat names no host
//!   key for goes no further (no trust on first use). Where to dial is read from boat's GET at each dial too: every
//!   resume is a new machine, with a new address, `sshEndpoint` and host key (W407's spike), so nothing is kept
//!   across a sleep.
//! - **What it carries**: only connections to the forward the hub asked for, each to the hub's listen address whatever
//!   the machine names. It never asks for a shell, a command, agent or X11 forwarding, and refuses every other channel.
//! - **Its life**: opened at the wake or create, before the node needs it; redialled with backoff (1 s doubling to
//!   30 s) for as long as the machine should be up; closed when it sleeps or is deleted. A tunnel that can't come up
//!   leaves the node silent, and the wake's own timeout ([`super::HELLO_MS`]) counts it as a failed wake, with the
//!   tunnel's last error as the slot's note.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client;
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{Channel, ChannelOpenFailure, Disconnect};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use super::boat::Boat;
use super::ledger::Ledger;

/// The port on the cloud machine's loopback that reaches the hub. Off fleetd's own 4790, so a hub an agent runs there
/// for a test never takes it.
pub const MACHINE_PORT: u16 = 47900;
/// Each step of a dial: the TCP connect and handshake, the key, the forward.
const STEP: Duration = Duration::from_secs(20);
/// A silent connection is found dead after 3 keepalives unanswered, 15 s apart. boat's sshd sends none of its own
/// (`ClientAliveInterval 0`), so the hub's are what find a drop.
const KEEPALIVE: Duration = Duration::from_secs(15);
/// A tunnel that held this long redials from the shortest wait again.
const HELD_LONG: Duration = Duration::from_secs(60);

/// The hub URL a cloud machine's node joins and dials: its own loopback, through the tunnel.
pub fn machine_hub_url() -> String {
    format!("http://127.0.0.1:{MACHINE_PORT}")
}

/// One slot's tunnel, as the hub holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Tunnel {
    /// Connected, its forward granted.
    Up,
    /// Not up: why, in one line ("opening", or the last dial's failure).
    Down(String),
}

/// The tunnels the pool holds. [`SshTunnels`] is the real one; the pool's tests use a fake.
pub trait Tunnels: Send + Sync + 'static {
    /// Holds a tunnel to `slot`'s machine `sandbox` until [`Tunnels::close`]. Again for the same machine changes
    /// nothing; for another one replaces it.
    fn open(&self, slot: &str, sandbox: &str);
    fn close(&self, slot: &str);
    /// None: no tunnel is held for `slot`.
    fn status(&self, slot: &str) -> Option<Tunnel>;
}

/// The hub's key, made from its seed.
fn key_of(seed: &[u8]) -> Result<PrivateKey, String> {
    let seed: &[u8; 32] = seed
        .try_into()
        .map_err(|_| "the hub's SSH key is damaged".to_owned())?;
    let mut key = PrivateKey::from(Ed25519Keypair::from_seed(seed));
    key.set_comment("fleetd-hub");
    Ok(key)
}

/// The hub's SSH key: the ledger's, opened with the hub's box key, or made now and kept sealed. Never logged.
pub fn hub_key(ledger: &Ledger, home: &std::path::Path) -> Result<PrivateKey, String> {
    let box_key = crate::node::identity::load_or_create_box_key(home)
        .map_err(|_| "the hub can't read its box key".to_owned())?;
    let sealed = match ledger.sealed_ssh_key().map_err(|e| e.to_string())? {
        Some(sealed) => sealed,
        None => {
            let seed = Zeroizing::new(rand::random::<[u8; 32]>());
            let sealed = box_key
                .seal(seed.as_slice())
                .ok_or("sealing the hub's SSH key failed")?;
            ledger.ssh_key_or(&sealed).map_err(|e| e.to_string())?
        }
    };
    let seed = box_key
        .open(&sealed)
        .ok_or("the hub's SSH key was sealed to another box key")?;
    key_of(&seed)
}

/// The public half, OpenSSH format: what boat puts on each machine, and what the Cloud panel shows.
pub fn public_line(key: &PrivateKey) -> Result<String, String> {
    key.public_key()
        .to_openssh()
        .map_err(|_| "the hub's SSH key can't be written out".to_owned())
}

/// Where the hub's key comes from at each dial.
pub type KeySource = Arc<dyn Fn() -> Result<Arc<PrivateKey>, String> + Send + Sync>;

/// The hub's tunnels over SSH, with russh: the key stays in the hub's memory (no key file for an `ssh` process to
/// read) and the hub needs no OpenSSH client.
pub struct SshTunnels {
    dial: Arc<Dial>,
    held: Mutex<HashMap<String, Held>>,
}

struct Dial {
    boat: Arc<dyn Boat>,
    key: KeySource,
    /// The hub's listen address: where every forwarded connection goes.
    hub: (String, u16),
    /// The first wait after a drop, doubled up to `longest`.
    shortest: Duration,
    longest: Duration,
}

struct Held {
    sandbox: String,
    status: Arc<Mutex<Tunnel>>,
    /// Dropped to close: the tunnel's task sees it and hangs up.
    _stop: oneshot::Sender<()>,
}

/// The address the hub dials for itself: its listen address, with an any-address bind dialled on loopback.
pub fn hub_target(listen: &crate::hub::api::Listen) -> (String, u16) {
    let host = match listen.host.trim_matches(['[', ']']) {
        "" | "0.0.0.0" => "127.0.0.1".to_owned(),
        "::" => "::1".to_owned(),
        host => host.to_owned(),
    };
    (host, listen.port)
}

impl SshTunnels {
    pub fn new(boat: Arc<dyn Boat>, key: KeySource, hub: (String, u16)) -> SshTunnels {
        SshTunnels::with_backoff(
            boat,
            key,
            hub,
            Duration::from_secs(1),
            Duration::from_secs(30),
        )
    }

    pub fn with_backoff(
        boat: Arc<dyn Boat>,
        key: KeySource,
        hub: (String, u16),
        shortest: Duration,
        longest: Duration,
    ) -> SshTunnels {
        SshTunnels {
            dial: Arc::new(Dial {
                boat,
                key,
                hub,
                shortest,
                longest,
            }),
            held: Mutex::default(),
        }
    }
}

impl Tunnels for SshTunnels {
    fn open(&self, slot: &str, sandbox: &str) {
        let mut held = self.held.lock().unwrap();
        if held.get(slot).is_some_and(|h| h.sandbox == sandbox) {
            return;
        }
        let Ok(rt) = tokio::runtime::Handle::try_current() else {
            return tracing::error!(slot, "pool: no runtime to hold a tunnel on");
        };
        let status = Arc::new(Mutex::new(Tunnel::Down("opening".into())));
        let (stop_tx, stop) = oneshot::channel();
        rt.spawn(hold(
            self.dial.clone(),
            slot.to_owned(),
            sandbox.to_owned(),
            status.clone(),
            stop,
        ));
        held.insert(
            slot.to_owned(),
            Held {
                sandbox: sandbox.to_owned(),
                status,
                _stop: stop_tx,
            },
        );
    }

    fn close(&self, slot: &str) {
        if self.held.lock().unwrap().remove(slot).is_some() {
            tracing::info!(slot, "pool: tunnel closed");
        }
    }

    fn status(&self, slot: &str) -> Option<Tunnel> {
        let held = self.held.lock().unwrap();
        Some(held.get(slot)?.status.lock().unwrap().clone())
    }
}

/// One slot's tunnel: dialled, held, and redialled with backoff, until its [`Held`] is dropped.
async fn hold(
    dial: Arc<Dial>,
    slot: String,
    sandbox: String,
    status: Arc<Mutex<Tunnel>>,
    mut stop: oneshot::Receiver<()>,
) {
    let mut wait = dial.shortest;
    loop {
        let began = Instant::now();
        let why = match dial.session(&sandbox, &status, &mut stop).await {
            Ok(()) => return,
            Err(why) => why,
        };
        if !matches!(stop.try_recv(), Err(oneshot::error::TryRecvError::Empty)) {
            return;
        }
        let was_up = *status.lock().unwrap() == Tunnel::Up;
        if was_up {
            tracing::warn!(slot, why, "pool: tunnel dropped, redialling");
        } else {
            tracing::info!(slot, why, "pool: tunnel not up yet, redialling");
        }
        *status.lock().unwrap() = Tunnel::Down(why);
        if began.elapsed() >= HELD_LONG {
            wait = dial.shortest;
        }
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            _ = &mut stop => return,
        }
        wait = (wait * 2).min(dial.longest);
    }
}

async fn step<T, E: std::fmt::Display>(
    what: &str,
    f: impl Future<Output = Result<T, E>>,
) -> Result<T, String> {
    match tokio::time::timeout(STEP, f).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(format!("{what}: {e}")),
        Err(_) => Err(format!("{what}: no answer within {} s", STEP.as_secs())),
    }
}

impl Dial {
    /// One connection: boat lets the key in and names the host key, a GET says where to dial, the hub dials and checks
    /// the host key, signs in and asks for the forward, then holds it. Ok once closed by the hub; Err with why it
    /// failed or dropped.
    async fn session(
        &self,
        sandbox: &str,
        status: &Mutex<Tunnel>,
        stop: &mut oneshot::Receiver<()>,
    ) -> Result<(), String> {
        let key = (self.key)()?;
        let public = public_line(&key)?;
        let access = self
            .boat
            .ssh_key(sandbox, &public)
            .await
            .map_err(|e| format!("boat.dev didn't let the hub's key in: {}", e.line()))?;
        let named = access
            .host_key
            .as_deref()
            .filter(|k| !k.is_empty())
            .ok_or("boat.dev named no host key for its SSH server: not dialled")?;
        let pin = PublicKey::from_openssh(named)
            .map_err(|_| "boat.dev's host key for it can't be read".to_owned())?;
        let seen = self
            .boat
            .get(sandbox)
            .await
            .map_err(|e| format!("boat.dev didn't say where it is: {}", e.line()))?;
        let (host, port) = access
            .target(Some(&seen))
            .ok_or("boat.dev names no SSH endpoint for it yet")?;
        let (alive, ended) = oneshot::channel::<()>();
        let handler = Machine {
            pin,
            hub: self.hub.clone(),
            _alive: alive,
        };
        let config = Arc::new(client::Config {
            keepalive_interval: Some(KEEPALIVE),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });
        let at = format!("its SSH server at {host}:{port}");
        let mut handle = match tokio::time::timeout(
            STEP,
            client::connect(config, (host.as_str(), port), handler),
        )
        .await
        {
            Ok(Ok(handle)) => handle,
            Ok(Err(russh::Error::UnknownKey)) => {
                return Err(format!(
                    "{at} showed a host key other than the one pinned: refused"
                ));
            }
            Ok(Err(e)) => return Err(format!("{at}: {e}")),
            Err(_) => return Err(format!("{at}: no answer within {} s", STEP.as_secs())),
        };
        let signed_in = step(
            &format!("{at}, signing in as {}", access.user()),
            handle.authenticate_publickey(access.user(), PrivateKeyWithHashAlg::new(key, None)),
        )
        .await?;
        if !signed_in.success() {
            return Err(format!("{at} refused the hub's SSH key"));
        }
        step(
            &format!("{at}, the forward of its port {MACHINE_PORT}"),
            handle.tcpip_forward("127.0.0.1", MACHINE_PORT.into()),
        )
        .await?;
        *status.lock().unwrap() = Tunnel::Up;
        tokio::select! {
            _ = ended => Err(format!("{at}: the connection dropped")),
            _ = stop => {
                let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
                Ok(())
            }
        }
    }
}

/// The hub's side of one connection: the host key checked against boat's, the forward's connections carried to the
/// hub, every other channel refused. Dropped when the connection ends, which `_alive` tells.
struct Machine {
    pin: PublicKey,
    hub: (String, u16),
    _alive: oneshot::Sender<()>,
}

const REFUSED: ChannelOpenFailure = ChannelOpenFailure::AdministrativelyProhibited;

impl client::Handler for Machine {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        shown: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = shown else {
            return Ok(false);
        };
        Ok(self.pin.key_data() == key.key_data())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if connected_port != u32::from(MACHINE_PORT) {
            reply.reject(REFUSED).await;
            return Ok(());
        }
        let hub = self.hub.clone();
        let Ok(mut tcp) = tokio::net::TcpStream::connect((hub.0.as_str(), hub.1)).await else {
            tracing::warn!(hub = %format!("{}:{}", hub.0, hub.1), "pool: the tunnel can't reach the hub's own address");
            reply.reject(ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
        });
        Ok(())
    }

    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        _channel: Channel<client::Msg>,
        _socket_path: &str,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.reject(REFUSED).await;
        Ok(())
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        _channel: Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.reject(REFUSED).await;
        Ok(())
    }

    async fn server_channel_open_session(
        &mut self,
        _channel: Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.reject(REFUSED).await;
        Ok(())
    }

    async fn server_channel_open_direct_tcpip(
        &mut self,
        _channel: Channel<client::Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.reject(REFUSED).await;
        Ok(())
    }

    async fn server_channel_open_direct_streamlocal(
        &mut self,
        _channel: Channel<client::Msg>,
        _socket_path: &str,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.reject(REFUSED).await;
        Ok(())
    }

    async fn server_channel_open_x11(
        &mut self,
        _channel: Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.reject(REFUSED).await;
        Ok(())
    }
}
