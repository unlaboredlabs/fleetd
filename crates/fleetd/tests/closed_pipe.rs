//! A reader that goes away (`fleetd … | head -1`): a one-shot command ends quietly with 0, never with Rust's "failed
//! printing" panic and exit 101, while a pipe into a child that exits early (the binary streamed into ssh) still
//! fails with its error, and the hub keeps SIGPIPE ignored.
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};

struct Fleet {
    dir: tempfile::TempDir,
    listen: String,
}

impl Fleet {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        for sub in ["user", "xdg", "bin"] {
            std::fs::create_dir_all(dir.path().join(sub)).unwrap();
        }
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        Fleet {
            dir,
            listen: format!("127.0.0.1:{port}"),
        }
    }

    fn path(&self, sub: &str) -> PathBuf {
        self.dir.path().join(sub)
    }

    fn fleetd(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fleetd"));
        command
            .args(args)
            .env("HOME", self.path("user"))
            .env("XDG_CONFIG_HOME", self.path("xdg"))
            .env("FLEETD_HOME", self.path("fleet"))
            .stdin(Stdio::null());
        command
    }

    /// `fleetd init --no-service`, then its hub, up and listening.
    fn hub(&self) -> Hub {
        let init = self
            .fleetd(&["init", "--no-service", "--listen", &self.listen])
            .output()
            .unwrap();
        assert!(init.status.success(), "{}", said(&init));
        let mut child = self
            .fleetd(&["hub", "start", "--listen", &self.listen])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while std::net::TcpStream::connect(&self.listen).is_err() {
            assert!(child.try_wait().unwrap().is_none(), "the hub exited");
            assert!(
                std::time::Instant::now() < deadline,
                "the hub never listened"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Hub(child)
    }
}

struct Hub(Child);

impl Drop for Hub {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn said(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// Runs `command` with stdout on a pipe whose read end is closed before it starts, as `head` leaves it.
fn into_closed_pipe(mut command: Command) -> Output {
    let (read, write) = nix::unistd::pipe().unwrap();
    drop(read);
    command
        .stdout(Stdio::from(write))
        .stderr(Stdio::piped())
        .output()
        .unwrap()
}

fn ends_quietly(out: &Output) {
    assert!(!said(out).contains("panicked"), "{}", said(out));
    assert_eq!(
        out.status.code(),
        Some(0),
        "{:?}: {}",
        out.status,
        said(out)
    );
}

#[test]
fn help_ends_quietly_when_its_reader_is_gone() {
    let fleet = Fleet::new();
    ends_quietly(&into_closed_pipe(fleet.fleetd(&["project", "--help"])));
}

#[test]
fn a_command_ends_quietly_when_its_reader_is_gone() {
    let fleet = Fleet::new();
    let _hub = fleet.hub();
    ends_quietly(&into_closed_pipe(fleet.fleetd(&["project", "list"])));
}

#[cfg(target_os = "linux")]
#[test]
fn the_hub_keeps_sigpipe_ignored() {
    let fleet = Fleet::new();
    let hub = fleet.hub();
    let status = std::fs::read_to_string(format!("/proc/{}/status", hub.0.id())).unwrap();
    let ignored = status
        .lines()
        .find_map(|line| line.strip_prefix("SigIgn:"))
        .map(|mask| u64::from_str_radix(mask.trim(), 16).unwrap())
        .unwrap();
    let sigpipe = nix::sys::signal::Signal::SIGPIPE as i32;
    assert_ne!(ignored & (1 << (sigpipe - 1)), 0, "{status}");
}

fn script(file: &Path, text: &str) {
    std::fs::write(file, text).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// An ssh that runs each command here, except that it gives up on the binary without reading it, as one whose
/// connection drops or whose disk is full does; and the claude the machine needs, which CI has none of.
fn fake_ssh(bin: &Path) {
    script(
        &bin.join("ssh"),
        "#!/bin/sh\nfor last; do :; done\ncase \"$last\" in\n  *fleetd-tmp*) echo 'devbox: disk full' >&2; exit 7 ;;\nesac\nexec sh -c \"$last\"\n",
    );
    script(
        &bin.join("claude"),
        &format!(
            "#!/bin/sh\necho '{} (Claude Code)'\n",
            fleetd::node::runner::claude::version::TESTED
        ),
    );
}

#[test]
fn a_child_that_stops_reading_still_fails_its_step() {
    let fleet = Fleet::new();
    let _hub = fleet.hub();
    fake_ssh(&fleet.path("bin"));
    let path = format!(
        "{}:{}",
        fleet.path("bin").display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let out = fleet
        .fleetd(&["machine", "add", "devbox-worker", "--no-service"])
        .env("PATH", path)
        .output()
        .unwrap();
    let said = said(&out);
    assert_eq!(out.status.signal(), None, "not killed by SIGPIPE: {said}");
    assert_eq!(out.status.code(), Some(1), "{said}");
    assert!(said.contains("failed (exit 7)"), "{said}");
    assert!(said.contains("devbox: disk full"), "{said}");
}
