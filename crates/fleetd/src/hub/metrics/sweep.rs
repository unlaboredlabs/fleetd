//! The host sweep: every project's repo read through its git host, not only repos with a train. It finds each
//! project's origin by asking its node, then per repo reads the PRs merged since its cursor (90 days back the first
//! time), the default branch's first-parent commits to find direct pushes, and the reviews and comments for the
//! person's touches. Each PR gets the projector's route from the same fields, so the train's events and the sweep
//! agree whichever reads it first; a train batch PR counts as its members.
//!
//! When: every 15 minutes for a repo with a merge in the last 7 days, else hourly, and within a minute of a metrics
//! read asking for it. Repos are read one at a time. On a train's repo the train's own minute-by-minute check stays
//! the fast path; the sweep fills what it can't see (no train yet, older PRs, other bases, pushes, reviews).
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::TrainEventData;
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::metrics::{ActorKind, MergeRoute, SkipWhy};
use fleetd_contracts::prim::Count;
use fleetd_contracts::train::{Change, ChangeState, GitHubRepo};
use rusqlite::{Connection, OptionalExtension, params};
use tokio::sync::Notify;

use super::host_acts::{self, BACKFILL_MS};
use super::project::{self, actor_str, skip_str};
use super::source::github::GitHubSource;
use super::source::{self, GitHostSource, LandedCommit, MergedPr, RepoInfo, RepoRef};
use super::store::{self, MergeRow, SKIPPED};
use super::touches;
use crate::hub::api::Hub;
use crate::hub::store::{HubDb, StoreError, iso_ms, now_ms};
use crate::hub::train::github::GhRunner;

/// A metrics read asks for a repo again once its last read is this old.
pub const ON_READ_MS: i64 = 60_000;
/// How often a repo with a merge in the last [`ACTIVE_FOR_MS`] is read.
pub const ACTIVE_EVERY_MS: i64 = 15 * 60_000;
/// How often any other repo is read.
pub const QUIET_EVERY_MS: i64 = 60 * 60_000;
pub const ACTIVE_FOR_MS: i64 = 7 * store::DAY_MS;
/// Each read starts this far before the last one, for host clocks and late updates; rows are idempotent.
const OVERLAP_MS: i64 = 10 * 60_000;
/// A checkout's origin is asked of its node again after a day, or after ten minutes when the node didn't answer.
const ORIGIN_EVERY_MS: i64 = store::DAY_MS;
const ORIGIN_RETRY_MS: i64 = 10 * 60_000;
const TICK: Duration = Duration::from_secs(60);

