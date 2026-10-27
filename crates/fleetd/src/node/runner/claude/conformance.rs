//! The zero-cost probe of the installed claude: `claude --version`, then one stream-json `initialize` control
//! request with stdin closed after the answer. No user message is sent, so claude makes no model call. The doctor,
//! the node (at start, and again while its claude can't run sessions) and CI (against a stand-in replaying the recorded
//! answer) use it.
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use fleetd_contracts::sessions::{LoginStatus, RunnerInfo, RunnerKind};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::protocol::Line;
use super::version::{self, SUPPORTED, TESTED, VersionVerdict};
use super::{AGENT_TOOLS, AUTO_MEMORY_OFF_ENV, AUTO_MEMORY_OFF_SETTINGS};
use super::{failure, setup};

/// `system/init.capabilities` the runner relies on (interrupt receipts, cancelling queued sends, run lifecycle).
/// They arrive only with a turn, so the runner checks them on its first `Init` rather than here.
pub const REQUIRED_INIT_CAPABILITIES: &[&str] = &[
    "interrupt_receipt_v1",
    "interrupt_cancel_queued_v1",
    "msg_lifecycle_v1",
];

/// Optional: a steer sent with ⌘Enter stops the running step with `interrupt {send_now}`. Without it the runner falls
/// back to an interrupt scoped to the running message (`interrupt_receipt_v1`), then to a plain interrupt.
pub const SEND_NOW_CAPABILITY: &str = "interrupt_send_now_v1";

const REQUEST_ID: &str = "fleetd-probe-1";
/// The probe's argv: no model, no MCP servers (starting them would cost time, not decide anything), and only the
/// user settings of the config dir sessions use (they may carry the proxy or gateway variables, which decide the
/// login). Auto memory off, as in every claude fleetd starts.
const PROBE_ARGS: &[&str] = &[
    "-p",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--strict-mcp-config",
    "--setting-sources",
    "user",
    "--settings",
    AUTO_MEMORY_OFF_SETTINGS,
];
/// claude answers in about 0.2 s; a cold start of a 280 MB binary on a loaded machine takes a few.
const TIMEOUT: Duration = Duration::from_secs(30);
/// Bytes of the probe's stderr kept for its error.
const STDERR_KEEP: usize = 8192;
const INSTALL_FIX: &str = version::INSTALL;

/// `initialize`'s `account`: which credential claude would use.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub token_source: Option<String>,
    pub api_key_source: Option<String>,
    pub api_provider: Option<String>,
    pub subscription_type: Option<String>,
    pub email: Option<String>,
}

/// Probes `binary` with exactly `env`: the environment a session would get (the user's own claude setup, plus the
/// optional `~/.fleetd/claude.env`).
pub async fn probe(binary: &Path, env: &[(String, String)]) -> RunnerInfo {
    let mut info = RunnerInfo {
        runner: RunnerKind::Claude,
        version: None,
        supported: SUPPORTED.to_owned(),
        version_ok: false,
        login: LoginStatus::Unknown,
        login_kind: None,
        conformance_ok: None,
        problem: None,
        login_label: None,
        proxy: None,
        proxy_source: None,
        config_dir: Some(setup::config_dir(env).to_string_lossy().into_owned()),
        self_update: Some(!super::install::autoupdater_off(
            &setup::config_dir(env).join("settings.json"),
        )),
        sandbox: super::super::sandbox::describe(),
    };
    if let Some((url, source)) = setup::proxy_of(env) {
        info.proxy = Some(url);
        info.proxy_source = Some(source);
    }
    let printed = match claude_version(binary, env).await {
        Ok(printed) => printed,
        Err(problem) => {
            info.problem = Some(problem);
            return info;
        }
    };
    // Outside the tested range is a doctor warning, never a refusal.
    info.version_ok = version::check(&printed) == VersionVerdict::Ok;
    let mut problems = Vec::new();
    info.version = Some(printed);
    match initialize(binary, env)
        .await
        .and_then(|line| read_initialize(&line))
    {
        Ok(answer) => {
            info.conformance_ok = Some(true);
            if let Some(reported) = &answer.claude_code_version
                && info
                    .version
                    .as_deref()
                    .and_then(|v| v.split_whitespace().next())
                    != Some(reported)
            {
                info.conformance_ok = Some(false);
                problems.push(format!(
                    "`claude --version` and the running claude disagree ({} vs {reported}): two installs on PATH? \
                     Fix: {INSTALL_FIX}",
                    info.version.as_deref().unwrap_or_default()
                ));
            }
            let (login, kind) = login_of(&answer.account);
            info.login = login;
            info.login_kind = Some(kind.to_owned());
            info.login_label = setup::login_label(&answer.account);
            if login == LoginStatus::LoggedOut {
                problems.push(format!(
                    "claude is not logged in. Fix: {}",
                    failure::login_fix(info.proxy.is_some())
                ));
            }
        }
        Err(problem) => {
            info.conformance_ok = Some(false);
            problems.push(format!(
                "{problem} This claude's stream-json differs from the one fleetd was tested with. Fix: claude \
                 install {TESTED}"
            ));
        }
    }
    info.problem = (!problems.is_empty()).then(|| problems.join(" "));
    info
}

