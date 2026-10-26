//! The usage service over an in-memory event log and a manual clock: a real 2026-10-25 pause, where a proxy's
//! cooldown named no reset, every task parked for a made-up hour, and the lead's own turns kept succeeding on the
//! same login.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEvent;
use serde_json::{Value, json};

use super::ports::{BoxFut, EventLog, NewEvent, ThreadRef, WaitInput, WaitPage};
use super::service::{Usage, UsageDeps, UsageOwners, UsageQueue};
use super::state::{Owner, ParkedKind, ParkedThread};
use crate::hub::store::iso_ms;
use crate::hub::store::test_clock::ManualClock;

/// 2026-10-25T22:40:38Z.
const T0: i64 = 1_792_968_038_000;
const MIN: u64 = 60_000;
const COOLDOWN: &str = "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling \
                        down (last error: rate_limit_error: This request would exceed your account's rate limit. \
                        Please try again later.)";

#[derive(Default)]
struct Fake {
    events: Mutex<Vec<HubEvent>>,
    /// (thread, client message id) per "continue" sent.
    sent: Mutex<Vec<(String, String)>>,
}

impl Fake {
    fn push(&self, at_ms: i64, kind: &str, thread: &str, data: Value) {
        let mut events = self.events.lock().unwrap();
        let seq = events.len() + 1;
        events.push(
            serde_json::from_value(json!({
                "seq": seq, "at": iso_ms(at_ms), "type": kind, "machineId": "devbox", "threadId": thread,
                "summary": format!("{thread} {kind}"), "data": data,
            }))
            .unwrap(),
        );
    }

    /// thread.usage_limited as the executor writes it for devbox's text.
    fn cooldown(&self, at_ms: i64, thread: &str) {
        let limit = super::classify::classify_limit(&super::classify::LimitInput {
            error_class: Some("rate_limit"),
            at: &iso_ms(at_ms),
            model: Some("claude-opus-5-5"),
            failure_model: Some("claude-opus-5-5"),
            ..Default::default()
        })
        .unwrap();
        let mut data =
            json!({ "status": "failed", "error": { "class": "rate_limit", "message": COOLDOWN } });
        for (k, v) in super::classify::limit_data(&limit) {
            data[k] = v;
        }
        self.push(at_ms, "thread.usage_limited", thread, data);
    }

    fn turn(&self, at_ms: i64, kind: &str, thread: &str) {
        self.push(
            at_ms,
            kind,
            thread,
            json!({ "status": "running", "model": "claude-opus-5-5" }),
        );
    }

    fn sent(&self) -> Vec<String> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|(t, _)| t.clone())
            .collect()
    }

    fn last(&self, kind: &str) -> Option<HubEvent> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|e| e.r#type.as_str() == kind)
            .cloned()
    }
}

impl EventLog for Fake {
    fn append(&self, e: NewEvent) -> BoxFut<'_, HubEvent> {
        let mut events = self.events.lock().unwrap();
        let event: HubEvent = serde_json::from_value(json!({
            "seq": events.len() + 1, "at": e.at, "type": e.kind, "machineId": e.machine_id,
            "threadId": e.thread_id, "summary": e.summary, "data": e.data, "attention": e.attention,
        }))
        .unwrap();
        events.push(event.clone());
        Box::pin(async move { event })
    }
    fn head(&self) -> BoxFut<'_, u64> {
        let n = self.events.lock().unwrap().len() as u64;
        Box::pin(async move { n })
    }
    fn wait(&self, input: WaitInput) -> BoxFut<'_, WaitPage> {
        let events = self.events.lock().unwrap();
        let page = WaitPage {
            events: events
                .iter()
                .skip(input.cursor as usize)
                .filter(|e| input.types.contains(&e.r#type.as_str()))
                .cloned()
                .collect(),
            cursor: events.len() as u64,
            more: false,
        };
        Box::pin(async move { page })
    }
}

impl UsageQueue for Fake {
    fn send_continue(&self, thread: &ThreadRef, id: &str) -> BoxFut<'_, Result<(), String>> {
        self.sent
            .lock()
            .unwrap()
            .push((thread.thread_id.clone(), id.to_owned()));
        Box::pin(async { Ok(()) })
    }
}

impl UsageOwners for Fake {
    fn owner_of(&self, thread: &ThreadRef) -> BoxFut<'_, Option<Owner>> {
        let owner = match thread.thread_id.as_str() {
            "lead" => Some((ParkedKind::Lead, None)),
            "w1" => Some((ParkedKind::Write, Some("T1"))),
            "w2" => Some((ParkedKind::Write, Some("T2"))),
            "r1" => Some((ParkedKind::Review, Some("T3"))),
            _ => None,
        }
        .map(|(kind, task)| Owner {
            kind,
            task_id: task.map(str::to_owned),
        });
        Box::pin(async move { owner })
    }
    fn still_parked(&self, _: &ParkedThread) -> BoxFut<'_, bool> {
        Box::pin(async { true })
    }
}

