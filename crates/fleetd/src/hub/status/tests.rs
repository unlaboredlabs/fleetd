//! The status view over a real in-memory hub: plan calls and their markers, the done rule from train merges and
//! claim results, and the docs the tools serve.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::plan::{
    PlanAddCall, PlanChangeKind, PlanDropCall, PlanItemState, PlanMilestoneCall,
};
use fleetd_contracts::status::{HeadlineSource, StatusScope};
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
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
        router_model: None,
    };
    let hub = build_on(HubDb::open_memory().unwrap(), config, clock).unwrap();
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
        "workstreamId": "W1", "serves": "done:0", "tier": "M", "headSha": sha, "state": "merged", "reviews": [],
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

fn claim(hub: &Hub, check: i64, pass: bool) {
    hub.db
        .with(|c| {
            let n: i64 = c.query_row(
                "INSERT INTO claims (workstream_id, machine_id, project_id) VALUES ('W1', 'devbox', 'storefront') RETURNING n",
                [],
                |r| r.get(0),
            )?;
            let result = if pass { "pass" } else { "fail" };
            let claim = json!({
                "claimId": format!("C{n}"), "workstreamId": "W1", "by": "lead:devbox/storefront", "at": AT,
                "outcome": result,
                "results": [{
                    "checkIndex": check, "spec": { "type": "ci_green", "repo": "acme/storefront" }, "result": result,
                    "evidence": "", "ranBy": "hub", "at": AT,
                }],
            });
            c.execute("UPDATE claims SET outcome = ?, data = ? WHERE n = ?", params![result, claim.to_string(), n])?;
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
async fn an_item_is_done_only_from_a_train_merge_and_its_latest_check_and_the_doc_shows_it() {
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
        .add(&r, by, add("cart page", json!({ "workstreamId": "W1", "pr": "https://github.com/acme/storefront/pull/212", "check": 2 })))
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
    assert!(!hub.plans.verify("W1"), "no merge and no claim yet");
    merged_change(&hub, 212);
    assert!(!hub.plans.verify("W1"), "merged, but check 2 never ran");
    claim(&hub, 2, true);
    assert!(hub.plans.verify("W1"));
    let view = hub.plans.view(&r, None).unwrap();
    let p1 = &view.items[0];
    assert_eq!(p1.state, PlanItemState::Done);
    assert_eq!(
        p1.evidence.as_ref().unwrap().as_str(),
        "#212 merged by the train · check 2 passed C1"
    );
    assert_eq!(
        view.progress.pct.get(),
        100,
        "polish never holds the number back"
    );

    let scope = StatusScope::Order {
        workstream_id: WorkstreamId::unchecked("W1"),
    };
    let doc = hub.status.get(&hub, &person(), &scope, None).unwrap();
    assert_eq!(doc.progress.pct.get(), 100);
    assert_eq!(
        doc.done[0].evidence.as_str(),
        "#212 merged by the train · check 2 passed C1"
    );
    assert_eq!(
        doc.headline.source,
        HeadlineSource::Template,
        "nothing generated yet"
    );
    assert!(doc.version.get() > 0);
    let (unchanged, version) = hub
        .status
        .wait(&hub, &person(), &scope, None, Some(doc.version.get()), 0)
        .await;
    assert!(unchanged.is_none());
    assert_eq!(
        version,
        doc.version.get(),
        "a re-render with the same content keeps the version"
    );

    claim(&hub, 2, false);
    assert!(hub.plans.verify("W1"));
    let view = hub.plans.view(&r, None).unwrap();
    assert_eq!(
        view.items[0].state,
        PlanItemState::Open,
        "a later failing claim reopens it"
    );
    assert!(
        view.markers
            .iter()
            .any(|m| m.kind == PlanChangeKind::Reopened)
    );
    let doc = hub.status.get(&hub, &person(), &scope, None).unwrap();
    assert_eq!(doc.progress.pct.get(), 0);
    assert!(doc.version.get() > version);

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
        PlanItemState::Open,
        "linked items stay to be verified"
    );

    let fleet = hub
        .status
        .get(&hub, &person(), &StatusScope::Fleet, None)
        .unwrap();
    assert_eq!(fleet.title.as_str(), "Fleet");
    assert!(serde_json::to_vec(&fleet).unwrap().len() <= 16 * 1024);
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
    let fleet = |hub: &Hub| {
        hub.status
            .get(hub, &person(), &StatusScope::Fleet, None)
            .unwrap()
    };
    assert!(hub.plans.placeholder_enter("W1", false));
    assert!(!hub.plans.placeholder_enter("W1", false), "once");
    assert_eq!(
        markers(&hub),
        vec!["+1 item: W1 Checkout redesign (no plan yet)"]
    );
    let doc = fleet(&hub);
    assert_eq!(
        (
            doc.progress.done.get(),
            doc.progress.total.get(),
            doc.progress.pct.get()
        ),
        (0, 1, 0)
    );
    assert_eq!(
        doc.markers[0].text.as_str(),
        "+1 item: W1 Checkout redesign (no plan yet)"
    );

    set_order_state(&hub, "done");
    hub.plans
        .placeholder_order_ended("W1", fleetd_contracts::ledger::WorkstreamState::Done);
    clock.advance(Duration::from_secs(1));
    let doc = fleet(&hub);
    assert_eq!(
        (doc.progress.done.get(), doc.progress.total.get()),
        (1, 1),
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
    let doc = fleet(&hub);
    assert_eq!(doc.progress.total.get(), 0);
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
    let doc = hub
        .status
        .get(&hub, &person(), &StatusScope::Fleet, None)
        .unwrap();
    assert_eq!(doc.progress.total.get(), 1, "the real item, not both");

    let clock2 = ManualClock::at(T0);
    let (hub2, _home2) = self::hub(clock2);
    hub2.plans.placeholder_enter("W1", false);
    hub2.plans
        .placeholder_order_ended("W1", fleetd_contracts::ledger::WorkstreamState::Stopped);
    assert_eq!(markers(&hub2)[1], "−1: W1 stopped");
}

/// Spec §13: a plan re-check per event is index lookups and stays within milliseconds, and a full render within
/// 200 ms (timed in release builds), however much history the project has.
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
                    "branch": "b", "taskId": format!("T{n}"), "workstreamId": "W1", "serves": "done:0", "tier": "M",
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
    let doc = hub
        .status
        .get(&hub, &person(), &StatusScope::Fleet, None)
        .unwrap();
    let render = started.elapsed();
    if !cfg!(debug_assertions) {
        assert!(again.as_millis() <= 2, "re-check took {again:?}");
        assert!(render.as_millis() <= 200, "full render took {render:?}");
    }
    assert!(serde_json::to_vec(&doc).unwrap().len() <= super::render::MAX_DOC_BYTES);
}

#[tokio::test]
async fn an_item_with_no_order_is_verified_by_its_own_prs_only() {
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
        .add(&r, by, add("listed check, no order", json!({ "check": 2 })))
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
    claim(&hub, 2, true);
    merged_change(&hub, 212);
    hub.plans.verify("W1");
    let view = hub.plans.view(&r, None).unwrap();
    assert_eq!(
        view.items[0].state,
        PlanItemState::Open,
        "W1's check 2 is not this item's check"
    );
    assert_eq!(
        view.items[1].state,
        PlanItemState::Done,
        "its own PR merged by the train"
    );
    assert_eq!(
        view.items[1].evidence.as_ref().unwrap().as_str(),
        "#212 merged by the train"
    );
    claim(&hub, 2, false);
    hub.plans.verify("W1");
    let view = hub.plans.view(&r, None).unwrap();
    assert_eq!(
        view.items[1].state,
        PlanItemState::Done,
        "an order's failing claim never reopens it"
    );
}

fn set_change(hub: &Hub, state: &str, from: Option<&str>) {
    let now = crate::hub::store::now_ms(hub.clock.as_ref());
    let at = crate::hub::store::iso_ms(now);
    let change = json!({
        "changeId": "X1", "projectRef": { "machineId": "devbox", "projectId": "storefront" }, "repo": "acme/storefront",
        "prNumber": 212, "prUrl": "https://github.com/acme/storefront/pull/212", "branch": "fleetd/T1-x",
        "workstreamId": "W1", "serves": "done:0", "tier": "M", "headSha": "b".repeat(40), "state": state,
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
async fn the_estimate_rises_with_observed_stages_and_falls_only_with_an_explained_marker() {
    use fleetd_contracts::plan::ItemStage;
    use fleetd_contracts::status::{DropReason, RiskRule};
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
    let scope = StatusScope::Order {
        workstream_id: WorkstreamId::unchecked("W1"),
    };
    let step = |secs: u64| {
        clock.advance(Duration::from_secs(secs));
        hub.status.get(&hub, &person(), &scope, None).unwrap()
    };
    let d = step(1);
    let e0 = d.progress.estimate.clone().unwrap();
    let planning = e0.planning.clone().unwrap();
    assert!(
        !planning.active,
        "the plan exists, so planning's share is fixed"
    );
    assert!(e0.pct.get() > 0, "planning counts: not 0%");
    assert_eq!(e0.verified_pct.get(), 0);
    assert_eq!(
        d.progress.pct.get(),
        0,
        "the old figure is unchanged for the GPUI app"
    );

    set_change(&hub, "reviewing", None);
    hub.db
        .with(|c| {
            c.execute("UPDATE plan_items SET started_ms = ?", [T0 as i64])?;
            Ok(())
        })
        .unwrap();
    let d = step(1);
    let e1 = d.progress.estimate.clone().unwrap();
    assert!(
        e1.pct > e0.pct,
        "a PR opened: {} > {}",
        e1.pct.get(),
        e0.pct.get()
    );
    assert_eq!(d.in_progress[0].stage, Some(ItemStage::PrOpen));

    set_change(&hub, "ready", Some("reviewing"));
    let e2 = step(1).progress.estimate.unwrap();
    assert!(e2.pct > e1.pct, "review passed");
    assert!(e2.pct.get() < 100 && e2.in_flight_pct.get() == e2.pct.get());

    set_change(&hub, "ci_failed", Some("ci"));
    let d = step(1);
    let e3 = d.progress.estimate.clone().unwrap();
    assert!(e3.pct < e2.pct, "CI failed: the item fell back a stage");
    let series = e3.series.clone().unwrap();
    let drop = series
        .last()
        .unwrap()
        .drop
        .clone()
        .expect("the drop is explained");
    assert_eq!(drop.reason, DropReason::CiFailed);
    assert_eq!(drop.from_pct, e2.pct);
    assert_eq!(drop.text.as_str(), "CI failed on #212");

    set_change(&hub, "ready", None);
    step(1);
    hub.db
        .with(|c| {
            c.execute("DELETE FROM changes", [])?;
            Ok(())
        })
        .unwrap();
    let e4 = step(1).progress.estimate.unwrap();
    let held = e4.series.unwrap();
    assert!(
        held.windows(2)
            .all(|w| w[1].pct >= w[0].pct || w[1].drop.is_some()),
        "never a silent drop: {held:?}"
    );

    set_change(&hub, "reviewing", None);
    let d = step(10 * 3600);
    assert_eq!(d.in_progress[0].slower_than_usual, Some(true));
    assert!(
        d.risks.iter().any(|r| r.rule == RiskRule::SlowerThanUsual
            && r.message.as_str().contains("slower than usual")),
        "{:?}",
        d.risks
    );
    let row = &d.in_progress[0];
    assert_eq!(
        row.critical,
        Some(true),
        "the only open item is the critical path"
    );
    let steps: Vec<&str> = row
        .waiting_on
        .iter()
        .flatten()
        .map(|s| s.as_str())
        .collect();
    assert_eq!(
        steps,
        ["review of #212", "CI on #212", "merge", "done-when checks"]
    );
    assert!(
        d.eta.current.is_none() && d.eta.basis == fleetd_contracts::status::EtaBasis::None,
        "no time estimates; the retired ETA still decodes in older apps"
    );
    let text = serde_json::to_string(&d).unwrap();
    assert!(
        !text.contains("p50") && !text.contains("overdueMinutes") && !text.contains("\"current\"")
    );
}
