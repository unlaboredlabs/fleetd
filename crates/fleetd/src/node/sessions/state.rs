//! The session service's decisions, kept pure so they are tested without a process: a summary's derived fields,
//! how runs close when a process ends, whether a start resumes, permission answers from policy, and the bounded
//! copies of items that go over the link.
use std::path::{Path, PathBuf};

use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::prim::Text;
use fleetd_contracts::sessions::{
    FailureClass, ItemKind, PermissionDecision, RESUME_REFUSED, RunEnd, RunFailure, RunInfo,
    RunStatus, SessionStatus, SessionSummary, ThreadItem,
};

use crate::node::runner::claude::ALWAYS_DISALLOWED;
use crate::node::runner::claude::failure;
use crate::node::runner::{ExitInfo, RunOutcome};
use crate::node::store::SessionLocal;
use crate::node::util::{head_utf16, tail_utf16};

/// Item outputs longer than this go over the link cut to their tail; `read_item` returns them whole.
pub const OUTPUT_KEPT: usize = 8 * 1024;
/// `latest_assistant_tail`'s length.
pub const ASSISTANT_TAIL: usize = 2000;

/// Recomputes what a summary derives from its runs: the latest run, the active one, and the status.
pub fn settle(summary: &mut SessionSummary, runs: &[RunInfo], at: &Timestamp) {
    // A message withdrawn (or cancelled) before claude took it in never ran: the session reads as its last real run.
    let never_ran = |r: &&RunInfo| r.status == RunStatus::Interrupted && r.started_at.is_none();
    summary.latest_run = runs
        .iter()
        .filter(|r| !never_ran(r))
        .max_by_key(|r| r.ordinal)
        .or_else(|| runs.iter().max_by_key(|r| r.ordinal))
        .cloned();
    summary.active_run_id = runs
        .iter()
        .filter(|r| r.status.is_active())
        .min_by_key(|r| r.ordinal)
        .map(|r| r.id.clone());
    if summary.active_run_id.is_none() {
        summary.pending_permission = None;
    }
    summary.status = if summary.pending_permission.is_some() {
        SessionStatus::Waiting
    } else if summary.active_run_id.is_some() {
        SessionStatus::Running
    } else {
        match summary.latest_run.as_ref().map(|r| r.status) {
            Some(RunStatus::Failed) => SessionStatus::Failed,
            Some(RunStatus::Interrupted) => SessionStatus::Interrupted,
            _ => SessionStatus::Idle,
        }
    };
    summary.updated_at = at.clone();
}

/// Why a process ended while runs were still active.
#[derive(Clone, Debug, PartialEq)]
pub enum EndCause {
    /// Someone asked: an interrupt that had to escalate, `stop`, a removed project.
    Requested(String),
    /// The node is shutting down (SIGTERM).
    NodeStopping,
    /// The node found the run active on start: it died with the previous node process.
    NodeRestarted,
    /// The agent's process exited or was killed with nobody asking.
    Exited(ExitInfo),
}

impl EndCause {
    /// Ended on purpose: by someone, or by the node stopping. A run the node is retrying ends with it.
    pub fn asked(&self) -> bool {
        matches!(self, Self::Requested(_) | Self::NodeStopping)
    }

    pub fn end(&self) -> RunEnd {
        match self {
            Self::Requested(_) => RunEnd::Requested,
            Self::NodeStopping => RunEnd::NodeStopping,
            Self::NodeRestarted => RunEnd::NodeRestarted,
            Self::Exited(_) => RunEnd::Exited,
        }
    }

    /// The reason a request was sent with.
    pub fn ended_by(&self) -> Option<Text<1, 200>> {
        match self {
            Self::Requested(why) => Text::new(head_utf16(why.trim(), 200)).ok(),
            _ => None,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Requested(why) => why.clone(),
            Self::NodeStopping => "the node stopped".into(),
            Self::NodeRestarted => "node restarted mid-run".into(),
            Self::Exited(exit) => describe_exit(exit),
        }
    }
}

