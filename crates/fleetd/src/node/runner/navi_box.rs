//! A Navi's box (Linux, D234 navi.sandbox-open-home): one long-lived bubblewrap per Navi, with user, pid and IPC
//! namespaces of its own and nothing of the machine mounted but its programs. It starts the first time one of the
//! Navi's sessions does and runs until the node exits. Each session's sandbox joins its user and pid namespaces
//! (bubblewrap's `--userns` and `--pidns`) with a mount namespace of its own, the session's fence. So a process a
//! command leaves running in the background (`nohup`, `setsid`) is reparented to the box's init, not the node, and
//! lives on after the turn, the session and its sweep; the Navi's sessions see one another's processes and no other
//! on the machine, and no host `/proc`, whose `/proc/<pid>/root` would reach hidden paths.
//!
//! The init is bubblewrap's own, pid 1, which reaps what is reparented to it and runs until nothing else in the box
//! does; `cat` on a pipe the node holds keeps it up while nothing else runs there. Each box is started by a thread of
//! its own, which waits on it, and dies with it (`--die-with-parent`): when the node exits, however it ends, so does
//! the box with everything still running in it. Nothing comes back after a restart. The box's `/tmp` dir is emptied
//! each time one starts.
//!
//! The node keeps the box's namespaces open, and a session's bubblewrap inherits them under the same numbers ([`join`]):
//! a box that ended is never mistaken for another process's namespaces, whatever pid comes next.
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek};
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex};

/// The machine's programs, read-only: all the box's mount namespace holds, for `cat` and the libraries it loads.
const PROGRAMS: &[&str] = &["/usr", "/bin", "/lib", "/lib64", "/lib32", "/nix"];

/// `ioctl` on a namespace's file: the user namespace that owns it.
const NS_GET_USERNS: u64 = 0xb701;

/// How long a box's user namespace may take to map its ids after bubblewrap says it is up.
const MAPPED_WITHIN: std::time::Duration = std::time::Duration::from_secs(2);

/// A running box.
struct NaviBox {
    /// The thread that started it, which ends when it does.
    waiter: std::thread::JoinHandle<()>,
    /// Its bubblewrap's pid, which only `waiter` reaps.
    pid_of: u32,
    /// Held open: `cat` keeps the box up until it closes.
    _hold: ChildStdin,
    /// The user namespace that owns its pid namespace, and that pid namespace.
    user: Arc<File>,
    pid: Arc<File>,
}

/// The node's boxes, by their `/tmp` dir.
static BOXES: LazyLock<Mutex<HashMap<PathBuf, NaviBox>>> = LazyLock::new(Default::default);

/// The namespaces of the box known by `tmp`, started now if it isn't running: its user namespace and its pid
/// namespace, open, for a session's bubblewrap to inherit and join (`--userns`, `--pidns`). Err: why it couldn't start.
pub fn join(tool: &Path, tmp: &Path) -> Result<(Arc<File>, Arc<File>), String> {
    let mut boxes = BOXES.lock().unwrap_or_else(|e| e.into_inner());
    let running = boxes.get(tmp).is_some_and(|b| !b.waiter.is_finished());
    if !running {
        boxes.insert(tmp.to_owned(), start(tool, tmp)?);
    }
    let b = &boxes[tmp];
    Ok((b.user.clone(), b.pid.clone()))
}

