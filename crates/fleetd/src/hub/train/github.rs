//! What the train asks of GitHub, through the `gh` CLI on the hub machine: PRs, check runs on a head, the
//! `fleetd/train` commit status, the pinned squash merge, and recently merged PRs for bypass detection.
use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::contract::GitHubRepo;
use super::host::BoxFut;
use crate::hub::projects::inspect::{self, GitHubAnswers};
use fleetd_contracts::projects::CiInfo;

pub const TRAIN_CONTEXT: &str = "fleetd/train";
pub const GH_AUTH_FIX: &str = "run `gh auth login` on the hub machine";

pub struct GhOut {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// One `gh` run; the error is why it could not start ("ENOENT" when gh is missing). Tests fake the binary.
pub trait GhRunner: Send + Sync + 'static {
    fn run(&self, args: Vec<String>) -> BoxFut<'_, Result<GhOut, String>>;
}

/// The real `gh` on PATH, 30 s per call.
pub struct SystemGh;

impl GhRunner for SystemGh {
    fn run(&self, args: Vec<String>) -> BoxFut<'_, Result<GhOut, String>> {
        Box::pin(async move {
            let child = tokio::process::Command::new("gh")
                .args(&args)
                .kill_on_drop(true)
                .output();
            match tokio::time::timeout(std::time::Duration::from_secs(30), child).await {
                Err(_) => Err("gh timed out after 30 s".into()),
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Err("ENOENT".into()),
                Ok(Err(e)) => Err(e.to_string()),
                Ok(Ok(out)) => Ok(GhOut {
                    exit_code: out.status.code().unwrap_or(1),
                    stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
                }),
            }
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GhErrorKind {
    Auth,
    Missing,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GhError {
    pub kind: GhErrorKind,
    pub message: String,
}

impl GhError {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            kind: GhErrorKind::Failed,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct PullHeadRepo {
    pub full_name: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PullHead {
    #[serde(rename = "ref")]
    pub ref_: String,
    pub sha: String,
    pub repo: Option<PullHeadRepo>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PullBase {
    #[serde(rename = "ref")]
    pub ref_: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Pull {
    pub state: String,
    pub merged: bool,
    pub merge_commit_sha: Option<String>,
    pub body: Option<String>,
    pub head: PullHead,
    pub base: PullBase,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CheckRun {
    pub id: f64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub html_url: Option<String>,
    /// GitHub's own stamps, whole seconds; kept for the time inspector's per-check spans.
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
}

#[derive(Deserialize)]
struct CheckRuns {
    check_runs: Vec<CheckRun>,
}

#[derive(Deserialize)]
struct MergeJson {
    sha: String,
    merged: bool,
}

#[derive(Deserialize)]
struct ClosedPull {
    number: i64,
    merged_at: Option<String>,
    merge_commit_sha: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergedPull {
    pub number: i64,
    pub merged_at: String,
    pub merge_sha: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MergeOutcome {
    Merged {
        sha: String,
    },
    /// GitHub said no: 405 (not mergeable, e.g. the base moved) or 409 (the head is no longer `sha`).
    Refused {
        status: u16,
        message: String,
    },
}

enum Reply {
    Ok(Value),
    Err { status: u16, message: String },
}

fn auth_hint(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    s.contains("gh auth login")
        || s.contains("not logged in")
        || s.contains("authentication required")
}

/// `(HTTP nnn)` in gh's stderr.
fn http_status(stderr: &str) -> u16 {
    stderr
        .match_indices("(HTTP ")
        .find_map(|(i, _)| {
            let digits = stderr.get(i + 6..i + 9)?;
            (stderr.get(i + 9..i + 10) == Some(")") && digits.bytes().all(|b| b.is_ascii_digit()))
                .then(|| digits.parse().ok())?
        })
        .unwrap_or(0)
}

#[derive(Clone)]
pub struct TrainGitHub {
    gh: Arc<dyn GhRunner>,
}

impl TrainGitHub {
    pub fn new(gh: Arc<dyn GhRunner>) -> Self {
        Self { gh }
    }

    /// `gh api`; a non-2xx answer is `{ status, message }` rather than an error, so callers can tell a 409 apart.
    async fn call(
        &self,
        method: &str,
        path: &str,
        fields: &[(&str, &str)],
    ) -> Result<Reply, GhError> {
        let mut args: Vec<String> = [
            "api",
            "-X",
            method,
            "-H",
            "Accept: application/vnd.github+json",
            path,
        ]
        .map(String::from)
        .into();
        for (k, v) in fields {
            args.push("-f".into());
            args.push(format!("{k}={v}"));
        }
        let out = self.gh.run(args).await.map_err(|spawn| {
            if spawn == "ENOENT" {
                GhError { kind: GhErrorKind::Missing, message: format!("gh is not installed on the hub machine: install the GitHub CLI, then {GH_AUTH_FIX}") }
            } else {
                GhError::failed(format!("gh could not start: {spawn}"))
            }
        })?;
        if out.exit_code == 4 || (out.exit_code != 0 && auth_hint(&out.stderr)) {
            return Err(GhError {
                kind: GhErrorKind::Auth,
                message: format!("gh is not authenticated: {GH_AUTH_FIX}"),
            });
        }
        if out.exit_code == 0 {
            let text = if out.stdout.is_empty() {
                "null"
            } else {
                &out.stdout
            };
            return serde_json::from_str(text)
                .map(Reply::Ok)
                .map_err(|_| GhError::failed(format!("gh api {path} did not return JSON")));
        }
        let last = out
            .stderr
            .trim()
            .split('\n')
            .next_back()
            .unwrap_or_default();
        let message: String = last
            .strip_prefix("gh: ")
            .unwrap_or(last)
            .chars()
            .take(500)
            .collect();
        Ok(Reply::Err {
            status: http_status(&out.stderr),
            message,
        })
    }

    async fn json<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        fields: &[(&str, &str)],
    ) -> Result<T, GhError> {
        match self.call(method, path, fields).await? {
            Reply::Ok(v) => serde_json::from_value(v).map_err(|_| {
                GhError::failed(format!("gh api {path} returned an unexpected shape"))
            }),
            Reply::Err { message, .. } => {
                Err(GhError::failed(format!("gh api {path} failed: {message}")))
            }
        }
    }

    /// A GET for callers outside the train (adding a project reads repo settings, branch rules and workflows):
    /// `Ok(Err((status, message)))` for a non-2xx answer.
    pub async fn get(&self, path: &str) -> Result<Result<Value, (u16, String)>, GhError> {
        Ok(match self.call("GET", path, &[]).await? {
            Reply::Ok(v) => Ok(v),
            Reply::Err { status, message } => Err((status, message)),
        })
    }

    pub async fn pull(&self, repo: &str, n: i64) -> Result<Pull, GhError> {
        self.json("GET", &format!("repos/{repo}/pulls/{n}"), &[])
            .await
    }

    /// The latest run of each check on `sha`.
    pub async fn check_runs(&self, repo: &str, sha: &str) -> Result<Vec<CheckRun>, GhError> {
        let runs: CheckRuns = self
            .json(
                "GET",
                &format!("repos/{repo}/commits/{sha}/check-runs?per_page=100"),
                &[],
            )
            .await?;
        // A re-run adds a newer run with the same name; only the newest counts. Map order is first-seen.
        let mut order: Vec<String> = Vec::new();
        let mut latest: HashMap<String, CheckRun> = HashMap::new();
        for r in runs.check_runs {
            match latest.get(&r.name) {
                Some(seen) if seen.id >= r.id => {}
                Some(_) => {
                    latest.insert(r.name.clone(), r);
                }
                None => {
                    order.push(r.name.clone());
                    latest.insert(r.name.clone(), r);
                }
            }
        }
        Ok(order
            .into_iter()
            .filter_map(|n| latest.remove(&n))
            .collect())
    }

    /// Posts `fleetd/train=success` on `sha`.
    pub async fn post_train_status(
        &self,
        repo: &str,
        sha: &str,
        description: &str,
    ) -> Result<(), GhError> {
        let description: String = description.chars().take(140).collect();
        let fields = [
            ("state", "success"),
            ("context", TRAIN_CONTEXT),
            ("description", description.as_str()),
        ];
        self.json::<Value>("POST", &format!("repos/{repo}/statuses/{sha}"), &fields)
            .await
            .map(|_| ())
    }

    /// Squash-merges pinned to `sha`.
    pub async fn merge(&self, repo: &str, n: i64, sha: &str) -> Result<MergeOutcome, GhError> {
        match self
            .call(
                "PUT",
                &format!("repos/{repo}/pulls/{n}/merge"),
                &[("merge_method", "squash"), ("sha", sha)],
            )
            .await?
        {
            Reply::Err {
                status: status @ (405 | 409),
                message,
            } => Ok(MergeOutcome::Refused { status, message }),
            Reply::Err { message, .. } => Err(GhError::failed(format!(
                "merging {repo}#{n} failed: {message}"
            ))),
            Reply::Ok(v) => match serde_json::from_value::<MergeJson>(v) {
                Ok(m) if m.merged => Ok(MergeOutcome::Merged { sha: m.sha }),
                Ok(_) => Ok(MergeOutcome::Refused {
                    status: 405,
                    message: "GitHub did not merge it".into(),
                }),
                Err(_) => Err(GhError::failed(format!(
                    "merging {repo}#{n} returned an unexpected shape"
                ))),
            },
        }
    }

    /// Comments on the PR with why, then closes it.
    pub async fn close(&self, repo: &str, n: i64, comment: &str) -> Result<(), GhError> {
        self.json::<Value>(
            "POST",
            &format!("repos/{repo}/issues/{n}/comments"),
            &[("body", comment)],
        )
        .await?;
        self.json::<Value>(
            "PATCH",
            &format!("repos/{repo}/pulls/{n}"),
            &[("state", "closed")],
        )
        .await
        .map(|_| ())
    }

    /// Recently updated closed PRs that were merged.
    pub async fn merged_pulls(&self, repo: &str) -> Result<Vec<MergedPull>, GhError> {
        let pulls: Vec<ClosedPull> = self
            .json(
                "GET",
                &format!("repos/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50"),
                &[],
            )
            .await?;
        Ok(pulls
            .into_iter()
            .filter_map(|p| {
                p.merged_at.map(|merged_at| MergedPull {
                    number: p.number,
                    merged_at,
                    merge_sha: p.merge_commit_sha,
                })
            })
            .collect())
    }

    /// Commit status contexts on `sha` other than the train's own.
    pub async fn status_contexts(&self, repo: &str, sha: &str) -> Result<Vec<String>, GhError> {
        let combined: Value = self
            .json(
                "GET",
                &format!("repos/{repo}/commits/{sha}/status?per_page=100"),
                &[],
            )
            .await?;
        Ok(combined["statuses"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s["context"].as_str())
            .filter(|c| *c != TRAIN_CONTEXT)
            .map(str::to_owned)
            .collect())
    }

    /// The repo's workflows and the checks `branch` requires, read as adding a project reads them; any read failing
    /// is an error, never "no CI".
    pub async fn ci_config(&self, repo: &str, branch: &str) -> Result<CiInfo, GhError> {
        let workflows: Value = self
            .json(
                "GET",
                &format!("repos/{repo}/actions/workflows?per_page=100"),
                &[],
            )
            .await?;
        let protection: Value = self
            .json("GET", &format!("repos/{repo}/branches/{branch}"), &[])
            .await?;
        let rules: Value = self
            .json("GET", &format!("repos/{repo}/rules/branches/{branch}"), &[])
            .await?;
        let answers = GitHubAnswers {
            workflows: Some(workflows),
            branch: Some(protection),
            rules: Some(rules),
            ..GitHubAnswers::default()
        };
        let repo = GitHubRepo::unchecked(repo);
        Ok(inspect::build(Some(&repo), &answers, None, vec![], true).ci)
    }
}
