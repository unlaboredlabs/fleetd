//! GitHub through `gh api` on the hub's machine, under the hub's login: one GraphQL query per page of 100 merged PRs
//! (author and merger account types, lines, the batch line), of 100 default-branch commits (each with the merged PRs
//! that brought it in, so a direct push needs no call of its own) and of 50 recently updated PRs' reviews and
//! comments. Pages stop once past the cursor, and at a bound so a first read of a busy repo can't run away.
use std::sync::Arc;

use fleetd_contracts::metrics::ActorKind;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{GitHostSource, LandedCommit, MergedPr, RepoInfo, RepoRef};
use crate::hub::metrics::host_acts::{HostAct, HostActKind, HostActs};
use crate::hub::prs::github::explain;
use crate::hub::store::{iso_ms, parse_ms};
use crate::hub::train::github::{GhRunner, batch_heads};
use crate::hub::usage::ports::BoxFut;

/// Pages of merged PRs read at most per sweep: a 90-day first read of a busy repo stops at 2,000 PRs.
pub const MERGED_PAGES: usize = 20;
/// Pages of default-branch commits read at most per sweep.
pub const COMMIT_PAGES: usize = 20;
/// Pages of recently updated PRs read at most for reviews and comments.
pub const ACT_PAGES: usize = 20;

const MERGED_QUERY: &str = "query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url body createdAt updatedAt mergedAt baseRefName headRefName additions deletions
        headRepository { nameWithOwner defaultBranchRef { name } }
        author { __typename login }
        mergedBy { __typename login }
        mergeCommit { oid }
      }
    }
  }
}";

const COMMITS_QUERY: &str = "query($owner: String!, $name: String!, $branch: String!, $since: GitTimestamp, $after: String) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $branch) {
      target {
        ... on Commit {
          history(first: 100, since: $since, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid committedDate messageHeadline
              parents(first: 1) { nodes { oid } }
              author { name email }
              associatedPullRequests(first: 5) { nodes { number merged } }
            }
          }
        }
      }
    }
  }
}";

const ACTS_QUERY: &str = "query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number headRefName additions deletions updatedAt
        reviews(last: 100) { nodes { databaseId submittedAt author { __typename login } } }
        comments(last: 100) { nodes { databaseId createdAt author { __typename login } } }
      }
    }
  }
}";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page<T> {
    page_info: PageInfo,
    nodes: Vec<Option<T>>,
}

#[derive(Deserialize)]
struct Actor {
    #[serde(rename = "__typename", default)]
    typename: String,
    login: Option<String>,
}

/// GitHub's account type: a `Bot` is an app (dependabot, renovate…); a deleted account answers no actor.
fn kind(actor: Option<&Actor>) -> ActorKind {
    match actor.map(|a| a.typename.as_str()) {
        Some("Bot") => ActorKind::Bot,
        Some("User" | "Organization" | "Mannequin" | "EnterpriseUserAccount") => ActorKind::Human,
        _ => ActorKind::Unknown,
    }
}

