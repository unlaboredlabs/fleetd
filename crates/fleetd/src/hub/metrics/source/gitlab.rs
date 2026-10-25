//! GitLab (gitlab.com or self-hosted) through its REST API v4, as the person: `glab api` when `glab` is installed and
//! signed in to the instance, else the token git's credential helper already has for it. fleetd never asks for a
//! token or writes one down (the helper's answer is held in memory for five minutes); with neither, the repo's reads
//! fail with "log in with `glab auth login`".
//! Pages of 100 merged MRs (who opened and merged each), of 100 first-parent commits on the default branch (GitLab
//! doesn't list a commit's MRs with it, so each one no merge accounts for is asked about), and of 50 recently updated
//! MRs whose notes are the person's comments and approvals (not what fleetd posted, `super::fleetd_posted`). Pages
//! stop once past the cursor, and at a bound; a merged-MR read the bound cut short goes on by time.
//!
//! A remote on any host other than gitlab.com is GitLab when `/api/v4/version` answers as GitLab does, asked with no
//! credentials ([`is_gitlab`]).
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::metrics::ActorKind;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{GitHostSource, LandedCommit, MergedPr, MergedRead, RepoInfo, RepoRef};
use crate::hub::metrics::host_acts::{HostAct, HostActKind, HostActs};
use crate::hub::store::{iso_ms, parse_ms};
use crate::hub::train::github::batch_heads;
use crate::hub::usage::ports::BoxFut;

/// Pages of 100 merged MRs read at most per sweep: a 90-day first read of a busy repo stops at 2,000 MRs.
pub const MERGED_PAGES: usize = 20;
/// Pages of 100 default-branch commits read at most per sweep.
pub const COMMIT_PAGES: usize = 20;
/// Pages of 50 recently updated MRs read at most for notes.
pub const ACT_PAGES: usize = 10;
/// Pages of 100 notes read at most per MR.
pub const NOTE_PAGES: usize = 5;

/// What every read says when GitLab can't be read as the person.
pub const LOG_IN: &str = "log in with `glab auth login`";

/// One answer of the API.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub body: String,
}

/// GitLab's REST API v4 on an instance ("gitlab.com", "gitlab.example.com"). Tests answer from recorded responses.
pub trait GitLabApi: Send + Sync {
    /// GETs `path` (after `/api/v4/`) as the person. `Err` when there is no way to read as them (no `glab` login, no
    /// token in git's credential helper), or the call couldn't be made.
    fn get<'a>(&'a self, instance: &'a str, path: &'a str) -> BoxFut<'a, Result<Reply, String>>;

    /// GETs `/api/v4/version` with no credentials, so nothing is sent to a host that isn't GitLab.
    fn version<'a>(&'a self, instance: &'a str) -> BoxFut<'a, Result<Reply, String>>;
}

/// Whether the instance is GitLab: `Some(true)` when its version answered, or it refused with GitLab's own 401;
/// `Some(false)` when it answered as something else; `None` when it gave no answer to go by (unreachable, timed out,
/// or a server error, as a GitLab under maintenance gives), so it is asked again.
pub async fn is_gitlab(api: &dyn GitLabApi, instance: &str) -> Option<bool> {
    let reply = api.version(instance).await.ok()?;
    if reply.status >= 500 {
        return None;
    }
    let v = serde_json::from_str::<Value>(&reply.body).unwrap_or_default();
    Some(match reply.status {
        200 => v["version"].is_string(),
        401 => v["message"].as_str() == Some("401 Unauthorized"),
        _ => false,
    })
}

/// The instance and the project's path of a remote key: "gitlab.example.com:8443/team/api" →
/// ("gitlab.example.com:8443", "team/api"). A key's port is the web port ([`super::remote_key`] leaves an ssh port
/// out), so it stays.
pub fn split_remote(remote: &str) -> Option<(&str, &str)> {
    let (host, path) = remote.split_once('/')?;
    (!host.is_empty() && !path.is_empty()).then_some((host, path))
}

