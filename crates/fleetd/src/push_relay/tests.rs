//! The relay against fake APNs and FCM: the requests they get (headers, a provider token that verifies, the body
//! with the ciphertext and nothing else), dead tokens answered `dead`, a relay set up wrong answered `failed` rather
//! than `dead`, the relay's key, and the abuse limits.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ring::signature::{
    ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair,
};
use serde_json::{Value, json};

use super::*;
use crate::hub::push::Outcome;

const RSA_KEY: &str = include_str!("testdata/service-account-test-key.pem");

/// What the fake upstream got: (path, headers, body).
type Seen = Arc<Mutex<Vec<(String, HeaderMap, String)>>>;

/// APNs, FCM and Google's token endpoint in one. APNs: token "gone" is 410, "bad" is 400 BadDeviceToken, "notopic"
/// 400 DeviceTokenNotForTopic, "badtopic" 400 BadTopic, "badjwt" 403 InvalidProviderToken, "boom" 500. FCM: token
/// "gone" is 404 UNREGISTERED, "mismatch" 403 SENDER_ID_MISMATCH, "denied" 403 PERMISSION_DENIED, "nf" a bare 404.
async fn upstream() -> (Seen, String) {
    let seen: Seen = Arc::default();
    let record = |seen: &Seen, path: String, headers: HeaderMap, body: String| {
        seen.lock().unwrap().push((path, headers, body));
    };
    let app = axum::Router::new()
        .route(
            "/3/device/{token}",
            post(
                move |State(seen): State<Seen>, Path(token): Path<String>, headers: HeaderMap, body: String| async move {
                    record(&seen, format!("/3/device/{token}"), headers, body);
                    match token.as_str() {
                        "gone" => (StatusCode::GONE, axum::Json(json!({ "reason": "Unregistered" }))),
                        "bad" => (StatusCode::BAD_REQUEST, axum::Json(json!({ "reason": "BadDeviceToken" }))),
                        "notopic" => (StatusCode::BAD_REQUEST, axum::Json(json!({ "reason": "DeviceTokenNotForTopic" }))),
                        "badtopic" => (StatusCode::BAD_REQUEST, axum::Json(json!({ "reason": "BadTopic" }))),
                        "badjwt" => (StatusCode::FORBIDDEN, axum::Json(json!({ "reason": "InvalidProviderToken" }))),
                        "boom" => (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(json!({ "reason": "InternalServerError" }))),
                        _ => (StatusCode::OK, axum::Json(json!({}))),
                    }
                },
            ),
        )
        .route(
            "/token",
            post(move |State(seen): State<Seen>, headers: HeaderMap, body: String| async move {
                record(&seen, "/token".into(), headers, body);
                axum::Json(json!({ "access_token": "fake-access", "expires_in": 3599, "token_type": "Bearer" }))
            }),
        )
        .route(
            "/v1/projects/{project}/messages:send",
            post(
                move |State(seen): State<Seen>, Path(project): Path<String>, headers: HeaderMap, body: String| async move {
                    let token = serde_json::from_str::<Value>(&body).unwrap()["message"]["token"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    record(&seen, format!("/v1/projects/{project}/messages:send"), headers, body);
                    let error = |status: StatusCode, state: &str, code: Option<&str>| {
                        let details: Vec<Value> = code
                            .map(|c| json!({ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": c }))
                            .into_iter()
                            .collect();
                        (status, axum::Json(json!({ "error": { "status": state, "details": details } })))
                    };
                    match token.as_str() {
                        "gone" => error(StatusCode::NOT_FOUND, "NOT_FOUND", Some("UNREGISTERED")),
                        "mismatch" => error(StatusCode::FORBIDDEN, "PERMISSION_DENIED", Some("SENDER_ID_MISMATCH")),
                        "denied" => error(StatusCode::FORBIDDEN, "PERMISSION_DENIED", None),
                        "nf" => error(StatusCode::NOT_FOUND, "NOT_FOUND", None),
                        _ => (StatusCode::OK, axum::Json(json!({ "name": format!("projects/{project}/messages/1") }))),
                    }
                },
            ),
        )
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (seen, url)
}

/// A P-256 key as Apple's .p8, and its public key.
fn p8() -> (String, Vec<u8>) {
    let rng = ring::rand::SystemRandom::new();
    let der = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
    let public = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, der.as_ref(), &rng)
        .unwrap()
        .public_key()
        .as_ref()
        .to_vec();
    let pem = format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
        STANDARD.encode(der.as_ref())
    );
    (pem, public)
}

/// A relay with both platforms pointed at `upstream`, served; its URL and the APNs public key.
async fn relay(upstream: &str) -> (String, Vec<u8>) {
    relay_keyed(upstream, None).await
}

/// [`relay`], taking only requests with `key` when given.
async fn relay_keyed(upstream: &str, key: Option<&str>) -> (String, Vec<u8>) {
    let (pem, public) = p8();
    let apns =
        apns::Apns::new(&pem, "KEY1234567", "TEAM123456", "dev.fleetd.app", upstream).unwrap();
    let account = json!({
        "type": "service_account", "project_id": "acme-push", "private_key": RSA_KEY,
        "client_email": "relay@acme-push.iam.gserviceaccount.com", "token_uri": format!("{upstream}/token"),
    });
    let fcm = fcm::Fcm::new(&account.to_string(), upstream).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let mut served = Relay::new(Some(apns), Some(fcm));
    served.key = key.map(|k| zeroize::Zeroizing::new(k.to_owned()));
    let app = router(Arc::new(served)).into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await });
    (url, public)
}