#[derive(Deserialize)]
struct Name {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadRepo {
    name_with_owner: String,
    default_branch_ref: Option<Name>,
}

#[derive(Deserialize)]
struct Oid {
    oid: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergedNode {
    number: i64,
    #[serde(default)]
    title: String,
    url: Option<String>,
    body: Option<String>,
    created_at: Option<String>,
    updated_at: String,
    merged_at: Option<String>,
    base_ref_name: String,
    head_ref_name: String,
    additions: Option<i64>,
    deletions: Option<i64>,
    head_repository: Option<HeadRepo>,
    author: Option<Actor>,
    merged_by: Option<Actor>,
    merge_commit: Option<Oid>,
}

#[derive(Deserialize)]
struct PullsRepo<T> {
    #[serde(rename = "pullRequests")]
    pulls: Page<T>,
}

#[derive(Deserialize)]
struct Repository<T> {
    repository: Option<T>,
}

#[derive(Deserialize)]
struct GitAuthor {
    name: Option<String>,
    email: Option<String>,
}

#[derive(Deserialize)]
struct Associated {
    number: i64,
    merged: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitNode {
    oid: String,
    committed_date: String,
    #[serde(default)]
    message_headline: String,
    parents: Nodes<Oid>,
    author: Option<GitAuthor>,
    associated_pull_requests: Option<Nodes<Associated>>,
}

#[derive(Deserialize)]
struct History {
    history: Page<CommitNode>,
}

#[derive(Deserialize)]
struct Target {
    target: Option<History>,
}

#[derive(Deserialize)]
struct RefRepo {
    #[serde(rename = "ref")]
    ref_: Option<Target>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewNode {
    database_id: Option<i64>,
    submitted_at: Option<String>,
    author: Option<Actor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentNode {
    database_id: Option<i64>,
    created_at: String,
    author: Option<Actor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActsNode {
    number: i64,
    head_ref_name: Option<String>,
    additions: Option<i64>,
    deletions: Option<i64>,
    updated_at: String,
    reviews: Option<Nodes<Option<ReviewNode>>>,
    comments: Option<Nodes<Option<CommentNode>>>,
}

#[derive(Deserialize)]
struct RepoJson {
    default_branch: String,
    parent: Option<FullName>,
}

#[derive(Deserialize)]
struct FullName {
    full_name: String,
}

pub struct GitHubSource {
    gh: Arc<dyn GhRunner>,
}

impl GitHubSource {
    pub fn new(gh: Arc<dyn GhRunner>) -> Self {
        Self { gh }
    }

    async fn run(&self, args: Vec<String>) -> Result<Value, String> {
        let out = self.gh.run(args).await.map_err(|spawn| {
            if spawn == "ENOENT" {
                "The GitHub CLI (gh) isn't installed on the machine fleetd runs on.".to_owned()
            } else {
                format!("GitHub couldn't be read: {spawn}")
            }
        })?;
        if out.exit_code != 0 {
            return Err(explain(out.exit_code, &out.stderr));
        }
        serde_json::from_str(&out.stdout)
            .map_err(|_| "GitHub answered in a shape fleetd doesn't read.".to_owned())
    }

    /// One GraphQL query; every variable is a string. GitHub's own errors come back as an error.
    async fn graphql(&self, query: &str, vars: &[(&str, &str)]) -> Result<Value, String> {
        let mut args: Vec<String> = vec!["api".into(), "graphql".into(), "-f".into()];
        args.push(format!("query={query}"));
        for (k, v) in vars {
            args.push("-f".into());
            args.push(format!("{k}={v}"));
        }
        let mut v = self.run(args).await?;
        if let Some(e) = v["errors"].as_array().and_then(|e| e.first()) {
            let message = e["message"].as_str().unwrap_or("no message");
            return Err(format!(
                "GitHub couldn't be read: {}",
                crate::hub::api::clip(message, 200)
            ));
        }
        Ok(v["data"].take())
    }

    /// Pages of `query`'s `repository.<path>` until `stop` says one passed the cursor or `max` pages were read.
    async fn pages<T: DeserializeOwned>(
        &self,
        repo: &RepoRef,
        query: &str,
        extra: &[(&str, &str)],
        max: usize,
        mut take: impl FnMut(Value) -> Result<Page<T>, String>,
        mut keep: impl FnMut(T) -> bool,
    ) -> Result<(), String> {
        let (owner, name) = repo
            .path
            .split_once('/')
            .ok_or_else(|| format!("{} is not owner/name", repo.path))?;
        let mut after: Option<String> = None;
        for _ in 0..max {
            let mut vars = vec![("owner", owner), ("name", name)];
            vars.extend_from_slice(extra);
            if let Some(a) = after.as_deref() {
                vars.push(("after", a));
            }
            let data = self.graphql(query, &vars).await?;
            let page = take(data)?;
            let mut go_on = page.page_info.has_next_page;
            for node in page.nodes.into_iter().flatten() {
                go_on &= keep(node);
            }
            after = page.page_info.end_cursor;
            if !go_on || after.is_none() {
                break;
            }
        }
        Ok(())
    }
}

fn decode<T: DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v)
        .map_err(|_| "GitHub answered in a shape fleetd doesn't read.".to_owned())
}

/// The page under `repository.pullRequests`.
fn pulls_page<T: DeserializeOwned>(data: Value) -> Result<Page<T>, String> {
    let repo: Repository<PullsRepo<T>> = decode(data)?;
    let repo = repo
        .repository
        .ok_or("GitHub doesn't know this repository, or the signed-in account can't see it.")?;
    Ok(repo.pulls)
}

fn merged_pr(n: MergedNode) -> Option<MergedPr> {
    let merged_ms = n.merged_at.as_deref().and_then(parse_ms)?;
    let head_is_default = n
        .head_repository
        .as_ref()
        .and_then(|r| r.default_branch_ref.as_ref())
        .is_some_and(|d| d.name == n.head_ref_name);
    Some(MergedPr {
        number: n.number,
        title: n.title,
        url: n.url,
        base: n.base_ref_name,
        head: n.head_ref_name,
        head_repo: n.head_repository.map(|r| r.name_with_owner),
        head_is_default,
        author: kind(n.author.as_ref()),
        merged_by: kind(n.merged_by.as_ref()),
        merged_by_login: n.merged_by.as_ref().and_then(|a| a.login.clone()),
        created_ms: n.created_at.as_deref().and_then(parse_ms),
        updated_ms: parse_ms(&n.updated_at).unwrap_or(merged_ms),
        merged_ms,
        merge_sha: n.merge_commit.map(|c| c.oid.to_lowercase()),
        additions: n.additions,
        deletions: n.deletions,
        batch_members: n
            .body
            .as_deref()
            .map(batch_heads)
            .unwrap_or_default()
            .into_iter()
            .map(|(n, _)| n)
            .collect(),
    })
}

/// A git identity GitHub gives its apps: `name[bot]`, `…[bot]@users.noreply.github.com`.
fn bot_identity(a: Option<&GitAuthor>) -> bool {
    a.is_some_and(|a| {
        a.name.as_deref().is_some_and(|n| n.ends_with("[bot]"))
            || a.email.as_deref().is_some_and(|e| e.contains("[bot]@"))
    })
}

impl GitHostSource for GitHubSource {
    fn signed_in(&self) -> BoxFut<'_, Result<Option<String>, String>> {
        Box::pin(async move {
            let v = self.run(vec!["api".into(), "user".into()]).await?;
            Ok(v["login"].as_str().map(str::to_owned))
        })
    }

