//! Skills: reusable `SKILL.md` workflows in the Agent Skills format skills.sh installs (a folder named for the skill,
//! a `SKILL.md` with `name` and `description` frontmatter, and any files it uses). An agent session gets them from four
//! places, the first one that has a name winning: the repo's `.agents/skills`, the repo's `.claude/skills`, the
//! project's skills the hub keeps, and the hub's global skills. The hub keeps its skills under its home, never in a
//! repo; installed ones record the source and the commit they are pinned to.

use std::sync::LazyLock;

use regex::Regex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;

use crate::ids::Timestamp;
use crate::prim::{Line, List, Positive, Text};

/// The file that makes a folder a skill.
pub const SKILL_FILE: &str = "SKILL.md";
/// `SKILL.md`, in characters.
pub const SKILL_TEXT_CAP: usize = 64_000;
/// The Agent Skills spec's cap on `description`.
pub const DESCRIPTION_CAP: usize = 1_024;
/// Files in one skill folder, `SKILL.md` included.
pub const SKILL_FILES_CAP: usize = 64;
/// One skill folder's files together, in bytes.
pub const SKILL_BYTES_CAP: usize = 512 * 1024;
/// Skills the hub keeps in one scope.
pub const SCOPE_CAP: usize = 200;
/// The versions the hub keeps of one skill, newest first; an older one is dropped as a new one is kept.
pub const SKILL_VERSIONS_KEPT: usize = 100;
/// A version's `why`, in characters.
pub const WHY_CAP: usize = 300;

static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9]+(-[a-z0-9]+)*$").unwrap());

crate::brand!(
    /// A skill's name, which is also its folder's: lowercase letters, digits and single hyphens, at most 64
    /// characters (the Agent Skills spec).
    SkillName,
    name = "SkillName",
    check = |s| s.len() <= 64 && NAME.is_match(s),
    expected = "lowercase letters, digits and single hyphens, at most 64 characters",
    pattern = r"^[a-z0-9]+(-[a-z0-9]+)*$",
    description = "Lowercase letters, digits and single hyphens, at most 64 characters"
);

/// Where a skill comes from, in precedence order: on a name clash the first wins.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum SkillOrigin {
    /// `.agents/skills/<name>` in the session's checkout: skills.sh's project folder.
    RepoAgents,
    /// `.claude/skills/<name>` in the session's checkout: Claude Code's project folder.
    RepoClaude,
    /// The project's skills, kept by the hub.
    Project,
    /// Every project's, kept by the hub.
    Global,
}

impl SkillOrigin {
    pub const ALL: [SkillOrigin; 4] = [
        SkillOrigin::RepoAgents,
        SkillOrigin::RepoClaude,
        SkillOrigin::Project,
        SkillOrigin::Global,
    ];

    /// The folder in a checkout, for the repo's two.
    pub fn repo_dir(self) -> Option<&'static str> {
        match self {
            SkillOrigin::RepoAgents => Some(".agents/skills"),
            SkillOrigin::RepoClaude => Some(".claude/skills"),
            SkillOrigin::Project | SkillOrigin::Global => None,
        }
    }
}

/// The hub's two scopes, which a person (and a lead's `skill_install`) writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Project,
    Global,
}

impl SkillScope {
    pub fn origin(self) -> SkillOrigin {
        match self {
            SkillScope::Project => SkillOrigin::Project,
            SkillScope::Global => SkillOrigin::Global,
        }
    }
}

/// Where an installed skill came from, pinned: Update fetches the same source again and moves the pin. Nothing
/// updates on its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstall {
    /// As given: `owner/repo`, `owner/repo@skill`, a GitHub URL (`/tree/<ref>/<path>` too) or any git URL.
    pub source: Line<1, 500>,
    /// What was cloned.
    pub url: Line<1, 500>,
    /// The branch or tag followed; `HEAD` for the default branch.
    #[serde(rename = "ref")]
    pub git_ref: Line<1, 200>,
    /// The commit the files are from.
    pub commit: Line<40, 40>,
    /// The skill's folder in the repo; empty for a repo that is one skill.
    pub path: Line<0, 300>,
    pub installed_at: Timestamp,
}

/// One file of a skill folder, by its path inside the folder (`/`-separated).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SkillFile {
    pub path: Line<1, 300>,
    pub text: Text<0, SKILL_BYTES_CAP>,
}

/// A hub-kept skill as a launch carries it to the node, which gives it to the session.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SkillBundle {
    pub name: SkillName,
    pub origin: SkillOrigin,
    pub files: List<SkillFile, 1, SKILL_FILES_CAP>,
}

/// Who wrote a version of a hub-kept skill.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillAuthor {
    /// A Navi's `skill_save`, or a lead's `skill_install`.
    Agent,
    /// A person in the app: an edit, a revert, an install.
    Person,
}