/// A claude tool that starts, lists, messages or stops agents, teams, workflows or background tasks. MCP tools
/// (`mcp__…`, fleetd's own among them) never count.
pub fn agent_like(tool: &str) -> bool {
    if tool.starts_with("mcp__") {
        return false;
    }
    AGENT_TOOLS.contains(&tool)
        || tool.starts_with("Task")
        || ["Agent", "Team", "Workflow", "Subagent", "Swarm"]
            .iter()
            .any(|word| tool.contains(word))
}

fn command(binary: &Path, env: &[(String, String)]) -> Command {
    let mut cmd = Command::new(binary);
    cmd.env_clear()
        .envs(
            env.iter()
                .filter(|(k, _)| k != setup::FLEETD_ENV_SOURCE)
                .map(|(k, v)| (k, v)),
        )
        .env(AUTO_MEMORY_OFF_ENV.0, AUTO_MEMORY_OFF_ENV.1)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    cmd
}

/// `claude --version`'s first line.
async fn claude_version(binary: &Path, env: &[(String, String)]) -> Result<String, String> {
    let shown = binary.display();
    let run = command(binary, env).arg("--version").output();
    let out = match tokio::time::timeout(TIMEOUT, run).await {
        Err(_) => {
            return Err(format!(
                "`{shown} --version` did not answer within {}s.",
                TIMEOUT.as_secs()
            ));
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "claude is not installed ({shown} not found). Fix: {INSTALL_FIX}"
            ));
        }
        Ok(Err(e)) => {
            return Err(format!(
                "could not run `{shown} --version`: {e}. Fix: {INSTALL_FIX}"
            ));
        }
        Ok(Ok(out)) => out,
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let first = stdout.lines().next().unwrap_or_default().trim();
    if !out.status.success() || first.is_empty() {
        return Err(format!(
            "`{shown} --version` failed ({}): {}. Fix: {INSTALL_FIX}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(first.to_owned())
}

/// Sends `initialize` and returns claude's answer line; stdin is closed once it arrives, which ends the process.
async fn initialize(binary: &Path, env: &[(String, String)]) -> Result<String, String> {
    let mut child = command(binary, env)
        .args(PROBE_ARGS)
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start claude for the conformance probe: {e}."))?;
    let request = serde_json::json!({
        "type": "control_request",
        "request_id": REQUEST_ID,
        "request": { "subtype": "initialize" },
    });
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    // Drained alongside stdout so a chatty stderr can't fill its pipe and stall claude; only the tail is kept.
    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr_tail = tokio::spawn(async move {
        let (mut kept, mut chunk) = (Vec::new(), [0u8; 4096]);
        while let Ok(n @ 1..) = stderr.read(&mut chunk).await {
            kept.extend_from_slice(&chunk[..n]);
            let excess = kept.len().saturating_sub(STDERR_KEEP);
            kept.drain(..excess);
        }
        String::from_utf8_lossy(&kept).into_owned()
    });
    let mut skipped = None;
    let exchange = async {
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|e| format!("could not write the initialize request: {e}."))?;
        while let Some(line) = stdout.next_line().await.map_err(|e| e.to_string())? {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                // A stray banner or warning on stdout: note it, and only fail if no answer follows.
                tracing::warn!(line = %tail(&line, 200), "claude printed a non-JSON line during the probe");
                skipped.get_or_insert(line);
                continue;
            };
            if value["type"] == "control_response" {
                return Ok(Some(line));
            }
        }
        Ok(None)
    };
    let answer = tokio::time::timeout(TIMEOUT, exchange).await;
    drop(stdin);
    let skipped = skipped
        .map(|l| {
            format!(
                " It printed a non-JSON line on stdout: {:?}.",
                tail(&l, 200)
            )
        })
        .unwrap_or_default();
    let answer = match answer {
        Err(_) => Err(format!(
            "claude did not answer the initialize probe within {}s.{skipped}",
            TIMEOUT.as_secs()
        )),
        Ok(Err(e)) => Err(e),
        Ok(Ok(Some(line))) => Ok(line),
        Ok(Ok(None)) => {
            let text = tokio::time::timeout(TIMEOUT, stderr_tail)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
            Err(format!(
                "claude exited without answering the initialize probe: {}.{skipped}",
                tail(text.trim(), 2000)
            ))
        }
    };
    // stdin is closed; claude exits on its own. kill_on_drop covers one that doesn't.
    let _ = tokio::time::timeout(TIMEOUT, child.wait()).await;
    answer
}

