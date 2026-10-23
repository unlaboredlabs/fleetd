//! Status over a real in-memory hub: plan calls and their markers, the done rule from train merges, and the project
//! rows and series the tools serve.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::plan::{
    PlanAddCall, PlanChangeKind, PlanDropCall, PlanItemState, PlanMilestoneCall,
};
use fleetd_contracts::status::{
    DropReason, ProgressDrop, ProgressPoint, ProjectRowState, ProjectStatusRow,
};
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
                "state": "running", "createdAt": AT, "updatedAt": AT,
            });
            c.execute(
                "INSERT INTO workstreams (machine_id, project_id, state, data) VALUES ('devbox', 'storefront', 'running', ?)",
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

/// The project's row and series as status_get serves them, `secs` later.
fn row_after(hub: &Hub, clock: &ManualClock, secs: u64) -> (ProjectStatusRow, Vec<ProgressPoint>) {
    clock.advance(Duration::from_secs(secs));
    hub.status
        .project(hub, &person(), &project())
        .unwrap()
        .expect("the project's row")
}

/// The project's bar `secs` later: (pct, the last point's drop).
fn bar_after(hub: &Hub, clock: &ManualClock, secs: u64) -> (i64, Option<ProgressDrop>) {
    let (row, series) = row_after(hub, clock, secs);
    (
        row.progress.expect("something to count").pct.get(),
        series.last().unwrap().drop.clone(),
    )
}

fn add(title: &str, extra: serde_json::Value) -> PlanAddCall {
    let mut v = json!({ "title": title, "milestoneId": "M1" });
    v.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(v).unwrap()
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

#[tokio::test]
async fn a_scope_change_after_the_planning_window_needs_a_reason_and_writes_a_marker() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    let (r, by) = (project(), "lead:devbox/storefront");
    let plans = &hub.plans;
    plans
        .milestone(
            &r,
            serde_json::from_value::<PlanMilestoneCall>(json!({ "title": "Checkout" })).unwrap(),
        )
        .unwrap();
    let p1 = plans
        .add(&r, by, add("cart page", json!({ "size": "l" })))
        .unwrap();
    assert!(p1.change.is_none(), "inside the planning window");
    plans.add(&r, by, add("payment page", json!({}))).unwrap();
    clock.advance(Duration::from_secs(11 * 60));
    let refused = plans.add(&r, by, add("receipts", json!({}))).unwrap_err();
    assert_eq!(refused.0.code, ErrorCode::Invalid);
    let added = plans
        .add(
            &r,
            by,
            add("receipts", json!({ "why": "receipts were missed" })),
        )
        .unwrap();
    let marker = added.change.unwrap();
    assert_eq!(marker.kind, PlanChangeKind::Scope);
    assert_eq!(marker.note.as_str(), "+1 item: receipts were missed");
    assert_eq!((marker.delta_items.get(), marker.delta_size.get()), (1, 3));
    let dropped = plans
        .drop_item(
            &r,
            by,
            serde_json::from_value::<PlanDropCall>(
                json!({ "itemId": "P2", "why": "folded into P1" }),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(dropped.item.state, PlanItemState::Dropped);
    assert_eq!(
        dropped.change.unwrap().note.as_str(),
        "−1 item: folded into P1"
    );
    let view = plans.view(&r, None).unwrap();
    assert_eq!(
        (view.progress.done.get(), view.progress.total.get()),
        (0, 2)
    );
    assert_eq!(view.markers.len(), 2);
}

#[tokio::test]
async fn an_item_is_done_only_from_a_train_merge_and_the_row_shows_it() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    let (r, by) = (project(), "lead:devbox/storefront");
    hub.plans
        .milestone(
            &r,
            serde_json::from_value::<PlanMilestoneCall>(json!({ "title": "Checkout" })).unwrap(),
        )
        .unwrap();
    hub.plans
        .add(&r, by, add("cart page", json!({ "workstreamId": "W1", "pr": "https://github.com/acme/storefront/pull/212" })))
        .unwrap();
    hub.plans
        .add(
            &r,
            by,
            add(
                "unlinked polish",
                json!({ "workstreamId": "W1", "weight": "polish" }),
            ),
        )
        .unwrap();
    assert!(!hub.plans.verify("W1"), "no merge yet");
    merged_change(&hub, 212);
    assert!(hub.plans.verify("W1"));
    let view = hub.plans.view(&r, None).unwrap();
    let p1 = &view.items[0];
    assert_eq!(p1.state, PlanItemState::Done);
    assert_eq!(
        p1.evidence.as_ref().unwrap().as_str(),
        "#212 merged by the train"
    );
    assert_eq!(
        view.progress.pct.get(),
        100,
        "polish never holds the number back"
    );

    let (row, _) = row_after(&hub, &clock, 1);
    let bar = row.progress.unwrap();
    assert_eq!(
        (bar.pct.get(), bar.verified_pct.get()),
        (100, 100),
        "the row's bar counts it verified"
    );

    hub.plans
        .close_order("W1", fleetd_contracts::ledger::WorkstreamState::Done);
    let view = hub.plans.view(&r, None).unwrap();
    assert_eq!(
        view.items[1].state,
        PlanItemState::Dropped,
        "unlinked items close with the order"
    );
    assert_eq!(
        view.items[0].state,
        PlanItemState::Done,
        "a verified item stays done"
    );
}

fn set_order_state(hub: &Hub, state: &str) {
    hub.db
        .with(|c| {
            c.execute(
                "UPDATE workstreams SET state = ?1, data = json_set(data, '$.state', ?1) WHERE n = 1",
                [state],
            )?;
            Ok(())
        })
        .unwrap();
}

fn markers(hub: &Hub) -> Vec<String> {
    hub.db
        .with(|c| {
            Ok(c.prepare("SELECT note FROM plan_changes ORDER BY n")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?)
        })
        .unwrap()
}

#[tokio::test]
async fn an_unplanned_order_enters_and_leaves_the_figure_only_with_markers() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    assert!(hub.plans.placeholder_enter("W1", false));
    assert!(!hub.plans.placeholder_enter("W1", false), "once");
    assert_eq!(
        markers(&hub),
        vec!["+1 item: W1 Checkout redesign (no plan yet)"]
    );
    assert_eq!(bar_after(&hub, &clock, 0).0, 0, "it counts, unstarted");

    set_order_state(&hub, "done");
    hub.plans
        .placeholder_order_ended("W1", fleetd_contracts::ledger::WorkstreamState::Done);
    assert_eq!(
        bar_after(&hub, &clock, 1).0,
        100,
        "done stays in the figure"
    );
    assert_eq!(markers(&hub).len(), 1, "done changes no denominator");

    clock.advance(Duration::from_secs(12 * 3600));
    assert!(
        hub.plans.placeholder_roll_off().is_some(),
        "the roll-off is a deadline"
    );
    assert_eq!(markers(&hub).len(), 1, "not yet due");
    clock.advance(Duration::from_secs(12 * 3600));
    assert_eq!(hub.plans.placeholder_roll_off(), None);
    assert_eq!(markers(&hub)[1], "W1 done a day ago, leaves the figure");
    assert_eq!(
        row_after(&hub, &clock, 1).0.progress,
        None,
        "nothing left to count"
    );
}

#[tokio::test]
async fn a_planned_or_stopped_order_s_placeholder_leaves_with_a_marker() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    let (r, by) = (project(), "lead:devbox/storefront");
    hub.plans.placeholder_enter("W1", false);
    hub.plans
        .milestone(
            &r,
            serde_json::from_value::<PlanMilestoneCall>(json!({ "title": "Checkout" })).unwrap(),
        )
        .unwrap();
    hub.plans
        .add(&r, by, add("cart page", json!({ "workstreamId": "W1" })))
        .unwrap();
    assert_eq!(
        markers(&hub)[1],
        "−1 item: W1's placeholder gives way to its plan"
    );
    let clock2 = ManualClock::at(T0);
    let (hub2, _home2) = self::hub(clock2);
    hub2.plans.placeholder_enter("W1", false);
    hub2.plans
        .placeholder_order_ended("W1", fleetd_contracts::ledger::WorkstreamState::Stopped);
    assert_eq!(markers(&hub2)[1], "−1: W1 stopped");
}

