//! The metrics over a real in-memory hub: the projector's routes and stamps from the train's events, replays,
//! `metrics_get`'s figures by calendar day in a zone, its bounds, grants, and the prune.
use std::sync::Arc;
use std::time::Duration;

use chrono::NaiveDate;
use chrono_tz::Tz;
use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, Timestamp};
use fleetd_contracts::mcp::{ErrorCode, MetricsGetOutput};
use fleetd_contracts::metrics::{ActorKind, MergeRoute, RequestedBasis, SkipWhy};
use serde_json::{Value, json};

use super::compute::{self, MAX_DAYS};
use super::project;
use super::store::{self, MergeRow};
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::serve::build_on;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, NewEvent, iso_ms, parse_ms};

pub(super) const HOUR: i64 = 3_600_000;
pub(super) const DAY: i64 = 24 * HOUR;
pub(super) const NOW: &str = "2026-10-25T12:00:00.000Z";

pub(super) fn ms(t: &str) -> i64 {
    parse_ms(t).unwrap()
}

pub(super) fn hub() -> (Arc<Hub>, Arc<ManualClock>, tempfile::TempDir) {
    let clock = ManualClock::at(ms(NOW) as u64);
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let hub = build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    (hub, clock, home)
}

pub(super) fn caller(grants: Value) -> Caller {
    serde_json::from_value::<Caller>(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": NOW, "grants": grants,
    }))
    .map(|c| Caller {
        kind: Some(KeyKind::Human),
        ..c
    })
    .unwrap()
}

pub(super) fn admin() -> Caller {
    caller(json!([{ "role": "admin", "machines": "*" }]))
}

pub(super) fn sql(hub: &Hub, statement: &str, args: &[&dyn rusqlite::ToSql]) {
    hub.db
        .with(|c| {
            c.execute(statement, args)?;
            Ok(())
        })
        .unwrap();
}

/// W1 the person submitted in the app; W2 the lead opened from the chat.
pub(super) fn orders(hub: &Hub) {
    for (n, channel, at) in [
        (1, "app", "2026-10-20T08:00:00.000Z"),
        (2, "lead", "2026-10-21T09:00:00.000Z"),
    ] {
        let w = json!({
            "workstreamId": format!("W{n}"), "projectRef": { "machineId": "devbox", "projectId": "web" },
            "title": "Checkout", "source": { "text": "Checkout", "channel": channel, "by": "human", "at": at },
            "state": "open", "createdAt": at, "updatedAt": at,
        });
        sql(
            hub,
            "INSERT INTO workstreams (n, machine_id, project_id, state, data) VALUES (?1, 'devbox', 'web', 'open', ?2)",
            &[&n, &w.to_string()],
        );
    }
}

pub(super) fn change(
    hub: &Hub,
    n: i64,
    pr: i64,
    w: &str,
    task: Option<&str>,
    state: &str,
    created: &str,
) {
    let mut c = json!({
        "changeId": format!("X{n}"), "projectRef": { "machineId": "devbox", "projectId": "web" }, "repo": "acme/web",
        "prNumber": pr, "prUrl": format!("https://github.com/acme/web/pull/{pr}"), "branch": format!("fleetd/T{n}-x"),
        "workstreamId": w, "headSha": "b".repeat(40), "state": state, "reviews": [],
        "createdAt": created, "updatedAt": created,
    });
    if let Some(t) = task {
        c["taskId"] = json!(t);
    }
    sql(
        hub,
        "INSERT INTO changes (n, repo, pr_number, state, machine_id, project_id, train_order, data)
         VALUES (?1, 'acme/web', ?2, ?3, 'devbox', 'web', ?1, ?4)",
        &[&n, &pr, &state, &c.to_string()],
    );
}

pub(super) fn event(hub: &Hub, at: &str, kind: HubEventType, data: Value) {
    hub.events
        .append(NewEvent {
            at: Timestamp(at.into()),
            r#type: kind,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: Some(ProjectId::unchecked("web")),
            thread_id: None,
            summary: kind.as_str().into(),
            data: Some(data),
            attention: None,
        })
        .unwrap();
}

