//! What a lead is told at a wake: the state block (the digest), then one line per event since its last wake. A fixed
//! format rendered here, not a prompt: no one edits it, the lead prompt says how to read it, and "What agents are
//! told" (#wake-events) describes it for people.
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

/// How the human settled one of the lead's asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settled {
    Answered,
    /// They wrote their own answer instead of picking an option.
    OwnWords,
    /// Skipped for now: the lead carries on with its recommendation.
    Skipped,
    Withdrawn,
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
    Order {
        workstream: &'a str,
        text: &'a str,
    },
    /// References and attachments that came with an order.
    OrderRefs {
        workstream: &'a str,
        references: &'a str,
    },
    OrderStopped {
        workstream: &'a str,
        title: &'a str,
        why: &'a str,
        cancelled: i64,
    },
    /// A task ended. `place` is its branch and PR; `receipts` the hub's count line; `result` its final message.
    AgentEnded {
        task: &'a str,
        ended: Ended,
        title: &'a str,
        place: &'a str,
        receipts: Option<&'a str>,
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
    /// `failures` are the failed checks' lines, already indented.
    ClaimFailed {
        claim: &'a str,
        workstream: &'a str,
        failures: &'a [String],
    },
    ClaimPassed {
        claim: &'a str,
        workstream: &'a str,
    },
    /// The checks passed, but write work of the order has not landed, so it stays open. `ids` are for tools only.
    ClaimHeld {
        claim: &'a str,
        workstream: &'a str,
        work: &'a str,
        ids: &'a str,
    },
    /// The order became done some other way while write work of it had not landed; that work keeps going.
    OrderDoneWorkKept {
        workstream: &'a str,
        work: &'a str,
        ids: &'a str,
    },
    PrMerged {
        change: &'a str,
        pr_url: &'a str,
        sha: &'a str,
        tier: &'a str,
        serves: &'a str,
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
    /// Slots are free and approved work could start.
    Runnable {
        items: &'a str,
        room: i64,
    },
    /// An ask settled: an answer, a gated command that ran, a saved secret, a checked step. `value` carries the
    /// option's label when it has one; `evidence` is what the hub observed.
    Answered {
        ask: &'a str,
        key: &'a str,
        settled: Settled,
        value: &'a str,
        decision: Option<&'a str>,
        evidence: Option<&'a str>,
    },
    /// The lead ended a turn with an approved order and nothing under way: nothing else would wake it for it.
    OrderIdle {
        workstream: &'a str,
        title: &'a str,
    },
    /// A person raised the project's max agents; queued agents have already started.
    CapRaised {
        max_agents: i64,
        free: i64,
    },
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
            Event::OrderRefs {
                workstream,
                references,
            } => (format!("- {workstream} came with:{references}"), vec![]),
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
                receipts,
                result,
            } => {
                let verb = match ended {
                    Ended::Done => "finished",
                    Ended::Failed => "failed",
                    Ended::Cancelled => "was cancelled",
                };
                let mut rest: Vec<String> =
                    receipts.map(|r| format!("  {r}")).into_iter().collect();
                rest.extend(body(result));
                (
                    format!("- {task} {verb}: {}{place}", one_line(title, 80)),
                    rest,
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
            Event::ClaimFailed {
                claim,
                workstream,
                failures,
            } => (
                format!("- claim {claim} on {workstream} failed: {workstream} stays verifying"),
                failures.to_vec(),
            ),
            Event::ClaimPassed { claim, workstream } => (
                format!("- claim {claim} on {workstream} passed: {workstream} is done"),
                vec![],
            ),
            Event::ClaimHeld {
                claim,
                workstream,
                work,
                ids,
            } => (
                format!(
                    "- claim {claim} on {workstream} passed, but write work that hasn't landed is still open: {work} (ids: {ids}); {workstream} stays open"
                ),
                vec![],
            ),
            Event::OrderDoneWorkKept {
                workstream,
                work,
                ids,
            } => (
                format!(
                    "- {workstream} is done; its write work that hadn't landed keeps going: {work} (ids: {ids})"
                ),
                vec![],
            ),
            Event::PrMerged {
                change,
                pr_url,
                sha,
                tier,
                serves,
                by,
            } => (
                format!(
                    "- {} merged{sha}: {pr_url} ({change}, tier {tier}, serves {serves}{})",
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
            Event::Answered {
                ask,
                key,
                settled,
                value,
                decision,
                evidence,
            } => {
                let value = one_line(value, 300);
                let head = match settled {
                    Settled::Withdrawn => format!("- {ask} {key} withdrawn by the human: drop it"),
                    Settled::Skipped => format!(
                        "- {ask} {key} skipped for now: carry on with your recommendation ({value}); no decision was recorded"
                    ),
                    Settled::Answered | Settled::OwnWords => format!(
                        "- {ask} {key} answered{}: {value}{}",
                        if *settled == Settled::OwnWords {
                            " in the human's own words"
                        } else {
                            ""
                        },
                        decision.map(|d| format!(" ({d})")).unwrap_or_default()
                    ),
                };
                let rest = evidence
                    .filter(|e| !e.trim().is_empty())
                    .map(|e| body(&one_line(e, 600)))
                    .unwrap_or_default();
                (head, rest)
            }
            Event::OrderIdle { workstream, title } => (
                format!(
                    "- {workstream} idle: {}; no agent running, nothing asked, and nothing else will wake you for it",
                    one_line(title, 80)
                ),
                vec![],
            ),
            Event::CapRaised { max_agents, free } => (
                format!(
                    "- cap raised to {max_agents}: {free} slot{} free; queued agents already started",
                    if *free == 1 { "" } else { "s" }
                ),
                vec![],
            ),
            Event::Runnable { items, room } => (
                format!(
                    "- {room} slot{} free; approved work can start: {items}",
                    if *room == 1 { "" } else { "s" }
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

/// A whole wake: the state block, then the events in the order they came.
pub fn frame(state: &str, events: &[String]) -> String {
    format!("{state}\n\n## Events\n{}", events.join("\n"))
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
            r(Event::OrderRefs {
                workstream: "W3",
                references: "\n  - https://example.com/spec"
            }),
            "- W3 came with:\n  - https://example.com/spec"
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
                receipts: Some("receipts: 3 commits"),
                result: "Fixed it.\nTests pass."
            }),
            "- T4 finished: fix login (branch fix/login, PR https://github.com/o/r/pull/12)\n  receipts: 3 commits\n  > Fixed it.\n  > Tests pass."
        );
        assert_eq!(
            r(Event::AgentEnded {
                task: "T5",
                ended: Ended::Failed,
                title: "port",
                place: "",
                receipts: None,
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
                receipts: None,
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
    fn claim_events() {
        let failures = vec![
            "  done:1 (CI green on o/r): fail".to_owned(),
            "    > red".to_owned(),
        ];
        assert_eq!(
            r(Event::ClaimFailed {
                claim: "C2",
                workstream: "W3",
                failures: &failures
            }),
            "- claim C2 on W3 failed: W3 stays verifying\n  done:1 (CI green on o/r): fail\n    > red"
        );
        assert_eq!(
            r(Event::ClaimPassed {
                claim: "C2",
                workstream: "W3"
            }),
            "- claim C2 on W3 passed: W3 is done"
        );
        assert_eq!(
            r(Event::ClaimHeld {
                claim: "C2",
                workstream: "W3",
                work: "the review's fixes",
                ids: "T7"
            }),
            "- claim C2 on W3 passed, but write work that hasn't landed is still open: the review's fixes (ids: T7); W3 stays open"
        );
        assert_eq!(
            r(Event::OrderDoneWorkKept {
                workstream: "W3",
                work: "the review's fixes",
                ids: "T7"
            }),
            "- W3 is done; its write work that hadn't landed keeps going: the review's fixes (ids: T7)"
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
                tier: "S",
                serves: "done:0",
                by: Some("T4")
            }),
            "- PR #12 merged as abc1234: https://github.com/o/r/pull/12 (C4, tier S, serves done:0, by T4)"
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
                message: "no serves",
                fix: Some("add Source: done:0")
            }),
            "- PR #12 from T4 refused by the train: no serves Fix: add Source: done:0. (https://github.com/o/r/pull/12)"
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
    fn runnable_event() {
        assert_eq!(
            r(Event::Runnable {
                items: "P3 docs; and 2 more",
                room: 2
            }),
            "- 2 slots free; approved work can start: P3 docs; and 2 more"
        );
    }

    #[test]
    fn answer_events() {
        let a = |settled, decision, evidence| {
            r(Event::Answered {
                ask: "A3",
                key: "deploy.prod",
                settled,
                value: "go (\"Ship it\")",
                decision,
                evidence,
            })
        };
        assert_eq!(
            a(Settled::Answered, Some("D4"), Some("exit 0\nall green")),
            "- A3 deploy.prod answered: go (\"Ship it\") (D4)\n  > exit 0 all green"
        );
        assert_eq!(
            a(Settled::OwnWords, None, None),
            "- A3 deploy.prod answered in the human's own words: go (\"Ship it\")"
        );
        assert_eq!(
            a(Settled::Skipped, None, None),
            "- A3 deploy.prod skipped for now: carry on with your recommendation (go (\"Ship it\")); no decision was recorded"
        );
        assert_eq!(
            a(Settled::Withdrawn, None, Some("")),
            "- A3 deploy.prod withdrawn by the human: drop it"
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

    #[test]
    fn idle_order_event() {
        assert_eq!(
            r(Event::OrderIdle {
                workstream: "W4",
                title: "schedules"
            }),
            "- W4 idle: schedules; no agent running, nothing asked, and nothing else will wake you for it"
        );
    }

    #[test]
    fn a_wake_is_the_state_then_the_events() {
        assert_eq!(
            frame("project lab", &["- a".into(), "- b".into()]),
            "project lab\n\n## Events\n- a\n- b"
        );
    }
}
