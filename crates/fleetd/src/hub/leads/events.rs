//! The event lines of a lead's wake: one per event since its last wake, after the state block (the digest), framed by
//! the `lead.wake` prompt. Facts in a fixed format: the lead prompt says how to read them, and "What agents are told"
//! (#wake-events) describes them for people.
//!
//! An event is `- <subject> <what>[: <detail>]`, and may carry a few `  > ` body lines: an agent's final message, its
//! question, a failed check's evidence. Ids (W3, T4, C2) stay because the lead passes them to its tools; the lead
//! never repeats them to the human.
use std::fmt::Display;

use super::digest::one_line;

/// How a task ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    Done,
    Failed,
    /// Its run died and fleetd did not resume it (`tasks::recovery`): the lead decides.
    NotResumed,
    Cancelled,
}

/// The project's agents against its cap, the second line of every state block: "agents: 4 running of 6 (auto:
/// memory 18 GB), 2 queued".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentsLine {
    pub running: i64,
    pub cap: i64,
    pub queued: i64,
    /// Where the cap comes from: "auto: memory 18 GB", "max agents set", "machine cap set".
    pub source: String,
}

impl Display for AgentsLine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "agents: {} running of {} ({}), {} queued",
            self.running, self.cap, self.source, self.queued
        )
    }
}

#[derive(Debug, Clone)]
pub enum Event<'a> {
    /// A new order from the human.
    Order { workstream: &'a str, text: &'a str },
    OrderStopped {
        workstream: &'a str,
        title: &'a str,
        why: &'a str,
        cancelled: i64,
    },
    /// A task ended. `place` is its branch and PR; `result` its final message.
    AgentEnded {
        task: &'a str,
        ended: Ended,
        title: &'a str,
        place: &'a str,
        result: &'a str,
    },
    /// fleetd resumed a task whose run died, in its thread and worktree. Quiet: in the next wake, never one alone.
    /// `doing` is the last thing the run did; `place` its branch; `worktree` what became of its worktree.
    AgentRecovered {
        task: &'a str,
        title: &'a str,
        place: &'a str,
        attempt: i64,
        recovery: i64,
        max: i64,
        cause: &'a str,
        doing: &'a str,
        worktree: &'a str,
    },
    /// A running task's machine has been offline for `minutes`; it resumes when the machine is back. Quiet.
    AgentUnreachable {
        task: &'a str,
        title: &'a str,
        place: &'a str,
        machine: &'a str,
        minutes: i64,
    },
    /// A message for a task, held while it waited to resume, that could not be sent to the run a person started.
    MessageNotSent {
        task: &'a str,
        title: &'a str,
        why: &'a str,
        text: &'a str,
    },
    AgentWaiting {
        task: &'a str,
        title: &'a str,
        question: &'a str,
    },
    /// A person steered a task directly, past the lead.
    AgentSteered {
        task: &'a str,
        kind: &'a str,
        steer: &'a str,
        text: &'a str,
    },
    PrMerged {
        change: &'a str,
        pr_url: &'a str,
        sha: &'a str,
        by: Option<&'a str>,
    },
    /// The train dropped a PR (closed, or a newer change replaced it).
    PrLeft {
        change: &'a str,
        pr_url: &'a str,
        why: &'a str,
    },
    PrGaveUp {
        change: &'a str,
        pr_url: &'a str,
        why: &'a str,
        tries: i64,
    },
    /// A PR's reviewers kept ending without a verdict: the train stopped starting new ones. `tail` is the last
    /// reviewer's final lines.
    PrReviewStalled {
        change: &'a str,
        pr_url: &'a str,
        task: &'a str,
        tries: i64,
        tail: &'a str,
    },
    PrRefused {
        pr_url: &'a str,
        task: &'a str,
        message: &'a str,
        fix: Option<&'a str>,
    },
    /// What the train told a PR's author, when there was no author task to tell.
    PrNote {
        change: &'a str,
        pr_url: &'a str,
        text: &'a str,
    },
    /// A secret or approval request settled, or came back open. `what` is the secret, command or tool prompt; `outcome`
    /// what became of it; `tail` a command's output tail.
    Request {
        request: &'a str,
        what: &'a str,
        outcome: &'a str,
        tail: Option<&'a str>,
    },
    /// A person raised the project's max agents; queued agents have already started.
    CapRaised { max_agents: i64, free: i64 },
}

