use super::event_log::WaitResult;
use super::test_clock::ManualClock;
use super::*;
use fleetd_contracts::events::{HubEvent, HubEventType as T};
use fleetd_contracts::ids::MachineId;
use std::sync::Arc;
use std::time::Duration;

fn m(id: &str) -> MachineId {
    MachineId::new(id).unwrap()
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
        attention: None,
    }
}

fn new_log() -> (Arc<EventLog>, Arc<ManualClock>) {
    let clock = ManualClock::at(0);
    (
        Arc::new(EventLog::new(HubDb::open_memory().unwrap(), clock.clone()).unwrap()),
        clock,
    )
}

fn append(log: &EventLog, events: impl IntoIterator<Item = NewEvent>) -> Vec<HubEvent> {
    events.into_iter().map(|e| log.append(e).unwrap()).collect()
}

fn wait_now(log: &EventLog, cursor: Option<i64>) -> WaitResult {
    futures_lite(log.wait(WaitInput {
        cursor,
        timeout_sec: 0,
        ..Default::default()
    }))
    .unwrap()
}

/// Runs a future that must finish without waiting (a zero timeout or events already there).
fn futures_lite<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
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

fn seqs(page: &WaitResult) -> Vec<i64> {
    page.events.iter().map(|e| e.seq.get()).collect()
}

