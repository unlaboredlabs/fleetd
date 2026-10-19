//! What the train asks of GitHub, through the `gh` CLI on the hub machine: PRs, check runs on a head, the
//! `fleetd/train` commit status, the pinned squash merge, and recently merged PRs for bypass detection.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::contract::GitHubRepo;
use super::host::BoxFut;
use crate::clock::Clock;
use crate::hub::projects::inspect::{self, GitHubAnswers};
use crate::hub::status::fresh::{self, Fresh};
use fleetd_contracts::projects::CiInfo;

pub const TRAIN_CONTEXT: &str = "fleetd/train";
/// The speculative CI of a stacked PR on top of its parent: informative, never required.
pub const STACK_CONTEXT: &str = "fleetd/stack";
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
pub struct Label {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Pull {
    #[serde(default)]
    pub number: i64,
    #[serde(default)]
    pub title: String,
    pub state: String,
    /// Absent from a PR list, which has `merged_at` only.
    #[serde(default)]
    pub merged: bool,
    #[serde(default)]
    pub merged_at: Option<String>,
    pub merge_commit_sha: Option<String>,
    pub body: Option<String>,
    pub head: PullHead,
    pub base: PullBase,
    #[serde(default)]
    pub labels: Vec<Label>,
}

/// The label that keeps a PR off the train until someone takes it off.
pub const HOLD_LABEL: &str = "hold";

impl Pull {
    pub fn held(&self) -> bool {
        self.labels
            .iter()
            .any(|l| l.name.eq_ignore_ascii_case(HOLD_LABEL))
    }
}

/// The machine-readable line in a batch PR's body naming its members, which recovery and the `pr_merged` check read.
pub const BATCH_MARKER: &str = "fleetd-batch:";

/// The PR numbers a batch PR's body names on its `fleetd-batch:` line.
pub fn batch_members(body: &str) -> Vec<i64> {
    body.lines()
        .find_map(|l| l.trim().strip_prefix(BATCH_MARKER))
        .map(|rest| {
            rest.split_whitespace()
                .filter_map(|w| w.trim_start_matches('#').parse().ok())
                .collect()
        })
        .unwrap_or_default()
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
    #[serde(default)]
    pub head_sha: Option<String>,
}

/// Whether `new` replaces `seen`, a run of the same check: the newer one does, except that a cancelled twin never
/// stands in for a run that is still going (a superseded workflow run is cancelled while its replacement runs).
fn supersedes(new: &CheckRun, seen: &CheckRun) -> bool {
    let cancelled = |r: &CheckRun| r.conclusion.as_deref() == Some("cancelled");
    let running = |r: &CheckRun| r.status != "completed";
    if cancelled(new) && running(seen) {
        return false;
    }
    if cancelled(seen) && running(new) {
        return true;
    }
    new.id > seen.id
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
    base: PullBase,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergedPull {
    pub number: i64,
    pub merged_at: String,
    pub merge_sha: Option<String>,
    pub base: String,
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

/// Paths whose last 200 carried an ETag, with that body: a 304 answer reuses it. GitHub does not count a 304
/// against the rate limit, so an unchanged PR polled every pass costs nothing.
const ETAG_PATHS: usize = 512;

#[derive(Default)]
struct Etags {
    by_path: HashMap<String, (String, Value, u64)>,
    tick: u64,
}

impl Etags {
    fn get(&mut self, path: &str) -> Option<(String, Value)> {
        self.tick += 1;
        let tick = self.tick;
        let entry = self.by_path.get_mut(path)?;
        entry.2 = tick;
        Some((entry.0.clone(), entry.1.clone()))
    }

    fn put(&mut self, path: &str, etag: String, body: Value) {
        self.tick += 1;
        if self.by_path.len() >= ETAG_PATHS && !self.by_path.contains_key(path) {
            let oldest = self
                .by_path
                .iter()
                .min_by_key(|(_, e)| e.2)
                .map(|(p, _)| p.clone());
            if let Some(oldest) = oldest {
                self.by_path.remove(&oldest);
            }
        }
        self.by_path
            .insert(path.to_owned(), (etag, body, self.tick));
    }
}

/// `gh api -i` output: the status line, headers, a blank line, the body. Absent when stdout does not start with a
/// status line (gh never reached GitHub, or a runner that prints only the body).
struct Included<'a> {
    status: u16,
    etag: Option<&'a str>,
    body: &'a str,
}

fn parse_included(stdout: &str) -> Option<Included<'_>> {
    let rest = stdout.strip_prefix("HTTP/")?;
    let status: u16 = rest.split_whitespace().nth(1)?.parse().ok()?;
    let ends = ["\r\n\r\n", "\n\r\n", "\n\n"];
    let (head, body) = ends
        .iter()
        .filter_map(|sep| stdout.find(sep).map(|i| (i, sep.len())))
        .min_by_key(|(i, _)| *i)
        .map_or((stdout, ""), |(i, len)| (&stdout[..i], &stdout[i + len..]));
    let etag = head.lines().skip(1).find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("etag")
            .then(|| value.trim())
    });
    Some(Included { status, etag, body })
}

