//! MCP tools `tasks_list`, `task_get`, `cap_set` and the lead calls `task_spawn|task_list|task_status|task_message|
//! task_cancel`. TS spec: apps/hub/src/api/FleetApi.ts (those three tools) and apps/hub/src/leads/LeadCallHandler.ts
//! (the task cases).

/// Adds the three tools to the hub's static tool table (framework `Registry`).
pub fn register(_registry: &mut crate::hub::api::Registry) {
    todo!("waits on the framework Registry API")
}

/// Adds the five task calls to the link area's `LeadCalls`, keyed by op.
pub fn register_lead_calls(_calls: &mut crate::hub::link::LeadCalls) {
    todo!("waits on the link LeadCalls API")
}
