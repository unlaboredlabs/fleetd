//! The approvals area's ports over the real hub: the node link's secret and gated-run commands, and the lead's wake
//! with a request's outcome.
use super::ports::{self, BoxFut};
use super::wire::{OpsPorts, convert};
use crate::hub::approvals::{
    ApprovalHub, ApprovalNodes, GatedOutcome, NodeCommandError, SecretOutcome, shown_argv,
};
use crate::hub::link::commands::NodeCommandErrorReason;
use crate::hub::usage::time::clip;
use fleetd_contracts::ledger::{HumanRequest, RequestState};
use serde::de::DeserializeOwned;
use serde_json::Value;

fn node_error(e: crate::hub::link::commands::NodeCommandError) -> NodeCommandError {
    NodeCommandError {
        reason: match e.reason {
            NodeCommandErrorReason::Offline => "offline",
            NodeCommandErrorReason::Lost => "lost",
            NodeCommandErrorReason::NoReply => "no_reply",
            NodeCommandErrorReason::Invalid => "invalid",
        }
        .into(),
        message: e.message,
        fix: None,
    }
}

/// A node frame from the approvals area's JSON; `id` is replaced by NodeCommands, so any placeholder does.
fn frame<T: DeserializeOwned>(mut input: Value) -> Result<T, NodeCommandError> {
    input["id"] = Value::String("pending".into());
    serde_json::from_value(input).map_err(|e| NodeCommandError {
        reason: "invalid".into(),
        message: e.to_string(),
        fix: None,
    })
}

fn machine_id(m: &str) -> Result<fleetd_contracts::ids::MachineId, NodeCommandError> {
    convert(&m).ok_or_else(|| NodeCommandError {
        reason: "invalid".into(),
        message: format!("{m} is not a machine id"),
        fix: None,
    })
}

impl ApprovalNodes for OpsPorts {
    fn deliver_secret(
        &self,
        m: &str,
        input: Value,
    ) -> BoxFut<'_, Result<SecretOutcome, NodeCommandError>> {
        let m = m.to_owned();
        Box::pin(async move {
            let (m, input) = (machine_id(&m)?, frame(input)?);
            let result = self
                .hub()
                .node_commands
                .deliver_secret(&m, input)
                .await
                .map_err(node_error)?;
            Ok(SecretOutcome {
                fingerprint: result.fingerprint.map(|f| f.to_string()),
                error: result.error.map(|e| e.to_string()),
            })
        })
    }

    fn run_gated(
        &self,
        m: &str,
        input: Value,
    ) -> BoxFut<'_, Result<GatedOutcome, NodeCommandError>> {
        let m = m.to_owned();
        Box::pin(async move {
            let (m, input) = (machine_id(&m)?, frame(input)?);
            let result = self
                .hub()
                .node_commands
                .run_gated(&m, input)
                .await
                .map_err(node_error)?;
            Ok(GatedOutcome {
                exit_code: result
                    .exit_code
                    .and_then(|c| serde_json::to_value(c).ok())
                    .and_then(|v| v.as_i64()),
                output_tail: result.output_tail.to_string(),
                timed_out: result.timed_out,
                error: result.error.map(|e| e.to_string()),
            })
        })
    }

    fn is_linked(&self, m: &str) -> BoxFut<'_, bool> {
        let m: Option<fleetd_contracts::ids::MachineId> = convert(&m);
        Box::pin(async move { m.is_some_and(|m| self.hub().executors.is_connected(&m)) })
    }
}

impl ApprovalHub for OpsPorts {
    fn box_key(&self, machine_id: &str) -> BoxFut<'_, Option<Option<String>>> {
        let m: Option<fleetd_contracts::ids::MachineId> = convert(&machine_id);
        Box::pin(async move {
            let machine = self.hub().store.machine_get(&m?).ok()??;
            Some(machine.box_pub_key.as_ref().and_then(convert))
        })
    }

    fn workspace_root(&self, project: &ports::ProjectRef) -> BoxFut<'_, Option<String>> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        Box::pin(async move { Some(self.hub().store.project_get(&r?).ok()??.workspace_root) })
    }

    fn wake_request(&self, request: &HumanRequest) -> BoxFut<'_, ()> {
        let (what, outcome) = request_outcome(request);
        let text = crate::hub::leads::events::Event::Request {
            request: request.request_id.as_str(),
            what: &what,
            outcome: &outcome,
            tail: (request.state == RequestState::Ran)
                .then(|| request.output_tail.as_ref().map(|t| t.as_str()))
                .flatten(),
        }
        .render();
        let project = request.project_ref.clone();
        Box::pin(async move {
            self.hub().leads.wakes.trigger(
                &project,
                crate::hub::leads::wakes::Trigger::Line {
                    kind: crate::hub::leads::wakes::LineKind::Request,
                    text,
                },
            );
        })
    }
}

/// What a request was and what became of it, in the lead's words for its wake.
/// What a settled request was and what became of it, for its line in the lead's wake. A command's output tail goes
/// on the line's body, not here.
pub fn request_outcome(r: &HumanRequest) -> (String, String) {
    let machine = r.project_ref.machine_id.as_str();
    let what = match (&r.secret, &r.gated, &r.permission) {
        (Some(s), _, _) => format!("secret {}", s.key),
        (_, Some(g), _) => format!(
            "your command `{}`",
            clip(
                &shown_argv(&g.argv.iter().cloned().collect::<Vec<_>>()),
                200
            )
        ),
        (_, _, Some(p)) => format!("tool prompt {} {}", p.tool_name, clip(&p.summary, 120)),
        _ => "request".into(),
    };
    let evidence = r.evidence.as_ref().map_or("", |e| e.as_str());
    let outcome = match r.state {
        RequestState::Stored => format!(
            "stored on {machine} ({evidence}); use it from its sink, you never see the value"
        ),
        RequestState::Withdrawn => "withdrawn".into(),
        RequestState::Denied => format!(
            "denied{}{}; don't run it, say in the chat what you do instead",
            r.answered_by
                .as_deref()
                .map_or(String::new(), |b| format!(" by {b}")),
            if evidence.is_empty() {
                String::new()
            } else {
                format!(": {evidence}")
            }
        ),
        RequestState::Approved => format!("approved ({evidence})"),
        RequestState::Ran => format!("ran: {evidence}"),
        RequestState::Failed => format!("did not run: {evidence}"),
        RequestState::Open => format!("open again: {evidence}"),
    };
    (what, outcome)
}
