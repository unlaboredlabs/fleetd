//! The Claude adapter: one `claude -p --input-format stream-json --output-format stream-json` process per live
//! session, spawned in its own process group with a scrubbed environment.
//!
//! - [`ClaudeRunner::args`]: the argv, with model, effort and thinking always explicit.
//! - [`mapper`]: stream-json both ways, pure and fixture-tested.
//! - [`session`]: the process task: I/O pump, stdin writer, transcript and the kill ladder.
pub mod mapper;
pub mod protocol;
mod session;
pub mod spans;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use fleetd_contracts::effort::{Effort, MODEL};
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::sessions::{RESUME_REFUSED, RunnerInfo, SessionRole};

use super::{
    BoxFut, Runner, RunnerError, SessionHandle, SessionSpec, claude_setup, conformance, failure,
    process,
};
use mapper::{Classify, StreamMapper};

/// Declares `$name`, the list the launch code uses, and `$why`, the same items each with the reason the docs print
/// (docsgen's "Agent tools" page), from one list so the docs can't drift from what fleetd sets.
macro_rules! explained {
    ($(#[$doc:meta])* $name:ident, $why:ident: $t:ty = [$($item:expr => $reason:expr),* $(,)?]) => {
        $(#[$doc])*
        pub const $name: &[$t] = &[$($item),*];
        #[doc = concat!("[`", stringify!($name), "`], each with why.")]
        pub const $why: &[($t, &str)] = &[$(($item, $reason)),*];
    };
}

const WHY_AGENTS: &str = "fleetd manages agents. Every agent is a fleetd task with its own session, slot, worktree, \
                          lane, steering and receipts, started with spawn_agent.";
const WHY_TASK: &str = "fleetd manages agents (spawn_agent). Task and Agent are one tool: init lists Task, the model \
                        sees Agent, and denying either removes both.";
const WHY_HEADLESS: &str = "Nobody sits at a terminal to answer it, so the run would stall. Agents use ask or \
                            ask_lead.";
const WHY_SCHEDULE: &str = "fleetd schedules work (tasks, wakes), never inside one claude process the node may \
                            restart.";
const WHY_WORKTREE: &str = "fleetd owns worktrees, one per writer. A session that moves its own folder can't be \
                            resumed.";
const WHY_NESTED: &str = "A claude started inside a session runs outside fleetd's slots, with its own subagents and \
                          any model. Agents start agents with spawn_agent.";

explained! {
    /// Tools no fleetd session gets (names from claude 2.1.302's `system/init` tool list). Any further agent tool a
    /// session's init still offers ([`conformance::agent_like`]) stops that session and is denied from then on.
    ///
    /// Then the Bash rules against a nested claude. claude itself matches `Bash(claude *)` in every part of a compound
    /// command, in subshells and `$(…)`, past any leading `VAR=…`, and past the wrappers it strips (`timeout`,
    /// `nice`, `nohup`, `command`, bare `xargs`, …). It matches no other spelling of the program, so the rest name
    /// the obvious ones: a path to the binary, a package runner, a `-c` shell, `env`, `exec`, `xargs` with flags. A
    /// script that hides the name still gets through: these keep agents honest, they are not a sandbox.
    ALWAYS_DISALLOWED, DISALLOWED_WHY: &str = [
        "Task" => WHY_TASK,
        "Agent" => WHY_TASK,
        "Workflow" => WHY_AGENTS,
        "ListAgents" => WHY_AGENTS,
        "SendMessage" => WHY_AGENTS,
        "TaskStop" => WHY_AGENTS,
        "TaskOutput" => WHY_AGENTS,
        "TeamCreate" => WHY_AGENTS,
        "TeamDelete" => WHY_AGENTS,
        "AskUserQuestion" => WHY_HEADLESS,
        "EnterPlanMode" => WHY_HEADLESS,
        "ExitPlanMode" => WHY_HEADLESS,
        "CronCreate" => WHY_SCHEDULE,
        "CronDelete" => WHY_SCHEDULE,
        "CronList" => WHY_SCHEDULE,
        "ScheduleWakeup" => WHY_SCHEDULE,
        "EnterWorktree" => WHY_WORKTREE,
        "ExitWorktree" => WHY_WORKTREE,
        "Bash(claude *)" => WHY_NESTED,
        "Bash(*bin/claude)" => WHY_NESTED,
        "Bash(*bin/claude *)" => WHY_NESTED,
        "Bash(*/claude -*)" => WHY_NESTED,
        "Bash(*claude/versions/*)" => WHY_NESTED,
        "Bash(npx *claude*)" => WHY_NESTED,
        "Bash(bunx *claude*)" => WHY_NESTED,
        "Bash(*@anthropic-ai/claude-code*)" => WHY_NESTED,
        "Bash(*sh -*c *claude*)" => WHY_NESTED,
        "Bash(env *claude*)" => WHY_NESTED,
        "Bash(exec *claude*)" => WHY_NESTED,
        "Bash(xargs *claude*)" => WHY_NESTED,
    ]
}

/// The agent tools of claude 2.1.302, all in [`ALWAYS_DISALLOWED`].
pub const AGENT_TOOLS: &[&str] = &[
    "Task",
    "Agent",
    "Workflow",
    "ListAgents",
    "SendMessage",
    "TaskStop",
    "TaskOutput",
    "TeamCreate",
    "TeamDelete",
];

explained! {
    /// Set in every claude fleetd starts. Each one's effect was checked on 2.1.302 (init, and the request a fake API
    /// endpoint received). `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION=0` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=0` are
    /// not here: an agent still launched with them.
    SUBAGENTS_OFF_ENV, SUBAGENTS_OFF_ENV_WHY: (&str, &str) = [
        ("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1") =>
            "Takes run_in_background out of Bash and Agent and refuses it: a background job outlives the turn fleetd \
             tracks.",
        ("CLAUDE_CODE_DISABLE_WORKFLOWS", "1") => "Removes the Workflow tool: fleetd manages agents.",
        ("CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS", "1") =>
            "Removes the built-in Explore and Plan agents: fleetd manages agents.",
        ("CLAUDE_CODE_DISABLE_AGENT_VIEW", "1") => "Removes the built-in claude agent: fleetd manages agents.",
    ]
}

explained! {
    /// Never passed on, and blanked in the settings overlay in case the user's settings set them.
    SUBAGENTS_ON_ENV, SUBAGENTS_ON_ENV_WHY: &str = [
        "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" => "Agent teams: fleetd manages agents.",
        "CLAUDE_CODE_COORDINATOR_MODE" =>
            "Coordinator mode turns a session into one that only delegates (its tools become Task, ListAgents, \
             SendMessage, TaskStop, Workflow).",
    ]
}

/// [`SUBAGENTS_OFF_ENV`] and blanked [`SUBAGENTS_ON_ENV`] as a settings `env` object. Flag settings outrank the user's
/// own settings, whose `env` would otherwise win over the process environment.
pub fn subagents_off_settings_env() -> serde_json::Map<String, serde_json::Value> {
    SUBAGENTS_OFF_ENV
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).into()))
        .chain(
            SUBAGENTS_ON_ENV
                .iter()
                .map(|k| ((*k).to_owned(), "".into())),
        )
        .collect()
}

