//! The person's touches and minutes over a real in-memory hub: sessions, each kind of touch and who it counts for,
//! the git host's reviews and comments through a stand-in reader, and metric 3 through `metrics_get`.
use std::sync::Mutex;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::metrics::HumanSource;
use serde_json::{Value, json};

use super::host_acts::{self, HostAct, HostActKind, HostActs, ReadError};
use super::human::{self, BRIDGE_MS, MINUTE_MS, Span};
use super::store::{self, TouchRow};
use super::tests::{HOUR, a_week, admin, event, get, hub, ms, project_from, sql};
use crate::hub::api::Hub;
use crate::hub::usage::ports::BoxFut;

const SEC: i64 = 1000;
const REPO: &str = "github.com/acme/web";

fn spans(intervals: &[(i64, i64)]) -> Vec<Span> {
    intervals
        .iter()
        .map(|&(start, end)| Span {
            start,
            end,
            source: HumanSource::Chat,
        })
        .collect()
}

#[test]
fn acts_under_five_minutes_apart_are_one_session_and_overlaps_count_once() {
    let m = MINUTE_MS;
    // Two one-minute acts with a gap just under the bridge: the gap counts.
    let near = spans(&[(0, m), (m + BRIDGE_MS - 1, 2 * m + BRIDGE_MS - 1)]);
    assert_eq!(
        human::minutes(&near),
        human::Minutes {
            total_ms: 2 * m + BRIDGE_MS - 1,
            low_ms: 2 * m
        }
    );
    // Exactly five minutes apart is two sessions.
    let apart = spans(&[(0, m), (m + BRIDGE_MS, 2 * m + BRIDGE_MS)]);
    assert_eq!(human::minutes(&apart).total_ms, 2 * m);
    // Overlapping and nested acts count once, in any order.
    let overlapping = spans(&[(2 * m, 4 * m), (0, 3 * m), (m, 2 * m)]);
    assert_eq!(
        human::minutes(&overlapping),
        human::Minutes {
            total_ms: 4 * m,
            low_ms: 4 * m
        }
    );
    assert_eq!(human::minutes(&[]), human::Minutes::default());

    // A bridged gap goes to the act after it, so the pieces add up to the session.
    let mixed = vec![
        Span {
            start: 0,
            end: m,
            source: HumanSource::Chat,
        },
        Span {
            start: 3 * m,
            end: 4 * m,
            source: HumanSource::Other,
        },
    ];
    let pieces = human::sessions(&mixed, BRIDGE_MS);
    assert_eq!(
        pieces
            .iter()
            .map(|p| (p.source, p.end - p.start))
            .collect::<Vec<_>>(),
        [(HumanSource::Chat, m), (HumanSource::Other, 3 * m)]
    );
    // Cut at midnight, each day keeps its part.
    assert_eq!(human::within(&pieces, 0, 2 * m), 2 * m);
    assert_eq!(human::within(&pieces, 2 * m, 10 * m), 2 * m);
    // Spans are cut to the range, and an empty one goes.
    assert_eq!(
        human::clip(spans(&[(-m, m), (5 * m, 6 * m)]), 0, 5 * m),
        spans(&[(0, m)])
    );
}

#[test]
fn each_touch_counts_its_stated_minimum() {
    assert_eq!(human::typed_ms(0), MINUTE_MS);
    assert_eq!(human::typed_ms(150), MINUTE_MS);
    assert_eq!(human::typed_ms(300), 2 * MINUTE_MS);
    assert_eq!(human::review_ms(None), 3 * MINUTE_MS);
    assert_eq!(human::review_ms(Some(250)), 5 * MINUTE_MS);
    assert_eq!(human::review_ms(Some(50_000)), 20 * MINUTE_MS);
    // An observed interval is taken as it is; any other touch is its credit before it was recorded.
    let app = TouchRow {
        kind: "app.use".into(),
        at_ms: 10 * MINUTE_MS,
        end_ms: Some(14 * MINUTE_MS),
        ..TouchRow::default()
    };
    assert_eq!(
        (human::span(&app).start, human::span(&app).end),
        (10 * MINUTE_MS, 14 * MINUTE_MS)
    );
    let steer = TouchRow {
        kind: "steer".into(),
        at_ms: 10 * MINUTE_MS,
        credit_ms: human::STEER_MS,
        ..TouchRow::default()
    };
    assert_eq!(
        (human::span(&steer).start, human::span(&steer).source),
        (9 * MINUTE_MS, HumanSource::Other)
    );
}

