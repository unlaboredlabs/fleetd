//! Lead-side `fleetd` calls this area answers: `brief create`, `status set`. The caller
//! is already attributed to a project by its cwd; every call acts only within that project.
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};

use super::Area;

/// Registered in the link area's `LeadCalls` by `wiring::wire_area`.
pub const OPS: [&str; 2] = ["brief_create", "status_set"];

impl Area {
    pub async fn lead_call(
        &self,
        project_ref: &ProjectRef,
        call: LeadCall,
    ) -> Result<LeadCallResult, super::error::LeadError> {
        let r = project_ref;
        Ok(match call {
            LeadCall::BriefCreate(c) => LeadCallResult::BriefCreate(
                self.workstreams
                    .brief_create(r, &c.workstream_id, c.brief)?,
            ),
            LeadCall::StatusSet(c) => LeadCallResult::StatusSet(self.workstreams.status_set(
                r,
                c.text.as_str(),
                c.workstream_id.as_ref(),
            )?),
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
