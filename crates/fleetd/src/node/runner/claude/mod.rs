//! The Claude adapter: one `claude -p --input-format stream-json --output-format stream-json` process per live
//! session, spawned in its own process group with a scrubbed environment.
//!
//! - [`ClaudeRunner::args`]: the argv, with model, effort and thinking always explicit.
//! - [`mapper`]: stream-json both ways, pure and fixture-tested.
//! - [`session`]: the process task: I/O pump, stdin writer, transcript and the kill ladder.
pub mod conformance;
pub mod failure;
pub mod guide;
pub mod install;
pub mod mapper;
pub mod protocol;
mod session;
pub mod setup;
pub mod spans;
pub mod version;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use fleetd_contracts::effort::{Effort, ProfileName};
use fleetd_contracts::model::RuntimeMode;
use fleetd_contracts::sessions::{PermissionDecision, RESUME_REFUSED, RunnerInfo, SessionRole};

use super::sandbox::{Access, Fence};
use super::{
    BoxFut, ProfileModel, Runner, RunnerError, SessionHandle, SessionSpec, process, scope,
};
use guide::MODEL;
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

const WHY_UNUSED: &str = "Unused by fleetd's agents, and tool schemas ride on every request.";
const WHY_LEAD_FILES: &str = "The lead never changes files: its agents do.";
const WHY_LEAD_WEB: &str = "The lead's agents read the web; the lead routes.";

explained! {
    /// Denied to fleetd's agents (leads and task agents), on top of [`ALWAYS_DISALLOWED`]; threads a person starts
    /// keep them. Names from claude 2.1.302's `system/init`.
    AGENT_DISALLOWED, AGENT_DISALLOWED_WHY: &str = [
        "ReportFindings" => "Agents report a review with fleetd's own `report`.",
        "DesignSync" => WHY_UNUSED,
        "NotebookEdit" => WHY_UNUSED,
    ]
}

explained! {
    /// Denied to a lead, on top of [`AGENT_DISALLOWED`].
    LEAD_DISALLOWED, LEAD_DISALLOWED_WHY: &str = [
        "Edit" => WHY_LEAD_FILES,
        "Write" => WHY_LEAD_FILES,
        "WebFetch" => WHY_LEAD_WEB,
        "WebSearch" => WHY_LEAD_WEB,
    ]
}

/// The tools denied to a session of `role` beyond [`ALWAYS_DISALLOWED`]. A Navi's lead keeps Edit, Write and the web:
/// [`role_answer`] decides its file tools, and the hub's site gate its fetches.
pub fn role_disallowed(role: SessionRole) -> impl Iterator<Item = &'static str> {
    let (agent, lead): (&[&str], &[&str]) = match role {
        SessionRole::Plain => (&[], &[]),
        SessionRole::Worker | SessionRole::Assistant => (AGENT_DISALLOWED, &[]),
        SessionRole::Lead => (AGENT_DISALLOWED, LEAD_DISALLOWED),
    };
    agent.iter().chain(lead).copied()
}

const WHY_DEVICE: &str = "Screens work as they do for every lead; a final Send or Pay click is the person's, through \
                          request_takeover.";

explained! {
    /// Allowed to a Navi's lead without asking. It runs in `manual` permission mode, so any other tool (a command, a
    /// fetch, opening a site, an MCP server's send) asks first: the node answers its file tools and its commands
    /// ([`role_answer`]), and every other ask reaches the hub, which allows a site the person allowed before (or linked
    /// in their own message) and otherwise asks them in the Navi's chat.
    ASSISTANT_ALLOWED, ASSISTANT_ALLOWED_WHY: &str = [
        "WebSearch" => "A search sends only its query, to the search provider.",
        "Skill" => "Loads a skill's instructions; runs nothing.",
        "mcp__fleetd" => "fleetd's own tools, which the hub checks on every call.",
        "Bash(agent-device *)" => WHY_DEVICE,
    ]
}

explained! {
    /// Asked of a Navi's lead whatever allows them, in its settings overlay: claude ranks an ask rule above every allow
    /// rule, a person's own settings' included, so each of these always reaches the node's permission prompt and its
    /// policy ([`role_answer`], then the hub).
    ASSISTANT_ASK, ASSISTANT_ASK_WHY: &str = [
        "Read" => "A Navi reads anything but what its sandbox hides.",
        "Glob" => "A Navi reads anything but what its sandbox hides.",
        "Grep" => "A Navi reads anything but what its sandbox hides.",
        "Edit" => "A Navi writes anything but what its sandbox hides or keeps read-only.",
        "Write" => "A Navi writes anything but what its sandbox hides or keeps read-only.",
        "NotebookEdit" => "A Navi writes anything but what its sandbox hides or keeps read-only.",
        "WebFetch" => "A Navi fetches a site unasked only once the person allowed or linked it.",
    ]
}

/// Files inside a Navi's folder its lead may read but never change: claude's own settings and MCP servers there,
/// fleetd's policy file, and agent-browser's project config, would let it give itself allow rules, hooks, tools, or
/// scripts, headers and a proxy on every page.
pub const ASSISTANT_KEPT: &[&str] = &[".claude", ".mcp.json", ".fleetd", "agent-browser.json"];