#[tokio::test]
async fn returns_events_after_the_cursor_at_once_and_nothing_at_head() {
    let (log, _) = new_log();
    append(
        &log,
        [
            event(T::ThreadStarted, "lab-a"),
            event(T::ThreadCompleted, "lab-a"),
            event(T::ThreadFailed, "lab-a"),
        ],
    );
    let page = log
        .wait(WaitInput {
            cursor: Some(1),
            timeout_sec: 50,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        page.events
            .iter()
            .map(|e| (e.seq.get(), e.r#type))
            .collect::<Vec<_>>(),
        [(2, T::ThreadCompleted), (3, T::ThreadFailed)]
    );
    assert_eq!((page.cursor, page.more), (3, false));
    let empty = log
        .wait(WaitInput {
            cursor: Some(3),
            timeout_sec: 0,
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        empty,
        WaitResult {
            events: vec![],
            cursor: 3,
            more: false
        }
    );
}

#[tokio::test]
async fn without_a_cursor_starts_at_the_end_and_wakes_on_the_next_append() {
    let (log, _) = new_log();
    append(&log, [event(T::ThreadStarted, "lab-a")]);
    let waiter = spawn_wait(
        &log,
        WaitInput {
            timeout_sec: 50,
            ..Default::default()
        },
    );
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
    let waiter = spawn_wait(
        &log,
        WaitInput {
            cursor: Some(1),
            timeout_sec: 50,
            ..Default::default()
        },
    );
    settle().await;
    clock.advance(Duration::from_secs(49));
    settle().await;
    assert!(!waiter.is_finished());
    clock.advance(Duration::from_secs(1));
    assert_eq!(
        waiter.await.unwrap(),
        WaitResult {
            events: vec![],
            cursor: 1,
            more: false
        }
    );
}

#[tokio::test]
async fn keeps_waiting_past_filtered_events_and_moves_the_cursor_past_them() {
    let (log, clock) = new_log();
    let waiter = spawn_wait(
        &log,
        WaitInput {
            cursor: Some(0),
            types: Some(vec![T::ThreadCompleted]),
            machine_id: Some(m("lab-b")),
            timeout_sec: 50,
        },
    );
    settle().await;
    append(
        &log,
        [
            event(T::ThreadStarted, "lab-b"),
            event(T::ThreadCompleted, "lab-a"),
        ],
    );
    settle().await;
    assert!(!waiter.is_finished());
    append(&log, [event(T::ThreadCompleted, "lab-b")]);
    let page = waiter.await.unwrap();
    assert_eq!(
        page.events
            .iter()
            .map(|e| (e.seq.get(), e.machine_id.clone()))
            .collect::<Vec<_>>(),
        [(3, Some(m("lab-b")))]
    );

    // A filtered wait that times out still advances the cursor over what it skipped.
    append(&log, [event(T::MachineOnline, "lab-b")]);
    let skipped = spawn_wait(
        &log,
        WaitInput {
            cursor: Some(3),
            types: Some(vec![T::ThreadFailed]),
            timeout_sec: 5,
            ..Default::default()
        },
    );
    settle().await;
    clock.advance(Duration::from_secs(4));
    settle().await;
    assert!(!skipped.is_finished());
    clock.advance(Duration::from_secs(1));
    assert_eq!(
        skipped.await.unwrap(),
        WaitResult {
            events: vec![],
            cursor: 4,
            more: false
        }
    );
}

#[test]
fn pages_at_100_events_with_more_set() {
    let (log, _) = new_log();
    append(&log, (0..150).map(|_| event(T::ThreadStarted, "lab-a")));
    let first = wait_now(&log, Some(0));
    assert_eq!(
        (first.events.len(), first.cursor, first.more),
        (100, 100, true)
    );
    let second = wait_now(&log, Some(first.cursor));
    assert_eq!(
        (
            second.events.len(),
            second.events[0].seq.get(),
            second.cursor,
            second.more
        ),
        (50, 101, 150, false)
    );
}

#[test]
fn treats_a_cursor_past_head_as_head() {
    let (log, _) = new_log();
    append(&log, [event(T::ThreadStarted, "lab-a")]);
    assert_eq!(
        wait_now(&log, Some(99)),
        WaitResult {
            events: vec![],
            cursor: 1,
            more: false
        }
    );
}

#[test]
fn trims_long_summaries_and_oversized_data() {
    let (log, _) = new_log();
    let small = NewEvent {
        summary: "x".repeat(300),
        data: Some(serde_json::json!({ "ok": 1 })),
        ..event(T::ThreadFailed, "lab-a")
    };
    let big = NewEvent {
        data: Some(serde_json::json!({ "blob": "y".repeat(3000) })),
        ..event(T::ThreadFailed, "lab-a")
    };
    let appended = append(&log, [small, big]);
    assert_eq!(appended[0].summary.as_str().chars().count(), 200);
    assert!(appended[0].summary.as_str().ends_with('…'));
    assert_eq!(appended[0].data, Some(serde_json::json!({ "ok": 1 })));
    assert_eq!(
        appended[1].data,
        Some(serde_json::json!({ "truncated": true }))
    );
    assert_eq!(wait_now(&log, Some(0)).events, appended);
}

#[test]
fn drops_events_older_than_30_days_without_reusing_their_seq_even_across_a_restart() {
    let db = HubDb::open_memory().unwrap();
    let clock = ManualClock::at(0);
    let log = EventLog::new(db.clone(), clock.clone()).unwrap();
    append(
        &log,
        [
            event(T::ThreadStarted, "lab-a"),
            event(T::ThreadCompleted, "lab-a"),
        ],
    );
    clock.advance(Duration::from_secs(29 * 86_400));
    append(&log, [event(T::ThreadFailed, "lab-a")]);
    assert_eq!(wait_now(&log, Some(0)).events.len(), 3);
    clock.advance(Duration::from_secs(2 * 86_400));
    assert_eq!(
        append(&log, [event(T::ThreadInterrupted, "lab-a")])[0]
            .seq
            .get(),
        4
    );
    assert_eq!(seqs(&wait_now(&log, Some(0))), [3, 4]);

    // A restarted hub prunes on start and keeps counting from the database's sequence.
    clock.advance(Duration::from_secs(31 * 86_400));
    let restarted = EventLog::new(db, clock).unwrap();
    assert_eq!(
        (restarted.head(), wait_now(&restarted, Some(0)).events.len()),
        (4, 0)
    );
    assert_eq!(
        append(&restarted, [event(T::ThreadStarted, "lab-a")])[0]
            .seq
            .get(),
        5
    );
}

/// A hub from before the order router went: its intake.routed events go, so every stored event still decodes.
#[test]
fn routed_intents_go_on_an_older_hub() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let gone = MIGRATIONS
        .iter()
        .position(|m| m.contains("type = 'intake.routed'"))
        .expect("the router migration");
    for m in &MIGRATIONS[..gone] {
        conn.execute_batch(m).unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO events (created_ms, type, data) VALUES (0, 'intake.routed', '{"workstreamId":"W1"}'),
          (0, 'workstream.running', '{"workstreamId":"W1"}');"#,
    )
    .unwrap();
    for m in &MIGRATIONS[gone..] {
        conn.execute_batch(m).unwrap();
    }
    let types: Vec<String> = conn
        .prepare("SELECT type FROM events")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(types, ["workstream.running"]);
}
