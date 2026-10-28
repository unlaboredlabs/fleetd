//! Who may start and steer agents: enforced on every lead-side call by the hub, whatever a prompt says or a tool list
//! offers. A lead is depth 0 and its tasks depth 1; nothing goes deeper, so a task's agent never starts another agent.
//! A lead has at most [`max_open_tasks`] tasks open at once.
use fleetd_contracts::browser::BrowserSessionState;
use fleetd_contracts::lead_calls::LeadCall;
use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::memory::MemoryScope;
use fleetd_contracts::preview::PreviewId;
use fleetd_contracts::tasks::TaskId;

/// A lead's tasks are depth 1; a call that would start an agent below that is refused.
pub const MAX_DEPTH: u32 = 1;
/// Open (queued, running or idle) tasks per project, the fan-out of its one lead, at least. Slots already cap what runs
/// at once; this caps what a runaway lead can queue.
pub const MAX_OPEN_TASKS: usize = 32;

/// The open tasks a project's lead may have: [`MAX_OPEN_TASKS`], or twice its max agents on a machine that runs more,
/// so a 56-agent server isn't held to 32.
pub fn max_open_tasks(max_agents: i64) -> usize {
    MAX_OPEN_TASKS.max(2 * max_agents.max(0) as usize)
}

/// The calls a task's agent makes: its review verdict (`report`), a question for its lead, reading its brief, its
/// project's decisions and its PRs' reviews, and Try it's suggestion and proposed setting (never a preview's start:
/// only the person or a lead answering them starts one, D161). Only a lead closes work.
pub const WORKER_OPS: &[&str] = &[
    "review_verdict",
    "ask_lead",
    "brief_read",
    "decisions_search",
    "review_read",
    "preview_suggest",
    "preview_config_propose",
];
/// The calls a task's node makes for it: its browser sessions (node/browser).
pub const NODE_OPS: &[&str] = &[
    "browser_session",
    "browser_recording_part",
    "browser_takeover",
    "session_route",
    "session_step",
];
/// What an ended preview's session still sends: its recording, and its report as it closes.
pub const ENDED_PREVIEW_OPS: &[&str] = &["browser_session", "browser_recording_part"];
/// The calls that start an agent.
pub const SPAWN_OPS: &[&str] = &["task_spawn"];
/// The only calls of a nightly memory refresh's session (hub/memory/refresh).
pub const MEMORY_REFRESH_OPS: &[&str] = &["memory_read", "remember", "forget"];

/// Which of fleetd's agents a lead-side call comes from, by the session it names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallerAgent {
    /// No fleetd session: a person's own shell.
    Person,
    /// A fleetd session that is no task's: the project's lead (or a thread a person started).
    Lead,
    /// A task's agent.
    Task(TaskId),
    /// No agent: a preview's browser session, which the person holds from the start (hub/preview). Its node reports
    /// the session and uploads its recording under the preview's id.
    Preview(PreviewId),
    /// That session once its preview ended, for as long as its node may still upload (hub/preview's
    /// `HELD_UPLOAD_MS`): it only uploads its recording and reports itself closing.
    EndedPreview(PreviewId),
    /// A project's nightly memory refresh: a lead session of its own that only reads and writes memory.
    MemoryRefresh,
}

impl CallerAgent {
    pub fn depth(&self) -> u32 {
        match self {
            CallerAgent::Person | CallerAgent::Lead | CallerAgent::MemoryRefresh => 0,
            CallerAgent::Task(_) | CallerAgent::Preview(_) | CallerAgent::EndedPreview(_) => 1,
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
            if !WORKER_OPS.contains(&op) && !NODE_OPS.contains(&op) {
                return Err(McpToolError::new(
                    ErrorCode::Forbidden,
                    format!("{op} is a lead's call, and {task} is a task."),
                )
                .with_fix(
                    "A task reports its review verdict (report), asks its lead (ask_lead), reads its brief \
                     (brief_read), decisions (decisions_search) and its PRs' reviews (review_read), and may suggest \
                     the person try its PR (preview_suggest) or propose how to run it (preview_config_propose). Put \
                     anything else in your result or ask your lead.",
                ));
            }
            Ok(())
        }
        CallerAgent::Preview(preview) if !NODE_OPS.contains(&op) => Err(McpToolError::new(
            ErrorCode::Forbidden,
            format!(
                "{op} isn't a call of preview {preview}'s session, which only reports itself and its recording."
            ),
        )),
        CallerAgent::Preview(_) => Ok(()),
        CallerAgent::EndedPreview(preview) if !ENDED_PREVIEW_OPS.contains(&op) => {
            Err(McpToolError::new(
                ErrorCode::Forbidden,
                format!(
                    "preview {preview} has ended: its session only uploads its recording and reports itself closing."
                ),
            ))
        }
        CallerAgent::EndedPreview(_) => Ok(()),
        CallerAgent::MemoryRefresh if !MEMORY_REFRESH_OPS.contains(&op) => Err(McpToolError::new(
            ErrorCode::Forbidden,
            format!("{op} isn't a call of the nightly memory refresh, which only reads and writes memory."),
        )
        .with_fix("Use memory_read, remember and forget only, then end your turn.")),
        CallerAgent::MemoryRefresh => Ok(()),
        CallerAgent::Person | CallerAgent::Lead if op == "ask_lead" => Err(McpToolError::new(
            ErrorCode::Invalid,
            "ask_lead is a task's question for its lead, and this call comes from no task.",
        )
        .with_fix("A lead asks the human with ask.")),
        CallerAgent::Person | CallerAgent::Lead if op == "brief_read" => Err(McpToolError::new(
            ErrorCode::Invalid,
            "brief_read reads a task's own brief, and this call comes from no task.",
        )
        .with_fix("A lead reads its workstreams' briefs in its state block.")),
        CallerAgent::Person | CallerAgent::Lead => Ok(()),
    }
}

