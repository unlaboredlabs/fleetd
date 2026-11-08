//! Agents' cargo builds take turns for the machine's build slots. With 19 agents compiling at once, rustc at 2 to 6 GB
//! each filled memory and swap, and the OOM killer took builds, agents and the hub's answers with it. So the node puts
//! a `cargo` of its own first on each agent's PATH (`<node home>/build-slots/bin/cargo`), which runs
//! `fleetd build-slot`: a build, test, check, clippy (and the like, [`HEAVY`]) first takes one of the machine's slots,
//! a file under `<node home>/build-slots` it holds a lock on while the real cargo runs, and every other cargo command
//! runs at once but `run`, whose build alone takes a slot (what it runs may run for hours). A call that compiles nothing
//! ([`compiles_nothing`]: `cargo nextest --version`, `cargo build --help`) runs at once too. With every slot in use a
//! build queues, first come first served, and says so in one line. The kernel
//! drops a lock when its holder exits however it ends, so a slot never stays taken by a build that's gone, and nothing
//! running is ever stopped: a build only ever waits before it starts.
//!
//! How many slots: node.json's `buildSlots`, which the admin sets, else one per [`MEM_PER_SLOT_GB`] of the machine's
//! memory, at least one: a fixed budget per build, never a reading of the load. `buildSlots: 0` turns the turns off. A
//! slot's budget holds one of the workspace's biggest builds and its share of what runs beside the builds; a test
//! build that may compile a lib's tests beside its lib takes two ([`slots_taken`]).
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The hidden subcommand the wrapper runs: `fleetd build-slot <node home> <cargo's arguments>`.
pub const COMMAND: &str = "build-slot";

/// The memory each build slot stands for when node.json sets no `buildSlots`: one build at its peak (fleetd's lib
/// tests, 10.6 GB at most on the devbox) and a third of the machine kept for everything that runs beside the builds
/// (agents' claude, browsers, test runners, a tmpfs /tmp), which took 19 to 22 GB of the devbox's 60.
pub const MEM_PER_SLOT_GB: u64 = 16;

/// The cargo commands that wait for a slot: those that compile. `run` builds first ([`build_first`]).
const HEAVY: &[&str] = &[
    "build", "b", "check", "c", "clippy", "test", "t", "bench", "doc", "d", "rustc", "rustdoc",
    "install", "fix", "nextest", "llvm-cov", "miri",
];

/// The commands that build a package's lib tests unless their targets leave them out.
const TESTS: &[&str] = &["test", "t", "bench", "nextest", "llvm-cov"];

/// Set on a build that holds a slot: a cargo it runs in turn (a test that builds a fixture) runs at once, since
/// waiting there for a slot of its own could wait forever on its parent's.
const HELD: &str = "FLEETD_BUILD_SLOT";

/// How often a queued build looks for a free slot.
const POLL: Duration = Duration::from_millis(500);

pub fn dir(home: &Path) -> PathBuf {
    home.join("build-slots")
}

/// The directory put first on an agent's PATH: it holds only the `cargo` wrapper.
pub fn bin_dir(home: &Path) -> PathBuf {
    dir(home).join("bin")
}

/// The slots that fit `mem_total` bytes of memory: one per [`MEM_PER_SLOT_GB`], at least one. An unknown total
/// counts as 2.
pub fn slots_fit(mem_total: Option<u64>) -> u64 {
    const GIB: u64 = 1 << 30;
    // As sold: a 64 GB machine whose kernel reports 62.7 counts as 64.
    mem_total.map_or(2, |total| (total.div_ceil(GIB) / MEM_PER_SLOT_GB).max(1))
}

/// This machine's slot count: node.json's `buildSlots`, else [`slots_fit`]. None when `buildSlots` is 0: no turns.
pub fn slots_here(home: &Path) -> Option<u64> {
    let set = super::config::read_config(home)
        .ok()
        .flatten()
        .and_then(|c| c.build_slots);
    match set {
        Some(0) => None,
        Some(n) => Some(n),
        None => Some(slots_fit(super::load::mem_total())),
    }
}

