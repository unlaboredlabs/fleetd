//! Agent and human keys, grants, node enrollment tokens and node keys.
//!
//! Device pairing tokens (`flp_`, `fleetd hub device add`) belonged to a client that no longer exists and are
//! gone; their table still comes from the migrations so an older hub's database opens unchanged.
#[cfg(test)]
mod tests;

use crate::clock::Clock;
use crate::hub::store::{HubDb, StoreError, iso_ms, now_ms};
use fleetd_contracts::auth::{
    AgentKeyInfo, AgentKeyPrefix, Grant, GrantMachines, KeyKind, Role, Star,
};
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::prim::Text;
use rusqlite::{OptionalExtension, named_params, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;

const CREATE_KEY_FIX: &str =
    "create a key with `fleetd hub key create --name <name> --role <role> --machines '*'`";
const KEY_PREFIX: &str = "fld_";
const ENROLL_PREFIX: &str = "fle_";
const LAST_USED_EVERY_MS: i64 = 60_000;
const ENROLL_TTL_MS: i64 = 15 * 60_000;
/// Where pre-release `fleetd steer`, `chat` and `project stop` kept the hub machine owner's human key ([`Auth::retire_owner_keys`]).
pub const RETIRED_OWNER_KEY_FILE: &str = "owner.key";
const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// Shaped like the MCP error result so transports can pass it through.
#[derive(Debug, Clone, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct Unauthorized {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error(transparent)]
    Unauthorized(#[from] Unauthorized),
    #[error("no agent key {key_id}; run `fleetd hub key list` to see key ids")]
    KeyNotFound { key_id: String },
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl From<rusqlite::Error> for AuthError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Store(e.into())
    }
}

/// `key` is shown once and never stored; the hub keeps its sha256.
#[derive(Debug, Clone)]
pub struct CreatedKey {
    pub key: String,
    pub info: AgentKeyInfo,
}

#[derive(Debug, Clone)]
pub struct EnrollToken {
    pub token: String,
    pub expires_at: String,
}

