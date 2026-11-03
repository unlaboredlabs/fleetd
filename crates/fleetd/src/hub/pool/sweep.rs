//! The orphan sweep (reconcile), at hub start before any placement and then every 10 minutes: boat's own list of
//! every machine labelled `fleetd.hub=<this hub>`, in every state and across every page, against the ledger.
//!
//! | boat says | ledger says | Action |
//! |---|---|---|
//! | running | awake / waking / creating | leave it to the life loop (lease, hello, node vanished) |
//! | running | asleep, stopping, broken, failed, gone, or the pool off | stop |
//! | running, more than 2 min past its deadline | any | stop, and warn once: boat's auto-stop didn't fire |
//! | any | no row | adopt it if its `fleetd.attempt` matches a creating row with no id; else stop, then delete |
//! | stopped | awake / waking / stopping | asleep, the meter's interval closed |
//! | error / cancelled | any | gone |
//! | not listed | a row with an id | gone |
//! | — | creating, no id, its attempt not found | send its sealed body again under the same key while its token lives; else failed |
//!
//! A list that can't be read whole changes nothing. Machines with another hub's label are never touched. The sweep
//! also takes the plan's starts and dollars from `GET /limits`, lifts a billing or key pause once boat can start
//! again and a machines-at-once hold once it has room, warns once when boat runs more machines than the hub knows,
//! reads boat's cost into the meter, and wakes a slot that has slept 12 days (the keepalive).
use std::sync::atomic::Ordering;

use super::boat::{BoatError, Phase};
use super::ledger::State;
use super::{
    KEEPALIVE_AFTER_MS, LABEL_ATTEMPT, LABEL_HUB, OVERDUE_MS, Pool, Why, day_start, month_start,
};

pub const SWEEP_MS: i64 = 10 * 60_000;

