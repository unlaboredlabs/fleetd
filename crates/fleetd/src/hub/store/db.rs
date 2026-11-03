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

/// The main connection's SQLite page cache, in KiB (a negative `cache_size`): SQLite's 2 MiB default sent reads of
/// the hot tables (tasks is about 8 MB) to the kernel again on every call. 16 MiB holds them.
const CACHE_KIB: i64 = 16 * 1024;

/// The hub's SQLite database. HubStore, EventLog, Auth and the areas with tables share this one connection.
pub struct HubDb {
    conn: Mutex<Connection>,
    /// `<home>/hub.sqlite`; None for an in-memory database.
    path: Option<PathBuf>,
    /// A read-only second connection to `path`, opened on the first `read`, for long reads (the time tools) that
    /// would otherwise hold `conn` for seconds; None when it can't open, and then `read` uses `conn`.
    reader: OnceLock<Option<Mutex<Connection>>>,
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
        let path = home.join("hub.sqlite");
        let db = Self::from_connection(
            Connection::open(&path)?,
            Some(path),
            Some(home.join("prompts")),
        )?;
        db.set_memory_dir(home.join("memory"));
        db.set_skills_dir(home.join("skills"));
        Ok(db)
    }

    /// A private in-memory database, for tests.
    #[cfg(test)]
    pub fn open_memory() -> Result<Arc<Self>, StoreError> {
        Self::from_connection(Connection::open_in_memory()?, None, None)
    }

    fn from_connection(
        conn: Connection,
        path: Option<PathBuf>,
        prompts_dir: Option<PathBuf>,
    ) -> Result<Arc<Self>, StoreError> {
        // Lets the CLI write keys while the hub runs; a writer waits up to 5 s for the other's lock.
        conn.execute_batch("PRAGMA busy_timeout = 5000")?;
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        conn.execute_batch("PRAGMA synchronous = NORMAL")?;
        conn.execute_batch(&format!("PRAGMA cache_size = -{CACHE_KIB}"))?;
        let db = Self {
            conn: Mutex::new(conn),
            path,
            reader: OnceLock::new(),
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

    /// Runs `f` on a read-only connection of its own, so a long read never holds up the hub's other calls. It sees
    /// what was committed when it starts, as `with` does (WAL). In-memory databases have no second connection and
    /// use the main one.
    pub fn read<R>(
        &self,
        f: impl FnOnce(&Connection) -> Result<R, StoreError>,
    ) -> Result<R, StoreError> {
        let reader = self.reader.get_or_init(|| {
            let path = self.path.as_ref()?;
            match Self::open_reader(path) {
                Ok(conn) => Some(Mutex::new(conn)),
                Err(e) => {
                    tracing::warn!(error = %e, "hub db: no read-only connection; long reads share the main one");
                    None
                }
            }
        });
        match reader {
            Some(conn) => f(&conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())),
            None => self.with(f),
        }
    }

    fn open_reader(path: &Path) -> Result<Connection, StoreError> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.execute_batch("PRAGMA busy_timeout = 5000")?;
        Ok(conn)
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
