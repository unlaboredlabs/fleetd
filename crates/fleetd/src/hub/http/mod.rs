//! The hub's HTTP server: /healthz, /mcp, /app and /node/link on one port,
//! loopback by default.
use crate::hub::api::{Hub, Registry};
use crate::hub::{app_ws, mcp};
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use fleetd_contracts::hello::PROTOCOL_VERSION;
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
}

pub fn router(hub: Arc<Hub>, tools: Arc<Registry>) -> Router {
    let mcp = Arc::new(mcp::McpEndpoint::new(&tools));
    Router::new()
        .route("/healthz", get(healthz))
        .route("/mcp", any(mcp_route))
        .route("/app", get(app_route))
        .route("/node/link", get(node_link_route))
        .with_state(Server { hub, tools, mcp })
}

async fn healthz() -> Response {
    axum::Json(serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL_VERSION }))
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
    let mut server = tokio::spawn(async move {
        axum::serve(listener, app)
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
