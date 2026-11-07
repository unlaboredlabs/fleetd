//! The agents' Mac's setup code (D309): Add machine › A Mac for agents shows six digits, and the fleetd app on the Mac
//! trades them at `POST /pair/mac` for a one-time enroll token of the hub's agents' Mac, so nobody pastes a line. A
//! code is a row of pair_codes with `machine_id` set, so it is listed and pruned with the others; it lives 10 minutes,
//! works once, and a new one revokes any still open, so there is one open code at a time. `fleetd pair --worker-codes`
//! lists it beside the worker codes, and `--worker-revoke` takes it back.
//!
//! Six digits are few: beside the per-address limit /pair has, every wrong code counts against one hub-wide budget of
//! [`MAX_GLOBAL_FAILURES`] a minute, so a code's 10 minutes allow at most 100 of its million guesses from anywhere.
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::pair::{MacCodeRequest, MacCodeResponse, PairErrorCode};
use rand::Rng;
use rusqlite::{OptionalExtension, named_params, params};
use std::net::IpAddr;

use super::{Limiter, MintedCode, PairCodes, RedeemError, hash, pair_error, store_failed};
use crate::hub::api::Hub;
use crate::hub::store::{StoreError, iso_ms, now_ms};
use axum::http::StatusCode;

pub const MAC_CODE_TTL_MS: i64 = 10 * 60_000;
/// Wrong Mac codes a minute from every address together.
pub const MAX_GLOBAL_FAILURES: usize = 10;
const DIGITS: usize = 6;
/// A listed code's id: as long as a worker code's, so `--worker-revoke` takes either.
const ID_LEN: usize = crate::hub::auth::ENROLL_CODE_ID_LEN;
/// The machine id of a hub's first agents' Mac.
pub const FIRST_MAC: &str = "mac";
const NEW_CODE_FIX: &str =
    "On your main machine, open Add machine › A Mac for agents for a new code, then type it here.";

/// Six random digits.
pub fn new_mac_code() -> String {
    format!("{:06}", rand::thread_rng().gen_range(0..1_000_000u32))
}

/// The code's six digits, typed with spaces or a hyphen between them or not. None when it can't be one.
pub fn normalize_mac(input: &str) -> Option<String> {
    let digits: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    (digits.len() == DIGITS && digits.bytes().all(|b| b.is_ascii_digit())).then_some(digits)
}

/// Its own namespace: a Mac code's hash never meets a pairing code's.
fn mac_hash(canon: &str) -> String {
    hash(&format!("mac {canon}"))
}

impl PairCodes {
    /// A new setup code for the agents' Mac `machine`: any Mac code still open is revoked first, so a person has one
    /// at a time.
    pub fn create_mac(&self, machine: &MachineId) -> Result<MintedCode, StoreError> {
        let now = now_ms(self.clock.as_ref());
        let expires = now + MAC_CODE_TTL_MS;
        let code = new_mac_code();
        let hash = mac_hash(&code);
        self.db.transaction(|conn| {
            conn.prepare_cached(
                "UPDATE pair_codes SET revoked_ms = ?1 WHERE machine_id IS NOT NULL AND used_ms IS NULL \
                 AND revoked_ms IS NULL AND expires_ms > ?1",
            )?
            .execute([now])?;
            // Every other code of these digits is spent now: the old row of a code drawn again makes way.
            conn.prepare_cached("DELETE FROM pair_codes WHERE hash = ?")?
                .execute([&hash])?;
            conn.prepare_cached(
                "INSERT INTO pair_codes (hash, name, expires_ms, role, created_ms, machine_id) VALUES (?, NULL, ?, 'read', ?, ?)",
            )?
            .execute(params![hash, expires, now, machine.as_str()])?;
            Ok(())
        })?;
        Ok(MintedCode {
            code,
            expires_at: iso_ms(expires),
        })
    }

