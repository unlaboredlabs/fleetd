//! Hub links (W104, D194): a Navi on one hub opens and follows work in projects on another.
//!
//! On the hub whose projects it reaches, a person's device mints a link (`hub_link_mint`): a key, `flk_…`, shown once,
//! of which the hub keeps the SHA-256, with the device's grants. The link acts as that device's person, at the lesser
//! of their hub role and the device's grants when it was minted, never above operate ([`link_grants`]), limited to
//! chosen projects or not, and only through `/link/v1` ([`serve`]): read the projects, ask a lead for work, read its
//! status, follow its news.
//! Asks go into chats as "<person> via <label> Navi" (`navi::bridge`, `Asker::Link`). Its person or an admin revokes
//! it (`hub_link_revoke`), and it stops when they leave the hub. A link minted before people acts at its device's
//! grants and stops with its device.
//!
//! On the hub with the Navi, the person adds it to the Navi (`hub_link_add`): the app seals the key to this hub's box
//! key, so it never crosses the app's link in the clear nor sits in a transcript, and the hub opens it only to call the
//! other hub ([`client`]). Removing it there deletes the key and revokes it on the other hub when that answers.
pub mod client;
pub mod serve;
#[cfg(test)]
mod tests;
pub mod tools;

use std::net::IpAddr;

use fleetd_contracts::auth::{AgentKeyInfo, Grant, GrantMachines, Role};
use fleetd_contracts::hub_links::{
    HubLabel, HubLink, HubLinkId, HubLinkState, IssuedLink, LINK_KEY_PREFIX, LinkedHub,
};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::people::PersonRef;
use rusqlite::{OptionalExtension, params};

use crate::hub::api::Hub;
use crate::hub::auth::{base32, secret, sha256};
use crate::hub::store::{HubDb, StoreError, iso_ms, now_ms};

/// How often a link's last use is written, at most.
const LAST_USED_EVERY_MS: i64 = 60_000;
/// A link unused this long expires, revoked at its next use: a link the other hub removed while this one couldn't
/// hear it, or a hub that's gone. A followed link is used at least every `FEED_WAIT_MAX_SEC`.
pub const IDLE_EXPIRY_MS: i64 = 90 * 24 * 60 * 60 * 1000;

fn link_id() -> String {
    format!("hl_{}", base32(&rand::random::<[u8; 5]>()))
}

/// A link minted here, as a request through it sees it: its person and what it may do, read again at each request.
#[derive(Clone, Debug)]
pub struct Issued {
    pub link_id: String,
    pub label: String,
    pub projects: Option<Vec<ProjectRef>>,
    pub person: Option<PersonRef>,
    /// What it may do ([`link_grants`]).
    pub grants: Vec<Grant>,
    /// Its person's name, or its device's for a link from before people.
    pub who: String,
}

impl Issued {
    /// It holds `role` on the machine.
    pub fn allows(&self, role: Role, machine_id: &MachineId) -> bool {
        self.grants.iter().any(|g| {
            g.role >= role
                && match &g.machines {
                    GrantMachines::All(_) => true,
                    GrantMachines::Only(ids) => ids.contains(machine_id),
                }
        })
    }

    /// The project is within its limits.
    pub fn limits(&self, p: &ProjectRef) -> bool {
        self.projects.as_ref().is_none_or(|only| only.contains(p))
    }

    /// Who its asks are from, in the chats here: its person, through their Navi on the hub the link is for.
    pub fn author(&self) -> String {
        format!("{} via {} Navi", self.who, self.label)
    }
}

struct IssuedRow {
    link_id: String,
    prefix: String,
    label: String,
    projects: Option<String>,
    key_id: String,
    device: String,
    person: Option<String>,
    created_ms: i64,
    last_used_ms: Option<i64>,
    revoked_ms: Option<i64>,
    /// The minting device's grants then, as JSON; None for a link minted before they were kept.
    grants: Option<String>,
}

const ISSUED_COLUMNS: &str = "link_id, prefix, label, projects, key_id, device, person, created_ms, last_used_ms, revoked_ms, \
     grants";

