//! Hub-owned wakes: stored in SQLite, scheduled on the hub clock, delivered through the write queue so a wake for an
//! offline machine waits for it. One scheduler task sleeps until the earliest active wake is due. A firing is a
//! turn, so one whose thread the usage layer holds (paused login, parked thread) stays due until the hold clears.
pub mod schedule;
pub mod tools;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use rand::RngCore;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::json;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::clock::Clock;
use crate::hub::queue::WriteQueue;
use crate::hub::queue::js_round;
use crate::hub::queue::ports::{UsageHold, emit, now_ms};
use crate::hub::store::{EventLog, HubDb, NewEvent};
use crate::hub::store::{iso_ms, parse_ms};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ThreadId, ThreadRef};
use fleetd_contracts::prim::NonEmpty;
pub use fleetd_contracts::wakes::{
    Wake, WakeAt, WakeCatchUp, WakeMessage, WakeSchedule, WakeState, WakeTarget,
};
use schedule::{next_run, validate};

fn state_str(state: WakeState) -> &'static str {
    match state {
        WakeState::Active => "active",
        WakeState::Done => "done",
        WakeState::Cancelled => "cancelled",
    }
}

fn thread_ref(target: &WakeTarget) -> ThreadRef {
    ThreadRef {
        machine_id: target.machine_id.clone(),
        thread_id: target.thread_id.clone(),
    }
}

/// wake_set's input (contracts WakeSetInput) plus the caller.
#[derive(Clone, Debug)]
pub struct WakeSet {
    pub target: WakeTarget,
    pub schedule: WakeSchedule,
    pub message: WakeMessage,
    pub once: bool,
    pub catch_up: WakeCatchUp,
    pub client_request_id: String,
    /// keyId of the caller.
    pub created_by: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeSetResult {
    pub wake_id: String,
    pub next_run_at: String,
}

#[derive(Clone, Debug, Default)]
pub struct WakeFilter {
    pub machine_id: Option<MachineId>,
    pub thread_id: Option<ThreadId>,
    pub state: Option<WakeState>,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct WakeInvalid {
    pub message: String,
}

/// A firing this much past its time follows the wake's catchUp: the hub was down, or the host slept.
pub const LATE_AFTER: Duration = Duration::from_secs(60);

pub struct Wakes {
    db: Arc<HubDb>,
    queue: Arc<WriteQueue>,
    events: Arc<EventLog>,
    usage: Arc<dyn UsageHold>,
    clock: Arc<dyn Clock>,
    /// Due wakes waiting for their thread's usage hold to clear.
    held: Mutex<HashSet<String>>,
    changed: watch::Sender<u64>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

fn decode(data: &str) -> Wake {
    serde_json::from_str(data).expect("stored wake decodes")
}

fn encode(wake: &Wake) -> String {
    serde_json::to_string(wake).expect("wake encodes")
}

impl Wakes {
    pub fn new(
        db: Arc<HubDb>,
        queue: Arc<WriteQueue>,
        events: Arc<EventLog>,
        usage: Arc<dyn UsageHold>,
        clock: Arc<dyn Clock>,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            queue,
            events,
            usage,
            clock,
            held: Mutex::new(HashSet::new()),
            changed: watch::channel(0).0,
            tasks: Mutex::new(Vec::new()),
        })
    }

    /// Starts the scheduler.
    pub fn start(self: &Arc<Self>) {
        let me = self.clone();
        self.tasks
            .lock()
            .expect("lock")
            .push(tokio::spawn(async move { me.scheduler().await }));
    }

    /// Stops the scheduler and any held firings (a hub shutdown).
    pub fn stop(&self) {
        for h in self.tasks.lock().expect("lock").drain(..) {
            h.abort();
        }
    }

    fn signal(&self) {
        self.changed.send_modify(|v| *v = v.wrapping_add(1));
    }

    fn held_json(&self) -> String {
        serde_json::to_string(&self.held.lock().expect("lock").iter().collect::<Vec<_>>())
            .expect("json")
    }

