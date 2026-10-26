//! Status over a real in-memory hub: the project rows the tools serve, their groups, and that they follow events.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::status::{ProjectRowState, ProjectStatusRow, StatusGroup};
use rusqlite::params;
use serde_json::json;

use crate::hub::api::{Caller, Hub, HubConfig, Listen};
use crate::hub::serve::build_on;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const T0: u64 = 1_792_000_000_000;
const AT: &str = "2026-10-18T10:00:00.000Z";

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("storefront"),
    }
}

fn hub(clock: Arc<ManualClock>) -> (Arc<Hub>, tempfile::TempDir) {
    hub_on(HubDb::open_memory().unwrap(), clock)
}

fn hub_on(db: Arc<HubDb>, clock: Arc<ManualClock>) -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub = build_on(db, config, clock).unwrap();
    hub.store
        .projects_upsert_many(
            &MachineId::unchecked("devbox"),
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "storefront", "title": "storefront",
                "workspaceRoot": "/work/storefront",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
                "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    hub.db
        .with(|c| {
            let w = json!({
                "workstreamId": "W1", "projectRef": { "machineId": "devbox", "projectId": "storefront" },
                "title": "Checkout redesign",
                "source": { "text": "Checkout redesign", "channel": "app", "by": "human", "at": AT },
                "state": "open", "createdAt": AT, "updatedAt": AT,
            });
            c.execute(
                "INSERT INTO workstreams (machine_id, project_id, state, data) VALUES ('devbox', 'storefront', 'open', ?)",
                [w.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    (hub, home)
}

fn person() -> Caller {
    serde_json::from_value::<Caller>(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "admin", "machines": "*" }],
    }))
    .map(|c| Caller {
        kind: Some(KeyKind::Human),
        ..c
    })
    .unwrap()
}

fn row(hub: &Hub) -> ProjectStatusRow {
    hub.status.project_rows(hub, &person()).unwrap().remove(0)
}

/// Something that changes a row, as the hub announces it.
fn announce(hub: &Hub, r#type: fleetd_contracts::events::HubEventType) {
    hub.events
        .append(crate::hub::store::NewEvent {
            at: fleetd_contracts::ids::Timestamp(AT.into()),
            r#type,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: Some(ProjectId::unchecked("storefront")),
            thread_id: None,
            summary: "changed".into(),
            data: None,
            attention: None,
        })
        .unwrap();
}

fn writer(hub: &Hub, task: &str, state: &str) {
    let at = iso_ms_of(T0 as i64);
    let ended = matches!(state, "done" | "failed" | "cancelled").then(|| at.clone());
    let row = json!({
        "taskId": task, "projectRef": { "machineId": "devbox", "projectId": "storefront" }, "workstreamId": "W1",
        "title": format!("work of {task}"), "kind": "write", "prompt": "Build it.",
        "model": "claude-opus-5-5", "effort": "high", "state": state, "attempt": 1,
        "createdAt": at, "startedAt": at, "endedAt": ended,
    });
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data)
                 VALUES (?, 'devbox', 'storefront', 'W1', ?, ?)",
                params![task[1..].parse::<i64>().unwrap(), state, row.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
}

