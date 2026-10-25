//! The landing scanner: every commit that reaches a watched base is recorded, however it got there (the merge
//! train, a PR merged by hand or by another tool, or a direct push), with plain git on the project's machine, so it
//! works on any host.
//!
//! Every `SCAN_EVERY_MS` it reads each project's repo and base from its root (`bind`), then, once per (repo, base),
//! `git ls-remote origin refs/heads/<base>`. When the base moved: fetch it, list its new first-parent commits and
//! read each one. Its route: a Change's merge commit is the train's; a message that names a PR (each host's default
//! merge message) is a PR merged outside the train; anything else is a direct push. On GitHub, its merged PRs add the
//! PR and head branch of a squash merge, and of each commit of a rebase merge. Each landing ends the active claims it
//! matches exactly (branch, PR, a closing reference to its issue), and a direct push ends its own author's claim when
//! it strongly matches the claim's title; it then wakes every lead on the scope, for outside routes only. While a
//! node is offline its watch waits: nothing is guessed, and the next scan catches up. When git there can't reach the
//! remote, the project's lead is told once.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::ids::{MachineId, ProjectRef, Timestamp};
use fleetd_contracts::plan::PlanItemId;
use fleetd_contracts::prim::{Line, List, Positive};
use fleetd_contracts::projects::short_remote;
use fleetd_contracts::tasks::PrUrl;
use fleetd_contracts::tasks::TaskId;
use fleetd_contracts::train::ChangeId;
use fleetd_contracts::train::{Change, ChangeState};
use fleetd_contracts::verification::CommitSha;
use fleetd_contracts::work::{
    BranchName, Claim, ClaimId, LandingRoute, RepoKey, WorkKey, WorkLandedData, WorkPath, WorkScope,
};
use serde::{Deserialize, Serialize};

use super::bind::{GitOut, NodeGit, bind_with, git};
use super::elsewhere::{Landed, Landings};
use super::{BoxFut, Ending, store};
use crate::hub::api::Hub;
use crate::hub::executor::shell_mapper::js_take;
use crate::hub::leads::wakes::Trigger;
use crate::hub::store::{HubDb, StoreError, iso_ms, now_ms};
use crate::hub::train::github::MergedPull;
use crate::hub::train::records::{ChangeRecords, ListFilter};

pub const SCAN_EVERY_MS: u64 = 60_000;
/// The most paths a landing keeps.
pub const LANDING_PATHS_MAX: usize = 200;

/// One commit on the first-parent line of a watched base, whoever made it and however it got there: a `landings`
/// row. Others read it through `elsewhere::Landings` and the `work.landed` event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Landing {
    pub repo_key: RepoKey,
    pub base: BranchName,
    pub sha: CommitSha,
    /// The commit's committer time.
    pub at: Timestamp,
    /// When the scanner saw it.
    pub seen_at: Timestamp,
    pub route: LandingRoute,
    /// The PR or merge request it came from, when the merge message or the host names one.
    pub pr_number: Option<Positive>,
    /// Built from the repo key on hosts whose PR URLs fleetd knows (GitHub, GitLab, Bitbucket).
    pub pr_url: Option<PrUrl>,
    /// The branch it came from, when the merge message or the host names one.
    pub head_branch: Option<BranchName>,
    pub subject: Line<0, 300>,
    pub author_email: Option<Line<1, 200>>,
    /// What it changed against its first parent; the first `LANDING_PATHS_MAX`, and only what the node's output kept.
    pub paths: List<WorkPath, 0, LANDING_PATHS_MAX>,
    /// The Change it is, or merged.
    pub change_id: Option<ChangeId>,
    /// The write task whose work it is: its Change's, or the one whose branch it came from.
    pub task_id: Option<TaskId>,
    /// The claims it ended.
    pub claim_ids: Vec<ClaimId>,
    /// The plan item of its task.
    pub item_ids: Vec<PlanItemId>,
}

impl Landing {
    /// What `work.landed` says of it.
    pub fn event(&self) -> WorkLandedData {
        WorkLandedData {
            repo_key: self.repo_key.clone(),
            base: self.base.clone(),
            sha: self.sha.clone(),
            route: self.route,
            pr_number: self.pr_number,
            head_branch: self.head_branch.clone(),
            subject: self.subject.clone(),
            claim_ids: self.claim_ids.clone(),
            change_id: self.change_id.clone(),
            task_id: self.task_id.clone(),
            item_ids: self.item_ids.clone(),
        }
    }
}
/// Commits read per watched base per scan; a base further behind catches up over the next scans.
const SCAN_MAX: usize = 200;
/// What a node's command output keeps: its last this many characters.
const OUTPUT_TAIL_MAX: usize = 2000;
/// How far back GitHub's merged PRs are read for a commit's PR and branch.
const MERGED_LOOKBACK_MS: i64 = 24 * 3_600_000;
/// Merged Changes searched for a commit's sha.
const MERGED_CHANGES: i64 = 200;
/// A commit not yet known as the train's waits while a Change on the repo has been merging for less than this; a
/// Change stuck merging longer never holds the scan back.
const MERGING_GRACE_MS: i64 = 10 * 60_000;

/// What the scanner asks beyond git: GitHub's merged PRs, for the PR and head branch of a squash or rebase merge.
pub trait LandingPorts: NodeGit {
    /// The GitHub repo's (`owner/name`) recently merged PRs; `None` when they could not be read.
    fn merged_pulls<'a>(&'a self, repo: &'a str) -> BoxFut<'a, Option<Vec<MergedPull>>>;
    /// The merged PRs the commit came from; `None` when they could not be read.
    fn merged_pulls_of<'a>(
        &'a self,
        repo: &'a str,
        sha: &'a str,
    ) -> BoxFut<'a, Option<Vec<MergedPull>>>;
}

/// The hub's own: git over the node link, GitHub through the train's client.
pub struct HubLandingPorts(pub Arc<Hub>);

