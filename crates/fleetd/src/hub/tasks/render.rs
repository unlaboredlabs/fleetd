//! Text the hub writes for tasks: the branch name, the task's first message, its line in the lead digest, and the
//! result the lead receives inline in its wake. Pure. Lengths count UTF-16 units, as older hubs' did.
use std::sync::LazyLock;

use fleetd_contracts::ledger::Brief;
use fleetd_contracts::tasks::{
    BranchPrefix, DEFAULT_BRANCH_PREFIX, Task, TaskKind, TaskResult, TaskResultStatus, TaskState,
};
use regex::Regex;

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

pub fn effort_str(effort: fleetd_contracts::effort::Effort) -> String {
    serde_json::to_value(effort)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
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
    let id = match task.kind {
        TaskKind::Write => "task.brief.write",
        TaskKind::Read => "task.brief.read",
        TaskKind::Review => "task.brief.review",
    };
    let text = set.render(
        id,
        &[
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
        ],
    );
    set.with_instructions(text)
}

fn quoted(text: &str) -> Vec<String> {
    text.trim()
        .split('\n')
        .map(|l| format!("  > {l}").trim_end().to_owned())
        .collect()
}

/// The "why you are woken" entry for a finished task: its whole result tail, inline.
/// `receipts` is the receipts area's line for this result.
pub fn task_result_lines(
    set: &PromptSet,
    task_id: &str,
    title: &str,
    result: &TaskResult,
    receipts: Option<&str>,
) -> String {
    let mut where_ = Vec::new();
    if let Some(b) = &result.branch {
        where_.push(format!("branch {}", b.as_str()));
    }
    if let Some(p) = &result.pr_url {
        where_.push(format!("PR {}", p.as_str()));
    }
    let where_ = if where_.is_empty() {
        String::new()
    } else {
        format!(" ({})", where_.join(", "))
    };
    // M6 receipts, counted by the hub; absent on results stored before them.
    let receipts = receipts.map_or_else(String::new, |r| format!("\n  {r}"));
    let tail = result.tail.as_str();
    let quoted_tail = if tail.trim().is_empty() {
        "  > (no final message)".to_owned()
    } else {
        quoted(tail).join("\n")
    };
    let (id, verb) = match result.status {
        TaskResultStatus::Done => ("wake.task_result", "completed"),
        TaskResultStatus::Failed => ("wake.task_result", "failed"),
        TaskResultStatus::Cancelled => ("wake.task_cancelled", "was cancelled"),
    };
    set.render(
        id,
        &[
            ("taskId", &task_id),
            ("verb", &verb),
            ("title", &one_line(title, 80)),
            ("where", &where_),
            ("receipts", &receipts),
            ("result", &quoted_tail),
        ],
    )
}

/// The "why you are woken" entry for a task waiting on input: its question, inline.
pub fn task_waiting_lines(set: &PromptSet, task_id: &str, title: &str, question: &str) -> String {
    set.render(
        "wake.task_waiting",
        &[
            ("taskId", &task_id),
            ("title", &one_line(title, 80)),
            ("question", &quoted(question).join("\n")),
        ],
    )
}

/// One digest line per task: running and idle, then queued with reasons, then those that ended since `since`.
pub fn task_digest_lines(set: &PromptSet, tasks: &[Task], since: Option<&str>) -> Vec<String> {
    let title = |t: &Task| one_line(t.title.as_str(), 80);
    let model = |t: &Task| format!("{}/{}", t.model.as_str(), effort_str(t.effort));
    let mut out = Vec::new();
    for t in tasks
        .iter()
        .filter(|t| matches!(t.state, TaskState::Running | TaskState::Idle))
    {
        let id = if t.state == TaskState::Idle {
            "digest.tasks.idle"
        } else {
            "digest.tasks.running"
        };
        let branch = t
            .branch
            .as_ref()
            .map_or_else(String::new, |b| format!(" [{}]", b.as_str()));
        out.push(set.render(
            id,
            &[
                ("taskId", &t.task_id),
                ("kind", &kind_str(t.kind)),
                ("model", &model(t)),
                ("title", &title(t)),
                ("branch", &branch),
            ],
        ));
    }
    for t in tasks.iter().filter(|t| t.state == TaskState::Queued) {
        let reason = t.queued_reason.as_ref().map_or("waiting", |r| r.as_str());
        out.push(set.render(
            "digest.tasks.queued",
            &[
                ("taskId", &t.task_id),
                ("kind", &kind_str(t.kind)),
                ("title", &title(t)),
                ("reason", &reason),
            ],
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
        out.push(set.render(
            "digest.tasks.ended",
            &[
                ("taskId", &t.task_id),
                ("state", &state_str(t.state)),
                ("title", &title(t)),
                ("result", &arrow),
            ],
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
