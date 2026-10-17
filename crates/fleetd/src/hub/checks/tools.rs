//! The MCP tools `claims_list` and `incidents_list`, and the lead calls `claim_done` and `review_verdict`.
//! TS spec: apps/hub/src/api/FleetApi.ts (claims_list, incidents_list) and apps/hub/src/leads/LeadCallHandler.ts
//! (claim_done, review_verdict).
use super::ports::Refusal;
use super::records::ClaimFilter;
use crate::hub::api::{Caller, Hub, Registry, ToolError, cap, readable, require};
use crate::hub::incidents::IncidentFilter;
use crate::hub::valuebar::Caller as LeadCaller;
use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::lead_calls::{ClaimDoneResult, ReviewVerdictResult};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::mcp::{
    ClaimsListInput, ClaimsListOutput, ErrorCode, IncidentCount, IncidentsListInput,
    IncidentsListOutput, McpToolError,
};
use fleetd_contracts::prim::{Int, List};
use fleetd_contracts::verification::{Claim, ReviewVerdict};
use std::collections::HashMap;
use std::sync::Arc;

pub fn register(tools: &mut Registry) {
    tools.add("claims_list", claims_list);
    tools.add("incidents_list", incidents_list);
}

fn unknown_workstream(id: &WorkstreamId) -> ToolError {
    McpToolError::new(ErrorCode::NotFound, format!("No workstream {id}."))
        .with_fix("Call workstream_list to see workstreams.")
}

async fn claims_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: ClaimsListInput,
) -> Result<ClaimsListOutput, ToolError> {
    if let Some(r) = &input.project_ref {
        require(&caller, Role::Read, Some(&r.machine_id))?;
    }
    let ports = hub.claims.ports();
    if let Some(id) = &input.workstream_id {
        match ports.workstream(id) {
            Some(w) if readable(&caller, &w.project_ref.machine_id) => {}
            _ => return Err(unknown_workstream(id)),
        }
    }
    let limit = input.limit.get() as usize;
    // Scoped to one project or workstream the store's limit is exact; otherwise read wide and keep what the key may
    // see.
    let scoped = input.project_ref.is_some() || input.workstream_id.is_some();
    let listed = hub.claims.list(&ClaimFilter {
        workstream_id: input.workstream_id.clone(),
        project_ref: input.project_ref.clone(),
        outcome: input.outcome,
        limit: if scoped { limit + 1 } else { 1000 },
    })?;
    let mut all: Vec<Claim> = Vec::new();
    let mut machine_of: HashMap<WorkstreamId, Option<MachineId>> = HashMap::new();
    for claim in listed {
        if scoped {
            all.push(claim);
            continue;
        }
        let machine = machine_of
            .entry(claim.workstream_id.clone())
            .or_insert_with(|| {
                ports
                    .workstream(&claim.workstream_id)
                    .map(|w| w.project_ref.machine_id)
            })
            .clone();
        if machine.is_some_and(|m| readable(&caller, &m)) {
            all.push(claim);
        }
    }
    let shown = cap(all, limit);
    let next = if shown.truncated.is_some() {
        "Narrow the list with workstreamId, projectRef or outcome."
    } else {
        "Each result's evidence is what fleetd saw; workstream_get shows the workstream's state."
    };
    Ok(ClaimsListOutput {
        claims: List::unchecked(shown.items),
        truncated: shown.truncated,
        next: Some(next.into()),
    })
}

async fn incidents_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: IncidentsListInput,
) -> Result<IncidentsListOutput, ToolError> {
    if let Some(r) = &input.project_ref {
        require(&caller, Role::Read, Some(&r.machine_id))?;
    }
    let filter = IncidentFilter {
        project_ref: input.project_ref.clone(),
        workstream_id: input.workstream_id.clone(),
        class: input.class,
        since_ms: None,
        until_ms: None,
    };
    let listed = hub.incidents.list_for_tool(
        filter,
        input.limit.get() as usize,
        input.window_days.get() as u32,
        &|r| readable(&caller, &r.machine_id),
    )?;
    let counts = listed
        .counts
        .into_iter()
        .map(|(class, count)| IncidentCount {
            class,
            count: Int::unchecked(count as i64),
        })
        .collect();
    Ok(IncidentsListOutput {
        incidents: List::unchecked(listed.incidents),
        counts,
        counts_since: Timestamp(listed.counts_since),
        truncated: listed.truncated.then_some(true),
        next: listed
            .truncated
            .then(|| "Narrow the list with projectRef, workstreamId or class.".into()),
    })
}

/// Lead call `claim_done`.
pub async fn lead_claim_done(
    hub: &Hub,
    caller: &LeadCaller,
    workstream_id: &WorkstreamId,
) -> Result<ClaimDoneResult, Refusal> {
    let outcome = hub
        .claims
        .claim_done(workstream_id, &caller.by, Some(&caller.project_ref))
        .await?;
    Ok(ClaimDoneResult {
        claim_id: outcome.claim_id,
        workstream_id: outcome.workstream_id,
        state: outcome.state,
        claim: outcome.claim,
        next: Some(outcome.next),
    })
}

/// Lead call `review_verdict`: records it and says how the reviewer ends.
pub async fn lead_review_verdict(
    hub: &Hub,
    caller: &LeadCaller,
    verdict: ReviewVerdict,
) -> Result<ReviewVerdictResult, Refusal> {
    let recorded = hub.value_bar.record_verdict(caller, verdict).await?;
    let stop = if recorded.verdict.blocking.get() == 0 {
        "end with your one-paragraph result and stop; this commit will not be reviewed again."
    } else {
        "end with your one-paragraph result listing each blocking finding, then stop; the lead gets it."
    };
    let next = match &recorded.research {
        Some(research) => format!("{research} {stop}"),
        None => stop.to_owned(),
    };
    Ok(ReviewVerdictResult {
        verdict: recorded.verdict,
        next: Some(next),
    })
}