fn pr(hub: &Hub, n: i64, task: Option<&str>, state: &str) {
    let change = json!({
        "changeId": format!("X{n}"), "projectRef": { "machineId": "devbox", "projectId": "storefront" },
        "repo": "acme/storefront", "prNumber": 200 + n,
        "prUrl": format!("https://github.com/acme/storefront/pull/{}", 200 + n), "branch": format!("fleetd/pr-{n}"),
        "taskId": task, "workstreamId": "W1", "headSha": "b".repeat(40), "state": state, "reviews": [],
        "createdAt": iso_ms_of(T0 as i64), "updatedAt": iso_ms_of(T0 as i64),
    });
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO changes (n, repo, pr_number, state, machine_id, project_id, train_order, data)
                 VALUES (?1, 'acme/storefront', ?2, ?3, 'devbox', 'storefront', ?1, ?4)",
                params![n, 200 + n, state, change.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
}

/// One item per piece of work, each in the group its observed state puts it in: a writer is grouped with its PR, a
/// PR no agent wrote stands alone, and the lead's question waits on you.
#[tokio::test]
async fn each_piece_of_work_is_in_one_group_from_what_the_hub_saw() {
    use fleetd_contracts::chat::ChatAuthor;

    use crate::hub::chat::NewMessage;

    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    writer(&hub, "T1", "running");
    writer(&hub, "T2", "done");
    pr(&hub, 1, Some("T2"), "reviewing");
    writer(&hub, "T3", "done");
    pr(&hub, 2, None, "ci");
    pr(&hub, 3, None, "merged");
    pr(&hub, 4, None, "abandoned");
    hub.chat
        .add(
            &project(),
            NewMessage {
                author: Some(ChatAuthor::Lead),
                text: "1. Ship the cart page behind a flag? I'd say yes.".into(),
                ..Default::default()
            },
        )
        .unwrap();
    let row = row(&hub);
    let items: Vec<(StatusGroup, &str)> = row
        .items
        .iter()
        .map(|i| (i.group, i.title.as_str()))
        .collect();
    assert_eq!(
        items,
        [
            (StatusGroup::WaitingOnYou, "The lead's question in chat"),
            (StatusGroup::InReview, "work of T2"),
            (StatusGroup::Working, "work of T1"),
            (StatusGroup::Landing, "fleetd/pr-2"),
            (StatusGroup::Idle, "work of T3"),
            (StatusGroup::Idle, "fleetd/pr-4"),
            (StatusGroup::Done, "fleetd/pr-3"),
        ]
    );
    let c = &row.counts;
    assert_eq!(
        [
            c.waiting_on_you,
            c.in_review,
            c.working,
            c.landing,
            c.idle,
            c.done
        ]
        .map(|n| n.get()),
        [1, 1, 1, 1, 2, 1]
    );
    let t2 = &row.items[1];
    assert_eq!(
        (
            t2.task_id.as_ref().map(|t| t.as_str()),
            t2.pr.as_ref().map(|p| p.number.get())
        ),
        (Some("T2"), Some(201)),
        "the writer opens its agent, and carries its PR"
    );
    assert_eq!(
        row.items[5].why.as_ref().map(|w| w.as_str()),
        Some("abandoned")
    );

    // A week on, nothing idle or done is news; what is still in flight stays.
    clock.advance(Duration::from_millis(super::groups::WINDOW_MS as u64 + 1));
    announce(&hub, fleetd_contracts::events::HubEventType::TaskStarted);
    let later = super::rows::read(
        &hub,
        &hub.status.fresh,
        crate::hub::store::now_ms(hub.clock.as_ref()),
    )
    .unwrap()
    .remove(0);
    let groups: Vec<StatusGroup> = later.items.iter().map(|i| i.group).collect();
    assert_eq!(
        groups,
        [
            StatusGroup::WaitingOnYou,
            StatusGroup::InReview,
            StatusGroup::Working,
            StatusGroup::Landing
        ]
    );
}

/// The rows are read again after an event and only then: nothing in a row moves with the clock alone.
#[tokio::test]
async fn the_rows_are_read_again_after_an_event_and_only_then() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    assert_eq!(row(&hub).counts.working.get(), 0);
    writer(&hub, "T1", "running");
    clock.advance(Duration::from_secs(3600));
    assert_eq!(
        row(&hub).counts.working.get(),
        0,
        "no event yet: the same read"
    );
    announce(&hub, fleetd_contracts::events::HubEventType::TaskStarted);
    assert_eq!(
        row(&hub).counts.working.get(),
        1,
        "the event's read sees it"
    );
}

#[tokio::test]
async fn nothing_status_serves_is_a_score_or_a_time_estimate() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    writer(&hub, "T1", "running");
    pr(&hub, 1, None, "ci");
    let rows = hub.status.project_rows(&hub, &person()).unwrap();
    let text = serde_json::to_string(&rows).unwrap().to_lowercase();
    for word in [
        "pct\"",
        "progress",
        "eta",
        "estimate",
        "remaining",
        "duration",
        "minutes",
    ] {
        assert!(!text.contains(word), "{word:?} in {text}");
    }
}

#[tokio::test]
async fn a_row_follows_events_and_says_when_a_source_went_quiet() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    let row = |hub: &Hub| hub.status.project_rows(hub, &person()).unwrap().remove(0);
    let first = row(&hub);
    assert_eq!(
        (
            first.state,
            first.last_merged.is_none(),
            first.stale.is_none()
        ),
        (ProjectRowState::Idle, true, true)
    );
    // In the same millisecond: the event alone makes the next read new.
    merged_change(&hub, 212);
    hub.events
        .append(crate::hub::store::NewEvent {
            at: fleetd_contracts::ids::Timestamp(AT.into()),
            r#type: fleetd_contracts::events::HubEventType::PrMerged,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: Some(ProjectId::unchecked("storefront")),
            thread_id: None,
            summary: "#212 merged".into(),
            data: Some(json!({ "changeId": "X1", "prNumber": 212 })),
            attention: None,
        })
        .unwrap();
    let merged = row(&hub).last_merged.expect("the merge shows at once");
    assert_eq!(
        (merged.title.as_str(), merged.pr_number.map(|n| n.get())),
        ("Checkout redesign", Some(212))
    );

    // GitHub for its repo has not answered since the hub started.
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO trains (repo, machine_id, project_id, watch_since_ms) VALUES ('acme/storefront', 'devbox', 'storefront', 0)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    hub.status.fresh.expect(
        "github:acme/storefront",
        super::fresh::GITHUB_STALE_MS,
        T0 as i64,
    );
    clock.advance(Duration::from_secs(1));
    // Each change reaches the rows as an event: the follower's flips, the machine's going offline.
    announce(&hub, fleetd_contracts::events::HubEventType::SourceStale);
    let quiet = row(&hub).stale.expect("GitHub went quiet");
    assert_eq!(quiet.reason.as_str(), "not checked since the hub started");
    hub.status.fresh.touch(
        "github:acme/storefront",
        crate::hub::store::now_ms(hub.clock.as_ref()),
    );
    clock.advance(Duration::from_secs(1));
    announce(&hub, fleetd_contracts::events::HubEventType::SourceFresh);
    assert_eq!(row(&hub).stale, None, "live again once it answers");

    // Its machine stops sending heartbeats: blocked, and stale since the last one.
    let machine = json!({
        "machineId": "devbox", "name": "devbox", "tags": [], "status": "offline",
        "lastSeenAt": iso_ms_of(T0 as i64), "nodeVersion": "0.0.0",
    });
    hub.store
        .machine_upsert(&serde_json::from_value(machine).unwrap(), None)
        .unwrap();
    clock.advance(Duration::from_secs(1));
    announce(&hub, fleetd_contracts::events::HubEventType::MachineOffline);
    let offline = row(&hub);
    assert_eq!(offline.state, ProjectRowState::Blocked);
    let mark = offline.stale.expect("its machine went quiet");
    assert_eq!(mark.since.as_str(), iso_ms_of(T0 as i64));
    assert!(
        mark.reason
            .as_str()
            .starts_with("no heartbeat from devbox since"),
        "{}",
        mark.reason.as_str()
    );
}

