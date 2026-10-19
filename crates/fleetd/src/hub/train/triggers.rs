//! Whether a GitHub Actions workflow can run for a PR, read from its `on:`. The train asks this before it calls a
//! head that has no checks "no CI", so the answer leans to yes: anything it can't read or evaluate (a YAML error, an
//! unknown event, a glob it doesn't model, `types` or `paths` filters) can run.
use regex::Regex;
use serde_yaml_ng::Value;

/// Events whose runs never report on a PR's head.
const NEVER_ON_HEAD: &[&str] = &[
    "branch_protection_rule",
    "check_run",
    "check_suite",
    "create",
    "delete",
    "discussion",
    "discussion_comment",
    "fork",
    "gollum",
    "issue_comment",
    "issues",
    "label",
    "member",
    "merge_group",
    "milestone",
    "page_build",
    "project",
    "project_card",
    "project_column",
    "public",
    "registry_package",
    "release",
    "repository_dispatch",
    "schedule",
    "status",
    "watch",
    "workflow_call",
    "workflow_dispatch",
    "workflow_run",
];

/// Whether the workflow file `yaml` can start a run for a PR from branch `head` into branch `base`.
pub fn may_run(yaml: &str, base: &str, head: &str) -> bool {
    let Ok(doc) = serde_yaml_ng::from_str::<Value>(yaml) else {
        return true;
    };
    // A YAML 1.1 reader takes the key `on` for true.
    let Some(on) = doc.get("on").or_else(|| doc.get(Value::Bool(true))) else {
        return true;
    };
    match on {
        Value::String(event) => event_may_run(event, &Value::Null, base, head),
        Value::Sequence(events) => events.iter().any(|e| {
            e.as_str()
                .is_none_or(|e| event_may_run(e, &Value::Null, base, head))
        }),
        Value::Mapping(events) => events.iter().any(|(e, filters)| {
            e.as_str()
                .is_none_or(|e| event_may_run(e, filters, base, head))
        }),
        _ => true,
    }
}

fn event_may_run(event: &str, filters: &Value, base: &str, head: &str) -> bool {
    match event {
        "pull_request"
        | "pull_request_target"
        | "pull_request_review"
        | "pull_request_review_comment" => branch_filters(filters, base),
        "push" => {
            let has = |k: &str| filters.get(k).is_some();
            // Filtered to tags only, a push of a branch runs nothing.
            let tags_only =
                (has("tags") || has("tags-ignore")) && !has("branches") && !has("branches-ignore");
            !tags_only && branch_filters(filters, head)
        }
        e if NEVER_ON_HEAD.contains(&e) => false,
        _ => true,
    }
}

/// Whether `branches` / `branches-ignore` let `name` through; no filter lets everything through.
fn branch_filters(filters: &Value, name: &str) -> bool {
    let (only, ignore) = (filters.get("branches"), filters.get("branches-ignore"));
    match (only, ignore) {
        (Some(only), None) => match patterns(only) {
            // In order, the last matching pattern decides; `!` excludes.
            Some(list) => {
                let mut through = false;
                for p in list {
                    let (negated, p) = p.strip_prefix('!').map_or((false, p), |p| (true, p));
                    match glob(p, name) {
                        Some(true) => through = !negated,
                        Some(false) => {}
                        None => return true,
                    }
                }
                through
            }
            None => true,
        },
        (None, Some(ignore)) => match patterns(ignore) {
            Some(list) => list.iter().all(|p| glob(p, name) != Some(true)),
            None => true,
        },
        _ => true,
    }
}

fn patterns(v: &Value) -> Option<Vec<&str>> {
    match v {
        Value::String(s) => Some(vec![s.as_str()]),
        Value::Sequence(items) => items.iter().map(Value::as_str).collect(),
        _ => None,
    }
}

/// GitHub's filter glob: `*` within a path segment, `**` across them. `None` for what it doesn't model (`?`, `+`,
/// `[...]`), which the caller takes as "may match".
fn glob(pattern: &str, name: &str) -> Option<bool> {
    if pattern.contains(['?', '+', '[', ']', '\\']) {
        return None;
    }
    let mut re = String::from("^");
    let mut rest = pattern;
    while let Some(c) = rest.chars().next() {
        if let Some(r) = rest.strip_prefix("**") {
            re.push_str(".*");
            rest = r;
        } else if let Some(r) = rest.strip_prefix('*') {
            re.push_str("[^/]*");
            rest = r;
        } else {
            re.push_str(&regex::escape(&c.to_string()));
            rest = &rest[c.len_utf8()..];
        }
    }
    re.push('$');
    Regex::new(&re).ok().map(|r| r.is_match(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAB_CI: &str = "name: ci\non:\n  pull_request:\n    branches-ignore: [\"noci/**\"]\n  push:\n    branches: [main, \"slot/*/main\"]\n";

    #[test]
    fn the_lab_workflow_runs_for_slot_prs_and_never_for_noci_prs() {
        assert!(may_run(LAB_CI, "slot/3/main", "slot/3/fleetd/T1-x"));
        assert!(may_run(LAB_CI, "main", "fleetd/T1-x"));
        assert!(!may_run(LAB_CI, "noci/4/main", "noci/4/fleetd/T1-x"));
    }

    #[test]
    fn a_bare_or_listed_pr_or_push_trigger_runs_for_every_pr() {
        for yaml in [
            "on: pull_request",
            "on: [push]",
            "on:\n  pull_request:\n",
            "on:\n  pull_request_target: {}\n",
        ] {
            assert!(may_run(yaml, "noci/1/main", "noci/1/x"), "{yaml}");
        }
    }

    #[test]
    fn events_that_never_report_on_a_head_are_not_ci() {
        assert!(!may_run(
            "on: [workflow_dispatch, schedule, release]",
            "main",
            "x"
        ));
        assert!(!may_run("on:\n  push:\n    tags: [\"v*\"]\n", "main", "x"));
    }

    #[test]
    fn branch_filters_with_globs_and_negation() {
        let only =
            "on:\n  pull_request:\n    branches: [\"releases/**\", \"!releases/**-alpha\"]\n";
        assert!(may_run(only, "releases/10", "x"));
        assert!(!may_run(only, "releases/10-alpha", "x"));
        assert!(!may_run(only, "main", "x"));
        let star = "on:\n  push:\n    branches: [\"slot/*/main\"]\n";
        assert!(may_run(star, "main", "slot/2/main"));
        assert!(!may_run(star, "main", "slot/2/fleetd/T1"));
        let ignore = "on:\n  pull_request:\n    branches-ignore: [main]\n";
        assert!(!may_run(ignore, "main", "x"));
        assert!(may_run(ignore, "dev", "x"));
    }

    #[test]
    fn what_it_cannot_read_or_model_may_run() {
        for yaml in [
            "on: [::",
            "name: no trigger\n",
            "on: some_new_event",
            "on:\n  pull_request:\n    branches: [\"ma?n\"]\n",
            "on:\n  pull_request:\n    branches-ignore: [\"[mn]ain\"]\n",
            "on:\n  pull_request:\n    branches: [x]\n    branches-ignore: [y]\n",
            "on:\n  pull_request:\n    branches: 7\n",
        ] {
            assert!(may_run(yaml, "main", "x"), "{yaml}");
        }
        // A preview deployment of the head (Vercel, Netlify) reports on the head's sha.
        assert!(may_run("on: deployment_status", "main", "x"));
        // paths filters aren't evaluated: the run may happen.
        assert!(may_run(
            "on:\n  pull_request:\n    paths: [\"src/**\"]\n",
            "main",
            "x"
        ));
    }
}
