//! Enqueue rules, pure: the PR body's `Source:` line, the tier, and the freeze decision key.
use super::contract::{Tier, is_serves};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub message: String,
    pub fix: String,
}

impl Refusal {
    pub fn new(message: impl Into<String>, fix: impl Into<String>) -> Self {
        Self { message: message.into(), fix: fix.into() }
    }
}

/// Up to two `*` or `_` around the label, as `(?:[*_]{1,2})?`.
fn strip_emphasis(s: &str) -> &str {
    let n = s.bytes().take_while(|c| matches!(c, b'*' | b'_')).count();
    if (1..=2).contains(&n) { &s[n..] } else { s }
}

/// The first `Source: <serves>` line of a PR body, trimmed; markdown emphasis around the label is allowed.
pub fn source_of(body: Option<&str>) -> Option<String> {
    for line in body.unwrap_or("").split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let rest = strip_emphasis(line.trim_start_matches([' ', '\t']));
        let Some(rest) = rest.strip_prefix("Source:") else { continue };
        // After the label the optional group is greedy: up to two marks go, however many follow.
        let marks = rest.bytes().take_while(|c| matches!(c, b'*' | b'_')).count().min(2);
        let value = rest[marks..].trim_matches([' ', '\t']);
        let value = value.strip_prefix('`').and_then(|v| v.strip_suffix('`')).unwrap_or(value).trim();
        return if value.is_empty() { None } else { Some(value.to_string()) };
    }
    None
}

fn add_line(serves: &str) -> String {
    format!("add 'Source: {serves}' to the PR body")
}

/// The PR's `Source:` must be a valid serves form, name an existing done-when check when it is `done:<n>`, and equal
/// `expected` (the task's or the caller's serves) when there is one. When the pinned playbook does not require the
/// line, a PR without one serves `expected`; with nothing expected either, it still needs the line.
pub fn check_source(
    body: Option<&str>,
    expected: Option<&str>,
    workstream_id: &str,
    done_when_checks: usize,
    require_source: bool,
) -> Result<String, Refusal> {
    let source = source_of(body);
    let example = expected.unwrap_or("done:0");
    let Some(source) = source else {
        if let (false, Some(expected)) = (require_source, expected) {
            return Ok(expected.to_string());
        }
        return Err(Refusal::new("The PR body has no 'Source:' line.", add_line(example)));
    };
    if !is_serves(&source) {
        return Err(Refusal::new(
            format!("'Source: {source}' is not a valid serves form."),
            format!("{} (done:<n>, issue:<#n|url>, defect:<text> or ask:A<n>)", add_line(example)),
        ));
    }
    if let Some(expected) = expected.filter(|e| *e != source) {
        return Err(Refusal::new(
            format!("The PR body says 'Source: {source}' but the work serves {expected}."),
            format!("change the PR body's line to 'Source: {expected}'"),
        ));
    }
    if let Some(n) = source.strip_prefix("done:").and_then(|n| n.parse::<usize>().ok())
        && n >= done_when_checks
    {
        let range = match done_when_checks {
            0 => "it has no done-when checks".to_string(),
            1 => "use done:0".to_string(),
            c => format!("use done:0 to done:{}", c - 1),
        };
        return Err(Refusal::new(
            format!("'Source: {source}' is not a done-when check of {workstream_id}."),
            format!("{}; {range}", add_line("done:<n>")),
        ));
    }
    Ok(source)
}

fn rank(t: Tier) -> u8 {
    match t {
        Tier::S => 0,
        Tier::M => 1,
        Tier::L => 2,
    }
}

