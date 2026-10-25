//! The metrics tables: landed changes (idempotent on `(repo, unit_key)`), when each Change passed review, each
//! repo's read state, retention and reads. Writes run inside the caller's transaction.
use rusqlite::{Connection, OptionalExtension, params};

use crate::hub::store::StoreError;

/// Landed changes and touches outlive the event log and spans: as long as the time roll-ups by default.
pub const DEFAULT_RETENTION_DAYS: i64 = crate::hub::time::store::ROLLUP_DAYS;
pub const PRUNE_BATCH: i64 = 5_000;
pub const DAY_MS: i64 = 86_400_000;
/// In `time_settings`, beside the span retention.
const RETENTION_KEY: &str = "metrics_retention_days";
/// In `time_cursors`: the event log's oldest event when the projector first ran. Merges are known from there on.
pub const KNOWN_SINCE: &str = "metrics:known_since";

/// The repo key of a train's GitHub repo ("acme/web"): its remote, host first ("github.com/acme/web").
pub fn github_remote(repo: &str) -> String {
    format!("github.com/{}", repo.to_lowercase())
}

/// The train's repo of a GitHub remote, the inverse of [`github_remote`].
pub fn train_repo(remote: &str) -> Option<&str> {
    remote.strip_prefix("github.com/")
}

pub fn retention_days(conn: &Connection) -> Result<i64, StoreError> {
    let v: Option<i64> = conn
        .query_row(
            "SELECT value FROM time_settings WHERE key = ?1",
            [RETENTION_KEY],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v.unwrap_or(DEFAULT_RETENTION_DAYS))
}

pub fn set_retention_days(conn: &Connection, days: i64) -> Result<(), StoreError> {
    conn.execute(
        "INSERT INTO time_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![RETENTION_KEY, days],
    )?;
    Ok(())
}

/// Deletes up to [`PRUNE_BATCH`] landed changes and touches older than the retention; true when there may be more.
pub fn prune(conn: &Connection, now_ms: i64) -> Result<bool, StoreError> {
    let cutoff = now_ms - retention_days(conn)? * DAY_MS;
    let merges = conn.execute(
        "DELETE FROM metric_merges WHERE (repo, unit_key) IN
           (SELECT repo, unit_key FROM metric_merges WHERE merged_ms < ?1 ORDER BY merged_ms LIMIT ?2)",
        params![cutoff, PRUNE_BATCH],
    )? as i64;
    let touches = conn.execute(
        "DELETE FROM metric_touches WHERE id IN (SELECT id FROM metric_touches WHERE at_ms < ?1 ORDER BY at_ms LIMIT ?2)",
        params![cutoff, PRUNE_BATCH],
    )? as i64;
    // A Change's stamp is read when it lands; one older than the retention would land outside every range.
    conn.execute(
        "DELETE FROM metric_changes WHERE review_passed_ms < ?1",
        [cutoff],
    )?;
    Ok(merges == PRUNE_BATCH || touches == PRUNE_BATCH)
}

/// One landed change (or a skipped merge) as the projector or a sweep saw it. `None` leaves a stored value as it is.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MergeRow {
    pub repo: String,
    pub unit_key: String,
    pub machine_id: Option<String>,
    pub project_id: Option<String>,
    pub pr_number: Option<i64>,
    pub merged_ms: i64,
    pub merged_sha: Option<String>,
    /// `MergeRoute::as_str`, or "skipped" with `skip_why`.
    pub route: String,
    pub skip_why: Option<String>,
    pub workstream_id: Option<String>,
    pub task_id: Option<String>,
    pub change_id: Option<String>,
    pub batch_pr: Option<i64>,
    pub requested_ms: Option<i64>,
    pub requested_basis: Option<String>,
    pub pr_created_ms: Option<i64>,
    pub first_pr_ms: Option<i64>,
    pub review_passed_ms: Option<i64>,
    pub author_kind: Option<String>,
    pub merged_by_kind: Option<String>,
    pub additions: Option<i64>,
    pub deletions: Option<i64>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub seen_claim: Option<String>,
    pub src: String,
}

pub const SKIPPED: &str = "skipped";

