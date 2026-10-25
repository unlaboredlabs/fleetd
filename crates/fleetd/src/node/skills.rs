//! A session's skills. Four sources, the first that has a name winning ([`SkillOrigin`]'s order): the checkout's
//! `.agents/skills` (skills.sh), its `.claude/skills` (Claude Code), then the project's and the global skills the hub
//! keeps, which ride on the launch and are kept beside the session's other files. At every start the node copies the
//! winners into a session-only plugin, `<home>/sessions/<id>/plugin` (`--plugin-dir`), so claude lists each as
//! `fleetd:<name>` with its description and reads the rest when the Skill tool opens it; and the session's settings
//! overlay turns off (`skillOverrides`) any other skill of a winner's name claude would load itself (the checkout's
//! `.claude/skills` copy, the person's `~/.claude/skills`), which never touches plugin skills. Nothing is written in
//! the checkout.
use std::path::{Path, PathBuf};

use fleetd_contracts::skills::{
    RepoSkill, SKILL_BYTES_CAP, SKILL_FILE, SKILL_FILES_CAP, SkillBundle, SkillName, SkillOrigin,
    description_of,
};

/// The plugin's name: claude lists its skills as `fleetd:<name>`.
pub const PLUGIN_NAME: &str = "fleetd";
/// The hub's skills for a session, as its launch carried them.
const HUB_SKILLS_FILE: &str = "hub-skills.json";

/// One skill a session could get, before precedence.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub name: SkillName,
    pub origin: SkillOrigin,
    pub from: From,
}

#[derive(Clone, Debug, PartialEq)]
pub enum From {
    /// A folder in the checkout.
    Dir(PathBuf),
    /// Files the hub sent.
    Files(Vec<(String, String)>),
}

/// What a start gives the session.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Prepared {
    /// `--plugin-dir`; none when the session has no skills.
    pub plugin_dir: Option<PathBuf>,
    /// The winners, by name.
    pub skills: Vec<(SkillName, SkillOrigin)>,
}

impl Prepared {
    /// The overlay's `skillOverrides`: every other skill of a winner's name, off.
    pub fn overrides(&self) -> serde_json::Map<String, serde_json::Value> {
        self.skills
            .iter()
            .map(|(name, _)| (name.to_string(), "off".into()))
            .collect()
    }
}

/// One winner per name, by [`SkillOrigin`]'s order, sorted by name.
pub fn resolve(mut found: Vec<Candidate>) -> Vec<Candidate> {
    found.sort_by(|a, b| (a.name.as_str(), a.origin).cmp(&(b.name.as_str(), b.origin)));
    found.dedup_by(|later, first| later.name == first.name);
    found
}

/// The skill folders of the checkout at `root`: each `<dir>/<name>/SKILL.md` whose folder name is a skill name. A
/// folder that links elsewhere (skills.sh links `.claude/skills/<name>` to `.agents/skills/<name>`) counts.
pub fn repo_candidates(root: &Path) -> Vec<Candidate> {
    let mut out = Vec::new();
    for origin in [SkillOrigin::RepoAgents, SkillOrigin::RepoClaude] {
        let Some(rel) = origin.repo_dir() else {
            continue;
        };
        let Ok(entries) = std::fs::read_dir(root.join(rel)) else {
            continue;
        };
        for entry in entries.flatten() {
            let Some(name) = entry
                .file_name()
                .to_str()
                .and_then(|n| SkillName::new(n).ok())
            else {
                continue;
            };
            let dir = entry.path();
            if dir.join(SKILL_FILE).is_file() {
                out.push(Candidate {
                    name,
                    origin,
                    from: From::Dir(dir),
                });
            }
        }
    }
    out
}

/// The checkout's skills with their descriptions, for Settings → Skills (`skills_list`).
pub fn repo_skills(root: &Path) -> Vec<RepoSkill> {
    let mut found = repo_candidates(root);
    found.sort_by(|a, b| (a.origin, a.name.as_str()).cmp(&(b.origin, b.name.as_str())));
    found
        .into_iter()
        .map(|c| {
            let text = match &c.from {
                From::Dir(dir) => std::fs::read_to_string(dir.join(SKILL_FILE)).unwrap_or_default(),
                From::Files(_) => String::new(),
            };
            RepoSkill {
                path: format!(
                    "{}/{}/{SKILL_FILE}",
                    c.origin.repo_dir().unwrap_or_default(),
                    c.name
                ),
                description: description_of(&text),
                name: c.name,
                origin: c.origin,
            }
        })
        .collect()
}

