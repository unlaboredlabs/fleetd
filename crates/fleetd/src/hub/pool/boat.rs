//! The boat.dev REST client: the few calls the pool makes, straight to `https://boat.dev/api/v1`, with a typed error
//! for each code boat documents (docs.boat.dev/limits, openapi/boat-v1.yaml). boat is young and changes fast, so this
//! is the one module that knows its wire, and its tests hold it to recorded answers (testdata/boat/).
//!
//! A create carries an Idempotency-Key and is sent as the exact bytes the ledger sealed, so a retry is byte-identical
//! (boat refuses a changed body under the same key). Every ttl goes out as a [`Ttl`], which only the lease's one
//! clamping function makes: no call here can send `null`, boat's "never stop".
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::lease::Ttl;
use crate::hub::train::host::BoxFut;

pub const API: &str = "https://boat.dev/api/v1";
/// Each call; a create or resume with failFast answers in about 1.5 s.
const TIMEOUT: Duration = Duration::from_secs(30);
/// A list's page: boat's most.
const PAGE: usize = 200;
/// A list longer than this many pages is refused rather than read short: a sweep must see every machine or none.
const MAX_PAGES: usize = 100;

/// A sandbox as boat answers it, with the fields the pool reads.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Sandbox {
    pub id: String,
    pub state: String,
    pub labels: BTreeMap<String, String>,
    /// When boat stops it by itself; null when auto-stop is off.
    pub archive_after: Option<String>,
    pub ttl_seconds: Option<i64>,
    pub setup_status: Option<String>,
    pub setup_error: Option<String>,
    pub data_expired_at: Option<String>,
    pub error: Option<String>,
    /// Its disk is fully attached: until then, after a wake, builds run about 5 times slower (W407's spike).
    pub hydrated: Option<bool>,
    /// `host:port` (IPv4) that forwards to its SSH server: new at every wake, so read at every dial.
    pub ssh_endpoint: Option<String>,
    /// A resume found it running already (boat answers 200, `status: "running"`): no start was counted, and its
    /// deadline didn't move. Not boat's field.
    #[serde(skip)]
    pub already_running: bool,
}

/// Where a sandbox is in its life, from boat's states.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// init, provisioning, provisioned, cloning, ready, idle, running: up, or on its way (and billing from
    /// provisioned on).
    Up,
    /// archiving: a stop is under way. A resume now takes back the same machine.
    Stopping,
    /// archived.
    Stopped,
    /// error or cancelled: it holds no machine.
    Dead,
}

impl Sandbox {
    pub fn phase(&self) -> Phase {
        match self.state.as_str() {
            "archiving" => Phase::Stopping,
            "archived" => Phase::Stopped,
            "error" | "cancelled" => Phase::Dead,
            _ => Phase::Up,
        }
    }

    pub fn label(&self, key: &str) -> Option<&str> {
        self.labels.get(key).map(String::as_str)
    }

    pub fn archive_after_ms(&self) -> Option<i64> {
        self.archive_after
            .as_deref()
            .and_then(crate::hub::store::parse_ms)
    }
}

/// The plan's included starts per rolling window.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct StartLimits {
    pub per_minute: u32,
    pub per_hour: u32,
    pub per_day: u32,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MachineType {
    #[serde(rename = "type")]
    pub kind: String,
    pub available: bool,
    pub reason: Option<String>,
}

/// `GET /limits`, the pre-flight before every start.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Limits {
    pub can_start: bool,
    pub start_blocked_reason: Option<String>,
    /// What the next start costs: 0 inside every limit, null when it would be refused.
    pub next_start_dollars: Option<f64>,
    pub active_sandboxes: u32,
    pub max_active_sandboxes: u32,
    /// Null on unlimited accounts.
    pub start_limits: Option<StartLimits>,
    /// The plan's price a month, which is also the machine time it includes.
    pub sandbox_plan_dollars: Option<f64>,
    pub machine_types: Vec<MachineType>,
}

/// `POST /sandboxes/{id}/sshkey`'s answer: where the running machine's SSH server is, as whom, and its host key.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SshAccess {
    /// Its own address: IPv6, which the hub may have no route to, so never dialled.
    pub machine_ip: Option<String>,
    /// `host:port` that forwards to its SSH server, set only for a machine with no public IPv4 of its own.
    pub ssh_endpoint: Option<String>,
    pub ssh_user: Option<String>,
    /// The SSH server's public host key, OpenSSH format: what the hub pins. A new one at every resume.
    pub host_key: Option<String>,
}

