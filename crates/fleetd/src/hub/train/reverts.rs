//! A PR that would undo work already on its base. A writer that moves its commit onto a freshly fetched main while its
//! files are still an older tree's commits those older files: each one is, byte for byte, a version main had before
//! someone changed it. Two exact steps find that, so ordinary edits, renames and new files never match:
//! - a file the PR changes is put back when its blob in the PR equals the file's blob after one of its last `DEPTH`
//!   earlier changes on the base, from no later than the PR's merge base, while the base's current blob differs; the
//!   base's commits that changed it since are the ones it undoes;
//! - such a commit counts only when the PR puts back at least half the files it changed (a file it added counts as
//!   put back when the PR deletes it): a PR that takes back one line of a big commit on purpose is not a stale tree.
//!
//! Such a PR goes back to its writer before review, with the files and the base's commits it would undo, unless its
//! title or body says it reverts named commits or PRs. scripts/reverts.sh is the same rule over a local checkout, for
//! writers before they push: keep the two in step.
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use super::github::{GhError, TrainGitHub};

/// How many of a file's earlier changes on the base are looked at, besides its newest.
pub const DEPTH: usize = 10;
/// Files per GraphQL query.
const CHUNK: usize = 50;
/// The most commits whose files are read; the rest never count.
const COMMITS: usize = 30;
/// The most files a message names one by one.
const NAMED: usize = 20;

/// A file as one change on the base left it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub commit: String,
    pub subject: String,
    /// The commit's committer time, Unix seconds.
    pub at: i64,
    /// None where the change deleted it.
    pub blob: Option<String>,
}

/// A file the PR puts back to an older version, and the base's commits that changed it since, newest first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Restore {
    pub path: String,
    pub undone: Vec<Version>,
}

/// The base's commits a PR's `blob` of a file would undo: `history` is the file's changes on the base, newest first
/// (`DEPTH` + 1 of them at most), `merge_base_at` the merge base's committer time. None for anything but an exact
/// restore of an older version from no later than the merge base.
pub fn undone(blob: &str, merge_base_at: i64, history: &[Version]) -> Option<Vec<Version>> {
    let (newest, older) = history.split_first()?;
    if newest.blob.as_deref() == Some(blob) {
        return None;
    }
    let k = older
        .iter()
        .take(DEPTH)
        .position(|v| v.blob.as_deref() == Some(blob) && v.at <= merge_base_at)?;
    Some(history[..=k].to_vec())
}

/// The files a commit changed, each with whether it added it: a rename is its old path and its new one, added.
pub type Touched = Vec<(String, bool)>;

/// `restores` kept to the commits the PR undoes: those it puts back at least half the files of, counting a file the
/// commit added as put back when the PR deletes it (`deleted`). A commit missing from `touched` doesn't count.
pub fn counted(
    restores: Vec<Restore>,
    deleted: &HashSet<String>,
    touched: &HashMap<String, Touched>,
) -> Vec<Restore> {
    let undoes = |commit: &str| {
        let Some(files) = touched.get(commit).filter(|f| !f.is_empty()) else {
            return false;
        };
        let back = files
            .iter()
            .filter(|(path, added)| {
                (*added && deleted.contains(path))
                    || restores
                        .iter()
                        .any(|r| &r.path == path && r.undone.iter().any(|v| v.commit == commit))
            })
            .count();
        back * 2 >= files.len()
    };
    let commits: HashSet<&str> = restores
        .iter()
        .flat_map(|r| r.undone.iter().map(|v| v.commit.as_str()))
        .filter(|c| undoes(c))
        .collect();
    let mut kept: Vec<Restore> = restores
        .iter()
        .map(|r| Restore {
            path: r.path.clone(),
            undone: r
                .undone
                .iter()
                .filter(|v| commits.contains(v.commit.as_str()))
                .cloned()
                .collect(),
        })
        .collect();
    kept.retain(|r| !r.undone.is_empty());
    kept
}

/// The PR's title or body says it reverts named commits or PRs: "revert" and, later on the same line, a `#<n>` or a
/// commit's hex.
pub fn deliberate(text: &str) -> bool {
    static REVERT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)revert.*(#[0-9]+|\b[0-9a-f]{7,40}\b)").expect("the revert pattern")
    });
    REVERT.is_match(text)
}