/// A plan re-check per event is index lookups and stays within milliseconds, and a read of the rows within 200 ms
/// (timed in release builds), however much history the project has.
#[tokio::test]
async fn recompute_stays_bounded_with_two_thousand_items_and_changes() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    let r = project();
    hub.plans
        .milestone(
            &r,
            serde_json::from_value::<PlanMilestoneCall>(json!({ "title": "Big" })).unwrap(),
        )
        .unwrap();
    hub.db
        .with(|c| {
            let tx = c.unchecked_transaction()?;
            let sha = "b".repeat(40);
            for n in 1..=2000i64 {
                let change = json!({
                    "changeId": format!("X{n}"), "projectRef": { "machineId": "devbox", "projectId": "storefront" },
                    "repo": "acme/storefront", "prNumber": n, "prUrl": format!("https://github.com/acme/storefront/pull/{n}"),
                    "branch": "b", "taskId": format!("T{n}"), "workstreamId": "W1",
                    "headSha": sha, "state": "merged", "reviews": [], "createdAt": AT, "updatedAt": AT,
                });
                tx.execute(
                    "INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data)
                     VALUES ('acme/storefront', ?, 'merged', 'devbox', 'storefront', 0, ?)",
                    params![n, change.to_string()],
                )?;
                let state = if n <= 1980 { "done" } else { "open" };
                let data = json!({ "title": format!("item {n}"), "links": { "tasks": [format!("T{n}")], "prs": [], "checks": [] }, "after": [] });
                tx.execute(
                    "INSERT INTO plan_items (project_ref, milestone, workstream_id, state, weight, size, position, done_ms, data)
                     VALUES ('devbox/storefront', 1, 'W1', ?, 'must', 3, ?, ?, ?)",
                    params![state, n, (state == "done").then_some(T0 as i64), data.to_string()],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .unwrap();
    let plan: String = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "EXPLAIN QUERY PLAN SELECT data FROM changes
                 WHERE (CASE WHEN json_valid(data) THEN json_extract(data, '$.taskId') END) = 'T1'",
                [],
                |r| r.get(3),
            )?)
        })
        .unwrap();
    assert!(
        plan.contains("changes_by_task"),
        "linked Changes are an index lookup: {plan}"
    );
    // Wall time is asserted only in release builds; debug builds on shared CI runners vary too much. The index
    // assertion above is the work bound that holds everywhere.
    hub.plans.verify("W1");
    let started = std::time::Instant::now();
    hub.plans.verify("W1");
    let again = started.elapsed();
    let started = std::time::Instant::now();
    let (row, _) = row_after(&hub, &clock, 1);
    let read = started.elapsed();
    if !cfg!(debug_assertions) {
        assert!(again.as_millis() <= 2, "re-check took {again:?}");
        assert!(read.as_millis() <= 200, "reading the rows took {read:?}");
    }
    assert_eq!(
        row.progress, None,
        "every item merged, so the milestone finished and left the figure"
    );
}