/// The sweep's sources and when each repo was last tried.
pub struct Sweep {
    github: Mutex<Arc<dyn GitHostSource>>,
    /// Repos a metrics read asked for since the last pass.
    wanted: Mutex<HashSet<String>>,
    tried: Mutex<HashMap<String, i64>>,
    /// Projects whose node was last asked for their origin, and when.
    asked: Mutex<HashMap<(String, String), i64>>,
    kick: Notify,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Sweep {
    pub fn new(gh: Arc<dyn GhRunner>) -> Self {
        Self {
            github: Mutex::new(Arc::new(GitHubSource::new(gh))),
            wanted: Mutex::default(),
            tried: Mutex::default(),
            asked: Mutex::default(),
            kick: Notify::new(),
        }
    }

    /// The source for a host as `metric_repos.host` names it; none yet for the others.
    pub fn source(&self, host: &str) -> Option<Arc<dyn GitHostSource>> {
        (host == "github").then(|| lock(&self.github).clone())
    }

    #[cfg(test)]
    pub fn use_github(&self, source: Arc<dyn GitHostSource>) {
        *lock(&self.github) = source;
    }

    /// A metrics read of `repos`: each is read again if its last read is over a minute old. Doesn't wait.
    pub fn want(&self, repos: &[String]) {
        lock(&self.wanted).extend(repos.iter().cloned());
        self.kick.notify_one();
    }
}

/// Whether a repo is due: never tried, asked for by a read a minute on, active and 15 minutes on, or an hour on.
pub fn due(
    last_try_ms: Option<i64>,
    last_merge_ms: Option<i64>,
    wanted: bool,
    now_ms: i64,
) -> bool {
    let Some(last) = last_try_ms else {
        return true;
    };
    let every = if wanted {
        ON_READ_MS
    } else if last_merge_ms.is_some_and(|m| now_ms - m < ACTIVE_FOR_MS) {
        ACTIVE_EVERY_MS
    } else {
        QUIET_EVERY_MS
    };
    now_ms - last >= every
}

pub async fn run(hub: Arc<Hub>) {
    loop {
        pass(&hub).await;
        tokio::select! {
            () = hub.shutdown.wait() => return,
            () = hub.metrics.sweep.kick.notified() => {}
            () = hub.clock.sleep(TICK) => {}
        }
    }
}

/// One pass: learn the projects' origins, then read every due repo, one at a time.
pub async fn pass(hub: &Hub) {
    let now = now_ms(hub.clock.as_ref());
    learn_origins(hub, now).await;
    let sweep = &hub.metrics.sweep;
    let wanted = std::mem::take(&mut *lock(&sweep.wanted));
    let repos = match hub.db.with(sweepable) {
        Ok(repos) => repos,
        Err(e) => return tracing::error!(error = %e, "metrics: repos not listed"),
    };
    for r in repos {
        let Some(source) = sweep.source(&r.host) else {
            continue;
        };
        let tried = lock(&sweep.tried).get(&r.repo).copied();
        let last = tried.max(r.last_ok_ms);
        if !due(last, r.last_merge_ms, wanted.contains(&r.repo), now) {
            continue;
        }
        lock(&sweep.tried).insert(r.repo.clone(), now);
        let now = now_ms(hub.clock.as_ref());
        if let Err(why) = sweep_repo(hub, source.as_ref(), &r.repo, now).await {
            tracing::warn!(repo = %r.repo, %why, "metrics: repo not read from its git host");
        }
    }
}

/// A repo the sweep may read.
#[derive(Debug, PartialEq)]
pub struct Sweepable {
    pub repo: String,
    pub host: String,
    pub last_ok_ms: Option<i64>,
    pub last_merge_ms: Option<i64>,
}

/// Every repo the metrics know (projects' origins, trains, Changes), each made known to `metric_repos`.
pub fn sweepable(c: &Connection) -> Result<Vec<Sweepable>, StoreError> {
    let repos = super::tools::repo_projects(c)?;
    for repo in repos.keys() {
        store::see_repo(c, repo, source::host_of(repo))?;
    }
    let mut stmt = c.prepare_cached(
        "SELECT r.repo, r.host, r.last_ok_ms, (SELECT MAX(merged_ms) FROM metric_merges m WHERE m.repo = r.repo)
         FROM metric_repos r ORDER BY r.repo",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Sweepable {
                repo: r.get(0)?,
                host: r.get(1)?,
                last_ok_ms: r.get(2)?,
                last_merge_ms: r.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Asks each project's node for its checkout's origin, once a day, and forgets projects that are gone.
pub async fn learn_origins(hub: &Hub, now: i64) {
    let projects = hub.db.with(|c| {
        c.execute(
            "DELETE FROM metric_project_repos WHERE NOT EXISTS
               (SELECT 1 FROM projects p WHERE p.machine_id = metric_project_repos.machine_id
                  AND p.project_id = metric_project_repos.project_id)",
            [],
        )?;
        let mut stmt = c.prepare_cached(
            "SELECT p.machine_id, p.project_id, json_extract(p.data, '$.workspaceRoot') FROM projects p
             LEFT JOIN metric_project_repos o ON o.machine_id = p.machine_id AND o.project_id = p.project_id
             WHERE o.checked_ms IS NULL OR o.checked_ms < ?1",
        )?;
        let rows = stmt
            .query_map([now - ORIGIN_EVERY_MS], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    });
    let projects = match projects {
        Ok(p) => p,
        Err(e) => return tracing::error!(error = %e, "metrics: projects not listed"),
    };
    for (m, p, root) in projects {
        let Some(root) = root else { continue };
        let key = (m.clone(), p.clone());
        if lock(&hub.metrics.sweep.asked)
            .get(&key)
            .is_some_and(|at| now - at < ORIGIN_RETRY_MS)
        {
            continue;
        }
        lock(&hub.metrics.sweep.asked).insert(key, now);
        let Ok(facts) = hub
            .executors
            .repo_inspect(&MachineId::unchecked(&m), &root)
            .await
        else {
            continue;
        };
        let Some(repo) = facts.remote.as_deref().and_then(source::remote_key) else {
            continue;
        };
        let wrote = hub.db.transaction(|c| {
            store::see_repo(c, &repo, source::host_of(&repo))?;
            c.execute(
                "INSERT INTO metric_project_repos (machine_id, project_id, repo, checked_ms) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(machine_id, project_id) DO UPDATE SET repo = excluded.repo, checked_ms = excluded.checked_ms",
                params![m, p, repo, now],
            )?;
            c.execute(
                "UPDATE metric_repos SET default_branch = ?2 WHERE repo = ?1 AND default_branch IS NULL",
                params![repo, facts.default_branch],
            )?;
            Ok(())
        });
        if let Err(e) = wrote {
            tracing::error!(error = %e, "metrics: a project's origin not kept");
        }
    }
}

/// What one repo's read found.
#[derive(Debug, Default, PartialEq)]
pub struct Swept {
    pub rows: usize,
    pub touches: usize,
}

/// Reads one repo from its host and writes what it found; on failure the repo keeps its rows and says why.
pub async fn sweep_repo(
    hub: &Hub,
    source: &dyn GitHostSource,
    remote: &str,
    now: i64,
) -> Result<Swept, String> {
    let read = read_repo(hub, source, remote, now).await;
    let failed = |why: &str| {
        let kept = hub.db.transaction(|c| {
            store::see_repo(c, remote, source::host_of(remote))?;
            c.execute(
                "UPDATE metric_repos SET last_error = ?2 WHERE repo = ?1",
                params![remote, crate::hub::api::clip(why, 500)],
            )?;
            Ok(())
        });
        if let Err(e) = kept {
            tracing::error!(error = %e, "metrics: a repo's read error not kept");
        }
    };
    let rows = match read {
        Ok(rows) => rows,
        Err(why) => {
            failed(&why);
            return Err(why);
        }
    };
    // The hub reads the host as the person: their own reviews, comments and merges are made by this account.
    match source.signed_in().await {
        Ok(Some(login)) => {
            let host = source::host_of(remote);
            if let Err(e) = hub.db.transaction(|c| store::add_identity(c, &login, host)) {
                tracing::error!(error = %e, "metrics: the host's login not kept");
            }
        }
        Ok(None) => {}
        Err(why) => {
            failed(&why);
            return Err(why);
        }
    }
    let touches = match host_acts::read(&hub.db, source.acts(), remote, now).await {
        Ok(n) => n,
        Err(e) => {
            let why = e.to_string();
            failed(&why);
            return Err(why);
        }
    };
    Ok(Swept { rows, touches })
}

/// The landed changes since the repo's cursor, written in one transaction with the cursor's move.
async fn read_repo(
    hub: &Hub,
    source: &dyn GitHostSource,
    remote: &str,
    now: i64,
) -> Result<usize, String> {
    let path = remote
        .split_once('/')
        .map(|(_, p)| p.to_owned())
        .ok_or_else(|| format!("{remote} is not host/path"))?;
    let repo = RepoRef {
        remote: remote.to_owned(),
        path,
    };
    let store_err = |e: StoreError| format!("the hub's database: {e}");
    let cursor: Option<i64> = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT merged_cursor_ms FROM metric_repos WHERE repo = ?1",
                [remote],
                |r| r.get(0),
            )
            .optional()?
            .flatten())
        })
        .map_err(store_err)?;
    let since = cursor.unwrap_or(now - BACKFILL_MS);
    let info = source.repo_info(&repo).await?;
    let pulls = source.merged_since(&repo, since).await?;
    let commits = source
        .default_commits(&repo, &info.default_branch, since)
        .await?;
    let mut rows = pr_rows(hub, &repo, &info, &pulls).map_err(store_err)?;
    let landed_shas: HashSet<String> = pulls
        .iter()
        .filter_map(|p| p.merge_sha.clone())
        .chain(known_shas(&hub.db, remote).map_err(store_err)?)
        .collect();
    for c in first_parent(&commits) {
        if c.at_ms < since || landed_shas.contains(&c.sha) {
            continue;
        }
        let prs = match &c.prs {
            Some(prs) => prs.clone(),
            None => source.prs_of_commit(&repo, &c.sha).await?,
        };
        if prs.is_empty() {
            rows.push(push_row(
                &repo,
                c,
                owner_of(&hub.db, remote).map_err(store_err)?,
            ));
        }
    }
    let head = commits.first().map(|c| c.sha.clone());
    let n = rows.len();
    hub.db
        .transaction(|c| {
            store::see_repo(c, remote, source::host_of(remote))?;
            for row in &rows {
                write(c, row)?;
                if let Some(t) = touches::merged_by_hand(row) {
                    store::upsert_touch(c, &t)?;
                }
            }
            c.execute(
                "UPDATE metric_repos SET default_branch = ?2, merged_cursor_ms = ?3,
                   commits_cursor_sha = COALESCE(?4, commits_cursor_sha), last_ok_ms = ?5, last_error = NULL,
                   backfilled_ms = COALESCE(backfilled_ms, ?6)
                 WHERE repo = ?1",
                params![remote, info.default_branch, now - OVERLAP_MS, head, now, since],
            )?;
            Ok(())
        })
        .map_err(store_err)?;
    Ok(n)
}