/// Projects every page from `cursor`, as the projector's loop does; the cursor it ends on.
pub(super) fn project_from(hub: &Hub, mut cursor: i64) -> i64 {
    loop {
        let (next, more) = project::step(&hub.db, &hub.events, cursor).unwrap();
        cursor = next;
        if !more {
            return cursor;
        }
    }
}

pub(super) fn rows(hub: &Hub) -> Vec<MergeRow> {
    hub.db
        .with(|c| store::merges(c, 0, i64::MAX, None))
        .unwrap()
}

pub(super) async fn get(
    hub: &Arc<Hub>,
    who: &Caller,
    input: Value,
) -> Result<MetricsGetOutput, CallError> {
    let out = registry().call(hub, who, "metrics_get", input).await?;
    // Decoding checks every bound the contract sets (the day list's 400 among them).
    Ok(serde_json::from_value(out).expect("metrics_get's output decodes against its contract"))
}

/// A week on acme/web: one change through the train, two fleetd PRs merged by hand (one known by its Change, one
/// by its `fleetd/` branch), one PR from outside, and a bot's PR.
pub(super) fn a_week(hub: &Hub) {
    orders(hub);
    sql(
        hub,
        "INSERT INTO trains (repo, machine_id, project_id, watch_since_ms) VALUES ('acme/web', 'devbox', 'web', 0)",
        &[],
    );
    sql(
        hub,
        "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (3, 'devbox', 'web', 'W2', 'done', '{}')",
        &[],
    );
    change(
        hub,
        1,
        7,
        "W1",
        Some("T1"),
        "merged",
        "2026-10-20T09:00:00.000Z",
    );
    change(
        hub,
        2,
        8,
        "W2",
        None,
        "abandoned",
        "2026-10-21T10:00:00.000Z",
    );
    let moved = |at, from, to| {
        event(
            hub,
            at,
            HubEventType::ChangeState,
            json!({ "changeId": "X1", "workstreamId": "W1", "repo": "acme/web", "prNumber": 7, "from": from, "to": to }),
        )
    };
    event(
        hub,
        "2026-10-20T08:00:00.000Z",
        HubEventType::WorkstreamCreated,
        json!({ "workstreamId": "W1" }),
    );
    moved("2026-10-20T09:30:00.000Z", "queued", "reviewing");
    moved("2026-10-20T10:00:00.000Z", "reviewing", "ready");
    // A bounce back to ready later keeps the first pass.
    moved("2026-10-20T10:30:00.000Z", "ready", "rebasing");
    moved("2026-10-20T11:00:00.000Z", "rebasing", "ready");
    event(
        hub,
        "2026-10-20T12:00:00.000Z",
        HubEventType::PrMerged,
        json!({ "changeId": "X1", "workstreamId": "W1", "repo": "acme/web", "prNumber": 7, "taskId": "T1",
                "mergedSha": "A".repeat(40), "batchPr": 12 }),
    );
    // Reported an hour after it merged: the git host's time counts.
    event(
        hub,
        "2026-10-21T15:00:00.000Z",
        HubEventType::PrMergedOutside,
        json!({ "repo": "acme/web", "prNumber": 8, "changeId": "X2", "mergedAt": "2026-10-21T14:00:00.000Z" }),
    );
    event(
        hub,
        "2026-10-22T11:00:00.000Z",
        HubEventType::PrMergedOutside,
        json!({ "repo": "acme/web", "prNumber": 9, "prCreatedAt": "2026-10-22T10:00:00.000Z",
                "authorKind": "human", "mergedByKind": "human" }),
    );
    event(
        hub,
        "2026-10-23T10:00:00.000Z",
        HubEventType::PrMergedOutside,
        json!({ "repo": "acme/web", "prNumber": 10, "head": "fleetd/T3-fix-totals" }),
    );
    event(
        hub,
        "2026-10-23T12:00:00.000Z",
        HubEventType::PrMergedOutside,
        json!({ "repo": "acme/web", "prNumber": 11, "head": "dependabot/npm/left-pad", "authorKind": "bot" }),
    );
}