/// The config file a Navi's agent-browser reads instead of any other (`AGENT_BROWSER_CONFIG`), in its session's own
/// directory: empty, so fleetd's environment alone decides how its browser runs.
pub const ASSISTANT_BROWSER_CONFIG: &str = "agent-browser-config.json";

/// Where `path` (relative to `cwd`, absolute, or from the person's home with `~`) really is: its nearest part that
/// exists with symlinks and `..` resolved, then the rest of it. None with a `..` in that rest.
fn resolve(cwd: &Path, path: &str) -> Option<PathBuf> {
    let joined = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            crate::node::util::home_dir().join(rest.trim_start_matches('/'))
        }
        _ => cwd.join(path),
    };
    let mut base = joined.as_path();
    let mut rest = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(base) {
            return Some(
                rest.iter()
                    .rev()
                    .fold(real, |p: PathBuf, part| p.join(part)),
            );
        }
        rest.push(base.file_name()?.to_owned());
        base = base.parent()?;
    }
}

/// `dir` with symlinks resolved, as it is when it can't be.
fn real(dir: &Path) -> PathBuf {
    std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_owned())
}

/// `path` really is in one of [`ASSISTANT_KEPT`] in `cwd`, whatever case it is spelled in: a disk that ignores case
/// (macOS's, by default) writes `.Claude` into `.claude`.
fn kept(cwd: &Path, path: &str) -> bool {
    let Some(resolved) = resolve(cwd, path) else {
        return true;
    };
    resolved
        .strip_prefix(real(cwd))
        .ok()
        .and_then(|rel| rel.components().next())
        .is_some_and(|first| {
            let first = first.as_os_str().to_string_lossy().to_lowercase();
            ASSISTANT_KEPT.contains(&first.as_str())
        })
}

/// Where a Glob pattern (or Grep's file filter) searches from, in `root`: its parts before the first with a wildcard or
/// braces in it, which can spell anything. An absolute one or one from home (`~`) leaves `root`.
fn pattern_root(root: &Path, pattern: &str) -> Option<PathBuf> {
    let fixed: Vec<&str> = pattern
        .split('/')
        .take_while(|part| !part.contains(['*', '?', '[', '{', '}']))
        .collect();
    let fixed = fixed.join("/");
    let fixed = if fixed.is_empty() && pattern.starts_with('/') {
        "/".to_owned()
    } else {
        fixed
    };
    resolve(root, &fixed)
}

/// How the node answers a file tool's or a command's prompt from a session of `role` in `cwd`, whoever would approve
/// it: a Navi's lead reads and writes what its sandbox `fence` lets it (D234: anything but what it hides, writes but
/// to what it keeps read-only; [`Fence::folder_only`] while its sandbox isn't known), never its settings in its
/// folder, and runs any command but a browser visit. None for any other tool or role, and for a visit: the prompt goes
/// on to the hub.
pub fn role_answer(
    role: SessionRole,
    cwd: &Path,
    fence: &Fence,
    tool: &str,
    input: &serde_json::Value,
) -> Option<PermissionDecision> {
    if role != SessionRole::Assistant {
        return None;
    }
    if tool == "Bash" {
        // A command runs unasked (D208): the OS sandbox holds its writes, and its agent-browser daemon's.
        // Only a browser visit goes on to the hub's site gate.
        return crate::hub::navi::sites::visit(tool, input)
            .is_none()
            .then_some(PermissionDecision::Allow {
                updated_input: None,
            });
    }
    let (writes, keys): (bool, &[&str]) = match tool {
        "Read" => (false, &["file_path"]),
        "Glob" | "Grep" => (false, &["path"]),
        "Edit" | "Write" => (true, &["file_path"]),
        "NotebookEdit" => (true, &["notebook_path"]),
        _ => return None,
    };
    let path = keys
        .iter()
        .find_map(|k| input.get(*k).and_then(|v| v.as_str()));
    // Glob and Grep with no path search the folder itself.
    let path = match (path, tool) {
        (None, "Glob" | "Grep") => ".",
        (None, _) => "",
        (Some(p), _) => p,
    };
    let deny = |why: String| {
        Some(PermissionDecision::Deny {
            message: fleetd_contracts::prim::Text::unchecked(why),
        })
    };
    let hidden = |at: &Path| {
        deny(format!(
            "fleetd policy: {} is hidden from a Navi (the person's keys and logins, and fleetd's own files)",
            at.display()
        ))
    };
    let Some(at) = (!path.is_empty()).then(|| resolve(cwd, path)).flatten() else {
        return deny(format!(
            "fleetd policy: a Navi can't tell where {path:?} is"
        ));
    };
    let patterns = ["pattern", "glob"]
        .iter()
        .filter(|k| tool == "Glob" || **k == "glob")
        .filter_map(|k| input.get(*k).and_then(|v| v.as_str()));
    for pattern in patterns {
        match pattern_root(&at, pattern) {
            Some(root) if fence.access(&root) == Access::Hidden => return hidden(&root),
            Some(_) => {}
            None => {
                return deny(format!(
                    "fleetd policy: a Navi can't tell where {pattern:?} searches"
                ));
            }
        }
    }
    match fence.access(&at) {
        Access::Hidden => return hidden(&at),
        Access::Read if writes => {
            return deny(format!(
                "fleetd policy: a Navi doesn't change {}: it is read-only to it",
                at.display()
            ));
        }
        _ => {}
    }
    if writes && at.starts_with(real(cwd)) && kept(cwd, path) {
        return deny(format!(
            "fleetd policy: a Navi doesn't change its own settings, policy or MCP servers ({})",
            ASSISTANT_KEPT.join(", ")
        ));
    }
    Some(PermissionDecision::Allow {
        updated_input: None,
    })
}

