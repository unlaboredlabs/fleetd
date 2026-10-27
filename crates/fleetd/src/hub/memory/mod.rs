//! What the leads remember: plain markdown under `<hub home>/memory`, in no repo. `user.md` is shared by every
//! project; `<machine>/<project>/MEMORY.md` (the always-on part, then one `- [topic](topic.md)` line per topic) and
//! its topic files belong to one project and are never read for another. The hub is the only writer: a lead's
//! `remember` or `forget` (`calls`; the nightly `refresh` makes them too) or a person's edit in the app (`tools`), one
//! write at a time. A write past a cap is refused, never truncated, so the lead merges entries in that turn.
pub mod calls;
pub mod refresh;
pub mod tools;

#[cfg(test)]
mod refresh_tests;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::memory::{
    FileCap, ForgetCall, MemoryCaps, MemoryEntry, MemoryFile, MemoryNote, MemoryScope, MemoryTopic,
    ProjectCap, RememberCall, RememberedItem,
};
use fleetd_contracts::prim::{Count, List, Text};
use sha2::{Digest, Sha256};

use crate::hub::store::{HubDb, StoreError, iso_ms, system_ms};

pub const USER_FILE: &str = "user.md";
pub const INDEX_FILE: &str = "MEMORY.md";

/// Serialises every write, from any caller.
static WRITE: Mutex<()> = Mutex::new(());

#[derive(Debug)]
pub struct MemoryError {
    pub code: ErrorCode,
    pub message: String,
    pub fix: Option<String>,
}

impl MemoryError {
    fn new(code: ErrorCode, message: impl Into<String>, fix: Option<&str>) -> Self {
        Self {
            code,
            message: message.into(),
            fix: fix.map(str::to_owned),
        }
    }
}

impl From<std::io::Error> for MemoryError {
    fn from(e: std::io::Error) -> Self {
        Self::new(
            ErrorCode::Failed,
            format!("cannot write the memory file: {e}"),
            None,
        )
    }
}

impl From<StoreError> for MemoryError {
    fn from(e: StoreError) -> Self {
        Self::new(ErrorCode::Failed, e.to_string(), None)
    }
}

/// One memory file: `user.md`, a project's `MEMORY.md` (no topic) or one of its topics.
#[derive(Clone, Debug, PartialEq)]
pub struct Target<'a> {
    pub project: Option<&'a ProjectRef>,
    pub topic: Option<&'a MemoryTopic>,
}

impl Target<'_> {
    pub fn scope(&self) -> MemoryScope {
        if self.project.is_some() {
            MemoryScope::Project
        } else {
            MemoryScope::User
        }
    }

    pub fn name(&self) -> String {
        match (self.project, self.topic) {
            (None, _) => USER_FILE.into(),
            (Some(_), None) => INDEX_FILE.into(),
            (Some(_), Some(t)) => format!("{t}.md"),
        }
    }
}

/// The memory of one hub, over `<home>/memory`; a hub without a home keeps none.
pub struct Memory<'a> {
    dir: Option<&'a Path>,
    caps: MemoryCaps,
}

impl HubDb {
    pub fn memory(&self) -> Memory<'_> {
        Memory {
            dir: self.memory_dir(),
            caps: self.memory_caps().unwrap_or_default(),
        }
    }

    /// The caps a hub admin set; each one not set has its default.
    pub fn memory_caps(&self) -> Result<MemoryCaps, StoreError> {
        let set: Vec<(String, i64)> = self.with(|c| {
            let mut stmt = c.prepare_cached("SELECT key, value FROM memory_settings")?;
            Ok(stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?)
        })?;
        let mut caps = MemoryCaps::default();
        for (key, value) in set {
            match key.as_str() {
                "user" => caps.user = FileCap::new(value).unwrap_or(caps.user),
                "index" => caps.index = FileCap::new(value).unwrap_or(caps.index),
                "topic" => caps.topic = FileCap::new(value).unwrap_or(caps.topic),
                "project" => caps.project = ProjectCap::new(value).unwrap_or(caps.project),
                _ => {}
            }
        }
        Ok(caps)
    }

    pub fn set_memory_caps(&self, caps: &MemoryCaps) -> Result<(), StoreError> {
        self.transaction(|c| {
            for (key, value) in [
                ("user", caps.user.get()),
                ("index", caps.index.get()),
                ("topic", caps.topic.get()),
                ("project", caps.project.get()),
            ] {
                c.execute(
                    "INSERT INTO memory_settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    rusqlite::params![key, value],
                )?;
            }
            Ok(())
        })
    }
}

