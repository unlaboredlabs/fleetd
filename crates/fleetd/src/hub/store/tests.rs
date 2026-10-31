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
        .position(|m| m.sql.contains("CREATE TABLE project_settings"))
        .expect("the profiles migration");
    for m in &MIGRATIONS[..profiles_at] {
        conn.execute_batch(m.sql).unwrap();
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
    conn.execute_batch(MIGRATIONS[profiles_at].sql).unwrap();

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
        .position(|m| m.sql.contains("type = 'intake.routed'"))
        .expect("the router migration");
    for m in &MIGRATIONS[..gone] {
        conn.execute_batch(m.sql).unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO events (created_ms, type, data) VALUES (0, 'intake.routed', '{"workstreamId":"W1"}'),
          (0, 'workstream.running', '{"workstreamId":"W1"}');"#,
    )
    .unwrap();
    for m in &MIGRATIONS[gone..] {
        conn.execute_batch(m.sql).unwrap();
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

/// A hub from before the retro went: its tables, events and incident class go, and a playbook change still open is
/// denied.
#[test]
fn the_retro_goes_on_an_older_hub() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let last = MIGRATIONS
        .iter()
        .position(|m| m.sql.contains("DROP TABLE retro_runs"))
        .unwrap();
    for m in &MIGRATIONS[..last] {
        conn.execute_batch(m.sql).unwrap();
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
    // Only this one: a later migration drops the incidents table.
    conn.execute_batch(MIGRATIONS[last].sql).unwrap();

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
        .position(|m| m.sql.contains("DROP TABLE status_eta"))
        .unwrap();
    for m in &MIGRATIONS[..drop] {
        conn.execute_batch(m.sql).unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO intake_routes (client_request_id, data) VALUES ('c1', '{}');
        INSERT INTO events (created_ms, type, data) VALUES (0, 'intake.routed', '{}'), (0, 'workstream.note', '{}'),
          (0, 'workstream.running', '{"workstreamId":"W1"}');"#,
    )
    .unwrap();
    conn.execute_batch(MIGRATIONS[drop].sql).unwrap();

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
        .position(|m| m.sql.contains("json_remove(data, '$.serves')"))
        .expect("the value bar migration");
    for m in &MIGRATIONS[..no_value_bar] {
        conn.execute_batch(m.sql).unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO tasks (machine_id, project_id, workstream_id, state, data)
          VALUES ('m', 'p', 'W1', 'done', '{"taskId":"T1","serves":"done:0"}');
        INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data)
          VALUES ('o/r', 1, 'merged', 'm', 'p', 0, '{"changeId":"X1","serves":"done:0"}');"#,
    )
    .unwrap();
    conn.execute_batch(MIGRATIONS[no_value_bar].sql).unwrap();

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
        .position(|m| m.sql.contains("DROP TABLE IF EXISTS review_waivers"))
        .expect("the one-review migration");
    for m in &MIGRATIONS[..gone] {
        conn.execute_batch(m.sql).unwrap();
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
        conn.execute_batch(m.sql).unwrap();
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
        .position(|m| m.sql.contains("json_remove(data, '$.parent')"))
        .expect("the finish-all migration");
    for m in &MIGRATIONS[..no_finish_all] {
        conn.execute_batch(m.sql).unwrap();
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
    conn.execute_batch(MIGRATIONS[no_finish_all].sql).unwrap();

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

/// A hub from before incidents went: the table and its events go, so every stored event still decodes.
#[test]
fn incidents_go_on_an_older_hub() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let gone = MIGRATIONS
        .iter()
        .position(|m| m.sql.contains("DROP TABLE incidents"))
        .expect("the incidents migration");
    for m in &MIGRATIONS[..gone] {
        conn.execute_batch(m.sql).unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO incidents (class, machine_id, project_id, data) VALUES ('policy_bypass', 'm', 'p', '{}');
        INSERT INTO events (created_ms, type, data) VALUES (0, 'incident.recorded', '{"incidentId":"I1"}'),
          (0, 'pr.merged_outside', '{"repo":"o/r","prNumber":8}');"#,
    )
    .unwrap();
    for m in &MIGRATIONS[gone..] {
        conn.execute_batch(m.sql).unwrap();
    }
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(
        count("SELECT count(*) FROM sqlite_master WHERE name LIKE 'incidents%'"),
        0
    );
    let types: Vec<String> = conn
        .prepare("SELECT type FROM events")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(types, ["pr.merged_outside"]);
}

/// A hub from before the train's worktree went: its `train.blocked` events go, so every stored event still decodes.
#[test]
fn train_blocked_events_go_on_an_older_hub() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let gone = MIGRATIONS
        .iter()
        .position(|m| m.sql.contains("'train.blocked'"))
        .expect("the train.blocked migration");
    for m in &MIGRATIONS[..gone] {
        conn.execute_batch(m.sql).unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO events (created_ms, type, data) VALUES (0, 'train.blocked', '{"error":"x"}'),
          (0, 'pr.merged', '{"repo":"o/r","prNumber":8}');"#,
    )
    .unwrap();
    for m in &MIGRATIONS[gone..] {
        conn.execute_batch(m.sql).unwrap();
    }
    let types: Vec<String> = conn
        .prepare("SELECT type FROM events")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(types, ["pr.merged"]);
}

/// A hub from before playbooks went: its pinned texts go, and a pinned workstream reads back unpinned.
#[test]
fn playbook_pins_go_on_an_older_hub() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let gone = MIGRATIONS
        .iter()
        .position(|m| m.sql.contains("DROP TABLE playbook_versions"))
        .expect("the playbooks migration");
    for m in &MIGRATIONS[..gone] {
        conn.execute_batch(m.sql).unwrap();
    }
    let pin = format!("bugfix@{}", "a".repeat(40));
    conn.execute_batch(&format!(
        r#"INSERT INTO workstreams (machine_id, project_id, state, data)
          VALUES ('m', 'p', 'running', '{{"workstreamId":"W1","state":"running","playbook":"{pin}"}}');
        INSERT INTO playbook_versions (ref, text) VALUES ('{pin}', 'x');"#
    ))
    .unwrap();
    for m in &MIGRATIONS[gone..] {
        conn.execute_batch(m.sql).unwrap();
    }
    let data: String = conn
        .query_row("SELECT data FROM workstreams", [], |r| r.get(0))
        .unwrap();
    assert_eq!(data, r#"{"workstreamId":"W1","state":"running"}"#);
    let tables: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'playbook_versions'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0);
}

#[test]
fn timestamps_keep_their_stored_form() {
    // Every stored timestamp reads back to the same instant and prints back to the same text.
    for stored in [
        "1970-01-01T00:00:00.000Z",
        "1969-12-31T23:59:59.999Z",
        "2024-02-29T23:59:59.500Z",
        "2026-10-17T10:00:00.000Z",
    ] {
        assert_eq!(iso_ms(parse_ms(stored).unwrap()), stored);
    }
    assert_eq!(parse_ms("1970-01-01T00:00:01.500Z"), Some(1500));
    assert_eq!(
        parse_ms("2026-10-17T10:00:00.000Z"),
        Some(1_792_231_200_000)
    );
    // GitHub's form has no fraction; finer digits are dropped, not rounded.
    assert_eq!(
        parse_ms("2026-10-17T12:30:00Z").map(iso_ms).as_deref(),
        Some("2026-10-17T12:30:00.000Z")
    );
    assert_eq!(
        parse_ms("2026-10-17T12:30:00.123999Z")
            .map(iso_ms)
            .as_deref(),
        Some("2026-10-17T12:30:00.123Z")
    );
    assert_eq!(parse_ms("not a time"), None);
    assert_eq!(system_ms(std::time::UNIX_EPOCH), 0);
}

/// A hub from before `close`: each done-when check becomes a plain line, a workstream left verifying runs again, and
/// the claims and plan items' check links go.
#[test]
fn stored_done_when_checks_become_plain_lines() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    // Found by content, not as the last migration, so later migrations don't break this test.
    let at = MIGRATIONS
        .iter()
        .position(|m| m.sql.contains("DROP TABLE claims"))
        .expect("the close migration");
    for m in &MIGRATIONS[..at] {
        conn.execute_batch(m.sql).unwrap();
    }
    let ts = "2026-10-18T10:00:00.000Z";
    let workstream = serde_json::json!({
        "workstreamId": "W1", "projectRef": { "machineId": "devbox", "projectId": "storefront" },
        "title": "Health page",
        "source": { "text": "Health page", "channel": "app", "by": "human", "at": ts },
        "state": "verifying", "createdAt": ts, "updatedAt": ts,
        "brief": {
            "goal": "g", "why": "w", "pointers": [], "constraints": [],
            "doneWhen": [
                { "type": "pr_merged", "repo": "acme/storefront", "pr": 12 },
                { "type": "ci_green", "repo": "acme/storefront" },
                { "type": "http", "url": "https://storefront.example/healthz", "status": 200, "contains": "ok" },
                { "type": "cmd", "machineId": "devbox", "argv": ["test", "-f", "docs/x.md"], "expectExit": 0 },
                { "type": "test", "repo": "acme/storefront", "testId": "health::answers" },
                { "type": "judge", "criteria": "the page reads well" },
                { "type": "human", "question": "good?" },
            ],
        },
    });
    conn.execute(
        "INSERT INTO workstreams (machine_id, project_id, state, data) VALUES ('devbox', 'storefront', 'verifying', ?)",
        [workstream.to_string()],
    )
    .unwrap();
    conn.execute_batch(
        r#"INSERT INTO plan_items (project_ref, milestone, workstream_id, state, weight, size, position, data)
             VALUES ('devbox/storefront', 1, 'W1', 'open', 'must', 2, 0, '{"title":"t","links":{"tasks":["T1"],"checks":[2]}}');
           INSERT INTO claims (workstream_id, machine_id, project_id) VALUES ('W1', 'devbox', 'storefront');"#,
    )
    .unwrap();
    conn.execute_batch(MIGRATIONS[at].sql).unwrap();
    let (state, data): (String, String) = conn
        .query_row("SELECT state, data FROM workstreams", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    let w: fleetd_contracts::ledger::Workstream = serde_json::from_str(&data).unwrap();
    assert_eq!(
        (state.as_str(), w.state),
        ("running", fleetd_contracts::ledger::WorkstreamState::Open)
    );
    let lines: Vec<&str> = w
        .brief
        .as_ref()
        .unwrap()
        .done_when
        .iter()
        .map(|l| l.as_str())
        .collect();
    assert_eq!(
        lines,
        [
            "PR #12 merged in acme/storefront",
            "CI green on acme/storefront",
            "GET https://storefront.example/healthz answers 200 containing \"ok\"",
            "on devbox: `test -f docs/x.md` exits 0",
            "test health::answers passes in acme/storefront",
            "the page reads well",
            "good?",
        ]
    );
    let links: String = conn
        .query_row(
            "SELECT json_extract(data, '$.links') FROM plan_items",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(links, r#"{"tasks":["T1"]}"#);
    let claims: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'claims'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(claims, 0);
}

/// A hub from before workstreams were open, done or stopped: every older state reads back as one of them, and the
/// playbook-change approvals the retro left go with their chat items, so every request and message still decodes.
#[test]
fn workstreams_are_open_done_or_stopped_on_an_older_hub() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    let at = MIGRATIONS
        .iter()
        .position(|m| m.sql.contains("THEN 'stopped' ELSE 'open'"))
        .expect("the open, done or stopped migration");
    for m in &MIGRATIONS[..at] {
        conn.execute_batch(m.sql).unwrap();
    }
    let ts = "2026-10-18T10:00:00.000Z";
    for (n, state) in [
        "draft",
        "running",
        "converging",
        "verifying",
        "done",
        "stopped",
        "failed",
    ]
    .iter()
    .enumerate()
    {
        let w = serde_json::json!({
            "workstreamId": format!("W{}", n + 1), "projectRef": { "machineId": "m", "projectId": "p" }, "title": "t",
            "source": { "text": "t", "channel": "app", "by": "human", "at": ts },
            "state": state, "createdAt": ts, "updatedAt": ts,
        });
        conn.execute(
            "INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (?1, 'm', 'p', ?2, ?3)",
            rusqlite::params![n as i64, state, w.to_string()],
        )
        .unwrap();
    }
    let request = |n: i64, subject: &str| {
        format!(
            r#"{{"requestId":"Q{n}","projectRef":{{"machineId":"m","projectId":"p"}},"kind":"approval","text":"t","state":"denied",{subject},"createdAt":"{ts}"}}"#
        )
    };
    let playbook = r#""playbook":{"proposalId":"R1","playbook":"bugfix","summary":"s","diff":"d"}"#;
    let permission =
        r#""permission":{"threadId":"t1","requestId":"r1","toolName":"Bash","summary":"ls"}"#;
    for (n, subject) in [(1, playbook), (2, permission)] {
        conn.execute(
            "INSERT INTO requests (n, project_key, kind, state, created_ms, data) VALUES (?1, 'm/p', 'approval', 'denied', 0, ?2)",
            rusqlite::params![n, request(n, subject)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chat_messages (machine_id, project_id, seq, created_ms, request, data) VALUES ('m', 'p', ?1, 0, ?2, ?3)",
            rusqlite::params![n, format!("Q{n}"), format!(r#"{{"item":{{"kind":"command_approval",{subject}}}}}"#)],
        )
        .unwrap();
    }
    conn.execute_batch(MIGRATIONS[at].sql).unwrap();

    let strings = |sql: &str| -> Vec<String> {
        conn.prepare(sql)
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(
        strings("SELECT state FROM workstreams ORDER BY n"),
        ["open", "open", "open", "open", "done", "stopped", "stopped"]
    );
    for (state, data) in strings("SELECT state FROM workstreams ORDER BY n")
        .iter()
        .zip(strings("SELECT data FROM workstreams ORDER BY n"))
    {
        let w: fleetd_contracts::ledger::Workstream = serde_json::from_str(&data).unwrap();
        assert_eq!(crate::hub::leads::digest::state_text(w.state), state);
    }
    for data in strings("SELECT data FROM requests") {
        let _: fleetd_contracts::ledger::HumanRequest = serde_json::from_str(&data).unwrap();
    }
    assert_eq!(strings("SELECT request FROM chat_messages"), ["Q2"]);
}

/// Plans went: their tables and the bar's series are dropped, and a claim stored with a plan item key keeps its other
/// keys, so it still reads.
#[test]
fn plans_go_and_a_claim_keeps_its_other_keys() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    // Found by content, not as the last migration, so later migrations don't break this test.
    let at = MIGRATIONS
        .iter()
        .position(|m| m.sql.contains("DROP TABLE plan_items"))
        .expect("the plans migration");
    for m in &MIGRATIONS[..at] {
        conn.execute_batch(m.sql).unwrap();
    }
    conn.execute_batch(
        r##"INSERT INTO work_claims (repo_key, base, state, owner_key, expires_ms, data)
             VALUES ('github.com/acme/shop', 'main', 'active', 'k1', 0,
               '{"claimId":"C1","keys":[{"issue":"#12"},{"item":"P5"},{"branch":"ada/x"}]}'),
                    ('github.com/acme/shop', 'main', 'active', 'k1', 0, '{"claimId":"C2","keys":[{"issue":"#13"}]}');"##,
    )
    .unwrap();
    conn.execute_batch(MIGRATIONS[at].sql).unwrap();
    let keys: Vec<String> = conn
        .prepare("SELECT json_extract(data, '$.keys') FROM work_claims ORDER BY n")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        keys,
        [
            r##"[{"issue":"#12"},{"branch":"ada/x"}]"##,
            r##"[{"issue":"#13"}]"##
        ]
    );
    let left: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name IN ('plan_items', 'plan_changes', 'plan_milestones', 'status_series')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0);
}

/// The 86 migrations from before one file each are, in order, the very SQL that older hubs ran, so an older hub's
/// `user_version` still counts the same steps.
#[test]
fn the_shipped_migrations_are_the_list_older_hubs_ran() {
    use super::migrations::MIGRATIONS;
    use sha2::{Digest, Sha256};
    // SHA-256 of each entry of the old list in migrations.rs, trimmed and followed by a NUL, as it stood at 0086.
    const SHIPPED: &str = "7948ebdf1a1def611f5c748b928842a60ffdf9312536c401fc721881ebeca6ca";
    let mut hash = Sha256::new();
    for m in &MIGRATIONS[..86] {
        // A file starts with its comment, which the old list kept in Rust.
        let sql: Vec<&str> = m.sql.lines().skip_while(|l| l.starts_with("--")).collect();
        hash.update(sql.join("\n").trim());
        hash.update([0]);
    }
    let hex: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, SHIPPED);
}

/// A hub that ran every migration of the old list opens with nothing run twice and ends with a fresh hub's schema.
#[test]
fn a_hub_at_the_old_lists_end_upgrades_to_a_fresh_hubs_schema() {
    use super::migrations::MIGRATIONS;
    fn schema(conn: &rusqlite::Connection) -> Vec<(String, String, Option<String>)> {
        conn.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
    let home = tempfile::tempdir().unwrap();
    {
        let conn = rusqlite::Connection::open(home.path().join("hub.sqlite")).unwrap();
        for m in &MIGRATIONS[..86] {
            conn.execute_batch(m.sql).unwrap();
        }
        conn.pragma_update(None, "user_version", 86).unwrap();
        // A row the old schema holds stays: no migration ran again over it.
        conn.execute_batch("INSERT INTO machines VALUES ('devbox', '{}')")
            .unwrap();
    }
    let upgraded = HubDb::open(home.path()).unwrap();
    assert_eq!(upgraded.user_version().unwrap(), MIGRATIONS.len() as i64);
    let fresh = HubDb::open_memory().unwrap();
    let (upgraded_schema, machines) = upgraded
        .with(|c| {
            Ok((
                schema(c),
                c.query_row("SELECT count(*) FROM machines", [], |r| r.get::<_, i64>(0))?,
            ))
        })
        .unwrap();
    assert_eq!(upgraded_schema, fresh.with(|c| Ok(schema(c))).unwrap());
    assert_eq!(machines, 1);
}

/// Profiles become rows with no change in what runs: high (the default) and medium on the fleet's model and effort,
/// the runner's own where none was set or claude refused it; each project allows medium unless its switch was off; a
/// project's overrides and the switch go.
#[test]
fn profiles_become_rows_and_each_project_keeps_what_it_allowed() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    // Found by content, not as the last migration, so later migrations don't break this test.
    let at = MIGRATIONS
        .iter()
        .position(|m| m.sql.contains("CREATE TABLE profiles ("))
        .expect("the profiles migration");
    for m in &MIGRATIONS[..at] {
        conn.execute_batch(m.sql).unwrap();
    }
    conn.execute_batch(
        r#"INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES
             ('devbox', 'on', '', '', '{}'), ('devbox', 'off', '', '', '{}'), ('devbox', 'unset', '', '', '{}');
           INSERT INTO project_settings (machine_id, project_id, medium_allowed) VALUES
             ('devbox', 'on', 1), ('devbox', 'off', 0);
           INSERT INTO profile_settings (machine_id, project_id, profile, model, effort, refused, set_at) VALUES
             ('', '', 'high', 'claude-sonnet-5-5', 'max', NULL, '2026-10-01T00:00:00.000Z'),
             ('', '', 'medium', 'claude-nope', NULL, 'claude refused it', '2026-10-01T00:00:00.000Z'),
             ('devbox', 'on', 'high', 'claude-haiku-5-5', 'low', NULL, '2026-10-01T00:00:00.000Z');"#,
    )
    .unwrap();
    conn.execute_batch(MIGRATIONS[at].sql).unwrap();
    let profiles: Vec<(i64, String, String, String, bool, bool)> = conn
        .prepare("SELECT id, name, model, effort, fast, is_default FROM profiles ORDER BY id")
        .unwrap()
        .query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        profiles,
        [
            (
                1,
                "high".into(),
                "claude-sonnet-5-5".into(),
                "max".into(),
                false,
                true
            ),
            (
                2,
                "medium".into(),
                "claude-opus-5-5".into(),
                "medium".into(),
                false,
                false
            ),
        ]
    );
    let note: String = conn
        .query_row("SELECT note FROM profiles WHERE name = 'medium'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(note.starts_with("Only for mechanical work"), "{note}");
    let allowed: Vec<String> = conn
        .prepare("SELECT project_id FROM project_profiles WHERE profile_id = 2 ORDER BY project_id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(allowed, ["on", "unset"]);
    let gone: i64 = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'profile_settings'
               OR (name = 'project_settings' AND sql LIKE '%medium_allowed%')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(gone, 0);
}

/// A fresh hub's profiles: high (the default) and medium, both on the runner's own.
#[test]
fn a_fresh_hub_has_high_and_medium() {
    let db = HubDb::open_memory().unwrap();
    let profiles = db.profiles().list().unwrap();
    let got: Vec<(&str, &str, &str, bool)> = profiles
        .iter()
        .map(|p| {
            (
                p.name.as_str(),
                p.model.as_str(),
                p.effort.as_str(),
                p.default,
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("high", "claude-opus-5-5", "high", true),
            ("medium", "claude-opus-5-5", "medium", false)
        ]
    );
}

/// A hub from before Google and Notion went (D236): the Google client, accounts and mail state go, and so do Navis'
/// Notion servers, each node that held a Notion token queued to forget it; a custom server stays as it was.
#[test]
fn google_and_notion_go_on_an_older_hub_and_their_secrets_are_queued_to_forget() {
    use super::migrations::MIGRATIONS;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    // Found by content, not as the last migration, so later migrations don't break this test.
    let gone = MIGRATIONS
        .iter()
        .position(|m| m.sql.contains("DROP TABLE google_client"))
        .expect("the no-Google-or-Notion migration");
    for m in &MIGRATIONS[..gone] {
        conn.execute_batch(m.sql).unwrap();
    }
    let sealed = |m: &str| format!(r#"{{"machineId":"{m}","fingerprint":"5ec2e7a1"}}"#);
    let server = |name: &str, kind: &str, holders: &[&str]| {
        let sealed_on: Vec<String> = holders.iter().map(|m| sealed(m)).collect();
        format!(
            r#"{{"scope":{{"kind":"project","machineId":"devbox","projectId":"navi"}},"name":"{name}","enabled":true,
            "roles":{{"lead":true,"writers":false,"reviewers":false}},
            "transport":{{"type":"stdio","command":"npx","args":["-y","server"]}},
            "env":[{{"name":"TOKEN","kind":"secret","sealedOn":[{}]}}],
            "integration":{{"kind":"{kind}"}},"updatedAt":"2026-10-27T00:00:00Z"}}"#,
            sealed_on.join(",")
        )
    };
    conn.execute(
        "INSERT INTO mcp_servers (machine_id, project_id, name, data) VALUES
           ('devbox', 'navi', 'notion', ?1), ('devbox', 'navi', 'crm', ?2), ('lab', 'navi2', 'notes', ?3)",
        rusqlite::params![
            server("notion", "notion", &["devbox"]),
            server("crm", "custom", &["devbox"]),
            server("notes", "notion", &["lab", "devbox"]),
        ],
    )
    .unwrap();
    conn.execute_batch(
        r#"INSERT INTO google_client (id, data) VALUES (1, '{"clientId":"1-a.apps.googleusercontent.com"}');
        INSERT INTO google_accounts (machine_id, project_id, data) VALUES ('devbox', 'navi', '{"email":"ana@example.com"}');
        INSERT INTO google_mail_state (id, pulled_ms) VALUES (1, 5);"#,
    )
    .unwrap();
    conn.execute_batch(MIGRATIONS[gone].sql).unwrap();
    for m in &MIGRATIONS[gone + 1..] {
        conn.execute_batch(m.sql).unwrap();
    }

    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
    assert_eq!(
        count("SELECT count(*) FROM sqlite_master WHERE name LIKE 'google%'"),
        0
    );
    let names: Vec<String> = conn
        .prepare("SELECT name FROM mcp_servers")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(names, ["crm"]);
    let queued: Vec<(String, String, String)> = conn
        .prepare("SELECT machine_id, project_id, name FROM mcp_secret_forgets ORDER BY 1, 2")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let row = |m: &str, p: &str, n: &str| (m.to_owned(), p.to_owned(), n.to_owned());
    assert_eq!(
        queued,
        [
            row("devbox", "navi", "notion"),
            row("devbox", "navi2", "notes"),
            row("lab", "navi2", "notes"),
        ]
    );
}