/// `--allowedTools` a session of `role` gets beyond its project's rules: [`ASSISTANT_ALLOWED`] for a Navi's lead, none
/// for other roles.
pub fn role_allowed(role: SessionRole) -> Vec<String> {
    if role != SessionRole::Assistant {
        return Vec::new();
    }
    ASSISTANT_ALLOWED.iter().map(|t| (*t).to_owned()).collect()
}

/// The `permissions.ask` rules of a session of `role`'s settings overlay: [`ASSISTANT_ASK`] for a Navi's lead.
pub fn role_ask(role: SessionRole) -> &'static [&'static str] {
    if role == SessionRole::Assistant {
        ASSISTANT_ASK
    } else {
        &[]
    }
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

/// The runtime's own tools among `rules` (`Read` of `Read(./notes/**)`), each once: no MCP server's.
pub fn runtime_tools(rules: &[String]) -> Vec<String> {
    let mut tools: Vec<String> = Vec::new();
    for rule in rules {
        let name = rule.split('(').next().unwrap_or_default().trim();
        if !name.is_empty() && !name.starts_with("mcp__") && !tools.iter().any(|t| t == name) {
            tools.push(name.to_owned());
        }
    }
    tools
}

/// A script claude reads once and runs ahead of every Bash command: what an order's session sources its order's
/// variables through, so a value renewed mid-turn reaches its next command (node/order_env.rs).
pub const ORDER_ENV_FILE_ENV: &str = "CLAUDE_ENV_FILE";

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

explained! {
    /// Defaults for a task's agent, like [`DEFAULT_ENV`]: the node's own environment or `claude.env` sets any of them
    /// otherwise. Also in its settings overlay, which outranks the `env` in the user's own settings.
    WORKER_ENV, WORKER_ENV_WHY: (&str, &str) = [
        ("BASH_MAX_TIMEOUT_MS", "280000") =>
            "No one command outlives a task agent's 5-minute prompt cache: past it, the agent's next request writes its \
             whole context to the cache again. A longer suite is CI's job.",
    ]
}

/// [`WORKER_ENV`] for a task's agent, each unless `env` sets it; nothing for other roles.
pub fn role_env(role: SessionRole, env: &[(String, String)]) -> Vec<(String, String)> {
    if role != SessionRole::Worker {
        return Vec::new();
    }
    WORKER_ENV
        .iter()
        .filter(|(key, _)| !env.iter().any(|(k, _)| k == key))
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
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
    /// A session's prompt cache TTL by role, unless the node's environment or `claude.env` sets
    /// [`PROMPT_CACHE_TTL_VARS`] (`SessionConfig::prompt_cache_env`). A 1-hour cache
    /// write costs 2x the input price, a 5-minute one 1.25x; reads cost the same.
    PROMPT_CACHE_TTL, PROMPT_CACHE_TTL_WHY: (SessionRole, CacheTtl) = [
        (SessionRole::Assistant, CacheTtl::OneHour) =>
            "A Navi's lead idles between a person's messages, like a lead between wakes.",
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
/// claude fleetd starts points it at the default profile's model ([`SessionSpec::helper_model`]; this one unless a
/// setting chose another), in its environment and its settings, so no call goes to another.
pub const HELPER_MODEL_ENV: (&str, &str) = ("ANTHROPIC_DEFAULT_HAIKU_MODEL", MODEL);
pub const HELPER_MODEL_WHY: &str = "claude's background helper calls (session titles and the like) run on the \
                                    default profile's model like the lead and every review, not on the haiku model \
                                    claude picks by default.";

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
                _ if spec.allowed_only => "manual",
                RuntimeMode::FullAccess => "bypassPermissions",
                RuntimeMode::ApprovalRequired => "manual",
            },
        ]
        .map(str::to_owned)
        .into();
        // Held to its allowed tools: claude loads only the runtime tools named there, none at all with `""`. MCP
        // tools aren't among them; they ask, and the node refuses.
        if spec.allowed_only {
            args.push("--tools".into());
            args.push(runtime_tools(&spec.allowed_tools).join(","));
        }
        // One argv element per rule: a rule such as `Bash(git commit -m "a, b")` survives no comma joining.
        if !spec.allowed_tools.is_empty() {
            args.push("--allowedTools".into());
            args.extend(spec.allowed_tools.iter().cloned());
        }
        args.push("--disallowedTools".into());
        args.extend(disallowed_tools(&spec.disallowed_tools));
        // Sessions run with the user's own claude setup, MCP servers included, and fleetd's servers are added to them;
        // unless a person turned the user's own off: `--strict-mcp-config` loads fleetd's only.
        if let Some(mcp) = &spec.mcp_config {
            args.push("--mcp-config".into());
            args.push(mcp.display().to_string());
            if spec.strict_mcp {
                args.push("--strict-mcp-config".into());
            }
        }
        if let Some(settings) = &spec.settings {
            args.push("--settings".into());
            args.push(settings.display().to_string());
        }
        // The first message is summarized when claude compacts the session; the system prompt never is.
        if let Some(system) = &spec.system_prompt {
            args.push("--append-system-prompt".into());
            args.push(system.clone());
        }
        args.push("--setting-sources".into());
        args.push("user,project,local".into());
        for dir in &spec.add_dirs {
            args.push("--add-dir".into());
            args.push(dir.display().to_string());
        }
        // The session's skills (`node::skills`), a plugin for this session only.
        for dir in &spec.plugin_dirs {
            args.push("--plugin-dir".into());
            args.push(dir.display().to_string());
        }
        args
    }
}

