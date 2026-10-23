//! Text the hub writes for tasks: the branch name, the task's first message, its line in the lead digest, and its
//! event lines in the lead's wake. Pure. Lengths count UTF-16 units, as older hubs' did.
use std::sync::LazyLock;

use fleetd_contracts::ledger::Brief;
use fleetd_contracts::tasks::{
    BranchPrefix, DEFAULT_BRANCH_PREFIX, Task, TaskKind, TaskResult, TaskResultStatus, TaskState,
};
use regex::Regex;

use crate::hub::leads::events::{Ended, Event};
use crate::hub::prompts::{PromptSet, fixed};
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
    Regex::new(r#"https?://[^\s"'<>()]+?/(?:pull|pulls|merge_requests)/[0-9]+"#).unwrap()
});

/// The last pull or merge request URL in `texts`, read in order.
pub fn find_pr_url<'a>(texts: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut found = None;
    for text in texts {
        for m in PR_URL.find_iter(text) {
            found = Some(m.as_str().to_owned());
        }
    }
    found
}

pub struct PromptInput<'a> {
    pub task: &'a Task,
    pub project_title: &'a str,
    /// Absent while the workstream is a draft.
    pub brief: Option<&'a Brief>,
    /// The brief's done-when checks as text (leads' doneWhenText with max 200).
    pub done_when: Option<String>,
    /// The globs of each leased area, in the task's area order.
    pub area_globs: &'a [(String, Vec<String>)],
    /// Write tasks: their branch and the branch it starts from.
    pub branch: Option<&'a str>,
    pub base_branch: Option<&'a str>,
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

/// The task's first message: the lead's text with the brief, the areas and the rules around it, then the human's
/// custom instructions.
pub fn render_task_prompt(set: &PromptSet, input: &PromptInput<'_>) -> String {
    let task = input.task;
    let serves = task.serves.as_ref().map(|s| s.as_str());
    let mut context = Vec::new();
    if let Some(brief) = input.brief {
        context.push(format!("Goal: {}", one_line(brief.goal.as_str(), 1000)));
        context.push(format!(
            "Done when: {}",
            input.done_when.as_deref().unwrap_or_default()
        ));
    }
    if let Some(serves) = serves {
        context.push(format!("This task serves: {}", one_line(serves, 200)));
    }
    let workstream = if context.is_empty() {
        String::new()
    } else {
        format!("\n\n## Workstream\n{}", context.join("\n"))
    };
    let areas = task
        .areas
        .iter()
        .map(|a| {
            let globs = input
                .area_globs
                .iter()
                .find(|(n, _)| n == a.as_str())
                .map(|(_, g)| g.join(", "))
                .unwrap_or_default();
            format!("{} ({globs})", a.as_str())
        })
        .collect::<Vec<_>>()
        .join("; ");
    let vars: &[(&str, &dyn std::fmt::Display)] = &[
        ("taskId", &task.task_id),
        ("kind", &kind_str(task.kind)),
        ("workstreamId", &task.workstream_id),
        ("project", &one_line(input.project_title, 80)),
        ("title", &task.title),
        ("task", &task.prompt.as_str().trim()),
        ("workstream", &workstream),
        ("areas", &areas),
        ("branch", &input.branch.unwrap_or("<your branch>")),
        (
            "baseBranch",
            &input.base_branch.unwrap_or("<default branch>"),
        ),
        ("serves", &serves.unwrap_or("<what this serves>")),
    ];
    let text = match task.kind {
        TaskKind::Write => set.render("task.brief.write", vars),
        TaskKind::Read => fixed::render(fixed::TASK_BRIEF_READ, vars),
        TaskKind::Review => fixed::render(fixed::TASK_BRIEF_REVIEW, vars),
    };
    set.with_instructions(text)
}

/// The lead's event line for a finished task: its whole result tail, inline.
/// `receipts` is the receipts area's line for this result.
pub fn task_result_lines(
    task_id: &str,
    title: &str,
    result: &TaskResult,
    receipts: Option<&str>,
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
            TaskResultStatus::Done => Ended::Done,
            TaskResultStatus::Failed => Ended::Failed,
            TaskResultStatus::Cancelled => Ended::Cancelled,
        },
        title,
        place: &place,
        // M6 receipts, counted by the hub; absent on results stored before them.
        receipts,
        result: result.tail.as_str(),
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
pub fn task_digest_lines(tasks: &[Task], since: Option<&str>) -> Vec<String> {
    let title = |t: &Task| one_line(t.title.as_str(), 80);
    let mut out = Vec::new();
    for t in tasks
        .iter()
        .filter(|t| matches!(t.state, TaskState::Running | TaskState::Idle))
    {
        let branch = t
            .branch
            .as_ref()
            .map_or_else(String::new, |b| format!(" [{}]", b.as_str()));
        let state = if t.state == TaskState::Idle {
            "idle, waiting for input"
        } else {
            "running"
        };
        out.push(format!(
            "- {} {state} ({}, {}): {}{branch}",
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
        let first = t.result.as_ref().map_or_else(String::new, |r| {
            let tail = r.tail.as_str();
            one_line(tail.strip_prefix('…').unwrap_or(tail), 160)
        });
        let arrow = if first.is_empty() {
            String::new()
        } else {
            format!(" → {first}")
        };
        out.push(format!(
            "- {} {} since your last wake: {}{arrow}",
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
