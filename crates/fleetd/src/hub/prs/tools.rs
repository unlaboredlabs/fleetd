//! pr_list, pr_get, pr_files and pr_diff. All read-only.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    ErrorCode, PrDiffInput, PrDiffOutput, PrFilesInput, PrFilesOutput, PrGetInput, PrGetOutput,
    PrListInput, PrListOutput,
};
use fleetd_contracts::prim::{List, NonEmpty, Text};
use fleetd_contracts::prs::{PR_FILES_PAGE, PR_LIST_MAX, PrLinks, PrReviewEntry, PrRow};
use fleetd_contracts::train::{Change, GitHubRepo};
use fleetd_contracts::verification::CommitSha;

use super::github::{GhDetail, GhPull, PrsGitHub};
use super::join::{self, RowCtx, RowKey};
use crate::hub::api::{Caller, Hub, Registry, ToolError, clip, require, unknown_project};
use crate::hub::executor::shell_mapper::normalize_iso;
use crate::hub::redact::redact;
use crate::hub::store::{iso_ms, now_ms};

pub fn register(tools: &mut Registry) {
    tools.add("pr_list", pr_list);
    tools.add("pr_get", pr_get);
    tools.add("pr_files", pr_files);
    tools.add("pr_diff", pr_diff);
}

fn error_text(error: Option<String>) -> Option<Text<0, 300>> {
    error.map(|e| Text::unchecked(clip(&e, 300)))
}

/// GitHub pages a Load more reads at most, past the first of each list. The first page reads none past those: it
/// costs one read per list, as the list did before it paged.
const MAX_PAGES: usize = 40;

/// One of GitHub's lists a page is drawn from: a repo's open PRs or its closed ones, as far as read.
struct Source {
    repo: GitHubRepo,
    closed: bool,
    pulls: Vec<GhPull>,
    /// The cursor of its next page; none once it is read to the end (or could not be read).
    next: Option<String>,
}

impl Source {
    /// The key past which its unread PRs sort, while it has any.
    fn frontier(&self) -> Option<RowKey> {
        self.next.as_ref()?;
        self.pulls.last().map(|p| join::pull_key(&self.repo, p))
    }
}

/// One page of rows from GitHub's lists of `repos` and fleetd's `changes`: those past `after` (all, without it) that no
/// unread PR can sort before. The first page reads each list's first GitHub page only; a later one reads on until
/// there is a page of rows or nothing left to read.
pub async fn list_page(
    github: &PrsGitHub,
    repos: &[GitHubRepo],
    changes: &[Change],
    closed_since: &str,
    ctx: &RowCtx<'_>,
    after: Option<&RowKey>,
) -> ListPage {
    let mut error = None;
    let mut sources = Vec::new();
    for repo in repos {
        for closed in [false, true] {
            let read = github.page(repo, closed, None).await;
            error = error.or(read.error);
            let page = read.value.as_deref().cloned().unwrap_or_default();
            sources.push(Source {
                repo: repo.clone(),
                closed,
                pulls: page.pulls,
                next: page.next,
            });
        }
    }
    // Rows past the cursor that no unread PR can sort before, read on until there is a page of them or nothing left.
    let max_pages = if after.is_some() { MAX_PAGES } else { 0 };
    let mut pages = 0;
    let (rows, more) = loop {
        for s in sources.iter_mut().filter(|s| s.closed) {
            // Closed lists go by update, which is never before the close: past closedSince nothing more is shown.
            if s.frontier().is_some_and(|f| f.1.as_str() < closed_since) {
                s.next = None;
            }
        }
        let pulls: Vec<_> = sources
            .iter()
            .flat_map(|s| s.pulls.iter().map(|p| (s.repo.clone(), p.clone())))
            .collect();
        let (all, _) = join::rows(&pulls, changes, closed_since, ctx, usize::MAX);
        let after_cursor: Vec<_> = all
            .into_iter()
            .filter(|r| after.is_none_or(|a| &join::row_key(r) < a))
            .collect();
        let blocking = sources
            .iter_mut()
            .filter(|s| s.frontier().is_some())
            .max_by_key(|s| s.frontier());
        let safe = match &blocking {
            None => after_cursor.len(),
            Some(s) => {
                let frontier = s.frontier();
                after_cursor
                    .iter()
                    .take_while(|r| Some(join::row_key(r)) >= frontier)
                    .count()
            }
        };
        let Some(source) = blocking.filter(|_| safe <= PR_LIST_MAX && pages < max_pages) else {
            let more = after_cursor.len() > safe.min(PR_LIST_MAX)
                || sources.iter().any(|s| s.next.is_some());
            let mut rows = after_cursor;
            rows.truncate(safe.min(PR_LIST_MAX));
            break (rows, more);
        };
        pages += 1;
        let read = github
            .page(&source.repo, source.closed, source.next.as_deref())
            .await;
        match read.value.filter(|_| read.error.is_none()) {
            Some(page) => {
                source.pulls.extend(page.pulls.iter().cloned());
                source.next = page.next.clone();
            }
            None => {
                error = error.or(read.error);
                source.next = None;
            }
        }
    };
    ListPage { rows, more, error }
}

