//! The hub's people (table `people`): who is behind each human key, with a hub role. Every human key belongs to a
//! person; a hub has at least one owner, made at its first start with people from the machine's user, and an older
//! hub's human keys all bind to it, so a one-person hub reads exactly as before. Invites are pairing codes bound to a
//! person (hub/pair); the app's tools are in tools.rs.
pub mod tools;

#[cfg(test)]
mod tests;

use std::sync::Arc;

use fleetd_contracts::auth::{Grant, Role};
use fleetd_contracts::people::{HubRole, Person, PersonId, PersonName, PersonRef};
use rusqlite::{Connection, OptionalExtension, params};

use crate::clock::Clock;
use crate::hub::auth::base32;
use crate::hub::store::{HubDb, StoreError, iso_ms, now_ms};

/// The owner's name when the machine's user has none.
const OWNER_FALLBACK: &str = "Owner";

pub fn role_of(text: &str) -> HubRole {
    match text {
        "owner" => HubRole::Owner,
        "admin" => HubRole::Admin,
        // An unreadable role grants the least, never more.
        _ => HubRole::Member,
    }
}

/// The most a device of a person in `role` may hold: a member operates, an owner or admin administers.
pub fn role_cap(role: HubRole) -> Role {
    if role.administers() {
        Role::Admin
    } else {
        Role::Operate
    }
}

/// `grants` with nothing above `cap`: what a device may do once its person's role is applied.
pub fn capped(grants: &[Grant], cap: Role) -> Vec<Grant> {
    grants
        .iter()
        .map(|grant| Grant {
            role: grant.role.min(cap),
            machines: grant.machines.clone(),
        })
        .collect()
}

/// A person's name as given: trimmed, control characters dropped, at most 80 characters. None when nothing is left.
pub fn clean_name(name: &str) -> Option<PersonName> {
    let name: String = name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    PersonName::new(name.trim()).ok()
}

fn new_id() -> PersonId {
    PersonId::unchecked(format!("p_{}", base32(&rand::random::<[u8; 5]>())))
}

const COLUMNS: &str = "person_id, name, role, created_ms, removed_ms";

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Person> {
    let name: String = row.get(1)?;
    let role: String = row.get(2)?;
    let removed: Option<i64> = row.get(4)?;
    Ok(Person {
        person_id: PersonId::unchecked(row.get::<_, String>(0)?),
        name: clean_name(&name).unwrap_or_else(|| PersonName::unchecked(OWNER_FALLBACK)),
        role: role_of(&role),
        created_at: iso_ms(row.get(3)?).into(),
        removed_at: removed.map(|ms| iso_ms(ms).into()),
    })
}

pub fn get_on(c: &Connection, id: &str) -> Result<Option<Person>, StoreError> {
    Ok(
        c.prepare_cached(&format!("SELECT {COLUMNS} FROM people WHERE person_id = ?"))?
            .query_row([id], read_row)
            .optional()?,
    )
}

/// The first owner still on the hub.
fn owner_on(c: &Connection) -> Result<Option<Person>, StoreError> {
    Ok(c.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms, rowid LIMIT 1"
    ))?
    .query_row([], read_row)
    .optional()?)
}

/// The machine user's name, for the owner a hub makes for itself.
fn machine_user() -> String {
    ["USER", "LOGNAME", "USERNAME"]
        .iter()
        .find_map(|var| std::env::var(var).ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| OWNER_FALLBACK.to_owned())
}

pub struct People {
    db: Arc<HubDb>,
    clock: Arc<dyn Clock>,
}

impl People {
    pub fn new(db: Arc<HubDb>, clock: Arc<dyn Clock>) -> Self {
        Self { db, clock }
    }

    fn now(&self) -> i64 {
        now_ms(self.clock.as_ref())
    }

    /// The hub's owner, made from the machine's user when the hub has none; every human key with no person binds to
    /// it. Idempotent: the hub runs it at each start, and a human key made without a person runs it too.
    pub fn ensure_owner(&self) -> Result<Person, StoreError> {
        let now = self.now();
        let name = machine_user();
        self.db.transaction(|c| ensure_owner_on(c, &name, now))
    }

    pub fn get(&self, id: &PersonId) -> Result<Option<Person>, StoreError> {
        self.db.with(|c| get_on(c, id.as_str()))
    }

    /// Oldest first.
    pub fn list(&self, include_removed: bool) -> Result<Vec<Person>, StoreError> {
        self.db.with(|c| {
            let mut stmt = c.prepare_cached(&format!(
                "SELECT {COLUMNS} FROM people WHERE ?1 OR removed_ms IS NULL ORDER BY created_ms, rowid"
            ))?;
            let people = stmt
                .query_map([include_removed], read_row)?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(people)
        })
    }

