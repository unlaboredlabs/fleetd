//! The hub's `Ports`: this slice's view of the other areas, forwarding to their services on the
//! `Hub`. Built before the `Hub` exists (the services that hold it go into the `Hub`), so it is bound right after.
//! Before `bind` (or after the hub is dropped) each answers as if there were nothing.
use super::ports::{
    BoxFuture, ClaimWake, CommandRun, HumanConfirmation, JudgeSpawn, Ports, Refusal, invalid,
};
use super::{JUDGE_BY, render};
use crate::hub::api::Hub;
use crate::hub::leads::wakes::{LineKind, Trigger};
use crate::hub::ledger::DecisionFilter;
use crate::hub::link::commands::CommandInput;
use crate::hub::tasks::{TaskCaller, TaskFilter};
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::lead_calls::TaskSpawnCall;
use fleetd_contracts::ledger::{
    DecisionScope, DecisionState, MetricValues, Workstream, WorkstreamId,
};
use fleetd_contracts::prim::{Line, Text};
use fleetd_contracts::tasks::{Task, TaskId, TaskKind};
use std::sync::{Arc, OnceLock, Weak};

#[derive(Default)]
pub struct HubPorts {
    hub: OnceLock<Weak<Hub>>,
}

impl HubPorts {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Called once by `hub::serve::build_on`, after the `Hub` is built.
    pub fn bind(&self, hub: &Arc<Hub>) {
        let _ = self.hub.set(Arc::downgrade(hub));
    }

    fn hub(&self) -> Option<Arc<Hub>> {
        self.hub.get()?.upgrade()
    }
}

fn not_linked(machine: &MachineId) -> String {
    format!("{machine}'s node is not linked to the hub")
}

