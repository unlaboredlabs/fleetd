//! `POST /hooks/<automationId>/<secret>`: a webhook run, with the request body as its context. An unknown automation
//! and a wrong secret get the same 401, and neither is logged or recorded: the URL holds the secret, so nothing here
//! writes the path, the secret or the body anywhere but the run it starts.
use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use fleetd_contracts::automations::{AutomationRunState, WEBHOOK_BODY_MAX};
use serde_json::json;

use super::Start;
use crate::hub::api::Hub;

fn refused(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": error }))).into_response()
}

pub async fn handle(hub: Arc<Hub>, automation_id: &str, secret: &str, body: Body) -> Response {
    let target = match hub.automations.webhook_target(automation_id, secret) {
        Ok(target) => target,
        Err(_) => {
            return refused(
                StatusCode::INTERNAL_SERVER_ERROR,
                "The hub failed to answer.",
            );
        }
    };
    let Some(automation) = target else {
        return refused(StatusCode::UNAUTHORIZED, "This webhook URL is not valid.");
    };
    let Ok(bytes) = axum::body::to_bytes(body, WEBHOOK_BODY_MAX).await else {
        return refused(
            StatusCode::PAYLOAD_TOO_LARGE,
            &format!("The body is over {WEBHOOK_BODY_MAX} bytes."),
        );
    };
    let payload = String::from_utf8_lossy(&bytes).into_owned();
    let opened = hub.automations.open(
        automation.automation_id.as_str(),
        Start::Webhook { payload },
    );
    let (automation, run) = match opened {
        Ok(opened) => opened,
        Err(e) => return refused(StatusCode::INTERNAL_SERVER_ERROR, &e.message),
    };
    let status = match run.state {
        AutomationRunState::Running => StatusCode::ACCEPTED,
        AutomationRunState::Failed => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::OK,
    };
    let answer = json!({
        "ok": run.state != AutomationRunState::Failed,
        "runId": run.run_id,
        "state": run.state,
        "workstreamId": run.workstream_id,
        "why": run.why,
    });
    // The caller gets its answer now; a lead that has to start takes as long as it takes.
    let automations = Arc::clone(&hub.automations);
    tokio::spawn(async move { automations.wake_lead(&automation, &run).await });
    (status, Json(answer)).into_response()
}
