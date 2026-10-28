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
    let clock = ManualClock::at(1_792_000_000_000);
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: Some("http://devbox.example.ts.net:4790".into()),
        queue_ttl_sec: None,
    };
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
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
}
