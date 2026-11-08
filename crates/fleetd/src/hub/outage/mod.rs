//! Machines down: a machine offline for [`DOWN_AFTER_MS`] that nothing explains is logged as `machine.down` with
//! `attention`, so the hub's admins get one push (hub/push: an event about no project is theirs) and the app one
//! notification; once it links again, `machine.back` tells them, once. The event log is the only state: a machine is
//! paged while its newest machine.down is newer than its last link (machine.online or machine.degraded), so a hub
//! restart mid-outage neither pages twice nor forgets the outage.
//!
//! Nothing explains an outage except an update whose node part has no result yet (its node restarts) and a cloud
//! machine the pool stopped or put to sleep (its rest). Those are looked at again each sweep: an update that never
//! brings the node back, or a cloud machine its pool marks broken, still pages. A removed machine has no row, so it
//! never pages. The agents' Mac counts like any machine.
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::events::{Attention, HubEventType};
use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::model::{Machine, MachineStatus, duration_text};
use rusqlite::{Connection, params};
use serde_json::json;

use crate::hub::api::Hub;
use crate::hub::pool::ledger::State;
use crate::hub::store::{NewEvent, StoreError, iso_ms, now_ms, parse_ms};

/// How long a machine stays offline before its admins are paged.
pub const DOWN_AFTER_MS: i64 = 10 * 60_000;
/// How often the sweep looks.
const SWEEP_EVERY: Duration = Duration::from_secs(30);

/// The newest of a machine's outage events: seqs (0 when none), and when it last went offline.
#[derive(Default)]
struct Marks {
    linked: i64,
    down: i64,
    back: i64,
    offline_ms: Option<i64>,
    linked_ms: Option<i64>,
}

fn marks(c: &Connection, machine: &str) -> Result<Marks, StoreError> {
    let mut rows: HashMap<String, (i64, i64)> = HashMap::new();
    let mut stmt = c.prepare_cached(
        "SELECT type, MAX(seq), MAX(created_ms) FROM events WHERE machine_id = ?
           AND type IN ('machine.online', 'machine.degraded', 'machine.offline', 'machine.down', 'machine.back')
         GROUP BY type",
    )?;
    for row in stmt.query_map(params![machine], |r| {
        Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?)))
    })? {
        let (kind, mark) = row?;
        rows.insert(kind, mark);
    }
    let seq = |k: &str| rows.get(k).map_or(0, |m| m.0);
    let at = |k: &str| rows.get(k).map(|m| m.1);
    Ok(Marks {
        linked: seq("machine.online").max(seq("machine.degraded")),
        down: seq("machine.down"),
        back: seq("machine.back"),
        offline_ms: at("machine.offline"),
        linked_ms: at("machine.online").max(at("machine.degraded")),
    })
}

/// Whether something explains the machine being away, so it needs nobody.
fn explained(hub: &Hub, m: &Machine) -> bool {
    if hub.updates.updating(&m.machine_id) {
        return true;
    }
    if m.cloud != Some(true) {
        return false;
    }
    match hub.pool.ledger().slot(m.machine_id.as_str()) {
        Ok(Some(slot)) => matches!(slot.state, State::Stopping | State::Asleep | State::Gone),
        // No slot: the pool no longer keeps it, so it isn't meant to be up.
        Ok(None) => true,
        Err(e) => {
            tracing::warn!(error = %e, "outage: pool slot not read");
            true
        }
    }
}

fn event(kind: HubEventType, m: &Machine, at: &str, summary: String, offline_ms: i64) -> NewEvent {
    NewEvent {
        at: Timestamp(at.to_owned()),
        r#type: kind,
        machine_id: Some(m.machine_id.clone()),
        project_id: None,
        thread_id: None,
        summary,
        data: Some(json!({ "offlineMs": offline_ms })),
        attention: Some(Attention::Loud),
    }
}

/// One look at every machine: pages each one down past [`DOWN_AFTER_MS`], and says each paged one is back.
pub fn sweep(hub: &Hub) -> Result<(), StoreError> {
    let now = now_ms(hub.clock.as_ref());
    for m in hub.store.machines_list()? {
        let marks = hub.db.with(|c| marks(c, m.machine_id.as_str()))?;
        let paged = marks.down > marks.linked;
        if m.status == MachineStatus::Offline {
            if paged {
                continue;
            }
            let since = marks
                .offline_ms
                .or_else(|| parse_ms(m.last_seen_at.as_str()))
                .unwrap_or(now);
            let away = now - since;
            if away < DOWN_AFTER_MS || explained(hub, &m) {
                continue;
            }
            let summary = format!("{} has been offline for {}", m.name, duration_text(away));
            hub.events.append(event(
                HubEventType::MachineDown,
                &m,
                &iso_ms(now),
                summary,
                away,
            ))?;
            tracing::warn!(machine_id = %m.machine_id, away_ms = away, "outage: machine down, admins paged");
        } else if marks.down > marks.back && marks.linked > marks.down {
            let away = marks
                .linked_ms
                .zip(marks.offline_ms)
                .map_or(0, |(linked, offline)| (linked - offline).max(0));
            let summary = format!("{} is back online after {}", m.name, duration_text(away));
            hub.events.append(event(
                HubEventType::MachineBack,
                &m,
                &iso_ms(now),
                summary,
                away,
            ))?;
            tracing::info!(machine_id = %m.machine_id, "outage: machine back");
        }
    }
    Ok(())
}

pub async fn run(hub: Arc<Hub>) {
    loop {
        tokio::select! {
            () = hub.shutdown.wait() => return,
            () = hub.clock.sleep(SWEEP_EVERY) => {}
        }
        if let Err(e) = sweep(&hub) {
            tracing::error!(error = %e, "outage: machines not swept");
        }
    }
}
