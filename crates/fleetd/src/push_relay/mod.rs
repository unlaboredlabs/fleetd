//! `fleetd push-relay`: the push relay (D218). A hub posts each sealed notification here; the
//! relay forwards it to APNs (apns.rs) or FCM (fcm.rs) with the publisher's credentials, which only it holds, from
//! files and the environment. It reads no notification: it sees a token, ciphertext and an opaque collapse key, keeps
//! none of them and logs none of them. Limits: a body of at most [`CIPHERTEXT_MAX`], [`PER_TOKEN_PER_MIN`] pushes a
//! minute to one token and [`PER_SOURCE_PER_MIN`] from one IP address (the peer's, or behind a proxy on the same machine
//! the last X-Forwarded-For entry). A token APNs or FCM no longer knows is answered `dead`, and the hub drops that device; an
//! answer that means the relay's own setup is wrong (another APNs environment or bundle id, another Firebase project)
//! is `failed`, saying what to fix, so a misconfigured relay never wipes the hub's phones. With
//! `FLEETD_PUSH_RELAY_KEY_FILE` set, it takes only requests that carry that key as a bearer token.
pub mod apns;
pub mod fcm;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, DefaultBodyLimit, Extension, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use fleetd_contracts::push::PushPlatform;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Digest;

/// The longest ciphertext (base64) the relay takes: with APNs's and FCM's envelopes it stays under their 4 KB.
pub const CIPHERTEXT_MAX: usize = 3500;
/// The longest token: APNs's are 64 hex digits, FCM's about 160 characters.
pub const TOKEN_MAX: usize = 4096;
pub const PER_TOKEN_PER_MIN: u32 = 60;
/// Pushes a minute from one IP address: a public relay takes pushes without a key, so one source can't flood it.
pub const PER_SOURCE_PER_MIN: u32 = 600;
/// Where `fleetd push-relay` listens without `--listen`.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:4795";
const BODY_MAX: usize = 8 * 1024;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(15);

/// What a hub posts to `/v1/push`, one device at a time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayPush {
    pub platform: PushPlatform,
    pub token: String,
    /// The sealed payload, standard base64.
    pub ciphertext: String,
    /// A later push with the same key replaces this one on the phone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapse_key: Option<String>,
}

/// The relay's answer, with 200 for `sent` and `dead` and an error status for `failed`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum RelayAnswer {
    Sent,
    /// APNs or FCM no longer knows the token: drop the device.
    Dead,
    Failed {
        error: String,
    },
}

/// What APNs or FCM made of one push.
#[derive(Clone, Debug, PartialEq)]
pub enum Delivery {
    Sent,
    Dead,
    Failed(String),
}

/// The relay's credentials and where it sends.
pub struct Relay {
    pub apns: Option<apns::Apns>,
    pub fcm: Option<fcm::Fcm>,
    /// The key hubs send as `Authorization: Bearer`; None takes every request.
    pub key: Option<zeroize::Zeroizing<String>>,
    pub http: reqwest::Client,
    tokens: Window,
    sources: Window,
}

/// Counts per key in a one-minute window. Keys are hashes: no token or address is kept in the clear.
struct Window {
    per_min: u32,
    counts: Mutex<HashMap<[u8; 32], (Instant, u32)>>,
}

impl Window {
    fn new(per_min: u32) -> Self {
        Self {
            per_min,
            counts: Mutex::new(HashMap::new()),
        }
    }

    /// Counts one against `what`'s minute; false when that minute is spent.
    fn allow(&self, what: &[u8], now: Instant) -> bool {
        let key: [u8; 32] = sha2::Sha256::digest(what).into();
        let mut counts = self.counts.lock().unwrap();
        if counts.len() > 10_000 {
            counts.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(60));
        }
        let entry = counts.entry(key).or_insert((now, 0));
        if now.duration_since(entry.0) >= Duration::from_secs(60) {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= self.per_min
    }
}

