//! A repo on a host fleetd can't read through an API (a bare ssh remote, a self-hosted Gitea with no token): its
//! landed changes come from git alone, the default branch's first-parent line as a node with it checked out reads
//! it (`landed_log`). Each commit on that line is one landed change, routed by what git keeps:
//!
//! - a `Fleetd-Change:` trailer (the train's squash), or the merge sha of a Merged Change: `train`, one per Change;
//! - a merge commit that brought in commits with a `Fleetd-Task:` trailer, or merged a `fleetd/T…` branch, or any
//!   other commit carrying that trailer (a squash or rebase by hand): `fleetd_by_hand`;
//! - any other merge commit: `outside`, a PR merged by hand;
//! - any other commit: `direct`, pushed straight. A PR squash-merged on the host reads so too: git can't tell.
//!
//! A run of commits of one task in a row is one change (a rebase merge). A merge of the default branch into itself (a
//! `git pull`) is skipped as a merge-back. Agents' commits carry `Fleetd-Task` only in a repo that already has
//! `extensions.worktreeConfig` on (`node::landed::trailer_hooks`); elsewhere fleetd's work merged by hand is found only
//! where a merge names its `fleetd/T…` branch. Who merged, reviews, bots, PR open times and fleetd's work merged by
//! hand that git doesn't name can't be known this way, and the coverage says so (`UNKNOWN`).
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use fleetd_contracts::ids::{MachineId, ProjectId};
use fleetd_contracts::metrics::{MergeRoute, SkipWhy};
use fleetd_contracts::sessions::{GitCommit, LandedLog};
use fleetd_contracts::train::Change;
use rusqlite::{OptionalExtension, params};

use super::host_acts::BACKFILL_MS;
use super::project::{self, skip_str};
use super::store::{self, MergeRow, SKIPPED};
use super::{source, sweep};
use crate::hub::api::Hub;
use crate::hub::leads::requested;
use crate::hub::store::{HubDb, StoreError};
use crate::hub::usage::ports::BoxFut;
use crate::node::landed::branch_task;

/// What a repo read from git alone can't say, for the view.
pub const UNKNOWN: &[&str] = &[
    "Who merged each change: git doesn't record it.",
    "Whether a commit with no fleetd trailer was pushed straight or squash-merged from a PR on the host: it reads as pushed straight.",
    "fleetd's work you merged by hand, when its commits carry no Fleetd-Task trailer and the merge doesn't name its fleetd/T… branch: it reads as merged outside fleetd or pushed straight.",
    "Reviews and comments on the host, so your minutes on them.",
    "When each PR was opened, so PR open to merged.",
    "Bot accounts, except commits whose author ends in [bot].",
    "Lines changed.",
];

/// Reads a checkout's landed log: a node's in the hub, a local checkout's in tests.
pub trait GitLog: Send + Sync {
    /// Whether `machine` can be asked now.
    fn can_read(&self, hub: &Hub, machine: &str) -> bool;

    fn read<'a>(
        &'a self,
        hub: &'a Hub,
        at: &'a (String, String),
        branch: &'a str,
        since_ms: i64,
        stop_at: Option<&'a str>,
    ) -> BoxFut<'a, Result<LandedLog, String>>;
}

/// Asks the project's node.
pub struct NodeLog;

impl GitLog for NodeLog {
    fn can_read(&self, hub: &Hub, machine: &str) -> bool {
        let m = MachineId::unchecked(machine);
        hub.executors.is_connected(&m)
            && hub
                .link
                .node_can(&m, fleetd_contracts::node_link::CAP_LANDED_LOG)
    }

    fn read<'a>(
        &'a self,
        hub: &'a Hub,
        at: &'a (String, String),
        branch: &'a str,
        since_ms: i64,
        stop_at: Option<&'a str>,
    ) -> BoxFut<'a, Result<LandedLog, String>> {
        Box::pin(async move {
            hub.executors
                .landed_log(
                    &MachineId::unchecked(&at.0),
                    &ProjectId::unchecked(&at.1),
                    branch,
                    since_ms,
                    stop_at,
                )
                .await
                .map_err(|e| e.to_string())
        })
    }
}

/// The reader the sweep uses; tests swap it.
pub struct Reader(Mutex<Arc<dyn GitLog>>);

