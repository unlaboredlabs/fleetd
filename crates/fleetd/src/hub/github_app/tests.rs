//! The hub's GitHub App against a fake GitHub that checks each JWT's signature: the manifest, the code traded and the
//! keys sealed to the hub's box key and never shown, Test reading installations, tokens only for the repositories the
//! App reaches and minted again near their end, `gh` run as the App, and an admin-only surface.
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use fleetd_contracts::auth::{Grant, KeyKind};
use fleetd_contracts::github_app::GITHUB_APP_PERMISSIONS;
use fleetd_contracts::people::{HubRole, PersonId, PersonName};
use serde_json::{Value, json};

use super::gh::{AppGh, repo_of};
use super::{Endpoints, manifest};
use crate::clock::Clock;
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::people::People;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, iso_ms};
use crate::hub::train::github::GhRunner;

const KEY: &str = include_str!("testdata/app-test-key.pem");
const CLIENT_SECRET: &str = "client-secret-never-shown";
const WEBHOOK_SECRET: &str = "webhook-secret-never-shown";
const APP_ID: i64 = 4242;

#[derive(Default)]
struct Fake {
    /// Tokens minted, in order.
    minted: Vec<String>,
    /// Calls with a JWT that didn't verify.
    bad_jwts: usize,
    /// People's tokens issued so far: `ghu_<n>` and `ghr_<n>`.
    issued: usize,
    /// GitHub no longer takes refresh tokens (revoked).
    refuse_refresh: bool,
    /// Grants revoked.
    revoked: usize,
}

#[derive(Clone)]
struct Shared {
    fake: Arc<Mutex<Fake>>,
    clock: Arc<ManualClock>,
}

/// Whether the bearer is a JWT for the App, signed with its key.
fn verified(headers: &HeaderMap) -> bool {
    let Some(jwt) = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return false;
    };
    let Some((signed, signature)) = jwt.rsplit_once('.') else {
        return false;
    };
    let pair = super::signer(KEY).unwrap();
    let public = ring::signature::UnparsedPublicKey::new(
        &ring::signature::RSA_PKCS1_2048_8192_SHA256,
        pair.public().as_ref().to_vec(),
    );
    let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    let claims: Value = signed
        .split('.')
        .nth(1)
        .and_then(|c| URL_SAFE_NO_PAD.decode(c).ok())
        .and_then(|c| serde_json::from_slice(&c).ok())
        .unwrap_or_default();
    public.verify(signed.as_bytes(), &signature).is_ok()
        && claims["iss"].as_str().and_then(|s| s.parse().ok()) == Some(APP_ID)
}

fn bearer(headers: &HeaderMap) -> String {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_owned()
}

fn refused(status: StatusCode, message: &str) -> Response {
    (status, axum::Json(json!({ "message": message }))).into_response()
}

async fn conversion(Path(code): Path<String>) -> Response {
    if code != "good-code" {
        return refused(StatusCode::NOT_FOUND, "Not Found");
    }
    axum::Json(json!({
        "id": APP_ID, "slug": "fleetd-on-devbox-2", "name": "fleetd on devbox 2",
        "owner": { "login": "acme", "type": "Organization" }, "html_url": "https://github.com/apps/fleetd-on-devbox-2",
        "client_id": "Iv23liTEST", "client_secret": CLIENT_SECRET, "webhook_secret": WEBHOOK_SECRET, "pem": KEY,
    }))
    .into_response()
}

async fn app(State(s): State<Shared>, headers: HeaderMap) -> Response {
    if !verified(&headers) {
        s.fake.lock().unwrap().bad_jwts += 1;
        return refused(
            StatusCode::UNAUTHORIZED,
            "A JSON web token could not be decoded",
        );
    }
    axum::Json(json!({ "id": APP_ID, "slug": "fleetd-on-devbox-2" })).into_response()
}

async fn installations(State(s): State<Shared>, headers: HeaderMap) -> Response {
    if !verified(&headers) {
        s.fake.lock().unwrap().bad_jwts += 1;
        return refused(
            StatusCode::UNAUTHORIZED,
            "A JSON web token could not be decoded",
        );
    }
    axum::Json(json!([
        { "id": 7, "account": { "login": "acme" }, "repository_selection": "selected" },
        { "id": 8, "account": { "login": "Solo" }, "repository_selection": "all" },
    ]))
    .into_response()
}

async fn access_token(
    State(s): State<Shared>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    let mut fake = s.fake.lock().unwrap();
    if !verified(&headers) {
        fake.bad_jwts += 1;
        return refused(
            StatusCode::UNAUTHORIZED,
            "A JSON web token could not be decoded",
        );
    }
    let token = format!("ghs_{id}_{}", fake.minted.len());
    fake.minted.push(token.clone());
    let expires = crate::hub::store::now_ms(s.clock.as_ref() as &dyn Clock) + 60 * 60_000;
    (
        StatusCode::CREATED,
        axum::Json(json!({ "token": token, "expires_at": iso_ms(expires) })),
    )
        .into_response()
}

async fn repositories(headers: HeaderMap) -> Response {
    let token = bearer(&headers);
    if token.starts_with("ghs_7_") {
        axum::Json(json!({ "total_count": 2, "repositories": [
            { "full_name": "acme/web" }, { "full_name": "acme/api" },
        ]}))
        .into_response()
    } else if token.starts_with("ghs_8_") {
        axum::Json(json!({ "total_count": 31, "repositories": [{ "full_name": "Solo/notes" }] }))
            .into_response()
    } else {
        refused(StatusCode::UNAUTHORIZED, "Bad credentials")
    }
}

/// GitHub's token endpoint for people's sign-in: a code from the sign-in, with the App's client and the PKCE verifier,
/// or a refresh token, makes a new pair. GitHub says a refusal with 200 and an `error`.
async fn user_token(
    State(s): State<Shared>,
    axum::Form(form): axum::Form<std::collections::HashMap<String, String>>,
) -> Response {
    let mut fake = s.fake.lock().unwrap();
    let field = |k: &str| form.get(k).map(String::as_str).unwrap_or_default();
    if field("client_id") != "Iv23liTEST" || field("client_secret") != CLIENT_SECRET {
        return axum::Json(json!({ "error": "incorrect_client_credentials" })).into_response();
    }
    let ok = match field("grant_type") {
        "refresh_token" => {
            !fake.refuse_refresh && field("refresh_token") == format!("ghr_{}", fake.issued)
        }
        _ => {
            field("code") == "good-user-code"
                && field("code_verifier").len() >= 43
                && field("redirect_uri").starts_with("http://127.0.0.1:")
        }
    };
    if !ok {
        return axum::Json(json!({ "error": "bad_refresh_token", "error_description": "The refresh token passed is incorrect or expired." }))
            .into_response();
    }
    fake.issued += 1;
    let n = fake.issued;
    axum::Json(json!({
        "access_token": format!("ghu_{n}"), "expires_in": 28800,
        "refresh_token": format!("ghr_{n}"), "refresh_token_expires_in": 15_811_200, "token_type": "bearer",
    }))
    .into_response()
}