    fn repo_info<'a>(&'a self, repo: &'a RepoRef) -> BoxFut<'a, Result<RepoInfo, String>> {
        Box::pin(async move {
            let v = self
                .run(vec!["api".into(), format!("repos/{}", repo.path)])
                .await?;
            let r: RepoJson = decode(v)?;
            Ok(RepoInfo {
                default_branch: r.default_branch,
                upstream: r.parent.map(|p| p.full_name),
            })
        })
    }

    fn merged_since<'a>(
        &'a self,
        repo: &'a RepoRef,
        since_ms: i64,
    ) -> BoxFut<'a, Result<Vec<MergedPr>, String>> {
        Box::pin(async move {
            let mut out = Vec::new();
            self.pages(
                repo,
                MERGED_QUERY,
                &[],
                MERGED_PAGES,
                pulls_page::<MergedNode>,
                |n| {
                    let updated = parse_ms(&n.updated_at).unwrap_or(i64::MAX);
                    if updated >= since_ms {
                        out.extend(merged_pr(n));
                    }
                    updated >= since_ms
                },
            )
            .await?;
            Ok(out)
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
            let (branch, since) = (format!("refs/heads/{branch}"), iso_ms(since_ms));
            // Back to the last read's head whatever the commits' dates (one made earlier can be pushed later), else
            // the date window.
            let mut vars = vec![("branch", branch.as_str())];
            if stop_at.is_none() {
                vars.push(("since", since.as_str()));
            }
            let mut out = Vec::new();
            self.pages(
                repo,
                COMMITS_QUERY,
                &vars,
                COMMIT_PAGES,
                |data| {
                    let repo: Repository<RefRepo> = decode(data)?;
                    repo.repository
                        .and_then(|r| r.ref_)
                        .and_then(|r| r.target)
                        .map(|t| t.history)
                        .ok_or_else(|| {
                            "GitHub has no such default branch on this repository.".to_owned()
                        })
                },
                |c: CommitNode| {
                    let go_on = stop_at.is_none_or(|s| !c.oid.eq_ignore_ascii_case(s));
                    out.push(LandedCommit {
                        at_ms: parse_ms(&c.committed_date).unwrap_or(0),
                        title: c.message_headline,
                        first_parent: c
                            .parents
                            .nodes
                            .into_iter()
                            .next()
                            .map(|p| p.oid.to_lowercase()),
                        prs: Some(
                            c.associated_pull_requests
                                .map(|a| a.nodes)
                                .unwrap_or_default()
                                .into_iter()
                                .filter(|p| p.merged)
                                .map(|p| p.number)
                                .collect(),
                        ),
                        bot: bot_identity(c.author.as_ref()),
                        sha: c.oid.to_lowercase(),
                    });
                    go_on
                },
            )
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
            let v = self
                .run(vec![
                    "api".into(),
                    format!("repos/{}/commits/{sha}/pulls", repo.path),
                ])
                .await?;
            Ok(v.as_array()
                .map(|a| {
                    a.iter()
                        .filter(|p| p["merged_at"].is_string())
                        .filter_map(|p| p["number"].as_i64())
                        .collect()
                })
                .unwrap_or_default())
        })
    }

