//! The pure part of the PR views: GitHub's answers and the hub's records joined into rows, checks and reviews rolled
//! up, and a file's patch split into numbered lines.
use std::collections::{HashMap, HashSet};

use fleetd_contracts::ids::Timestamp;
use fleetd_contracts::prim::{Count, NonEmpty, Positive, Text};
use fleetd_contracts::prs::{
    ChecksState, ChecksSummary, DiffLine, DiffLineKind, PR_DIFF_LINE_MAX, PrAuthor, PrCheck,
    PrFile, PrFileStatus, PrQueue, PrRow, PrState, ReviewState, ReviewSummary,
};
use fleetd_contracts::tasks::Task;
use fleetd_contracts::train::{Change, ChangeState, GitHubPrUrl, GitHubRepo};

use super::github::{GhCheck, GhFile, GhPull};
use crate::hub::api::clip;
use crate::hub::executor::shell_mapper::{js_take, normalize_iso};
use crate::hub::orders::phase;
use crate::hub::redact::redact;

/// The context fleetd posts itself; the queue state says the same in words.
const OWN_CONTEXT: &str = crate::hub::train::github::TRAIN_CONTEXT;

/// What the rows need from the hub's records, read once per answer.
#[derive(Default)]
pub struct RowCtx<'a> {
    pub tasks_by_id: HashMap<&'a str, &'a Task>,
    /// Write tasks by their branch, for PRs opened from a task's branch before it was queued.
    pub tasks_by_branch: HashMap<&'a str, &'a Task>,
    /// Per repo (lowercase): how many PRs wait in its queue.
    pub queues: HashMap<String, usize>,
}

impl<'a> RowCtx<'a> {
    pub fn with_tasks(tasks: &'a [Task]) -> Self {
        Self {
            tasks_by_id: tasks.iter().map(|t| (t.task_id.as_str(), t)).collect(),
            tasks_by_branch: tasks
                .iter()
                .filter_map(|t| t.branch.as_ref().map(|b| (b.as_str(), t)))
                .collect(),
            ..Self::default()
        }
    }
}

pub fn iso(text: &str) -> Timestamp {
    Timestamp(normalize_iso(text))
}

/// A check's state, or None for fleetd's own statuses.
pub fn check_state(c: &GhCheck) -> Option<(String, ChecksState)> {
    let name = c
        .name
        .as_deref()
        .or(c.context.as_deref())
        .unwrap_or("")
        .trim();
    if name.is_empty() || name == OWN_CONTEXT {
        return None;
    }
    let state = if c.typename == "StatusContext" || c.state.is_some() && c.status.is_none() {
        match c.state.as_deref().unwrap_or("").to_uppercase().as_str() {
            "SUCCESS" => ChecksState::Passing,
            "FAILURE" | "ERROR" => ChecksState::Failing,
            _ => ChecksState::Pending,
        }
    } else if !c
        .status
        .as_deref()
        .is_some_and(|s| s.eq_ignore_ascii_case("completed"))
    {
        ChecksState::Pending
    } else {
        match c
            .conclusion
            .as_deref()
            .unwrap_or("")
            .to_uppercase()
            .as_str()
        {
            "SUCCESS" | "NEUTRAL" | "SKIPPED" => ChecksState::Passing,
            "" => ChecksState::Pending,
            _ => ChecksState::Failing,
        }
    };
    Some((name.to_owned(), state))
}

pub fn checks_summary(checks: &[GhCheck]) -> ChecksSummary {
    let (mut passed, mut failed, mut pending) = (0, 0, 0);
    for (_, state) in checks.iter().filter_map(check_state) {
        match state {
            ChecksState::Passing => passed += 1,
            ChecksState::Failing => failed += 1,
            _ => pending += 1,
        }
    }
    let state = if failed > 0 {
        ChecksState::Failing
    } else if pending > 0 {
        ChecksState::Pending
    } else if passed > 0 {
        ChecksState::Passing
    } else {
        ChecksState::None
    };
    ChecksSummary {
        state,
        passed: Count::unchecked(passed),
        failed: Count::unchecked(failed),
        pending: Count::unchecked(pending),
    }
}

fn opt_text<const MAX: usize>(s: Option<&str>) -> Option<Text<1, MAX>> {
    s.filter(|s| !s.trim().is_empty())
        .and_then(|s| Text::new(js_take(s, MAX)).ok())
}

