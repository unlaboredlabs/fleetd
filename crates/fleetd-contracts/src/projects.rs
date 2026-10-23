//! Adding a project: what `project_discover`, `project_inspect` and `project_add` return, and the data of the
//! `project.clone_progress`, `project.added` and `project.add_failed` events.
//!
//! The hub owns the flow; the node on the target machine does the filesystem and git work (scan, clone, local
//! inspect), and `gh` runs where it is logged in: the hub machine first, else the target worker.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::{MachineId, ProjectId};
use crate::prim::{Int, Text};
use crate::train::GitHubRepo;

/// Minted by the hub for one clone; carried by its progress, added and failed events.
pub type AddId = Text<1, 64>;

/// A git checkout found on a machine (under ~/src, ~/code, ~/projects, ~/dev and similar, at most two levels down).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FoundRepo {
    /// Absolute.
    pub path: String,
    /// The directory's name.
    pub name: String,
    /// The origin remote, shortened: "github.com/acme/storefront".
    pub remote: Option<String>,
    /// When the remote is on GitHub.
    pub repo: Option<GitHubRepo>,
    /// Set when the checkout is already a project.
    pub project_id: Option<ProjectId>,
}

/// One machine's part of `project_discover`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MachineRepos {
    pub machine_id: MachineId,
    pub online: bool,
    /// Where a clone onto this machine goes by default: the first of ~/src, ~/code, ~/projects that exists, else
    /// ~/src. Absolute.
    pub clone_root: Option<String>,
    pub repos: Vec<FoundRepo>,
    /// Why this machine could not be scanned (offline, an older node), with its fix.
    pub problem: Option<ProjectProblem>,
}

/// A repository `gh repo list` returned, for the user or one of their orgs.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitHubCandidate {
    pub repo: GitHubRepo,
    pub url: String,
    pub private: bool,
    pub description: Option<Text<0, 300>>,
    pub pushed_at: Option<String>,
    /// Machines that already have a checkout of it.
    pub checkouts: Vec<Checkout>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Checkout {
    pub machine_id: MachineId,
    pub path: String,
    pub project_id: Option<ProjectId>,
}

/// The `gh repo list` part of `project_discover`.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepos {
    /// Where gh ran: "hub" (the hub machine) or a machine id. Absent when gh is logged in nowhere.
    pub gh_on: Option<String>,
    /// The login and the orgs listed, in order.
    pub owners: Vec<String>,
    pub repos: Vec<GitHubCandidate>,
    pub problem: Option<ProjectProblem>,
}

/// Why something could not be done, and the one step that fixes it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProblem {
    pub code: ProjectProblemCode,
    pub message: String,
    pub fix: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectProblemCode {
    /// The machine's node is not connected.
    MachineOffline,
    /// No connected machine runs agents.
    NoWorker,
    /// gh is missing or logged out where it ran.
    GhUnavailable,
    /// gh is logged in but cannot see the repository (private, renamed, or a typo).
    GhNoAccess,
    /// The path does not exist on the machine.
    PathMissing,
    /// The path exists but is not a git checkout.
    NotAGitRepo,
    /// The clone destination exists. `CloneTarget.sameRemote` says whether it is already this repository.
    DestExists,
    /// git clone failed; the message is git's own last line.
    CloneFailed,
    /// The machine's node is older than this hub and cannot do this.
    NodeTooOld,
    Other,
}

/// Where a clone would go on a machine, and what is there now.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloneTarget {
    pub machine_id: MachineId,
    /// Absolute.
    pub path: String,
    pub exists: bool,
    /// The existing directory is a checkout of the same repository: `project_add` with `useExisting` adds it.
    pub same_remote: bool,
    /// The existing directory is already this project.
    pub project_id: Option<ProjectId>,
}

/// CI the repository runs.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CiInfo {
    /// Active GitHub Actions workflows by name (from `.github/workflows` on a checkout without GitHub access).
    pub workflows: Vec<String>,
    /// Status checks the default branch requires, from branch protection and rulesets.
    pub required_checks: Vec<String>,
}

/// How the default branch may be merged into.
#[skip_serializing_none]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MergeRules {
    /// Branch protection or an active ruleset applies to the default branch.
    pub protected: bool,
    /// Active rulesets that apply to the default branch, by name.
    pub rulesets: Vec<String>,
    /// Absent when gh could not read the repository settings.
    pub squash_allowed: Option<bool>,
    /// Approving reviews a pull request needs.
    pub required_reviews: Option<Int<0, 10>>,
    /// Pull requests must be up to date with the base before merging.
    pub strict: Option<bool>,
}