pub async fn sweep(pool: &Pool) -> Result<(), String> {
    let s = pool.ledger.settings().map_err(|e| e.to_string())?;
    if !s.has_key {
        pool.ready.store(true, Ordering::SeqCst);
        return Ok(());
    }
    let limits = match pool.boat.limits().await {
        Ok(l) => l,
        Err(e) => {
            if matches!(e, BoatError::KeyRefused { .. } | BoatError::NoKey(_)) {
                pool.back_off(&e);
            }
            return Err(e.line());
        }
    };
    pool.ledger
        .set_plan(limits.start_limits, limits.sandbox_plan_dollars)
        .map_err(|e| e.to_string())?;
    if limits.can_start && s.paused.is_some() {
        tracing::info!("pool: boat.dev can start again; bursting resumes");
        pool.ledger.set_paused(None).map_err(|e| e.to_string())?;
    }
    // boat's machines-at-once limit: held only while /limits still shows it full. Machines the person runs outside the
    // pool may have filled it, and none of ours stopping would ever lift it; a member cap /limits doesn't show is
    // tried again at the next start, which boat refuses without counting it.
    if s.full && limits.active_sandboxes < limits.max_active_sandboxes {
        tracing::info!("pool: boat.dev has room for a machine again");
        pool.ledger.set_full(false).map_err(|e| e.to_string())?;
    }
    let labels = [(LABEL_HUB.to_owned(), s.hub_id.clone())];
    let list = pool.boat.list(&labels).await.map_err(|e| e.line())?;
    let now = pool.now();
    let mut seen: Vec<String> = Vec::new();
    let mut up = 0_u32;
    for sb in list {
        // Only this hub's machines, whatever boat's filter did.
        if sb.label(LABEL_HUB) != Some(s.hub_id.as_str()) {
            continue;
        }
        seen.push(sb.id.clone());
        let phase = sb.phase();
        if phase == Phase::Up {
            up += 1;
        }
        let rows = pool.ledger.slots().map_err(|e| e.to_string())?;
        let mut row = rows
            .iter()
            .find(|r| r.sandbox_id.as_deref() == Some(sb.id.as_str()))
            .cloned();
        if row.is_none() {
            // A create whose answer was lost: its attempt label finds its row.
            let attempt = sb.label(LABEL_ATTEMPT);
            if let Some(mut r) = rows
                .iter()
                .find(|r| {
                    r.sandbox_id.is_none()
                        && r.state == State::Creating
                        && r.idem_key.as_deref() == attempt
                })
                .cloned()
            {
                tracing::info!(
                    slot = r.slot,
                    sandbox = sb.id,
                    "pool: adopted a create whose answer was lost"
                );
                r.sandbox_id = Some(sb.id.clone());
                r.create_body = None;
                pool.ledger.put(&r).map_err(|e| e.to_string())?;
                pool.ledger
                    .name_spend(&r.slot, &sb.id)
                    .map_err(|e| e.to_string())?;
                row = Some(r);
            }
        }
        let Some(found) = row else {
            // An orphan: this hub's label, no row. Stop it; once stopped, delete it.
            tracing::warn!(
                sandbox = sb.id,
                state = sb.state,
                "pool: a machine the ledger doesn't know"
            );
            let result = match phase {
                Phase::Up => pool.send_stop(&sb.id, None).await,
                Phase::Stopping => Ok(()),
                Phase::Stopped | Phase::Dead => {
                    pool.boat.delete(&sb.id).await.map_err(|e| e.line())
                }
            };
            if let Err(e) = result {
                tracing::warn!(sandbox = sb.id, error = e, "pool: orphan not stopped");
            }
            continue;
        };
        // Under the slot's lock, the row as it is now: a wake or create may have moved it since the list.
        let lock = pool.lock(&found.slot);
        let _held = lock.lock().await;
        let Some(row) = pool.ledger.slot(&found.slot).map_err(|e| e.to_string())? else {
            continue;
        };
        if row.sandbox_id.as_deref() != Some(sb.id.as_str()) {
            continue;
        }
        match phase {
            Phase::Up => {
                let overdue = sb
                    .archive_after_ms()
                    .is_some_and(|at| now - at > OVERDUE_MS);
                if overdue {
                    pool.warn_once(
                        format!("overdue {}", sb.id),
                        "boat.dev ran a machine past its deadline; stopped it",
                    );
                }
                if overdue || !s.enabled || !row.state.wanted() {
                    let to = match row.state {
                        State::Broken | State::Failed => row.state,
                        _ => State::Stopping,
                    };
                    let why = if s.enabled {
                        "boat ran it while the hub didn't want it"
                    } else {
                        "cloud machines are off"
                    };
                    if let Err(e) = pool.stop(&row.slot, to, why).await {
                        tracing::warn!(slot = row.slot, error = e, "pool: stop refused");
                    }
                }
            }
            Phase::Stopped => {
                if row.state == State::Creating {
                    // Its setup lease ended before a hello: the life loop's create timeout settles it.
                    continue;
                }
                // A wanted machine is asked again: a resume may have gone out since the list was read.
                let stopped = !row.state.wanted()
                    || matches!(pool.boat.get(&sb.id).await, Ok(fresh) if fresh.phase() == Phase::Stopped);
                let open = pool
                    .ledger
                    .has_open_spend(&row.slot)
                    .map_err(|e| e.to_string())?;
                if stopped && (row.state.wanted() || row.state == State::Stopping || open) {
                    pool.asleep(row).map_err(|e| e.to_string())?;
                }
            }
            Phase::Stopping => {}
            Phase::Dead => pool
                .gone(&row.slot, "boat.dev lost it")
                .map_err(|e| e.to_string())?,
        }
    }
    // Rows whose machine boat no longer lists.
    for row in pool.ledger.slots().map_err(|e| e.to_string())? {
        let Some(id) = row.sandbox_id.clone().filter(|id| !seen.contains(id)) else {
            continue;
        };
        // Asked by id first: a create may have kept its id after the list was read.
        let lock = pool.lock(&row.slot);
        let _held = lock.lock().await;
        if let Err(BoatError::NotFound) = pool.boat.get(&id).await {
            pool.gone(&row.slot, "boat.dev no longer has it")
                .map_err(|e| e.to_string())?;
        }
    }
    retry_creates(pool, now).await?;
    // boat runs machines this hub doesn't know of (another hub on the account, or the person's own): warn once.
    let strangers = limits.active_sandboxes > up;
    if strangers && !s.strangers_warned {
        tracing::warn!(
            boat = limits.active_sandboxes,
            ours = up,
            "pool: boat.dev runs machines this hub didn't make; they share its start limits"
        );
    }
    if strangers != s.strangers_warned {
        pool.ledger
            .set_strangers_warned(strangers)
            .map_err(|e| e.to_string())?;
    }
    reconcile_cost(pool, now).await;
    pool.ledger.prune(now).map_err(|e| e.to_string())?;
    // The sweep got through: placement may use the pool. Then the keepalive, which places a wake of its own.
    pool.ready.store(true, Ordering::SeqCst);
    keepalive(pool, now).await;
    Ok(())
}

