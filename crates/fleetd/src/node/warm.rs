//! A read or review session's worktree starts ready to test: the dependencies of the apps its commits touch installed,
//! and a warm cargo build. Reviewers that found no `node_modules` or `target/` ran no tests and left them to CI.
//!
//! The build is handed on, not shared: a reader's `target/` goes to its checkout's pool when its worktree goes, and
//! the next reader's new worktree takes the newest one by a rename, so nothing is copied and no two worktrees build
//! into one directory (cargo checks a workspace's own crates by mtime, so a shared target could hand one worktree
//! another's build). Cargo keeps a moved target's dependencies fresh; the taker's tracked files are touched so its
//! own crates always rebuild from its sources.
//!
//! Dependencies come from setup commands: the project's own when it has them, else one install per lockfile whose
//! app the commits touch, with the package manager's shared cache. Either way time-boxed and never stopping the
//! reader: a failed setup is told to it and it starts anyway.
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use fleetd_contracts::project_settings::{SETUP_COMMANDS_MAX, WorktreeSetup};
use sha2::{Digest, Sha256};

use super::worktree::git;

/// Warm targets a checkout's pool keeps; a reader finishing when it is full pushes the oldest out.
pub const KEEP: usize = 3;
/// Each of a reader's setup commands' time limit, at most.
pub const SETUP_LIMIT_SEC: i64 = 300;

/// Lockfiles a reader's setup installs from, each with its install command: the store or cache each package manager
/// keeps per user makes it a link or copy of what an earlier install fetched.
const INSTALLS: [(&str, &str); 4] = [
    (
        "pnpm-lock.yaml",
        "pnpm install --frozen-lockfile --prefer-offline",
    ),
    (
        "package-lock.json",
        "npm ci --prefer-offline --no-audit --no-fund",
    ),
    (
        "yarn.lock",
        "yarn install --frozen-lockfile --prefer-offline",
    ),
    ("bun.lock", "bun install --frozen-lockfile"),
];

/// Where the warm targets of the checkout at `root` wait: `<node home>/cache/targets/<16 hex of its path's SHA-256>`.
pub fn pool(home: &Path, root: &Path) -> PathBuf {
    let digest = Sha256::digest(root.to_string_lossy().as_bytes());
    let name: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    home.join("cache").join("targets").join(name)
}

/// The pool's targets, newest first.
fn waiting(pool: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(pool) else {
        return Vec::new();
    };
    let mut all: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).collect();
    all.sort();
    all.reverse();
    all
}

/// Hands the `target/` of a reader's worktree, which is about to go, to its checkout's pool, and drops the pool's
/// oldest past `KEEP`.
pub fn give(home: &Path, root: &Path, worktree: &Path) {
    let target = worktree.join("target");
    if !target.is_dir() || !worktree.join("Cargo.lock").is_file() {
        return;
    }
    let pool = pool(home, root);
    if let Err(e) = std::fs::create_dir_all(&pool) {
        tracing::warn!(pool = %pool.display(), "warm build pool not made: {e}");
        return;
    }
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let to = pool.join(format!("{nanos:024}-{}", std::process::id()));
    if let Err(e) = std::fs::rename(&target, &to) {
        tracing::warn!(target = %target.display(), "warm build not handed on: {e}");
        return;
    }
    for old in waiting(&pool).into_iter().skip(KEEP) {
        if let Err(e) = std::fs::remove_dir_all(&old) {
            tracing::warn!(target = %old.display(), "old warm build not removed: {e}");
        }
    }
}

/// Gives a reader's new worktree without a `target/` the newest of its checkout's pool, and touches its tracked files
/// so cargo rebuilds its own crates from them however recent the build. Whether it got one.
pub fn take(home: &Path, root: &Path, worktree: &Path) -> bool {
    let target = worktree.join("target");
    if target.exists() || !worktree.join("Cargo.lock").is_file() {
        return false;
    }
    // Another reader starting at the same time may take one first: the next is tried.
    let Some(_) = waiting(&pool(home, root))
        .into_iter()
        .find(|warm| std::fs::rename(warm, &target).is_ok())
    else {
        return false;
    };
    touch(worktree);
    true
}

/// Sets every tracked file's mtime to now.
fn touch(worktree: &Path) {
    let Ok(files) = git(worktree, &["ls-files", "-z"]) else {
        return;
    };
    let now = SystemTime::now();
    for file in files.split('\0').filter(|f| !f.is_empty()) {
        let path = worktree.join(file);
        if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file()) {
            continue;
        }
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&path) {
            let _ = f.set_modified(now);
        }
    }
}

