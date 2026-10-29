//! Device pairing: `fleetd pair` mints a one-time code, and a device trades it at `POST /pair` for a human key
//! (the same key `fleetd hub key create --human` makes) on every machine, with the role the code was minted with.
//! An invite (`fleetd invite`, invite_create) is such a code bound to a person and valid for 7 days: the key it mints
//! belongs to them. A plain `fleetd pair` code pairs one more device for the hub's owner.
//! No auth header: the code is the credential, so failed attempts are rate limited per remote address.
#[cfg(test)]
mod tests;
pub mod tools;

use crate::clock::Clock;
use crate::hub::api::{Hub, role_name};
use crate::hub::auth::CreatedKey;
use crate::hub::store::{HubDb, NewEvent, StoreError, iso_ms, now_ms};
use axum::http::StatusCode;
use fleetd_contracts::auth::{Grant, GrantMachines, KeyKind, Role, Star};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::pair::{PairError, PairErrorCode, PairRequest, PairResponse};
use fleetd_contracts::people::{
    Invite, InviteId, InviteState, PeopleChange, Person, PersonId, PersonName, PersonRef,
};
use rusqlite::{Connection, OptionalExtension, named_params, params};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

pub const CODE_TTL_MS: i64 = 15 * 60_000;
/// An invite travels by chat or email, so it lives longer than a code read off the hub machine's screen.
pub const INVITE_TTL_MS: i64 = 7 * 24 * 60 * 60_000;
/// Crockford base32: no I, L, O or U, so a code read aloud or off a screen can't be misread.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN: usize = 8;
const MAX_FAILURES: usize = 5;
const FAILURE_WINDOW_MS: i64 = 60_000;
const MAX_DEVICE_NAME: usize = 64;
const NEW_CODE_FIX: &str =
    "Run `fleetd pair` on the hub for a new code, or ask whoever invited you for a new invite.";
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