/// The files, the base's commits they undo and the fix, for the writer.
pub fn details(restores: &[Restore], base: &str) -> String {
    let mut commits: Vec<&Version> = Vec::new();
    for v in restores.iter().flat_map(|r| &r.undone) {
        if !commits.iter().any(|c| c.commit == v.commit) {
            commits.push(v);
        }
    }
    let mut text = format!("Files back to an older version of {base}'s:\n");
    for r in restores.iter().take(NAMED) {
        let shas: Vec<&str> = r.undone.iter().map(|v| short(&v.commit)).collect();
        text.push_str(&format!("- {} (undoes {})\n", r.path, shas.join(", ")));
    }
    if restores.len() > NAMED {
        text.push_str(&format!("- and {} more\n", restores.len() - NAMED));
    }
    text.push_str(&format!("\nCommits of {base} it would undo:\n"));
    for c in &commits {
        text.push_str(&format!("- {} {}\n", short(&c.commit), c.subject));
    }
    text.push_str(&format!(
        "\nYour commit carries files from an older {base}. Rebuild your branch on origin/{base} and re-apply only \
         your own changes: `git fetch origin && git checkout -B <branch> origin/{base}`, redo your edits there, check \
         `git diff origin/{base}` shows only them, then force-push. If you mean to revert those commits, say so in \
         the PR's title or body, naming them or their PRs, then push a new head (amending your commit's message is \
         enough): the train checks again only when the head moves."
    ));
    text
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(9)]
}

/// The PR's restores of files on `base` (a branch), kept to the commits it undoes, from GitHub: the PR's files and
/// merge base from one compare, the files' histories on the base from one GraphQL query per `CHUNK` files, and each
/// candidate commit's files from one call.
pub async fn restores(
    github: &TrainGitHub,
    repo: &str,
    base: &str,
    head: &str,
) -> Result<Vec<Restore>, GhError> {
    #[derive(Deserialize)]
    struct Committer {
        date: String,
    }
    #[derive(Deserialize)]
    struct Meta {
        committer: Committer,
    }
    #[derive(Deserialize)]
    struct Commit {
        sha: String,
        commit: Meta,
    }
    #[derive(Deserialize)]
    struct Compare {
        base_commit: Commit,
        merge_base_commit: Commit,
        #[serde(default)]
        files: Vec<File>,
    }
    let path = format!("repos/{repo}/compare/{base}...{head}");
    let compare: Compare = get(github, &path).await?;
    let merge_base_at = seconds(&compare.merge_base_commit.commit.committer.date)
        .ok_or_else(|| GhError::failed(format!("gh api {path}: no merge base time")))?;
    let mut deleted = HashSet::new();
    let mut changed: Vec<(String, String)> = Vec::new();
    for f in compare.files {
        deleted.extend(f.previous_filename);
        match (f.status.as_str(), f.sha) {
            ("removed", _) => {
                deleted.insert(f.filename);
            }
            (_, Some(sha)) => changed.push((f.filename, sha.to_lowercase())),
            _ => {}
        }
    }
    let (owner, name) = repo.split_once('/').unwrap_or((repo, ""));
    let mut restores = Vec::new();
    for chunk in changed.chunks(CHUNK) {
        let histories = histories(github, owner, name, &compare.base_commit.sha, chunk).await?;
        for ((path, blob), history) in chunk.iter().zip(histories) {
            if let Some(undone) = undone(blob, merge_base_at, &history) {
                restores.push(Restore {
                    path: path.clone(),
                    undone,
                });
            }
        }
    }
    let mut touched = HashMap::new();
    for r in &restores {
        for v in &r.undone {
            if touched.len() < COMMITS && !touched.contains_key(&v.commit) {
                let path = format!("repos/{repo}/commits/{}", v.commit);
                let commit: CommitFiles = get(github, &path).await?;
                touched.insert(v.commit.clone(), commit.touched());
            }
        }
    }
    Ok(counted(restores, &deleted, &touched))
}

#[derive(Deserialize)]
struct File {
    filename: String,
    #[serde(default)]
    previous_filename: Option<String>,
    sha: Option<String>,
    status: String,
}

#[derive(Deserialize)]
struct CommitFiles {
    #[serde(default)]
    files: Vec<File>,
}