/// A create with no id and no machine found under its attempt label: its sealed body again, under the same key,
/// while its enroll token lives (within 24 h boat returns the same machine and spends no second start); else failed.
async fn retry_creates(pool: &Pool, now: i64) -> Result<(), String> {
    for row in pool.ledger.slots().map_err(|e| e.to_string())? {
        let lock = pool.lock(&row.slot);
        let _held = lock.lock().await;
        let Some(row) = pool.ledger.slot(&row.slot).map_err(|e| e.to_string())? else {
            continue;
        };
        if row.state != State::Creating || row.sandbox_id.is_some() {
            continue;
        }
        let body = match (&row.create_body, &row.idem_key) {
            (Some(sealed), Some(key)) if row.body_until.is_some_and(|until| until > now) => pool
                .box_key()
                .ok()
                .and_then(|k| k.open(sealed))
                .map(|plain| (plain, key.clone())),
            _ => None,
        };
        match body {
            Some((plain, key)) => {
                let answer = pool.boat.create(&key, &plain).await;
                if let Err(e) = pool.created(&row.slot, answer, None) {
                    tracing::warn!(slot = row.slot, error = e, "pool: create retry");
                }
            }
            None => {
                let mut r = row.clone();
                r.state = State::Failed;
                r.create_body = None;
                r.note =
                    Some("its create got no answer, and boat.dev has no machine for it".into());
                pool.ledger.put(&r).map_err(|e| e.to_string())?;
                pool.ledger
                    .close_spend(&row.slot, now)
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// boat's own cost for each machine that ran today or this month, since the same start as the meter's: where it is
/// higher, [`super::ledger::Ledger::spent`] takes it.
async fn reconcile_cost(pool: &Pool, now: i64) {
    for since in [day_start(now, pool.zone), month_start(now, pool.zone)] {
        let ids = pool.ledger.metered_since(since, now).unwrap_or_default();
        for id in ids {
            match pool.boat.usage(&id, since).await {
                Ok(dollars) => {
                    if let Err(e) = pool.ledger.set_boat_cost(&id, since, dollars) {
                        tracing::error!(error = %e, "pool: boat's cost not kept");
                    }
                }
                Err(e) => tracing::warn!(sandbox = id, error = ?e, "pool: boat's cost unread"),
            }
        }
    }
}

/// Wakes each slot asleep 12 days, so boat keeps its disk; it stops again 5 minutes after its node is idle.
async fn keepalive(pool: &Pool, now: i64) {
    let Ok(rows) = pool.ledger.slots() else {
        return;
    };
    for row in rows {
        let due = row.state == State::Asleep
            && row.sandbox_id.is_some()
            && row
                .asleep_since
                .is_some_and(|at| now - at >= KEEPALIVE_AFTER_MS);
        if due && let Err(e) = pool.wake(&row.slot, Why::Keepalive).await {
            tracing::warn!(slot = row.slot, error = e, "pool: keepalive wake held back");
        }
    }
}
