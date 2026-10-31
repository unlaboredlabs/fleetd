//! The hub's HTTP server: /healthz, /mcp, /app, /pair, /node/link, session relays, automations' /hooks and hub links'
//! /link/v1 on one port, loopback by default.
use crate::hub::api::{Hub, Registry};
use crate::hub::{app_ws, mcp, pair};

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use fleetd_contracts::hello::PROTOCOL_VERSION;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;

/// Node links, /app sessions and events_wait long-polls never end on their own, so after a stop is asked for they
/// get this long before the server returns anyway (writes retry by clientRequestId).
pub const SHUTDOWN_GRACE: Duration = Duration::from_millis(800);

#[derive(Clone)]
struct Server {
    hub: Arc<Hub>,
    tools: Arc<Registry>,
    mcp: Arc<mcp::McpEndpoint>,
    pair_limiter: Arc<pair::Limiter>,
}

pub fn router(hub: Arc<Hub>, tools: Arc<Registry>) -> Router {
    let mcp = Arc::new(mcp::McpEndpoint::new(&tools));
    Router::new()
        .route("/healthz", get(healthz))
        .route("/mcp", any(mcp_route))
        .route("/app", get(app_route))
        .route("/pair", post(pair_route))
        .route("/node/link", get(node_link_route))
        .route("/relay/{token}", get(relay_route))
        .route("/hooks/{automation_id}/{secret}", post(hook_route))
        .route("/link/v1/{op}", any(hub_link_route))
        .with_state(Server {
            hub,
            tools,
            mcp,
            pair_limiter: Arc::default(),
        })
}

async fn healthz() -> Response {
    axum::Json(serde_json::json!({ "ok": true, "version": crate::version(), "protocol": PROTOCOL_VERSION }))
        .into_response()
}

async fn mcp_route(
    State(server): State<Server>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    mcp::handle(
        &server.hub,
        &server.tools,
        &server.mcp,
        method,
        headers,
        body,
    )
    .await
}

async fn pair_route(State(server): State<Server>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let remote = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip());
    let host = parts
        .headers
        .get(axum::http::header::HOST)
        .and_then(|h| h.to_str().ok());
    let Ok(body) = axum::body::to_bytes(body, 16 * 1024).await else {
        return (StatusCode::PAYLOAD_TOO_LARGE, "pairing request too large").into_response();
    };
    let (status, json) = pair::handle(&server.hub, &server.pair_limiter, remote, host, &body);
    (status, axum::Json(json)).into_response()
}

async fn hook_route(
    State(server): State<Server>,
    Path((automation_id, secret)): Path<(String, String)>,
    request: Request,
) -> Response {
    crate::hub::automations::webhook::handle(
        server.hub,
        &automation_id,
        &secret,
        request.into_body(),
    )
    .await
}

async fn hub_link_route(
    State(server): State<Server>,
    Path(op): Path<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    crate::hub::hub_links::serve::handle(server.hub, &op, method, &headers, &query, &body).await
}

fn expect_upgrade() -> Response {
    (StatusCode::UPGRADE_REQUIRED, "Expected a WebSocket upgrade").into_response()
}

async fn app_route(
    State(server): State<Server>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Ok(upgrade) = upgrade else {
        return expect_upgrade();
    };
    upgrade.on_upgrade(move |socket| app_ws::handle(server.hub, server.tools, socket))
}

async fn relay_route(
    State(server): State<Server>,
    Path(token): Path<String>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Ok(upgrade) = upgrade else {
        return expect_upgrade();
    };
    crate::hub::machine_roles::relay::route(server.hub, token, upgrade).await
}

async fn node_link_route(
    State(server): State<Server>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Ok(upgrade) = upgrade else {
        return expect_upgrade();
    };
    upgrade.on_upgrade(move |socket| crate::hub::link::handle(server.hub, socket))
}

/// Serves until `hub.shutdown` fires, then gives open connections [`SHUTDOWN_GRACE`] before returning.
pub async fn serve(
    listener: TcpListener,
    hub: Arc<Hub>,
    tools: Arc<Registry>,
) -> std::io::Result<()> {
    let shutdown = hub.shutdown.clone();
    let app = router(hub, tools);
    let stop = shutdown.clone();
    // Nagle off, as on the node's end of its link: small frames that answer each other (a screen's start, its control,
    // its first frame; the app's calls) would each wait out a delayed ack.
    let listener = axum::serve::ListenerExt::tap_io(listener, |tcp| {
        let _ = tcp.set_nodelay(true);
    });
    let mut server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move { stop.wait().await })
        .await
    });
    let joined = |r: Result<std::io::Result<()>, tokio::task::JoinError>| {
        r.unwrap_or_else(|e| Err(std::io::Error::other(e)))
    };
    tokio::select! {
        result = &mut server => return joined(result),
        () = shutdown.wait() => {}
    }
    match tokio::time::timeout(SHUTDOWN_GRACE, &mut server).await {
        Ok(result) => joined(result),
        Err(_) => {
            server.abort();
            Ok(())
        }
    }
}
