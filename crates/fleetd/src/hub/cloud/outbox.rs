//! What a sleeping cloud machine missed, kept until its next hello (`cloud_outbox`): a secret it must forget that the
//! hub couldn't tell it while it slept. Each item names an account or a person, never a value, and is kept once per
//! machine; the catch-up ([`super::catch_up`]) replays them in order and drops each one its node took.
use fleetd_contracts::claude_accounts::ClaudeAccount;
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::people::PersonId;
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::hub::api::Hub;
use crate::hub::store::{HubDb, StoreError, now_ms};

/// One thing a sleeping cloud machine missed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Missed {
    /// Forget a Claude account's secret: the hub's API key replaced or removed, or a person's subscription.
    ClaudeForget { account: ClaudeAccount },
    /// Forget a person's 1Password service account token.
    #[serde(rename_all = "camelCase")]
    OnePasswordForget { person_id: PersonId },
}

pub struct Outbox<'a> {
    db: &'a HubDb,
}

impl HubDb {
    pub fn cloud_outbox(&self) -> Outbox<'_> {
        Outbox { db: self }
    }
}

impl Outbox<'_> {
    /// Keeps `item` for the machine's next hello; once only, however often it is missed.
    pub fn add(&self, machine_id: &MachineId, item: &Missed, at_ms: i64) -> Result<(), StoreError> {
        let item = serde_json::to_string(item)?;
        self.db.with(|c| {
            c.prepare_cached(
                "INSERT INTO cloud_outbox (machine_id, item, created_ms) VALUES (?, ?, ?)
                 ON CONFLICT (machine_id, item) DO NOTHING",
            )?
            .execute(params![machine_id.as_str(), item, at_ms])?;
            Ok(())
        })
    }

    /// The machine's items, oldest first, each with its id. One that no longer decodes is skipped.
    pub fn list(&self, machine_id: &MachineId) -> Result<Vec<(i64, Missed)>, StoreError> {
        let rows: Vec<(i64, String)> = self.db.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT id, item FROM cloud_outbox WHERE machine_id = ? ORDER BY id",
            )?;
            let rows = stmt
                .query_map([machine_id.as_str()], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        })?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, item)| Some((id, serde_json::from_str(&item).ok()?)))
            .collect())
    }

    /// The item went to its machine.
    pub fn done(&self, id: i64) -> Result<(), StoreError> {
        self.db.with(|c| {
            c.prepare_cached("DELETE FROM cloud_outbox WHERE id = ?")?
                .execute([id])?;
            Ok(())
        })
    }
}

/// `machine_id` missed `item` because it was offline: kept for its next hello when it is a cloud machine, which sleeps
/// by design. Any other machine offline keeps today's rule (the hub stops recording it as holding the secret, so
/// nothing runs on it there).
pub fn missed(hub: &Hub, machine_id: &MachineId, item: Missed) {
    if !super::is_pool(hub, machine_id) {
        return;
    }
    let at = now_ms(hub.clock.as_ref());
    if let Err(e) = hub.db.cloud_outbox().add(machine_id, &item, at) {
        tracing::warn!(machine_id = %machine_id, ?item, "a sleeping cloud machine's missed forget not kept: {e}");
    }
}
