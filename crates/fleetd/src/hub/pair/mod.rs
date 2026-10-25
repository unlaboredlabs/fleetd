//! Device pairing: `fleetd pair` mints a one-time code, and a device trades it at `POST /pair` for a human key
//! (the same key `fleetd hub key create --human` makes) on every machine, with the role the code was minted with.
//! No auth header: the code is the credential, so failed attempts are rate limited per remote address.
#[cfg(test)]
mod tests;

use crate::clock::Clock;
use crate::hub::api::{Hub, role_name};
use crate::hub::auth::CreatedKey;
use crate::hub::store::{HubDb, NewEvent, StoreError, iso_ms, now_ms};
use axum::http::StatusCode;
use fleetd_contracts::auth::{Grant, GrantMachines, KeyKind, Role, Star};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::pair::{PairError, PairErrorCode, PairRequest, PairResponse};
use rusqlite::{OptionalExtension, named_params, params};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

pub const CODE_TTL_MS: i64 = 15 * 60_000;
/// Crockford base32: no I, L, O or U, so a code read aloud or off a screen can't be misread.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN: usize = 8;
const MAX_FAILURES: usize = 5;
const FAILURE_WINDOW_MS: i64 = 60_000;
const MAX_DEVICE_NAME: usize = 64;
const NEW_CODE_FIX: &str = "Run `fleetd pair` on the hub for a new code.";
/// What `fleetd pair` grants without `--role`: the person at the hub machine pairs their own app, which changes
/// the hub's settings.
pub const DEFAULT_ROLE: Role = Role::Admin;

/// A fresh code, `XXXX-XXXX`: 40 random bits.
pub fn new_code() -> String {
    let bits = rand::random::<[u8; 5]>()
        .iter()
        .fold(0u64, |acc, &b| (acc << 8) | u64::from(b));
    let chars: String = (0..CODE_LEN)
        .rev()
        .map(|i| ALPHABET[((bits >> (i * 5)) & 31) as usize] as char)
        .collect();
    format!("{}-{}", &chars[..4], &chars[4..])
}

/// The code's 8 canonical characters: any case, the hyphen and surrounding spaces optional, and the look-alikes
/// Crockford decodes (I and L as 1, O as 0) accepted. None when it can't be a code.
pub fn normalize(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let body = match trimmed.split_once('-') {
        Some((a, b)) if a.len() == 4 => format!("{a}{b}"),
        Some(_) => return None,
        None => trimmed.to_owned(),
    };
    let canon: String = body
        .chars()
        .map(|c| match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            c => c,
        })
        .collect();
    (canon.len() == CODE_LEN && canon.bytes().all(|b| ALPHABET.contains(&b))).then_some(canon)
}

fn hash(canon: &str) -> String {
    Sha256::digest(canon.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Debug, Clone)]
pub struct MintedCode {
    /// `XXXX-XXXX`, shown once; the hub keeps its sha256.
    pub code: String,
    pub expires_at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum RedeemError {
    #[error("unknown or already used pairing code")]
    Invalid,
    #[error("pairing code expired")]
    Expired,
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// The `pair_codes` table.
pub struct PairCodes {
    db: Arc<HubDb>,
    clock: Arc<dyn Clock>,
}

impl PairCodes {
    pub fn new(db: Arc<HubDb>, clock: Arc<dyn Clock>) -> Self {
        Self { db, clock }
    }

    /// One-time, valid for 15 minutes. `name` names the key when the device sends no name of its own; `role` is
    /// what the key gets, whatever the device asks for.
    pub fn create(&self, name: Option<&str>, role: Role) -> Result<MintedCode, StoreError> {
        let expires = now_ms(self.clock.as_ref()) + CODE_TTL_MS;
        let code = new_code();
        let canon = normalize(&code).expect("a new code normalizes");
        self.db.with(|conn| {
            conn.prepare_cached(
                "INSERT INTO pair_codes (hash, name, expires_ms, role) VALUES (?, ?, ?, ?)",
            )?
            .execute(params![hash(&canon), name, expires, role_name(role)])?;
            Ok(())
        })?;
        Ok(MintedCode {
            code,
            expires_at: iso_ms(expires),
        })
    }

    /// Burns the code; returns the `--name` and `--role` it was minted with.
    pub fn redeem(&self, code: &str) -> Result<(Option<String>, Role), RedeemError> {
        let Some(canon) = normalize(code) else {
            return Err(RedeemError::Invalid);
        };
        let now = now_ms(self.clock.as_ref());
        let hash = hash(&canon);
        // One statement, so two devices racing on one code cannot both win.
        let burned: Option<(Option<String>, String)> = self.db.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "UPDATE pair_codes SET used_ms = $now WHERE hash = $hash AND used_ms IS NULL AND expires_ms > $now RETURNING name, role",
                )?
                .query_row(named_params! { "$now": now, "$hash": hash }, |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })
                .optional()?)
        })?;
        if let Some((name, role)) = burned {
            // An unreadable role grants the least, never more.
            return Ok((name, parse_role(&role).unwrap_or(Role::Read)));
        }
        let row: Option<(i64, Option<i64>)> = self.db.with(|conn| {
            Ok(conn
                .prepare_cached("SELECT expires_ms, used_ms FROM pair_codes WHERE hash = ?")?
                .query_row([&hash], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()?)
        })?;
        Err(match row {
            Some((expires, None)) if expires <= now => RedeemError::Expired,
            _ => RedeemError::Invalid,
        })
    }
}