/// Where cargo's command is in `args`: the first that is neither a toolchain (`+nightly`) nor a flag (nor a global
/// flag's value).
fn command_at(args: &[String]) -> Option<usize> {
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        if ["-C", "--config", "-Z", "--color"].contains(&arg.as_str()) {
            at += 2;
        } else if arg.starts_with('-') || arg.starts_with('+') {
            at += 1;
        } else {
            return Some(at);
        }
    }
    None
}

/// Whether cargo's `args` name a [`HEAVY`] command that compiles: not one that only prints ([`compiles_nothing`]).
pub fn heavy(args: &[String]) -> bool {
    command_at(args).is_some_and(|at| HEAVY.contains(&args[at].as_str())) && !compiles_nothing(args)
}

/// How many slots a build of cargo's `args` takes: two when it may compile a lib's tests and the lib itself at once,
/// the two biggest rustc of a package (fleetd's lib tests and lib together peaked at 13.1 GB), else one. A test
/// command builds both unless its targets are only `--lib` of one package, or leave the lib's tests out (`--test x`,
/// `--doc`: those wait for the lib, so build after it); a `build` with `--all-targets` or `--tests` builds both too.
pub fn slots_taken(args: &[String]) -> u64 {
    let Some(at) = command_at(args) else {
        return 1;
    };
    let (mut lib, mut others, mut both, mut packages) = (false, false, false, 0);
    for arg in args[at + 1..].iter().take_while(|a| *a != "--") {
        match arg.split_once('=').map_or(arg.as_str(), |(flag, _)| flag) {
            "--lib" => lib = true,
            "-p" | "--package" => packages += 1,
            "--workspace" | "--all" => packages += 2,
            "--all-targets" | "--tests" => both = true,
            "--bin" | "--bins" | "--test" | "--bench" | "--benches" | "--example"
            | "--examples" | "--doc" => {
                others = true;
            }
            _ => {}
        }
    }
    let command = args[at].as_str();
    let two = if TESTS.contains(&command) {
        both || lib == others || (lib && packages > 1)
    } else {
        // A check or clippy only type-checks: its lib and lib tests together peaked at 6.3 GB.
        both && ["build", "b"].contains(&command)
    };
    if two { 2 } else { 1 }
}

/// Flags that make a command print and exit: `cargo nextest --version`, `cargo build --help`.
const PRINTS_ONLY: &[&str] = &["--version", "-V", "--help", "-h"];

/// Whether cargo's `args` compile nothing whatever their command: none (`cargo -V`), or a version or help flag of the
/// command's own (before `--`, and for `run` before the program's first argument), or `install --list`.
pub fn compiles_nothing(args: &[String]) -> bool {
    let Some(at) = command_at(args) else {
        return true;
    };
    let command = args[at].as_str();
    let run = ["run", "r"].contains(&command);
    let mut rest = args[at + 1..].iter().take_while(|a| *a != "--");
    while let Some(arg) = rest.next() {
        if PRINTS_ONLY.contains(&arg.as_str()) || (command == "install" && arg == "--list") {
            return true;
        }
        if run && RUN_VALUES.contains(&arg.as_str()) {
            rest.next();
        } else if run && !arg.starts_with('-') {
            // The program's arguments from here on, flags too.
            return false;
        }
    }
    false
}

/// `cargo run`'s flags that take a value as the next argument: every one of them `cargo build` takes too.
const RUN_VALUES: &[&str] = &[
    "-p",
    "--package",
    "--bin",
    "--example",
    "-F",
    "--features",
    "-j",
    "--jobs",
    "--profile",
    "--target",
    "--target-dir",
    "--manifest-path",
    "--message-format",
    "--color",
    "--config",
    "-Z",
    "-C",
    "--lockfile-path",
];

/// For a `cargo run`, the `cargo build` of what it runs: `build` for `run`, and its flags with their values up to
/// `--`, never the program's own arguments (`cargo run -q a b` runs it with `a b`, which `cargo build` refuses). It
/// builds in a slot, which frees before the program starts.
pub fn build_first(args: &[String]) -> Option<Vec<String>> {
    let at = command_at(args).filter(|&at| ["run", "r"].contains(&args[at].as_str()))?;
    let mut build = args[..at].to_vec();
    build.push("build".to_owned());
    let mut rest = args[at + 1..].iter().take_while(|a| *a != "--");
    while let Some(arg) = rest.next() {
        if !arg.starts_with('-') {
            continue;
        }
        build.push(arg.clone());
        if RUN_VALUES.contains(&arg.as_str())
            && let Some(value) = rest.next()
        {
            build.push(value.clone());
        }
    }
    Some(build)
}