/// A project's directory name: its id when that is a plain file name, else a hash of it.
pub fn project_dir_name(r: &ProjectRef) -> String {
    let id = r.project_id.as_str();
    let plain = id.len() <= 128
        && !id.starts_with('.')
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if plain {
        return id.to_owned();
    }
    let digest = Sha256::digest(id.as_bytes());
    format!("p-{}", hex(&digest[..8]))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn entry_line(text: &str) -> String {
    format!("- {text}")
}

fn index_line(topic: &MemoryTopic) -> String {
    format!("- [{topic}]({topic}.md)")
}

fn is_index_line(line: &str) -> bool {
    line.starts_with("- [") && line.trim_end().ends_with(".md)")
}

fn chars(text: &str) -> usize {
    text.chars().count()
}

fn lines_of(text: &str) -> Vec<String> {
    text.lines().map(str::to_owned).collect()
}

fn join(lines: &[String]) -> String {
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let dir = path.parent().expect("a memory file has a directory");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)?;
    let tmp = path.with_extension("md.tmp");
    {
        let mut open = std::fs::OpenOptions::new();
        open.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut open, 0o600);
        std::io::Write::write_all(&mut open.open(&tmp)?, text.as_bytes())?;
    }
    std::fs::rename(&tmp, path)
}

fn secret_refusal(text: &str) -> Result<(), MemoryError> {
    if crate::hub::redact::redact(text) != text {
        return Err(MemoryError::new(
            ErrorCode::Invalid,
            "That looks like a secret, and memory never holds one.",
            Some("Leave the value out; a secret goes through request_secret."),
        ));
    }
    Ok(())
}

