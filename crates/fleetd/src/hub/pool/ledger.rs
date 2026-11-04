//! The pool's tables (migration `cloud_pool`): its settings, one row per slot, the starts it counted and its spend
//! meter. Every row is written before the boat call it stands for; nothing about the pool is held only in memory.
use fleetd_contracts::ids::ProjectRef;
use rusqlite::{Connection, OptionalExtension, Row, params};
use std::sync::Arc;

use super::boat::StartLimits;
use crate::hub::store::{HubDb, StoreError};

/// What the admin set, and why starts are held back.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    /// Labels every machine this hub makes: `fleetd.hub=<hub_id>`.
    pub hub_id: String,
    pub enabled: bool,
    pub pool_size: u32,
    pub machine_type: String,
    pub day_budget: f64,
    /// None: the plan's included dollars.
    pub month_budget: Option<f64>,
    pub projects: Vec<ProjectRef>,
    pub environment: Option<String>,
    pub has_key: bool,
    /// `billing` or `key`, with its line: held until a sweep's /limits says boat can start, or the admin resumes.
    pub paused: Option<(String, String)>,
    pub hold_until: Option<i64>,
    pub hold_reason: Option<String>,
    pub backoff_step: u32,
    /// boat's machines-at-once limit is full: no start until one of ours stops.
    pub full: bool,
    /// The plan's included starts, as /limits last said.
    pub starts: Option<StartLimits>,
    pub plan_dollars: Option<f64>,
    pub strangers_warned: bool,
    /// Writers may run on cloud machines too; off until the admin turns it on (reviews and readers go first).
    pub writers: bool,
}

/// The included dollars of boat's $20 plan, the month budget before /limits was ever read.
pub const PLAN_DOLLARS_UNKNOWN: f64 = 20.0;

impl Settings {
    /// The month budget: the admin's, else the plan's included dollars.
    pub fn month_budget(&self) -> f64 {
        self.month_budget
            .or(self.plan_dollars)
            .unwrap_or(PLAN_DOLLARS_UNKNOWN)
    }
}

/// What the admin may change (Settings › Cloud, the setup step).
#[derive(Clone, Debug, PartialEq)]
pub struct SettingsChange {
    pub enabled: bool,
    pub pool_size: u32,
    pub machine_type: String,
    pub day_budget: f64,
    pub month_budget: Option<f64>,
    pub projects: Vec<ProjectRef>,
    pub environment: Option<String>,
}

/// boat's machine sizes, each with its list price an hour.
pub const MACHINE_TYPES: [(&str, f64); 4] = [
    ("small", 0.018),
    ("default", 0.036),
    ("large", 0.072),
    ("xlarge", 0.200),
];

/// Dollars an hour for `kind`; an unknown size counts as the dearest.
pub fn price_per_hour(kind: &str) -> f64 {
    MACHINE_TYPES
        .iter()
        .find(|(k, _)| *k == kind)
        .map_or(MACHINE_TYPES[3].1, |(_, p)| *p)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// Created, not yet heard from.
    Creating,
    /// Resumed, not yet heard from.
    Waking,
    Awake,
    /// A stop was sent; asleep once boat says archived.
    Stopping,
    Asleep,
    /// Two wakes in a row brought no hello: never woken again until the admin resets it.
    Broken,
    /// Its create failed, or it never said hello.
    Failed,
    /// boat no longer has it.
    Gone,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Creating => "creating",
            State::Waking => "waking",
            State::Awake => "awake",
            State::Stopping => "stopping",
            State::Asleep => "asleep",
            State::Broken => "broken",
            State::Failed => "failed",
            State::Gone => "gone",
        }
    }

    fn parse(s: &str) -> State {
        match s {
            "creating" => State::Creating,
            "waking" => State::Waking,
            "awake" => State::Awake,
            "stopping" => State::Stopping,
            "asleep" => State::Asleep,
            "broken" => State::Broken,
            "failed" => State::Failed,
            _ => State::Gone,
        }
    }

    /// Whether the hub wants the machine running.
    pub fn wanted(self) -> bool {
        matches!(self, State::Creating | State::Waking | State::Awake)
    }
}

