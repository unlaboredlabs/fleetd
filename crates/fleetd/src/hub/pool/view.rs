//! The pool as Settings › Hub › Machines and the setup step see it: the admin's Test (boat's answer to the hub's key, in
//! one line), each machine's state and spend today, the settings an admin may set, and Reset for a broken slot.
use fleetd_contracts::cloud::{
    BUDGET_MAX, CloudKeyTest, CloudMachine, CloudMachineState, CloudSettings, CloudSize, POOL_MAX,
};
use fleetd_contracts::node_link::NodeBusy;

use super::boat::{BoatError, Limits};
use super::ledger::{MACHINE_TYPES, SettingsChange, State};
use super::{LABEL_HUB, Pool, day_start, price_per_hour};
use crate::hub::store::StoreError;

/// The slots of a pool of `n`: `boat-1`…`boat-n`.
pub fn slot_names(n: u32) -> Vec<String> {
    (1..=n).map(|i| format!("boat-{i}")).collect()
}

/// What `n` machines of `kind` cost awake around the clock, a day: the most the pool size alone lets it spend.
pub fn ceiling(n: u32, kind: &str) -> f64 {
    f64::from(n) * price_per_hour(kind) * 24.0
}

/// boat's sizes with their list prices.
pub fn sizes() -> Vec<CloudSize> {
    MACHINE_TYPES
        .iter()
        .map(|(kind, per_hour)| CloudSize {
            kind: (*kind).to_owned(),
            per_hour: *per_hour,
        })
        .collect()
}

fn state(s: State) -> CloudMachineState {
    match s {
        State::Creating => CloudMachineState::Creating,
        State::Waking => CloudMachineState::Waking,
        State::Awake => CloudMachineState::Awake,
        State::Stopping => CloudMachineState::Stopping,
        State::Asleep => CloudMachineState::Asleep,
        State::Broken => CloudMachineState::Broken,
        State::Failed => CloudMachineState::Failed,
        State::Gone => CloudMachineState::Gone,
    }
}

/// `/limits` in one line: the plan, its starts, the machines running and whether the pool's size is allowed.
pub fn limits_line(l: &Limits, kind: &str) -> String {
    let mut parts = vec!["Key works".to_owned()];
    if let Some(d) = l.sandbox_plan_dollars {
        parts.push(format!("${d:.0} plan"));
    }
    if let Some(s) = l.start_limits {
        parts.push(format!(
            "{} starts a day ({} a minute)",
            s.per_day, s.per_minute
        ));
    }
    parts.push(format!(
        "{} of {} machines running",
        l.active_sandboxes, l.max_active_sandboxes
    ));
    match l.machine_types.iter().find(|t| t.kind == kind) {
        Some(t) if t.available => parts.push(format!("{kind} allowed")),
        Some(t) => parts.push(format!(
            "{kind} not allowed on this plan{}",
            t.reason
                .as_deref()
                .map(|r| format!(" ({r})"))
                .unwrap_or_default()
        )),
        None => {}
    }
    let mut line = parts.join(" · ");
    if !l.can_start {
        let why = l
            .start_blocked_reason
            .as_deref()
            .unwrap_or("it can't start machines now");
        line.push_str(&format!(". But boat.dev says: {why}"));
    }
    line
}

/// What a refusal of the hub's key means, in plain words.
pub fn key_words(e: &BoatError) -> String {
    match e {
        BoatError::KeyRefused { code } => match code.as_str() {
            "api_key_expired" => {
                "boat.dev says the key has expired: make a new one and paste it here".into()
            }
            "api_key_action_forbidden" => {
                "boat.dev refused an action this key lacks: give it account.read and sandbox.read, and the rest \
                 of the actions the setup step lists"
                    .into()
            }
            "api_key_sandbox_forbidden" => {
                "boat.dev says the key can't reach these machines: scope it to the fleetd environment".into()
            }
            "unauthorized" | "invalid_api_key" | "" => {
                "boat.dev doesn't know this key: check it was copied whole".into()
            }
            other => format!("boat.dev refused the key ({other})"),
        },
        BoatError::Billing { code, .. } => {
            format!("The key works, but boat.dev needs billing attention ({code})")
        }
        other => other.line(),
    }
}

impl Pool {
    /// What boat last said to the hub's key, since the hub started or the key changed.
    pub fn key_test(&self) -> Option<CloudKeyTest> {
        self.key_test.lock().unwrap().clone()
    }

    pub(super) fn heard(&self, test: Option<CloudKeyTest>) {
        *self.key_test.lock().unwrap() = test;
    }

