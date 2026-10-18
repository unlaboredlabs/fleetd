//! Estimates vs actuals. When a workstream with a raw estimate starts running, its tier's ratio is saved as
//! `ratioAtStart`; when it is done, the wall-clock minutes since then are its actual. A tier's ratio is the median
//! actual/raw of its latest done workstreams (calibration.rs), and an actual over twice the raw is an incident.
pub mod calibration;

use crate::clock::Clock;
use crate::hub::checks::ports::Ports;
use crate::hub::incidents::{IncidentInput, Incidents};
use crate::hub::store::{EventLog, HubDb, StoreError, WaitInput, now_ms};
use calibration::{Calibration, MISS_RATIO, WINDOW, calibrate, eta_of, round1};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ledger::{Tier, Workstream, WorkstreamEstimateActual, WorkstreamId};
use fleetd_contracts::prim::{NonNegative, PositiveNumber};
use fleetd_contracts::verification::{Eta, IncidentClass};
use rusqlite::OptionalExtension;
use std::sync::Arc;

pub use calibration::eta_text;

pub struct Estimates {
    db: Arc<HubDb>,
    ports: Arc<dyn Ports>,
    incidents: Arc<Incidents>,
    clock: Arc<dyn Clock>,
}

fn tier_name(tier: Tier) -> &'static str {
    match tier {
        Tier::S => "S",
        Tier::M => "M",
        Tier::L => "L",
    }
}

/// JS `String(n)` for the evidence lines: integers without ".0".
fn num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

struct Row {
    tier: String,
    raw_minutes: f64,
    ratio_at_start: f64,
    started_ms: i64,
    done_ms: Option<i64>,
}

