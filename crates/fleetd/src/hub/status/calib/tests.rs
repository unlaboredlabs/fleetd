use chrono_tz::Tz;
use fleetd_contracts::plan::{ItemStage, Size};
use fleetd_contracts::status::DropReason;
use fleetd_contracts::train::ChangeState;
use rusqlite::{Connection, params};

use super::*;
use crate::hub::status::model::{Obs, UnitKey, What};
use crate::hub::store::{HubDb, iso_ms};

const T0: i64 = 1_792_000_000_000;

fn unit(key: &str, pkey: &str, obs: &[(i64, What)]) -> Timeline {
    let k = UnitKey::Order(key.into());
    Timeline {
        key: k.clone(),
        label: key.into(),
        workstream: key.into(),
        pkey: pkey.into(),
        kind: UnitKind::Order,
        size: Size::M,
        order_ms: obs[0].0,
        plan_ms: Some(obs[0].0 + MIN),
        start_ms: obs[0].0,
        obs: obs
            .iter()
            .map(|(at_ms, what)| Obs {
                at_ms: *at_ms,
                unit: k.clone(),
                what: what.clone(),
            })
            .collect(),
        causes: Vec::new(),
        dropped: false,
    }
}

fn change(state: ChangeState) -> What {
    What::ChangeState {
        change: "X1".into(),
        state,
    }
}

/// Planned at 0, task at 10 min, PR at 40, merged at 50, verified at 60 (minutes from `at`).
fn hour_item(key: &str, pkey: &str, at: i64) -> Timeline {
    unit(
        key,
        pkey,
        &[
            (at, What::Created),
            (at + 10 * MIN, What::TaskStarted),
            (at + 40 * MIN, change(ChangeState::Queued)),
            (at + 50 * MIN, change(ChangeState::Merged)),
            (at + 60 * MIN, What::Verified),
        ],
    )
}

#[test]
fn weights_follow_where_the_time_went() {
    let units: Vec<Timeline> = (0..5)
        .map(|i| hour_item(&format!("W{i}"), "m/p", T0 + i * DAY_MS))
        .collect();
    let refs: Vec<&Timeline> = units.iter().collect();
    let p = params(&refs);
    assert_eq!(p.weight_samples, 5);
    let w = p.weights.unwrap();
    // 1/6 of the hour passed before the task started, 4/6 before the PR: the writing stretch weighs most.
    let writing = w.cum[ItemStage::PrOpen.index()] - w.cum[ItemStage::TaskStarted.index()];
    assert!(writing > 0.4, "{w:?}");
    assert!(w.cum[ItemStage::TaskStarted.index()] < 0.25, "{w:?}");
    let d = &p.durations[0];
    assert_eq!(
        (d.kind, d.size, d.durations.samples),
        (UnitKind::Order, Size::M, 5)
    );
    // A stage lasts until the next stage a unit was seen to reach: no push was seen, so task started runs to the PR.
    assert_eq!(d.durations.p50[ItemStage::Planned.index()], 10 * MIN);
    assert_eq!(d.durations.p50[ItemStage::TaskStarted.index()], 30 * MIN);
    assert_eq!(d.durations.p50[ItemStage::PrOpen.index()], 10 * MIN);
    assert_eq!(d.durations.stage_samples[ItemStage::TaskStarted.index()], 5);
    // A stage nobody saw is not measured at a few seconds: it keeps its share of the length, at least a minute.
    let unseen = ItemStage::BriefFrozen.index();
    assert_eq!(d.durations.stage_samples[unseen], 0);
    assert!(d.durations.p50[unseen] >= model::MIN_STAGE_MS);
}

