//! The intake router: one `claude -p` run on the hub machine, the only way fleetd reaches a model. It uses the login
//! the user's own `claude` uses (~/.claude: OAuth, or a base URL and token in its settings' env), in safe mode so none
//! of the user's hooks, plugins, MCP servers or CLAUDE.md load, and nothing of any `CLAUDE*` session the hub was
//! started from.
use crate::hub::prompts::PromptSet;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::playbooks::RouterResult;
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

pub const DEFAULT_ROUTER_MODEL: &str = "claude-haiku-5-5";
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

#[derive(Debug, Clone)]
pub struct RouterProject {
    pub project_ref: ProjectRef,
    pub title: String,
    pub root: String,
    /// Titles of its latest workstreams, newest first.
    pub recent_intents: Vec<String>,
}

/// One `claude` run, recorded as `orchestrator` usage. Tokens only when the CLI reported them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterRun {
    pub kind: &'static str,
    pub model: String,
    pub duration_ms: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// Why the run gave no usable answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The prompt it was given (`router@…` or `router.retry@…`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_ref: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RouteOutcome {
    /// None when the router could not place the intent: the caller asks the human.
    pub result: Option<RouterResult>,
    /// Why there is no result, for the fallback ask.
    pub why: Option<String>,
    pub runs: Vec<RouterRun>,
}

fn basename(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
}