/// `--disallowedTools` for a claude fleetd starts: [`ALWAYS_DISALLOWED`], then `extra` (agent tools an earlier
/// session's init offered, the project's own denials), each once.
pub fn disallowed_tools<'a>(extra: impl IntoIterator<Item = &'a String>) -> Vec<String> {
    let mut tools: Vec<String> = ALWAYS_DISALLOWED.iter().map(|t| (*t).to_owned()).collect();
    for tool in extra {
        if !tools.contains(tool) {
            tools.push(tool.clone());
        }
    }
    tools
}

/// Claude's auto memory is off in every claude fleetd starts, whatever the user's settings say: fleetd owns an
/// agent's context (briefs, decisions, instructions), and a memory claude keeps per cwd would carry stale, unreviewed
/// notes from one agent's worktree to the next. Both knobs, since either alone has been ignored by some claude
/// versions.
pub const AUTO_MEMORY_OFF_ENV: (&str, &str) = ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1");
pub const AUTO_MEMORY_OFF_WHY: &str = "fleetd owns an agent's context (briefs, decisions, instructions). Notes claude \
                                       keeps per folder would carry stale, unreviewed text from one agent's worktree \
                                       to the next.";
/// The same as a `--settings` value, for the one-shot claude runs that take no overlay file.
pub const AUTO_MEMORY_OFF_SETTINGS: &str = r#"{"autoMemoryEnabled":false}"#;