#[tokio::test]
async fn an_item_with_no_order_is_verified_by_its_own_prs() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    let (r, by) = (project(), "lead:devbox/storefront");
    hub.plans
        .milestone(
            &r,
            serde_json::from_value::<PlanMilestoneCall>(json!({ "title": "Checkout" })).unwrap(),
        )
        .unwrap();
    hub.plans
        .add(
            &r,
            by,
            add(
                "own PR, no order",
                json!({ "pr": "https://github.com/acme/storefront/pull/212" }),
            ),
        )
        .unwrap();
    merged_change(&hub, 212);
    hub.plans.verify("W1");
    let view = hub.plans.view(&r, None).unwrap();
    assert_eq!(
        view.items[0].state,
        PlanItemState::Done,
        "its own PR merged by the train"
    );
    assert_eq!(
        view.items[0].evidence.as_ref().unwrap().as_str(),
        "#212 merged by the train"
    );
}

fn set_change(hub: &Hub, state: &str, from: Option<&str>) {
    let now = crate::hub::store::now_ms(hub.clock.as_ref());
    let at = crate::hub::store::iso_ms(now);
    let change = json!({
        "changeId": "X1", "projectRef": { "machineId": "devbox", "projectId": "storefront" }, "repo": "acme/storefront",
        "prNumber": 212, "prUrl": "https://github.com/acme/storefront/pull/212", "branch": "fleetd/T1-x",
        "workstreamId": "W1", "headSha": "b".repeat(40), "state": state,
        "reviews": [], "createdAt": iso_ms_of(T0 as i64), "updatedAt": at,
    });
    hub.db
        .with(|c| {
            c.execute("DELETE FROM changes", [])?;
            c.execute(
                "INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data)
                 VALUES ('acme/storefront', 212, ?, 'devbox', 'storefront', 0, ?)",
                params![state, change.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
    if let Some(from) = from {
        hub.events
            .append(crate::hub::store::NewEvent {
                at: fleetd_contracts::ids::Timestamp(at),
                r#type: fleetd_contracts::events::HubEventType::ChangeState,
                machine_id: Some(MachineId::unchecked("devbox")),
                project_id: Some(ProjectId::unchecked("storefront")),
                thread_id: None,
                summary: format!("X1 {from} → {state}"),
                data: Some(json!({
                    "changeId": "X1", "workstreamId": "W1", "repo": "acme/storefront", "prNumber": 212,
                    "from": from, "to": state,
                })),
                attention: None,
            })
            .unwrap();
    }
}

fn iso_ms_of(ms: i64) -> String {
    crate::hub::store::iso_ms(ms)
}

#[tokio::test]
async fn the_bar_rises_with_observed_stages_and_falls_only_with_an_explained_marker() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    let (r, by) = (project(), "lead:devbox/storefront");
    hub.plans
        .milestone(
            &r,
            serde_json::from_value::<PlanMilestoneCall>(json!({ "title": "Checkout" })).unwrap(),
        )
        .unwrap();
    hub.plans
        .add(
            &r,
            by,
            add(
                "cart page",
                json!({ "workstreamId": "W1", "pr": "https://github.com/acme/storefront/pull/212", "size": "m" }),
            ),
        )
        .unwrap();
    assert_eq!(
        bar_after(&hub, &clock, 1),
        (0, None),
        "planned, nothing observed"
    );
    set_change(&hub, "reviewing", None);
    assert_eq!(bar_after(&hub, &clock, 1).0, 50, "a PR opened");
    set_change(&hub, "ready", Some("reviewing"));
    let (row, _) = row_after(&hub, &clock, 1);
    let bar = row.progress.unwrap();
    assert_eq!(
        (
            bar.pct.get(),
            bar.verified_pct.get(),
            bar.in_flight_pct.get()
        ),
        (70, 0, 70),
        "review passed, all of it in flight"
    );

    set_change(&hub, "ci_failed", Some("ci"));
    let (pct, drop) = bar_after(&hub, &clock, 1);
    assert_eq!(pct, 50, "CI failed: back to PR open");
    let drop = drop.expect("the drop is explained");
    assert_eq!(
        (drop.reason, drop.from_pct.get(), drop.text.as_str()),
        (DropReason::CiFailed, 70, "CI failed on #212")
    );

    set_change(&hub, "ready", None);
    bar_after(&hub, &clock, 1);
    hub.db
        .with(|c| {
            c.execute("DELETE FROM changes", [])?;
            Ok(())
        })
        .unwrap();
    let (row, series) = row_after(&hub, &clock, 1);
    assert_eq!(row.progress.unwrap().pct.get(), 70, "no cause: it holds");
    assert!(
        series
            .windows(2)
            .all(|w| w[1].pct >= w[0].pct || w[1].drop.is_some()),
        "never a silent drop: {series:?}"
    );
}

/// What Status serves names no time to come: no ETA, no usual or remaining duration, no "slower than usual".
#[tokio::test]
async fn nothing_status_serves_is_a_time_estimate() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = one_item(&clock);
    set_writer(&hub, "T1", "running");
    set_change(&hub, "ready", Some("reviewing"));
    let rows = hub.status.project_rows(&hub, &person()).unwrap();
    let (row, series) = row_after(&hub, &clock, 30 * 60);
    let text = serde_json::to_string(&(rows, row, series))
        .unwrap()
        .to_lowercase();
    for word in [
        "eta",
        "estimate",
        "p50",
        "p90",
        "usual",
        "remaining",
        "left",
        "slower",
        "duration",
        "minutes",
    ] {
        assert!(!text.contains(word), "{word:?} in {text}");
    }
}

#[tokio::test]
async fn a_finished_milestone_lowers_the_bar_only_with_a_marker() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = hub(clock.clone());
    let (r, by) = (project(), "lead:devbox/storefront");
    for title in ["Checkout", "Search"] {
        hub.plans
            .milestone(
                &r,
                serde_json::from_value::<PlanMilestoneCall>(json!({ "title": title })).unwrap(),
            )
            .unwrap();
    }
    hub.plans
        .add(
            &r,
            by,
            add(
                "cart page",
                json!({ "workstreamId": "W1", "pr": "https://github.com/acme/storefront/pull/212", "size": "m" }),
            ),
        )
        .unwrap();
    hub.plans
        .add(
            &r,
            by,
            add("search box", json!({ "milestoneId": "M2", "size": "m" })),
        )
        .unwrap();
    bar_after(&hub, &clock, 1);
    set_change(&hub, "merged", None);
    assert_eq!(bar_after(&hub, &clock, 1).0, 45, "a merged m of two");
    assert!(
        hub.plans.verify("W1"),
        "M1 finishes and leaves the project's figure"
    );
    let (pct, drop) = bar_after(&hub, &clock, 1);
    assert_eq!(pct, 0, "only the search box is left");
    let drop = drop.expect("the drop is explained");
    assert_eq!(drop.reason, DropReason::ScopeChange);
    assert!(drop.text.as_str().contains("M1"), "{}", drop.text.as_str());
}

/// The rows are read again after any event, so a row is never older than the last thing that happened; and a row
/// whose machine, GitHub or merge train went quiet says so, with why and since when.
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
    let quiet = row(&hub).stale.expect("GitHub went quiet");
    assert_eq!(quiet.reason.as_str(), "not checked since the hub started");
    hub.status.fresh.touch(
        "github:acme/storefront",
        crate::hub::store::now_ms(hub.clock.as_ref()),
    );
    clock.advance(Duration::from_secs(1));
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
    let (hub, _home) = one_item(&clock);
    let (row, series) = row_after(&hub, &clock, 1);
    assert_eq!(row.title.as_str(), "storefront");
    assert_eq!(series.len(), 1, "the first point");
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

/// Puts `task`, a writer linked to the item, in `state`, and appends its `task.*` event as the hub does.
fn set_writer(hub: &Hub, task: &str, state: &str) {
    let now = crate::hub::store::now_ms(hub.clock.as_ref());
    let at = iso_ms_of(now);
    let row = json!({
        "taskId": task, "projectRef": { "machineId": "devbox", "projectId": "storefront" }, "workstreamId": "W1",
        "title": "cart page", "kind": "write", "prompt": "Build the cart page.",
        "model": "claude-opus-5-5", "effort": "high", "itemId": "P1", "state": state, "attempt": 1,
        "createdAt": iso_ms_of(T0 as i64), "startedAt": iso_ms_of(T0 as i64),
    });
    hub.db
        .with(|c| {
            c.execute(
                "DELETE FROM tasks WHERE json_extract(data, '$.taskId') = ?",
                [task],
            )?;
            c.execute(
                "INSERT INTO tasks (machine_id, project_id, workstream_id, state, data)
                 VALUES ('devbox', 'storefront', 'W1', ?, ?)",
                params![state, row.to_string()],
            )?;
            c.execute(
                "UPDATE plan_items SET started_ms = ?, data = json_set(data, '$.links.tasks',
                   (SELECT json_group_array(json_extract(data, '$.taskId')) FROM tasks))",
                [T0 as i64],
            )?;
            Ok(())
        })
        .unwrap();
    let r#type = match state {
        "running" => fleetd_contracts::events::HubEventType::TaskStarted,
        "failed" => fleetd_contracts::events::HubEventType::TaskFailed,
        "done" => fleetd_contracts::events::HubEventType::TaskCompleted,
        _ => return,
    };
    hub.events
        .append(crate::hub::store::NewEvent {
            at: fleetd_contracts::ids::Timestamp(at),
            r#type,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: Some(ProjectId::unchecked("storefront")),
            thread_id: None,
            summary: format!("{task} {state}: cart page"),
            data: Some(json!({ "taskId": task, "workstreamId": "W1" })),
            attention: None,
        })
        .unwrap();
}