    /// A sweep's `/limits`: the key works.
    pub(super) fn heard_limits(&self, limits: &Limits, kind: &str) {
        self.heard(Some(CloudKeyTest {
            ok: true,
            said: limits_line(limits, kind),
        }));
    }

    /// A refusal about the key itself; boat being down says nothing about it.
    pub(super) fn heard_refusal(&self, e: &BoatError) {
        if matches!(e, BoatError::KeyRefused { .. } | BoatError::Billing { .. }) {
            self.heard(Some(CloudKeyTest {
                ok: false,
                said: key_words(e),
            }));
        }
    }

    /// The admin's Test: `GET /limits` (the key's `account.read`) and the list of this hub's machines
    /// (`sandbox.read`). It starts nothing: a missing create or stop action shows at the first create.
    pub async fn test(&self) -> CloudKeyTest {
        let s = match self.ledger.settings() {
            Ok(s) => s,
            Err(e) => {
                return CloudKeyTest {
                    ok: false,
                    said: format!("the pool's ledger can't be read: {e}"),
                };
            }
        };
        if !s.has_key {
            return CloudKeyTest {
                ok: false,
                said: "No boat.dev key yet: paste one first.".into(),
            };
        }
        let fail = |e: &BoatError| {
            self.heard_refusal(e);
            CloudKeyTest {
                ok: false,
                said: key_words(e),
            }
        };
        let limits = match self.boat.limits().await {
            Ok(l) => l,
            Err(e) => return fail(&e),
        };
        if let Err(e) = self
            .ledger
            .set_plan(limits.start_limits, limits.sandbox_plan_dollars)
        {
            tracing::warn!(error = %e, "pool: plan not kept");
        }
        let labels = [(LABEL_HUB.to_owned(), s.hub_id.clone())];
        if let Err(e) = self.boat.list(&labels).await {
            return fail(&e);
        }
        self.heard_limits(&limits, &s.machine_type);
        self.key_test().unwrap_or(CloudKeyTest {
            ok: true,
            said: limits_line(&limits, &s.machine_type),
        })
    }