impl Relay {
    pub fn new(apns: Option<apns::Apns>, fcm: Option<fcm::Fcm>) -> Self {
        Self {
            apns,
            fcm,
            key: None,
            http: reqwest::Client::builder()
                .timeout(UPSTREAM_TIMEOUT)
                .build()
                .unwrap_or_default(),
            tokens: Window::new(PER_TOKEN_PER_MIN),
            sources: Window::new(PER_SOURCE_PER_MIN),
        }
    }

    /// The relay with `per_min` pushes a minute from one source, for tests.
    #[cfg(test)]
    pub fn with_source_limit(mut self, per_min: u32) -> Self {
        self.sources = Window::new(per_min);
        self
    }

    /// The credentials the environment names: `FLEETD_APNS_*` and `FLEETD_FCM_SERVICE_ACCOUNT`, and the key in
    /// `FLEETD_PUSH_RELAY_KEY_FILE`.
    pub fn from_env() -> Result<Self, String> {
        let mut relay = Self::new(apns::Apns::from_env()?, fcm::Fcm::from_env()?);
        if let Some(key) = read_named("FLEETD_PUSH_RELAY_KEY_FILE")? {
            let key = key.trim();
            if key.is_empty() {
                return Err("FLEETD_PUSH_RELAY_KEY_FILE names an empty file".into());
            }
            relay.key = Some(zeroize::Zeroizing::new(key.to_owned()));
        }
        Ok(relay)
    }

    /// Whether `headers` carry the relay's key, when it has one. Compared as hashes, so the time taken says nothing
    /// about the key.
    fn admits(&self, headers: &HeaderMap) -> bool {
        let Some(key) = &self.key else { return true };
        let sent = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or_default();
        sha2::Sha256::digest(sent.trim().as_bytes()) == sha2::Sha256::digest(key.as_bytes())
    }

    /// Counts a push to `token` against its minute; false when that minute is spent.
    fn allow(&self, token: &str, now: Instant) -> bool {
        self.tokens.allow(token.as_bytes(), now)
    }

    /// Counts a push from `source` against its minute; false when that minute is spent.
    fn allow_source(&self, source: IpAddr, now: Instant) -> bool {
        self.sources.allow(source.to_string().as_bytes(), now)
    }
}

/// Where a push came from: the TCP peer, or when the peer is this machine (a reverse proxy such as Caddy in front of
/// the relay) the last X-Forwarded-For entry, the one that proxy added. A header from anywhere else is ignored, so a
/// client can't pick its own address. Without a peer (no connect info) every push counts as one source.
pub fn source(peer: Option<SocketAddr>, headers: &HeaderMap) -> IpAddr {
    let Some(peer) = peer else {
        return IpAddr::V4(Ipv4Addr::UNSPECIFIED);
    };
    if !peer.ip().is_loopback() {
        return peer.ip();
    }
    headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .last()
        .and_then(|ip| ip.trim().parse().ok())
        .unwrap_or(peer.ip())
}

fn answer(status: StatusCode, answer: RelayAnswer) -> Response {
    (status, Json(answer)).into_response()
}

fn failed(status: StatusCode, error: &str) -> Response {
    answer(
        status,
        RelayAnswer::Failed {
            error: error.into(),
        },
    )
}

fn plausible(push: &RelayPush) -> bool {
    let b64 = |c: char| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=');
    !push.token.is_empty()
        && push.token.len() <= TOKEN_MAX
        // APNs's hex, FCM's base64url with a colon: nothing that could change the URL it goes in.
        && push.token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
        && !push.ciphertext.is_empty()
        && push.ciphertext.chars().all(b64)
        && push
            .collapse_key
            .as_ref()
            .is_none_or(|k| !k.is_empty() && k.len() <= 64 && k.chars().all(|c| c.is_ascii_alphanumeric()))
}

