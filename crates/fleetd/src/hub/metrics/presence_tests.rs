//! App presence over a real in-memory hub: which frames are recorded, the per-key rate, the event's three facts and
//! nothing more, and focused minutes as `app.use` touches joined into sessions in `metrics_get`.
use std::time::Duration;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::metrics::HumanSource;
use fleetd_contracts::model::ProjectSummary;
use serde_json::json;

use super::human::MINUTE_MS;
use super::presence::{self, MIN_MS, WINDOW_MS};
use super::store::{self, TouchRow};
use super::tests::{NOW, admin, caller, get, hub, ms, project_from};
use crate::hub::api::{Caller, Hub};
use crate::hub::store::test_clock::ManualClock;

/// The hub's projects on devbox: web, which the frames name.
pub(crate) fn add_projects(hub: &Hub, ids: &[&str]) {
    let projects: Vec<ProjectSummary> = ids
        .iter()
        .map(|id| {
            serde_json::from_value(json!({
                "machineId": "devbox", "projectId": id, "title": id, "workspaceRoot": format!("/srv/{id}"),
                "threads": { "running": 0, "idle": 0, "waiting": 0, "failed": 0 }, "lastActivityAt": NOW,
            }))
            .unwrap()
        })
        .collect();
    hub.store
        .projects_upsert_many(&MachineId::unchecked("devbox"), &projects)
        .unwrap();
}

fn web() -> ProjectRef {
    serde_json::from_value(json!({ "machineId": "devbox", "projectId": "web" })).unwrap()
}

fn touches(hub: &Hub) -> Vec<TouchRow> {
    hub.db.with(|c| store::touches(c, 0, i64::MAX)).unwrap()
}

fn presence_events(hub: &Hub) -> Vec<serde_json::Value> {
    let page = hub
        .events
        .page(0, Some(&[HubEventType::AppPresence]), None)
        .unwrap();
    page.events
        .into_iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect()
}

/// A focused frame with input on web, `after` the clock moves on.
fn frame(hub: &Hub, clock: &ManualClock, who: &Caller, after: i64) -> bool {
    clock.advance(Duration::from_millis(after as u64));
    presence::record(hub, who, true, true, Some(&web())).unwrap()
}

#[test]
fn a_key_records_at_most_one_interval_a_minute_from_where_its_last_ended() {
    let p = presence::Presence::default();
    let t = ms(NOW);
    assert_eq!(p.interval("k1", t), Some((t - WINDOW_MS, t)));
    // A frame a little early on the app's timer still counts, from where the last one ended.
    assert_eq!(p.interval("k1", t + 58_000), Some((t, t + 58_000)));
    // One sooner than that adds too little.
    assert_eq!(p.interval("k1", t + 58_000 + MIN_MS - 1), None);
    // After a gap, the minute before the frame.
    assert_eq!(
        p.interval("k1", t + 10 * MINUTE_MS),
        Some((t + 9 * MINUTE_MS, t + 10 * MINUTE_MS))
    );
    // Each key has its own.
    assert_eq!(p.interval("k2", t + 58_000), Some((t - 2_000, t + 58_000)));
}

#[test]
fn only_a_human_keys_focused_minute_on_a_project_with_input_is_recorded() {
    let (hub, clock, _home) = hub();
    add_projects(&hub, &["web"]);
    let me = admin();
    clock.advance(Duration::from_secs(60));
    // Each fact missing: nothing.
    assert!(!presence::record(&hub, &me, false, true, Some(&web())).unwrap());
    assert!(!presence::record(&hub, &me, true, false, Some(&web())).unwrap());
    assert!(!presence::record(&hub, &me, true, true, None).unwrap());
    // An agent's key, or a key that can't read the machine: nothing.
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..admin()
    };
    assert!(!presence::record(&hub, &agent, true, true, Some(&web())).unwrap());
    let elsewhere = caller(json!([{ "role": "read", "machines": ["laptop"] }]));
    assert!(!presence::record(&hub, &elsewhere, true, true, Some(&web())).unwrap());
    // A project the hub doesn't know on that machine: nothing, and the key's minute isn't used up.
    for (machine, project) in [("devbox", "nope"), ("laptop", "web")] {
        let unknown: ProjectRef =
            serde_json::from_value(json!({ "machineId": machine, "projectId": project })).unwrap();
        assert!(!presence::record(&hub, &me, true, true, Some(&unknown)).unwrap());
    }
    assert!(presence_events(&hub).is_empty());

    assert!(presence::record(&hub, &me, true, true, Some(&web())).unwrap());
    // A second window's frame in the same minute: nothing more.
    assert!(!frame(&hub, &clock, &me, 5_000));
    let events = presence_events(&hub);
    assert_eq!(events.len(), 1);
    let now = ms(NOW) + 60_000;
    // The event carries when, where and whose: no content.
    let e = &events[0];
    assert_eq!(
        e["data"],
        json!({ "fromMs": now - WINDOW_MS, "toMs": now, "by": "desk" })
    );
    assert_eq!(
        (e["machineId"].as_str(), e["projectId"].as_str()),
        (Some("devbox"), Some("web"))
    );
    assert_eq!(e["summary"], "app in use");
}