fn touches(hub: &Hub) -> Vec<TouchRow> {
    hub.db.with(|c| store::touches(c, 0, i64::MAX)).unwrap()
}

fn message(n: i64, author: &str, text: &str, at: &str, extra: Value) -> Value {
    let mut m = json!({
        "messageId": format!("m{n}"), "projectRef": { "machineId": "devbox", "projectId": "web" }, "seq": n,
        "author": author, "text": text, "createdAt": at, "state": "final", "by": "desk",
    });
    m.as_object_mut()
        .unwrap()
        .extend(extra.as_object().cloned().unwrap_or_default());
    m
}

fn chat(hub: &Hub, at: &str, message: Value) {
    event(
        hub,
        at,
        HubEventType::ChatMessage,
        json!({
            "projectRef": message["projectRef"], "messageId": message["messageId"], "seq": message["seq"],
            "author": message["author"], "state": "final", "message": message,
        }),
    );
}

fn steer(hub: &Hub, at: &str, n: i64, by: Value) {
    event(
        hub,
        at,
        HubEventType::SteerQueued,
        json!({ "steerId": format!("S{n}"), "workstreamId": "W1", "stage": "queued", "by": by }),
    );
}

fn request(hub: &Hub, at: &str, id: &str, state: &str, by: &str) {
    event(
        hub,
        at,
        HubEventType::RequestUpdated,
        json!({ "requestId": id, "kind": "approval", "state": state, "workstreamId": "W1", "by": by }),
    );
}

/// Request `Q<n>`'s record, last answered at `at` by the person.
fn answered(hub: &Hub, n: i64, at: &str) {
    let data =
        json!({ "requestId": format!("Q{n}"), "answeredAt": at, "answeredBy": "human:desk" });
    sql(
        hub,
        "INSERT INTO requests (n, project_key, kind, state, created_ms, data) VALUES (?1, 'devbox/web', 'approval', 'approved', 0, ?2)
         ON CONFLICT(n) DO UPDATE SET data = excluded.data",
        &[&n, &data.to_string()],
    );
}

fn decision(hub: &Hub, at: &str, id: &str, source: &str) {
    event(
        hub,
        at,
        HubEventType::DecisionRecorded,
        json!({ "decisionId": id, "key": "db", "source": source,
                "scope": { "kind": "project", "projectRef": { "machineId": "devbox", "projectId": "web" } } }),
    );
}

/// The person's acts on the 20th, around W1's change (on top of `a_week`):
/// - 07:59–08:00 W1 submitted in the app ("Checkout", a minute);
/// - 08:58–09:00 a 300-character chat message (2 minutes);
/// - 09:02:30–09:03 an approval (30 s), bridged to the message;
/// - 09:02:20–09:03:20 a steer (a minute), overlapping the approval;
/// - 09:59–10:00 a decision (a minute), its own session.
///
/// And the acts that are not the person's: an agent's chat message, a history message, the lead's steer, decision
/// and withdrawal, the hub closing a request, and the approval's later states.
fn a_day_of_touches(hub: &Hub) {
    let text = "x".repeat(300);
    chat(
        hub,
        "2026-10-20T09:00:00.000Z",
        message(
            1,
            "human",
            &text,
            "2026-10-20T09:00:00.000Z",
            json!({ "client": "app" }),
        ),
    );
    chat(
        hub,
        "2026-10-20T09:00:01.000Z",
        message(
            2,
            "agent",
            "build is green",
            "2026-10-20T09:00:01.000Z",
            json!({}),
        ),
    );
    chat(
        hub,
        "2026-10-20T09:00:02.000Z",
        message(
            3,
            "human",
            "old note",
            "2026-10-01T09:00:00.000Z",
            json!({ "history": "note" }),
        ),
    );
    answered(hub, 1, "2026-10-20T09:03:00.000Z");
    request(
        hub,
        "2026-10-20T09:03:00.000Z",
        "Q1",
        "approved",
        "human:desk",
    );
    // A note on its run while it stays approved is the same answer.
    request(
        hub,
        "2026-10-20T09:03:40.000Z",
        "Q1",
        "approved",
        "human:desk",
    );
    request(hub, "2026-10-20T09:04:00.000Z", "Q1", "ran", "human:desk");
    request(
        hub,
        "2026-10-20T09:05:00.000Z",
        "Q2",
        "denied",
        "lead:devbox/web",
    );
    request(hub, "2026-10-20T09:06:00.000Z", "Q3", "withdrawn", "hub");
    steer(
        hub,
        "2026-10-20T09:03:20.000Z",
        1,
        json!({ "kind": "human", "keyName": "desk" }),
    );
    steer(
        hub,
        "2026-10-20T09:30:00.000Z",
        2,
        json!({ "kind": "lead" }),
    );
    decision(hub, "2026-10-20T10:00:00.000Z", "D1", "human");
    decision(hub, "2026-10-20T10:30:00.000Z", "D2", "lead");
}

