//! "Sign in with boat" against a fake boat.dev that answers with W448's recorded answers (testdata/boat/signin.json):
//! the sign-in's key is used once, to make the setup step's narrow key, and revoked; only the narrow key is sealed.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use fleetd_contracts::cloud::BoatSignInState;
use serde_json::{Value, json};

use super::{HubFleet, Pool, open_key};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const T0: u64 = 1_793_828_400_000; // 2026-11-04T19:40:00Z
const CLAIM: &str = "clm_test_claim_token_never_logged";
const SIGN_IN_KEY: &str = "boat_test_sign_in_token_never_logged";
const MINTED: &str = "boat_test_minted_key_never_logged";
const ENV_ID: &str = "ce42d23f-f2de-4b9f-bdbe-1f03ed8274f5";

fn answers() -> Value {
    serde_json::from_str(include_str!("testdata/boat/signin.json")).unwrap()
}

fn pool_answers() -> Value {
    serde_json::from_str(include_str!("testdata/boat/answers.json")).unwrap()
}

#[derive(Clone, Debug)]
struct Seen {
    method: Method,
    path: String,
    auth: Option<String>,
    body: String,
}

#[derive(Default)]
struct Fake {
    seen: Vec<Seen>,
    /// Asks for the token answered "pending" before the person typed the code.
    pending: u32,
    /// boat makes a full-access key whatever was asked.
    broad: bool,
}

type Shared = Arc<Mutex<Fake>>;

fn answer(status: u16, body: Value) -> Response {
    assert!(!body.is_null(), "no recorded answer");
    (StatusCode::from_u16(status).unwrap(), axum::Json(body)).into_response()
}

async fn serve(
    State(fake): State<Shared>,
    method: Method,
    headers: HeaderMap,
    uri: axum::http::Uri,
    body: Bytes,
) -> Response {
    let path = uri.path().to_owned();
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim_start_matches("Bearer ").to_owned());
    let body = String::from_utf8(body.to_vec()).unwrap();
    let (pending, broad) = {
        let mut f = fake.lock().unwrap();
        f.seen.push(Seen {
            method: method.clone(),
            path: path.clone(),
            auth: auth.clone(),
            body: body.clone(),
        });
        let pending = path == "/api/box/oauth2/token" && f.pending > 0;
        if pending {
            f.pending -= 1;
        }
        (pending, f.broad)
    };
    let a = answers();
    match (method.as_str(), path.as_str()) {
        ("POST", "/api/box/agent/identity") => return answer(200, a["identity"].clone()),
        ("POST", "/api/box/oauth2/token") if pending => return answer(400, a["pending"].clone()),
        ("POST", "/api/box/oauth2/token") if body.contains(CLAIM) => {
            return answer(200, a["token"].clone());
        }
        ("POST", "/api/box/oauth2/token") => return answer(400, a["invalid_claim_token"].clone()),
        ("POST", "/api/box/oauth2/revoke") => return answer(200, a["revoked"].clone()),
        _ => {}
    }
    let p = pool_answers();
    match (auth.as_deref(), method.as_str(), path.as_str()) {
        (Some(SIGN_IN_KEY), "GET", "/api/v1/environments") => {
            answer(200, a["environments"].clone())
        }
        (Some(SIGN_IN_KEY), "POST", "/api/v1/api-keys/scoped") => {
            let asked: Value = serde_json::from_str(&body).unwrap();
            if asked["ttl"] == "365d" {
                return answer(403, a["mint_too_long"].clone());
            }
            let mut minted = a["minted"].clone();
            if broad {
                minted["apiKey"]["scope"]["actions"] = json!(["*"]);
            }
            answer(201, minted)
        }
        (Some(SIGN_IN_KEY), "DELETE", p) if p.starts_with("/api/v1/api-keys/") => {
            answer(200, a["key_deleted"].clone())
        }
        // The pool's Test, with the key sealed: only the minted one works.
        (Some(MINTED), "GET", "/api/v1/limits") => answer(200, p["limits"].clone()),
        (Some(MINTED), "GET", "/api/v1/sandboxes") => answer(200, p["list-page-2"].clone()),
        _ => answer(401, p["unauthorized"].clone()),
    }
}