#[tokio::test]
async fn focused_minutes_become_touches_joined_into_sessions() {
    let (hub, clock, _home) = hub();
    add_projects(&hub, &["web"]);
    let me = admin();
    let start = ms(NOW);
    // Three minutes in a row, two idle minutes, then one more: one session from start - 1 min to start + 4 min.
    assert!(frame(&hub, &clock, &me, 0));
    assert!(frame(&hub, &clock, &me, 60_000));
    assert!(frame(&hub, &clock, &me, 60_000));
    clock.advance(Duration::from_secs(60));
    assert!(!presence::record(&hub, &me, true, false, Some(&web())).unwrap());
    clock.advance(Duration::from_secs(60));
    assert!(!presence::record(&hub, &me, false, false, Some(&web())).unwrap());
    // The minute before this frame, not the idle ones since the last.
    assert!(frame(&hub, &clock, &me, 60_000));
    // A minute much later: a session of its own.
    assert!(frame(&hub, &clock, &me, 30 * MINUTE_MS));

    let cursor = project_from(&hub, 0);
    let rows = touches(&hub);
    assert_eq!(rows.len(), 5);
    assert!(rows.iter().all(|t| t.kind == "app.use"
        && t.src == "app"
        && t.end_ms == Some(t.at_ms + t.credit_ms)
        && t.project_id.as_deref() == Some("web")
        && t.key_id.as_deref() == Some("desk")
        && !t.estimated
        && !t.outside));
    assert_eq!(
        rows.iter()
            .map(|t| (t.at_ms - start, t.end_ms.unwrap() - start))
            .collect::<Vec<_>>(),
        [
            (-MINUTE_MS, 0),
            (0, MINUTE_MS),
            (MINUTE_MS, 2 * MINUTE_MS),
            (4 * MINUTE_MS, 5 * MINUTE_MS),
            (34 * MINUTE_MS, 35 * MINUTE_MS),
        ]
    );
    // A replay writes the same rows.
    sql_reset_cursor(&hub);
    project_from(&hub, 0);
    assert_eq!(touches(&hub).len(), 5);
    assert_eq!(project_from(&hub, cursor), cursor);

    clock.advance(Duration::from_secs(60));
    let out = get(
        &hub,
        &admin(),
        json!({ "since": "2026-10-25T00:00:00.000Z", "tz": "UTC" }),
    )
    .await
    .unwrap();
    // -1 to +5 min bridged over the two idle minutes, then the lone minute: 7 minutes, at least 5.
    assert_eq!(out.tiles.human.total_ms.get(), 7 * MINUTE_MS);
    assert_eq!(out.tiles.human.low_ms.get(), 5 * MINUTE_MS);
    let today = out
        .days
        .iter()
        .find(|d| d.day.as_str() == "2026-10-25")
        .unwrap();
    assert_eq!(
        today
            .human
            .iter()
            .map(|s| (s.source, s.ms.get()))
            .collect::<Vec<_>>(),
        [(HumanSource::App, 7 * MINUTE_MS)]
    );
}

fn sql_reset_cursor(hub: &Hub) {
    super::tests::sql(
        hub,
        "DELETE FROM time_cursors WHERE source = 'metrics:events'",
        &[],
    );
}
