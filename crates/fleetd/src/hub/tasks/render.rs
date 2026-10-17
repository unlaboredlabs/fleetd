//! Text the hub writes for tasks: the branch name, the task's first message, its line in the lead digest, and the
//! result the lead receives inline in its wake. Pure. Lengths count UTF-16 units, as the TS hub's did.
//! TS spec: apps/hub/src/tasks/render.ts.
use std::sync::LazyLock;

use fleetd_contracts::ledger::Brief;
use fleetd_contracts::tasks::{Task, TaskKind, TaskResult, TaskResultStatus, TaskState};
use regex::Regex;
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

pub fn branch_for(task_id: &str, title: &str) -> String {
    format!("fleetd/{task_id}-{}", slug_of(title))
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

/// The task's first message: the lead's text with the brief, the areas and the rules around it.
pub fn render_task_prompt(input: &PromptInput<'_>) -> String {
    let task = input.task;
    let task_id = task.task_id.as_str();
    let serves = task.serves.as_ref().map(|s| s.as_str());
    let mut context = Vec::new();
    if let Some(brief) = input.brief {
        context.push(format!("Goal: {}", one_line(brief.goal.as_str(), 1000)));
        context.push(format!(
            "Done when: {}",
            crate::hub::leads::digest::done_when_text(&brief.done_when, None, 200)
        ));
    }
    if let Some(serves) = serves {
        context.push(format!("This task serves: {}", one_line(serves, 200)));
    }

    let mut rules = Vec::new();
    if task.kind == TaskKind::Write {
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
        rules.push(format!("- Only change files in these areas: {areas}. Changes anywhere else are flagged as out of area."));
        let base = input.base_branch.map_or_else(
            || "the default branch".to_owned(),
            |b| format!("the default branch ({b})"),
        );
        rules.push(format!(
            "- You work in your own worktree on branch {}. Commit to your branch; do not merge; do not push to {base}.",
            input.branch.unwrap_or("your task branch")
        ));
        // M7: only the merge train merges, and it takes a PR only with the Source: line it checks.
        let branch = input.branch.unwrap_or("<your branch>");
        rules.push(format!(
            "- If the repo's origin is on GitHub: when your commits are done, `git push -u origin {branch}` and open a pull request with `gh pr create --base {} --head {branch}` whose body has the line `Source: {}`, and put its URL in your result. Never merge it and never post a `fleetd/train` commit status: fleetd's merge train merges it. Without a GitHub origin, just commit.",
            input.base_branch.unwrap_or("<default branch>"),
            serves.unwrap_or("<what this serves>"),
        ));
    } else {
        rules.push(
            "- This is a read-only task: do not change, commit or push any files.".to_owned(),
        );
    }
    rules.push("- Do the task yourself; do not hand it to subagents.".to_owned());
    if task.kind == TaskKind::Review {
        // The value bar keys review rounds on this verdict: one clean pass per commit ends review.
        rules.push(format!(
            "- Before your final message, record your verdict once: `fleetd review verdict --task {task_id} --sha <the full SHA you reviewed> --blocking <n> --non-blocking <n> --summary \"<one paragraph>\"`. Blocking findings are the ones that must change before merge."
        ));
    }
    rules.push("- End with a one-paragraph result: what you did, what is left, and anything the lead must decide.".to_owned());

    let mut lines = vec![
        format!(
            "You are fleetd task {task_id} ({}) for workstream {} in project {}: {}",
            kind_str(task.kind),
            task.workstream_id.as_str(),
            one_line(input.project_title, 80),
            task.title.as_str()
        ),
        String::new(),
        "## Task".to_owned(),
        task.prompt.as_str().trim().to_owned(),
    ];
    if !context.is_empty() {
        lines.push(String::new());
        lines.push("## Workstream".to_owned());
        lines.extend(context);
    }
    lines.push(String::new());
    lines.push("## Rules".to_owned());
    lines.extend(rules);
    lines.join("\n")
}

fn quoted(text: &str) -> Vec<String> {
    text.trim()
        .split('\n')
        .map(|l| format!("  > {l}").trim_end().to_owned())
        .collect()
}

/// The "why you are woken" entry for a finished task: its whole result tail, inline.
/// `receipts` is the receipts area's line for this result (TS receiptsLine).
pub fn task_result_lines(
    task_id: &str,
    title: &str,
    result: &TaskResult,
    receipts: Option<&str>,
) -> String {
    let verb = match result.status {
        TaskResultStatus::Done => "completed",
        TaskResultStatus::Failed => "failed",
        TaskResultStatus::Cancelled => "was cancelled",
    };
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
    let mut out = vec![format!(
        "- {task_id} {verb}: {}{where_}",
        one_line(title, 80)
    )];
    // M6 receipts, counted by the hub; absent on results stored before them.
    if let Some(receipts) = receipts {
        out.push(format!("  {receipts}"));
    }
    out.push("  result:".to_owned());
    let tail = result.tail.as_str();
    if tail.trim().is_empty() {
        out.push("  > (no final message)".to_owned());
    } else {
        out.extend(quoted(tail));
    }
    out.push(if result.status == TaskResultStatus::Cancelled {
        "  next: nothing; spawn a new task if the work is still needed.".to_owned()
    } else {
        format!("  next: judge the result; `fleetd task message {task_id} \"<text>\"` continues the same thread.")
    });
    out.join("\n")
}

/// The "why you are woken" entry for a task waiting on input: its question, inline.
pub fn task_waiting_lines(task_id: &str, title: &str, question: &str) -> String {
    let mut out = vec![
        format!("- {task_id} is waiting for input: {}", one_line(title, 80)),
        "  question:".to_owned(),
    ];
    out.extend(quoted(question));
    out.push(format!(
        "  next: answer it with `fleetd task message {task_id} \"<answer>\"`, or `fleetd task cancel {task_id}`. Ask the human only if it is a product, money, credential or irreversible call."
    ));
    out.join("\n")
}

/// One digest line per task: running and idle, then queued with reasons, then those that ended since `since`.
pub fn task_digest_lines(tasks: &[Task], since: Option<&str>) -> Vec<String> {
    let title = |t: &Task| one_line(t.title.as_str(), 80);
    let model = |t: &Task| format!("{}/{}", t.model.as_str(), effort_str(t.effort));
    let mut out = Vec::new();
    for t in tasks
        .iter()
        .filter(|t| matches!(t.state, TaskState::Running | TaskState::Idle))
    {
        let what = if t.state == TaskState::Idle {
            "idle, waiting for input"
        } else {
            "running"
        };
        let branch = t
            .branch
            .as_ref()
            .map_or_else(String::new, |b| format!(" [{}]", b.as_str()));
        out.push(format!(
            "- {} {what} ({}, {}): {}{branch}",
            t.task_id.as_str(),
            kind_str(t.kind),
            model(t),
            title(t)
        ));
    }
    for t in tasks.iter().filter(|t| t.state == TaskState::Queued) {
        let reason = t.queued_reason.as_ref().map_or("waiting", |r| r.as_str());
        out.push(format!(
            "- {} queued ({}): {}; {reason}",
            t.task_id.as_str(),
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
            t.task_id.as_str(),
            state_str(t.state),
            title(t)
        ));
    }
    out
}