fn push(platform: PushPlatform, token: &str) -> RelayPush {
    RelayPush {
        platform,
        token: token.into(),
        ciphertext: STANDARD.encode([7u8; 120]),
        collapse_key: Some("0123456789abcdef".into()),
    }
}

async fn send(relay: &str, body: &Value) -> (u16, Value) {
    send_keyed(relay, None, body).await
}

async fn send_keyed(relay: &str, key: Option<&str>, body: &Value) -> (u16, Value) {
    let mut request = reqwest::Client::new()
        .post(format!("{relay}/v1/push"))
        .json(body);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let answer = request.send().await.unwrap();
    (
        answer.status().as_u16(),
        answer.json().await.unwrap_or_default(),
    )
}

#[tokio::test]
async fn apns_gets_a_mutable_alert_with_the_ciphertext_and_a_provider_token_that_verifies() {
    let (seen, up) = upstream().await;
    let (relay, public) = relay(&up).await;
    let p = push(PushPlatform::Ios, "aa11");
    assert_eq!(
        send(&relay, &json!(p)).await,
        (200, json!({ "status": "sent" }))
    );

    let (path, headers, body) = seen.lock().unwrap()[0].clone();
    assert_eq!(path, "/3/device/aa11");
    let header = |k: &str| headers.get(k).unwrap().to_str().unwrap().to_owned();
    assert_eq!(header("apns-topic"), "dev.fleetd.app");
    assert_eq!(header("apns-push-type"), "alert");
    assert_eq!(header("apns-priority"), "10");
    assert_eq!(header("apns-collapse-id"), "0123456789abcdef");
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        body,
        json!({
            "aps": { "alert": { "title": "fleetd", "body": "New activity" }, "mutable-content": 1, "sound": "default" },
            "c": p.ciphertext,
        })
    );
    // The provider token: ES256 over the header and claims, by the .p8's key.
    let jwt = header("authorization")
        .strip_prefix("Bearer ")
        .unwrap()
        .to_owned();
    let parts: Vec<&str> = jwt.split('.').collect();
    let decoded = |i: usize| -> Value {
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[i]).unwrap()).unwrap()
    };
    assert_eq!(decoded(0), json!({ "alg": "ES256", "kid": "KEY1234567" }));
    assert_eq!(decoded(1)["iss"], "TEAM123456");
    ring::signature::UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &public)
        .verify(
            format!("{}.{}", parts[0], parts[1]).as_bytes(),
            &URL_SAFE_NO_PAD.decode(parts[2]).unwrap(),
        )
        .expect("the provider token verifies");

    // A token APNs no longer knows is dead; its other failures are the relay's 502.
    assert_eq!(
        send(&relay, &json!(push(PushPlatform::Ios, "gone")))
            .await
            .1,
        json!({ "status": "dead" })
    );
    assert_eq!(
        send(&relay, &json!(push(PushPlatform::Ios, "bad"))).await.1["status"],
        "dead"
    );
    let (status, failed) = send(&relay, &json!(push(PushPlatform::Ios, "boom"))).await;
    assert_eq!((status, failed["status"].as_str()), (502, Some("failed")));
    // One provider token for all of them.
    let tokens: Vec<String> = seen
        .lock()
        .unwrap()
        .iter()
        .map(|(_, h, _)| h["authorization"].to_str().unwrap().to_owned())
        .collect();
    assert!(tokens.iter().all(|t| *t == tokens[0]));

    // And the hub reads the relay's answers.
    let http = reqwest::Client::new();
    assert_eq!(
        crate::hub::push::post(&http, &relay, None, &push(PushPlatform::Ios, "aa11")).await,
        Outcome::Sent
    );
    assert_eq!(
        crate::hub::push::post(&http, &relay, None, &push(PushPlatform::Ios, "gone")).await,
        Outcome::Dead
    );
    assert!(matches!(
        crate::hub::push::post(&http, &relay, None, &push(PushPlatform::Ios, "boom")).await,
        Outcome::Failed(_)
    ));
}