impl Memory<'_> {
    pub fn caps(&self) -> &MemoryCaps {
        &self.caps
    }

    /// The cap of file `t`.
    pub fn cap(&self, t: &Target<'_>) -> usize {
        let cap = match (t.project, t.topic) {
            (None, _) => self.caps.user,
            (Some(_), None) => self.caps.index,
            (Some(_), Some(_)) => self.caps.topic,
        };
        cap.get() as usize
    }

    fn project_cap(&self) -> usize {
        self.caps.project.get() as usize
    }

    fn root(&self) -> Result<&Path, MemoryError> {
        self.dir.ok_or_else(|| {
            MemoryError::new(
                ErrorCode::Failed,
                "This hub has no home to keep memory in.",
                None,
            )
        })
    }

    fn project_dir(&self, r: &ProjectRef) -> Option<PathBuf> {
        Some(
            self.dir?
                .join(r.machine_id.as_str())
                .join(project_dir_name(r)),
        )
    }

    pub fn path(&self, t: &Target<'_>) -> Option<PathBuf> {
        match t.project {
            None => Some(self.dir?.join(USER_FILE)),
            Some(r) => Some(self.project_dir(r)?.join(t.name())),
        }
    }

    /// The file's text; empty when there is none.
    pub fn read(&self, t: &Target<'_>) -> String {
        self.path(t)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_default()
    }

    fn updated_at(&self, t: &Target<'_>) -> Option<Timestamp> {
        let modified = std::fs::metadata(self.path(t)?).ok()?.modified().ok()?;
        Some(iso_ms(system_ms(modified)).into())
    }

    /// A project's topics, by name.
    pub fn topics(&self, r: &ProjectRef) -> Vec<MemoryTopic> {
        let Some(dir) = self.project_dir(r) else {
            return Vec::new();
        };
        let mut topics: Vec<MemoryTopic> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                MemoryTopic::new(name.strip_suffix(".md")?).ok()
            })
            .collect();
        topics.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        topics
    }

    /// Every file of the project, MEMORY.md included, together.
    pub fn project_chars(&self, r: &ProjectRef) -> usize {
        let index = chars(&self.read(&Target {
            project: Some(r),
            topic: None,
        }));
        index
            + self
                .topics(r)
                .iter()
                .map(|t| {
                    chars(&self.read(&Target {
                        project: Some(r),
                        topic: Some(t),
                    }))
                })
                .sum::<usize>()
    }

    /// Writes `text` to `t`, or deletes the file when it is empty, after the secret and cap checks.
    fn put(&self, t: &Target<'_>, text: &str) -> Result<(), MemoryError> {
        self.root()?;
        secret_refusal(text)?;
        let (len, cap) = (chars(text), self.cap(t));
        if len > cap {
            return Err(MemoryError::new(
                ErrorCode::Invalid,
                format!(
                    "{} would be {len} characters, past its cap of {cap}. Nothing was written.",
                    t.name()
                ),
                Some(
                    "Merge or replace: fold this into an entry it overlaps (remember with replaces), or drop one that no longer holds.",
                ),
            ));
        }
        if let Some(r) = t.project {
            let total = self.project_chars(r) - chars(&self.read(t)) + len;
            let cap = self.project_cap();
            if total > cap {
                return Err(MemoryError::new(
                    ErrorCode::Invalid,
                    format!(
                        "This project's memory would be {total} characters, past its cap of {cap}. Nothing was written."
                    ),
                    Some(
                        "Merge or replace: fold topics together, or drop entries that no longer hold.",
                    ),
                ));
            }
        }
        let path = self.path(t).expect("a hub with a home has paths");
        if text.trim().is_empty() {
            match std::fs::remove_file(&path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            }
        } else {
            write_atomic(&path, text)?;
        }
        Ok(())
    }

    /// A project's index with the line for `topic` added (`present`) or dropped.
    fn index_with(&self, r: &ProjectRef, topic: &MemoryTopic, present: bool) -> Option<String> {
        let index = Target {
            project: Some(r),
            topic: None,
        };
        let mut lines = lines_of(&self.read(&index));
        let link = format!("({topic}.md)");
        let has = lines.iter().any(|l| is_index_line(l) && l.contains(&link));
        match (present, has) {
            (true, false) => lines.push(index_line(topic)),
            (false, true) => lines.retain(|l| !(is_index_line(l) && l.contains(&link))),
            _ => return None,
        }
        Some(join(&lines))
    }

    /// A lead's `remember` in project `r`: the entry appended, or put in place of the one that contains `replaces`.
    /// None when the file already says exactly that.
    pub fn remember<'c>(
        &self,
        r: &'c ProjectRef,
        call: &'c RememberCall,
    ) -> Result<(Target<'c>, Option<RememberedItem>, usize), MemoryError> {
        let _write = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        self.remember_locked(r, call)
    }

    fn remember_locked<'c>(
        &self,
        r: &'c ProjectRef,
        call: &'c RememberCall,
    ) -> Result<(Target<'c>, Option<RememberedItem>, usize), MemoryError> {
        self.root()?;
        let t = Target {
            project: (call.scope == MemoryScope::Project).then_some(r),
            topic: call.topic.as_ref(),
        };
        let mut lines = lines_of(&self.read(&t));
        let line = entry_line(call.text.as_str());
        if lines.iter().any(|l| l.trim_end() == line) {
            let len = chars(&join(&lines));
            return Ok((t, None, len));
        }
        let mut replaced = None;
        match &call.replaces {
            Some(old) => {
                let i = one_entry(&t, &lines, old.as_str())?;
                let old_line = lines[i].trim_start_matches("- ").to_owned();
                replaced = MemoryEntry::new(old_line).ok();
                lines[i] = line;
            }
            // Entries go above the topic index, so MEMORY.md keeps its always-on part first.
            None => match lines.iter().position(|l| is_index_line(l)) {
                Some(i) if t.topic.is_none() => lines.insert(i, line),
                _ => lines.push(line),
            },
        }
        let text = join(&lines);
        // The index line is in the cap check of the topic write: both go, or neither.
        let index = match (t.project, t.topic) {
            (Some(r), Some(topic)) => self.index_with(r, topic, true),
            _ => None,
        };
        if let (Some(index), Some(r)) = (&index, t.project) {
            let it = Target {
                project: Some(r),
                topic: None,
            };
            let room = self.project_cap().saturating_sub(
                self.project_chars(r) - chars(&self.read(&t)) - chars(&self.read(&it)),
            );
            if chars(index) > self.cap(&it) || chars(index) + chars(&text) > room {
                return Err(MemoryError::new(
                    ErrorCode::Invalid,
                    "This project's memory is at its cap. Nothing was written.",
                    Some(
                        "Merge or replace: fold topics together, or drop entries that no longer hold.",
                    ),
                ));
            }
        }
        self.put(&t, &text)?;
        if let (Some(index), Some(r)) = (index, t.project) {
            self.put(
                &Target {
                    project: Some(r),
                    topic: None,
                },
                &index,
            )?;
        }
        let item = RememberedItem {
            scope: call.scope,
            topic: call.topic.clone(),
            text: call.text.clone(),
            replaced,
            forgotten: None,
            reason: None,
            undone: None,
        };
        Ok((t, Some(item), chars(&text)))
    }

    /// A lead's `forget` in project `r`: the one entry that contains `call.entry` goes. A topic left empty goes with
    /// its index line.
    pub fn forget<'c>(
        &self,
        r: &'c ProjectRef,
        call: &'c ForgetCall,
    ) -> Result<(Target<'c>, RememberedItem, usize), MemoryError> {
        let _write = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        self.root()?;
        let t = Target {
            project: (call.scope == MemoryScope::Project).then_some(r),
            topic: call.topic.as_ref(),
        };
        let mut lines = lines_of(&self.read(&t));
        let i = one_entry(&t, &lines, call.entry.as_str())?;
        let whole = lines[i].trim_start_matches("- ").trim_end().to_owned();
        let Ok(text) = MemoryEntry::new(whole) else {
            return Err(MemoryError::new(
                ErrorCode::Invalid,
                format!(
                    "That line of {} is not one entry of at most 1,000 characters.",
                    t.name()
                ),
                Some("Leave it, or merge it into a shorter entry with remember and replaces."),
            ));
        };
        lines.remove(i);
        let text_now = join(&lines);
        self.put_dropping_empty_topic(&t, &text_now)?;
        let item = RememberedItem {
            scope: call.scope,
            topic: call.topic.clone(),
            text,
            replaced: None,
            forgotten: Some(true),
            reason: call.reason.clone(),
            undone: None,
        };
        Ok((t, item, chars(&text_now)))
    }

    /// Writes `text` to `t`; a topic left empty goes with its index line.
    fn put_dropping_empty_topic(&self, t: &Target<'_>, text: &str) -> Result<(), MemoryError> {
        self.put(t, text)?;
        if let (Some(r), Some(topic)) = (t.project, t.topic)
            && text.trim().is_empty()
            && let Some(index) = self.index_with(r, topic, false)
        {
            self.put(
                &Target {
                    project: Some(r),
                    topic: None,
                },
                &index,
            )?;
        }
        Ok(())
    }

    /// Takes back what `item` wrote in project `r`: its entry goes, and the one it replaced comes back; a forgotten
    /// entry comes back. A topic left empty goes with its index line.
    pub fn undo(&self, r: &ProjectRef, item: &RememberedItem) -> Result<(), MemoryError> {
        let _write = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        if item.forgotten == Some(true) {
            let call = RememberCall {
                scope: item.scope,
                topic: item.topic.clone(),
                text: item.text.clone(),
                replaces: None,
            };
            self.remember_locked(r, &call)?;
            return Ok(());
        }
        let t = Target {
            project: (item.scope == MemoryScope::Project).then_some(r),
            topic: item.topic.as_ref(),
        };
        let mut lines = lines_of(&self.read(&t));
        let line = entry_line(item.text.as_str());
        let Some(i) = lines.iter().position(|l| l.trim_end() == line) else {
            return Err(MemoryError::new(
                ErrorCode::Invalid,
                format!(
                    "{} no longer has that entry; it was changed since.",
                    t.name()
                ),
                Some("Edit it in Settings > Memory."),
            ));
        };
        match &item.replaced {
            Some(old) => lines[i] = entry_line(old.as_str()),
            None => {
                lines.remove(i);
            }
        }
        self.put_dropping_empty_topic(&t, &join(&lines))
    }

    /// A person's edit in the app: the whole file. Empty deletes it, and a topic's index line with it.
    pub fn set(&self, t: &Target<'_>, text: &str) -> Result<(), MemoryError> {
        let _write = WRITE.lock().unwrap_or_else(|p| p.into_inner());
        self.put(t, text)?;
        if let (Some(r), Some(topic)) = (t.project, t.topic)
            && let Some(index) = self.index_with(r, topic, !text.trim().is_empty())
        {
            self.put(
                &Target {
                    project: Some(r),
                    topic: None,
                },
                &index,
            )?;
        }
        Ok(())
    }

    /// The file as the app shows it, with the notes of the entries `remember` wrote that are still in it.
    pub fn file(&self, db: &HubDb, t: &Target<'_>) -> Result<MemoryFile, MemoryError> {
        let text = self.read(t);
        let notes = notes(db, t)?
            .into_iter()
            .filter(|n| {
                text.lines()
                    .any(|l| l.trim_end() == entry_line(n.text.as_str()))
            })
            .collect();
        Ok(MemoryFile {
            scope: t.scope(),
            topic: t.topic.cloned(),
            chars: Count::unchecked(chars(&text) as i64),
            cap: Count::unchecked(self.cap(t) as i64),
            text: Text::unchecked(text),
            updated_at: self.updated_at(t),
            notes: List::unchecked(notes),
        })
    }

    /// What a session of project `r` starts with: `user.md`, then the project's `MEMORY.md`. Empty when both are.
    /// A lead is told how to open the topics.
    pub fn injected(&self, r: &ProjectRef, lead: bool) -> String {
        let user = self.read(&Target {
            project: None,
            topic: None,
        });
        let project = self.read(&Target {
            project: Some(r),
            topic: None,
        });
        if user.trim().is_empty() && project.trim().is_empty() {
            return String::new();
        }
        let mut out = String::from("## Memory\n");
        out.push_str(if lead {
            "What you remembered in earlier sessions, with `remember`. Open a topic with `memory_read`."
        } else {
            "What fleetd remembers about the human and this project. Follow it."
        });
        for (title, text) in [
            ("How the human works (user.md)", user),
            ("This project (MEMORY.md)", project),
        ] {
            if !text.trim().is_empty() {
                out.push_str(&format!("\n\n### {title}\n{}", text.trim_end()));
            }
        }
        out
    }
}