/// One version of a hub-kept skill's `SKILL.md`: every write keeps one (a Navi's save, a person's edit or revert, an
/// install), the newest [`SKILL_VERSIONS_KEPT`] of them.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersion {
    /// 1 for its first, one more for each after; a revert is a new version too.
    pub version: Positive,
    pub author: SkillAuthor,
    /// The Navi's (or the lead's project's) title, or the person's name.
    pub by: Line<1, 200>,
    pub at: Timestamp,
    /// The one line its author gave: a Navi always gives one; a person may.
    pub why: Option<Line<1, WHY_CAP>>,
}

/// One skill as Settings → Skills and the composer list it.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: SkillName,
    pub origin: SkillOrigin,
    /// From the frontmatter; empty when it has none.
    pub description: Text<0, DESCRIPTION_CAP>,
    /// The origin whose skill of the same name sessions get instead.
    pub shadowed_by: Option<SkillOrigin>,
    /// Installed from a source.
    pub install: Option<SkillInstall>,
    /// A repo skill: its `SKILL.md`, repo-relative.
    pub path: Option<Line<1, 400>>,
    /// The folder's other files, folder-relative.
    #[serde(default)]
    pub files: List<Line<1, 300>, 0, SKILL_FILES_CAP>,
    pub updated_at: Option<Timestamp>,
    /// A hub-kept skill's newest version: who changed it last, when and why. Absent for a repo skill, and for one
    /// written before versions were kept and not since.
    pub changed: Option<SkillVersion>,
    /// Listed for a project: the person turned it off there (`skill_off`), so its sessions don't get it.
    pub off: Option<bool>,
    /// Listed for a project: when one of its sessions last ran it with the Skill tool (its lead's, a Navi's).
    pub last_used_at: Option<Timestamp>,
}

/// A repo skill as the node finds it in the project's checkout.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RepoSkill {
    pub name: SkillName,
    pub origin: SkillOrigin,
    pub description: String,
    /// Its `SKILL.md`, repo-relative.
    pub path: String,
}

/// `skill_install`: a lead installs skills into its project, or for every project, from a source. Pinned to the
/// commit it fetched; the person updates it from Settings → Skills.
#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SkillInstallCall {
    /// `owner/repo`, `owner/repo@skill`, a GitHub URL (`/tree/<ref>/<path>` too) or any git URL.
    pub source: Line<1, 500>,
    /// Only this skill of the source; absent, every skill it has.
    pub skill: Option<SkillName>,
    pub scope: SkillScope,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SkillInstallResult {
    pub installed: List<SkillName, 1, SCOPE_CAP>,
    pub commit: Line<40, 40>,
    pub next: Option<String>,
}

/// `skill_save`: a Navi writes one of its own skills, new or changed, as a whole `SKILL.md`. No one approves it: the
/// hub keeps it as a new version with `why`, posts one line in the chat, and the Navi's sessions get it from their next
/// start. It is the Navi's only, never another Navi's or a project's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SkillSaveCall {
    /// The skill's folder name, also its frontmatter `name`: `weekly-invoices`.
    pub name: SkillName,
    /// The whole `SKILL.md`: frontmatter (`name`, a `description` of what it does and when to use it), then the
    /// steps.
    pub text: Text<1, SKILL_TEXT_CAP>,
    /// One line on why: what it learned, or what the person corrected.
    pub why: Line<1, WHY_CAP>,
}

#[skip_serializing_none]
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SkillSaveResult {
    pub name: SkillName,
    pub version: Positive,
    /// It is new: this is its first version.
    pub created: bool,
    pub next: Option<String>,
}

/// A chat line's skill: a Navi saved or changed one (`skill_save`). The app links it to the skill's view.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillSaved {
    pub name: SkillName,
    pub version: Positive,
    /// Its first version.
    pub created: bool,
    pub why: Line<1, WHY_CAP>,
}

/// A `SKILL.md`'s frontmatter: the `name` and `description` it gives.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Frontmatter {
    pub name: Option<String>,
    pub description: Option<String>,
}

/// The `name` and `description` of a `SKILL.md`'s YAML frontmatter: plain, quoted and block (`>`, `|`) scalars. A
/// file without frontmatter gives neither.
pub fn frontmatter(text: &str) -> Frontmatter {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.lines();
    if lines.next().map(str::trim_end) != Some("---") {
        return Frontmatter::default();
    }
    let block: Vec<&str> = lines.take_while(|l| l.trim_end() != "---").collect();
    let mut out = Frontmatter::default();
    let mut i = 0;
    while i < block.len() {
        let line = block[i];
        i += 1;
        if line.starts_with([' ', '\t']) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        let value = if matches!(value.chars().next(), Some('>' | '|')) {
            let folded = value.starts_with('>');
            let mut parts = Vec::new();
            while i < block.len()
                && (block[i].starts_with([' ', '\t']) || block[i].trim().is_empty())
            {
                parts.push(block[i].trim());
                i += 1;
            }
            let parts: Vec<&str> = parts.into_iter().filter(|p| !p.is_empty()).collect();
            parts.join(if folded { " " } else { "\n" })
        } else {
            unquote(value)
        };
        match key.trim() {
            "name" => out.name = Some(value),
            "description" => out.description = Some(value),
            _ => {}
        }
    }
    out
}