fn usage() -> (Arc<Fake>, Arc<ManualClock>, Usage) {
    let fake = Arc::new(Fake::default());
    let clock = ManualClock::at(T0 as u64);
    let usage = Usage::new(UsageDeps {
        events: fake.clone(),
        queue: fake.clone(),
        owners: fake.clone(),
        clock: clock.clone(),
    });
    (fake, clock, usage)
}

/// Lets spawned timers run up to their sleep or to the end.
async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

/// Moves the clock and lets the woken timers run.
async fn advance(clock: &ManualClock, ms: u64) {
    settle().await;
    clock.advance(Duration::from_millis(ms));
    settle().await;
}

/// devbox's three agents hit the cooldown within a second.
async fn proxy_pause(fake: &Fake, usage: &Usage) {
    fake.cooldown(T0, "w1");
    fake.cooldown(T0 + 400, "r1");
    fake.cooldown(T0 + 900, "w2");
    usage.drain().await;
}

#[tokio::test]
async fn a_proxy_cooldown_pauses_with_no_made_up_reset() {
    let (fake, _clock, usage) = usage();
    proxy_pause(&fake, &usage).await;
    let breaker = fake.last("usage.breaker").expect("trips");
    assert_eq!(
        breaker.summary.as_str(),
        "Rate-limited by your proxy on devbox; checking again shortly; 2 tasks parked"
    );
    let data = breaker.data.unwrap();
    assert_eq!(data.get("until"), None, "main parked until 23:40:38");
    // The hub trips the breaker at its own now; the first check is a minute on.
    assert_eq!(data["checkAt"], iso_ms(T0 + MIN as i64));
    assert_eq!(
        usage.gate("devbox").as_deref(),
        Some("usage: rate-limited by your proxy on devbox, checking again shortly")
    );
    let status = usage.status("devbox", Err("offline".into())).await;
    assert_eq!(
        (
            status.breaker.until,
            status.breaker.check_at,
            status.breaker.proxy
        ),
        (None, Some(iso_ms(T0 + MIN as i64)), Some(true))
    );
}

/// The case behind this: during devbox's pause the lead kept taking turns on the same login while every task stayed
/// parked. A turn that started after the pause and completed proves the login, on whatever model id it names (an
/// alias, a dated id, a proxy's own name), so it lifts the pause.
#[tokio::test]
async fn the_leads_successful_turn_on_the_paused_login_resumes_every_parked_agent() {
    let (fake, _clock, usage) = usage();
    // The lead's turn already running when the limit hit proves nothing.
    fake.turn(T0 - 5_000, "thread.started", "lead");
    proxy_pause(&fake, &usage).await;
    fake.turn(T0 + 2_000, "thread.completed", "lead");
    usage.drain().await;
    assert!(
        usage.gate("devbox").is_some(),
        "a turn from before the pause"
    );
    // A turn that starts after the pause but fails proves nothing, and leaves no start behind for a later
    // completion that had none of its own.
    fake.turn(T0 + 10_000, "thread.started", "lead");
    fake.push(
        T0 + 20_000,
        "thread.failed",
        "lead",
        json!({ "status": "failed" }),
    );
    fake.turn(T0 + 25_000, "thread.completed", "lead");
    usage.drain().await;
    assert!(usage.gate("devbox").is_some(), "a failed turn");
    assert!(fake.sent().is_empty());

    // The lead's next turn names a dated model id the limit didn't: it completed, so the login answers.
    fake.turn(T0 + 30_000, "thread.started", "lead");
    fake.push(
        T0 + 45_000,
        "thread.completed",
        "lead",
        json!({ "status": "completed", "model": "claude-opus-5-5-20261020" }),
    );
    usage.drain().await;
    assert_eq!(usage.gate("devbox"), None);
    assert_eq!(fake.sent(), ["r1", "w1", "w2"], "reviews before writers");
    let resumed = fake.last("usage.resumed").unwrap();
    assert_eq!(
        resumed.summary.as_str(),
        "Usage pause on devbox lifted (a turn on its login succeeded); sent \"continue\" to 3 parked threads"
    );
    assert_eq!(resumed.data.unwrap()["by"], "turn");
}

/// What the executor logs for one run of a fake claude behind devbox's proxy: the run starts, claude retries the 429
/// inside the turn for `retrying_ms`, then either gives up (thread.usage_limited) or gets a response and completes.
fn fake_run(fake: &Fake, at_ms: i64, thread: &str, retrying_ms: i64, gets_through: bool) {
    fake.turn(at_ms, "thread.started", thread);
    if gets_through {
        fake.turn(at_ms + retrying_ms, "thread.completed", thread);
    } else {
        fake.cooldown(at_ms + retrying_ms, thread);
    }
}

