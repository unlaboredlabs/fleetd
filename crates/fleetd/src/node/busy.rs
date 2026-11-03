//! What keeps this machine busy, sent with each heartbeat (`NodeBusy`): agent runs going, live screens, recordings
//! still on their way to the hub, and screens hosted here for agents on other machines. A cloud machine is stopped
//! only while every count is 0 (hub/pool), and `fleetd node flush` reads the same counts ahead of a stop.
use std::path::{Path, PathBuf};
use std::time::Duration;

use fleetd_contracts::node_link::{NodeBusy, UPLOAD_BUSY_SECS};

/// Where each kind of screen keeps its recordings until the hub has them.
fn recording_roots(home: &Path) -> [PathBuf; 4] {
    [
        super::browser::upload::recordings_dir(home),
        super::device::session::recordings_dir(home),
        super::device::ios::session::recordings_dir(home),
        super::desktop::recordings_dir(home),
    ]
}

/// Recordings that ended within [`UPLOAD_BUSY_SECS`] and haven't reached the hub yet.
pub fn uploads(home: &Path) -> usize {
    let within = Duration::from_secs(UPLOAD_BUSY_SECS);
    recording_roots(home)
        .iter()
        .map(|root| super::browser::upload::ended_within(root, within))
        .sum()
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The heartbeat's `busy`, from the runs going, the live screens and those of them hosted for other machines.
pub fn read(running: usize, screens: usize, hosted: usize, home: &Path) -> NodeBusy {
    NodeBusy {
        threads: count(running),
        screens: count(screens),
        uploads: count(uploads(home)),
        hosted: count(hosted),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recording(root: &Path, id: &str, ended: bool) {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let mut meta = serde_json::json!({
            "sessionId": id, "threadId": "t1", "cwd": "/work", "purpose": "check the page",
            "startedAt": "2026-11-03T10:00:00.000Z", "credentialsFilled": 0,
        });
        if ended {
            meta["endedAt"] = "2026-11-03T10:05:00.000Z".into();
        }
        std::fs::write(dir.join("session.json"), meta.to_string()).unwrap();
    }

    #[test]
    fn a_machine_with_nothing_going_is_idle() {
        let home = tempfile::tempdir().unwrap();
        let busy = read(0, 0, 0, home.path());
        assert!(busy.idle(), "{busy:?}");
    }

    #[test]
    fn runs_screens_hosted_screens_and_fresh_recordings_each_keep_it_busy() {
        let home = tempfile::tempdir().unwrap();
        assert!(!read(1, 0, 0, home.path()).idle());
        assert!(!read(0, 2, 1, home.path()).idle());
        // A recording still live counts as its screen, not as an upload; an ended one waits to go.
        let root = super::super::browser::upload::recordings_dir(home.path());
        recording(&root, "s-live", false);
        assert_eq!(read(0, 0, 0, home.path()).uploads, 0);
        recording(&root, "s-done", true);
        recording(
            &super::super::desktop::recordings_dir(home.path()),
            "d-done",
            true,
        );
        let busy = read(0, 0, 0, home.path());
        assert_eq!(busy.uploads, 2);
        assert!(!busy.idle());
    }
}