impl Default for Reader {
    fn default() -> Self {
        Self(Mutex::new(Arc::new(NodeLog)))
    }
}

impl Reader {
    pub fn get(&self) -> Arc<dyn GitLog> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    #[cfg(test)]
    pub fn set(&self, log: Arc<dyn GitLog>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = log;
    }
}

/// Reads one repo from git on a checkout of it and writes what it found; on failure the repo keeps its rows and
/// says why.
pub async fn sweep_repo(hub: &Hub, remote: &str, now: i64) -> Result<usize, String> {
    let read = read_repo(hub, remote, now).await;
    if let Err(why) = &read {
        sweep::failed(hub, remote, why);
    }
    read
}

async fn read_repo(hub: &Hub, remote: &str, now: i64) -> Result<usize, String> {
    let store_err = |e: StoreError| format!("the hub's database: {e}");
    let (branch, cursor, head_seen, checkouts) = hub
        .db
        .with(|c| {
            let (branch, cursor, head): (Option<String>, Option<i64>, Option<String>) = c
                .query_row(
                    "SELECT default_branch, merged_cursor_ms, commits_cursor_sha FROM metric_repos WHERE repo = ?1",
                    [remote],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?
                .unwrap_or_default();
            let mut stmt = c.prepare_cached(
                "SELECT machine_id, project_id FROM metric_project_repos WHERE repo = ?1
                 ORDER BY machine_id, project_id",
            )?;
            let checkouts = stmt
                .query_map([remote], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok((branch, cursor, head, checkouts))
        })
        .map_err(store_err)?;
    let branch = branch.ok_or("its default branch isn't known yet: no node has said")?;
    let reader = hub.metrics.sweep.git.get();
    let at = checkouts
        .iter()
        .find(|(m, _)| reader.can_read(hub, m))
        .ok_or("no machine with it checked out is connected to read its git log")?;
    let since = cursor.unwrap_or(now - BACKFILL_MS);
    let log = reader
        .read(hub, at, &branch, since, head_seen.as_deref())
        .await?;
    let rows = rows(&hub.db, remote, &branch, Some(at.clone()), &log.commits).map_err(store_err)?;
    let head = log.commits.first().map(|c| c.sha.clone());
    let n = rows.len();
    hub.db
        .transaction(|c| {
            store::see_repo(c, remote, source::host_of(remote))?;
            for row in &rows {
                sweep::write(c, row)?;
            }
            // A failed fetch read the last fetched copy: its rows count, but the repo isn't read as of now.
            let error = log
                .fetch_failed
                .as_deref()
                .map(|why| crate::hub::api::clip(&format!("git fetch failed: {why}"), 500));
            c.execute(
                "UPDATE metric_repos SET default_branch = ?2, merged_cursor_ms = ?3,
                   commits_cursor_sha = COALESCE(?4, commits_cursor_sha),
                   last_ok_ms = CASE WHEN ?6 IS NULL THEN ?5 ELSE last_ok_ms END, last_error = ?6,
                   backfilled_ms = COALESCE(backfilled_ms, ?7)
                 WHERE repo = ?1",
                params![remote, branch, now, head, now, error, since],
            )?;
            Ok(())
        })
        .map_err(store_err)?;
    Ok(n)
}

/// The Changes the train merged, by their merge sha: one each, or a batch's members.
fn merged_by_sha(db: &HubDb) -> Result<HashMap<String, Vec<Change>>, StoreError> {
    db.with(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT lower(json_extract(data, '$.mergedSha')), data FROM changes
             WHERE state = 'merged' AND json_extract(data, '$.mergedSha') IS NOT NULL ORDER BY n",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let mut out: HashMap<String, Vec<Change>> = HashMap::new();
        for row in rows {
            let (sha, data) = row?;
            if let Ok(change) = serde_json::from_str(&data) {
                out.entry(sha).or_default().push(change);
            }
        }
        Ok(out)
    })
}

/// A `Fleetd-Change` trailer's parts: "X12 (T45, W9)" → ("X12", Some("T45"), Some("W9")).
pub fn change_trailer(value: &str) -> Option<(String, Option<String>, Option<String>)> {
    let mut words = value
        .split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | ','))
        .filter(|w| !w.is_empty());
    let id = words.next().filter(|w| numbered(w, 'X'))?.to_owned();
    let (mut task, mut ws) = (None, None);
    for w in words {
        if numbered(w, 'T') {
            task.get_or_insert_with(|| w.to_owned());
        } else if numbered(w, 'W') {
            ws.get_or_insert_with(|| w.to_owned());
        }
    }
    Some((id, task, ws))
}

