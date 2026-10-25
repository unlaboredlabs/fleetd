//! Text the hub writes for tasks: the branch name, the task's first message, its line in the lead digest, and its
//! event lines in the lead's wake. Pure. Lengths count UTF-16 units, as older hubs' did.
use std::sync::LazyLock;

use fleetd_contracts::ledger::Brief;
use fleetd_contracts::sessions::WorktreeSource;
use fleetd_contracts::tasks::{
    BranchPrefix, DEFAULT_BRANCH_PREFIX, Task, TaskKind, TaskRecovery, TaskResult,
    TaskResultStatus, TaskState,
};
use regex::Regex;

use crate::hub::leads::events::{Ended, Event};
use crate::hub::prompts::PromptSet;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

pub const TAIL_MAX: usize = 2000;
const SLUG_MAX: usize = 40;

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The longest prefix of `s` with at most `max` UTF-16 units.
fn js_prefix(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

/// The longest suffix of `s` with at most `max` UTF-16 units.
fn js_suffix(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices().rev() {
        units += c.len_utf16();
        if units > max {
            return &s[i + c.len_utf8()..];
        }
    }
    s
}

pub fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if js_len(&flat) > max {
        format!("{}…", js_prefix(&flat, max - 1))
    } else {
        flat
    }
}

/// Lowercase ASCII words joined by "-", cut at a word boundary; "task" when nothing is left.
pub fn slug_of(title: &str) -> String {
    let folded: String = title
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase();
    let words: Vec<&str> = folded
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|w| !w.is_empty())
        .collect();
    let mut slug = String::new();
    for w in &words {
        let next_len = if slug.is_empty() {
            w.len()
        } else {
            slug.len() + 1 + w.len()
        };
        if next_len > SLUG_MAX {
            break;
        }
        if !slug.is_empty() {
            slug.push('-');
        }
        slug.push_str(w);
    }
    if !slug.is_empty() {
        return slug;
    }
    match words.first() {
        Some(w) => w[..w.len().min(SLUG_MAX)].to_owned(),
        None => "task".to_owned(),
    }
}

/// A write task's branch, the only branch fleetd names: the train pushes to a PR's own branch, and review refs live
/// under refs/fleetd/. `prefix` is the policy's `branchPrefix`.
pub fn branch_for(prefix: Option<&BranchPrefix>, task_id: &str, title: &str) -> String {
    let prefix = prefix.map_or(DEFAULT_BRANCH_PREFIX, |p| p.as_str());
    format!("{prefix}{task_id}-{}", slug_of(title))
}

/// The last `max` characters, starting with "…" when cut.
pub fn tail_of(text: &str, max: usize) -> String {
    let t = text.trim();
    if js_len(t) <= max {
        t.to_owned()
    } else {
        format!("…{}", js_suffix(t, max - 1))
    }
}

static PR_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"https?://[^\s"'<>()]+?/(?:pull|pulls|pull-requests|pullrequest|merge_requests)/[0-9]+"#,
    )
    .unwrap()
});

/// Every pull or merge request URL in `texts`, read in order.
pub fn pr_urls<'a>(texts: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    texts
        .into_iter()
        .flat_map(|text| PR_URL.find_iter(text).map(|m| m.as_str().to_owned()))
        .collect()
}

pub struct PromptInput<'a> {
    pub task: &'a Task,
    pub project_title: &'a str,
    /// Absent while the workstream is a draft.
    pub brief: Option<&'a Brief>,
    /// The brief's done-when lines as text, whole (leads' `done_when_text` with the lines' own max).
    pub done_when: Option<String>,
    /// Write tasks: their branch. Every task's worktree starts from the remote's copy of `base_branch`.
    pub branch: Option<&'a str>,
    pub base_branch: Option<&'a str>,
    /// Write tasks: the work in flight elsewhere they may overlap (`duplicates::for_writer`).
    pub elsewhere: &'a [String],
    /// Write tasks: `user.md` and the project's `MEMORY.md` (`Memory::injected`), or empty.
    pub memory: &'a str,
}

fn kind_str(kind: TaskKind) -> &'static str {
    match kind {
        TaskKind::Write => "write",
        TaskKind::Read => "read",
        TaskKind::Review => "review",
    }
}

fn state_str(state: TaskState) -> &'static str {
    match state {
        TaskState::Queued => "queued",
        TaskState::Running => "running",
        TaskState::Idle => "idle",
        TaskState::Done => "done",
        TaskState::Failed => "failed",
        TaskState::Cancelled => "cancelled",
    }
}

