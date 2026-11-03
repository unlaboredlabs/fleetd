//! A person's time zone, so a lead reads each of their messages with the time where they are, and a schedule it makes
//! runs on their clock (D288). The zone is the one their app or phone last sent with a chat message (`people.tz`);
//! a hub that has none for them uses its `policy.tz` decision, else the hub machine's zone, and says which.
use chrono::TimeZone as _;
use chrono_tz::Tz;
use fleetd_contracts::chat::{ChatAuthor, ChatMessage};
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::DecisionScope;
use fleetd_contracts::people::PersonId;
use fleetd_contracts::wakes::TimeZone;
use rusqlite::{Connection, OptionalExtension, params};

use crate::hub::attention::{POLICY_TZ_KEY, hub_zone, zone};
use crate::hub::ledger::repo::{DecisionFilter, list_decisions};
use crate::hub::store::{HubDb, StoreError};

/// Where a zone came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Their own device sent it.
    Device,
    /// The hub's `policy.tz` decision.
    Policy,
    /// The hub machine's own zone.
    Hub,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Zone {
    pub tz: Tz,
    pub source: Source,
}

impl Zone {
    pub fn name(&self) -> &'static str {
        self.tz.name()
    }

    /// The zone with how it was chosen when it isn't the person's own: "Europe/Berlin", or "UTC, the hub machine's
    /// zone: theirs isn't known yet".
    pub fn told(&self) -> String {
        match self.source {
            Source::Device => self.name().to_owned(),
            Source::Policy => format!(
                "{}, the hub's policy.tz: theirs isn't known yet",
                self.name()
            ),
            Source::Hub => format!(
                "{}, the hub machine's zone: theirs isn't known yet",
                self.name()
            ),
        }
    }

    /// "Tue 3 Nov 2026, 18:05 Europe/Berlin": the instant `ms` on this zone's clock, with how the zone was chosen.
    pub fn stamp(&self, ms: i64) -> String {
        format!("{} {}", self.format(ms, "%a %-d %b %Y, %H:%M"), self.told())
    }

    /// "Tue 3 Nov, 18:05": the instant `ms` on this zone's clock, for a list that names the zone once.
    pub fn short(&self, ms: i64) -> String {
        self.format(ms, "%a %-d %b, %H:%M")
    }

    fn format(&self, ms: i64, pattern: &str) -> String {
        let t = self
            .tz
            .timestamp_millis_opt(ms)
            .single()
            .unwrap_or_else(|| self.tz.timestamp_millis_opt(0).unwrap());
        t.format(pattern).to_string()
    }
}

/// The active global `policy.tz` decision's zone, if it names one.
fn policy_on(c: &Connection) -> Option<Tz> {
    let global = list_decisions(
        c,
        &DecisionFilter {
            scope: Some(DecisionScope::Global),
            limit: Some(500),
            ..Default::default()
        },
    )
    .ok()?;
    global
        .into_iter()
        .find(|d| d.key.as_str() == POLICY_TZ_KEY)
        .and_then(|d| zone(d.value.trim()))
}

/// The person `person` names, else the hub's first owner (a key with no person acts for it, as for Navis).
fn person_on(c: &Connection, person: Option<&PersonId>) -> Result<Option<String>, StoreError> {
    Ok(match person {
        Some(p) => Some(p.to_string()),
        None => super::owner_on(c)?.map(|p| p.person_id.to_string()),
    })
}

/// Keeps `tz` as the zone of `person` (None: the hub's owner), from a chat message their device sent.
pub fn set(db: &HubDb, person: Option<&PersonId>, tz: &TimeZone) -> Result<(), StoreError> {
    db.with(|c| {
        if let Some(id) = person_on(c, person)? {
            c.execute(
                "UPDATE people SET tz = ? WHERE person_id = ? AND tz IS NOT ?",
                params![tz.as_str(), id, tz.as_str()],
            )?;
        }
        Ok(())
    })
}

/// The zone of `person` (None: the hub's owner): their device's, else `policy.tz`, else the hub machine's.
pub fn of_person(db: &HubDb, person: Option<&PersonId>) -> Zone {
    let found = db.with(|c| {
        let own: Option<String> = match person_on(c, person)? {
            Some(id) => c
                .query_row("SELECT tz FROM people WHERE person_id = ?", [id], |r| {
                    r.get(0)
                })
                .optional()?
                .flatten(),
            None => None,
        };
        Ok((own.and_then(|t| zone(&t)), policy_on(c)))
    });
    match found {
        Ok((Some(tz), _)) => Zone {
            tz,
            source: Source::Device,
        },
        Ok((None, Some(tz))) => Zone {
            tz,
            source: Source::Policy,
        },
        Ok((None, None)) | Err(_) => Zone {
            tz: hub_zone(),
            source: Source::Hub,
        },
    }
}

/// The zone of the person who last wrote in `r`'s chat (none yet: the hub's owner), for what its lead schedules and reads.
pub fn of_chat(db: &HubDb, r: &ProjectRef) -> Zone {
    let person = db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT data FROM chat_messages WHERE machine_id = ?1 AND project_id = ?2
                   AND json_valid(data) AND json_extract(data, '$.author') = 'human'
                 ORDER BY seq DESC LIMIT 1",
            )?;
            let data: Option<String> = stmt
                .query_row([r.machine_id.as_str(), r.project_id.as_str()], |row| {
                    row.get(0)
                })
                .optional()?;
            Ok(data)
        })
        .ok()
        .flatten()
        .and_then(|d| serde_json::from_str::<ChatMessage>(&d).ok())
        .filter(|m| m.author == ChatAuthor::Human)
        .and_then(|m| m.person.map(|p| p.person_id));
    of_person(db, person.as_ref())
}