/// Writes the wrapper, which runs `exe` (this binary, as sessions start it), unless it already says the same.
pub fn install(home: &Path, exe: &str) -> std::io::Result<PathBuf> {
    let bin = bin_dir(home);
    super::config::mkdir_private(&bin)?;
    let wrapper = bin.join("cargo");
    let mut script = String::from(
        "#!/bin/sh\n# fleetd's: an agent's cargo build waits its turn for one of the machine's build slots.\nexec ",
    );
    super::order_env::push_quoted(&mut script, exe);
    script.push(' ');
    script.push_str(COMMAND);
    script.push(' ');
    super::order_env::push_quoted(&mut script, &home.to_string_lossy());
    script.push_str(" \"$@\"\n");
    // Runnable before it's in place: a cargo started meanwhile finds the old wrapper or this one, never neither.
    if std::fs::read_to_string(&wrapper).ok().as_deref() != Some(script.as_str()) {
        let tmp = bin.join(format!(".cargo-{}", std::process::id()));
        std::fs::write(&tmp, &script)?;
        std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
        std::fs::rename(&tmp, &wrapper)?;
    }
    Ok(wrapper)
}

/// The wrapper's folder first on `env`'s PATH (installed now), for an agent session's claude. Left as it is when the
/// wrapper can't be written: builds then run without turns.
pub fn add_to_path(home: &Path, exe: &str, env: &mut Vec<(String, String)>) {
    if let Err(e) = install(home, exe) {
        tracing::warn!("agents' builds won't take turns: the cargo wrapper was not written: {e}");
        return;
    }
    let bin = bin_dir(home).to_string_lossy().into_owned();
    // None set: the node's own, which the session would otherwise have searched.
    let path = match env.iter().position(|(k, _)| k == "PATH") {
        Some(at) => env.remove(at).1,
        None => std::env::var("PATH").unwrap_or_default(),
    };
    let path = if path.is_empty() {
        bin
    } else {
        format!("{bin}:{path}")
    };
    env.push(("PATH".to_owned(), path));
}

/// What a worker's standing rules say about build turns.
pub fn brief_line(slots: u64) -> String {
    format!(
        "- Cargo builds, tests, checks and clippy runs take turns for this machine's {slots} build slots, one each; \
         a `cargo test` takes two (a lib's tests beside the lib) unless it builds only `--lib` of one package or \
         only named targets (`--test <name>`), so pick one of those when you can. One with too few free prints that \
         it is queued for a build slot and starts by itself once they free, within the same command: give it Bash's \
         longest timeout, since one stopped and started again goes to the back of the queue.\n"
    )
}

