//! Receipts: what a task actually executed, counted from its thread items rather than read from its prose. Pure.
use fleetd_contracts::model::{ActionItem, ActionKind};
use fleetd_contracts::prim::Count;
use fleetd_contracts::tasks::{Receipts, TaskResult};
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

pub fn count_receipts(actions: &[ActionItem]) -> Receipts {
    let (mut commands, mut commands_failed, mut tool_calls) = (0, 0, 0);
    let mut files = HashSet::new();
    for a in actions {
        match a.kind {
            ActionKind::Command => {
                commands += 1;
                if a.failed {
                    commands_failed += 1;
                }
            }
            // Several edits to one file are one changed file.
            ActionKind::FileChange => {
                files.insert(a.summary.as_str());
            }
            ActionKind::ToolCall => tool_calls += 1,
            ActionKind::Other => {}
        }
    }
    Receipts {
        commands: Count::unchecked(commands),
        commands_failed: Count::unchecked(commands_failed),
        files_changed: Count::unchecked(files.len() as i64),
        tool_calls: Count::unchecked(tool_calls),
    }
}

/// The fixed claim phrases: "tests pass", "fixed", "ran", "verified", "all green", as whole words, any case.
static CLAIM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:tests? pass(?:es|ed|ing)?|fixed|ran|verified|all green)\b")
        .expect("claim regex")
});

/// The text claims something was run or checked, yet the task ran no commands.
pub fn claims_unverified(text: &str, receipts: &Receipts) -> bool {
    receipts.commands.get() == 0 && CLAIM.is_match(text)
}

fn plural(n: Count, one: &str) -> String {
    let n = n.get();
    if n == 1 {
        format!("{n} {one}")
    } else {
        format!("{n} {one}s")
    }
}

/// The wake's receipts line, or None for results stored before receipts existed.
pub fn receipts_line(result: &TaskResult) -> Option<String> {
    let r = result.receipts.as_ref()?;
    if result.claims_unverified == Some(true) {
        return Some("receipts: 0 commands run — claims unverified".into());
    }
    let commands = if r.commands.get() == 0 {
        "0 commands run".to_owned()
    } else {
        format!(
            "{} ({} failed)",
            plural(r.commands, "command"),
            r.commands_failed
        )
    };
    Some(format!(
        "receipts: {commands}, {} changed, {}",
        plural(r.files_changed, "file"),
        plural(r.tool_calls, "tool call")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn action(kind: &str, summary: &str, failed: bool) -> ActionItem {
        let status = if failed { "failed" } else { "completed" };
        serde_json::from_value(json!({ "at": "2026-10-17T10:00:00.000Z", "kind": kind, "status": status, "summary": summary, "failed": failed }))
            .unwrap()
    }

    fn receipts(
        commands: i64,
        commands_failed: i64,
        files_changed: i64,
        tool_calls: i64,
    ) -> Receipts {
        serde_json::from_value(json!({ "commands": commands, "commandsFailed": commands_failed, "filesChanged": files_changed, "toolCalls": tool_calls }))
            .unwrap()
    }

    #[test]
    fn counts_commands_failures_distinct_files_and_tool_calls() {
        let counted = count_receipts(&[
            action("command", "pnpm test", false),
            action("command", "pnpm lint", true),
            action("file_change", "docs/x.md", false),
            action("file_change", "docs/x.md", false),
            action("file_change", "docs/y.md", false),
            action("tool_call", "web search: effect", false),
            action("other", "provider: boom", true),
        ]);
        assert_eq!(counted, receipts(2, 1, 2, 1));
        assert_eq!(count_receipts(&[]), receipts(0, 0, 0, 0));
    }

    #[test]
    fn the_claim_phrase_rule() {
        let (none, some) = (receipts(0, 0, 0, 0), receipts(2, 0, 0, 0));
        let cases = [
            ("All tests pass.", none.clone(), true),
            ("tests passed locally", none.clone(), true),
            ("Fixed the bug in parse()", none.clone(), true),
            ("I ran the suite", none.clone(), true),
            ("Verified by reading the code", none.clone(), true),
            ("CI is ALL GREEN", none.clone(), true),
            ("Tests pass.", some, false),
            ("Wrote docs/x.md on the branch", none.clone(), false),
            ("Granted: the branch is ready", none.clone(), false),
            ("prefixed the ids", none.clone(), false),
            ("", none.clone(), false),
        ];
        for (text, receipts, expected) in cases {
            assert_eq!(claims_unverified(text, &receipts), expected, "{text:?}");
        }
    }

    #[test]
    fn receipts_line_says_what_ran() {
        let result = |r: Option<Receipts>, unverified: Option<bool>| -> TaskResult {
            let mut v = json!({ "status": "done", "tail": "", "at": "2026-10-17T10:00:00.000Z" });
            if let Some(r) = r {
                v["receipts"] = serde_json::to_value(r).unwrap();
            }
            if let Some(u) = unverified {
                v["claimsUnverified"] = json!(u);
            }
            serde_json::from_value(v).unwrap()
        };
        assert_eq!(
            receipts_line(&result(Some(receipts(3, 1, 1, 2)), Some(false))).unwrap(),
            "receipts: 3 commands (1 failed), 1 file changed, 2 tool calls"
        );
        assert_eq!(
            receipts_line(&result(Some(receipts(0, 0, 0, 0)), Some(true))).unwrap(),
            "receipts: 0 commands run — claims unverified"
        );
        assert_eq!(
            receipts_line(&result(Some(receipts(0, 0, 2, 0)), Some(false))).unwrap(),
            "receipts: 0 commands run, 2 files changed, 0 tool calls"
        );
        assert_eq!(receipts_line(&result(None, None)), None);
    }
}