fn numbered(word: &str, prefix: char) -> bool {
    word.strip_prefix(prefix).is_some_and(|n| {
        !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
    })
}

/// The PR a merge commit's subject names: "Merge pull request #12 from …" (GitHub), "Merge pull request 'Fix' (#12)
/// from …" (Gitea).
fn subject_pr(subject: &str) -> Option<i64> {
    let digits = |s: &str| -> Option<i64> {
        let n: String = s.chars().take_while(char::is_ascii_digit).collect();
        n.parse().ok().filter(|n| *n > 0)
    };
    if let Some(rest) = subject.strip_prefix("Merge pull request #") {
        return digits(rest);
    }
    let at = subject.rfind("(#")? + 2;
    let n = digits(&subject[at..])?;
    subject[at..]
        .trim_start_matches(|c: char| c.is_ascii_digit())
        .starts_with(')')
        .then_some(n)
}

/// The fleetd branch a merge commit's subject names: "Merge pull request #12 from acme/fleetd/T45-x", "Merge branch
/// 'fleetd/T45-x'".
fn subject_task(subject: &str) -> Option<String> {
    let at = subject.find("fleetd/")?;
    branch_task(&subject[at..])
}

/// A merge of the default branch into itself: `git pull` on it, "Merge branch 'main' of host:repo".
fn is_sync(subject: &str, branch: &str) -> bool {
    subject.starts_with(&format!("Merge branch '{branch}' of "))
        || (subject.starts_with("Merge remote-tracking branch '")
            && subject.contains(&format!("/{branch}'")))
}

/// The route-free fields every row from git has.
fn base_row(remote: &str, c: &GitCommit, owner: &Option<(String, String)>) -> MergeRow {
    let (machine_id, project_id) = owner.clone().unzip();
    MergeRow {
        repo: remote.to_owned(),
        unit_key: format!("commit:{}", c.sha),
        machine_id,
        project_id,
        merged_ms: c.at_ms,
        merged_sha: Some(c.sha.to_lowercase()),
        title: Some(c.subject.clone()).filter(|t| !t.is_empty()),
        src: "git".into(),
        ..MergeRow::default()
    }
}

/// Fills a fleetd row's order: its workstream and when it was asked for.
fn with_order(
    db: &HubDb,
    row: &mut MergeRow,
    workstream: Option<String>,
) -> Result<(), StoreError> {
    let workstream = match (workstream, &row.task_id) {
        (Some(w), _) => Some(w),
        (None, Some(t)) => project::task_workstream(db, t)?,
        (None, None) => None,
    };
    if let Some(w) = workstream
        .as_deref()
        .map(|w| project::workstream(db, w))
        .transpose()?
        .flatten()
    {
        let r = requested::get(db, &w)?;
        row.requested_ms = Some(r.at_ms);
        row.requested_basis = Some(r.basis.as_str().to_owned());
    }
    row.workstream_id = workstream;
    Ok(())
}

/// The train's row for one Change a commit landed.
fn train_row(
    db: &HubDb,
    base: &MergeRow,
    id: &str,
    change: Option<Change>,
    task: Option<String>,
    workstream: Option<String>,
) -> Result<MergeRow, StoreError> {
    let mut row = MergeRow {
        unit_key: change
            .as_ref()
            .map_or_else(|| format!("change:{id}"), |c| format!("pr:{}", c.pr_number)),
        route: MergeRoute::Train.as_str().into(),
        change_id: Some(id.to_owned()),
        merged_by_kind: Some(
            project::actor_str(fleetd_contracts::metrics::ActorKind::Train).into(),
        ),
        ..base.clone()
    };
    if let Some(c) = &change {
        row.pr_number = Some(c.pr_number.get());
        row.url = Some(c.pr_url.to_string());
        row.first_pr_ms = crate::hub::store::parse_ms(c.created_at.as_str());
        row.machine_id = Some(c.project_ref.machine_id.to_string());
        row.project_id = Some(c.project_ref.project_id.to_string());
    }
    row.task_id = change
        .as_ref()
        .and_then(|c| c.task_id.as_ref().map(|t| t.to_string()))
        .or(task);
    let workstream = change
        .as_ref()
        .map(|c| c.workstream_id.to_string())
        .or(workstream);
    with_order(db, &mut row, workstream)?;
    Ok(row)
}