impl Runner for ClaudeRunner {
    fn probe<'a>(&'a self, env: &'a [(String, String)]) -> BoxFut<'a, RunnerInfo> {
        Box::pin(conformance::probe(&self.binary, env))
    }

    /// Starts the sandbox once on a blocking thread: it waits on bwrap, and the runtime's threads don't wait.
    fn fence<'a>(&'a self, spec: &'a SessionSpec) -> BoxFut<'a, Result<(), RunnerError>> {
        Box::pin(async move {
            let Some(fence) = spec.sandbox.clone() else {
                return Ok(());
            };
            let cwd = spec.cwd.clone();
            tokio::task::spawn_blocking(move || super::sandbox::check(&fence, &cwd))
                .await
                .map_err(|e| RunnerError::Sandbox {
                    message: format!("A Navi's sandbox check stopped: {e}"),
                    fix: "Send again.".into(),
                })?
                .map_err(|r| RunnerError::Sandbox {
                    message: r.message,
                    fix: r.fix,
                })
        })
    }

    fn try_account<'a>(&'a self, env: &'a [(String, String)]) -> BoxFut<'a, Result<(), String>> {
        Box::pin(conformance::try_account(&self.binary, env))
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
        let config_dir = setup::config_dir(&spec.env);
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
        // A binary that isn't there is reported as missing below, not as a scope that failed to start it.
        let scope = scope::current().filter(|_| self.binary.exists());
        // A Navi's claude starts inside its sandbox (checked by `fence`), or not at all.
        let sandboxed = match &spec.sandbox {
            Some(fence) => Some(
                super::sandbox::wrap(fence, &spec.cwd, &self.binary, self.args(&spec)).map_err(
                    |r| RunnerError::Sandbox {
                        message: r.message,
                        fix: r.fix,
                    },
                )?,
            ),
            None => None,
        };
        let build = |program: PathBuf, args: Vec<String>, scope: Option<&scope::Scope>| {
            let mut cmd = tokio::process::Command::new(program);
            cmd.args(args)
                .current_dir(&spec.cwd)
                .env_clear()
                .envs(
                    spec.env
                        .iter()
                        .filter(|(k, _)| {
                            !NESTING_VARS.contains(&k.as_str())
                                && !SUBAGENTS_ON_ENV.contains(&k.as_str())
                                && k != process::SESSION_MARKER
                                && k != setup::FLEETD_ENV_SOURCE
                                && !SESSION_ENV.iter().any(|(set, _)| set == k)
                                && k != HELPER_MODEL_ENV.0
                        })
                        .map(|(k, v)| (k, v)),
                )
                .envs(SUBAGENTS_OFF_ENV.iter().copied())
                .env(HELPER_MODEL_ENV.0, &spec.helper_model)
                .envs(SESSION_ENV.iter().copied())
                .envs(scope.iter().flat_map(|s| s.env.iter().map(|(k, v)| (k, v))))
                .env(process::SESSION_MARKER, &marker)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .process_group(0)
                .kill_on_drop(true);
            if let Some(sandboxed) = &sandboxed {
                // SAFETY: the hooks make system calls only.
                unsafe {
                    // The namespaces of its box, which its sandbox joins.
                    cmd.pre_exec(sandboxed.hook());
                    // It reaches no abstract socket made outside it (an X server's), where the kernel can say so.
                    if let Some(hook) = super::sandbox::scope_hook() {
                        cmd.pre_exec(hook);
                    }
                }
            }
            cmd
        };
        let (program, args) = match &sandboxed {
            Some(s) => (s.program.clone(), s.args.clone()),
            None => (self.binary.clone(), self.args(&spec)),
        };
        let spawned = scope::spawn(scope.as_ref(), &program, args, &spec.session_id, build);
        let (child, scope_failed) = spawned.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound && !self.binary.exists() {
                RunnerError::Missing {
                    binary: binary.clone(),
                }
            } else {
                refuse(format!("{error} (cwd {})", spec.cwd.display()))
            }
        })?;
        if let Some(why) = scope_failed {
            scope::failed(&why);
        }
        let mapper = StreamMapper::new(spec.session_id.clone(), self.classify.clone());
        Ok(session::start(child, marker, mapper, spec.transcript))
    }

    fn profile(&self, profile: &ProfileName) -> ProfileModel {
        guide::profile(profile)
    }

    fn profile_of(&self, model: &str, effort: Effort) -> ProfileName {
        guide::profile_of(model, effort)
    }
}