#[tokio::test]
async fn status_get_answers_only_for_a_project_there_is() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock);
    let row = hub
        .status
        .project(&hub, &person(), &project())
        .unwrap()
        .expect("its row");
    assert_eq!(row.title.as_str(), "storefront");
    let missing = ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("nope"),
    };
    assert!(
        hub.status
            .project(&hub, &person(), &missing)
            .unwrap()
            .is_none()
    );
}

fn merged_change(hub: &Hub, pr: i64) {
    let sha = "b".repeat(40);
    let change = json!({
        "changeId": "X1", "projectRef": { "machineId": "devbox", "projectId": "storefront" }, "repo": "acme/storefront",
        "prNumber": pr, "prUrl": format!("https://github.com/acme/storefront/pull/{pr}"), "branch": "fleetd/T1-x",
        "workstreamId": "W1", "headSha": sha, "state": "merged", "reviews": [],
        "createdAt": AT, "updatedAt": AT,
    });
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data)
                 VALUES ('acme/storefront', ?, 'merged', 'devbox', 'storefront', 0, ?)",
                params![pr, change.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
}

fn iso_ms_of(ms: i64) -> String {
    crate::hub::store::iso_ms(ms)
}

/// A usage pause blocks the row and offers Resume; on a machine that is also degraded, the row names both and the
/// pause keeps its own words.
#[tokio::test]
async fn a_usage_pause_blocks_the_row_and_names_itself_beside_a_degraded_machine() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock);
    hub.ops.bind(&hub);
    for (i, thread) in ["w1", "w2"].iter().enumerate() {
        let event: crate::hub::store::NewEvent = serde_json::from_value(json!({
            "at": crate::hub::store::iso_ms(T0 as i64 + i as i64 * 1000), "type": "thread.usage_limited",
            "machineId": "devbox", "threadId": thread, "summary": "hit the usage limit",
            "data": { "usageClass": "usage_limit", "resumeAt": "2026-10-18T15:00:00.000Z" },
        }))
        .unwrap();
        hub.events.append(event).unwrap();
    }
    hub.usage.drain().await;
    let paused = "paused until Sun 15:00 UTC (usage limit on devbox's login)";
    let r = row(&hub);
    assert_eq!(r.state, ProjectRowState::Blocked);
    assert_eq!(r.blocked_reason.as_ref().map(|l| l.as_str()), Some(paused));
    assert_eq!(r.usage_paused_on, Some(MachineId::unchecked("devbox")));
    assert_eq!(
        r.usage_paused_reason.as_ref().map(|l| l.as_str()),
        Some(paused)
    );

    let machine = json!({
        "machineId": "devbox", "name": "devbox", "tags": [], "status": "degraded",
        "lastSeenAt": crate::hub::store::iso_ms(T0 as i64), "nodeVersion": "0.0.0",
    });
    hub.store
        .machine_upsert(&serde_json::from_value(machine).unwrap(), None)
        .unwrap();
    announce(
        &hub,
        fleetd_contracts::events::HubEventType::MachineDegraded,
    );
    let r = row(&hub);
    assert_eq!(
        r.blocked_reason.as_ref().map(|l| l.as_str()),
        Some("devbox can't run agents (see Machines), and its usage is paused")
    );
    assert_eq!(r.usage_paused_on, Some(MachineId::unchecked("devbox")));
    assert_eq!(
        r.usage_paused_reason.as_ref().map(|l| l.as_str()),
        Some(paused)
    );
}