struct World {
    pool: Arc<Pool>,
    fake: Shared,
    clock: Arc<ManualClock>,
    api: String,
    home: tempfile::TempDir,
}

async fn world() -> World {
    let fake: Shared = Arc::default();
    let router = Router::new()
        .route("/{*rest}", any(serve))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let api = format!("http://{addr}/api/v1");
    let clock = ManualClock::at(T0);
    let home = tempfile::tempdir().unwrap();
    let pool = Pool::over_boat(
        HubDb::open_memory().unwrap(),
        home.path().into(),
        &api,
        ("127.0.0.1".into(), 4790),
        Arc::new(HubFleet::default()),
        clock.clone(),
        chrono_tz::UTC,
    );
    World {
        pool,
        fake,
        clock,
        api,
        home,
    }
}

impl World {
    async fn begin(&self, environment: &str) -> super::signin::Flow {
        self.pool
            .sign_in_begin(
                &self.api,
                "person@example.com",
                environment.into(),
                "fleetd-devbox".into(),
            )
            .await
            .unwrap()
    }

    fn seen(&self, path: &str) -> Vec<Seen> {
        let f = self.fake.lock().unwrap();
        f.seen.iter().filter(|s| s.path == path).cloned().collect()
    }

    fn sealed(&self) -> Option<String> {
        open_key(self.pool.ledger(), self.home.path())
            .ok()
            .map(|k| k.as_str().to_owned())
    }
}

#[tokio::test]
async fn sign_in_seals_only_the_narrow_key_and_revokes_the_sign_ins_own() {
    let w = world().await;
    w.fake.lock().unwrap().pending = 1;
    let mut flow = w.begin("fleetd-devbox").await;

    // The person sees boat's link and code; the claim token stays in the flow.
    let shown = w.pool.sign_in().unwrap();
    assert_eq!(shown.state, BoatSignInState::Waiting);
    assert_eq!(shown.user_code.as_deref(), Some("151323"));
    assert!(
        shown
            .verification_uri
            .unwrap()
            .contains("claim_attempt_token=")
    );
    assert_eq!(shown.expires_at_ms, Some(T0 as i64 + 600_000));
    assert_eq!(flow.interval, 5);
    let identity = &w.seen("/api/box/agent/identity")[0];
    let sent: Value = serde_json::from_str(&identity.body).unwrap();
    assert_eq!(
        sent,
        json!({"type": "service_auth", "login_hint": "person@example.com"})
    );

    // Pending until they typed the code, then the hub's key from the sign-in's.
    assert!(!w.pool.sign_in_step(&mut flow).await);
    assert_eq!(w.pool.sign_in().unwrap().state, BoatSignInState::Waiting);
    assert!(w.pool.sign_in_step(&mut flow).await);

    let mint = &w.seen("/api/v1/api-keys/scoped")[0];
    assert_eq!(mint.auth.as_deref(), Some(SIGN_IN_KEY));
    let asked: Value = serde_json::from_str(&mint.body).unwrap();
    assert_eq!(
        asked,
        json!({
            "name": "fleetd-devbox",
            "ttl": "364d",
            "actions": ["sandbox.create", "sandbox.read", "sandbox.update", "sandbox.stop", "sandbox.resume",
                        "sandbox.delete", "ssh", "account.read"],
            "environmentIds": [ENV_ID],
        })
    );
    let revoke = w.seen("/api/box/oauth2/revoke");
    assert_eq!(revoke.len(), 1);
    assert_eq!(
        revoke[0].body,
        format!("token={SIGN_IN_KEY}&token_type_hint=access_token")
    );

    // Only the narrow key is sealed, the environment it reaches is saved, and Test passed with it.
    assert_eq!(w.sealed().as_deref(), Some(MINTED));
    let s = w.pool.ledger().settings().unwrap();
    assert_eq!(s.environment.as_deref(), Some("fleetd-devbox"));
    assert!(w.pool.key_test().unwrap().ok, "{:?}", w.pool.key_test());
    let done = w.pool.sign_in().unwrap();
    assert_eq!(done.state, BoatSignInState::Done);
    assert_eq!(
        done.said.as_deref(),
        Some(
            "Signed in as person@example.com: the hub's key fleetd-devbox is sealed, scoped to fleetd-devbox for \
             364 days. The sign-in's own key is revoked."
        )
    );
    assert!(done.user_code.is_none() && done.verification_uri.is_none());

    // The claim token went only to the token endpoint; no key or token is shown.
    let f = w.fake.lock().unwrap();
    for s in &f.seen {
        if s.body.contains(CLAIM) {
            assert_eq!(s.path, "/api/box/oauth2/token");
        }
    }
    let view = serde_json::to_string(&done).unwrap();
    assert!(!view.contains("boat_") && !view.contains(CLAIM), "{view}");
}