fn tail(s: &str, chars: usize) -> &str {
    let skip = s.chars().count().saturating_sub(chars);
    s.char_indices().nth(skip).map_or(s, |(i, _)| &s[i..])
}

/// The parts of the initialize answer fleetd reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InitializeAnswer {
    pub account: Account,
    pub capabilities: Vec<String>,
    pub claude_code_version: Option<String>,
}

/// Checks the initialize answer's shape: a success for our request carrying `account` and `capabilities`.
pub fn read_initialize(line: &str) -> Result<InitializeAnswer, String> {
    let Ok(Line::ControlResponse(resp)) = serde_json::from_str::<Line>(line) else {
        return Err(
            "claude's initialize answer is not a control_response fleetd can read.".to_owned(),
        );
    };
    let body = resp.response;
    if body.request_id != REQUEST_ID {
        return Err(format!(
            "claude answered request {:?}, not fleetd's initialize.",
            body.request_id
        ));
    }
    if body.subtype != "success" {
        return Err(format!(
            "claude refused the initialize probe: {}.",
            body.error.as_deref().unwrap_or(&body.subtype)
        ));
    }
    let answer = body.response.unwrap_or(Value::Null);
    let account = match answer.get("account") {
        Some(account @ Value::Object(_)) => Account::deserialize(account)
            .map_err(|e| format!("claude's initialize `account` has an unexpected shape: {e}."))?,
        _ => return Err("claude's initialize answer has no `account`.".to_owned()),
    };
    let capabilities = answer
        .get("capabilities")
        .and_then(Value::as_array)
        .and_then(|caps| {
            caps.iter()
                .map(|c| c.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        })
        .ok_or("claude's initialize answer has no `capabilities` list.")?;
    Ok(InitializeAnswer {
        account,
        capabilities,
        claude_code_version: answer
            .get("claude_code_version")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// Login state and kind ("subscription", "api_key", "token" or "none") from the credential claude would use.
/// An expired login still reads as logged in here; the first Auth failure marks it logged out.
pub fn login_of(account: &Account) -> (LoginStatus, &'static str) {
    fn set(v: &Option<String>) -> Option<&str> {
        v.as_deref().filter(|s| !s.is_empty() && *s != "none")
    }
    if account
        .api_provider
        .as_deref()
        .is_some_and(|p| p != "firstParty")
    {
        // Bedrock, Vertex, an enterprise gateway, …: the credential lives outside claude.
        return (LoginStatus::LoggedIn, "token");
    }
    if account.subscription_type.is_some()
        || matches!(
            set(&account.token_source),
            Some("claude.ai" | "CLAUDE_CODE_OAUTH_TOKEN")
        )
    {
        return (LoginStatus::LoggedIn, "subscription");
    }
    if set(&account.token_source).is_some() {
        return (LoginStatus::LoggedIn, "token");
    }
    if set(&account.api_key_source).is_some() {
        return (LoginStatus::LoggedIn, "api_key");
    }
    (LoginStatus::LoggedOut, "none")
}

/// The [`REQUIRED_INIT_CAPABILITIES`] a `system/init` lacks.
pub fn missing_init_capabilities(capabilities: &[String]) -> Vec<&'static str> {
    REQUIRED_INIT_CAPABILITIES
        .iter()
        .copied()
        .filter(|need| !capabilities.iter().any(|c| c == need))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    use super::*;
    use crate::node::runner::claude::ALWAYS_DISALLOWED;

    fn fixture_out(name: &str) -> Vec<Value> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/node/runner/fixtures")
            .join(format!("claude-2.1.302-{name}.jsonl"));
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|r| r["dir"] == "out")
            .map(|r| r["msg"].clone())
            .collect()
    }

    /// The answer claude 2.1.302 gave, with an empty config dir and no credentials.
    fn recorded_answer() -> Value {
        fixture_out("initialize-probe").remove(0)
    }

    /// The recorded answer as another claude version would give it.
    fn recorded_answer_for(version: &str) -> Value {
        let mut answer = recorded_answer();
        answer["response"]["response"]["claude_code_version"] = Value::String(version.to_owned());
        answer
    }

    fn account(json: Value) -> Account {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn the_recorded_initialize_answer_conforms() {
        let answer = read_initialize(&recorded_answer().to_string()).unwrap();
        assert_eq!(answer.claude_code_version.as_deref(), Some("2.1.302"));
        assert_eq!(
            answer.account,
            account(serde_json::json!({"tokenSource": "none", "apiProvider": "firstParty"}))
        );
        assert!(!answer.capabilities.is_empty());
        assert_eq!(login_of(&answer.account), (LoginStatus::LoggedOut, "none"));
    }

    #[test]
    fn a_changed_initialize_answer_is_named() {
        let mut no_account = recorded_answer();
        no_account["response"]["response"]
            .as_object_mut()
            .unwrap()
            .remove("account");
        let mut caps_renamed = recorded_answer();
        let body = caps_renamed["response"]["response"]
            .as_object_mut()
            .unwrap();
        let caps = body.remove("capabilities").unwrap();
        body.insert("features".into(), caps);
        let mut refused = recorded_answer();
        refused["response"] =
            serde_json::json!({"subtype": "error", "request_id": REQUEST_ID, "error": "nope"});
        let mut other_id = recorded_answer();
        other_id["response"]["request_id"] = "someone-else".into();
        for (answer, want) in [
            (no_account, "has no `account`"),
            (caps_renamed, "has no `capabilities` list"),
            (refused, "refused the initialize probe: nope"),
            (other_id, "answered request \"someone-else\""),
            (
                serde_json::json!({"type": "result"}),
                "not a control_response",
            ),
        ] {
            let got = read_initialize(&answer.to_string()).unwrap_err();
            assert!(got.contains(want), "{got}");
        }
    }

    /// `account` as claude 2.1.302 reported it for each credential (observed with fake values), plus a claude.ai
    /// login from the SDK's types.
    #[test]
    fn login_kind_follows_the_credential_claude_would_use() {
        use LoginStatus::*;
        for (json, want) in [
            (
                serde_json::json!({"tokenSource": "none", "apiProvider": "firstParty"}),
                (LoggedOut, "none"),
            ),
            (
                serde_json::json!({"tokenSource": "ANTHROPIC_AUTH_TOKEN", "apiProvider": "firstParty"}),
                (LoggedIn, "token"),
            ),
            (
                serde_json::json!({"tokenSource": "none", "apiKeySource": "ANTHROPIC_API_KEY", "apiProvider": "firstParty"}),
                (LoggedIn, "api_key"),
            ),
            (
                serde_json::json!({"tokenSource": "CLAUDE_CODE_OAUTH_TOKEN", "apiProvider": "firstParty"}),
                (LoggedIn, "subscription"),
            ),
            (
                serde_json::json!({"email": "a@b.c", "subscriptionType": "max", "tokenSource": "claude.ai", "apiProvider": "firstParty"}),
                (LoggedIn, "subscription"),
            ),
            (
                serde_json::json!({"apiProvider": "bedrock"}),
                (LoggedIn, "token"),
            ),
        ] {
            assert_eq!(login_of(&account(json.clone())), want, "{json}");
        }
    }

    #[test]
    fn the_recorded_init_has_every_capability_the_runner_needs() {
        let init = fixture_out("init-partial-two-turns")
            .into_iter()
            .find(|m| m["type"] == "system" && m["subtype"] == "init")
            .unwrap();
        let caps: Vec<String> = serde_json::from_value(init["capabilities"].clone()).unwrap();
        assert_eq!(missing_init_capabilities(&caps), Vec::<&str>::new());
        let fewer: Vec<String> = caps
            .into_iter()
            .filter(|c| c != "msg_lifecycle_v1")
            .collect();
        assert_eq!(missing_init_capabilities(&fewer), vec!["msg_lifecycle_v1"]);
    }

    /// A stand-in `claude`: prints `version` for `--version`; otherwise reads the initialize request, then a
    /// non-JSON stdout line and 200 KB of stderr (past any pipe buffer), then `answer`, and waits for stdin to
    /// close. With an empty `answer` it exits 1 with "boom" on stderr instead.
    fn stand_in(dir: &Path, version: &str, answer: &str) -> PathBuf {
        use std::io::Write;
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let answer_path = dir.join(format!("answer-{n}.json"));
        std::fs::write(&answer_path, answer).unwrap();
        let script = format!(
            "#!/bin/sh\n\
             if [ \"$1\" = --version ]; then echo '{version}'; exit 0; fi\n\
             read -r request\n\
             if [ ! -s '{a}' ]; then echo boom >&2; exit 1; fi\n\
             echo 'Claude Code: a banner, not JSON'\n\
             head -c 200000 /dev/zero | tr '\\0' x >&2\n\
             cat '{a}'\n\
             while read -r more; do :; done\n",
            a = answer_path.display()
        );
        // Written under a temp name, synced, closed and renamed, so nothing execs a half-written file.
        let tmp = dir.join(format!(".claude-{n}.tmp"));
        let mut file = std::fs::File::create(&tmp).unwrap();
        file.write_all(script.as_bytes()).unwrap();
        file.set_permissions(std::fs::Permissions::from_mode(0o755))
            .unwrap();
        file.sync_all().unwrap();
        drop(file);
        let bin = dir.join(format!("claude-{n}"));
        std::fs::rename(&tmp, &bin).unwrap();
        wait_until_executable(&bin);
        bin
    }

    /// Linux refuses to exec a file while any process holds it open for writing (ETXTBSY). Tests run in parallel
    /// threads, so a child another test forks while our write fd is open inherits it until that child execs
    /// (O_CLOEXEC closes it then). That window is microseconds; retry the exec through it.
    fn wait_until_executable(bin: &Path) {
        const ETXTBSY: i32 = 26;
        for _ in 0..200 {
            match std::process::Command::new(bin).arg("--version").output() {
                Err(e) if e.raw_os_error() == Some(ETXTBSY) => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                Err(e) => panic!("stand-in claude: {e}"),
                Ok(_) => return,
            }
        }
        panic!("stand-in claude stayed busy (ETXTBSY)");
    }

    /// A HOME with no claude settings, so the user's own proxy can't change what these tests see.
    fn env() -> Vec<(String, String)> {
        vec![
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), "/nonexistent/fleetd-test-home".into()),
        ]
    }

    #[tokio::test]
    async fn probe_reads_version_answer_and_login_through_the_process() {
        let dir = tempfile::tempdir().unwrap();
        let bin = stand_in(
            dir.path(),
            "2.1.302 (Claude Code)",
            &format!("{}\n", recorded_answer()),
        );
        let info = probe(&bin, &env()).await;
        assert_eq!(info.version.as_deref(), Some("2.1.302 (Claude Code)"));
        assert!(info.version_ok);
        assert_eq!(info.conformance_ok, Some(true));
        assert_eq!(
            (info.login, info.login_kind.as_deref()),
            (LoginStatus::LoggedOut, Some("none"))
        );
        assert_eq!(
            info.problem.unwrap(),
            "claude is not logged in. Fix: claude auth login"
        );
    }

    #[tokio::test]
    async fn probe_names_each_problem_with_its_fix() {
        let dir = tempfile::tempdir().unwrap();
        let mut token = recorded_answer();
        token["response"]["response"]["account"] =
            serde_json::json!({"tokenSource": "ANTHROPIC_AUTH_TOKEN"});

        // Past the tested range: only a doctor warning, so the problem is the answer saying 2.1.302 while --version
        // says 2.2.1.
        let bin = stand_in(dir.path(), "2.2.1 (Claude Code)", &format!("{token}\n"));
        let info = probe(&bin, &env()).await;
        assert!(!info.version_ok);
        assert_eq!(
            (info.login, info.conformance_ok),
            (LoginStatus::LoggedIn, Some(false))
        );
        let problem = info.problem.unwrap();
        assert!(
            problem.starts_with("`claude --version` and the running claude disagree"),
            "{problem}"
        );
        let bin = stand_in(
            dir.path(),
            "2.2.1 (Claude Code)",
            &format!("{}\n", recorded_answer_for("2.2.1")),
        );
        let info = probe(&bin, &env()).await;
        assert_eq!((info.version_ok, info.conformance_ok), (false, Some(true)));

        // Older than tested: it runs, and nothing is a problem when its protocol answers.
        let bin = stand_in(
            dir.path(),
            "2.1.296 (Claude Code)",
            &format!("{}\n", recorded_answer_for("2.1.296")),
        );
        let info = probe(&bin, &env()).await;
        assert_eq!(info.conformance_ok, Some(true), "{info:?}");

        let bin = stand_in(dir.path(), "2.1.302 (Claude Code)", "");
        let info = probe(&bin, &env()).await;
        assert_eq!(info.conformance_ok, Some(false));
        let problem = info.problem.unwrap();
        assert!(
            problem.starts_with("claude exited without answering the initialize probe: boom."),
            "{problem}"
        );
        assert!(
            problem.ends_with("Fix: claude install 2.1.302"),
            "{problem}"
        );

        let info = probe(&dir.path().join("missing/claude"), &env()).await;
        assert_eq!(
            (info.version, info.version_ok, info.conformance_ok),
            (None, false, None)
        );
        assert!(
            info.problem
                .unwrap()
                .ends_with("Fix: curl -fsSL https://claude.ai/install.sh | bash")
        );
    }

    /// The tool list of claude 2.1.302 as recorded; a later claude may add tools under new names.
    #[test]
    fn the_agent_tools_are_derived_from_the_names_claude_reports() {
        let init = fixture_out("init-partial-two-turns")
            .into_iter()
            .find(|m| m["type"] == "system" && m["subtype"] == "init")
            .unwrap();
        let tools: Vec<String> = serde_json::from_value(init["tools"].clone()).unwrap();
        let found: Vec<&str> = tools
            .iter()
            .map(String::as_str)
            .filter(|t| agent_like(t))
            .collect();
        assert_eq!(
            found,
            ["Task", "ListAgents", "SendMessage", "TaskStop", "Workflow"]
        );
        for later in [
            "TeamCreate",
            "TaskOutput",
            "BackgroundAgentLaunch",
            "SubagentFork",
            "TaskCreate",
        ] {
            assert!(agent_like(later), "{later}");
        }
        for not in [
            "Bash",
            "Read",
            "Skill",
            "ToolSearch",
            "mcp__fleetd__spawn_agent",
            "mcp__x__SendMessage",
        ] {
            assert!(!agent_like(not), "{not}");
        }
        assert!(AGENT_TOOLS.iter().all(|t| ALWAYS_DISALLOWED.contains(t)));
    }
}
