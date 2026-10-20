//! One `claude -p` run on the hub machine for the hub itself (the retro). It uses the login the user's own `claude`
//! uses (~/.claude: OAuth, or a base URL and token in its settings' env), in safe mode so none of the user's hooks,
//! plugins, MCP servers or CLAUDE.md load, and nothing of any `CLAUDE*` session the hub was started from.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

pub const DEFAULT_ONE_SHOT_MODEL: &str = "claude-haiku-5-5";
const RUN_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_STDOUT: usize = 1 << 20;

/// Copied from the hub's environment into the run: what lets `claude` reach the user's login or proxy. The same
/// variables `fleetd init` checks the hub's claude with from `claude.env`, so a login that passes there works here.
pub const LOGIN_ENV: [&str; 4] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
];
const BASE_ENV: [&str; 4] = ["HOME", "PATH", "USER", "LANG"];

/// No tools, no MCP servers, no saved session, and none of the user's customizations; the login still applies.
pub const ONE_SHOT_FLAGS: [&str; 5] = [
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--safe-mode",
];

/// The one-shot's `--settings`: auto memory off, and claude's own subagents off as in every claude fleetd starts.
pub fn one_shot_settings() -> String {
    serde_json::json!({
        "autoMemoryEnabled": false,
        "env": crate::node::runner::claude::subagents_off_settings_env(),
    })
    .to_string()
}

/// The one-shot's full argv after the binary. It has no tools at all (`--tools ""`); the deny list still names the
/// agent tools, so a claude that ignored `--tools` would not get them either.
pub fn one_shot_args(model: &str) -> Vec<String> {
    let mut args: Vec<String> = ["-p", "--output-format", "json", "--model", model]
        .iter()
        .chain(ONE_SHOT_FLAGS.iter())
        .map(|a| (*a).to_owned())
        .collect();
    args.push("--disallowedTools".into());
    args.extend(crate::node::runner::claude::disallowed_tools([]));
    args.push("--settings".into());
    args.push(one_shot_settings());
    args
}

/// One `claude` run, recorded as `orchestrator` usage. Tokens only when the CLI reported them.
#[derive(Debug, Clone, PartialEq)]
pub struct OneShotRun {
    pub kind: &'static str,
    pub model: String,
    pub duration_ms: u64,
    pub ok: bool,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Why the run gave no usable answer.
    pub error: Option<String>,
}

/// The child's whole environment: an allowlist, so the hub's own `CLAUDE*` variables never reach it. Without
/// `CLAUDE_CONFIG_DIR`, `claude` reads the user's login from `$HOME/.claude`, as it does in their own shell. Auto
/// memory is always off (`AUTO_MEMORY_OFF_ENV`).
pub fn one_shot_env(source: &HashMap<String, String>) -> Vec<(String, String)> {
    let (memory_key, memory_off) = crate::node::runner::claude::AUTO_MEMORY_OFF_ENV;
    BASE_ENV
        .iter()
        .chain(LOGIN_ENV.iter())
        .filter_map(|k| {
            source
                .get(*k)
                .filter(|v| !v.is_empty())
                .map(|v| (k.to_string(), v.clone()))
        })
        .chain([(memory_key.to_owned(), memory_off.to_owned())])
        .chain(
            crate::node::runner::claude::SUBAGENTS_OFF_ENV
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
        )
        .collect()
}