/// `read`, `operate` or `admin`, as `fleetd pair --role` takes it.
pub fn parse_role(text: &str) -> Option<Role> {
    serde_json::from_value(serde_json::Value::String(text.to_owned())).ok()
}

/// Failed redeem attempts per remote address over the last minute.
#[derive(Default)]
pub struct Limiter {
    failures: Mutex<HashMap<Option<IpAddr>, Vec<i64>>>,
}

impl Limiter {
    pub fn blocked(&self, addr: Option<IpAddr>, now: i64) -> bool {
        let mut failures = self.failures.lock().unwrap_or_else(|p| p.into_inner());
        let Some(times) = failures.get_mut(&addr) else {
            return false;
        };
        times.retain(|&at| now - at < FAILURE_WINDOW_MS);
        times.len() >= MAX_FAILURES
    }

    pub fn failed(&self, addr: Option<IpAddr>, now: i64) {
        let mut failures = self.failures.lock().unwrap_or_else(|p| p.into_inner());
        if failures.len() > 1024 {
            failures.retain(|_, times| times.iter().any(|&at| now - at < FAILURE_WINDOW_MS));
        }
        failures.entry(addr).or_default().push(now);
    }
}

fn pair_error(
    status: StatusCode,
    code: PairErrorCode,
    message: &str,
    fix: &str,
) -> (StatusCode, serde_json::Value) {
    let body = PairError {
        code,
        message: message.to_owned(),
        fix: fix.to_owned(),
    };
    (
        status,
        serde_json::to_value(body).expect("a pair error serializes"),
    )
}

fn device_name(sent: Option<&str>, minted: Option<String>) -> String {
    let name: String = sent
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_owned)
        .or(minted)
        .unwrap_or_else(|| "device".to_owned())
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_DEVICE_NAME)
        .collect();
    name
}

/// Where the device should reach the hub from now on: the configured URL, else the address it just used when the
/// hub listens on every interface (`http://0.0.0.0:…` reaches nothing), else `http://<listen>`.
fn hub_url(hub: &Hub, host_header: Option<&str>) -> String {
    let unspecified = hub
        .config
        .listen
        .host
        .trim_matches(['[', ']'])
        .parse::<IpAddr>()
        .is_ok_and(|ip| ip.is_unspecified());
    match (&hub.config.url, host_header) {
        (None, Some(host)) if unspecified => format!("http://{host}"),
        _ => hub.config.url(),
    }
}

/// `POST /pair`: the status and JSON body to answer with.
pub fn handle(
    hub: &Hub,
    limiter: &Limiter,
    remote: Option<IpAddr>,
    host_header: Option<&str>,
    body: &[u8],
) -> (StatusCode, serde_json::Value) {
    let now = now_ms(hub.clock.as_ref());
    if limiter.blocked(remote, now) {
        return pair_error(
            StatusCode::TOO_MANY_REQUESTS,
            PairErrorCode::PairRateLimited,
            "too many wrong pairing codes from this address",
            "Wait a minute, then try again.",
        );
    }
    let request: PairRequest = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            return pair_error(
                StatusCode::BAD_REQUEST,
                PairErrorCode::Invalid,
                &format!("expected {{\"code\": \"XXXX-XXXX\", \"deviceName\": \"…\"}}: {error}"),
                "Send the pairing code from `fleetd pair` as JSON.",
            );
        }
    };
    let codes = PairCodes::new(hub.db.clone(), hub.clock.clone());
    let (minted_name, role) = match codes.redeem(&request.code) {
        Ok(minted) => minted,
        Err(error @ (RedeemError::Invalid | RedeemError::Expired)) => {
            limiter.failed(remote, now);
            let code = if matches!(error, RedeemError::Expired) {
                PairErrorCode::PairCodeExpired
            } else {
                PairErrorCode::PairCodeInvalid
            };
            return pair_error(
                StatusCode::UNAUTHORIZED,
                code,
                &error.to_string(),
                NEW_CODE_FIX,
            );
        }
        Err(RedeemError::Store(error)) => return store_failed(&error),
    };
    let name = device_name(request.device_name.as_deref(), minted_name);
    let grant = Grant {
        role,
        machines: GrantMachines::All(Star::Value),
    };
    let CreatedKey { key, info } = match hub.auth.create_key(&name, &[grant], KeyKind::Human) {
        Ok(created) => created,
        Err(error) => return store_failed(&error),
    };
    if let Err(error) = hub.events.append(NewEvent {
        at: iso_ms(now).into(),
        r#type: HubEventType::KeyPaired,
        machine_id: None,
        project_id: None,
        thread_id: None,
        summary: format!("{name} paired with the hub"),
        data: Some(serde_json::json!({ "keyId": info.key_id, "deviceName": name })),
        attention: None,
    }) {
        tracing::warn!("key.paired event not recorded: {error}");
    }
    let response = PairResponse {
        key,
        hub_url: hub_url(hub, host_header),
        hub_name: crate::hub::link::server::hub_id(),
    };
    (
        StatusCode::OK,
        serde_json::to_value(response).expect("a pair response serializes"),
    )
}

fn store_failed(error: &StoreError) -> (StatusCode, serde_json::Value) {
    tracing::error!("pairing failed: {error}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        serde_json::json!({ "code": "internal", "message": "the hub could not record the pairing", "fix": "Check the hub's log, then run `fleetd pair` again." }),
    )
}