/// Realistic CI: the train usually finds CI already green (ready → merging in a second), sometimes waits minutes.
#[test]
fn a_few_seconds_of_ci_never_makes_normal_ci_slower_than_usual() {
    let units: Vec<Timeline> = (0..6)
        .map(|i| {
            let at = T0 + i * DAY_MS;
            let ci = if i < 4 { 1_000 } else { 6 * MIN };
            unit(
                &format!("W{i}"),
                "m/p",
                &[
                    (at, What::Created),
                    (at + 2 * MIN, What::TaskStarted),
                    (at + 12 * MIN, change(ChangeState::Queued)),
                    (at + 15 * MIN, change(ChangeState::Ready)),
                    (at + 15 * MIN + ci, change(ChangeState::Merging)),
                    (at + 16 * MIN + ci, change(ChangeState::Merged)),
                    (at + 20 * MIN + ci, What::Verified),
                ],
            )
        })
        .collect();
    let cal = derive(&units, T0);
    let r = cal.resolve("m/p", UnitKind::Order, Size::M);
    let k = ItemStage::ReviewPassed.index();
    assert_eq!(r.durations.stage_samples[k], 6);
    assert_eq!(
        r.usual_ms(k),
        model::MIN_STAGE_MS,
        "1 s of CI is floored to a minute"
    );
    let in_ci = |minutes: i64| {
        let f = model::ItemFacts {
            reached: vec![(ItemStage::ReviewPassed, 0)],
        };
        model::item_progress(&f, minutes * MIN, &r, &[(0, i64::MAX)]).slower
    };
    assert!(!in_ci(4), "a normal few minutes of CI");
    assert!(!in_ci(9), "under ten minutes is never slower than usual");
    assert!(in_ci(11));
    let few = derive(&units[..4], T0).resolve("m/p", UnitKind::Order, Size::M);
    let f = model::ItemFacts {
        reached: vec![(ItemStage::ReviewPassed, 0)],
    };
    assert!(
        !model::item_progress(&f, 60 * MIN, &few, &[(0, i64::MAX)]).slower,
        "4 units are too few to call anything slow"
    );
}

#[test]
fn unfinished_and_dropped_units_are_not_measured() {
    let mut dropped = hour_item("W1", "m/p", T0);
    dropped.dropped = true;
    let open = unit(
        "W2",
        "m/p",
        &[(T0, What::Created), (T0 + MIN, change(ChangeState::Queued))],
    );
    let p = params(&[&dropped, &open]);
    assert_eq!(p.weight_samples, 0);
    assert!(p.weights.is_none() && p.durations.is_empty());
}

#[test]
fn a_project_with_few_units_falls_back_to_the_fleet() {
    let mut units: Vec<Timeline> = (0..5)
        .map(|i| hour_item(&format!("W{i}"), "m/big", T0 + i * DAY_MS))
        .collect();
    units.push(hour_item("W9", "m/small", T0));
    let cal = derive(&units, T0);
    let r = cal.resolve("m/small", UnitKind::Order, Size::M);
    assert_eq!(r.basis, fleetd_contracts::status::WeightsBasis::Fleet);
    let r = cal.resolve("m/big", UnitKind::Order, Size::M);
    assert_eq!(r.basis, fleetd_contracts::status::WeightsBasis::Project);
    assert_eq!(r.durations.p50[ItemStage::TaskStarted.index()], 30 * MIN);
}

#[test]
fn the_nightly_run_is_the_next_three_oclock() {
    let tz: Tz = "Europe/Berlin".parse().unwrap();
    let at = |d: u32, h: u32| {
        tz.with_ymd_and_hms(2026, 10, d, h, 0, 0)
            .unwrap()
            .timestamp_millis()
    };
    assert_eq!(next_run(at(19, 2), tz), at(19, 3));
    assert_eq!(next_run(at(19, 3), tz), at(20, 3));
    assert_eq!(next_run(at(19, 23), tz), at(20, 3));
}

fn event(c: &Connection, at: i64, ty: &str, data: serde_json::Value) {
    let body = serde_json::json!({ "type": ty, "summary": ty, "data": data });
    c.execute(
        "INSERT INTO events (created_ms, type, data) VALUES (?1, ?2, ?3)",
        params![at, ty, body.to_string()],
    )
    .unwrap();
}

