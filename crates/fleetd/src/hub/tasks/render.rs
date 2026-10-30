//! Text the hub writes for tasks: the branch name, the task's first message, its line in the lead digest, and its
//! event lines in the lead's wake. Pure. Lengths count UTF-16 units, as older hubs' did.
use std::sync::LazyLock;

use fleetd_contracts::ledger::{Brief, Decision, DecisionState};
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

const REFS: &str = "Refs: ";

/// A finished task's result as stored: whole when it fits in `max`, else its head and its tail around a "…" line, then
/// a last line "Refs: …" lifting every PR URL, attachment id (F12) and commit SHA of the whole text, so no cut loses
/// them.
pub fn result_text(text: &str, max: usize) -> String {
    let t = text.trim();
    if js_len(t) <= max {
        return t.to_owned();
    }
    let refs = refs_of(t);
    // A text cut once already (the executor's copy of a long message) ends in its own Refs line: the new one
    // replaces it, and holds all of its refs.
    let t = t
        .rsplit_once(&format!("\n\n{REFS}"))
        .filter(|(_, last)| !last.contains('\n'))
        .map_or(t, |(body, _)| body.trim_end());
    let line = if refs.is_empty() {
        String::new()
    } else {
        format!(
            "\n\n{}",
            one_line(&format!("{REFS}{}", refs.join(" ")), max / 2)
        )
    };
    let room = max - js_len(&line) - js_len("\n…\n");
    let head = js_prefix(t, room / 2).trim_end();
    let tail = js_suffix(t, room - js_len(head)).trim_start();
    format!("{head}\n…\n{tail}{line}")
}

/// A token of letters, digits, `_` and `-`: an attachment id or a commit SHA is one whole, a UUID's part is not.
static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[0-9A-Za-z_-]+").unwrap());

fn is_attachment_id(token: &str) -> bool {
    token.strip_prefix('F').is_some_and(|n| {
        !n.is_empty() && !n.starts_with('0') && n.bytes().all(|b| b.is_ascii_digit())
    })
}

/// 7 to 40 lowercase hex digits with a letter and a digit, so neither a number nor a hex-looking word.
fn is_sha(token: &str) -> bool {
    (7..=40).contains(&token.len())
        && token
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && token.bytes().any(|b| b.is_ascii_digit())
        && token.bytes().any(|b| b.is_ascii_alphabetic())
}

/// What a result names that a cut must never lose, each once: its PR URLs, then its attachment ids, then its commit
/// SHAs, in the order they appear.
pub fn refs_of(text: &str) -> Vec<String> {
    let tokens: Vec<&str> = TOKEN.find_iter(text).map(|m| m.as_str()).collect();
    let ids = tokens.iter().filter(|t| is_attachment_id(t));
    let shas = tokens.iter().filter(|t| is_sha(t));
    let mut refs: Vec<String> = Vec::new();
    for r in pr_urls([text])
        .into_iter()
        .chain(ids.chain(shas).map(|t| (*t).to_owned()))
    {
        if !refs.contains(&r) {
            refs.push(r);
        }
    }
    refs
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
    /// The decisions the brief names by id or key, whole.
    pub decisions: &'a [Decision],
    /// Write tasks: their branch. Every task's worktree starts from the remote's copy of `base_branch`.
    pub branch: Option<&'a str>,
    pub base_branch: Option<&'a str>,
    /// Write tasks: the work in flight elsewhere they may overlap (`duplicates::for_writer`).
    pub elsewhere: &'a [String],
    /// Write tasks: the user memory of whoever started the order and the project's `MEMORY.md` (`Memory::injected`), or
    /// empty.
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

/// A brief's whole text, to find the decisions it names.
pub fn brief_text(brief: &Brief) -> String {
    let mut parts = vec![brief.goal.as_str(), brief.why.as_str()];
    parts.extend(brief.pointers.iter().map(|l| l.as_str()));
    parts.extend(brief.constraints.iter().map(|l| l.as_str()));
    parts.extend(brief.done_when.iter().map(|l| l.as_str()));
    parts.join("\n")
}

/// `- D12 api.health.path = /healthz (why: ...)`, whole; one no longer in force says so.
fn decision_line(d: &Decision) -> String {
    let why = d
        .why
        .as_ref()
        .map(|w| format!(" (why: {})", w.as_str().trim()))
        .unwrap_or_default();
    let state = match d.state {
        DecisionState::Active => "",
        DecisionState::Superseded => " [superseded]",
        DecisionState::Retired => " [retired]",
    };
    format!(
        "- {}{state} {} = {}{why}",
        d.decision_id,
        d.key.as_str(),
        d.value.as_str().trim()
    )
}

/// A task's system prompt and first message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskPrompt {
    /// Its standing rules, which a compaction never summarizes: its brief's `## Rules` and all after them, the human's
    /// custom instructions and the memory. Empty for a brief with no `## Rules` and nothing after it.
    pub system: String,
    /// The lead's text and the brief around it.
    pub first: String,
}

/// The heading a brief's standing rules start at (`task.brief.*`).
const RULES: &str = "\n## Rules\n";

