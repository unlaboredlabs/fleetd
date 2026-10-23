//! The playbooks a workstream can follow: fleetd's bundled ones with the user's overrides in `<hub home>/playbooks/`.
//! A workstream pins `name@sha` at creation and the pinned text is kept (table `playbook_versions`), so a later edit of
//! the file never changes the rules of a workstream already under way.
pub mod budget;
pub mod floor;
pub mod load;
pub mod research;
pub mod verdict;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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

    /// The current version of `name`; new workstreams pin this one. Read from disk each time, so an override saved
    /// with prompt_set or `fleetd prompts edit` applies at once; one that no longer parses leaves the last good one.
    pub fn current(&self, name: PlaybookName) -> LoadedPlaybook {
        match load::load_all(self.overrides_dir.as_deref()) {
            Ok(all) => *self.current.lock().unwrap() = all,
            Err(error) => {
                tracing::warn!(%error, "playbook overrides unreadable; keeping the last good ones")
            }
        }
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
}
