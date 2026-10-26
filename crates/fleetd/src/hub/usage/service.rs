//! The usage layer (M4). A lead or task thread that hits a usage limit is parked and sent one "continue" at its
//! reset, leads first, then reviews, then writers. When one machine's login fails the same way on two threads within
//! 10 minutes (or its proxy has no account at all), a breaker pauses new turns there with one plain usage.breaker
//! event, until the reset or usage_resume. A limit whose message names no reset is never given a made-up one: fleetd
//! tries one parked thread after 1, 2, 5, 10 and then every 15 minutes, and lifts the pause once that thread's turn
//! completes (a start proves nothing: claude may still be retrying the 429 inside it). Any turn that completes on the
//! login after such a limit, on whatever model, lifts it at once, the lead's own included; a known reset waits for
//! itself, and a proxy with no account for usage_resume. The state is rebuilt from the event log at start, so a hub
//! restart keeps it.
use super::classify::{UsageClass, UsageParked, limit_of_event};
use super::ports::{BoxFut, EventLog, NewEvent, ThreadRef, WaitInput};
use super::source::{LoginKind, UsageReading};
use super::state::{Owner, ParkedCounts, ParkedThread, Resumed, UsageState, resumed_event};
use crate::clock::Clock;
use crate::hub::store::{iso_ms, parse_ms, system_ms};
use fleetd_contracts::events::{HubEvent, HubEventType};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const REPLAYED: &[&str] = &[
    "thread.usage_limited",
    "thread.started",
    "thread.completed",
    "thread.failed",
    "thread.interrupted",
    "usage.breaker",
    "usage.resumed",
];
const FOLLOWED: &[&str] = &[
    "thread.usage_limited",
    "thread.started",
    "thread.completed",
    "thread.failed",
    "thread.interrupted",
];

/// Who owns a thread, and whether a park still stands.
pub trait UsageOwners: Send + Sync {
    /// A task's thread (with its kind and id) or a lead's current thread; `None` for any other thread.
    fn owner_of(&self, thread: &ThreadRef) -> BoxFut<'_, Option<Owner>>;
    /// The task has not ended or been cancelled; for a lead, the thread is still its current one.
    fn still_parked(&self, parked: &ParkedThread) -> BoxFut<'_, bool>;
}

/// The write queue's `send` of the `usage.continue` prompt, rendered from the thread's own texts: delivered once per
/// `client_message_id`.
pub trait UsageQueue: Send + Sync {
    fn send_continue(
        &self,
        thread: &ThreadRef,
        client_message_id: &str,
    ) -> BoxFut<'_, Result<(), String>>;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreaker {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class: Option<UsageClass>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatus {
    pub machine_id: String,
    pub login: LoginKind,
    pub breaker: UsageBreaker,
    pub parked: ParkedCounts,
    pub last_events: Vec<HubEvent>,
}

pub struct UsageDeps {
    pub events: Arc<dyn EventLog>,
    pub queue: Arc<dyn UsageQueue>,
    pub owners: Arc<dyn UsageOwners>,
    pub clock: Arc<dyn Clock>,
}

struct Inner {
    deps: UsageDeps,
    state: Mutex<UsageState>,
    /// Serialises the follower, `drain`, resets and `resume`. `gate` and `hold` only read.
    op: tokio::sync::Mutex<u64>,
}

#[derive(Clone)]
pub struct Usage {
    inner: Arc<Inner>,
}

impl Usage {
    pub fn new(deps: UsageDeps) -> Self {
        Usage {
            inner: Arc::new(Inner {
                deps,
                state: Mutex::default(),
                op: tokio::sync::Mutex::new(0),
            }),
        }
    }

    /// Replays the log, schedules every pending reset, then follows the log from where the replay stopped. Runs
    /// until the hub stops; `drain`, `status` and `resume` wait for the replay.
    pub async fn serve(&self) {
        {
            let mut op = self.inner.op.lock().await;
            let mut cursor = 0;
            loop {
                let page = self
                    .inner
                    .deps
                    .events
                    .wait(WaitInput {
                        cursor,
                        types: REPLAYED.to_vec(),
                        timeout_sec: 0,
                        ..Default::default()
                    })
                    .await;
                for event in &page.events {
                    self.apply(event).await;
                }
                cursor = page.cursor;
                if !page.more {
                    break;
                }
            }
            *op = cursor;
            let resets: Vec<String> = {
                let s = self.inner.state.lock().unwrap();
                s.machines
                    .values()
                    .filter_map(|m| m.breaker.as_ref())
                    .flat_map(|b| [b.until.clone(), b.check_at.clone()])
                    .chain(
                        s.all_parked()
                            .flat_map(|p| [p.parked.resume_at.clone(), p.parked.check_at.clone()]),
                    )
                    .flatten()
                    .collect()
            };
            for at in resets {
                self.schedule(&at);
            }
        }
        loop {
            let cursor = *self.inner.op.lock().await;
            self.inner
                .deps
                .events
                .wait(WaitInput {
                    cursor,
                    types: FOLLOWED.to_vec(),
                    timeout_sec: 3600,
                    ..Default::default()
                })
                .await;
            self.drain().await;
        }
    }