    /// Burns the Mac code once `check` accepts the machine it is for; returns that machine. A code `check` refuses
    /// stays open, so the person can fix what it says and type the same code again.
    pub fn redeem_mac<E>(
        &self,
        code: &str,
        check: impl FnOnce(&MachineId) -> Result<(), E>,
    ) -> Result<Result<MachineId, E>, RedeemError> {
        let Some(canon) = normalize_mac(code) else {
            return Err(RedeemError::Invalid);
        };
        let now = now_ms(self.clock.as_ref());
        let hash = mac_hash(&canon);
        let row: Option<(String, i64, Option<i64>, Option<i64>)> = self.db.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "SELECT machine_id, expires_ms, used_ms, revoked_ms FROM pair_codes WHERE hash = ? AND machine_id IS NOT NULL",
                )?
                .query_row([&hash], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
                .optional()?)
        })?;
        let machine = match row {
            Some((machine, expires, None, None)) if expires > now => MachineId::unchecked(machine),
            Some((_, _, None, None)) => return Err(RedeemError::Expired),
            _ => return Err(RedeemError::Invalid),
        };
        if let Err(refused) = check(&machine) {
            return Ok(Err(refused));
        }
        // One statement, so two Macs racing on one code cannot both win.
        let burned = self.db.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "UPDATE pair_codes SET used_ms = $now WHERE hash = $hash AND machine_id IS NOT NULL AND used_ms IS NULL \
                     AND revoked_ms IS NULL AND expires_ms > $now",
                )?
                .execute(named_params! { "$now": now, "$hash": hash })?)
        })?;
        match burned {
            1 => Ok(Ok(machine)),
            _ => Err(RedeemError::Invalid),
        }
    }
}

/// An open Mac setup code as `fleetd pair --worker-codes` lists it: never the code itself.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenMacCode {
    /// The start of its hash, as long as a worker code's id: what `--worker-revoke` takes.
    pub id: String,
    pub machine_id: MachineId,
    /// RFC 3339.
    pub created_at: String,
    /// RFC 3339.
    pub expires_at: String,
}

impl PairCodes {
    /// The open Mac setup code, if there is one: there is one at a time.
    pub fn open_mac(&self) -> Result<Option<OpenMacCode>, StoreError> {
        let now = now_ms(self.clock.as_ref());
        self.db.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "SELECT substr(hash, 1, ?1), machine_id, created_ms, expires_ms FROM pair_codes WHERE machine_id IS NOT NULL \
                     AND used_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?2 ORDER BY created_ms DESC LIMIT 1",
                )?
                .query_row(params![ID_LEN as i64, now], |row| {
                    let expires: i64 = row.get(3)?;
                    Ok(OpenMacCode {
                        id: row.get(0)?,
                        machine_id: MachineId::unchecked(row.get::<_, String>(1)?),
                        created_at: iso_ms(row.get::<_, Option<i64>>(2)?.unwrap_or(expires - MAC_CODE_TTL_MS)),
                        expires_at: iso_ms(expires),
                    })
                })
                .optional()?)
        })
    }

    /// Takes back the open Mac setup code `id` names; the machine it was for, or None when there is no such code.
    pub fn revoke_mac(&self, id: &str) -> Result<Option<MachineId>, StoreError> {
        let now = now_ms(self.clock.as_ref());
        self.db.with(|conn| {
            Ok(conn
                .prepare_cached(
                    "UPDATE pair_codes SET revoked_ms = ?3 WHERE substr(hash, 1, ?1) = ?2 AND length(?2) = ?1 \
                     AND machine_id IS NOT NULL AND used_ms IS NULL AND revoked_ms IS NULL AND expires_ms > ?3 \
                     RETURNING machine_id",
                )?
                .query_row(params![ID_LEN as i64, id, now], |row| row.get::<_, String>(0))
                .optional()?
                .map(MachineId::unchecked))
        })
    }
}

/// The machine a new Mac code is for: the hub's agents' Mac (the first by id, should there be two), else
/// [`FIRST_MAC`], else `agents-mac` when a machine that isn't the Mac has that name.
pub fn mac_machine_id(hub: &Hub) -> Result<MachineId, StoreError> {
    let mut machines = hub.store.machines_list()?;
    machines.sort_by(|a, b| a.machine_id.as_str().cmp(b.machine_id.as_str()));
    if let Some(mac) = machines.iter().find(|m| m.agents_mac == Some(true)) {
        return Ok(mac.machine_id.clone());
    }
    let taken = machines.iter().any(|m| m.machine_id.as_str() == FIRST_MAC);
    Ok(MachineId::unchecked(if taken {
        "agents-mac"
    } else {
        FIRST_MAC
    }))
}

