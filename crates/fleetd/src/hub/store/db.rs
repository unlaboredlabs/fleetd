use super::migrations::{self, Drift, MIGRATIONS};
use rusqlite::{Connection, TransactionBehavior};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("stored json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// The hub's SQLite database. HubStore, EventLog, Auth and the areas with tables share this one connection.
pub struct HubDb {
    conn: Mutex<Connection>,
    /// `<home>/prompts`, where prompt overrides live; None for an in-memory database, which has the shipped prompts only.
    prompts_dir: Option<PathBuf>,
    /// `<home>/memory`, the leads' memory (`hub::memory`); set by `open`, or by the hub built over an in-memory one.
    memory_dir: OnceLock<PathBuf>,
    /// `<home>/skills`, the skills the hub keeps (`hub::skills`); set like `memory_dir`.
    skills_dir: OnceLock<PathBuf>,
}

impl HubDb {
    /// Opens (creating if needed) `<home>/hub.sqlite` in WAL mode and migrates it. `home` must come from
    /// `resolve_hub_home`.
    pub fn open(home: &Path) -> Result<Arc<Self>, StoreError> {
        let mut dir = std::fs::DirBuilder::new();
        dir.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut dir, 0o700);
        dir.create(home)?;
        let db = Self::from_connection(
            Connection::open(home.join("hub.sqlite"))?,
            Some(home.join("prompts")),
        )?;
        db.set_memory_dir(home.join("memory"));
        db.set_skills_dir(home.join("skills"));
        Ok(db)
    }

    /// A private in-memory database, for tests.
    #[cfg(test)]
    pub fn open_memory() -> Result<Arc<Self>, StoreError> {
        Self::from_connection(Connection::open_in_memory()?, None)
    }

    fn from_connection(
        conn: Connection,
        prompts_dir: Option<PathBuf>,
    ) -> Result<Arc<Self>, StoreError> {
        // Lets the CLI write keys while the hub runs; a writer waits up to 5 s for the other's lock.
        conn.execute_batch("PRAGMA busy_timeout = 5000")?;
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        conn.execute_batch("PRAGMA synchronous = NORMAL")?;
        let db = Self {
            conn: Mutex::new(conn),
            prompts_dir,
            memory_dir: OnceLock::new(),
            skills_dir: OnceLock::new(),
        };
        db.migrate()?;
        Ok(Arc::new(db))
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs `f` on the connection, outside any explicit transaction.
    pub fn with<R>(
        &self,
        f: impl FnOnce(&Connection) -> Result<R, StoreError>,
    ) -> Result<R, StoreError> {
        f(&self.lock())
    }

    /// Runs `f` in a write transaction (`BEGIN IMMEDIATE`), so a concurrent writer (the CLI next to a running hub)
    /// waits instead of interleaving. Rolls back when `f` fails.
    pub fn transaction<R>(
        &self,
        f: impl FnOnce(&Connection) -> Result<R, StoreError>,
    ) -> Result<R, StoreError> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn prompts_dir(&self) -> Option<&Path> {
        self.prompts_dir.as_deref()
    }

    pub fn memory_dir(&self) -> Option<&Path> {
        self.memory_dir.get().map(PathBuf::as_path)
    }

    /// The first one set stays.
    pub fn set_memory_dir(&self, dir: PathBuf) {
        let _ = self.memory_dir.set(dir);
    }

    pub fn skills_dir(&self) -> Option<&Path> {
        self.skills_dir.get().map(PathBuf::as_path)
    }

    /// The first one set stays.
    pub fn set_skills_dir(&self, dir: PathBuf) {
        let _ = self.skills_dir.set(dir);
    }

    pub fn user_version(&self) -> Result<i64, StoreError> {
        self.with(|conn| Ok(migrations::user_version(conn)?))
    }

    fn migrate(&self) -> Result<(), StoreError> {
        // Never fatal: re-running a changed migration could break a hub's data, and refusing to start would take the
        // whole hub down over SQL its operator can't change. The warning names the file.
        for drift in migrations::migrate(&mut self.lock(), MIGRATIONS)? {
            match drift {
                Drift::Changed(name) => tracing::warn!(
                    migration = name,
                    "hub migrations: this migration changed after it ran here; it does not run again, so the database may lack what the new file adds"
                ),
                Drift::Unknown(name) => tracing::warn!(
                    migration = name,
                    "hub migrations: this database ran a migration this fleetd doesn't have (a newer fleetd's, or one removed)"
                ),
            }
        }
        Ok(())
    }
}

/// `path.resolve`: absolute against the cwd, with `.` and `..` folded lexically.
fn resolve(p: &Path) -> PathBuf {
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(p)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Resolves `--home` (default `<fleetd dir>/hub`, `~` expanded).
pub fn resolve_hub_home(home: Option<&str>, user_home: &Path) -> PathBuf {
    match home {
        None => crate::home::fleetd_dir().join("hub"),
        Some(raw) => expand_home(raw, user_home),
    }
}

/// A directory as given on a command line or in the environment: `~` expanded, absolute against the cwd.
pub fn expand_home(raw: &str, user_home: &Path) -> PathBuf {
    let expanded = match raw {
        "~" => user_home.to_path_buf(),
        _ => match raw.strip_prefix("~/") {
            Some(rest) => user_home.join(rest),
            None => PathBuf::from(raw),
        },
    };
    resolve(&expanded)
}
