//! Default areas for a project whose policy file sets none, read off the repo's layout: one area per workspace member
//! (Cargo `[workspace] members`, package.json `workspaces`, pnpm-workspace.yaml `packages`) and per directory under a
//! top-level apps/, crates/, packages/ or services/, plus `docs` for a top-level docs/. `all` (the whole repo) always
//! stays, for work that spans members. Writers in different areas run at once; with only `all`, every writer queues
//! behind the one before it.
use std::collections::{BTreeMap, BTreeSet};

use crate::hub::tasks::glob::GlobMatcher;

/// Top-level directories whose children are areas even without a workspace manifest.
pub const CONTAINERS: [&str; 4] = ["apps", "crates", "packages", "services"];
/// More members than this and each container is one area instead, so the list stays one a lead can read.
const MAX_MEMBERS: usize = 40;
/// The root files a member's change also touches (a new dependency moves the lock file), by ecosystem.
const CARGO_ROOT: [&str; 2] = ["Cargo.toml", "Cargo.lock"];
const JS_ROOT: [&str; 4] = [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
];

/// The workspace manifests at the repo root, as text; `None` where there is none.
#[derive(Clone, Debug, Default)]
pub struct Manifests {
    pub cargo_toml: Option<String>,
    pub package_json: Option<String>,
    pub pnpm_workspace: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Ecosystem {
    Cargo,
    Js,
    Plain,
}

/// `members = [...]` of the `[workspace]` table. A small reader rather than a TOML parser: members are a plain array
/// of strings, and anything it can't read just leaves the members to the container directories.
fn cargo_members(text: &str) -> Vec<String> {
    let mut in_workspace = false;
    let mut collecting: Option<String> = None;
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or_default().trim();
        if let Some(acc) = collecting.as_mut() {
            acc.push_str(line);
            if line.contains(']') {
                break;
            }
            continue;
        }
        if line.starts_with('[') {
            in_workspace = line == "[workspace]";
            continue;
        }
        if in_workspace
            && let Some(rest) = line.strip_prefix("members")
            && let Some(value) = rest.trim_start().strip_prefix('=')
        {
            collecting = Some(value.to_owned());
            if value.contains(']') {
                break;
            }
        }
    }
    collecting.map(|a| quoted(&a)).unwrap_or_default()
}

fn quoted(text: &str) -> Vec<String> {
    text.split(['"', '\''])
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

fn js_members(m: &Manifests) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(v) = m
        .package_json
        .as_deref()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
    {
        let list = v
            .get("workspaces")
            .and_then(|w| w.as_array().or_else(|| w.get("packages")?.as_array()));
        out.extend(
            list.into_iter()
                .flatten()
                .filter_map(|p| p.as_str().map(str::to_owned)),
        );
    }
    if let Some(v) = m
        .pnpm_workspace
        .as_deref()
        .and_then(|t| serde_yaml_ng::from_str::<serde_yaml_ng::Value>(t).ok())
    {
        let list = v.get("packages").and_then(|p| p.as_sequence());
        out.extend(
            list.into_iter()
                .flatten()
                .filter_map(|p| p.as_str().map(str::to_owned)),
        );
    }
    out
}

fn clean(pattern: &str) -> String {
    pattern
        .trim()
        .trim_start_matches("./")
        .trim_end_matches('/')
        .to_owned()
}

/// The directories whose children must be listed to resolve the members: the containers and each member's parent.
pub fn dirs_to_list(m: &Manifests) -> Vec<String> {
    let patterns = m
        .cargo_toml
        .as_deref()
        .map(cargo_members)
        .unwrap_or_default()
        .into_iter()
        .chain(js_members(m));
    let mut out: BTreeSet<String> = CONTAINERS.iter().map(|c| (*c).to_owned()).collect();
    for p in patterns {
        let p = clean(p.trim_start_matches('!'));
        if let Some((parent, _)) = p.split_once('/') {
            // Only the first segment can be listed one level down; deeper members are matched against what that gives.
            if !parent.contains(['*', '?', '[', '{']) {
                out.insert(parent.to_owned());
            }
        }
    }
    out.into_iter().collect()
}

