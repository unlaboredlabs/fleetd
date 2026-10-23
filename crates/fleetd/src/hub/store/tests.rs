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

/// A hub from before task profiles: a task stored on claude-opus-5-5 at medium runs medium and every other one high,
/// the lead's saved model and effort go, and agent spans take their session's profile.
#[test]
fn stored_models_and_efforts_become_the_two_profiles() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    // Found by content, not as the last migration, so later migrations don't break this test.
    let profiles_at = MIGRATIONS
        .iter()
        .position(|m| m.contains("CREATE TABLE project_settings"))
        .expect("the profiles migration");
    for m in &MIGRATIONS[..profiles_at] {
        conn.execute_batch(m).unwrap();
    }
    let tasks = [
        (1, "claude-opus-5-5", "medium"),
        (2, "claude-opus-5-5", "high"),
        (3, "claude-haiku-5-5", "low"),
        (4, "claude-opus-5-5", "max"),
        (5, "claude-sonnet-5-5", "medium"),
    ];
    for (n, model, effort) in tasks {
        conn.execute(
            "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (?1, 'lab-a', 'p1', 'W1', 'done', ?2)",
            rusqlite::params![n, format!(r#"{{"taskId":"T{n}","model":"{model}","effort":"{effort}"}}"#)],
        )
        .unwrap();
    }
    conn.execute_batch(
        "INSERT INTO lead_settings VALUES ('lab-a', 'p1', 'claude-haiku-5-5', 'low');
         INSERT INTO time_spans (src, src_key, kind, cat, start_ms, task_id, role, lane, status)
           VALUES ('n', 'a', 2, 0, 0, 'T1', 'implementer', 'x', 0), ('n', 'b', 2, 0, 0, 'T3', 'implementer', 'x', 0),
                  ('n', 'c', 2, 0, 0, NULL, 'lead', 'x', 0), ('h', 'd', 30, 4, 0, NULL, NULL, 'x', 0);",
    )
    .unwrap();
    conn.execute_batch(MIGRATIONS[profiles_at]).unwrap();

    let profiles: Vec<(String, Option<String>, Option<String>)> = conn
        .prepare("SELECT json_extract(data, '$.profile'), json_extract(data, '$.model'), json_extract(data, '$.effort') FROM tasks ORDER BY n")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let only = |p: &str| (p.to_owned(), None, None);
    assert_eq!(
        profiles,
        [
            only("medium"),
            only("high"),
            only("high"),
            only("high"),
            only("high")
        ]
    );
    let spans: Vec<Option<String>> = conn
        .prepare("SELECT profile FROM time_spans ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        spans,
        [
            Some("medium".into()),
            Some("high".into()),
            Some("high".into()),
            None
        ],
        "agent spans take their task's profile, the lead's high; a hub span has none"
    );
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(
        count("SELECT count(*) FROM sqlite_master WHERE name = 'lead_settings'"),
        0
    );
    assert_eq!(
        count("SELECT count(*) FROM project_settings"),
        0,
        "medium stays on"
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

/// A hub from before the retro went: its tables, events and incidents go, and a playbook change still open is denied,
/// so every stored event, incident and request still decodes.
#[test]
fn the_retro_goes_on_an_older_hub() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let last = MIGRATIONS
        .iter()
        .position(|m| m.contains("DROP TABLE retro_runs"))
        .unwrap();
    for m in &MIGRATIONS[..last] {
        conn.execute_batch(m).unwrap();
    }
    let p = r#""projectRef":{"machineId":"lab-a","projectId":"p1"}"#;
    let change = r#""playbook":{"proposalId":"R1","playbook":"bugfix","summary":"reviewers 1 → 0","diff":"-a\n+b"}"#;
    for (state, n) in [("open", 1), ("approved", 2)] {
        conn.execute(
            "INSERT INTO requests (n, project_key, kind, state, created_ms, data) VALUES (?1, 'lab-a/p1', 'approval', ?2, 0, ?3)",
            rusqlite::params![
                n,
                state,
                format!(
                    r#"{{"requestId":"Q{n}",{p},"kind":"approval","text":"Loosen bugfix","state":"{state}",{change},"createdAt":"2026-10-18T10:00:00.000Z"}}"#
                )
            ],
        )
        .unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO retro_runs (at_ms, trigger, data) VALUES (0, 'schedule', '{}');
        INSERT INTO events (created_ms, type, data) VALUES (0, 'retro.ran', '{}'), (0, 'playbook.kept', '{}'),
          (0, 'workstream.running', '{"workstreamId":"W1"}');
        INSERT INTO incidents (class, machine_id, project_id, data) VALUES ('playbook_reverted', 'lab-a', 'p1', '{}'),
          ('stall', 'lab-a', 'p1', '{}');"#,
    )
    .unwrap();
    for m in &MIGRATIONS[last..] {
        conn.execute_batch(m).unwrap();
    }

    let strings = |sql: &str| -> Vec<String> {
        conn.prepare(sql)
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert!(strings("SELECT name FROM sqlite_master WHERE name LIKE 'retro_%'").is_empty());
    assert_eq!(strings("SELECT type FROM events"), ["workstream.running"]);
    assert_eq!(strings("SELECT class FROM incidents"), ["stall"]);
    assert_eq!(
        strings("SELECT state FROM requests ORDER BY n"),
        ["denied", "approved"]
    );
    for data in strings("SELECT data FROM requests ORDER BY n") {
        let request: fleetd_contracts::ledger::HumanRequest = serde_json::from_str(&data).unwrap();
        assert!(request.playbook.is_some(), "an older approval still reads");
    }
}

/// A hub from before the unused tables went: they are dropped, and the events nothing emits any more are deleted so
/// every stored event still decodes.
#[test]
fn unused_tables_and_events_go_on_an_older_hub() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    // Found by content, not as the last migration, so later migrations don't break this test.
    let drop = MIGRATIONS
        .iter()
        .position(|m| m.contains("DROP TABLE status_eta"))
        .unwrap();
    for m in &MIGRATIONS[..drop] {
        conn.execute_batch(m).unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO intake_routes (client_request_id, data) VALUES ('c1', '{}');
        INSERT INTO events (created_ms, type, data) VALUES (0, 'intake.routed', '{}'), (0, 'workstream.note', '{}'),
          (0, 'workstream.running', '{"workstreamId":"W1"}');"#,
    )
    .unwrap();
    conn.execute_batch(MIGRATIONS[drop]).unwrap();

    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(
        count(
            "SELECT count(*) FROM sqlite_master WHERE name IN ('intake_routes', 'status_eta', 'status_headlines')"
        ),
        0
    );
    let types: Vec<String> = conn
        .prepare("SELECT type FROM events")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(types, ["workstream.running"]);
}

/// A hub from before the value bar went: stored tasks and changes drop what they served.
#[test]
fn tasks_and_changes_from_an_older_hub_drop_what_they_served() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let no_value_bar = MIGRATIONS
        .iter()
        .position(|m| m.contains("json_remove(data, '$.serves')"))
        .expect("the value bar migration");
    for m in &MIGRATIONS[..no_value_bar] {
        conn.execute_batch(m).unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO tasks (machine_id, project_id, workstream_id, state, data)
          VALUES ('m', 'p', 'W1', 'done', '{"taskId":"T1","serves":"done:0"}');
        INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data)
          VALUES ('o/r', 1, 'merged', 'm', 'p', 0, '{"changeId":"X1","serves":"done:0"}');"#,
    )
    .unwrap();
    conn.execute_batch(MIGRATIONS[no_value_bar]).unwrap();

    let data: (String, String) = conn
        .query_row(
            "SELECT (SELECT data FROM tasks), (SELECT data FROM changes)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        data,
        (
            r#"{"taskId":"T1"}"#.to_string(),
            r#"{"changeId":"X1"}"#.to_string()
        )
    );
}

