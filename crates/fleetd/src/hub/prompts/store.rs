//! Where prompt texts live and which one a message gets.
//!
//! Overrides are files under `<hub home>/prompts` (`<id>.md`, `projects/<key>/<id>.md`, `<key>` a hash of the project ref), each with a
//! `base:` frontmatter naming the default it was edited from; playbooks keep `<hub home>/playbooks/<name>.md`. Files
//! are read on every resolve, so an edit (a tool call, the CLI, or by hand) reaches the next session at once. Every
//! text a session was given is kept in `prompt_versions`, and `session_prompts` pins each session to its refs: every
//! later message to that thread renders from the text it started with.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, Timestamp};
use fleetd_contracts::prompts::{
    PromptDetail, PromptId, PromptOverride, PromptRef, PromptScope, PromptSummary, PromptVersion,
    PromptWarning, SessionPrompt, SessionPromptRef, StalePrompt,
};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

use super::registry::{self, Audience, ENTRIES, Entry, INSTRUCTIONS};
use super::render::{self, merge, ref_of, rule_present, same_words, warnings};
use crate::hub::playbooks::load::{git_blob_sha, parse_playbook};
use crate::hub::store::{HubDb, StoreError};

/// One resolved text.
#[derive(Clone, Debug)]
pub struct Resolved {
    pub r#ref: String,
    pub scope: PromptScope,
    pub text: Arc<str>,
}

/// The texts one message is rendered from: a session's pinned ones, or the current ones for a project.
#[derive(Clone, Debug)]
pub struct PromptSet {
    entries: HashMap<&'static str, Resolved>,
    /// Global, then project; empty ones left out.
    instructions: Vec<Resolved>,
}

static DEFAULTS: LazyLock<PromptSet> = LazyLock::new(|| PromptSet {
    entries: ENTRIES.iter().map(|e| (e.id, default_of(e))).collect(),
    instructions: Vec::new(),
});

fn default_of(e: &Entry) -> Resolved {
    Resolved {
        r#ref: ref_of(e.id, e.default),
        scope: PromptScope::Default,
        text: Arc::from(e.default),
    }
}

impl PromptSet {
    /// The shipped texts and no instructions.
    pub fn defaults() -> &'static PromptSet {
        &DEFAULTS
    }

    pub fn get(&self, id: &str) -> &Resolved {
        self.entries
            .get(id)
            .unwrap_or_else(|| panic!("no prompt {id} in the registry"))
    }

    pub fn render(&self, id: &str, vars: &[(&str, &dyn std::fmt::Display)]) -> String {
        render::render(&self.get(id).text, vars)
    }

    /// A first message (lead or task) with the human's custom instructions appended.
    pub fn with_instructions(&self, first: String) -> String {
        if self.instructions.is_empty() {
            return first;
        }
        let texts: Vec<&str> = self.instructions.iter().map(|r| r.text.trim()).collect();
        format!(
            "{first}\n\n## Custom instructions from the human\n{}",
            texts.join("\n\n")
        )
    }

    /// What a session of `audience` pins: every entry it may receive, and the instructions.
    pub fn refs(&self, audience: Audience) -> Vec<(SessionPromptRef, Arc<str>)> {
        ENTRIES
            .iter()
            .filter(|e| e.audience == audience || e.audience == Audience::Any)
            .map(|e| (e.id, self.get(e.id)))
            .chain(self.instructions.iter().map(|r| (INSTRUCTIONS, r)))
            .map(|(id, r)| {
                (
                    SessionPromptRef {
                        id: PromptId::unchecked(id),
                        r#ref: PromptRef::unchecked(r.r#ref.clone()),
                        scope: r.scope,
                    },
                    Arc::clone(&r.text),
                )
            })
            .collect()
    }
}

/// An override file's text, without its frontmatter, and the default it was edited from.
#[derive(Clone, Debug)]
pub struct Override {
    pub text: String,
    pub base: Option<String>,
}

