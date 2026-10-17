//! Receipts: what a task actually executed, counted from its T3 items rather than read from its prose. Pure.
//! TS spec: apps/hub/src/receipts/count.ts. T3's own "Preparing workspace" step never reaches here: the executor's
//! actions leave it out, since the agent ran nothing.
use fleetd_contracts::{ActionItem, ActionKind, Receipts, TaskResult};
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

pub fn count_receipts(actions: &[ActionItem]) -> Receipts {
    let mut r = Receipts::default();
    let mut files = HashSet::new();
    for a in actions {
        match a.kind {
            ActionKind::Command => {
                r.commands += 1;
                if a.failed {
                    r.commands_failed += 1;
                }
            }
            // Several edits to one file are one changed file.
            ActionKind::FileChange => {
                files.insert(a.summary.as_str());
            }
            ActionKind::ToolCall => r.tool_calls += 1,
            ActionKind::Other => {}
        }
    }
    r.files_changed = files.len() as u32;
    r
}

/// The fixed claim phrases: "tests pass", "fixed", "ran", "verified", "all green", as whole words, any case.
static CLAIM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:tests? pass(?:es|ed|ing)?|fixed|ran|verified|all green)\b").expect("claim regex"));

/// The text claims something was run or checked, yet the task ran no commands.
pub fn claims_unverified(text: &str, receipts: &Receipts) -> bool {
    receipts.commands == 0 && CLAIM.is_match(text)
}

fn plural(n: u32, one: &str) -> String {
    if n == 1 { format!("{n} {one}") } else { format!("{n} {one}s") }
}

/// The wake's receipts line, or None for results stored before receipts existed.
pub fn receipts_line(result: &TaskResult) -> Option<String> {
    let r = result.receipts.as_ref()?;
    if result.claims_unverified == Some(true) {
        return Some("receipts: 0 commands run — claims unverified".into());
    }
    let commands =
        if r.commands == 0 { "0 commands run".to_owned() } else { format!("{} ({} failed)", plural(r.commands, "command"), r.commands_failed) };
    Some(format!("receipts: {commands}, {} changed, {}", plural(r.files_changed, "file"), plural(r.tool_calls, "tool call")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::{ActionStatus, TaskResultStatus};

    fn action(kind: ActionKind, summary: &str, failed: bool) -> ActionItem {
        ActionItem {
            at: "2026-10-17T10:00:00.000Z".into(),
            kind,
            status: if failed { ActionStatus::Failed } else { ActionStatus::Completed },
            summary: summary.into(),
            output_tail: None,
            exit_code: None,
            failed,
        }
    }

    const NONE: Receipts = Receipts { commands: 0, commands_failed: 0, files_changed: 0, tool_calls: 0 };
    const SOME: Receipts = Receipts { commands: 2, commands_failed: 0, files_changed: 0, tool_calls: 0 };

    #[test]
    fn counts_commands_failures_distinct_files_and_tool_calls() {
        let counted = count_receipts(&[
            action(ActionKind::Command, "pnpm test", false),
            action(ActionKind::Command, "pnpm lint", true),
            action(ActionKind::FileChange, "docs/x.md", false),
            action(ActionKind::FileChange, "docs/x.md", false),
            action(ActionKind::FileChange, "docs/y.md", false),
            action(ActionKind::ToolCall, "web search: effect", false),
            action(ActionKind::Other, "provider: boom", true),
        ]);
        assert_eq!(counted, Receipts { commands: 2, commands_failed: 1, files_changed: 2, tool_calls: 1 });
        assert_eq!(count_receipts(&[]), NONE);
    }

    #[test]
    fn the_claim_phrase_rule() {
        let cases = [
            ("All tests pass.", NONE, true),
            ("tests passed locally", NONE, true),
            ("Fixed the bug in parse()", NONE, true),
            ("I ran the suite", NONE, true),
            ("Verified by reading the code", NONE, true),
            ("CI is ALL GREEN", NONE, true),
            ("Tests pass.", SOME, false),
            ("Wrote docs/x.md on the branch", NONE, false),
            ("Granted: the branch is ready", NONE, false),
            ("prefixed the ids", NONE, false),
            ("", NONE, false),
        ];
        for (text, receipts, expected) in cases {
            assert_eq!(claims_unverified(text, &receipts), expected, "{text:?}");
        }
    }

    #[test]
    fn receipts_line_says_what_ran() {
        let result = |receipts: Option<Receipts>, unverified: Option<bool>| TaskResult {
            status: TaskResultStatus::Done,
            tail: String::new(),
            branch: None,
            pr_url: None,
            receipts,
            claims_unverified: unverified,
            at: "2026-10-17T10:00:00.000Z".into(),
        };
        let three = Receipts { commands: 3, commands_failed: 1, files_changed: 1, tool_calls: 2 };
        assert_eq!(receipts_line(&result(Some(three), Some(false))).unwrap(), "receipts: 3 commands (1 failed), 1 file changed, 2 tool calls");
        assert_eq!(receipts_line(&result(Some(NONE), Some(true))).unwrap(), "receipts: 0 commands run — claims unverified");
        let files = Receipts { files_changed: 2, ..NONE };
        assert_eq!(receipts_line(&result(Some(files), Some(false))).unwrap(), "receipts: 0 commands run, 2 files changed, 0 tool calls");
        assert_eq!(receipts_line(&result(None, None)), None);
    }
}