/// Drops the warm targets of a checkout that is going.
pub fn drop_pool(home: &Path, root: &Path) {
    let pool = pool(home, root);
    match std::fs::remove_dir_all(&pool) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            tracing::warn!(pool = %pool.display(), "warm builds not removed: {e}");
        }
        _ => {}
    }
}

/// What a reader's worktree at `cwd` is set up with: the project's commands (`project`) when it has some, else an
/// install for each tracked lockfile in a directory the commits since `base` touched. Each command at most
/// `SETUP_LIMIT_SEC`, and a failure starts the reader anyway. `None`: nothing to set up.
pub fn reader_setup(
    project: Option<WorktreeSetup>,
    cwd: &Path,
    base: &str,
) -> Option<WorktreeSetup> {
    let mut setup = match project.filter(|s| !s.is_empty()) {
        Some(own) => own,
        None => installs(cwd, base)?,
    };
    setup.run_anyway = true;
    if setup.timeout_sec.get() > SETUP_LIMIT_SEC {
        setup.timeout_sec = fleetd_contracts::prim::Int::unchecked(SETUP_LIMIT_SEC);
    }
    Some(setup)
}

/// An install for each tracked lockfile whose directory holds a file the commits since `base` changed.
fn installs(cwd: &Path, base: &str) -> Option<WorktreeSetup> {
    let changed = git(cwd, &["diff", "--name-only", &format!("{base}...HEAD")]).ok()?;
    let changed: Vec<&str> = changed.lines().filter(|l| !l.is_empty()).collect();
    if changed.is_empty() {
        return None;
    }
    let tracked = git(cwd, &["ls-files", "-z"]).ok()?;
    let mut commands = Vec::new();
    let mut inputs = Vec::new();
    for lockfile in tracked.split('\0') {
        let (dir, name) = match lockfile.rsplit_once('/') {
            Some((dir, name)) => (dir, name),
            None => ("", lockfile),
        };
        let Some((_, install)) = INSTALLS.iter().find(|(l, _)| *l == name) else {
            continue;
        };
        let touched = dir.is_empty()
            || changed.iter().any(|f| {
                f.strip_prefix(dir)
                    .is_some_and(|rest| rest.starts_with('/'))
            });
        if !touched || commands.len() == SETUP_COMMANDS_MAX {
            continue;
        }
        let command = if dir.is_empty() {
            (*install).to_owned()
        } else {
            format!("cd {} && {install}", quote(dir))
        };
        let (Ok(command), Ok(input)) = (
            fleetd_contracts::project_settings::SetupCommand::new(command),
            fleetd_contracts::project_settings::SetupInput::new(lockfile),
        ) else {
            continue;
        };
        commands.push(command);
        inputs.push(input);
    }
    if commands.is_empty() {
        return None;
    }
    Some(WorktreeSetup {
        commands: commands.try_into().ok()?,
        inputs: inputs.try_into().ok()?,
        ..Default::default()
    })
}