impl SshAccess {
    /// Where to dial: the IPv4 `sshEndpoint` boat forwards to the machine's SSH server, `seen`'s (a GET of the machine
    /// just now) first, else this answer's. Never the machine's own address, which is IPv6 (W407's spike).
    pub fn target(&self, seen: Option<&Sandbox>) -> Option<(String, u16)> {
        let endpoint = seen
            .and_then(|sb| sb.ssh_endpoint.as_deref())
            .into_iter()
            .chain(self.ssh_endpoint.as_deref())
            .find(|e| !e.is_empty())?;
        let (host, port) = endpoint.rsplit_once(':')?;
        Some((host.trim_matches(['[', ']']).to_owned(), port.parse().ok()?))
    }

    pub fn user(&self) -> &str {
        self.ssh_user
            .as_deref()
            .filter(|u| !u.is_empty())
            .unwrap_or("user")
    }
}

/// A create's file: under /tmp, which boat never snapshots, for anything secret.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct File {
    pub path: String,
    pub content: String,
}

/// `POST /sandboxes`, as the pool always sends it: no environment's secrets and no in-VM boat key (`noEnv`),
/// monitoring off (a process list carries argv, and argv can carry a token), and failFast so a short boat answers in
/// seconds instead of building a machine.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBody {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub labels: BTreeMap<String, String>,
    pub ttl_seconds: Ttl,
    pub no_env: bool,
    pub monitoring: bool,
    pub fail_fast: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_script: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<File>,
}

impl CreateBody {
    pub fn new(kind: &str, name: String, labels: BTreeMap<String, String>, ttl: Ttl) -> Self {
        CreateBody {
            kind: kind.to_owned(),
            name,
            labels,
            ttl_seconds: ttl,
            no_env: true,
            monitoring: false,
            fail_fast: true,
            environment: None,
            setup_script: None,
            files: Vec::new(),
        }
    }
}

/// What boat refused, one case per code it documents.
#[derive(Clone, Debug, PartialEq)]
pub enum BoatError {
    /// 429 `rate_limited`: a start window is full; no start before `next_start_at` (ms).
    RateLimited {
        next_start_at: Option<i64>,
        retry_after_s: Option<u64>,
    },
    /// 429 `limit_reached`: the plan's machines-at-once limit is full.
    LimitReached,
    /// 429 `member_limit_reached`: the org owner capped this member's machines at once.
    MemberLimitReached,
    /// 402 `billing_required` / `team_member_cap_reached`, 429 `trial_compute_limit_reached`.
    Billing { code: String, url: Option<String> },
    /// 503 `no_ready_machine`: failFast found no machine; nothing started or counted.
    NoReadyMachine,
    /// 503 `out_of_capacity`.
    OutOfCapacity { retry_after_s: Option<u64> },
    /// 429 `IP_RATE_LIMIT_EXCEEDED`.
    IpRateLimited { retry_after_s: Option<u64> },
    /// 401, or a 403 about the key (`api_key_expired`, `api_key_action_forbidden`, `api_key_sandbox_forbidden`,
    /// `forbidden`).
    KeyRefused { code: String },
    /// 404: the sandbox is gone.
    NotFound,
    /// 409 `snapshot_data_expired`: boat deleted a long-stopped sandbox's disk; it can't resume.
    DataExpired,
    /// 409 `idempotency_in_progress`: the first create under this key is still being made.
    IdempotencyInProgress,
    /// 409 `idempotency_key_reused`: this key went with another body.
    IdempotencyKeyReused,
    /// Any other 409.
    Conflict { code: String },
    /// Any other 4xx.
    Refused { status: u16, code: String },
    /// 5xx.
    Server { status: u16 },
    /// No answer: a timeout, DNS, a reset connection, or an answer that isn't boat's JSON.
    Network(String),
    /// The hub holds no boat key, or can't open it.
    NoKey(String),
}

