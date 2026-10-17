//! GitHub's REST API through the `gh` CLI on the hub machine, so the hub holds no GitHub token of its own.
//! TS spec: apps/hub/src/checks/GitHub.ts. The train, reviews, finish-all and the doctor reuse this.
use super::ports::BoxFuture;
use regex::Regex;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

pub const GH_AUTH_FIX: &str = "run `gh auth login` on the hub machine";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GhErrorKind {
    /// gh is not logged in.
    Auth,
    /// No gh on PATH.
    Missing,
    /// The call itself failed (404, rate limit, ...).
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct GhError {
    pub kind: GhErrorKind,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Why gh did not run at all: `"ENOENT"` for no binary, else the start error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhSpawnError(pub String);

/// One `gh` subprocess run; the fake in tests stands in for the binary.
pub trait GhRunner: Send + Sync + 'static {
    fn run(&self, args: Vec<String>) -> BoxFuture<'_, Result<GhOutput, GhSpawnError>>;
}

/// The real `gh` on PATH: 30 s timeout, 8 MiB of output at most.
pub struct GhCli;

const GH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_BUFFER: usize = 8 << 20;

impl GhRunner for GhCli {
    fn run(&self, args: Vec<String>) -> BoxFuture<'_, Result<GhOutput, GhSpawnError>> {
        Box::pin(async move {
            let mut cmd = tokio::process::Command::new("gh");
            cmd.args(&args)
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true);
            let out = match tokio::time::timeout(GH_TIMEOUT, cmd.output()).await {
                Err(_) => {
                    return Err(GhSpawnError(
                        "Command failed: gh timed out after 30000 ms".into(),
                    ));
                }
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(GhSpawnError("ENOENT".into()));
                }
                Ok(Err(e)) => return Err(GhSpawnError(e.to_string())),
                Ok(Ok(out)) => out,
            };
            if out.stdout.len() + out.stderr.len() > MAX_BUFFER {
                return Err(GhSpawnError("stdout maxBuffer length exceeded".into()));
            }
            // Killed by a signal: Node reports no numeric code, so this is a start error there too.
            let Some(exit_code) = out.status.code() else {
                return Err(GhSpawnError(format!(
                    "Command failed: gh {}",
                    args.join(" ")
                )));
            };
            Ok(GhOutput {
                exit_code,
                stdout: String::from_utf8_lossy(&out.stdout).into(),
                stderr: String::from_utf8_lossy(&out.stderr).into(),
            })
        })
    }
}

static AUTH_HINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)gh auth login|not logged in|authentication required|GH_TOKEN")
        .expect("auth regex")
});

pub struct GitHub {
    runner: Arc<dyn GhRunner>,
}

impl GitHub {
    pub fn new(runner: Arc<dyn GhRunner>) -> Self {
        Self { runner }
    }

    pub fn runner(&self) -> &Arc<dyn GhRunner> {
        &self.runner
    }

    /// `gh api <path>`, parsed as JSON. `path` is relative, e.g. `repos/o/r/pulls/7`.
    pub async fn api(&self, path: &str) -> Result<serde_json::Value, GhError> {
        let args = vec![
            "api".into(),
            "-H".into(),
            "Accept: application/vnd.github+json".into(),
            path.to_owned(),
        ];
        let out = self.runner.run(args).await.map_err(|GhSpawnError(e)| {
            if e == "ENOENT" {
                GhError { kind: GhErrorKind::Missing, message: format!("gh is not installed on the hub machine: install the GitHub CLI, then {GH_AUTH_FIX}") }
            } else {
                GhError { kind: GhErrorKind::Failed, message: format!("gh could not start: {e}") }
            }
        })?;
        // gh exits 4 when it needs a login.
        if out.exit_code == 4 || (out.exit_code != 0 && AUTH_HINT.is_match(&out.stderr)) {
            return Err(GhError {
                kind: GhErrorKind::Auth,
                message: format!("gh is not authenticated: {GH_AUTH_FIX}"),
            });
        }
        if out.exit_code != 0 {
            // As TS: the last stderr line, empty when there is none (its `exit N` fallback never applies).
            let why = out.stderr.trim().rsplit('\n').next().unwrap_or_default();
            return Err(GhError {
                kind: GhErrorKind::Failed,
                message: super::utf16_prefix(&format!("gh api {path} failed: {why}"), 500)
                    .to_owned(),
            });
        }
        serde_json::from_str(&out.stdout).map_err(|_| GhError {
            kind: GhErrorKind::Failed,
            message: format!("gh api {path} did not return JSON"),
        })
    }
}