/// RFC 4648 base32, lowercase, unpadded.
pub(crate) fn base32(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5 + 1);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            out.push(BASE32[((buffer >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        buffer &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(BASE32[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub(crate) fn secret(prefix: &str) -> String {
    format!("{prefix}{}", base32(&rand::random::<[u8; 32]>()))
}

pub(crate) fn sha256(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `^fld_[a-z2-7]{52}$`
fn is_agent_key(key: &str) -> bool {
    key.strip_prefix(KEY_PREFIX)
        .is_some_and(|body| body.len() == 52 && body.bytes().all(|b| BASE32.contains(&b)))
}

/// Drops a leading `Bearer ` (any case, any whitespace run), then trims.
pub(crate) fn strip_bearer(bearer: &str) -> &str {
    let rest = match bearer.get(..6) {
        Some(scheme) if scheme.eq_ignore_ascii_case("bearer") => {
            let after = &bearer[6..];
            let stripped = after.trim_start();
            if stripped.len() < after.len() {
                stripped
            } else {
                bearer
            }
        }
        _ => bearer,
    };
    rest.trim()
}

fn rank(role: Role) -> u8 {
    match role {
        Role::Read => 0,
        Role::Operate => 1,
        Role::Admin => 2,
    }
}

struct KeyRow {
    key_id: String,
    name: String,
    kind: String,
    prefix: String,
    grants: String,
    created_ms: i64,
    last_used_ms: Option<i64>,
    revoked_ms: Option<i64>,
}

const KEY_COLUMNS: &str =
    "key_id, name, kind, prefix, grants, created_ms, last_used_ms, revoked_ms";

impl KeyRow {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            key_id: row.get(0)?,
            name: row.get(1)?,
            kind: row.get(2)?,
            prefix: row.get(3)?,
            grants: row.get(4)?,
            created_ms: row.get(5)?,
            last_used_ms: row.get(6)?,
            revoked_ms: row.get(7)?,
        })
    }

    fn info(&self) -> Result<AgentKeyInfo, StoreError> {
        Ok(AgentKeyInfo {
            key_id: Text::unchecked(self.key_id.clone()),
            name: self.name.clone(),
            kind: (self.kind == "human").then_some(KeyKind::Human),
            prefix: AgentKeyPrefix::unchecked(self.prefix.clone()),
            grants: serde_json::from_str(&self.grants)?,
            created_at: iso_ms(self.created_ms).into(),
            last_used_at: self.last_used_ms.map(|ms| iso_ms(ms).into()),
            revoked_at: self.revoked_ms.map(|ms| iso_ms(ms).into()),
            person: None,
        })
    }
}

/// Whether some grant gives at least `role` on `machine_id`. Without a machine (fleet-wide reads), any grant of that
/// role is enough; the caller then filters results per machine.
pub fn allows(info: &AgentKeyInfo, role: Role, machine_id: Option<&MachineId>) -> bool {
    info.revoked_at.is_none()
        && info.grants.iter().any(|grant| {
            rank(grant.role) >= rank(role)
                && match (machine_id, &grant.machines) {
                    (None, _) | (_, GrantMachines::All(_)) => true,
                    (Some(id), GrantMachines::Only(ids)) => ids.contains(id),
                }
        })
}

pub struct Auth {
    db: Arc<HubDb>,
    clock: Arc<dyn Clock>,
}

impl Auth {
    pub fn new(db: Arc<HubDb>, clock: Arc<dyn Clock>) -> Self {
        Self { db, clock }
    }

    fn now(&self) -> i64 {
        now_ms(self.clock.as_ref())
    }

    pub fn create_key(
        &self,
        name: &str,
        grants: &[Grant],
        kind: KeyKind,
    ) -> Result<CreatedKey, StoreError> {
        let now = self.now();
        let key = secret(KEY_PREFIX);
        let row = KeyRow {
            key_id: format!("key_{}", base32(&rand::random::<[u8; 5]>())),
            name: name.to_owned(),
            kind: if kind == KeyKind::Human {
                "human"
            } else {
                "agent"
            }
            .to_owned(),
            prefix: key[..KEY_PREFIX.len() + 6].to_owned(),
            grants: serde_json::to_string(grants)?,
            created_ms: now,
            last_used_ms: None,
            revoked_ms: None,
        };
        self.db.with(|conn| {
            conn.prepare_cached(
                "INSERT INTO agent_keys (key_id, hash, prefix, name, grants, created_ms, kind) VALUES ($key_id, $hash, $prefix, $name, $grants, $created_ms, $kind)",
            )?
            .execute(named_params! {
                "$key_id": row.key_id,
                "$hash": sha256(&key),
                "$prefix": row.prefix,
                "$name": row.name,
                "$grants": row.grants,
                "$created_ms": row.created_ms,
                "$kind": row.kind,
            })?;
            Ok(())
        })?;
        Ok(CreatedKey {
            info: row.info()?,
            key,
        })
    }

    /// Accepts `fld_…` or `Bearer fld_…`. Revocation is seen on the next call.
    pub fn verify(&self, bearer: &str) -> Result<AgentKeyInfo, AuthError> {
        let key = strip_bearer(bearer);
        if !is_agent_key(key) {
            return Err(Unauthorized {
                code: ErrorCode::Invalid,
                message: "expected an agent key: `Authorization: Bearer fld_…`".into(),
                fix: Some(CREATE_KEY_FIX.into()),
            }
            .into());
        }
        let row = self.db.with(|conn| {
            Ok(conn
                .prepare_cached(&format!(
                    "SELECT {KEY_COLUMNS} FROM agent_keys WHERE hash = ?"
                ))?
                .query_row([sha256(key)], KeyRow::read)
                .optional()?)
        })?;
        let forbidden = |message: String| Unauthorized {
            code: ErrorCode::Forbidden,
            message,
            fix: Some(CREATE_KEY_FIX.into()),
        };
        let Some(mut row) = row else {
            return Err(forbidden("unknown agent key".into()).into());
        };
        if row.revoked_ms.is_some() {
            return Err(forbidden(format!("agent key {} was revoked", row.prefix)).into());
        }
        let now = self.now();
        if row
            .last_used_ms
            .is_none_or(|last| now - last >= LAST_USED_EVERY_MS)
        {
            self.db.with(|conn| {
                conn.prepare_cached("UPDATE agent_keys SET last_used_ms = ? WHERE key_id = ?")?
                    .execute(params![now, row.key_id])?;
                Ok(())
            })?;
            row.last_used_ms = Some(now);
        }
        Ok(row.info()?)
    }

    /// Idempotent: revoking a revoked key keeps its first `revokedAt`.
    pub fn revoke(&self, key_id: &str) -> Result<(), AuthError> {
        let now = self.now();
        let changed = self.db.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "UPDATE agent_keys SET revoked_ms = COALESCE(revoked_ms, ?) WHERE key_id = ?",
                )?
                .execute(params![now, key_id])?)
        })?;
        if changed == 0 {
            return Err(AuthError::KeyNotFound {
                key_id: key_id.to_owned(),
            });
        }
        Ok(())
    }

    /// Retires the owner key pre-release CLIs minted on first use: a human key named "owner", admin on every machine,
    /// kept in `<hub home>/owner.key`, where any process of the hub's OS user could read it, agents included. Revokes
    /// the key in that file and every key minted that way, then deletes the file. Runs at each start, so a copy taken
    /// before the upgrade stops working too. Returns how many keys it revoked.
    pub fn retire_owner_keys(&self, home: &Path) -> Result<usize, StoreError> {
        let file = home.join(RETIRED_OWNER_KEY_FILE);
        let in_file = std::fs::read_to_string(&file)
            .ok()
            .map(|key| sha256(key.trim()));
        let minted = serde_json::to_string(&[Grant {
            role: Role::Admin,
            machines: GrantMachines::All(Star::Value),
        }])?;
        let now = self.now();
        let revoked = self.db.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "UPDATE agent_keys SET revoked_ms = ? WHERE revoked_ms IS NULL \
                     AND (hash = ? OR (name = 'owner' AND kind = 'human' AND grants = ?))",
                )?
                .execute(params![now, in_file, minted])?)
        })?;
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            // The key in it is revoked already; the next start tries again.
            Err(error) => tracing::warn!("cannot delete {}: {error}", file.display()),
        }
        Ok(revoked)
    }

    /// One key by its id, revoked or not.
    pub fn get(&self, key_id: &str) -> Result<Option<AgentKeyInfo>, StoreError> {
        let row = self.db.with(|conn| {
            Ok(conn
                .prepare_cached(&format!(
                    "SELECT {KEY_COLUMNS} FROM agent_keys WHERE key_id = ?"
                ))?
                .query_row([key_id], KeyRow::read)
                .optional()?)
        })?;
        row.as_ref().map(KeyRow::info).transpose()
    }

    pub fn list(&self) -> Result<Vec<AgentKeyInfo>, StoreError> {
        let rows = self.db.with(|conn| {
            let mut stmt = conn.prepare_cached(&format!(
                "SELECT {KEY_COLUMNS} FROM agent_keys ORDER BY created_ms, key_id"
            ))?;
            let rows = stmt
                .query_map([], KeyRow::read)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        rows.iter().map(KeyRow::info).collect()
    }

    /// One-time, valid for 15 minutes.
    pub fn create_enroll_token(&self, machine_id: &MachineId) -> Result<EnrollToken, StoreError> {
        let expires = self.now() + ENROLL_TTL_MS;
        let token = secret(ENROLL_PREFIX);
        self.db.with(|conn| {
            conn.prepare_cached(
                "INSERT INTO enroll_tokens (hash, machine_id, expires_ms) VALUES (?, ?, ?)",
            )?
            .execute(params![sha256(&token), machine_id.as_str(), expires])?;
            Ok(())
        })?;
        Ok(EnrollToken {
            token,
            expires_at: iso_ms(expires),
        })
    }

    /// Burns the token and records `pub_key` as the machine's node key.
    pub fn consume_enroll_token(
        &self,
        token: &str,
        machine_id: &MachineId,
        pub_key: &str,
    ) -> Result<(), AuthError> {
        let now = self.now();
        let hash = sha256(token);
        let burned = self.db.transaction(|conn| {
            // One statement, so two nodes racing on one token cannot both win.
            let changed = conn
                .prepare_cached(
                    "UPDATE enroll_tokens SET used_ms = $now WHERE hash = $hash AND machine_id = $machine AND used_ms IS NULL AND expires_ms > $now",
                )?
                .execute(named_params! { "$now": now, "$hash": hash, "$machine": machine_id.as_str() })?;
            if changed == 0 {
                return Ok(false);
            }
            conn.prepare_cached(
                "INSERT INTO node_keys (machine_id, pub_key) VALUES (?, ?) ON CONFLICT (machine_id) DO UPDATE SET pub_key = excluded.pub_key",
            )?
            .execute(params![machine_id.as_str(), pub_key])?;
            Ok(true)
        })?;
        if burned {
            return Ok(());
        }
        let row: Option<(String, i64, Option<i64>)> = self.db.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "SELECT machine_id, expires_ms, used_ms FROM enroll_tokens WHERE hash = ?",
                )?
                .query_row([&hash], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .optional()?)
        })?;
        let why = match row {
            None => "unknown enrollment token".to_owned(),
            Some((_, _, Some(_))) => "enrollment token was already used".to_owned(),
            Some((_, expires, None)) if expires <= now => "enrollment token expired".to_owned(),
            Some((machine, _, None)) => format!(
                "enrollment token is for machine {machine}, not {}",
                machine_id.as_str()
            ),
        };
        Err(Unauthorized {
            code: ErrorCode::Forbidden,
            message: why,
            fix: Some(format!(
                "on the hub, run `fleetd pair --worker {}` and run the command it prints within 15 minutes",
                machine_id.as_str()
            )),
        }
        .into())
    }

    pub fn node_pub_key(&self, machine_id: &MachineId) -> Result<Option<String>, StoreError> {
        self.db.with(|conn| {
            Ok(conn
                .prepare_cached("SELECT pub_key FROM node_keys WHERE machine_id = ?")?
                .query_row([&machine_id.as_str()], |row| row.get(0))
                .optional()?)
        })
    }

    /// Forgets the machine's node key, so its node is refused from its next link on; false if it had none.
    pub fn revoke_node(&self, machine_id: &MachineId) -> Result<bool, StoreError> {
        self.db.with(|conn| {
            Ok(conn
                .prepare_cached("DELETE FROM node_keys WHERE machine_id = ?")?
                .execute([&machine_id.as_str()])?
                > 0)
        })
    }
}