/// What a burned code was minted with.
#[derive(Debug, Clone, PartialEq)]
pub struct Redeemed {
    /// `--name`, for a device that sends none.
    pub name: Option<String>,
    pub role: Role,
    /// An invite's person; None pairs for the owner.
    pub person_id: Option<PersonId>,
    pub invite_id: Option<InviteId>,
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
        self.insert(name, role, None)
    }

    /// The same, for one more device of `person` (the app's Pair a phone): the key it mints is theirs.
    pub fn create_for(&self, person: &PersonId, role: Role) -> Result<MintedCode, StoreError> {
        self.insert(None, role, Some(person))
    }

    fn insert(
        &self,
        name: Option<&str>,
        role: Role,
        person: Option<&PersonId>,
    ) -> Result<MintedCode, StoreError> {
        let now = now_ms(self.clock.as_ref());
        let expires = now + CODE_TTL_MS;
        let code = new_code();
        let canon = normalize(&code).expect("a new code normalizes");
        self.db.with(|conn| {
            conn.prepare_cached(
                "INSERT INTO pair_codes (hash, name, expires_ms, role, created_ms, person_id) VALUES (?, ?, ?, ?, ?, ?)",
            )?
            .execute(params![
                hash(&canon),
                name,
                expires,
                role_name(role),
                now,
                person.map(|p| p.as_str())
            ])?;
            Ok(())
        })?;
        Ok(MintedCode {
            code,
            expires_at: iso_ms(expires),
        })
    }

    /// An invite for `person`, valid for 7 days: the device that redeems it gets a key of theirs with admin on every
    /// machine, which their role caps each time the key is verified (`Auth::verify`). So a member's device operates,
    /// and making them an admin later takes effect on it at once, with no new device.
    pub fn create_invite(
        &self,
        person: &Person,
        created_by: Option<&PersonId>,
    ) -> Result<(MintedCode, Invite), StoreError> {
        let now = now_ms(self.clock.as_ref());
        let expires = now + INVITE_TTL_MS;
        let code = new_code();
        let canon = normalize(&code).expect("a new code normalizes");
        let invite_id = format!(
            "inv_{}",
            crate::hub::auth::base32(&rand::random::<[u8; 5]>())
        );
        let role = Role::Admin;
        let invite = self.db.with(|conn| {
            conn.prepare_cached(
                "INSERT INTO pair_codes (hash, name, expires_ms, role, created_ms, person_id, invite_id, created_by) \
                 VALUES (?, NULL, ?, ?, ?, ?, ?, ?)",
            )?
            .execute(params![
                hash(&canon),
                expires,
                role_name(role),
                now,
                person.person_id.as_str(),
                invite_id,
                created_by.map(|p| p.as_str())
            ])?;
            invite_on(conn, &invite_id, now)
        })?;
        let invite = invite.expect("just inserted");
        Ok((
            MintedCode {
                code,
                expires_at: iso_ms(expires),
            },
            invite,
        ))
    }

    /// Invites, newest first: only open ones unless `all`.
    pub fn invites(&self, all: bool) -> Result<Vec<Invite>, StoreError> {
        let now = now_ms(self.clock.as_ref());
        self.db.with(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {INVITE_COLUMNS} FROM {INVITE_FROM} WHERE c.invite_id IS NOT NULL \
                 AND (?1 OR (c.used_ms IS NULL AND c.revoked_ms IS NULL AND c.expires_ms > ?2)) \
                 ORDER BY c.created_ms DESC, c.invite_id"
            ))?;
            let invites = stmt
                .query_map(params![all, now], |row| invite_row(row, now))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(invites)
        })
    }

    pub fn invite(&self, id: &InviteId) -> Result<Option<Invite>, StoreError> {
        let now = now_ms(self.clock.as_ref());
        self.db.with(|conn| invite_on(conn, id.as_str(), now))
    }

    /// Takes an open invite back; a used or revoked one stays as it was. The invite, and whether this call revoked it;
    /// None when there is no such invite.
    pub fn revoke_invite(&self, id: &InviteId) -> Result<Option<(Invite, bool)>, StoreError> {
        let now = now_ms(self.clock.as_ref());
        self.db.with(|conn| {
            let changed = conn
                .prepare_cached(
                    "UPDATE pair_codes SET revoked_ms = ?2 WHERE invite_id = ?1 AND used_ms IS NULL AND revoked_ms IS NULL",
                )?
                .execute(params![id.as_str(), now])?;
            Ok(invite_on(conn, id.as_str(), now)?.map(|invite| (invite, changed > 0)))
        })
    }

    /// Burns the code; returns what it was minted with.
    pub fn redeem(&self, code: &str) -> Result<Redeemed, RedeemError> {
        let Some(canon) = normalize(code) else {
            return Err(RedeemError::Invalid);
        };
        let now = now_ms(self.clock.as_ref());
        let hash = hash(&canon);
        // One statement, so two devices racing on one code cannot both win.
        type Burned = (Option<String>, String, Option<String>, Option<String>);
        let burned: Option<Burned> = self.db.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "UPDATE pair_codes SET used_ms = $now WHERE hash = $hash AND used_ms IS NULL AND revoked_ms IS NULL \
                     AND expires_ms > $now RETURNING name, role, person_id, invite_id",
                )?
                .query_row(named_params! { "$now": now, "$hash": hash }, |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .optional()?)
        })?;
        if let Some((name, role, person_id, invite_id)) = burned {
            return Ok(Redeemed {
                name,
                // An unreadable role grants the least, never more.
                role: parse_role(&role).unwrap_or(Role::Read),
                person_id: person_id.map(PersonId::unchecked),
                invite_id: invite_id.map(InviteId::unchecked),
            });
        }
        let row: Option<(i64, Option<i64>, Option<i64>)> = self.db.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "SELECT expires_ms, used_ms, revoked_ms FROM pair_codes WHERE hash = ?",
                )?
                .query_row([&hash], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .optional()?)
        })?;
        Err(match row {
            Some((expires, None, None)) if expires <= now => RedeemError::Expired,
            _ => RedeemError::Invalid,
        })
    }
}