    fn acts(&self) -> &dyn HostActs {
        self
    }
}

impl HostActs for GitHubSource {
    fn acts_since<'a>(
        &'a self,
        repo: &'a str,
        since_ms: i64,
    ) -> BoxFut<'a, Result<Vec<HostAct>, String>> {
        Box::pin(async move {
            let path = repo
                .strip_prefix("github.com/")
                .ok_or_else(|| format!("{repo} is not on GitHub"))?;
            let repo = RepoRef {
                remote: repo.to_owned(),
                path: path.to_owned(),
            };
            let mut out = Vec::new();
            self.pages(
                &repo,
                ACTS_QUERY,
                &[],
                ACT_PAGES,
                pulls_page::<ActsNode>,
                |n: ActsNode| {
                    let updated = parse_ms(&n.updated_at).unwrap_or(i64::MAX);
                    let lines = n.additions.zip(n.deletions).map(|(a, d)| a + d);
                    let act = |what, id: Option<i64>, at: Option<&str>, actor: Option<&Actor>| {
                        let at_ms = at.and_then(parse_ms).filter(|at| *at >= since_ms)?;
                        Some(HostAct {
                            kind: what,
                            id: id?.to_string(),
                            pr_number: n.number,
                            at_ms,
                            login: actor.and_then(|a| a.login.clone()),
                            bot: kind(actor) == ActorKind::Bot,
                            head: n.head_ref_name.clone(),
                            lines,
                        })
                    };
                    // A pending review has no submit time yet: it is not an act.
                    for r in n.reviews.iter().flat_map(|r| &r.nodes).flatten() {
                        out.extend(act(
                            HostActKind::Review,
                            r.database_id,
                            r.submitted_at.as_deref(),
                            r.author.as_ref(),
                        ));
                    }
                    for c in n.comments.iter().flat_map(|c| &c.nodes).flatten() {
                        out.extend(act(
                            HostActKind::Comment,
                            c.database_id,
                            Some(c.created_at.as_str()),
                            c.author.as_ref(),
                        ));
                    }
                    updated >= since_ms
                },
            )
            .await?;
            Ok(out)
        })
    }
}