/// A hub from before every PR got one review: the waivers table goes, and stored briefs, tasks and changes lose their
/// tier.
#[test]
fn tiers_and_review_waivers_go_on_an_older_hub() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    // Found by content, not as the last migration, so later migrations don't break this test.
    let gone = MIGRATIONS
        .iter()
        .position(|m| m.contains("DROP TABLE IF EXISTS review_waivers"))
        .expect("the one-review migration");
    for m in &MIGRATIONS[..gone] {
        conn.execute_batch(m).unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO review_waivers (change_id, patch_id, reason) VALUES ('X1', 'p', 'polish loop');
        INSERT INTO workstreams (n, machine_id, project_id, state, data)
          VALUES (1, 'lab-a', 'p1', 'running', '{"workstreamId":"W1","brief":{"goal":"g","tier":"S"}}');
        INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data)
          VALUES (1, 'lab-a', 'p1', 'W1', 'done', '{"taskId":"T1","tier":"L"}');
        INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data)
          VALUES ('acme/app', 7, 'ready', 'lab-a', 'p1', 1, '{"changeId":"X1","tier":"S"}');"#,
    )
    .unwrap();
    for m in &MIGRATIONS[gone..] {
        conn.execute_batch(m).unwrap();
    }
    let one = |sql: &str| -> String { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(
        one("SELECT count(*) || '' FROM sqlite_master WHERE name = 'review_waivers'"),
        "0"
    );
    assert_eq!(
        one("SELECT data FROM workstreams"),
        r#"{"workstreamId":"W1","brief":{"goal":"g"}}"#
    );
    assert_eq!(one("SELECT data FROM tasks"), r#"{"taskId":"T1"}"#);
    assert_eq!(one("SELECT data FROM changes"), r#"{"changeId":"X1"}"#);
}

/// A hub from before finish-all went: its idle parent is done and unpinned, and its child forgets the parent.
#[test]
fn finish_all_workstreams_from_an_older_hub_read_back_plain() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let no_finish_all = MIGRATIONS
        .iter()
        .position(|m| m.contains("json_remove(data, '$.parent')"))
        .expect("the finish-all migration");
    for m in &MIGRATIONS[..no_finish_all] {
        conn.execute_batch(m).unwrap();
    }
    let pin = format!("finish-all@{}", "a".repeat(40));
    conn.execute_batch(&format!(
        r#"INSERT INTO workstreams (machine_id, project_id, state, data)
          VALUES ('m', 'p', 'idle', '{{"workstreamId":"W1","state":"idle","playbook":"{pin}"}}');
        INSERT INTO workstreams (machine_id, project_id, state, data)
          VALUES ('m', 'p', 'running', '{{"workstreamId":"W2","state":"running","parent":{{"workstreamId":"W1","serves":"issue:#3"}}}}');
        INSERT INTO playbook_versions (ref, text) VALUES ('{pin}', 'x');"#
    ))
    .unwrap();
    conn.execute_batch(MIGRATIONS[no_finish_all]).unwrap();

    let rows: Vec<(String, String)> = conn
        .prepare("SELECT state, data FROM workstreams ORDER BY n")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        rows,
        [
            (
                "done".to_owned(),
                r#"{"workstreamId":"W1","state":"done"}"#.to_owned()
            ),
            (
                "running".to_owned(),
                r#"{"workstreamId":"W2","state":"running"}"#.to_owned()
            ),
        ]
    );
    let pins: i64 = conn
        .query_row("SELECT count(*) FROM playbook_versions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(pins, 0);
}