/// Percent-encodes everything but RFC 3986's unreserved characters: a project path ("team/api" → "team%2Fapi"), a
/// branch or a timestamp in a query.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[derive(Deserialize)]
struct User {
    username: Option<String>,
    /// GitLab 16 and later say so for bot users (project and group access tokens, service accounts).
    #[serde(default)]
    bot: Option<bool>,
}

/// The bot accounts GitLab makes for access tokens and its own services, and the usual dependency bots.
fn bot_name(name: &str) -> bool {
    let name = name.to_lowercase();
    let token_bot = |prefix: &str| {
        name.strip_prefix(prefix)
            .and_then(|rest| rest.split_once("_bot"))
            .is_some_and(|(id, _)| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
    };
    token_bot("project_")
        || token_bot("group_")
        || name.starts_with("service_account_")
        || name.ends_with("[bot]")
        || name.ends_with("-bot")
        || name.ends_with("_bot")
        || matches!(
            name.as_str(),
            "dependabot" | "renovate" | "snyk-bot" | "gitlab-bot" | "support-bot" | "alert-bot"
        )
}

/// GitLab's account kind: a bot by its flag or its name; a deleted account is GitLab's `ghost`.
fn kind(user: Option<&User>) -> ActorKind {
    let Some(u) = user else {
        return ActorKind::Unknown;
    };
    let name = u.username.as_deref().unwrap_or_default();
    if u.bot == Some(true) || bot_name(name) {
        ActorKind::Bot
    } else if name.is_empty() || name == "ghost" {
        ActorKind::Unknown
    } else {
        ActorKind::Human
    }
}

#[derive(Deserialize)]
struct Upstream {
    id: i64,
    path_with_namespace: String,
    default_branch: Option<String>,
}

#[derive(Deserialize)]
struct Project {
    id: i64,
    default_branch: Option<String>,
    forked_from_project: Option<Upstream>,
}

/// What a repo's MRs are read against: its own id, and the project it was forked from.
#[derive(Clone)]
struct Facts {
    id: i64,
    path: String,
    default_branch: String,
    upstream: Option<(i64, String, Option<String>)>,
}

#[derive(Deserialize)]
struct Mr {
    iid: i64,
    #[serde(default)]
    title: String,
    web_url: Option<String>,
    description: Option<String>,
    created_at: Option<String>,
    updated_at: String,
    merged_at: Option<String>,
    target_branch: String,
    source_branch: String,
    source_project_id: Option<i64>,
    target_project_id: Option<i64>,
    author: Option<User>,
    /// Who merged it, or set it to merge when its pipeline passed; `merged_by` on GitLab before 14.7.
    merge_user: Option<User>,
    merged_by: Option<User>,
    merge_commit_sha: Option<String>,
    squash_commit_sha: Option<String>,
    sha: Option<String>,
}

#[derive(Deserialize)]
struct Commit {
    id: String,
    committed_date: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    parent_ids: Vec<String>,
    author_name: Option<String>,
    author_email: Option<String>,
}

#[derive(Deserialize)]
struct CommitMr {
    iid: i64,
    state: String,
}

#[derive(Deserialize)]
struct ActMr {
    iid: i64,
    source_branch: Option<String>,
}

#[derive(Deserialize)]
struct Note {
    id: i64,
    #[serde(default)]
    body: String,
    created_at: String,
    #[serde(default)]
    system: bool,
    author: Option<User>,
}

/// What a note is as the person's act: an approval or a change request (GitLab records both as system notes, and
/// older versions keep no time on the approval itself) is a review, anything a person wrote a comment. Other system
/// notes (pushes, label changes) are not acts.
fn note_act(n: &Note) -> Option<HostActKind> {
    if !n.system {
        return Some(HostActKind::Comment);
    }
    let body = n.body.trim_start();
    (body.starts_with("approved this merge request") || body.starts_with("requested changes"))
        .then_some(HostActKind::Review)
}

/// A git identity of a GitLab bot: a token bot's `project_12_bot_…@noreply.…`, or `name[bot]`.
fn bot_identity(name: Option<&str>, email: Option<&str>) -> bool {
    name.is_some_and(|n| n.ends_with("[bot]"))
        || email
            .and_then(|e| e.split_once('@'))
            .is_some_and(|(local, _)| bot_name(local))
}

fn merged_pr(m: Mr, facts: &Facts) -> Option<MergedPr> {
    let merged_ms = m.merged_at.as_deref().and_then(parse_ms)?;
    let (head_repo, head_default) = match (m.source_project_id, &facts.upstream) {
        (Some(s), _) if Some(s) == m.target_project_id || s == facts.id => {
            (Some(facts.path.clone()), Some(facts.default_branch.clone()))
        }
        (Some(s), Some((up, path, default))) if s == *up => (Some(path.clone()), default.clone()),
        _ => (None, None),
    };
    let merger = m.merge_user.as_ref().or(m.merged_by.as_ref());
    Some(MergedPr {
        number: m.iid,
        head_is_default: head_default.as_deref() == Some(m.source_branch.as_str()),
        head_repo,
        title: m.title,
        url: m.web_url,
        base: m.target_branch,
        head: m.source_branch,
        author: kind(m.author.as_ref()),
        merged_by: kind(merger),
        merged_by_login: merger.and_then(|u| u.username.clone()),
        created_ms: m.created_at.as_deref().and_then(parse_ms),
        updated_ms: parse_ms(&m.updated_at).unwrap_or(merged_ms),
        merged_ms,
        // The commit on the target's own line: the merge commit, else the squash, else (fast-forward) the head.
        merge_sha: m
            .merge_commit_sha
            .or(m.squash_commit_sha)
            .or(m.sha)
            .map(|s| s.to_lowercase()),
        // The list doesn't carry lines; a review's credit takes its base.
        additions: None,
        deletions: None,
        batch_members: m
            .description
            .as_deref()
            .map(batch_heads)
            .unwrap_or_default()
            .into_iter()
            .map(|(n, _)| n)
            .collect(),
    })
}

/// One instance's reads.
pub struct GitLabSource {
    api: Arc<dyn GitLabApi>,
    instance: String,
    facts: Mutex<HashMap<String, Facts>>,
    /// The most items asked for per page; tests page with fewer.
    page_cap: usize,
}

fn decode<T: DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v)
        .map_err(|_| "GitLab answered in a shape fleetd doesn't read.".to_owned())
}

