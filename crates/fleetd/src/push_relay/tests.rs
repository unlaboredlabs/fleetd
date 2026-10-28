//! The relay against fake APNs and FCM: the requests they get (headers, a provider token that verifies, the body
//! with the ciphertext and nothing else), dead tokens answered `dead`, and the abuse limits.
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

const RSA_KEY: &str = include_str!("../node/google/testdata/service-account-test-key.pem");

/// What the fake upstream got: (path, headers, body).
type Seen = Arc<Mutex<Vec<(String, HeaderMap, String)>>>;

/// APNs, FCM and Google's token endpoint in one. APNs: token "gone" is 410, "bad" is 400 BadDeviceToken, "boom" is
/// 500. FCM: token "gone" is 404 UNREGISTERED.
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
                    let gone = body.contains("\"gone\"");
                    record(&seen, format!("/v1/projects/{project}/messages:send"), headers, body);
                    if gone {
                        let details = [json!({ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": "UNREGISTERED" })];
                        (StatusCode::NOT_FOUND, axum::Json(json!({ "error": { "status": "NOT_FOUND", "details": details } })))
                    } else {
                        (StatusCode::OK, axum::Json(json!({ "name": format!("projects/{project}/messages/1") })))
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
    let app = router(Arc::new(Relay::new(Some(apns), Some(fcm))));
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
    let answer = reqwest::Client::new()
        .post(format!("{relay}/v1/push"))
        .json(body)
        .send()
        .await
        .unwrap();
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
        crate::hub::push::post(&http, &relay, &push(PushPlatform::Ios, "aa11")).await,
        Outcome::Sent
    );
    assert_eq!(
        crate::hub::push::post(&http, &relay, &push(PushPlatform::Ios, "gone")).await,
        Outcome::Dead
    );
    assert!(matches!(
        crate::hub::push::post(&http, &relay, &push(PushPlatform::Ios, "boom")).await,
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