/// An order with no plan items, as one unit: its task and PR are its stages, and a CI failure sends it back.
#[test]
fn an_order_without_a_plan_is_one_unit_that_falls_back_on_ci() {
    let db = HubDb::open_memory().unwrap();
    db.with(|c| {
        let ws = serde_json::json!({ "workstreamId": "W1", "createdAt": iso_ms(T0) });
        c.execute(
            "INSERT INTO workstreams (machine_id, project_id, client_request_id, state, data)
             VALUES ('m', 'p', 'r', 'done', ?1)",
            [ws.to_string()],
        )?;
        c.execute(
            "INSERT INTO tasks (machine_id, project_id, workstream_id, state, thread_id, data)
             VALUES ('m', 'p', 'W1', 'done', 't', '{\"taskId\":\"T1\",\"kind\":\"write\"}')",
            [],
        )?;
        c.execute(
            "INSERT INTO changes (repo, pr_number, state, machine_id, project_id, train_order, data)
             VALUES ('o/r', 7, 'merged', 'm', 'p', 1, '{\"changeId\":\"X1\",\"taskId\":\"T1\",\"workstreamId\":\"W1\"}')",
            [],
        )?;
        let w = |extra: serde_json::Value| {
            let mut v = serde_json::json!({ "workstreamId": "W1" });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        use serde_json::json;
        event(c, T0 + MIN, "workstream.running", w(json!({})));
        event(c, T0 + 2 * MIN, "task.started", w(json!({ "taskId": "T1" })));
        event(c, T0 + 20 * MIN, "change.queued", w(json!({ "changeId": "X1", "prNumber": 7 })));
        event(c, T0 + 25 * MIN, "change.state", w(json!({ "changeId": "X1", "to": "ci", "prNumber": 7 })));
        event(
            c,
            T0 + 28 * MIN,
            "change.state",
            w(json!({ "changeId": "X1", "from": "ci", "to": "ci_failed", "prNumber": 7 })),
        );
        event(c, T0 + 35 * MIN, "change.state", w(json!({ "changeId": "X1", "to": "merging", "prNumber": 7 })));
        event(c, T0 + 36 * MIN, "pr.merged", w(json!({ "changeId": "X1", "prNumber": 7 })));
        event(c, T0 + 40 * MIN, "workstream.done", w(json!({})));
        let units = timeline::load(c, T0 - DAY_MS, None)?;
        assert_eq!(units.len(), 1);
        let u = &units[0];
        assert_eq!((u.label.as_str(), u.kind, u.pkey.as_str()), ("W1", UnitKind::Order, "m/p"));
        assert_eq!(u.plan_ms, Some(T0 + 2 * MIN));
        use ItemStage::*;
        let at = |m: i64| u.facts_at(T0 + m * MIN).current();
        assert_eq!(at(1), (BriefFrozen, T0 + MIN));
        assert_eq!(at(21), (PrOpen, T0 + 20 * MIN));
        assert_eq!(at(26), (ReviewPassed, T0 + 25 * MIN));
        // Red CI sends it back to "PR open", with a marker that says why.
        assert_eq!(at(30), (PrOpen, T0 + 28 * MIN));
        assert!(
            u.causes
                .iter()
                .any(|c| c.reason == DropReason::CiFailed && c.text.contains("#7"))
        );
        assert_eq!(at(37), (Merged, T0 + 36 * MIN));
        assert_eq!(u.done_ms(), Some(T0 + 40 * MIN));
        let first = u.first_reached();
        assert_eq!(first[ReviewPassed.index()], Some(T0 + 25 * MIN));
        assert_eq!(first[CiGreen.index()], Some(T0 + 35 * MIN));
        Ok(())
    })
    .unwrap();
}

#[test]
fn recompute_stores_and_reloads() {
    let db = HubDb::open_memory().unwrap();
    db.with(|c| {
        let cal = recompute(c, T0)?;
        assert_eq!(stored(c)?, Some(cal));
        Ok(())
    })
    .unwrap();
}