const INVITE_COLUMNS: &str = "c.invite_id, c.person_id, p.name, c.created_ms, c.expires_ms, c.used_ms, \
     c.revoked_ms, c.created_by, b.name";
const INVITE_FROM: &str = "pair_codes c LEFT JOIN people p ON p.person_id = c.person_id \
     LEFT JOIN people b ON b.person_id = c.created_by";

fn invite_on(conn: &Connection, id: &str, now: i64) -> Result<Option<Invite>, StoreError> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {INVITE_COLUMNS} FROM {INVITE_FROM} WHERE c.invite_id = ?"
        ))?
        .query_row([id], |row| invite_row(row, now))
        .optional()?)
}

fn invite_row(row: &rusqlite::Row<'_>, now: i64) -> rusqlite::Result<Invite> {
    let name = |n: Option<String>| {
        n.as_deref()
            .and_then(crate::hub::people::clean_name)
            .unwrap_or_else(|| PersonName::unchecked("someone"))
    };
    let created_ms: Option<i64> = row.get(3)?;
    let expires_ms: i64 = row.get(4)?;
    let used_ms: Option<i64> = row.get(5)?;
    let revoked_ms: Option<i64> = row.get(6)?;
    let created_by: Option<String> = row.get(7)?;
    let state = match (used_ms, revoked_ms) {
        (Some(_), _) => InviteState::Used,
        (None, Some(_)) => InviteState::Revoked,
        (None, None) if expires_ms <= now => InviteState::Expired,
        (None, None) => InviteState::Open,
    };
    Ok(Invite {
        invite_id: InviteId::unchecked(row.get::<_, String>(0)?),
        person: PersonRef {
            person_id: PersonId::unchecked(row.get::<_, Option<String>>(1)?.unwrap_or_default()),
            name: name(row.get(2)?),
        },
        state,
        created_at: iso_ms(created_ms.unwrap_or(expires_ms - INVITE_TTL_MS)).into(),
        expires_at: iso_ms(expires_ms).into(),
        created_by: match created_by {
            Some(id) => Some(PersonRef {
                person_id: PersonId::unchecked(id),
                name: name(row.get(8)?),
            }),
            None => None,
        },
        used_at: used_ms.map(|ms| iso_ms(ms).into()),
        revoked_at: revoked_ms.map(|ms| iso_ms(ms).into()),
    })
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
    let redeemed = match codes.redeem(&request.code) {
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
    let name = device_name(request.device_name.as_deref(), redeemed.name.clone());
    let grant = Grant {
        role: redeemed.role,
        machines: GrantMachines::All(Star::Value),
    };
    let CreatedKey { key, info } =
        match hub
            .auth
            .create_key_for(&name, &[grant], KeyKind::Human, redeemed.person_id.as_ref())
        {
            Ok(created) => created,
            Err(error) => return store_failed(&error),
        };
    if let (Some(invite_id), Some(person)) = (&redeemed.invite_id, &info.person) {
        use crate::hub::people::tools::{announce, change};
        announce(
            &hub.events,
            hub.clock.as_ref(),
            fleetd_contracts::people::PeopleChangedData {
                invite_id: Some(invite_id.clone()),
                key_id: Some(info.key_id.to_string()),
                ..change(PeopleChange::Joined, person, None)
            },
            format!("{} joined the hub on {name}", person.name),
        );
    }
    if let Err(error) = hub.events.append(NewEvent {
        at: iso_ms(now).into(),
        r#type: HubEventType::KeyPaired,
        machine_id: None,
        project_id: None,
        thread_id: None,
        summary: format!("{name} paired with the hub"),
        data: Some(serde_json::json!({
            "keyId": info.key_id,
            "deviceName": name,
            "personId": info.person.as_ref().map(|p| &p.person_id),
            "inviteId": redeemed.invite_id,
        })),
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