pub fn check(c: &GhCheck) -> Option<PrCheck> {
    let (name, state) = check_state(c)?;
    Some(PrCheck {
        name: Text::new(js_take(&name, 200)).ok()?,
        state,
        conclusion: opt_text(
            c.conclusion
                .as_deref()
                .or(c.state.as_deref())
                .map(str::to_lowercase)
                .as_deref(),
        ),
        url: opt_text(c.details_url.as_deref().or(c.target_url.as_deref())),
        started_at: c.started_at.as_deref().filter(|s| !s.is_empty()).map(iso),
        completed_at: c
            .completed_at
            .as_deref()
            .filter(|s| !s.is_empty() && !s.starts_with("0001"))
            .map(iso),
    })
}

/// A Change's review is of its current patch (or of its head, before the patch id is known).
fn of_current_patch(change: &Change, r: &fleetd_contracts::train::ChangeReview) -> bool {
    match &change.patch_id {
        Some(patch) => &r.patch_id == patch,
        None => r.pr_head_sha == change.head_sha,
    }
}

/// A verdict counts for the PR's current change: as the Change records it when it does, else when it reviewed the
/// current head.
pub fn is_current(change: &Change, task_id: &str, sha: &str) -> bool {
    match change
        .reviews
        .iter()
        .find(|r| r.task_id.as_str() == task_id && r.pr_head_sha.as_str() == sha)
    {
        Some(r) => of_current_patch(change, r),
        None => change.head_sha.as_str() == sha,
    }
}

pub fn review_summary(
    change: Option<&Change>,
    needed: i64,
    decision: Option<&str>,
) -> ReviewSummary {
    let from_github = || match decision.unwrap_or("") {
        "APPROVED" => ReviewState::Approved,
        "CHANGES_REQUESTED" => ReviewState::ChangesRequested,
        "REVIEW_REQUIRED" => ReviewState::Pending,
        _ => ReviewState::None,
    };
    let Some(change) = change else {
        return ReviewSummary {
            state: from_github(),
            done: Count::unchecked(0),
            needed: Count::unchecked(0),
        };
    };
    let current: Vec<_> = change
        .reviews
        .iter()
        .filter(|r| of_current_patch(change, r))
        .collect();
    let done = current.iter().filter(|r| r.blocking.get() == 0).count() as i64;
    let blocked = current.iter().any(|r| r.blocking.get() > 0);
    let state = if blocked {
        ReviewState::ChangesRequested
    } else if needed > 0 && done >= needed {
        ReviewState::Approved
    } else if needed > 0 {
        ReviewState::Pending
    } else {
        from_github()
    };
    ReviewSummary {
        state,
        done: Count::unchecked(done),
        needed: Count::unchecked(needed.max(0)),
    }
}

/// The agent behind a task, as the PR views name it.
pub fn agent_of(task: &Task, role: fleetd_contracts::live::AgentRole) -> PrAuthor {
    PrAuthor {
        lane_id: Text::new(task.task_id.as_str()).ok(),
        task_id: Some(task.task_id.clone()),
        role: Some(role),
        title: Some(Text::unchecked(js_take(&task.title, 80))),
        profile: Some(task.profile),
        thread_ref: task.thread_ref.clone(),
        login: None,
    }
}

pub fn author(task: Option<&Task>, login: Option<&str>) -> PrAuthor {
    let mut out = match task {
        Some(t) => agent_of(t, phase::role(t.kind, t.qa == Some(true))),
        None => PrAuthor {
            lane_id: None,
            task_id: None,
            role: None,
            title: None,
            profile: None,
            thread_ref: None,
            login: None,
        },
    };
    out.login = opt_text(login);
    out
}

pub fn queue(change: &Change, length: usize) -> PrQueue {
    let held = matches!(
        change.state,
        ChangeState::NeedsRebase | ChangeState::CiFailed | ChangeState::Refused
    );
    PrQueue {
        change_id: change.change_id.clone(),
        state: change.state,
        position: change.position,
        length: Count::unchecked(length as i64),
        reason: change
            .last_error
            .as_ref()
            .filter(|_| held)
            .map(|e| Text::unchecked(clip(&redact(e), 2000))),
    }
}

