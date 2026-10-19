//! Who may start and steer agents: enforced on every lead-side call by the hub, whatever a prompt says or a tool list
//! offers. A lead is depth 0 and its tasks depth 1; nothing goes deeper, so a task's agent never starts another agent.
//! A lead has at most [`MAX_OPEN_TASKS`] tasks open at once.
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::tasks::TaskId;

/// A lead's tasks are depth 1; a call that would start an agent below that is refused.
pub const MAX_DEPTH: u32 = 1;
/// Open (queued, running or idle) tasks per project, the fan-out of its one lead. Slots already cap what runs at once;
/// this caps what a runaway lead can queue.
pub const MAX_OPEN_TASKS: usize = 32;

/// The calls a task's agent makes: its review verdict (`report`), a question for its lead, and a done claim.
const WORKER_OPS: &[&str] = &["review_verdict", "ask_lead", "claim_done"];
/// The calls that start an agent.
const SPAWN_OPS: &[&str] = &["task_spawn", "workstream_spawn"];

/// Which of fleetd's agents a lead-side call comes from, by the session it names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallerAgent {
    /// No fleetd session: a person's own shell.
    Person,
    /// A fleetd session that is no task's: the project's lead (or a thread a person started).
    Lead,
    /// A task's agent.
    Task(TaskId),
}

impl CallerAgent {
    pub fn depth(&self) -> u32 {
        match self {
            CallerAgent::Person | CallerAgent::Lead => 0,
            CallerAgent::Task(_) => 1,
        }
    }
}

/// Whether `agent` may make the call `op`; the refusal's `fix` says why and what to do instead.
pub fn check(agent: &CallerAgent, op: &str) -> Result<(), McpToolError> {
    match agent {
        CallerAgent::Task(task_id) => {
            let task = task_id.as_str();
            if SPAWN_OPS.contains(&op) && agent.depth() + 1 > MAX_DEPTH {
                return Err(McpToolError::new(
                    ErrorCode::Forbidden,
                    format!(
                        "{task} is a task, and a task's agent can't start agents: fleetd runs one level, a lead and \
                         its tasks."
                    ),
                )
                .with_fix(
                    "Do this work yourself. If it is too big for one task, say so with ask_lead: your lead decides \
                     whether to split it.",
                ));
            }
            if !WORKER_OPS.contains(&op) {
                return Err(McpToolError::new(
                    ErrorCode::Forbidden,
                    format!("{op} is a lead's call, and {task} is a task."),
                )
                .with_fix(
                    "A task reports its review verdict (report), asks its lead (ask_lead) and claims done \
                     (claim_done). Put anything else in your result or ask your lead.",
                ));
            }
            Ok(())
        }
        CallerAgent::Person | CallerAgent::Lead if op == "ask_lead" => Err(McpToolError::new(
            ErrorCode::Invalid,
            "ask_lead is a task's question for its lead, and this call comes from no task.",
        )
        .with_fix("A lead asks the human with ask.")),
        CallerAgent::Person | CallerAgent::Lead => Ok(()),
    }
}

/// A spawn with `open` tasks already open in the project.
pub fn check_fan_out(open: usize) -> Result<(), McpToolError> {
    if open < MAX_OPEN_TASKS {
        return Ok(());
    }
    Err(McpToolError::new(
        ErrorCode::Forbidden,
        format!(
            "This project already has {open} open tasks, the most one lead may have at once ({MAX_OPEN_TASKS})."
        ),
    )
    .with_fix(
        "End your turn: results arrive in wakes and free room. Or stop a task you no longer need with stop_agent.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> CallerAgent {
        CallerAgent::Task(TaskId::unchecked("T3"))
    }

    #[test]
    fn a_task_can_report_ask_its_lead_and_claim_done_but_never_start_or_steer_agents() {
        for op in WORKER_OPS {
            assert_eq!(check(&task(), op), Ok(()), "{op}");
        }
        for op in SPAWN_OPS {
            let refused = check(&task(), op).unwrap_err();
            assert_eq!(refused.code, ErrorCode::Forbidden);
            assert!(
                refused.message.contains("can't start agents"),
                "{}",
                refused.message
            );
            assert!(refused.fix.unwrap().contains("ask_lead"));
        }
        for op in [
            "task_message",
            "task_cancel",
            "task_list",
            "ask",
            "decide",
            "brief_create",
            "gated_run",
        ] {
            let refused = check(&task(), op).unwrap_err();
            assert_eq!(
                refused.message,
                format!("{op} is a lead's call, and T3 is a task.")
            );
        }
    }

    #[test]
    fn a_lead_and_a_person_make_every_call_but_ask_lead() {
        for agent in [CallerAgent::Lead, CallerAgent::Person] {
            for op in [
                "task_spawn",
                "workstream_spawn",
                "task_message",
                "claim_done",
                "gated_run",
            ] {
                assert_eq!(check(&agent, op), Ok(()), "{op}");
            }
            assert_eq!(
                check(&agent, "ask_lead").unwrap_err().code,
                ErrorCode::Invalid
            );
        }
    }

    #[test]
    fn spawning_stops_at_the_fan_out_limit() {
        assert_eq!(check_fan_out(MAX_OPEN_TASKS - 1), Ok(()));
        let refused = check_fan_out(MAX_OPEN_TASKS).unwrap_err();
        assert_eq!(refused.code, ErrorCode::Forbidden);
        assert!(refused.fix.unwrap().contains("stop_agent"));
    }
}
