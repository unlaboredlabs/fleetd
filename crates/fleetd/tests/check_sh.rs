//! scripts/check.sh's keys (`--keys`), in a throwaway repo holding a copy of it: a check's pass holds for any tree with
//! the same key, so a change keeps every key but those of the checks that read it. check.sh is the Linux pre-push check.
#![cfg(target_os = "linux")]
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

struct Repo {
    dir: tempfile::TempDir,
}

impl Repo {
    /// check.sh and .github/rust-scope.sh, a Rust crate, the desktop app (a screen, its QA), the site and a README,
    /// committed.
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repo { dir };
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for script in ["scripts/check.sh", ".github/rust-scope.sh"] {
            repo.write(script, &std::fs::read_to_string(root.join(script)).unwrap());
        }
        for (path, text) in [
            ("crates/a/src/lib.rs", "pub fn a() {}\n"),
            ("Cargo.toml", "[workspace]\n"),
            ("app/desktop/src/renderer/Screen.tsx", "export {};\n"),
            ("app/desktop/qa/screen.spec.ts", "export {};\n"),
            ("crates/fleetd-contracts/schema/hello.json", "{}\n"),
            ("docs/site/src/content/docs/index.md", "# fleetd\n"),
            ("README.md", "fleetd\n"),
            (".gitignore", "target/\n"),
        ] {
            repo.write(path, text);
        }
        std::fs::create_dir_all(repo.dir.path().join("tmp")).unwrap();
        repo.git(&["init", "-q"]);
        repo.git(&["add", "-A"]);
        repo.git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@devbox",
            "commit",
            "-qm",
            "start",
        ]);
        repo
    }

    /// The repo: beside the TMPDIR check.sh makes its scratch files in.
    fn root(&self) -> PathBuf {
        self.dir.path().join("repo")
    }

    fn path(&self, path: &str) -> PathBuf {
        self.root().join(path)
    }

    fn write(&self, path: &str, text: &str) {
        let path = self.path(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn git(&self, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(self.root())
            .env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_WORK_TREE")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    /// `scripts/check.sh --keys`: each check's key on the worktree's tree.
    fn keys(&self) -> BTreeMap<String, String> {
        let out = Command::new("bash")
            .args(["scripts/check.sh", "--keys"])
            .current_dir(self.root())
            .env_remove("GIT_DIR")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_WORK_TREE")
            .env("TMPDIR", self.dir.path().join("tmp"))
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
        String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(|l| {
                let (check, key) = l.split_once(' ').unwrap();
                (check.to_owned(), key.to_owned())
            })
            .collect()
    }

    /// The checks whose key differs from `before`'s.
    fn changed_since(&self, before: &BTreeMap<String, String>) -> Vec<String> {
        let now = self.keys();
        assert_eq!(now.len(), 6, "{now:?}");
        now.into_iter()
            .filter(|(check, key)| before.get(check) != Some(key))
            .map(|(check, _)| check)
            .collect()
    }
}

#[test]
fn a_change_keeps_the_keys_of_the_checks_that_dont_read_it() {
    let repo = Repo::new();
    let start = repo.keys();
    assert_eq!(start["rust-lint"], start["rust-tests"]);
    // Nothing changed, nothing ignored counts.
    repo.write("target/debug/fleetd", "built\n");
    assert!(repo.changed_since(&start).is_empty());
    // A desktop test fix: the Rust checks and the site keep their keys.
    repo.write("app/desktop/qa/screen.spec.ts", "export const x = 1;\n");
    assert_eq!(repo.changed_since(&start), ["desktop", "qa"]);
    let desktop_fixed = repo.keys();
    // A Rust change, untracked: the Rust checks and the site (its `fleetd help`); desktop for the new path's name.
    repo.write("crates/a/src/new.rs", "\n");
    assert_eq!(
        repo.changed_since(&desktop_fixed),
        ["desktop", "rust-docs", "rust-lint", "rust-tests", "site"]
    );
    let rust_added = repo.keys();
    // An edit outside every check's inputs changes no key; a new file there, only desktop's (its case clashes).
    repo.write("README.md", "fleetd, edited\n");
    assert!(repo.changed_since(&rust_added).is_empty());
    repo.write("NOTES.md", "\n");
    assert_eq!(repo.changed_since(&rust_added), ["desktop"]);
    // The hub's schemas, which the QA fixtures read, are Rust inputs too.
    let notes = repo.keys();
    repo.write("crates/fleetd-contracts/schema/hello.json", "{\"a\":1}\n");
    assert_eq!(
        repo.changed_since(&notes),
        ["qa", "rust-docs", "rust-lint", "rust-tests", "site"]
    );
    // check.sh itself is every check's input.
    let schema = repo.keys();
    let script = std::fs::read_to_string(repo.path("scripts/check.sh")).unwrap();
    repo.write("scripts/check.sh", &format!("{script}\n"));
    assert_eq!(repo.changed_since(&schema).len(), 6);
    // Committed, the same tree has the same keys.
    let edited = repo.keys();
    repo.git(&["add", "-A"]);
    repo.git(&[
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@devbox",
        "commit",
        "-qm",
        "edit",
    ]);
    assert!(repo.changed_since(&edited).is_empty());
}
