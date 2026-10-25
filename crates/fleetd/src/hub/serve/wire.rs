//! Cross-area links that belong to no single area: the ledger's lead calls and the leads hooks over usage, the train
//! and GitHub. Run once in `build_on`, after the `Hub` exists.
use std::sync::{Arc, Weak};

use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef, Timestamp};
use fleetd_contracts::lead_calls::LeadCall;
use fleetd_contracts::ledger::WorkstreamId;
use fleetd_contracts::mcp::McpToolError;
use fleetd_contracts::usage::UsageParked;

use crate::hub::api::Hub;
use crate::hub::leads::error::LeadError;
use crate::hub::leads::hooks::{BoxFuture, TrainHook, UsageHook, WorkHook};
use crate::hub::link::lead_calls::LeadCallFuture;
use crate::hub::link::{LeadCallHandler, LeadCaller};
use crate::hub::usage::wire::convert;

pub fn wire(hub: &Arc<Hub>) {
    register_ledger_calls(hub);
    extend_tools(hub);
    let hooks = &hub.leads.ctx.hooks;
    let _ = hooks
        .usage
        .set(Arc::new(UsageForLeads(Arc::downgrade(hub))));
    let _ = hooks
        .train
        .set(Arc::new(TrainForLeads(Arc::downgrade(hub))));
    let _ = hooks.work.set(Arc::new(WorkForLeads(Arc::downgrade(hub))));
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

/// The lead call `review_verdict`, answered by review verdicts.
struct CheckCalls(Weak<Hub>);

impl LeadCallHandler for CheckCalls {
    fn handle(&self, caller: LeadCaller, call: LeadCall) -> LeadCallFuture {
        use fleetd_contracts::lead_calls::LeadCallResult;
        let hub = self.0.upgrade();
        Box::pin(async move {
            let hub = hub.ok_or_else(stopping)?;
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
    hub.lead_calls.register("review_verdict", checks);
}

struct UsageForLeads(Weak<Hub>);

fn usage_ref(thread: &ThreadRef) -> Option<crate::hub::usage::ports::ThreadRef> {
    convert(thread)
}

impl UsageHook for UsageForLeads {
    fn gate(&self, machine_id: &MachineId) -> Option<String> {
        self.0.upgrade()?.usage.gate(machine_id.as_str())
    }
    fn parked_of(&self, thread: &ThreadRef) -> Option<UsageParked> {
        convert(&self.0.upgrade()?.usage.parked_of(&usage_ref(thread)?)?)
    }
    fn hold(&self, thread: &ThreadRef) -> Option<String> {
        self.0.upgrade()?.usage.hold(&usage_ref(thread)?)
    }
    fn when_clear(&self, thread: &ThreadRef) -> BoxFuture<()> {
        let (hub, r) = (self.0.upgrade(), usage_ref(thread));
        Box::pin(async move {
            if let (Some(hub), Some(r)) = (hub, r) {
                hub.usage.when_clear(&r).await;
            }
        })
    }
}

/// Lead wakes: the section is left out when the project has no train and no Change.
struct TrainForLeads(Weak<Hub>);

impl TrainHook for TrainForLeads {
    fn lead_lines(
        &self,
        project_ref: &ProjectRef,
        since: Option<&Timestamp>,
    ) -> Option<Vec<String>> {
        let hub = self.0.upgrade()?;
        let facts = crate::hub::train::digest::train_facts(hub.train.records(), |r| {
            r.machine_id == project_ref.machine_id && r.project_id == project_ref.project_id
        });
        if facts.trains.is_empty() && facts.changes.is_empty() {
            return None;
        }
        Some(crate::hub::train::digest::lead_train_lines(
            &facts,
            since.map(|s| s.0.as_str()),
        ))
    }

    fn unlanded(&self, project_ref: &ProjectRef, workstream_id: &WorkstreamId) -> Vec<String> {
        let Some(hub) = self.0.upgrade() else {
            return Vec::new();
        };
        hub.train
            .records()
            .unlanded(project_ref, workstream_id.as_str())
            .iter()
            .map(|c| {
                format!(
                    "#{} {}",
                    c.pr_number.get(),
                    crate::hub::train::contract::state_str(c.state)
                )
            })
            .collect()
    }
}

/// Lead wakes: the section is left out when the project's repo and base aren't known, or the ledger can't be read.
struct WorkForLeads(Weak<Hub>);

impl WorkHook for WorkForLeads {
    fn elsewhere(&self, project_ref: &ProjectRef) -> BoxFuture<Option<Vec<String>>> {
        let (hub, r) = (self.0.upgrade(), project_ref.clone());
        Box::pin(async move {
            match hub?.work.elsewhere(&r).await {
                Ok(lines) => lines,
                Err(error) => {
                    tracing::warn!(%error, "the digest's Elsewhere lines");
                    None
                }
            }
        })
    }
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