    /// People on the hub, removed ones left out.
    pub fn count(&self) -> Result<usize, StoreError> {
        self.db.with(|c| {
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM people WHERE removed_ms IS NULL",
                [],
                |row| row.get(0),
            )?;
            Ok(n as usize)
        })
    }

    /// The names of people who joined after the hub's first person: not removed, with a device that still works.
    /// Someone invited who hasn't paired yet hasn't joined.
    pub fn joined(&self) -> Result<Vec<String>, StoreError> {
        self.db.with(|c| {
            let mut stmt = c.prepare(
                "SELECT p.name FROM people p
                 WHERE p.removed_ms IS NULL
                   AND p.person_id != (SELECT person_id FROM people ORDER BY created_ms, rowid LIMIT 1)
                   AND EXISTS (SELECT 1 FROM agent_keys k WHERE k.person_id = p.person_id AND k.kind = 'human'
                               AND k.revoked_ms IS NULL)
                 ORDER BY p.created_ms, p.rowid",
            )?;
            let names = stmt
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            Ok(names)
        })
    }

    pub fn create(&self, name: &PersonName, role: HubRole) -> Result<Person, StoreError> {
        let now = self.now();
        let person = Person {
            person_id: new_id(),
            name: name.clone(),
            role,
            created_at: iso_ms(now).into(),
            removed_at: None,
        };
        self.db.with(|c| {
            c.prepare_cached(
                "INSERT INTO people (person_id, name, role, created_ms) VALUES (?, ?, ?, ?)",
            )?
            .execute(params![
                person.person_id.as_str(),
                person.name.as_str(),
                role.as_str(),
                now
            ])?;
            Ok(())
        })?;
        Ok(person)
    }

    /// Renames a person or changes their role; None when there is no such person.
    pub fn set(
        &self,
        id: &PersonId,
        name: Option<&PersonName>,
        role: Option<HubRole>,
    ) -> Result<Option<Person>, StoreError> {
        self.db.transaction(|c| {
            c.prepare_cached(
                "UPDATE people SET name = COALESCE(?2, name), role = COALESCE(?3, role) WHERE person_id = ?1",
            )?
            .execute(params![
                id.as_str(),
                name.map(|n| n.as_str()),
                role.map(HubRole::as_str)
            ])?;
            get_on(c, id.as_str())
        })
    }

    /// Removes a person: their devices are revoked and their open invites closed. Returns the person and how many
    /// devices it revoked; None when there is no such person.
    pub fn remove(&self, id: &PersonId) -> Result<Option<(Person, usize)>, StoreError> {
        let now = self.now();
        self.db.transaction(|c| {
            c.prepare_cached(
                "UPDATE people SET removed_ms = COALESCE(removed_ms, ?2) WHERE person_id = ?1",
            )?
            .execute(params![id.as_str(), now])?;
            let revoked = c
                .prepare_cached(
                    "UPDATE agent_keys SET revoked_ms = ?2 WHERE person_id = ?1 AND revoked_ms IS NULL",
                )?
                .execute(params![id.as_str(), now])?;
            c.prepare_cached(
                "UPDATE pair_codes SET revoked_ms = ?2 WHERE person_id = ?1 AND used_ms IS NULL AND revoked_ms IS NULL",
            )?
            .execute(params![id.as_str(), now])?;
            Ok(get_on(c, id.as_str())?.map(|person| (person, revoked)))
        })
    }

    /// Owners still on the hub.
    pub fn owners(&self) -> Result<usize, StoreError> {
        self.db.with(|c| {
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM people WHERE role = 'owner' AND removed_ms IS NULL",
                [],
                |row| row.get(0),
            )?;
            Ok(n as usize)
        })
    }

    /// The person a key belongs to, as records name them.
    pub fn person_ref(&self, id: &PersonId) -> Result<Option<PersonRef>, StoreError> {
        Ok(self.get(id)?.map(|p| p.as_ref()))
    }
}

/// [`People::ensure_owner`] inside a transaction.
pub fn ensure_owner_on(c: &Connection, name: &str, now: i64) -> Result<Person, StoreError> {
    let owner = match owner_on(c)? {
        Some(owner) => owner,
        None => {
            let name = clean_name(name).unwrap_or_else(|| PersonName::unchecked(OWNER_FALLBACK));
            let id = new_id();
            c.prepare_cached(
                "INSERT INTO people (person_id, name, role, created_ms) VALUES (?, ?, 'owner', ?)",
            )?
            .execute(params![id.as_str(), name.as_str(), now])?;
            get_on(c, id.as_str())?.expect("just inserted")
        }
    };
    c.prepare_cached(
        "UPDATE agent_keys SET person_id = ? WHERE kind = 'human' AND person_id IS NULL",
    )?
    .execute([owner.person_id.as_str()])?;
    Ok(owner)
}

/// Everyone on the hub (not removed), oldest first.
pub fn active(db: &HubDb) -> Result<Vec<Person>, StoreError> {
    db.with(|c| {
        let mut stmt = c.prepare_cached(&format!(
            "SELECT {COLUMNS} FROM people WHERE removed_ms IS NULL ORDER BY created_ms, rowid"
        ))?;
        let people = stmt
            .query_map([], read_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(people)
    })
}

/// The hub's people when there is more than one, oldest first; empty on a one-person hub, whose prompts read
/// exactly as before people.
pub fn roster(db: &HubDb) -> Vec<Person> {
    match active(db) {
        Ok(people) if people.len() > 1 => people,
        Ok(_) => Vec::new(),
        Err(error) => {
            tracing::warn!(%error, "people: roster not read");
            Vec::new()
        }
    }
}

/// Who wrote a human message, as the lead reads it: "The human" on a one-person hub, else the writer's name.
pub fn writer(db: &HubDb, person: Option<&PersonRef>) -> String {
    match person {
        Some(person) if !roster(db).is_empty() => person.name.to_string(),
        _ => "The human".to_owned(),
    }
}

/// `lead.start`'s `{{people}}`: nothing on a one-person hub; else who shares the chat, with their roles.
pub fn lead_people(db: &HubDb) -> String {
    let people = roster(db);
    if people.is_empty() {
        return String::new();
    }
    let names: Vec<String> = people
        .iter()
        .map(|p| format!("{} ({})", p.name, p.role.as_str()))
        .collect();
    format!(
        " Several people share this hub and its chats: {}. \"The human\" below means whoever writes to you: each \
         message names its writer, so answer them by name, and take an answer to a question you asked one person \
         from that person.",
        names.join(", ")
    )
}