/// The order's one m item, "cart page".
fn one_item(clock: &Arc<ManualClock>) -> (Arc<Hub>, tempfile::TempDir) {
    one_item_on(HubDb::open_memory().unwrap(), clock)
}

fn one_item_on(db: Arc<HubDb>, clock: &Arc<ManualClock>) -> (Arc<Hub>, tempfile::TempDir) {
    let (hub, home) = hub_on(db, clock.clone());
    let (r, by) = (project(), "lead:devbox/storefront");
    hub.plans
        .milestone(
            &r,
            serde_json::from_value::<PlanMilestoneCall>(json!({ "title": "Checkout" })).unwrap(),
        )
        .unwrap();
    hub.plans
        .add(
            &r,
            by,
            add("cart page", json!({ "workstreamId": "W1", "size": "m" })),
        )
        .unwrap();
    (hub, home)
}

/// The bug #261 fixed: an item whose writer had ended still earned in-stage credit for every minute since it started,
/// so the bar sat near the cap with nothing being built. In-stage credit is for work in flight only.
#[tokio::test]
async fn an_item_with_nothing_in_flight_holds_its_stage_credit() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = one_item(&clock);
    // Its writer finished without a PR (a research item, say): nothing else will happen until the lead acts.
    set_writer(&hub, "T1", "done");
    assert_eq!(
        bar_after(&hub, &clock, 2 * 3600).0,
        0,
        "two hours on: no time in the stage counts (45 before the fix)"
    );
}

