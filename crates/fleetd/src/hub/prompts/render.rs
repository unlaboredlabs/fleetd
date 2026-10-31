//! `{{name}}` templates, pure: rendering, the refs that name a text, the warnings an edit gets, and the 3-way merge
//! an override gets when a release changes its default.
use std::fmt::Display;

use fleetd_contracts::prompts::{Enforcement, PromptWarning, PromptWarningCode};
use regex::RegexBuilder;

use super::registry::Entry;

/// What `git hash-object <file>` prints for these bytes. Prompt refs and the `base` an override file records are
/// built from it, so changing the hash would mark every edited prompt as changed by a release.
pub fn git_blob_sha(content: &[u8]) -> String {
    let mut sha = ring::digest::Context::new(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY);
    sha.update(format!("blob {}\0", content.len()).as_bytes());
    sha.update(content);
    sha.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// `<id>@<first 10 hex of the text's git blob SHA>`.
pub fn ref_of(id: &str, text: &str) -> String {
    format!("{id}@{}", &git_blob_sha(text.as_bytes())[..10])
}

/// The same words in the same order, whatever the whitespace between them.
pub fn same_words(a: &str, b: &str) -> bool {
    a.split_whitespace().eq(b.split_whitespace())
}

/// One pass over `template`: each `{{name}}` with a value is replaced, any other is left as written. Values are never
/// scanned, so a value that contains `{{x}}` stays as it is. One trailing newline of the file is dropped.
pub fn render(template: &str, vars: &[(&str, &dyn Display)]) -> String {
    let template = template.strip_suffix('\n').unwrap_or(template);
    let mut out = String::with_capacity(template.len() + 64);
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let name_end = after.find("}}").filter(|&end| is_name(&after[..end]));
        match name_end.and_then(|end| {
            vars.iter()
                .find(|(n, _)| *n == &after[..end])
                .map(|(_, v)| (end, v))
        }) {
            Some((end, value)) => {
                out.push_str(&value.to_string());
                rest = &after[end + 2..];
            }
            None => {
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn is_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Every `{{name}}` in `text`, in order, each once.
pub fn placeholders_in(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        match after.find("}}").filter(|&end| is_name(&after[..end])) {
            Some(end) => {
                let name = after[..end].to_owned();
                if !names.contains(&name) {
                    names.push(name);
                }
                rest = &after[end + 2..];
            }
            None => rest = after,
        }
    }
    names
}

pub fn rule_present(needle: &str, text: &str) -> bool {
    RegexBuilder::new(needle)
        .case_insensitive(true)
        .build()
        .is_ok_and(|re| re.is_match(text))
}

/// What an edit of `entry` to `text` may break. Never a refusal.
pub fn warnings(entry: &Entry, text: &str) -> Vec<PromptWarning> {
    let mut out = Vec::new();
    let declared = entry.placeholders();
    let used = placeholders_in(text);
    for p in declared.iter().filter(|p| p.required) {
        if !used.contains(&p.name) {
            out.push(PromptWarning {
                code: PromptWarningCode::PlaceholderMissing,
                message: format!(
                    "{{{{{}}}}} is gone: the model no longer gets {}.",
                    p.name, p.description
                ),
                placeholder: Some(p.name.clone()),
                rule: None,
                enforced: None,
            });
        }
    }
    for name in used
        .iter()
        .filter(|n| !declared.iter().any(|p| &p.name == *n))
    {
        out.push(PromptWarning {
            code: PromptWarningCode::PlaceholderUnknown,
            message: format!(
                "fleetd does not fill in {{{{{name}}}}} here; the model reads it as written."
            ),
            placeholder: Some(name.clone()),
            rule: None,
            enforced: None,
        });
    }
    for rule in entry.safety_rules() {
        if rule_present(&rule.needle, entry.default) && !rule_present(&rule.needle, text) {
            let consequence = match rule.enforced {
                Enforcement::Code => {
                    "fleetd still enforces this; agents will hit refusals they were not warned about"
                }
                Enforcement::Prompt => "nothing else enforces this",
            };
            out.push(PromptWarning {
                code: PromptWarningCode::SafetyRuleMissing,
                message: format!(
                    "The text no longer carries the rule \"{}\" ({}): {consequence}.",
                    rule.label, rule.id
                ),
                placeholder: None,
                rule: Some(rule.id),
                enforced: Some(rule.enforced),
            });
        }
    }
    let (len, budget) = (text.chars().count(), entry.budget());
    if len > budget {
        out.push(PromptWarning {
            code: PromptWarningCode::TooLong,
            message: format!(
                "{len} characters, past the {budget} this prompt is sized for; every session that gets it pays for it."
            ),
            placeholder: None,
            rule: None,
            enforced: None,
        });
    }
    out
}

/// A line 3-way merge of `base` → `current` into `yours`: the text, and whether it has conflict markers.
pub fn merge(base: &str, current: &str, yours: &str) -> (String, bool) {
    match diffy::merge(base, yours, current) {
        Ok(merged) => (merged, false),
        Err(conflicted) => (conflicted, true),
    }
}