impl NodeGit for HubLandingPorts {
    fn git<'a>(
        &'a self,
        machine: &'a MachineId,
        cwd: &'a str,
        args: Vec<String>,
    ) -> BoxFut<'a, Option<GitOut>> {
        self.0.node_commands.git(machine, cwd, args)
    }
}

impl LandingPorts for HubLandingPorts {
    fn merged_pulls<'a>(&'a self, repo: &'a str) -> BoxFut<'a, Option<Vec<MergedPull>>> {
        Box::pin(async move {
            let since = now_ms(self.0.clock.as_ref()) - MERGED_LOOKBACK_MS;
            match self.0.train.github().merged_pulls(repo, since).await {
                Ok(pulls) => Some(pulls),
                Err(e) => {
                    tracing::warn!(repo, error = %e.message, "landings: merged PRs not read");
                    None
                }
            }
        })
    }

    fn merged_pulls_of<'a>(
        &'a self,
        repo: &'a str,
        sha: &'a str,
    ) -> BoxFut<'a, Option<Vec<MergedPull>>> {
        Box::pin(async move {
            match self.0.train.github().merged_pulls_of(repo, sha).await {
                Ok(pulls) => Some(pulls),
                Err(e) => {
                    tracing::warn!(repo, sha, error = %e.message, "landings: a commit's PRs not read");
                    None
                }
            }
        })
    }
}

/// The landings table, as the digest and `plan covered` read it.
pub struct LandingStore(pub Arc<HubDb>);

fn landed(landing: Landing) -> Landed {
    let pr = landing
        .pr_url
        .as_ref()
        .map(|u| u.to_string())
        .or_else(|| landing.pr_number.map(|n| format!("#{}", n.get())));
    let mut covers: Vec<String> = landing.item_ids.iter().map(|i| i.to_string()).collect();
    covers.extend(landing.task_id.iter().map(|t| t.to_string()));
    covers.extend(landing.claim_ids.iter().map(|c| c.to_string()));
    Landed {
        at_ms: crate::hub::store::parse_ms(landing.at.as_str()).unwrap_or(0),
        sha: landing.sha,
        route: landing.route,
        pr,
        subject: landing.subject.to_string(),
        author_email: landing.author_email.map(|e| e.to_string()),
        covers,
    }
}

impl Landings for LandingStore {
    fn outside(
        &self,
        scope: &WorkScope,
        since_ms: i64,
        limit: usize,
    ) -> Result<Vec<Landed>, StoreError> {
        let rows = self
            .0
            .with(|c| Ok(store::landings_since(c, scope, since_ms, limit, true)?))?;
        Ok(rows.into_iter().map(landed).collect())
    }

    fn find(&self, scope: &WorkScope, sha: &str) -> Result<Option<Landed>, StoreError> {
        let found = self
            .0
            .with(|c| Ok(store::landing_by_prefix(c, scope, sha)?))?;
        Ok(found.map(landed))
    }
}

/// Scans every `SCAN_EVERY_MS` until the hub shuts down.
pub async fn run(hub: Arc<Hub>, ports: Arc<dyn LandingPorts>) {
    loop {
        tokio::select! {
            _ = hub.shutdown.wait() => return,
            _ = hub.clock.sleep(Duration::from_millis(SCAN_EVERY_MS)) => {}
        }
        scan(&hub, ports.as_ref()).await;
    }
}

/// One scan: binds every project from its root, then reads each watched base once, through the first of its
/// projects whose node answers.
pub async fn scan(hub: &Hub, ports: &dyn LandingPorts) {
    let projects = match hub.store.projects_list(None, None) {
        Ok(projects) => projects,
        Err(error) => return tracing::warn!(%error, "landings: projects not read"),
    };
    let mut scopes: Vec<(WorkScope, Vec<(ProjectRef, String)>)> = Vec::new();
    for p in projects {
        let project = ProjectRef {
            machine_id: p.machine_id,
            project_id: p.project_id,
        };
        let scope = match bind_with(hub, ports, &project, &p.workspace_root).await {
            Ok(Some(scope)) => scope,
            Ok(None) => continue,
            Err(error) => {
                tracing::warn!(%error, "landings: the project's repo and base were not recorded");
                continue;
            }
        };
        let root = (project, p.workspace_root);
        match scopes.iter_mut().find(|(s, _)| *s == scope) {
            Some((_, roots)) => roots.push(root),
            None => scopes.push((scope, vec![root])),
        }
    }
    for (scope, roots) in scopes {
        for (project, root) in roots {
            let scanner = Scanner {
                hub,
                ports,
                scope: &scope,
                project: &project,
                root: &root,
            };
            match scanner.scan().await {
                Ok(true) => break,
                Ok(false) => continue,
                Err(error) => {
                    tracing::warn!(%error, repo = %scope.repo_key, base = %scope.base, "landings: scan failed");
                    break;
                }
            }
        }
    }
}

struct Scanner<'a> {
    hub: &'a Hub,
    ports: &'a dyn LandingPorts,
    scope: &'a WorkScope,
    project: &'a ProjectRef,
    root: &'a str,
}

/// What one scan of a base read once and reuses for each commit.
#[derive(Default)]
struct Context {
    projects: Vec<ProjectRef>,
    /// The scope's GitHub repo (`owner/name`), when it is on GitHub: where the train's Changes are.
    github: Option<String>,
    merged: Vec<Change>,
    /// The train has been merging a Change on the repo for under `MERGING_GRACE_MS`: a commit the train may not have
    /// recorded yet waits.
    merging: bool,
    pulls: Option<Vec<MergedPull>>,
}

