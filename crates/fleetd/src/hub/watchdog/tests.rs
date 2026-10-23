//! Stall detection on a test clock: one thread on a fake node, driven by the test.
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use super::*;

const MIN: u64 = 60_000;

#[derive(Default)]
struct Thread {
    run_id: String,
    running: bool,
    stream_open: bool,
    last_frame_ms: u64,
    tool: Option<OpenTool>,
}

#[derive(Default)]
struct Fake {
    now: AtomicU64,
    thread: Mutex<Thread>,
    calls: Mutex<Vec<String>>,
    /// (type, data, summary)
    events: Mutex<Vec<(String, Value, String)>>,
}

impl WatchPort for &Fake {
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
    fn running(&self) -> Vec<(Key, String)> {
        let t = self.thread.lock().unwrap();
        let key = ("lab-a".into(), "t1".into());
        t.running
            .then(|| (key, t.run_id.clone()))
            .into_iter()
            .collect()
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
    fn progress(&self, _: &Key) -> Option<(u64, Option<OpenTool>)> {
        let t = self.thread.lock().unwrap();
        t.stream_open.then_some((t.last_frame_ms, t.tool))
    }
    async fn interrupt(&self, _: &Key) -> Result<(), String> {
        let run = self.thread.lock().unwrap().run_id.clone();
        self.calls.lock().unwrap().push(format!("interrupt {run}"));
        Ok(())
    }
    async fn emit(&self, key: &Key, kind: &'static str, detail: String, data: Value) {
        let summary = format!("\"sleepy\" on {} {detail}", key.0);
        self.events
            .lock()
            .unwrap()
            .push((kind.into(), data, summary));
    }
}

/// Advances the clock to minute `m`, checking every minute on the way.
async fn to_minute(f: &Fake, w: &Watchdog<&Fake>, m: u64) {
    while f.now.load(Ordering::SeqCst) < m * MIN {
        f.now.fetch_add(MIN, Ordering::SeqCst);
        w.check().await;
    }
}

#[tokio::test]
async fn a_stall_fails_the_run_once_and_interrupts_it() {
    let f = Fake::default();
    *f.thread.lock().unwrap() = Thread {
        run_id: "r1".into(),
        running: true,
        ..Thread::default()
    };
    let w = Watchdog::with_port(STALL_MS, &f);
    to_minute(&f, &w, 1).await; // the stream opens at minute 1, the first frame
    for m in (5..=60).step_by(5) {
        to_minute(&f, &w, m).await;
        f.thread.lock().unwrap().last_frame_ms = m * MIN;
    }
    to_minute(&f, &w, 69).await;
    assert!(
        f.events.lock().unwrap().is_empty(),
        "frames keep a run alive"
    );

    to_minute(&f, &w, 70).await;
    let (kind, data, summary) = f.events.lock().unwrap()[0].clone();
    assert_eq!(kind, "thread.failed");
    assert_eq!(
        (
            data["reason"].as_str(),
            data["runId"].as_str(),
            data["inTool"].as_bool()
        ),
        (Some("stalled"), Some("r1"), Some(false))
    );
    assert_eq!(
        summary,
        r#""sleepy" on lab-a stalled: no progress for 10 min outside a tool, so fleetd interrupted it"#
    );
    assert_eq!(*f.calls.lock().unwrap(), ["follow", "interrupt r1"]);

    // Even if the interrupt does not take, nothing more happens to this run: no retry, no second turn.
    to_minute(&f, &w, 120).await;
    assert_eq!(f.events.lock().unwrap().len(), 1);
    f.thread.lock().unwrap().running = false;
    to_minute(&f, &w, 121).await;
    assert_eq!(f.calls.lock().unwrap().last().unwrap(), "release");

    // A later run (the lead continued it) is watched afresh, and inside a tool waits for its timeout plus the threshold.
    *f.thread.lock().unwrap() = Thread {
        run_id: "r2".into(),
        running: true,
        tool: Some(OpenTool {
            stated_timeout_ms: None,
            unstated: true,
        }),
        ..Thread::default()
    };
    to_minute(&f, &w, 141).await;
    assert_eq!(f.events.lock().unwrap().len(), 1);
    to_minute(&f, &w, 142).await;
    let (_, data, _) = f.events.lock().unwrap()[1].clone();
    assert_eq!(
        (data["runId"].as_str(), data["thresholdSec"].as_u64()),
        (Some("r2"), Some(1200))
    );
}
