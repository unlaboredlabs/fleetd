use super::test_clock::ManualClock;
use super::*;
use crate::hub::auth::{Auth, AuthError};
use fleetd_contracts::{
    HubEventType as T, KeyKind, MachineId, MachineStatus, ProjectId, ProjectRef, Role, ThreadId, ThreadRef,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

fn m(id: &str) -> MachineId {
    MachineId(id.into())
}

/// A fresh directory under the system temp dir, removed on drop.
struct TempHome(PathBuf);

impl TempHome {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("fleetd-store-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/hub/store/fixtures").join(name)
}

fn schema(db: &HubDb) -> Vec<(String, String, Option<String>)> {
    db.with(|conn| {
        let mut stmt = conn.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
        Ok(rows)
    })
    .unwrap()
}

#[tokio::test]
async fn opens_a_database_written_by_the_ts_hub_unchanged() {
    // Written by fixtures/make-ts-hub.ts with the TS hub's own HubDb, HubStore, EventLog and Auth.
    let secrets: serde_json::Value = serde_json::from_slice(&std::fs::read(fixture("ts-hub.json")).unwrap()).unwrap();
    let at = secrets["at"].as_u64().unwrap();
    let home = TempHome::new("ts");
    std::fs::copy(fixture("ts-hub.sqlite"), home.0.join("hub.sqlite")).unwrap();

    let db = HubDb::open(&home.0).unwrap();
    assert_eq!(db.user_version().unwrap(), SCHEMA_VERSION as i64);
    assert_eq!(schema(&db), schema(&HubDb::open_memory().unwrap()), "same tables, indexes and SQL as a Rust-created hub");
    let mode: String = db.with(|c| Ok(c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?)).unwrap();
    assert_eq!(mode, "wal");

    let store = HubStore::new(db.clone());
    let machine = store.machine_get(&m("lab-a")).unwrap().unwrap();
    assert_eq!(machine.status, MachineStatus::Degraded);
    assert_eq!(machine.degraded_reason.as_deref(), Some("T3 is restarting"));
    assert_eq!(store.machines_list().unwrap().len(), 1);
    let project = ProjectRef { machine_id: m("lab-a"), project_id: ProjectId("p1".into()) };
    assert_eq!(store.project_get(&project).unwrap().unwrap().title, "Fleetd Hub");
    assert_eq!(store.projects_list(None, Some("FLEETD")).unwrap().len(), 1);
    let thread = store.thread_get(&ThreadRef { machine_id: m("lab-a"), thread_id: ThreadId("t1".into()) }).unwrap().unwrap();
    assert_eq!(
        (thread.last_sequence, thread.last_run_id.as_deref(), thread.last_run_status.as_deref()),
        (Some(7), Some("run-1"), Some("running"))
    );
    assert_eq!(thread.thread.model.as_deref(), Some("claude-haiku-5-5"));
    assert_eq!(store.threads_running().unwrap().len(), 1);
    assert_eq!(store.cursor_get(&m("lab-a")).unwrap(), Some(42));

    let clock = ManualClock::at(at + 60_000);
    let log = EventLog::new(db.clone(), clock.clone()).unwrap();
    assert_eq!(log.head(), 3);
    let page = log.page(0, None, None).unwrap();
    assert_eq!(page.events.iter().map(|e| e.seq).collect::<Vec<_>>(), [1, 2, 3]);
    assert_eq!(page.events[1].data, Some(serde_json::json!({ "runId": "run-1" })));
    assert_eq!(page.events[2].summary.chars().count(), 200);
    assert_eq!(page.events[2].data, Some(serde_json::json!({ "truncated": true })));
    assert_eq!(log.page(0, Some(&[T::ThreadStarted]), Some(&m("lab-a"))).unwrap().events.len(), 1);
    assert_eq!(log.append(event(T::ThreadFailed, "lab-a")).unwrap().seq, 4);

    let auth = Auth::new(db.clone(), clock.clone());
    let agent = auth.verify(secrets["agentKey"].as_str().unwrap()).unwrap();
    assert!(auth.allows(&agent, Role::Operate, Some(&m("lab-a"))));
    assert!(!auth.allows(&agent, Role::Operate, Some(&m("lab-b"))));
    let human = auth.verify(&format!("Bearer {}", secrets["humanKey"].as_str().unwrap())).unwrap();
    assert_eq!(human.kind, Some(KeyKind::Human));
    assert!(matches!(auth.verify(secrets["revokedKey"].as_str().unwrap()), Err(AuthError::Unauthorized(u)) if u.message.ends_with("was revoked")));
    assert_eq!(auth.list().unwrap().len(), 3);
    assert_eq!(auth.node_pub_key(&m("lab-a")).unwrap().as_deref(), Some("node-pub-a"));
    auth.consume_enroll_token(secrets["enrollToken"].as_str().unwrap(), &m("lab-b"), "node-pub-b").unwrap();
    assert_eq!(auth.node_pub_key(&m("lab-b")).unwrap().as_deref(), Some("node-pub-b"));
}

fn event(t: T, machine: &str) -> NewEvent {
    NewEvent {
        at: "2026-10-17T10:00:00.000Z".into(),
        r#type: t,
        machine_id: Some(m(machine)),
        project_id: None,
        thread_id: None,
        summary: format!("{t:?} on {machine}"),
        data: None,
    }
}

fn new_log() -> (Arc<EventLog>, Arc<ManualClock>) {
    let clock = ManualClock::at(0);
    (Arc::new(EventLog::new(HubDb::open_memory().unwrap(), clock.clone()).unwrap()), clock)
}

fn append(log: &EventLog, events: impl IntoIterator<Item = NewEvent>) -> Vec<HubEvent> {
    events.into_iter().map(|e| log.append(e).unwrap()).collect()
}

fn wait_now(log: &EventLog, cursor: Option<u64>) -> WaitResult {
    futures_lite(log.wait(WaitInput { cursor, timeout_sec: 0, ..Default::default() })).unwrap()
}

/// Runs a future that must finish without waiting (a zero timeout or events already there).
fn futures_lite<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

/// Lets spawned waiters run until they block.
async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

fn spawn_wait(log: &Arc<EventLog>, input: WaitInput) -> tokio::task::JoinHandle<WaitResult> {
    let log = log.clone();
    tokio::spawn(async move { log.wait(input).await.unwrap() })
}

use fleetd_contracts::HubEvent;

fn seqs(page: &WaitResult) -> Vec<u64> {
    page.events.iter().map(|e| e.seq).collect()
}

#[tokio::test]
async fn returns_events_after_the_cursor_at_once_and_nothing_at_head() {
    let (log, _) = new_log();
    append(&log, [event(T::ThreadStarted, "lab-a"), event(T::ThreadCompleted, "lab-a"), event(T::ThreadFailed, "lab-a")]);
    let page = log.wait(WaitInput { cursor: Some(1), timeout_sec: 50, ..Default::default() }).await.unwrap();
    assert_eq!(page.events.iter().map(|e| (e.seq, e.r#type)).collect::<Vec<_>>(), [(2, T::ThreadCompleted), (3, T::ThreadFailed)]);
    assert_eq!((page.cursor, page.more), (3, false));
    let empty = log.wait(WaitInput { cursor: Some(3), timeout_sec: 0, ..Default::default() }).await.unwrap();
    assert_eq!(empty, WaitResult { events: vec![], cursor: 3, more: false });
}

#[tokio::test]
async fn without_a_cursor_starts_at_the_end_and_wakes_on_the_next_append() {
    let (log, _) = new_log();
    append(&log, [event(T::ThreadStarted, "lab-a")]);
    let waiter = spawn_wait(&log, WaitInput { timeout_sec: 50, ..Default::default() });
    settle().await;
    assert!(!waiter.is_finished());
    append(&log, [event(T::ThreadCompleted, "lab-a")]);
    let page = waiter.await.unwrap();
    assert_eq!((seqs(&page), page.cursor), (vec![2], 2));
}

#[tokio::test]
async fn times_out_after_timeout_sec_with_the_cursor_at_head() {
    let (log, clock) = new_log();
    append(&log, [event(T::ThreadStarted, "lab-a")]);
    let waiter = spawn_wait(&log, WaitInput { cursor: Some(1), timeout_sec: 50, ..Default::default() });
    settle().await;
    clock.advance(Duration::from_secs(49));
    settle().await;
    assert!(!waiter.is_finished());
    clock.advance(Duration::from_secs(1));
    assert_eq!(waiter.await.unwrap(), WaitResult { events: vec![], cursor: 1, more: false });
}

#[tokio::test]
async fn keeps_waiting_past_filtered_events_and_moves_the_cursor_past_them() {
    let (log, clock) = new_log();
    let waiter = spawn_wait(
        &log,
        WaitInput { cursor: Some(0), types: Some(vec![T::ThreadCompleted]), machine_id: Some(m("lab-b")), timeout_sec: 50 },
    );
    settle().await;
    append(&log, [event(T::ThreadStarted, "lab-b"), event(T::ThreadCompleted, "lab-a")]);
    settle().await;
    assert!(!waiter.is_finished());
    append(&log, [event(T::ThreadCompleted, "lab-b")]);
    let page = waiter.await.unwrap();
    assert_eq!(page.events.iter().map(|e| (e.seq, e.machine_id.clone())).collect::<Vec<_>>(), [(3, Some(m("lab-b")))]);

    // A filtered wait that times out still advances the cursor over what it skipped.
    append(&log, [event(T::MachineOnline, "lab-b")]);
    let skipped = spawn_wait(&log, WaitInput { cursor: Some(3), types: Some(vec![T::ThreadFailed]), timeout_sec: 5, ..Default::default() });
    settle().await;
    clock.advance(Duration::from_secs(4));
    settle().await;
    assert!(!skipped.is_finished());
    clock.advance(Duration::from_secs(1));
    assert_eq!(skipped.await.unwrap(), WaitResult { events: vec![], cursor: 4, more: false });
}

#[test]
fn pages_at_100_events_with_more_set() {
    let (log, _) = new_log();
    append(&log, (0..150).map(|_| event(T::ThreadStarted, "lab-a")));
    let first = wait_now(&log, Some(0));
    assert_eq!((first.events.len(), first.cursor, first.more), (100, 100, true));
    let second = wait_now(&log, Some(first.cursor));
    assert_eq!((second.events.len(), second.events[0].seq, second.cursor, second.more), (50, 101, 150, false));
}

#[test]
fn treats_a_cursor_past_head_as_head() {
    let (log, _) = new_log();
    append(&log, [event(T::ThreadStarted, "lab-a")]);
    assert_eq!(wait_now(&log, Some(99)), WaitResult { events: vec![], cursor: 1, more: false });
}

#[test]
fn trims_long_summaries_and_oversized_data() {
    let (log, _) = new_log();
    let small = NewEvent { summary: "x".repeat(300), data: Some(serde_json::json!({ "ok": 1 })), ..event(T::ThreadFailed, "lab-a") };
    let big = NewEvent { data: Some(serde_json::json!({ "blob": "y".repeat(3000) })), ..event(T::ThreadFailed, "lab-a") };
    let appended = append(&log, [small, big]);
    assert_eq!(appended[0].summary.chars().count(), 200);
    assert!(appended[0].summary.ends_with('…'));
    assert_eq!(appended[0].data, Some(serde_json::json!({ "ok": 1 })));
    assert_eq!(appended[1].data, Some(serde_json::json!({ "truncated": true })));
    assert_eq!(wait_now(&log, Some(0)).events, appended);
}

#[test]
fn drops_events_older_than_30_days_without_reusing_their_seq_even_across_a_restart() {
    let db = HubDb::open_memory().unwrap();
    let clock = ManualClock::at(0);
    let log = EventLog::new(db.clone(), clock.clone()).unwrap();
    append(&log, [event(T::ThreadStarted, "lab-a"), event(T::ThreadCompleted, "lab-a")]);
    clock.advance(Duration::from_secs(29 * 86_400));
    append(&log, [event(T::ThreadFailed, "lab-a")]);
    assert_eq!(wait_now(&log, Some(0)).events.len(), 3);
    clock.advance(Duration::from_secs(2 * 86_400));
    assert_eq!(append(&log, [event(T::ThreadInterrupted, "lab-a")])[0].seq, 4);
    assert_eq!(seqs(&wait_now(&log, Some(0))), [3, 4]);

    // A restarted hub prunes on start and keeps counting from the database's sequence.
    clock.advance(Duration::from_secs(31 * 86_400));
    let restarted = EventLog::new(db, clock).unwrap();
    assert_eq!((restarted.head(), wait_now(&restarted, Some(0)).events.len()), (4, 0));
    assert_eq!(append(&restarted, [event(T::ThreadStarted, "lab-a")])[0].seq, 5);
}