impl Scanner<'_> {
    async fn git(&self, args: &[&str]) -> Option<GitOut> {
        git(self.ports, &self.project.machine_id, self.root, args).await
    }

    /// False when the node didn't answer (another project's root may).
    async fn scan(&self) -> Result<bool, StoreError> {
        let base_ref = format!("refs/heads/{}", self.scope.base);
        let Some(remote) = self.git(&["ls-remote", "origin", &base_ref]).await else {
            return Ok(false);
        };
        if !remote.ok() {
            self.unreachable(&remote);
            return Ok(false);
        }
        let Some(head) = ls_remote_sha(&remote.out, &base_ref) else {
            return Ok(true);
        };
        let work = &self.hub.work;
        let Some(watch) = work.watch(self.scope)? else {
            // The watch starts now: nothing older is reported.
            work.watch_at(self.scope, &head)?;
            return Ok(true);
        };
        if watch.last_sha == head {
            work.scan_ok(self.project);
            return Ok(true);
        }
        let refspec = format!("+{base_ref}:refs/remotes/origin/{}", self.scope.base);
        let Some(fetched) = self
            .git(&["fetch", "--no-tags", "--quiet", "origin", &refspec])
            .await
        else {
            return Ok(false);
        };
        if !fetched.ok() {
            self.unreachable(&fetched);
            return Ok(false);
        }
        work.scan_ok(self.project);
        let mut cx = self.context()?;
        let mut last = watch.last_sha;
        let mut read = 0;
        while read < SCAN_MAX {
            let Some((shas, rewritten)) = self.new_commits(&last, &head, watch.since_ms).await?
            else {
                return Ok(false);
            };
            if shas.is_empty() {
                work.watch_at(self.scope, &head)?;
                break;
            }
            for sha in shas {
                let Some(read_one) = self.read(&sha, &mut cx).await else {
                    return Ok(false);
                };
                if cx.merging && read_one.landing.route != LandingRoute::Train {
                    // Likely the train's own merge, not recorded yet: the next scan reads it again.
                    return Ok(true);
                }
                // After a force push, a commit rewritten from one already recorded is not new work.
                let seen = rewritten
                    && self.hub.db.with(|c| {
                        Ok(store::rewrite_of(
                            c,
                            self.scope,
                            &read_one.rewrite_key,
                            read_one.landing.pr_number.map(|n| n.get()),
                        )?)
                    })?;
                if seen {
                    work.watch_at(self.scope, &sha)?;
                } else {
                    self.land(read_one, &cx)?;
                }
                last = sha;
                read += 1;
            }
        }
        Ok(true)
    }

    /// Git on this project's machine can't reach the remote: its lead is told once, with why, as #407 words it.
    fn unreachable(&self, out: &GitOut) {
        let why = crate::node::worktree::FetchError::of_text(&out.out).to_string();
        tracing::warn!(repo = %self.scope.repo_key, project = %self.project.project_id, %why, "landings: the base was not read");
        if !self.hub.work.scan_failed(self.project, &why) {
            return;
        }
        let line = format!(
            "fleetd can't see what lands on {} of {}: git on {} can't reach origin from {} (fetch failed: {why}). Merges \
             and pushes made outside fleetd stay unseen until it can (an SSH key in ssh-agent, or a credential helper).",
            self.scope.base, self.scope.repo_key, self.project.machine_id, self.root
        );
        self.hub
            .leads
            .wakes
            .trigger(self.project, Trigger::train(&line));
    }

    fn context(&self) -> Result<Context, StoreError> {
        let projects = self
            .hub
            .db
            .with(|c| Ok(store::projects_in(c, self.scope)?))?;
        let github = self
            .scope
            .repo_key
            .as_str()
            .strip_prefix("github.com/")
            .map(str::to_owned);
        let Some(repo) = &github else {
            return Ok(Context {
                projects,
                ..Default::default()
            });
        };
        let records = ChangeRecords::new(self.hub.db.clone());
        Ok(Context {
            projects,
            merged: records.list(&ListFilter {
                repo: Some(repo.clone()),
                state: Some(ChangeState::Merged),
                limit: MERGED_CHANGES,
                ..Default::default()
            }),
            merging: records
                .in_train(repo, &[ChangeState::Merging])
                .iter()
                .any(|c| {
                    crate::hub::store::parse_ms(c.updated_at.as_str())
                        .is_some_and(|at| now_ms(self.hub.clock.as_ref()) - at < MERGING_GRACE_MS)
                }),
            github,
            pulls: None,
        })
    }

    /// The base's first-parent commits after `last` that aren't recorded yet, oldest first, as many as the node's
    /// output kept, and whether the base was rewritten. When `last` is no longer on the base (a force push), the new
    /// line's commits since it left the old one, never older than the watch. `None` when the node didn't answer.
    async fn new_commits(
        &self,
        last: &str,
        head: &str,
        since_ms: i64,
    ) -> Result<Option<(Vec<String>, bool)>, StoreError> {
        let Some(ancestor) = self.git(&["merge-base", "--is-ancestor", last, head]).await else {
            return Ok(None);
        };
        let since = format!("--since={}", since_ms / 1000);
        let range = if ancestor.ok() {
            format!("{last}..{head}")
        } else {
            // Rewritten: the new line from where it left the old one, if git still has the old one; and never older
            // than the watch.
            let fork = self.git(&["merge-base", last, head]).await;
            match fork.filter(GitOut::ok).map(|f| f.out.trim().to_owned()) {
                Some(fork) if fork.len() == head.len() => format!("{fork}..{head}"),
                _ => head.to_owned(),
            }
        };
        let mut args = vec!["rev-list", "--first-parent", range.as_str()];
        if !ancestor.ok() {
            args.push(&since);
        }
        let Some(listed) = self.git(&args).await else {
            return Ok(None);
        };
        if !listed.ok() {
            return Ok(Some((Vec::new(), false)));
        }
        // Newest first, so the tail the node kept is the oldest; a cut first line is shorter than a sha.
        let mut shas: Vec<String> = listed
            .out
            .lines()
            .map(str::trim)
            .filter(|l| l.len() == head.len() && l.bytes().all(|b| b.is_ascii_hexdigit()))
            .map(str::to_owned)
            .collect();
        shas.reverse();
        let mut out = Vec::new();
        for sha in shas {
            let known = self
                .hub
                .db
                .with(|c| Ok(store::has_landing(c, self.scope, &sha)?))?;
            if !known {
                out.push(sha);
            }
        }
        Ok(Some((out, !ancestor.ok())))
    }

    /// The landing `sha` is, with its route and links; `None` when the node didn't answer.
    async fn read(&self, sha: &str, cx: &mut Context) -> Option<Read> {
        // The body first: when the node keeps only the tail, the fields after it are whole.
        let header = self.git(&["show", "-s", COMMIT_FORMAT, sha]).await?;
        let commit = Commit::parse(&header.out)?;
        let paths = match commit.parents.first() {
            Some(parent) => {
                let diff = self
                    .git(&["diff", "--name-only", "--no-renames", parent, sha])
                    .await?;
                if diff.ok() {
                    cut_lines(&diff.out)
                } else {
                    Vec::new()
                }
            }
            None => Vec::new(),
        };
        let mut origin = origin_of(&commit.subject, &commit.body);
        let change = cx
            .merged
            .iter()
            .find(|c| {
                c.merged_sha
                    .as_ref()
                    .is_some_and(|m| m.as_str() == commit.sha)
            })
            .cloned();
        let mut route = match (&change, origin.pr) {
            (Some(_), _) => LandingRoute::Train,
            (None, Some(_)) => LandingRoute::PrOutside,
            (None, None) => LandingRoute::DirectPush,
        };
        let mut change = change;
        if let Some(repo) = cx.github.clone() {
            if origin.head.is_none() || origin.pr.is_none() {
                if cx.pulls.is_none() {
                    cx.pulls = Some(self.ports.merged_pulls(&repo).await.unwrap_or_default());
                }
                let pull = cx.pulls.iter().flatten().find(|p| {
                    origin.pr == Some(p.number as u64)
                        || p.merge_sha.as_deref().map(str::to_lowercase).as_deref()
                            == Some(commit.sha.as_str())
                });
                let mut pull = pull.cloned();
                if pull.is_none() && route == LandingRoute::DirectPush {
                    // A rebase merge's earlier commits: GitHub names only its last one as the merge commit.
                    let base = self.scope.base.as_str();
                    pull = self
                        .ports
                        .merged_pulls_of(&repo, &commit.sha)
                        .await
                        .unwrap_or_default()
                        .into_iter()
                        .find(|p| p.base == base);
                }
                if let Some(pull) = pull {
                    origin.pr = Some(pull.number as u64);
                    origin.head.get_or_insert_with(|| pull.head.clone());
                    origin.host.get_or_insert(GitHost::GitHub);
                    if route == LandingRoute::DirectPush {
                        route = LandingRoute::PrOutside;
                    }
                }
            }
            if change.is_none()
                && let Some(n) = origin.pr
            {
                let records = ChangeRecords::new(self.hub.db.clone());
                change = records.latest_for(&repo, n as i64);
                if change
                    .as_ref()
                    .is_some_and(|c| c.state == ChangeState::Merged)
                {
                    route = LandingRoute::Train;
                }
            }
        }
        let head = origin
            .head
            .clone()
            .or_else(|| change.as_ref().map(|c| c.branch.to_string()));
        let task = match (&change.as_ref().and_then(|c| c.task_id.clone()), &head) {
            (Some(task_id), _) => self
                .hub
                .db
                .with(|c| Ok(crate::hub::tasks::records::TaskRecords::get(c, task_id)?))
                .ok()
                .flatten()
                .map(|s| s.task),
            (None, Some(branch)) => self
                .hub
                .db
                .with(|c| Ok(store::task_on_branch(c, &cx.projects, branch)?))
                .ok()
                .flatten(),
            (None, None) => None,
        };
        let pr_number = origin.pr.and_then(|n| Positive::new(n as i64).ok());
        let landing = Landing {
            repo_key: self.scope.repo_key.clone(),
            base: self.scope.base.clone(),
            sha: CommitSha::unchecked(commit.sha.clone()),
            at: Timestamp(iso_ms(commit.at_secs * 1000)),
            seen_at: Timestamp(iso_ms(now_ms(self.hub.clock.as_ref()))),
            route,
            pr_number,
            pr_url: origin
                .pr
                .and_then(|n| pr_url(&self.scope.repo_key, origin.host, n)),
            head_branch: head.and_then(|h| Line::new(h).ok()),
            subject: Line::unchecked(js_take(&commit.subject, 300)),
            author_email: Line::new(js_take(&commit.email, 200)).ok(),
            paths: List::unchecked(
                paths
                    .iter()
                    .filter_map(|p| WorkPath::new(p.as_str()).ok())
                    .take(LANDING_PATHS_MAX)
                    .collect(),
            ),
            change_id: change.as_ref().map(|c| c.change_id.clone()),
            task_id: task.as_ref().map(|t| t.task_id.clone()),
            claim_ids: Vec::new(),
            item_ids: task.and_then(|t| t.item_id).into_iter().collect(),
        };
        Some(Read {
            landing,
            rewrite_key: commit.rewrite_key(),
            body: commit.body,
        })
    }

    /// Records the landing, ends the claims it matches and wakes the scope's leads for an outside route.
    fn land(&self, read: Read, cx: &Context) -> Result<(), StoreError> {
        let Read {
            mut landing,
            rewrite_key,
            body,
        } = read;
        let body = body.as_str();
        let work = &self.hub.work;
        let mut ending = Vec::new();
        let mut renewing = Vec::new();
        for claim in work.active_claims(self.scope)? {
            match claim_match(&claim, &landing, body) {
                Some(Match::Ends(why)) => ending.push((claim, why)),
                Some(Match::Renews) => renewing.push(claim),
                None => {}
            }
        }
        landing.claim_ids = ending.iter().map(|(c, _)| c.claim_id.clone()).collect();
        if !work.record_landing(&landing, &rewrite_key, self.project)? {
            return Ok(());
        }
        let short = &landing.sha.as_str()[..7];
        for (claim, why) in &ending {
            let reason = format!("{short} landed on {}: {why}", landing.base);
            work.end(
                &claim.claim_id,
                Ending::Landed,
                &reason,
                Some(landing.sha.clone()),
            )?;
        }
        for claim in &renewing {
            work.renew(&claim.claim_id, None)?;
        }
        if landing.route != LandingRoute::Train {
            let line = wake_line(&landing);
            for project in &cx.projects {
                self.hub.leads.wakes.trigger(project, Trigger::train(&line));
            }
        }
        Ok(())
    }
}