impl GitLabSource {
    pub fn new(api: Arc<dyn GitLabApi>, instance: &str) -> Self {
        Self {
            api,
            instance: instance.to_owned(),
            facts: Mutex::default(),
            page_cap: usize::MAX,
        }
    }

    #[cfg(test)]
    pub fn with_page_cap(mut self, cap: usize) -> Self {
        self.page_cap = cap;
        self
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let reply = self.api.get(&self.instance, path).await?;
        let message = || {
            serde_json::from_str::<Value>(&reply.body)
                .ok()
                .and_then(|v| match &v["message"] {
                    Value::String(s) => Some(s.clone()),
                    Value::Null => v["error"].as_str().map(str::to_owned),
                    other => Some(other.to_string()),
                })
                .unwrap_or_default()
        };
        match reply.status {
            200..=299 => serde_json::from_str(&reply.body)
                .map_err(|_| "GitLab answered in a shape fleetd doesn't read.".to_owned()),
            401 => Err(LOG_IN.to_owned()),
            403 => Err(format!(
                "GitLab refused the read: the login needs the read_api scope ({})",
                crate::hub::api::clip(&message(), 120)
            )),
            404 => Err(
                "GitLab doesn't know this project, or the signed-in account can't see it."
                    .to_owned(),
            ),
            status => Err(match message() {
                m if m.is_empty() => format!("GitLab couldn't be read: HTTP {status}"),
                m => format!(
                    "GitLab couldn't be read: HTTP {status}: {}",
                    crate::hub::api::clip(&m, 200)
                ),
            }),
        }
    }