#[tokio::test]
async fn a_week_of_merges_reads_as_routes_rates_and_order_times() {
    let (hub, _clock, _home) = hub();
    a_week(&hub);
    project_from(&hub, 0);
    let out = get(
        &hub,
        &admin(),
        json!({ "since": "2026-10-19T00:00:00.000Z", "tz": "UTC" }),
    )
    .await
    .unwrap();

    // 19th to the 25th: six whole days and half of today.
    assert_eq!(out.days.len(), 7);
    let merged = &out.tiles.merged;
    assert_eq!(merged.n.get(), 4, "the bot's PR is not a landed change");
    assert_eq!(
        (
            merged.by_route.train.get(),
            merged.by_route.fleetd_by_hand.get(),
            merged.by_route.outside.get(),
            merged.by_route.direct.get()
        ),
        (1, 2, 1, 0)
    );
    assert!((merged.per_day.get() - 4.0 / 6.5).abs() < 1e-9);

    // Order to merged: W1 asked at 08:00 and merged at 12:00 on the 20th; W2 the lead opened at 09:00 on the 21st,
    // its PRs merged at 14:00 that day and at 10:00 on the 23rd.
    let lead = &out.tiles.order_to_merged;
    assert_eq!(
        (
            lead.n.get(),
            lead.median_ms.map(|m| m.get()),
            lead.p90_ms.map(|m| m.get())
        ),
        (3, Some(5 * HOUR), Some(49 * HOUR))
    );
    assert_eq!((lead.from_opened.get(), lead.no_order.get()), (2, 1));
    assert_eq!(lead.pr_open_median_ms.map(|m| m.get()), Some(HOUR));
    assert_eq!(lead.previous_median_ms, None);

    let share = &out.tiles.through_fleetd;
    assert_eq!(share.pct.map(|p| p.get()), Some(25.0));
    assert_eq!(share.made_by_fleetd_pct.map(|p| p.get()), Some(75.0));
    // Nothing before the projector's first event was read: no previous period to compare with.
    assert_eq!(merged.previous_per_day, None);

    let numbers: Vec<_> = out
        .merges
        .iter()
        .map(|m| (m.pr_number.unwrap().get(), m.route))
        .collect();
    assert_eq!(
        numbers,
        [
            (10, MergeRoute::FleetdByHand),
            (9, MergeRoute::Outside),
            (8, MergeRoute::FleetdByHand),
            (7, MergeRoute::Train)
        ]
    );
    assert_eq!(out.merges_total.get(), 4);
    let train = out.merges.last().unwrap();
    assert_eq!(train.batch_pr.map(|n| n.get()), Some(12));
    assert_eq!(train.merged_by, Some(ActorKind::Train));
    assert_eq!(train.requested_basis, Some(RequestedBasis::Source));
    assert_eq!(
        train.first_pr_at.as_ref().map(|t| t.as_str()),
        Some("2026-10-20T09:00:00.000Z")
    );
    assert_eq!(
        train.review_passed_at.as_ref().map(|t| t.as_str()),
        Some("2026-10-20T10:00:00.000Z")
    );
    assert_eq!(
        train.sha.as_ref().map(|s| s.as_str()),
        Some(&*"a".repeat(40))
    );
    let by_branch = &out.merges[0];
    assert_eq!(
        (
            by_branch.task_id.as_ref().map(|t| t.as_str()),
            by_branch.workstream_id.as_ref().map(|w| w.as_str()),
            by_branch.requested_basis
        ),
        (Some("T3"), Some("W2"), Some(RequestedBasis::Opened))
    );
    let outside = &out.merges[1];
    assert_eq!(
        (
            outside.workstream_id.as_ref(),
            outside.order_to_merged_ms,
            outside.author
        ),
        (None, None, Some(ActorKind::Human))
    );

    // The bot's PR is counted on its day as not counted, never dropped.
    let the_23rd = out
        .days
        .iter()
        .find(|d| d.day.as_str() == "2026-10-23")
        .unwrap();
    assert_eq!(the_23rd.merged.fleetd_by_hand.get(), 1);
    assert_eq!(
        the_23rd
            .not_counted
            .iter()
            .map(|s| (s.why, s.n.get()))
            .collect::<Vec<_>>(),
        [(SkipWhy::Bot, 1)]
    );

    let repos = out.repos.expect("the fleet's view has one row per repo");
    assert_eq!(repos.len(), 1);
    assert_eq!(repos[0].repo.as_str(), "github.com/acme/web");
    assert_eq!(repos[0].n.get(), 4);
    assert_eq!(out.coverage.repos[0].repo.as_str(), "github.com/acme/web");
}

