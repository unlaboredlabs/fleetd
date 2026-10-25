//! The skills the hub keeps: plain skill folders (a `SKILL.md` and its files) under `<hub home>/skills`, in no repo.
//! `global/<name>` is every project's; `projects/<machine>/<project>/<name>` is one project's. A folder installed
//! from a source keeps where from and the commit it is pinned to in `.fleetd-install.json`, a dot-file sessions never
//! get. The hub is the only writer: a person in the app (`tools`) or a lead's `skill_install` (`calls`), one write
//! at a time. Every launch carries the project's skills and the global ones of other names to the node
//! ([`Skills::bundles`]), which adds the checkout's own and gives the session the lot (`node::skills`).
pub mod calls;
pub mod install;
pub mod tools;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::prim::{Line, List, Text};
use fleetd_contracts::skills::{
    SCOPE_CAP, SKILL_BYTES_CAP, SKILL_FILE, SKILL_FILES_CAP, SkillBundle, SkillFile, SkillInstall,
    SkillName, SkillOrigin, SkillScope, SkillSummary, check_skill_md, description_of,
};

use crate::hub::store::{HubDb, iso_ms, system_ms};

/// Where an installed skill's source and pin are kept, in its folder.
pub const INSTALL_FILE: &str = ".fleetd-install.json";
/// What one launch carries, all skills together.
const LAUNCH_BYTES_CAP: usize = 4 * 1024 * 1024;

/// A skill folder to put in place: its name, its files (folder-relative path, bytes) and where it came from.
pub type Folder = (SkillName, Vec<(String, Vec<u8>)>, SkillInstall);

/// Serialises every write, from any caller.
static WRITE: Mutex<()> = Mutex::new(());

#[derive(Debug)]
pub struct SkillError {
    pub code: ErrorCode,
    pub message: String,
    pub fix: Option<String>,
}

impl SkillError {
    pub fn new(code: ErrorCode, message: impl Into<String>, fix: Option<&str>) -> Self {
        Self {
            code,
            message: message.into(),
            fix: fix.map(str::to_owned),
        }
    }
}

impl From<std::io::Error> for SkillError {
    fn from(e: std::io::Error) -> Self {
        Self::new(
            ErrorCode::Failed,
            format!("cannot write the skill: {e}"),
            None,
        )
    }
}

/// One skill the hub keeps, read from its folder.
#[derive(Clone, Debug, PartialEq)]
pub struct Kept {
    pub name: SkillName,
    pub scope: SkillScope,
    /// `SKILL.md`.
    pub text: String,
    pub install: Option<SkillInstall>,
    /// The other files, folder-relative, sorted.
    pub files: Vec<String>,
    pub updated_at: Option<Timestamp>,
}

impl Kept {
    pub fn summary(&self) -> SkillSummary {
        SkillSummary {
            name: self.name.clone(),
            origin: self.scope.origin(),
            description: Text::unchecked(description_of(&self.text)),
            shadowed_by: None,
            install: self.install.clone(),
            path: None,
            files: List::unchecked(self.files.iter().map(Line::unchecked).collect()),
            updated_at: self.updated_at.clone(),
        }
    }
}

/// The skills of one hub, over `<home>/skills`; a hub without a home keeps none.
pub struct Skills<'a> {
    dir: Option<&'a Path>,
}

impl HubDb {
    pub fn skills(&self) -> Skills<'_> {
        Skills {
            dir: self.skills_dir(),
        }
    }
}

/// The folder-relative paths of `dir`'s files, dot-files and dot-folders left out, at most one past `cap`.
pub fn files_of(dir: &Path, cap: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), String::new())];
    while let Some((at, prefix)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&at) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let rel = format!("{prefix}{name}");
            match entry.file_type() {
                Ok(t) if t.is_dir() => stack.push((entry.path(), format!("{rel}/"))),
                Ok(t) if t.is_file() => out.push(rel),
                _ => {}
            }
            if out.len() > cap {
                break;
            }
        }
    }
    out.sort();
    out
}

fn mkdir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        mkdir(dir)?;
    }
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
    std::io::Write::write_all(&mut open.open(path)?, bytes)
}

fn secret_refusal(text: &str) -> Result<(), SkillError> {
    if crate::hub::redact::redact(text) != text {
        return Err(SkillError::new(
            ErrorCode::Invalid,
            "That looks like a secret, and a skill never holds one.",
            Some(
                "Leave the value out: a skill names the secret, and the agent asks for it with request_secret.",
            ),
        ));
    }
    Ok(())
}