/// `POST /pair/mac`: the status and JSON body to answer with. `limiter` is /pair's per-address one; `global` counts
/// every address's wrong Mac codes together.
pub fn handle(
    hub: &Hub,
    limiter: &Limiter,
    global: &Limiter,
    remote: Option<IpAddr>,
    host_header: Option<&str>,
    body: &[u8],
) -> (StatusCode, serde_json::Value) {
    let now = now_ms(hub.clock.as_ref());
    if limiter.blocked(remote, now) || global.blocked_over(None, now, MAX_GLOBAL_FAILURES) {
        return pair_error(
            StatusCode::TOO_MANY_REQUESTS,
            PairErrorCode::PairRateLimited,
            "too many wrong setup codes",
            "Wait a minute, then type the code again.",
        );
    }
    let request: MacCodeRequest = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(error) => {
            return pair_error(
                StatusCode::BAD_REQUEST,
                PairErrorCode::Invalid,
                &format!("expected {{\"code\": \"123456\"}}: {error}"),
                "Send the 6-digit code from Add machine › A Mac for agents as JSON.",
            );
        }
    };
    let codes = PairCodes::new(hub.db.clone(), hub.clock.clone());
    // A code for an agents' Mac that is another computer would enroll nothing (Auth::enroll_node refuses it): said
    // now, before the code is spent.
    enum Refused {
        OtherComputer,
        Store(StoreError),
    }
    let other_computer = |machine: &MachineId| match (
        &request.fingerprint,
        hub.auth.node_fingerprint(machine).map_err(Refused::Store)?,
    ) {
        (Some(ours), Some(theirs)) if *ours != theirs => Err(Refused::OtherComputer),
        _ => Ok(()),
    };
    let machine = match codes.redeem_mac(&request.code, other_computer) {
        Ok(Ok(machine)) => machine,
        Ok(Err(Refused::OtherComputer)) => {
            return pair_error(
                StatusCode::CONFLICT,
                PairErrorCode::MacOtherComputer,
                "this hub's agents' Mac is another computer",
                "To make this Mac the agents' Mac instead, remove the old one on your main machine (Settings › Hub › \
                 Machines › the Mac › Remove), then type this code again.",
            );
        }
        Ok(Err(Refused::Store(error))) | Err(RedeemError::Store(error)) => {
            return store_failed(&error);
        }
        Err(error @ (RedeemError::Invalid | RedeemError::Expired)) => {
            limiter.failed(remote, now);
            global.failed(None, now);
            let (code, message) = match error {
                RedeemError::Expired => (PairErrorCode::PairCodeExpired, "that code expired"),
                _ => (
                    PairErrorCode::PairCodeInvalid,
                    "that code isn't open on this hub",
                ),
            };
            return pair_error(StatusCode::UNAUTHORIZED, code, message, NEW_CODE_FIX);
        }
    };
    let existing = match hub.store.machine_get(&machine) {
        Ok(found) => found.is_some(),
        Err(error) => return store_failed(&error),
    };
    let token = match hub
        .auth
        .create_enroll_token(&machine, "POST /pair/mac (the agents' Mac's setup code)")
    {
        Ok(token) => token,
        Err(error) => return store_failed(&error),
    };
    tracing::info!("the agents' Mac {machine} traded its setup code");
    let response = MacCodeResponse {
        hub_url: super::hub_url(hub, host_header),
        hub_name: crate::hub::link::server::hub_id(),
        machine_id: machine.as_str().to_owned(),
        token: token.token,
        expires_at: token.expires_at,
        version: crate::version().to_owned(),
        existing,
    };
    (
        StatusCode::OK,
        serde_json::to_value(response).expect("a Mac code response serializes"),
    )
}