#[tokio::test]
async fn each_kind_of_touch_is_the_persons_act_and_nothing_else() {
    let (hub, _clock, _home) = hub();
    a_week(&hub);
    a_day_of_touches(&hub);
    let cursor = project_from(&hub, 0);

    let got: Vec<_> = touches(&hub)
        .iter()
        .map(|t| {
            (
                t.kind.clone(),
                t.src_key.clone(),
                t.credit_ms,
                t.outside,
                t.project_id.as_deref().map(str::to_owned),
            )
        })
        .collect();
    let web = Some("web".to_owned());
    assert_eq!(
        got,
        [
            (
                "order.submitted".into(),
                "W1".into(),
                MINUTE_MS,
                false,
                web.clone()
            ),
            (
                "chat.message".into(),
                "m1".into(),
                2 * MINUTE_MS,
                false,
                web.clone()
            ),
            (
                "item.answered".into(),
                format!("Q1@{}", ms("2026-10-20T09:03:00.000Z")),
                30 * SEC,
                false,
                web.clone()
            ),
            ("steer".into(), "S1".into(), MINUTE_MS, false, web.clone()),
            (
                "decision".into(),
                "D1".into(),
                MINUTE_MS,
                false,
                web.clone()
            ),
            // PR 9 from outside, merged by the person.
            (
                "merge.by_hand".into(),
                format!("{REPO}#pr:9"),
                MINUTE_MS,
                true,
                web.clone()
            ),
        ]
    );
    let all = touches(&hub);
    assert_eq!(all[1].key_id.as_deref(), Some("desk"));
    assert_eq!(all[3].workstream_id.as_deref(), Some("W1"));
    assert_eq!(
        (all[5].repo.as_deref(), all[5].pr_number),
        (Some(REPO), Some(9))
    );

    // A replay writes the same touches.
    assert_eq!(project_from(&hub, 0), cursor);
    assert_eq!(touches(&hub), all);
}

#[tokio::test]
async fn a_message_too_long_for_its_event_is_read_from_the_chat() {
    let (hub, _clock, _home) = hub();
    let text = "y".repeat(3000);
    let m = message(
        7,
        "human",
        &text,
        "2026-10-24T09:00:00.000Z",
        json!({ "client": "cli" }),
    );
    sql(
        &hub,
        "INSERT INTO chat_messages (n, machine_id, project_id, seq, created_ms, data) VALUES (7, 'devbox', 'web', 7, ?1, ?2)",
        &[&ms("2026-10-24T09:00:00.000Z"), &m.to_string()],
    );
    event(
        &hub,
        "2026-10-24T09:00:00.000Z",
        HubEventType::ChatMessage,
        json!({ "projectRef": m["projectRef"], "messageId": "m7", "seq": 7, "author": "human", "state": "final" }),
    );
    project_from(&hub, 0);
    let got = touches(&hub);
    assert_eq!(got.len(), 1);
    // 3000 characters at 150 a minute.
    assert_eq!(got[0].credit_ms, 20 * MINUTE_MS);
}