/// Writes a landed change. The train's word is final: a row it wrote keeps route `train` whatever reports the same
/// PR later. Other fields fill in; a later report's value wins over an earlier one's.
pub fn upsert_merge(conn: &Connection, m: &MergeRow) -> Result<(), StoreError> {
    conn.prepare_cached(
        "INSERT INTO metric_merges (repo, unit_key, machine_id, project_id, pr_number, merged_ms, merged_sha, route,
           skip_why, workstream_id, task_id, change_id, batch_pr, requested_ms, requested_basis, pr_created_ms,
           first_pr_ms, review_passed_ms, author_kind, merged_by_kind, additions, deletions, title, url, seen_claim, src)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22,
           ?23, ?24, ?25, ?26)
         ON CONFLICT(repo, unit_key) DO UPDATE SET
           route = CASE WHEN metric_merges.route = 'train' THEN 'train' ELSE excluded.route END,
           skip_why = CASE WHEN metric_merges.route = 'train' THEN NULL ELSE excluded.skip_why END,
           merged_ms = CASE WHEN metric_merges.route = 'train' AND excluded.route <> 'train' THEN metric_merges.merged_ms
             ELSE excluded.merged_ms END,
           machine_id = COALESCE(excluded.machine_id, machine_id),
           project_id = COALESCE(excluded.project_id, project_id),
           pr_number = COALESCE(excluded.pr_number, pr_number),
           merged_sha = COALESCE(excluded.merged_sha, merged_sha),
           workstream_id = COALESCE(excluded.workstream_id, workstream_id),
           task_id = COALESCE(excluded.task_id, task_id),
           change_id = COALESCE(excluded.change_id, change_id),
           batch_pr = COALESCE(excluded.batch_pr, batch_pr),
           requested_ms = COALESCE(excluded.requested_ms, requested_ms),
           requested_basis = COALESCE(excluded.requested_basis, requested_basis),
           pr_created_ms = COALESCE(excluded.pr_created_ms, pr_created_ms),
           first_pr_ms = COALESCE(excluded.first_pr_ms, first_pr_ms),
           review_passed_ms = COALESCE(excluded.review_passed_ms, review_passed_ms),
           author_kind = COALESCE(excluded.author_kind, author_kind),
           merged_by_kind = CASE WHEN metric_merges.route = 'train' THEN metric_merges.merged_by_kind
             ELSE COALESCE(excluded.merged_by_kind, merged_by_kind) END,
           additions = COALESCE(excluded.additions, additions),
           deletions = COALESCE(excluded.deletions, deletions),
           title = COALESCE(excluded.title, title),
           url = COALESCE(excluded.url, url),
           seen_claim = COALESCE(excluded.seen_claim, seen_claim),
           src = excluded.src",
    )?
    .execute(params![
        m.repo,
        m.unit_key,
        m.machine_id,
        m.project_id,
        m.pr_number,
        m.merged_ms,
        m.merged_sha,
        m.route,
        m.skip_why,
        m.workstream_id,
        m.task_id,
        m.change_id,
        m.batch_pr,
        m.requested_ms,
        m.requested_basis,
        m.pr_created_ms,
        m.first_pr_ms,
        m.review_passed_ms,
        m.author_kind,
        m.merged_by_kind,
        m.additions,
        m.deletions,
        m.title,
        m.url,
        m.seen_claim,
        m.src,
    ])?;
    Ok(())
}

/// A repo the metrics read, created on first sight.
pub fn see_repo(conn: &Connection, repo: &str, host: &str) -> Result<(), StoreError> {
    conn.prepare_cached("INSERT OR IGNORE INTO metric_repos (repo, host) VALUES (?1, ?2)")?
        .execute(params![repo, host])?;
    Ok(())
}

/// When a Change first passed review (its first `change.state` move to `ready`): the earliest kept, so a replay or a
/// bounce back to ready changes nothing. A Change that already landed takes it too.
pub fn stamp_review(conn: &Connection, change_id: &str, at_ms: i64) -> Result<(), StoreError> {
    conn.prepare_cached(
        "INSERT INTO metric_changes (change_id, review_passed_ms) VALUES (?1, ?2)
         ON CONFLICT(change_id) DO UPDATE SET review_passed_ms = MIN(review_passed_ms, excluded.review_passed_ms)",
    )?
    .execute(params![change_id, at_ms])?;
    conn.prepare_cached(
        "UPDATE metric_merges SET review_passed_ms = (SELECT review_passed_ms FROM metric_changes WHERE change_id = ?1)
         WHERE change_id = ?1 AND review_passed_ms IS NULL",
    )?
    .execute([change_id])?;
    Ok(())
}