    /// The admin's settings, checked: a pool of 1 to [`POOL_MAX`], a size boat sells, budgets above 0 and at most
    /// [`BUDGET_MAX`], and an environment name boat takes.
    pub fn apply(&self, c: &CloudSettings) -> Result<(), String> {
        if c.pool_size == 0 || c.pool_size > POOL_MAX {
            return Err(format!("A pool holds 1 to {POOL_MAX} machines."));
        }
        if !MACHINE_TYPES.iter().any(|(k, _)| *k == c.machine_type) {
            let kinds: Vec<&str> = MACHINE_TYPES.iter().map(|(k, _)| *k).collect();
            return Err(format!(
                "boat.dev has no size {}: pick {}.",
                c.machine_type,
                kinds.join(", ")
            ));
        }
        let budget = |what: &str, d: f64| {
            if d.is_finite() && d > 0.0 && d <= BUDGET_MAX {
                Ok(())
            } else {
                Err(format!(
                    "The {what} budget is dollars above 0, at most ${BUDGET_MAX:.0}."
                ))
            }
        };
        budget("day", c.day_budget)?;
        if let Some(m) = c.month_budget {
            budget("month", m)?;
        }
        let environment = c
            .environment
            .as_deref()
            .map(str::trim)
            .filter(|e| !e.is_empty());
        if let Some(e) = environment
            && (e.len() > 64
                || !e
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'))
        {
            return Err(format!(
                "{e} isn't a boat.dev environment name: letters, digits, - and _."
            ));
        }
        let mut projects: Vec<_> = Vec::new();
        for p in &c.projects {
            if !projects.contains(p) {
                projects.push(p.clone());
            }
        }
        self.ledger
            .change_settings(&SettingsChange {
                enabled: c.enabled,
                pool_size: c.pool_size,
                machine_type: c.machine_type.clone(),
                day_budget: c.day_budget,
                month_budget: c.month_budget,
                projects,
                environment: environment.map(str::to_owned),
            })
            .map_err(|e| e.to_string())?;
        if let Some(on) = c.writers {
            self.ledger.set_writers(on).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// The slots of the pool's size that need a create: none made yet, or one that failed or boat no longer has.
    pub fn missing(&self) -> Result<Vec<String>, StoreError> {
        let s = self.ledger.settings()?;
        let rows = self.ledger.slots()?;
        Ok(slot_names(s.pool_size)
            .into_iter()
            .filter(|slot| match rows.iter().find(|r| &r.slot == slot) {
                None => true,
                Some(r) => r.sandbox_id.is_none() && matches!(r.state, State::Failed | State::Gone),
            })
            .collect())
    }

    /// Reset: deletes the slot's machine at boat (its disk, snapshots and keys go with it) and forgets it, so the next
    /// create makes it anew. A machine boat no longer has is simply forgotten.
    pub async fn retire(&self, slot: &str) -> Result<(), String> {
        let lock = self.lock(slot);
        let _held = lock.lock().await;
        let Some(mut row) = self.ledger.slot(slot).map_err(|e| e.to_string())? else {
            return Err(format!("{slot} isn't one of the hub's cloud machines"));
        };
        if row.state == State::Creating && row.sandbox_id.is_none() {
            return Err(format!(
                "{slot} is being created: wait until boat.dev answers"
            ));
        }
        if let Some(id) = row.sandbox_id.clone() {
            match self.boat.delete(&id).await {
                Ok(()) | Err(BoatError::NotFound) => {}
                Err(e) => {
                    // Stopped at least, so it costs nothing; Reset again deletes it.
                    let _ = self.boat.stop(&id).await;
                    return Err(e.line());
                }
            }
        }
        self.ledger
            .close_spend(slot, self.now())
            .map_err(|e| e.to_string())?;
        row.state = State::Gone;
        row.sandbox_id = None;
        row.create_body = None;
        row.idem_key = None;
        row.lease_until = None;
        row.renewed_at = None;
        row.awake_since = None;
        row.idle_since = None;
        row.wake_failures = 0;
        row.note = Some("reset: deleted at boat.dev".into());
        self.ledger.put(&row).map_err(|e| e.to_string())
    }

    /// Each slot of the ledger with its state, what runs there (`busy`, from its node's heartbeat) and its spend today.
    pub fn machines(
        &self,
        busy: impl Fn(&str) -> Option<NodeBusy>,
    ) -> Result<Vec<CloudMachine>, StoreError> {
        let now = self.now();
        let meter = self.ledger.meter(day_start(now, self.zone), now)?;
        let rows = self.ledger.slots()?;
        Ok(rows
            .into_iter()
            .filter_map(|r| {
                let machine_id = fleetd_contracts::ids::MachineId::new(&r.slot).ok()?;
                let today = meter
                    .iter()
                    .filter(|(id, _)| id == &r.slot || r.sandbox_id.as_deref() == Some(id.as_str()))
                    .map(|(_, d)| d)
                    .sum();
                let b = busy(&r.slot).unwrap_or_default();
                let running = matches!(r.state, State::Awake | State::Waking);
                let since_ms = match r.state {
                    State::Awake | State::Waking => r.awake_since.or(r.wake_at),
                    State::Asleep => r.asleep_since,
                    _ => None,
                };
                Some(CloudMachine {
                    machine_id,
                    state: state(r.state),
                    agents: if running { b.threads } else { 0 },
                    screens: if running { b.screens } else { 0 },
                    today,
                    since_ms,
                    note: r.note,
                })
            })
            .collect())
    }
}

/// What the doctor's `hub/cloud_*` checks read, once a boat.dev key is saved; None before.
pub fn facts(hub: &crate::hub::api::Hub) -> Option<crate::hub::doctor::checks::CloudFacts> {
    let pool = &hub.pool;
    let s = pool
        .ledger()
        .settings()
        .inspect_err(|e| tracing::warn!(error = %e, "cloud: the pool's settings not read"))
        .ok()?;
    if !s.has_key {
        return None;
    }
    let now = pool.now();
    let budget = pool.budget(&s, now).ok()?;
    let machines = pool
        .ledger()
        .slots()
        .ok()?
        .into_iter()
        .map(|r| (r.slot, state(r.state), r.note))
        .collect();
    Some(crate::hub::doctor::checks::CloudFacts {
        enabled: s.enabled,
        pool_size: s.pool_size,
        key_test: pool.key_test(),
        paused: s.paused.clone(),
        hub_url: crate::hub::cloud::setup::public_hub_url(hub),
        machines,
        spend: spend_line(
            budget.day_spent,
            budget.day_budget,
            budget.month_spent,
            budget.month_budget,
        ),
        over: budget.line().map(|l| {
            let mut c = l.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect())
                .unwrap_or_default()
        }),
    })
}

/// "Today $0.41 of $3.00 · this month $6.10 of $20.00".
pub fn spend_line(day: f64, day_budget: f64, month: f64, month_budget: f64) -> String {
    format!("Today ${day:.2} of ${day_budget:.2} · this month ${month:.2} of ${month_budget:.2}")
}
