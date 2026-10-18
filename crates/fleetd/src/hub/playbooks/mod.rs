//! The playbooks a workstream can follow: fleetd's bundled ones with the user's overrides in `<hub home>/playbooks/`,
//! read at start and again when the retro writes an override. A workstream pins `name@sha` at creation and the pinned
//! text is kept (table `playbook_versions`), so a later edit of the file never changes the rules of a workstream
//! already under way.
pub mod finish_all;
pub mod finish_all_rules;
pub mod floor;
pub mod load;
pub mod research;
pub mod verdict;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub use finish_all::FinishAll;
use fleetd_contracts::ledger::{PlaybookName, PlaybookRef};
pub use fleetd_contracts::playbooks::Playbook;
pub use load::{LoadedPlaybook, PlaybookError};
pub use research::Research;
use rusqlite::{OptionalExtension, params};

use crate::hub::store::{HubDb, StoreError};

pub struct Playbooks {
    db: Arc<HubDb>,
    /// `<hub home>/playbooks`; None means the bundled playbooks only.
    overrides_dir: Option<PathBuf>,
    current: Mutex<BTreeMap<&'static str, LoadedPlaybook>>,
    cache: Mutex<HashMap<PlaybookRef, LoadedPlaybook>>,
}

impl Playbooks {
    /// Fails when a playbook file is invalid, naming the file and the problem.
    pub fn new(db: Arc<HubDb>, overrides_dir: Option<PathBuf>) -> Result<Arc<Self>, PlaybookError> {
        let current = load::load_all(overrides_dir.as_deref())?;
        let cache = current
            .values()
            .map(|p| (p.r#ref.clone(), p.clone()))
            .collect();
        Ok(Arc::new(Self {
            db,
            overrides_dir,
            current: Mutex::new(current),
            cache: Mutex::new(cache),
        }))
    }

    /// The current version of `name`; new workstreams pin this one.
    pub fn current(&self, name: PlaybookName) -> LoadedPlaybook {
        self.current.lock().unwrap()[name.as_str()].clone()
    }

    /// Records the current version of `name` as pinned and returns it.
    pub fn pin(&self, name: PlaybookName) -> Result<LoadedPlaybook, StoreError> {
        let loaded = self.current(name);
        self.db.with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO playbook_versions (ref, text) VALUES (?, ?)",
                params![loaded.r#ref.as_str(), loaded.text],
            )?;
            Ok(())
        })?;
        Ok(loaded)
    }

    /// A pinned version; None for a ref that was never pinned here.
    pub fn by_ref(&self, r: &PlaybookRef) -> Result<Option<LoadedPlaybook>, StoreError> {
        if let Some(cached) = self.cache.lock().unwrap().get(r) {
            return Ok(Some(cached.clone()));
        }
        let text: Option<String> = self.db.with(|c| {
            Ok(c.query_row(
                "SELECT text FROM playbook_versions WHERE ref = ?",
                params![r.as_str()],
                |row| row.get(0),
            )
            .optional()?)
        })?;
        let Some(text) = text else { return Ok(None) };
        match load::parse_playbook(&text, r.as_str(), None) {
            Ok(loaded) => {
                self.cache.lock().unwrap().insert(r.clone(), loaded.clone());
                Ok(Some(loaded))
            }
            Err(error) => {
                // Valid when pinned; only a later schema change can get here.
                tracing::warn!(r#ref = r.as_str(), %error, "pinned playbook no longer parses");
                Ok(None)
            }
        }
    }

    fn override_file(&self, name: PlaybookName) -> Option<PathBuf> {
        self.overrides_dir
            .as_ref()
            .map(|d| d.join(format!("{}.md", name.as_str())))
    }

    /// The text of `<overrides>/<name>.md`; None when the bundled playbook is in use.
    pub fn override_text(&self, name: PlaybookName) -> std::io::Result<Option<String>> {
        let Some(file) = self.override_file(name) else {
            return Ok(None);
        };
        match std::fs::read_to_string(file) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// M12: writes `<overrides>/<name>.md` (None removes it, back to the bundled one) and makes the result current.
    /// A text that does not parse is refused before anything is written.
    pub fn set_override(
        &self,
        name: PlaybookName,
        text: Option<&str>,
    ) -> Result<LoadedPlaybook, PlaybookError> {
        let Some(file) = self.override_file(name) else {
            return Err(PlaybookError {
                message: "this hub has no playbook overrides directory".into(),
            });
        };
        let io = |e: std::io::Error| PlaybookError {
            message: format!("cannot write {}: {e}", file.display()),
        };
        match text {
            None => match std::fs::remove_file(&file) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(io(e)),
                _ => {}
            },
            Some(text) => {
                load::parse_playbook(text, &file.display().to_string(), Some(name))?;
                let dir = file.parent().expect("an override file has a directory");
                let mut builder = std::fs::DirBuilder::new();
                builder.recursive(true);
                #[cfg(unix)]
                std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
                builder.create(dir).map_err(io)?;
                let tmp = file.with_extension("md.tmp");
                std::fs::write(&tmp, text).map_err(io)?;
                std::fs::rename(&tmp, &file).map_err(io)?;
            }
        }
        let all = load::load_all(self.overrides_dir.as_deref())?;
        let loaded = all[name.as_str()].clone();
        *self.current.lock().unwrap() = all;
        self.cache
            .lock()
            .unwrap()
            .insert(loaded.r#ref.clone(), loaded.clone());
        Ok(loaded)
    }
}
