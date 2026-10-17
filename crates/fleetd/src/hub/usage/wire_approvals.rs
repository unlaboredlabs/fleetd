//! The approvals area's ports over the real hub: the ledger's asks, the node link's secret and gated-run commands,
//! the leads' answer wakes and the check runner (TS Approvals.ts's layer over Asks, NodeCommands, LeadWakes and
//! CheckRunner). Asks cross as their wire JSON, as the approvals area reads them.
use super::ports::{self, BoxFut};
use super::wire::{OpsPorts, convert};
use crate::hub::approvals::{
    ApprovalAsks, ApprovalHub, ApprovalNodes, ApprovalRefused, GatedOutcome, NodeCommandError,
    SecretOutcome,
};
use crate::hub::ledger::{AskFilter, LedgerError};
use crate::hub::link::commands::NodeCommandErrorReason;
use fleetd_contracts::ledger::{Ask, AskState, CheckSpec};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

fn refused(e: LedgerError) -> ApprovalRefused {
    ApprovalRefused {
        code: e.code.as_str().into(),
        message: e.message,
        fix: e.fix,
    }
}

fn invalid(message: String) -> ApprovalRefused {
    ApprovalRefused {
        code: "invalid".into(),
        message,
        fix: None,
    }
}

fn ask_json(ask: &Ask) -> Value {
    serde_json::to_value(ask).unwrap_or_default()
}

impl ApprovalAsks for OpsPorts {
    fn get(&self, ask_id: &str) -> BoxFut<'_, Option<Value>> {
        let ask_id = ask_id.to_owned();
        Box::pin(async move { Some(ask_json(&self.hub().asks.get(&ask_id).ok()??)) })
    }

    fn list_answered(&self) -> BoxFut<'_, Vec<Value>> {
        Box::pin(async move {
            self.hub()
                .asks
                .list(&AskFilter {
                    state: Some(AskState::Answered),
                    limit: Some(i64::MAX),
                    ..Default::default()
                })
                .map(|asks| asks.iter().map(ask_json).collect())
                .unwrap_or_else(|error| {
                    tracing::warn!(%error, "approvals: answered asks not listed");
                    Vec::new()
                })
        })
    }

    fn create(&self, input: Value, by: &str) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
        let by = by.to_owned();
        Box::pin(async move {
            let input = super::wire_retro::ask_input_of(&input).map_err(invalid)?;
            let outcome = self.hub().asks.create(&input, &by).map_err(refused)?;
            Ok(ask_json(&outcome.ask))
        })
    }

    fn update(
        &self,
        ask_id: &str,
        patch: Map<String, Value>,
    ) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
        let ask_id = ask_id.to_owned();
        Box::pin(async move {
            let mut decode_error = None;
            let saved = self
                .hub()
                .asks
                .update(&ask_id, |current| {
                    let mut merged = ask_json(&current);
                    if let Value::Object(fields) = &mut merged {
                        fields.extend(patch);
                    }
                    match serde_json::from_value::<Ask>(merged) {
                        Ok(next) => next,
                        Err(e) => {
                            decode_error = Some(e.to_string());
                            current
                        }
                    }
                })
                .map_err(refused)?;
            match decode_error {
                Some(e) => Err(invalid(format!("{ask_id} was not updated: {e}"))),
                None => Ok(ask_json(&saved)),
            }
        })
    }

    fn reopen(&self, ask_id: &str, evidence: &str) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
        let (ask_id, evidence) = (ask_id.to_owned(), evidence.to_owned());
        Box::pin(async move {
            let ask = self
                .hub()
                .asks
                .reopen(&ask_id, &evidence)
                .map_err(refused)?;
            Ok(ask_json(&ask))
        })
    }
}

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
    }
}

/// A node frame from the approvals area's JSON; `id` is replaced by NodeCommands, so any placeholder does.
fn frame<T: DeserializeOwned>(mut input: Value) -> Result<T, NodeCommandError> {
    input["id"] = Value::String("pending".into());
    serde_json::from_value(input).map_err(|e| NodeCommandError {
        reason: "invalid".into(),
        message: e.to_string(),
    })
}

fn machine_id(m: &str) -> Result<fleetd_contracts::ids::MachineId, NodeCommandError> {
    convert(&m).ok_or_else(|| NodeCommandError {
        reason: "invalid".into(),
        message: format!("{m} is not a machine id"),
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

    fn wake_answer(
        &self,
        project: &ports::ProjectRef,
        ask: Value,
        value: String,
    ) -> BoxFut<'_, ()> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        Box::pin(async move {
            let (Some(r), Ok(ask)) = (r, serde_json::from_value::<Ask>(ask)) else {
                tracing::warn!("approvals: answer wake dropped (not a project ref or an ask)");
                return;
            };
            let answer = crate::hub::leads::ports::Answer {
                ask,
                withdrawn: false,
                value: Some(value),
                decision: None,
            };
            self.hub()
                .leads
                .wakes
                .trigger(&r, crate::hub::leads::wakes::Trigger::Answer(answer));
        })
    }

    fn verify(
        &self,
        project: &ports::ProjectRef,
        workstream_id: Option<String>,
        verify: Value,
    ) -> BoxFut<'_, (String, String)> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        Box::pin(async move {
            let spec = serde_json::from_value::<CheckSpec>(verify);
            let (Some(project_ref), Ok(spec)) = (r, spec) else {
                return (
                    "error".into(),
                    "the ask's verify check could not be read".into(),
                );
            };
            let scope = crate::hub::checks::runner::CheckScope {
                project_ref,
                workstream_id: workstream_id.as_ref().and_then(convert),
            };
            let (result, evidence) = self.hub().checks.verify(&scope, &spec).await;
            let result = serde_json::to_value(result)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| "error".into());
            (result, evidence)
        })
    }
}
