//! What the train asks of GitHub, through the `gh` CLI on the hub machine: PRs, rebasing a PR's branch, batch branches
//! built by merges, patch ids, check runs on a head, the `fleetd/train` commit status, the pinned squash merge, and
//! recently merged PRs, to report merges outside it. The train runs no git of its own but `git patch-id`.
use std::collections::HashMap;
use std::sync::Arc;

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
        Box::pin(run_gh("gh", args, None))
    }
}

/// One run of `program` (`gh`), 30 s at most; with `token`, as that token (`GH_TOKEN`) instead of gh's own login.
pub async fn run_gh(
    program: &str,
    args: Vec<String>,
    token: Option<&str>,
) -> Result<GhOut, String> {
    let mut command = tokio::process::Command::new(program);
    command.args(&args).kill_on_drop(true);
    if let Some(token) = token {
        command.env("GH_TOKEN", token);
    }
    match tokio::time::timeout(std::time::Duration::from_secs(30), command.output()).await {
        Err(_) => Err("gh timed out after 30 s".into()),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => Err("ENOENT".into()),
        Ok(Err(e)) => Err(e.to_string()),
        Ok(Ok(out)) => Ok(GhOut {
            exit_code: out.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }),
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
    pub(super) fn failed(message: impl Into<String>) -> Self {
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
    /// A draft waits on the train until it is marked ready.
    #[serde(default)]
    pub draft: bool,
    /// Who merged it: only a PR's detail says.
    #[serde(default)]
    pub merged_by: Option<PullMerger>,
    /// Whether it merges cleanly into its base: only a PR's detail says, and None while GitHub still works it out.
    #[serde(default)]
    pub mergeable: Option<bool>,
    /// GitHub's word for it: `dirty` when it conflicts, `unknown` while GitHub still works it out.
    #[serde(default)]
    pub mergeable_state: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PullMerger {
    pub login: String,
    /// GitHub's account type: "User", "Bot".
    #[serde(rename = "type", default)]
    pub kind: String,
}

/// The label that keeps a PR off the train until someone takes it off.
pub const HOLD_LABEL: &str = "hold";

/// The label the train puts on its batch PR and on the next PRs it will merge, so a repo whose CI runners are scarce
/// can run its expensive jobs on those PRs only.
pub const NEXT_LABEL: &str = "fleetd:next";

impl Pull {
    pub fn held(&self) -> bool {
        self.labelled(HOLD_LABEL)
    }

    pub fn labelled(&self, name: &str) -> bool {
        self.labels
            .iter()
            .any(|l| l.name.eq_ignore_ascii_case(name))
    }

    /// GitHub found it conflicts with its base, and so runs no `pull_request` CI on it. Never while GitHub still works
    /// it out.
    pub fn conflicts(&self) -> bool {
        self.mergeable == Some(false) || self.mergeable_state.as_deref() == Some("dirty")
    }
}

/// The machine-readable line in a batch PR's body naming each member and the head it was built from
/// (`fleetd-batch: #7@<sha> #8@<sha>`), which recovery and the `pr_merged` check read.
pub const BATCH_MARKER: &str = "fleetd-batch:";

/// A hidden line on every comment the train posts: it posts under the person's own login, so the metrics' host sweep
/// tells the train's comments from the person's by it.
pub const TRAIN_MARK: &str = "<!-- fleetd:train -->";

/// Each member a batch PR's body names on its `fleetd-batch:` line, with the head sha it was built from (None when
/// the line names none).
pub fn batch_heads(body: &str) -> Vec<(i64, Option<String>)> {
    body.lines()
        .find_map(|l| l.trim().strip_prefix(BATCH_MARKER))
        .map(|rest| {
            rest.split_whitespace()
                .filter_map(|w| {
                    let (n, sha) = match w.trim_start_matches('#').split_once('@') {
                        Some((n, sha)) => (n, Some(sha.to_lowercase())),
                        None => (w.trim_start_matches('#'), None),
                    };
                    Some((n.parse().ok()?, sha))
                })
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

impl CheckRun {
    /// The workflow run that reported it, from its page (`.../actions/runs/<id>/job/<job>`): a re-run's jobs keep it.
    pub fn workflow_run(&self) -> Option<u64> {
        let url = self.html_url.as_deref()?;
        let (_, rest) = url.split_once("/actions/runs/")?;
        rest.split('/').next()?.parse().ok()
    }

    /// The Actions job behind it, from its page (`.../job/<job>`): what a re-run of only this check takes.
    pub fn job(&self) -> Option<u64> {
        let url = self.html_url.as_deref()?;
        let (_, rest) = url.split_once("/job/")?;
        rest.split(['/', '?', '#']).next()?.parse().ok()
    }
}

/// A workflow run, as the Actions API lists it.
#[derive(Clone, Debug, Deserialize)]
pub struct WorkflowRun {
    pub id: u64,
    pub workflow_id: u64,
    /// The workflow's name.
    #[serde(default)]
    pub name: Option<String>,
    /// The workflow's file, `.github/workflows/<file>`.
    #[serde(default)]
    pub path: Option<String>,
    pub head_sha: String,
    pub conclusion: Option<String>,
    pub html_url: String,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// A job of a workflow run: a job of a workflow it calls is named `<caller job> / <job>`, as its check is.
#[derive(Clone, Debug, Deserialize)]
pub struct RunJob {
    pub name: String,
    pub conclusion: Option<String>,
}

/// The latest run of each check in `runs`. A re-run adds a newer run with the same name; only the newest counts. Map
/// order is first-seen.
pub fn latest(runs: Vec<CheckRun>) -> Vec<CheckRun> {
    let mut order: Vec<String> = Vec::new();
    let mut latest: HashMap<String, CheckRun> = HashMap::new();
    for r in runs {
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
    order
        .into_iter()
        .filter_map(|n| latest.remove(&n))
        .collect()
}

/// Whether `new` replaces `seen`, a run of the same check: the newer one does, except that a cancelled twin never
/// stands in for a run that is still going (a superseded workflow run is cancelled while its replacement runs), and a
/// skipped twin never stands in for a run that ran. GitHub writes a skipped job's check run only when its workflow run
/// gets to it: on #638 the PR's own run wrote its skips of the label's checks after the label's run had started them,
/// so the skips had the newer ids.
fn supersedes(new: &CheckRun, seen: &CheckRun) -> bool {
    let cancelled = |r: &CheckRun| r.conclusion.as_deref() == Some("cancelled");
    let skipped = |r: &CheckRun| r.conclusion.as_deref() == Some("skipped");
    let running = |r: &CheckRun| r.status != "completed";
    if cancelled(new) && running(seen) {
        return false;
    }
    if cancelled(seen) && running(new) {
        return true;
    }
    if skipped(new) != skipped(seen) {
        return skipped(seen);
    }
    new.id > seen.id
}

#[derive(Deserialize)]
struct CheckRuns {
    check_runs: Vec<CheckRun>,
}

/// A commit status on a head, as GitHub's combined status lists it: a required check may be one, not a check run.
#[derive(Clone, Debug, Deserialize)]
pub struct CommitStatus {
    pub context: String,
    /// "success", "pending", "failure" or "error".
    pub state: String,
    #[serde(default)]
    pub target_url: Option<String>,
}

#[derive(Deserialize)]
struct CombinedStatus {
    statuses: Vec<CommitStatus>,
}

#[derive(Deserialize)]
struct MergeJson {
    sha: String,
    merged: bool,
}

/// An open PR as the list answers it: enough to see a draft marked ready.
#[derive(Clone, Debug, Deserialize)]
pub struct OpenPull {
    pub number: i64,
    #[serde(default)]
    pub draft: bool,
    pub head: PullHead,
}

#[derive(Deserialize)]
struct PullUser {
    #[serde(rename = "type", default)]
    kind: String,
}

#[derive(Deserialize)]
struct ClosedPull {
    number: i64,
    merged_at: Option<String>,
    merge_commit_sha: Option<String>,
    base: PullBase,
    head: PullHead,
    user: Option<PullUser>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

fn merged(p: ClosedPull) -> Option<MergedPull> {
    p.merged_at.map(|merged_at| MergedPull {
        number: p.number,
        merged_at,
        merge_sha: p.merge_commit_sha,
        base: p.base.ref_,
        head: p.head.ref_,
        author_bot: p.user.map(|u| u.kind == "Bot"),
        created_at: p.created_at,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergedPull {
    pub number: i64,
    pub merged_at: String,
    pub merge_sha: Option<String>,
    pub base: String,
    /// Its branch.
    pub head: String,
    /// Opened by a bot account (GitHub's `user.type`), when GitHub said.
    pub author_bot: Option<bool>,
    pub created_at: Option<String>,
}

/// GitHub's squash message from the repo's settings and the PR's commit messages, oldest first. One commit gives its
/// own subject and body; several give the PR's title and a `* ` line per commit, with their `Co-authored-by`
/// trailers gathered once at the end, as GitHub does.
pub fn squash_text(
    pull: &Pull,
    title_from: &str,
    body_from: &str,
    messages: &[String],
) -> (String, String) {
    let split = |m: &str| -> (String, String) {
        let m = m.replace("\r\n", "\n");
        match m.trim().split_once('\n') {
            Some((subject, body)) => (subject.trim().to_owned(), body.trim().to_owned()),
            None => (m.trim().to_owned(), String::new()),
        }
    };
    let one = (messages.len() == 1).then(|| split(&messages[0]));
    let title = match (&one, title_from) {
        (Some((subject, _)), "COMMIT_OR_PR_TITLE") => subject.clone(),
        _ => pull.title.trim().to_owned(),
    };
    let body = match body_from {
        "PR_BODY" => pull
            .body
            .as_deref()
            .unwrap_or_default()
            .replace("\r\n", "\n"),
        "BLANK" => String::new(),
        _ => match &one {
            Some((_, body)) => body.clone(),
            None => {
                let co_author = |l: &str| l.to_ascii_lowercase().starts_with("co-authored-by:");
                let mut co_authors: Vec<String> = Vec::new();
                let mut lines = Vec::new();
                for m in messages {
                    let m = m.replace("\r\n", "\n");
                    let kept: Vec<&str> =
                        m.trim().lines().filter(|l| !co_author(l.trim())).collect();
                    lines.push(format!("* {}", kept.join("\n").trim()));
                    for l in m.lines().map(str::trim).filter(|l| co_author(l)) {
                        if !co_authors.iter().any(|c| c.eq_ignore_ascii_case(l)) {
                            co_authors.push(l.to_owned());
                        }
                    }
                }
                let mut body = lines.join("\n\n");
                if !co_authors.is_empty() {
                    body = format!("{body}\n\n---------\n\n{}", co_authors.join("\n"));
                }
                body
            }
        },
    };
    (format!("{title} (#{})", pull.number), body)
}

/// Pages of closed PRs `merged_pulls` reads at most per check before it stops short of its cursor: the check runs
/// every minute, so a busy repo stays within GitHub's rate limit; the metrics' host sweep backfills past it.
pub const MERGED_PAGES: usize = 2;
const MERGED_PAGE: usize = 100;

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

/// What `gh pr update-branch --rebase` did to a PR's branch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BranchUpdate {
    /// Already on its base: the head is as it was.
    Current,
    /// Rebased onto its base: a new head, which GitHub may show only a moment later.
    Rebased,
    Conflict,
}

/// What merging a PR's head into the train's batch branch on GitHub did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BranchMerge {
    /// The branch's new head.
    Merged(String),
    /// The branch already has it.
    Nothing,
    Conflict,
}

fn is_sha(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `git patch-id --stable` of `diff`, by the hub's git, which needs no repository for it.
async fn stable_patch_id(diff: String) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new("git")
        .args(["patch-id", "--stable"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("git patch-id could not start on the hub: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("git patch-id has no stdin")?;
    let feed = tokio::spawn(async move { stdin.write_all(diff.as_bytes()).await });
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("git patch-id: {e}"))?;
    let _ = feed.await;
    // "<patch id> <commit id>", the commit id zeros for a diff read from stdin; nothing for an empty diff.
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .filter(|id| is_sha(id))
        .map(String::from)
        .ok_or_else(|| "the diff against its merge base is empty".into())
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

/// `owner/name` of a `repos/<owner>/<name>/...` path, lowercased: the `github:<repo>` freshness source.
fn repo_of(path: &str) -> Option<String> {
    let mut parts = path.strip_prefix("repos/")?.split(['/', '?']);
    let (owner, name) = (parts.next()?, parts.next()?);
    Some(format!("{owner}/{name}").to_lowercase())
}

/// `s` percent-encoded for a URL path (`/` kept when `path`) or query value.
fn encode_url(s: &str, path: bool) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            b'/' if path => "/".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
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
    fresh: Arc<Fresh>,
    clock: Arc<dyn Clock>,
}

impl TrainGitHub {
    pub fn new(gh: Arc<dyn GhRunner>, fresh: Arc<Fresh>, clock: Arc<dyn Clock>) -> Self {
        Self { gh, fresh, clock }
    }

    fn reached(&self, path: &str) {
        if let Some(repo) = repo_of(path) {
            let now = crate::hub::store::system_ms(self.clock.now());
            self.fresh.touch(&fresh::github(&repo), now);
        }
    }

    fn missed(&self, path: &str, why: &str) {
        if let Some(repo) = repo_of(path) {
            self.fresh.fail(&fresh::github(&repo), why);
        }
    }

    /// One `gh` run: gh missing or not logged in is an error of its own kind.
    async fn run(&self, args: Vec<String>) -> Result<GhOut, GhError> {
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
        Ok(out)
    }

    /// `gh api` with `accept`: the answer's text, or `(status, message)` for a non-2xx answer, so callers can tell a
    /// 409 apart. Each answer from GitHub keeps `github:<repo>` fresh.
    async fn exchange(
        &self,
        method: &str,
        path: &str,
        accept: &str,
        fields: &[(&str, &str)],
    ) -> Result<Result<String, (u16, String)>, GhError> {
        let mut args: Vec<String> = vec!["api".into()];
        args.extend(["-X", method, "-H", accept].map(String::from));
        args.push(path.into());
        for (k, v) in fields {
            // `draft` is a JSON boolean; -f would send the string "true".
            args.push(if *k == "draft" { "-F" } else { "-f" }.into());
            args.push(format!("{k}={v}"));
        }
        let reply = self.run(args).await.map(|out| {
            if out.exit_code == 0 {
                return Ok(out.stdout);
            }
            // gh prints GitHub's error body on stdout; its message is the plainest reason.
            let message = serde_json::from_str::<Value>(&out.stdout)
                .ok()
                .and_then(|v| v["message"].as_str().map(String::from))
                .unwrap_or_else(|| last_line(&out.stderr));
            Err((http_status(&out.stderr), message))
        });
        match &reply {
            Ok(Ok(_)) => self.reached(path),
            // GitHub answered, just not with what was asked for (404, 405, 409, 422): it was reached.
            Ok(Err((status, _))) if (400..500).contains(status) => self.reached(path),
            Ok(Err((_, message))) => self.missed(path, message),
            Err(e) => self.missed(path, &e.message),
        }
        reply
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        fields: &[(&str, &str)],
    ) -> Result<Reply, GhError> {
        match self
            .exchange(method, path, "Accept: application/vnd.github+json", fields)
            .await?
        {
            Ok(text) => serde_json::from_str(if text.is_empty() { "null" } else { &text })
                .map(Reply::Ok)
                .map_err(|_| GhError::failed(format!("gh api {path} did not return JSON"))),
            Err((status, message)) => Ok(Reply::Err { status, message }),
        }
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
        Ok(latest(self.all_check_runs(repo, sha).await?))
    }

    /// The check runs on `sha` as GitHub lists them: a check that two workflow runs report (a PR's own run and one
    /// dispatched on its branch) is there once for each.
    pub async fn all_check_runs(&self, repo: &str, sha: &str) -> Result<Vec<CheckRun>, GhError> {
        let runs: CheckRuns = self
            .json(
                "GET",
                &format!("repos/{repo}/commits/{sha}/check-runs?per_page=100"),
                &[],
            )
            .await?;
        Ok(runs.check_runs)
    }

    /// The finished runs on `base` that a schedule started, newest first: one page of 50.
    pub async fn scheduled_runs(
        &self,
        repo: &str,
        base: &str,
    ) -> Result<Vec<WorkflowRun>, GhError> {
        #[derive(Deserialize)]
        struct Runs {
            workflow_runs: Vec<WorkflowRun>,
        }
        let runs: Runs = self
            .json(
                "GET",
                &format!(
                    "repos/{repo}/actions/runs?branch={base}&event=schedule&status=completed&per_page=50"
                ),
                &[],
            )
            .await?;
        Ok(runs.workflow_runs)
    }

    /// The jobs of a workflow run, each at its latest attempt.
    pub async fn run_jobs(&self, repo: &str, run: u64) -> Result<Vec<RunJob>, GhError> {
        #[derive(Deserialize)]
        struct Jobs {
            jobs: Vec<RunJob>,
        }
        let jobs: Jobs = self
            .json(
                "GET",
                &format!("repos/{repo}/actions/runs/{run}/jobs?filter=latest&per_page=100"),
                &[],
            )
            .await?;
        Ok(jobs.jobs)
    }

    /// The commits on `sha` since `from`, oldest first, each its short sha and its title, and how many there are in
    /// all: GitHub lists 250 at most.
    pub async fn commits_since(
        &self,
        repo: &str,
        from: &str,
        sha: &str,
    ) -> Result<(Vec<(String, String)>, usize), GhError> {
        #[derive(Deserialize)]
        struct Message {
            message: String,
        }
        #[derive(Deserialize)]
        struct Commit {
            sha: String,
            commit: Message,
        }
        #[derive(Deserialize)]
        struct Compare {
            commits: Vec<Commit>,
            total_commits: usize,
        }
        let c: Compare = self
            .json("GET", &format!("repos/{repo}/compare/{from}...{sha}"), &[])
            .await?;
        let commits = c.commits.into_iter().map(|c| {
            let title = c
                .commit
                .message
                .lines()
                .next()
                .unwrap_or_default()
                .to_string();
            (super::service::short(&c.sha).to_string(), title)
        });
        Ok((commits.collect(), c.total_commits))
    }

    /// The newest commit status of each context on `sha`.
    pub async fn statuses(&self, repo: &str, sha: &str) -> Result<Vec<CommitStatus>, GhError> {
        let combined: CombinedStatus = self
            .json(
                "GET",
                &format!("repos/{repo}/commits/{sha}/status?per_page=100"),
                &[],
            )
            .await?;
        Ok(combined.statuses)
    }

    /// Re-runs Actions job `job` and the jobs that need it, and nothing else of its workflow run.
    pub async fn rerun_job(&self, repo: &str, job: u64) -> Result<(), GhError> {
        self.json::<Value>(
            "POST",
            &format!("repos/{repo}/actions/jobs/{job}/rerun"),
            &[],
        )
        .await
        .map(|_| ())
    }

    /// The log of Actions job `job`, as text.
    pub async fn job_log(&self, repo: &str, job: u64) -> Result<String, GhError> {
        let path = format!("repos/{repo}/actions/jobs/{job}/logs");
        self.exchange("GET", &path, "Accept: application/vnd.github+json", &[])
            .await?
            .map_err(|(_, message)| GhError::failed(format!("the log of job {job}: {message}")))
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

    /// The squash message GitHub writes for `pull` by the repo's settings (`squash_merge_commit_title` and
    /// `squash_merge_commit_message`, GitHub's defaults when the repo doesn't say): its title and body, so the train
    /// can add to it and keep the rest, the commits' `Co-authored-by` trailers among them.
    pub async fn squash_message(
        &self,
        repo: &str,
        pull: &Pull,
    ) -> Result<(String, String), GhError> {
        #[derive(Deserialize)]
        struct Settings {
            squash_merge_commit_title: Option<String>,
            squash_merge_commit_message: Option<String>,
        }
        #[derive(Deserialize)]
        struct PullCommit {
            commit: CommitJson,
        }
        #[derive(Deserialize)]
        struct CommitJson {
            message: String,
        }
        let settings: Settings = self.json("GET", &format!("repos/{repo}"), &[]).await?;
        let title_from = settings
            .squash_merge_commit_title
            .unwrap_or_else(|| "COMMIT_OR_PR_TITLE".into());
        let body_from = settings
            .squash_merge_commit_message
            .unwrap_or_else(|| "COMMIT_MESSAGES".into());
        let mut messages = Vec::new();
        if title_from == "COMMIT_OR_PR_TITLE" || body_from == "COMMIT_MESSAGES" {
            // GitHub lists at most 250 commits of a PR.
            for page in 1..=3 {
                let commits: Vec<PullCommit> = self
                    .json(
                        "GET",
                        &format!(
                            "repos/{repo}/pulls/{}/commits?per_page=100&page={page}",
                            pull.number
                        ),
                        &[],
                    )
                    .await?;
                let last = commits.len() < 100;
                messages.extend(commits.into_iter().map(|c| c.commit.message));
                if last {
                    break;
                }
            }
        }
        Ok(squash_text(pull, &title_from, &body_from, &messages))
    }

    /// Rebases the PR's branch onto its base on GitHub (`gh pr update-branch --rebase`); a branch already on its base
    /// stays as it is.
    pub async fn update_branch(&self, repo: &str, n: i64) -> Result<BranchUpdate, GhError> {
        let path = format!("repos/{repo}/pulls/{n}");
        let args = [
            "pr",
            "update-branch",
            &n.to_string(),
            "--rebase",
            "--repo",
            repo,
        ];
        let out = match self.run(args.map(String::from).into()).await {
            Ok(out) => out,
            Err(e) => {
                self.missed(&path, &e.message);
                return Err(e);
            }
        };
        let conflict = out.stderr.to_lowercase().contains("conflict");
        if out.exit_code != 0 && !conflict {
            let why = last_line(&out.stderr);
            self.missed(&path, &why);
            return Err(GhError::failed(format!(
                "rebasing {repo}#{n} on GitHub failed: {why}"
            )));
        }
        self.reached(&path);
        Ok(if out.exit_code != 0 {
            BranchUpdate::Conflict
        } else if out.stdout.contains("PR branch updated") {
            BranchUpdate::Rebased
        } else {
            BranchUpdate::Current
        })
    }

    /// Where `branch` points now.
    pub async fn branch_sha(&self, repo: &str, branch: &str) -> Result<String, GhError> {
        #[derive(Deserialize)]
        struct Object {
            sha: String,
        }
        #[derive(Deserialize)]
        struct Ref {
            object: Object,
        }
        let r: Ref = self
            .json("GET", &format!("repos/{repo}/git/ref/heads/{branch}"), &[])
            .await?;
        Ok(r.object.sha.to_lowercase())
    }

    pub async fn create_branch(&self, repo: &str, branch: &str, sha: &str) -> Result<(), GhError> {
        let name = format!("refs/heads/{branch}");
        let fields = [("ref", name.as_str()), ("sha", sha)];
        self.json::<Value>("POST", &format!("repos/{repo}/git/refs"), &fields)
            .await
            .map(|_| ())
    }

    /// Merges `sha` into `branch` on GitHub, a merge commit with `message`.
    pub async fn merge_into(
        &self,
        repo: &str,
        branch: &str,
        sha: &str,
        message: &str,
    ) -> Result<BranchMerge, GhError> {
        let fields = [("base", branch), ("head", sha), ("commit_message", message)];
        match self
            .call("POST", &format!("repos/{repo}/merges"), &fields)
            .await?
        {
            Reply::Ok(Value::Null) => Ok(BranchMerge::Nothing),
            Reply::Ok(v) => v["sha"]
                .as_str()
                .map(|s| BranchMerge::Merged(s.to_lowercase()))
                .ok_or_else(|| GhError::failed(format!("merging into {branch} returned no sha"))),
            Reply::Err { status: 409, .. } => Ok(BranchMerge::Conflict),
            Reply::Err { message, .. } => Err(GhError::failed(format!(
                "merging {} into {branch} failed: {message}",
                &sha[..sha.len().min(12)]
            ))),
        }
    }

    /// The patch id of `sha`: `git patch-id --stable` of its diff against its merge base with `base`, the diff from
    /// GitHub. The train and the reviews both bind to it, so it is computed one way only.
    pub async fn patch_id(&self, repo: &str, base: &str, sha: &str) -> Result<String, GhError> {
        if !is_sha(sha) {
            let shown: String = sha.chars().take(80).collect();
            return Err(GhError::failed(format!("not a full commit SHA: {shown}")));
        }
        let base_sha = self.branch_sha(repo, base).await?;
        self.patch_id_from(repo, &base_sha, sha).await
    }

    /// The patch id of `sha` against its merge base with the commit `from`, as `patch_id` computes it.
    pub async fn patch_id_from(
        &self,
        repo: &str,
        from: &str,
        sha: &str,
    ) -> Result<String, GhError> {
        let at = format!("{repo}@{}", &sha[..sha.len().min(12)]);
        let diff = self.diff(repo, from, sha).await?;
        stable_patch_id(diff)
            .await
            .map_err(|why| GhError::failed(format!("the patch id of {at}: {why}")))
    }

    /// The diff of `sha` against its merge base with the commit `from`, as GitHub shows it.
    pub async fn diff(&self, repo: &str, from: &str, sha: &str) -> Result<String, GhError> {
        let path = format!("repos/{repo}/compare/{from}...{sha}");
        let at = format!("{repo}@{}", &sha[..sha.len().min(12)]);
        self.exchange("GET", &path, "Accept: application/vnd.github.diff", &[])
            .await?
            .map_err(|(_, message)| GhError::failed(format!("the diff of {at}: {message}")))
    }

    /// The patch id of the commit `sha` alone: its diff against its first parent.
    pub async fn commit_patch_id(&self, repo: &str, sha: &str) -> Result<String, GhError> {
        let path = format!("repos/{repo}/commits/{sha}");
        let at = format!("{repo}@{}", &sha[..sha.len().min(12)]);
        let diff = self
            .exchange("GET", &path, "Accept: application/vnd.github.diff", &[])
            .await?
            .map_err(|(_, message)| GhError::failed(format!("the diff of {at}: {message}")))?;
        stable_patch_id(diff)
            .await
            .map_err(|why| GhError::failed(format!("the patch id of {at}: {why}")))
    }

    /// The commits `sha` has on its merge base with the commit `from`, oldest first, and that merge base: the range
    /// `git range-diff` compares. None when GitHub lists only some of them.
    pub async fn range(
        &self,
        repo: &str,
        from: &str,
        sha: &str,
    ) -> Result<Option<(String, Vec<String>)>, GhError> {
        #[derive(Deserialize)]
        struct Commit {
            sha: String,
        }
        #[derive(Deserialize)]
        struct Compare {
            merge_base_commit: Commit,
            commits: Vec<Commit>,
            total_commits: usize,
        }
        let c: Compare = self
            .json("GET", &format!("repos/{repo}/compare/{from}...{sha}"), &[])
            .await?;
        Ok((c.commits.len() == c.total_commits).then(|| {
            let commits = c.commits.into_iter().map(|c| c.sha.to_lowercase());
            (c.merge_base_commit.sha.to_lowercase(), commits.collect())
        }))
    }

    /// Comments on the PR with why (marked as the train's), then closes it.
    pub async fn close(&self, repo: &str, n: i64, comment: &str) -> Result<(), GhError> {
        let body = format!("{comment}\n\n{TRAIN_MARK}");
        self.json::<Value>(
            "POST",
            &format!("repos/{repo}/issues/{n}/comments"),
            &[("body", &body)],
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

    /// The repo's branches whose names start with `prefix`.
    pub async fn matching_branches(
        &self,
        repo: &str,
        prefix: &str,
    ) -> Result<Vec<String>, GhError> {
        #[derive(Deserialize)]
        struct Ref {
            #[serde(rename = "ref")]
            ref_: String,
        }
        let refs: Vec<Ref> = self
            .json(
                "GET",
                &format!("repos/{repo}/git/matching-refs/heads/{prefix}?per_page=100"),
                &[],
            )
            .await?;
        Ok(refs
            .into_iter()
            .filter_map(|r| r.ref_.strip_prefix("refs/heads/").map(String::from))
            .collect())
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

    /// Creates the repo's label `name`; one the repo already has counts as created.
    pub async fn create_label(
        &self,
        repo: &str,
        name: &str,
        color: &str,
        description: &str,
    ) -> Result<(), GhError> {
        let fields = [
            ("name", name),
            ("color", color),
            ("description", description),
        ];
        match self
            .call("POST", &format!("repos/{repo}/labels"), &fields)
            .await?
        {
            Reply::Ok(_) | Reply::Err { status: 422, .. } => Ok(()),
            Reply::Err { message, .. } => Err(GhError::failed(format!(
                "creating the label {name} on {repo} failed: {message}"
            ))),
        }
    }

    pub async fn add_label(&self, repo: &str, n: i64, name: &str) -> Result<(), GhError> {
        self.json::<Value>(
            "POST",
            &format!("repos/{repo}/issues/{n}/labels"),
            &[("labels[]", name)],
        )
        .await
        .map(|_| ())
    }

    /// Takes `name` off the PR; one without it counts as done.
    pub async fn remove_label(&self, repo: &str, n: i64, name: &str) -> Result<(), GhError> {
        let name = name.replace(':', "%3A");
        match self
            .call(
                "DELETE",
                &format!("repos/{repo}/issues/{n}/labels/{name}"),
                &[],
            )
            .await?
        {
            Reply::Ok(_) | Reply::Err { status: 404, .. } => Ok(()),
            Reply::Err { message, .. } => Err(GhError::failed(format!(
                "taking the label off {repo}#{n} failed: {message}"
            ))),
        }
    }

    /// Each workflow file in `.github/workflows` on `branch`, by path, with its text; a repo without the directory has
    /// none.
    pub async fn workflow_files(
        &self,
        repo: &str,
        branch: &str,
    ) -> Result<Vec<(String, String)>, GhError> {
        #[derive(Deserialize)]
        struct Entry {
            path: String,
            #[serde(rename = "type")]
            kind: String,
        }
        let at = encode_url(branch, false);
        let entries: Vec<Entry> = match self
            .call(
                "GET",
                &format!("repos/{repo}/contents/.github/workflows?ref={at}"),
                &[],
            )
            .await?
        {
            Reply::Ok(v) => serde_json::from_value(v).map_err(|_| {
                GhError::failed(format!(
                    "the workflows of {repo} came in an unexpected shape"
                ))
            })?,
            Reply::Err { status: 404, .. } => return Ok(Vec::new()),
            Reply::Err { message, .. } => {
                return Err(GhError::failed(format!(
                    "the workflows of {repo}: {message}"
                )));
            }
        };
        let mut files = Vec::new();
        for e in entries {
            if e.kind != "file" || !(e.path.ends_with(".yml") || e.path.ends_with(".yaml")) {
                continue;
            }
            let path = format!(
                "repos/{repo}/contents/{}?ref={at}",
                encode_url(&e.path, true)
            );
            let text = self
                .exchange("GET", &path, "Accept: application/vnd.github.raw", &[])
                .await?
                .map_err(|(_, message)| GhError::failed(format!("{}: {message}", e.path)))?;
            files.push((e.path, text));
        }
        Ok(files)
    }

    /// The text of the file `path` on `branch`; None when it has none.
    pub async fn file(
        &self,
        repo: &str,
        path: &str,
        branch: &str,
    ) -> Result<Option<String>, GhError> {
        let at = encode_url(branch, false);
        let url = format!("repos/{repo}/contents/{}?ref={at}", encode_url(path, true));
        match self
            .exchange("GET", &url, "Accept: application/vnd.github.raw", &[])
            .await?
        {
            Ok(text) => Ok(Some(text)),
            Err((404, _)) => Ok(None),
            Err((_, message)) => Err(GhError::failed(format!("{path} on {branch}: {message}"))),
        }
    }

    /// The names of the files in the directory `dir` on `branch` (one listing, up to 1,000); none when it has no such
    /// directory.
    pub async fn file_names(
        &self,
        repo: &str,
        dir: &str,
        branch: &str,
    ) -> Result<Vec<String>, GhError> {
        #[derive(Deserialize)]
        struct Entry {
            name: String,
            #[serde(rename = "type")]
            kind: String,
        }
        let at = encode_url(branch, false);
        let dir = dir.trim_end_matches('/');
        let url = format!("repos/{repo}/contents/{}?ref={at}", encode_url(dir, true));
        match self.call("GET", &url, &[]).await? {
            Reply::Ok(v) => {
                let entries: Vec<Entry> = serde_json::from_value(v).map_err(|_| {
                    GhError::failed(format!("{dir} on {branch} is not a directory"))
                })?;
                Ok(entries
                    .into_iter()
                    .filter(|e| e.kind == "file")
                    .map(|e| e.name)
                    .collect())
            }
            Reply::Err { status: 404, .. } => Ok(Vec::new()),
            Reply::Err { message, .. } => {
                Err(GhError::failed(format!("{dir} on {branch}: {message}")))
            }
        }
    }

    /// The paths a PR adds, by GitHub's list of its files (up to 3,000, a page of 100 at a time).
    pub async fn added_files(&self, repo: &str, n: i64) -> Result<Vec<String>, GhError> {
        #[derive(Deserialize)]
        struct File {
            filename: String,
            status: String,
        }
        let mut added = Vec::new();
        for page in 1..=30 {
            let files: Vec<File> = self
                .json(
                    "GET",
                    &format!("repos/{repo}/pulls/{n}/files?per_page=100&page={page}"),
                    &[],
                )
                .await?;
            let last = files.len() < 100;
            added.extend(
                files
                    .into_iter()
                    .filter(|f| f.status == "added")
                    .map(|f| f.filename),
            );
            if last {
                break;
            }
        }
        Ok(added)
    }

    /// The repo's open PRs that carry the label `name` (one page).
    pub async fn labelled_pulls(&self, repo: &str, name: &str) -> Result<Vec<i64>, GhError> {
        #[derive(Deserialize)]
        struct Issue {
            number: i64,
            /// Only a PR has it.
            pull_request: Option<Value>,
        }
        let issues: Vec<Issue> = self
            .json(
                "GET",
                &format!("repos/{repo}/issues?state=open&labels={name}&per_page=100"),
                &[],
            )
            .await?;
        Ok(issues
            .into_iter()
            .filter(|i| i.pull_request.is_some())
            .map(|i| i.number)
            .collect())
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

    /// The repo's open PRs, newest first (one page).
    pub async fn open_pulls(&self, repo: &str) -> Result<Vec<OpenPull>, GhError> {
        self.json(
            "GET",
            &format!("repos/{repo}/pulls?state=open&sort=created&direction=desc&per_page=100"),
            &[],
        )
        .await
    }

    /// Closed PRs that were merged, most recently updated first, paged until one was last updated before
    /// `since_ms` (at most [`MERGED_PAGES`] pages).
    pub async fn merged_pulls(
        &self,
        repo: &str,
        since_ms: i64,
    ) -> Result<Vec<MergedPull>, GhError> {
        let mut out = Vec::new();
        for page in 1..=MERGED_PAGES {
            let pulls: Vec<ClosedPull> = self
                .json(
                    "GET",
                    &format!(
                        "repos/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page={MERGED_PAGE}&page={page}"
                    ),
                    &[],
                )
                .await?;
            let full = pulls.len() == MERGED_PAGE;
            let passed = pulls.last().is_none_or(|p| {
                p.updated_at
                    .as_deref()
                    .and_then(crate::hub::store::parse_ms)
                    .is_none_or(|at| at < since_ms)
            });
            out.extend(pulls.into_iter().filter_map(|p| {
                p.merged_at.map(|merged_at| MergedPull {
                    number: p.number,
                    merged_at,
                    merge_sha: p.merge_commit_sha,
                    base: p.base.ref_,
                    head: p.head.ref_,
                    author_bot: p.user.map(|u| u.kind == "Bot"),
                    created_at: p.created_at,
                })
            }));
            if !full || passed {
                break;
            }
        }
        Ok(out)
    }

    /// The merged PRs a commit came from: how a rebase merge's earlier commits, which GitHub never names as the merge
    /// commit, are matched to their PR.
    pub async fn merged_pulls_of(&self, repo: &str, sha: &str) -> Result<Vec<MergedPull>, GhError> {
        let pulls: Vec<ClosedPull> = self
            .json("GET", &format!("repos/{repo}/commits/{sha}/pulls"), &[])
            .await?;
        Ok(pulls.into_iter().filter_map(merged).collect())
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
    use std::sync::Mutex;

    use super::*;
    use crate::clock::SystemClock;

    /// Replays `gh api` answers in order.
    #[derive(Default)]
    struct Replay {
        answers: Mutex<Vec<(i32, &'static str, &'static str)>>,
    }

    impl GhRunner for Replay {
        fn run(&self, _: Vec<String>) -> BoxFut<'_, Result<GhOut, String>> {
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

    fn github(answers: Vec<(i32, &'static str, &'static str)>) -> (Arc<Fresh>, TrainGitHub) {
        let gh = Arc::new(Replay {
            answers: Mutex::new(answers),
        });
        let fresh = Arc::new(Fresh::default());
        let github = TrainGitHub::new(gh, fresh.clone(), Arc::new(SystemClock));
        (fresh, github)
    }

    #[test]
    fn a_branch_and_a_path_are_percent_encoded() {
        assert_eq!(
            encode_url("fleetd/a b#1?x&y", false),
            "fleetd%2Fa%20b%231%3Fx%26y"
        );
        assert_eq!(
            encode_url(".github/workflows/c i.yml", true),
            ".github/workflows/c%20i.yml"
        );
    }

    #[tokio::test]
    async fn a_404_is_an_answer_with_its_status() {
        let (_, github) = github(vec![(
            1,
            r#"{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}"#,
            "gh: Not Found (HTTP 404)\n",
        )]);
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
        let (fresh, github) = github(vec![(1, "", "gh: connect: network is unreachable\n")]);
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
}
