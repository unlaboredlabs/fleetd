//! Cross-area links that belong to no single area: the ledger's lead calls and the hub the leads read usage, the train
//! and the work ledger through. Run once in `build_on`, after the `Hub` exists.
use std::sync::{Arc, Weak};

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::lead_calls::LeadCall;
use fleetd_contracts::mcp::McpToolError;

use crate::hub::api::Hub;
use crate::hub::leads::error::LeadError;
use crate::hub::link::lead_calls::LeadCallFuture;
use crate::hub::link::{LeadCallHandler, LeadCaller};

pub fn wire(hub: &Arc<Hub>) {
    register_ledger_calls(hub);
    extend_tools(hub);
    let _ = hub.leads.ctx.hooks.hub.set(Arc::downgrade(hub));
}

/// The ledger's lead calls: `decide`, `decisions_search`.
struct LedgerCalls(Weak<Hub>);

impl LeadCallHandler for LedgerCalls {
    fn handle(&self, caller: LeadCaller, call: LeadCall) -> LeadCallFuture {
        let hub = self.0.upgrade();
        Box::pin(async move {
            let hub = hub.ok_or_else(|| {
                McpToolError::new(
                    fleetd_contracts::mcp::ErrorCode::Failed,
                    "the hub is stopping",
                )
            })?;
            crate::hub::ledger::lead_call(&hub, &caller.project_ref, &caller.by, call)
                .map_err(|e| McpToolError::from(LeadError::from(e)))
        })
    }
}

fn stopping() -> McpToolError {
    McpToolError::new(
        fleetd_contracts::mcp::ErrorCode::Failed,
        "the hub is stopping",
    )
}

/// The lead calls `review_verdict` and `review_read`, answered by review verdicts.
struct CheckCalls(Weak<Hub>);

impl LeadCallHandler for CheckCalls {
    fn handle(&self, caller: LeadCaller, call: LeadCall) -> LeadCallFuture {
        use fleetd_contracts::lead_calls::LeadCallResult;
        let hub = self.0.upgrade();
        Box::pin(async move {
            let hub = hub.ok_or_else(stopping)?;
            if let LeadCall::ReviewRead(read) = &call {
                return crate::hub::reviews::read::review_read(&hub, &caller, read)
                    .map(LeadCallResult::ReviewRead);
            }
            let caller = crate::hub::reviews::verdicts::Caller {
                project_ref: caller.project_ref,
                by: caller.by,
                task: match caller.agent {
                    crate::hub::link::lead_calls::CallerAgent::Task(task) => Some(task),
                    _ => None,
                },
            };
            match call {
                LeadCall::ReviewVerdict(v) => {
                    crate::hub::checks::tools::lead_review_verdict(&hub, &caller, v)
                        .await
                        .map(LeadCallResult::ReviewVerdict)
                }
                other => Err(McpToolError::new(
                    fleetd_contracts::mcp::ErrorCode::Invalid,
                    format!(
                        "{} is not a review call",
                        crate::hub::link::lead_calls::op_of(&other)
                    ),
                )),
            }
        })
    }
}

fn register_ledger_calls(hub: &Arc<Hub>) {
    let calls: Arc<dyn LeadCallHandler> = Arc::new(LedgerCalls(Arc::downgrade(hub)));
    for op in ["decide", "decisions_search"] {
        hub.lead_calls.register(op, Arc::clone(&calls));
    }
    let checks: Arc<dyn LeadCallHandler> = Arc::new(CheckCalls(Arc::downgrade(hub)));
    hub.lead_calls
        .register("review_verdict", Arc::clone(&checks));
    hub.lead_calls.register("review_read", checks);
}

/// fleetd_status carries the slot board (rows on machines the caller reads), and project_get the
/// project's tasks (their threads leave the thread list) and its trains.
fn extend_tools(hub: &Arc<Hub>) {
    use crate::hub::api::{ToolError, limits};
    use crate::hub::executor::tools::ProjectExtra;
    use fleetd_contracts::auth::Role;

    hub.executors.hooks.extend_status(Arc::new(|hub, caller| {
        Box::pin(async move {
            let mut board = serde_json::to_value(hub.slots.state()).unwrap_or_default();
            if let Some(rows) = board.get_mut("perProject").and_then(|r| r.as_array_mut()) {
                rows.retain(|row| {
                    row["projectRef"]["machineId"]
                        .as_str()
                        .and_then(|m| MachineId::try_from(m.to_owned()).ok())
                        .is_some_and(|m| crate::hub::api::allows(&caller, Role::Read, Some(&m)))
                });
            }
            if let Some(rows) = board.get_mut("perMachine").and_then(|r| r.as_array_mut()) {
                rows.retain(|row| {
                    row["machineId"]
                        .as_str()
                        .and_then(|m| MachineId::try_from(m.to_owned()).ok())
                        .is_some_and(|m| crate::hub::api::allows(&caller, Role::Read, Some(&m)))
                });
            }
            let mut out = serde_json::Map::new();
            out.insert("slots".into(), board);
            Ok(out)
        })
    }));
    hub.executors.hooks.extend_project_get(Arc::new(|hub, r| {
        Box::pin(async move {
            use crate::hub::tasks::records::TaskRecords;
            let internal = |e: crate::hub::store::StoreError| ToolError::from(e);
            let mut extra = ProjectExtra {
                exclude_threads: hub
                    .db
                    .with(|c| Ok(TaskRecords::thread_ids(c, &r)?))
                    .map_err(internal)?,
                ..Default::default()
            };
            let mut recent = hub
                .tasks
                .list(&crate::hub::tasks::TaskFilter {
                    project_ref: Some(r.clone()),
                    state: None,
                    workstream_id: None,
                    limit: limits::OUTCOME_TASKS + 1,
                })
                .map_err(internal)?;
            if recent.len() > limits::OUTCOME_TASKS {
                recent.truncate(limits::OUTCOME_TASKS);
                extra.truncated = Some(true);
            }
            if !recent.is_empty() {
                let counts = hub
                    .db
                    .with(|c| Ok(TaskRecords::counts(c, &r)?))
                    .map_err(internal)?;
                extra.fields.insert(
                    "taskCounts".into(),
                    serde_json::to_value(counts).unwrap_or_default(),
                );
                extra.fields.insert(
                    "tasks".into(),
                    serde_json::to_value(recent).unwrap_or_default(),
                );
            }
            let own: Vec<_> = hub
                .train
                .records()
                .trains()
                .into_iter()
                .filter(|t| t.project_ref == r)
                .collect();
            if own.len() > limits::TRAINS {
                extra.truncated = Some(true);
            }
            let trains: Vec<_> = own
                .iter()
                .take(limits::TRAINS)
                .map(|t| hub.train.state(&t.repo))
                .collect();
            if !trains.is_empty() {
                extra.fields.insert(
                    "trains".into(),
                    serde_json::to_value(trains).unwrap_or_default(),
                );
            }
            Ok(extra)
        })
    }));
}
