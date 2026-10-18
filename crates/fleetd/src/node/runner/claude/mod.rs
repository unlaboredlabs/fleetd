//! The Claude adapter: one `claude -p --input-format stream-json --output-format stream-json` process per live
//! session, spawned in its own process group with a scrubbed environment.
//!
//! - [`ClaudeRunner::args`]: the argv, with model, effort and thinking always explicit.
//! - [`mapper`]: stream-json both ways, pure and fixture-tested.
//! - [`session`]: the process task: I/O pump, stdin writer, transcript and the kill ladder.
pub mod mapper;
pub mod protocol;
mod session;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::sessions::{RunnerInfo, RunnerKind};

use super::{
    BoxFut, ExitInfo, Runner, RunnerError, SessionHandle, SessionSpec, conformance, failure,
    process,
};
use mapper::{Classify, StreamMapper};

/// Tools no fleetd session gets: subagent fan-out stays under fleetd's slots, and nobody is at a terminal to answer
/// AskUserQuestion (agents use `fleetd ask`).
pub const ALWAYS_DISALLOWED: &[&str] = &["Task", "Workflow", "AskUserQuestion"];

/// `--mcp-config` when the node wrote none: with `--strict-mcp-config`, no user or repo MCP server loads.
const NO_MCP_SERVERS: &str = r#"{"mcpServers":{}}"#;

/// Variables never passed on even if the caller's env has them: claude sets them for its own children and treats a
/// process that has them as nested inside another session.
const NESTING_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
];

pub struct ClaudeRunner {
    /// The `claude` binary, resolved once at node start.
    pub binary: PathBuf,
    /// [`failure::classify`]; replaceable so tests can see the evidence a run left.
    pub classify: Classify,
}

impl ClaudeRunner {
    pub fn new(binary: PathBuf) -> Self {
        Self {
            binary,
            classify: Arc::new(failure::classify),
        }
    }

    /// The full argv after the binary for `spec`.
    pub fn args(&self, spec: &SessionSpec) -> Vec<String> {
        let mut args: Vec<String> = [
            "-p",
            "--verbose",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--include-partial-messages",
            "--model",
            &spec.model,
            "--effort",
            effort_flag(spec.effort),
            "--thinking",
            "adaptive",
            "--thinking-display",
            "summarized",
            if spec.resume {
                "--resume"
            } else {
                "--session-id"
            },
            &spec.session_id,
            // Every ask claude still raises comes to fleetd over stdio; nothing ever waits on a TTY.
            "--permission-prompt-tool",
            "stdio",
            "--permission-mode",
            match spec.runtime_mode {
                RuntimeMode::FullAccess => "bypassPermissions",
                RuntimeMode::ApprovalRequired => "manual",
            },
        ]
        .map(str::to_owned)
        .into();
        // One argv element per rule: a rule such as `Bash(git commit -m "a, b")` survives no comma joining.
        if !spec.allowed_tools.is_empty() {
            args.push("--allowedTools".into());
            args.extend(spec.allowed_tools.iter().cloned());
        }
        args.push("--disallowedTools".into());
        let mut disallowed: Vec<String> =
            ALWAYS_DISALLOWED.iter().map(|t| (*t).to_owned()).collect();
        for tool in &spec.disallowed_tools {
            if !disallowed.contains(tool) {
                disallowed.push(tool.clone());
            }
        }
        args.extend(disallowed);
        args.push("--strict-mcp-config".into());
        args.push("--mcp-config".into());
        args.push(
            spec.mcp_config
                .as_ref()
                .map_or(NO_MCP_SERVERS.into(), |p| p.display().to_string()),
        );
        args.push("--setting-sources".into());
        args.push("user,project,local".into());
        for dir in &spec.add_dirs {
            args.push("--add-dir".into());
            args.push(dir.display().to_string());
        }
        args
    }
}

impl Runner for ClaudeRunner {
    fn kind(&self) -> RunnerKind {
        RunnerKind::Claude
    }

    fn probe<'a>(&'a self, env: &'a [(String, String)]) -> BoxFut<'a, RunnerInfo> {
        Box::pin(conformance::probe(&self.binary, env))
    }

    fn spawn(&self, mut spec: SessionSpec) -> Result<SessionHandle, RunnerError> {
        let binary = self.binary.display().to_string();
        let refuse = |message: String| RunnerError::Spawn {
            binary: binary.clone(),
            message,
        };
        if spec.model.trim().is_empty() {
            return Err(refuse("no model: fleetd always names one".into()));
        }
        // Without it claude would read and write the user's own ~/.claude: their login, settings, hooks, sessions.
        let Some(config_dir) = spec
            .env
            .iter()
            .find(|(k, v)| k == "CLAUDE_CONFIG_DIR" && !v.is_empty())
            .map(|(_, v)| PathBuf::from(v))
        else {
            return Err(refuse(
                "CLAUDE_CONFIG_DIR is not set for the session".into(),
            ));
        };
        if let Some(file) = session_file(&config_dir, &spec.cwd, &spec.session_id) {
            // The session file decides, so a crash between spawn and the node's own record can't make claude refuse
            // ("Session ID … is already in use" / "No conversation found").
            spec.resume = file.exists();
        }

        process::adopt_orphans();
        let marker = process::marker(&spec.session_id);
        let mut cmd = tokio::process::Command::new(&self.binary);
        cmd.args(self.args(&spec))
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(
                spec.env
                    .iter()
                    .filter(|(k, _)| {
                        !NESTING_VARS.contains(&k.as_str())
                            && k != process::SESSION_MARKER
                            && k != "CLAUDE_CODE_STARTUP_FAILURE_RESULTS"
                    })
                    .map(|(k, v)| (k, v)),
            )
            .env(process::SESSION_MARKER, &marker)
            // Some refusals at startup (a session held by a background job, a CLI too old for the org) then also come
            // as a `result` with `startup_failure_reason`, not as stderr alone. "Session ID … is already in use" stays
            // stderr-only (observed on 2.1.302), hence [`session_in_use`].
            .env("CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        let child = cmd.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound && !self.binary.exists() {
                RunnerError::Missing {
                    binary: binary.clone(),
                }
            } else {
                refuse(format!("{error} (cwd {})", spec.cwd.display()))
            }
        })?;
        let mapper = StreamMapper::new(spec.session_id.clone(), self.classify.clone());
        Ok(session::start(child, marker, mapper, spec.transcript))
    }
}