impl Override {
    fn version(&self, id: &str) -> PromptOverride {
        PromptOverride {
            r#ref: PromptRef::unchecked(ref_of(id, &self.text)),
            text: self.text.clone(),
            base: self.base.clone().map(PromptRef::unchecked),
        }
    }
}

fn parse_file(raw: &str) -> Override {
    let block = raw
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n"));
    match block {
        Some((front, text)) if front.lines().all(|l| l.contains(':')) => Override {
            text: text.to_owned(),
            base: front
                .lines()
                .find_map(|l| l.strip_prefix("base:"))
                .map(|b| b.trim().to_owned())
                .filter(|b| !b.is_empty()),
        },
        _ => Override {
            text: raw.to_owned(),
            base: None,
        },
    }
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let dir = path.parent().expect("an override file has a directory");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

#[derive(Debug, thiserror::Error)]
pub enum PromptError {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    NotFound(String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("cannot write the override: {0}")]
    Io(#[from] std::io::Error),
}

/// An override edited from an older default than the one shipped now.
pub struct StaleOverride {
    pub entry: &'static Entry,
    pub project: Option<ProjectRef>,
    pub base: Option<String>,
}

/// The prompts of one hub, over its database and `<home>/prompts`.
pub struct Prompts<'a> {
    db: &'a HubDb,
}

impl HubDb {
    pub fn prompts(&self) -> Prompts<'_> {
        Prompts { db: self }
    }
}

pub fn entry(id: &str) -> Result<&'static Entry, PromptError> {
    registry::get(id).ok_or_else(|| PromptError::NotFound(format!("There is no prompt {id}.")))
}

