//! `fleetd node flush`: a clean stop for a cloud machine, run as boat's pre-stop hook (`~/.boat/pre-stop`, which boat
//! gives 60 s). It holds every agent tool call that hasn't started (node/hold.rs; the hold lapses by itself in
//! `HOLD_LEASE_SECS` if the stop never comes), so the stop lands between steps; waits, up to `wait`, for the
//! recordings still on their way to the hub ([`super::busy::uploads`]); then checkpoints the node's database and syncs
//! the disk, so boat's snapshot holds them whole. Nothing is lost when time runs out: runs resume and recordings go at
//! the next wake.
use std::path::Path;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(500);

/// What a flush left, in one line.
pub async fn flush(home: &Path, wait: Duration) -> String {
    let held = match super::hold::hold(home) {
        Ok(()) => "agents held between steps",
        Err(_) => "agents not held",
    };
    let deadline = Instant::now() + wait;
    let mut uploads = super::busy::uploads(home);
    while uploads > 0 && Instant::now() < deadline {
        tokio::time::sleep(POLL).await;
        uploads = super::busy::uploads(home);
    }
    let checkpoint = match checkpoint(&home.join("sessions.sqlite")) {
        Ok(()) => "database checkpointed",
        Err(_) => "database not checkpointed",
    };
    nix::unistd::sync();
    let waiting = match uploads {
        0 => "no recording waits".to_owned(),
        1 => "1 recording waits for the next wake".to_owned(),
        n => format!("{n} recordings wait for the next wake"),
    };
    format!("flushed: {held}, {waiting}, {checkpoint}, disk synced")
}

/// Folds the database's write-ahead log into it, waiting a while for the node's own writes.
fn checkpoint(db: &Path) -> rusqlite::Result<()> {
    if !db.exists() {
        return Ok(());
    }
    let conn = rusqlite::Connection::open(db)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_flush_holds_the_agents_checkpoints_and_says_what_waits() {
        let home = tempfile::tempdir().unwrap();
        let db = home.path().join("sessions.sqlite");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))
            .unwrap();
        conn.execute_batch("CREATE TABLE t (x); INSERT INTO t VALUES (1);")
            .unwrap();
        let said = flush(home.path(), Duration::ZERO).await;
        assert_eq!(
            said,
            "flushed: agents held between steps, no recording waits, database checkpointed, disk synced"
        );
        assert!(super::super::hold::hold_path(home.path()).exists());
        let wal = std::fs::metadata(home.path().join("sessions.sqlite-wal")).map_or(0, |m| m.len());
        assert_eq!(wal, 0, "the log was folded into the database");
    }
}
