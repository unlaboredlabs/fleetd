//! `POST /github`: opt-in GitHub webhook deliveries. Only while a secret exists (`github_webhook_set`); the body is
//! verified against `X-Hub-Signature-256`, and a verified delivery only kicks its repo's train.
use std::sync::Arc;

use axum::body::Body;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::hub::api::Hub;
use crate::hub::train::hooks;

/// GitHub caps a delivery at 25 MB; the fields used here sit at the top of far smaller bodies.
pub const MAX_BODY: usize = 5 * 1024 * 1024;

pub async fn handle(hub: Arc<Hub>, headers: HeaderMap, body: Body) -> Response {
    let Some(secret) = hooks::secret(&hub) else {
        return (StatusCode::NOT_FOUND, "GitHub webhooks are off").into_response();
    };
    let Ok(body) = axum::body::to_bytes(body, MAX_BODY).await else {
        return (StatusCode::PAYLOAD_TOO_LARGE, "delivery over 5 MB").into_response();
    };
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    };
    if !hooks::verify(&secret, header("x-hub-signature-256"), &body) {
        return (StatusCode::UNAUTHORIZED, "bad signature").into_response();
    }
    let event = header("x-github-event").to_string();
    let repo = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["repository"]["full_name"].as_str().map(str::to_lowercase));
    if let Some(repo) = repo
        && hub.train.records().train(&repo).is_some()
    {
        hub.train.webhook_delivered(&repo, &event);
    }
    StatusCode::ACCEPTED.into_response()
}