async fn user(headers: HeaderMap) -> Response {
    if !bearer(&headers).starts_with("ghu_") {
        return refused(StatusCode::UNAUTHORIZED, "Bad credentials");
    }
    axum::Json(json!({ "login": "sam-rivera", "id": 583231 })).into_response()
}

async fn revoke(State(s): State<Shared>) -> Response {
    s.fake.lock().unwrap().revoked += 1;
    StatusCode::NO_CONTENT.into_response()
}

async fn fake_github(clock: Arc<ManualClock>) -> (Endpoints, Arc<Mutex<Fake>>) {
    let fake: Arc<Mutex<Fake>> = Arc::default();
    let shared = Shared {
        fake: fake.clone(),
        clock,
    };
    let router = Router::new()
        .route("/app-manifests/{code}/conversions", post(conversion))
        .route("/app", get(app))
        .route("/app/installations", get(installations))
        .route("/app/installations/{id}/access_tokens", post(access_token))
        .route("/installation/repositories", get(repositories))
        .route("/login/oauth/access_token", post(user_token))
        .route("/user", get(user))
        .route(
            "/applications/{client}/grant",
            axum::routing::delete(revoke),
        )
        .with_state(shared);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let ep = Endpoints {
        api: base.clone(),
        web: base,
    };
    (ep, fake)
}

struct Lab {
    hub: Arc<Hub>,
    clock: Arc<ManualClock>,
    fake: Arc<Mutex<Fake>>,
    _home: tempfile::TempDir,
}

async fn lab() -> Lab {
    let home = tempfile::tempdir().unwrap();
    lab_in(
        home,
        HubDb::open_memory().unwrap(),
        ManualClock::at(1_792_000_000_000),
    )
    .await
}

/// A hub over `db` in `home`, with its own fake GitHub.
async fn lab_in(home: tempfile::TempDir, db: Arc<HubDb>, clock: Arc<ManualClock>) -> Lab {
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: Some("http://devbox.example.ts.net:4790".into()),
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(db, config, clock.clone()).unwrap();
    let (ep, fake) = fake_github(clock.clone()).await;
    hub.github_app.set_endpoints(ep);
    Lab {
        hub,
        clock,
        fake,
        _home: home,
    }
}

fn device(hub: &Hub, person: &PersonId, role: &str) -> Caller {
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": role, "machines": "*" }])).unwrap();
    hub.auth
        .create_key_for("desk", &grants, KeyKind::Human, Some(person))
        .unwrap()
        .info
}

fn admin(hub: &Hub) -> Caller {
    let owner = People::new(hub.db.clone(), hub.clock.clone())
        .ensure_owner()
        .unwrap()
        .person_id;
    device(hub, &owner, "admin")
}

fn member(hub: &Hub) -> Caller {
    let bob = People::new(hub.db.clone(), hub.clock.clone())
        .create(&PersonName::unchecked("Bob"), HubRole::Member)
        .unwrap()
        .person_id;
    device(hub, &bob, "operate")
}

async fn call(
    hub: &Arc<Hub>,
    caller: &Caller,
    tool: &str,
    input: Value,
) -> Result<Value, CallError> {
    registry().call(hub, caller, tool, input).await
}

fn refusal(result: Result<Value, CallError>) -> (String, String) {
    match result {
        Err(CallError::Tool(e)) => (
            serde_json::to_value(e.code)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned(),
            e.message,
        ),
        Err(CallError::Invalid(m)) => ("invalid".to_owned(), m),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

async fn created(lab: &Lab) -> Value {
    call(
        &lab.hub,
        &admin(&lab.hub),
        "github_app_create",
        json!({ "code": "good-code" }),
    )
    .await
    .unwrap()
}

#[test]
fn the_manifest_asks_for_what_the_train_needs_and_sets_no_webhook() {
    let m = manifest(
        "fleetd on devbox",
        "http://devbox.example.ts.net:4790",
        "http://127.0.0.1:5123/created",
    );
    assert_eq!(m["name"], "fleetd on devbox");
    assert_eq!(m["url"], "http://devbox.example.ts.net:4790");
    assert_eq!(m["redirect_url"], "http://127.0.0.1:5123/created");
    assert_eq!(m["public"], false);
    assert_eq!(
        m["default_permissions"],
        json!({
            "contents": "write", "pull_requests": "write", "issues": "write", "workflows": "write", "statuses": "write",
            "actions": "write", "checks": "read", "metadata": "read",
        })
    );
    // Webhooks off (D192): no hook_attributes and no events.
    assert!(m.get("hook_attributes").is_none());
    assert_eq!(m["default_events"], json!([]));
}

#[test]
fn a_gh_run_names_its_repository_in_each_shape_the_hub_uses() {
    let args = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        repo_of(&args(&[
            "pr", "view", "7", "--repo", "acme/web", "--json", "x"
        ]))
        .as_deref(),
        Some("acme/web")
    );
    assert_eq!(
        repo_of(&args(&[
            "api",
            "-X",
            "PUT",
            "-H",
            "Accept: x",
            "repos/acme/web/pulls/7/merge",
            "-f",
            "sha=1"
        ]))
        .as_deref(),
        Some("acme/web")
    );
    assert_eq!(
        repo_of(&args(&["api", "/repos/acme/web.site?per_page=1"])).as_deref(),
        Some("acme/web.site")
    );
    assert_eq!(
        repo_of(&args(&[
            "api",
            "graphql",
            "-f",
            "query=q",
            "-f",
            "owner=acme",
            "-f",
            "name=web",
            "-F",
            "first=50"
        ]))
        .as_deref(),
        Some("acme/web")
    );
    assert_eq!(repo_of(&args(&["api", "user"])), None);
    // A field's value is never taken for a path.
    assert_eq!(
        repo_of(&args(&["api", "graphql", "-f", "query=repos/x/y"])),
        None
    );
}

#[tokio::test]
async fn the_code_becomes_the_app_with_its_keys_sealed_to_the_hub_and_never_shown() {
    let lab = lab().await;
    let out = created(&lab).await;
    let text = out.to_string();
    assert_eq!(out["app"]["appId"], APP_ID);
    // The slug is GitHub's, never the name proposed.
    assert_eq!(out["app"]["slug"], "fleetd-on-devbox-2");
    assert_eq!(out["app"]["owner"], "acme");
    assert_eq!(out["app"]["clientId"], "Iv23liTEST");
    assert_eq!(
        out["app"]["settingsUrl"],
        format!(
            "{}/organizations/acme/settings/apps/fleetd-on-devbox-2",
            lab.hub.github_app.endpoints().web
        )
    );
    for secret in ["PRIVATE KEY", CLIENT_SECRET, WEBHOOK_SECRET] {
        assert!(!text.contains(secret), "{secret} returned");
    }
    let got = call(&lab.hub, &member(&lab.hub), "github_app_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["app"]["name"], "fleetd on devbox 2");
    assert!(!got.to_string().contains(CLIENT_SECRET));
    // Kept sealed: no column holds a secret in the clear, and the key opens with the hub's box key.
    let (data, key, client, hook): (String, Vec<u8>, Vec<u8>, Vec<u8>) = lab
        .hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT data, sealed_key, sealed_client_secret, sealed_webhook_secret FROM github_app",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?)
        })
        .unwrap();
    for secret in ["PRIVATE KEY", CLIENT_SECRET, WEBHOOK_SECRET] {
        assert!(!data.contains(secret));
        for blob in [&key, &client, &hook] {
            assert!(!String::from_utf8_lossy(blob).contains(secret));
        }
    }
    let box_key = crate::node::identity::load_or_create_box_key(&lab.hub.config.home).unwrap();
    assert_eq!(box_key.open(&key).unwrap().as_slice(), KEY.as_bytes());
    assert_eq!(
        box_key.open(&hook).unwrap().as_slice(),
        WEBHOOK_SECRET.as_bytes()
    );
}