    /// Idempotent per (createdBy, clientRequestId): a retry returns the wake the first call made.
    pub fn set(&self, input: WakeSet) -> Result<WakeSetResult, WakeInvalid> {
        let existing: Option<String> = self.db.run(|db| {
            db.query_row(
                "SELECT data FROM wakes WHERE created_by = ? AND client_request_id = ?",
                params![input.created_by, input.client_request_id],
                |r| r.get(0),
            )
            .optional()
            .expect("sql")
        });
        if let Some(data) = existing {
            let wake = decode(&data);
            return Ok(WakeSetResult {
                wake_id: wake.wake_id.into_inner(),
                next_run_at: wake
                    .next_run_at
                    .or(wake.last_fired_at)
                    .unwrap_or_default()
                    .0,
            });
        }
        let now = now_ms(&*self.clock);
        let next = validate(&input.schedule)
            .and_then(|()| next_run(&input.schedule, now, None))
            .map_err(|e| WakeInvalid { message: e.0 })?;
        let Some(next) = next else {
            return Err(WakeInvalid {
                message: match &input.schedule {
                    WakeSchedule::At(WakeAt { at, .. }) => format!("{at} is in the past"),
                    _ => "this schedule never runs".into(),
                },
            });
        };
        let mut id = [0u8; 9];
        rand::thread_rng().fill_bytes(&mut id);
        let wake = Wake {
            wake_id: NonEmpty::unchecked(format!(
                "wk_{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(id)
            )),
            target: input.target,
            schedule: input.schedule,
            message: input.message,
            once: input.once,
            catch_up: input.catch_up,
            next_run_at: Some(iso_ms(next).into()),
            last_fired_at: None,
            created_by: input.created_by.clone(),
            state: WakeState::Active,
        };
        self.db.run(|db| db
            .execute(
                "INSERT INTO wakes (wake_id, created_by, client_request_id, machine_id, thread_id, state, next_run_ms, data)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    wake.wake_id.as_str(),
                    input.created_by,
                    input.client_request_id,
                    wake.target.machine_id.as_str(),
                    wake.target.thread_id.as_str(),
                    state_str(wake.state),
                    next,
                    encode(&wake)
                ],
            )
            .expect("sql"));
        self.signal();
        Ok(WakeSetResult {
            wake_id: wake.wake_id.into_inner(),
            next_run_at: iso_ms(next),
        })
    }

    /// Oldest first.
    pub fn list(&self, filter: &WakeFilter) -> Vec<Wake> {
        self.db.run(|db| {
        let mut stmt = db
            .prepare(
                "SELECT data FROM wakes
                 WHERE (?1 IS NULL OR machine_id = ?1) AND (?2 IS NULL OR thread_id = ?2) AND (?3 IS NULL OR state = ?3)
                 ORDER BY rowid",
            )
            .expect("sql");
        let (machine, thread) = (
            filter.machine_id.as_ref().map(|m| m.as_str()),
            filter.thread_id.as_ref().map(|t| t.as_str()),
        );
        stmt.query_map(params![machine, thread, filter.state.map(state_str)], |r| {
            r.get::<_, String>(0)
        })
        .expect("sql")
        .filter_map(Result::ok)
        .map(|d| decode(&d))
        .collect()
    })
    }