/// The lead's line: "abc1234 "feat: dark mode" was pushed straight to main by ada@example.com; it ended claim C7."
pub fn wake_line(landing: &Landing) -> String {
    let short = &landing.sha.as_str()[..7];
    let by = landing
        .author_email
        .as_ref()
        .map(|e| format!(" by {e}"))
        .unwrap_or_default();
    let how = match landing.route {
        LandingRoute::DirectPush => format!("was pushed straight to {}{by}", landing.base),
        _ => {
            let pr = match (&landing.pr_url, landing.pr_number) {
                (Some(url), _) => format!(" from {url}"),
                (None, Some(n)) => format!(" from PR #{}", n.get()),
                (None, None) => String::new(),
            };
            format!(
                "was merged into {}{pr}{by} without the merge train",
                landing.base
            )
        }
    };
    let mut line = format!("{short} \"{}\" {how}", landing.subject);
    if !landing.claim_ids.is_empty() {
        let ids: Vec<&str> = landing.claim_ids.iter().map(|c| c.as_str()).collect();
        line.push_str(&format!("; it ended claim {}", ids.join(", ")));
    }
    if let Some(task) = &landing.task_id {
        let item = landing
            .item_ids
            .first()
            .map(|i| format!(", item {i}"))
            .unwrap_or_default();
        line.push_str(&format!("; it is {task}'s work{item}"));
    }
    line.push('.');
    line
}