fn effort_flag(effort: Effort) -> &'static str {
    match effort {
        Effort::Low => "low",
        Effort::Medium => "medium",
        Effort::High => "high",
        Effort::Xhigh => "xhigh",
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

    #[test]
    fn a_lead_loses_file_and_web_tools_a_task_agent_keeps_and_a_persons_thread_loses_nothing() {
        let denied = |role| role_disallowed(role).collect::<Vec<_>>();
        assert!(denied(SessionRole::Plain).is_empty());
        let worker = denied(SessionRole::Worker);
        // Skills are fleetd's own (`node::skills`): every agent keeps the Skill tool.
        assert!(!worker.contains(&"Skill") && !worker.contains(&"Edit"));
        let lead = denied(SessionRole::Lead);
        assert!(!lead.contains(&"Skill") && lead.contains(&"Edit") && lead.contains(&"WebFetch"));
        // Every name is a tool claude 2.1.302 offers, and none overlaps the list every session gets.
        let init = include_str!("../fixtures/claude-2.1.302-interrupt-mid-tool.jsonl");
        for tool in lead {
            assert!(init.contains(&format!("\"{tool}\"")), "{tool}");
            assert!(!ALWAYS_DISALLOWED.contains(&tool), "{tool}");
        }
    }

    #[test]
    fn a_navis_lead_reads_and_writes_only_its_own_folder_and_asks_for_the_rest() {
        let denied = role_disallowed(SessionRole::Assistant).collect::<Vec<_>>();
        for tool in ["Edit", "Write", "WebFetch", "WebSearch"] {
            assert!(!denied.contains(&tool), "{tool}");
        }
        assert!(denied.contains(&"ReportFindings"));
        let allowed = role_allowed(SessionRole::Assistant);
        for tool in ["WebSearch", "mcp__fleetd"] {
            assert!(allowed.contains(&tool.to_owned()), "{tool}");
        }
        // No prefix rule for the browser or the shell: the node reads each command whole, and a browser visit goes on
        // to the hub's site gate.
        assert!(!allowed.iter().any(|t| t.starts_with("Bash(agent-browser")));
        // Nothing that reads files, fetches, opens a site, runs a command, or uses another MCP server skips the prompt.
        assert!(!allowed.iter().any(|t| {
            [
                "Read",
                "WebFetch",
                "Bash",
                "Write",
                "Edit",
                "Bash(agent-browser *)",
            ]
            .contains(&t.as_str())
                || t.starts_with("Bash(agent-browser open")
                || t.starts_with("Bash(agent-browser eval")
                || t.starts_with("Bash(agent-browser tab")
                || (t.starts_with("mcp__") && t != "mcp__fleetd")
        }));
        // An ask rule for each file tool and the fetch, above any allow rule.
        for tool in ["Read", "Edit", "Write", "WebFetch"] {
            assert!(role_ask(SessionRole::Assistant).contains(&tool), "{tool}");
        }
        // Each bare name is a tool claude 2.1.302 offers.
        let init = include_str!("../fixtures/claude-2.1.302-interrupt-mid-tool.jsonl");
        for tool in ASSISTANT_ALLOWED.iter().filter(|t| !t.contains(['(', '_'])) {
            assert!(init.contains(&format!("\"{tool}\"")), "{tool}");
        }
        for role in [SessionRole::Plain, SessionRole::Lead, SessionRole::Worker] {
            assert!(role_allowed(role).is_empty() && role_ask(role).is_empty());
        }
    }

    #[test]
    fn a_navis_commands_run_unasked_and_only_a_browser_visit_goes_on_to_the_hub() {
        let folder = std::path::Path::new("/home/dev/navi/ada");
        let answer = |command: &str| {
            role_answer(
                SessionRole::Assistant,
                folder,
                &Fence::folder_only(folder, folder),
                "Bash",
                &serde_json::json!({ "command": command }),
            )
        };
        // Any command, the browser's included: the OS sandbox holds its writes to the folder (D208).
        for runs in [
            "ls -la",
            "cat /etc/passwd",
            "npx -y xaq-cli connect https://macbook.example --setup-mcp",
            "curl -s https://api.example/v1 | jq .items",
            "cd notes && grep -r dentist .",
            "agent-browser snapshot -i",
            "agent-browser click @e3",
            "agent-browser fill @e2 'Ana Ruiz'",
            "agent-browser screenshot /home/me/x.png",
            "agent-browser eval 'document.title'",
            "agent-browser get cdp-url",
            "agent-device tap 120 300",
        ] {
            assert!(
                matches!(answer(runs), Some(PermissionDecision::Allow { .. })),
                "{runs}"
            );
        }
        // A browser visit goes on to the hub's site gate, which allows a site the person allowed or linked.
        for visits in [
            "agent-browser open https://x.example",
            "agent-browser --json goto https://x.example",
            "agent-browser open 'https://x.example/a?b=c&d=e'",
            "agent-browser click @e3 && agent-browser open https://x.example",
            "cd notes && agent-browser open https://x.example",
            "agent-browser --cdp=9222 open https://x.example",
        ] {
            assert!(answer(visits).is_none(), "{visits}");
        }
    }

    #[test]
    fn the_node_answers_a_navis_file_tools_as_its_sandbox_does() {
        // A person's machine: their keys, fleetd's dir with the Navi's folder and home, another Navi's home, their code.
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let fleetd = root.join(".fleetd");
        let folder = fleetd.join("node/navi/ada");
        let home = fleetd.join("node/navis/p1/home");
        let other = fleetd.join("node/navis/p2/home/.local/bin/tool");
        let ssh = root.join(".ssh/id_ed25519");
        let code = root.join("src/app/main.rs");
        let bashrc = root.join(".bashrc");
        for file in [&folder.join("notes.md"), &other, &ssh, &code, &bashrc] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "x").unwrap();
        }
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&ssh, folder.join("key")).unwrap();
        let fence = Fence {
            write: vec![folder.clone(), home.clone()],
            hide: vec![fleetd.clone(), root.join(".ssh")],
            show: vec![bashrc.clone()],
            keep: ASSISTANT_KEPT.iter().map(|k| folder.join(k)).collect(),
            ..Fence::default()
        };
        let answer = |tool: &str, input: serde_json::Value| {
            role_answer(SessionRole::Assistant, &folder, &fence, tool, &input)
        };
        let allowed = |tool: &str, p: &Path| {
            let input = serde_json::json!({ "file_path": p, "content": "x" });
            matches!(answer(tool, input), Some(PermissionDecision::Allow { .. }))
        };
        // Anywhere the person can: their code, its own home, the machine.
        for p in [
            &code,
            &root.join("src/app/new.rs"),
            &home.join(".local/bin/hello"),
        ] {
            assert!(allowed("Write", p) && allowed("Read", p), "{}", p.display());
        }
        assert!(allowed("Read", Path::new("/etc/passwd")));
        assert!(allowed("Edit", Path::new("notes.md")));
        // Never their keys, however reached, fleetd's dir, or another Navi's home.
        for p in [
            &ssh,
            &folder.join("key"),
            &other,
            &fleetd.join("hub/hub.sqlite"),
        ] {
            assert!(
                !allowed("Read", p) && !allowed("Write", p),
                "{}",
                p.display()
            );
        }
        // What runs on its own reads, but takes no write; nor do its own settings.
        assert!(allowed("Read", &bashrc) && !allowed("Edit", &bashrc));
        assert!(!allowed("Write", &folder.join(".Claude/settings.json")));
        // A search that starts in a hidden dir is refused; one through the machine isn't.
        let search = |input: serde_json::Value| answer("Glob", input);
        assert!(matches!(
            search(serde_json::json!({ "pattern": format!("{}/*", root.join(".ssh").display()) })),
            Some(PermissionDecision::Deny { .. })
        ));
        assert!(matches!(
            search(serde_json::json!({ "pattern": "**/*.rs", "path": root.join("src") })),
            Some(PermissionDecision::Allow { .. })
        ));
    }

    #[test]
    fn without_its_sandbox_the_node_answers_a_navis_file_tools_inside_its_folder_only() {
        let home = tempfile::tempdir().unwrap();
        let folder = home.path().join("navi/ada");
        std::fs::create_dir_all(folder.join("notes")).unwrap();
        std::fs::write(home.path().join("mcp.json"), "{\"secret\": 1}").unwrap();
        std::os::unix::fs::symlink(home.path().join("mcp.json"), folder.join("notes/link.json"))
            .unwrap();
        let scratch = home.path().join("tmp/ab12");
        std::fs::create_dir_all(&scratch).unwrap();
        let answer = |tool: &str, input: serde_json::Value| {
            role_answer(
                SessionRole::Assistant,
                &folder,
                &Fence::folder_only(&folder, &scratch),
                tool,
                &input,
            )
        };
        let allowed = |tool: &str, input: serde_json::Value| {
            matches!(answer(tool, input), Some(PermissionDecision::Allow { .. }))
        };
        let refused = |tool: &str, input: serde_json::Value| {
            matches!(answer(tool, input), Some(PermissionDecision::Deny { .. }))
        };
        let file = |p: &str| serde_json::json!({ "file_path": p, "content": "x" });
        let inner = folder.join("notes/today.md").display().to_string();
        assert!(allowed("Read", file(&inner)));
        assert!(allowed("Write", file(&inner)));
        assert!(allowed("Edit", file("notes/today.md")));
        assert!(allowed("Glob", serde_json::json!({ "pattern": "**/*.md" })));
        assert!(
            allowed("Read", file(".claude/settings.json")),
            "it may read its settings"
        );
        // Outside the folder, through `..` or a symlink: refused, whoever would approve it.
        let secret = home.path().join("mcp.json").display().to_string();
        assert!(refused("Read", file(&secret)));
        assert!(refused("Read", file("/etc/passwd")));
        assert!(refused(
            "Grep",
            serde_json::json!({ "pattern": "key", "path": "/home" })
        ));
        assert!(refused("Read", file("notes/../../grace/x.md")));
        assert!(refused("Read", file("notes/link.json")));
        assert!(refused("Write", file("/home/me/.bashrc")));
        assert!(refused(
            "Write",
            file(&format!("{}x/a.md", folder.display()))
        ));
        // Its own claude settings and MCP servers stay as they are.
        assert!(refused("Write", file(".claude/settings.json")));
        assert!(refused(
            "Edit",
            file(&folder.join(".mcp.json").display().to_string())
        ));
        assert!(refused("Write", file(".fleetd/policy.yaml")));
        assert!(refused("Write", file("./.claude/settings.local.json")));
        assert!(allowed("Read", file(".fleetd/policy.yaml")));
        // Any other tool goes on to the hub; other roles get nothing here.
        assert!(
            answer(
                "WebFetch",
                serde_json::json!({ "url": "https://example.com" })
            )
            .is_none()
        );
        assert!(
            role_answer(
                SessionRole::Lead,
                &folder,
                &Fence::folder_only(&folder, &scratch),
                "Read",
                &file("/etc/passwd")
            )
            .is_none()
        );
        // Its session's scratch directory too, but not the session's other files beside it.
        let tmp = scratch.join("download.pdf").display().to_string();
        assert!(allowed("Write", file(&tmp)) && allowed("Read", file(&tmp)));
        assert!(refused(
            "Read",
            file(&home.path().join("tmp/other/x").display().to_string())
        ));
    }

    #[test]
    fn a_navis_settings_stay_unwritable_however_the_path_is_spelled() {
        // The folder as the node knows it goes through a symlinked ancestor, as /var is /private/var on macOS.
        let home = tempfile::tempdir().unwrap();
        let real_folder = home.path().join("private/var/navi/ada");
        std::fs::create_dir_all(real_folder.join(".claude")).unwrap();
        std::os::unix::fs::symlink(home.path().join("private/var"), home.path().join("var"))
            .unwrap();
        let folder = home.path().join("var/navi/ada");
        let scratch = home.path().join("tmp/ab12");
        let write = |p: &str| {
            role_answer(
                SessionRole::Assistant,
                &folder,
                &Fence::folder_only(&folder, &scratch),
                "Write",
                &serde_json::json!({ "file_path": p, "content": "{}" }),
            )
        };
        let refused = |p: &str| matches!(write(p), Some(PermissionDecision::Deny { .. }));
        let real = real_folder.display().to_string();
        let linked = folder.display().to_string();
        for path in [
            // Case variants, which a disk that ignores case writes into the real files.
            ".Claude/settings.local.json".to_owned(),
            ".MCP.json".to_owned(),
            ".FLEETD/policy.yaml".to_owned(),
            // The folder spelled through its real path, and through the symlink.
            format!("{real}/.claude/settings.json"),
            format!("{linked}/.mcp.json"),
            format!("{real}/.fleetd/policy.yaml"),
        ] {
            assert!(refused(&path), "{path}");
        }
        // Its own notes, however spelled, still write.
        for path in [
            format!("{real}/notes.md"),
            format!("{linked}/notes.md"),
            "Claude.md".to_owned(),
        ] {
            assert!(
                matches!(write(&path), Some(PermissionDecision::Allow { .. })),
                "{path}"
            );
        }
        // A pattern that reaches outside the folder is refused, as a path would be.
        let search = |tool: &str, input: serde_json::Value| {
            role_answer(
                SessionRole::Assistant,
                &folder,
                &Fence::folder_only(&folder, &scratch),
                tool,
                &input,
            )
        };
        for (tool, input) in [
            ("Glob", serde_json::json!({ "pattern": "/home/**/.ssh/*" })),
            ("Glob", serde_json::json!({ "pattern": "../../**" })),
            ("Glob", serde_json::json!({ "pattern": "~/.config/**" })),
            (
                "Grep",
                serde_json::json!({ "pattern": "token", "glob": "../**/*.json" }),
            ),
        ] {
            assert!(
                matches!(
                    search(tool, input.clone()),
                    Some(PermissionDecision::Deny { .. })
                ),
                "{input}"
            );
        }
        assert!(matches!(
            search("Glob", serde_json::json!({ "pattern": "notes/**/*.md" })),
            Some(PermissionDecision::Allow { .. })
        ));
        assert!(matches!(
            search("Grep", serde_json::json!({ "pattern": "/etc/passwd" })),
            Some(PermissionDecision::Allow { .. })
        ));
    }

    #[test]
    fn a_navis_browser_config_stays_fleetds() {
        let home = tempfile::tempdir().unwrap();
        let folder = home.path().join("navi/ada");
        std::fs::create_dir_all(&folder).unwrap();
        let scratch = home.path().join("tmp/ab12");
        let answer = |tool: &str, input: serde_json::Value| {
            role_answer(
                SessionRole::Assistant,
                &folder,
                &Fence::folder_only(&folder, &scratch),
                tool,
                &input,
            )
        };
        // Its project config is one of the files it never writes, in any case.
        let write = |p: &str| {
            answer(
                "Write",
                serde_json::json!({ "file_path": p, "content": "{}" }),
            )
        };
        for p in ["agent-browser.json", "Agent-Browser.JSON"] {
            assert!(
                matches!(write(p), Some(PermissionDecision::Deny { .. })),
                "{p}"
            );
        }
        // A pattern is answered by where it starts searching; what its braces spell, the sandbox holds.
        assert!(matches!(
            answer("Glob", serde_json::json!({ "pattern": "**/*.{md,txt}" })),
            Some(PermissionDecision::Allow { .. })
        ));
    }

    #[test]
    fn only_a_task_agent_gets_the_command_cap_and_its_own_setting_wins() {
        assert!(role_env(SessionRole::Lead, &[]).is_empty());
        assert_eq!(
            role_env(SessionRole::Worker, &[]),
            [("BASH_MAX_TIMEOUT_MS".to_owned(), "280000".to_owned())]
        );
        let set = [("BASH_MAX_TIMEOUT_MS".to_owned(), "900000".to_owned())];
        assert!(role_env(SessionRole::Worker, &set).is_empty());
    }

    fn spec() -> SessionSpec {
        SessionSpec {
            session_id: "7f0c0000-0000-4000-8000-000000000001".into(),
            resume: false,
            must_resume: false,
            cwd: "/work/project".into(),
            add_dirs: vec!["/work/root".into()],
            model: "claude-haiku-5-5".into(),
            effort: Effort::Max,
            helper_model: "claude-opus-5-5".into(),
            runtime_mode: RuntimeMode::ApprovalRequired,
            allowed_tools: vec![
                "Bash(npm test:*)".into(),
                r#"Bash(git commit -m "a, b")"#.into(),
            ],
            allowed_only: false,
            system_prompt: None,
            disallowed_tools: vec!["Task".into(), "WebFetch".into()],
            mcp_config: None,
            strict_mcp: false,
            settings: None,
            plugin_dirs: Vec::new(),
            env: Vec::new(),
            transcript: None,
            sandbox: None,
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
            strict_mcp: false,
            settings: Some("/n/settings.json".into()),
            ..spec()
        };
        let args = runner.args(&resumed).join(" ");
        assert!(args.contains("--resume 7f0c0000-0000-4000-8000-000000000001 "));
        assert!(args.contains("--permission-mode bypassPermissions --disallowedTools"));
        // fleetd's servers and settings are added to the user's own, never in place of them.
        assert!(args.contains("--mcp-config /n/mcp.json --settings /n/settings.json "));
        assert!(!args.contains("--strict-mcp-config"));
        // With the person's own servers turned off, claude loads fleetd's file only.
        let strict = SessionSpec {
            strict_mcp: true,
            ..resumed
        };
        let args = runner.args(&strict).join(" ");
        assert!(
            args.contains(
                "--mcp-config /n/mcp.json --strict-mcp-config --settings /n/settings.json "
            )
        );
    }

    #[test]
    fn standing_rules_go_in_the_system_prompt_at_every_start() {
        let runner = ClaudeRunner::new("claude".into());
        let rules = "## Your voice\nShort and casual.";
        for resume in [false, true] {
            let spec = SessionSpec {
                resume,
                system_prompt: Some(rules.into()),
                ..spec()
            };
            let args = runner.args(&spec);
            let at = args
                .iter()
                .position(|a| a == "--append-system-prompt")
                .unwrap();
            // One argument, verbatim: a compaction summarizes the conversation, never this.
            assert_eq!(args[at + 1], rules);
        }
        assert!(
            !runner
                .args(&spec())
                .iter()
                .any(|a| a == "--append-system-prompt")
        );
    }

    #[test]
    fn a_session_held_to_its_allowed_tools_loads_only_those_and_asks_for_the_rest() {
        let runner = ClaudeRunner::new("claude".into());
        let memory = [
            "mcp__fleetd__memory_read",
            "mcp__fleetd__remember",
            "mcp__fleetd__forget",
        ]
        .map(String::from)
        .to_vec();
        // Even under full access: bypassPermissions would run any tool unasked.
        let held = SessionSpec {
            runtime_mode: RuntimeMode::FullAccess,
            allowed_tools: memory.clone(),
            allowed_only: true,
            ..spec()
        };
        let args = runner.args(&held);
        let joined = args.join(" ");
        assert!(
            joined.contains(
                "--permission-mode manual --tools  --allowedTools mcp__fleetd__memory_read mcp__fleetd__remember \
                 mcp__fleetd__forget --disallowedTools"
            ),
            "{joined}"
        );
        // `--tools ""`: no runtime tool at all, as one empty argument.
        let at = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[at + 1], "");
        // A runtime tool it is allowed is the only one it loads.
        let reads = SessionSpec {
            allowed_tools: [memory, vec!["Read(//memory/**)".into(), "Read".into()]].concat(),
            ..held
        };
        let args = runner.args(&reads);
        let at = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[at + 1], "Read");
        // Any other session loads the runtime's tools as before.
        assert!(!runner.args(&spec()).iter().any(|a| a == "--tools"));
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