#[tokio::test]
async fn an_answer_is_one_touch_however_often_its_request_updates() {
    let (hub, _clock, _home) = hub();
    answered(&hub, 4, "2026-10-24T09:00:00.000Z");
    request(
        &hub,
        "2026-10-24T09:00:00.000Z",
        "Q4",
        "approved",
        "human:desk",
    );
    // A note on its run, while it stays approved, then its result.
    request(
        &hub,
        "2026-10-24T09:00:30.000Z",
        "Q4",
        "approved",
        "human:desk",
    );
    request(&hub, "2026-10-24T09:01:00.000Z", "Q4", "ran", "human:desk");
    let cursor = project_from(&hub, 0);
    let at = |hub: &Hub| touches(hub).iter().map(|t| t.at_ms).collect::<Vec<_>>();
    assert_eq!(at(&hub), [ms("2026-10-24T09:00:00.000Z")]);

    // It opened again, and the person approved it again: a second answer.
    request(&hub, "2026-10-24T09:30:00.000Z", "Q4", "open", "human:desk");
    answered(&hub, 4, "2026-10-24T10:00:00.000Z");
    request(
        &hub,
        "2026-10-24T10:00:00.000Z",
        "Q4",
        "approved",
        "human:desk",
    );
    project_from(&hub, cursor);
    assert_eq!(
        at(&hub),
        [
            ms("2026-10-24T09:00:00.000Z"),
            ms("2026-10-24T10:00:00.000Z")
        ]
    );
}

#[test]
fn the_persons_identities_are_their_logins_and_emails_in_any_case() {
    let ids = human::Identities::new(["1+Ada@users.noreply.github.com", " ada@example.com "]);
    for who in [
        "ada",
        "ADA",
        "1+ada@users.noreply.github.com",
        "Ada@Example.com",
    ] {
        assert!(ids.has(who), "{who}");
    }
    assert!(!ids.has("bob") && !ids.has(""));
    assert!(!human::Identities::default().has("ada"));
}

#[tokio::test]
async fn only_the_persons_own_reviews_count_and_with_no_identity_none_do() {
    let (hub, _clock, _home) = hub();
    a_week(&hub);
    project_from(&hub, 0);
    let host = Host {
        acts: Ok(vec![
            HostAct {
                lines: Some(250),
                ..act(HostActKind::Review, "r1", 7, "2026-10-21T10:00:00.000Z")
            },
            // A colleague's review on the same shared repo.
            HostAct {
                login: Some("colleague".into()),
                ..act(HostActKind::Review, "r3", 7, "2026-10-21T12:00:00.000Z")
            },
        ]),
        asked: Mutex::new(Vec::new()),
    };
    host_acts::read(&hub.db, &host, REPO, ms(super::tests::NOW))
        .await
        .unwrap();
    let read = || async {
        let out = get(
            &hub,
            &admin(),
            json!({ "since": "2026-10-19T00:00:00.000Z", "tz": "UTC" }),
        )
        .await
        .unwrap();
        let on_7 = out
            .merges
            .iter()
            .find(|m| m.pr_number.map(|n| n.get()) == Some(7))
            .map(|m| m.touches.get());
        (out.tiles.human.total_ms.get(), on_7)
    };
    // No identity known: no review is the person's. Only W1, submitted in the app, counts.
    assert_eq!(read().await, (MINUTE_MS, Some(0)));
    hub.db
        .transaction(|c| store::add_identity(c, "Reviewer", "host_login"))
        .unwrap();
    // Theirs counts (5 minutes for 250 lines); the colleague's never does.
    assert_eq!(read().await, (6 * MINUTE_MS, Some(1)));
}

/// Stands in for the host sweep's reader: answers with `acts`, and remembers each `since` it was asked.
struct Host {
    acts: Result<Vec<HostAct>, String>,
    asked: Mutex<Vec<i64>>,
}

impl HostActs for Host {
    fn acts_since<'a>(
        &'a self,
        _repo: &'a str,
        since_ms: i64,
    ) -> BoxFut<'a, Result<Vec<HostAct>, String>> {
        self.asked.lock().unwrap().push(since_ms);
        let acts = self.acts.clone();
        Box::pin(async move { acts })
    }
}

fn act(kind: HostActKind, id: &str, pr: i64, at: &str) -> HostAct {
    HostAct {
        kind,
        id: id.into(),
        pr_number: pr,
        at_ms: ms(at),
        login: Some("reviewer".into()),
        bot: false,
        head: None,
        lines: None,
    }
}