/// A commit read for a landing.
struct Read {
    landing: Landing,
    /// What a rebase keeps of the commit (`Commit::rewrite_key`).
    rewrite_key: String,
    /// What the node kept of its message body.
    body: String,
}

/// The body first: when the node keeps only the tail, the fields after it are whole.
const COMMIT_FORMAT: &str = "--format=%b%x1e%H%x1f%ct%x1f%ae%x1f%P%x1f%at%x1f%s";

/// One commit as `git show -s` prints it with `COMMIT_FORMAT`.
#[derive(Debug, PartialEq, Eq)]
struct Commit {
    sha: String,
    at_secs: i64,
    email: String,
    parents: Vec<String>,
    /// Its author time, which a rebase or cherry-pick keeps.
    authored_secs: i64,
    subject: String,
    /// What the node's output kept of it: its end.
    body: String,
}

impl Commit {
    fn parse(out: &str) -> Option<Self> {
        let (body, fields) = out.rsplit_once('\u{1e}')?;
        let mut f = fields.splitn(6, '\u{1f}');
        let sha = f.next()?.trim().to_lowercase();
        let at_secs = f.next()?.trim().parse().ok()?;
        let email = f.next()?.trim().to_owned();
        let parents = f.next()?.split_whitespace().map(str::to_owned).collect();
        let authored_secs = f.next()?.trim().parse().ok()?;
        let subject = f.next()?.trim_end_matches('\n').to_owned();
        Some(Self {
            sha,
            at_secs,
            email,
            parents,
            authored_secs,
            subject,
            body: body.to_owned(),
        })
    }

    /// What a rebase, an amend of the committer or a cherry-pick keeps: the author, the author time and the subject.
    /// `git patch-id` would need a pipe, which a node command can't run.
    fn rewrite_key(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}",
            self.email.to_lowercase(),
            self.authored_secs,
            self.subject
        )
    }
}

/// The lines of an output the node may have cut: a cut first line is dropped.
fn cut_lines(out: &str) -> Vec<String> {
    let cut = out.encode_utf16().count() >= OUTPUT_TAIL_MAX;
    out.lines()
        .skip(usize::from(cut))
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `<sha>\trefs/heads/main` in `git ls-remote origin refs/heads/main`.
pub(crate) fn ls_remote_sha(out: &str, base_ref: &str) -> Option<String> {
    out.lines().find_map(|line| {
        let (sha, name) = line.split_once('\t')?;
        (name.trim() == base_ref && sha.bytes().all(|b| b.is_ascii_hexdigit()) && sha.len() >= 40)
            .then(|| sha.to_lowercase())
    })
}

/// The host whose merge message named the PR.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GitHost {
    /// GitHub, Gitea and Forgejo: "Merge pull request #12 from …", "… (#12)".
    GitHub,
    GitLab,
    Bitbucket,
    Azure,
}

/// What a commit's message says about where it came from.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Origin {
    pub pr: Option<u64>,
    pub head: Option<String>,
    pub host: Option<GitHost>,
}

