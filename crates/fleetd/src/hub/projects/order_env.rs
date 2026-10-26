//! An order's variables (`order:` secret sinks): what the hub keeps of each one its node saved (`order_env` rows: the
//! name, fingerprint and size, never the value), and their end. Once the order is closed (done or stopped) or gone,
//! its node is told to forget them (`order_env_drop`) and the rows go; a node offline then hears it once it is back,
//! from the next event or sweep.
use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::node_link::CAP_ORDER_ENV;
use rusqlite::params;

use crate::hub::api::Hub;
use crate::hub::leads::records::is_closed;
use crate::hub::store::{HubDb, StoreError};

/// One variable delivered for an order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OrderEnvRow {
    pub name: String,
    pub fingerprint: String,
    pub bytes: i64,
    pub request_id: String,
    pub updated_at: String,
}

pub struct OrderEnvStore<'a> {
    db: &'a HubDb,
}

impl HubDb {
    pub fn order_env(&self) -> OrderEnvStore<'_> {
        OrderEnvStore { db: self }
    }
}

impl OrderEnvStore<'_> {
    pub fn save(&self, r: &ProjectRef, order: &str, row: &OrderEnvRow) -> Result<(), StoreError> {
        self.db.with(|c| {
            c.prepare_cached(
                "INSERT INTO order_env (machine_id, project_id, workstream_id, name, fingerprint, bytes, request_id, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (machine_id, project_id, workstream_id, name) DO UPDATE SET fingerprint = excluded.fingerprint,
                   bytes = excluded.bytes, request_id = excluded.request_id, updated_at = excluded.updated_at",
            )?
            .execute(params![
                r.machine_id.as_str(),
                r.project_id.as_str(),
                order,
                row.name,
                row.fingerprint,
                row.bytes,
                row.request_id,
                row.updated_at,
            ])?;
            Ok(())
        })
    }

    /// The order's variables, by name.
    pub fn list(&self, r: &ProjectRef, order: &str) -> Result<Vec<OrderEnvRow>, StoreError> {
        self.db.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT name, fingerprint, bytes, request_id, updated_at FROM order_env
                 WHERE machine_id = ? AND project_id = ? AND workstream_id = ? ORDER BY name",
            )?;
            let rows = stmt
                .query_map(
                    params![r.machine_id.as_str(), r.project_id.as_str(), order],
                    |row| {
                        Ok(OrderEnvRow {
                            name: row.get(0)?,
                            fingerprint: row.get(1)?,
                            bytes: row.get(2)?,
                            request_id: row.get(3)?,
                            updated_at: row.get(4)?,
                        })
                    },
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Every order that has variables, with its project.
    pub fn held(&self) -> Result<Vec<(ProjectRef, String)>, StoreError> {
        self.db.with(|c| {
            let mut stmt = c.prepare_cached(
                "SELECT DISTINCT machine_id, project_id, workstream_id FROM order_env ORDER BY workstream_id",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        ProjectRef {
                            machine_id: MachineId::unchecked(row.get::<_, String>(0)?),
                            project_id: ProjectId::unchecked(row.get::<_, String>(1)?),
                        },
                        row.get(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn forget(&self, r: &ProjectRef, order: &str) -> Result<(), StoreError> {
        self.db.with(|c| {
            c.prepare_cached(
                "DELETE FROM order_env WHERE machine_id = ? AND project_id = ? AND workstream_id = ?",
            )?
            .execute(params![r.machine_id.as_str(), r.project_id.as_str(), order])?;
            Ok(())
        })
    }
}

/// Why the project's order can't take a variable now; `None` when it can.
pub fn refusal(hub: &Hub, r: &ProjectRef, order: &str) -> Option<String> {
    let Ok(id) = WorkstreamId::new(order) else {
        return Some(format!("{order} is no order id."));
    };
    let w = match hub.leads.records.workstream_get(&id) {
        Ok(Some(w)) if w.project_ref == *r => w,
        Ok(_) => return Some(format!("The project has no order {order}.")),
        Err(e) => return Some(format!("The hub could not read {order}: {e}.")),
    };
    if is_closed(w.state) {
        return Some(format!("{order} is closed: its agents are done."));
    }
    let m = &r.machine_id;
    if !hub.link.node_can(m, CAP_ORDER_ENV) {
        return Some(format!(
            "{m}'s node is too old to take an order's variables: update fleetd there."
        ));
    }
    None
}

/// Records what the node saved; the rows go once the order closes.
pub fn saved(hub: &Hub, saved: &crate::hub::approvals::OrderEnvSaved, at: &Timestamp) {
    let Ok(r) = serde_json::from_value::<ProjectRef>(serde_json::json!({
        "machineId": saved.project.machine_id,
        "projectId": saved.project.project_id,
    })) else {
        return;
    };
    let row = OrderEnvRow {
        name: saved.name.clone(),
        fingerprint: saved.fingerprint.clone(),
        bytes: saved.bytes as i64,
        request_id: saved.request_id.clone(),
        updated_at: at.to_string(),
    };
    if let Err(e) = hub.db.order_env().save(&r, &saved.order_id, &row) {
        tracing::warn!(order = saved.order_id.as_str(), error = %e, "an order's variable not recorded");
    }
}

/// Has each closed or gone order's node forget its variables, and drops their rows once it has. An order whose node is
/// offline or too old keeps its rows until a later pass. Returns how many orders were dropped.
pub async fn drop_closed(hub: &Hub) -> Result<usize, StoreError> {
    let mut dropped = 0;
    for (r, order) in hub.db.order_env().held()? {
        let id = WorkstreamId::new(order.clone()).ok();
        let open = id
            .as_ref()
            .and_then(|id| hub.leads.records.workstream_get(id).ok().flatten())
            .is_some_and(|w| w.project_ref == r && !is_closed(w.state));
        if open {
            continue;
        }
        let m = &r.machine_id;
        if !hub.executors.is_connected(m) || !hub.link.node_can(m, CAP_ORDER_ENV) {
            continue;
        }
        let Some(id) = id else {
            hub.db.order_env().forget(&r, &order)?;
            continue;
        };
        match hub.executors.order_env_drop(m, &r.project_id, &id).await {
            Ok(()) => {
                hub.db.order_env().forget(&r, &order)?;
                tracing::info!(order = order.as_str(), machine = %m, "the closed order's variables are gone");
                dropped += 1;
            }
            Err(e) => {
                tracing::warn!(order = order.as_str(), machine = %m, error = %e, "the closed order's variables not dropped yet");
            }
        }
    }
    Ok(dropped)
}

/// Drops closed orders' variables after every batch of events (an order closing, a machine coming back), and on
/// every sweep.
pub async fn run(hub: Arc<Hub>) {
    let check = hub.clone();
    hub.sweep.register(crate::hub::sweep::SweepCheck {
        name: "order-env".into(),
        run: Arc::new(move || {
            let hub = check.clone();
            Box::pin(async move {
                drop_closed(&hub)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
        }),
    });
    let mut head = hub.events.subscribe();
    loop {
        head.borrow_and_update();
        let held = hub.db.order_env().held().map(|h| !h.is_empty());
        if held.unwrap_or(false)
            && let Err(e) = drop_closed(&hub).await
        {
            tracing::warn!(error = %e, "closed orders' variables not checked");
        }
        tokio::select! {
            () = hub.shutdown.wait() => return,
            changed = head.changed() => if changed.is_err() { return },
        }
    }
}