/// With no turn to prove it, fleetd tries one parked thread at 1, 2, 5, 10, then every 15 minutes. A tried thread
/// whose turn has only started proves nothing, since claude may still be retrying the 429 inside it; the pause lifts
/// only once a tried turn completes.
#[tokio::test]
async fn with_no_reset_one_parked_thread_is_tried_on_a_backoff_until_its_turn_completes() {
    let (fake, clock, usage) = usage();
    proxy_pause(&fake, &usage).await;
    advance(&clock, MIN - 1).await;
    assert!(fake.sent().is_empty());
    advance(&clock, 1).await;
    assert_eq!(fake.sent(), ["r1"], "one check, the review first");
    assert!(usage.gate("devbox").is_some(), "the rest stay parked");
    assert_eq!(
        fake.last("usage.resumed").unwrap().summary.as_str(),
        "Trying devbox's login again; sent \"continue\" to 1 parked thread"
    );

    // r1's run starts, and claude is still retrying the 429 at the next check, 2 minutes on: not through.
    let first = T0 + MIN as i64;
    fake.turn(first + 1_000, "thread.started", "r1");
    usage.drain().await;
    advance(&clock, 2 * MIN).await;
    assert!(
        usage.gate("devbox").is_some(),
        "a started turn proves nothing"
    );
    assert_eq!(
        fake.sent(),
        ["r1"],
        "r1 isn't parked, so nothing else was tried"
    );
    // Then claude gives up, 30 s later: r1 parks again, and the next check is a step (2 minutes) on from then.
    let failed = first + 2 * MIN as i64 + 30_000;
    fake.cooldown(failed, "r1");
    usage.drain().await;
    advance(&clock, 30_000 + 2 * MIN - 1).await;
    assert_eq!(fake.sent(), ["r1"]);
    advance(&clock, 1).await;
    assert_eq!(fake.sent(), ["r1", "r1"]);
    assert!(usage.gate("devbox").is_some());

    // That run retries 40 s and fails again; the one after retries 40 s, then the proxy answers and the turn
    // completes: the pause lifts at once.
    let second = failed + 2 * MIN as i64;
    fake_run(&fake, second + 1_000, "r1", 40_000, false);
    usage.drain().await;
    assert!(usage.gate("devbox").is_some(), "retried, then failed again");
    advance(&clock, 10 * MIN).await;
    assert_eq!(fake.sent(), ["r1", "r1", "r1"]);
    fake_run(&fake, second + 10 * MIN as i64 + 1_000, "r1", 40_000, true);
    usage.drain().await;
    assert_eq!(usage.gate("devbox"), None);
    assert_eq!(fake.sent(), ["r1", "r1", "r1", "w1", "w2"]);
    assert_eq!(
        fake.last("usage.resumed").unwrap().summary.as_str(),
        "Usage pause on devbox lifted (a turn on its login succeeded); sent \"continue\" to 2 parked threads"
    );
}

/// A check with nothing parked left to try lifts the pause, and says just that, not that a check got through.
#[tokio::test]
async fn a_check_with_nothing_left_to_try_says_so() {
    let (fake, clock, usage) = usage();
    // Threads no task or lead owns count for the breaker but are not parked.
    fake.cooldown(T0, "x1");
    fake.cooldown(T0 + 500, "x2");
    usage.drain().await;
    assert!(usage.gate("devbox").is_some());
    advance(&clock, MIN).await;
    assert_eq!(usage.gate("devbox"), None);
    assert!(fake.sent().is_empty());
    let lifted = fake.last("usage.resumed").unwrap();
    assert_eq!(
        lifted.summary.as_str(),
        "Usage pause on devbox lifted (nothing was left parked to check it with; the next turn there tries the login)"
    );
    assert_eq!(lifted.data.unwrap()["by"], "unchecked");
}

/// A single park that named no reset is tried again itself on the same backoff, not after an hour.
#[tokio::test]
async fn a_park_alone_with_no_reset_is_tried_again_after_a_minute_then_two() {
    let (fake, clock, usage) = usage();
    fake.cooldown(T0, "w1");
    usage.drain().await;
    assert!(fake.last("usage.breaker").is_none());
    let parked = usage
        .parked_of(&ThreadRef {
            machine_id: "devbox".into(),
            thread_id: "w1".into(),
        })
        .unwrap();
    assert_eq!(
        (parked.resume_at, parked.check_at, parked.proxy),
        (None, Some(iso_ms(T0 + MIN as i64)), true)
    );
    advance(&clock, MIN).await;
    assert_eq!(fake.sent(), ["w1"]);
    fake.cooldown(T0 + MIN as i64 + 5_000, "w1");
    usage.drain().await;
    advance(&clock, 2 * MIN + 4_999).await;
    assert_eq!(fake.sent(), ["w1"]);
    advance(&clock, 1).await;
    assert_eq!(fake.sent(), ["w1", "w1"]);
}
