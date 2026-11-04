//! The life loop, every 30 s: each slot one step, under its lock.
//! - **Hello**: a creating or waking machine whose node has spoken since the call, and caught up since it linked
//!   (hub/cloud's catch-up: the hub's fleetd and Claude Code, and the hub's Claude configuration), is `awake`.
//! - **Wake timeout**: no hello and catch-up 5 minutes after a resume (15 after a create): stopped, and a wake failure counted;
//!   two in a row make the slot `broken`. A create that never said hello is deleted and `failed`.
//! - **Lease**: an awake machine's deadline is renewed every 10 minutes through [`lease::clamp`], and at once when the
//!   budget shortened it; when the clamp says stop, it is stopped.
//! - **Idle**: the node says not busy, and no placement claimed it, for 15 minutes (5 after a keepalive wake):
//!   stopped.
//! - **Node vanished**: boat runs it but its node has been silent 10 minutes while the hub hears other machines:
//!   stopped. Its tasks take the node-lost path and resume at the next wake.
//! - **The pool off**: an awake machine is stopped (the kill switch's sweep does it too).
//! - **Stopping**: boat is asked until it says archived; then `asleep`, and the meter's interval closes.
use std::time::Duration;

use super::boat::{BoatError, Phase};
use super::lease::{LEASE_S, Lease};
use super::ledger::{Settings, Slot, State};
use super::{
    BROKEN_AFTER, CLAIM_MS, CREATE_HELLO_MS, HELLO_MS, IDLE_GRACE_MS, KEEPALIVE_GRACE_MS, Pool,
    RENEW_MS, SILENT_MS,
};

pub const TICK: Duration = Duration::from_secs(30);

pub async fn tick(pool: &Pool) {
    let Ok(rows) = pool.ledger.slots() else {
        return tracing::error!("pool: ledger unreadable");
    };
    for row in rows {
        let lock = pool.lock(&row.slot);
        let _held = lock.lock().await;
        // Read again under the lock: a wake may have just written it.
        let Ok(Some(row)) = pool.ledger.slot(&row.slot) else {
            continue;
        };
        if let Err(e) = step(pool, row).await {
            tracing::warn!(error = %e, "pool: life step");
        }
    }
}

async fn step(pool: &Pool, row: Slot) -> Result<(), String> {
    let now = pool.now();
    let s = pool.ledger.settings().map_err(|e| e.to_string())?;
    let heard = |since: Option<i64>| match (pool.fleet.last_seen(&row.slot), since) {
        (Some(seen), Some(since)) => seen > since,
        _ => false,
    };
    match row.state {
        // Its node spoke since the call and caught up since it linked (hub/cloud): awake for work.
        State::Creating | State::Waking if heard(row.wake_at) && pool.fleet.ready(&row.slot) => {
            let mut row = row;
            row.state = State::Awake;
            row.awake_since = Some(now);
            row.wake_failures = 0;
            row.idle_since = None;
            row.create_body = None;
            row.note = None;
            pool.ledger.put(&row).map_err(|e| e.to_string())?;
            pool.fleet.woke(&row.slot);
            Ok(())
        }
        State::Creating => {
            if row.wake_at.is_some_and(|at| now - at > CREATE_HELLO_MS) {
                return never_joined(pool, row).await;
            }
            Ok(())
        }
        State::Waking => {
            if row.wake_at.is_some_and(|at| now - at > HELLO_MS) {
                let failures = row.wake_failures + 1;
                let mut r = row.clone();
                r.wake_failures = failures;
                pool.ledger.put(&r).map_err(|e| e.to_string())?;
                let (to, why) = if failures >= BROKEN_AFTER {
                    (
                        State::Broken,
                        format!("{} doesn't come back: Reset it?", row.slot),
                    )
                } else {
                    (
                        State::Stopping,
                        "no hello within 5 minutes of its wake".to_owned(),
                    )
                };
                return pool.stop(&row.slot, to, &why).await;
            }
            Ok(())
        }
        State::Awake => awake(pool, &s, row, now).await,
        State::Stopping | State::Broken | State::Failed => settle(pool, row).await,
        State::Asleep | State::Gone => Ok(()),
    }
}