/// The first `cargo` on `path` outside `skip` (the wrapper's own folder).
pub fn real_cargo(path: &std::ffi::OsStr, skip: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let skip = std::fs::canonicalize(skip).unwrap_or_else(|_| skip.to_owned());
    std::env::split_paths(path)
        .filter(|dir| std::fs::canonicalize(dir).unwrap_or_else(|_| dir.clone()) != skip)
        .map(|dir| dir.join("cargo"))
        .find(|bin| {
            std::fs::metadata(bin).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// The slots taken: their locks go when this drops, or when the process ends however it ends.
pub struct Slot {
    _locks: Vec<File>,
}

/// A place in the queue: a lock on `<dir>/queue/<ticket>`, which sorts by when it was taken. Removed on drop; one
/// whose owner died is unlocked, and whoever next counts the queue removes it.
struct Ticket {
    path: PathBuf,
    _lock: File,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn ticket(queue: &Path) -> std::io::Result<Ticket> {
    super::config::mkdir_private(queue)?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = format!("{nanos:020}-{}", std::process::id());
    // Locked before it's in the queue under its name, so nobody ever sees it unlocked and takes it for a dead one's.
    let mut n = 0;
    let (tmp, lock) = loop {
        let tmp = queue.join(format!(".{name}-{n}"));
        match OpenOptions::new().write(true).create_new(true).open(&tmp) {
            Ok(file) => break (tmp, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(e),
        }
    };
    lock.lock()?;
    let path = queue.join(format!("{name}-{n}"));
    std::fs::rename(&tmp, &path)?;
    Ok(Ticket { path, _lock: lock })
}

/// The live tickets in `queue` that sort before `mine`. Removes those whose owner is gone.
fn ahead(queue: &Path, mine: &Path) -> std::io::Result<usize> {
    let mut count = 0;
    for entry in std::fs::read_dir(queue)? {
        let path = entry?.path();
        let hidden = path
            .file_name()
            .is_none_or(|n| n.to_string_lossy().starts_with('.'));
        if hidden || path.as_path() >= mine {
            continue;
        }
        let Ok(file) = File::open(&path) else {
            continue;
        };
        match file.try_lock() {
            Err(std::fs::TryLockError::WouldBlock) => count += 1,
            // Unlocked: its owner ended without removing it.
            Ok(()) => {
                let _ = std::fs::remove_file(&path);
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(e),
        }
    }
    Ok(count)
}

/// `need` free ones of `slots` slots in `dir` (all of them if it needs more), if there are that many free.
fn free_slot(dir: &Path, slots: u64, need: u64) -> std::io::Result<Option<Slot>> {
    let mut locks = Vec::new();
    for i in 0..slots {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(format!("slot-{i}")))?;
        match file.try_lock() {
            Ok(()) => locks.push(file),
            Err(std::fs::TryLockError::WouldBlock) => {}
            Err(std::fs::TryLockError::Error(e)) => return Err(e),
        }
        if locks.len() as u64 == need.min(slots) {
            return Ok(Some(Slot { _locks: locks }));
        }
    }
    // Too few free: those locked free again as they drop.
    Ok(None)
}

/// Takes `need` of `slots` slots in `dir` ([`slots_taken`]), after every build queued before this one. While it
/// waits, `queued` hears once how many are ahead of it.
pub fn take(
    dir: &Path,
    slots: u64,
    need: u64,
    poll: Duration,
    mut queued: impl FnMut(usize),
) -> std::io::Result<Slot> {
    super::config::mkdir_private(dir)?;
    let queue = dir.join("queue");
    let mine = ticket(&queue)?;
    let mut told = false;
    loop {
        let ahead = ahead(&queue, &mine.path)?;
        if ahead == 0
            && let Some(slot) = free_slot(dir, slots, need)?
        {
            return Ok(slot);
        }
        if !told {
            queued(ahead);
            told = true;
        }
        std::thread::sleep(poll);
    }
}

/// The line a queued build prints.
pub fn queued_line(slots: u64, ahead: usize) -> String {
    let place = match ahead {
        0 => "next in line".to_owned(),
        1 => "1 build ahead".to_owned(),
        n => format!("{n} builds ahead"),
    };
    let slots = if slots == 1 {
        "1 slot".to_owned()
    } else {
        format!("{slots} slots")
    };
    format!(
        "fleetd: queued for a build slot ({place}; {slots} on this machine): it starts once one frees"
    )
}

/// `fleetd build-slot <node home> <cargo's arguments>`: the real cargo with them, once a slot is free if it builds.
pub fn main(args: &[String]) -> ExitCode {
    let Some((home, args)) = args.split_first() else {
        eprintln!("fleetd: {COMMAND} needs the node home, then cargo's arguments");
        return ExitCode::from(2);
    };
    let home = Path::new(home);
    let path = std::env::var_os("PATH").unwrap_or_default();
    let Some(cargo) = real_cargo(&path, &bin_dir(home)) else {
        eprintln!("fleetd: no cargo on PATH beside fleetd's build-slot wrapper");
        return ExitCode::from(127);
    };
    let mut command = std::process::Command::new(&cargo);
    command.args(args);
    let held = std::env::var_os(HELD).is_some();
    let build = build_first(args).filter(|_| !held && !compiles_nothing(args));
    let waits = !held && (build.is_some() || heavy(args));
    let slots = if waits { slots_here(home) } else { None };
    let Some(slots) = slots else {
        return exec(command, &cargo);
    };
    let slot = take(&dir(home), slots, slots_taken(args), POLL, |ahead| {
        eprintln!("{}", queued_line(slots, ahead));
    });
    if let Err(e) = &slot {
        eprintln!("fleetd: build slots unavailable ({e}): building without waiting");
    }
    let mut building = match &build {
        Some(build) => {
            let mut first = std::process::Command::new(&cargo);
            first.args(build);
            first
        }
        None => command,
    };
    building.env(HELD, "1");
    let status = match building.status() {
        Ok(status) => status,
        Err(e) => {
            eprintln!("fleetd: cannot run {}: {e}", cargo.display());
            return ExitCode::from(126);
        }
    };
    drop(slot);
    // Built: the program runs outside the slot, with nothing left to compile.
    if build.is_some() && status.success() {
        let mut run = std::process::Command::new(&cargo);
        run.args(args);
        return exec(run, &cargo);
    }
    use std::os::unix::process::ExitStatusExt;
    let code = status
        .code()
        .or_else(|| status.signal().map(|s| 128 + s))
        .unwrap_or(1);
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

/// Runs `command` in this process's place.
fn exec(mut command: std::process::Command, cargo: &Path) -> ExitCode {
    use std::os::unix::process::CommandExt;
    let e = command.exec();
    eprintln!("fleetd: cannot run {}: {e}", cargo.display());
    ExitCode::from(126)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    const FAST: Duration = Duration::from_millis(10);

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    /// N slots, N+1 builds: N run, the last waits and says it is queued, then runs once one of them ends.
    #[test]
    fn with_every_slot_taken_a_build_waits_its_turn_then_runs() {
        let dir = tempfile::tempdir().unwrap();
        let slots = 3;
        let running: Vec<Slot> = (0..slots)
            .map(|_| {
                take(dir.path(), slots, 1, FAST, |_| {
                    panic!("a free slot was there")
                })
                .unwrap()
            })
            .collect();
        let (said, heard) = mpsc::channel();
        let (started, start) = mpsc::channel();
        let at = dir.path().to_owned();
        let last = std::thread::spawn(move || {
            let slot = take(&at, slots, 1, FAST, |ahead| said.send(ahead).unwrap()).unwrap();
            started.send(()).unwrap();
            slot
        });
        assert_eq!(heard.recv_timeout(Duration::from_secs(10)), Ok(0));
        assert!(
            start.recv_timeout(Duration::from_millis(200)).is_err(),
            "ran with every slot taken"
        );
        let mut running = running;
        drop(running.pop());
        start
            .recv_timeout(Duration::from_secs(10))
            .expect("never ran once a slot freed");
        let _last = last.join().unwrap();
        assert!(
            heard.try_recv().is_err(),
            "said it was queued more than once"
        );
        // Every slot is taken again: a new build waits.
        assert!(free_slot(dir.path(), slots, 1).unwrap().is_none());
    }

    /// A build that takes two slots waits until two are free, and holds both: with one left, a one-slot build runs.
    #[test]
    fn a_two_slot_build_waits_for_two_and_holds_both() {
        let dir = tempfile::tempdir().unwrap();
        let slots = 3;
        let first = take(dir.path(), slots, 1, FAST, |_| unreachable!()).unwrap();
        let second = take(dir.path(), slots, 1, FAST, |_| unreachable!()).unwrap();
        let (said, heard) = mpsc::channel();
        let (started, start) = mpsc::channel();
        let at = dir.path().to_owned();
        let both = std::thread::spawn(move || {
            let slot = take(&at, slots, 2, FAST, |ahead| said.send(ahead).unwrap()).unwrap();
            started.send(()).unwrap();
            slot
        });
        assert_eq!(heard.recv_timeout(Duration::from_secs(10)), Ok(0));
        assert!(
            start.recv_timeout(Duration::from_millis(200)).is_err(),
            "ran with one slot free"
        );
        drop(first);
        start
            .recv_timeout(Duration::from_secs(10))
            .expect("never ran once two slots were free");
        let both = both.join().unwrap();
        assert!(free_slot(dir.path(), slots, 1).unwrap().is_none());
        // The one left frees with the last one-slot build. Waited for: a child another test forks meanwhile holds
        // the lock until it execs.
        drop(second);
        let one = (0..1000).find_map(|_| {
            let slot = free_slot(dir.path(), slots, 1).unwrap();
            if slot.is_none() {
                std::thread::sleep(FAST);
            }
            slot
        });
        assert!(one.is_some(), "the slot left never freed");
        drop(both);
        // On a one-slot machine it takes the one.
        let small = tempfile::tempdir().unwrap();
        take(small.path(), 1, 2, FAST, |_| {
            panic!("waited for a second slot of one")
        })
        .unwrap();
    }

    /// Two slots for a test build that may compile a lib's tests beside the lib; one for a single kind of target.
    #[test]
    fn a_build_of_lib_tests_beside_other_targets_takes_two_slots() {
        for two in [
            &["test"][..],
            &["test", "-p", "fleetd", "slots"],
            &["t", "--workspace"],
            &[
                "test", "--no-run", "-p", "fleetd", "--lib", "--test", "check_sh",
            ],
            &["test", "--lib", "--test=check_sh"],
            &["nextest", "run", "-p", "fleetd", "-E", "test(/^node::/)"],
            &["+nightly", "llvm-cov", "--", "--lib"],
            &["test", "--tests"],
            &["test", "--lib", "--tests"],
            &["test", "-p", "fleetd", "-p", "fleetd-contracts", "--lib"],
            &["test", "--workspace", "--lib"],
            &["build", "--all-targets"],
        ] {
            assert_eq!(slots_taken(&args(two)), 2, "{two:?}");
        }
        for one in [
            &["test", "-p", "fleetd", "--lib", "node::build_slots::"][..],
            &["test", "-p", "fleetd", "--test", "check_sh"],
            &["test", "--doc"],
            &["nextest", "run", "--lib"],
            &["build", "-p", "fleetd", "-p", "docsgen"],
            &[
                "clippy",
                "--workspace",
                "--all-targets",
                "--",
                "-D",
                "warnings",
            ],
            &["check", "--tests"],
            &["check"],
            &["run", "-p", "docsgen", "--", "--check"],
            &[],
        ] {
            assert_eq!(slots_taken(&args(one)), 1, "{one:?}");
        }
    }

    /// Queued builds go first come first served, and each hears how many are ahead of it.
    #[test]
    fn queued_builds_go_in_turn_and_hear_how_many_are_ahead() {
        let dir = tempfile::tempdir().unwrap();
        let held = take(dir.path(), 1, 1, FAST, |_| unreachable!()).unwrap();
        let (done, order) = mpsc::channel();
        let mut waiting = Vec::new();
        for who in 0..2 {
            let (said, heard) = mpsc::channel();
            let (at, done) = (dir.path().to_owned(), done.clone());
            waiting.push(std::thread::spawn(move || {
                let slot = take(&at, 1, 1, FAST, |ahead| said.send(ahead).unwrap()).unwrap();
                done.send(who).unwrap();
                std::thread::sleep(Duration::from_millis(50));
                drop(slot);
            }));
            assert_eq!(heard.recv_timeout(Duration::from_secs(10)), Ok(who));
        }
        drop(held);
        assert_eq!(order.recv_timeout(Duration::from_secs(10)), Ok(0));
        assert_eq!(order.recv_timeout(Duration::from_secs(10)), Ok(1));
        for w in waiting {
            w.join().unwrap();
        }
        // Each took its ticket out of the queue as it left.
        let left: Vec<_> = std::fs::read_dir(dir.path().join("queue"))
            .unwrap()
            .collect();
        assert!(left.is_empty(), "{left:?}");
    }

    /// A queued build that died leaves its ticket unlocked: those behind it don't count it, and remove it.
    #[test]
    fn a_dead_builds_ticket_holds_nobody_up() {
        let dir = tempfile::tempdir().unwrap();
        let queue = dir.path().join("queue");
        std::fs::create_dir_all(&queue).unwrap();
        let dead = queue.join("00000000000000000001-1-0");
        std::fs::write(&dead, "").unwrap();
        let _slot = take(dir.path(), 1, 1, FAST, |_| panic!("waited on a dead build")).unwrap();
        assert!(!dead.exists());
    }

    #[test]
    fn the_wrapper_runs_the_real_cargo_past_its_own() {
        let home = tempfile::tempdir().unwrap();
        let wrapper = install(home.path(), "/opt/fleetd").unwrap();
        let script = std::fs::read_to_string(&wrapper).unwrap();
        assert!(
            script.ends_with(&format!(
                "exec '/opt/fleetd' build-slot '{}' \"$@\"\n",
                home.path().display()
            )),
            "{script}"
        );
        let tools = home.path().join("tools");
        std::fs::create_dir_all(&tools).unwrap();
        let cargo = tools.join("cargo");
        std::fs::write(&cargo, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&cargo, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let bin = bin_dir(home.path());
        let path = std::env::join_paths([bin.clone(), tools]).unwrap();
        assert_eq!(real_cargo(&path, &bin), Some(cargo));
        let only = std::env::join_paths([bin.clone()]).unwrap();
        assert_eq!(real_cargo(&only, &bin), None);
    }

    /// `cargo run` builds what it runs in a slot first: everything up to `--`, as `build`.
    #[test]
    fn a_run_builds_first() {
        assert_eq!(
            build_first(&args(&[
                "+nightly", "-q", "run", "-p", "docsgen", "--", "--check", "run"
            ])),
            Some(args(&["+nightly", "-q", "build", "-p", "docsgen"]))
        );
        assert_eq!(
            build_first(&args(&["r", "--release"])),
            Some(args(&["build", "--release"]))
        );
        // The program's own arguments, even without `--`, are the program's: flags' values stay.
        assert_eq!(
            build_first(&args(&[
                "run",
                "-q",
                "foo",
                "--bin",
                "x",
                "-p",
                "y",
                "bar",
                "--release",
                "-j",
                "2"
            ])),
            Some(args(&[
                "build",
                "-q",
                "--bin",
                "x",
                "-p",
                "y",
                "--release",
                "-j",
                "2"
            ]))
        );
        assert_eq!(
            build_first(&args(&["run", "--features=a b", "-pdocsgen", "out.txt"])),
            Some(args(&["build", "--features=a b", "-pdocsgen"]))
        );
        assert_eq!(build_first(&args(&["-C", "run", "test"])), None);
        assert_eq!(build_first(&args(&["build"])), None);
    }

    #[test]
    fn only_commands_that_compile_wait() {
        for build in [
            &["build"][..],
            &["test", "-p", "fleetd", "slots"],
            &["+nightly", "clippy", "--all-targets"],
            &["-C", "crates/x", "check"],
            &["--config", "build.jobs=2", "-q", "t"],
            &["nextest", "run"],
        ] {
            assert!(heavy(&args(build)), "{build:?}");
        }
        for light in [
            &[][..],
            &["--version"],
            &["metadata", "--format-version", "1"],
            &["fmt", "--check"],
            &["run", "--", "hub"],
            &["tree"],
            &["-C", "build", "fmt"],
        ] {
            assert!(!heavy(&args(light)), "{light:?}");
        }
    }

    /// A call that only prints (a version, a command's help, `install --list`) runs at once, even with a command that
    /// compiles; the flags of a program or its tests don't count.
    #[test]
    fn trivial_calls_skip_the_slot() {
        for trivial in [
            &["--version"][..],
            &["-V"],
            &["nextest", "--version"],
            &["nextest", "run", "--help"],
            &["+nightly", "-q", "clippy", "-V"],
            &["build", "-p", "fleetd", "-h"],
            &["install", "--list"],
            &["run", "-p", "docsgen", "--help"],
        ] {
            assert!(compiles_nothing(&args(trivial)), "{trivial:?}");
            assert!(!heavy(&args(trivial)), "{trivial:?}");
        }
        for builds in [
            &["test", "--", "--help"][..],
            &["nextest", "run", "--", "-h"],
            &["run", "-p", "docsgen", "--", "--version"],
            &["run", "-q", "prog", "-h"],
            &["run", "--bin", "-h"],
            &["install", "cargo-nextest"],
        ] {
            assert!(!compiles_nothing(&args(builds)), "{builds:?}");
        }
        assert!(heavy(&args(&["test", "--", "--help"])));
    }

    #[test]
    fn the_default_is_one_slot_per_16_gb_of_memory() {
        const GIB: u64 = 1 << 30;
        // The devbox: 59.5 GB as the kernel counts it, 60 as sold.
        assert_eq!(slots_fit(Some(59 * GIB + GIB / 2)), 3);
        assert_eq!(slots_fit(Some(64 * GIB)), 4);
        assert_eq!(slots_fit(Some(32 * GIB)), 2);
        assert_eq!(slots_fit(Some(16 * GIB)), 1);
        assert_eq!(slots_fit(Some(8 * GIB)), 1);
        assert_eq!(slots_fit(Some(128 * GIB)), 8);
        assert_eq!(slots_fit(Some(256 * GIB)), 16);
        assert_eq!(slots_fit(None), 2);
    }

    /// The most memory one cargo's compilers took at once on the devbox (Nov 2026, 2 jobs, line-tables-only debug
    /// info): in one slot, fleetd's lib tests (10.6 GB by another build's high-water mark; 8.5 to 8.7 GB sampled in a
    /// check.sh run's process trees, and the rustc the OOM killer took had 9.2 GB); in two, fleetd's lib tests beside its
    /// lib and integration tests (13.1 GB at most; 9.6 GB sampled). Beside the builds, the rest of the devbox (claude,
    /// browsers, the desktop, a tmpfs /tmp) took 19 GB at the OOMs of Nov 8 and 22 GB with swap full later that day.
    const ONE_SLOT_PEAK_GB: f64 = 10.6;
    const TWO_SLOT_PEAK_GB: f64 = 13.1;
    const BESIDE_BUILDS_GB: f64 = 22.0;

    #[test]
    fn every_slot_busy_at_its_measured_peak_fits_the_machine() {
        const GIB: u64 = 1 << 30;
        let budget = MEM_PER_SLOT_GB as f64;
        assert!(ONE_SLOT_PEAK_GB <= budget && TWO_SLOT_PEAK_GB <= 2.0 * budget);
        // Every slot busy at its peak leaves a third of the machine to what runs beside the builds.
        for total in [16, 24, 32, 48, 60, 64, 96, 128, 256] {
            let slots = slots_fit(Some(total * GIB));
            let builds = slots as f64 * ONE_SLOT_PEAK_GB;
            assert!(
                builds <= total as f64 * 2.0 / 3.0,
                "{total} GB: {slots} slots at {ONE_SLOT_PEAK_GB} GB leave less than a third"
            );
        }
        // The devbox's 59.5 GB: 3 slots at their peak beside the most seen beside them. One more, #1131's 4, didn't fit.
        let devbox = slots_fit(Some(59 * GIB + GIB / 2));
        assert_eq!(devbox, 3);
        assert!(devbox as f64 * ONE_SLOT_PEAK_GB + BESIDE_BUILDS_GB <= 59.5);
        assert!((devbox + 1) as f64 * ONE_SLOT_PEAK_GB + BESIDE_BUILDS_GB > 59.5);
    }

    #[test]
    fn node_json_sets_the_slots_and_0_turns_them_off() {
        let home = tempfile::tempdir().unwrap();
        let config = |slots: &str| {
            std::fs::write(
                home.path().join("node.json"),
                format!(
                    r#"{{"hub":"http://devbox:4790","machineId":"devbox","name":"devbox","enrolled":true{slots}}}"#
                ),
            )
            .unwrap();
        };
        config(r#","buildSlots":3"#);
        assert_eq!(slots_here(home.path()), Some(3));
        config(r#","buildSlots":0"#);
        assert_eq!(slots_here(home.path()), None);
        config("");
        assert_eq!(
            slots_here(home.path()),
            Some(slots_fit(super::super::load::mem_total()))
        );
    }

    #[test]
    fn the_queued_line_says_where_it_stands() {
        assert_eq!(
            queued_line(4, 2),
            "fleetd: queued for a build slot (2 builds ahead; 4 slots on this machine): it starts once one frees"
        );
        assert!(queued_line(1, 0).contains("(next in line; 1 slot on this machine)"));
    }

    #[test]
    fn an_agent_finds_the_wrapper_first_on_its_path() {
        let home = tempfile::tempdir().unwrap();
        let mut env = vec![("PATH".to_owned(), "/usr/bin".to_owned())];
        add_to_path(home.path(), "/opt/fleetd", &mut env);
        assert_eq!(
            env[0].1,
            format!("{}:/usr/bin", bin_dir(home.path()).display())
        );
        assert!(bin_dir(home.path()).join("cargo").is_file());
    }
}
