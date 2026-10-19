//! A project's max agents and the fleet cap, as a person sets them (`cap_set`, `fleetd project set`). The slot board
//! enforces both at every start; this is the change itself: lowering stops nothing (running agents finish their work,
//! new ones wait) unless the extras are paused, raising starts queued agents at once and wakes the lead, and every
//! change is one `agents.cap` event whose summary is the chat's quiet line.
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::prim::{Count, Int, List};
use fleetd_contracts::tasks::{AgentsCapData, SlotState, TaskId, TaskState};

use super::ports::{TaskError, WakeKind};
use super::{StoredTask, TaskRecords, Tasks, lead_error, request_id, store_error};
use crate::hub::slots::CapInput;
use crate::hub::store::NewEvent;

pub struct CapChange {
    pub cap: Option<i64>,
    pub project: Option<ProjectCap>,
}

pub struct ProjectCap {
    pub project_ref: ProjectRef,
    pub max_agents: i64,
    /// Lowering: pause the agents above the new max now instead of letting them finish.
    pub pause_extras: bool,
}

#[derive(Debug)]
pub struct CapOutcome {
    pub slots: SlotState,
    pub paused: Vec<TaskId>,
    pub next: String,
}

fn plural(n: i64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// A paused agent's reason, as its task shows it while it waits.
pub fn paused_reason(max_agents: i64) -> String {
    format!("paused: max agents lowered to {max_agents}; resumes when a slot frees")
}

impl Tasks {
    pub async fn set_caps(self: &Arc<Self>, change: CapChange) -> Result<CapOutcome, TaskError> {
        let slots = &self.d.slots;
        let cap_before = slots.cap();
        let cap = change.cap.unwrap_or(cap_before);
        if let Some(p) = &change.project
            && p.max_agents > cap
        {
            return Err(lead_error(
                ErrorCode::Invalid,
                format!(
                    "Max agents {} is above the fleet's {cap} slots.",
                    p.max_agents
                ),
                Some(&format!("Pick 1 to {cap}, or raise the fleet cap first.")),
            ));
        }
        let before = change
            .project
            .as_ref()
            .map(|p| slots.agents(&p.project_ref));
        // The board grants every queued claim that now fits before this returns; the release listener starts them.
        slots
            .set_cap(CapInput {
                cap: change.cap,
                max_agents: change
                    .project
                    .as_ref()
                    .map(|p| (p.project_ref.clone(), p.max_agents)),
            })
            .map_err(store_error)?;

        let mut paused = Vec::new();
        let mut lines = Vec::new();
        if cap != cap_before {
            let after = slots.state();
            let line = if cap > cap_before {
                format!("Fleet cap {cap_before} → {cap}: queued turns start as slots allow.")
            } else {
                format!("Fleet cap {cap_before} → {cap}: running turns finish; new ones wait.")
            };
            self.cap_event(
                None,
                cap_before,
                cap,
                after.used.get(),
                after.queued.get(),
                &[],
                &line,
            )
            .map_err(store_error)?;
            lines.push(line);
        }
        if let (Some(p), Some(before)) = (&change.project, before) {
            let r = &p.project_ref;
            let (from, to) = (before.max_agents, p.max_agents);
            if to < from && p.pause_extras {
                paused = self.pause_extras(r, to).await;
            }
            let after = slots.agents(r);
            let free = slots.room(r);
            let line = if to > from {
                let started = (after.running - before.running).max(0);
                format!(
                    "Max agents {from} → {to}: {} now, {} free.",
                    plural(started, "queued agent starts", "queued agents start"),
                    plural(free, "slot", "slots")
                )
            } else if to < from && !paused.is_empty() {
                format!(
                    "Max agents {from} → {to}: {} push their work and wait; {} keep running.",
                    plural(paused.len() as i64, "agent", "agents"),
                    (after.running - paused.len() as i64).max(0)
                )
            } else if to < from && after.running > to {
                format!(
                    "Max agents {from} → {to}: {} running finish their work; new agents wait.",
                    after.running
                )
            } else {
                format!("Max agents {from} → {to}.")
            };
            if to != from {
                self.cap_event(
                    Some(r),
                    from,
                    to,
                    after.running,
                    after.queued,
                    &paused,
                    &line,
                )
                .map_err(store_error)?;
                lines.push(line);
            }
            if to > from {
                let set = self.d.db.prompts().for_lead(r);
                let text = set.render("wake.cap_raised", &[("maxAgents", &to), ("free", &free)]);
                self.d.ports.wake(r, WakeKind::CapRaised, text);
            }
        }
        let next = if lines.is_empty() {
            "Nothing changed.".to_owned()
        } else {
            lines.join(" ")
        };
        Ok(CapOutcome {
            slots: slots.state(),
            paused,
            next,
        })
    }

    #[allow(clippy::too_many_arguments, reason = "one event's fields")]
    fn cap_event(
        &self,
        r: Option<&ProjectRef>,
        from: i64,
        to: i64,
        running: i64,
        queued: i64,
        paused: &[TaskId],
        line: &str,
    ) -> Result<(), crate::hub::store::StoreError> {
        let count = |n: i64| Count::unchecked(n.max(0));
        let data = AgentsCapData {
            project_ref: r.cloned(),
            from: count(from),
            to: count(to),
            running: count(running),
            queued: count(queued),
            paused: (!paused.is_empty()).then(|| List::unchecked(paused.to_vec())),
        };
        self.d.events.append(NewEvent {
            at: Timestamp(self.now_iso()),
            r#type: HubEventType::AgentsCap,
            machine_id: r.map(|r| r.machine_id.clone()),
            project_id: r.map(|r| r.project_id.clone()),
            thread_id: None,
            summary: line.to_owned(),
            data: serde_json::to_value(data).ok(),
            attention: None,
        })?;
        Ok(())
    }

    /// Tells each running writer or reader above `max_agents` to push its work and end its turn, and queues it with
    /// a resume message. Its slot frees when that turn ends; the queue continues it in the same thread once one is
    /// free for it. One the node can't reach keeps running.
    async fn pause_extras(self: &Arc<Self>, r: &ProjectRef, max_agents: i64) -> Vec<TaskId> {
        let _guard = self.lock.lock().await;
        let mut paused = Vec::new();
        for holder in self.d.slots.extras(r) {
            let Ok(Some(stored)) =
                self.db(|c| TaskRecords::get(c, &TaskId::unchecked(holder.clone())))
            else {
                continue;
            };
            let task = &stored.task;
            let Some(thread) = task
                .thread_ref
                .as_ref()
                .filter(|_| task.state == TaskState::Running)
            else {
                continue;
            };
            let set = self.d.db.prompts().for_task(r, task.task_id.as_str());
            let pause = set.render("task.pause", &[("maxAgents", &max_agents)]);
            let id = request_id(task, &["pause", &task.attempt.get().to_string()]);
            if let Err(error) = self.d.ports.send(thread, &pause, &id).await {
                tracing::warn!(task_id = %holder, ?error, "pause not delivered; the agent keeps running");
                continue;
            }
            let mut next = task.clone();
            next.attempt = Int::unchecked(next.attempt.get() + 1);
            let queued = StoredTask {
                task: next,
                pending_message: Some(set.render("task.resume", &[])),
            };
            match self.queue(&queued, "paused", &paused_reason(max_agents)) {
                Ok(_) => paused.push(task.task_id.clone()),
                Err(error) => tracing::warn!(task_id = %holder, %error, "paused agent not queued"),
            }
        }
        paused
    }
}