/// What `project_inspect` found: the default branch, CI and merge rules, and one line on what the lead will need.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInspect {
    /// Absent for a checkout without a GitHub remote.
    pub repo: Option<GitHubRepo>,
    pub default_branch: Option<String>,
    pub ci: CiInfo,
    pub merge: MergeRules,
    /// One line for a person, e.g. "no CI found: the merge train holds its PRs until the repo has CI".
    pub lead_needs: Text<1, 300>,
    /// What could not be read, e.g. "branch rules need admin access on acme/storefront".
    pub notes: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClonePhase {
    /// Before git reports anything.
    Starting,
    /// "Receiving objects".
    Receiving,
    /// "Resolving deltas".
    Resolving,
    /// "Updating files".
    CheckingOut,
    /// The clone finished; the hub reads the default branch, CI and merge rules.
    Inspecting,
}

/// `HubEvent.data` on `project.clone_progress`: on each phase change and its 100 %, else every 5 percent at most once
/// a second.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgressData {
    pub add_id: AddId,
    pub repo: Option<GitHubRepo>,
    /// Absolute, on the event's machine.
    pub path: String,
    pub phase: ClonePhase,
    /// Of this phase.
    pub percent: Option<Int<0, 100>>,
    /// As git prints it, e.g. "12.40 MiB | 3.10 MiB/s".
    pub detail: Option<Text<0, 120>>,
}

/// `HubEvent.data` on `project.added`, for every add (a path or a clone).
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAddedData {
    /// Absent when the add registered an existing directory.
    pub add_id: Option<AddId>,
    pub title: String,
    pub path: String,
    /// False when the directory was already a project.
    pub created: bool,
    /// Long lists are cut so the event fits the log's 2 KB of data; `project_inspect` returns them whole.
    pub inspect: ProjectInspect,
}

/// `HubEvent.data` on `project.add_failed`: a clone that was accepted, then failed.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAddFailedData {
    pub add_id: AddId,
    pub repo: Option<GitHubRepo>,
    pub path: String,
    #[serde(flatten)]
    pub problem: ProjectProblem,
}

/// `git@github.com:o/r.git`, `https://github.com/o/r` → `github.com/o/r`; other URLs unchanged.
pub fn short_remote(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);
    if let Some(rest) = url.strip_prefix("git@")
        && let Some((host, path)) = rest.split_once(':')
    {
        return format!("{host}/{path}");
    }
    for scheme in ["https://", "http://", "ssh://git@", "ssh://", "git://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            return rest.rsplit_once('@').map_or(rest, |(_, r)| r).to_owned();
        }
    }
    url.to_owned()
}

/// The GitHub repository in what a person pastes or drops: a URL (a `/tree/main` or `/pull/3` tail is ignored),
/// `github.com/o/r`, `git@github.com:o/r.git` or `o/r`.
pub fn github_repo(text: &str) -> Option<GitHubRepo> {
    let text = text.trim();
    let short = short_remote(text);
    let path = short
        .strip_prefix("github.com/")
        .or_else(|| short.strip_prefix("www.github.com/"))
        .map(|p| p.splitn(3, '/').take(2).collect::<Vec<_>>().join("/"))
        .or_else(|| {
            (!text.contains(':') && !text.contains('.') && !text.starts_with('/'))
                .then(|| short.clone())
        })?;
    let path = path.strip_suffix(".git").unwrap_or(&path);
    GitHubRepo::new(path).ok()
}

/// What `fleetd project add` and a drop onto the app were given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AddSource {
    /// A directory: absolute, `~/…`, or relative (resolve it against the caller's cwd on the caller's machine).
    Path(String),
    GitHub(GitHubRepo),
}

/// A path when it looks like one (`/`, `~`, `.`), else a GitHub repository, else neither.
pub fn add_source(text: &str) -> Option<AddSource> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if text.starts_with(['/', '~', '.']) {
        return Some(AddSource::Path(text.to_owned()));
    }
    github_repo(text).map(AddSource::GitHub)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_people_paste_for_a_repo() {
        for text in [
            "https://github.com/acme/storefront",
            "https://github.com/acme/storefront.git",
            "https://github.com/acme/storefront/tree/main/src",
            "git@github.com:acme/storefront.git",
            "github.com/acme/storefront",
            "acme/storefront",
            " acme/storefront\n",
        ] {
            assert_eq!(
                github_repo(text).map(|r| r.to_string()),
                Some("acme/storefront".into()),
                "{text}"
            );
        }
        for text in [
            "https://gitlab.com/acme/storefront",
            "storefront",
            "/home/me/src/storefront",
            "a/b/c",
        ] {
            assert_eq!(github_repo(text), None, "{text}");
        }
    }

    #[test]
    fn tells_a_path_from_a_url() {
        assert_eq!(
            add_source("~/src/storefront"),
            Some(AddSource::Path("~/src/storefront".into()))
        );
        assert_eq!(
            add_source("./storefront"),
            Some(AddSource::Path("./storefront".into()))
        );
        assert_eq!(
            add_source("/srv/storefront"),
            Some(AddSource::Path("/srv/storefront".into()))
        );
        assert!(matches!(
            add_source("https://github.com/acme/storefront"),
            Some(AddSource::GitHub(_))
        ));
        assert_eq!(add_source("storefront"), None);
    }
}