/// The brief's tier, raised by the task's or the caller's, never lowered by the caller.
pub fn check_tier(brief: Tier, requested: Option<Tier>, task: Option<Tier>) -> Result<Tier, Refusal> {
    if let Some(r) = requested
        && rank(r) < rank(brief)
    {
        return Err(Refusal::new(
            format!("Tier {r} is below the brief's tier {brief}; a tier can be raised, never lowered."),
            format!("omit --tier, or pass --tier {brief} or higher"),
        ));
    }
    Ok([Some(brief), requested, task].into_iter().flatten().fold(brief, |a, b| if rank(b) > rank(a) { b } else { a }))
}

/// `policy.freeze.<owner>.<name>`, lowercased; its value "true" holds the repo's train.
pub fn freeze_key(repo: &str) -> String {
    format!("policy.freeze.{}", repo.to_lowercase().replacen('/', ".", 1))
}

pub fn is_frozen_value(value: &str) -> bool {
    matches!(value.trim().to_lowercase().as_str(), "true" | "yes" | "on" | "1")
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: &str = "W1";

    #[test]
    fn reads_the_source_line_with_or_without_markdown() {
        assert_eq!(source_of(Some("Adds docs.\n\nSource: done:2\n")).as_deref(), Some("done:2"));
        assert_eq!(source_of(Some("**Source:** `issue:#4`")).as_deref(), Some("issue:#4"));
        assert_eq!(source_of(Some("No source here")), None);
        assert_eq!(source_of(None), None);
    }

    #[test]
    fn refuses_a_missing_malformed_mismatched_or_out_of_range_source_with_the_fix() {
        assert_eq!(check_source(Some("Source: done:2"), Some("done:2"), W, 3, true), Ok("done:2".into()));
        assert_eq!(check_source(Some("Source: ask:A3"), None, W, 3, true), Ok("ask:A3".into()));
        assert_eq!(check_source(Some("nothing"), Some("done:2"), W, 3, true).unwrap_err().fix, "add 'Source: done:2' to the PR body");
        assert_eq!(check_source(Some("Source: stuff"), None, W, 3, true).unwrap_err().message, "'Source: stuff' is not a valid serves form.");
        assert_eq!(
            check_source(Some("Source: done:1"), Some("done:2"), W, 3, true).unwrap_err().fix,
            "change the PR body's line to 'Source: done:2'"
        );
        assert_eq!(
            check_source(Some("Source: done:3"), None, W, 3, true).unwrap_err().fix,
            "add 'Source: done:<n>' to the PR body; use done:0 to done:2"
        );
    }

    #[test]
    fn a_pr_without_source_serves_the_task_when_the_playbook_does_not_require_the_line() {
        assert_eq!(check_source(Some("Adds docs."), Some("done:2"), W, 3, false), Ok("done:2".into()));
        assert_eq!(check_source(Some("Adds docs."), None, W, 3, false).unwrap_err().message, "The PR body has no 'Source:' line.");
        assert_eq!(
            check_source(Some("Source: done:1"), Some("done:2"), W, 3, false).unwrap_err().fix,
            "change the PR body's line to 'Source: done:2'"
        );
        assert_eq!(check_source(Some("Adds docs."), Some("done:2"), W, 3, true).unwrap_err().fix, "add 'Source: done:2' to the PR body");
    }

    #[test]
    fn takes_the_highest_tier_and_refuses_a_caller_lowering_it() {
        assert_eq!(check_tier(Tier::M, None, None), Ok(Tier::M));
        assert_eq!(check_tier(Tier::S, Some(Tier::L), Some(Tier::M)), Ok(Tier::L));
        assert_eq!(check_tier(Tier::M, None, Some(Tier::L)), Ok(Tier::L));
        assert_eq!(check_tier(Tier::M, Some(Tier::S), None).unwrap_err().fix, "omit --tier, or pass --tier M or higher");
    }

    #[test]
    fn keys_the_freeze_on_the_lowercased_repo() {
        assert_eq!(freeze_key("Wynn-Dev/Fleetd-Testbed"), "policy.freeze.wynn-dev.fleetd-testbed");
        assert!(is_frozen_value(" Yes ") && !is_frozen_value("false"));
    }
}