explained! {
    /// Defaults for every claude fleetd starts, unlike the forced lists: the node's own environment or `claude.env`
    /// sets any of them otherwise (`SessionConfig::runner_env`).
    DEFAULT_ENV, DEFAULT_ENV_WHY: (&str, &str) = [
        ("ENABLE_TOOL_SEARCH", "true") =>
            "Tool schemas load when a tool is used, not on every request. fleetd's own tools always load at start.",
    ]
}

/// claude's prompt cache TTL variables: a session's own turns, then the helper requests beside them. On 2.1.302 either
/// outranks the `promptCacheTtl` settings and claude's automatic choice (1 hour on a subscription within its limits,
/// else 5 minutes); only `FORCE_PROMPT_CACHING_5M` outranks them. `5m` sends no `ttl`, which the API reads as 5 minutes.
pub const PROMPT_CACHE_TTL_VARS: [&str; 2] = [
    "CLAUDE_CODE_PROMPT_CACHE_TTL",
    "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL",
];

/// A prompt cache TTL claude accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum CacheTtl {
    #[serde(rename = "5m")]
    FiveMinutes,
    #[serde(rename = "1h")]
    OneHour,
}

impl CacheTtl {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FiveMinutes => "5m",
            Self::OneHour => "1h",
        }
    }
}

explained! {
    /// A session's prompt cache TTL by role, unless `promptCacheTtl` in node.json names the role or the node's
    /// environment or `claude.env` sets [`PROMPT_CACHE_TTL_VARS`] (`SessionConfig::prompt_cache_env`). A 1-hour cache
    /// write costs 2x the input price, a 5-minute one 1.25x; reads cost the same.
    PROMPT_CACHE_TTL, PROMPT_CACHE_TTL_WHY: (SessionRole, CacheTtl) = [
        (SessionRole::Lead, CacheTtl::OneHour) =>
            "A lead idles between wakes, often more than 5 minutes while reviews and CI run, and would otherwise \
             rewrite its whole context to the prompt cache on those wakes.",
        (SessionRole::Plain, CacheTtl::OneHour) =>
            "A person's thread idles while they read and reply.",
        (SessionRole::Worker, CacheTtl::FiveMinutes) =>
            "A task's agent (writer, reader, reviewer, CI fix) works in one burst and ends, so a 1-hour write pays for \
             an hour it never uses.",
    ]
}

/// [`PROMPT_CACHE_TTL`] for `role`.
pub fn default_cache_ttl(role: SessionRole) -> CacheTtl {
    PROMPT_CACHE_TTL
        .iter()
        .find(|(r, _)| *r == role)
        .map_or(CacheTtl::OneHour, |(_, ttl)| *ttl)
}

const WHY_NESTING: &str = "claude sets it for its own children and treats a process that has it as nested inside \
                           another session.";

explained! {
    /// Variables never passed on to a session, even if the node's env has them.
    NESTING_VARS, NESTING_VARS_WHY: &str = [
        "CLAUDECODE" => WHY_NESTING,
        "CLAUDE_CODE_ENTRYPOINT" => WHY_NESTING,
        "CLAUDE_CODE_SSE_PORT" => WHY_NESTING,
    ]
}

/// claude sends its background helper calls (session titles and the like) to whatever the haiku alias names. Every
/// claude fleetd starts points it at the one model fleetd runs, in its environment and its settings, so no call goes
/// to another.
pub const HELPER_MODEL_ENV: (&str, &str) = ("ANTHROPIC_DEFAULT_HAIKU_MODEL", MODEL);
pub const HELPER_MODEL_WHY: &str = "claude's background helper calls (session titles and the like) run on Opus 5.5 \
                                    like everything else fleetd starts, not on the haiku model claude picks by \
                                    default.";