#[tokio::test]
async fn fcm_gets_a_data_message_with_a_service_account_token_traded_once() {
    let (seen, up) = upstream().await;
    let (relay, _) = relay(&up).await;
    let p = push(PushPlatform::Android, "fcm-token:APA91b_x");
    assert_eq!(send(&relay, &json!(p)).await.1, json!({ "status": "sent" }));
    assert_eq!(send(&relay, &json!(p)).await.1, json!({ "status": "sent" }));

    let seen_now = seen.lock().unwrap().clone();
    let paths: Vec<&str> = seen_now.iter().map(|(p, _, _)| p.as_str()).collect();
    assert_eq!(
        paths,
        [
            "/token",
            "/v1/projects/acme-push/messages:send",
            "/v1/projects/acme-push/messages:send"
        ]
    );
    let form = &seen_now[0].2;
    assert!(form.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer"));
    assert!(form.contains("assertion="));
    let (_, headers, body) = &seen_now[1];
    assert_eq!(headers["authorization"], "Bearer fake-access");
    let body: Value = serde_json::from_str(body).unwrap();
    assert_eq!(
        body,
        json!({ "message": {
            "token": "fcm-token:APA91b_x", "data": { "c": p.ciphertext },
            "android": { "priority": "high", "collapse_key": "0123456789abcdef" },
        } })
    );
    assert_eq!(
        send(&relay, &json!(push(PushPlatform::Android, "gone")))
            .await
            .1,
        json!({ "status": "dead" })
    );
}

#[tokio::test]
async fn the_relay_refuses_what_is_too_big_malformed_too_frequent_or_unconfigured() {
    let (_, up) = upstream().await;
    let (relay, _) = relay(&up).await;
    let mut big = push(PushPlatform::Ios, "aa11");
    big.ciphertext = "A".repeat(CIPHERTEXT_MAX + 1);
    assert_eq!(send(&relay, &json!(big)).await.0, 413);
    big.ciphertext = "A".repeat(20_000);
    assert_eq!(send(&relay, &json!(big)).await.0, 413);
    assert_eq!(
        send(&relay, &json!(push(PushPlatform::Ios, "../x")))
            .await
            .0,
        400
    );
    let mut not_b64 = push(PushPlatform::Ios, "aa11");
    not_b64.ciphertext = "<plain text>".into();
    assert_eq!(send(&relay, &json!(not_b64)).await.0, 400);
    assert_eq!(send(&relay, &json!({ "hello": 1 })).await.0, 400);

    // Per token, a minute's pushes at most.
    let limits = Relay::new(None, None);
    let t0 = Instant::now();
    assert!((0..PER_TOKEN_PER_MIN).all(|_| limits.allow("aa11", t0)));
    assert!(!limits.allow("aa11", t0));
    assert!(limits.allow("bb22", t0));
    assert!(limits.allow("aa11", t0 + Duration::from_secs(61)));
    // Per source address too, whatever the tokens.
    let ip: std::net::IpAddr = "203.0.113.7".parse().unwrap();
    assert!((0..PER_SOURCE_PER_MIN).all(|_| limits.allow_source(ip, t0)));
    assert!(!limits.allow_source(ip, t0));
    assert!(limits.allow_source("203.0.113.8".parse().unwrap(), t0));
    assert!(limits.allow_source(ip, t0 + Duration::from_secs(61)));

    // A platform the relay has no credentials for.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bare = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(
        async move { axum::serve(listener, router(Arc::new(Relay::new(None, None)))).await },
    );
    assert_eq!(
        send(&bare, &json!(push(PushPlatform::Android, "aa11")))
            .await
            .0,
        503
    );
    let health: Value = reqwest::get(format!("{bare}/"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health, json!({ "ok": true, "apns": false, "fcm": false }));
}

#[tokio::test]
async fn a_relay_set_up_wrong_fails_its_pushes_rather_than_calling_every_token_dead() {
    let (_, up) = upstream().await;
    let (relay, _) = relay(&up).await;
    let answer = |token: &'static str, platform: PushPlatform| {
        let relay = relay.clone();
        async move { send(&relay, &json!(push(platform, token))).await }
    };
    let failed_with = |(status, body): (u16, Value), words: &str| {
        assert_eq!(
            (status, body["status"].as_str()),
            (502, Some("failed")),
            "{body}"
        );
        let error = body["error"].as_str().unwrap();
        assert!(error.contains(words), "{error}");
    };

    // Before any push has gone through, a token APNs calls bad may be the relay's environment or bundle id.
    failed_with(
        answer("bad", PushPlatform::Ios).await,
        "FLEETD_APNS_SANDBOX",
    );
    failed_with(
        answer("notopic", PushPlatform::Ios).await,
        "FLEETD_APNS_TOPIC",
    );
    failed_with(
        answer("badtopic", PushPlatform::Ios).await,
        "FLEETD_APNS_TOPIC",
    );
    failed_with(
        answer("badjwt", PushPlatform::Ios).await,
        "FLEETD_APNS_KEY_ID",
    );
    // 410 is that token alone, always.
    assert_eq!(
        answer("gone", PushPlatform::Ios).await.1,
        json!({ "status": "dead" })
    );
    // Once one has gone through, the setup is right and a bad token is the token's.
    assert_eq!(
        answer("aa11", PushPlatform::Ios).await.1,
        json!({ "status": "sent" })
    );
    assert_eq!(
        answer("bad", PushPlatform::Ios).await.1,
        json!({ "status": "dead" })
    );
    assert_eq!(
        answer("notopic", PushPlatform::Ios).await.1,
        json!({ "status": "dead" })
    );
    failed_with(
        answer("badtopic", PushPlatform::Ios).await,
        "FLEETD_APNS_TOPIC",
    );

    // FCM: only UNREGISTERED is the token's.
    failed_with(
        answer("mismatch", PushPlatform::Android).await,
        "SENDER_ID_MISMATCH",
    );
    failed_with(
        answer("denied", PushPlatform::Android).await,
        "service account",
    );
    failed_with(answer("nf", PushPlatform::Android).await, "404");
    assert_eq!(
        answer("gone", PushPlatform::Android).await.1,
        json!({ "status": "dead" })
    );
}