pub fn render_router_prompt(set: &PromptSet, text: &str, projects: &[RouterProject]) -> String {
    let lines: Vec<String> = projects
        .iter()
        .map(|p| {
            // Key order as older hubs wrote it: machineId, projectId, title, folder, recentIntents.
            format!(
                "{{\"machineId\":{},\"projectId\":{},\"title\":{},\"folder\":{},\"recentIntents\":{}}}",
                json_str(p.project_ref.machine_id.as_str()),
                json_str(p.project_ref.project_id.as_str()),
                json_str(&p.title),
                json_str(basename(&p.root)),
                serde_json::to_string(&p.recent_intents).unwrap_or_default()
            )
        })
        .collect();
    set.render(
        "router",
        &[("projects", &lines.join("\n")), ("intent", &text.trim())],
    )
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// The child's whole environment: an allowlist, so the hub's own `CLAUDE*` variables never reach it. Without
/// `CLAUDE_CONFIG_DIR`, `claude` reads the user's login from `$HOME/.claude`, as it does in their own shell.
pub fn router_env(source: &HashMap<String, String>) -> Vec<(String, String)> {
    BASE_ENV
        .iter()
        .chain(LOGIN_ENV.iter())
        .filter_map(|k| {
            source
                .get(*k)
                .filter(|v| !v.is_empty())
                .map(|v| (k.to_string(), v.clone()))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Ok(RouterResult),
    Unsure(String),
    Invalid(String),
}

/// The model's answer from the text of the CLI's `result`, checked against the projects it was offered.
pub fn judge_answer(text: &str, projects: &[RouterProject]) -> Verdict {
    let (Some(start), Some(end)) = (text.find('{'), text.rfind('}')) else {
        return Verdict::Invalid("the answer has no JSON object".into());
    };
    if end < start {
        return Verdict::Invalid("the answer has no JSON object".into());
    }
    let Ok(raw) = serde_json::from_str::<Value>(&text[start..=end]) else {
        return Verdict::Invalid("the answer is not valid JSON".into());
    };
    if raw.get("projectRef").is_some_and(Value::is_null) {
        let reason = raw
            .get("reason")
            .and_then(Value::as_str)
            .map(|r| r.split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        let reason: String = reason.chars().take(200).collect();
        return Verdict::Unsure(if reason.is_empty() {
            "the router could not tell which project".into()
        } else {
            reason
        });
    }
    let result: RouterResult = match serde_json::from_value(raw) {
        Ok(r) => r,
        Err(e) => {
            let detail: String = e.to_string().chars().take(300).collect();
            return Verdict::Invalid(format!(
                "the answer does not match {{projectRef, template, reason}}: {detail}"
            ));
        }
    };
    let r = &result.project_ref;
    if !projects.iter().any(|p| {
        p.project_ref.machine_id == r.machine_id && p.project_ref.project_id == r.project_id
    }) {
        return Verdict::Invalid(format!(
            "{}/{} is not one of the listed projects",
            r.machine_id, r.project_id
        ));
    }
    Verdict::Ok(result)
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
    pub run: RouterRun,
}

/// The `claude -p --output-format json` runner the router and the retro share: the user's own login, the empty
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
            model: model.unwrap_or_else(|| DEFAULT_ROUTER_MODEL.into()),
            cwd,
            env: router_env(env),
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
        let run = RouterRun {
            kind: "orchestrator",
            model: self.model.clone(),
            duration_ms,
            ok: failed.is_none(),
            input_tokens: envelope.input_tokens,
            output_tokens: envelope.output_tokens,
            error: failed.as_ref().map(|f| f.chars().take(300).collect()),
            prompt_ref: None,
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
        let mut args: Vec<&str> = vec!["-p", "--output-format", "json", "--model", &self.model];
        args.extend(ONE_SHOT_FLAGS);
        let mut child = Command::new("claude")
            .args(&args)
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

pub struct IntakeRouter {
    one_shot: Arc<OneShot>,
}

impl IntakeRouter {
    pub fn new(one_shot: Arc<OneShot>) -> Arc<Self> {
        Arc::new(Self { one_shot })
    }

    async fn attempt(&self, prompt: &str, projects: &[RouterProject]) -> (Verdict, RouterRun) {
        let OneShotResult { text, mut run } = self.one_shot.run(prompt).await;
        let verdict = match text {
            None => Verdict::Invalid(run.error.clone().unwrap_or_else(|| "no answer".into())),
            Some(text) => judge_answer(&text, projects),
        };
        if let Verdict::Invalid(error) = &verdict {
            run.ok = false;
            run.error = Some(error.chars().take(300).collect());
        }
        (verdict, run)
    }

    pub async fn route(
        &self,
        set: &PromptSet,
        text: &str,
        projects: &[RouterProject],
    ) -> RouteOutcome {
        let prompt = render_router_prompt(set, text, projects);
        let (first, mut first_run) = self.attempt(&prompt, projects).await;
        first_run.prompt_ref = Some(set.get("router").r#ref.clone());
        let error = match first {
            Verdict::Ok(result) => {
                return RouteOutcome {
                    result: Some(result),
                    why: None,
                    runs: vec![first_run],
                };
            }
            Verdict::Unsure(why) => {
                return RouteOutcome {
                    result: None,
                    why: Some(why),
                    runs: vec![first_run],
                };
            }
            Verdict::Invalid(error) => error,
        };
        let retry = set.render("router.retry", &[("prompt", &prompt), ("error", &error)]);
        let (second, mut second_run) = self.attempt(&retry, projects).await;
        second_run.prompt_ref = Some(set.get("router.retry").r#ref.clone());
        let runs = vec![first_run, second_run];
        match second {
            Verdict::Ok(result) => RouteOutcome {
                result: Some(result),
                why: None,
                runs,
            },
            Verdict::Unsure(why) => RouteOutcome {
                result: None,
                why: Some(why),
                runs,
            },
            Verdict::Invalid(error) => RouteOutcome {
                result: None,
                why: Some(
                    format!("the router gave no usable answer twice ({error})")
                        .chars()
                        .take(300)
                        .collect(),
                ),
                runs,
            },
        }
    }
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

        fn router(&self, model: Option<&str>) -> Arc<IntakeRouter> {
            IntakeRouter::new(Arc::new(
                OneShot::new(
                    &self.root.path().join("hub"),
                    model.map(Into::into),
                    &self.env,
                    None,
                )
                .unwrap(),
            ))
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

    fn projects() -> Vec<RouterProject> {
        let p = |m: &str, id: &str, title: &str, root: &str, recent: &[&str]| RouterProject {
            project_ref: serde_json::from_value(json!({ "machineId": m, "projectId": id }))
                .unwrap(),
            title: title.into(),
            root: root.into(),
            recent_intents: recent.iter().map(|s| s.to_string()).collect(),
        };
        vec![
            p(
                "lab-a",
                "p-a",
                "repo-a",
                "/lab/repo-a",
                &["add a /health endpoint"],
            ),
            p("lab-b", "p-b", "repo-b", "/lab/repo-b", &[]),
        ]
    }

    fn to_a() -> Value {
        json!({ "projectRef": { "machineId": "lab-a", "projectId": "p-a" }, "template": "bugfix", "reason": "repo-a has the README" })
    }

    const TEXT: &str = "fix: the lab README has a typo";

    #[test]
    fn prompt_names_every_template_and_renders_projects_and_the_intent() {
        for name in fleetd_contracts::ledger::PlaybookName::ALL {
            assert!(
                PromptSet::defaults()
                    .get("router")
                    .text
                    .contains(&format!("- {}:", name.as_str()))
            );
        }
        let prompt = render_router_prompt(PromptSet::defaults(), TEXT, &projects());
        assert!(prompt.contains(r#"{"machineId":"lab-a","projectId":"p-a","title":"repo-a","folder":"repo-a","recentIntents":["add a /health endpoint"]}"#));
        assert!(prompt.contains(TEXT));
        assert!(!prompt.contains("{{"));
    }

    #[test]
    fn judges_answers() {
        let mut fenced = String::from("Here you go:\n```json\n");
        fenced.push_str(&to_a().to_string());
        fenced.push_str("\n```");
        let with = |patch: Value| {
            let mut v = to_a();
            for (k, val) in patch.as_object().unwrap() {
                v[k] = val.clone();
            }
            v.to_string()
        };
        let cases: Vec<(String, &str)> = vec![
            (to_a().to_string(), "ok"),
            (fenced, "ok"),
            ("repo-a, I think".into(), "invalid"),
            (r#"{"projectRef": {"#.into(), "invalid"),
            (with(json!({ "template": "chore" })), "invalid"),
            (with(json!({ "projectRef": { "machineId": "lab-a", "projectId": "p-z" } })), "invalid"),
            (with(json!({ "reason": "two\nlines" })), "invalid"),
            (json!({ "projectRef": null, "template": "feature", "reason": "both repos have a README" }).to_string(), "unsure"),
        ];
        for (text, kind) in cases {
            let got = match judge_answer(&text, &projects()) {
                Verdict::Ok(_) => "ok",
                Verdict::Unsure(_) => "unsure",
                Verdict::Invalid(_) => "invalid",
            };
            assert_eq!(got, kind, "{text}");
        }
    }

    #[tokio::test]
    async fn runs_claude_once_with_the_users_login_and_no_claude_session_variables() {
        let fake = Fake::new(&[(&result(&to_a()), 0)]);
        let outcome = fake
            .router(None)
            .route(PromptSet::defaults(), TEXT, &projects())
            .await;
        assert_eq!(
            serde_json::to_value(outcome.result.unwrap()).unwrap(),
            to_a()
        );
        let run = &outcome.runs[0];
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
            args,
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
                "--safe-mode"
            ]
        );
        assert!(
            env.lines()
                .any(|l| l == "ANTHROPIC_BASE_URL=http://proxy.invalid")
        );
        assert!(env.lines().any(|l| l == "ANTHROPIC_AUTH_TOKEN=test-token"));
        assert!(!env.lines().any(|l| l.starts_with("CLAUDE")), "{env}");
        assert!(prompt.contains(TEXT) && prompt.contains(r#""title":"repo-b""#));
    }

    #[tokio::test]
    async fn uses_the_configured_model() {
        let fake = Fake::new(&[(&result(&to_a()), 0)]);
        let outcome = fake
            .router(Some("claude-sonnet-5-5"))
            .route(PromptSet::defaults(), TEXT, &projects())
            .await;
        assert!(fake.call(1).0.contains(&"claude-sonnet-5-5".to_string()));
        assert_eq!(outcome.runs[0].model, "claude-sonnet-5-5");
    }

    #[tokio::test]
    async fn retries_once_after_an_invalid_answer_saying_what_was_wrong() {
        let mut bad = to_a();
        bad["projectRef"]["projectId"] = json!("p-z");
        let fake = Fake::new(&[(&result(&bad), 0), (&result(&to_a()), 0)]);
        let outcome = fake
            .router(None)
            .route(PromptSet::defaults(), TEXT, &projects())
            .await;
        assert!(outcome.result.is_some());
        assert_eq!(
            outcome.runs.iter().map(|r| r.ok).collect::<Vec<_>>(),
            [false, true]
        );
        assert!(
            outcome.runs[0]
                .error
                .as_deref()
                .unwrap()
                .contains("lab-a/p-z is not one of the listed projects")
        );
        assert!(fake.call(2).2.contains(
            "Your previous answer was not usable (lab-a/p-z is not one of the listed projects)"
        ));
    }

    #[tokio::test]
    async fn gives_up_after_a_cli_error_then_no_json() {
        let error = json!({ "type": "result", "subtype": "error_during_execution", "is_error": true, "result": "API Error: 529" }).to_string();
        let fake = Fake::new(&[(&error, 0), (&result(&json!("repo-a")), 0)]);
        let outcome = fake
            .router(None)
            .route(PromptSet::defaults(), TEXT, &projects())
            .await;
        assert!(outcome.result.is_none());
        assert!(
            outcome
                .why
                .unwrap()
                .contains("the router gave no usable answer twice (the answer has no JSON object)")
        );
        assert_eq!(
            outcome
                .runs
                .iter()
                .map(|r| r.error.clone().unwrap())
                .collect::<Vec<_>>(),
            [
                "the CLI reported an error: API Error: 529",
                "the answer has no JSON object"
            ]
        );
        assert_eq!(fake.calls(), 2);
    }

    #[tokio::test]
    async fn counts_a_failed_exit_and_garbage_output_as_invalid() {
        let fake = Fake::new(&[("", 1), ("not json", 0)]);
        let outcome = fake
            .router(None)
            .route(PromptSet::defaults(), TEXT, &projects())
            .await;
        assert!(outcome.result.is_none());
        assert_eq!(
            outcome
                .runs
                .iter()
                .map(|r| r.error.clone().unwrap())
                .collect::<Vec<_>>(),
            ["the CLI printed no JSON result"; 2]
        );
    }

    #[tokio::test]
    async fn does_not_retry_when_the_model_says_no_project_fits() {
        let fake = Fake::new(&[(
            &result(
                &json!({ "projectRef": null, "template": "bugfix", "reason": "both repos have a README" }),
            ),
            0,
        )]);
        let outcome = fake
            .router(None)
            .route(PromptSet::defaults(), TEXT, &projects())
            .await;
        assert_eq!(outcome.why.as_deref(), Some("both repos have a README"));
        assert!(outcome.result.is_none() && outcome.runs[0].ok);
        assert_eq!(fake.calls(), 1);
    }

    #[tokio::test]
    async fn reports_a_missing_claude_binary_as_the_reason() {
        let mut fake = Fake::new(&[]);
        fake.env.insert("PATH".into(), "/nonexistent".into());
        let outcome = fake
            .router(None)
            .route(PromptSet::defaults(), TEXT, &projects())
            .await;
        assert!(outcome.result.is_none());
        let error = outcome.runs[0].error.clone().unwrap();
        assert!(
            error.starts_with("could not start claude: ") && error.contains("ENOENT"),
            "{error}"
        );
    }
}
