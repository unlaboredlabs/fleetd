//! The node's own binary, pinned where `fleetd update` can't replace it: the command its sessions start
//! `fleetd agent-mcp` with. The update writes a new binary beside the installed one and renames it over (cli/update.rs),
//! so the installed path then names the new binary: on Linux the running one shows as `<path> (deleted)`, and on macOS
//! the path opens the new one, which may not speak the running node's socket. At start the node hard-links its running
//! binary to `<node home>/bin/fleetd-agent-<pid>` (copying it when the home is on another filesystem). The link keeps
//! the running binary's file, whatever the update does to the installed path, for as long as this node runs; the next
//! node start removes the links of nodes that are gone, but not one a session's host still runs from
//! (`runner::host`): the sessions it re-adopts keep starting their fleetd tools from it.
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const DIR: &str = "bin";
const PREFIX: &str = "fleetd-agent-";

static PINNED: OnceLock<PathBuf> = OnceLock::new();

/// Pins this process's binary under `home` for the agent-mcp command; logged and skipped when it can't.
pub fn pin(home: &Path) {
    let exe = std::env::current_exe().map(|exe| {
        // Linux names a binary replaced under a running process `<path> (deleted)`; /proc still opens it.
        if !exe.exists() && cfg!(target_os = "linux") {
            PathBuf::from("/proc/self/exe")
        } else {
            exe
        }
    });
    match exe.and_then(|exe| pin_from(&exe, home, std::process::id())) {
        Ok(pinned) => {
            let _ = PINNED.set(pinned);
        }
        Err(e) => tracing::warn!(
            "the node's binary was not pinned for agents' fleetd tools; a self-update may leave new sessions without them: {e}"
        ),
    }
}

/// The pinned binary, while it is there.
pub fn pinned() -> Option<&'static Path> {
    PINNED.get().map(PathBuf::as_path).filter(|p| p.exists())
}

/// Links (else copies) `exe` to `<home>/bin/fleetd-agent-<pid>`, and removes those of processes that are gone.
pub fn pin_from(exe: &Path, home: &Path, pid: u32) -> std::io::Result<PathBuf> {
    let dir = home.join(DIR);
    super::config::mkdir_private(&dir)?;
    sweep(&dir, pid);
    // The file itself, not a symlink to it (an installed `fleetd` is often one), which the update would retarget.
    let source = std::fs::canonicalize(exe).unwrap_or_else(|_| exe.to_owned());
    let target = dir.join(format!("{PREFIX}{pid}"));
    let tmp = dir.join(format!(".{PREFIX}{pid}.tmp"));
    let _ = std::fs::remove_file(&tmp);
    if std::fs::hard_link(&source, &tmp).is_err() {
        std::fs::copy(&source, &tmp)?;
    }
    std::fs::rename(&tmp, &target)?;
    Ok(target)
}

/// Removes the pins of processes that no longer run, unless a running process was started from one; never this one's.
fn sweep(dir: &Path, pid: u32) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let running = running_exes();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(other) = name
            .to_str()
            .and_then(|n| n.strip_prefix(PREFIX))
            .and_then(|n| n.parse::<i32>().ok())
        else {
            continue;
        };
        if other as u32 == pid || alive(other) || running.contains(&entry.path()) {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
}

/// The binaries this user's processes run, as `/proc/<pid>/exe` names them. Empty off Linux.
fn running_exes() -> std::collections::HashSet<PathBuf> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Default::default();
    };
    entries
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.parse::<u32>().is_ok())
        })
        .filter_map(|e| std::fs::read_link(e.path().join("exe")).ok())
        .collect()
}

