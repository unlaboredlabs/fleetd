//! A project's max agents, a machine's cap and the fleet cap, as a person sets them (`cap_set`, `fleetd project set`,
//! `fleetd machine set`), each a number or back to auto. The slot board enforces them at every start; this is the change itself: lowering stops nothing (running agents finish their work,
//! new ones wait) unless the extras are paused, raising starts queued agents at once and wakes the lead, and every
//! change is one `agents.cap` event whose summary is the chat's quiet line.
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef, Timestamp};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::prim::{Count, Int, List};
use fleetd_contracts::tasks::{AgentsCapData, SlotState, TaskId, TaskState};

use super::ports::{TaskError, WakeKind};
use super::{StoredTask, TaskRecords, Tasks, lead_error, request_id, store_error};
use crate::hub::slots::CapInput;
use crate::hub::store::NewEvent;

/// Each part: None leaves it alone.
pub struct CapChange {
    /// Some(None): unset, so the machines' caps added up are the only limit across projects.
    pub cap: Option<Option<i64>>,
    pub project: Option<ProjectCap>,
    pub machine: Option<MachineCap>,
}

pub struct ProjectCap {
    pub project_ref: ProjectRef,
    /// None: auto, its machine's cap.
    pub max_agents: Option<i64>,
    /// Lowering: pause the agents above the new max now instead of letting them finish.
    pub pause_extras: bool,
}