/// The one entry of `lines` (file `t`) that contains `words`: quoted words are an optimistic lock, so an entry
/// changed since it was read is refused rather than guessed at.
fn one_entry(t: &Target<'_>, lines: &[String], words: &str) -> Result<usize, MemoryError> {
    let hits: Vec<usize> = (0..lines.len())
        .filter(|&i| !is_index_line(&lines[i]) && lines[i].contains(words))
        .collect();
    let [i] = hits[..] else {
        let message = if hits.is_empty() {
            format!("No entry of {} contains \"{words}\".", t.name())
        } else {
            format!(
                "{} entries of {} contain \"{words}\".",
                hits.len(),
                t.name()
            )
        };
        return Err(MemoryError::new(
            ErrorCode::Invalid,
            message,
            Some("Quote words of exactly one entry as it reads now (memory_read for a topic)."),
        ));
    };
    Ok(i)
}

/// The remembered lines of the chats a file belongs to, and the nightly refresh's lines, newest first: every
/// project's for `user.md`, the project's own for its files.
fn notes(db: &HubDb, t: &Target<'_>) -> Result<Vec<MemoryNote>, MemoryError> {
    let rows: Vec<String> = db.with(|c| {
        let mut stmt = c.prepare_cached(
            "SELECT data FROM chat_messages \
             WHERE (json_type(data, '$.remembered') IS NOT NULL OR json_type(data, '$.memoryRefreshed') IS NOT NULL) \
             AND (?1 IS NULL OR (machine_id = ?1 AND project_id = ?2)) ORDER BY n DESC LIMIT 400",
        )?;
        let rows = stmt
            .query_map(
                rusqlite::params![
                    t.project.map(|r| r.machine_id.as_str()),
                    t.project.map(|r| r.project_id.as_str())
                ],
                |row| row.get(0),
            )?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    })?;
    let mut out = Vec::new();
    for data in rows {
        let Ok(m) = serde_json::from_str::<fleetd_contracts::chat::ChatMessage>(&data) else {
            continue;
        };
        let items = m
            .remembered
            .iter()
            .chain(m.memory_refreshed.iter().flat_map(|r| r.items.iter()));
        for item in items {
            if item.undone == Some(true)
                || item.forgotten == Some(true)
                || item.scope != t.scope()
                || item.topic.as_ref() != t.topic
            {
                continue;
            }
            if out.len() < 200 {
                out.push(MemoryNote {
                    text: item.text.clone(),
                    at: m.created_at.clone(),
                    project_ref: m.project_ref.clone(),
                    message_id: m.message_id.clone(),
                });
            }
        }
    }
    Ok(out)
}
