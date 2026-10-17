use super::migrations::MIGRATIONS;
use rusqlite::{Connection, TransactionBehavior};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("hub home {} is inside ~/.t3, which belongs to T3; pick another --home (default ~/.fleetd/hub)", .0.display())]
    InsideT3Home(PathBuf),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("stored json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// The `user_version` of a fully migrated database.
pub const SCHEMA_VERSION: usize = MIGRATIONS.len();

/// The hub's SQLite database. HubStore, EventLog, Auth and the areas with tables share this one connection.
pub struct HubDb {
    conn: Mutex<Connection>,
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
        Self::from_connection(Connection::open(home.join("hub.sqlite"))?)
    }

    /// A private in-memory database, for tests.
    pub fn open_memory() -> Result<Arc<Self>, StoreError> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(conn: Connection) -> Result<Arc<Self>, StoreError> {
        // Lets the CLI write keys while the hub runs; a writer waits up to 5 s for the other's lock.
        conn.execute_batch("PRAGMA busy_timeout = 5000")?;
        let _mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        conn.execute_batch("PRAGMA synchronous = NORMAL")?;
        let db = Self { conn: Mutex::new(conn) };
        db.migrate()?;
        Ok(Arc::new(db))
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs `f` on the connection, outside any explicit transaction.
    pub fn with<R>(&self, f: impl FnOnce(&Connection) -> Result<R, StoreError>) -> Result<R, StoreError> {
        f(&self.lock())
    }

    /// Runs `f` in a write transaction (`BEGIN IMMEDIATE`), so a concurrent writer (the CLI next to a running hub)
    /// waits instead of interleaving. Rolls back when `f` fails.
    pub fn transaction<R>(&self, f: impl FnOnce(&Connection) -> Result<R, StoreError>) -> Result<R, StoreError> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn user_version(&self) -> Result<i64, StoreError> {
        self.with(|conn| Ok(user_version(conn)?))
    }

    fn migrate(&self) -> Result<(), StoreError> {
        while (self.user_version()? as usize) < MIGRATIONS.len() {
            self.transaction(|conn| {
                // Re-read inside the lock: another process may have migrated while we waited.
                let current = user_version(conn)? as usize;
                let Some(next) = MIGRATIONS.get(current) else { return Ok(()) };
                conn.execute_batch(next)?;
                conn.execute_batch(&format!("PRAGMA user_version = {}", current + 1))?;
                Ok(())
            })?;
        }
        Ok(())
    }
}

fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

/// `path.resolve`: absolute against the cwd, with `.` and `..` folded lexically.
fn resolve(p: &Path) -> PathBuf {
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(p)
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

/// Real path of `p`, following symlinks in the part of it that exists.
fn realish(p: &Path) -> PathBuf {
    match std::fs::canonicalize(p) {
        Ok(real) => real,
        Err(_) => match (p.parent(), p.file_name()) {
            (Some(parent), Some(name)) => realish(parent).join(name),
            _ => p.to_path_buf(),
        },
    }
}

/// Resolves `--home` (default `~/.fleetd/hub`, `~` expanded) and refuses anything inside `~/.t3`, the live T3
/// home, including through symlinks.
pub fn resolve_hub_home(home: Option<&str>, user_home: &Path) -> Result<PathBuf, StoreError> {
    let expanded = match home {
        None => user_home.join(".fleetd").join("hub"),
        Some("~") => user_home.to_path_buf(),
        Some(raw) => match raw.strip_prefix("~/") {
            Some(rest) => user_home.join(rest),
            None => PathBuf::from(raw),
        },
    };
    let resolved = resolve(&expanded);
    let t3 = resolve(&user_home.join(".t3"));
    if resolved.starts_with(&t3) || realish(&resolved).starts_with(realish(&t3)) {
        return Err(StoreError::InsideT3Home(resolved));
    }
    Ok(resolved)
}