impl Prompts<'_> {
    fn file(&self, e: &Entry, project: Option<&ProjectRef>) -> Option<PathBuf> {
        let dir = self.db.prompts_dir()?;
        if let Some(name) = e.playbook() {
            return Some(
                dir.parent()?
                    .join("playbooks")
                    .join(format!("{}.md", name.as_str())),
            );
        }
        let file = match project {
            None => dir.join(format!("{}.md", e.id)),
            Some(p) => dir
                .join("projects")
                .join(project_key(p))
                .join(format!("{}.md", e.id)),
        };
        // Ids are registry constants and the key is hex, so this holds; checked anyway, since the file is written.
        file.starts_with(dir).then_some(file)
    }

    /// The override at exactly this level.
    pub fn override_of(&self, e: &Entry, project: Option<&ProjectRef>) -> Option<Override> {
        if project.is_some() && !e.per_project() {
            return None;
        }
        let raw = std::fs::read_to_string(self.file(e, project)?).ok()?;
        Some(if e.playbook().is_some() {
            Override {
                text: raw,
                base: None,
            }
        } else {
            parse_file(&raw)
        })
    }

    fn effective_override(
        &self,
        e: &Entry,
        project: Option<&ProjectRef>,
    ) -> Option<(PromptScope, Override)> {
        project
            .and_then(|p| {
                self.override_of(e, Some(p))
                    .map(|o| (PromptScope::Project, o))
            })
            .or_else(|| self.override_of(e, None).map(|o| (PromptScope::Global, o)))
    }

    fn resolve(&self, e: &Entry, project: Option<&ProjectRef>) -> Resolved {
        match self.effective_override(e, project) {
            Some((scope, o)) => Resolved {
                r#ref: ref_of(e.id, &o.text),
                scope,
                text: Arc::from(o.text),
            },
            None => default_of(e),
        }
    }

    fn instructions(&self, project: Option<&ProjectRef>) -> Vec<Resolved> {
        let e = registry::entry(INSTRUCTIONS);
        let mut levels = vec![(PromptScope::Global, None)];
        if project.is_some() {
            levels.push((PromptScope::Project, project));
        }
        levels
            .into_iter()
            .filter_map(|(scope, p)| {
                let o = self.override_of(e, p)?;
                (!o.text.trim().is_empty()).then(|| Resolved {
                    r#ref: ref_of(e.id, &o.text),
                    scope,
                    text: Arc::from(o.text),
                })
            })
            .collect()
    }

    /// The texts in effect now: the project's override, else the hub-wide one, else the shipped default.
    pub fn current(&self, project: Option<&ProjectRef>) -> PromptSet {
        PromptSet {
            entries: ENTRIES
                .iter()
                .map(|e| (e.id, self.resolve(e, project)))
                .collect(),
            instructions: self.instructions(project),
        }
    }

    /// The texts for a message to this thread: what its session pinned at its start, the current ones for the rest.
    /// A thread fleetd did not start (or started before pinning) gets its project's current texts.
    pub fn for_thread(&self, machine_id: &MachineId, thread_id: &str) -> PromptSet {
        self.pinned(machine_id, thread_id).unwrap_or_else(|error| {
            tracing::warn!(%error, "prompts: pinned texts unreadable, using the current ones");
            self.current(None)
        })
    }

    fn pinned(&self, machine_id: &MachineId, thread_id: &str) -> Result<PromptSet, StoreError> {
        let row: Option<(Option<String>, String)> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT project_id, refs FROM session_prompts WHERE machine_id = ? AND thread_id = ?",
                params![machine_id.as_str(), thread_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
        })?;
        let project_of = |id: String| ProjectRef {
            machine_id: machine_id.clone(),
            project_id: ProjectId::unchecked(id),
        };
        let Some((project_id, refs)) = row else {
            let project: Option<String> = self.db.with(|c| {
                Ok(c.query_row(
                    "SELECT project_id FROM threads WHERE machine_id = ? AND thread_id = ?",
                    params![machine_id.as_str(), thread_id],
                    |r| r.get(0),
                )
                .optional()?)
            })?;
            return Ok(self.current(project.map(project_of).as_ref()));
        };
        let mut set = self.current(project_id.map(project_of).as_ref());
        let refs: Vec<SessionPromptRef> = serde_json::from_str(&refs)?;
        set.instructions.clear();
        for r in refs {
            let Some(text) = self.version(r.r#ref.as_str())? else {
                continue;
            };
            let resolved = Resolved {
                r#ref: r.r#ref.into_inner(),
                scope: r.scope,
                text: Arc::from(text),
            };
            if r.id.as_str() == INSTRUCTIONS {
                set.instructions.push(resolved);
            } else if let Some(e) = registry::get(r.id.as_str()) {
                set.entries.insert(e.id, resolved);
            }
        }
        Ok(set)
    }

    /// The texts for a wake to the project's lead: its session's, or the current ones when it has none.
    pub fn for_lead(&self, project: &ProjectRef) -> PromptSet {
        let thread: Result<Option<String>, StoreError> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT thread_id FROM leads WHERE machine_id = ? AND project_id = ?",
                params![project.machine_id.as_str(), project.project_id.as_str()],
                |r| r.get(0),
            )
            .optional()?)
        });
        match thread {
            Ok(Some(thread)) => self.for_thread(&project.machine_id, &thread),
            _ => self.current(Some(project)),
        }
    }

    /// The texts for a message to a task's thread (`T<n>`).
    pub fn for_task(&self, project: &ProjectRef, task_id: &str) -> PromptSet {
        let n: i64 = task_id.get(1..).and_then(|n| n.parse().ok()).unwrap_or(0);
        let thread: Result<Option<String>, StoreError> = self.db.with(|c| {
            Ok(
                c.query_row("SELECT thread_id FROM tasks WHERE n = ?", [n], |r| {
                    r.get::<_, Option<String>>(0)
                })
                .optional()?
                .flatten(),
            )
        });
        match thread {
            Ok(Some(thread)) => self.for_thread(&project.machine_id, &thread),
            _ => self.current(Some(project)),
        }
    }

    fn version(&self, r: &str) -> Result<Option<String>, StoreError> {
        self.db.with(|c| {
            Ok(c.query_row(
                "SELECT text FROM prompt_versions WHERE ref = ?",
                [r],
                |row| row.get(0),
            )
            .optional()?)
        })
    }

    fn keep(&self, versions: &[(String, &str)]) -> Result<(), StoreError> {
        self.db.transaction(|c| {
            let mut insert = c.prepare_cached(
                "INSERT OR IGNORE INTO prompt_versions (ref, text) VALUES (?, ?)",
            )?;
            for (r, text) in versions {
                insert.execute(params![r, text])?;
            }
            Ok(())
        })
    }

    /// Keeps every shipped text, so an override edited from an older release can still be compared with its base.
    pub fn keep_defaults(&self) -> Result<(), StoreError> {
        let versions: Vec<(String, &str)> = ENTRIES
            .iter()
            .map(|e| (ref_of(e.id, e.default), e.default))
            .collect();
        self.keep(&versions)
    }

    /// Records what a session started with: `text`, its exact first message, and the ref of every prompt it may
    /// receive. Returns the text's SHA.
    pub fn pin(
        &self,
        set: &PromptSet,
        audience: Audience,
        project: &ProjectRef,
        thread_id: &ThreadId,
        at: &Timestamp,
        text: &str,
    ) -> Result<String, StoreError> {
        let refs = set.refs(audience);
        let versions: Vec<(String, &str)> = refs
            .iter()
            .map(|(r, text)| (r.r#ref.as_str().to_owned(), &**text))
            .collect();
        self.keep(&versions)?;
        let sha = git_blob_sha(text.as_bytes());
        let refs_json =
            serde_json::to_string(&refs.into_iter().map(|(r, _)| r).collect::<Vec<_>>())?;
        self.db.with(|c| {
            c.execute(
                "INSERT OR REPLACE INTO session_prompts (machine_id, thread_id, project_id, started_at, refs, text_sha, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![
                    project.machine_id.as_str(),
                    thread_id.as_str(),
                    project.project_id.as_str(),
                    at.as_str(),
                    refs_json,
                    sha,
                    text
                ],
            )?;
            Ok(())
        })?;
        Ok(sha)
    }

    pub fn session(
        &self,
        machine_id: &MachineId,
        thread_id: &ThreadId,
    ) -> Result<Option<SessionPrompt>, StoreError> {
        type Row = (Option<String>, String, String, String, String);
        let row: Option<Row> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT project_id, started_at, refs, text_sha, text FROM session_prompts WHERE machine_id = ? AND thread_id = ?",
                params![machine_id.as_str(), thread_id.as_str()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?)
        })?;
        let Some((project_id, started_at, refs, text_sha, text)) = row else {
            return Ok(None);
        };
        Ok(Some(SessionPrompt {
            machine_id: machine_id.clone(),
            thread_id: thread_id.clone(),
            project_ref: project_id.map(|p| ProjectRef {
                machine_id: machine_id.clone(),
                project_id: ProjectId::unchecked(p),
            }),
            started_at: Timestamp(started_at),
            text,
            text_sha,
            refs: serde_json::from_str(&refs)?,
            disallowed_tools: crate::node::runner::claude::ALWAYS_DISALLOWED
                .iter()
                .map(|t| (*t).to_owned())
                .collect(),
        }))
    }

    /// Saves an override (`scope` global or project) and keeps its text. `base` is the default it was edited from;
    /// absent means the one shipped now. Returns its ref.
    pub fn save(
        &self,
        e: &Entry,
        scope: PromptScope,
        project: Option<&ProjectRef>,
        text: &str,
        base: Option<&str>,
    ) -> Result<String, PromptError> {
        let level = self.level(e, scope, project)?;
        if text.trim().is_empty() && e.id != INSTRUCTIONS {
            return Err(PromptError::Invalid(
                "The text is empty; reset the prompt to go back to the shipped one.".into(),
            ));
        }
        let file = self.file(e, level).ok_or_else(|| {
            PromptError::Invalid("This hub keeps no prompt files (an in-memory database).".into())
        })?;
        if let Some(name) = e.playbook() {
            parse_playbook(text, &file.display().to_string(), Some(name))
                .map_err(|err| PromptError::Invalid(err.message))?;
            write_atomic(&file, text)?;
        } else {
            let base = base.map_or_else(|| ref_of(e.id, e.default), str::to_owned);
            write_atomic(&file, &format!("---\nbase: {base}\n---\n{text}"))?;
        }
        let r = ref_of(e.id, text);
        self.keep(&[(r.clone(), text)])?;
        Ok(r)
    }

    /// `prompt_set`: what the edit may break, then the edit saved anyway (warnings never block). Returns the ref.
    pub fn set(
        &self,
        e: &Entry,
        scope: PromptScope,
        project: Option<&ProjectRef>,
        text: &str,
        base: Option<&str>,
    ) -> Result<(String, Vec<PromptWarning>), PromptError> {
        let found = warnings(e, text);
        Ok((self.save(e, scope, project, text, base)?, found))
    }

    /// Removes the override at this level; the next level down is in effect again.
    pub fn reset(
        &self,
        e: &Entry,
        scope: PromptScope,
        project: Option<&ProjectRef>,
    ) -> Result<(), PromptError> {
        let level = self.level(e, scope, project)?;
        if let Some(file) = self.file(e, level) {
            match std::fs::remove_file(file) {
                Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.into()),
                _ => {}
            }
        }
        Ok(())
    }

    fn level<'p>(
        &self,
        e: &Entry,
        scope: PromptScope,
        project: Option<&'p ProjectRef>,
    ) -> Result<Option<&'p ProjectRef>, PromptError> {
        match scope {
            PromptScope::Default => Err(PromptError::Invalid(
                "The shipped text cannot change; save a global or project override.".into(),
            )),
            PromptScope::Global => Ok(None),
            PromptScope::Project if !e.per_project() => Err(PromptError::Invalid(format!(
                "{} has one hub-wide text; save it with scope global.",
                e.id
            ))),
            PromptScope::Project => project
                .map(Some)
                .ok_or_else(|| PromptError::Invalid("A project override needs projectRef.".into())),
        }
    }

    /// Whether an override edited from `base` is still up to date with the default shipped now. A default that
    /// changed only in whitespace (texts reflowed from hard-wrapped lines into paragraphs) is the same default.
    fn base_current(&self, e: &Entry, base: Option<&str>) -> bool {
        let Some(base) = base else { return false };
        base == ref_of(e.id, e.default)
            || self
                .version(base)
                .ok()
                .flatten()
                .is_some_and(|text| same_words(&text, e.default))
    }

    fn stale_of(&self, e: &Entry, scope: PromptScope, o: &Override) -> Option<StalePrompt> {
        if e.playbook().is_some() || self.base_current(e, o.base.as_deref()) {
            return None;
        }
        let current = ref_of(e.id, e.default);
        let base = o.base.as_ref().and_then(|b| {
            self.version(b).ok().flatten().map(|text| PromptVersion {
                r#ref: PromptRef::unchecked(b.clone()),
                text,
            })
        });
        let (merged, conflicts) = merge(
            base.as_ref().map_or("", |b| b.text.as_str()),
            e.default,
            &o.text,
        );
        Some(StalePrompt {
            scope,
            base,
            current: PromptVersion {
                r#ref: PromptRef::unchecked(current),
                text: e.default.to_owned(),
            },
            yours: PromptVersion {
                r#ref: PromptRef::unchecked(ref_of(e.id, &o.text)),
                text: o.text.clone(),
            },
            merged,
            conflicts,
        })
    }

    pub fn list(&self, project: Option<&ProjectRef>) -> Vec<PromptSummary> {
        ENTRIES
            .iter()
            .map(|e| {
                let found = self.effective_override(e, project);
                PromptSummary {
                    id: PromptId::unchecked(e.id),
                    title: e.title.into(),
                    kind: e.kind,
                    group: e.group,
                    sent_when: e.sent_when.into(),
                    scope: found.as_ref().map_or(PromptScope::Default, |(s, _)| *s),
                    default_ref: PromptRef::unchecked(ref_of(e.id, e.default)),
                    override_ref: found
                        .as_ref()
                        .map(|(_, o)| PromptRef::unchecked(ref_of(e.id, &o.text))),
                    stale: found.is_some_and(|(s, o)| self.stale_of(e, s, &o).is_some()),
                }
            })
            .collect()
    }

    pub fn detail(&self, e: &Entry, project: Option<&ProjectRef>) -> PromptDetail {
        let global = self.override_of(e, None);
        let local = project.and_then(|p| self.override_of(e, Some(p)));
        let (scope, mine) = match (&local, &global) {
            (Some(o), _) => (PromptScope::Project, Some(o)),
            (None, Some(o)) => (PromptScope::Global, Some(o)),
            _ => (PromptScope::Default, None),
        };
        let effective = mine.map_or_else(|| e.default.to_owned(), |o| o.text.clone());
        let stale = mine.and_then(|o| self.stale_of(e, scope, o));
        PromptDetail {
            id: PromptId::unchecked(e.id),
            title: e.title.into(),
            kind: e.kind,
            group: e.group,
            sent_when: e.sent_when.into(),
            per_project: e.per_project(),
            default: PromptVersion {
                r#ref: PromptRef::unchecked(ref_of(e.id, e.default)),
                text: e.default.to_owned(),
            },
            global: global.as_ref().map(|o| o.version(e.id)),
            project: local.as_ref().map(|o| o.version(e.id)),
            scope,
            placeholders: e.placeholders(),
            safety_rules: e
                .safety_rules()
                .into_iter()
                .map(|mut r| {
                    r.present = Some(rule_present(&r.needle, &effective));
                    r
                })
                .collect(),
            warnings: if mine.is_some() {
                warnings(e, &effective)
            } else {
                Vec::new()
            },
            effective: PromptVersion {
                r#ref: PromptRef::unchecked(ref_of(e.id, &effective)),
                text: effective,
            },
            stale,
        }
    }

    /// Every override edited from an older default than the one shipped now.
    pub fn stale(&self) -> Vec<StaleOverride> {
        let mut levels: Vec<Option<ProjectRef>> = vec![None];
        let known: Result<Vec<(String, String)>, StoreError> = self.db.with(|c| {
            let mut rows = c.prepare("SELECT machine_id, project_id FROM projects")?;
            let rows = rows
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        });
        for (machine, project) in known.unwrap_or_default() {
            if let Ok(machine_id) = MachineId::new(machine) {
                levels.push(Some(ProjectRef {
                    machine_id,
                    project_id: ProjectId::unchecked(project),
                }));
            }
        }
        let mut out = Vec::new();
        for project in levels {
            for e in ENTRIES.iter().filter(|e| e.playbook().is_none()) {
                if let Some(o) = self.override_of(e, project.as_ref())
                    && !self.base_current(e, o.base.as_deref())
                {
                    out.push(StaleOverride {
                        entry: e,
                        project: project.clone(),
                        base: o.base,
                    });
                }
            }
        }
        out
    }
}

/// A project's override directory: a hash of its ref, never the ids themselves. A project id is whatever a node
/// reports, so as a path component `../..` would land on the hub-wide overrides or anywhere else.
fn project_key(p: &ProjectRef) -> String {
    let digest = Sha256::digest(format!("{}\0{}", p.machine_id, p.project_id).as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}