#[tokio::test]
async fn in_stage_credit_moves_while_its_writer_runs_and_is_taken_back_with_a_marker_when_it_stops()
{
    let clock = ManualClock::at(T0);
    let (hub, _home) = one_item(&clock);
    set_writer(&hub, "T1", "running");
    let (running, _) = bar_after(&hub, &clock, 3 * 60);
    let (later, _) = bar_after(&hub, &clock, 30 * 60);
    assert_eq!(
        (running, later),
        (15, 45),
        "in flight: three minutes of a ten-minute step, then the 0.9 cap"
    );
    set_writer(&hub, "T1", "failed");
    let (stopped, drop) = bar_after(&hub, &clock, 1);
    assert_eq!(stopped, 0, "the in-stage credit is taken back");
    let drop = drop.expect("never a silent drop");
    assert_eq!(
        (drop.reason, drop.from_pct.get(), drop.text.as_str()),
        (
            DropReason::WorkStopped,
            later,
            "work stopped: an agent failed"
        )
    );
    assert_eq!(
        bar_after(&hub, &clock, 3 * 3600).0,
        stopped,
        "and it doesn't creep back"
    );
}

/// Work resumed after a gap earns in-stage credit from its own start: the hours nobody worked never count.
#[tokio::test]
async fn a_new_writer_after_a_gap_earns_from_its_own_start_not_from_the_stage_start() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = one_item(&clock);
    set_writer(&hub, "T1", "running");
    let (ran, _) = bar_after(&hub, &clock, 30 * 60);
    set_writer(&hub, "T1", "failed");
    assert_eq!(bar_after(&hub, &clock, 1).0, 0);
    clock.advance(Duration::from_secs(3 * 3600));
    // The lead starts a new writer for the same item three hours later.
    set_writer(&hub, "T2", "running");
    assert_eq!(
        bar_after(&hub, &clock, 1).0,
        0,
        "three idle hours earn nothing at its start ({ran} counted from the stage's start)"
    );
    let (three_min, _) = bar_after(&hub, &clock, 3 * 60);
    assert!(
        0 < three_min && three_min < ran,
        "it moves with the new writer's own minutes: 0 < {three_min} < {ran}"
    );
    assert_eq!(bar_after(&hub, &clock, 30 * 60).0, ran);
}