    /// Pages of `path` (with `&page=` added) of up to `per_page` items, until `keep` says one passed the cursor, a
    /// page comes back short, or `max` pages were read: then the read was cut short, and this says so.
    async fn pages<T: DeserializeOwned>(
        &self,
        path: &str,
        per_page: usize,
        max: usize,
        mut keep: impl FnMut(T) -> bool,
    ) -> Result<bool, String> {
        let per_page = per_page.min(self.page_cap);
        for page in 1..=max {
            let items: Vec<T> = decode(
                self.get(&format!("{path}&per_page={per_page}&page={page}"))
                    .await?,
            )?;
            let full = items.len() >= per_page;
            let mut go_on = full;
            for item in items {
                go_on &= keep(item);
            }
            if !go_on {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// The project's id, default branch and upstream, read once per repo.
    async fn facts(&self, repo: &RepoRef) -> Result<Facts, String> {
        if let Some(f) = self
            .facts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&repo.path)
        {
            return Ok(f.clone());
        }
        let p: Project = decode(self.get(&format!("projects/{}", enc(&repo.path))).await?)?;
        let facts = Facts {
            id: p.id,
            path: repo.path.clone(),
            default_branch: p
                .default_branch
                .ok_or("GitLab has no default branch on this project: it has no commits yet.")?,
            upstream: p
                .forked_from_project
                .map(|u| (u.id, u.path_with_namespace, u.default_branch)),
        };
        self.facts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(repo.path.clone(), facts.clone());
        Ok(facts)
    }
}

impl GitHostSource for GitLabSource {
    fn host(&self) -> &'static str {
        "gitlab"
    }

    fn signed_in(&self) -> BoxFut<'_, Result<Option<String>, String>> {
        Box::pin(async move {
            let u: User = decode(self.get("user").await?)?;
            Ok(u.username)
        })
    }

    fn repo_info<'a>(&'a self, repo: &'a RepoRef) -> BoxFut<'a, Result<RepoInfo, String>> {
        Box::pin(async move {
            // Read fresh each sweep: the default branch can be changed.
            self.facts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&repo.path);
            let f = self.facts(repo).await?;
            Ok(RepoInfo {
                default_branch: f.default_branch,
                upstream: f.upstream.map(|(_, path, _)| path),
            })
        })
    }

    fn merged_since<'a>(
        &'a self,
        repo: &'a RepoRef,
        since_ms: i64,
        after: Option<&'a str>,
    ) -> BoxFut<'a, Result<MergedRead, String>> {
        Box::pin(async move {
            let facts = self.facts(repo).await?;
            let mut path = format!(
                "projects/{}/merge_requests?state=merged&order_by=updated_at&sort=desc&updated_after={}",
                facts.id,
                enc(&iso_ms(since_ms))
            );
            // Going on from a read the cap cut short is by time, not page: pages shift as MRs are updated, and
            // GitLab's `updated_before` takes that time in, so a resume reads the last MRs again rather than missing
            // any.
            if let Some(after) = after {
                path.push_str(&format!("&updated_before={}", enc(after)));
            }
            let (mut pulls, mut oldest) = (Vec::new(), i64::MAX);
            let cut = self
                .pages(&path, 100, MERGED_PAGES, |m: Mr| {
                    let updated = parse_ms(&m.updated_at).unwrap_or(i64::MAX);
                    oldest = oldest.min(updated);
                    if updated >= since_ms {
                        pulls.extend(merged_pr(m, &facts));
                    }
                    updated >= since_ms
                })
                .await?;
            Ok(MergedRead {
                pulls,
                rest: (cut && oldest != i64::MAX).then(|| (iso_ms(oldest), oldest)),
            })
        })
    }

    fn default_commits<'a>(
        &'a self,
        repo: &'a RepoRef,
        branch: &'a str,
        since_ms: i64,
        stop_at: Option<&'a str>,
    ) -> BoxFut<'a, Result<Vec<LandedCommit>, String>> {
        Box::pin(async move {
            let facts = self.facts(repo).await?;
            let mut path = format!(
                "projects/{}/repository/commits?ref_name={}&first_parent=true",
                facts.id,
                enc(branch)
            );
            // Back to the last read's head whatever the commits' dates, else the date window.
            if stop_at.is_none() {
                path.push_str(&format!("&since={}", enc(&iso_ms(since_ms))));
            }
            let mut out = Vec::new();
            self.pages(&path, 100, COMMIT_PAGES, |c: Commit| {
                let go_on = stop_at.is_none_or(|s| !c.id.eq_ignore_ascii_case(s));
                out.push(LandedCommit {
                    at_ms: parse_ms(&c.committed_date).unwrap_or(0),
                    title: c.title,
                    first_parent: c.parent_ids.first().map(|p| p.to_lowercase()),
                    prs: None,
                    bot: bot_identity(c.author_name.as_deref(), c.author_email.as_deref()),
                    sha: c.id.to_lowercase(),
                });
                go_on
            })
            .await?;
            Ok(out)
        })
    }

    fn prs_of_commit<'a>(
        &'a self,
        repo: &'a RepoRef,
        sha: &'a str,
    ) -> BoxFut<'a, Result<Vec<i64>, String>> {
        Box::pin(async move {
            let facts = self.facts(repo).await?;
            let mrs: Vec<CommitMr> = decode(
                self.get(&format!(
                    "projects/{}/repository/commits/{}/merge_requests",
                    facts.id,
                    enc(sha)
                ))
                .await?,
            )?;
            Ok(mrs
                .into_iter()
                .filter(|m| m.state == "merged")
                .map(|m| m.iid)
                .collect())
        })
    }

    fn acts(&self) -> &dyn HostActs {
        self
    }
}