explained! {
    /// Set in every session's environment or settings overlay, besides [`SUBAGENTS_OFF_ENV`] and auto memory.
    SESSION_ENV, SESSION_ENV_WHY: (&str, &str) = [
        ("DISABLE_AUTOUPDATER", "1") =>
            "Keeps the claude fleetd checked. An update mid-run would swap the binary under a live session.",
        // Some refusals at startup (a session held by a background job, a CLI too old for the org) then also come
        // as a `result` with `startup_failure_reason`, not as stderr alone. "Session ID … is already in use" stays
        // stderr-only (observed on 2.1.302), hence [`session_in_use`].
        ("CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "1") =>
            "A refusal at startup arrives as a result fleetd can read, not only as stderr.",
    ]
}

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
        args.extend(disallowed_tools(&spec.disallowed_tools));
        // No `--strict-mcp-config`: sessions run with the user's own claude setup, MCP servers included, and fleetd's
        // servers are added to them.
        if let Some(mcp) = &spec.mcp_config {
            args.push("--mcp-config".into());
            args.push(mcp.display().to_string());
        }
        if let Some(settings) = &spec.settings {
            args.push("--settings".into());
            args.push(settings.display().to_string());
        }
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
        let config_dir = claude_setup::config_dir(&spec.env);
        if let Some(file) = session_file(&config_dir, &spec.cwd, &spec.session_id) {
            if spec.must_resume && !file.exists() {
                return Err(refuse(format!(
                    "{RESUME_REFUSED}claude's conversation {} is gone",
                    file.display()
                )));
            }
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
                            && !SUBAGENTS_ON_ENV.contains(&k.as_str())
                            && k != process::SESSION_MARKER
                            && k != claude_setup::FLEETD_ENV_SOURCE
                            && !SESSION_ENV.iter().any(|(set, _)| set == k)
                            && k != HELPER_MODEL_ENV.0
                    })
                    .map(|(k, v)| (k, v)),
            )
            .envs(SUBAGENTS_OFF_ENV.iter().copied())
            .envs([HELPER_MODEL_ENV])
            .envs(SESSION_ENV.iter().copied())
            .env(process::SESSION_MARKER, &marker)
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

