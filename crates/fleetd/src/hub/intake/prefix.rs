//! Explicit prefixes on an intent: a template prefix (`fix:`) skips the router for the template, and a leading
//! `@<project>` skips it for the project. Either order works: "@lab fix: …" and "fix: @lab …".
use std::sync::LazyLock;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::PlaybookName;
use fleetd_contracts::model::ProjectSummary;
use regex::Regex;

const TEMPLATE_PREFIXES: [(&str, PlaybookName); 4] = [
    ("bug", PlaybookName::Bugfix),
    ("fix", PlaybookName::Bugfix),
    ("research", PlaybookName::Research),
    ("finish", PlaybookName::FinishAll),
];

static MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^@([^\s:,]+)[\s:,]*").unwrap());
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^([a-z]+)\s*:\s*").unwrap());
static NON_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedIntent {
    pub template: Option<PlaybookName>,
    /// The `<project>` of a leading `@<project>`, as typed.
    pub project: Option<String>,
    /// The template prefix as written in lowercase, e.g. "fix:", for the echo.
    pub prefix: Option<String>,
}

pub fn parse_intent(text: &str) -> ParsedIntent {
    let mut rest = text.trim_start();
    let mut parsed = ParsedIntent::default();
    for _ in 0..2 {
        if parsed.project.is_none()
            && let Some(m) = MENTION.captures(rest)
        {
            parsed.project = Some(m[1].to_string());
            rest = &rest[m[0].len()..];
            continue;
        }
        if parsed.template.is_none()
            && let Some(m) = WORD.captures(rest)
        {
            let word = m[1].to_lowercase();
            if let Some((name, template)) = TEMPLATE_PREFIXES.iter().find(|(name, _)| *name == word)
            {
                parsed.template = Some(*template);
                parsed.prefix = Some(format!("{name}:"));
                rest = &rest[m[0].len()..];
                continue;
            }
        }
        break;
    }
    parsed
}

/// Lowercase words joined by "-": "Repo A (lab)" → "repo-a-lab".
pub fn slug_of(text: &str) -> String {
    NON_SLUG
        .replace_all(&text.to_lowercase(), "-")
        .trim_matches('-')
        .to_string()
}

pub enum ProjectMatch<'a> {
    One(&'a ProjectSummary),
    None,
    Many(Vec<&'a ProjectSummary>),
}

fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// `@<name>` against each project's title, the title's slug or the slug of its folder name, ignoring case.
pub fn match_project<'a>(name: &str, projects: &'a [ProjectSummary]) -> ProjectMatch<'a> {
    let wanted = name.to_lowercase();
    let slug = slug_of(name);
    let hits: Vec<&ProjectSummary> = projects
        .iter()
        .filter(|p| {
            let names = [
                p.title.to_lowercase(),
                slug_of(&p.title),
                slug_of(basename(&p.workspace_root)),
            ];
            names.contains(&wanted) || (!slug.is_empty() && names.contains(&slug))
        })
        .collect();
    match hits.len() {
        0 => ProjectMatch::None,
        1 => ProjectMatch::One(hits[0]),
        _ => ProjectMatch::Many(hits),
    }
}

pub fn ref_of(p: &ProjectSummary) -> ProjectRef {
    ProjectRef {
        machine_id: p.machine_id.clone(),
        project_id: p.project_id.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes() {
        use PlaybookName::*;
        type Case<'a> = (
            &'a str,
            Option<PlaybookName>,
            Option<&'a str>,
            Option<&'a str>,
        );
        let cases: &[Case] = &[
            (
                "fix: the lab README has a typo",
                Some(Bugfix),
                Some("fix:"),
                None,
            ),
            ("bug: login fails", Some(Bugfix), Some("bug:"), None),
            ("Fix: capitals work", Some(Bugfix), Some("fix:"), None),
            (
                "research:does caching help",
                Some(Research),
                Some("research:"),
                None,
            ),
            (
                "finish: everything in flight",
                Some(FinishAll),
                Some("finish:"),
                None,
            ),
            (
                "  fix :  spaces around the colon",
                Some(Bugfix),
                Some("fix:"),
                None,
            ),
            ("@repo-a add a /health endpoint", None, None, Some("repo-a")),
            (
                "@Repo-A: add a /health endpoint",
                None,
                None,
                Some("Repo-A"),
            ),
            (
                "@repo-a fix: the README typo",
                Some(Bugfix),
                Some("fix:"),
                Some("repo-a"),
            ),
            (
                "fix: @repo-a the README typo",
                Some(Bugfix),
                Some("fix:"),
                Some("repo-a"),
            ),
            ("add a /health endpoint", None, None, None),
            ("fix the README typo", None, None, None),
            ("note: not a template", None, None, None),
            ("fixes: not a template either", None, None, None),
            ("email me@example.com about it", None, None, None),
            (
                "fix: research: only the first prefix counts",
                Some(Bugfix),
                Some("fix:"),
                None,
            ),
        ];
        for (text, template, prefix, project) in cases {
            let parsed = parse_intent(text);
            assert_eq!(parsed.template, *template, "{text}");
            assert_eq!(parsed.prefix.as_deref(), *prefix, "{text}");
            assert_eq!(parsed.project.as_deref(), *project, "{text}");
        }
    }

    #[test]
    fn slugs() {
        assert_eq!(slug_of("Repo A (lab)"), "repo-a-lab");
        assert_eq!(slug_of("--x--"), "x");
    }
}