#[tokio::test]
async fn a_used_code_says_to_create_the_app_again() {
    let lab = lab().await;
    let (code, message) = refusal(
        call(
            &lab.hub,
            &admin(&lab.hub),
            "github_app_create",
            json!({ "code": "used-code" }),
        )
        .await,
    );
    assert_eq!(code, "failed");
    assert!(message.contains("Create the App again"), "{message}");
    assert!(lab.hub.db.github_app().get().unwrap().is_none());
}

#[tokio::test]
async fn only_an_owner_or_admin_sets_it_up() {
    let lab = lab().await;
    let bob = member(&lab.hub);
    for (tool, input) in [
        (
            "github_app_manifest",
            json!({ "name": "fleetd on devbox", "redirect": "http://127.0.0.1:5123/created" }),
        ),
        ("github_app_create", json!({ "code": "good-code" })),
        ("github_app_test", json!({})),
        ("github_app_remove", json!({})),
    ] {
        let (code, _) = refusal(call(&lab.hub, &bob, tool, input).await);
        assert_eq!(code, "forbidden", "{tool}");
    }
    assert!(lab.hub.db.github_app().get().unwrap().is_none());
}

#[tokio::test]
async fn the_manifest_goes_to_the_account_or_the_organization() {
    let lab = lab().await;
    let me = admin(&lab.hub);
    let base = lab.hub.github_app.endpoints().web;
    let mine = call(
        &lab.hub,
        &me,
        "github_app_manifest",
        json!({ "name": "fleetd on devbox", "redirect": "http://127.0.0.1:5123/created" }),
    )
    .await
    .unwrap();
    assert_eq!(mine["postTo"], format!("{base}/settings/apps/new"));
    let manifest: Value = serde_json::from_str(mine["manifest"].as_str().unwrap()).unwrap();
    assert_eq!(manifest["url"], "http://devbox.example.ts.net:4790");
    assert_eq!(manifest["redirect_url"], "http://127.0.0.1:5123/created");
    let org = call(
        &lab.hub,
        &me,
        "github_app_manifest",
        json!({ "name": "fleetd on devbox", "redirect": "http://127.0.0.1:5123/created", "organization": "acme" }),
    )
    .await
    .unwrap();
    assert_eq!(
        org["postTo"],
        format!("{base}/organizations/acme/settings/apps/new")
    );
    // Only a loopback page takes the code back.
    let (code, _) = refusal(
        call(
            &lab.hub,
            &me,
            "github_app_manifest",
            json!({ "name": "fleetd on devbox", "redirect": "http://evil.example/created" }),
        )
        .await,
    );
    assert_eq!(code, "invalid");
}