/// `owner/name` of a `repos/<owner>/<name>/...` path, lowercased: the `github:<repo>` freshness source.
fn repo_of(path: &str) -> Option<String> {
    let mut parts = path.strip_prefix("repos/")?.split(['/', '?']);
    let (owner, name) = (parts.next()?, parts.next()?);
    Some(format!("{owner}/{name}").to_lowercase())
}

fn last_line(stderr: &str) -> String {
    let last = stderr.trim().split('\n').next_back().unwrap_or_default();
    last.strip_prefix("gh: ")
        .unwrap_or(last)
        .chars()
        .take(500)
        .collect()
}

#[derive(Clone)]
pub struct TrainGitHub {
    gh: Arc<dyn GhRunner>,
    etags: Arc<Mutex<Etags>>,
    fresh: Arc<Fresh>,
    clock: Arc<dyn Clock>,
}

impl TrainGitHub {
    pub fn new(gh: Arc<dyn GhRunner>, fresh: Arc<Fresh>, clock: Arc<dyn Clock>) -> Self {
        Self {
            gh,
            etags: Arc::default(),
            fresh,
            clock,
        }
    }

    fn reached(&self, path: &str) {
        if let Some(repo) = repo_of(path) {
            let now = super::time::millis(self.clock.now());
            self.fresh.touch(&fresh::github(&repo), now);
        }
    }

    fn missed(&self, path: &str, why: &str) {
        if let Some(repo) = repo_of(path) {
            self.fresh.fail(&fresh::github(&repo), why);
        }
    }

    /// `gh api`; a non-2xx answer is `{ status, message }` rather than an error, so callers can tell a 409 apart.
    /// Every GET is conditional: `-i` shows the status line and ETag, and a 304 (which gh exits 1 on, with
    /// "gh: HTTP 304") answers from the cached body. Each answer from GitHub keeps `github:<repo>` fresh.
    async fn call(
        &self,
        method: &str,
        path: &str,
        fields: &[(&str, &str)],
    ) -> Result<Reply, GhError> {
        let reply = self.call_inner(method, path, fields).await;
        match &reply {
            Ok(Reply::Ok(_)) => self.reached(path),
            // GitHub answered, just not with what was asked for (404, 405, 409, 422): it was reached.
            Ok(Reply::Err { status, .. }) if (400..500).contains(status) => self.reached(path),
            Ok(Reply::Err { message, .. }) => self.missed(path, message),
            Err(e) => self.missed(path, &e.message),
        }
        reply
    }