/// A page of rows; `more` when there are rows past it.
pub struct ListPage {
    pub rows: Vec<PrRow>,
    pub more: bool,
    pub error: Option<String>,
}

async fn pr_list(
    hub: Arc<Hub>,
    caller: Caller,
    input: PrListInput,
) -> Result<PrListOutput, ToolError> {
    let project = &input.project_ref;
    require(&caller, Role::Read, Some(&project.machine_id))?;
    if hub.store.project_get(project)?.is_none() {
        return Err(unknown_project(project));
    }
    let now = now_ms(hub.clock.as_ref());
    // No closedSince: every PR, so later pages reach the oldest.
    let closed_since = input
        .closed_since
        .as_ref()
        .map(|t| normalize_iso(&t.0))
        .unwrap_or_default();
    let after = input
        .cursor
        .as_ref()
        .map(|c| {
            join::key_of_cursor(c.as_str()).ok_or_else(|| {
                ToolError::new(ErrorCode::Invalid, "That cursor is not one pr_list gave.").with_fix(
                    "Pass a page's nextCursor as it came, or leave cursor out for the first page.",
                )
            })
        })
        .transpose()?;
    let changes = super::project_changes(&hub, project);
    let repos = super::project_repos(&hub, project, &changes);
    let tasks = super::project_tasks(&hub, project);
    let mut ctx = RowCtx::with_tasks(&tasks);
    super::fill_ctx(&hub, &mut ctx, &repos);
    let page = list_page(
        &hub.prs.github,
        &repos,
        &changes,
        &closed_since,
        &ctx,
        after.as_ref(),
    )
    .await;
    let (rows, more, error) = (page.rows, page.more, page.error);
    let next_cursor = rows
        .last()
        .filter(|_| more)
        .map(|r| Text::unchecked(join::cursor_of(&join::row_key(r))));
    Ok(PrListOutput {
        prs: List::unchecked(rows),
        next_cursor,
        github_error: error_text(error),
        at: iso_ms(now).into(),
        next: Some("pr_get with a row's repo and number reads it in full.".into()),
        truncated: more.then_some(true),
    })
}

/// The project whose PRs `repo` holds, refused unless the key may read it.
fn owner(hub: &Hub, caller: &Caller, repo: &GitHubRepo) -> Result<ProjectRef, ToolError> {
    let project = super::owner_of(hub, repo).ok_or_else(|| {
        ToolError::new(
            ErrorCode::NotFound,
            format!("No project of this fleet lands PRs on {repo}."),
        )
        .with_fix("pr_list shows a project's PRs.")
    })?;
    require(caller, Role::Read, Some(&project.machine_id))?;
    Ok(project)
}

async fn pr_get(
    hub: Arc<Hub>,
    caller: Caller,
    input: PrGetInput,
) -> Result<PrGetOutput, ToolError> {
    let repo = &input.repo;
    let number = input.number.get();
    let project = owner(&hub, &caller, repo)?;
    let changes = super::pr_changes(&hub, repo, number);
    let read = hub.prs.github.detail(repo, number).await;
    let detail: Option<&GhDetail> = read.value.as_deref();
    if detail.is_none() && changes.is_empty() {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!(
                "{repo}#{number}: {}",
                read.error.as_deref().unwrap_or("GitHub has no such PR.")
            ),
        )
        .with_fix("pr_list shows the project's PRs."));
    }
    let change = changes.first();
    let tasks = super::project_tasks(&hub, &project);
    let mut ctx = RowCtx::with_tasks(&tasks);
    super::fill_ctx(&hub, &mut ctx, std::slice::from_ref(repo));
    let pr = join::row(repo, detail.map(|d| &d.pull), change, &ctx).ok_or_else(|| {
        ToolError::new(
            ErrorCode::Failed,
            format!("{repo}#{number} could not be read."),
        )
    })?;
    let head = detail
        .map(|d| d.pull.head_ref_oid.clone())
        .or_else(|| change.map(|c| c.head_sha.to_string()))
        .unwrap_or_default();
    let mut reviews: Vec<PrReviewEntry> = super::verdicts(&hub, pr.url.as_str())
        .into_iter()
        .map(|(task_id, sha, at, verdict)| {
            let current = change.map_or(sha == head, |c| join::is_current(c, &task_id, &sha));
            super::agent_review(
                &verdict,
                at,
                ctx.tasks_by_id.get(task_id.as_str()).copied(),
                current,
            )
        })
        .collect();
    if let Some(d) = detail {
        reviews.extend(
            d.reviews
                .iter()
                .filter_map(|r| super::person_review(r, &head)),
        );
    }
    reviews.sort_by(|a, b| b.at.cmp(&a.at));
    reviews.truncate(30);
    let ids: Vec<String> = changes.iter().map(|c| c.change_id.to_string()).collect();
    let checks = detail
        .map(|d| {
            d.pull
                .status_check_rollup
                .iter()
                .filter_map(join::check)
                .take(60)
                .collect()
        })
        .unwrap_or_default();
    let merge_commit = detail
        .and_then(|d| d.merge_commit.as_ref())
        .map(|m| m.oid.clone())
        .or_else(|| {
            change
                .and_then(|c| c.merged_sha.as_ref())
                .map(|s| s.to_string())
        })
        .filter(|s| !s.is_empty())
        .and_then(|sha| Text::new(format!("https://github.com/{repo}/commit/{sha}")).ok());
    let links = PrLinks {
        files: Text::unchecked(format!("{}/files", pr.url)),
        checks: Text::unchecked(format!("{}/checks", pr.url)),
        pr: pr.url.clone(),
        merge_commit,
    };
    Ok(PrGetOutput {
        body: Text::unchecked(clip(&redact(detail.map_or("", |d| d.body.as_str())), 8000)),
        base_branch: detail.and_then(|d| NonEmpty::new(d.base_ref_name.as_str()).ok()),
        head_sha: CommitSha::new(head.as_str()).ok(),
        additions: detail.map(|d| super::count(d.additions)),
        deletions: detail.map(|d| super::count(d.deletions)),
        changed_files: detail.map(|d| super::count(d.changed_files)),
        checks: List::unchecked(checks),
        reviews: List::unchecked(reviews),
        history: List::unchecked(super::history(&hub, &ids)),
        links,
        github_error: error_text(read.error),
        pr,
        next: Some("pr_files lists its changed files; pr_diff pages one file's diff.".into()),
        truncated: None,
    })
}

