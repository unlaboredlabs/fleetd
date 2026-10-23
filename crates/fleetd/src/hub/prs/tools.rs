//! pr_list, pr_get, pr_files and pr_diff. All read-only.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::mcp::{
    ErrorCode, PrDiffInput, PrDiffOutput, PrFilesInput, PrFilesOutput, PrGetInput, PrGetOutput,
    PrListInput, PrListOutput,
};
use fleetd_contracts::prim::{List, NonEmpty, Text};
use fleetd_contracts::prs::{PR_FILES_PAGE, PR_LIST_MAX, PrLinks, PrReviewEntry};
use fleetd_contracts::train::GitHubRepo;
use fleetd_contracts::verification::CommitSha;

use super::github::GhDetail;
use super::join::{self, RowCtx};
use crate::hub::api::{Caller, Hub, Registry, ToolError, clip, require, unknown_project};
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
    let closed_since = input
        .closed_since
        .as_ref()
        .map_or_else(|| super::default_closed_since(now), |t| t.0.clone());
    let changes = super::project_changes(&hub, project);
    let repos = super::project_repos(&hub, project, &changes);
    let mut pulls = Vec::new();
    let mut error = None;
    for repo in &repos {
        for closed in [false, true] {
            let read = hub.prs.github.list(repo, closed).await;
            error = error.or(read.error);
            if let Some(list) = read.value {
                pulls.extend(list.iter().map(|p| (repo.clone(), p.clone())));
            }
        }
    }
    let tasks = super::project_tasks(&hub, project);
    let mut ctx = RowCtx::with_tasks(&tasks);
    super::fill_ctx(&hub, &mut ctx, &changes, &repos);
    let (prs, truncated) = join::rows(&pulls, &changes, &closed_since, &ctx, PR_LIST_MAX);
    Ok(PrListOutput {
        prs: List::unchecked(prs),
        github_error: error_text(error),
        at: iso_ms(now).into(),
        next: Some("pr_get with a row's repo and number reads it in full.".into()),
        truncated: truncated.then_some(true),
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
    super::fill_ctx(&hub, &mut ctx, &changes, std::slice::from_ref(repo));
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
                hub.reviews.role_of(&task_id),
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