/// Where a read or review task works, for its brief's `{{workspace}}`: a worktree of its own when it has a base, else
/// (a node older than detached worktrees, or a directory with no branch) the project's checkout, left as it is.
fn workspace_line(kind: TaskKind, base_branch: Option<&str>) -> String {
    let own = "You may build and run tests there; fleetd removes it when the task ends. Never work in the project's \
               own checkout, which is the human's.";
    match (kind, base_branch) {
        (TaskKind::Review, Some(base)) => format!(
            "Your current directory is a detached git worktree of your own, at the PR's head when fleetd could fetch \
             it from the remote the PR belongs to, else at origin/{base}. Check with `git log -1` against the PR's \
             head commit; if it isn't that, fetch the PR's head yourself and check it out in this worktree. \
             origin/{base} is fresh, to diff against. {own}"
        ),
        (_, Some(base)) => format!(
            "Your current directory is a detached git worktree of your own, at origin/{base} as fetched at your \
             start. {own}"
        ),
        (_, None) => "Your current directory is the project's own checkout, which is the human's: read it as it \
                      is, and never check out, build or write anything there."
            .to_owned(),
    }
}

/// The task's first message: the lead's text with the brief and the rules around it, then the human's
/// custom instructions.
pub fn render_task_prompt(set: &PromptSet, input: &PromptInput<'_>) -> String {
    let task = input.task;
    let mut context = Vec::new();
    if let Some(brief) = input.brief {
        context.push(format!("Goal: {}", one_line(brief.goal.as_str(), 1000)));
        context.push(format!(
            "Done when: {}",
            input.done_when.as_deref().unwrap_or_default()
        ));
    }
    let workstream = if context.is_empty() {
        String::new()
    } else {
        format!("\n\n## Workstream\n{}", context.join("\n"))
    };
    let elsewhere = if input.elsewhere.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n## Elsewhere\nWork in flight that may overlap yours. Don't redo it; if yours is the same work, stop and \
             ask your lead.\n{}",
            input
                .elsewhere
                .iter()
                .map(|l| format!("- {}", one_line(l, 300)))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    let vars: &[(&str, &dyn std::fmt::Display)] = &[
        ("taskId", &task.task_id),
        ("kind", &kind_str(task.kind)),
        ("workstreamId", &task.workstream_id),
        ("project", &one_line(input.project_title, 80)),
        ("title", &task.title),
        ("task", &task.prompt.as_str().trim()),
        ("workstream", &workstream),
        ("elsewhere", &elsewhere),
        ("branch", &input.branch.unwrap_or("<your branch>")),
        (
            "baseBranch",
            &input.base_branch.unwrap_or("<default branch>"),
        ),
        ("workspace", &workspace_line(task.kind, input.base_branch)),
    ];
    let id = match task.kind {
        TaskKind::Write => "task.brief.write",
        TaskKind::Read => "task.brief.read",
        TaskKind::Review => "task.brief.review",
    };
    let text = set.with_instructions(set.render(id, vars));
    if input.memory.is_empty() {
        text
    } else {
        format!("{text}\n\n{}", input.memory)
    }
}

/// The lead's event line for a finished task: its whole result tail, inline. `escalated`: its run died and fleetd
/// did not resume it, which the tail says why.
pub fn task_result_lines(
    task_id: &str,
    title: &str,
    result: &TaskResult,
    escalated: bool,
) -> String {
    let mut place = Vec::new();
    if let Some(b) = &result.branch {
        place.push(format!("branch {}", b.as_str()));
    }
    if let Some(p) = &result.pr_url {
        place.push(format!("PR {}", p.as_str()));
    }
    let place = if place.is_empty() {
        String::new()
    } else {
        format!(" ({})", place.join(", "))
    };
    Event::AgentEnded {
        task: task_id,
        ended: match result.status {
            TaskResultStatus::Failed if escalated => Ended::NotResumed,
            TaskResultStatus::Done => Ended::Done,
            TaskResultStatus::Failed => Ended::Failed,
            TaskResultStatus::Cancelled => Ended::Cancelled,
        },
        title,
        place: &place,
        result: result.tail.as_str(),
    }
    .render()
}

/// `" [branch]"`, or nothing.
fn branch_place(task: &Task) -> String {
    task.branch
        .as_ref()
        .map_or_else(String::new, |b| format!(" [{}]", b.as_str()))
}