fn gh_state(pull: &GhPull) -> PrState {
    match pull.state.to_uppercase().as_str() {
        "MERGED" => PrState::Merged,
        "CLOSED" => PrState::Closed,
        _ if pull.is_draft => PrState::Draft,
        _ => PrState::Open,
    }
}

fn change_state(change: &Change) -> PrState {
    match change.state {
        ChangeState::Merged => PrState::Merged,
        ChangeState::Refused | ChangeState::Abandoned => PrState::Closed,
        _ => PrState::Open,
    }
}

pub fn is_open(state: PrState) -> bool {
    matches!(state, PrState::Open | PrState::Draft)
}

/// One row from GitHub's PR (when GitHub was reached) and fleetd's Change for it (when fleetd lands it).
pub fn row(
    repo: &GitHubRepo,
    pull: Option<&GhPull>,
    change: Option<&Change>,
    ctx: &RowCtx<'_>,
) -> Option<PrRow> {
    let number = pull
        .map(|p| p.number)
        .or_else(|| change.map(|c| c.pr_number.get()))?;
    let url = change
        .map(|c| c.pr_url.clone())
        .or_else(|| GitHubPrUrl::new(format!("https://github.com/{repo}/pull/{number}")).ok())?;
    let task = change
        .and_then(|c| c.task_id.as_ref())
        .and_then(|t| ctx.tasks_by_id.get(t.as_str()).copied())
        .or_else(|| {
            let branch = pull
                .map(|p| p.head_ref_name.as_str())
                .or_else(|| change.map(|c| c.branch.as_str()))?;
            ctx.tasks_by_branch.get(branch).copied()
        });
    let title = pull
        .map(|p| p.title.as_str())
        .filter(|t| !t.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| task.map(|t| t.title.to_string()))
        .unwrap_or_else(|| format!("PR #{number}"));
    // Every PR the train lands needs one clean review of its current patch.
    let needed = i64::from(change.is_some());
    let length = ctx.queues.get(&repo.to_lowercase()).copied().unwrap_or(0);
    let stamp = |gh: Option<&str>, ours: Option<&Timestamp>| {
        gh.filter(|s| !s.is_empty())
            .map(iso)
            .or_else(|| ours.cloned())
            .unwrap_or_default()
    };
    Some(PrRow {
        repo: repo.clone(),
        number: Positive::new(number).ok()?,
        url,
        title: Text::unchecked(js_take(&title, 300)),
        state: pull.map_or_else(|| change.map_or(PrState::Open, change_state), gh_state),
        checks: pull.map(|p| checks_summary(&p.status_check_rollup)),
        review: review_summary(
            change,
            needed,
            pull.and_then(|p| p.review_decision.as_deref()),
        ),
        queue: change.map(|c| queue(c, length)),
        author: author(
            task,
            pull.and_then(|p| p.author.as_ref())
                .map(|a| a.login.as_str()),
        ),
        branch: pull
            .map(|p| p.head_ref_name.as_str())
            .filter(|b| !b.is_empty())
            .or_else(|| change.map(|c| c.branch.as_str()))
            .and_then(|b| NonEmpty::new(b).ok()),
        workstream_id: change
            .map(|c| c.workstream_id.clone())
            .or_else(|| task.map(|t| t.workstream_id.clone())),
        created_at: stamp(
            pull.map(|p| p.created_at.as_str()),
            change.map(|c| &c.created_at),
        ),
        updated_at: stamp(
            pull.map(|p| p.updated_at.as_str()),
            change.map(|c| &c.updated_at),
        ),
        merged_at: pull
            .and_then(|p| p.merged_at.as_deref())
            .filter(|s| !s.is_empty())
            .map(iso)
            .or_else(|| {
                change
                    .filter(|c| c.state == ChangeState::Merged)
                    .map(|c| c.updated_at.clone())
            }),
    })
}