    fn row(&self, wake_id: &str) -> Option<(Wake, i64)> {
        self.db.run(|db| {
            db.query_row(
                "SELECT data, fired FROM wakes WHERE wake_id = ?",
                [wake_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()
            .expect("sql")
            .map(|(d, fired)| (decode(&d), fired))
        })
    }

    pub fn get(&self, wake_id: &str) -> Option<Wake> {
        self.row(wake_id).map(|(w, _)| w)
    }

    /// A no-op for a wake that is already done or cancelled.
    pub fn cancel(&self, wake_id: &str) {
        let Some(wake) = self.get(wake_id) else {
            return;
        };
        if wake.state != WakeState::Active {
            return;
        }
        let cancelled = Wake {
            next_run_at: None,
            state: WakeState::Cancelled,
            ..wake
        };
        self.db.run(|db| db
            .execute(
                "UPDATE wakes SET state = 'cancelled', next_run_ms = NULL, data = ? WHERE wake_id = ? AND state = 'active'",
                params![encode(&cancelled), wake_id],
            )
            .expect("sql"));
        self.signal();
    }

    /// The sweep's check: counts active wakes overdue by more than `older_than` and wakes the scheduler, which fires
    /// them per their catchUp. Firing from here instead would race the scheduler.
    pub fn sweep_overdue(&self, older_than: Duration) -> usize {
        let before = now_ms(&*self.clock) - older_than.as_millis() as i64;
        let n: i64 = self.db.run(|db| {
            db.query_row(
                "SELECT COUNT(*) FROM wakes WHERE state = 'active' AND next_run_ms < ?1
                   AND wake_id NOT IN (SELECT value FROM json_each(?2))",
                params![before, self.held_json()],
                |r| r.get(0),
            )
            .unwrap_or(0)
        });
        if n == 0 {
            return 0;
        }
        tracing::warn!(overdue = n, "sweep: wakes overdue; waking the scheduler");
        self.signal();
        n as usize
    }

    fn advance(&self, wake: &Wake, next: Option<i64>, fired: i64) {
        // Only an active wake moves on, so a cancel that lands mid-firing sticks.
        self.db.run(|db| db
            .execute(
                "UPDATE wakes SET state = ?, next_run_ms = ?, fired = ?, data = ? WHERE wake_id = ? AND state = 'active'",
                params![state_str(wake.state), next, fired, encode(wake), wake.wake_id.as_str()],
            )
            .expect("sql"));
    }

    /// Fires (or, when late with catchUp "skip", passes over) a due wake and schedules its next run. A wake whose
    /// thread is held by the usage layer is not fired: it stays due and fires once the hold clears. `after_hold` is
    /// that firing, which goes out whatever its catchUp, since the wait was fleetd's, not a missed run.
    async fn fire(
        self: &Arc<Self>,
        wake: Wake,
        fired: i64,
        after_hold: bool,
    ) -> Result<(), String> {
        if !after_hold && self.usage.hold(&thread_ref(&wake.target)).await.is_some() {
            self.hold_until_clear(wake);
            return Ok(());
        }
        let now = now_ms(&*self.clock);
        let scheduled_at = wake
            .next_run_at
            .clone()
            .ok_or("active wake without nextRunAt")?;
        let scheduled = parse_ms(scheduled_at.as_str()).ok_or("bad nextRunAt")?;
        let late_ms = now - scheduled;
        let late = !after_hold && late_ms >= LATE_AFTER.as_millis() as i64;
        let late_min = js_round(late_ms as f64 / 60_000.0);
        let next = if wake.once {
            None
        } else {
            next_run(&wake.schedule, now, Some(scheduled)).map_err(|e| e.0)?
        };
        let moved = Wake {
            next_run_at: next.map(|n| iso_ms(n).into()),
            state: if next.is_none() {
                WakeState::Done
            } else {
                WakeState::Active
            },
            ..wake.clone()
        };
        let next_note = next.map_or(String::new(), |n| format!("; next at {}", iso_ms(n)));
        let event = |kind: HubEventType, summary: String, data: serde_json::Value| NewEvent {
            at: iso_ms(now).into(),
            r#type: kind,
            machine_id: Some(wake.target.machine_id.clone()),
            project_id: None,
            thread_id: Some(wake.target.thread_id.clone()),
            summary,
            data: Some(data),
            attention: None,
        };

        if late && wake.catch_up == WakeCatchUp::Skip {
            self.advance(&moved, next, fired);
            emit(
                &self.events,
                event(
                    HubEventType::WakeMissed,
                    format!(
                        "Wake {} for thread {} missed its {} run by {late_min} min and was skipped{next_note}",
                        wake.wake_id, wake.target.thread_id, scheduled_at
                    ),
                    json!({ "wakeId": wake.wake_id, "scheduledAt": scheduled_at, "lateMin": late_min }),
                ),
            );
            return Ok(());
        }

        let n = fired + 1;
        let message = if after_hold {
            format!("(held {late_min} min by a usage pause) {}", wake.message)
        } else if late {
            format!("(late by {late_min} min) {}", wake.message)
        } else {
            wake.message.to_string()
        };
        // The id is stable per firing, so a firing retried after a crash reaches the thread once.
        let result = self
            .queue
            .send(
                &thread_ref(&wake.target),
                &message,
                &format!("wake:{}:{n}", wake.wake_id),
                Some(&wake.wake_id),
            )
            .await;
        let done = Wake {
            last_fired_at: Some(iso_ms(now).into()),
            ..moved
        };
        self.advance(&done, next, n);
        let outcome = match &result {
            Err(e) => format!("could not be delivered: {e}"),
            Ok(r) if r.queued => format!(
                "queued until {} (machine offline)",
                r.queued_until.clone().unwrap_or_default()
            ),
            Ok(_) => "delivered".into(),
        };
        let mut data = serde_json::Map::new();
        data.insert("wakeId".into(), json!(wake.wake_id));
        data.insert("n".into(), json!(n));
        data.insert("scheduledAt".into(), json!(scheduled_at));
        if late {
            data.insert("late".into(), json!(true));
            data.insert("lateMin".into(), json!(late_min));
        } else if after_hold {
            data.insert("heldMin".into(), json!(late_min));
        }
        match &result {
            Err(e) => {
                data.insert("delivered".into(), json!(false));
                data.insert("error".into(), json!(e.tag()));
            }
            Ok(r) => {
                data.insert("queued".into(), json!(r.queued));
                if let Some(u) = &r.queued_until {
                    data.insert("queuedUntil".into(), json!(u));
                }
                if let Some(run_id) = &r.run_id {
                    data.insert("runId".into(), json!(run_id));
                }
            }
        }
        let how = if late {
            format!(" {late_min} min late")
        } else if after_hold {
            format!(" after a {late_min} min usage hold")
        } else {
            String::new()
        };
        emit(
            &self.events,
            event(
                HubEventType::WakeFired,
                format!(
                    "Wake {} fired{how} for thread {}: {outcome}{next_note}",
                    wake.wake_id, wake.target.thread_id
                ),
                data.into(),
            ),
        );
        Ok(())
    }

    /// Takes the wake out of the schedule until its thread's usage hold clears, then fires it as it stands then.
    fn hold_until_clear(self: &Arc<Self>, wake: Wake) {
        let wake_id = wake.wake_id.to_string();
        if !self.held.lock().expect("lock").insert(wake_id.clone()) {
            return;
        }
        tracing::info!(wake_id = %wake_id, thread = %format!("{}/{}", wake.target.machine_id, wake.target.thread_id), "wake held by the usage layer until it clears");
        let me = self.clone();
        let handle = tokio::spawn(async move {
            me.usage.when_clear(&thread_ref(&wake.target)).await;
            // Cancelled while held: no longer active.
            if let Some((now, fired)) = me
                .row(&wake_id)
                .filter(|(w, _)| w.state == WakeState::Active)
                && let Err(error) = Box::pin(me.fire(now, fired, true)).await
            {
                tracing::error!(wake_id = %wake_id, error = %error, "held wake firing failed");
            }
            me.held.lock().expect("lock").remove(&wake_id);
            me.signal();
        });
        self.tasks.lock().expect("lock").push(handle);
    }

    /// Sleeps until the earliest active wake is due, or until a wake is set or cancelled.
    async fn scheduler(self: Arc<Self>) {
        let mut changed = self.changed.subscribe();
        loop {
            changed.borrow_and_update();
            let row: Option<(String, String, i64, i64)> = self.db.run(|db| db
                .query_row(
                    // Held wakes wait on the usage layer, not on the clock.
                    "SELECT wake_id, data, fired, next_run_ms FROM wakes
                     WHERE state = 'active' AND next_run_ms IS NOT NULL AND wake_id NOT IN (SELECT value FROM json_each(?1))
                     ORDER BY next_run_ms LIMIT 1",
                    [self.held_json()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()
                .expect("sql"));
            let Some((wake_id, data, fired, next_run_ms)) = row else {
                let _ = changed.changed().await;
                continue;
            };
            let wait = next_run_ms - now_ms(&*self.clock);
            if wait > 0 {
                tokio::select! {
                    () = self.clock.sleep(Duration::from_millis(wait as u64)) => {}
                    _ = changed.changed() => {}
                }
                continue;
            }
            let outcome = match serde_json::from_str::<Wake>(&data) {
                Ok(wake) => self.fire(wake, fired, false).await,
                Err(e) => Err(e.to_string()),
            };
            if let Err(error) = outcome {
                // Retiring it keeps one broken row from spinning the scheduler.
                tracing::error!(wake_id = %wake_id, error = %error, "wake firing failed; wake retired");
                let _ = self.db.run(|db| {
                    db.execute(
                        "UPDATE wakes SET state = 'done', next_run_ms = NULL WHERE wake_id = ?",
                        [&wake_id],
                    )
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::queue::DEFAULT_TTL;
    use crate::hub::queue::ports::NoHold;
    use crate::hub::queue::test_kit::*;

    const MIN: i64 = 60_000;

    fn t1() -> ThreadRef {
        tref("lab-a", "t1")
    }
    fn wake(schedule: WakeSchedule) -> WakeSet {
        WakeSet {
            target: WakeTarget {
                machine_id: t1().machine_id,
                thread_id: t1().thread_id,
            },
            schedule,
            message: WakeMessage::unchecked("check in"),
            once: true,
            catch_up: WakeCatchUp::FireOnce,
            client_request_id: "c1".into(),
            created_by: "key1".into(),
        }
    }
    fn sched(v: serde_json::Value) -> WakeSchedule {
        serde_json::from_value(v).unwrap()
    }
    fn in_a_minute() -> WakeSchedule {
        sched(json!({ "kind": "at", "at": iso_ms(NOW + MIN), "tz": "UTC" }))
    }
    fn hourly() -> WakeSchedule {
        sched(json!({ "kind": "every", "everySec": 3600 }))
    }

    /// A "hub process": queue plus wakes over the kit's database.
    fn start(kit: &Kit, usage: Arc<dyn UsageHold>) -> (Arc<WriteQueue>, Arc<Wakes>) {
        let queue = kit.queue(DEFAULT_TTL);
        let wakes = Wakes::new(
            kit.db.clone(),
            queue.clone(),
            kit.events.clone(),
            usage,
            kit.clock.clone(),
        );
        wakes.start();
        (queue, wakes)
    }
    fn stop((queue, wakes): (Arc<WriteQueue>, Arc<Wakes>)) {
        wakes.stop();
        queue.stop();
    }
    fn data(e: &fleetd_contracts::events::HubEvent) -> &serde_json::Value {
        e.data.as_ref().unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn fires_an_at_wake_on_time_with_a_per_firing_request_id() {
        let kit = Kit::new();
        kit.writer.go_live("lab-a");
        let (_q, wakes) = start(&kit, Arc::new(NoHold));
        let set = wakes.set(wake(in_a_minute())).unwrap();
        assert_eq!(set.next_run_at, iso_ms(NOW + MIN));
        kit.advance(Duration::from_secs(59)).await;
        assert!(kit.writer.sends().is_empty());
        kit.advance(Duration::from_secs(1)).await;
        assert_eq!(
            kit.writer.sends(),
            vec![(t1(), "check in".into(), format!("wake:{}:1", set.wake_id))]
        );
        let fired = &kit.events.of(HubEventType::WakeFired)[0];
        assert_eq!(fired.at.as_str(), iso_ms(NOW + MIN));
        assert_eq!(data(fired)["n"], 1);
        assert_eq!(data(fired)["queued"], false);
        assert_eq!(data(fired)["runId"], "run-1");
        assert!(data(fired).get("late").is_none());
        let after = wakes.get(&set.wake_id).unwrap();
        assert_eq!(
            (after.state, after.last_fired_at, after.next_run_at),
            (WakeState::Done, Some(iso_ms(NOW + MIN).into()), None)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn repeats_an_every_wake_on_its_grid() {
        let kit = Kit::new();
        kit.writer.go_live("lab-a");
        let (_q, wakes) = start(&kit, Arc::new(NoHold));
        let set = wakes
            .set(WakeSet {
                once: false,
                ..wake(hourly())
            })
            .unwrap();
        kit.advance(Duration::from_secs(7200)).await;
        let ids: Vec<_> = kit.writer.sends().into_iter().map(|s| s.2).collect();
        assert_eq!(
            ids,
            vec![
                format!("wake:{}:1", set.wake_id),
                format!("wake:{}:2", set.wake_id)
            ]
        );
        let after = wakes.get(&set.wake_id).unwrap();
        assert_eq!(
            (after.state, after.next_run_at),
            (WakeState::Active, Some(iso_ms(NOW + 180 * MIN).into()))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn fires_a_wake_missed_while_down_once_marked_late_keeping_its_grid() {
        let kit = Kit::new();
        kit.writer.go_live("lab-a");
        let before = start(&kit, Arc::new(NoHold));
        let set = before
            .1
            .set(WakeSet {
                once: false,
                ..wake(hourly())
            })
            .unwrap();
        stop(before);
        // Down from 10:00 to 13:20: the 11:00, 12:00 and 13:00 runs were missed.
        kit.advance(Duration::from_secs(200 * 60)).await;
        let (_q, wakes) = start(&kit, Arc::new(NoHold));
        settle().await;
        assert_eq!(
            kit.writer.sends(),
            vec![(
                t1(),
                "(late by 140 min) check in".into(),
                format!("wake:{}:1", set.wake_id)
            )]
        );
        let fired = &kit.events.of(HubEventType::WakeFired)[0];
        assert_eq!(
            (data(fired)["late"].clone(), data(fired)["lateMin"].clone()),
            (json!(true), json!(140))
        );
        assert_eq!(data(fired)["scheduledAt"], iso_ms(NOW + 60 * MIN));
        assert_eq!(
            wakes.get(&set.wake_id).unwrap().next_run_at,
            Some(iso_ms(NOW + 240 * MIN).into())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn skips_a_missed_run_with_catch_up_skip() {
        let kit = Kit::new();
        kit.writer.go_live("lab-a");
        let before = start(&kit, Arc::new(NoHold));
        let set = before
            .1
            .set(WakeSet {
                catch_up: WakeCatchUp::Skip,
                ..wake(in_a_minute())
            })
            .unwrap();
        stop(before);
        kit.advance(Duration::from_secs(30 * 60)).await;
        let (_q, wakes) = start(&kit, Arc::new(NoHold));
        settle().await;
        let all = kit.events.all();
        assert_eq!(
            all.iter().map(|e| e.r#type).collect::<Vec<_>>(),
            vec![HubEventType::WakeMissed]
        );
        assert_eq!(all[0].thread_id.as_ref().map(|t| t.as_str()), Some("t1"));
        assert_eq!(data(&all[0])["scheduledAt"], iso_ms(NOW + MIN));
        assert_eq!(data(&all[0])["lateMin"], 29);
        assert!(kit.writer.sends().is_empty());
        assert_eq!(wakes.get(&set.wake_id).unwrap().state, WakeState::Done);
    }

    #[tokio::test(start_paused = true)]
    async fn queues_a_firing_for_an_offline_machine() {
        let kit = Kit::new();
        let (_q, wakes) = start(&kit, Arc::new(NoHold));
        let set = wakes.set(wake(in_a_minute())).unwrap();
        kit.advance(Duration::from_secs(60)).await;
        let fired = &kit.events.of(HubEventType::WakeFired)[0];
        assert_eq!(data(fired)["queued"], true);
        assert_eq!(
            data(fired)["queuedUntil"],
            iso_ms(NOW + MIN + 24 * 60 * MIN)
        );
        kit.writer.go_live("lab-a");
        settle().await;
        let delivered = &kit.events.of(HubEventType::WriteDelivered)[0];
        assert_eq!(data(delivered)["wakeId"], set.wake_id);
        assert_eq!(
            data(delivered)["clientRequestId"],
            format!("wake:{}:1", set.wake_id)
        );
        assert_eq!(kit.writer.messages(), vec!["check in"]);
    }

    #[tokio::test(start_paused = true)]
    async fn holds_a_firing_during_a_usage_hold_then_delivers_once() {
        let kit = Kit::new();
        kit.writer.go_live("lab-a");
        let usage = Arc::new(FakeUsage::default());
        let (_q, wakes) = start(&kit, usage.clone());
        let set = wakes
            .set(WakeSet {
                catch_up: WakeCatchUp::Skip,
                ..wake(in_a_minute())
            })
            .unwrap();
        usage.hold_thread(&t1());
        kit.advance(Duration::from_secs(60)).await;
        // Not fired, not missed: still due, and the sweep does not count it as overdue.
        assert!(kit.writer.sends().is_empty());
        assert!(kit.events.all().is_empty());
        let still = wakes.get(&set.wake_id).unwrap();
        assert_eq!(
            (still.state, still.next_run_at),
            (WakeState::Active, Some(iso_ms(NOW + MIN).into()))
        );
        assert_eq!(wakes.sweep_overdue(Duration::ZERO), 0);

        kit.advance(Duration::from_secs(7200)).await;
        usage.release(&t1());
        settle().await;
        assert_eq!(
            kit.writer.sends(),
            vec![(
                t1(),
                "(held 120 min by a usage pause) check in".into(),
                format!("wake:{}:1", set.wake_id)
            )]
        );
        let all = kit.events.all();
        assert_eq!(
            all.iter().map(|e| e.r#type).collect::<Vec<_>>(),
            vec![HubEventType::WakeFired]
        );
        assert_eq!(
            (data(&all[0])["n"].clone(), data(&all[0])["heldMin"].clone()),
            (json!(1), json!(120))
        );
        assert!(data(&all[0]).get("late").is_none());
        assert_eq!(wakes.get(&set.wake_id).unwrap().state, WakeState::Done);
    }

    #[tokio::test(start_paused = true)]
    async fn follows_wall_clock_time_across_a_dst_change() {
        // Saturday 2026-10-24 10:00 UTC; London leaves BST on Sunday 10-25.
        let kit = Kit::at(parse_ms("2026-10-24T10:00:00Z").unwrap());
        kit.writer.go_live("lab-a");
        let (_q, wakes) = start(&kit, Arc::new(NoHold));
        let cron = sched(json!({ "kind": "cron", "cron": "0 9 * * *", "tz": "Europe/London" }));
        let set = wakes
            .set(WakeSet {
                once: false,
                ..wake(cron)
            })
            .unwrap();
        assert_eq!(set.next_run_at, "2026-10-25T09:00:00.000Z");
        kit.advance(Duration::from_secs(23 * 3600)).await;
        assert_eq!(kit.events.of(HubEventType::WakeFired).len(), 1);
        assert_eq!(
            wakes
                .get(&set.wake_id)
                .unwrap()
                .next_run_at
                .as_ref()
                .map(|t| t.as_str()),
            Some("2026-10-26T09:00:00.000Z")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn never_fires_a_cancelled_wake_and_dedupes_a_retried_set() {
        let kit = Kit::new();
        kit.writer.go_live("lab-a");
        let (_q, wakes) = start(&kit, Arc::new(NoHold));
        let first = wakes.set(wake(in_a_minute())).unwrap();
        assert_eq!(wakes.set(wake(in_a_minute())).unwrap(), first);
        assert_eq!(wakes.list(&WakeFilter::default()).len(), 1);
        wakes.cancel(&first.wake_id);
        kit.advance(Duration::from_secs(3600)).await;
        assert!(kit.writer.sends().is_empty());
        let cancelled = wakes.list(&WakeFilter {
            state: Some(WakeState::Cancelled),
            ..Default::default()
        });
        assert_eq!(
            cancelled
                .iter()
                .map(|w| w.wake_id.to_string())
                .collect::<Vec<_>>(),
            vec![first.wake_id]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_a_schedule_that_cannot_run() {
        let kit = Kit::new();
        let (_q, wakes) = start(&kit, Arc::new(NoHold));
        let refused = |s: WakeSchedule| wakes.set(wake(s)).unwrap_err().message;
        assert!(
            refused(sched(
                json!({ "kind": "at", "at": iso_ms(NOW - MIN), "tz": "UTC" })
            ))
            .contains("in the past")
        );
        assert_eq!(
            refused(sched(
                json!({ "kind": "cron", "cron": "0 0 30 2 *", "tz": "UTC" })
            )),
            "this schedule never runs"
        );
        assert!(
            refused(sched(
                json!({ "kind": "cron", "cron": "every day", "tz": "UTC" })
            ))
            .contains("5 fields")
        );
    }
}