/// claude's words (stderr, so also the failed run's message) for a first start of a session it already has, when
/// [`session_file`] could not tell. The session service sends the run again to a resumed process.
pub fn session_in_use(text: &str) -> bool {
    text.contains("is already in use")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SessionSpec {
        SessionSpec {
            session_id: "7f0c0000-0000-4000-8000-000000000001".into(),
            resume: false,
            must_resume: false,
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
            settings: None,
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
             --disallowedTools Task Agent Workflow ListAgents SendMessage TaskStop TaskOutput TeamCreate TeamDelete \
             AskUserQuestion EnterPlanMode ExitPlanMode CronCreate CronDelete \
             CronList ScheduleWakeup EnterWorktree ExitWorktree Bash(claude *) Bash(*bin/claude) \
             Bash(*bin/claude *) Bash(*/claude -*) Bash(*claude/versions/*) Bash(npx *claude*) Bash(bunx *claude*) \
             Bash(*@anthropic-ai/claude-code*) Bash(*sh -*c *claude*) Bash(env *claude*) Bash(exec *claude*) \
             Bash(xargs *claude*) WebFetch \
             --setting-sources user,project,local --add-dir /work/root"
        );

        let resumed = SessionSpec {
            resume: true,
            runtime_mode: RuntimeMode::FullAccess,
            allowed_tools: Vec::new(),
            mcp_config: Some("/n/mcp.json".into()),
            settings: Some("/n/settings.json".into()),
            ..spec()
        };
        let args = runner.args(&resumed).join(" ");
        assert!(args.contains("--resume 7f0c0000-0000-4000-8000-000000000001 "));
        assert!(args.contains("--permission-mode bypassPermissions --disallowedTools"));
        // fleetd's servers and settings are added to the user's own, never in place of them.
        assert!(args.contains("--mcp-config /n/mcp.json --settings /n/settings.json "));
        assert!(!args.contains("--strict-mcp-config"));
    }

    /// A Bash deny rule as claude matches it against one part of a command, after it split off the other parts and
    /// stripped leading assignments and its wrappers: `*` is any text, and a trailing ` *` that is the only `*` also
    /// matches the bare command.
    fn denies(rule: &str, command: &str) -> bool {
        fn glob(p: &[u8], s: &[u8]) -> bool {
            match p.split_first() {
                None => s.is_empty(),
                Some((b'*', rest)) => (0..=s.len()).any(|i| glob(rest, &s[i..])),
                Some((c, rest)) => s.first() == Some(c) && glob(rest, &s[1..]),
            }
        }
        let Some(p) = rule.strip_prefix("Bash(").and_then(|r| r.strip_suffix(')')) else {
            return false;
        };
        let bare = p.strip_suffix(" *").filter(|b| !b.contains('*'));
        glob(p.as_bytes(), command.as_bytes()) || bare == Some(command)
    }

    #[test]
    fn no_spelling_of_claude_runs_in_an_agents_bash() {
        let denied = |c: &str| ALWAYS_DISALLOWED.iter().any(|r| denies(r, c));
        for nested in [
            "claude",
            "claude -p hi",
            // A helper call on another model.
            "claude -p --model claude-haiku-4-5 'sum this up'",
            "/usr/local/bin/claude -p hi",
            "~/.local/bin/claude --print hi",
            "./node_modules/.bin/claude -p hi",
            "/opt/claude -p hi",
            "~/.local/share/claude/versions/2.1.302 -p hi",
            "npx claude -p hi",
            "npx -y @anthropic-ai/claude-code -p hi",
            "bunx @anthropic-ai/claude-code -p hi",
            "pnpm dlx @anthropic-ai/claude-code -p hi",
            "npm exec -- @anthropic-ai/claude-code@latest -p hi",
            "sh -c 'claude -p hi'",
            "bash -lc \"claude -p hi\"",
            "/bin/zsh -c 'cd /w && claude -p hi'",
            "env -u CLAUDECODE claude -p hi",
            "env CLAUDECODE= /usr/bin/claude -p hi",
            "exec claude -p hi",
            "xargs -0 claude -p",
        ] {
            assert!(denied(nested), "{nested}");
        }
        // Everyday work on fleetd itself, whose runner lives in a folder named claude.
        for work in [
            "cargo test -p fleetd --lib node::runner::claude",
            "cat crates/fleetd/src/node/runner/claude/mod.rs",
            "git log --oneline -- crates/fleetd/src/node/runner/claude/",
            "rg -n claude crates docs",
            "ls ~/.claude",
            "git commit -m 'fix(node): the claude runner resumes'",
            "npx vitest run",
            "env",
            "claudette --help",
        ] {
            assert!(!denied(work), "{work}");
        }
    }

    #[test]
    fn the_session_file_follows_claudes_project_naming() {
        let config = Path::new("/c");
        // Observed: /work/project → -work-project, and dots become dashes (`~/.fleetd/...` → `-home-ada--fleetd-...`).
        assert_eq!(
            session_file(config, Path::new("/nonexistent/.wt/a_b"), "s1"),
            Some(PathBuf::from("/c/projects/-nonexistent--wt-a-b/s1.jsonl"))
        );
        let long = format!("/nonexistent/{}", "x".repeat(200));
        assert_eq!(session_file(config, Path::new(&long), "s1"), None);
    }

    /// A task's session whose conversation is gone is refused, never started empty.
    #[test]
    fn a_task_session_without_its_conversation_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("config");
        let spec = SessionSpec {
            resume: true,
            must_resume: true,
            cwd: dir.path().to_owned(),
            env: vec![("CLAUDE_CONFIG_DIR".into(), config.display().to_string())],
            ..spec()
        };
        let runner = ClaudeRunner::new("/nonexistent/claude".into());
        let Err(RunnerError::Spawn { message, .. }) = runner.spawn(spec) else {
            panic!("a session with no conversation started");
        };
        assert!(message.starts_with(RESUME_REFUSED), "{message}");
    }
}