#[tokio::test]
async fn a_replay_writes_the_same_rows_and_the_train_has_the_last_word() {
    let (hub, _clock, _home) = hub();
    a_week(&hub);
    let cursor = project_from(&hub, 0);
    let first = rows(&hub);
    assert_eq!(first.len(), 5);
    assert_eq!(project_from(&hub, 0), cursor);
    assert_eq!(rows(&hub), first);

    // A report of the train's own merge as made outside it changes nothing that matters.
    event(
        &hub,
        "2026-10-24T09:00:00.000Z",
        HubEventType::PrMergedOutside,
        json!({ "repo": "acme/web", "prNumber": 7, "mergedByKind": "human" }),
    );
    project_from(&hub, cursor);
    let pr7 = rows(&hub)
        .into_iter()
        .find(|r| r.unit_key == "pr:7")
        .unwrap();
    assert_eq!(
        (
            pr7.route.as_str(),
            pr7.merged_ms,
            pr7.merged_by_kind.as_deref()
        ),
        ("train", ms("2026-10-20T12:00:00.000Z"), Some("train"))
    );
}

#[tokio::test]
async fn an_order_known_after_its_merge_gets_its_request_time() {
    let (hub, _clock, _home) = hub();
    orders(&hub);
    // The merge arrives before the order's row can be read: a stamp-free row first.
    store_row(
        &hub,
        "pr:4",
        "train",
        ms("2026-10-22T08:00:00.000Z"),
        Some("W2"),
    );
    event(
        &hub,
        "2026-10-21T09:00:00.000Z",
        HubEventType::WorkstreamCreated,
        json!({ "workstreamId": "W2" }),
    );
    project_from(&hub, 0);
    let row = rows(&hub).pop().unwrap();
    assert_eq!(
        (row.requested_ms, row.requested_basis.as_deref()),
        (Some(ms("2026-10-21T09:00:00.000Z")), Some("opened"))
    );
}

fn store_row(hub: &Hub, unit: &str, route: &str, merged_ms: i64, w: Option<&str>) {
    hub.db
        .transaction(|c| {
            store::upsert_merge(
                c,
                &MergeRow {
                    repo: "github.com/acme/web".into(),
                    unit_key: unit.into(),
                    machine_id: Some("devbox".into()),
                    project_id: Some("web".into()),
                    merged_ms,
                    route: route.into(),
                    workstream_id: w.map(str::to_owned),
                    src: "event".into(),
                    ..MergeRow::default()
                },
            )
        })
        .unwrap();
}