#[derive(Debug, Default, PartialEq)]
pub struct Envelope {
    pub text: Option<String>,
    pub error: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

fn count(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map_or(0, |n| n as u64)
}

/// `claude -p --output-format json` stdout: the `result` text and the usage it reports.
pub fn read_envelope(stdout: &str) -> Envelope {
    let no_json = || Envelope {
        error: Some("the CLI printed no JSON result".into()),
        ..Default::default()
    };
    let Ok(Value::Object(e)) = serde_json::from_str::<Value>(stdout) else {
        return no_json();
    };
    let mut out = Envelope::default();
    if let Some(Value::Object(usage)) = e.get("usage") {
        out.input_tokens = Some(
            count(usage.get("input_tokens"))
                + count(usage.get("cache_creation_input_tokens"))
                + count(usage.get("cache_read_input_tokens")),
        );
        out.output_tokens = Some(count(usage.get("output_tokens")));
    }
    match e.get("result") {
        Some(Value::String(text)) if e.get("is_error") != Some(&Value::Bool(true)) => {
            out.text = Some(text.clone())
        }
        other => {
            let shown = match other {
                Some(Value::String(s)) => s.clone(),
                None | Some(Value::Null) => "no result".into(),
                Some(v) => v.to_string(),
            };
            out.error = Some(format!(
                "the CLI reported an error: {}",
                shown.chars().take(200).collect::<String>()
            ));
        }
    }
    out
}

/// The answer text of one run, None when the run failed (`run.error` says why), and the run as orchestrator usage.
pub struct OneShotResult {
    pub text: Option<String>,
    pub run: OneShotRun,
}

/// The `claude -p --output-format json` runner: the user's own login, the empty
/// `<home>/claude-router` as cwd (so no project CLAUDE.md applies), the allowlisted environment and `ONE_SHOT_FLAGS`.
pub struct OneShot {
    model: String,
    cwd: PathBuf,
    env: Vec<(String, String)>,
    timeout: Duration,
}

impl OneShot {
    /// `env` is where the login variables and PATH come from: the hub's own environment in production.
    pub fn new(
        home: &Path,
        model: Option<String>,
        env: &HashMap<String, String>,
        timeout: Option<Duration>,
    ) -> std::io::Result<Self> {
        let cwd = home.join("claude-router");
        let mut dir = std::fs::DirBuilder::new();
        dir.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut dir, 0o700);
        dir.create(&cwd)?;
        Ok(Self {
            model: model.unwrap_or_else(|| DEFAULT_ONE_SHOT_MODEL.into()),
            cwd,
            env: one_shot_env(env),
            timeout: timeout.unwrap_or(RUN_TIMEOUT),
        })
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub async fn run(&self, prompt: &str) -> OneShotResult {
        let started = Instant::now();
        let exit = self.spawn(prompt).await;
        let duration_ms = started.elapsed().as_millis() as u64;
        let (envelope, failed) = match exit {
            Err(spawn_error) => (
                Envelope::default(),
                Some(format!("could not start claude: {spawn_error}")),
            ),
            Ok((code, stdout, stderr)) => {
                let envelope = read_envelope(&stdout);
                let failed = envelope.error.clone().or_else(|| match code {
                    Some(0) => None,
                    code => {
                        let tail = tail_chars(stderr.trim(), 200);
                        Some(format!(
                            "claude exited with {}: {tail}",
                            code.map_or("a signal".to_string(), |c| c.to_string())
                        ))
                    }
                });
                (envelope, failed)
            }
        };
        let run = OneShotRun {
            kind: "orchestrator",
            model: self.model.clone(),
            duration_ms,
            ok: failed.is_none(),
            input_tokens: envelope.input_tokens,
            output_tokens: envelope.output_tokens,
            error: failed.as_ref().map(|f| f.chars().take(300).collect()),
        };
        OneShotResult {
            text: if failed.is_none() {
                Some(envelope.text.unwrap_or_default())
            } else {
                None
            },
            run,
        }
    }

    /// Runs `claude` once with the prompt on stdin, killed at the timeout.
    async fn spawn(&self, prompt: &str) -> Result<(Option<i32>, String, String), String> {
        let mut child = Command::new("claude")
            .args(one_shot_args(&self.model))
            .current_dir(&self.cwd)
            .env_clear()
            .envs(self.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "spawn claude ENOENT".to_string()
                } else {
                    e.to_string()
                }
            })?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        let mut stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        let prompt = prompt.to_string();
        let write = async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            drop(stdin);
        };
        let read_out = async move {
            let mut buf = Vec::new();
            let _ = (&mut stdout)
                .take(MAX_STDOUT as u64)
                .read_to_end(&mut buf)
                .await;
            String::from_utf8_lossy(&buf).into_owned()
        };
        let read_err = async move {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf).await;
            tail_chars(&String::from_utf8_lossy(&buf), 2000)
        };
        let all = async {
            let (_, out, err, status) = tokio::join!(write, read_out, read_err, child.wait());
            (status.ok().and_then(|s| s.code()), out, err)
        };
        match tokio::time::timeout(self.timeout, all).await {
            Ok(done) => Ok(done),
            Err(_) => Ok((None, String::new(), "timed out".into())),
        }
    }
}

fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A stand-in `claude` first on PATH: records each call (args, environment, stdin) next to itself and prints the
    /// next canned reply. No model is ever called.
    const FAKE: &str = r#"#!/bin/sh
dir="$(dirname "$0")/../calls"
n=$(ls "$dir" | grep -c '\.prompt$')
n=$((n + 1))
cat > "$dir/call-$n.prompt"
for a in "$@"; do printf '[%s]\n' "$a"; done > "$dir/call-$n.args"
env > "$dir/call-$n.env"
[ -f "$dir/reply-$n.out" ] || exit 1
cat "$dir/reply-$n.out"
exit "$(cat "$dir/reply-$n.exit")"
"#;

    struct Fake {
        root: tempfile::TempDir,
        env: HashMap<String, String>,
    }

    impl Fake {
        fn new(replies: &[(&str, i32)]) -> Self {
            let root = tempfile::tempdir().unwrap();
            let (bin, calls) = (root.path().join("bin"), root.path().join("calls"));
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::create_dir_all(&calls).unwrap();
            std::fs::create_dir_all(root.path().join("hub")).unwrap();
            let claude = bin.join("claude");
            std::fs::write(&claude, FAKE).unwrap();
            std::fs::set_permissions(&claude, std::os::unix::fs::PermissionsExt::from_mode(0o755))
                .unwrap();
            for (i, (out, exit)) in replies.iter().enumerate() {
                std::fs::write(calls.join(format!("reply-{}.out", i + 1)), out).unwrap();
                std::fs::write(
                    calls.join(format!("reply-{}.exit", i + 1)),
                    exit.to_string(),
                )
                .unwrap();
            }
            let env = HashMap::from([
                (
                    "PATH".to_string(),
                    format!("{}:/usr/bin:/bin", bin.display()),
                ),
                ("HOME".to_string(), root.path().display().to_string()),
                (
                    "ANTHROPIC_BASE_URL".to_string(),
                    "http://proxy.invalid".to_string(),
                ),
                ("ANTHROPIC_AUTH_TOKEN".to_string(), "test-token".to_string()),
                ("CLAUDECODE".to_string(), "1".to_string()),
                ("CLAUDE_CODE_ENTRYPOINT".to_string(), "cli".to_string()),
                (
                    "CLAUDE_CONFIG_DIR".to_string(),
                    "/somewhere/else".to_string(),
                ),
            ]);
            Fake { root, env }
        }

        fn one_shot(&self, model: Option<&str>) -> OneShot {
            OneShot::new(
                &self.root.path().join("hub"),
                model.map(Into::into),
                &self.env,
                None,
            )
            .unwrap()
        }

        fn call(&self, n: usize) -> (Vec<String>, String, String) {
            let read = |ext: &str| {
                std::fs::read_to_string(
                    self.root
                        .path()
                        .join("calls")
                        .join(format!("call-{n}.{ext}")),
                )
                .unwrap()
            };
            let args = read("args")
                .lines()
                .map(|l| l[1..l.len() - 1].to_string())
                .collect();
            (args, read("env"), read("prompt"))
        }

        fn calls(&self) -> usize {
            std::fs::read_dir(self.root.path().join("calls"))
                .unwrap()
                .filter(|e| {
                    e.as_ref()
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .ends_with(".prompt")
                })
                .count()
        }
    }

    /// What `claude -p --output-format json` prints for a successful run whose answer is `answer`.
    fn result(answer: &Value) -> String {
        let text = match answer {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        json!({ "type": "result", "subtype": "success", "is_error": false, "duration_ms": 1200, "result": text,
                "usage": { "input_tokens": 100, "cache_read_input_tokens": 20, "output_tokens": 30 } })
        .to_string()
    }

    const PROMPT: &str = "one prompt for the retro";

    #[tokio::test]
    async fn runs_claude_once_with_the_users_login_and_no_claude_session_variables() {
        let fake = Fake::new(&[(&result(&json!("the answer")), 0)]);
        let outcome = fake.one_shot(None).run(PROMPT).await;
        assert_eq!(outcome.text.as_deref(), Some("the answer"));
        let run = &outcome.run;
        assert_eq!(
            (
                run.kind,
                run.model.as_str(),
                run.ok,
                run.input_tokens,
                run.output_tokens
            ),
            (
                "orchestrator",
                "claude-haiku-5-5",
                true,
                Some(120),
                Some(30)
            )
        );
        assert_eq!(fake.calls(), 1);
        let (args, env, prompt) = fake.call(1);
        assert_eq!(
            args[..10],
            [
                "-p",
                "--output-format",
                "json",
                "--model",
                "claude-haiku-5-5",
                "--tools",
                "",
                "--strict-mcp-config",
                "--no-session-persistence",
                "--safe-mode",
            ]
        );
        // Claude's own subagents are off here too: denied by name, and the knobs set over the user's settings.
        let denied = args.iter().position(|a| a == "--disallowedTools").unwrap();
        assert_eq!(args[denied + 1..denied + 3], ["Task", "Agent"]);
        let settings: Value = serde_json::from_str(args.last().unwrap()).unwrap();
        assert_eq!(settings["autoMemoryEnabled"], false);
        assert_eq!(settings["env"]["CLAUDE_CODE_DISABLE_AGENT_VIEW"], "1");
        assert!(
            env.lines()
                .any(|l| l == "ANTHROPIC_BASE_URL=http://proxy.invalid")
        );
        assert!(env.lines().any(|l| l == "ANTHROPIC_AUTH_TOKEN=test-token"));
        // No session variable of the hub's own; only fleetd's auto memory and subagent switches.
        let mut claude_vars: Vec<&str> = env.lines().filter(|l| l.starts_with("CLAUDE")).collect();
        claude_vars.sort_unstable();
        assert_eq!(
            claude_vars,
            [
                "CLAUDE_CODE_DISABLE_AGENT_VIEW=1",
                "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
                "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
                "CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1",
                "CLAUDE_CODE_DISABLE_WORKFLOWS=1",
            ],
            "{env}"
        );
        assert_eq!(prompt, PROMPT);
    }

    #[tokio::test]
    async fn uses_the_configured_model() {
        let fake = Fake::new(&[(&result(&json!("ok")), 0)]);
        let outcome = fake.one_shot(Some("claude-sonnet-5-5")).run(PROMPT).await;
        assert!(fake.call(1).0.contains(&"claude-sonnet-5-5".to_string()));
        assert_eq!(outcome.run.model, "claude-sonnet-5-5");
    }

    #[tokio::test]
    async fn reports_a_cli_error_a_failed_exit_and_garbage_output() {
        let error = json!({ "type": "result", "subtype": "error_during_execution", "is_error": true, "result": "API Error: 529" }).to_string();
        for (reply, exit, why) in [
            (
                error.as_str(),
                0,
                "the CLI reported an error: API Error: 529",
            ),
            ("", 1, "the CLI printed no JSON result"),
            ("not json", 0, "the CLI printed no JSON result"),
        ] {
            let fake = Fake::new(&[(reply, exit)]);
            let outcome = fake.one_shot(None).run(PROMPT).await;
            assert!(outcome.text.is_none() && !outcome.run.ok);
            assert_eq!(outcome.run.error.as_deref(), Some(why));
        }
    }

    #[tokio::test]
    async fn reports_a_missing_claude_binary_as_the_reason() {
        let mut fake = Fake::new(&[]);
        fake.env.insert("PATH".into(), "/nonexistent".into());
        let outcome = fake.one_shot(None).run(PROMPT).await;
        assert!(outcome.text.is_none());
        let error = outcome.run.error.unwrap();
        assert!(
            error.starts_with("could not start claude: ") && error.contains("ENOENT"),
            "{error}"
        );
    }
}