/// What became of a resumed task's worktree: as it was, or rebuilt by its node (`rebuilt`) from what was left of its
/// branch.
fn worktree_words(task: &Task, rebuilt: Option<WorktreeSource>) -> String {
    let branch = task.branch.as_ref().map_or("its branch", |b| b.as_str());
    match rebuilt {
        None | Some(WorktreeSource::Unknown) => {
            "It goes on in its own worktree; nothing for you to do.".to_owned()
        }
        Some(WorktreeSource::Local) => format!(
            "Its worktree was gone and was rebuilt from its local branch {branch}: its commits are there, uncommitted \
             changes are lost. Nothing for you to do."
        ),
        Some(WorktreeSource::Remote) => format!(
            "Its worktree and local branch were gone, so the worktree was rebuilt from origin/{branch} as pushed: \
             unpushed commits and uncommitted changes are lost. Nothing for you to do."
        ),
        Some(WorktreeSource::Base) => format!(
            "Its worktree was gone and {branch} was neither on the machine nor pushed, so it starts again on a new \
             {branch} from the default branch: its earlier work is lost."
        ),
    }
}

/// The lead's quiet line for a dead task fleetd resumed: why its run ended, what it was doing, and its worktree.
pub fn task_recovered_lines(
    task: &Task,
    recovery: &TaskRecovery,
    doing: &str,
    rebuilt: Option<WorktreeSource>,
) -> String {
    Event::AgentRecovered {
        task: task.task_id.as_str(),
        title: task.title.as_str(),
        place: &branch_place(task),
        attempt: task.attempt.get(),
        used: &super::recovery::used(recovery),
        cause: recovery.last_cause_text.as_str(),
        doing,
        worktree: &worktree_words(task, rebuilt),
    }
    .render()
}

/// The lead's line for a message to a task that never reached it: a person continued the task while it waited to
/// resume, and sending it into that run failed.
pub fn task_message_not_sent_lines(task: &Task, why: &str, text: &str) -> String {
    Event::MessageNotSent {
        task: task.task_id.as_str(),
        title: task.title.as_str(),
        why,
        text,
    }
    .render()
}

/// The lead's quiet line for a running task whose machine has been offline for `minutes`.
pub fn task_unreachable_lines(task: &Task, minutes: i64) -> String {
    Event::AgentUnreachable {
        task: task.task_id.as_str(),
        title: task.title.as_str(),
        place: &branch_place(task),
        machine: task.project_ref.machine_id.as_str(),
        minutes,
    }
    .render()
}

/// The lead's quiet line for a finished writer whose PR lookup the host refused.
pub fn task_pr_skipped_lines(task_id: &str, why: &str) -> String {
    Event::AgentPrSkipped { task: task_id, why }.render()
}

/// The lead's quiet line for a finished task's PR, found after its result line went out.
pub fn task_pr_lines(task_id: &str, pr_url: &str) -> String {
    Event::AgentPr {
        task: task_id,
        pr_url,
    }
    .render()
}

/// The lead's event line for a task waiting on input: its question, inline.
pub fn task_waiting_lines(task_id: &str, title: &str, question: &str) -> String {
    Event::AgentWaiting {
        task: task_id,
        title,
        question,
    }
    .render()
}