/// Closes every active run of a process that is gone. A run ended on purpose or by a node restart is `Interrupted`
/// (its lead decides whether to continue it); an unexplained exit fails the run with the exit code and claude's
/// stderr. Returns the indexes of the runs it changed.
pub fn close_out(runs: &mut [RunInfo], cause: &EndCause, at: &Timestamp) -> Vec<usize> {
    let mut changed = Vec::new();
    for (index, run) in runs.iter_mut().enumerate() {
        if !run.status.is_active() {
            continue;
        }
        run.status = match cause {
            EndCause::Exited(_) => RunStatus::Failed,
            _ => RunStatus::Interrupted,
        };
        run.ended_at = Some(at.clone());
        run.failure = Some(ended_by(cause.message()));
        run.end = Some(cause.end());
        run.ended_by = cause.ended_by();
        changed.push(index);
    }
    changed
}

/// The run a runner's end of run `run_id` ends: that run while it is active, else the active one when no run has that
/// id. A run that already ended stays ended: its end told twice is never another run's, which cut a steer's run before
/// it began (T588).
pub fn ending(runs: &[RunInfo], run_id: &str) -> Option<usize> {
    if let Some(index) = runs.iter().position(|r| r.id == run_id) {
        return runs[index].status.is_active().then_some(index);
    }
    runs.iter().position(|r| r.status.is_active())
}

/// Why a run claude ended itself (with a `result`, or cut by an interrupt) ended. `asked`: why the node was asked
/// to end it, if it was; `slept`: the node cut it after the machine woke.
pub fn run_end(outcome: &RunOutcome, asked: Option<&EndCause>, slept: bool) -> RunEnd {
    match outcome {
        RunOutcome::Completed { .. } => RunEnd::Completed,
        RunOutcome::Superseded { .. } => RunEnd::Superseded,
        _ if slept => RunEnd::MachineSlept,
        RunOutcome::Interrupted => asked.map_or(RunEnd::Requested, EndCause::end),
        RunOutcome::Failed(failure) => failure_end(failure),
    }
}

/// The end of a run claude failed.
pub fn failure_end(failure: &RunFailure) -> RunEnd {
    match failure.class {
        FailureClass::UsageLimit | FailureClass::RateLimit | FailureClass::PoolExhausted => {
            RunEnd::Limited
        }
        FailureClass::ProcessExited => RunEnd::Exited,
        FailureClass::InvalidRequest if failure::context_full_text(&failure.message) => {
            RunEnd::ContextFull
        }
        _ => RunEnd::Failed,
    }
}

/// The failure of a run that ended because of `message`: a request, a restart or an exit.
pub fn ended_by(message: String) -> RunFailure {
    RunFailure {
        class: FailureClass::ProcessExited,
        message: Text::new(message.clone())
            .unwrap_or_else(|_| Text::unchecked(tail_utf16(&message, 4000))),
        api_status: None,
        reset_at: None,
        retries: 0,
        model: None,
    }
}

fn describe_exit(exit: &ExitInfo) -> String {
    let how = match (exit.code, exit.signal) {
        (_, Some(signal)) => format!("the agent was killed by signal {signal}"),
        (Some(code), None) => format!("the agent exited with code {code}"),
        (None, None) => "the agent exited".to_owned(),
    };
    let stderr = exit.stderr_tail.trim();
    if stderr.is_empty() {
        format!("{how} before the run ended")
    } else {
        format!("{how} before the run ended\n--- stderr tail ---\n{stderr}")
    }
}

/// `<claude config dir>/projects/<cwd, every non-alphanumeric character as ->/<session id>.jsonl`: where claude
/// keeps the session `--resume` needs.
pub fn claude_session_file(config_dir: &Path, cwd: &Path, session_id: &str) -> PathBuf {
    let key: String = cwd
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    config_dir
        .join("projects")
        .join(key)
        .join(format!("{session_id}.jsonl"))
}

/// Whether the next start resumes, or why it must not start at all. A session claude has a file for resumes only
/// in the config dir it was started with: starting it under another one would silently begin an empty
/// conversation, so that is refused.
pub fn start_mode(
    local: &SessionLocal,
    config_dir: &Path,
    session_id: &str,
) -> Result<bool, String> {
    if !local.started {
        return Ok(false);
    }
    if local.config_dir != config_dir
        && claude_session_file(&local.config_dir, &local.cwd, session_id).exists()
    {
        return Err(format!(
            "{RESUME_REFUSED}session {session_id} was started with the claude config dir {} and cannot resume under {}: claude \
             keeps the conversation there. Point the machine back at it (\"claudeConfigDir\": \"{}\" in the node's \
             node.json, then restart the node), or start a new session",
            local.config_dir.display(),
            config_dir.display(),
            local.config_dir.display()
        ));
    }
    Ok(true)
}