#[tokio::test]
async fn days_are_the_viewers_and_a_full_retention_range_fits_the_day_list() {
    let (hub, _clock, _home) = hub();
    // 23:30 UTC on the 20th is the 21st in Berlin.
    store_row(
        &hub,
        "pr:1",
        "outside",
        ms("2026-10-20T23:30:00.000Z"),
        None,
    );
    sql(
        &hub,
        "INSERT INTO time_cursors (source, value) VALUES (?1, 0)",
        &[&store::KNOWN_SINCE],
    );
    let berlin = get(
        &hub,
        &admin(),
        json!({ "since": "2026-10-19T22:00:00.000Z", "until": "2026-10-22T22:00:00.000Z", "tz": "Europe/Berlin" }),
    )
    .await
    .unwrap();
    let days: Vec<_> = berlin
        .days
        .iter()
        .map(|d| (d.day.as_str().to_owned(), d.merged.outside.get()))
        .collect();
    assert_eq!(
        days,
        [
            ("2026-10-20".to_owned(), 0),
            ("2026-10-21".to_owned(), 1),
            ("2026-10-22".to_owned(), 0)
        ]
    );
    assert_eq!(berlin.tiles.merged.per_day.get(), 1.0 / 3.0);
    // Merges were known from the start: the previous period is compared, at zero.
    assert_eq!(
        berlin.tiles.merged.previous_per_day.map(|p| p.get()),
        Some(0.0)
    );

    // 400 days back from mid-day, in zones on both sides of UTC: never more days than the list holds.
    for tz in [
        "America/Los_Angeles",
        "Pacific/Kiritimati",
        "Asia/Kolkata",
        "UTC",
    ] {
        let since = iso_ms(ms(NOW) - 400 * DAY);
        let out = get(
            &hub,
            &admin(),
            json!({ "since": since, "tz": tz, "compare": true }),
        )
        .await
        .unwrap_or_else(|_| panic!("{tz}: a full retention range is refused"));
        assert!(out.days.len() <= MAX_DAYS, "{tz}: {}", out.days.len());
        assert!(out.compare.unwrap().days.len() <= MAX_DAYS, "{tz}");
    }

    let Err(CallError::Tool(e)) = get(
        &hub,
        &admin(),
        json!({ "since": "2026-10-26T00:00:00.000Z", "tz": "UTC" }),
    )
    .await
    else {
        panic!("a range in the future was read");
    };
    assert_eq!(e.code, ErrorCode::Invalid);
}

#[test]
fn calendar_days_follow_the_zone_through_a_clock_change() {
    let berlin: Tz = "Europe/Berlin".parse().unwrap();
    let date = |d| NaiveDate::parse_from_str(d, "%Y-%m-%d").unwrap();
    // Summer time ends on the 25th: that day is 25 hours long.
    let (from, to) = (
        compute::day_start(date("2026-10-24"), berlin),
        compute::day_start(date("2026-10-27"), berlin),
    );
    let lens: Vec<i64> = compute::days(from, to, berlin)
        .iter()
        .map(|d| d.len / HOUR)
        .collect();
    assert_eq!(lens, [24, 25, 24]);
    assert_eq!(from, ms("2026-10-23T22:00:00.000Z"));

    // A range a few hours over 400 days is cut to the last 400 calendar days.
    let until = ms(NOW);
    let since = compute::clamp_since(until - 400 * DAY - 5 * HOUR, until, berlin);
    assert_eq!(compute::days(since, until, berlin).len(), MAX_DAYS);
    assert_eq!(since, compute::day_start(date("2025-09-21"), berlin));
}

