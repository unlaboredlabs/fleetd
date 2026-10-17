//! The MCP tools `claims_list` and `incidents_list`, and the lead calls `claim_done` and `review_verdict`, as handler
//! bodies over this area's services. The framework's registries decode input, check the tool's scope, call these and
//! encode errors; `ToolRefusal` carries the TS ToolError texts. TS spec: apps/hub/src/api/FleetApi.ts (claims_list,
//! incidents_list) and apps/hub/src/leads/LeadCallHandler.ts (claim_done, review_verdict).
use super::claims::Claims;
use super::ports::{Ports, Refusal};
use super::records::ClaimFilter;
use crate::hub::incidents::{IncidentFilter, Incidents};
use crate::hub::valuebar::{Caller, ValueBar};
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::verification::{Claim, ClaimOutcome, IncidentClass, ReviewVerdict};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;

/// A tool's wire error: `{code, message, fix?}`.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolRefusal {
    pub code: &'static str,
    pub message: String,
    pub fix: Option<String>,
}

pub fn forbidden_read(machine_id: &MachineId) -> ToolRefusal {
    ToolRefusal {
        code: "forbidden",
        message: format!("This key has no read grant on machine {machine_id}."),
        fix: Some("Ask the hub admin for a key with that grant (fleetd hub key create --role … --machines …).".into()),
    }
}

fn unknown_workstream(id: &WorkstreamId) -> ToolRefusal {
    ToolRefusal {
        code: "not_found",
        message: format!("No workstream {id}."),
        fix: Some("Call workstream_list to see workstreams.".into()),
    }
}

fn internal(e: impl std::fmt::Display) -> ToolRefusal {
    ToolRefusal {
        code: "internal",
        message: e.to_string(),
        fix: None,
    }
}

fn default_limit() -> usize {
    20
}
fn default_window() -> u32 {
    7
}

/// ClaimsListInput, already validated by the framework against the contract (limit 1-100).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimsListInput {
    pub workstream_id: Option<WorkstreamId>,
    pub project_ref: Option<ProjectRef>,
    pub outcome: Option<ClaimOutcome>,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

/// IncidentsListInput (limit 1-100, windowDays 1-30).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncidentsListInput {
    pub project_ref: Option<ProjectRef>,
    pub workstream_id: Option<WorkstreamId>,
    pub class: Option<IncidentClass>,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default = "default_window")]
    pub window_days: u32,
}

/// `allows(machine)`: the caller's read grant on that machine.
pub fn claims_list(
    claims: &Claims,
    ports: &dyn Ports,
    input: ClaimsListInput,
    allows: &dyn Fn(&MachineId) -> bool,
) -> Result<Value, ToolRefusal> {
    if let Some(r) = &input.project_ref
        && !allows(&r.machine_id)
    {
        return Err(forbidden_read(&r.machine_id));
    }
    if let Some(id) = &input.workstream_id {
        match ports.workstream(id) {
            Some(w) if allows(&w.project_ref.machine_id) => {}
            _ => return Err(unknown_workstream(id)),
        }
    }
    // Scoped to one project or workstream the store's limit is exact; otherwise read wide and keep what the key may see.
    let scoped = input.project_ref.is_some() || input.workstream_id.is_some();
    let listed = claims
        .list(&ClaimFilter {
            workstream_id: input.workstream_id.clone(),
            project_ref: input.project_ref.clone(),
            outcome: input.outcome,
            limit: if scoped { input.limit + 1 } else { 1000 },
        })
        .map_err(internal)?;
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
        if machine.is_some_and(|m| allows(&m)) {
            all.push(claim);
        }
    }
    let truncated = all.len() > input.limit;
    all.truncate(input.limit);
    let mut out = json!({ "claims": all });
    if truncated {
        out["truncated"] = json!(true);
    }
    out["next"] = json!(if truncated {
        "Narrow the list with workstreamId, projectRef or outcome."
    } else {
        "Each result's evidence is what fleetd saw; workstream_get shows the workstream's state."
    });
    Ok(out)
}

pub fn incidents_list(
    incidents: &Incidents,
    input: IncidentsListInput,
    allows: &dyn Fn(&MachineId) -> bool,
) -> Result<Value, ToolRefusal> {
    if let Some(r) = &input.project_ref
        && !allows(&r.machine_id)
    {
        return Err(forbidden_read(&r.machine_id));
    }
    let filter = IncidentFilter {
        project_ref: input.project_ref,
        workstream_id: input.workstream_id,
        class: input.class,
        since_ms: None,
        until_ms: None,
    };
    let listed = incidents
        .list_for_tool(filter, input.limit, input.window_days, &|r| {
            allows(&r.machine_id)
        })
        .map_err(internal)?;
    let counts: Vec<Value> = listed
        .counts
        .iter()
        .map(|(class, count)| json!({ "class": class, "count": count }))
        .collect();
    let mut out = json!({ "incidents": listed.incidents, "counts": counts, "countsSince": listed.counts_since });
    if listed.truncated {
        out["truncated"] = json!(true);
        out["next"] = json!("Narrow the list with projectRef, workstreamId or class.");
    }
    Ok(out)
}

/// Lead call `claim_done`: the result frame's body (`op` included).
pub async fn lead_claim_done(
    claims: &Arc<Claims>,
    caller: &Caller,
    workstream_id: &WorkstreamId,
) -> Result<Value, Refusal> {
    let outcome = claims
        .claim_done(workstream_id, &caller.by, Some(&caller.project_ref))
        .await?;
    let mut out = serde_json::to_value(&outcome).map_err(|e| Refusal {
        code: "internal",
        message: e.to_string(),
        fix: None,
    })?;
    out["op"] = json!("claim_done");
    Ok(out)
}

/// Lead call `review_verdict`: records it and says how the reviewer ends.
pub async fn lead_review_verdict(
    value_bar: &ValueBar,
    caller: &Caller,
    verdict: ReviewVerdict,
) -> Result<Value, Refusal> {
    let recorded = value_bar.record_verdict(caller, verdict).await?;
    let stop = if recorded.verdict.blocking.get() == 0 {
        "end with your one-paragraph result and stop; this commit will not be reviewed again."
    } else {
        "end with your one-paragraph result listing each blocking finding, then stop; the lead gets it."
    };
    let next = match &recorded.research {
        Some(research) => format!("{research} {stop}"),
        None => stop.to_owned(),
    };
    Ok(json!({ "op": "review_verdict", "verdict": recorded.verdict, "next": next }))
}