async fn push(
    State(relay): State<Arc<Relay>>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let peer = peer.map(|Extension(ConnectInfo(peer))| peer);
    if !relay.allow_source(source(peer, &headers), Instant::now()) {
        return failed(
            StatusCode::TOO_MANY_REQUESTS,
            "too many pushes from this address",
        );
    }
    if !relay.admits(&headers) {
        return failed(
            StatusCode::UNAUTHORIZED,
            "this relay takes a key: set it on the hub with `fleetd push-relay set <url> --relay-key-file <path>`",
        );
    }
    let Ok(push) = serde_json::from_slice::<RelayPush>(&body) else {
        return failed(StatusCode::BAD_REQUEST, "not a push");
    };
    if push.ciphertext.len() > CIPHERTEXT_MAX {
        return failed(StatusCode::PAYLOAD_TOO_LARGE, "ciphertext too long");
    }
    if !plausible(&push) {
        return failed(StatusCode::BAD_REQUEST, "not a push");
    }
    if !relay.allow(&push.token, Instant::now()) {
        return failed(
            StatusCode::TOO_MANY_REQUESTS,
            "too many pushes to this device",
        );
    }
    let delivery = match push.platform {
        PushPlatform::Ios => match &relay.apns {
            Some(apns) => apns.send(&relay.http, &push).await,
            None => return failed(StatusCode::SERVICE_UNAVAILABLE, "this relay sends no APNs"),
        },
        PushPlatform::Android => match &relay.fcm {
            Some(fcm) => fcm.send(&relay.http, &push).await,
            None => return failed(StatusCode::SERVICE_UNAVAILABLE, "this relay sends no FCM"),
        },
    };
    match delivery {
        Delivery::Sent => answer(StatusCode::OK, RelayAnswer::Sent),
        Delivery::Dead => answer(StatusCode::OK, RelayAnswer::Dead),
        Delivery::Failed(why) => {
            tracing::warn!(
                platform = push.platform.as_str(),
                "push not delivered: {why}"
            );
            failed(StatusCode::BAD_GATEWAY, &why)
        }
    }
}

async fn health(State(relay): State<Arc<Relay>>) -> Response {
    Json(json!({ "ok": true, "apns": relay.apns.is_some(), "fcm": relay.fcm.is_some() }))
        .into_response()
}

pub fn router(relay: Arc<Relay>) -> Router {
    Router::new()
        .route("/", get(health))
        .route("/v1/push", post(push))
        .layer(DefaultBodyLimit::max(BODY_MAX))
        .with_state(relay)
}

/// Serves the relay on `listen` until SIGINT or SIGTERM.
pub async fn serve(listen: SocketAddr, relay: Relay) -> Result<(), String> {
    let (apns, fcm, key) = (
        relay.apns.is_some(),
        relay.fcm.is_some(),
        relay.key.is_some(),
    );
    if !apns && !fcm {
        return Err(
            "no credentials: set FLEETD_APNS_KEY_FILE (with _KEY_ID, _TEAM_ID, _TOPIC) or FLEETD_FCM_SERVICE_ACCOUNT"
                .into(),
        );
    }
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|e| format!("can't listen on {listen}: {e}"))?;
    println!(
        "push relay on http://{listen} (APNs {}, FCM {}, {})",
        if apns { "on" } else { "off" },
        if fcm { "on" } else { "off" },
        if key { "key required" } else { "no key" }
    );
    let mut stop = crate::cli::Stop::on_signals();
    axum::serve(
        listener,
        router(Arc::new(relay)).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move { stop.wait().await })
    .await
    .map_err(|e| e.to_string())
}

/// A file a credential env var names, read whole.
fn read_named(var: &str) -> Result<Option<String>, String> {
    match std::env::var(var).ok().filter(|v| !v.trim().is_empty()) {
        None => Ok(None),
        Some(path) => std::fs::read_to_string(path.trim())
            .map(Some)
            .map_err(|e| format!("{var}: can't read {path}: {e}")),
    }
}

fn required(var: &str) -> Result<String, String> {
    std::env::var(var)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{var} is not set"))
}

/// The DER inside a PEM block.
fn pem_der(pem: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .map(str::trim)
        .collect();
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