fn unquote(value: &str) -> String {
    for q in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(q) && value.ends_with(q) {
            let inner = &value[1..value.len() - 1];
            return if q == '\'' {
                inner.replace("''", "'")
            } else {
                inner.replace("\\\"", "\"").replace("\\\\", "\\")
            };
        }
    }
    // A plain scalar ends at a comment.
    value.split(" #").next().unwrap_or(value).trim().to_owned()
}

/// The description a listing shows: the frontmatter's, at most [`DESCRIPTION_CAP`] characters, on one line.
pub fn description_of(text: &str) -> String {
    let d = frontmatter(text).description.unwrap_or_default();
    d.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(DESCRIPTION_CAP)
        .collect()
}

/// What is wrong with `text` as the `SKILL.md` of a skill called `name`, or None: it needs frontmatter with a
/// description, and a `name` there must be the folder's.
pub fn check_skill_md(name: &SkillName, text: &str) -> Option<String> {
    if text.chars().count() > SKILL_TEXT_CAP {
        return Some(format!(
            "SKILL.md is past its cap of {SKILL_TEXT_CAP} characters."
        ));
    }
    let front = frontmatter(text);
    if front == Frontmatter::default() && !text.trim_start().starts_with("---") {
        return Some("SKILL.md starts with frontmatter: ---, name and description, ---.".into());
    }
    if let Some(n) = &front.name
        && n != name.as_str()
    {
        return Some(format!(
            "The frontmatter names it {n}, and its folder is {name}: they must match."
        ));
    }
    match front.description.as_deref().map(str::trim) {
        None | Some("") => Some(
            "The frontmatter needs a description: what the skill does and when to use it.".into(),
        ),
        Some(d) if d.chars().count() > DESCRIPTION_CAP => Some(format!(
            "The description is past its cap of {DESCRIPTION_CAP} characters."
        )),
        Some(_) => None,
    }
}

/// A new skill's `SKILL.md`, which the app's New starts from.
pub fn template(name: &SkillName) -> String {
    format!(
        "---\nname: {name}\ndescription: What this skill does, and when an agent should use it.\n---\n\n# {name}\n\n\
         Steps the agent follows, in order.\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_agent_skills_spec() {
        for ok in ["pdf", "pr-review", "a1-b2"] {
            assert!(SkillName::new(ok).is_ok(), "{ok}");
        }
        for bad in ["", "PDF", "-a", "a-", "a--b", "a_b", "a.b", &"a".repeat(65)] {
            assert!(SkillName::new(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn frontmatter_reads_plain_quoted_and_block_scalars() {
        let f = frontmatter(
            "---\nname: pdf\ndescription: \"Fill PDF forms: any.\"\nlicense: MIT\n---\n# Body\n",
        );
        assert_eq!(f.name.as_deref(), Some("pdf"));
        assert_eq!(f.description.as_deref(), Some("Fill PDF forms: any."));
        let f = frontmatter(
            "---\nname: x\ndescription: >\n  Two lines\n  folded.\nmetadata:\n  a: b\n---\n",
        );
        assert_eq!(f.description.as_deref(), Some("Two lines folded."));
        assert_eq!(frontmatter("# no frontmatter\n"), Frontmatter::default());
        assert_eq!(
            frontmatter("---\ndescription: it's # a note\n---")
                .description
                .as_deref(),
            Some("it's")
        );
    }

    #[test]
    fn a_skill_md_needs_a_description_and_its_folders_name() {
        let name = SkillName::new("deploy").unwrap();
        assert_eq!(check_skill_md(&name, &template(&name)), None);
        assert!(
            check_skill_md(&name, "# just text")
                .unwrap()
                .contains("frontmatter")
        );
        assert!(
            check_skill_md(&name, "---\nname: other\ndescription: d\n---\n")
                .unwrap()
                .contains("match")
        );
        assert!(
            check_skill_md(&name, "---\nname: deploy\n---\n")
                .unwrap()
                .contains("description")
        );
        assert_eq!(check_skill_md(&name, "---\ndescription: d\n---\n"), None);
    }

    #[test]
    fn origins_are_in_precedence_order() {
        let mut sorted = SkillOrigin::ALL;
        sorted.sort();
        assert_eq!(sorted, SkillOrigin::ALL);
    }
}