async fn awake(pool: &Pool, s: &Settings, mut row: Slot, now: i64) -> Result<(), String> {
    let slot = row.slot.clone();
    if !s.enabled {
        return pool
            .stop(&slot, State::Stopping, "cloud machines are off")
            .await;
    }
    // Node vanished: silent 10 minutes, while the hub hears its other machines (a stalled hub hears none).
    let seen = pool
        .fleet
        .last_seen(&slot)
        .or(row.awake_since)
        .unwrap_or(now);
    if now - seen > SILENT_MS {
        let pool_slots: Vec<String> = pool
            .ledger
            .slots()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|r| r.slot)
            .collect();
        if pool.fleet.others_heard(&pool_slots, now) {
            return pool
                .stop(
                    &slot,
                    State::Stopping,
                    "its node went silent for 10 minutes",
                )
                .await;
        }
    }
    // Idle: the node not busy (a node that sends no busy flag counts as busy) and no claim, under the claims lock.
    let idle = {
        let claims = pool.claims.lock().unwrap();
        let claimed = claims.get(&slot).is_some_and(|at| now - at < CLAIM_MS);
        let busy = pool.fleet.busy(&slot).unwrap_or(true);
        let grace = if row.wake_why.as_deref() == Some("keepalive") {
            KEEPALIVE_GRACE_MS
        } else {
            IDLE_GRACE_MS
        };
        let before = row.idle_since;
        row.idle_since = if busy || claimed {
            None
        } else {
            Some(before.unwrap_or(now))
        };
        let idle = row.idle_since.is_some_and(|since| now - since >= grace);
        if idle {
            // The stopping write under the claims lock: a claim after it sees the machine isn't awake.
            row.state = State::Stopping;
            row.note = Some("idle".into());
            row.idle_since = None;
        }
        if idle || row.idle_since != before {
            pool.ledger.put(&row).map_err(|e| e.to_string())?;
        }
        idle
    };
    if idle {
        return pool.stop(&slot, State::Stopping, "idle").await;
    }
    renew(pool, s, row, now).await
}

/// The lease: renewed every 10 minutes, or at once when the clamp now gives an earlier deadline than boat holds;
/// stopped when the clamp says so.
async fn renew(pool: &Pool, s: &Settings, mut row: Slot, now: i64) -> Result<(), String> {
    let lease = pool.lease(s, LEASE_S, 0).map_err(|e| e.to_string())?;
    let ttl = match lease {
        Lease::Stop => {
            let why = pool
                .budget(s, now)
                .ok()
                .and_then(|b| b.line())
                .unwrap_or_else(|| "the budget is nearly spent".into());
            return pool.stop(&row.slot, State::Stopping, &why).await;
        }
        Lease::Renew(ttl) => ttl,
    };
    let due = row.renewed_at.is_none_or(|at| now - at >= RENEW_MS);
    let shorter = row
        .lease_until
        .is_some_and(|until| now + ttl.ms() + 30_000 < until);
    if !due && !shorter {
        return Ok(());
    }
    let Some(id) = row.sandbox_id.clone() else {
        return Ok(());
    };
    match pool.boat.set_ttl(&id, ttl).await {
        Ok(()) => {
            row.lease_until = Some(now + ttl.ms());
            row.renewed_at = Some(now);
            pool.ledger.put(&row).map_err(|e| e.to_string())
        }
        Err(BoatError::NotFound) => pool
            .gone(&row.slot, "boat.dev no longer has it")
            .map_err(|e| e.to_string()),
        // boat stops it at the old deadline if this never gets through.
        Err(e) => Err(format!("lease of {} not renewed: {}", row.slot, e.line())),
    }
}

/// A machine that is to stop (or never wake again): asked until boat says archived, then asleep with its meter
/// closed.
async fn settle(pool: &Pool, row: Slot) -> Result<(), String> {
    let open = pool
        .ledger
        .has_open_spend(&row.slot)
        .map_err(|e| e.to_string())?;
    if row.state != State::Stopping && !open {
        return Ok(());
    }
    let Some(id) = row.sandbox_id.clone() else {
        pool.ledger
            .close_spend(&row.slot, pool.now())
            .map_err(|e| e.to_string())?;
        return Ok(());
    };
    match pool.boat.get(&id).await {
        Ok(sb) => match sb.phase() {
            Phase::Stopped => pool.asleep(row).map_err(|e| e.to_string()),
            Phase::Dead => pool
                .gone(&row.slot, "boat.dev lost it")
                .map_err(|e| e.to_string()),
            Phase::Stopping => Ok(()),
            Phase::Up => pool.send_stop(&id, Some(&row.slot)).await,
        },
        Err(BoatError::NotFound) => pool
            .gone(&row.slot, "boat.dev no longer has it")
            .map_err(|e| e.to_string()),
        Err(e) => Err(e.line()),
    }
}

/// A create whose node never said hello within the enroll token's life: deleted (billing ends at once), `failed`,
/// with boat's setup error as its note.
async fn never_joined(pool: &Pool, mut row: Slot) -> Result<(), String> {
    let mut note = "no hello within 15 minutes of its create".to_owned();
    if let Some(id) = row.sandbox_id.clone() {
        if let Ok(sb) = pool.boat.get(&id).await
            && let Some(err) = sb.setup_error.filter(|e| !e.is_empty())
        {
            note = format!("its setup failed: {err}");
        }
        match pool.boat.delete(&id).await {
            Ok(()) => {
                pool.ledger
                    .close_spend(&row.slot, pool.now())
                    .map_err(|e| e.to_string())?;
                row.sandbox_id = None;
            }
            Err(e) => {
                // Stopped at least; the sweep deletes it.
                let _ = pool.boat.stop(&id).await;
                note = format!("{note} (delete refused: {})", e.line());
            }
        }
    }
    row.state = State::Failed;
    row.create_body = None;
    row.note = Some(note);
    pool.ledger.put(&row).map_err(|e| e.to_string())
}