fn number_after<'a>(text: &'a str, marker: &str) -> Option<(u64, &'a str)> {
    let at = text.find(marker)? + marker.len();
    let rest = &text[at..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    Some((digits.parse().ok()?, &rest[digits.len()..]))
}

/// The first `'quoted'` name in `text`.
fn quoted(text: &str) -> Option<&str> {
    let (_, rest) = text.split_once('\'')?;
    let (name, _) = rest.split_once('\'')?;
    (!name.is_empty()).then_some(name)
}

/// Reads each host's default merge message:
/// - GitHub merge: `Merge pull request #12 from owner/branch`; Gitea and Forgejo:
///   `Merge pull request 'title' (#12) from branch into main`;
/// - GitHub, Gitea and Forgejo squash: a subject ending in `(#12)`;
/// - GitLab: `See merge request group/proj!12` in the body, `Merge branch 'feature' into 'main'`;
/// - Bitbucket: `Merged in branch (pull request #12)`;
/// - Azure DevOps: `Merged PR 12: title`;
/// - a local merge pushed: `Merge branch 'feature'`, `Merge remote-tracking branch 'origin/feature'` (no PR).
pub(crate) fn origin_of(subject: &str, body: &str) -> Origin {
    let subject = subject.trim();
    let mut origin = Origin::default();
    if let Some(rest) = subject.strip_prefix("Merge pull request ") {
        origin.host = Some(GitHost::GitHub);
        origin.pr = number_after(rest, "#").map(|(n, _)| n);
        if let Some((_, from)) = rest.rsplit_once(" from ") {
            let mut words = from.split_whitespace();
            let head = words.next().unwrap_or_default();
            origin.head = if words.next() == Some("into") {
                Some(head.to_owned())
            } else {
                head.split_once('/').map(|(_, branch)| branch.to_owned())
            }
            .filter(|h| !h.is_empty());
        }
        return origin;
    }
    if let Some(rest) = subject.strip_prefix("Merged in ")
        && let Some((n, _)) = number_after(rest, "(pull request #")
    {
        origin.host = Some(GitHost::Bitbucket);
        origin.pr = Some(n);
        origin.head = rest.split_whitespace().next().map(str::to_owned);
        return origin;
    }
    if let Some((n, rest)) = number_after(subject, "Merged PR ")
        && subject.starts_with("Merged PR ")
        && rest.starts_with(':')
    {
        origin.host = Some(GitHost::Azure);
        origin.pr = Some(n);
        return origin;
    }
    let gitlab = body.lines().chain([subject]).find_map(|line| {
        let rest = line.trim().strip_prefix("See merge request ")?;
        let (_, n) = rest.rsplit_once('!')?;
        n.trim().trim_end_matches('.').parse::<u64>().ok()
    });
    if let Some(n) = gitlab {
        origin.host = Some(GitHost::GitLab);
        origin.pr = Some(n);
    }
    for prefix in ["Merge branch ", "Merge remote-tracking branch "] {
        if let Some(rest) = subject.strip_prefix(prefix)
            && let Some(name) = quoted(rest)
        {
            let name = match prefix {
                "Merge branch " => name,
                _ => name.split_once('/').map_or(name, |(_, b)| b),
            };
            origin.head = Some(name.to_owned());
            return origin;
        }
    }
    if origin.pr.is_none()
        && let Some(open) = subject.rfind("(#")
        && subject.ends_with(')')
        && let Ok(n) = subject[open + 2..subject.len() - 1].parse::<u64>()
    {
        origin.host = Some(GitHost::GitHub);
        origin.pr = Some(n);
    }
    origin
}

/// The PR's URL on hosts whose URLs fleetd knows: github.com, bitbucket.org, and GitLab wherever its message said so.
pub(crate) fn pr_url(repo_key: &RepoKey, host: Option<GitHost>, n: u64) -> Option<PrUrl> {
    let key = repo_key.as_str();
    let url = match host? {
        GitHost::GitHub if key.starts_with("github.com/") => format!("https://{key}/pull/{n}"),
        GitHost::Bitbucket if key.starts_with("bitbucket.org/") => {
            format!("https://{key}/pull-requests/{n}")
        }
        GitHost::GitLab if !key.starts_with('/') => format!("https://{key}/-/merge_requests/{n}"),
        _ => return None,
    };
    PrUrl::new(url).ok()
}

/// A PR URL's number when it is on the repo: `/pull/57`, `/pulls/57`, `/-/merge_requests/57`, `/pull-requests/57`.
fn pr_number_in(url: &str, repo_key: &RepoKey) -> Option<u64> {
    let short = short_remote(url).to_lowercase();
    let rest = short.strip_prefix(repo_key.as_str())?.strip_prefix('/')?;
    let mut parts = rest.split('/').filter(|p| *p != "-");
    let kind = parts.next()?;
    matches!(kind, "pull" | "pulls" | "merge_requests" | "pull-requests")
        .then(|| parts.next()?.parse().ok())
        .flatten()
}

/// Words that close an issue in a commit message, on GitHub, GitLab, Gitea and Bitbucket alike.
const CLOSING: [&str; 12] = [
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
    "implement",
    "implements",
    "implemented",
];

/// Whether `text` closes `key` ("#12", "SHOP-12"): the key as a whole word right after a closing word ("Fixes #12",
/// "closes: SHOP-12"). A mere mention ("follow-up to #12") isn't one.
fn closes(text: &str, key: &str) -> bool {
    let (text, key) = (text.to_lowercase(), key.to_lowercase());
    text.match_indices(&key).any(|(at, _)| {
        let after = text[at + key.len()..].chars().next();
        if after.is_some_and(char::is_alphanumeric) {
            return false;
        }
        let before = text[..at].trim_end_matches(|c: char| c.is_whitespace() || c == ':');
        if before.len() == text[..at].len() && !before.is_empty() {
            return false;
        }
        let word = before
            .rsplit(|c: char| !c.is_alphanumeric())
            .next()
            .unwrap_or_default();
        CLOSING.contains(&word)
    })
}

/// The keys a closing reference to the claim's issue may use. An issue URL counts only on the landing's own repo,
/// as itself or as its `#n`.
fn issue_refs(issue: &str, repo_key: &RepoKey) -> Vec<String> {
    if !issue.contains("://") {
        return vec![issue.to_owned()];
    }
    let short = short_remote(issue).to_lowercase();
    let Some(rest) = short
        .strip_prefix(repo_key.as_str())
        .and_then(|r| r.strip_prefix('/'))
    else {
        return Vec::new();
    };
    let n = rest
        .trim_start_matches("-/")
        .strip_prefix("issues/")
        .map(|n| n.split('/').next().unwrap_or_default())
        .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
    let mut refs = vec![issue.to_owned()];
    refs.extend(n.map(|n| format!("#{n}")));
    refs
}

enum Match {
    /// It landed: why, for the claim's end.
    Ends(String),
    /// Its author's push touched its paths: its work is going on.
    Renews,
}

fn claim_match(claim: &Claim, landing: &Landing, body: &str) -> Option<Match> {
    let head = landing.head_branch.as_ref().map(|b| b.as_str());
    let branches = claim
        .branch
        .iter()
        .map(|b| b.as_str())
        .chain(claim.keys.iter().filter_map(|k| match k {
            WorkKey::Branch(b) => Some(b.as_str()),
            _ => None,
        }));
    for branch in branches {
        if Some(branch) == head {
            return Some(Match::Ends(format!("branch {branch}")));
        }
    }
    let message = format!("{}\n{body}", landing.subject);
    for key in claim.keys.iter() {
        match key {
            WorkKey::Pr(url) => {
                let n = pr_number_in(url.as_str(), &landing.repo_key);
                if n.is_some() && n == landing.pr_number.map(|p| p.get() as u64) {
                    return Some(Match::Ends(format!("PR {url}")));
                }
            }
            WorkKey::Issue(issue)
                if issue_refs(issue.as_str(), &landing.repo_key)
                    .iter()
                    .any(|r| closes(&message, r)) =>
            {
                return Some(Match::Ends(format!("issue {issue}")));
            }
            _ => {}
        }
    }
    let own = claim
        .author_email
        .as_ref()
        .zip(landing.author_email.as_ref())
        .is_some_and(|(a, b)| a.as_str().eq_ignore_ascii_case(b.as_str()));
    if !own {
        return None;
    }
    let claim_paths: Vec<&str> = claim
        .paths
        .iter()
        .map(|p| p.as_str())
        .chain(
            claim
                .observed
                .iter()
                .flat_map(|o| o.paths.iter().map(|p| p.as_str())),
        )
        .collect();
    let same_file = landing
        .paths
        .iter()
        .any(|p| claim_paths.iter().any(|g| path_matches(g, p.as_str())));
    if landing.route == LandingRoute::DirectPush
        && strongly_matches(claim.title.as_str(), landing.subject.as_str(), same_file)
    {
        return Some(Match::Ends(format!(
            "pushed by {} and matching its title",
            landing
                .author_email
                .as_ref()
                .map_or("its author", |e| e.as_str())
        )));
    }
    same_file.then_some(Match::Renews)
}

/// `app/settings/**`, `app/*.ts` or a plain path against a repo-relative path.
fn path_matches(glob: &str, path: &str) -> bool {
    if let Some(dir) = glob.strip_suffix("/**") {
        return path == dir || path.starts_with(&format!("{dir}/"));
    }
    if !glob.contains('*') {
        return glob == path;
    }
    let parts: Vec<&str> = glob.split('*').collect();
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !path.starts_with(first) || !path.ends_with(last) || path.len() < first.len() + last.len() {
        return false;
    }
    let mut rest = &path[first.len()..path.len() - last.len()];
    for part in &parts[1..parts.len() - 1] {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    true
}

const COMMIT_TYPES: [&str; 11] = [
    "feat", "fix", "chore", "docs", "refactor", "test", "tests", "perf", "build", "ci", "style",
];
const STOP_WORDS: [&str; 22] = [
    "the", "and", "for", "with", "from", "into", "that", "this", "add", "adds", "added", "update",
    "updates", "fix", "fixes", "make", "makes", "support", "use", "uses", "when", "now",
];

/// A title's words: lowercase letters and digits, without the conventional-commit type, stop words, numbers or
/// words under 3 characters.
fn words(title: &str) -> Vec<String> {
    let lower = title.to_lowercase();
    let mut text = lower.as_str();
    if let Some(at) = text.find([':', '(']) {
        let first = text[..at].trim().trim_end_matches('!');
        if COMMIT_TYPES.contains(&first) {
            text = &text[first.len()..];
        }
    }
    let mut out: Vec<String> = Vec::new();
    for word in text.split(|c: char| !c.is_alphanumeric()) {
        if word.chars().count() >= 3
            && !word.chars().all(|c| c.is_ascii_digit())
            && !STOP_WORDS.contains(&word)
            && !out.iter().any(|w| w == word)
        {
            out.push(word.to_owned());
        }
    }
    out
}

/// The design's strong tier: shared words over the smaller set ≥ 0.6 with ≥ 3 shared, or ≥ 0.4 with ≥ 2 shared and a
/// file in common.
fn strongly_matches(a: &str, b: &str, same_file: bool) -> bool {
    let (a, b) = (words(a), words(b));
    let smaller = a.len().min(b.len());
    if smaller == 0 {
        return false;
    }
    let shared = a.iter().filter(|w| b.contains(w)).count();
    let score = shared as f64 / smaller as f64;
    (score >= 0.6 && shared >= 3) || (score >= 0.4 && shared >= 2 && same_file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_hosts_default_merge_message_names_its_pr_and_branch() {
        let cases: [(&str, &str, Origin); 9] = [
            (
                "Merge pull request #57 from acme/ada/dark-mode",
                "dark mode",
                Origin {
                    pr: Some(57),
                    head: Some("ada/dark-mode".into()),
                    host: Some(GitHost::GitHub),
                },
            ),
            (
                "feat: dark mode toggle (#58)",
                "* first\n* second",
                Origin {
                    pr: Some(58),
                    head: None,
                    host: Some(GitHost::GitHub),
                },
            ),
            (
                "Merge pull request 'dark mode' (#9) from dark-mode into main",
                "",
                Origin {
                    pr: Some(9),
                    head: Some("dark-mode".into()),
                    host: Some(GitHost::GitHub),
                },
            ),
            (
                "Merge branch 'dark-mode' into 'main'",
                "dark mode toggle\n\nSee merge request acme/shop!12",
                Origin {
                    pr: Some(12),
                    head: Some("dark-mode".into()),
                    host: Some(GitHost::GitLab),
                },
            ),
            (
                "Merged in ada/dark-mode (pull request #4)",
                "dark mode",
                Origin {
                    pr: Some(4),
                    head: Some("ada/dark-mode".into()),
                    host: Some(GitHost::Bitbucket),
                },
            ),
            (
                "Merged PR 31: dark mode toggle",
                "",
                Origin {
                    pr: Some(31),
                    head: None,
                    host: Some(GitHost::Azure),
                },
            ),
            (
                "Merge branch 'dark-mode'",
                "",
                Origin {
                    pr: None,
                    head: Some("dark-mode".into()),
                    host: None,
                },
            ),
            (
                "Merge remote-tracking branch 'origin/dark-mode'",
                "",
                Origin {
                    pr: None,
                    head: Some("dark-mode".into()),
                    host: None,
                },
            ),
            ("feat: dark mode toggle, closes #12", "", Origin::default()),
        ];
        for (subject, body, origin) in cases {
            assert_eq!(origin_of(subject, body), origin, "{subject}");
        }
    }

    #[test]
    fn a_pr_url_is_built_only_where_the_host_is_known() {
        let key = |k: &str| RepoKey::new(k).unwrap();
        let url = |k: &str, f: Option<GitHost>| pr_url(&key(k), f, 7).map(|u| u.to_string());
        assert_eq!(
            url("github.com/acme/shop", Some(GitHost::GitHub)).as_deref(),
            Some("https://github.com/acme/shop/pull/7")
        );
        assert_eq!(
            url("gitlab.example.com/acme/shop", Some(GitHost::GitLab)).as_deref(),
            Some("https://gitlab.example.com/acme/shop/-/merge_requests/7")
        );
        assert_eq!(
            url("bitbucket.org/acme/shop", Some(GitHost::Bitbucket)).as_deref(),
            Some("https://bitbucket.org/acme/shop/pull-requests/7")
        );
        assert_eq!(
            url("git.example.com/acme/shop", Some(GitHost::GitHub)),
            None
        );
        assert_eq!(url("/srv/git/shop", Some(GitHost::GitLab)), None);
        assert_eq!(
            pr_number_in(
                "https://gitlab.example.com/acme/shop/-/merge_requests/12",
                &key("gitlab.example.com/acme/shop")
            ),
            Some(12)
        );
        assert_eq!(
            pr_number_in(
                "https://github.com/acme/shop/pull/12/files",
                &key("github.com/acme/shop")
            ),
            Some(12)
        );
        assert_eq!(
            pr_number_in(
                "https://github.com/acme/other/pull/12",
                &key("github.com/acme/shop")
            ),
            None
        );
    }

    #[test]
    fn only_a_closing_reference_on_the_same_repo_closes_an_issue() {
        assert!(closes("fix: checkout total\n\nCloses SHOP-12", "SHOP-12"));
        assert!(closes("fix: checkout total, fixes #12", "#12"));
        assert!(closes("Resolves: #12.", "#12"));
        assert!(!closes("fix: follow-up to #12", "#12"), "a mention");
        assert!(
            !closes("fix: checkout total (SHOP-12)", "SHOP-12"),
            "a mention"
        );
        assert!(!closes("fix: checkout total, closes #123", "#12"));
        assert!(!closes("closes BIGSHOP-12", "SHOP-12"));
        let shop = RepoKey::new("github.com/acme/shop").unwrap();
        assert_eq!(
            issue_refs("https://github.com/acme/shop/issues/12", &shop),
            ["https://github.com/acme/shop/issues/12", "#12"]
        );
        assert_eq!(
            issue_refs(
                "https://gitlab.example.com/acme/shop/-/issues/8",
                &RepoKey::new("gitlab.example.com/acme/shop").unwrap()
            ),
            ["https://gitlab.example.com/acme/shop/-/issues/8", "#8"]
        );
        assert!(
            issue_refs("https://github.com/acme/other/issues/12", &shop).is_empty(),
            "another repo's issue"
        );
    }

    #[test]
    fn a_strong_match_shares_most_title_words_or_some_and_a_file() {
        assert!(strongly_matches(
            "dark mode toggle in settings",
            "feat(app): dark mode toggle for settings",
            false
        ));
        assert!(!strongly_matches(
            "dark mode toggle",
            "fix: dark mode contrast",
            false
        ));
        assert!(strongly_matches(
            "dark mode toggle",
            "fix: dark mode contrast",
            true
        ));
        assert!(!strongly_matches(
            "dark mode toggle",
            "feat: checkout totals",
            true
        ));
        assert_eq!(
            words("fix(hub): add the dark-mode toggle (#58)"),
            ["hub", "dark", "mode", "toggle"]
        );
    }

    #[test]
    fn globs_match_paths() {
        assert!(path_matches(
            "app/settings/**",
            "app/settings/theme/dark.ts"
        ));
        assert!(path_matches("app/*.ts", "app/theme.ts"));
        assert!(!path_matches("app/*.ts", "app/theme.tsx"));
        assert!(path_matches("app/theme.ts", "app/theme.ts"));
        assert!(!path_matches("app/settings/**", "app/settingsx/a.ts"));
    }

    #[test]
    fn a_commit_is_read_whole_even_when_the_node_kept_only_its_tail() {
        let out = "…of a long body\nSee merge request acme/shop!12\n\u{1e}0123456789abcdef0123456789abcdef01234567\u{1f}1792922400\u{1f}ada@example.com\u{1f}aaa bbb\u{1f}1792922000\u{1f}Merge branch 'x' into 'main'\n";
        let commit = Commit::parse(out).unwrap();
        assert_eq!(commit.sha, "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(commit.at_secs, 1_792_922_400);
        assert_eq!(commit.parents, ["aaa", "bbb"]);
        assert_eq!(commit.authored_secs, 1_792_922_000);
        assert_eq!(commit.subject, "Merge branch 'x' into 'main'");
        assert!(commit.body.ends_with("acme/shop!12\n"));
        let long = format!("cut-line\n{}", "a/b.ts\n".repeat(400));
        let lines = cut_lines(&long[long.len() - 2000..]);
        assert!(lines.iter().all(|l| l == "a/b.ts"), "{:?}", &lines[..2]);
        assert_eq!(
            ls_remote_sha(
                "0123456789ABCDEF0123456789abcdef01234567\trefs/heads/main\n",
                "refs/heads/main"
            )
            .as_deref(),
            Some("0123456789abcdef0123456789abcdef01234567")
        );
        assert_eq!(
            super::super::bind::remote_head("ref: refs/heads/trunk\tHEAD\nabc\tHEAD\n"),
            Some("trunk")
        );
    }
}
