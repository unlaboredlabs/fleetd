//! Reviews and comments the person left on a repo's git host, as touches. The host sweep reads them through
//! [`HostActs`] (GitHub first) and calls [`read`] per repo. A review's
//! credit is estimated and marked so. A touch on a PR fleetd wrote (a Change's, or a `fleetd/` head) counts toward
//! minutes through fleetd; one on any other PR toward the outside figure.
use fleetd_contracts::metrics::TouchKind;
use rusqlite::{Connection, OptionalExtension, params};

use super::human;
use super::store::{self, TouchRow};
use crate::hub::store::{HubDb, StoreError};
use crate::hub::usage::ports::BoxFut;

/// The first read of a repo goes this far back.
pub const BACKFILL_MS: i64 = 90 * store::DAY_MS;
/// The branches fleetd's write tasks push.
const FLEETD_BRANCH: &str = "fleetd/";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostActKind {
    /// A review submitted (approve, request changes or comment).
    Review,
    /// A review comment or a PR comment.
    Comment,
}

/// One review or comment, as the host recorded it.
#[derive(Clone, Debug, PartialEq)]
pub struct HostAct {
    pub kind: HostActKind,
    /// The host's id for it, unique in the repo for its kind.
    pub id: String,
    pub pr_number: i64,
    /// When it was submitted.
    pub at_ms: i64,
    pub login: Option<String>,
    /// Left by a bot account: not a touch.
    pub bot: bool,
    /// The PR's head branch, when the host said.
    pub head: Option<String>,
    /// The PR's changed lines (additions + deletions), for a review's credit.
    pub lines: Option<i64>,
}

/// Reads a repo's reviews and comments. `repo` is the metrics' remote key ("github.com/acme/web").
pub trait HostActs: Send + Sync {
    /// Every review and comment submitted at or after `since_ms`; `Err` says why the host could not be read.
    fn acts_since<'a>(
        &'a self,
        repo: &'a str,
        since_ms: i64,
    ) -> BoxFut<'a, Result<Vec<HostAct>, String>>;
}

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("the git host was not read: {0}")]
    Host(String),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Reads `repo`'s acts since its cursor (90 days back the first time), writes the people's as touches and moves the
/// cursor to `now_ms`. The repo must be one the metrics know. Returns how many touches were written.
pub async fn read(
    db: &HubDb,
    reader: &dyn HostActs,
    repo: &str,
    now_ms: i64,
) -> Result<usize, ReadError> {
    let since = db
        .with(|c| store::reviews_cursor(c, repo))?
        .unwrap_or(now_ms - BACKFILL_MS);
    let acts = reader
        .acts_since(repo, since)
        .await
        .map_err(ReadError::Host)?;
    let written = db.transaction(|c| {
        let mut n = 0;
        for act in acts.iter().filter(|a| !a.bot) {
            store::upsert_touch(c, &touch(c, repo, act)?)?;
            n += 1;
        }
        store::set_reviews_cursor(c, repo, now_ms)?;
        Ok(n)
    })?;
    Ok(written)
}

/// The order a PR belongs to and the project that owns it, when fleetd wrote it: its Change's, or the task its
/// `fleetd/T<n>-…` head names, or a landed change already routed as fleetd's.
#[derive(Default)]
struct Owner {
    fleetd: bool,
    workstream_id: Option<String>,
    project: Option<(String, String)>,
}

fn owner(c: &Connection, repo: &str, pr: i64, head: Option<&str>) -> Result<Owner, StoreError> {
    if let Some(train_repo) = store::train_repo(repo) {
        let change: Option<(Option<String>, String, String)> = c
            .query_row(
                "SELECT json_extract(data, '$.workstreamId'), machine_id, project_id FROM changes
                 WHERE repo = ?1 AND pr_number = ?2 ORDER BY n DESC LIMIT 1",
                params![train_repo.to_lowercase(), pr],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((w, m, p)) = change {
            return Ok(Owner {
                fleetd: true,
                workstream_id: w,
                project: Some((m, p)),
            });
        }
    }
    let task = head
        .and_then(|h| h.strip_prefix(FLEETD_BRANCH))
        .and_then(|rest| rest.strip_prefix('T'))
        .map(|rest| {
            rest.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        })
        .and_then(|n| n.parse::<i64>().ok());
    let landed = c
        .query_row(
            "SELECT route, workstream_id, machine_id, project_id FROM metric_merges WHERE repo = ?1 AND unit_key = ?2",
            params![repo, format!("pr:{pr}")],
            |r| {
                let route: String = r.get(0)?;
                Ok(Owner {
                    fleetd: route == "train" || route == "fleetd_by_hand",
                    workstream_id: r.get(1)?,
                    project: r
                        .get::<_, Option<String>>(2)?
                        .zip(r.get::<_, Option<String>>(3)?),
                })
            },
        )
        .optional()?
        .unwrap_or_default();
    if let Some(n) = task {
        let t: Option<(String, String, String)> = c
            .query_row(
                "SELECT workstream_id, machine_id, project_id FROM tasks WHERE n = ?1",
                [n],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        return Ok(Owner {
            fleetd: true,
            workstream_id: t.as_ref().map(|t| t.0.clone()),
            project: t.map(|t| (t.1, t.2)).or(landed.project),
        });
    }
    Ok(landed)
}

fn touch(c: &Connection, repo: &str, act: &HostAct) -> Result<TouchRow, StoreError> {
    let (kind, credit) = match act.kind {
        HostActKind::Review => (TouchKind::Review, human::review_ms(act.lines)),
        HostActKind::Comment => (TouchKind::Comment, human::COMMENT_MS),
    };
    let owner = owner(c, repo, act.pr_number, act.head.as_deref())?;
    let (machine_id, project_id) = owner.project.unzip();
    Ok(TouchRow {
        src: "host".into(),
        src_key: format!("{repo}#{}:{}", kind.as_str(), act.id),
        kind: kind.as_str().into(),
        at_ms: act.at_ms,
        credit_ms: credit,
        end_ms: None,
        machine_id,
        project_id,
        repo: Some(repo.to_owned()),
        workstream_id: owner.workstream_id,
        pr_number: Some(act.pr_number),
        key_id: act.login.clone(),
        estimated: true,
        outside: !owner.fleetd,
    })
}