/// Ends the box known by `tmp`, and everything running in it: its Navi is going.
pub fn end(tmp: &Path) {
    let gone = BOXES.lock().unwrap_or_else(|e| e.into_inner()).remove(tmp);
    if let Some(b) = gone {
        // Its init dies with its bubblewrap, and the box with everything in it.
        if !b.waiter.is_finished() {
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(b.pid_of as i32),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
        let _ = b.waiter.join();
    }
}

/// Starts a box, with `tmp` emptied: once it is up, the namespaces it runs in.
fn start(tool: &Path, tmp: &Path) -> Result<NaviBox, String> {
    match std::fs::remove_dir_all(tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "its /tmp ({}) could not be emptied: {e}",
                tmp.display()
            ));
        }
    }
    std::fs::create_dir_all(tmp).map_err(|e| format!("its /tmp could not be made: {e}"))?;
    let mut args: Vec<String> = [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--die-with-parent",
    ]
    .map(str::to_owned)
    .into();
    for dir in PROGRAMS {
        args.extend(["--ro-bind-try".into(), (*dir).into(), (*dir).into()]);
    }
    // What it says once the box is up comes on a pipe of its own: bubblewrap closes it before `cat` runs.
    let (info, said) = std::io::pipe().map_err(|e| e.to_string())?;
    let said_fd = said.as_raw_fd();
    // No `--dev`: bubblewrap would nest a second user namespace for it, and the sessions' would map them to root.
    args.extend([
        "--proc".into(),
        "/proc".into(),
        "--info-fd".into(),
        said_fd.to_string(),
    ]);
    args.extend(["--".into(), "cat".into()]);
    let mut command = Command::new(tool);
    command
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // SAFETY: clears close-on-exec on the pipe's end this process holds open, a system call only.
    unsafe {
        std::os::unix::process::CommandExt::pre_exec(&mut command, move || {
            match libc::fcntl(said_fd, libc::F_SETFD, 0) {
                0 => Ok(()),
                _ => Err(std::io::Error::last_os_error()),
            }
        });
    }
    let (started, pipes) = std::sync::mpsc::channel();
    let waiter = std::thread::Builder::new()
        .name("navi-box".into())
        .spawn(move || match command.spawn() {
            Ok(mut child) => {
                let _ = started.send(Ok((child.id(), child.stdin.take(), child.stderr.take())));
                let _ = child.wait();
            }
            Err(e) => {
                let _ = started.send(Err(e.to_string()));
            }
        })
        .map_err(|e| e.to_string())?;
    let started = pipes
        .recv()
        .map_err(|_| "it could not be started".to_owned());
    // Only bubblewrap holds the pipe's other end now: it ends when bubblewrap says what it says, or fails.
    drop(said);
    let (pid_of, hold, stderr) = started??;
    let up = namespaces(BufReader::new(info));
    match (up, hold) {
        (Ok((user, pid)), Some(hold)) => Ok(NaviBox {
            waiter,
            pid_of,
            _hold: hold,
            user: Arc::new(user),
            pid: Arc::new(pid),
        }),
        (up, hold) => {
            // A box that never came up (its ids never mapped) is ended: only `waiter` reaps its bubblewrap, so the pid
            // is still its own.
            let _ = nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(pid_of as i32),
                nix::sys::signal::Signal::SIGKILL,
            );
            drop(hold);
            let _ = waiter.join();
            let mut said = String::new();
            if let Some(mut err) = stderr {
                let _ = err.read_to_string(&mut said);
            }
            let why = up.err().unwrap_or_default();
            Err(match said.trim() {
                "" => why,
                said => said.to_owned(),
            })
        }
    }
}

/// Reads what bubblewrap says once the box is up (`--info-fd`) and opens its namespaces: the pid namespace, checked
/// to be the one it named, and the user namespace that owns it, once that maps its ids ([`mapped`]).
fn namespaces(mut out: impl BufRead) -> Result<(File, File), String> {
    let mut text = String::new();
    loop {
        let mut line = String::new();
        match out.read_line(&mut line) {
            Ok(0) | Err(_) => return Err("it ended before it was up".into()),
            Ok(_) => text.push_str(&line),
        }
        if line.trim_end() == "}" {
            break;
        }
    }
    let info: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("it said {text:?}: {e}"))?;
    let (Some(child), Some(ns)) = (info["child-pid"].as_u64(), info["pid-namespace"].as_u64())
    else {
        return Err(format!("it said {text:?}"));
    };
    // Opened before the pid namespace is checked, so they are the child's too.
    let maps = ["uid_map", "gid_map"]
        .map(|map| File::open(format!("/proc/{child}/{map}")).map_err(|e| e.to_string()));
    let pid = File::open(format!("/proc/{child}/ns/pid")).map_err(|e| e.to_string())?;
    let opened = std::os::unix::fs::MetadataExt::ino(&pid.metadata().map_err(|e| e.to_string())?);
    if opened != ns {
        return Err("it ended before it was up".into());
    }
    // SAFETY: NS_GET_USERNS takes no argument and returns a new fd (close-on-exec), which the File owns.
    let user = unsafe {
        let fd = libc::ioctl(pid.as_raw_fd(), NS_GET_USERNS as _);
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        File::from_raw_fd(fd)
    };
    let [uid, gid] = maps;
    mapped([uid?, gid?], MAPPED_WITHIN)?;
    Ok((user, pid))
}

/// Waits, up to `within`, until the box's user namespace maps its ids: its uid and gid maps, open, are written.
/// Unprivileged bubblewrap says the box is up before its child writes them, and a session's bubblewrap that joins
/// the namespace before then can't hand its pid over (`Can't send pid: Invalid argument`).
fn mapped(mut maps: [File; 2], within: std::time::Duration) -> Result<(), String> {
    let until = std::time::Instant::now() + within;
    loop {
        let mut written = true;
        for map in &mut maps {
            let mut text = String::new();
            map.rewind()
                .and_then(|_| map.read_to_string(&mut text))
                .map_err(|e| e.to_string())?;
            written &= !text.trim().is_empty();
        }
        if written {
            return Ok(());
        }
        if std::time::Instant::now() >= until {
            return Err(format!(
                "its uid and gid maps were still empty {} s after it started",
                within.as_secs()
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}
