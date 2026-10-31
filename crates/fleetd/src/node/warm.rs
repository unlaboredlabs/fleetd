//! A read or review session's worktree starts ready to test: the dependencies of the apps its commits touch installed,
//! and a warm cargo build. Reviewers that found no `node_modules` or `target/` ran no tests and left them to CI.
//!
//! The build is handed on, not shared: a reader's `target/` goes to its checkout's pool when its worktree goes, and
//! the next reader's new worktree takes the newest one by a rename, so nothing is copied and no two worktrees build
//! into one directory (cargo checks a workspace's own crates by mtime, so a shared target could hand one worktree
//! another's build). Cargo keeps a moved target's dependencies fresh; the taker's tracked files are touched so its
//! own crates always rebuild from its sources.
//!
//! A pool keeps at most `warmBuilds` targets (node.json, 2 by default): each one is a whole target, often many GB, and
//! cargo never cleans one. One that goes is first renamed out of the pool (`.gone-…`), so a reader taking it at the
//! same moment gets it whole or not at all, never half deleted. Once a day the node prunes every pool to that many,
//! drops builds older than `MAX_AGE` and what an interrupted removal left.
//!
//! Dependencies come from setup commands: the project's own when it has them, else one install per lockfile whose
//! app the commits touch, with the package manager's shared cache. Either way time-boxed and never stopping the
//! reader: a failed setup is told to it and it starts anyway.
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use fleetd_contracts::project_settings::{SETUP_COMMANDS_MAX, WorktreeSetup};
use sha2::{Digest, Sha256};

use super::worktree::git;

/// Warm targets a checkout's pool keeps unless node.json's `warmBuilds` says otherwise; a reader finishing when it is
/// full pushes the oldest out.
pub const KEEP: usize = 2;
/// A warm target older than this is pruned: its dependencies are likely stale by then.
pub const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
/// How often the node prunes the pools.
pub const PRUNE_EVERY: Duration = Duration::from_secs(24 * 3600);
/// The start of the name a target leaving its pool is renamed to before it is removed.
const GONE: &str = ".gone-";
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

/// How many warm targets each pool keeps on this machine: node.json's `warmBuilds`, else `KEEP`. 0 keeps none.
pub fn keep(home: &Path) -> usize {
    super::config::read_config(home)
        .ok()
        .flatten()
        .and_then(|c| c.warm_builds)
        .map_or(KEEP, |n| n as usize)
}

/// Every checkout's pool sits here.
fn pools(home: &Path) -> PathBuf {
    home.join("cache").join("targets")
}

/// Where the warm targets of the checkout at `root` wait: `<node home>/cache/targets/<16 hex of its path's SHA-256>`.
pub fn pool(home: &Path, root: &Path) -> PathBuf {
    let digest = Sha256::digest(root.to_string_lossy().as_bytes());
    let name: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    pools(home).join(name)
}

/// The pool's targets, newest first; none leaving it.
fn waiting(pool: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(pool) else {
        return Vec::new();
    };
    let mut all: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .collect();
    all.sort();
    all.reverse();
    all
}

/// When a target entered its pool, from its name.
fn given_at(target: &Path) -> Option<SystemTime> {
    let name = target.file_name()?.to_string_lossy();
    let nanos: u64 = name.split('-').next()?.parse().ok()?;
    Some(SystemTime::UNIX_EPOCH + Duration::from_nanos(nanos))
}

/// Takes `target` out of its pool and removes it. Renamed out first, so a reader's `take` of the same one either got
/// it whole before or finds it gone; when the reader won, nothing is removed. Whether it went.
fn evict(target: &Path) -> bool {
    let (Some(pool), Some(name)) = (target.parent(), target.file_name()) else {
        return false;
    };
    let gone = pool.join(format!("{GONE}{}", name.to_string_lossy()));
    if std::fs::rename(target, &gone).is_err() {
        return false;
    }
    // Left behind on a failure, it is out of the pool and the next prune removes it.
    if let Err(e) = std::fs::remove_dir_all(&gone) {
        tracing::warn!(target = %gone.display(), "old warm build not removed: {e}");
    }
    true
}

/// Prunes the pool to its newest `keep`, dropping those older than `MAX_AGE` at `now` and what an interrupted removal
/// left. How many went.
fn prune_pool(pool: &Path, keep: usize, now: SystemTime) -> usize {
    let mut gone = 0;
    if let Ok(entries) = std::fs::read_dir(pool) {
        for left in entries.filter_map(Result::ok) {
            if left.file_name().to_string_lossy().starts_with(GONE)
                && std::fs::remove_dir_all(left.path()).is_ok()
            {
                gone += 1;
            }
        }
    }
    for (i, target) in waiting(pool).into_iter().enumerate() {
        let old = given_at(&target)
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|age| age > MAX_AGE);
        if (i >= keep || old) && evict(&target) {
            gone += 1;
        }
    }
    gone
}

/// The node's daily cleanup: every checkout's pool pruned to `keep`, as `prune_pool`. How many targets went.
pub fn prune(home: &Path, keep: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(pools(home)) else {
        return 0;
    };
    let now = SystemTime::now();
    entries
        .filter_map(Result::ok)
        .map(|pool| prune_pool(&pool.path(), keep, now))
        .sum()
}