/// A review on PR 7 (W1's Change, 250 lines), a comment on PR 9 (from outside) and a bot's review.
fn reviews() -> Vec<HostAct> {
    vec![
        HostAct {
            lines: Some(250),
            ..act(HostActKind::Review, "r1", 7, "2026-10-21T10:00:00.000Z")
        },
        act(HostActKind::Comment, "c1", 9, "2026-10-22T10:30:00.000Z"),
        HostAct {
            bot: true,
            login: Some("renovate[bot]".into()),
            ..act(HostActKind::Review, "r2", 11, "2026-10-23T12:00:00.000Z")
        },
    ]
}

#[tokio::test]
async fn reviews_and_comments_on_the_git_host_are_estimated_touches_on_their_prs() {
    let (hub, _clock, _home) = hub();
    a_week(&hub);
    project_from(&hub, 0);
    let now = ms(super::tests::NOW);
    let host = Host {
        acts: Ok(reviews()),
        asked: Mutex::new(Vec::new()),
    };
    assert_eq!(host_acts::read(&hub.db, &host, REPO, now).await.unwrap(), 2);
    // A second read goes from where the first one ended; the same acts rewrite the same two touches.
    assert_eq!(
        host_acts::read(&hub.db, &host, REPO, now + HOUR)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        *host.asked.lock().unwrap(),
        [now - host_acts::BACKFILL_MS, now]
    );

    let host_touches: Vec<_> = touches(&hub)
        .into_iter()
        .filter(|t| t.src == "host")
        .collect();
    let got: Vec<_> = host_touches
        .iter()
        .map(|t| {
            (
                t.kind.as_str(),
                t.pr_number,
                t.credit_ms,
                t.estimated,
                t.outside,
                t.workstream_id.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            (
                "host.review",
                Some(7),
                5 * MINUTE_MS,
                true,
                false,
                Some("W1")
            ),
            ("host.comment", Some(9), 30 * SEC, true, true, None),
        ]
    );
    assert_eq!(host_touches[0].key_id.as_deref(), Some("reviewer"));

    // A `fleetd/` head names its task's order even with no Change.
    let fleetd_head = Host {
        acts: Ok(vec![HostAct {
            head: Some("fleetd/T3-fix-totals".into()),
            ..act(HostActKind::Comment, "c2", 10, "2026-10-23T09:00:00.000Z")
        }]),
        asked: Mutex::new(Vec::new()),
    };
    host_acts::read(&hub.db, &fleetd_head, REPO, now + 2 * HOUR)
        .await
        .unwrap();
    let c2 = touches(&hub)
        .into_iter()
        .find(|t| t.src_key.ends_with(":c2"))
        .unwrap();
    assert_eq!(
        (c2.outside, c2.workstream_id.as_deref()),
        (false, Some("W2"))
    );

    // A failed read says why and keeps the cursor.
    let down = Host {
        acts: Err("gh is signed out".into()),
        asked: Mutex::new(Vec::new()),
    };
    assert!(matches!(
        host_acts::read(&hub.db, &down, REPO, now + 3 * HOUR).await,
        Err(ReadError::Host(why)) if why == "gh is signed out"
    ));
    assert_eq!(
        hub.db.with(|c| store::reviews_cursor(c, REPO)).unwrap(),
        Some(now + 2 * HOUR)
    );
}

#[tokio::test]
async fn minutes_per_merged_pr_are_the_sessions_over_fleetd_work_with_the_low_bound_beside() {
    let (hub, _clock, home) = hub();
    // The person's commit identity, as setup wrote it: its noreply email names their login.
    std::fs::write(
        home.path().join("setup.json"),
        json!({ "gitIdentity": { "name": "Reviewer", "email": "1+reviewer@users.noreply.github.com" } })
            .to_string(),
    )
    .unwrap();
    a_week(&hub);
    a_day_of_touches(&hub);
    project_from(&hub, 0);
    let host = Host {
        acts: Ok(reviews()),
        asked: Mutex::new(Vec::new()),
    };
    host_acts::read(&hub.db, &host, REPO, ms(super::tests::NOW))
        .await
        .unwrap();
    let out = get(
        &hub,
        &admin(),
        json!({ "since": "2026-10-19T00:00:00.000Z", "tz": "UTC" }),
    )
    .await
    .unwrap();

    // Fleetd work: the order (1 min), the 08:58–09:03:20 session (5 min 20 s), the decision (1 min), and the review
    // of PR 7 (5 min). The low bound drops the bridged gap: 1 + 2 + 1 (approval and steer at once) + 1 + 5.
    let h = &out.tiles.human;
    let total = 12 * MINUTE_MS + 20 * SEC;
    assert_eq!((h.total_ms.get(), h.low_ms.get()), (total, 10 * MINUTE_MS));
    assert_eq!(h.prs.get(), 3);
    assert_eq!(h.per_pr_ms.map(|v| v.get()), Some(total / 3));
    // Outside work: the person's comment on PR 9. Its merge by hand doesn't say who merged it, so it isn't counted.
    assert_eq!(h.outside_total_ms.get(), 30 * SEC);
    assert_eq!(
        (h.outside_prs.get(), h.outside_per_pr_ms.map(|v| v.get())),
        (1, Some(30 * SEC))
    );
    assert_eq!(h.previous_per_pr_ms, None);
    assert_eq!(h.spark.len(), 7);

    // By day and source; a bridged gap goes to the act after it: the steer, which started before the approval.
    let day = |d: &str| {
        out.days
            .iter()
            .find(|x| x.day.as_str() == d)
            .unwrap()
            .human
            .iter()
            .map(|s| (s.source, s.ms.get(), s.touches.get()))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        day("2026-10-20"),
        [
            (HumanSource::Chat, 3 * MINUTE_MS, 3),
            (HumanSource::Other, 4 * MINUTE_MS + 20 * SEC, 2)
        ]
    );
    assert_eq!(
        day("2026-10-21"),
        [(HumanSource::Reviews, 5 * MINUTE_MS, 1)]
    );
    assert_eq!(day("2026-10-22"), [(HumanSource::Reviews, 30 * SEC, 1)]);
    assert_eq!(day("2026-10-24"), []);

    // The touches that belong to one PR show on it.
    let on = |pr: i64| {
        out.merges
            .iter()
            .find(|m| m.pr_number.map(|n| n.get()) == Some(pr))
            .map(|m| m.touches.get())
    };
    assert_eq!((on(7), on(8), on(9)), (Some(1), Some(0), Some(1)));

    let repos = out.repos.unwrap();
    assert_eq!(repos[0].human_per_pr_ms.map(|v| v.get()), Some(total / 3));
    assert!(
        out.coverage
            .invisible
            .iter()
            .any(|l| l.as_str().contains("Claude Code sessions"))
    );

    // The project's own view counts the same; another project's sees none of it.
    let mine = get(
        &hub,
        &admin(),
        json!({ "since": "2026-10-19T00:00:00.000Z", "tz": "UTC",
                "projectRef": { "machineId": "devbox", "projectId": "web" } }),
    )
    .await
    .unwrap();
    assert_eq!(mine.tiles.human.total_ms.get(), total);
    let other = get(
        &hub,
        &admin(),
        json!({ "since": "2026-10-19T00:00:00.000Z", "tz": "UTC",
                "projectRef": { "machineId": "devbox", "projectId": "api" } }),
    )
    .await
    .unwrap();
    assert_eq!(other.tiles.human.total_ms.get(), 0);
}

#[tokio::test]
async fn a_session_across_midnight_counts_once_and_splits_by_day() {
    let (hub, _clock, _home) = hub();
    for (n, at) in [
        (1, "2026-10-21T23:59:00.000Z"),
        (2, "2026-10-22T00:02:00.000Z"),
    ] {
        chat(
            &hub,
            at,
            message(n, "human", "ok", at, json!({ "client": "app" })),
        );
    }
    project_from(&hub, 0);
    let out = get(
        &hub,
        &admin(),
        json!({ "since": "2026-10-21T00:00:00.000Z", "tz": "UTC" }),
    )
    .await
    .unwrap();
    // 23:58 to 00:02, bridged: 4 minutes, 2 before midnight and 2 after.
    assert_eq!(out.tiles.human.total_ms.get(), 4 * MINUTE_MS);
    assert_eq!(out.tiles.human.low_ms.get(), 2 * MINUTE_MS);
    let ms_on = |d: &str| {
        out.days
            .iter()
            .find(|x| x.day.as_str() == d)
            .unwrap()
            .human
            .iter()
            .map(|s| s.ms.get())
            .sum::<i64>()
    };
    assert_eq!(
        (ms_on("2026-10-21"), ms_on("2026-10-22")),
        (2 * MINUTE_MS, 2 * MINUTE_MS)
    );
}