fn alive(pid: i32) -> bool {
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) {
        Ok(()) => true,
        // Someone else's process: it runs.
        Err(nix::errno::Errno::EPERM) => true,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// As `fleetd update` installs on macOS and Linux alike: a new file renamed over the installed one. The pinned
    /// binary is still the one that ran, and still starts. This test binary plays the node's: a hard link of it beside
    /// it (a copy's write fd could leak into another test's fork, and exec of it would fail with `ETXTBSY`).
    #[test]
    fn the_pinned_binary_survives_an_update_of_the_installed_one() {
        use std::os::unix::fs::MetadataExt;
        let exe = std::env::current_exe().unwrap();
        let dir = tempfile::tempdir_in(exe.parent().unwrap()).unwrap();
        let installed = dir.path().join("fleetd");
        std::fs::hard_link(&exe, &installed).unwrap();
        // Installed through a symlink, as a package manager or ~/.local/bin does.
        let shim = dir.path().join("shim");
        std::os::unix::fs::symlink(&installed, &shim).unwrap();
        let home = dir.path().join("node");
        let pinned = pin_from(&shim, &home, 4242).unwrap();
        assert_eq!(pinned, home.join("bin").join("fleetd-agent-4242"));
        let inode = |p: &Path| std::fs::metadata(p).unwrap().ino();
        assert_eq!(inode(&pinned), inode(&exe));

        let new = dir.path().join("fleetd.new");
        std::fs::write(&new, "#!/bin/sh\nexit 3\n").unwrap();
        std::fs::rename(&new, &installed).unwrap();
        assert_ne!(inode(&installed), inode(&exe));
        assert_eq!(inode(&pinned), inode(&exe), "the update left the pin alone");
        let listed = std::process::Command::new(&pinned)
            .args(["--list"])
            .output()
            .unwrap();
        assert!(listed.status.success(), "{listed:?}");
        assert!(
            String::from_utf8_lossy(&listed.stdout)
                .contains("the_pinned_binary_survives_an_update_of_the_installed_one")
        );
    }

    #[test]
    fn a_new_start_removes_the_pins_of_nodes_that_are_gone() {
        let exe = std::env::current_exe().unwrap();
        let dir = tempfile::tempdir_in(exe.parent().unwrap()).unwrap();
        let home = dir.path().join("node");
        let bin = home.join("bin");
        super::super::config::mkdir_private(&bin).unwrap();
        // A pid past any the system hands out, and this process's own.
        let gone = bin.join("fleetd-agent-2147483000");
        let live = bin.join(format!("fleetd-agent-{}", std::process::id()));
        let other = bin.join("notes.txt");
        for f in [&gone, &live, &other] {
            std::fs::write(f, "x").unwrap();
        }
        pin_from(&exe, &home, 4243).unwrap();
        assert!(!gone.exists());
        assert!(live.exists() && other.exists());
        assert!(bin.join("fleetd-agent-4243").exists());
        // Pinning again for the same process replaces its own.
        pin_from(&exe, &home, 4243).unwrap();
        assert!(bin.join("fleetd-agent-4243").exists());
    }

    /// A session's host runs from the pin of the node that started it, and its re-adopted session's fleetd tools
    /// still start from that path after the node restarted. The host here is this test binary, linked as a pin of a
    /// node that's gone, waiting in [`waits`].
    #[cfg(target_os = "linux")]
    #[test]
    fn a_pin_a_running_host_was_started_from_is_kept() {
        let exe = std::env::current_exe().unwrap();
        let dir = tempfile::tempdir_in(exe.parent().unwrap()).unwrap();
        let home = dir.path().join("node");
        let bin = home.join("bin");
        super::super::config::mkdir_private(&bin).unwrap();
        let used = bin.join("fleetd-agent-2147483001");
        std::fs::hard_link(&exe, &used).unwrap();
        let mut host = std::process::Command::new(&used)
            .args(["--ignored", "--exact", "node::self_exe::tests::waits"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let exe_of = format!("/proc/{}/exe", host.id());
        while std::fs::read_link(&exe_of).ok().as_ref() != Some(&used) {
            assert!(host.try_wait().unwrap().is_none(), "the host runs");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        pin_from(&exe, &home, 4244).unwrap();
        assert!(used.exists(), "a running process's pin stays");
        host.kill().unwrap();
        host.wait().unwrap();
        pin_from(&exe, &home, 4244).unwrap();
        assert!(!used.exists(), "and goes once nothing runs from it");
    }

    /// What the host of the test above runs.
    #[test]
    #[ignore = "run by a_pin_a_running_host_was_started_from_is_kept"]
    fn waits() {
        std::thread::sleep(std::time::Duration::from_secs(30));
    }
}