impl CommitFiles {
    fn touched(self) -> Touched {
        let mut touched = Vec::new();
        for f in self.files {
            if let Some(old) = f.previous_filename {
                touched.push((old, false));
            }
            let added = matches!(f.status.as_str(), "added" | "renamed" | "copied");
            touched.push((f.filename, added));
        }
        touched
    }
}

async fn get<T: serde::de::DeserializeOwned>(
    github: &TrainGitHub,
    path: &str,
) -> Result<T, GhError> {
    match github.get(path).await? {
        Ok(v) => serde_json::from_value(v)
            .map_err(|_| GhError::failed(format!("gh api {path} returned an unexpected shape"))),
        Err((_, message)) => Err(GhError::failed(format!("gh api {path} failed: {message}"))),
    }
}

/// Each file's last `DEPTH` + 1 changes on the commit `at`, newest first.
async fn histories(
    github: &TrainGitHub,
    owner: &str,
    name: &str,
    at: &str,
    files: &[(String, String)],
) -> Result<Vec<Vec<Version>>, GhError> {
    let mut vars: Vec<(String, String)> = vec![
        ("owner".into(), owner.into()),
        ("name".into(), name.into()),
        ("at".into(), at.into()),
    ];
    let mut params = String::from("$owner:String!,$name:String!,$at:String!");
    let mut fields = String::new();
    for (i, (path, _)) in files.iter().enumerate() {
        vars.push((format!("p{i}"), path.clone()));
        params.push_str(&format!(",$p{i}:String!"));
        fields.push_str(&format!(
            " f{i}:history(first:{},path:$p{i}){{nodes{{oid messageHeadline committedDate file(path:$p{i}){{oid}}}}}}",
            DEPTH + 1
        ));
    }
    let query = format!(
        "query({params}){{repository(owner:$owner,name:$name){{object(expression:$at){{...on Commit{{{fields}}}}}}}}}"
    );
    let vars: Vec<(&str, &str)> = vars.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let data = github.graphql(&query, &vars).await?;
    let commit = &data["repository"]["object"];
    Ok((0..files.len())
        .map(|i| {
            commit[format!("f{i}")]["nodes"]
                .as_array()
                .map(|nodes| nodes.iter().filter_map(version).collect())
                .unwrap_or_default()
        })
        .collect())
}

fn version(node: &Value) -> Option<Version> {
    Some(Version {
        commit: node["oid"].as_str()?.to_lowercase(),
        subject: node["messageHeadline"].as_str().unwrap_or_default().into(),
        at: seconds(node["committedDate"].as_str()?)?,
        blob: node["file"]["oid"].as_str().map(str::to_lowercase),
    })
}

fn seconds(iso: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|t| t.timestamp())
}

/// For a fake GitHub over a real repo: `histories`' GraphQL answer, a path's changes read by `git` in `repo`.
#[cfg(test)]
pub fn answer(repo: &std::path::Path, vars: &HashMap<&str, &str>) -> Value {
    let at = vars.get("at").copied().unwrap_or("main");
    let mut fields = serde_json::Map::new();
    for i in 0.. {
        let Some(path) = vars.get(format!("p{i}").as_str()) else {
            break;
        };
        let nodes: Vec<Value> = git_history(repo, at, path)
            .into_iter()
            .map(|v| {
                let at = chrono::DateTime::from_timestamp(v.at, 0).unwrap_or_default();
                let file = v.blob.map(|b| serde_json::json!({ "oid": b }));
                serde_json::json!({ "oid": v.commit, "messageHeadline": v.subject, "committedDate": at.to_rfc3339(), "file": file })
            })
            .collect();
        fields.insert(format!("f{i}"), serde_json::json!({ "nodes": nodes }));
    }
    serde_json::json!({ "data": { "repository": { "object": fields } } })
}