    async fn call_inner(
        &self,
        method: &str,
        path: &str,
        fields: &[(&str, &str)],
    ) -> Result<Reply, GhError> {
        let get = method == "GET";
        let cached = if get {
            self.etags.lock().unwrap().get(path)
        } else {
            None
        };
        let mut args: Vec<String> = vec!["api".into()];
        if get {
            args.push("-i".into());
        }
        args.extend(["-X", method, "-H", "Accept: application/vnd.github+json"].map(String::from));
        if let Some((etag, _)) = &cached {
            args.push("-H".into());
            args.push(format!("If-None-Match: {etag}"));
        }
        args.push(path.into());
        for (k, v) in fields {
            // `draft` is a JSON boolean; -f would send the string "true".
            args.push(if *k == "draft" { "-F" } else { "-f" }.into());
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
        // With -i the status line decides, not gh's exit code (1 on a 304).
        if let Some(included) = parse_included(&out.stdout) {
            if included.status == 304
                && let Some((_, body)) = cached
            {
                return Ok(Reply::Ok(body));
            }
            if (200..300).contains(&included.status) {
                let text = if included.body.trim().is_empty() {
                    "null"
                } else {
                    included.body
                };
                let value: Value = serde_json::from_str(text)
                    .map_err(|_| GhError::failed(format!("gh api {path} did not return JSON")))?;
                if let Some(etag) = included.etag {
                    self.etags
                        .lock()
                        .unwrap()
                        .put(path, etag.to_owned(), value.clone());
                }
                return Ok(Reply::Ok(value));
            }
            let message = serde_json::from_str::<Value>(included.body)
                .ok()
                .and_then(|v| v["message"].as_str().map(String::from))
                .unwrap_or_else(|| last_line(&out.stderr));
            return Ok(Reply::Err {
                status: included.status,
                message,
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
        Ok(Reply::Err {
            status: http_status(&out.stderr),
            message: last_line(&out.stderr),
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
                Some(seen) if !supersedes(&r, seen) => {}
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

    /// Posts `state` of the `fleetd/stack` context on a stacked PR's head: how it fares on top of its parent.
    pub async fn post_stack_status(
        &self,
        repo: &str,
        sha: &str,
        state: &str,
        description: &str,
        target_url: &str,
    ) -> Result<(), GhError> {
        let description: String = description.chars().take(140).collect();
        let fields = [
            ("state", state),
            ("context", STACK_CONTEXT),
            ("description", description.as_str()),
            ("target_url", target_url),
        ];
        self.json::<Value>("POST", &format!("repos/{repo}/statuses/{sha}"), &fields)
            .await
            .map(|_| ())
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

    /// Squash-merges pinned to `sha`; `message` is the squash commit's title and body when GitHub's default won't do.
    pub async fn merge(
        &self,
        repo: &str,
        n: i64,
        sha: &str,
        message: Option<(&str, &str)>,
    ) -> Result<MergeOutcome, GhError> {
        let mut fields = vec![("merge_method", "squash"), ("sha", sha)];
        if let Some((title, body)) = message {
            fields.extend([("commit_title", title), ("commit_message", body)]);
        }
        match self
            .call("PUT", &format!("repos/{repo}/pulls/{n}/merge"), &fields)
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

    /// Opens a PR from `head` (a branch of `repo`) into `base`, or, when one is already open, retitles it. Its number.
    pub async fn open_pull(
        &self,
        repo: &str,
        head: &str,
        base: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> Result<i64, GhError> {
        #[derive(Deserialize)]
        struct Opened {
            number: i64,
        }
        if let Some(open) = self.open_pull_for(repo, head).await? {
            self.edit_pull(repo, open, &[("title", title), ("body", body)])
                .await?;
            return Ok(open);
        }
        let draft = if draft { "true" } else { "false" };
        let fields = [
            ("head", head),
            ("base", base),
            ("title", title),
            ("body", body),
            ("draft", draft),
        ];
        let opened: Opened = self
            .json("POST", &format!("repos/{repo}/pulls"), &fields)
            .await?;
        Ok(opened.number)
    }

    /// The open PR whose head is `branch` of `repo`, if any.
    pub async fn open_pull_for(&self, repo: &str, branch: &str) -> Result<Option<i64>, GhError> {
        let pulls = self.pulls_for(repo, branch, "open").await?;
        Ok(pulls.first().map(|p| p.number))
    }

    /// PRs whose head is `branch` of `repo`, in `state` ("open", "closed"), newest first.
    pub async fn pulls_for(
        &self,
        repo: &str,
        branch: &str,
        state: &str,
    ) -> Result<Vec<Pull>, GhError> {
        let owner = repo.split('/').next().unwrap_or_default();
        self.json(
            "GET",
            &format!("repos/{repo}/pulls?head={owner}:{branch}&state={state}&per_page=10"),
            &[],
        )
        .await
    }

    /// PATCHes the PR: title, body, base or state.
    pub async fn edit_pull(
        &self,
        repo: &str,
        n: i64,
        fields: &[(&str, &str)],
    ) -> Result<(), GhError> {
        self.json::<Value>("PATCH", &format!("repos/{repo}/pulls/{n}"), fields)
            .await
            .map(|_| ())
    }

    /// Deletes a branch of the train's own; one already gone counts as deleted.
    pub async fn delete_branch(&self, repo: &str, branch: &str) -> Result<(), GhError> {
        match self
            .call(
                "DELETE",
                &format!("repos/{repo}/git/refs/heads/{branch}"),
                &[],
            )
            .await?
        {
            Reply::Ok(_)
            | Reply::Err {
                status: 404 | 422, ..
            } => Ok(()),
            Reply::Err { message, .. } => Err(GhError::failed(format!(
                "deleting {branch} on {repo} failed: {message}"
            ))),
        }
    }

    /// The repo's default branch, the base main CI is read on.
    pub async fn default_branch(&self, repo: &str) -> Result<String, GhError> {
        #[derive(Deserialize)]
        struct RepoJson {
            default_branch: String,
        }
        let r: RepoJson = self.json("GET", &format!("repos/{repo}"), &[]).await?;
        Ok(r.default_branch)
    }

    /// A repo webhook for check_suite, pull_request and push, signed with `secret`; returns its id.
    pub async fn create_hook(&self, repo: &str, url: &str, secret: &str) -> Result<i64, GhError> {
        #[derive(Deserialize)]
        struct Hook {
            id: i64,
        }
        let fields = [
            ("name", "web"),
            ("config[url]", url),
            ("config[content_type]", "json"),
            ("config[secret]", secret),
            ("events[]", "check_suite"),
            ("events[]", "pull_request"),
            ("events[]", "push"),
        ];
        let hook: Hook = self
            .json("POST", &format!("repos/{repo}/hooks"), &fields)
            .await?;
        Ok(hook.id)
    }

    /// Deletes a hook fleetd made; one already gone counts as deleted.
    pub async fn delete_hook(&self, repo: &str, id: i64) -> Result<(), GhError> {
        match self
            .call("DELETE", &format!("repos/{repo}/hooks/{id}"), &[])
            .await?
        {
            Reply::Ok(_) | Reply::Err { status: 404, .. } => Ok(()),
            Reply::Err { message, .. } => Err(GhError::failed(format!(
                "deleting the webhook on {repo} failed: {message}"
            ))),
        }
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
                    base: p.base.ref_,
                })
            })
            .collect())
    }

    /// Commit status contexts on `sha` other than fleetd's own (`fleetd/train`, `fleetd/stack`).
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
            .filter(|c| !c.starts_with("fleetd/"))
            .map(str::to_owned)
            .collect())
    }

    /// How many workflow runs GitHub has for `sha`, in any state (queued and waiting count).
    pub async fn workflow_runs(&self, repo: &str, sha: &str) -> Result<i64, GhError> {
        #[derive(Deserialize)]
        struct Runs {
            total_count: i64,
        }
        let runs: Runs = self
            .json(
                "GET",
                &format!("repos/{repo}/actions/runs?head_sha={sha}&per_page=1"),
                &[],
            )
            .await?;
        Ok(runs.total_count)
    }

    /// The repo's active workflow files as they are on `base`; `None` for one that can't be read there. GitHub's own
    /// dynamic workflows (Copilot, Dependabot) are left out, as adding a project leaves them out.
    pub async fn workflow_files(
        &self,
        repo: &str,
        base: &str,
    ) -> Result<Vec<Option<String>>, GhError> {
        let listed: Value = self
            .json(
                "GET",
                &format!("repos/{repo}/actions/workflows?per_page=100"),
                &[],
            )
            .await?;
        let paths: Vec<String> = listed["workflows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|w| w["state"].as_str() == Some("active"))
            .filter_map(|w| w["path"].as_str())
            .filter(|p| !p.starts_with("dynamic/"))
            .map(str::to_owned)
            .collect();
        let mut files = Vec::with_capacity(paths.len());
        for path in paths {
            let file = match self
                .call(
                    "GET",
                    &format!("repos/{repo}/contents/{path}?ref={base}"),
                    &[],
                )
                .await?
            {
                Reply::Ok(v) => v["content"].as_str().and_then(|b64| {
                    use base64::Engine;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(b64.replace('\n', ""))
                        .ok()?;
                    String::from_utf8(bytes).ok()
                }),
                Reply::Err { status: 404, .. } => None,
                Reply::Err { message, .. } => {
                    return Err(GhError::failed(format!(
                        "gh api repos/{repo}/contents/{path} failed: {message}"
                    )));
                }
            };
            files.push(file);
        }
        Ok(files)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::SystemClock;

    const OK_200: &str = include_str!("fixtures/gh-api-i-200.stdout");
    const NOT_MODIFIED: &str = include_str!("fixtures/gh-api-i-304.stdout");
    const NOT_MODIFIED_ERR: &str = include_str!("fixtures/gh-api-i-304.stderr");
    const NOT_FOUND: &str = include_str!("fixtures/gh-api-i-404.stdout");
    const NOT_FOUND_ERR: &str = include_str!("fixtures/gh-api-i-404.stderr");

    /// Replays recorded `gh api -i` answers in order and keeps every argv it was run with.
    #[derive(Default)]
    struct Replay {
        answers: Mutex<Vec<(i32, &'static str, &'static str)>>,
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl GhRunner for Replay {
        fn run(&self, args: Vec<String>) -> BoxFut<'_, Result<GhOut, String>> {
            self.calls.lock().unwrap().push(args);
            let (exit_code, stdout, stderr) = self.answers.lock().unwrap().remove(0);
            Box::pin(async move {
                Ok(GhOut {
                    exit_code,
                    stdout: stdout.into(),
                    stderr: stderr.into(),
                })
            })
        }
    }

    fn github(
        answers: Vec<(i32, &'static str, &'static str)>,
    ) -> (Arc<Replay>, Arc<Fresh>, TrainGitHub) {
        let gh = Arc::new(Replay {
            answers: Mutex::new(answers),
            calls: Mutex::default(),
        });
        let fresh = Arc::new(Fresh::default());
        let github = TrainGitHub::new(gh.clone(), fresh.clone(), Arc::new(SystemClock));
        (gh, fresh, github)
    }

    #[tokio::test]
    async fn a_304_answers_from_the_body_its_etag_came_with() {
        let (gh, fresh, github) =
            github(vec![(0, OK_200, ""), (1, NOT_MODIFIED, NOT_MODIFIED_ERR)]);
        let repo = "unlaboredlabs/fleetd-lab";
        fresh.expect(&fresh::github(repo), 180_000, 0);
        assert_eq!(github.default_branch(repo).await.unwrap(), "main");
        assert!(
            fresh
                .view(&fresh::github(repo), 1)
                .unwrap()
                .as_of_ms
                .is_some(),
            "a 200 reached GitHub"
        );
        assert_eq!(
            github.default_branch(repo).await.unwrap(),
            "main",
            "gh exits 1 on a 304; the status line decides"
        );
        let calls = gh.calls.lock().unwrap();
        assert!(calls[0].contains(&"-i".to_string()));
        assert!(!calls[0].iter().any(|a| a.starts_with("If-None-Match")));
        assert!(
            calls[1].contains(&r#"If-None-Match: W/"a44d8fe005905792c3265d74087b595af15ffac0d69630e3aff64b3c0e491862""#.to_string()),
            "{:?}",
            calls[1]
        );
    }

    #[tokio::test]
    async fn a_404_is_an_answer_with_its_status() {
        let (_, _, github) = github(vec![(1, NOT_FOUND, NOT_FOUND_ERR)]);
        let Reply::Err { status, message } = github
            .call("GET", "repos/unlaboredlabs/fleetd-lab/pulls/999999", &[])
            .await
            .unwrap()
        else {
            panic!("not an error reply")
        };
        assert_eq!((status, message.as_str()), (404, "Not Found"));
    }

    #[tokio::test]
    async fn an_unreachable_github_keeps_the_reason_for_the_stale_source() {
        let (_, fresh, github) = github(vec![(1, "", "gh: connect: network is unreachable\n")]);
        let repo = "acme/storefront";
        fresh.expect(&fresh::github(repo), 1_000, 0);
        fresh.touch(&fresh::github(repo), 0);
        fresh.check(0);
        assert!(github.pull(repo, 1).await.is_err());
        let flips = fresh.check(5_000);
        let crate::hub::status::fresh::Flip::Stale { reason, .. } = &flips[0] else {
            panic!("{flips:?}")
        };
        assert!(reason.contains("unreachable"), "{reason}");
    }

    #[test]
    fn the_etag_cache_drops_the_least_recently_used_path() {
        let mut etags = Etags::default();
        for i in 0..ETAG_PATHS {
            etags.put(&format!("p{i}"), "e".into(), Value::Null);
        }
        etags.get("p0");
        etags.put("new", "e".into(), Value::Null);
        assert!(etags.get("p0").is_some());
        assert!(etags.get("p1").is_none());
        assert_eq!(etags.by_path.len(), ETAG_PATHS);
    }
}