impl HostActs for GitLabSource {
    fn acts_since<'a>(
        &'a self,
        repo: &'a str,
        since_ms: i64,
    ) -> BoxFut<'a, Result<Vec<HostAct>, String>> {
        Box::pin(async move {
            let (_, path) = split_remote(repo).ok_or_else(|| format!("{repo} is not host/path"))?;
            let repo = RepoRef {
                remote: repo.to_owned(),
                path: path.to_owned(),
            };
            let facts = self.facts(&repo).await?;
            let mut mrs = Vec::new();
            self.pages(
                &format!(
                    "projects/{}/merge_requests?state=all&order_by=updated_at&sort=desc&updated_after={}",
                    facts.id,
                    enc(&iso_ms(since_ms))
                ),
                50,
                ACT_PAGES,
                |m: ActMr| {
                    mrs.push(m);
                    true
                },
            )
            .await?;
            let mut out = Vec::new();
            for mr in mrs {
                let notes = format!(
                    "projects/{}/merge_requests/{}/notes?sort=desc&order_by=created_at",
                    facts.id, mr.iid
                );
                self.pages(&notes, 100, NOTE_PAGES, |n: Note| {
                    let at_ms = parse_ms(&n.created_at).unwrap_or(0);
                    // What fleetd posted under the person's login is not their act.
                    if at_ms >= since_ms
                        && !super::fleetd_posted(&n.body)
                        && let Some(what) = note_act(&n)
                    {
                        out.push(HostAct {
                            kind: what,
                            id: n.id.to_string(),
                            pr_number: mr.iid,
                            at_ms,
                            login: n.author.as_ref().and_then(|a| a.username.clone()),
                            bot: kind(n.author.as_ref()) == ActorKind::Bot,
                            head: mr.source_branch.clone(),
                            lines: None,
                        });
                    }
                    at_ms >= since_ms
                })
                .await?;
            }
            Ok(out)
        })
    }
}

/// How the person reads an instance.
#[derive(Clone)]
enum Auth {
    Glab,
    Token(String),
    None,
}

/// How long an instance's way in is trusted before it's looked up again: a `glab auth login` or a new token in the
/// credential helper is picked up within this. Kept in memory only.
const AUTH_FOR: Duration = Duration::from_secs(5 * 60);
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// The real API: `glab` on PATH, else HTTPS with the credential helper's token.
pub struct SystemGitLab {
    http: reqwest::Client,
    auth: Mutex<HashMap<String, (Auth, std::time::Instant)>>,
}

impl Default for SystemGitLab {
    fn default() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(CALL_TIMEOUT)
                // A token never follows a redirect.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default(),
            auth: Mutex::default(),
        }
    }
}