/// A project's rows: GitHub's open PRs and those closed since `closed_since` on its repos, joined with fleetd's
/// Changes (newest first), plus Changes GitHub's lists didn't carry that are still open or recently ended. Open first,
/// then most recently updated; at most `max`.
pub fn rows(
    pulls: &[(GitHubRepo, GhPull)],
    changes: &[Change],
    closed_since: &str,
    ctx: &RowCtx<'_>,
    max: usize,
) -> (Vec<PrRow>, bool) {
    let mut newest: HashMap<(String, i64), &Change> = HashMap::new();
    for c in changes {
        newest
            .entry((c.repo.to_lowercase(), c.pr_number.get()))
            .or_insert(c);
    }
    let mut seen: HashSet<(String, i64)> = HashSet::new();
    let mut out = Vec::new();
    for (repo, pull) in pulls {
        let key = (repo.to_lowercase(), pull.number);
        if !seen.insert(key.clone()) {
            continue;
        }
        let ended = pull
            .merged_at
            .as_deref()
            .or(pull.closed_at.as_deref())
            .unwrap_or(&pull.updated_at);
        if !is_open(gh_state(pull)) && normalize_iso(ended).as_str() < closed_since {
            continue;
        }
        out.extend(row(repo, Some(pull), newest.get(&key).copied(), ctx));
    }
    for (key, change) in &newest {
        if seen.contains(key) {
            continue;
        }
        let open = !crate::hub::train::records::TERMINAL_STATES.contains(&change.state);
        if open || change.updated_at.0.as_str() >= closed_since {
            out.extend(row(&change.repo, None, Some(change), ctx));
        }
    }
    out.sort_by(|a, b| {
        is_open(b.state)
            .cmp(&is_open(a.state))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| b.number.get().cmp(&a.number.get()))
    });
    let truncated = out.len() > max;
    out.truncate(max);
    (out, truncated)
}

pub fn file_status(status: &str) -> PrFileStatus {
    match status {
        "added" => PrFileStatus::Added,
        "removed" => PrFileStatus::Removed,
        "renamed" => PrFileStatus::Renamed,
        "copied" => PrFileStatus::Copied,
        "unchanged" => PrFileStatus::Unchanged,
        "changed" => PrFileStatus::Changed,
        _ => PrFileStatus::Modified,
    }
}

pub fn file(f: &GhFile) -> Option<PrFile> {
    Some(PrFile {
        path: Text::new(js_take(&f.filename, 1000)).ok()?,
        previous_path: opt_text(f.previous_filename.as_deref()),
        status: file_status(&f.status),
        additions: Count::unchecked(f.additions.max(0)),
        deletions: Count::unchecked(f.deletions.max(0)),
        diff_lines: f
            .patch
            .as_deref()
            .map(|p| Count::unchecked(diff_lines(p).len() as i64)),
    })
}

/// "@@ -12,7 +14,9 @@ fn main": the old and new start lines and the trailing context.
fn hunk(line: &str) -> Option<(i64, i64, &str)> {
    let rest = line.strip_prefix("@@ -")?;
    let (ranges, context) = rest.split_once(" @@").unwrap_or((rest, ""));
    let (old, new) = ranges.split_once(" +")?;
    let start = |r: &str| r.split(',').next()?.parse::<i64>().ok();
    Some((start(old)?, start(new)?, context.trim_start()))
}

/// A unified patch as numbered lines, secrets replaced and long lines cut.
pub fn diff_lines(patch: &str) -> Vec<DiffLine> {
    let (mut old, mut new) = (0i64, 0i64);
    let mut out = Vec::new();
    let mut push = |kind, text: &str, o: Option<i64>, n: Option<i64>| {
        let text = redact(text);
        let cut = js_take(&text, PR_DIFF_LINE_MAX);
        out.push(DiffLine {
            kind,
            cut: (cut.len() < text.len()).then_some(true),
            text: Text::unchecked(cut),
            old: o.map(|v| Count::unchecked(v.max(0))),
            new: n.map(|v| Count::unchecked(v.max(0))),
        });
    };
    for line in patch.lines() {
        if let Some((o, n, context)) = hunk(line) {
            old = o;
            new = n;
            push(DiffLineKind::Hunk, context, Some(o), Some(n));
        } else if let Some(text) = line.strip_prefix('+') {
            push(DiffLineKind::Add, text, None, Some(new));
            new += 1;
        } else if let Some(text) = line.strip_prefix('-') {
            push(DiffLineKind::Del, text, Some(old), None);
            old += 1;
        } else if line.starts_with('\\') {
            // "\ No newline at end of file" describes the line before it.
        } else {
            let text = line.strip_prefix(' ').unwrap_or(line);
            push(DiffLineKind::Context, text, Some(old), Some(new));
            old += 1;
            new += 1;
        }
    }
    out
}
