//! `GET /oauth/callback`: where a service sends the person's browser back after they sign in to an MCP server. The
//! hub finishes the sign-in ([`super::finish`]) and answers with a small page saying how it went; the app, watching
//! the server's sign-in, carries on by itself. The page loads nothing and is never cached.
use std::collections::HashMap;
use std::sync::Arc;

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

use super::Finished;
use crate::hub::api::Hub;

pub async fn handle(hub: Arc<Hub>, query: HashMap<String, String>) -> Response {
    let Some(state) = query.get("state").filter(|s| !s.is_empty()) else {
        return page(
            StatusCode::BAD_REQUEST,
            "Sign-in failed",
            "The service sent the browser back without its sign-in state. Start the sign-in again from fleetd.",
        );
    };
    // The service's description, else its error code.
    let error = query.get("error").map(|e| {
        match query
            .get("error_description")
            .filter(|d| !d.trim().is_empty())
        {
            Some(d) => d.trim().to_owned(),
            None => format!("`{e}`"),
        }
    });
    let code = query.get("code").map(String::as_str);
    match super::finish(&hub, state, code, error).await {
        Finished::Connected { name, on_machine } => {
            let rest = if on_machine {
                "Go back to fleetd: it tests the connection and asks which tools its lead may use without asking."
            } else {
                "Its machine is offline: the lead gets it once the machine is back. You can go back to fleetd."
            };
            page(
                StatusCode::OK,
                &format!("Signed in to {name}"),
                &format!("{rest} You can close this tab."),
            )
        }
        Finished::Failed { name, problem } => {
            let title = match name {
                Some(name) => format!("Signing in to {name} failed"),
                None => "Sign-in failed".to_owned(),
            };
            page(StatusCode::BAD_REQUEST, &title, &problem)
        }
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn page(status: StatusCode, title: &str, text: &str) -> Response {
    // Hosts and codes are marked as code for the app; the page shows them plain.
    let (title, text) = (escape(title), escape(&text.replace('`', "")));
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" \
         content=\"width=device-width,initial-scale=1\"><title>{title} · fleetd</title><style>\
         :root{{color-scheme:light dark}}body{{margin:0;min-height:100vh;display:grid;place-items:center;\
         font:15px/1.5 system-ui,-apple-system,sans-serif}}main{{max-width:28rem;padding:2rem}}\
         h1{{font-size:1.15rem;margin:0 0 .5rem}}p{{margin:0;opacity:.75}}</style></head>\
         <body><main><h1>{title}</h1><p>{text}</p></main></body></html>"
    );
    let mut response = (status, html).into_response();
    let headers = response.headers_mut();
    for (name, value) in [
        (header::CONTENT_TYPE, "text/html; charset=utf-8"),
        (header::CACHE_CONTROL, "no-store"),
        (header::REFERRER_POLICY, "no-referrer"),
        (
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; style-src 'unsafe-inline'",
        ),
        (header::X_FRAME_OPTIONS, "DENY"),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
    response
}