/// Keeps the hub's skills from a launch in the session's directory, for every start of it.
pub fn keep(session_dir: &Path, bundles: &[SkillBundle]) -> std::io::Result<()> {
    super::config::mkdir_private(session_dir)?;
    let path = session_dir.join(HUB_SKILLS_FILE);
    if bundles.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    std::fs::write(
        path,
        serde_json::to_vec(bundles).map_err(std::io::Error::other)?,
    )
}

fn kept(session_dir: &Path) -> Vec<Candidate> {
    let Ok(bytes) = std::fs::read(session_dir.join(HUB_SKILLS_FILE)) else {
        return Vec::new();
    };
    let bundles: Vec<SkillBundle> = serde_json::from_slice(&bytes).unwrap_or_default();
    bundles
        .into_iter()
        .map(|b| Candidate {
            name: b.name,
            origin: b.origin,
            from: From::Files(
                b.files
                    .iter()
                    .map(|f| (f.path.to_string(), f.text.to_string()))
                    .collect(),
            ),
        })
        .collect()
}

/// Writes the session's plugin afresh from the checkout at `cwd` and the hub's skills kept for it, so a start always
/// has what the sources hold now.
pub fn prepare(session_dir: &Path, cwd: &Path) -> std::io::Result<Prepared> {
    let mut found = repo_candidates(cwd);
    found.extend(kept(session_dir));
    let winners = resolve(found);
    let dir = session_dir.join("plugin");
    match std::fs::remove_dir_all(&dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    if winners.is_empty() {
        return Ok(Prepared::default());
    }
    super::config::mkdir_private(&dir.join(".claude-plugin"))?;
    let manifest = serde_json::json!({
        "name": PLUGIN_NAME,
        "description": "The skills fleetd gives this session: the repo's, the project's and the hub's.",
    });
    std::fs::write(
        dir.join(".claude-plugin").join("plugin.json"),
        format!("{manifest}\n"),
    )?;
    let mut skills = Vec::new();
    for c in winners {
        let to = dir.join("skills").join(c.name.as_str());
        let written = match &c.from {
            From::Dir(from) => copy_skill(from, &to),
            From::Files(files) => write_files(&to, files),
        };
        match written {
            Ok(()) => skills.push((c.name, c.origin)),
            Err(e) => {
                tracing::warn!(
                    skill = c.name.as_str(),
                    "skill left out of the session: {e}"
                );
                let _ = std::fs::remove_dir_all(&to);
            }
        }
    }
    Ok(Prepared {
        plugin_dir: Some(dir),
        skills,
    })
}

/// A folder-relative path that stays in the folder.
fn safe_rel(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}

fn write_files(to: &Path, files: &[(String, String)]) -> std::io::Result<()> {
    for (rel, text) in files {
        if !safe_rel(rel) {
            return Err(std::io::Error::other(format!("{rel} leaves its folder")));
        }
        let path = to.join(rel);
        if let Some(parent) = path.parent() {
            super::config::mkdir_private(parent)?;
        }
        std::fs::write(path, text)?;
    }
    Ok(())
}

/// Copies a checkout's skill folder, its dot-files left out, within [`SKILL_FILES_CAP`] and [`SKILL_BYTES_CAP`].
fn copy_skill(from: &Path, to: &Path) -> std::io::Result<()> {
    let (mut files, mut bytes) = (0usize, 0u64);
    let mut stack = vec![(from.to_path_buf(), to.to_path_buf())];
    while let Some((src, dst)) = stack.pop() {
        super::config::mkdir_private(&dst)?;
        for entry in std::fs::read_dir(&src)?.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            let meta = std::fs::metadata(entry.path())?;
            if meta.is_dir() {
                stack.push((entry.path(), dst.join(&name)));
            } else if meta.is_file() {
                files += 1;
                bytes += meta.len();
                if files > SKILL_FILES_CAP || bytes > SKILL_BYTES_CAP as u64 {
                    return Err(std::io::Error::other(format!(
                        "{} is past {SKILL_FILES_CAP} files or {} KB",
                        from.display(),
                        SKILL_BYTES_CAP / 1024
                    )));
                }
                std::fs::copy(entry.path(), dst.join(&name))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::prim::List;
    use fleetd_contracts::skills::SkillFile;

    pub fn skill_md(name: &str, says: &str) -> String {
        format!("---\nname: {name}\ndescription: {says}\n---\n\n{says}\n")
    }

    pub fn put(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    pub fn bundle(name: &str, origin: SkillOrigin, says: &str) -> SkillBundle {
        SkillBundle {
            name: SkillName::new(name).unwrap(),
            origin,
            files: List::unchecked(vec![SkillFile {
                path: fleetd_contracts::prim::Line::unchecked(SKILL_FILE),
                text: fleetd_contracts::prim::Text::unchecked(skill_md(name, says)),
            }]),
        }
    }

    #[test]
    fn the_first_source_with_a_name_wins() {
        let c = |name: &str, origin| Candidate {
            name: SkillName::new(name).unwrap(),
            origin,
            from: From::Files(Vec::new()),
        };
        let won = resolve(vec![
            c("deploy", SkillOrigin::Global),
            c("deploy", SkillOrigin::RepoClaude),
            c("deploy", SkillOrigin::Project),
            c("lint", SkillOrigin::Global),
            c("lint", SkillOrigin::Project),
            c("deploy", SkillOrigin::RepoAgents),
        ]);
        let won: Vec<_> = won.iter().map(|c| (c.name.as_str(), c.origin)).collect();
        assert_eq!(
            won,
            [
                ("deploy", SkillOrigin::RepoAgents),
                ("lint", SkillOrigin::Project)
            ]
        );
    }

    #[test]
    fn a_session_gets_every_source_in_one_plugin_and_nothing_in_the_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, session) = (tmp.path().join("repo"), tmp.path().join("session"));
        put(
            &repo,
            ".agents/skills/release/SKILL.md",
            &skill_md("release", "agents copy"),
        );
        put(&repo, ".agents/skills/release/scripts/go.sh", "echo go\n");
        put(&repo, ".agents/skills/release/.cache/x", "left out");
        put(
            &repo,
            ".claude/skills/release/SKILL.md",
            &skill_md("release", "claude copy"),
        );
        put(
            &repo,
            ".claude/skills/triage/SKILL.md",
            &skill_md("triage", "claude only"),
        );
        put(
            &repo,
            ".claude/skills/Not_A_Name/SKILL.md",
            &skill_md("x", "skipped"),
        );
        put(&repo, ".claude/skills/no-skill-md/README.md", "skipped");
        keep(
            &session,
            &[
                bundle("triage", SkillOrigin::Project, "project copy"),
                bundle("standup", SkillOrigin::Global, "global only"),
            ],
        )
        .unwrap();
        let before = listing(&repo);

        let p = prepare(&session, &repo).unwrap();
        let plugin = p.plugin_dir.clone().unwrap();
        assert_eq!(plugin, session.join("plugin"));
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(plugin.join(".claude-plugin/plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], PLUGIN_NAME);
        let names: Vec<_> = p.skills.iter().map(|(n, o)| (n.as_str(), *o)).collect();
        assert_eq!(
            names,
            [
                ("release", SkillOrigin::RepoAgents),
                ("standup", SkillOrigin::Global),
                ("triage", SkillOrigin::RepoClaude),
            ]
        );
        let read = |rel: &str| std::fs::read_to_string(plugin.join("skills").join(rel)).unwrap();
        assert!(read("release/SKILL.md").contains("agents copy"));
        assert_eq!(read("release/scripts/go.sh"), "echo go\n");
        assert!(!plugin.join("skills/release/.cache").exists());
        assert!(read("triage/SKILL.md").contains("claude only"));
        assert!(read("standup/SKILL.md").contains("global only"));
        assert_eq!(
            serde_json::Value::Object(p.overrides()),
            serde_json::json!({ "release": "off", "standup": "off", "triage": "off" })
        );
        // The checkout is as it was: the plugin lives with the session.
        assert_eq!(listing(&repo), before);

        // A start with the source gone drops it.
        std::fs::remove_dir_all(repo.join(".agents")).unwrap();
        keep(&session, &[]).unwrap();
        let p = prepare(&session, &repo).unwrap();
        let names: Vec<_> = p.skills.iter().map(|(n, o)| (n.as_str(), *o)).collect();
        assert_eq!(
            names,
            [
                ("release", SkillOrigin::RepoClaude),
                ("triage", SkillOrigin::RepoClaude)
            ]
        );
        assert!(!plugin.join("skills/standup").exists());
    }

    #[test]
    fn no_skills_no_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        let p = prepare(&tmp.path().join("s"), tmp.path()).unwrap();
        assert_eq!(p, Prepared::default());
    }

    #[test]
    fn a_hub_file_that_leaves_its_folder_drops_that_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let mut bad = bundle("evil", SkillOrigin::Global, "x");
        bad.files = List::unchecked(vec![SkillFile {
            path: fleetd_contracts::prim::Line::unchecked("../../escape.md"),
            text: fleetd_contracts::prim::Text::unchecked("x"),
        }]);
        keep(tmp.path(), &[bad, bundle("fine", SkillOrigin::Global, "y")]).unwrap();
        let p = prepare(tmp.path(), &tmp.path().join("none")).unwrap();
        assert_eq!(p.skills.len(), 1);
        assert!(!tmp.path().join("escape.md").exists());
    }

    #[test]
    fn repo_skills_list_both_folders_with_descriptions() {
        let tmp = tempfile::tempdir().unwrap();
        put(
            tmp.path(),
            ".claude/skills/b/SKILL.md",
            &skill_md("b", "Bee."),
        );
        put(
            tmp.path(),
            ".agents/skills/a/SKILL.md",
            &skill_md("a", "Ay."),
        );
        let listed = repo_skills(tmp.path());
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].path, ".agents/skills/a/SKILL.md");
        assert_eq!(listed[0].description, "Ay.");
        assert_eq!(listed[1].origin, SkillOrigin::RepoClaude);
    }

    /// claude 2.1.302 loading a session's plugin, as the documented fixture has it (fleetd's agents can't run claude to
    /// record it): every skill fleetd writes is listed as `fleetd:<name>` from the `@inline` plugin at `--plugin-dir`,
    /// and the checkout's own copies, which the overlay turns off, are not listed.
    #[test]
    fn claude_lists_the_plugins_skills_as_fleetd_and_not_the_checkouts_own() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, session) = (tmp.path().join("repo"), tmp.path().join("session"));
        put(
            &repo,
            ".claude/skills/release/SKILL.md",
            &skill_md("release", "r"),
        );
        put(
            &repo,
            ".claude/skills/triage/SKILL.md",
            &skill_md("triage", "t"),
        );
        keep(&session, &[bundle("standup", SkillOrigin::Global, "s")]).unwrap();
        let p = prepare(&session, &repo).unwrap();

        let fixture =
            include_str!("runner/fixtures/claude-2.1.302-skills-plugin-dir.documented.jsonl");
        let lines: Vec<serde_json::Value> = fixture
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let args: Vec<&str> = lines[0]["msg"]["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap())
            .collect();
        let dir = args[args.iter().position(|a| *a == "--plugin-dir").unwrap() + 1];
        let init = lines
            .iter()
            .map(|l| &l["msg"])
            .find(|m| m["subtype"] == "init")
            .unwrap();
        let plugin = init["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == PLUGIN_NAME)
            .unwrap();
        assert_eq!(
            (plugin["path"].as_str(), plugin["source"].as_str()),
            (Some(dir), Some("fleetd@inline"))
        );
        let listed: Vec<&str> = init["skills"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap())
            .collect();
        let ours: Vec<&str> = listed
            .iter()
            .copied()
            .filter(|s| s.starts_with("fleetd:"))
            .collect();
        let wrote: Vec<String> = p
            .skills
            .iter()
            .map(|(n, _)| format!("{PLUGIN_NAME}:{n}"))
            .collect();
        assert_eq!(ours, wrote);
        for (name, _) in &p.skills {
            assert!(!listed.contains(&name.as_str()), "{name} is listed twice");
        }
    }

    fn listing(root: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                if e.path().is_dir() {
                    stack.push(e.path());
                }
                out.push(e.path());
            }
        }
        out.sort();
        out
    }
}