/// The default branch's own line: from its head, first parents only, as far as the commits read go.
pub fn first_parent(commits: &[LandedCommit]) -> Vec<&LandedCommit> {
    let by_sha: HashMap<&str, &LandedCommit> =
        commits.iter().map(|c| (c.sha.as_str(), c)).collect();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut next = commits.first();
    while let Some(c) = next.filter(|c| seen.insert(c.sha.as_str())) {
        out.push(c);
        next = c
            .first_parent
            .as_deref()
            .and_then(|p| by_sha.get(p).copied());
    }
    out
}

/// The commits already known as landed on the repo: merges and squashes the train or a PR left.
fn known_shas(db: &HubDb, remote: &str) -> Result<Vec<String>, StoreError> {
    db.with(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT merged_sha FROM metric_merges WHERE repo = ?1 AND merged_sha IS NOT NULL AND unit_key LIKE 'pr:%'",
        )?;
        let shas = stmt
            .query_map([remote], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(shas)
    })
}

/// The project a repo's rows belong to when no train or Change says: the first with it checked out.
fn owner_of(db: &HubDb, remote: &str) -> Result<Option<(String, String)>, StoreError> {
    db.with(|c| {
        Ok(c.query_row(
            "SELECT machine_id, project_id FROM metric_project_repos WHERE repo = ?1
             ORDER BY machine_id, project_id LIMIT 1",
            [remote],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
    })
}

/// The newest Change for a PR, if fleetd ever enqueued it.
fn change_of(db: &HubDb, repo: &str, pr: i64) -> Result<Option<Change>, StoreError> {
    let data: Option<String> = db.with(|c| {
        Ok(c.query_row(
            "SELECT data FROM changes WHERE repo = ?1 AND pr_number = ?2 ORDER BY n DESC LIMIT 1",
            params![repo.to_lowercase(), pr],
            |r| r.get(0),
        )
        .optional()?)
    })?;
    Ok(data.and_then(|d| serde_json::from_str(&d).ok()))
}

fn actor_kind(k: ActorKind) -> Option<ActorKind> {
    (k != ActorKind::Unknown).then_some(k)
}

/// Why a merged PR is not a landed change, beyond the projector's bots: into a base that isn't the repo's default
/// or one the train guards, or a merge-back (an upstream's default branch synced in, or a branch other PRs merge
/// into, such as `release` → `main`).
pub fn skip_why(
    pr: &MergedPr,
    repo_path: &str,
    info: &RepoInfo,
    guarded: &dyn Fn(&str) -> bool,
    bases: &BTreeSet<&str>,
) -> Option<SkipWhy> {
    if pr.base != info.default_branch && !guarded(&pr.base) {
        return Some(SkipWhy::OtherBase);
    }
    let same_repo = pr
        .head_repo
        .as_deref()
        .is_some_and(|h| h.eq_ignore_ascii_case(repo_path));
    let upstream = pr
        .head_repo
        .as_deref()
        .zip(info.upstream.as_deref())
        .is_some_and(|(h, u)| h.eq_ignore_ascii_case(u));
    let merge_back = (upstream && pr.head_is_default)
        || (same_repo && (pr.head == info.default_branch || bases.contains(pr.head.as_str())));
    merge_back.then_some(SkipWhy::MergeBack)
}

/// The rows the merged PRs make: a batch PR's members one each, every other PR as the projector would route it.
fn pr_rows(
    hub: &Hub,
    repo: &RepoRef,
    info: &RepoInfo,
    pulls: &[MergedPr],
) -> Result<Vec<MergeRow>, StoreError> {
    let fallback = owner_of(&hub.db, &repo.remote)?;
    let train_repo = GitHubRepo::new(repo.path.to_lowercase()).ok();
    let bases: BTreeSet<&str> = pulls
        .iter()
        .map(|p| p.base.as_str())
        .filter(|b| *b != info.default_branch)
        .collect();
    let guarded = |base: &str| hub.train.guards_base(&repo.path, base);
    let mut out = Vec::new();
    for pr in pulls {
        let base = TrainEventData {
            repo: train_repo.clone(),
            merged_sha: pr.merge_sha.clone(),
            merged_at: Some(Timestamp(iso_ms(pr.merged_ms))),
            base: Some(pr.base.clone()),
            ..TrainEventData::default()
        };
        if !pr.batch_members.is_empty() {
            // The train's batch PR: its members landed in it, and it isn't counted itself.
            for &n in &pr.batch_members {
                let change = change_of(&hub.db, &repo.path, n)?;
                let d = TrainEventData {
                    pr_number: Some(Count::unchecked(n)),
                    batch_pr: Some(Count::unchecked(pr.number)),
                    change_id: change.as_ref().map(|c| c.change_id.clone()),
                    head: change.as_ref().map(|c| c.branch.to_string()),
                    ..base.clone()
                };
                out.extend(host_row(project::landed(
                    &hub.db,
                    true,
                    &d,
                    pr.merged_ms,
                    fallback.clone(),
                )?));
            }
            continue;
        }
        let change = change_of(&hub.db, &repo.path, pr.number)?;
        let train = change
            .as_ref()
            .is_some_and(|c| c.state == ChangeState::Merged);
        let d = TrainEventData {
            pr_number: Some(Count::unchecked(pr.number)),
            pr_url: pr.url.clone(),
            change_id: change.as_ref().map(|c| c.change_id.clone()),
            head: Some(pr.head.clone()),
            pr_created_at: pr.created_ms.map(|ms| Timestamp(iso_ms(ms))),
            author_kind: actor_kind(pr.author),
            merged_by_kind: actor_kind(pr.merged_by),
            merged_by: pr.merged_by_login.clone(),
            ..base
        };
        let Some(mut row) = host_row(project::landed(
            &hub.db,
            train,
            &d,
            pr.merged_ms,
            fallback.clone(),
        )?) else {
            continue;
        };
        row.title = Some(pr.title.clone()).filter(|t| !t.is_empty());
        row.additions = pr.additions;
        row.deletions = pr.deletions;
        if !train
            && row.route != SKIPPED
            && let Some(why) = skip_why(pr, &repo.path, info, &guarded, &bases)
        {
            row.route = SKIPPED.into();
            row.skip_why = Some(skip_str(why).into());
        }
        out.push(row);
    }
    Ok(out)
}

fn host_row(row: Option<MergeRow>) -> Option<MergeRow> {
    row.map(|r| MergeRow {
        src: "host".into(),
        ..r
    })
}

/// A first-parent commit no PR brought in: pushed straight to the default branch.
fn push_row(repo: &RepoRef, c: &LandedCommit, owner: Option<(String, String)>) -> MergeRow {
    let (machine_id, project_id) = owner.unzip();
    let (route, skip) = if c.bot {
        (SKIPPED, Some(skip_str(SkipWhy::Bot)))
    } else {
        (MergeRoute::Direct.as_str(), None)
    };
    MergeRow {
        repo: repo.remote.clone(),
        unit_key: format!("commit:{}", c.sha),
        machine_id,
        project_id,
        merged_ms: c.at_ms,
        merged_sha: Some(c.sha.clone()),
        route: route.into(),
        skip_why: skip.map(str::to_owned),
        author_kind: Some(
            actor_str(if c.bot {
                ActorKind::Bot
            } else {
                ActorKind::Human
            })
            .into(),
        ),
        title: Some(c.title.clone()).filter(|t| !t.is_empty()),
        url: Some(format!("https://{}/commit/{}", repo.remote, c.sha)),
        src: "host".into(),
        ..MergeRow::default()
    }
}

/// Writes a row the sweep made. A merge the train reported was into a base it guards, so the sweep's "other base"
/// never overrides it; a PR's row replaces the direct push its commit was taken for before the host linked them.
fn write(c: &Connection, row: &MergeRow) -> Result<(), StoreError> {
    if row.skip_why.as_deref() == Some(skip_str(SkipWhy::OtherBase)) {
        let from_event: bool = c
            .query_row(
                "SELECT src = 'event' FROM metric_merges WHERE repo = ?1 AND unit_key = ?2",
                params![row.repo, row.unit_key],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false);
        if from_event {
            return Ok(());
        }
    }
    if let Some(id) = &row.change_id {
        let mut row = row.clone();
        row.review_passed_ms = store::review_passed(c, id)?;
        store::upsert_merge(c, &row)?;
    } else {
        store::upsert_merge(c, row)?;
    }
    if let (Some(sha), true) = (&row.merged_sha, row.unit_key.starts_with("pr:")) {
        c.execute(
            "DELETE FROM metric_merges WHERE repo = ?1 AND unit_key = ?2 AND route IN ('direct', 'skipped')",
            params![row.repo, format!("commit:{sha}")],
        )?;
    }
    Ok(())
}