pub struct MachineCap {
    pub machine_id: MachineId,
    /// None: auto, what the machine fits.
    pub max_agents: Option<i64>,
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

/// The chat line for a project cap that paused the extras: lowered, or kept where it was.
pub fn paused_line(from: i64, to: i64, paused: i64, running: i64) -> String {
    let (push, keep) = (
        if paused == 1 {
            "pushes its work and waits"
        } else {
            "push their work and wait"
        },
        if running == 1 { "keeps" } else { "keep" },
    );
    // The app lowers the max first and offers the pause after it, at the same max.
    let change = if to < from {
        format!("{from} → {to}")
    } else {
        to.to_string()
    };
    format!(
        "Max agents {change}: {} {push}; {running} {keep} running.",
        plural(paused, "agent", "agents")
    )
}

/// The chat line for a raised project cap: what started, if anything did.
pub fn raised_line(from: i64, to: i64, started: i64, free: i64) -> String {
    if started == 0 {
        return format!("Max agents {from} → {to}.");
    }
    format!(
        "Max agents {from} → {to}: {} now, {} free.",
        plural(started, "queued agent starts", "queued agents start"),
        plural(free, "slot", "slots")
    )
}

/// A paused agent's reason, as its task shows it while it waits.
pub fn paused_reason(max_agents: i64) -> String {
    format!("paused: max agents lowered to {max_agents}; resumes when a slot frees")
}

impl Tasks {
    pub async fn set_caps(self: &Arc<Self>, change: CapChange) -> Result<CapOutcome, TaskError> {
        let slots = &self.d.slots;
        // Unset until someone sets it: the machines' own caps are the only limit across projects.
        let (cap_before, total_before) = (slots.cap(), slots.total());
        if let Some(p) = &change.project
            && let Some(n) = p.max_agents
            && let Some(cap) = change.cap.unwrap_or(cap_before)
            && n > cap
        {
            return Err(lead_error(
                ErrorCode::Invalid,
                format!("Max agents {n} is above the fleet's {cap} slots."),
                Some(&format!("Pick 1 to {cap}, or raise the fleet cap first.")),
            ));
        }
        let machine_row = |m: &MachineId| {
            slots
                .state()
                .per_machine
                .iter()
                .find(|x| x.machine_id == *m)
                .map(|x| (x.cap.get(), x.set))
        };
        let machine_before = change.machine.as_ref().map(|c| {
            machine_row(&c.machine_id).unwrap_or((slots.machine_cap(&c.machine_id), false))
        });
        let before = change.project.as_ref().map(|p| {
            (
                slots.agents(&p.project_ref),
                slots.max_agents_set(&p.project_ref),
            )
        });
        // The board grants every queued claim that now fits before this returns; the release listener starts them.
        slots
            .set_cap(CapInput {
                cap: change.cap,
                max_agents: change
                    .project
                    .as_ref()
                    .map(|p| (p.project_ref.clone(), p.max_agents)),
                machine: change
                    .machine
                    .as_ref()
                    .map(|m| (m.machine_id.clone(), m.max_agents)),
            })
            .map_err(store_error)?;

        let mut paused = Vec::new();
        let mut lines = Vec::new();
        if let Some(cap) = change.cap
            && cap != cap_before
        {
            let after = slots.state();
            let total = slots.total();
            let change = match (cap_before, cap) {
                (Some(before), Some(cap)) => format!("Fleet cap {before} → {cap}"),
                (None, Some(cap)) => {
                    format!("Fleet cap set to {cap} (the machines fit {total_before})")
                }
                (Some(before), None) => {
                    format!("Fleet cap {before} unset (the machines fit {total})")
                }
                (None, None) => unreachable!("an unchanged cap"),
            };
            let line = if total > total_before {
                format!("{change}: queued agents start as slots allow.")
            } else {
                format!("{change}: running agents finish; new ones wait.")
            };
            self.cap_event(
                None,
                None,
                cap_before.unwrap_or(total_before),
                total,
                after.used.get(),
                after.queued.get(),
                &[],
                &line,
            )
            .map_err(store_error)?;
            lines.push(line);
        }
        if let (Some(c), Some((from, was_set))) = (&change.machine, machine_before) {
            let m = &c.machine_id;
            let after = slots.state();
            let row = after.per_machine.iter().find(|x| x.machine_id == *m);
            let (to, auto, why) = row.map_or((from, from, String::new()), |x| {
                (x.cap.get(), x.auto.get(), x.why.as_str().to_owned())
            });
            if to != from || was_set != c.max_agents.is_some() {
                let to_text = match c.max_agents {
                    Some(_) => to.to_string(),
                    None => format!("auto, {to} ({why})"),
                };
                let mut line = format!("Machine cap on {m} {from} → {to_text}");
                if c.max_agents.is_some() && to > auto {
                    line.push_str(&format!(", above the {auto} it fits ({why})"));
                }
                line.push_str(if to > from {
                    ": queued agents start as slots allow."
                } else if to < from {
                    ": running agents finish; new ones wait."
                } else {
                    "."
                });
                let running = row.map_or(0, |x| x.running.get());
                self.cap_event(
                    None,
                    Some(m),
                    from,
                    to,
                    running,
                    after.queued.get(),
                    &[],
                    &line,
                )
                .map_err(store_error)?;
                lines.push(line);
            }
        }
        if let (Some(p), Some((before, set_before))) = (&change.project, before) {
            let r = &p.project_ref;
            let from = before.max_agents;
            // Never above its machine's cap: no more than that run there.
            let to = slots.agents(r).max_agents;
            // At the same max too: the app applies a lower max first and offers the pause after it.
            if to <= from && p.pause_extras {
                paused = self.pause_extras(r, to).await;
            }
            let after = slots.agents(r);
            let free = slots.room(r);
            let mut line = if to > from {
                raised_line(from, to, (after.running - before.running).max(0), free)
            } else if !paused.is_empty() {
                paused_line(
                    from,
                    to,
                    paused.len() as i64,
                    (after.running - paused.len() as i64).max(0),
                )
            } else if to < from && after.running > to {
                let finish = if after.running == 1 {
                    "finishes its work"
                } else {
                    "finish their work"
                };
                format!(
                    "Max agents {from} → {to}: {} running {finish}; new agents wait.",
                    after.running
                )
            } else {
                format!("Max agents {from} → {to}.")
            };
            let m = &r.machine_id;
            match p.max_agents {
                None => line.push_str(&format!(" Auto: {m}'s cap.")),
                Some(n) if n > to => line.push_str(&format!(
                    " Set to {n}, but {m} runs at most {to}, so {to} is what counts."
                )),
                Some(_) => {}
            }
            if to != from || !paused.is_empty() || set_before != p.max_agents {
                self.cap_event(
                    Some(r),
                    Some(m),
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
                let text = crate::hub::leads::events::Event::CapRaised {
                    max_agents: to,
                    free,
                }
                .render();
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
        machine: Option<&MachineId>,
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
            machine_id: machine.cloned(),
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
    /// free for it. One the node can't reach, or one waiting on its lead's answer, keeps running.
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
            if self.asking.lock().unwrap().contains(&task.task_id) {
                continue;
            }
            let set = self
                .d
                .db
                .prompts()
                .for_thread(&thread.machine_id, thread.thread_id.as_str());
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