/// Hands the `target/` of a reader's worktree, which is about to go, to its checkout's pool, and drops the pool's
/// oldest past `keep`. With `keep` 0 it goes with the worktree.
pub fn give(home: &Path, root: &Path, worktree: &Path, keep: usize) {
    let target = worktree.join("target");
    if keep == 0 || !target.is_dir() || !worktree.join("Cargo.lock").is_file() {
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
    for old in waiting(&pool).into_iter().skip(keep) {
        evict(&old);
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
        give(home.path(), root.path(), &first, KEEP);
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
            give(home.path(), root.path(), &wt, KEEP);
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
        give(home.path(), root.path(), &plain, KEEP);
        assert!(plain.join("target").exists());
        drop_pool(home.path(), root.path());
        assert!(!pool(home.path(), root.path()).exists());
    }

    /// A target in the pool with `n` in it, given `days` ago.
    fn waiting_target(pool: &Path, days: u64, n: &str) -> PathBuf {
        let at = SystemTime::now() - Duration::from_secs(days * 24 * 3600);
        let nanos = at
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let target = pool.join(format!("{nanos:024}-1"));
        std::fs::create_dir_all(target.join("debug")).unwrap();
        std::fs::write(target.join("n"), n).unwrap();
        target
    }

    #[test]
    fn the_cap_comes_from_node_json_and_two_by_default() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(keep(home.path()), 2);
        let config = |extra: &str| {
            std::fs::write(
                home.path().join("node.json"),
                format!(
                    r#"{{"hub":"http://devbox:4790","machineId":"m1","name":"devbox","tags":[],"enrolled":true{extra}}}"#
                ),
            )
            .unwrap();
        };
        config("");
        assert_eq!(keep(home.path()), 2);
        config(r#","warmBuilds":5"#);
        assert_eq!(keep(home.path()), 5);
        config(r#","warmBuilds":0"#);
        assert_eq!(keep(home.path()), 0);
        // None kept: a reader's build goes with its worktree.
        let wt = home.path().join("wt");
        std::fs::create_dir_all(wt.join("target")).unwrap();
        std::fs::write(wt.join("Cargo.lock"), "lock").unwrap();
        give(home.path(), Path::new("/src/app"), &wt, 0);
        assert!(wt.join("target").exists());
        assert!(waiting(&pool(home.path(), Path::new("/src/app"))).is_empty());
    }

    #[test]
    fn the_daily_prune_keeps_the_newest_young_ones_in_every_pool() {
        let home = tempfile::tempdir().unwrap();
        let a = pool(home.path(), Path::new("/src/a"));
        let b = pool(home.path(), Path::new("/src/b"));
        for (days, n) in [(0, "a0"), (1, "a1"), (2, "a2"), (3, "a3")] {
            waiting_target(&a, days, n);
        }
        waiting_target(&b, 0, "b0");
        waiting_target(&b, 8, "b-old");
        // What a removal cut off in the middle left behind.
        std::fs::create_dir_all(b.join(".gone-000-1/debug")).unwrap();
        assert_eq!(prune(home.path(), 2), 2 + 1 + 1);
        let left = |pool: &Path| -> Vec<String> {
            waiting(pool)
                .iter()
                .map(|t| std::fs::read_to_string(t.join("n")).unwrap())
                .collect()
        };
        assert_eq!(left(&a), ["a0", "a1"]);
        assert_eq!(
            left(&b),
            ["b0"],
            "older than a week goes even under the cap"
        );
        assert_eq!(std::fs::read_dir(&b).unwrap().count(), 1, "no leftovers");
        assert_eq!(prune(home.path(), 2), 0);
        assert_eq!(prune(&home.path().join("none"), 2), 0);
    }

    /// The reviewer's race: the pool trimmed while a reader takes the same target. Each side renames it, so exactly
    /// one wins: the reader gets it whole, or the eviction removes it and the reader takes another or none.
    #[test]
    fn a_target_leaving_the_pool_is_never_taken_half_removed() {
        let home = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        checkout(root.path(), "src/lib.rs");
        let pool = pool(home.path(), root.path());
        let reader = |name: &str| {
            let path = root.path().join("wt").join(name);
            sh(
                root.path(),
                &format!("git worktree add -q --detach {} HEAD", path.display()),
            );
            path
        };
        // The reader won: the eviction finds it gone and removes nothing.
        waiting_target(&pool, 1, "older");
        let newest = waiting_target(&pool, 0, "newest");
        let first = reader("first");
        assert!(take(home.path(), root.path(), &first));
        assert!(!evict(&newest));
        assert_eq!(
            std::fs::read_to_string(first.join("target/n")).unwrap(),
            "newest"
        );
        assert!(first.join("target/debug").is_dir());
        // The eviction won: it is out of the pool before any of it is removed, so the reader takes the next.
        let newer = waiting_target(&pool, 0, "newer");
        let gone = pool.join(format!(
            "{GONE}{}",
            newer.file_name().unwrap().to_string_lossy()
        ));
        std::fs::rename(&newer, &gone).unwrap();
        let second = reader("second");
        assert!(take(home.path(), root.path(), &second));
        assert_eq!(
            std::fs::read_to_string(second.join("target/n")).unwrap(),
            "older"
        );
        // A half-removed one is never handed out, and the prune clears it.
        let third = reader("third");
        assert!(!take(home.path(), root.path(), &third));
        assert!(!third.join("target").exists());
        assert!(gone.exists());
        assert_eq!(prune(home.path(), KEEP), 1);
        assert!(!gone.exists());
    }
}
