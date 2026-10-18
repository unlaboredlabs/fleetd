//! The stall ladder on a test clock: one thread on a fake node, driven by the test.
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use super::ladder::*;

const MIN: u64 = 60_000;

#[derive(Default)]
struct Thread {
    run_id: String,
    running: bool,
    stream_open: bool,
    last_frame_ms: u64,
    tool: Option<Tool>,
}

#[derive(Default)]
struct Fake {
    now: AtomicU64,
    thread: Mutex<Thread>,
    calls: Mutex<Vec<String>>,
    /// (type, data, summary)
    events: Mutex<Vec<(String, Value, String)>>,
}

fn key() -> Key {
    ("lab-a".into(), "t1".into())
}

impl WatchPort for &Fake {
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
    fn running(&self) -> Vec<(Key, String)> {
        let t = self.thread.lock().unwrap();
        if t.running {
            vec![(key(), t.run_id.clone())]
        } else {
            vec![]
        }
    }
    fn latest_run(&self, _: &Key) -> Option<(Option<String>, bool)> {
        let t = self.thread.lock().unwrap();
        Some((Some(t.run_id.clone()), t.running))
    }
    async fn follow(&self, _: &Key) -> bool {
        self.calls.lock().unwrap().push("follow".into());
        let mut t = self.thread.lock().unwrap();
        t.stream_open = true;
        t.last_frame_ms = self.now_ms();
        true
    }
    fn release(&self, _: &Key) {
        self.calls.lock().unwrap().push("release".into());
    }
    fn progress(&self, _: &Key) -> Option<(u64, Option<Tool>)> {
        let t = self.thread.lock().unwrap();
        t.stream_open.then_some((t.last_frame_ms, t.tool))
    }
    async fn interrupt(&self, _: &Key, client_request_id: &str) -> Result<(), String> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("interrupt {client_request_id}"));
        Ok(())
    }
    async fn send(&self, _: &Key, message: &str, client_request_id: &str) -> Result<(), String> {
        let m = if message == NUDGE { "NUDGE" } else { message };
        self.calls
            .lock()
            .unwrap()
            .push(format!("send {client_request_id} {m}"));
        Ok(())
    }
    async fn emit(&self, key: &Key, kind: &'static str, detail: String, data: Value) {
        // The real port reads the title from the store: "sleepy".
        let summary = format!("\"sleepy\" on {} {detail}", key.0);
        self.events
            .lock()
            .unwrap()
            .push((kind.into(), data, summary));
    }
}

struct Run<'a> {
    fake: &'a Fake,
    ladder: Ladder<&'a Fake>,
}

impl Run<'_> {
    /// Advances the clock to `ms`, checking every `check_every_ms` on the way, as the watchdog's loop does.
    async fn to(&self, ms: u64) {
        let every = self.ladder.config.check_every_ms;
        loop {
            let now = self.fake.now.load(Ordering::SeqCst);
            let next = (now / every + 1) * every;
            if next > ms {
                self.fake.now.store(ms, Ordering::SeqCst);
                return;
            }
            self.fake.now.store(next, Ordering::SeqCst);
            self.ladder.check().await;
        }
    }
    async fn to_minute(&self, m: u64) {
        self.to(m * MIN).await;
    }
    fn types(&self) -> Vec<String> {
        self.fake
            .events
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.0.clone())
            .collect()
    }
    fn calls(&self) -> Vec<String> {
        self.fake.calls.lock().unwrap().clone()
    }
    fn sends(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter(|c| c.starts_with("send"))
            .collect()
    }
    fn set(&self, f: impl FnOnce(&mut Thread)) {
        f(&mut self.fake.thread.lock().unwrap());
    }
}

fn fake() -> Fake {
    let f = Fake::default();
    *f.thread.lock().unwrap() = Thread {
        run_id: "r1".into(),
        running: true,
        ..Thread::default()
    };
    f
}

fn ladder(fake: &Fake, config: WatchdogConfig) -> Run<'_> {
    Run {
        fake,
        ladder: Ladder::new(config, fake),
    }
}

const EVERY_MINUTE: WatchdogConfig = WatchdogConfig {
    check_every_ms: MIN,
    ..DEFAULT_CONFIG
};

#[tokio::test]
async fn stalls_interrupts_nudges_once_then_fails_without_retrying() {
    let f = fake();
    let r = ladder(&f, EVERY_MINUTE);
    r.to_minute(1).await;
    assert_eq!(r.calls(), vec!["follow"]); // the stream opens at minute 1, the first frame
    r.to_minute(10).await;
    assert!(r.types().is_empty());
    r.to_minute(11).await;
    let (kind, data, summary) = f.events.lock().unwrap()[0].clone();
    assert_eq!(kind, "thread.stalled");
    assert_eq!(
        (data["runId"].as_str(), data["inTool"].as_bool()),
        (Some("r1"), Some(false))
    );
    assert_eq!(
        (data["idleSec"].as_u64(), data["thresholdSec"].as_u64()),
        (Some(600), Some(600))
    );
    assert_eq!(
        summary,
        r#""sleepy" on lab-a stalled: no progress for 10 min outside a tool; interrupting and nudging once"#
    );
    assert_eq!(r.calls()[1..], ["interrupt watchdog:r1:interrupt"]);

    // The nudge waits for the interrupted run to end, and goes out once.
    r.to_minute(13).await;
    assert!(r.sends().is_empty());
    r.set(|t| t.running = false);
    r.to_minute(16).await;
    assert_eq!(r.sends(), vec!["send watchdog:r1:continue NUDGE"]);

    // The continuation runs, makes some progress, then stalls: the chain fails.
    r.set(|t| {
        t.run_id = "r2".into();
        t.running = true;
    });
    r.to_minute(18).await;
    r.set(|t| t.last_frame_ms = 18 * MIN);
    r.to_minute(27).await;
    assert_eq!(r.types(), vec!["thread.stalled"]);
    r.to_minute(28).await;
    let (kind, data, _) = f.events.lock().unwrap()[1].clone();
    assert_eq!(kind, "thread.failed");
    assert_eq!(
        (
            data["runId"].as_str(),
            data["reason"].as_str(),
            data["status"].as_str()
        ),
        (Some("r2"), Some("stalled"), Some("failed"))
    );
    assert_eq!(r.calls().last().unwrap(), "interrupt watchdog:r2:fail");

    // Even if the interrupt does not take, nothing more happens to this run.
    r.to_minute(90).await;
    assert_eq!(r.types(), vec!["thread.stalled", "thread.failed"]);
    assert_eq!(r.sends().len(), 1);
    r.set(|t| t.running = false);
    r.to_minute(91).await;
    assert_eq!(r.calls().last().unwrap(), "release");
}

