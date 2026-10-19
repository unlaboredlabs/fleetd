//! A leading `@<project>` on an intent names its project: "@lab add a /health endpoint".
use std::sync::LazyLock;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::model::ProjectSummary;
use regex::Regex;

static MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^@([^\s:,]+)[\s:,]*").unwrap());
static NON_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9]+").unwrap());

/// The `<project>` of a leading `@<project>`, as typed.
pub fn mentioned_project(text: &str) -> Option<String> {
    MENTION
        .captures(text.trim_start())
        .map(|m| m[1].to_string())
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
    fn mentions() {
        let cases: &[(&str, Option<&str>)] = &[
            ("@repo-a add a /health endpoint", Some("repo-a")),
            ("@Repo-A: add a /health endpoint", Some("Repo-A")),
            ("  @repo-a, the README typo", Some("repo-a")),
            ("fix: @repo-a the README typo", None),
            ("add a /health endpoint", None),
            ("email me@example.com about it", None),
        ];
        for (text, project) in cases {
            assert_eq!(mentioned_project(text).as_deref(), *project, "{text}");
        }
    }

    #[test]
    fn slugs() {
        assert_eq!(slug_of("Repo A (lab)"), "repo-a-lab");
        assert_eq!(slug_of("--x--"), "x");
    }
}