impl IssuedRow {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            link_id: row.get(0)?,
            prefix: row.get(1)?,
            label: row.get(2)?,
            projects: row.get(3)?,
            key_id: row.get(4)?,
            device: row.get(5)?,
            person: row.get(6)?,
            created_ms: row.get(7)?,
            last_used_ms: row.get(8)?,
            revoked_ms: row.get(9)?,
            grants: row.get(10)?,
        })
    }

    fn projects(&self) -> Result<Option<Vec<ProjectRef>>, StoreError> {
        Ok(match &self.projects {
            Some(json) => Some(serde_json::from_str(json)?),
            None => None,
        })
    }

    fn person(&self) -> Result<Option<PersonRef>, StoreError> {
        Ok(match &self.person {
            Some(json) => Some(serde_json::from_str(json)?),
            None => None,
        })
    }

    fn info(&self) -> Result<IssuedLink, StoreError> {
        Ok(IssuedLink {
            link_id: HubLinkId::unchecked(self.link_id.clone()),
            label: HubLabel::unchecked(self.label.clone()),
            prefix: self.prefix.clone(),
            projects: self.projects()?,
            key_id: self.key_id.clone(),
            device: self.device.clone(),
            person: self.person()?,
            created_at: Timestamp(iso_ms(self.created_ms)),
            last_used_at: self.last_used_ms.map(|ms| Timestamp(iso_ms(ms))),
            revoked_at: self.revoked_ms.map(|ms| Timestamp(iso_ms(ms))),
        })
    }
}

fn issued_row(db: &HubDb, link_id: &str) -> Result<Option<IssuedRow>, StoreError> {
    db.with(|c| {
        Ok(c.query_row(
            &format!("SELECT {ISSUED_COLUMNS} FROM hub_links_issued WHERE link_id = ?"),
            [link_id],
            IssuedRow::read,
        )
        .optional()?)
    })
}

/// Mints a link acting as `by`, limited to `projects` when given: the link and its key, which is never stored.
pub fn mint(
    hub: &Hub,
    by: &AgentKeyInfo,
    label: &HubLabel,
    projects: Option<&[ProjectRef]>,
) -> Result<(IssuedLink, String), StoreError> {
    let key = secret(LINK_KEY_PREFIX);
    let row = IssuedRow {
        link_id: link_id(),
        prefix: key[..LINK_KEY_PREFIX.len() + 6].to_owned(),
        label: label.to_string(),
        projects: projects.map(serde_json::to_string).transpose()?,
        key_id: by.key_id.to_string(),
        device: by.name.clone(),
        person: by.person.as_ref().map(serde_json::to_string).transpose()?,
        created_ms: now_ms(hub.clock.as_ref()),
        last_used_ms: None,
        revoked_ms: None,
        grants: Some(serde_json::to_string(&by.grants)?),
    };
    hub.db.with(|c| {
        c.execute(
            "INSERT INTO hub_links_issued (link_id, hash, prefix, label, projects, key_id, device, person, created_ms,
             grants) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                row.link_id,
                sha256(&key),
                row.prefix,
                row.label,
                row.projects,
                row.key_id,
                row.device,
                row.person,
                row.created_ms,
                row.grants
            ],
        )?;
        Ok(())
    })?;
    Ok((row.info()?, key))
}