#[tokio::test]
async fn a_finished_continuation_ends_the_chain() {
    let f = fake();
    let r = ladder(&f, EVERY_MINUTE);
    r.to_minute(11).await;
    r.set(|t| t.running = false);
    r.to_minute(12).await;
    r.set(|t| {
        t.run_id = "r2".into();
        t.running = true;
    });
    r.to_minute(13).await;
    r.set(|t| t.running = false); // r2 completes
    r.to_minute(14).await;
    assert_eq!(r.calls().last().unwrap(), "release");
    r.set(|t| {
        t.run_id = "r3".into();
        t.running = true;
        t.stream_open = false;
    });
    r.to_minute(26).await;
    assert_eq!(r.types(), vec!["thread.stalled", "thread.stalled"]);
    assert_eq!(f.events.lock().unwrap()[1].1["runId"], "r3");
}

#[tokio::test]
async fn frames_keep_a_run_alive() {
    let f = fake();
    let r = ladder(&f, EVERY_MINUTE);
    for minute in (5..=120).step_by(5) {
        r.to_minute(minute).await;
        r.set(|t| t.last_frame_ms = minute * MIN);
    }
    assert!(r.types().is_empty());
}

#[tokio::test]
async fn inside_a_tool_waits_for_its_timeout_plus_grace() {
    let f = fake();
    let r = ladder(&f, EVERY_MINUTE);
    r.set(|t| {
        t.tool = Some(Tool {
            stated_timeout_ms: None,
            unstated: true,
        })
    });
    r.to_minute(20).await;
    assert!(r.types().is_empty());
    r.to_minute(21).await;
    let (kind, data, _) = f.events.lock().unwrap()[0].clone();
    assert_eq!(
        (
            kind.as_str(),
            data["inTool"].as_bool(),
            data["thresholdSec"].as_u64()
        ),
        ("thread.stalled", Some(true), Some(1200))
    );
}

#[tokio::test]
async fn short_thresholds_from_env_as_the_lab_uses() {
    let env = |name: &str| {
        match name {
            "FLEETD_STALL_OUTSIDE_SEC" => Some("20"),
            "FLEETD_STALL_TOOL_TIMEOUT_SEC" => Some("10"),
            "FLEETD_STALL_INSIDE_GRACE_SEC" => Some("20"),
            "FLEETD_WATCHDOG_EVERY_SEC" => Some("1"),
            _ => None,
        }
        .map(str::to_owned)
    };
    let f = fake();
    let r = ladder(&f, config_from_env(env));
    r.set(|t| {
        t.tool = Some(Tool {
            stated_timeout_ms: None,
            unstated: true,
        })
    });
    r.to(30_000).await;
    assert!(r.types().is_empty());
    r.to(31_000).await;
    assert_eq!(r.types(), vec!["thread.stalled"]);
}

#[test]
fn thresholds() {
    assert_eq!(threshold_ms(&DEFAULT_CONFIG, None), 10 * MIN);
    assert_eq!(
        threshold_ms(
            &DEFAULT_CONFIG,
            Some(Tool {
                stated_timeout_ms: None,
                unstated: true
            })
        ),
        20 * MIN
    );
    assert_eq!(
        threshold_ms(
            &DEFAULT_CONFIG,
            Some(Tool {
                stated_timeout_ms: Some(30 * MIN),
                unstated: false
            })
        ),
        40 * MIN
    );
    // A short stated timeout next to a tool that states none still gets the default.
    assert_eq!(
        threshold_ms(
            &DEFAULT_CONFIG,
            Some(Tool {
                stated_timeout_ms: Some(MIN),
                unstated: true
            })
        ),
        20 * MIN
    );
}

#[test]
fn env_seconds_ignore_junk() {
    assert_eq!(config_from_env(|_| None), DEFAULT_CONFIG);
    let env = |name: &str| {
        match name {
            "FLEETD_STALL_OUTSIDE_SEC" => Some("20"),
            "FLEETD_STALL_INSIDE_GRACE_SEC" => Some("x"),
            "FLEETD_WATCHDOG_EVERY_SEC" => Some("-1"),
            _ => None,
        }
        .map(str::to_owned)
    };
    assert_eq!(
        config_from_env(env),
        WatchdogConfig {
            outside_tool_ms: 20_000,
            ..DEFAULT_CONFIG
        }
    );
}