impl Estimates {
    pub fn new(
        db: Arc<HubDb>,
        ports: Arc<dyn Ports>,
        incidents: Arc<Incidents>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            db,
            ports,
            incidents,
            clock,
        }
    }

    fn row(&self, id: &WorkstreamId) -> Result<Option<Row>, StoreError> {
        self.db.with(|conn| {
            Ok(conn
                .prepare_cached("SELECT tier, raw_minutes, ratio_at_start, started_ms, done_ms FROM estimates WHERE workstream_id = ?")?
                .query_row([id.as_str()], |r| {
                    Ok(Row { tier: r.get(0)?, raw_minutes: r.get(1)?, ratio_at_start: r.get(2)?, started_ms: r.get(3)?, done_ms: r.get(4)? })
                })
                .optional()?)
        })
    }

    /// Below MIN_SAMPLES the workstream's pinned playbook supplies the prior.
    fn calibration_of(
        &self,
        tier: Tier,
        workstream: &Workstream,
    ) -> Result<Calibration, StoreError> {
        let prior = workstream
            .playbook
            .as_ref()
            .and_then(|p| self.ports.playbook_limits(p))
            .map(|l| l.estimate_prior);
        let ratios = self.db.with(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT actual_minutes / raw_minutes AS ratio FROM estimates
                 WHERE tier = ? AND done_ms IS NOT NULL AND raw_minutes > 0 ORDER BY done_ms DESC LIMIT ?",
            )?;
            let rows = stmt.query_map(rusqlite::params![tier_name(tier), WINDOW as i64], |r| r.get::<_, Option<f64>>(0))?;
            let mut out = Vec::new();
            for r in rows {
                // A NULL ratio counts as 0, which calibrate drops.
                out.push(r?.unwrap_or(0.0));
            }
            Ok(out)
        })?;
        Ok(calibrate(&ratios, prior))
    }

    fn put_estimate_actual(&self, id: &WorkstreamId, actual: WorkstreamEstimateActual) {
        if let Some(mut w) = self.ports.workstream(id) {
            w.estimate_actual = Some(actual);
            self.ports.put_workstream(&w);
        }
    }

    /// Saves the tier's current ratio as `ratioAtStart` and starts the clock. Once per workstream; no-op without a
    /// raw estimate.
    pub fn record_start(&self, id: &WorkstreamId) -> Result<(), StoreError> {
        let Some(workstream) = self.ports.workstream(id) else {
            return Ok(());
        };
        let Some(brief) = &workstream.brief else {
            return Ok(());
        };
        let Some(estimate) = &brief.estimate else {
            return Ok(());
        };
        if self.row(id)?.is_some() {
            return Ok(());
        }
        let ratio = self.calibration_of(brief.tier, &workstream)?.ratio;
        let now = now_ms(self.clock.as_ref());
        self.db.with(|conn| {
            conn.prepare_cached(
                "INSERT OR IGNORE INTO estimates (workstream_id, tier, raw_minutes, ratio_at_start, started_ms) VALUES (?, ?, ?, ?, ?)",
            )?
            .execute(rusqlite::params![id.as_str(), tier_name(brief.tier), estimate.raw_minutes.get(), ratio, now])?;
            Ok(())
        })?;
        self.put_estimate_actual(
            id,
            WorkstreamEstimateActual {
                actual_minutes: None,
                ratio_at_start: PositiveNumber::unchecked(ratio),
            },
        );
        Ok(())
    }

    /// Stores `actualMinutes`, records `estimate_miss` past 2x the raw. Once per workstream; no-op if it never started
    /// the clock.
    pub fn record_done(&self, id: &WorkstreamId) -> Result<(), StoreError> {
        let Some(row) = self.row(id)? else {
            return Ok(());
        };
        if row.done_ms.is_some() {
            return Ok(());
        }
        let now = now_ms(self.clock.as_ref());
        let actual_minutes = round1((now - row.started_ms).max(0) as f64 / 60_000.0);
        self.db.with(|conn| {
            conn.prepare_cached("UPDATE estimates SET done_ms = ?, actual_minutes = ? WHERE workstream_id = ? AND done_ms IS NULL")?
                .execute(rusqlite::params![now, actual_minutes, id.as_str()])?;
            Ok(())
        })?;
        self.put_estimate_actual(
            id,
            WorkstreamEstimateActual {
                actual_minutes: Some(NonNegative::unchecked(actual_minutes)),
                ratio_at_start: PositiveNumber::unchecked(row.ratio_at_start),
            },
        );
        let raw = row.raw_minutes;
        if raw <= 0.0 || actual_minutes / raw <= MISS_RATIO {
            return Ok(());
        }
        let Some(workstream) = self.ports.workstream(id) else {
            return Ok(());
        };
        self.incidents.record(IncidentInput {
            class: IncidentClass::EstimateMiss,
            project_ref: workstream.project_ref,
            workstream_id: Some(id.clone()),
            task_id: None,
            evidence: vec![
                format!(
                    "{id} (tier {}) took {} min against a raw estimate of {} min: {}x, over the {}x limit.",
                    row.tier,
                    num(actual_minutes),
                    num(raw),
                    num(round1(actual_minutes / raw)),
                    num(MISS_RATIO)
                ),
                format!(
                    "The calibrated estimate at start was {} min (ratio {}).",
                    num(round1(raw * row.ratio_at_start)),
                    num(row.ratio_at_start)
                ),
            ],
        })?;
        Ok(())
    }

    /// None without a raw estimate in the brief.
    pub fn eta(&self, workstream: &Workstream) -> Result<Option<Eta>, StoreError> {
        let Some(brief) = &workstream.brief else {
            return Ok(None);
        };
        let Some(estimate) = &brief.estimate else {
            return Ok(None);
        };
        Ok(Some(eta_of(
            estimate.raw_minutes.get(),
            &self.calibration_of(brief.tier, workstream)?,
        )))
    }

    /// Starts the clock on every `workstream.running` event from the hub's start on. Runs until the hub stops.
    pub async fn run_start_on_running(self: Arc<Self>, events: Arc<EventLog>) {
        let mut cursor = events.head();
        loop {
            let page = match events
                .wait(WaitInput {
                    cursor: Some(cursor),
                    types: Some(vec![HubEventType::WorkstreamRunning]),
                    machine_id: None,
                    timeout_sec: 3600,
                })
                .await
            {
                Ok(page) => page,
                Err(error) => {
                    tracing::warn!(%error, "estimates: event log not readable");
                    self.clock.sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
            };
            cursor = page.cursor;
            for event in page.events {
                let Some(id) = event
                    .data
                    .as_ref()
                    .and_then(|d| d.get("workstreamId"))
                    .and_then(|v| v.as_str())
                else {
                    continue;
                };
                if let Err(error) = self.record_start(&WorkstreamId::unchecked(id)) {
                    tracing::warn!(workstream_id = id, %error, "estimate start not recorded");
                }
            }
        }
    }
}