/// A permission prompt the node answers without asking anyone: everything under full access (bypassPermissions
/// rarely asks, but an ask must never wedge a run), and tools fleetd never gives an agent.
pub fn auto_answer(
    mode: RuntimeMode,
    tool_name: &str,
    input: &serde_json::Value,
) -> Option<PermissionDecision> {
    if ALWAYS_DISALLOWED.contains(&tool_name) {
        return Some(PermissionDecision::Deny {
            message: Text::unchecked(format!(
                "fleetd policy: {tool_name} is not available to fleetd sessions"
            )),
        });
    }
    match mode {
        RuntimeMode::FullAccess => Some(PermissionDecision::Allow {
            updated_input: Some(input.clone()),
        }),
        RuntimeMode::ApprovalRequired => None,
    }
}

/// The copy of an item that goes over the link: outputs over [`OUTPUT_KEPT`] cut to their tail.
pub fn bounded(item: &ThreadItem) -> ThreadItem {
    let mut item = item.clone();
    let (output, omitted) = match &mut item.kind {
        ItemKind::Command {
            output,
            output_omitted,
            ..
        }
        | ItemKind::Tool {
            output,
            output_omitted,
            ..
        } => (output, output_omitted),
        _ => return item,
    };
    if let Some(text) = output.as_mut()
        && text.len() > OUTPUT_KEPT
    {
        let mut start = text.len() - OUTPUT_KEPT;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text.drain(..start);
        *omitted = true;
    }
    item
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::effort::Effort;
    use fleetd_contracts::ids::{ProjectId, ThreadId};
    use fleetd_contracts::prim::NonEmpty;
    use fleetd_contracts::sessions::{ItemStatus, PendingPermission};

    fn run(id: &str, ordinal: u64, status: RunStatus) -> RunInfo {
        RunInfo {
            id: NonEmpty::unchecked(id),
            status,
            ordinal,
            queued_at: None,
            started_at: None,
            ended_at: None,
            failure: None,
            usage: None,
            superseded_by: None,
            end: None,
            ended_by: None,
        }
    }

    fn summary() -> SessionSummary {
        SessionSummary {
            session_id: ThreadId::unchecked("s1"),
            project_id: ProjectId::unchecked("p1"),
            title: "t".into(),
            status: SessionStatus::Idle,
            model: "claude-haiku-5-5".into(),
            effort: Effort::Low,
            runtime_mode: RuntimeMode::ApprovalRequired,
            latest_run: None,
            active_run_id: None,
            pending_permission: None,
            latest_assistant_tail: None,
            branch: None,
            worktree_path: None,
            recreated_from: None,
            recreated_at: None,
            created_at: Timestamp::from("t0"),
            updated_at: Timestamp::from("t0"),
        }
    }

    #[test]
    fn a_summary_follows_its_runs() {
        let at = Timestamp::from("t1");
        let mut s = summary();
        // A send queued behind a running run: the running one is active, the queued one is latest.
        let mut runs = vec![
            run("r1", 1, RunStatus::Running),
            run("r2", 2, RunStatus::Queued),
        ];
        settle(&mut s, &runs, &at);
        assert_eq!(s.status, SessionStatus::Running);
        assert_eq!(s.active_run_id.as_deref(), Some("r1"));
        assert_eq!(s.latest_run.as_ref().unwrap().id, "r2");

        s.pending_permission = Some(PendingPermission {
            request_id: NonEmpty::unchecked("q1"),
            tool_name: NonEmpty::unchecked("Write"),
            summary: Text::unchecked("x"),
        });
        settle(&mut s, &runs, &at);
        assert_eq!(s.status, SessionStatus::Waiting);

        // Both end: a prompt can't outlive its run, and the latest run's outcome is the session's.
        runs[0].status = RunStatus::Completed;
        runs[1].status = RunStatus::Failed;
        settle(&mut s, &runs, &at);
        assert_eq!(s.status, SessionStatus::Failed);
        assert_eq!(s.active_run_id, None);
        assert_eq!(s.pending_permission, None);
    }

    #[test]
    fn a_dead_process_closes_its_active_runs_by_cause() {
        let at = Timestamp::from("t1");
        let base = vec![
            run("r1", 1, RunStatus::Completed),
            run("r2", 2, RunStatus::Waiting),
        ];

        let mut runs = base.clone();
        assert_eq!(close_out(&mut runs, &EndCause::NodeRestarted, &at), [1]);
        assert_eq!(runs[0].status, RunStatus::Completed);
        assert_eq!(runs[1].status, RunStatus::Interrupted);
        assert_eq!(
            runs[1].failure.as_ref().unwrap().message.as_str(),
            "node restarted mid-run"
        );

        assert_eq!(runs[0].end, None);
        assert_eq!(runs[1].end, Some(RunEnd::NodeRestarted));
        assert_eq!(runs[1].ended_by, None);

        let mut runs = base.clone();
        close_out(&mut runs, &EndCause::NodeStopping, &at);
        assert_eq!(runs[1].status, RunStatus::Interrupted);
        assert_eq!(runs[1].end, Some(RunEnd::NodeStopping));
        assert_eq!(
            runs[1].failure.as_ref().unwrap().message.as_str(),
            "the node stopped"
        );

        let mut runs = base.clone();
        close_out(&mut runs, &EndCause::Requested("watchdog".into()), &at);
        assert_eq!(runs[1].status, RunStatus::Interrupted);
        assert_eq!(runs[1].end, Some(RunEnd::Requested));
        assert_eq!(runs[1].ended_by.as_ref().unwrap().as_str(), "watchdog");

        let mut runs = base;
        let exit = ExitInfo {
            code: None,
            signal: Some(9),
            stderr_tail: "boom\n".into(),
        };
        close_out(&mut runs, &EndCause::Exited(exit), &at);
        let failure = runs[1].failure.as_ref().unwrap();
        assert_eq!(runs[1].status, RunStatus::Failed);
        assert_eq!(runs[1].end, Some(RunEnd::Exited));
        assert_eq!(failure.class, FailureClass::ProcessExited);
        assert_eq!(
            failure.message.as_str(),
            "the agent was killed by signal 9 before the run ended\n--- stderr tail ---\nboom"
        );
    }

    #[test]
    fn a_run_ends_once_and_its_second_end_is_no_other_runs() {
        let runs = [
            run("r1", 1, RunStatus::Interrupted),
            run("r2", 2, RunStatus::Running),
            run("r3", 3, RunStatus::Queued),
        ];
        assert_eq!(ending(&runs, "r2"), Some(1));
        assert_eq!(ending(&runs, "r1"), None);
        // An end that names no run of the session's is the active run's.
        assert_eq!(ending(&runs, "claude-own"), Some(1));
        assert_eq!(ending(&runs[..1], "r2"), None);
    }

    #[test]
    fn a_run_claude_ended_says_why() {
        let failed = |class, message: &str| {
            RunOutcome::Failed(RunFailure {
                class,
                message: Text::unchecked(message),
                api_status: None,
                reset_at: None,
                retries: 0,
                model: None,
            })
        };
        let completed = RunOutcome::Completed { text: "ok".into() };
        let stopping = EndCause::NodeStopping;
        let lead = EndCause::Requested("interrupted through fleetd".into());
        let cases = [
            (run_end(&completed, None, false), RunEnd::Completed),
            // A turn that completed after the machine woke is just completed.
            (run_end(&completed, None, true), RunEnd::Completed),
            (
                run_end(&RunOutcome::Superseded { by: "r2".into() }, None, false),
                RunEnd::Superseded,
            ),
            (
                run_end(&RunOutcome::Interrupted, Some(&lead), false),
                RunEnd::Requested,
            ),
            (
                run_end(&RunOutcome::Interrupted, Some(&stopping), false),
                RunEnd::NodeStopping,
            ),
            (
                run_end(&RunOutcome::Interrupted, None, false),
                RunEnd::Requested,
            ),
            (
                run_end(&failed(FailureClass::Network, "stream lost"), None, true),
                RunEnd::MachineSlept,
            ),
            (
                run_end(
                    &failed(FailureClass::UsageLimit, "You've hit your limit"),
                    None,
                    false,
                ),
                RunEnd::Limited,
            ),
            (
                run_end(&failed(FailureClass::RateLimit, "429"), None, false),
                RunEnd::Limited,
            ),
            (
                run_end(
                    &failed(FailureClass::PoolExhausted, "no account"),
                    None,
                    false,
                ),
                RunEnd::Limited,
            ),
            (
                run_end(
                    &failed(FailureClass::InvalidRequest, "Prompt is too long"),
                    None,
                    false,
                ),
                RunEnd::ContextFull,
            ),
            (
                run_end(
                    &failed(FailureClass::InvalidRequest, "model not found"),
                    None,
                    false,
                ),
                RunEnd::Failed,
            ),
            (
                run_end(
                    &failed(FailureClass::ProcessExited, "claude exited with code 1"),
                    None,
                    false,
                ),
                RunEnd::Exited,
            ),
            (
                run_end(&failed(FailureClass::Auth, "Not logged in"), None, false),
                RunEnd::Failed,
            ),
            (
                run_end(&failed(FailureClass::Overloaded, "529"), None, false),
                RunEnd::Failed,
            ),
        ];
        for (index, (got, want)) in cases.into_iter().enumerate() {
            assert_eq!(got, want, "case {index}");
        }
        assert_eq!(
            lead.ended_by().unwrap().as_str(),
            "interrupted through fleetd"
        );
        assert_eq!(stopping.ended_by(), None);
        let long = EndCause::Requested("x".repeat(300));
        assert_eq!(long.ended_by().unwrap().as_str().len(), 200);
    }

    #[test]
    fn a_started_session_resumes_only_in_its_own_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("claude-old");
        let new = dir.path().join("claude-new");
        let mut local = SessionLocal {
            cwd: "/work/my_project.x".into(),
            add_dirs: vec![],
            config_dir: old.clone(),
            workspace_root: "/work".into(),
            base_ref: None,
            branch: None,
            started: false,
            pid: None,
            pid_start: None,
            allowed_tools: vec![],
            disallowed_tools: vec![],
            role: Default::default(),
            order_id: None,
            setup: None,
            setup_pending: false,
        };
        assert_eq!(start_mode(&local, &new, "s1"), Ok(false));
        local.started = true;
        assert_eq!(start_mode(&local, &old, "s1"), Ok(true));
        // No session file under the old dir (claude never got far): nothing to lose.
        assert_eq!(start_mode(&local, &new, "s1"), Ok(true));
        let file = claude_session_file(&old, &local.cwd, "s1");
        assert!(file.ends_with("projects/-work-my-project-x/s1.jsonl"));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "{}\n").unwrap();
        assert!(start_mode(&local, &new, "s1").is_err_and(|e| e.starts_with(RESUME_REFUSED)));
    }

    #[test]
    fn policy_answers_full_access_and_denied_tools_and_asks_otherwise() {
        let input = serde_json::json!({"command": "rm -rf build"});
        assert!(matches!(
            auto_answer(RuntimeMode::FullAccess, "Bash", &input),
            Some(PermissionDecision::Allow { updated_input: Some(i) }) if i == input
        ));
        assert_eq!(
            auto_answer(RuntimeMode::ApprovalRequired, "Bash", &input),
            None
        );
        assert!(matches!(
            auto_answer(RuntimeMode::FullAccess, "AskUserQuestion", &input),
            Some(PermissionDecision::Deny { .. })
        ));
    }

    #[test]
    fn long_outputs_go_out_as_their_tail() {
        let item = |output: String| ThreadItem {
            id: NonEmpty::unchecked("t1"),
            run_id: None,
            status: ItemStatus::Completed,
            title: "Bash".into(),
            started_at: Timestamp::from("t"),
            completed_at: None,
            updated_at: Timestamp::from("t"),
            kind: ItemKind::Command {
                command: "cat big".into(),
                timeout_ms: None,
                output: Some(output),
                output_omitted: false,
                exit_code: Some(0),
            },
        };
        let short = item("ok".into());
        assert_eq!(bounded(&short), short);
        // A multi-byte character straddling the cut is dropped whole, never split.
        let long = format!("{}é{}", "a".repeat(10), "b".repeat(OUTPUT_KEPT - 1));
        let ItemKind::Command {
            output,
            output_omitted,
            ..
        } = bounded(&item(long)).kind
        else {
            unreachable!()
        };
        assert!(output_omitted);
        assert_eq!(output.unwrap(), "b".repeat(OUTPUT_KEPT - 1));
    }
}