/// Links minted here: every one, or those minted by `key_id` (or its person, on a hub with people), newest first.
pub fn issued(
    db: &HubDb,
    mine: Option<(&str, Option<&PersonRef>)>,
) -> Result<Vec<IssuedLink>, StoreError> {
    let rows = db.with(|c| {
        let mut stmt = c.prepare_cached(&format!(
            "SELECT {ISSUED_COLUMNS} FROM hub_links_issued
             WHERE ?1 OR key_id = ?2 OR (?3 IS NOT NULL AND json_extract(person, '$.personId') = ?3)
             ORDER BY created_ms DESC, link_id LIMIT 500"
        ))?;
        let (all, key_id, person) = match mine {
            None => (true, "", None),
            Some((key_id, person)) => (false, key_id, person.map(|p| p.person_id.as_str())),
        };
        Ok(stmt
            .query_map(params![all, key_id, person], IssuedRow::read)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    rows.iter().map(IssuedRow::info).collect()
}

pub fn issued_get(db: &HubDb, link_id: &str) -> Result<Option<IssuedLink>, StoreError> {
    issued_row(db, link_id)?.map(|r| r.info()).transpose()
}

/// Revokes a link minted here; idempotent, keeping the first time. False for no such link.
pub fn revoke_issued(hub: &Hub, link_id: &str) -> Result<bool, StoreError> {
    let now = now_ms(hub.clock.as_ref());
    hub.db.with(|c| {
        Ok(c.execute(
            "UPDATE hub_links_issued SET revoked_ms = COALESCE(revoked_ms, ?) WHERE link_id = ?",
            params![now, link_id],
        )? > 0)
    })
}

/// Why a link key can't be used: the request goes no further.
pub fn dead(message: impl Into<String>) -> McpToolError {
    McpToolError::new(ErrorCode::Forbidden, message).with_fix(
        "Ask the person to make a new link on this hub and add it to their Navi's Linked hubs.",
    )
}

/// The link a bearer key belongs to, live: not revoked, its device not revoked. Checked at every request, so a
/// revoke stops the next one.
pub fn verify(hub: &Hub, bearer: &str) -> Result<Issued, McpToolError> {
    let key = crate::hub::auth::strip_bearer(bearer);
    let row = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                &format!("SELECT {ISSUED_COLUMNS} FROM hub_links_issued WHERE hash = ?"),
                [sha256(key)],
                IssuedRow::read,
            )
            .optional()?)
        })
        .map_err(failed)?;
    let Some(row) = row.filter(|_| key.starts_with(LINK_KEY_PREFIX)) else {
        return Err(dead("This hub knows no such link key."));
    };
    if row.revoked_ms.is_some() {
        return Err(dead(format!(
            "The link {} was revoked on this hub.",
            row.prefix
        )));
    }
    let now = now_ms(hub.clock.as_ref());
    if now - row.last_used_ms.unwrap_or(row.created_ms) >= IDLE_EXPIRY_MS {
        revoke_issued(hub, &row.link_id).map_err(failed)?;
        return Err(dead(format!(
            "The link {} went unused for 90 days and expired on this hub.",
            row.prefix
        )));
    }
    // The person who made it: as stored at minting, or its device's for a link minted before people.
    let person_id = match row.person().map_err(failed)? {
        Some(p) => Some(p.person_id),
        None => hub
            .auth
            .get(&row.key_id)
            .map_err(failed)?
            .and_then(|d| d.person)
            .map(|p| p.person_id),
    };
    let (person, grants, who) = match person_id {
        Some(id) => {
            let people = crate::hub::people::People::new(hub.db.clone(), hub.clock.clone());
            let Some(someone) = people
                .get(&id)
                .map_err(failed)?
                .filter(|p| p.removed_at.is_none())
            else {
                return Err(dead(format!(
                    "The person who made link {} was removed from this hub, and the link with them.",
                    row.prefix
                )));
            };
            // The device's grants at minting; a link from before they were kept reads its device's now.
            let minted: Vec<Grant> = match &row.grants {
                Some(json) => serde_json::from_str(json).map_err(|e| failed(e.into()))?,
                None => hub
                    .auth
                    .get(&row.key_id)
                    .map_err(failed)?
                    .map(|d| d.grants)
                    .unwrap_or_default(),
            };
            let cap = crate::hub::people::role_cap(someone.role);
            (
                Some(someone.as_ref()),
                link_grants(&minted, cap),
                someone.name.to_string(),
            )
        }
        // No person behind it: its device's grants, and it dies with its device.
        None => {
            let device = hub.auth.get(&row.key_id).map_err(failed)?;
            let Some(device) = device.filter(|d| d.revoked_at.is_none()) else {
                return Err(dead(format!(
                    "The device that made link {} was revoked on this hub, and the link with it.",
                    row.prefix
                )));
            };
            (
                None,
                link_grants(&device.grants, Role::Operate),
                device.name,
            )
        }
    };
    if row
        .last_used_ms
        .is_none_or(|last| now - last >= LAST_USED_EVERY_MS)
    {
        hub.db
            .with(|c| {
                c.execute(
                    "UPDATE hub_links_issued SET last_used_ms = ? WHERE link_id = ?",
                    params![now, row.link_id],
                )?;
                Ok(())
            })
            .map_err(failed)?;
    }
    Ok(Issued {
        projects: row.projects().map_err(failed)?,
        person,
        grants,
        who,
        link_id: row.link_id,
        label: row.label,
    })
}

