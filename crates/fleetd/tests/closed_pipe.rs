//! A reader that goes away (`fleetd … | head -1`): a one-shot command ends quietly, never with Rust's "failed printing"
//! panic and exit 101, while the hub keeps SIGPIPE ignored and handles a closed connection as an error.
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};

fn fleetd(home: &std::path::Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fleetd"));
    command
        .args(args)
        .env("HOME", home.join("user"))
        .env("XDG_CONFIG_HOME", home.join("xdg"))
        .env("FLEETD_HOME", home.join("fleet"))
        .stdin(Stdio::null());
    command
}

#[test]
fn a_one_shot_command_ends_quietly_when_its_reader_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    // The read end is closed before the command starts, so its first write finds no reader, as `head` leaves it.
    let (read, write) = nix::unistd::pipe().unwrap();
    drop(read);
    let out = fleetd(dir.path(), &["project", "--help"])
        .stdout(Stdio::from(write))
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(!said.contains("panicked"), "{said}");
    assert!(
        out.status.success() || out.status.signal() == Some(sigpipe()),
        "ends with 0 or SIGPIPE, not {:?}: {said}",
        out.status
    );
}

#[cfg(target_os = "linux")]
#[test]
fn the_hub_keeps_sigpipe_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let listen = format!("127.0.0.1:{port}");
    let hub_home = dir.path().join("fleet/hub");
    let mut hub = fleetd(
        dir.path(),
        &[
            "hub",
            "start",
            "--home",
            hub_home.to_str().unwrap(),
            "--listen",
            &listen,
        ],
    )
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .unwrap();
    // Listening means its main has run, past where a one-shot command takes the default SIGPIPE back.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while std::net::TcpStream::connect(&listen).is_err() {
        assert!(hub.try_wait().unwrap().is_none(), "the hub exited");
        assert!(
            std::time::Instant::now() < deadline,
            "the hub never listened"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let status = std::fs::read_to_string(format!("/proc/{}/status", hub.id())).unwrap();
    let _ = hub.kill();
    let _ = hub.wait();
    let ignored = status
        .lines()
        .find_map(|line| line.strip_prefix("SigIgn:"))
        .map(|mask| u64::from_str_radix(mask.trim(), 16).unwrap())
        .unwrap();
    assert_ne!(ignored & (1 << (sigpipe() - 1)), 0, "{status}");
}

fn sigpipe() -> i32 {
    nix::sys::signal::Signal::SIGPIPE as i32
}