/// One digest line per task: running and idle, then queued with reasons, then those that ended since `since`.
/// `offline` says since when a machine is offline (`HH:MM` UTC), for a running task on it.
pub fn task_digest_lines(
    tasks: &[Task],
    since: Option<&str>,
    now: &str,
    offline: &dyn Fn(&str) -> Option<String>,
) -> Vec<String> {
    let title = |t: &Task| one_line(t.title.as_str(), 80);
    let mut out = Vec::new();
    for t in tasks
        .iter()
        .filter(|t| matches!(t.state, TaskState::Running | TaskState::Idle))
    {
        let branch = match (&t.branch, &t.base) {
            (Some(b), Some(base)) => format!(" [{}, {}]", b.as_str(), super::base::line(base, now)),
            (Some(b), None) => format!(" [{}]", b.as_str()),
            (None, _) => String::new(),
        };
        let state = if t.state == TaskState::Idle {
            "idle, waiting for input"
        } else {
            "running"
        };
        // Resumed on its own after a death: the lead needn't continue it.
        let recovered = t
            .recovery
            .as_ref()
            .filter(|r| r.resumed_at.is_some())
            .map_or_else(String::new, |r| {
                let how = match r.mode {
                    fleetd_contracts::tasks::RecoveryMode::Fresh => "restarted fresh",
                    _ => "resumed automatically",
                };
                format!(
                    "; {how} after {}, {}",
                    r.last_cause_text.as_str(),
                    super::recovery::used(r)
                )
            });
        // Its machine is away: it resumes when that is back, so the lead needn't continue it either.
        let machine = t.project_ref.machine_id.as_str();
        let away = offline(machine)
            .filter(|_| t.state == TaskState::Running)
            .map_or_else(String::new, |at| {
                format!("; {machine} offline since {at} UTC, it resumes when {machine} is back")
            });
        out.push(format!(
            "- {} {state} ({}, {}): {}{branch}{recovered}{away}",
            t.task_id,
            kind_str(t.kind),
            t.profile.as_str(),
            title(t)
        ));
    }
    for t in tasks.iter().filter(|t| t.state == TaskState::Queued) {
        let reason = t.queued_reason.as_ref().map_or("waiting", |r| r.as_str());
        out.push(format!(
            "- {} queued ({}): {}; {reason}",
            t.task_id,
            kind_str(t.kind),
            title(t)
        ));
    }
    for t in tasks.iter().filter(|t| {
        matches!(
            t.state,
            TaskState::Done | TaskState::Failed | TaskState::Cancelled
        ) && since.is_none_or(|s| t.ended_at.as_ref().map_or("", |e| e.as_str()) > s)
    }) {
        // A wake's event lines carry the result of a task that ended since the last one; only a lead's first message
        // has no such line.
        let first = t
            .result
            .as_ref()
            .filter(|_| since.is_none())
            .map_or_else(String::new, |r| {
                let tail = r.tail.as_str();
                one_line(tail.strip_prefix('…').unwrap_or(tail), 160)
            });
        let arrow = if first.is_empty() {
            String::new()
        } else {
            format!(" → {first}")
        };
        let pr = t
            .result
            .as_ref()
            .and_then(|r| r.pr_url.as_ref())
            .map_or_else(String::new, |p| format!(" [{}]", p.as_str()));
        out.push(format!(
            "- {} {} since your last wake: {}{pr}{arrow}",
            t.task_id,
            state_str(t.state),
            title(t)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dead run fleetd did not resume says so in its head; the tail says why and what the lead can do.
    #[test]
    fn an_escalated_end_says_it_was_not_resumed() {
        let result: TaskResult = serde_json::from_value(serde_json::json!({
            "status": "failed", "tail": "Not resumed automatically: it died the same way twice.",
            "branch": "fleetd/T23-b", "at": "2026-10-25T10:00:00.000Z",
        }))
        .unwrap();
        assert_eq!(
            task_result_lines("T23", "B: progress bar", &result, true),
            "- T23 failed and was not resumed: B: progress bar (branch fleetd/T23-b)\n  > Not resumed automatically: \
             it died the same way twice."
        );
        assert!(task_result_lines("T23", "B", &result, false).starts_with("- T23 failed: B"));
    }

    #[test]
    fn an_ended_tasks_result_shows_in_a_first_message_but_not_beside_its_wake_line() {
        let task: Task = serde_json::from_value(serde_json::json!({
            "taskId": "T4", "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "workstreamId": "W1",
            "title": "B", "kind": "write", "prompt": "do it", "state": "done", "attempt": 1,
            "createdAt": "2026-10-25T09:00:00.000Z", "endedAt": "2026-10-25T10:00:00.000Z",
            "result": { "status": "done", "tail": "Fixed it.", "at": "2026-10-25T10:00:00.000Z" },
        }))
        .unwrap();
        let lines = |since| task_digest_lines(std::slice::from_ref(&task), since, "", &|_| None);
        assert!(lines(None)[0].ends_with("→ Fixed it."), "{:?}", lines(None));
        let wake = lines(Some("2026-10-25T09:30:00.000Z"));
        assert!(wake[0].ends_with(": B"), "{wake:?}");
    }

    #[test]
    fn a_task_branch_starts_with_the_policys_prefix_else_fleetd() {
        assert_eq!(
            branch_for(None, "T1", "Add alpha page"),
            "fleetd/T1-add-alpha-page"
        );
        let slot = BranchPrefix::new("slot/3/fleetd/").unwrap();
        assert_eq!(
            branch_for(Some(&slot), "T12", "Add alpha page"),
            "slot/3/fleetd/T12-add-alpha-page"
        );
    }
}