/// What a link may do: the minting device's grants, none above its person's role cap (`cap`), and none above
/// operate, since nothing a link calls needs more.
pub fn link_grants(device: &[Grant], cap: Role) -> Vec<Grant> {
    crate::hub::people::capped(device, cap.min(Role::Operate))
}

pub fn failed(e: StoreError) -> McpToolError {
    tracing::error!(error = %e, "hub links store");
    McpToolError::new(ErrorCode::Failed, "The hub failed to answer that request.")
}

/// A link this hub keeps for one of its Navis, its key still sealed.
#[derive(Clone, Debug)]
pub struct Kept {
    pub link_id: String,
    pub navi: ProjectRef,
    pub label: String,
    pub url: String,
    pub sealed: Vec<u8>,
    pub cursor: i64,
    pub state: HubLinkState,
    pub error: Option<String>,
    pub checked_ms: Option<i64>,
    pub created_ms: i64,
}

const KEPT_COLUMNS: &str = "link_id, machine_id, project_id, label, url, sealed, cursor, state, error, checked_ms, created_ms";

fn state_str(s: HubLinkState) -> &'static str {
    match s {
        HubLinkState::Ok => "ok",
        HubLinkState::Unreachable => "unreachable",
        HubLinkState::Revoked => "revoked",
    }
}

impl Kept {
    fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        let state: String = row.get(7)?;
        Ok(Self {
            link_id: row.get(0)?,
            navi: ProjectRef {
                machine_id: MachineId::unchecked(row.get::<_, String>(1)?),
                project_id: ProjectId::unchecked(row.get::<_, String>(2)?),
            },
            label: row.get(3)?,
            url: row.get(4)?,
            sealed: row.get(5)?,
            cursor: row.get(6)?,
            state: match state.as_str() {
                "unreachable" => HubLinkState::Unreachable,
                "revoked" => HubLinkState::Revoked,
                _ => HubLinkState::Ok,
            },
            error: row.get(8)?,
            checked_ms: row.get(9)?,
            created_ms: row.get(10)?,
        })
    }

    pub fn info(&self) -> HubLink {
        HubLink {
            link_id: HubLinkId::unchecked(self.link_id.clone()),
            navi: self.navi.clone(),
            label: HubLabel::unchecked(self.label.clone()),
            url: self.url.clone(),
            state: self.state,
            error: self.error.clone(),
            checked_at: self.checked_ms.map(|ms| Timestamp(iso_ms(ms))),
            created_at: Timestamp(iso_ms(self.created_ms)),
        }
    }
}