    fn now_ms(&self) -> i64 {
        system_ms(self.inner.deps.clock.now())
    }

    async fn apply(&self, event: &HubEvent) {
        let owner = match (event.r#type, &event.machine_id, &event.thread_id) {
            (HubEventType::ThreadUsageLimited, Some(m), Some(t))
                if limit_of_event(event).is_some() =>
            {
                self.inner
                    .deps
                    .owners
                    .owner_of(&ThreadRef {
                        machine_id: m.to_string(),
                        thread_id: t.to_string(),
                    })
                    .await
            }
            _ => None,
        };
        self.inner.state.lock().unwrap().apply(event, owner);
    }

    async fn emit(&self, event: NewEvent) {
        let appended = self.inner.deps.events.append(event).await;
        self.apply(&appended).await;
    }

    /// A tick at `at`. Timers are never cancelled: a tick with nothing due does nothing.
    fn schedule(&self, at: &str) {
        let wait = parse_ms(at).map_or(0, |t| (t - self.now_ms()).max(0));
        let usage = self.clone();
        tokio::spawn(async move {
            usage
                .inner
                .deps
                .clock
                .sleep(Duration::from_millis(wait as u64))
                .await;
            let _op = usage.inner.op.lock().await;
            usage.tick().await;
        });
    }

    /// Resumes whatever is due now: everything a lapsed breaker held, parks whose reset or check time has passed,
    /// and checks of breakers with no reset.
    async fn tick(&self) {
        let due = self.inner.state.lock().unwrap().due(self.now_ms());
        for d in due {
            if let Some(at) = &d.in_flight_until {
                self.schedule(at);
                continue;
            }
            if d.check && !d.breaker_cleared {
                self.check(&d.machine_id, d.threads).await;
                continue;
            }
            let by = if d.check || d.threads.iter().any(|p| p.parked.resume_at.is_none()) {
                "check"
            } else {
                "reset"
            };
            // A thread still limited parks again on its next turn, and on_live schedules its next check then.
            self.resume_threads(&d.machine_id, d.threads, d.breaker_cleared, by)
                .await;
        }
    }

    /// A check of a breaker with no reset: sends the first thread still parked "continue" and names it in a
    /// usage.resumed `check` event, which keeps the breaker open and sets the next check. Nothing else moves until
    /// that thread's turn completes. With nothing left to try, the breaker clears, and the queue's next turn tries the
    /// login itself.
    async fn check(&self, machine_id: &str, parked: Vec<ParkedThread>) {
        for p in UsageState::in_order(&parked) {
            self.inner.state.lock().unwrap().take(&p.thread);
            let Some(sent) = self.send_continue(&p).await else {
                continue;
            };
            if let Some(event) =
                resumed_event(machine_id, &iso_ms(self.now_ms()), &[sent], false, "check")
            {
                self.emit(event).await;
            }
            let next = self
                .inner
                .state
                .lock()
                .unwrap()
                .machines
                .get(machine_id)
                .and_then(|m| m.breaker.as_ref()?.check_at.clone());
            if let Some(at) = next {
                self.schedule(&at);
            }
            return;
        }
        if let Some(event) =
            resumed_event(machine_id, &iso_ms(self.now_ms()), &[], true, "unchecked")
        {
            self.emit(event).await;
        }
    }

    /// Sends one parked thread "continue", unless its task ended or its lead moved on.
    async fn send_continue(&self, p: &ParkedThread) -> Option<Resumed> {
        if !self.inner.deps.owners.still_parked(p).await {
            return None;
        }
        // The id names this park, so a resend after a restart is delivered once.
        let id = format!(
            "fleetd-usage:{}/{}:{}",
            p.thread.machine_id,
            p.thread.thread_id,
            parse_ms(&p.parked.since).unwrap_or(0)
        );
        if let Err(reason) = self.inner.deps.queue.send_continue(&p.thread, &id).await {
            tracing::warn!(thread = %format!("{}/{}", p.thread.machine_id, p.thread.thread_id), %reason, "usage: continue not delivered");
            return None;
        }
        Some(Resumed {
            thread_id: p.thread.thread_id.clone(),
            kind: p.kind.as_str(),
            task_id: p.task_id.clone(),
        })
    }

    /// Sends "continue" in priority order and reports it in one usage.resumed event. Returns how many went out.
    async fn resume_threads(
        &self,
        machine_id: &str,
        list: Vec<ParkedThread>,
        breaker_cleared: bool,
        by: &str,
    ) -> usize {
        let ordered = self.inner.state.lock().unwrap().take_in_order(&list);
        let mut sent = Vec::new();
        for p in ordered {
            if let Some(r) = self.send_continue(&p).await {
                sent.push(r);
            }
        }
        if let Some(event) = resumed_event(
            machine_id,
            &iso_ms(self.now_ms()),
            &sent,
            breaker_cleared,
            by,
        ) {
            self.emit(event).await;
        }
        sent.len()
    }

