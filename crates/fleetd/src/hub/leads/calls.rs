//! Lead-side `fleetd` calls this area answers: `brief create` (which opens a workstream when given none), `close`. The caller is already attributed to a project
//! by its cwd; every call acts only within that project.
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::ledger::IntakeChannel;

use super::Area;
use super::workstreams::IntakeInput;

/// Registered in the link area's `LeadCalls` by `wiring::wire_area`.
pub const OPS: [&str; 2] = ["brief_create", "close"];

impl Area {
    pub async fn lead_call(
        &self,
        project_ref: &ProjectRef,
        by: &str,
        call: LeadCall,
    ) -> Result<LeadCallResult, super::error::LeadError> {
        let r = project_ref;
        Ok(match call {
            LeadCall::BriefCreate(c) => {
                let id = match c.workstream_id {
                    Some(id) => id,
                    // No intent wake: the lead that opens it already knows.
                    None => {
                        self.workstreams
                            .open(
                                IntakeInput {
                                    project_ref: r.clone(),
                                    text: c.text.map(|t| t.to_string()).unwrap_or_default(),
                                    client_request_id: request_id(),
                                    channel: IntakeChannel::Lead,
                                    by: by.to_owned(),
                                },
                                c.asked.as_ref(),
                            )?
                            .workstream_id
                    }
                };
                LeadCallResult::BriefCreate(self.workstreams.brief_create(r, &id, c.brief)?)
            }
            LeadCall::Close(c) => LeadCallResult::Close(
                self.workstreams
                    .close(r, &c.workstream_id, c.why.as_str(), by)
                    .await?,
            ),
            other => {
                return Err(super::error::LeadError::bare(
                    fleetd_contracts::mcp::ErrorCode::Invalid,
                    format!(
                        "leads do not answer the {} call",
                        serde_json::to_value(&other)
                            .ok()
                            .and_then(|v| v["op"].as_str().map(String::from))
                            .unwrap_or_default()
                    ),
                ));
            }
        })
    }
}

/// Each open is a new workstream: a fresh key, never deduped.
fn request_id() -> String {
    let bytes: [u8; 16] = rand::random();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