/// `text` in single quotes for `sh`.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, script: &str) {
        let ok = std::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .status()
            .unwrap()
            .success();
        assert!(ok, "{script}");
    }

    /// A checkout with a cargo workspace, a pnpm app and an npm app, and a commit on top of `base` touching `touch`.
    fn checkout(dir: &Path, touch: &str) -> String {
        sh(
            dir,
            "git init -q -b main . && mkdir -p app/desktop app/mobile src \
             && echo lock > Cargo.lock && echo a > app/desktop/pnpm-lock.yaml \
             && echo b > app/mobile/package-lock.json && echo c > src/lib.rs \
             && echo d > app/desktop/main.ts && echo e > app/mobile/main.ts \
             && git add -A && git commit -qm base",
        );
        let base = git(dir, &["rev-parse", "HEAD"]).unwrap().trim().to_owned();
        sh(
            dir,
            &format!("echo more >> {touch} && git commit -qam change"),
        );
        base
    }

    fn commands(setup: &WorktreeSetup) -> Vec<String> {
        setup.commands.iter().map(|c| c.to_string()).collect()
    }

    #[test]
    fn a_reader_installs_only_the_apps_its_commits_touch() {
        let dir = tempfile::tempdir().unwrap();
        let base = checkout(dir.path(), "app/desktop/main.ts");
        let setup = reader_setup(None, dir.path(), &base).unwrap();
        assert_eq!(
            commands(&setup),
            ["cd 'app/desktop' && pnpm install --frozen-lockfile --prefer-offline"]
        );
        assert_eq!(
            setup
                .inputs
                .iter()
                .map(|i| i.to_string())
                .collect::<Vec<_>>(),
            ["app/desktop/pnpm-lock.yaml"]
        );
        assert!(setup.run_anyway, "a failed install still starts the reader");
        assert_eq!(setup.timeout_sec.get(), SETUP_LIMIT_SEC);
        // A Rust-only change installs nothing; no commits since the base neither.
        let rust = tempfile::tempdir().unwrap();
        let base = checkout(rust.path(), "src/lib.rs");
        assert_eq!(reader_setup(None, rust.path(), &base), None);
        let head = git(rust.path(), &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(reader_setup(None, rust.path(), head.trim()), None);
    }

    #[test]
    fn the_projects_own_setup_runs_time_boxed_and_never_stops_the_reader() {
        let dir = tempfile::tempdir().unwrap();
        let base = checkout(dir.path(), "app/mobile/main.ts");
        let own: WorktreeSetup = serde_json::from_value(serde_json::json!({
            "commands": ["make deps"], "timeoutSec": 1800, "runAnyway": false
        }))
        .unwrap();
        let setup = reader_setup(Some(own), dir.path(), &base).unwrap();
        assert_eq!(commands(&setup), ["make deps"]);
        assert!(setup.run_anyway);
        assert_eq!(setup.timeout_sec.get(), SETUP_LIMIT_SEC);
        // An empty one is none: the lockfiles decide.
        let setup = reader_setup(Some(WorktreeSetup::default()), dir.path(), &base).unwrap();
        assert_eq!(
            commands(&setup),
            ["cd 'app/mobile' && npm ci --prefer-offline --no-audit --no-fund"]
        );
    }

    #[test]
    fn a_finished_readers_build_goes_to_the_next_reader_and_its_sources_rebuild() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        checkout(root.path(), "src/lib.rs");
        let wt = |name: &str| {
            let path = root.path().join("wt").join(name);
            sh(
                root.path(),
                &format!("git worktree add -q --detach {} HEAD", path.display()),
            );
            path
        };
        let first = wt("first");
        // Nothing waits yet.
        assert!(!take(home.path(), root.path(), &first));
        std::fs::create_dir_all(first.join("target/debug")).unwrap();
        std::fs::write(first.join("target/debug/built"), "x").unwrap();
        give(home.path(), root.path(), &first);
        assert!(!first.join("target").exists());
        assert_eq!(waiting(&pool(home.path(), root.path())).len(), 1);

        let second = wt("second");
        let source = second.join("src/lib.rs");
        let before = std::fs::metadata(&source).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(take(home.path(), root.path(), &second));
        assert_eq!(
            std::fs::read_to_string(second.join("target/debug/built")).unwrap(),
            "x"
        );
        assert!(std::fs::metadata(&source).unwrap().modified().unwrap() > before);
        assert!(waiting(&pool(home.path(), root.path())).is_empty());
        // A worktree with a target of its own keeps it, and another checkout's pool is its own.
        assert!(!take(home.path(), root.path(), &second));
        assert_ne!(pool(home.path(), root.path()), pool(home.path(), &first));
    }

    #[test]
    fn the_pool_keeps_the_newest_few_and_goes_with_its_checkout() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        checkout(root.path(), "src/lib.rs");
        for i in 0..KEEP + 2 {
            let wt = root.path().join(format!("wt{i}"));
            std::fs::create_dir_all(wt.join("target")).unwrap();
            std::fs::write(wt.join("Cargo.lock"), "lock").unwrap();
            std::fs::write(wt.join("target/n"), i.to_string()).unwrap();
            give(home.path(), root.path(), &wt);
        }
        let left = waiting(&pool(home.path(), root.path()));
        assert_eq!(left.len(), KEEP);
        assert_eq!(
            std::fs::read_to_string(left[0].join("n")).unwrap(),
            (KEEP + 1).to_string(),
            "the newest first"
        );
        // A worktree without a Cargo.lock has no build to hand on.
        let plain = root.path().join("plain");
        std::fs::create_dir_all(plain.join("target")).unwrap();
        give(home.path(), root.path(), &plain);
        assert!(plain.join("target").exists());
        drop_pool(home.path(), root.path());
        assert!(!pool(home.path(), root.path()).exists());
    }
}