/// A PR the train holds on an error, or one in review with no reviewer running, is not work in flight: its unit
/// keeps the stage's credit and earns nothing more while it sits.
#[tokio::test]
async fn a_pr_the_train_holds_earns_no_in_stage_credit() {
    let clock = ManualClock::at(T0);
    let (hub, _home) = one_item(&clock);
    let held = |error: Option<&str>| {
        let change = json!({
            "changeId": "X1", "projectRef": { "machineId": "devbox", "projectId": "storefront" },
            "repo": "acme/storefront", "prNumber": 212, "prUrl": "https://github.com/acme/storefront/pull/212",
            "branch": "fleetd/T1-x", "taskId": "T9", "workstreamId": "W1", "headSha": "b".repeat(40),
            "state": "ready", "reviews": [], "lastError": error,
            "createdAt": iso_ms_of(T0 as i64),
            "updatedAt": iso_ms_of(crate::hub::store::now_ms(hub.clock.as_ref())),
        });
        hub.db
            .with(|c| {
                c.execute("DELETE FROM changes", [])?;
                c.execute(
                    "INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data)
                     VALUES ('acme/storefront', 212, 'ready', 'devbox', 'storefront', 0, ?)",
                    [change.to_string()],
                )?;
                c.execute(
                    "UPDATE plan_items SET data = json_set(data, '$.links.tasks', json('[\"T9\"]'))",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
    };
    held(Some("git: the node refused the checkout"));
    assert_eq!(bar_after(&hub, &clock, 1).0, 70);
    assert_eq!(
        bar_after(&hub, &clock, 3600).0,
        70,
        "held an hour: review passed, nothing more"
    );
    held(None);
    bar_after(&hub, &clock, 0);
    assert!(
        bar_after(&hub, &clock, 60).0 > 70,
        "moving on the train again, it earns in-stage credit"
    );
}

/// The stuck figure an update leaves behind: a point stored under the old credits. The drop rule holds a stored
/// figure until an observed event explains a fall, so the update restarts each series.
#[tokio::test]
async fn the_update_drops_the_old_status_tables_and_restarts_every_series() {
    let clock = ManualClock::at(T0);
    let home = tempfile::tempdir().unwrap();
    let db = HubDb::open(home.path()).unwrap();
    let (hub, _home) = one_item_on(db.clone(), &clock);
    set_writer(&hub, "T1", "done");
    // The old model stored 45 an hour later.
    db.with(|c| {
        c.execute(
            "INSERT INTO status_series (scope, at_ms, pct, verified) VALUES ('devbox/storefront', ?, 45, 0)",
            [T0 as i64 + 3_600_000],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        bar_after(&hub, &clock, 2 * 3600).0,
        45,
        "held: nothing since that point explains a fall"
    );
    // Found by content, not as the last migration, so a later migration doesn't break this test.
    let update = crate::hub::store::MIGRATIONS
        .iter()
        .find(|m| m.contains("DROP TABLE progress_calibration"))
        .expect("the status rows update");
    let tables = |c: &rusqlite::Connection| -> rusqlite::Result<Vec<String>> {
        c.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'
               AND name IN ('status_seen', 'status_planning', 'progress_calibration', 'status_series') ORDER BY name",
        )?
        .query_map([], |r| r.get(0))?
        .collect()
    };
    // The update ran when the hub opened the database; run it again on a copy of the tables it drops.
    db.with(|c| {
        c.execute_batch(
            "CREATE TABLE status_seen (x); CREATE TABLE status_planning (x); CREATE TABLE progress_calibration (x);",
        )?;
        c.execute_batch(update)?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        db.with(|c| Ok(tables(c)?)).unwrap(),
        vec!["status_series"],
        "only the series stays"
    );
    assert_eq!(bar_after(&hub, &clock, 1).0, 0);
}

/// Appends a `thread.*` event for `thread` on the test machine, as the node link does.
fn thread_event(hub: &Hub, kind: fleetd_contracts::events::HubEventType, thread: &str) {
    let at = iso_ms_of(crate::hub::store::now_ms(hub.clock.as_ref()));
    hub.events
        .append(crate::hub::store::NewEvent {
            at: fleetd_contracts::ids::Timestamp(at),
            r#type: kind,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: Some(ProjectId::unchecked("storefront")),
            thread_id: Some(fleetd_contracts::ids::ThreadId::unchecked(thread)),
            summary: format!("\"{thread}\" on devbox moved"),
            data: Some(json!({ "status": "running" })),
            attention: None,
        })
        .unwrap();
}

/// Sets `task`'s record as the task area does after its thread's event: `parked` on a usage limit, or running again.
fn set_record(hub: &Hub, task: &str, state: &str, parked: Option<serde_json::Value>) {
    hub.db
        .with(|c| {
            c.execute(
                "UPDATE tasks SET state = ?2, thread_id = 'th-1',
                   data = json_set(data, '$.state', ?2, '$.parked', json(?3))
                 WHERE json_extract(data, '$.taskId') = ?1",
                params![task, state, parked.map(|p| p.to_string())],
            )?;
            Ok(())
        })
        .unwrap();
}

/// The project's last point `secs` later.
fn point_after(hub: &Hub, clock: &ManualClock, secs: u64) -> ProgressPoint {
    row_after(hub, clock, secs).1.last().unwrap().clone()
}

/// A writer running since now, with nothing else happening: what the same minutes of work earn.
fn twin() -> (Arc<ManualClock>, Arc<Hub>, tempfile::TempDir) {
    let clock = ManualClock::at(T0);
    let (hub, home) = one_item(&clock);
    set_writer(&hub, "T1", "running");
    set_record(&hub, "T1", "running", None);
    (clock, hub, home)
}

/// The gap #261 left (#302): a task parked on a usage limit (or waiting for an answer) still earned in-stage credit up
/// to the cap while nobody worked. Parked, it holds what it earned with a marker; resumed, it goes on from there, so
/// its figure is always what the minutes it worked earn.
#[tokio::test]
async fn a_task_parked_on_a_usage_limit_holds_its_figure_and_goes_on_from_it() {
    use fleetd_contracts::events::HubEventType;
    let (clock, hub, _home) = twin();
    let (tclock, twin, _thome) = twin();
    let (start, _) = bar_after(&hub, &clock, 0);
    let (ran, _) = bar_after(&hub, &clock, 3 * 60);
    assert_eq!((start, ran), (0, 15), "it rises while it runs");

    thread_event(&hub, HubEventType::ThreadUsageLimited, "th-1");
    // Before the task area parks the record: the event alone pauses it.
    let at_park = point_after(&hub, &clock, 1);
    assert_eq!(
        (
            at_park.pct.get(),
            at_park.drop.is_none(),
            at_park.paused.as_ref().map(|p| p.as_str())
        ),
        (ran, true, Some("paused: an agent hit a usage limit")),
        "it holds what it earned, with a marker and no drop"
    );
    let parked = json!({ "class": "usage_limit", "since": iso_ms_of(crate::hub::store::now_ms(hub.clock.as_ref())) });
    set_record(&hub, "T1", "idle", Some(parked));
    for _ in 0..4 {
        assert_eq!(
            point_after(&hub, &clock, 30 * 60),
            at_park,
            "flat while parked: the paused point stays the last"
        );
    }

    // The usage layer's "continue" at the reset: the thread runs again, and the record follows it.
    thread_event(&hub, HubEventType::ThreadStarted, "th-1");
    let resumed = point_after(&hub, &clock, 0);
    assert_eq!(
        (resumed.pct.get(), resumed.drop, resumed.paused),
        (ran, None, None),
        "no jump: the two parked hours count for nothing, and the marker goes"
    );
    set_record(&hub, "T1", "running", None);
    let (four_min, _) = bar_after(&hub, &clock, 60);
    assert_eq!(
        (four_min, bar_after(&twin, &tclock, 4 * 60).0),
        (20, 20),
        "it goes on from {ran}: three minutes before and one after earn what four unbroken minutes do"
    );
}

/// A wait for an answer holds it the same way, and the lead's answer (which continues the task) goes on from there.
#[tokio::test]
async fn a_task_waiting_for_an_answer_holds_until_the_answer_continues_it() {
    use fleetd_contracts::events::HubEventType;
    let (clock, hub, _home) = twin();
    let (tclock, twin, _thome) = twin();
    let (ran, _) = bar_after(&hub, &clock, 3 * 60);
    thread_event(&hub, HubEventType::ThreadWaiting, "th-1");
    set_record(&hub, "T1", "idle", None);
    let held = point_after(&hub, &clock, 2 * 3600);
    assert_eq!(
        (
            held.pct.get(),
            held.drop,
            held.paused.map(|p| p.to_string())
        ),
        (
            ran,
            None,
            Some("paused: an agent is waiting for an answer".to_owned())
        )
    );
    // `message_agent` continues it: task.started.
    set_writer(&hub, "T1", "running");
    set_record(&hub, "T1", "running", None);
    assert_eq!(bar_after(&hub, &clock, 0), (ran, None));
    assert_eq!(
        bar_after(&hub, &clock, 3 * 60).0,
        bar_after(&twin, &tclock, 6 * 60).0
    );
}

/// The control: the same timeline with the limit hitting another thread (the lead's), a reminder of an open prompt,
/// and its own thread starting a new turn. None of them pauses it, so it keeps rising with no marker.
#[tokio::test]
async fn another_threads_limit_or_a_new_turn_never_pauses_a_running_task() {
    use fleetd_contracts::events::HubEventType;
    let (clock, hub, _home) = twin();
    let (tclock, twin, _thome) = twin();
    bar_after(&hub, &clock, 60);
    thread_event(&hub, HubEventType::ThreadUsageLimited, "lead-th");
    hub.events
        .append(crate::hub::store::NewEvent {
            at: fleetd_contracts::ids::Timestamp(iso_ms_of(crate::hub::store::now_ms(
                hub.clock.as_ref(),
            ))),
            r#type: HubEventType::ThreadWaiting,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: Some(ProjectId::unchecked("storefront")),
            thread_id: Some(fleetd_contracts::ids::ThreadId::unchecked("th-1")),
            summary: "still waiting".into(),
            data: Some(json!({ "status": "waiting", "reminder": true })),
            attention: None,
        })
        .unwrap();
    thread_event(&hub, HubEventType::ThreadStarted, "th-1");
    let p = point_after(&hub, &clock, 2 * 60);
    assert_eq!(
        (p.pct.get(), p.drop, p.paused),
        (bar_after(&twin, &tclock, 3 * 60).0, None, None),
        "the same three minutes as with no thread event at all"
    );
    let later = point_after(&hub, &clock, 2 * 3600);
    assert!(
        later.pct > p.pct && later.paused.is_none(),
        "the two hours count as work: {} > {}",
        later.pct.get(),
        p.pct.get()
    );
}