impl BoatError {
    /// One plain line for the person.
    pub fn line(&self) -> String {
        match self {
            BoatError::RateLimited { .. } => "boat.dev start limit reached".into(),
            BoatError::LimitReached => "boat.dev: machines-at-once limit reached".into(),
            BoatError::MemberLimitReached => {
                "boat.dev: your organization's machines-at-once cap is reached".into()
            }
            BoatError::Billing { code, .. } => {
                format!("boat.dev needs billing attention ({code}): Settings › Hub › Machines")
            }
            BoatError::NoReadyMachine | BoatError::OutOfCapacity { .. } => {
                "boat.dev is short of machines, retrying".into()
            }
            BoatError::IpRateLimited { .. } => "boat.dev rate limit, retrying".into(),
            BoatError::KeyRefused { code } => {
                format!("boat.dev key refused ({code}): Settings › Hub › Machines")
            }
            BoatError::NotFound => "boat.dev has no such machine".into(),
            BoatError::DataExpired => "boat.dev deleted the stopped machine's disk".into(),
            BoatError::IdempotencyInProgress => "boat.dev is still making this machine".into(),
            BoatError::IdempotencyKeyReused => "boat.dev refused a changed retry".into(),
            BoatError::Conflict { code } => format!("boat.dev refused it ({code})"),
            BoatError::Refused { status, code } => format!("boat.dev refused it ({status} {code})"),
            BoatError::Server { .. } | BoatError::Network(_) => {
                "boat.dev unreachable, retrying".into()
            }
            BoatError::NoKey(why) => why.clone(),
        }
    }
}

/// The calls the pool makes. [`RestBoat`] is boat itself; the pool's tests use a fake.
pub trait Boat: Send + Sync + 'static {
    /// `POST /sandboxes` with `body`'s exact bytes under `idem_key`.
    fn create<'a>(
        &'a self,
        idem_key: &'a str,
        body: &'a [u8],
    ) -> BoxFut<'a, Result<Sandbox, BoatError>>;
    fn get<'a>(&'a self, id: &'a str) -> BoxFut<'a, Result<Sandbox, BoatError>>;
    /// Every sandbox carrying all of `labels`, in every state, every page read.
    fn list<'a>(
        &'a self,
        labels: &'a [(String, String)],
    ) -> BoxFut<'a, Result<Vec<Sandbox>, BoatError>>;
    /// `PATCH {ttlSeconds}`: boat stops it `ttl` from now.
    fn set_ttl<'a>(&'a self, id: &'a str, ttl: Ttl) -> BoxFut<'a, Result<(), BoatError>>;
    fn stop<'a>(&'a self, id: &'a str) -> BoxFut<'a, Result<(), BoatError>>;
    /// `POST /resume`, failFast, no-env, with a lease. boat documents no Idempotency-Key for it: the pool sends it only
    /// after a GET saw the machine stopped, one at a time per slot.
    fn resume<'a>(&'a self, id: &'a str, ttl: Ttl) -> BoxFut<'a, Result<Sandbox, BoatError>>;
    /// `DELETE` with its confirm header: the disk, its snapshots and every key on it go.
    fn delete<'a>(&'a self, id: &'a str) -> BoxFut<'a, Result<(), BoatError>>;
    fn limits(&self) -> BoxFut<'_, Result<Limits, BoatError>>;
    /// `POST /sshkey`: lets `public_key` (OpenSSH format) in as boat's `user` on the running machine, for the hub's
    /// tunnel. The key's `ssh` action.
    fn ssh_key<'a>(
        &'a self,
        id: &'a str,
        public_key: &'a str,
    ) -> BoxFut<'a, Result<SshAccess, BoatError>>;
    /// Dollars of machine time the sandbox used since `since_ms`, at list price.
    fn usage<'a>(&'a self, id: &'a str, since_ms: i64) -> BoxFut<'a, Result<f64, BoatError>>;
}

/// Where the key comes from at each call: the ledger's, opened with the hub's box key.
pub type KeySource = Arc<dyn Fn() -> Result<Zeroizing<String>, BoatError> + Send + Sync>;

/// boat.dev over HTTPS.
pub struct RestBoat {
    api: String,
    http: reqwest::Client,
    key: KeySource,
}

impl RestBoat {
    pub fn new(api: &str, key: KeySource) -> Self {
        RestBoat {
            api: api.trim_end_matches('/').to_owned(),
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .user_agent("fleetd")
                .build()
                .unwrap_or_default(),
            key,
        }
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        headers: &[(&str, &str)],
        body: Option<Vec<u8>>,
    ) -> Result<Value, BoatError> {
        let key = (self.key)()?;
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.api))
            .bearer_auth(key.as_str())
            .query(query);
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        if let Some(body) = body {
            req = req.header("content-type", "application/json").body(body);
        }
        let res = req
            .send()
            .await
            .map_err(|e| BoatError::Network(e.without_url().to_string()))?;
        let status = res.status().as_u16();
        let retry_after = res
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let text = res
            .text()
            .await
            .map_err(|e| BoatError::Network(e.without_url().to_string()))?;
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            if body.is_null() {
                return Err(BoatError::Network(format!(
                    "boat answered {status} without JSON"
                )));
            }
            return Ok(body);
        }
        Err(refusal(status, &body, retry_after))
    }

    fn sandbox(body: Value) -> Result<Sandbox, BoatError> {
        let v = body.get("sandbox").cloned().unwrap_or(Value::Null);
        serde_json::from_value(v).map_err(|e| BoatError::Network(format!("boat's sandbox: {e}")))
    }
}

