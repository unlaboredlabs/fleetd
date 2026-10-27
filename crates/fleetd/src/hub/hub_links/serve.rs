//! `/link/v1/<op>`: what a link minted here may do, with its key as `Authorization: Bearer flk_…`. Nothing else on the
//! hub takes a link key, and nothing here administers anything.
//!
//! - `GET hello`: the link's label, its person, the projects it reaches (and whether it is limited to them), and the
//!   feed's start.
//! - `POST ask` (`LinkAskCall`): `project_message` as the link's person, "<person> via <label> Navi".
//! - `GET status?project=`: `factory_status` over the projects it reaches, with its own asks.
//! - `GET feed?after=&wait=`: what happened to its asks after `after`, waiting up to `wait` seconds for some.
//! - `POST revoke`: the link revokes itself, when the hub with the Navi removes it.
//!
//! A refusal is an `McpToolError` as JSON: 401 with `dead: true` (`LinkRefusal`) when the link is dead for good
//! (unknown, revoked, expired, or its person removed), else 403, 404, 400 or 500 by its code.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use fleetd_contracts::hub_links::{
    FEED_WAIT_MAX_SEC, HubLabel, LinkAskCall, LinkAskResult, LinkFeed, LinkHello, LinkProject,
    LinkRefusal,
};
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::navi::{FactoryStatusCall, ProjectMessageCall};
use serde::Serialize;

use super::{Issued, failed, verify};
use crate::hub::api::Hub;
use crate::hub::navi::bridge::{self, Asker};

fn status_of(code: ErrorCode) -> StatusCode {
    match code {
        ErrorCode::Forbidden => StatusCode::FORBIDDEN,
        ErrorCode::NotFound => StatusCode::NOT_FOUND,
        ErrorCode::Invalid => StatusCode::BAD_REQUEST,
        ErrorCode::MachineOffline => StatusCode::SERVICE_UNAVAILABLE,
        ErrorCode::Failed => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn refused(status: StatusCode, e: &McpToolError) -> Response {
    (status, axum::Json(e)).into_response()
}

/// A refusal of the key itself: 401 with `dead` for a link dead for good, else (a store failure) its own status, so
/// the other hub never takes a passing failure for a revoke.
fn key_refused(e: McpToolError) -> Response {
    if e.code != ErrorCode::Forbidden {
        return refused(status_of(e.code), &e);
    }
    let body = LinkRefusal {
        error: e,
        dead: Some(true),
    };
    (StatusCode::UNAUTHORIZED, axum::Json(body)).into_response()
}

fn ok<T: Serialize>(out: &T) -> Response {
    axum::Json(out).into_response()
}

pub async fn handle(
    hub: Arc<Hub>,
    op: &str,
    method: Method,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
    body: &Bytes,
) -> Response {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let link = match verify(&hub, bearer) {
        Ok(link) => link,
        Err(e) => return key_refused(e),
    };
    let out = match (&method, op) {
        (&Method::GET, "hello") => hello(&hub, &link).map(|o| ok(&o)),
        (&Method::POST, "ask") => ask(&hub, link, body).await.map(|o| ok(&o)),
        (&Method::GET, "status") => status(&hub, link, query).map(|o| ok(&o)),
        (&Method::GET, "feed") => feed(&hub, &link, query, bearer).await,
        (&Method::POST, "revoke") => super::revoke_issued(&hub, &link.link_id)
            .map(|_| ok(&serde_json::json!({})))
            .map_err(failed),
        _ => Err(McpToolError::new(
            ErrorCode::NotFound,
            format!("No {method} /link/v1/{op} on this hub."),
        )),
    };
    out.unwrap_or_else(|e| refused(status_of(e.code), &e))
}

fn hello(hub: &Hub, link: &Issued) -> Result<LinkHello, McpToolError> {
    let asker = Asker::Link(Box::new(link.clone()));
    let all = bridge::factory_status(hub, &asker, &FactoryStatusCall::default())?;
    Ok(LinkHello {
        label: HubLabel::unchecked(link.label.clone()),
        projects: all
            .projects
            .into_iter()
            .map(|p| LinkProject {
                project_ref: p.project_ref,
                title: p.title,
            })
            .collect(),
        cursor: hub.events.head(),
        who: Some(link.who.clone()),
        limited: Some(link.projects.is_some()),
    })
}

async fn ask(hub: &Arc<Hub>, link: Issued, body: &Bytes) -> Result<LinkAskResult, McpToolError> {
    let call: LinkAskCall = serde_json::from_slice(body)
        .map_err(|e| McpToolError::new(ErrorCode::Invalid, format!("Not an ask: {e}.")))?;
    let out = bridge::project_message(
        hub,
        &Asker::Link(Box::new(link)),
        ProjectMessageCall {
            project: call.project,
            text: call.text,
            hub: None,
        },
    )
    .await?;
    Ok(LinkAskResult {
        handle: out.handle,
        project_ref: out.project_ref,
        title: out.title,
        lead_waiting: out.lead_waiting,
    })
}

fn status(
    hub: &Hub,
    link: Issued,
    query: &HashMap<String, String>,
) -> Result<fleetd_contracts::navi::FactoryStatusResult, McpToolError> {
    let project = match query.get("project") {
        Some(p) => Some(
            p.as_str()
                .try_into()
                .map_err(|e: String| McpToolError::new(ErrorCode::Invalid, e))?,
        ),
        None => None,
    };
    bridge::factory_status(
        hub,
        &Asker::Link(Box::new(link)),
        &FactoryStatusCall { project, hub: None },
    )
}

/// One feed read: at once when there is news, else when some comes, the wait ends or the hub stops. A revoke while
/// it waits ends it with the refusal.
async fn feed(
    hub: &Hub,
    link: &Issued,
    query: &HashMap<String, String>,
    bearer: &str,
) -> Result<Response, McpToolError> {
    let number = |name: &str| -> Result<Option<i64>, McpToolError> {
        query
            .get(name)
            .map(|v| {
                v.parse::<i64>().map_err(|_| {
                    McpToolError::new(ErrorCode::Invalid, format!("{name} is not a number."))
                })
            })
            .transpose()
    };
    let mut after = number("after")?.unwrap_or_else(|| hub.events.head());
    let wait = number("wait")?
        .unwrap_or(0)
        .clamp(0, FEED_WAIT_MAX_SEC as i64);
    let until = tokio::time::Instant::now() + Duration::from_secs(wait as u64);
    let mut head = hub.events.subscribe();
    loop {
        head.borrow_and_update();
        let (cursor, more, items) = bridge::feed(hub, &link.link_id, after).map_err(failed)?;
        after = cursor;
        if !items.is_empty() || more || tokio::time::Instant::now() >= until {
            return Ok(ok(&LinkFeed {
                cursor,
                more,
                items,
            }));
        }
        tokio::select! {
            () = hub.shutdown.wait() => {}
            _ = tokio::time::sleep_until(until) => {}
            _ = head.changed() => {}
        }
        if let Err(e) = verify(hub, bearer) {
            return Ok(key_refused(e));
        }
        if hub.shutdown.is_triggered() {
            return Ok(ok(&LinkFeed {
                cursor: after,
                more: false,
                items: Vec::new(),
            }));
        }
    }
}