/// One slot's row.
#[derive(Clone, Debug, PartialEq)]
pub struct Slot {
    /// Also its machine id: `boat-1`.
    pub slot: String,
    pub sandbox_id: Option<String>,
    pub state: State,
    /// The current create attempt's Idempotency-Key and `fleetd.attempt` label.
    pub idem_key: Option<String>,
    /// The attempt's body, sealed to the hub's box key, while boat hasn't answered it.
    pub create_body: Option<Vec<u8>>,
    pub body_until: Option<i64>,
    pub created_at: i64,
    pub awake_since: Option<i64>,
    pub wake_at: Option<i64>,
    pub wake_why: Option<String>,
    pub asleep_since: Option<i64>,
    pub lease_until: Option<i64>,
    pub renewed_at: Option<i64>,
    pub idle_since: Option<i64>,
    pub wake_failures: u32,
    pub note: Option<String>,
}

impl Slot {
    pub fn new(slot: &str, now: i64) -> Slot {
        Slot {
            slot: slot.to_owned(),
            sandbox_id: None,
            state: State::Failed,
            idem_key: None,
            create_body: None,
            body_until: None,
            created_at: now,
            awake_since: None,
            wake_at: None,
            wake_why: None,
            asleep_since: None,
            lease_until: None,
            renewed_at: None,
            idle_since: None,
            wake_failures: 0,
            note: None,
        }
    }
}

const SLOT_COLUMNS: &str = "slot, sandbox_id, state, idem_key, create_body, body_until, created_at, awake_since, \
    wake_at, wake_why, asleep_since, lease_until, renewed_at, idle_since, wake_failures, note";

fn slot_of(r: &Row) -> rusqlite::Result<Slot> {
    Ok(Slot {
        slot: r.get(0)?,
        sandbox_id: r.get(1)?,
        state: State::parse(&r.get::<_, String>(2)?),
        idem_key: r.get(3)?,
        create_body: r.get(4)?,
        body_until: r.get(5)?,
        created_at: r.get(6)?,
        awake_since: r.get(7)?,
        wake_at: r.get(8)?,
        wake_why: r.get(9)?,
        asleep_since: r.get(10)?,
        lease_until: r.get(11)?,
        renewed_at: r.get(12)?,
        idle_since: r.get(13)?,
        wake_failures: r.get(14)?,
        note: r.get(15)?,
    })
}

/// One window of the start budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Window {
    Minute,
    Hour,
    Day,
}

impl Window {
    pub const ALL: [Window; 3] = [Window::Minute, Window::Hour, Window::Day];

    pub fn ms(self) -> i64 {
        match self {
            Window::Minute => 60_000,
            Window::Hour => 3_600_000,
            Window::Day => 86_400_000,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Window::Minute => "minute",
            Window::Hour => "hour",
            Window::Day => "day",
        }
    }
}

#[derive(Clone)]
pub struct Ledger {
    db: Arc<HubDb>,
}

impl Ledger {
    pub fn new(db: Arc<HubDb>) -> Ledger {
        Ledger { db }
    }

    pub fn settings(&self) -> Result<Settings, StoreError> {
        self.db.with(|c| {
            c.query_row(
                "SELECT hub_id, enabled, pool_size, machine_type, day_budget, month_budget, projects, environment,
                        sealed_key IS NOT NULL, paused_kind, paused_reason, hold_until, hold_reason, backoff_step, full,
                        starts_minute, starts_hour, starts_day, plan_dollars, strangers_warned, writers
                 FROM pool_settings WHERE id = 1",
                [],
                |r| {
                    let projects: String = r.get(6)?;
                    let kind: Option<String> = r.get(9)?;
                    let reason: Option<String> = r.get(10)?;
                    let starts = match (r.get(15)?, r.get(16)?, r.get(17)?) {
                        (Some(per_minute), Some(per_hour), Some(per_day)) => Some(StartLimits {
                            per_minute,
                            per_hour,
                            per_day,
                        }),
                        _ => None,
                    };
                    Ok(Settings {
                        hub_id: r.get(0)?,
                        enabled: r.get(1)?,
                        pool_size: r.get(2)?,
                        machine_type: r.get(3)?,
                        day_budget: r.get(4)?,
                        month_budget: r.get(5)?,
                        projects: serde_json::from_str(&projects).unwrap_or_default(),
                        environment: r.get(7)?,
                        has_key: r.get(8)?,
                        paused: kind.map(|k| (k, reason.unwrap_or_default())),
                        hold_until: r.get(11)?,
                        hold_reason: r.get(12)?,
                        backoff_step: r.get(13)?,
                        full: r.get(14)?,
                        starts,
                        plan_dollars: r.get(18)?,
                        strangers_warned: r.get(19)?,
                        writers: r.get(20)?,
                    })
                },
            )
            .map_err(Into::into)
        })
    }

