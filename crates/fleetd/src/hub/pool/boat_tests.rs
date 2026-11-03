//! The boat client against a fake boat.dev that answers with recorded answers (testdata/boat/answers.json): each call's
//! method, path, headers and body as boat documents them, every page of a list followed, and a typed error per code.
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::Value;
use zeroize::Zeroizing;

use super::boat::{Boat, BoatError, CreateBody, Phase, RestBoat};
use super::lease::{self, Lease};

const KEY: &str = "boat_test_key_never_logged";

fn answers() -> Value {
    serde_json::from_str(include_str!("testdata/boat/answers.json")).unwrap()
}

/// What the fake saw of one call.
#[derive(Clone, Debug)]
struct Seen {
    method: Method,
    path: String,
    query: Vec<(String, String)>,
    headers: HeaderMap,
    body: Vec<u8>,
}

#[derive(Default)]
struct Fake {
    seen: Vec<Seen>,
    /// The next calls' refusals: status, answer name, a Retry-After header.
    refusals: VecDeque<Refusal>,
}

type Shared = Arc<Mutex<Fake>>;
/// A refusal to answer with: status, answer name, a Retry-After header.
type Refusal = (u16, &'static str, Option<&'static str>);

fn answer(status: u16, name: &str, retry_after: Option<&str>) -> Response {
    let body = answers()[name].clone();
    assert!(!body.is_null(), "no recorded answer {name}");
    let mut res = (StatusCode::from_u16(status).unwrap(), axum::Json(body)).into_response();
    if let Some(r) = retry_after {
        res.headers_mut().insert("retry-after", r.parse().unwrap());
    }
    res
}

async fn any(
    State(fake): State<Shared>,
    method: Method,
    Query(query): Query<Vec<(String, String)>>,
    headers: HeaderMap,
    uri: axum::http::Uri,
    body: Bytes,
) -> Response {
    let path = uri.path().trim_start_matches("/api/v1").to_owned();
    let refusal = {
        let mut f = fake.lock().unwrap();
        f.seen.push(Seen {
            method: method.clone(),
            path: path.clone(),
            query: query.clone(),
            headers: headers.clone(),
            body: body.to_vec(),
        });
        f.refusals.pop_front()
    };
    if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(&format!("Bearer {KEY}"))
    {
        return answer(401, "unauthorized", None);
    }
    if let Some((status, name, retry)) = refusal {
        return answer(status, name, retry);
    }
    let cursor = query
        .iter()
        .find(|(k, _)| k == "cursor")
        .map(|(_, v)| v.as_str());
    match (method.as_str(), path.as_str()) {
        ("POST", "/sandboxes") => answer(202, "create", None),
        ("GET", "/sandboxes") if cursor == Some("c2") => answer(200, "list-page-2", None),
        ("GET", "/sandboxes") => answer(200, "list-page-1", None),
        ("GET", "/limits") => answer(200, "limits", None),
        ("GET", "/sandboxes/bx_gone2222") | ("DELETE", "/sandboxes/bx_gone2222") => {
            answer(404, "not_found", None)
        }
        ("GET", p) if p.ends_with("/usage") => answer(200, "usage", None),
        ("GET", _) => answer(200, "get-running", None),
        ("PATCH", _) => answer(200, "update", None),
        ("POST", p) if p.ends_with("/stop") => answer(202, "stopping", None),
        ("POST", p) if p.ends_with("/resume") => answer(202, "resuming", None),
        ("DELETE", p) => {
            let id = p.trim_start_matches("/sandboxes/");
            if headers
                .get("x-ascii-confirm-delete")
                .and_then(|v| v.to_str().ok())
                != Some(id)
            {
                return answer(409, "idempotency_key_reused", None);
            }
            answer(202, "deleting", None)
        }
        _ => answer(404, "not_found", None),
    }
}

async fn fake_boat() -> (RestBoat, Shared) {
    let fake: Shared = Arc::default();
    let router = Router::new()
        .route("/api/v1/{*rest}", get(any).post(any).patch(any).delete(any))
        .route("/api/v1/sandboxes", get(any).post(any))
        .route("/api/v1/limits", get(any))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let key: super::boat::KeySource = Arc::new(|| Ok(Zeroizing::new(KEY.to_owned())));
    (RestBoat::new(&format!("http://{addr}/api/v1"), key), fake)
}

fn last(fake: &Shared) -> Seen {
    fake.lock().unwrap().seen.last().cloned().unwrap()
}

fn ttl(seconds: f64) -> super::lease::Ttl {
    match lease::clamp(lease::SETUP_S, seconds, 3600.0) {
        Lease::Renew(t) => t,
        Lease::Stop => panic!("no lease"),
    }
}