/// The PR's head and changed-file count from its detail, or why GitHub couldn't say.
async fn head_of(hub: &Hub, repo: &GitHubRepo, number: i64) -> Result<(String, usize), ToolError> {
    let read = hub.prs.github.detail(repo, number).await;
    match read.value {
        Some(d) if !d.pull.head_ref_oid.is_empty() => {
            Ok((d.pull.head_ref_oid.clone(), d.changed_files.max(0) as usize))
        }
        _ => Err(ToolError::new(
            ErrorCode::Failed,
            read.error
                .unwrap_or_else(|| format!("GitHub has no files for {repo}#{number}.")),
        )
        .with_fix("Try again in a minute; pr_get shows what fleetd records meanwhile.")),
    }
}

fn github_failed(error: Option<String>) -> ToolError {
    ToolError::new(
        ErrorCode::Failed,
        error.unwrap_or_else(|| "GitHub couldn't be read.".into()),
    )
    .with_fix("Try again in a minute.")
}

async fn pr_files(
    hub: Arc<Hub>,
    caller: Caller,
    input: PrFilesInput,
) -> Result<PrFilesOutput, ToolError> {
    let repo = &input.repo;
    let number = input.number.get();
    owner(&hub, &caller, repo)?;
    let (head, total) = head_of(&hub, repo, number).await?;
    let page = input.offset.get().max(0) as usize / PR_FILES_PAGE;
    let read = hub.prs.github.files(repo, number, &head, page).await;
    let Some(files) = read.value else {
        return Err(github_failed(read.error));
    };
    let next = (page + 1) * PR_FILES_PAGE;
    Ok(PrFilesOutput {
        files: List::unchecked(files.iter().filter_map(join::file).collect()),
        total: super::count(total as i64),
        next_offset: (next < total && files.len() == PR_FILES_PAGE)
            .then(|| super::count(next as i64)),
        head_sha: CommitSha::new(head.as_str()).ok(),
        next: None,
        truncated: None,
    })
}

async fn pr_diff(
    hub: Arc<Hub>,
    caller: Caller,
    input: PrDiffInput,
) -> Result<PrDiffOutput, ToolError> {
    let repo = &input.repo;
    let number = input.number.get();
    owner(&hub, &caller, repo)?;
    let (head, total_files) = head_of(&hub, repo, number).await?;
    let pages = total_files.div_ceil(PR_FILES_PAGE).max(1);
    let mut found = None;
    for page in 0..pages {
        let read = hub.prs.github.files(repo, number, &head, page).await;
        let Some(files) = read.value else {
            return Err(github_failed(read.error));
        };
        if let Some(f) = files.iter().find(|f| f.filename == input.path.as_str()) {
            found = Some(f.clone());
            break;
        }
        if files.len() < PR_FILES_PAGE {
            break;
        }
    }
    let Some(file) = found else {
        return Err(ToolError::new(
            ErrorCode::NotFound,
            format!("{repo}#{number} doesn't change {}.", input.path.as_str()),
        )
        .with_fix("pr_files lists the files it changes."));
    };
    let lines = file.patch.as_deref().map(join::diff_lines);
    let total = lines.as_ref().map_or(0, Vec::len);
    let offset = (input.offset.get().max(0) as usize).min(total);
    let limit = input.limit.get().max(1) as usize;
    let page: Vec<_> = lines
        .unwrap_or_default()
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect();
    let end = offset + page.len();
    Ok(PrDiffOutput {
        lines: List::unchecked(page),
        total: super::count(total as i64),
        next_offset: (end < total).then(|| super::count(end as i64)),
        no_diff: file.patch.is_none().then_some(true),
        head_sha: CommitSha::new(head.as_str()).ok(),
        next: None,
        truncated: None,
    })
}
