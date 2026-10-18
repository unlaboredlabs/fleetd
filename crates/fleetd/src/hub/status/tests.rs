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