fn effort_flag(effort: Effort) -> &'static str {
    match effort {
        Effort::Low => "low",
        Effort::Medium => "medium",
        Effort::High => "high",
        Effort::Max => "max",
    }
}

/// Where claude files session `id` started in `cwd`: `<config>/projects/<cwd, every character but [A-Za-z0-9] as
/// '-'>/<id>.jsonl`. `None` past 200 characters, where claude shortens the name with a hash we don't reproduce.
pub fn session_file(config_dir: &Path, cwd: &Path, id: &str) -> Option<PathBuf> {
    // claude's cwd is the resolved path.
    let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_owned());
    let mut name = String::new();
    for ch in cwd.to_string_lossy().chars() {
        if ch.is_ascii_alphanumeric() {
            name.push(ch);
        } else {
            // JavaScript's replace works on UTF-16 units: a character outside the BMP becomes two dashes.
            name.extend(std::iter::repeat_n('-', ch.len_utf16()));
        }
    }
    (name.len() <= 200).then(|| {
        config_dir
            .join("projects")
            .join(name)
            .join(format!("{id}.jsonl"))
    })
}

/// claude refused to start because the session id is taken (a first start of a session that already exists, when
/// [`session_file`] could not tell). The caller retries once with `resume`.
pub fn session_in_use(exit: &ExitInfo) -> bool {
    exit.stderr_tail.contains("is already in use")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SessionSpec {
        SessionSpec {
            session_id: "7f0c0000-0000-4000-8000-000000000001".into(),
            resume: false,
            cwd: "/work/project".into(),
            add_dirs: vec!["/work/root".into()],
            model: "claude-haiku-5-5".into(),
            effort: Effort::Max,
            runtime_mode: RuntimeMode::ApprovalRequired,
            allowed_tools: vec![
                "Bash(npm test:*)".into(),
                r#"Bash(git commit -m "a, b")"#.into(),
            ],
            disallowed_tools: vec!["Task".into(), "WebFetch".into()],
            mcp_config: None,
            env: Vec::new(),
            transcript: None,
        }
    }

    #[test]
    fn argv_names_everything_explicitly() {
        let runner = ClaudeRunner::new("claude".into());
        let args = runner.args(&spec()).join(" ");
        assert_eq!(
            args,
            "-p --verbose --output-format stream-json --input-format stream-json --include-partial-messages \
             --model claude-haiku-5-5 --effort max --thinking adaptive --thinking-display summarized \
             --session-id 7f0c0000-0000-4000-8000-000000000001 --permission-prompt-tool stdio --permission-mode manual \
             --allowedTools Bash(npm test:*) Bash(git commit -m \"a, b\") \
             --disallowedTools Task Workflow AskUserQuestion WebFetch \
             --strict-mcp-config --mcp-config {\"mcpServers\":{}} --setting-sources user,project,local \
             --add-dir /work/root"
        );

        let resumed = SessionSpec {
            resume: true,
            runtime_mode: RuntimeMode::FullAccess,
            allowed_tools: Vec::new(),
            mcp_config: Some("/n/mcp.json".into()),
            ..spec()
        };
        let args = runner.args(&resumed).join(" ");
        assert!(args.contains("--resume 7f0c0000-0000-4000-8000-000000000001 "));
        assert!(args.contains("--permission-mode bypassPermissions --disallowedTools"));
        assert!(args.contains("--mcp-config /n/mcp.json "));
    }

    #[test]
    fn the_session_file_follows_claudes_project_naming() {
        let config = Path::new("/c");
        // Observed: /work/project → -work-project, and dots become dashes (`~/.t3/...` → `-home-wynn--t3-...`).
        assert_eq!(
            session_file(config, Path::new("/nonexistent/.wt/a_b"), "s1"),
            Some(PathBuf::from("/c/projects/-nonexistent--wt-a-b/s1.jsonl"))
        );
        let long = format!("/nonexistent/{}", "x".repeat(200));
        assert_eq!(session_file(config, Path::new(&long), "s1"), None);
    }

    #[tokio::test]
    async fn spawn_refuses_without_an_isolated_config_dir() {
        let runner = ClaudeRunner::new("/bin/true".into());
        let refused = runner.spawn(spec()).err().map(|e| e.to_string());
        assert_eq!(
            refused.as_deref(),
            Some("could not start /bin/true: CLAUDE_CONFIG_DIR is not set for the session")
        );
    }
}
