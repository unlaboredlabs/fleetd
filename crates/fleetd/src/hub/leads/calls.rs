//! Lead-side `fleetd` calls this area answers: `brief create`, `status set`, `workstream spawn`, `inventory`. The caller
//! is already attributed to a project by its cwd; every call acts only within that project.
use std::sync::Arc;

use fleetd_contracts::lead_calls::{InventoryResult, LeadCall, LeadCallResult, WorkstreamSpawnResult};
use fleetd_contracts::prim::Count;

use super::Area;
use crate::hub::link::{LeadCallFuture, LeadCallHandler, LeadCallRefused, LeadCaller, LeadCalls};
use crate::hub::playbooks::finish_all::Caller;

pub const OPS: [&str; 4] = ["brief_create", "status_set", "workstream_spawn", "inventory"];

struct Handler(Arc<Area>);

impl LeadCallHandler for Handler {
    fn handle(&self, caller: LeadCaller, call: LeadCall) -> LeadCallFuture {
        let area = Arc::clone(&self.0);
        Box::pin(async move { area.lead_call(caller, call).await.map_err(LeadCallRefused::from) })
    }
}

pub fn register(calls: &LeadCalls, area: &Arc<Area>) {
    let handler: Arc<dyn LeadCallHandler> = Arc::new(Handler(Arc::clone(area)));
    for op in OPS {
        calls.register(op, Arc::clone(&handler));
    }
}

impl Area {
    async fn lead_call(&self, caller: LeadCaller, call: LeadCall) -> Result<LeadCallResult, super::error::LeadError> {
        let r = &caller.project_ref;
        let finish_all_caller = || Caller { project_ref: r.clone(), by: caller.by.clone(), channel: None };
        Ok(match call {
            LeadCall::BriefCreate(c) => LeadCallResult::BriefCreate(self.workstreams.brief_create(r, &c.workstream_id, c.brief, c.amend.as_ref())?),
            LeadCall::StatusSet(c) => LeadCallResult::StatusSet(self.workstreams.status_set(r, c.text.as_str(), c.workstream_id.as_ref())?),
            LeadCall::WorkstreamSpawn(c) => {
                let spawned = self.finish_all.spawn(&finish_all_caller(), c.text.as_str(), c.serves.as_str(), c.template).await?;
                LeadCallResult::WorkstreamSpawn(WorkstreamSpawnResult {
                    workstream_id: spawned.workstream_id,
                    parent: spawned.parent,
                    playbook: spawned.playbook,
                    next: Some(spawned.next),
                })
            }
            LeadCall::Inventory(_) => {
                let listed = self.finish_all.inventory(&finish_all_caller()).await?;
                LeadCallResult::Inventory(InventoryResult {
                    text: listed.text,
                    spawnable: Count::unchecked(listed.spawnable as i64),
                    idle: listed.idle,
                    next: None,
                })
            }
            other => {
                return Err(super::error::LeadError::bare(
                    fleetd_contracts::mcp::ErrorCode::Invalid,
                    format!("leads do not answer the {} call", serde_json::to_value(&other).ok().and_then(|v| v["op"].as_str().map(String::from)).unwrap_or_default()),
                ));
            }
        })
    }
}