#[test]
fn medians_and_p90_take_the_middle_and_the_nearest_rank() {
    assert_eq!(compute::median(&[]), None);
    assert_eq!(compute::median(&[5]), Some(5));
    assert_eq!(compute::median(&[1, 3, 10, 40]), Some(6));
    assert_eq!(
        compute::percentile(&[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9),
        Some(9)
    );
    assert_eq!(compute::percentile(&[4, 5, 49], 0.9), Some(49));
    assert_eq!(compute::percentile(&[7], 0.9), Some(7));
}

#[tokio::test]
async fn reads_need_the_machine_and_the_fleet_shows_only_readable_repos() {
    let (hub, _clock, _home) = hub();
    a_week(&hub);
    project_from(&hub, 0);
    let elsewhere = caller(json!([{ "role": "read", "machines": ["other"] }]));
    let Err(CallError::Tool(e)) = get(
        &hub,
        &elsewhere,
        json!({ "projectRef": { "machineId": "devbox", "projectId": "web" }, "since": "2026-10-19T00:00:00.000Z", "tz": "UTC" }),
    )
    .await
    else {
        panic!("a project on a machine the key can't read was shown");
    };
    assert_eq!(e.code, ErrorCode::Forbidden);
    let fleet = get(
        &hub,
        &elsewhere,
        json!({ "since": "2026-10-19T00:00:00.000Z", "tz": "UTC" }),
    )
    .await
    .unwrap();
    assert_eq!(
        (fleet.tiles.merged.n.get(), fleet.repos.unwrap().len()),
        (0, 0)
    );

    let here = caller(json!([{ "role": "read", "machines": ["devbox"] }]));
    let project = get(
        &hub,
        &here,
        json!({ "projectRef": { "machineId": "devbox", "projectId": "web" }, "since": "2026-10-19T00:00:00.000Z", "tz": "UTC" }),
    )
    .await
    .unwrap();
    assert_eq!(project.tiles.merged.n.get(), 4);
    assert!(project.repos.is_none());
}

#[tokio::test]
async fn the_prune_keeps_what_the_retention_says() {
    let (hub, clock, _home) = hub();
    let now = ms(NOW);
    for (unit, age) in [("pr:1", 300), ("pr:2", 40), ("pr:3", 10)] {
        store_row(&hub, unit, "outside", now - age * DAY, None);
    }
    let units = |hub: &Hub| -> Vec<String> { rows(hub).into_iter().map(|r| r.unit_key).collect() };
    // 400 days by default.
    assert!(!hub.db.transaction(|c| store::prune(c, now)).unwrap());
    assert_eq!(units(&hub).len(), 3);

    let only_here = caller(json!([{ "role": "admin", "machines": ["devbox"] }]));
    let Err(CallError::Tool(e)) = registry()
        .call(
            &hub,
            &only_here,
            "metrics_retention_set",
            json!({ "retentionDays": 30 }),
        )
        .await
    else {
        panic!("one machine's admin set the fleet's retention");
    };
    assert_eq!(e.code, ErrorCode::Forbidden);
    registry()
        .call(
            &hub,
            &admin(),
            "metrics_retention_set",
            json!({ "retentionDays": 30 }),
        )
        .await
        .unwrap();
    // The hourly loop prunes.
    let loops = super::start(&hub);
    // Once the loop sleeps on the clock.
    tokio::time::sleep(Duration::from_millis(50)).await;
    clock.advance(Duration::from_secs(3600));
    for _ in 0..50 {
        if units(&hub).len() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(units(&hub), ["pr:3"]);
    hub.shutdown.trigger();
    for l in loops {
        l.abort();
    }
}

#[tokio::test]
async fn an_order_the_lead_opened_is_timed_from_the_message_that_asked_for_it() {
    use crate::hub::leads::requested::{self, Requested, RequestedBasis as Basis};

    let (hub, _clock, _home) = hub();
    orders(&hub);
    let w2 = hub
        .leads
        .records
        .workstream_get(&fleetd_contracts::ledger::WorkstreamId::unchecked("W2"))
        .unwrap()
        .unwrap();
    // The person asked in the chat at 08:30; the lead opened W2 at 09:00.
    requested::set(
        &hub.db,
        &w2,
        Requested {
            at_ms: ms("2026-10-21T08:30:00.000Z"),
            basis: Basis::Chat,
        },
    )
    .unwrap();
    event(
        &hub,
        "2026-10-21T12:30:00.000Z",
        HubEventType::PrMerged,
        json!({ "changeId": "X5", "workstreamId": "W2", "repo": "acme/web", "prNumber": 5 }),
    );
    project_from(&hub, 0);
    let out = get(
        &hub,
        &admin(),
        json!({ "since": "2026-10-19T00:00:00.000Z", "tz": "UTC" }),
    )
    .await
    .unwrap();
    let merge = &out.merges[0];
    assert_eq!(merge.requested_basis, Some(RequestedBasis::Chat));
    assert_eq!(merge.order_to_merged_ms.map(|m| m.get()), Some(4 * HOUR));
    assert_eq!(out.tiles.order_to_merged.from_opened.get(), 0);
}

/// The Status row's fact is its project's last 7 calendar days as `metrics_get` counts them, a merge whose event the
/// read answers included before the projector's loop folds it. A project whose repos the metrics don't know has
/// none, rather than a zero.
#[tokio::test]
async fn the_status_row_counts_the_last_7_days_and_a_merge_just_reported() {
    let (hub, _clock, _home) = hub();
    let project = |id: &str| {
        serde_json::from_value(json!({
            "machineId": "devbox", "projectId": id, "title": id, "workspaceRoot": format!("/work/{id}"),
            "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 },
            "lastActivityAt": NOW,
        }))
        .unwrap()
    };
    hub.store
        .projects_upsert_many(
            &MachineId::unchecked("devbox"),
            &[project("web"), project("docs")],
        )
        .unwrap();
    a_week(&hub);
    let fact = |hub: &Hub| {
        let rows = crate::hub::status::rows::read(hub, &Default::default(), ms(NOW)).unwrap();
        rows.iter()
            .map(|r| {
                (
                    r.project_ref.project_id.to_string(),
                    r.merged_7d.map(|n| n.get()),
                    r.through_fleetd_pct_7d.map(|p| p.get()),
                )
            })
            .collect::<Vec<_>>()
    };
    // Nothing projected yet: the read folds the log itself.
    assert_eq!(
        fact(&hub),
        [
            ("docs".to_owned(), None, None),
            ("web".to_owned(), Some(4), Some(25.0))
        ]
    );
    let zone = crate::hub::attention::hub_zone();
    let since = compute::day_start(
        compute::local_date(ms(NOW), zone)
            .checked_sub_days(chrono::Days::new(6))
            .unwrap(),
        zone,
    );
    let out = get(
        &hub,
        &admin(),
        json!({ "projectRef": { "machineId": "devbox", "projectId": "web" }, "since": iso_ms(since),
                "tz": zone.name() }),
    )
    .await
    .unwrap();
    assert_eq!(
        out.tiles.merged.n.get(),
        4,
        "the same count as the Factory's"
    );

    event(
        &hub,
        "2026-10-24T09:00:00.000Z",
        HubEventType::PrMergedOutside,
        json!({ "repo": "acme/web", "prNumber": 13, "authorKind": "human" }),
    );
    assert_eq!(fact(&hub)[1], ("web".to_owned(), Some(5), Some(20.0)));
}

/// Status never breaks on the metrics: with them unreadable, every row still comes back, its 7-day fact left out.
#[tokio::test]
async fn status_reads_its_rows_when_the_metrics_cannot_be_read() {
    let (hub, _clock, _home) = hub();
    hub.store
        .projects_upsert_many(
            &MachineId::unchecked("devbox"),
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "web", "title": "web", "workspaceRoot": "/work/web",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": NOW,
            }))
            .unwrap()],
        )
        .unwrap();
    a_week(&hub);
    sql(&hub, "DROP TABLE metric_merges", &[]);
    let rows = crate::hub::status::rows::read(&hub, &Default::default(), ms(NOW)).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].merged_7d, rows[0].through_fleetd_pct_7d),
        (None, None)
    );
}

/// A step from an older cursor (a catch-up racing the loop) folds again but never moves the saved cursor back.
#[tokio::test]
async fn the_saved_cursor_only_moves_forward() {
    let (hub, _clock, _home) = hub();
    a_week(&hub);
    let end = project_from(&hub, 0);
    let saved = |hub: &Hub| {
        hub.db
            .with(|c| crate::hub::time::store::cursor(c, "metrics:events"))
            .unwrap()
    };
    assert_eq!(saved(&hub), Some(end));
    let before = rows(&hub);
    project::step(&hub.db, &hub.events, 0).unwrap();
    assert_eq!(saved(&hub), Some(end));
    assert_eq!(rows(&hub), before, "a replay writes the same rows");
}
