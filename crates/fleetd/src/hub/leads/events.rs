//! The event lines of a lead's wake: one per event since its last wake, after the state block (the digest), framed by
//! the `lead.wake` prompt. Facts in a fixed format: the lead prompt says how to read them, and "What agents are told"
//! (#wake-events) describes them for people.
//!
//! An event is `- <subject> <what>[: <detail>]`, and may carry a few `  > ` body lines: an agent's final message, its
//! question, a failed check's evidence. Ids (W3, T4, C2) stay because the lead passes them to its tools; the lead
//! never repeats them to the human.
use std::fmt::Display;

use fleetd_contracts::ledger::ResearchOutcome;

use super::digest::one_line;

/// How a task ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    Done,
    Failed,
    Cancelled,
}

/// The project's agents against its cap, the second line of every state block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentsLine {
    pub running: i64,
    pub cap: i64,
    pub queued: i64,
}

impl Display for AgentsLine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "agents: {} running of {}, {} queued",
            self.running, self.cap, self.queued
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
    ResearchVerdict {
        workstream: &'a str,
        verdict: ResearchOutcome,
        measured: &'a str,
        go: &'a str,
        stop: &'a str,
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
                    Ended::Cancelled => "was cancelled",
                };
                (
                    format!("- {task} {verb}: {}{place}", one_line(title, 80)),
                    body(result),
                )
            }
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
            Event::ResearchVerdict {
                workstream,
                verdict,
                measured,
                go,
                stop,
            } => {
                let word = match verdict {
                    ResearchOutcome::Go => "GO",
                    ResearchOutcome::Stop => "STOP",
                    ResearchOutcome::Inconclusive => "INCONCLUSIVE",
                };
                (
                    format!(
                        "- {workstream} research verdict {word}: {measured} (go line {go}, stop line {stop})"
                    ),
                    vec![],
                )
            }
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
    fn agents_line() {
        let a = AgentsLine {
            running: 7,
            cap: 12,
            queued: 2,
        };
        assert_eq!(a.to_string(), "agents: 7 running of 12, 2 queued");
    }

    #[test]
    fn order_events() {
        assert_eq!(
            r(Event::Order {
                workstream: "W3",
                text: "add a dark\nmode"
            }),
            "- new order W3: \"add a dark mode\""
        );
        assert_eq!(
            r(Event::OrderStopped {
                workstream: "W3",
                title: "dark mode",
                why: "not needed",
                cancelled: 2
            }),
            "- W3 stopped by the human (not needed): dark mode; 2 agents cancelled, merged PRs stay; do no more work on it"
        );
    }

    #[test]
    fn agent_events() {
        assert_eq!(
            r(Event::AgentEnded {
                task: "T4",
                ended: Ended::Done,
                title: "fix login",
                place: " (branch fix/login, PR https://github.com/o/r/pull/12)",
                result: "Fixed it.\nTests pass."
            }),
            "- T4 finished: fix login (branch fix/login, PR https://github.com/o/r/pull/12)\n  > Fixed it.\n  > Tests pass."
        );
        assert_eq!(
            r(Event::AgentEnded {
                task: "T5",
                ended: Ended::Failed,
                title: "port",
                place: "",
                result: ""
            }),
            "- T5 failed: port\n  > (no final message)"
        );
        assert_eq!(
            r(Event::AgentEnded {
                task: "T6",
                ended: Ended::Cancelled,
                title: "port",
                place: "",
                result: "stopped"
            }),
            "- T6 was cancelled: port\n  > stopped"
        );
        assert_eq!(
            r(Event::AgentWaiting {
                task: "T7",
                title: "docs",
                question: "which branch?"
            }),
            "- T7 waiting for an answer: docs\n  > which branch?"
        );
        assert_eq!(
            r(Event::AgentSteered {
                task: "T4",
                kind: "write",
                steer: "S2",
                text: "keep the old API"
            }),
            "- the human steered T4 (write) directly (S2): \"keep the old API\""
        );
    }

    #[test]
    fn train_events() {
        let url = "https://github.com/o/r/pull/12";
        assert_eq!(
            r(Event::PrMerged {
                change: "C4",
                pr_url: url,
                sha: " as abc1234",
                by: Some("T4")
            }),
            "- PR #12 merged as abc1234: https://github.com/o/r/pull/12 (C4, by T4)"
        );
        assert_eq!(
            r(Event::PrLeft {
                change: "C4",
                pr_url: url,
                why: "closed on GitHub"
            }),
            "- PR #12 left the train: closed on GitHub (C4, https://github.com/o/r/pull/12)"
        );
        assert_eq!(
            r(Event::PrGaveUp {
                change: "C4",
                pr_url: url,
                why: "branch protection",
                tries: 3
            }),
            "- PR #12 not merged: branch protection; the train gave up after 3 tries (C4, https://github.com/o/r/pull/12)"
        );
        assert_eq!(
            r(Event::PrRefused {
                pr_url: url,
                task: "T4",
                message: "It is closed.",
                fix: Some("enqueue an open PR")
            }),
            "- PR #12 from T4 refused by the train: It is closed. Fix: enqueue an open PR. (https://github.com/o/r/pull/12)"
        );
        assert_eq!(
            r(Event::PrNote {
                change: "C4",
                pr_url: url,
                text: "CI red in rust (macos)"
            }),
            "- PR #12 (C4): CI red in rust (macos)"
        );
        assert_eq!(
            pr_label("https://example.com/x"),
            "PR https://example.com/x"
        );
    }

    #[test]
    fn research_verdict_events() {
        for (verdict, word) in [
            (ResearchOutcome::Go, "GO"),
            (ResearchOutcome::Stop, "STOP"),
            (ResearchOutcome::Inconclusive, "INCONCLUSIVE"),
        ] {
            assert_eq!(
                r(Event::ResearchVerdict {
                    workstream: "W2",
                    verdict,
                    measured: "candidate 0.6 vs baseline 0.5: improvement 0.1",
                    go: "0.1",
                    stop: "0.02"
                }),
                format!(
                    "- W2 research verdict {word}: candidate 0.6 vs baseline 0.5: improvement 0.1 (go line 0.1, stop line 0.02)"
                )
            );
        }
    }

    #[test]
    fn request_events() {
        assert_eq!(
            r(Event::Request {
                request: "Q3",
                what: "your command `sh -c \"make migrate\"`",
                outcome: "ran: exit 0 on lab-a, approved by human:desk",
                tail: Some("migrated 3 tables\nok"),
            }),
            "- Q3 your command `sh -c \"make migrate\"`: ran: exit 0 on lab-a, approved by human:desk\n  > migrated 3 tables\n  > ok"
        );
        assert_eq!(
            r(Event::Request {
                request: "Q4",
                what: "secret stripe.test_key",
                outcome: "stored on lab-a (fingerprint ab12cd34); use it from its sink, you never see the value",
                tail: None,
            }),
            "- Q4 secret stripe.test_key: stored on lab-a (fingerprint ab12cd34); use it from its sink, you never see the value"
        );
        assert_eq!(
            r(Event::Request {
                request: "Q5",
                what: "your command `./deploy.sh prod`",
                outcome: "denied by human:desk: not on a Friday; don't run it, say in the chat what you do instead",
                tail: Some(""),
            }),
            "- Q5 your command `./deploy.sh prod`: denied by human:desk: not on a Friday; don't run it, say in the chat what you do instead"
        );
    }

    #[test]
    fn cap_raised_event() {
        assert_eq!(
            r(Event::CapRaised {
                max_agents: 12,
                free: 9
            }),
            "- cap raised to 12: 9 slots free; queued agents already started"
        );
    }
}