/// `path`'s last `DEPTH` + 1 changes on `at` in `repo`, newest first, as GitHub's history gives them.
#[cfg(test)]
pub fn git_history(repo: &std::path::Path, at: &str, path: &str) -> Vec<Version> {
    let depth = (DEPTH + 1).to_string();
    let log = git(
        repo,
        &[
            "log",
            "-n",
            &depth,
            "--first-parent",
            "--format=C %H %ct %s",
            "--raw",
            "--no-abbrev",
            "--no-renames",
            at,
            "--",
            path,
        ],
    );
    let mut versions: Vec<Version> = Vec::new();
    for line in log.lines() {
        if let Some(rest) = line.strip_prefix("C ") {
            let mut parts = rest.splitn(3, ' ');
            let (commit, at, subject) = (parts.next(), parts.next(), parts.next());
            versions.push(Version {
                commit: commit.unwrap_or_default().into(),
                subject: subject.unwrap_or_default().into(),
                at: at.and_then(|t| t.parse().ok()).unwrap_or_default(),
                blob: None,
            });
        } else if line.starts_with(':')
            && let Some(v) = versions.last_mut()
        {
            v.blob = line
                .split_whitespace()
                .nth(3)
                .filter(|b| b.bytes().any(|c| c != b'0'))
                .map(String::from);
        }
    }
    versions
}

/// A commit's files in `repo`, as GitHub's commit gives them, for a fake GitHub.
#[cfg(test)]
pub fn git_commit_files(repo: &std::path::Path, sha: &str) -> Value {
    let files: Vec<Value> = git(
        repo,
        &["show", "--format=", "--name-status", "--no-renames", sha],
    )
    .lines()
    .filter_map(|l| l.split_once('\t'))
    .map(|(status, path)| {
        let status = match status {
            "A" => "added",
            "D" => "removed",
            _ => "modified",
        };
        serde_json::json!({ "filename": path, "status": status })
    })
    .collect();
    serde_json::json!({ "sha": sha, "files": files })
}