/// A refusal's typed error, from its status, its body's `code` and the fields boat puts beside it (at the top, or
/// under `error.details`) and the Retry-After header.
pub fn refusal(status: u16, body: &Value, retry_after: Option<u64>) -> BoatError {
    let code = body
        .get("code")
        .or_else(|| body.pointer("/error/code"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let field = |name: &str| {
        body.get(name)
            .or_else(|| body.pointer(&format!("/error/details/{name}")))
            .filter(|v| !v.is_null())
    };
    let secs = |name: &str| {
        field(name)
            .and_then(Value::as_f64)
            .map(|s| s.max(0.0).ceil() as u64)
    };
    let retry = retry_after
        .or_else(|| secs("retryAfterSeconds"))
        .or_else(|| secs("retryAfter"));
    match (status, code.as_str()) {
        (429, "rate_limited") => BoatError::RateLimited {
            next_start_at: field("nextStartAt")
                .and_then(Value::as_str)
                .and_then(crate::hub::store::parse_ms),
            retry_after_s: retry,
        },
        (429, "limit_reached") => BoatError::LimitReached,
        (429, "member_limit_reached") => BoatError::MemberLimitReached,
        (402, _) | (429, "trial_compute_limit_reached") => BoatError::Billing {
            url: field("billingUrl")
                .and_then(Value::as_str)
                .map(str::to_owned),
            code: if code.is_empty() {
                "billing_required".into()
            } else {
                code
            },
        },
        (429, c) if c.eq_ignore_ascii_case("ip_rate_limit_exceeded") => BoatError::IpRateLimited {
            retry_after_s: retry,
        },
        (503, "no_ready_machine") => BoatError::NoReadyMachine,
        (503, "out_of_capacity") => BoatError::OutOfCapacity {
            retry_after_s: retry,
        },
        (401, _) => BoatError::KeyRefused {
            code: if code.is_empty() {
                "unauthorized".into()
            } else {
                code
            },
        },
        (403, c) if c.starts_with("api_key_") || c == "forbidden" || c == "unauthorized" => {
            BoatError::KeyRefused { code }
        }
        (404, _) => BoatError::NotFound,
        (409, "snapshot_data_expired") => BoatError::DataExpired,
        (409, "idempotency_in_progress") => BoatError::IdempotencyInProgress,
        (409, "idempotency_key_reused") => BoatError::IdempotencyKeyReused,
        (409, _) => BoatError::Conflict { code },
        (s, _) if s >= 500 => BoatError::Server { status: s },
        (s, _) => BoatError::Refused { status: s, code },
    }
}

impl Boat for RestBoat {
    fn create<'a>(
        &'a self,
        idem_key: &'a str,
        body: &'a [u8],
    ) -> BoxFut<'a, Result<Sandbox, BoatError>> {
        Box::pin(async move {
            let body = self
                .call(
                    reqwest::Method::POST,
                    "/sandboxes",
                    &[],
                    &[("idempotency-key", idem_key)],
                    Some(body.to_vec()),
                )
                .await?;
            Self::sandbox(body)
        })
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFut<'a, Result<Sandbox, BoatError>> {
        Box::pin(async move {
            let body = self
                .call(
                    reqwest::Method::GET,
                    &format!("/sandboxes/{id}"),
                    &[],
                    &[],
                    None,
                )
                .await?;
            Self::sandbox(body)
        })
    }

    fn list<'a>(
        &'a self,
        labels: &'a [(String, String)],
    ) -> BoxFut<'a, Result<Vec<Sandbox>, BoatError>> {
        Box::pin(async move {
            let mut all = Vec::new();
            let mut cursor: Option<String> = None;
            for _ in 0..MAX_PAGES {
                let mut query: Vec<(&str, String)> = labels
                    .iter()
                    .map(|(k, v)| ("label", format!("{k}={v}")))
                    .collect();
                query.push(("limit", PAGE.to_string()));
                if let Some(c) = &cursor {
                    query.push(("cursor", c.clone()));
                }
                let body = self
                    .call(reqwest::Method::GET, "/sandboxes", &query, &[], None)
                    .await?;
                let page: Vec<Sandbox> =
                    serde_json::from_value(body.get("sandboxes").cloned().unwrap_or(json!([])))
                        .map_err(|e| BoatError::Network(format!("boat's list: {e}")))?;
                all.extend(page);
                let more = body.pointer("/pageInfo/hasMore").and_then(Value::as_bool) == Some(true);
                cursor = body
                    .pointer("/pageInfo/nextCursor")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if !more || cursor.is_none() {
                    return Ok(all);
                }
            }
            Err(BoatError::Network(format!(
                "boat's list ran past {MAX_PAGES} pages; read none of it"
            )))
        })
    }

    fn set_ttl<'a>(&'a self, id: &'a str, ttl: Ttl) -> BoxFut<'a, Result<(), BoatError>> {
        Box::pin(async move {
            let body = serde_json::to_vec(&TtlBody { ttl_seconds: ttl }).unwrap_or_default();
            self.call(
                reqwest::Method::PATCH,
                &format!("/sandboxes/{id}"),
                &[],
                &[],
                Some(body),
            )
            .await
            .map(drop)
        })
    }

    fn stop<'a>(&'a self, id: &'a str) -> BoxFut<'a, Result<(), BoatError>> {
        Box::pin(async move {
            self.call(
                reqwest::Method::POST,
                &format!("/sandboxes/{id}/stop"),
                &[],
                &[],
                Some(b"{}".to_vec()),
            )
            .await
            .map(drop)
        })
    }

    fn resume<'a>(&'a self, id: &'a str, ttl: Ttl) -> BoxFut<'a, Result<Sandbox, BoatError>> {
        Box::pin(async move {
            let body = serde_json::to_vec(&ResumeBody {
                ttl_seconds: ttl,
                fail_fast: true,
                no_env: true,
            })
            .unwrap_or_default();
            let body = self
                .call(
                    reqwest::Method::POST,
                    &format!("/sandboxes/{id}/resume"),
                    &[],
                    &[],
                    Some(body),
                )
                .await?;
            let already_running = body.get("status").and_then(Value::as_str) == Some("running");
            // The answer's sandbox can be null; the id is the one resumed.
            let mut sandbox = Self::sandbox(body).unwrap_or_default();
            sandbox.already_running = already_running;
            if sandbox.id.is_empty() {
                sandbox.id = id.to_owned();
            }
            Ok(sandbox)
        })
    }

    fn delete<'a>(&'a self, id: &'a str) -> BoxFut<'a, Result<(), BoatError>> {
        Box::pin(async move {
            match self
                .call(
                    reqwest::Method::DELETE,
                    &format!("/sandboxes/{id}"),
                    &[],
                    &[("x-ascii-confirm-delete", id)],
                    None,
                )
                .await
            {
                Ok(_) | Err(BoatError::NotFound) => Ok(()),
                Err(e) => Err(e),
            }
        })
    }

    fn limits(&self) -> BoxFut<'_, Result<Limits, BoatError>> {
        Box::pin(async move {
            let body = self
                .call(reqwest::Method::GET, "/limits", &[], &[], None)
                .await?;
            serde_json::from_value(body)
                .map_err(|e| BoatError::Network(format!("boat's limits: {e}")))
        })
    }

    fn ssh_key<'a>(
        &'a self,
        id: &'a str,
        public_key: &'a str,
    ) -> BoxFut<'a, Result<SshAccess, BoatError>> {
        Box::pin(async move {
            let body = serde_json::to_vec(&json!({ "key": public_key })).unwrap_or_default();
            let body = self
                .call(
                    reqwest::Method::POST,
                    &format!("/sandboxes/{id}/sshkey"),
                    &[],
                    &[],
                    Some(body),
                )
                .await?;
            serde_json::from_value(body)
                .map_err(|e| BoatError::Network(format!("boat's SSH answer: {e}")))
        })
    }

    fn usage<'a>(&'a self, id: &'a str, since_ms: i64) -> BoxFut<'a, Result<f64, BoatError>> {
        Box::pin(async move {
            let since = crate::hub::store::iso_ms(since_ms);
            let body = self
                .call(
                    reqwest::Method::GET,
                    &format!("/sandboxes/{id}/usage"),
                    &[("since", since)],
                    &[],
                    None,
                )
                .await?;
            body.get("dollars")
                .and_then(Value::as_f64)
                .ok_or_else(|| BoatError::Network("boat's usage had no dollars".into()))
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtlBody {
    pub ttl_seconds: Ttl,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeBody {
    pub ttl_seconds: Ttl,
    pub fail_fast: bool,
    pub no_env: bool,
}