/// The task's brief: the lead's text with the brief and the rules around it, then the human's custom instructions and
/// the memory. Its rules on go in its system prompt, all before them in its first message.
pub fn render_task_prompt(set: &PromptSet, input: &PromptInput<'_>) -> TaskPrompt {
    let task = input.task;
    let mut context = Vec::new();
    if let Some(brief) = input.brief {
        context.push(format!("Goal: {}", one_line(brief.goal.as_str(), 1000)));
        context.push(format!("Why: {}", brief.why.as_str().trim()));
        for (name, lines) in [
            ("Pointers", &brief.pointers),
            ("Constraints", &brief.constraints),
        ] {
            if !lines.is_empty() {
                context.push(format!("{name}:"));
                context.extend(lines.iter().map(|l| format!("- {}", l.as_str().trim())));
            }
        }
        context.push(format!(
            "Done when: {}",
            input.done_when.as_deref().unwrap_or_default()
        ));
    }
    if !input.decisions.is_empty() {
        context.push("Decisions it names:".to_owned());
        context.extend(input.decisions.iter().map(decision_line));
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
    let brief = set.render(id, vars);
    // The template's own heading is the last: the lead's text and the workstream come before it, and may hold one too.
    let (first, rules) = match brief.rfind(RULES) {
        Some(at) => (brief[..at].trim_end(), &brief[at + 1..]),
        None => (brief.trim_end(), ""),
    };
    let mut system = set.with_instructions(rules.trim_end().to_owned());
    if !input.memory.is_empty() {
        system = format!("{system}\n\n{}", input.memory);
    }
    TaskPrompt {
        system: system.trim_start().to_owned(),
        first: first.to_owned(),
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
                let tail = tail.strip_prefix('…').unwrap_or(tail);
                let body = tail
                    .rsplit_once(&format!("\n\n{REFS}"))
                    .map_or(tail, |(body, _)| body);
                let shown = one_line(body, 160);
                // The line is cut, its refs never: those it or the PR beside the title already show are left out.
                let seen = refs_of(&shown);
                let refs: Vec<String> = refs_of(tail)
                    .into_iter()
                    .filter(|p| !seen.contains(p))
                    .filter(|p| r.pr_url.as_ref().is_none_or(|pr| pr.as_str() != p))
                    .collect();
                if refs.is_empty() {
                    shown
                } else {
                    format!("{shown} {REFS}{}", refs.join(" "))
                }
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

    /// A long result keeps its head and its tail, and a last Refs line holds every PR URL, attachment id and commit
    /// SHA, even those from the middle that was cut.
    #[test]
    fn a_long_result_keeps_its_head_tail_and_refs() {
        let middle = "Took screenshots F12 and F13, pushed 3f9c2ab1, then CI went red; ".repeat(60);
        let text = format!(
            "Done: the sidebar glides. PR https://github.com/o/r/pull/868.\n{middle}\nLeft: nothing. See F14."
        );
        let kept = result_text(&text, TAIL_MAX);
        assert!(js_len(&kept) <= TAIL_MAX, "{}", js_len(&kept));
        assert!(kept.starts_with("Done: the sidebar glides."), "{kept}");
        assert!(kept.contains("\n…\n"), "{kept}");
        let (body, refs) = kept.rsplit_once("\n\n").unwrap();
        assert!(body.ends_with("Left: nothing. See F14."), "{body}");
        assert_eq!(
            refs,
            "Refs: https://github.com/o/r/pull/868 F12 F13 F14 3f9c2ab1"
        );
        // Cut again, it keeps one Refs line, with every ref.
        let again = result_text(&format!("More at the start: F9.\n{kept}"), 1000);
        assert_eq!(again.matches("Refs: ").count(), 1, "{again}");
        assert!(
            again.ends_with("\n\nRefs: https://github.com/o/r/pull/868 F9 F12 F13 F14 3f9c2ab1"),
            "{again}"
        );
        // A short one stays as it was, with no Refs line.
        assert_eq!(
            result_text("  Fixed it in F2.  ", TAIL_MAX),
            "Fixed it in F2."
        );
    }

    /// Ids are whole tokens: a UUID's part, a plain number, a hex-looking word and F0 are none.
    #[test]
    fn refs_are_whole_ids_each_once() {
        assert_eq!(
            refs_of(
                "F3 then F3, commit abc1234 and abc1234def; project 0a00fc86-8668-4fe9, run 12345678, \
                 deadbeef, F0, FOO1, https://github.com/o/r/pull/7 and https://github.com/o/r/pull/7"
            ),
            [
                "https://github.com/o/r/pull/7",
                "F3",
                "abc1234",
                "abc1234def"
            ]
        );
    }

    /// The digest's line for an ended task is cut, but names every ref its text holds beyond the cut and the PR.
    #[test]
    fn a_first_messages_ended_line_keeps_the_refs_its_cut_lost() {
        let tail = result_text(
            &format!(
                "{} Shots F21 and F22, head 9e8d7c6b.",
                "Long story. ".repeat(300)
            ),
            TAIL_MAX,
        );
        let task: Task = serde_json::from_value(serde_json::json!({
            "taskId": "T5", "projectRef": { "machineId": "lab-a", "projectId": "p1" }, "workstreamId": "W1",
            "title": "B", "kind": "write", "prompt": "do it", "state": "done", "attempt": 1,
            "createdAt": "2026-10-25T09:00:00.000Z", "endedAt": "2026-10-25T10:00:00.000Z",
            "result": { "status": "done", "tail": tail, "prUrl": "https://github.com/o/r/pull/9",
                        "at": "2026-10-25T10:00:00.000Z" },
        }))
        .unwrap();
        let line = &task_digest_lines(std::slice::from_ref(&task), None, "", &|_| None)[0];
        assert!(line.contains("[https://github.com/o/r/pull/9]"), "{line}");
        assert!(line.ends_with("… Refs: F21 F22 9e8d7c6b"), "{line}");
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
