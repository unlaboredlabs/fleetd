//! What the host sweep reads from a repo's git host, one implementation per host. GitHub ships first; GitLab, Gitea,
//! Bitbucket and Azure DevOps each fit the same shape (merged PRs with who opened and merged them, the default
//! branch's first-parent commits and the PRs each belongs to, reviews and comments), and each is its own PR when a
//! project needs it. A repo on a host with no source is still listed, with its figures marked as not read.
pub mod github;

use std::sync::Arc;

use fleetd_contracts::metrics::ActorKind;

use super::host_acts::HostActs;
use crate::hub::usage::ports::BoxFut;

/// A repo as the sweep reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoRef {
    /// The metrics' key, host first: "github.com/acme/web".
    pub remote: String,
    /// The host's own name for it: "acme/web".
    pub path: String,
}

/// What the host says about the repo itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RepoInfo {
    pub default_branch: String,
    /// The repo this one is a fork of, by the host's name ("upstream/web"): a PR from its default branch is a sync.
    pub upstream: Option<String>,
}

/// A PR merged on the host, into any base.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergedPr {
    pub number: i64,
    pub title: String,
    pub url: Option<String>,
    pub base: String,
    pub head: String,
    /// The repo its head is on, by the host's name, when the host said.
    pub head_repo: Option<String>,
    /// Whether `head` is the default branch of the repo it is on.
    pub head_is_default: bool,
    pub author: ActorKind,
    pub merged_by: ActorKind,
    /// The merger's login.
    pub merged_by_login: Option<String>,
    pub created_ms: Option<i64>,
    pub updated_ms: i64,
    pub merged_ms: i64,
    pub merge_sha: Option<String>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    /// The members a train batch PR names on its `fleetd-batch:` line, empty for any other PR.
    pub batch_members: Vec<i64>,
}

/// One read of merged PRs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MergedRead {
    pub pulls: Vec<MergedPr>,
    /// When the page cap cut the read short: the host's page cursor to go on from, and the oldest update read.
    pub rest: Option<(String, i64)>,
}

/// A commit on the default branch.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LandedCommit {
    pub sha: String,
    pub at_ms: i64,
    pub title: String,
    /// Its first parent, to walk the default branch's own line.
    pub first_parent: Option<String>,
    /// The merged PRs that brought it in, when the host lists them with the commit; `None` asks `prs_of_commit`.
    pub prs: Option<Vec<i64>>,
    /// Pushed under a bot's identity (`…[bot]`).
    pub bot: bool,
}

/// One git host's reads. Errors are plain words a person can act on ("GitHub isn't signed in …").
pub trait GitHostSource: Send + Sync {
    /// The account the hub reads the host as, which is the person's own: their reviews and merges are made by it.
    fn signed_in(&self) -> BoxFut<'_, Result<Option<String>, String>>;

    fn repo_info<'a>(&'a self, repo: &'a RepoRef) -> BoxFut<'a, Result<RepoInfo, String>>;

    /// PRs merged into any base whose last update was at or after `since_ms`, newest update first, paged until
    /// past it or until the host's page cap; `after` goes on from where a read the cap cut short stopped.
    fn merged_since<'a>(
        &'a self,
        repo: &'a RepoRef,
        since_ms: i64,
        after: Option<&'a str>,
    ) -> BoxFut<'a, Result<MergedRead, String>>;

    /// The commits reachable from `branch`, newest first: back to `stop_at` (the last read's head) when given,
    /// whatever their dates, else those made at or after `since_ms`.
    fn default_commits<'a>(
        &'a self,
        repo: &'a RepoRef,
        branch: &'a str,
        since_ms: i64,
        stop_at: Option<&'a str>,
    ) -> BoxFut<'a, Result<Vec<LandedCommit>, String>>;

    /// The merged PRs a commit on the default branch belongs to, for a host that doesn't list them with the commit.
    fn prs_of_commit<'a>(
        &'a self,
        repo: &'a RepoRef,
        sha: &'a str,
    ) -> BoxFut<'a, Result<Vec<i64>, String>>;

    /// Reviews and comments, for the person's touches.
    fn acts(&self) -> &dyn HostActs;
}

/// The git host readers the sweep uses, one per host it can read. The shipped hub reads through the hosts' real
/// CLIs; a test or lab hub reads none (or fakes), so it never reaches the network.
#[derive(Clone, Default)]
pub struct HostSources {
    pub github: Option<Arc<dyn GitHostSource>>,
}

impl HostSources {
    /// GitHub through the hub's `gh`.
    pub fn real() -> Self {
        Self {
            github: Some(Arc::new(github::GitHubSource::new(Arc::new(
                crate::hub::train::github::SystemGh,
            )))),
        }
    }

    pub fn none() -> Self {
        Self::default()
    }

    /// The source for a host as `metric_repos.host` names it.
    pub fn get(&self, host: &str) -> Option<Arc<dyn GitHostSource>> {
        match host {
            "github" => self.github.clone(),
            _ => None,
        }
    }
}

/// Whether fleetd reads a host, as `metric_repos.host` names it, through its API; a repo on any other is read from
/// git alone (`no_host.rs`), whichever sources a hub was built with.
pub fn has_api(host: &str) -> bool {
    host == "github"
}

/// Whether fleetd itself posted a review or comment with this body: it posts under the person's own login, so its
/// acts are told apart by their markers: a hidden `<!-- fleetd:… -->` line (the train's), a `Fleetd-Task:` trailer, or
/// the wording of the train's comments from before it marked them.
pub fn fleetd_posted(body: &str) -> bool {
    body.contains("<!-- fleetd:")
        || body.contains("by the fleetd merge train")
        || body
            .lines()
            .any(|l| l.trim_start().starts_with("Fleetd-Task:"))
}

/// The host part of a remote key ("github.com/acme/web" → "github"), as `metric_repos.host` stores it: "git" for a
/// host fleetd has no name for.
pub fn host_of(remote: &str) -> &'static str {
    match remote.split('/').next().unwrap_or_default() {
        "github.com" => "github",
        "gitlab.com" => "gitlab",
        "bitbucket.org" => "bitbucket",
        "dev.azure.com" | "ssh.dev.azure.com" => "azure_devops",
        "codeberg.org" => "gitea",
        _ => "git",
    }
}

/// A checkout's origin URL as the metrics' key: host first, lowercased, no scheme, user or `.git`.
pub fn remote_key(url: &str) -> Option<String> {
    let key = fleetd_contracts::projects::short_remote(url).to_lowercase();
    fleetd_contracts::metrics::RemoteRepo::new(&key)
        .ok()
        .map(|_| key)
}