/// [`check`], and what only the call itself says: an ended preview's session reports itself closing, never live.
pub fn check_call(agent: &CallerAgent, call: &LeadCall) -> Result<(), McpToolError> {
    check(agent, &fleetd_contracts::lead_calls::op_name(call))?;
    // The refresh adds to a person's own memory, but never changes or removes what is there.
    let user_md_changed = match call {
        LeadCall::Remember(c) => c.scope == MemoryScope::User && c.replaces.is_some(),
        LeadCall::Forget(c) => c.scope == MemoryScope::User,
        _ => false,
    };
    if *agent == CallerAgent::MemoryRefresh && user_md_changed {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            "The nightly refresh only adds to user memory: it never replaces or removes an entry there.",
        )
        .with_fix("Add the lesson as a new user memory entry, or leave user memory as it is."));
    }
    if let (CallerAgent::EndedPreview(preview), LeadCall::BrowserSession(report)) = (agent, call)
        && matches!(
            report.state,
            BrowserSessionState::Live | BrowserSessionState::Expired
        )
    {
        return Err(McpToolError::new(
            ErrorCode::Forbidden,
            format!(
                "preview {preview} has ended, so its session can't be {}: it only reports itself closing.",
                report.state.as_str()
            ),
        ));
    }
    Ok(())
}

/// A spawn with `open` tasks already open in the project, whose max agents is `max_agents`.
pub fn check_fan_out(open: usize, max_agents: i64) -> Result<(), McpToolError> {
    let most = max_open_tasks(max_agents);
    if open < most {
        return Ok(());
    }
    Err(McpToolError::new(
        ErrorCode::Forbidden,
        format!("This project already has {open} open tasks, the most one lead may have at once ({most})."),
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
    fn a_task_can_report_and_ask_its_lead_but_never_start_steer_or_close() {
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
            "close",
            "gated_run",
            "claim_done",
            "preview_start",
        ] {
            let refused = check(&task(), op).unwrap_err();
            assert_eq!(
                refused.message,
                format!("{op} is a lead's call, and T3 is a task.")
            );
        }
    }

    #[test]
    fn a_lead_and_a_person_make_every_call_but_a_tasks_own() {
        for agent in [CallerAgent::Lead, CallerAgent::Person] {
            for op in ["task_spawn", "task_message", "close", "gated_run"] {
                assert_eq!(check(&agent, op), Ok(()), "{op}");
            }
            assert_eq!(
                check(&agent, "ask_lead").unwrap_err().code,
                ErrorCode::Invalid
            );
        }
    }

    #[test]
    fn a_previews_session_only_reports_itself() {
        let preview = CallerAgent::Preview(PreviewId::unchecked(format!("P{}", "a".repeat(32))));
        for op in NODE_OPS {
            assert_eq!(check(&preview, op), Ok(()), "{op}");
        }
        for op in [
            "task_spawn",
            "preview_start",
            "preview_suggest",
            "ask_lead",
            "gated_run",
        ] {
            assert_eq!(
                check(&preview, op).unwrap_err().code,
                ErrorCode::Forbidden,
                "{op}"
            );
        }
    }

    #[test]
    fn an_ended_previews_session_only_uploads_and_reports_itself_closing() {
        let ended = CallerAgent::EndedPreview(PreviewId::unchecked(format!("P{}", "a".repeat(32))));
        for op in ENDED_PREVIEW_OPS {
            assert_eq!(check(&ended, op), Ok(()), "{op}");
        }
        for op in ["browser_takeover", "session_route", "preview_suggest"] {
            assert_eq!(
                check(&ended, op).unwrap_err().code,
                ErrorCode::Forbidden,
                "{op}"
            );
        }
        let report = |state: &str| -> LeadCall {
            serde_json::from_value(serde_json::json!({
                "op": "browser_session", "sessionId": format!("B{}", "c".repeat(32)), "threadId": "t",
                "purpose": "Try #14", "state": state, "startedAt": "2026-10-26T10:00:00.000Z", "files": [],
            }))
            .unwrap()
        };
        for state in ["uploading", "recorded", "lost"] {
            assert_eq!(check_call(&ended, &report(state)), Ok(()), "{state}");
        }
        for state in ["live", "expired"] {
            assert_eq!(
                check_call(&ended, &report(state)).unwrap_err().code,
                ErrorCode::Forbidden,
                "{state}"
            );
        }
        let running = CallerAgent::Preview(PreviewId::unchecked(format!("P{}", "a".repeat(32))));
        assert_eq!(check_call(&running, &report("live")), Ok(()));
    }

    #[test]
    fn spawning_stops_at_the_fan_out_limit() {
        assert_eq!(check_fan_out(MAX_OPEN_TASKS - 1, 12), Ok(()));
        let refused = check_fan_out(MAX_OPEN_TASKS, 12).unwrap_err();
        assert_eq!(refused.code, ErrorCode::Forbidden);
        assert!(refused.fix.unwrap().contains("stop_agent"));
    }

    /// A big server's 56 agents get 112 open tasks, not 32.
    #[test]
    fn the_fan_out_limit_grows_with_max_agents() {
        assert_eq!(max_open_tasks(2), 32);
        assert_eq!(max_open_tasks(16), 32);
        assert_eq!(max_open_tasks(56), 112);
        assert_eq!(check_fan_out(100, 56), Ok(()));
        assert!(check_fan_out(112, 56).is_err());
    }
}
