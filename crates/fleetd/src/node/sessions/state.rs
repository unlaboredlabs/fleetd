//! The session service's decisions, kept pure so they are tested without a process: a summary's derived fields,
//! how runs close when a process ends, whether a start resumes, permission answers from policy, and the bounded
//! copies of items that go over the link.
use std::path::{Path, PathBuf};

use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::prim::Text;
use fleetd_contracts::sessions::{
    FailureClass, ItemKind, PermissionDecision, RunFailure, RunInfo, RunStatus, SessionStatus,
    SessionSummary, ThreadItem,
};

use crate::node::runner::ExitInfo;
use crate::node::runner::claude::ALWAYS_DISALLOWED;
use crate::node::store::SessionLocal;
use crate::node::util::tail_utf16;

/// Item outputs longer than this go over the link cut to their tail; `read_item` returns them whole.
pub const OUTPUT_KEPT: usize = 8 * 1024;
/// `latest_assistant_tail`'s length.
pub const ASSISTANT_TAIL: usize = 2000;

/// Recomputes what a summary derives from its runs: the latest run, the active one, and the status.
pub fn settle(summary: &mut SessionSummary, runs: &[RunInfo], at: &Timestamp) {
    summary.latest_run = runs.iter().max_by_key(|r| r.ordinal).cloned();
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
    /// Someone asked: an interrupt that had to escalate, `stop`, or the node shutting down.
    Requested(String),
    /// The node found the run active on start: it died with the previous node process.
    NodeRestarted,
    /// claude exited or was killed with nobody asking.
    Exited(ExitInfo),
}

/// Closes every active run of a process that is gone. A run ended by request or by a node restart is
/// `Interrupted` (the hub's watchdog decides whether to continue it); an unexplained exit fails the run with the exit
/// code and claude's stderr. Returns the indexes of the runs it changed.
pub fn close_out(runs: &mut [RunInfo], cause: &EndCause, at: &Timestamp) -> Vec<usize> {
    let mut changed = Vec::new();
    for (index, run) in runs.iter_mut().enumerate() {
        if !run.status.is_active() {
            continue;
        }
        let (status, message) = match cause {
            EndCause::Requested(why) => (RunStatus::Interrupted, why.clone()),
            EndCause::NodeRestarted => (RunStatus::Interrupted, "node restarted mid-run".into()),
            EndCause::Exited(exit) => (RunStatus::Failed, describe_exit(exit)),
        };
        run.status = status;
        run.ended_at = Some(at.clone());
        run.failure = Some(RunFailure {
            class: FailureClass::ProcessExited,
            message: Text::new(message.clone())
                .unwrap_or_else(|_| Text::unchecked(tail_utf16(&message, 4000))),
            api_status: None,
            reset_at: None,
            retries: 0,
        });
        changed.push(index);
    }
    changed
}

fn describe_exit(exit: &ExitInfo) -> String {
    let how = match (exit.code, exit.signal) {
        (_, Some(signal)) => format!("claude was killed by signal {signal}"),
        (Some(code), None) => format!("claude exited with code {code}"),
        (None, None) => "claude exited".to_owned(),
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
            "session {session_id} was started with the claude config dir {} and cannot resume under {}: claude \
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

/// Keeps a raw transcript under `cap` bytes by dropping its oldest half, on a line boundary.
pub fn cap_transcript(path: &Path, cap: u64) -> std::io::Result<()> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(());
    };
    if meta.len() <= cap {
        return Ok(());
    }
    let bytes = std::fs::read(path)?;
    let from = (bytes.len() / 2).saturating_sub(1);
    let start = bytes[from..]
        .iter()
        .position(|b| *b == b'\n')
        .map_or(bytes.len(), |n| from + n + 1);
    std::fs::write(path, &bytes[start..])
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
            started_at: None,
            ended_at: None,
            failure: None,
            usage: None,
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

        let mut runs = base;
        let exit = ExitInfo {
            code: None,
            signal: Some(9),
            stderr_tail: "boom\n".into(),
        };
        close_out(&mut runs, &EndCause::Exited(exit), &at);
        let failure = runs[1].failure.as_ref().unwrap();
        assert_eq!(runs[1].status, RunStatus::Failed);
        assert_eq!(failure.class, FailureClass::ProcessExited);
        assert_eq!(
            failure.message.as_str(),
            "claude was killed by signal 9 before the run ended\n--- stderr tail ---\nboom"
        );
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
            auto_memory: false,
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
        assert!(start_mode(&local, &new, "s1").is_err());
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

    #[test]
    fn a_transcript_over_its_cap_keeps_its_newest_half_on_line_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let lines: String = (0..10).map(|n| format!("line-{n}\n")).collect();
        std::fs::write(&path, &lines).unwrap();
        cap_transcript(&path, 1000).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), lines);
        cap_transcript(&path, 40).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "line-5\nline-6\nline-7\nline-8\nline-9\n"
        );
    }
}
