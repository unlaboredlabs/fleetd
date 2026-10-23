//! The prompt table on "What agents are told", from the hub's own registry, so a new or renamed prompt can't be
//! missing from the docs. docsgen writes it between `<!-- prompt-table -->` and `<!-- /prompt-table -->`.

use fleetd::hub::prompts::registry::{ENTRIES, INSTRUCTIONS};
use fleetd_contracts::prompts::{Enforcement, PromptGroup};

const GROUPS: [(PromptGroup, &str); 4] = [
    (PromptGroup::Lead, "Lead"),
    (PromptGroup::Tasks, "Tasks"),
    (PromptGroup::ReviewsAndChecks, "Reviews and checks"),
    (PromptGroup::Messages, "Messages"),
];

/// Markdown: one `###` per group, then a row per prompt with its id, when it is sent and the safety rules it
/// carries (prompt-only ones marked).
pub fn table(_root: &std::path::Path) -> Result<String, String> {
    let mut md = String::new();
    for (group, title) in GROUPS {
        md.push_str(&format!(
            "### {title}\n\n| Id | Sent | Safety rules |\n|---|---|---|\n"
        ));
        for e in ENTRIES
            .iter()
            .filter(|e| e.group == group && e.id != INSTRUCTIONS)
        {
            let rules: Vec<String> = e
                .safety_rules()
                .iter()
                .map(|r| match r.enforced {
                    Enforcement::Code => cell(&r.label),
                    Enforcement::Prompt => format!("{} (prompt only)", cell(&r.label)),
                })
                .collect();
            md.push_str(&format!(
                "| `{}` | {} | {} |\n",
                e.id,
                cell(e.sent_when),
                rules.join("; ")
            ));
        }
        md.push('\n');
    }
    Ok(md.trim_end().to_owned() + "\n")
}

/// Table-cell safe: nothing in it reads as markup.
fn cell(text: &str) -> String {
    crate::md_text(text)
}