fn quote(text: &str) -> String {
    format!("\"{}\"", one_line(text, 300))
}

/// `PR #12` from a GitHub PR URL; the URL itself when it has no number.
pub fn pr_label(url: &str) -> String {
    match url.rsplit_once("/pull/") {
        Some((_, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => {
            format!("PR #{n}")
        }
        _ => format!("PR {url}"),
    }
}

/// An agent's text as `  > ` lines.
pub fn body(text: &str) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return vec!["  > (no final message)".into()];
    }
    text.split('\n')
        .map(|l| format!("  > {l}").trim_end().to_owned())
        .collect()
}

impl Event<'_> {
    pub fn render(&self) -> String {
        let (head, rest): (String, Vec<String>) = match self {
            Event::Order { workstream, text } => {
                (format!("- new order {workstream}: {}", quote(text)), vec![])
            }
            Event::OrderStopped {
                workstream,
                title,
                why,
                cancelled,
            } => (
                format!(
                    "- {workstream} stopped by the human ({why}): {}; {cancelled} agents cancelled, merged PRs stay; do no more work on it",
                    one_line(title, 80)
                ),
                vec![],
            ),
            Event::AgentEnded {
                task,
                ended,
                title,
                place,
                result,
            } => {
                let verb = match ended {
                    Ended::Done => "finished",
                    Ended::Failed => "failed",
                    Ended::NotResumed => "failed and was not resumed",
                    Ended::Cancelled => "was cancelled",
                };
                (
                    format!("- {task} {verb}: {}{place}", one_line(title, 80)),
                    body(result),
                )
            }
            Event::AgentRecovered {
                task,
                title,
                place,
                attempt,
                recovery,
                max,
                cause,
                doing,
                worktree,
            } => (
                format!(
                    "- {task} resumed automatically (attempt {attempt}, recovery {recovery} of {max}): {}{place}",
                    one_line(title, 80)
                ),
                vec![format!(
                    "  > its run was cut off ({}) during: {}. {worktree}",
                    one_line(cause, 200),
                    one_line(doing, 200)
                )],
            ),
            Event::AgentUnreachable {
                task,
                title,
                place,
                machine,
                minutes,
            } => (
                format!(
                    "- {task} waits for {machine}, offline for {minutes} min: {}{place}; it resumes on its own when {machine} is back",
                    one_line(title, 80)
                ),
                vec![format!(
                    "  > Its worktree and session are on {machine}, so it stays there. To have it done elsewhere, cancel it and start a new task."
                )],
            ),
            Event::MessageNotSent {
                task,
                title,
                why,
                text,
            } => (
                format!(
                    "- {task} did not get your message ({why}): {}; it runs again, so send it again with message_agent if it still applies",
                    one_line(title, 80)
                ),
                body(text),
            ),
            Event::AgentWaiting {
                task,
                title,
                question,
            } => (
                format!("- {task} waiting for an answer: {}", one_line(title, 80)),
                body(question),
            ),
            Event::AgentSteered {
                task,
                kind,
                steer,
                text,
            } => (
                format!(
                    "- the human steered {task} ({kind}) directly ({steer}): {}",
                    quote(text)
                ),
                vec![],
            ),
            Event::PrMerged {
                change,
                pr_url,
                sha,
                by,
            } => (
                format!(
                    "- {} merged{sha}: {pr_url} ({change}{})",
                    pr_label(pr_url),
                    by.map(|b| format!(", by {b}")).unwrap_or_default()
                ),
                vec![],
            ),
            Event::PrLeft {
                change,
                pr_url,
                why,
            } => (
                format!(
                    "- {} left the train: {why} ({change}, {pr_url})",
                    pr_label(pr_url)
                ),
                vec![],
            ),
            Event::PrGaveUp {
                change,
                pr_url,
                why,
                tries,
            } => (
                format!(
                    "- {} not merged: {why}; the train gave up after {tries} tries ({change}, {pr_url})",
                    pr_label(pr_url)
                ),
                vec![],
            ),
            Event::PrReviewStalled {
                change,
                pr_url,
                task,
                tries,
                tail,
            } => (
                format!(
                    "- {} not reviewed: {tries} reviewers in a row ended without a verdict, the last {task}; the train starts no more ({change}, {pr_url})",
                    pr_label(pr_url)
                ),
                body(tail),
            ),
            Event::PrRefused {
                pr_url,
                task,
                message,
                fix,
            } => (
                format!(
                    "- {} from {task} refused by the train: {message}{} ({pr_url})",
                    pr_label(pr_url),
                    fix.map(|f| format!(" Fix: {f}.")).unwrap_or_default()
                ),
                vec![],
            ),
            Event::PrNote {
                change,
                pr_url,
                text,
            } => (
                format!("- {} ({change}): {}", pr_label(pr_url), one_line(text, 600)),
                vec![],
            ),
            Event::Request {
                request,
                what,
                outcome,
                tail,
            } => (
                format!("- {request} {what}: {outcome}"),
                tail.filter(|t| !t.trim().is_empty())
                    .map(body)
                    .unwrap_or_default(),
            ),
            Event::CapRaised { max_agents, free } => (
                format!(
                    "- cap raised to {max_agents}: {free} slot{} free; queued agents already started",
                    if *free == 1 { "" } else { "s" }
                ),
                vec![],
            ),
        };
        std::iter::once(head)
            .chain(rest)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(e: Event) -> String {
        e.render()
    }

    #[test]
    fn a_result_is_quoted_line_by_line_and_an_empty_one_says_so() {
        let ended = |result| {
            r(Event::AgentEnded {
                task: "T4",
                ended: Ended::Done,
                title: "fix login",
                place: "",
                result,
            })
        };
        assert!(ended("Fixed it.\nTests pass.").ends_with("\n  > Fixed it.\n  > Tests pass."));
        assert!(ended("").ends_with("\n  > (no final message)"));
    }

    #[test]
    fn a_recovery_says_what_was_cut_off_and_that_nothing_is_to_do() {
        assert_eq!(
            r(Event::AgentRecovered {
                task: "T23",
                title: "B: progress bar takes in-flight credit back",
                place: " [fleetd/T23-b-progress-bar]",
                attempt: 2,
                recovery: 1,
                max: 3,
                cause: "the node on devbox stopped",
                doing: "Ran cargo test --workspace",
                worktree: "It goes on in its own worktree; nothing for you to do.",
            }),
            "- T23 resumed automatically (attempt 2, recovery 1 of 3): B: progress bar takes in-flight credit back \
             [fleetd/T23-b-progress-bar]\n  > its run was cut off (the node on devbox stopped) during: Ran cargo test \
             --workspace. It goes on in its own worktree; nothing for you to do."
        );
        assert_eq!(
            r(Event::AgentUnreachable {
                task: "T23",
                title: "B: progress bar",
                place: "",
                machine: "devbox",
                minutes: 30,
            }),
            "- T23 waits for devbox, offline for 30 min: B: progress bar; it resumes on its own when devbox is back\n  > \
             Its worktree and session are on devbox, so it stays there. To have it done elsewhere, cancel it and start \
             a new task."
        );
    }

    #[test]
    fn a_pr_label_is_its_number_or_the_url() {
        assert_eq!(pr_label("https://github.com/o/r/pull/12"), "PR #12");
        assert_eq!(
            pr_label("https://example.com/x"),
            "PR https://example.com/x"
        );
    }
}