    async fn on_live(&self, event: &HubEvent) {
        let lifted = self.inner.state.lock().unwrap().lifted_by(event);
        self.apply(event).await;
        if let Some(l) = lifted {
            self.resume_threads(&l.machine_id, l.threads, l.breaker_cleared, "turn")
                .await;
            return;
        }
        let Some(machine_id) = event
            .machine_id
            .as_deref()
            .filter(|_| event.r#type == HubEventType::ThreadUsageLimited)
        else {
            return;
        };
        let trip = self
            .inner
            .state
            .lock()
            .unwrap()
            .trip(machine_id, &iso_ms(self.now_ms()));
        if let Some((breaker, until)) = trip {
            self.emit(breaker).await;
            if let Some(u) = until {
                self.schedule(&u);
            }
        }
        if let Some(resume_at) = limit_of_event(event).and_then(|l| l.resume_at) {
            self.schedule(&resume_at);
        }
        let check_at = event.thread_id.as_ref().and_then(|t| {
            let thread = ThreadRef {
                machine_id: machine_id.to_string(),
                thread_id: t.to_string(),
            };
            self.inner
                .state
                .lock()
                .unwrap()
                .parked(&thread)?
                .check_at
                .clone()
        });
        if let Some(at) = check_at {
            self.schedule(&at);
        }
        let breaker_check = self
            .inner
            .state
            .lock()
            .unwrap()
            .machines
            .get(machine_id)
            .and_then(|m| m.breaker.as_ref()?.check_at.clone());
        if let Some(at) = breaker_check {
            self.schedule(&at);
        }
    }

    /// Applies every followed event appended so far. The caller holds the op lock, whose value is the cursor.
    async fn pump(&self, cursor: &mut u64) {
        loop {
            let page = self
                .inner
                .deps
                .events
                .wait(WaitInput {
                    cursor: *cursor,
                    types: FOLLOWED.to_vec(),
                    timeout_sec: 0,
                    ..Default::default()
                })
                .await;
            for event in &page.events {
                self.on_live(event).await;
            }
            *cursor = page.cursor;
            if !page.more {
                return;
            }
        }
    }

    /// Applies the thread events appended so far, so a read right after them sees their effect.
    pub async fn drain(&self) {
        let mut cursor = self.inner.op.lock().await;
        self.pump(&mut cursor).await;
    }

    /// Why a new turn may not start on the machine now, as a queued reason ("usage: paused until …").
    pub fn gate(&self, machine_id: &str) -> Option<String> {
        self.inner
            .state
            .lock()
            .unwrap()
            .gate(machine_id, self.now_ms())
    }

    /// `gate`, or why this thread is parked. Lead wakes wait while it is set.
    pub fn hold(&self, thread: &ThreadRef) -> Option<String> {
        self.inner.state.lock().unwrap().hold(thread, self.now_ms())
    }

    pub fn parked_of(&self, thread: &ThreadRef) -> Option<UsageParked> {
        self.inner.state.lock().unwrap().parked(thread).cloned()
    }

    /// Returns once `hold` is clear for the thread.
    pub async fn when_clear(&self, thread: &ThreadRef) {
        loop {
            let head = self.inner.deps.events.head().await;
            if self.hold(thread).is_none() {
                return;
            }
            self.inner
                .deps
                .events
                .wait(WaitInput {
                    cursor: head,
                    types: vec!["usage.resumed", "thread.started"],
                    machine_id: Some(thread.machine_id.clone()),
                    timeout_sec: 3600,
                })
                .await;
        }
    }

    /// The machine's usage view; `reading` is its runner's login, failing when the machine is offline.
    pub async fn status(
        &self,
        machine_id: &str,
        reading: Result<UsageReading, String>,
    ) -> UsageStatus {
        self.drain().await;
        let s = self.inner.state.lock().unwrap();
        let m = s.machines.get(machine_id);
        let breaker = match m.and_then(|m| m.breaker.as_ref()) {
            None => UsageBreaker {
                state: "closed",
                class: None,
                since: None,
                until: None,
                check_at: None,
                proxy: None,
                message: None,
            },
            Some(b) => UsageBreaker {
                state: "open",
                class: Some(b.class),
                since: Some(b.since.clone()),
                until: b.until.clone(),
                check_at: b.check_at.clone(),
                proxy: b.proxy.then_some(true),
                message: Some(b.message.clone()),
            },
        };
        UsageStatus {
            machine_id: machine_id.to_string(),
            login: reading.map_or(LoginKind::Unknown, |r| r.login),
            breaker,
            parked: s.counts_on(machine_id),
            last_events: m.map(|m| m.last_events.clone()).unwrap_or_default(),
        }
    }

    /// usage_resume: closes the machine's breaker and sends "continue" to every thread parked there.
    pub async fn resume(&self, machine_id: &str, by: &str) -> usize {
        let mut cursor = self.inner.op.lock().await;
        self.pump(&mut cursor).await;
        let (cleared, parked) = {
            let s = self.inner.state.lock().unwrap();
            (
                s.machines
                    .get(machine_id)
                    .is_some_and(|m| m.breaker.is_some()),
                s.parked_on(machine_id),
            )
        };
        self.resume_threads(machine_id, parked, cleared, by).await
    }
}