fn invalid(message: String) -> SkillError {
    SkillError::new(ErrorCode::Invalid, message, None)
}

impl Skills<'_> {
    fn root(&self) -> Result<&Path, SkillError> {
        self.dir.ok_or_else(|| {
            SkillError::new(
                ErrorCode::Failed,
                "This hub has no home to keep skills in.",
                None,
            )
        })
    }

    /// The scope's folder; `r` is the project for scope project.
    pub fn scope_dir(&self, scope: SkillScope, r: Option<&ProjectRef>) -> Option<PathBuf> {
        let root = self.dir?;
        Some(match (scope, r) {
            (SkillScope::Global, _) => root.join("global"),
            (SkillScope::Project, Some(r)) => root
                .join("projects")
                .join(r.machine_id.as_str())
                .join(crate::hub::memory::project_dir_name(r)),
            (SkillScope::Project, None) => return None,
        })
    }

    fn skill_dir(
        &self,
        scope: SkillScope,
        r: Option<&ProjectRef>,
        name: &SkillName,
    ) -> Option<PathBuf> {
        Some(self.scope_dir(scope, r)?.join(name.as_str()))
    }

    fn read(&self, scope: SkillScope, dir: &Path) -> Option<Kept> {
        let name = SkillName::new(dir.file_name()?.to_str()?).ok()?;
        let md = dir.join(SKILL_FILE);
        let text = std::fs::read_to_string(&md).ok()?;
        let install = std::fs::read(dir.join(INSTALL_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        let updated_at = std::fs::metadata(&md)
            .and_then(|m| m.modified())
            .ok()
            .map(|t| iso_ms(system_ms(t)).into());
        let files = files_of(dir, SKILL_FILES_CAP)
            .into_iter()
            .filter(|f| f != SKILL_FILE)
            .collect();
        Some(Kept {
            name,
            scope,
            text,
            install,
            files,
            updated_at,
        })
    }

    /// The scope's skills, by name.
    pub fn list(&self, scope: SkillScope, r: Option<&ProjectRef>) -> Vec<Kept> {
        let Some(dir) = self.scope_dir(scope, r) else {
            return Vec::new();
        };
        let mut out: Vec<Kept> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| self.read(scope, &e.path()))
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    pub fn get(&self, scope: SkillScope, r: Option<&ProjectRef>, name: &SkillName) -> Option<Kept> {
        self.read(scope, &self.skill_dir(scope, r, name)?)
    }

    fn room(
        &self,
        scope: SkillScope,
        r: Option<&ProjectRef>,
        adding: usize,
    ) -> Result<(), SkillError> {
        let have = self.list(scope, r).len();
        if have + adding > SCOPE_CAP {
            return Err(invalid(format!(
                "This scope would hold {} skills, past its cap of {SCOPE_CAP}. Nothing was written.",
                have + adding
            )));
        }
        Ok(())
    }

    /// Creates a skill or replaces its `SKILL.md`; its other files stay. `create` refuses a name already there.
    pub fn set(
        &self,
        scope: SkillScope,
        r: Option<&ProjectRef>,
        name: &SkillName,
        text: &str,
        create: bool,
    ) -> Result<Kept, SkillError> {
        let _write = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        self.root()?;
        if let Some(why) = check_skill_md(name, text) {
            return Err(invalid(why));
        }
        secret_refusal(text)?;
        let dir = self
            .skill_dir(scope, r, name)
            .expect("a hub with a home has paths");
        let exists = dir.join(SKILL_FILE).is_file();
        if create && exists {
            return Err(SkillError::new(
                ErrorCode::Invalid,
                format!("There is already a skill called {name} here."),
                Some("Pick another name, or open that skill to edit it."),
            ));
        }
        if !exists {
            self.room(scope, r, 1)?;
        }
        let md = dir.join(SKILL_FILE);
        let tmp = dir.join(".SKILL.md.tmp");
        write_private(&tmp, text.as_bytes())?;
        std::fs::rename(&tmp, &md)?;
        Ok(self.read(scope, &dir).expect("just written"))
    }

    /// Removes a skill's folder; false when there was none.
    pub fn delete(
        &self,
        scope: SkillScope,
        r: Option<&ProjectRef>,
        name: &SkillName,
    ) -> Result<bool, SkillError> {
        let _write = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        self.root()?;
        let dir = self
            .skill_dir(scope, r, name)
            .expect("a hub with a home has paths");
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    /// Puts whole skill folders in place of any of the same names, each with its install record: all of them, or
    /// none (each is written aside first, then moved in).
    pub fn put_folders(
        &self,
        scope: SkillScope,
        r: Option<&ProjectRef>,
        folders: &[Folder],
    ) -> Result<Vec<Kept>, SkillError> {
        let _write = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        self.root()?;
        let base = self
            .scope_dir(scope, r)
            .expect("a hub with a home has paths");
        let new = folders
            .iter()
            .filter(|(name, ..)| !base.join(name.as_str()).join(SKILL_FILE).is_file())
            .count();
        self.room(scope, r, new)?;
        for (name, files, _) in folders {
            if let Some((_, md)) = files.iter().find(|(p, _)| p == SKILL_FILE) {
                let text = String::from_utf8_lossy(md);
                if let Some(why) = check_skill_md(name, &text) {
                    return Err(invalid(format!("{name}: {why}")));
                }
                secret_refusal(&text)?;
            } else {
                return Err(invalid(format!("{name} has no {SKILL_FILE}.")));
            }
        }
        let staging = base.join(".staging");
        let _ = std::fs::remove_dir_all(&staging);
        for (name, files, install) in folders {
            let dir = staging.join(name.as_str());
            for (rel, bytes) in files {
                write_private(&dir.join(rel), bytes)?;
            }
            let record = serde_json::to_vec_pretty(install).map_err(std::io::Error::other)?;
            write_private(&dir.join(INSTALL_FILE), &record)?;
        }
        let mut out = Vec::new();
        for (name, ..) in folders {
            let to = base.join(name.as_str());
            match std::fs::remove_dir_all(&to) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
            std::fs::rename(staging.join(name.as_str()), &to)?;
            out.push(self.read(scope, &to).expect("just written"));
        }
        let _ = std::fs::remove_dir_all(&staging);
        Ok(out)
    }

    /// What a launch in project `r` carries: the project's skills, then the global ones of other names, their text
    /// files only, within the launch's cap.
    pub fn bundles(&self, r: &ProjectRef) -> Vec<SkillBundle> {
        let mut out: Vec<SkillBundle> = Vec::new();
        let mut bytes = 0usize;
        for (scope, project) in [(SkillScope::Project, Some(r)), (SkillScope::Global, None)] {
            for kept in self.list(scope, project) {
                if out.iter().any(|b| b.name == kept.name) {
                    continue;
                }
                let dir = self.skill_dir(scope, project, &kept.name).expect("listed");
                let mut files = vec![SkillFile {
                    path: Line::unchecked(SKILL_FILE),
                    text: Text::unchecked(kept.text.clone()),
                }];
                let mut size = kept.text.len();
                for rel in &kept.files {
                    // Scripts, references, templates: text. Anything else stays on the hub.
                    let Ok(text) = std::fs::read_to_string(dir.join(rel)) else {
                        continue;
                    };
                    size += text.len();
                    files.push(SkillFile {
                        path: Line::unchecked(rel.as_str()),
                        text: Text::unchecked(text),
                    });
                }
                if size > SKILL_BYTES_CAP || bytes + size > LAUNCH_BYTES_CAP {
                    tracing::warn!(
                        skill = kept.name.as_str(),
                        "skill left out of the launch: too big"
                    );
                    continue;
                }
                bytes += size;
                files.truncate(SKILL_FILES_CAP);
                out.push(SkillBundle {
                    name: kept.name,
                    origin: scope.origin(),
                    files: List::unchecked(files),
                });
            }
        }
        out
    }
}

/// Marks each skill that another of the same name outranks ([`SkillOrigin`]'s order), and sorts the list by origin,
/// then name.
pub fn mark_shadowed(skills: &mut [SkillSummary]) {
    skills.sort_by(|a, b| (a.origin, a.name.as_str()).cmp(&(b.origin, b.name.as_str())));
    for i in 0..skills.len() {
        let winner: Option<SkillOrigin> = skills[..i]
            .iter()
            .find(|s| s.name == skills[i].name)
            .map(|s| s.origin);
        skills[i].shadowed_by = winner;
    }
}