#[tokio::test]
async fn a_relay_with_a_key_takes_only_hubs_that_send_it() {
    let (seen, up) = upstream().await;
    let (relay, _) = relay_keyed(&up, Some("relay-key-1")).await;
    let p = json!(push(PushPlatform::Ios, "aa11"));
    let (status, refused) = send(&relay, &p).await;
    assert_eq!((status, refused["status"].as_str()), (401, Some("failed")));
    assert!(
        refused["error"]
            .as_str()
            .unwrap()
            .contains("--relay-key-file")
    );
    assert_eq!(send_keyed(&relay, Some("relay-key-2"), &p).await.0, 401);
    assert!(seen.lock().unwrap().is_empty(), "nothing reached APNs");
    assert_eq!(
        send_keyed(&relay, Some("relay-key-1"), &p).await,
        (200, json!({ "status": "sent" }))
    );

    // The hub sends its key as a bearer token.
    let http = reqwest::Client::new();
    let ios = push(PushPlatform::Ios, "aa11");
    assert_eq!(
        crate::hub::push::post(&http, &relay, Some("relay-key-1"), &ios).await,
        Outcome::Sent
    );
    assert!(matches!(
        crate::hub::push::post(&http, &relay, None, &ios).await,
        Outcome::Failed(why) if why.starts_with("401")
    ));
}