/// The links a Navi keeps, by label; every Navi's without one.
pub fn kept(db: &HubDb, navi: Option<&ProjectRef>) -> Result<Vec<Kept>, StoreError> {
    db.with(|c| {
        let rows = match navi {
            Some(r) => c
                .prepare_cached(&format!(
                    "SELECT {KEPT_COLUMNS} FROM hub_links WHERE machine_id = ? AND project_id = ? ORDER BY label"
                ))?
                .query_map(
                    params![r.machine_id.as_str(), r.project_id.as_str()],
                    Kept::read,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            None => c
                .prepare_cached(&format!(
                    "SELECT {KEPT_COLUMNS} FROM hub_links ORDER BY created_ms"
                ))?
                .query_map([], Kept::read)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        };
        Ok(rows)
    })
}

pub fn kept_get(db: &HubDb, link_id: &str) -> Result<Option<Kept>, StoreError> {
    db.with(|c| {
        Ok(c.query_row(
            &format!("SELECT {KEPT_COLUMNS} FROM hub_links WHERE link_id = ?"),
            [link_id],
            Kept::read,
        )
        .optional()?)
    })
}

/// A Navi's links as `factory_status` lists them.
pub fn linked(db: &HubDb, navi: &ProjectRef) -> Result<Vec<LinkedHub>, StoreError> {
    Ok(kept(db, Some(navi))?
        .into_iter()
        .map(|k| LinkedHub {
            label: HubLabel::unchecked(k.label),
            state: k.state,
            error: k.error,
        })
        .collect())
}

/// Adds a link to a Navi: its id. Refused (`None`) when the Navi has one by that label already.
pub fn keep(
    hub: &Hub,
    navi: &ProjectRef,
    label: &HubLabel,
    url: &str,
    sealed: &[u8],
    cursor: i64,
) -> Result<Option<String>, StoreError> {
    let id = link_id();
    let now = now_ms(hub.clock.as_ref());
    hub.db.with(|c| {
        let added = c.execute(
            "INSERT OR IGNORE INTO hub_links (link_id, machine_id, project_id, label, url, sealed, cursor, state,
             checked_ms, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', ?, ?)",
            params![
                id,
                navi.machine_id.as_str(),
                navi.project_id.as_str(),
                label.as_str(),
                url,
                sealed,
                cursor,
                now,
                now
            ],
        )?;
        Ok((added > 0).then_some(id))
    })
}

/// Deletes a kept link, its key with it: false for no such link.
pub fn forget(db: &HubDb, link_id: &str) -> Result<bool, StoreError> {
    db.with(|c| Ok(c.execute("DELETE FROM hub_links WHERE link_id = ?", [link_id])? > 0))
}

/// Records how the last call over a kept link went.
pub fn set_state(
    hub: &Hub,
    link_id: &str,
    state: HubLinkState,
    error: Option<&str>,
) -> Result<(), StoreError> {
    let now = now_ms(hub.clock.as_ref());
    hub.db.with(|c| {
        c.execute(
            "UPDATE hub_links SET state = ?, error = ?, checked_ms = ? WHERE link_id = ? AND state != 'revoked'",
            params![state_str(state), error, now, link_id],
        )?;
        Ok(())
    })
}

pub fn set_cursor(db: &HubDb, link_id: &str, cursor: i64) -> Result<(), StoreError> {
    db.with(|c| {
        c.execute(
            "UPDATE hub_links SET cursor = ? WHERE link_id = ?",
            params![cursor, link_id],
        )?;
        Ok(())
    })
}

/// The hub's own X25519 box key, in its home: what the app seals link keys to.
pub fn box_key(hub: &Hub) -> std::io::Result<crate::node::identity::NodeBoxKey> {
    crate::node::identity::load_or_create_box_key(&hub.config.home)
}

/// A link key travels only where nobody else reads it: HTTPS, or plain HTTP to this machine or over a tailnet
/// (Tailscale's 100.64.0.0/10, fd7a:115c:a1e0::/48 and *.ts.net names), which encrypts it.
pub fn check_url(url: &str) -> Result<url::Url, McpToolError> {
    let bad = |why: String| {
        McpToolError::new(ErrorCode::Invalid, why).with_fix(
            "Use the other hub's URL as the app pairs with it: https://…, or http:// over a tailnet.",
        )
    };
    let parsed = url::Url::parse(url.trim()).map_err(|e| bad(format!("{url} is no URL: {e}.")))?;
    let host = match parsed.host() {
        Some(url::Host::Domain(d)) => Host::Name(d.to_ascii_lowercase()),
        Some(url::Host::Ipv4(ip)) => Host::Ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => Host::Ip(IpAddr::V6(ip)),
        None => return Err(bad(format!("{url} names no host."))),
    };
    let private = match &host {
        Host::Name(n) => n == "localhost" || n.ends_with(".ts.net"),
        Host::Ip(IpAddr::V4(ip)) => {
            ip.is_loopback() || (ip.octets()[0] == 100 && (ip.octets()[1] & 0xc0) == 64)
        }
        Host::Ip(IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0]
        }
    };
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if private => Ok(parsed),
        "http" => Err(bad(format!(
            "{url} is plain HTTP off a tailnet: the link key would cross the network in the clear."
        ))),
        other => Err(bad(format!("{other}: is not http or https."))),
    }
}

enum Host {
    Name(String),
    Ip(IpAddr),
}