/// A lowercase slug, the policy's area-name rule: [a-z0-9][a-z0-9_-]*, at most 40.
fn slug(text: &str) -> String {
    let s: String = text
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_start_matches(['-', '_']).trim_end_matches('-');
    s.chars()
        .take(40)
        .collect::<String>()
        .trim_end_matches('-')
        .to_owned()
}

/// Areas for a repo whose committed directories are `dirs` (top-level names, and `parent/child` for each listed
/// parent), as area name -> globs. Always `all`; nothing else when the layout shows no members.
pub fn infer(m: &Manifests, dirs: &[String]) -> BTreeMap<String, Vec<String>> {
    let dirs: BTreeSet<&str> = dirs.iter().map(String::as_str).collect();
    let mut members: BTreeMap<String, Ecosystem> = BTreeMap::new();
    let mut resolve = |patterns: Vec<String>, eco: Ecosystem| {
        let (exclude, include): (Vec<String>, Vec<String>) =
            patterns.into_iter().partition(|p| p.starts_with('!'));
        let exclude: Vec<GlobMatcher> = exclude
            .iter()
            .map(|p| GlobMatcher::new(&clean(&p[1..])))
            .collect();
        for p in include.iter().map(|p| clean(p)) {
            let matcher = GlobMatcher::new(&p);
            let depth = p.matches('/').count();
            let wild = p.contains(['*', '?', '[', '{']);
            for d in &dirs {
                let hit = if wild {
                    // `x/*` and `x/**` name x's children: one level down is what the layout lists.
                    d.matches('/').count() == depth && matcher.is_match(d)
                } else {
                    *d == p
                };
                if hit && !exclude.iter().any(|e| e.is_match(d)) {
                    members.entry((*d).to_owned()).or_insert(eco);
                }
            }
        }
    };
    if let Some(cargo) = m.cargo_toml.as_deref() {
        resolve(cargo_members(cargo), Ecosystem::Cargo);
    }
    resolve(js_members(m), Ecosystem::Js);
    for c in CONTAINERS {
        resolve(vec![format!("{c}/*")], Ecosystem::Plain);
    }
    let roots = |eco: Ecosystem| -> &[&str] {
        match eco {
            Ecosystem::Cargo => &CARGO_ROOT,
            Ecosystem::Js => &JS_ROOT,
            Ecosystem::Plain => &[],
        }
    };

    let mut areas: BTreeMap<String, Vec<String>> = BTreeMap::new();
    areas.insert("all".into(), vec!["**".into()]);
    if dirs.contains("docs") {
        areas.insert("docs".into(), vec!["docs/**".into()]);
    }
    if members.len() > MAX_MEMBERS {
        for (path, eco) in &members {
            let top = path.split('/').next().unwrap_or(path);
            let globs = areas.entry(slug(top)).or_default();
            if globs.is_empty() {
                globs.push(format!("{top}/**"));
                globs.extend(roots(*eco).iter().map(|r| (*r).to_owned()));
            }
        }
        return areas;
    }
    for (path, eco) in members {
        let last = path.rsplit('/').next().unwrap_or(&path);
        let name = [slug(last), slug(&path.replace('/', "-"))]
            .into_iter()
            .find(|n| !n.is_empty() && !areas.contains_key(n));
        if let Some(name) = name {
            let mut globs = vec![format!("{path}/**")];
            globs.extend(roots(eco).iter().map(|r| (*r).to_owned()));
            areas.insert(name, globs);
        }
    }
    areas
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dirs(list: &[&str]) -> Vec<String> {
        list.iter().map(|d| (*d).to_owned()).collect()
    }

    fn infer_json(m: &Manifests, d: &[&str]) -> serde_json::Value {
        serde_json::to_value(infer(m, &dirs(d))).unwrap()
    }

    #[test]
    fn a_cargo_workspace_gets_an_area_per_member_and_docs() {
        let m = Manifests {
            cargo_toml: Some(
                "[package]\nname = \"x\"\n\n[workspace]\nresolver = \"3\"\nmembers = [\n  \"crates/*\", # all of them\n  \"tools/gen\",\n]\nexclude = [\"crates/old\"]\n".into(),
            ),
            ..Manifests::default()
        };
        assert_eq!(
            dirs_to_list(&m),
            ["apps", "crates", "packages", "services", "tools"]
        );
        let areas = infer_json(
            &m,
            &[
                "crates",
                "docs",
                "tools",
                ".github",
                "crates/hub",
                "crates/contracts",
                "tools/gen",
                "tools/other",
            ],
        );
        assert_eq!(
            areas,
            json!({
                "all": ["**"],
                "docs": ["docs/**"],
                "hub": ["crates/hub/**", "Cargo.toml", "Cargo.lock"],
                "contracts": ["crates/contracts/**", "Cargo.toml", "Cargo.lock"],
                "gen": ["tools/gen/**", "Cargo.toml", "Cargo.lock"],
            })
        );
    }

    #[test]
    fn js_workspaces_from_package_json_or_pnpm_with_exclusions() {
        let npm = Manifests {
            package_json: Some(r#"{"name":"x","workspaces":{"packages":["packages/*"]}}"#.into()),
            ..Manifests::default()
        };
        assert_eq!(
            infer_json(&npm, &["packages", "packages/ui", "packages/api"]),
            json!({
                "all": ["**"],
                "ui": ["packages/ui/**", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
                "api": ["packages/api/**", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
            })
        );
        let pnpm = Manifests {
            pnpm_workspace: Some("packages:\n  - 'libs/*'\n  - '!libs/scratch'\n".into()),
            ..Manifests::default()
        };
        assert!(dirs_to_list(&pnpm).contains(&"libs".to_owned()));
        let areas = infer(&pnpm, &dirs(&["libs", "libs/core", "libs/scratch"]));
        assert_eq!(areas.keys().collect::<Vec<_>>(), ["all", "core"]);
    }

    #[test]
    fn container_directories_without_a_manifest_and_name_clashes() {
        let areas = infer(
            &Manifests::default(),
            &dirs(&[
                "apps",
                "services",
                "docs",
                "apps/web",
                "services/web",
                "apps/docs",
                "apps/All Tools",
            ]),
        );
        assert_eq!(
            serde_json::to_value(&areas).unwrap(),
            json!({
                "all": ["**"],
                "docs": ["docs/**"],
                "web": ["apps/web/**"],
                "services-web": ["services/web/**"],
                "apps-docs": ["apps/docs/**"],
                "all-tools": ["apps/All Tools/**"],
            })
        );
    }

    #[test]
    fn a_repo_without_members_keeps_one_area_and_a_huge_one_gets_one_per_container() {
        assert_eq!(
            infer_json(&Manifests::default(), &["src", "test"]),
            json!({ "all": ["**"] })
        );
        let many: Vec<String> = (0..50)
            .map(|i| format!("packages/p{i}"))
            .chain(["packages".into(), "apps".into(), "apps/web".into()])
            .collect();
        assert_eq!(
            serde_json::to_value(infer(&Manifests::default(), &many)).unwrap(),
            json!({ "all": ["**"], "apps": ["apps/**"], "packages": ["packages/**"] })
        );
    }

    #[test]
    fn unreadable_manifests_fall_back_to_the_containers() {
        let m = Manifests {
            cargo_toml: Some("[workspace\nmembers = ".into()),
            package_json: Some("{ not json".into()),
            pnpm_workspace: Some(": [".into()),
        };
        assert_eq!(dirs_to_list(&m), ["apps", "crates", "packages", "services"]);
        assert_eq!(
            infer_json(&m, &["crates", "crates/a"]),
            json!({ "all": ["**"], "a": ["crates/a/**"] })
        );
    }
}