impl Ports for HubPorts {
    fn workstream(&self, id: &WorkstreamId) -> Option<Workstream> {
        let stored = self.hub()?.leads.records.workstream_get(id);
        logged(stored, "reading a workstream").flatten()
    }
    fn put_workstream(&self, workstream: &Workstream) {
        let Some(hub) = self.hub() else { return };
        logged(
            hub.leads.records.workstream_put(workstream),
            "storing a workstream",
        );
    }
    fn put_workstream_if(&self, workstream: &Workstream, expect: &Workstream) -> bool {
        let Some(hub) = self.hub() else { return false };
        logged(
            hub.leads.records.workstream_put_if(workstream, expect),
            "storing a workstream",
        )
        .unwrap_or(false)
    }
    fn wake(&self, project: &ProjectRef, wake: ClaimWake) {
        let Some(hub) = self.hub() else { return };
        let trigger = match wake {
            ClaimWake::Failed {
                claim_id,
                workstream_id,
                failures,
            } => Trigger::Line {
                kind: LineKind::ClaimFailed,
                text: render::claim_failed_lines(&claim_id, &workstream_id, &failures),
            },
            ClaimWake::Passed {
                claim_id,
                workstream_id,
            } => Trigger::Line {
                kind: LineKind::ClaimPassed,
                text: render::claim_passed_line(&claim_id, &workstream_id),
            },
            ClaimWake::Held {
                claim_id,
                workstream_id,
                work,
            } => Trigger::Line {
                kind: LineKind::ClaimPassed,
                text: render::claim_held_line(&claim_id, &workstream_id, &work),
            },
        };
        hub.leads.wakes.trigger(project, trigger);
    }
    fn run_command(
        &self,
        machine: &MachineId,
        cwd: String,
        argv: Vec<String>,
    ) -> BoxFuture<'_, Result<CommandRun, String>> {
        let hub = self.hub();
        let machine = machine.clone();
        Box::pin(async move {
            let Some(hub) = hub else {
                return Err(not_linked(&machine));
            };
            let input = CommandInput {
                cwd,
                argv,
                timeout_sec: None,
            };
            let result = hub
                .node_commands
                .run(&machine, input)
                .await
                .map_err(|e| e.message)?;
            Ok(CommandRun {
                exit_code: result.exit_code.map(|c| c.get()),
                output_tail: result.output_tail.to_string(),
                timed_out: result.timed_out,
            })
        })
    }
    fn workspace_root(&self, project: &ProjectRef) -> Option<String> {
        let summary = self.hub()?.store.project_get(project).ok()??;
        Some(summary.workspace_root)
    }
    fn research_verdict<'a>(
        &'a self,
        workstream: &'a WorkstreamId,
        values: MetricValues,
    ) -> BoxFuture<'a, Result<String, Refusal>> {
        Box::pin(async move {
            let Some(hub) = self.hub() else {
                return Err(invalid(
                    format!("{workstream} has no research verdict to record."),
                    None,
                ));
            };
            let (_, text) = hub
                .leads
                .research
                .record_verdict(workstream, values)
                .await?;
            Ok(text)
        })
    }
    fn task(&self, id: &TaskId) -> Option<Task> {
        logged(self.hub()?.tasks.get(id), "reading a task").flatten()
    }
    fn tasks_of(&self, project: &ProjectRef, workstream: &WorkstreamId, limit: usize) -> Vec<Task> {
        let Some(hub) = self.hub() else {
            return Vec::new();
        };
        let filter = TaskFilter {
            project_ref: Some(project.clone()),
            state: None,
            workstream_id: Some(workstream.clone()),
            limit,
        };
        logged(hub.tasks.list(&filter), "listing tasks").unwrap_or_default()
    }
    fn open_work(&self, workstream: &Workstream) -> Vec<crate::hub::orders::open_work::OpenWork> {
        let Some(hub) = self.hub() else {
            return Vec::new();
        };
        crate::hub::orders::open_work::open(
            &hub,
            &workstream.project_ref,
            &workstream.workstream_id,
        )
    }
    fn spawn_judge(&self, spawn: JudgeSpawn) -> BoxFuture<'_, Result<Task, Refusal>> {
        Box::pin(async move {
            let Some(hub) = self.hub() else {
                return Err(invalid("The hub cannot spawn tasks yet.", None));
            };
            let caller = TaskCaller {
                project_ref: spawn.project_ref,
                by: JUDGE_BY.into(),
            };
            let input = TaskSpawnCall {
                workstream_id: spawn.workstream_id,
                title: Line::unchecked(spawn.title),
                kind: TaskKind::Review,
                prompt: Text::unchecked(spawn.prompt),
                profile: None,
                pr: None,
                qa: None,
                item: None,
            };
            hub.tasks.spawn(&caller, input).await
        })
    }
    fn human_confirmation(
        &self,
        workstream: &WorkstreamId,
        key: &str,
    ) -> Option<HumanConfirmation> {
        let hub = self.hub()?;
        let scope = DecisionScope::Workstream {
            workstream_id: workstream.clone(),
        };
        let found = hub.decisions.list(&DecisionFilter {
            scope: Some(scope),
            limit: Some(200),
            ..Default::default()
        });
        let decision = logged(found, "reading a workstream's decisions")?
            .into_iter()
            .find(|d| d.key.as_str() == key && d.state == DecisionState::Active)?;
        Some(HumanConfirmation {
            value: decision.value.to_string(),
            decision_id: decision.decision_id.to_string(),
            at_ms: crate::hub::usage::time::parse_ms(decision.at.as_str()).unwrap_or(0),
        })
    }
    fn brief_set_ms(&self, workstream: &WorkstreamId) -> Option<i64> {
        let hub = self.hub()?;
        let at = hub.db.with(|c| {
            Ok(c.query_row(
                "SELECT max(created_ms) FROM events
                 WHERE (type = 'workstream.running'
                        OR (type = 'workstream.state' AND (json_extract(data, '$.data.briefEdited')
                            OR json_extract(data, '$.data.amend') IS NOT NULL)))
                   AND json_valid(data) AND json_extract(data, '$.data.workstreamId') = ?1",
                [workstream.as_str()],
                |r| r.get::<_, Option<i64>>(0),
            )?)
        });
        logged(at, "reading when a brief was set").flatten()
    }
}

/// A failed read or write is logged and answered as "nothing", as the stub did.
fn logged<T, E: std::fmt::Display>(result: Result<T, E>, what: &str) -> Option<T> {
    result
        .map_err(|error| tracing::warn!(%error, "checks: {what} failed"))
        .ok()
}