/// The rows the default branch's line makes, newest first, as the module's rules route them.
pub fn rows(
    db: &HubDb,
    remote: &str,
    branch: &str,
    owner: Option<(String, String)>,
    commits: &[GitCommit],
) -> Result<Vec<MergeRow>, StoreError> {
    let mut out = Vec::new();
    // The task of the last commit when it was one of a task's by hand: the commits after it in a row are the same
    // rebase.
    let mut run: Option<Vec<String>> = None;
    let mut landed = merged_by_sha(db)?;
    for c in commits {
        let base = base_row(remote, c, &owner);
        let merge = c.parents.len() > 1;
        let by_trailer: Vec<_> = c.changes.iter().filter_map(|v| change_trailer(v)).collect();
        if !by_trailer.is_empty() {
            run = None;
            for (id, task, ws) in by_trailer {
                let change = project::change(db, &id)?;
                out.push(train_row(db, &base, &id, change, task, ws)?);
            }
            continue;
        }
        if let Some(merged) = landed.remove(&c.sha.to_lowercase()) {
            run = None;
            for change in merged {
                let id = change.change_id.to_string();
                out.push(train_row(db, &base, &id, Some(change), None, None)?);
            }
            continue;
        }
        if !merge && !c.tasks.is_empty() && run.as_ref() == Some(&c.tasks) {
            continue;
        }
        run = None;
        let mut row = base;
        if c.author_name.ends_with("[bot]") {
            row.route = SKIPPED.into();
            row.skip_why = Some(skip_str(SkipWhy::Bot).into());
            row.author_kind = Some("bot".into());
        } else if merge && is_sync(&c.subject, branch) {
            row.route = SKIPPED.into();
            row.skip_why = Some(skip_str(SkipWhy::MergeBack).into());
        } else {
            let task = if merge {
                c.merged_tasks
                    .first()
                    .cloned()
                    .or_else(|| subject_task(&c.subject))
                    .or_else(|| c.tasks.first().cloned())
            } else {
                c.tasks.first().cloned()
            };
            row.pr_number = merge.then(|| subject_pr(&c.subject)).flatten();
            row.route = match (&task, merge) {
                (Some(_), _) => MergeRoute::FleetdByHand,
                (None, true) => MergeRoute::Outside,
                (None, false) => MergeRoute::Direct,
            }
            .as_str()
            .into();
            if task.is_some() {
                row.task_id = task;
                with_order(db, &mut row, None)?;
                if !merge {
                    run = Some(c.tasks.clone());
                }
            }
        }
        out.push(row);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailers_and_subjects_name_changes_tasks_and_prs() {
        assert_eq!(
            change_trailer("X12 (T45, W9)"),
            Some(("X12".into(), Some("T45".into()), Some("W9".into())))
        );
        assert_eq!(
            change_trailer("X3 (W1)"),
            Some(("X3".into(), None, Some("W1".into())))
        );
        assert_eq!(change_trailer("T4"), None);
        assert_eq!(
            subject_pr("Merge pull request #12 from acme/fleetd/T45-x"),
            Some(12)
        );
        assert_eq!(
            subject_pr("Merge pull request 'Fix totals' (#7) from fix into main"),
            Some(7)
        );
        assert_eq!(subject_pr("Merge branch 'fix (#7x)'"), None);
        assert_eq!(subject_pr("Merge branch 'feature'"), None);
        assert_eq!(
            subject_task("Merge pull request #12 from acme/fleetd/T45-x").as_deref(),
            Some("T45")
        );
        assert!(is_sync(
            "Merge branch 'main' of git.internal:srv/web",
            "main"
        ));
        assert!(is_sync(
            "Merge remote-tracking branch 'origin/main'",
            "main"
        ));
        assert!(!is_sync("Merge branch 'feature'", "main"));
    }
}