/// When a Change first passed review, if that was seen.
pub fn review_passed(conn: &Connection, change_id: &str) -> Result<Option<i64>, StoreError> {
    Ok(conn
        .prepare_cached("SELECT review_passed_ms FROM metric_changes WHERE change_id = ?1")?
        .query_row([change_id], |r| r.get(0))
        .optional()?)
}

/// Gives an order's landed changes its request time once it is known.
pub fn set_requested(
    conn: &Connection,
    workstream_id: &str,
    at_ms: i64,
    basis: &str,
) -> Result<(), StoreError> {
    conn.prepare_cached(
        "UPDATE metric_merges SET requested_ms = ?2, requested_basis = ?3
         WHERE workstream_id = ?1 AND requested_ms IS NULL",
    )?
    .execute(params![workstream_id, at_ms, basis])?;
    Ok(())
}

/// Every stored row with `merged_ms` in `[since, until)`, in `repos` when given.
pub fn merges(
    conn: &Connection,
    since_ms: i64,
    until_ms: i64,
    repos: Option<&[String]>,
) -> Result<Vec<MergeRow>, StoreError> {
    let repos = repos.map(serde_json::to_string).transpose()?;
    let mut stmt = conn.prepare_cached(
        "SELECT repo, unit_key, machine_id, project_id, pr_number, merged_ms, merged_sha, route, skip_why,
           workstream_id, task_id, change_id, batch_pr, requested_ms, requested_basis, pr_created_ms, first_pr_ms,
           review_passed_ms, author_kind, merged_by_kind, additions, deletions, title, url, seen_claim, src
         FROM metric_merges
         WHERE merged_ms >= ?1 AND merged_ms < ?2 AND (?3 IS NULL OR repo IN (SELECT value FROM json_each(?3)))
         ORDER BY merged_ms DESC, repo, unit_key",
    )?;
    let rows = stmt
        .query_map(params![since_ms, until_ms, repos], |r| {
            Ok(MergeRow {
                repo: r.get(0)?,
                unit_key: r.get(1)?,
                machine_id: r.get(2)?,
                project_id: r.get(3)?,
                pr_number: r.get(4)?,
                merged_ms: r.get(5)?,
                merged_sha: r.get(6)?,
                route: r.get(7)?,
                skip_why: r.get(8)?,
                workstream_id: r.get(9)?,
                task_id: r.get(10)?,
                change_id: r.get(11)?,
                batch_pr: r.get(12)?,
                requested_ms: r.get(13)?,
                requested_basis: r.get(14)?,
                pr_created_ms: r.get(15)?,
                first_pr_ms: r.get(16)?,
                review_passed_ms: r.get(17)?,
                author_kind: r.get(18)?,
                merged_by_kind: r.get(19)?,
                additions: r.get(20)?,
                deletions: r.get(21)?,
                title: r.get(22)?,
                url: r.get(23)?,
                seen_claim: r.get(24)?,
                src: r.get(25)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// A repo's read state.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RepoRow {
    pub repo: String,
    /// `GitHost` as stored: "github", "gitlab", ... or "git".
    pub host: String,
    pub default_branch: Option<String>,
    pub last_ok_ms: Option<i64>,
    pub last_error: Option<String>,
    pub backfilled_ms: Option<i64>,
}

pub fn repos(conn: &Connection) -> Result<Vec<RepoRow>, StoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT repo, host, default_branch, last_ok_ms, last_error, backfilled_ms FROM metric_repos ORDER BY repo",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(RepoRow {
                repo: r.get(0)?,
                host: r.get(1)?,
                default_branch: r.get(2)?,
                last_ok_ms: r.get(3)?,
                last_error: r.get(4)?,
                backfilled_ms: r.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// One act by the person, as the projector or a git host read saw it. Idempotent on `(src, src_key)`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TouchRow {
    /// Where it was read: "chat", "request", "steer", "decision", "order", "merge" or "host".
    pub src: String,
    pub src_key: String,
    /// `TouchKind::as_str`.
    pub kind: String,
    /// When the act was recorded; the act itself took the `credit_ms` before it.
    pub at_ms: i64,
    pub credit_ms: i64,
    /// An interval observed as it is (app use): `[at_ms, end_ms]`, and the credit is its length.
    pub end_ms: Option<i64>,
    pub machine_id: Option<String>,
    pub project_id: Option<String>,
    pub repo: Option<String>,
    pub workstream_id: Option<String>,
    pub pr_number: Option<i64>,
    /// The name of the key that made it.
    pub key_id: Option<String>,
    /// The credit is estimated from a floor (reviews), not observed.
    pub estimated: bool,
    /// On work fleetd didn't write: it counts toward the outside figure.
    pub outside: bool,
}

/// Writes a touch; a later read of the same act replaces what an earlier one said.
pub fn upsert_touch(conn: &Connection, t: &TouchRow) -> Result<(), StoreError> {
    conn.prepare_cached(
        "INSERT INTO metric_touches (src, src_key, kind, at_ms, credit_ms, end_ms, machine_id, project_id, repo,
           workstream_id, pr_number, key_id, estimated, outside)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(src, src_key) DO UPDATE SET kind = excluded.kind, at_ms = excluded.at_ms,
           credit_ms = excluded.credit_ms, end_ms = excluded.end_ms,
           machine_id = COALESCE(excluded.machine_id, machine_id),
           project_id = COALESCE(excluded.project_id, project_id), repo = COALESCE(excluded.repo, repo),
           workstream_id = COALESCE(excluded.workstream_id, workstream_id),
           pr_number = COALESCE(excluded.pr_number, pr_number), key_id = COALESCE(excluded.key_id, key_id),
           estimated = excluded.estimated, outside = excluded.outside",
    )?
    .execute(params![
        t.src,
        t.src_key,
        t.kind,
        t.at_ms,
        t.credit_ms,
        t.end_ms,
        t.machine_id,
        t.project_id,
        t.repo,
        t.workstream_id,
        t.pr_number,
        t.key_id,
        t.estimated,
        t.outside,
    ])?;
    Ok(())
}

/// Every touch recorded in `[since, until)`, oldest first.
pub fn touches(
    conn: &Connection,
    since_ms: i64,
    until_ms: i64,
) -> Result<Vec<TouchRow>, StoreError> {
    let mut stmt = conn.prepare_cached(
        "SELECT src, src_key, kind, at_ms, credit_ms, end_ms, machine_id, project_id, repo, workstream_id, pr_number,
           key_id, estimated, outside
         FROM metric_touches WHERE at_ms >= ?1 AND at_ms < ?2 ORDER BY at_ms, id",
    )?;
    let rows = stmt
        .query_map(params![since_ms, until_ms], |r| {
            Ok(TouchRow {
                src: r.get(0)?,
                src_key: r.get(1)?,
                kind: r.get(2)?,
                at_ms: r.get(3)?,
                credit_ms: r.get(4)?,
                end_ms: r.get(5)?,
                machine_id: r.get(6)?,
                project_id: r.get(7)?,
                repo: r.get(8)?,
                workstream_id: r.get(9)?,
                pr_number: r.get(10)?,
                key_id: r.get(11)?,
                estimated: r.get(12)?,
                outside: r.get(13)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Where a repo's reviews and comments were last read up to.
pub fn reviews_cursor(conn: &Connection, repo: &str) -> Result<Option<i64>, StoreError> {
    Ok(conn
        .prepare_cached("SELECT reviews_cursor_ms FROM metric_repos WHERE repo = ?1")?
        .query_row([repo], |r| r.get(0))
        .optional()?
        .flatten())
}

pub fn set_reviews_cursor(conn: &Connection, repo: &str, at_ms: i64) -> Result<(), StoreError> {
    conn.prepare_cached(
        "UPDATE metric_repos SET reviews_cursor_ms = MAX(COALESCE(reviews_cursor_ms, 0), ?2) WHERE repo = ?1",
    )?
    .execute(params![repo, at_ms])?;
    Ok(())
}

/// The person's own git host logins and emails, lowercased: only their reviews, comments and merges are their time.
pub fn identities(conn: &Connection) -> Result<Vec<String>, StoreError> {
    let mut stmt =
        conn.prepare_cached("SELECT identity FROM metric_identities ORDER BY identity")?;
    let rows = stmt
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Records one of the person's identities; `src` says where it was learned (the host's signed-in login, a setting).
pub fn add_identity(conn: &Connection, identity: &str, src: &str) -> Result<(), StoreError> {
    conn.prepare_cached(
        "INSERT INTO metric_identities (identity, src) VALUES (?1, ?2)
         ON CONFLICT(identity) DO UPDATE SET src = excluded.src",
    )?
    .execute(params![identity.trim().to_lowercase(), src])?;
    Ok(())
}