async fn output(
    mut cmd: tokio::process::Command,
    stdin: Option<String>,
) -> Option<std::process::Output> {
    use tokio::io::AsyncWriteExt;
    cmd.kill_on_drop(true)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let mut input = child.stdin.take()?;
    if let Some(s) = stdin {
        input.write_all(s.as_bytes()).await.ok()?;
    }
    drop(input);
    tokio::time::timeout(CALL_TIMEOUT, child.wait_with_output())
        .await
        .ok()?
        .ok()
}

/// The password git's credential helper answers for the instance, if it has one. Never prompts: no terminal, no
/// askpass, no credential manager window.
pub fn credential_password(out: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.strip_prefix("password="))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
}

/// The HTTP status in `glab api`'s error line ("glab: 404 Not Found (HTTP 404)").
pub fn glab_status(stderr: &str) -> Option<u16> {
    let at = stderr.find("HTTP ")?;
    stderr[at + 5..].get(..3)?.parse().ok()
}

impl SystemGitLab {
    async fn auth(&self, instance: &str) -> Auth {
        if let Some((auth, at)) = self
            .auth
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(instance)
            && at.elapsed() < AUTH_FOR
        {
            return auth.clone();
        }
        // Signed in is a read that works: `glab auth status` says yes for a token that has expired.
        let mut glab = tokio::process::Command::new("glab");
        glab.args(["api", "--hostname", instance, "user"]);
        let auth = if output(glab, None).await.is_some_and(|o| o.status.success()) {
            Auth::Glab
        } else {
            let mut git = tokio::process::Command::new("git");
            git.args(["-c", "credential.interactive=false", "credential", "fill"])
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GIT_ASKPASS", "")
                .env("SSH_ASKPASS", "")
                .env("GCM_INTERACTIVE", "never");
            let asked = format!("protocol=https\nhost={instance}\n\n");
            match output(git, Some(asked)).await {
                Some(o) if o.status.success() => {
                    credential_password(&String::from_utf8_lossy(&o.stdout))
                        .map_or(Auth::None, Auth::Token)
                }
                _ => Auth::None,
            }
        };
        self.auth.lock().unwrap_or_else(|e| e.into_inner()).insert(
            instance.to_owned(),
            (auth.clone(), std::time::Instant::now()),
        );
        auth
    }

    async fn http(&self, instance: &str, path: &str, token: Option<&str>) -> Result<Reply, String> {
        let mut req = self.http.get(format!("https://{instance}/api/v4/{path}"));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let res = req
            .send()
            .await
            .map_err(|e| format!("GitLab couldn't be reached at {instance}: {e}"))?;
        let status = res.status().as_u16();
        let body = res
            .text()
            .await
            .map_err(|e| format!("GitLab's answer was cut off: {e}"))?;
        Ok(Reply { status, body })
    }
}

impl GitLabApi for SystemGitLab {
    fn get<'a>(&'a self, instance: &'a str, path: &'a str) -> BoxFut<'a, Result<Reply, String>> {
        Box::pin(async move {
            match self.auth(instance).await {
                Auth::None => Err(LOG_IN.to_owned()),
                Auth::Token(t) => self.http(instance, path, Some(&t)).await,
                Auth::Glab => {
                    let mut glab = tokio::process::Command::new("glab");
                    glab.args(["api", "--hostname", instance, path]);
                    let o = output(glab, None)
                        .await
                        .ok_or("glab didn't answer within 30 s.")?;
                    let stderr = String::from_utf8_lossy(&o.stderr);
                    let status = if o.status.success() {
                        200
                    } else {
                        glab_status(&stderr).ok_or_else(|| {
                            format!(
                                "GitLab couldn't be read: {}",
                                crate::hub::api::clip(stderr.trim(), 200)
                            )
                        })?
                    };
                    Ok(Reply {
                        status,
                        body: String::from_utf8_lossy(&o.stdout).into_owned(),
                    })
                }
            }
        })
    }

    fn version<'a>(&'a self, instance: &'a str) -> BoxFut<'a, Result<Reply, String>> {
        Box::pin(self.http(instance, "version", None))
    }
}