#[tokio::test]
async fn test_reads_where_it_is_installed_with_a_token_for_each() {
    let lab = lab().await;
    created(&lab).await;
    let out = call(&lab.hub, &admin(&lab.hub), "github_app_test", json!({}))
        .await
        .unwrap();
    let app = &out["app"];
    assert_eq!(app["lastTest"]["ok"], true, "{app}");
    assert_eq!(
        app["lastTest"]["said"],
        "\"fleetd on devbox 2\" is installed on acme (2 repositories), Solo (all 31 repositories), and its tokens work."
    );
    assert_eq!(
        app["installations"][0]["repositories"],
        json!(["acme/web", "acme/api"])
    );
    assert_eq!(app["installations"][1]["allRepositories"], true);
    assert_eq!(app["installations"][1]["repositories"], json!([]));
    assert_eq!(lab.fake.lock().unwrap().bad_jwts, 0);
    assert!(!out.to_string().contains("ghs_"), "a token returned");
    // Kept: the app's page shows it without a new Test.
    let got = call(&lab.hub, &admin(&lab.hub), "github_app_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["app"]["lastTest"], app["lastTest"]);
}

#[tokio::test]
async fn tokens_reach_only_installed_repositories_and_are_minted_again_near_their_end() {
    let lab = lab().await;
    let apps = &lab.hub.github_app;
    assert!(apps.token_for("acme/web").await.is_none(), "no App yet");
    created(&lab).await;
    let first = apps.token_for("acme/web").await.unwrap();
    assert!(first.starts_with("ghs_7_"));
    // Same installation, same token, until it nears its end.
    assert_eq!(*apps.token_for("ACME/api").await.unwrap(), *first);
    assert!(
        apps.token_for("acme/elsewhere").await.is_none(),
        "not among the chosen"
    );
    assert!(
        apps.token_for("solo/anything")
            .await
            .unwrap()
            .starts_with("ghs_8_")
    );
    assert!(apps.token_for("stranger/web").await.is_none());
    let minted = lab.fake.lock().unwrap().minted.len();
    lab.clock.advance(Duration::from_secs(56 * 60));
    let again = apps.token_for("acme/web").await.unwrap();
    assert_ne!(*again, *first);
    assert!(lab.fake.lock().unwrap().minted.len() > minted);
    // Removed: the machine's own login again.
    call(&lab.hub, &admin(&lab.hub), "github_app_remove", json!({}))
        .await
        .unwrap();
    assert!(apps.token_for("acme/web").await.is_none());
    let (code, _) = refusal(call(&lab.hub, &admin(&lab.hub), "github_app_test", json!({})).await);
    assert_eq!(code, "not_found");
}

#[tokio::test]
async fn gh_runs_as_the_app_on_its_repositories_and_on_its_own_login_elsewhere() {
    let lab = lab().await;
    created(&lab).await;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("gh");
    // As GitHub answers an App on a path it may not take: refused with its token, fine on the machine's login.
    std::fs::write(
        &script,
        "#!/bin/sh\ncase \"$*\" in *protected*) if [ \"${GH_TOKEN#ghs_}\" != \"$GH_TOKEN\" ]; then echo 'HTTP 403: Resource not accessible by integration' >&2; exit 1; fi; echo machine; exit 0;; esac\nprintf '%s' \"$GH_TOKEN\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let gh = AppGh::with_program(lab.hub.github_app.clone(), script.to_string_lossy());
    let args = |a: &[&str]| a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
    let out = gh
        .run(args(&["pr", "view", "7", "--repo", "acme/web"]))
        .await
        .unwrap();
    assert!(out.stdout.starts_with("ghs_7_"), "{}", out.stdout);
    let elsewhere = gh
        .run(args(&["api", "repos/stranger/web/pulls"]))
        .await
        .unwrap();
    assert!(
        !elsewhere.stdout.starts_with("ghs_"),
        "{}",
        elsewhere.stdout
    );
    let user = gh.run(args(&["api", "user"])).await.unwrap();
    assert!(!user.stdout.starts_with("ghs_"));
    // Refused to the App: once more on the machine's login.
    let refused = gh
        .run(args(&["api", "repos/acme/web/branches/main/protected"]))
        .await
        .unwrap();
    assert_eq!((refused.exit_code, refused.stdout.trim()), (0, "machine"));
}

/// What each REST path the hub's gh calls needs of a GitHub App, by its first segment after the repository (and, under
/// `commits/{sha}`, the next one), from GitHub's "Permissions required for GitHub Apps". Labels and a PR's comments
/// go through the issues endpoints.
const NEEDS: &[(&str, &str, &str)] = &[
    ("pulls", "pull_requests", "write"),
    ("issues", "issues", "write"),
    ("labels", "issues", "write"),
    ("contents", "contents", "read"),
    ("git", "contents", "write"),
    ("compare", "contents", "read"),
    ("merges", "contents", "write"),
    ("branches", "contents", "read"),
    ("commits", "contents", "read"),
    ("commits/status", "statuses", "read"),
    ("commits/check-runs", "checks", "read"),
    ("commits/pulls", "pull_requests", "read"),
    ("statuses", "statuses", "write"),
    ("check-runs", "checks", "read"),
    ("actions", "actions", "write"),
    ("rules", "metadata", "read"),
];

#[test]
fn the_manifest_asks_for_everything_the_hubs_github_calls_need() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/hub");
    // Every area whose gh runs as the App (serve/mod.rs: the train with its reviews, and the PR pages).
    let mut text = String::new();
    for dir in ["train", "prs", "reviews"] {
        for entry in std::fs::read_dir(src.join(dir)).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|e| e == "rs")
                && !path.file_name().unwrap().to_string_lossy().contains("test")
            {
                text.push_str(&std::fs::read_to_string(&path).unwrap());
            }
        }
    }
    let path =
        regex::Regex::new(r"repos/\{[a-z_.]*\}/([a-z_-]+)(?:/\{[^}]*\})?(?:/([a-z_-]+))?").unwrap();
    let granted = |name: &str, level: &str| {
        GITHUB_APP_PERMISSIONS
            .iter()
            .any(|(k, v)| *k == name && (*v == level || *v == "write"))
    };
    let mut seen = 0;
    for m in path.captures_iter(&text) {
        let first = &m[1];
        let key = match (first, m.get(2)) {
            ("commits", Some(next)) => format!("commits/{}", next.as_str()),
            _ => first.to_owned(),
        };
        let Some((_, name, level)) = NEEDS.iter().find(|(k, _, _)| *k == key) else {
            panic!(
                "the hub calls {} on GitHub: say what it needs in NEEDS",
                &m[0]
            );
        };
        assert!(
            granted(name, level),
            "{} needs {name}: {level}, which the App's manifest doesn't ask for",
            &m[0]
        );
        seen += 1;
    }
    assert!(
        seen > 20,
        "only {seen} GitHub paths found: the scan missed them"
    );
    // The labelled PRs (fleetd:next) are listed through the issues endpoint.
    assert!(granted("issues", "write"));
    // gh's own commands: each one the hub runs, and what it needs.
    let pr = regex::Regex::new(r#""pr",\s*"([a-z-]+)""#).unwrap();
    let mut commands = 0;
    for m in pr.captures_iter(&text) {
        let needs: &[(&str, &str)] = match &m[1] {
            "view" | "list" | "checks" | "diff" => &[("pull_requests", "read")],
            "update-branch" | "merge" => &[("pull_requests", "write"), ("contents", "write")],
            "edit" | "comment" | "ready" | "close" => &[("pull_requests", "write")],
            other => panic!("the hub runs gh pr {other}: say what it needs here"),
        };
        for (name, level) in needs {
            assert!(
                granted(name, level),
                "gh pr {} needs {name}: {level}",
                &m[1]
            );
        }
        commands += 1;
    }
    assert!(
        commands >= 2,
        "only {commands} gh pr commands found: the scan missed them"
    );
    // GraphQL, in a query or a `--json` list: each field that reads more than the pull request itself.
    for (field, name, level) in [
        ("pullRequest", "pull_requests", "read"),
        ("statusCheckRollup", "checks", "read"),
        ("statusCheckRollup", "statuses", "read"),
        ("labels", "issues", "read"),
        ("commits", "contents", "read"),
        ("mergeCommit", "contents", "read"),
    ] {
        if text.contains(field) {
            assert!(
                granted(name, level),
                "GraphQL's {field} needs {name}: {level}"
            );
        }
    }
    assert!(
        text.contains("statusCheckRollup"),
        "the PR pages' GraphQL wasn't scanned"
    );
}

const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const LOOPBACK: &str = "http://127.0.0.1:5123/github/callback";

async fn connect(lab: &Lab, caller: &Caller) -> Result<Value, CallError> {
    call(
        &lab.hub,
        caller,
        "github_connect",
        json!({ "code": "good-user-code", "codeVerifier": VERIFIER, "redirectUri": LOOPBACK }),
    )
    .await
}