#[tokio::test]
async fn a_broader_key_than_asked_is_revoked_and_nothing_is_sealed() {
    let w = world().await;
    w.fake.lock().unwrap().broad = true;
    let mut flow = w.begin("fleetd-devbox").await;
    assert!(w.pool.sign_in_step(&mut flow).await);

    let deleted = w.seen("/api/v1/api-keys/2f5bf143-1514-49e6-b190-eeee772f941d");
    assert_eq!(deleted.len(), 1);
    assert_eq!(deleted[0].method, Method::DELETE);
    assert_eq!(w.seen("/api/box/oauth2/revoke").len(), 1);
    assert_eq!(w.sealed(), None);
    let failed = w.pool.sign_in().unwrap();
    assert_eq!(failed.state, BoatSignInState::Failed);
    assert_eq!(
        failed.said.as_deref(),
        Some("boat.dev made a broader key than asked (*): it was revoked, and nothing was saved.")
    );
}

#[tokio::test]
async fn an_environment_missing_or_not_safe_for_third_parties_makes_no_key() {
    for (environment, why) in [
        (
            "fleetd-other",
            "boat.dev has no environment named fleetd-other: make it, with Safe for third parties on, then sign in again.",
        ),
        (
            "base",
            "boat.dev's environment base isn't Safe for third parties: turn that on, then sign in again.",
        ),
    ] {
        let w = world().await;
        let mut flow = w.begin(environment).await;
        assert!(w.pool.sign_in_step(&mut flow).await);
        assert!(w.seen("/api/v1/api-keys/scoped").is_empty());
        assert_eq!(w.seen("/api/box/oauth2/revoke").len(), 1, "{environment}");
        assert_eq!(w.sealed(), None);
        let failed = w.pool.sign_in().unwrap();
        assert_eq!(failed.state, BoatSignInState::Failed);
        assert_eq!(failed.said.as_deref(), Some(why));
    }
}

#[tokio::test]
async fn a_stopped_or_lapsed_sign_in_asks_boat_no_more() {
    let w = world().await;
    let mut flow = w.begin("fleetd-devbox").await;
    w.pool.sign_in_stop();
    assert!(w.pool.sign_in_step(&mut flow).await);
    assert!(w.seen("/api/box/oauth2/token").is_empty());
    assert_eq!(w.pool.sign_in(), None);

    let mut flow = w.begin("fleetd-devbox").await;
    w.clock.advance(Duration::from_secs(601));
    assert!(w.pool.sign_in_step(&mut flow).await);
    assert!(w.seen("/api/box/oauth2/token").is_empty());
    let lapsed = w.pool.sign_in().unwrap();
    assert_eq!(lapsed.state, BoatSignInState::Failed);
    assert_eq!(
        lapsed.said.as_deref(),
        Some("The code lapsed before it was typed: sign in again.")
    );
}

#[test]
fn only_an_email_goes_to_boat_as_the_login_hint() {
    use super::signin::email_ok;
    assert!(email_ok("person@example.com"));
    for bad in [
        "",
        "person",
        "@example.com",
        "person@example",
        "a b@example.com",
    ] {
        assert!(!email_ok(bad), "{bad}");
    }
}