#[tokio::test]
async fn a_create_goes_out_as_the_sealed_bytes_under_its_idempotency_key() {
    let (boat, fake) = fake_boat().await;
    let labels = [
        ("fleetd.hub", "3f9a1c2e7b4d5a60"),
        ("fleetd.slot", "boat-1"),
        ("fleetd.attempt", "0123"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let mut body = CreateBody::new(
        "large",
        "fleetd-3f9a1c2e-boat-1".into(),
        labels,
        ttl(2700.0),
    );
    body.setup_script = Some("#!/bin/bash\necho hi\n".into());
    body.files = vec![super::boat::File {
        path: "/tmp/fleetd-enroll".into(),
        content: "code".into(),
    }];
    let bytes = serde_json::to_vec(&body).unwrap();
    let sb = boat.create("0123", &bytes).await.unwrap();
    assert_eq!(sb.id, "bx_23456789");
    assert_eq!(sb.phase(), Phase::Up);
    assert_eq!(sb.label("fleetd.slot"), Some("boat-1"));
    let seen = last(&fake);
    assert_eq!(
        (seen.method.as_str(), seen.path.as_str()),
        ("POST", "/sandboxes")
    );
    assert_eq!(seen.headers["idempotency-key"], "0123");
    assert_eq!(
        seen.body, bytes,
        "byte-identical, so a retry under the key is the same request"
    );
    let sent: Value = serde_json::from_slice(&seen.body).unwrap();
    assert_eq!(sent["type"], "large");
    assert_eq!(sent["noEnv"], true);
    assert_eq!(sent["monitoring"], false);
    assert_eq!(sent["failFast"], true);
    assert_eq!(sent["ttlSeconds"], 2700);
    assert_eq!(sent["labels"]["fleetd.attempt"], "0123");
    assert_eq!(sent["files"][0]["path"], "/tmp/fleetd-enroll");
    assert!(sent.get("environment").is_none());
}

#[tokio::test]
async fn a_list_follows_every_cursor_page_with_its_labels() {
    let (boat, fake) = fake_boat().await;
    let labels = vec![("fleetd.hub".to_owned(), "3f9a1c2e7b4d5a60".to_owned())];
    let all = boat.list(&labels).await.unwrap();
    let ids: Vec<(&str, Phase)> = all.iter().map(|s| (s.id.as_str(), s.phase())).collect();
    assert_eq!(
        ids,
        [
            ("bx_23456789", Phase::Up),
            ("bx_3456789a", Phase::Stopped),
            ("bx_456789ab", Phase::Stopping)
        ]
    );
    let seen = fake.lock().unwrap().seen.clone();
    assert_eq!(seen.len(), 2);
    for call in &seen {
        assert!(
            call.query
                .contains(&("label".into(), "fleetd.hub=3f9a1c2e7b4d5a60".into()))
        );
        assert!(call.query.contains(&("limit".into(), "200".into())));
    }
    assert!(seen[1].query.contains(&("cursor".into(), "c2".into())));
}

#[tokio::test]
async fn get_patch_stop_resume_delete_limits_and_usage() {
    let (boat, fake) = fake_boat().await;
    let sb = boat.get("bx_23456789").await.unwrap();
    assert_eq!(
        sb.archive_after_ms(),
        crate::hub::store::parse_ms("2026-11-03T12:45:00Z")
    );
    assert_eq!(sb.setup_status.as_deref(), Some("done"));

    boat.set_ttl("bx_23456789", ttl(1800.0)).await.unwrap();
    let seen = last(&fake);
    assert_eq!(
        (seen.method.as_str(), seen.path.as_str()),
        ("PATCH", "/sandboxes/bx_23456789")
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&seen.body).unwrap(),
        serde_json::json!({ "ttlSeconds": 1800 })
    );

    boat.stop("bx_23456789").await.unwrap();
    assert_eq!(last(&fake).path, "/sandboxes/bx_23456789/stop");

    let resumed = boat.resume("bx_23456789", ttl(1800.0)).await.unwrap();
    assert_eq!(resumed.id, "bx_23456789");
    let sent: Value = serde_json::from_slice(&last(&fake).body).unwrap();
    assert_eq!(
        sent,
        serde_json::json!({ "ttlSeconds": 1800, "failFast": true, "noEnv": true })
    );

    boat.delete("bx_23456789").await.unwrap();
    assert_eq!(last(&fake).headers["x-ascii-confirm-delete"], "bx_23456789");
    // Deleting what boat no longer has is done.
    boat.delete("bx_gone2222").await.unwrap();
    assert_eq!(boat.get("bx_gone2222").await, Err(BoatError::NotFound));

    let limits = boat.limits().await.unwrap();
    assert!(limits.can_start);
    assert_eq!(limits.next_start_dollars, Some(0.0));
    assert_eq!(
        limits
            .start_limits
            .map(|s| (s.per_minute, s.per_hour, s.per_day)),
        Some((12, 60, 200))
    );
    assert_eq!(limits.sandbox_plan_dollars, Some(20.0));
    assert_eq!(limits.active_sandboxes, 1);
    assert!(
        limits
            .machine_types
            .iter()
            .any(|t| t.kind == "xlarge" && !t.available)
    );

    let dollars = boat.usage("bx_23456789", 1_793_750_400_000).await.unwrap();
    assert_eq!(dollars, 0.0996);
    let seen = last(&fake);
    assert_eq!(seen.path, "/sandboxes/bx_23456789/usage");
    assert!(
        seen.query
            .contains(&("since".into(), "2026-11-04T00:00:00.000Z".into()))
    );
}

#[tokio::test]
async fn each_refusal_is_its_own_typed_error() {
    let (boat, fake) = fake_boat().await;
    let cases: Vec<(Refusal, BoatError)> = vec![
        (
            (429, "rate_limited", None),
            BoatError::RateLimited {
                next_start_at: crate::hub::store::parse_ms("2026-11-03T12:01:30Z"),
                retry_after_s: Some(42),
            },
        ),
        (
            (429, "rate_limited", Some("30")),
            BoatError::RateLimited {
                next_start_at: crate::hub::store::parse_ms("2026-11-03T12:01:30Z"),
                retry_after_s: Some(30),
            },
        ),
        ((429, "limit_reached", None), BoatError::LimitReached),
        (
            (429, "member_limit_reached", None),
            BoatError::MemberLimitReached,
        ),
        (
            (402, "billing_required", None),
            BoatError::Billing {
                code: "billing_required".into(),
                url: Some("https://boat.dev/dashboard/billing".into()),
            },
        ),
        (
            (402, "team_member_cap_reached", None),
            BoatError::Billing {
                code: "team_member_cap_reached".into(),
                url: None,
            },
        ),
        (
            (429, "trial_compute_limit_reached", None),
            BoatError::Billing {
                code: "trial_compute_limit_reached".into(),
                url: None,
            },
        ),
        ((503, "no_ready_machine", None), BoatError::NoReadyMachine),
        (
            (503, "out_of_capacity", None),
            BoatError::OutOfCapacity {
                retry_after_s: Some(120),
            },
        ),
        (
            (429, "ip_rate_limit", Some("17")),
            BoatError::IpRateLimited {
                retry_after_s: Some(17),
            },
        ),
        (
            (401, "unauthorized", None),
            BoatError::KeyRefused {
                code: "unauthorized".into(),
            },
        ),
        (
            (403, "api_key_action_forbidden", None),
            BoatError::KeyRefused {
                code: "api_key_action_forbidden".into(),
            },
        ),
        ((409, "snapshot_data_expired", None), BoatError::DataExpired),
        (
            (409, "idempotency_key_reused", None),
            BoatError::IdempotencyKeyReused,
        ),
        (
            (409, "idempotency_in_progress", None),
            BoatError::IdempotencyInProgress,
        ),
        ((404, "not_found", None), BoatError::NotFound),
        ((502, "not_found", None), BoatError::Server { status: 502 }),
    ];
    for (refusal, want) in cases {
        fake.lock().unwrap().refusals.push_back(refusal);
        assert_eq!(
            boat.resume("bx_23456789", ttl(1800.0)).await.unwrap_err(),
            want,
            "{refusal:?}"
        );
    }
    // No answer at all is a network error, which never carries the key.
    let wrong: super::boat::KeySource = Arc::new(|| Ok(Zeroizing::new("boat_wrong".to_owned())));
    let e = RestBoat::new("http://127.0.0.1:9/api/v1", wrong)
        .limits()
        .await
        .unwrap_err();
    assert!(
        matches!(e, BoatError::Network(ref m) if !m.contains("boat_wrong")),
        "{e:?}"
    );
}

#[tokio::test]
async fn no_key_makes_no_call() {
    let fake: Shared = Arc::default();
    let key: super::boat::KeySource =
        Arc::new(|| Err(BoatError::NoKey("no boat.dev key: Settings › Cloud".into())));
    let boat = RestBoat::new("http://127.0.0.1:9/api/v1", key);
    assert_eq!(
        boat.limits().await,
        Err(BoatError::NoKey("no boat.dev key: Settings › Cloud".into()))
    );
    assert!(fake.lock().unwrap().seen.is_empty());
}