    pub fn change_settings(&self, s: &SettingsChange) -> Result<(), StoreError> {
        let projects = serde_json::to_string(&s.projects).unwrap_or_else(|_| "[]".into());
        self.db.with(|c| {
            c.execute(
                "UPDATE pool_settings SET enabled = ?1, pool_size = ?2, machine_type = ?3, day_budget = ?4,
                   month_budget = ?5, projects = ?6, environment = ?7 WHERE id = 1",
                params![
                    s.enabled,
                    s.pool_size,
                    s.machine_type,
                    s.day_budget,
                    s.month_budget,
                    projects,
                    s.environment
                ],
            )?;
            Ok(())
        })
    }

    /// Whether writers may run on cloud machines.
    pub fn set_writers(&self, on: bool) -> Result<(), StoreError> {
        self.exec(
            "UPDATE pool_settings SET writers = ?1 WHERE id = 1",
            params![on],
        )
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), StoreError> {
        self.exec(
            "UPDATE pool_settings SET enabled = ?1 WHERE id = 1",
            params![enabled],
        )
    }

    /// The boat key, sealed to the hub's box key; None forgets it.
    pub fn set_sealed_key(&self, sealed: Option<&[u8]>) -> Result<(), StoreError> {
        self.exec(
            "UPDATE pool_settings SET sealed_key = ?1, paused_kind = NULL, paused_reason = NULL WHERE id = 1",
            params![sealed],
        )
    }

    pub fn sealed_key(&self) -> Result<Option<Vec<u8>>, StoreError> {
        self.db.with(|c| {
            Ok(c.query_row(
                "SELECT sealed_key FROM pool_settings WHERE id = 1",
                [],
                |r| r.get(0),
            )?)
        })
    }

    pub fn set_paused(&self, paused: Option<(&str, &str)>) -> Result<(), StoreError> {
        self.exec(
            "UPDATE pool_settings SET paused_kind = ?1, paused_reason = ?2 WHERE id = 1",
            params![paused.map(|p| p.0), paused.map(|p| p.1)],
        )
    }

    /// boat's backoff: no start before `until`, for `reason`, at retry `step`.
    pub fn set_hold(
        &self,
        until: Option<i64>,
        reason: Option<&str>,
        step: u32,
    ) -> Result<(), StoreError> {
        self.exec(
            "UPDATE pool_settings SET hold_until = ?1, hold_reason = ?2, backoff_step = ?3 WHERE id = 1",
            params![until, reason, step],
        )
    }

    pub fn set_full(&self, full: bool) -> Result<(), StoreError> {
        self.exec(
            "UPDATE pool_settings SET full = ?1 WHERE id = 1",
            params![full],
        )
    }

    pub fn set_plan(
        &self,
        starts: Option<StartLimits>,
        plan_dollars: Option<f64>,
    ) -> Result<(), StoreError> {
        self.exec(
            "UPDATE pool_settings SET starts_minute = ?1, starts_hour = ?2, starts_day = ?3,
               plan_dollars = coalesce(?4, plan_dollars) WHERE id = 1",
            params![
                starts.map(|s| s.per_minute),
                starts.map(|s| s.per_hour),
                starts.map(|s| s.per_day),
                plan_dollars
            ],
        )
    }