/// Every text and blob of the people's tokens table, as text.
fn kept_tokens(hub: &Hub) -> String {
    hub.db
        .with(|c| {
            let mut stmt =
                c.prepare("SELECT data, sealed_access, sealed_refresh FROM github_accounts")?;
            let rows = stmt
                .query_map([], |r| {
                    let data: String = r.get(0)?;
                    let a: Vec<u8> = r.get(1)?;
                    let b: Option<Vec<u8>> = r.get(2)?;
                    Ok(format!(
                        "{data}{}{}",
                        String::from_utf8_lossy(&a),
                        String::from_utf8_lossy(&b.unwrap_or_default())
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.concat())
        })
        .unwrap()
}

#[tokio::test]
async fn a_person_connects_their_github_kept_sealed_and_refreshed() {
    let lab = lab().await;
    created(&lab).await;
    let sam = admin(&lab.hub);
    let out = connect(&lab, &sam).await.unwrap();
    assert_eq!(out["me"]["login"], "sam-rivera");
    assert!(!out.to_string().contains("ghu_"));
    let got = call(&lab.hub, &sam, "github_app_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["me"]["login"], "sam-rivera");
    assert_eq!(
        got["authorizeUrl"],
        format!(
            "{}/login/oauth/authorize",
            lab.hub.github_app.endpoints().web
        )
    );
    let kept = kept_tokens(&lab.hub);
    assert!(
        !kept.contains("ghu_") && !kept.contains("ghr_"),
        "a token kept in the clear"
    );
    let person = sam.person.clone().unwrap().person_id;
    let (first, _) = lab
        .hub
        .github_app
        .user_token(&person)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(*first, "ghu_1");
    // Within two hours of its end, a token handed out is refreshed first, and the refresh token turns over.
    lab.clock.advance(Duration::from_secs(6 * 3600 + 60));
    let (second, ends) = lab
        .hub
        .github_app
        .user_token(&person)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(*second, "ghu_2");
    assert!(ends - crate::hub::store::now_ms(lab.clock.as_ref() as &dyn Clock) > 7 * 3600 * 1000);
    lab.clock.advance(Duration::from_secs(6 * 3600 + 60));
    assert_eq!(
        *lab.hub
            .github_app
            .user_token(&person)
            .await
            .unwrap()
            .unwrap()
            .0,
        "ghu_3"
    );
}

#[tokio::test]
async fn a_refresh_github_refuses_marks_the_connection_lapsed() {
    let lab = lab().await;
    created(&lab).await;
    let sam = admin(&lab.hub);
    connect(&lab, &sam).await.unwrap();
    let person = sam.person.clone().unwrap().person_id;
    lab.fake.lock().unwrap().refuse_refresh = true;
    lab.clock.advance(Duration::from_secs(7 * 3600));
    let e = lab.hub.github_app.user_token(&person).await.unwrap_err();
    assert!(e.contains("connect GitHub again"), "{e}");
    let got = call(&lab.hub, &sam, "github_app_get", json!({}))
        .await
        .unwrap();
    assert_eq!(got["me"]["lapsed"], true);
    // Connecting again clears it.
    lab.fake.lock().unwrap().refuse_refresh = false;
    connect(&lab, &sam).await.unwrap();
    assert!(
        lab.hub
            .github_app
            .user_token(&person)
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn disconnecting_revokes_at_github_and_forgets() {
    let lab = lab().await;
    created(&lab).await;
    let sam = admin(&lab.hub);
    connect(&lab, &sam).await.unwrap();
    let out = call(&lab.hub, &sam, "github_disconnect", json!({}))
        .await
        .unwrap();
    assert_eq!(out["revoked"], true);
    assert_eq!(lab.fake.lock().unwrap().revoked, 1);
    let got = call(&lab.hub, &sam, "github_app_get", json!({}))
        .await
        .unwrap();
    assert!(got.get("me").is_none());
    assert_eq!(kept_tokens(&lab.hub), "");
}

#[tokio::test]
async fn only_a_person_connects_and_never_without_an_app() {
    let lab = lab().await;
    let sam = admin(&lab.hub);
    let (code, message) = refusal(connect(&lab, &sam).await);
    assert_eq!(code, "failed");
    assert!(message.contains("no GitHub App yet"), "{message}");
    created(&lab).await;
    let agent: Vec<Grant> =
        serde_json::from_value(json!([{ "role": "operate", "machines": "*" }])).unwrap();
    let agent = lab
        .hub
        .auth
        .create_key_for("lead", &agent, KeyKind::Agent, None)
        .unwrap()
        .info;
    let (code, _) = refusal(connect(&lab, &agent).await);
    assert_eq!(code, "forbidden");
}

/// A project `shop` on devbox whose repo is acme/web, with an order started by `person` (none: nobody).
fn order_on_acme(
    hub: &Hub,
    person: Option<&PersonId>,
) -> (
    fleetd_contracts::ids::ProjectRef,
    fleetd_contracts::ledger::WorkstreamId,
) {
    let summary: fleetd_contracts::model::ProjectSummary = serde_json::from_value(json!({
        "machineId": "devbox", "projectId": "shop", "title": "shop", "workspaceRoot": "/home/dev/src/shop",
        "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": "2026-10-28T10:00:00.000Z",
    }))
    .unwrap();
    hub.store
        .projects_upsert_many(
            &fleetd_contracts::ids::MachineId::unchecked("devbox"),
            &[summary],
        )
        .unwrap();
    hub.db
        .with(|c| {
            c.execute_batch("INSERT OR IGNORE INTO work_projects VALUES ('devbox', 'shop', 'github.com/acme/web', 'main', 1);")?;
            Ok(())
        })
        .unwrap();
    let r: fleetd_contracts::ids::ProjectRef =
        serde_json::from_value(json!({ "machineId": "devbox", "projectId": "shop" })).unwrap();
    let records = &hub.leads.records;
    let (w, _) = records
        .workstream_create(crate::hub::leads::records::NewWorkstream {
            project_ref: r.clone(),
            title: "Ship it".into(),
            text: "Ship it".into(),
            channel: fleetd_contracts::ledger::IntakeChannel::App,
            by: "human".into(),
            at: "2026-10-28T10:00:00.000Z".into(),
            client_request_id: None,
        })
        .unwrap();
    let started_by = person.map(|id| {
        People::new(hub.db.clone(), hub.clock.clone())
            .person_ref(id)
            .unwrap()
            .unwrap()
    });
    records
        .workstream_put(&fleetd_contracts::ledger::Workstream {
            started_by,
            ..w.clone()
        })
        .unwrap();
    (r, w.workstream_id)
}

#[tokio::test]
async fn a_writer_waits_for_its_starter_to_connect_and_runs_as_them() {
    use super::sessions::{GithubAs, github_as, refusal as github_refusal, repo_of as task_repo};
    use fleetd_contracts::tasks::TaskKind;
    let lab = lab().await;
    created(&lab).await;
    let sam = admin(&lab.hub);
    let person = sam.person.clone().unwrap().person_id;
    let (r, order) = order_on_acme(&lab.hub, Some(&person));
    assert_eq!(task_repo(&lab.hub, &r, None).as_deref(), Some("acme/web"));
    // Not installed yet: nothing changes, the machine's own login.
    assert_eq!(github_as(&lab.hub, &r, Some(&order), "acme/web"), None);
    assert_eq!(
        github_refusal(&lab.hub, &r, &order, TaskKind::Write, None),
        None
    );
    call(&lab.hub, &sam, "github_app_test", json!({}))
        .await
        .unwrap();
    assert_eq!(
        github_as(&lab.hub, &r, Some(&order), "acme/web"),
        Some(GithubAs::Person(person.clone()))
    );
    let (message, fix) = github_refusal(&lab.hub, &r, &order, TaskKind::Write, None).unwrap();
    assert!(
        message.starts_with("Connect your GitHub to open this order's PRs."),
        "{message}"
    );
    assert!(fix.contains("Settings › Connections › GitHub"), "{fix}");
    // A reader or reviewer opens no PR: it goes on.
    assert_eq!(
        github_refusal(&lab.hub, &r, &order, TaskKind::Review, None),
        None
    );
    connect(&lab, &sam).await.unwrap();
    assert_eq!(
        github_refusal(&lab.hub, &r, &order, TaskKind::Write, None),
        None
    );
    // Work nobody started runs as the App.
    let (_, nobody) = order_on_acme(&lab.hub, None);
    assert_eq!(
        github_as(&lab.hub, &r, Some(&nobody), "acme/web"),
        Some(GithubAs::App)
    );
    assert_eq!(
        github_refusal(&lab.hub, &r, &nobody, TaskKind::Write, None),
        None
    );
}

#[tokio::test]
async fn a_token_goes_only_to_a_node_that_keeps_it_as_the_orders() {
    use super::sessions::deliver;
    let lab = lab().await;
    created(&lab).await;
    let sam = admin(&lab.hub);
    let person = sam.person.clone().unwrap().person_id;
    let (r, order) = order_on_acme(&lab.hub, Some(&person));
    // Not installed: nothing to hand over.
    deliver(&lab.hub, &r, &order, None, true).await.unwrap();
    call(&lab.hub, &sam, "github_app_test", json!({}))
        .await
        .unwrap();
    // Not connected: a reader or reviewer goes without; a writer that got past its spawn (queued before the App was
    // installed) is refused at its launch, never run on the machine's login.
    deliver(&lab.hub, &r, &order, None, false).await.unwrap();
    let e = deliver(&lab.hub, &r, &order, None, true).await.unwrap_err();
    assert!(
        e.starts_with("Connect your GitHub to open this order's PRs."),
        "{e}"
    );
    connect(&lab, &sam).await.unwrap();
    // devbox's node isn't linked here, so it can't keep an order's variables: refused, never the machine's login.
    let e = deliver(&lab.hub, &r, &order, None, true).await.unwrap_err();
    assert!(e.contains("too old to hand agents a GitHub token"), "{e}");
    assert!(
        lab.hub
            .db
            .order_env()
            .list(&r, order.as_str())
            .unwrap()
            .is_empty()
    );
}

/// The hub restarts while an order's agents run (an update): what it handed them is still renewed, with no new launch.
#[tokio::test]
async fn the_orders_tokens_are_renewed_after_a_hub_restart() {
    use super::sessions::{Kept, keep, kept, renew};
    let home = tempfile::tempdir().unwrap();
    let path = home.path().to_path_buf();
    let clock = ManualClock::at(1_792_000_000_000);
    let first = lab_in(home, HubDb::open(&path).unwrap(), clock.clone()).await;
    created(&first).await;
    call(&first.hub, &admin(&first.hub), "github_app_test", json!({}))
        .await
        .unwrap();
    // Work nobody started: the App's token, handed over at its launch and ending within the hour.
    let (r, order) = order_on_acme(&first.hub, None);
    let now = crate::hub::store::now_ms(clock.as_ref() as &dyn Clock);
    let handed = Kept {
        r: r.clone(),
        order: order.clone(),
        checkout: r.clone(),
        repo_id: None,
        person: None,
        expires_ms: now + 50 * 60_000,
        margin_ms: 30 * 60_000,
        blocked: false,
    };
    keep(&first.hub, &handed).unwrap();
    let home = first._home;
    drop(first.hub);
    // The new process, on the same home.
    let second = lab_in(home, HubDb::open(&path).unwrap(), clock.clone()).await;
    assert_eq!(kept(&second.hub), std::slice::from_ref(&handed));
    // Not due yet: nothing is asked of GitHub.
    renew(&second.hub).await;
    assert!(second.fake.lock().unwrap().minted.is_empty());
    // Within its margin, the sweep renews it: a new token is minted for the order (its node, not linked in this test,
    // then refuses it, and the record stays to try again).
    clock.advance(Duration::from_secs(25 * 60));
    renew(&second.hub).await;
    assert!(
        second
            .fake
            .lock()
            .unwrap()
            .minted
            .iter()
            .any(|t| t.starts_with("ghs_7_")),
        "no token minted for acme's installation"
    );
    assert_eq!(kept(&second.hub), [handed]);
    // Closed, it is forgotten.
    let records = &second.hub.leads.records;
    let w = records.workstream_get(&order).unwrap().unwrap();
    records
        .workstream_put(&fleetd_contracts::ledger::Workstream {
            state: fleetd_contracts::ledger::WorkstreamState::Done,
            ..w
        })
        .unwrap();
    renew(&second.hub).await;
    assert!(kept(&second.hub).is_empty());
}

#[tokio::test]
async fn removing_the_app_forgets_everyones_connection_through_it() {
    let lab = lab().await;
    created(&lab).await;
    let sam = admin(&lab.hub);
    connect(&lab, &sam).await.unwrap();
    call(&lab.hub, &sam, "github_app_remove", json!({}))
        .await
        .unwrap();
    created(&lab).await;
    let got = call(&lab.hub, &sam, "github_app_get", json!({}))
        .await
        .unwrap();
    assert!(got.get("me").is_none(), "{got}");
}

/// Links a node for devbox that answers every session call, and hands each one to the test.
async fn fake_node(hub: &Arc<Hub>) -> Arc<Mutex<Vec<fleetd_contracts::sessions::SessionCall>>> {
    use fleetd_contracts::node_link::{HubToNode, NodeToHub};
    let devbox = fleetd_contracts::ids::MachineId::unchecked("devbox");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    hub.executors
        .attach(
            &devbox,
            crate::hub::executor::NodeSessions {
                link_id: 1,
                send: tx,
            },
        )
        .await;
    let HubToNode::SessionCall(subscribe) = rx.recv().await.unwrap() else {
        panic!("not a subscribe")
    };
    let frame = |v: Value| {
        hub.executors
            .handle_frame(&devbox, serde_json::from_value::<NodeToHub>(v).unwrap())
    };
    frame(
        json!({ "t": "machine_event", "seq": 1, "at": "2026-10-28T10:00:00.000Z",
        "event": { "type": "snapshot", "projects": [{ "projectId": "shop", "title": "shop",
          "workspaceRoot": "/home/dev/src/shop", "updatedAt": "2026-10-28T10:00:00.000Z" }], "sessions": [] } }),
    );
    frame(
        json!({ "t": "session_reply", "id": subscribe.id, "result": { "ok": { "kind": "done" } } }),
    );
    hub.executors.await_live(&devbox).await;
    let calls: Arc<Mutex<Vec<_>>> = Arc::default();
    let (seen, hub) = (calls.clone(), hub.clone());
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let HubToNode::SessionCall(f) = frame else {
                continue;
            };
            let id = f.id.clone();
            seen.lock().unwrap().push(f.call);
            let reply =
                json!({ "t": "session_reply", "id": id, "result": { "ok": { "kind": "done" } } });
            hub.executors
                .handle_frame(&devbox, serde_json::from_value::<NodeToHub>(reply).unwrap());
        }
    });
    calls
}

/// As a launch leaves it: the order's `GH_TOKEN` held at `checkout`, and its record, `person`'s or the App's.
fn handed(
    hub: &Hub,
    r: &fleetd_contracts::ids::ProjectRef,
    order: &fleetd_contracts::ledger::WorkstreamId,
    person: Option<&PersonId>,
) {
    let row = crate::hub::projects::order_env::OrderEnvRow {
        name: "GH_TOKEN".into(),
        fingerprint: "ab12cd34".into(),
        bytes: 40,
        request_id: "github".into(),
        updated_at: "2026-10-28T10:00:00.000Z".into(),
    };
    hub.db.order_env().save(r, order.as_str(), &row).unwrap();
    super::sessions::keep(
        hub,
        &super::sessions::Kept {
            r: r.clone(),
            order: order.clone(),
            checkout: r.clone(),
            repo_id: None,
            person: person.cloned(),
            expires_ms: 1_792_000_000_000 + 8 * 3600 * 1000,
            margin_ms: 2 * 3600 * 1000,
            blocked: false,
        },
    )
    .unwrap();
}

/// The `GH_TOKEN` drops the node was asked for.
fn drops(
    calls: &Mutex<Vec<fleetd_contracts::sessions::SessionCall>>,
) -> Vec<(String, Option<String>)> {
    calls
        .lock()
        .unwrap()
        .iter()
        .filter_map(|c| match c {
            fleetd_contracts::sessions::SessionCall::OrderEnvDrop {
                order_id,
                name,
                fingerprint,
                ..
            } if name.as_ref().map(|n| n.as_str()) == Some("GH_TOKEN") => Some((
                order_id.to_string(),
                fingerprint.as_ref().map(|f| f.to_string()),
            )),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_repo_the_app_doesnt_reach_gets_no_token_and_loses_one_held_before() {
    let lab = lab().await;
    created(&lab).await;
    let sam = admin(&lab.hub);
    call(&lab.hub, &sam, "github_app_test", json!({}))
        .await
        .unwrap();
    let (r, order) = order_on_acme(&lab.hub, None);
    // The repo moved to an owner the App isn't installed on, since a token was handed there.
    lab.hub
        .db
        .with(|c| {
            c.execute_batch("UPDATE work_projects SET repo_key = 'github.com/stranger/web';")?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        super::sessions::repo_at(&lab.hub, &r, None).map(|(name, checkout)| (name, checkout == r)),
        Some(("stranger/web".to_owned(), true))
    );
    handed(&lab.hub, &r, &order, None);
    let calls = fake_node(&lab.hub).await;
    super::sessions::deliver(&lab.hub, &r, &order, None, true)
        .await
        .unwrap();
    assert_eq!(
        drops(&calls),
        [(order.to_string(), Some("ab12cd34".into()))]
    );
    assert!(super::sessions::kept(&lab.hub).is_empty());
}

#[tokio::test]
async fn the_app_reaches_repositories_past_the_first_hundred_it_keeps() {
    let lab = lab().await;
    created(&lab).await;
    call(&lab.hub, &admin(&lab.hub), "github_app_test", json!({}))
        .await
        .unwrap();
    // As an installation with more chosen repositories than the App keeps for its page: the cache reads them all.
    let mut app = lab.hub.db.github_app().get().unwrap().unwrap();
    app.installations[0].repositories.clear();
    lab.hub.db.github_app().update(&app).unwrap();
    assert!(lab.hub.github_app.reaches("acme/api"));
    assert!(!lab.hub.github_app.reaches("acme/elsewhere"));
}

/// What a node linked for `machine` kept of each `secret_deliver`: its sink, its project, its variable and the value,
/// opened with the box key the test publishes for it. The node takes order variables.
async fn fake_link(
    hub: &Arc<Hub>,
    machine: &str,
) -> Arc<Mutex<Vec<(String, String, String, String)>>> {
    use fleetd_contracts::node_link::{CAP_ORDER_ENV, HubToNode, NodeToHub};
    let m = fleetd_contracts::ids::MachineId::unchecked(machine);
    let secret = crypto_box::SecretKey::generate(&mut crypto_box::aead::OsRng);
    let public = base64::engine::general_purpose::STANDARD.encode(secret.public_key().as_bytes());
    let record = serde_json::from_value(json!({
        "machineId": machine, "name": machine, "tags": [], "status": "online",
        "lastSeenAt": "2026-10-28T10:00:00.000Z", "nodeVersion": "0.1.0", "boxPubKey": public,
    }))
    .unwrap();
    hub.store.machine_upsert(&record, None).unwrap();
    hub.link.set_capabilities(&m, &[CAP_ORDER_ENV]);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let link = hub.node_commands.attach(&m, tx);
    let kept: Arc<Mutex<Vec<_>>> = Arc::default();
    let (seen, hub) = (kept.clone(), hub.clone());
    tokio::spawn(async move {
        let _link = link;
        while let Some(frame) = rx.recv().await {
            let HubToNode::SecretDeliver(d) = frame else {
                continue;
            };
            let sealed = base64::engine::general_purpose::STANDARD
                .decode(d.sealed.as_str())
                .unwrap();
            let plain = String::from_utf8(secret.unseal(&sealed).unwrap()).unwrap();
            seen.lock().unwrap().push((
                d.sink.to_string(),
                d.project_id.map(|p| p.to_string()).unwrap_or_default(),
                d.env_name.map(|n| n.to_string()).unwrap_or_default(),
                plain,
            ));
            let reply = json!({ "t": "secret_result", "id": d.id, "fingerprint": "f00dfeed" });
            hub.node_commands
                .resolve(&m, serde_json::from_value::<NodeToHub>(reply).unwrap());
        }
    });
    kept
}

/// The values a fake link was handed, as `GH_TOKEN`.
fn tokens(link: &Mutex<Vec<(String, String, String, String)>>) -> Vec<String> {
    link.lock()
        .unwrap()
        .iter()
        .filter(|(_, _, name, _)| name == "GH_TOKEN")
        .map(|(_, _, _, value)| value.clone())
        .collect()
}

#[tokio::test]
async fn a_disconnect_blocks_the_persons_orders_never_falling_back_to_the_machines_login() {
    use super::sessions::{BLOCKED_TOKEN, kept, renew};
    let lab = lab().await;
    created(&lab).await;
    let sam = admin(&lab.hub);
    call(&lab.hub, &sam, "github_app_test", json!({}))
        .await
        .unwrap();
    connect(&lab, &sam).await.unwrap();
    let person = sam.person.clone().unwrap().person_id;
    let (r, order) = order_on_acme(&lab.hub, Some(&person));
    let (_, nobody) = order_on_acme(&lab.hub, None);
    let link = fake_link(&lab.hub, "devbox").await;
    let drops_at = fake_node(&lab.hub).await;
    super::sessions::deliver(&lab.hub, &r, &order, None, true)
        .await
        .unwrap();
    super::sessions::deliver(&lab.hub, &r, &nobody, None, true)
        .await
        .unwrap();
    let handed = tokens(&link);
    assert!(
        handed[0].starts_with("ghu_") && handed[1].starts_with("ghs_7_"),
        "{handed:?}"
    );
    call(&lab.hub, &sam, "github_disconnect", json!({}))
        .await
        .unwrap();
    // Sam's agents hold a value GitHub refuses, not nothing: gh fails rather than run as the machine's login.
    assert_eq!(tokens(&link)[2..], [BLOCKED_TOKEN.to_owned()]);
    assert!(
        drops(&drops_at).is_empty(),
        "a person's token was dropped, not blocked"
    );
    let blocked: Vec<_> = kept(&lab.hub)
        .into_iter()
        .map(|k| (k.order, k.blocked))
        .collect();
    assert_eq!(blocked, [(order.clone(), true), (nobody.clone(), false)]);
    // The sweep leaves it so, and a writer for it is refused at launch.
    renew(&lab.hub).await;
    assert_eq!(tokens(&link).len(), 3);
    assert!(
        super::sessions::deliver(&lab.hub, &r, &order, None, true)
            .await
            .is_err()
    );
    // Connected again: the next sweep gives the agents their token back.
    connect(&lab, &sam).await.unwrap();
    renew(&lab.hub).await;
    assert!(tokens(&link)[3].starts_with("ghu_"), "{:?}", tokens(&link));
    assert!(kept(&lab.hub).iter().all(|k| !k.blocked));
}

#[tokio::test]
async fn a_person_removed_from_the_hub_has_their_token_revoked_and_their_orders_blocked() {
    use super::sessions::BLOCKED_TOKEN;
    let lab = lab().await;
    created(&lab).await;
    let sam = admin(&lab.hub);
    call(&lab.hub, &sam, "github_app_test", json!({}))
        .await
        .unwrap();
    let bob = member(&lab.hub);
    connect(&lab, &bob).await.unwrap();
    let person = bob.person.clone().unwrap().person_id;
    let (r, order) = order_on_acme(&lab.hub, Some(&person));
    let link = fake_link(&lab.hub, "devbox").await;
    super::sessions::deliver(&lab.hub, &r, &order, None, true)
        .await
        .unwrap();
    call(
        &lab.hub,
        &sam,
        "person_remove",
        json!({ "personId": person.as_str() }),
    )
    .await
    .unwrap();
    assert_eq!(lab.fake.lock().unwrap().revoked, 1, "not revoked at GitHub");
    assert!(lab.hub.github_app.account(&person).unwrap().is_none());
    assert_eq!(
        tokens(&link).last().map(String::as_str),
        Some(BLOCKED_TOKEN)
    );
}

#[tokio::test]
async fn a_block_a_node_missed_while_offline_comes_with_the_next_sweep() {
    use super::sessions::{BLOCKED_TOKEN, kept, renew};
    let lab = lab().await;
    created(&lab).await;
    let sam = admin(&lab.hub);
    call(&lab.hub, &sam, "github_app_test", json!({}))
        .await
        .unwrap();
    connect(&lab, &sam).await.unwrap();
    let person = sam.person.clone().unwrap().person_id;
    let (r, order) = order_on_acme(&lab.hub, Some(&person));
    handed(&lab.hub, &r, &order, Some(&person));
    // devbox is offline when Sam disconnects: nothing can be blocked yet.
    call(&lab.hub, &sam, "github_disconnect", json!({}))
        .await
        .unwrap();
    assert!(!kept(&lab.hub)[0].blocked);
    let link = fake_link(&lab.hub, "devbox").await;
    renew(&lab.hub).await;
    assert_eq!(tokens(&link), [BLOCKED_TOKEN.to_owned()]);
    assert!(kept(&lab.hub)[0].blocked);
}

#[tokio::test]
async fn a_task_in_another_projects_checkout_gets_the_token_there() {
    let lab = lab().await;
    created(&lab).await;
    call(&lab.hub, &admin(&lab.hub), "github_app_test", json!({}))
        .await
        .unwrap();
    let (r, order) = order_on_acme(&lab.hub, None);
    // acme/api is checked out on buildbox, as project `api`, and the order's project takes it in as a repo.
    let summary: fleetd_contracts::model::ProjectSummary = serde_json::from_value(json!({
        "machineId": "buildbox", "projectId": "api", "title": "api", "workspaceRoot": "/home/dev/src/api",
        "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": "2026-10-28T10:00:00.000Z",
    }))
    .unwrap();
    let buildbox = fleetd_contracts::ids::MachineId::unchecked("buildbox");
    lab.hub
        .store
        .projects_upsert_many(&buildbox, &[summary])
        .unwrap();
    lab.hub
        .db
        .with(|c| {
            c.execute_batch("INSERT INTO work_projects VALUES ('buildbox', 'api', 'github.com/acme/api', 'main', 1);")?;
            Ok(())
        })
        .unwrap();
    let api: fleetd_contracts::ids::ProjectRef =
        serde_json::from_value(json!({ "machineId": "buildbox", "projectId": "api" })).unwrap();
    let repo = lab
        .hub
        .repos
        .attach(&r, None, &api, "/home/dev/src/api")
        .unwrap();
    assert_eq!(
        super::sessions::repo_at(&lab.hub, &r, Some(&repo.repo_id)),
        Some(("acme/api".to_owned(), api.clone()))
    );
    let devbox = fake_link(&lab.hub, "devbox").await;
    let at_buildbox = fake_link(&lab.hub, "buildbox").await;
    super::sessions::deliver(&lab.hub, &r, &order, Some(&repo.repo_id), true)
        .await
        .unwrap();
    // Under buildbox's checkout, where that task's sessions read their order's variables; nothing on devbox.
    let kept = at_buildbox.lock().unwrap().clone();
    assert_eq!(kept.len(), 1);
    assert_eq!(
        (kept[0].0.as_str(), kept[0].1.as_str()),
        (format!("order:buildbox:{order}").as_str(), "api")
    );
    assert!(kept[0].3.starts_with("ghs_7_"));
    assert!(devbox.lock().unwrap().is_empty());
    assert_eq!(super::sessions::kept(&lab.hub)[0].checkout, api);
}

#[tokio::test]
async fn removing_the_app_takes_back_what_it_handed_to_orders() {
    let lab = lab().await;
    created(&lab).await;
    let sam = admin(&lab.hub);
    call(&lab.hub, &sam, "github_app_test", json!({}))
        .await
        .unwrap();
    let (r, order) = order_on_acme(&lab.hub, None);
    handed(&lab.hub, &r, &order, None);
    let calls = fake_node(&lab.hub).await;
    call(&lab.hub, &sam, "github_app_remove", json!({}))
        .await
        .unwrap();
    assert_eq!(
        drops(&calls),
        [(order.to_string(), Some("ab12cd34".into()))]
    );
    assert!(super::sessions::kept(&lab.hub).is_empty());
}