#[test]
fn a_push_comes_from_its_peer_or_from_what_a_proxy_on_this_machine_says() {
    let forwarded = |v: &str| {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-for", v.parse().unwrap());
        h
    };
    let ip = |s: &str| s.parse::<std::net::IpAddr>().unwrap();
    let remote: SocketAddr = "198.51.100.4:5000".parse().unwrap();
    let local: SocketAddr = "127.0.0.1:5000".parse().unwrap();
    // A client far away can't name its own address.
    assert_eq!(
        source(Some(remote), &forwarded("203.0.113.7")),
        ip("198.51.100.4")
    );
    // Behind Caddy on this machine: the entry Caddy added, the last one, not what the client sent before it.
    assert_eq!(
        source(Some(local), &forwarded("203.0.113.7")),
        ip("203.0.113.7")
    );
    assert_eq!(
        source(Some(local), &forwarded("10.0.0.1, 203.0.113.7")),
        ip("203.0.113.7")
    );
    assert_eq!(
        source(Some(local), &forwarded("not an ip")),
        ip("127.0.0.1")
    );
    assert_eq!(source(Some(local), &HeaderMap::new()), ip("127.0.0.1"));
    assert_eq!(source(None, &forwarded("203.0.113.7")), ip("0.0.0.0"));
}

#[tokio::test]
async fn a_source_over_its_minute_is_refused_whatever_tokens_it_names() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay = format!("http://{}", listener.local_addr().unwrap());
    let app = router(Arc::new(Relay::new(None, None).with_source_limit(2)))
        .into_make_service_with_connect_info::<SocketAddr>();
    tokio::spawn(async move { axum::serve(listener, app).await });
    let from = |ip: &'static str, token: &'static str| {
        let relay = relay.clone();
        async move {
            reqwest::Client::new()
                .post(format!("{relay}/v1/push"))
                .header("x-forwarded-for", ip)
                .json(&push(PushPlatform::Ios, token))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        }
    };
    // No APNs credentials: a push let through answers 503.
    assert_eq!(from("203.0.113.7", "aa11").await, 503);
    assert_eq!(from("203.0.113.7", "bb22").await, 503);
    assert_eq!(from("203.0.113.7", "cc33").await, 429);
    assert_eq!(from("203.0.113.8", "cc33").await, 503);
}