    pub fn set_strangers_warned(&self, warned: bool) -> Result<(), StoreError> {
        self.exec(
            "UPDATE pool_settings SET strangers_warned = ?1 WHERE id = 1",
            params![warned],
        )
    }

    pub fn slots(&self) -> Result<Vec<Slot>, StoreError> {
        self.db.with(|c| {
            let mut stmt = c.prepare(&format!(
                "SELECT {SLOT_COLUMNS} FROM pool_machines ORDER BY slot"
            ))?;
            let rows = stmt.query_map([], slot_of)?.collect::<Result<_, _>>()?;
            Ok(rows)
        })
    }

    pub fn slot(&self, slot: &str) -> Result<Option<Slot>, StoreError> {
        self.db.with(|c| slot_in(c, slot))
    }

    /// Writes the whole row.
    pub fn put(&self, s: &Slot) -> Result<(), StoreError> {
        self.db.with(|c| {
            c.execute(
                &format!(
                    "INSERT OR REPLACE INTO pool_machines ({SLOT_COLUMNS})
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)"
                ),
                params![
                    s.slot,
                    s.sandbox_id,
                    s.state.as_str(),
                    s.idem_key,
                    s.create_body,
                    s.body_until,
                    s.created_at,
                    s.awake_since,
                    s.wake_at,
                    s.wake_why,
                    s.asleep_since,
                    s.lease_until,
                    s.renewed_at,
                    s.idle_since,
                    s.wake_failures,
                    s.note
                ],
            )?;
            Ok(())
        })
    }

    /// Counts a start before its call; returns its row, to mark refused if boat clearly didn't count it.
    pub fn count_start(&self, slot: &str, what: &str, at: i64) -> Result<i64, StoreError> {
        self.db.with(|c| {
            c.execute(
                "INSERT INTO pool_starts (at, slot, what) VALUES (?1, ?2, ?3)",
                params![at, slot, what],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    pub fn uncount_start(&self, row: i64) -> Result<(), StoreError> {
        self.exec(
            "UPDATE pool_starts SET refused = 1 WHERE rowid = ?1",
            params![row],
        )
    }

    /// Starts counted in `window` up to `now`, and the oldest of them.
    pub fn starts_in(&self, window: Window, now: i64) -> Result<(u32, Option<i64>), StoreError> {
        self.db.with(|c| {
            Ok(c.query_row(
                "SELECT count(*), min(at) FROM pool_starts WHERE refused = 0 AND at > ?1",
                params![now - window.ms()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
    }

    /// Opens a spend interval from `from` (before the call that starts the machine).
    pub fn open_spend(
        &self,
        slot: &str,
        sandbox_id: Option<&str>,
        from: i64,
        per_hour: f64,
    ) -> Result<i64, StoreError> {
        self.db.with(|c| {
            c.execute(
                "INSERT INTO pool_spend (slot, sandbox_id, from_ms, per_hour) VALUES (?1, ?2, ?3, ?4)",
                params![slot, sandbox_id, from, per_hour],
            )?;
            Ok(c.last_insert_rowid())
        })
    }

    /// Drops an interval whose start boat refused: no machine ran.
    pub fn drop_spend(&self, id: i64) -> Result<(), StoreError> {
        self.exec("DELETE FROM pool_spend WHERE id = ?1", params![id])
    }

    pub fn has_open_spend(&self, slot: &str) -> Result<bool, StoreError> {
        self.db.with(|c| {
            Ok(c.query_row(
                "SELECT 1 FROM pool_spend WHERE slot = ?1 AND until_ms IS NULL",
                params![slot],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
        })
    }

    pub fn close_spend(&self, slot: &str, at: i64) -> Result<(), StoreError> {
        self.exec(
            "UPDATE pool_spend SET until_ms = max(from_ms, ?2) WHERE slot = ?1 AND until_ms IS NULL",
            params![slot, at],
        )
    }

    /// Names the sandbox on the slot's intervals made before boat said its id.
    pub fn name_spend(&self, slot: &str, sandbox_id: &str) -> Result<(), StoreError> {
        self.exec(
            "UPDATE pool_spend SET sandbox_id = ?2 WHERE slot = ?1 AND sandbox_id IS NULL",
            params![slot, sandbox_id],
        )
    }

    /// fleetd's own meter per sandbox from `since` to `now`: each interval's overlap at its price (an open one runs
    /// to now). Intervals of a start whose id boat never said count under the slot's name.
    pub fn meter(&self, since: i64, now: i64) -> Result<Vec<(String, f64)>, StoreError> {
        self.db.with(|c| {
            let mut stmt = c.prepare(
                "SELECT coalesce(sandbox_id, slot), from_ms, coalesce(until_ms, ?2), per_hour FROM pool_spend
                 WHERE coalesce(until_ms, ?2) > ?1",
            )?;
            let rows = stmt.query_map(params![since, now], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, f64>(3)?))
            })?;
            let mut out: Vec<(String, f64)> = Vec::new();
            for row in rows {
                let (id, from, until, per_hour) = row?;
                let ms = (until.min(now) - from.max(since)).max(0);
                let dollars = per_hour * ms as f64 / 3_600_000.0;
                match out.iter_mut().find(|(k, _)| *k == id) {
                    Some((_, d)) => *d += dollars,
                    None => out.push((id, dollars)),
                }
            }
            Ok(out)
        })
    }

    pub fn set_boat_cost(
        &self,
        sandbox_id: &str,
        since: i64,
        dollars: f64,
    ) -> Result<(), StoreError> {
        self.exec(
            "INSERT OR REPLACE INTO pool_boat_cost (sandbox_id, since_ms, dollars) VALUES (?1, ?2, ?3)",
            params![sandbox_id, since, dollars],
        )
    }

    /// Spent since `since`: per sandbox, the higher of fleetd's meter and boat's own figure from that same start.
    pub fn spent(&self, since: i64, now: i64) -> Result<f64, StoreError> {
        let meter = self.meter(since, now)?;
        let boat: Vec<(String, f64)> = self.db.with(|c| {
            let mut stmt =
                c.prepare("SELECT sandbox_id, dollars FROM pool_boat_cost WHERE since_ms = ?1")?;
            let rows = stmt
                .query_map(params![since], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })?;
        let mut total: f64 = meter
            .iter()
            .map(|(id, ours)| {
                let theirs = boat.iter().find(|(b, _)| b == id).map_or(0.0, |b| b.1);
                ours.max(theirs)
            })
            .sum();
        total += boat
            .iter()
            .filter(|(id, _)| !meter.iter().any(|(m, _)| m == id))
            .map(|b| b.1)
            .sum::<f64>();
        Ok(total)
    }

    /// The sandboxes with any metered time since `since`.
    pub fn metered_since(&self, since: i64, now: i64) -> Result<Vec<String>, StoreError> {
        Ok(self
            .meter(since, now)?
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| id.starts_with("bx_"))
            .collect())
    }

    /// Forgets starts older than a day and spend older than 40 days.
    pub fn prune(&self, now: i64) -> Result<(), StoreError> {
        let old = now - 40 * 86_400_000;
        self.db.with(|c| {
            c.execute(
                "DELETE FROM pool_starts WHERE at <= ?1",
                params![now - Window::Day.ms()],
            )?;
            c.execute(
                "DELETE FROM pool_spend WHERE until_ms IS NOT NULL AND until_ms < ?1",
                params![old],
            )?;
            c.execute(
                "DELETE FROM pool_boat_cost WHERE since_ms < ?1",
                params![old],
            )?;
            Ok(())
        })
    }

    fn exec(&self, sql: &str, p: impl rusqlite::Params) -> Result<(), StoreError> {
        self.db.with(|c| {
            c.execute(sql, p)?;
            Ok(())
        })
    }
}

fn slot_in(c: &Connection, slot: &str) -> Result<Option<Slot>, StoreError> {
    Ok(c.query_row(
        &format!("SELECT {SLOT_COLUMNS} FROM pool_machines WHERE slot = ?1"),
        params![slot],
        slot_of,
    )
    .optional()?)
}