#[cfg(test)]
fn git(repo: &std::path::Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use super::*;

    fn v(commit: &str, at: i64, blob: Option<&str>) -> Version {
        Version {
            commit: commit.into(),
            subject: format!("{commit} subject"),
            at,
            blob: blob.map(String::from),
        }
    }

    #[test]
    fn undone_is_an_exact_older_version_from_no_later_than_the_merge_base() {
        let history = [
            v("c3", 30, Some("b3")),
            v("c2", 20, Some("b2")),
            v("c1", 10, Some("b1")),
        ];
        let commits = |u: Option<Vec<Version>>| {
            u.map(|u| u.into_iter().map(|v| v.commit).collect::<Vec<_>>())
        };
        assert_eq!(
            commits(undone("b1", 30, &history)),
            Some(vec!["c3".into(), "c2".into()])
        );
        assert_eq!(commits(undone("b2", 30, &history)), Some(vec!["c3".into()]));
        // The base's own version, a new one, or one main reached only after the merge base: none.
        assert_eq!(undone("b3", 30, &history), None);
        assert_eq!(undone("b9", 30, &history), None);
        assert_eq!(undone("b2", 15, &history), None);
        assert_eq!(undone("b1", 30, &[]), None);
    }

    #[test]
    fn deliberate_names_what_it_reverts() {
        assert!(deliberate("Revert #904 and #907"));
        assert!(deliberate("chore: revert 447cab29c, it broke the build"));
        assert!(deliberate(
            "fix: x\n\nThis reverts commit 447cab29c86a982a2eed0af3a5774e433a33996c."
        ));
        assert!(!deliberate("feat: talk to your Navi from Telegram (W237)"));
        assert!(!deliberate("revert the sidebar change"));
        assert!(!deliberate("Closes #12\nrevert nothing"));
    }

    /// A repo whose commits are a minute apart, as a base's are.
    struct Repo {
        dir: tempfile::TempDir,
        commits: std::cell::Cell<i64>,
    }

    impl Repo {
        fn path(&self) -> &Path {
            self.dir.path()
        }

        fn git(&self, args: &[&str]) -> String {
            let at = format!("@{} +0000", 1_790_000_000 + 60 * self.commits.get());
            let out = Command::new("git")
                .args(args)
                .current_dir(self.path())
                .env("GIT_AUTHOR_NAME", "author")
                .env("GIT_AUTHOR_EMAIL", "author@example.invalid")
                .env("GIT_COMMITTER_NAME", "author")
                .env("GIT_COMMITTER_EMAIL", "author@example.invalid")
                .env("GIT_AUTHOR_DATE", &at)
                .env("GIT_COMMITTER_DATE", &at)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        /// Writes `files` (None deletes) on `branch` from `from` and commits them: the new head.
        fn commit(
            &self,
            branch: &str,
            from: &str,
            files: &[(&str, Option<&str>)],
            message: &str,
        ) -> String {
            self.git(&["checkout", "-q", "-B", branch, from]);
            self.write(files);
            self.done(message)
        }

        fn write(&self, files: &[(&str, Option<&str>)]) {
            for (file, content) in files {
                match content {
                    Some(c) => std::fs::write(self.path().join(file), c).unwrap(),
                    None => std::fs::remove_file(self.path().join(file)).unwrap(),
                }
            }
        }

        fn done(&self, message: &str) -> String {
            self.commits.set(self.commits.get() + 1);
            self.git(&["add", "-A"]);
            self.git(&["commit", "-q", "-m", message]);
            self.git(&["rev-parse", "HEAD"])
        }

        /// A writer's commit on `onto` made from `from`'s files plus `files`: an older tree on a fresh base.
        fn stale(
            &self,
            branch: &str,
            from: &str,
            onto: &str,
            files: &[(&str, Option<&str>)],
            message: &str,
        ) -> String {
            self.git(&["checkout", "-q", "-B", branch, from]);
            self.write(files);
            self.git(&["add", "-A"]);
            self.git(&["reset", "-q", "--soft", onto]);
            self.done(message)
        }

        /// The first step of the train's rule for `head` against main, from this repo's git: each file put back, and
        /// the files `head` deletes.
        fn put_back(&self, head: &str) -> (Vec<Restore>, HashSet<String>) {
            let mb = self.git(&["merge-base", "main", head]);
            let mb_at: i64 = self
                .git(&["log", "-1", "--format=%ct", &mb])
                .parse()
                .unwrap();
            let mut restores = Vec::new();
            let mut deleted = HashSet::new();
            for line in self
                .git(&["diff", "--name-status", "--no-renames", &mb, head])
                .lines()
            {
                let (status, path) = line.split_once('\t').unwrap();
                if status == "D" {
                    deleted.insert(path.to_string());
                    continue;
                }
                let blob = self.git(&["rev-parse", &format!("{head}:{path}")]);
                if let Some(undone) = undone(&blob, mb_at, &git_history(self.path(), "main", path))
                {
                    restores.push(Restore {
                        path: path.into(),
                        undone,
                    });
                }
            }
            (restores, deleted)
        }

        /// What the train's rule finds for `head` against main, from this repo's git: (commit, file) pairs.
        fn rust(&self, head: &str) -> BTreeSet<(String, String)> {
            let mb = self.git(&["merge-base", "main", head]);
            if deliberate(&self.git(&["log", "--format=%B", &format!("{mb}..{head}")])) {
                return BTreeSet::new();
            }
            let (restores, deleted) = self.put_back(head);
            let touched = restores
                .iter()
                .flat_map(|r| &r.undone)
                .map(|v| {
                    let files: CommitFiles =
                        serde_json::from_value(git_commit_files(self.path(), &v.commit)).unwrap();
                    (v.commit.clone(), files.touched())
                })
                .collect();
            counted(restores, &deleted, &touched)
                .into_iter()
                .flat_map(|r| {
                    r.undone
                        .into_iter()
                        .map(move |v| (v.commit[..9].to_string(), r.path.clone()))
                })
                .collect()
        }

        /// What scripts/reverts.sh finds for `head` against main: its exit code and (commit, file) pairs.
        fn shell(&self, head: &str) -> (i32, BTreeSet<(String, String)>) {
            let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../scripts/reverts.sh");
            let out = Command::new("bash")
                .arg(script)
                .args(["main", head])
                .current_dir(self.path())
                .output()
                .unwrap();
            let mut found = BTreeSet::new();
            let mut commit = String::new();
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Some(file) = line.strip_prefix("  ") {
                    found.insert((commit.clone(), file.to_string()));
                } else if let Some((sha, _)) = line.split_once(' ')
                    && sha.len() >= 7
                    && sha.bytes().all(|b| b.is_ascii_hexdigit())
                {
                    commit = self.git(&["rev-parse", sha])[..9].to_string();
                }
            }
            (out.status.code().unwrap_or(-1), found)
        }

        /// The train's rule and scripts/reverts.sh agree on `head`: what they found.
        fn check(&self, head: &str) -> BTreeSet<(String, String)> {
            let rust = self.rust(head);
            let (code, shell) = self.shell(head);
            assert_eq!(
                rust, shell,
                "the train and scripts/reverts.sh differ on {head}"
            );
            assert_eq!(
                code,
                if rust.is_empty() { 0 } else { 1 },
                "scripts/reverts.sh's exit on {head}"
            );
            rust
        }
    }

    fn pairs(list: &[(&str, &str)]) -> BTreeSet<(String, String)> {
        list.iter()
            .map(|(c, f)| (c[..9].to_string(), f.to_string()))
            .collect()
    }

    /// #914's first head in small: main took two PRs, then a writer committed its older tree, plus its own file, on
    /// the fresh main. Ordinary edits, a rename, a deliberate revert, one file of a big commit taken back and a branch
    /// carrying a PR main already squashed all pass. The train's rule and scripts/reverts.sh find the same.
    #[test]
    fn a_stale_tree_on_a_fresh_main_is_found_and_ordinary_changes_pass() {
        let repo = Repo {
            dir: tempfile::tempdir().unwrap(),
            commits: Default::default(),
        };
        repo.git(&["init", "-q", "-b", "main"]);
        let files = ["a", "b", "c", "x", "y", "z", "keep"].map(|f| format!("{f}.txt"));
        let start: Vec<(&str, Option<&str>)> =
            files.iter().map(|f| (f.as_str(), Some("0\n"))).collect();
        repo.write(&start);
        let c0 = repo.done("base");
        let c1 = repo.commit(
            "main",
            "main",
            &[("a.txt", Some("1\n")), ("b.txt", Some("1\n"))],
            "feat: one (#101)",
        );
        let c2 = repo.commit(
            "main",
            "main",
            &[("c.txt", Some("1\n")), ("d.txt", Some("1\n"))],
            "fix: two (#102)",
        );
        let stale = repo.stale(
            "stale",
            &c0,
            &c2,
            &[("own.txt", Some("mine\n"))],
            "feat: mine",
        );
        let reverting = repo.stale(
            "reverting",
            &c0,
            &c2,
            &[("own.txt", Some("mine\n"))],
            "Revert #101 and #102: they broke the build",
        );
        let edit = repo.commit(
            "edit",
            &c2,
            &[("a.txt", Some("mine\n")), ("new.txt", Some("new\n"))],
            "feat: an edit",
        );
        repo.git(&["checkout", "-q", "-B", "rename", &c2]);
        repo.git(&["mv", "b.txt", "b-renamed.txt"]);
        let rename = repo.done("refactor: a rename");
        let c3 = repo.commit(
            "main",
            "main",
            &[
                ("x.txt", Some("1\n")),
                ("y.txt", Some("1\n")),
                ("z.txt", Some("1\n")),
            ],
            "feat: three (#103)",
        );
        let takeback = repo.commit(
            "takeback",
            &c3,
            &[("x.txt", Some("0\n"))],
            "fix: x as it was",
        );
        let carried = repo.commit(
            "carried",
            &c3,
            &[("keep.txt", Some("mine\n"))],
            "feat: keep",
        );
        repo.commit(
            "main",
            "main",
            &[("keep.txt", Some("mine\n"))],
            "feat: keep (#104)",
        );
        repo.commit(
            "main",
            "main",
            &[("keep.txt", Some("2\n"))],
            "feat: keep more (#105)",
        );

        assert_eq!(
            repo.check(&stale),
            pairs(&[(&c1, "a.txt"), (&c1, "b.txt"), (&c2, "c.txt")]),
            "d.txt, which #102 added and the stale tree lacks, counts but isn't put back"
        );
        assert!(repo.check(&reverting).is_empty());
        assert!(repo.check(&edit).is_empty());
        assert!(repo.check(&rename).is_empty());
        // Its x.txt is #103's older version, but #103 changed three files: one taken back is a choice, not a stale tree.
        assert_eq!(repo.put_back(&takeback).0.len(), 1);
        assert!(repo.check(&takeback).is_empty());
        // Its keep.txt is the version #104 landed, after its merge base: its own change, not one of main's.
        assert!(repo.check(&carried).is_empty());
    }
}
