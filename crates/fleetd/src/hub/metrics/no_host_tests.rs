//! A repo whose host fleetd can't read, over a real bare-repo origin and a checkout of it: the train's merges (by
//! trailer and by merge sha), hand merges, fleetd's work merged by hand, direct pushes and a bot's push, each routed
//! from git alone; the next read picks up only what landed since; and the view says what git can't know.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use fleetd_contracts::metrics::{GitHost, MergeRoute};
use fleetd_contracts::sessions::LandedLog;
use serde_json::json;

use super::no_host::{GitLog, UNKNOWN};
use super::sweep::{self, QUIET_EVERY_MS};
use super::tests::{NOW, admin, change, get, hub, ms, orders, rows, sql};
use crate::hub::api::Hub;
use crate::hub::usage::ports::BoxFut;

const REPO: &str = "git.internal/srv/web";

/// `git` in `dir` as a person at `at`, failing the test on an error; its stdout.
fn git_at(dir: &Path, at: &str, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "init.defaultBranch=main",
        ])
        .args(args)
        .env("GIT_AUTHOR_NAME", "Sam")
        .env("GIT_AUTHOR_EMAIL", "sam@example.com")
        .env("GIT_COMMITTER_NAME", "Sam")
        .env("GIT_COMMITTER_EMAIL", "sam@example.com")
        .env("GIT_AUTHOR_DATE", at)
        .env("GIT_COMMITTER_DATE", at)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// A bare origin, a person's working clone that lands work on it, and the project's checkout of it.
struct Origin {
    dir: tempfile::TempDir,
    work: PathBuf,
    checkout: PathBuf,
}

impl Origin {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let bare = dir.path().join("web.git");
        let work = dir.path().join("work");
        let checkout = dir.path().join("checkout");
        let old = "2026-04-01T12:00:00Z";
        git_at(
            dir.path(),
            old,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                &bare.to_string_lossy(),
            ],
        );
        git_at(
            dir.path(),
            old,
            &[
                "clone",
                "-q",
                &bare.to_string_lossy(),
                &work.to_string_lossy(),
            ],
        );
        let o = Self {
            dir,
            work,
            checkout,
        };
        // Older than the 90 days a first read goes back.
        o.commit(old, "init.txt", "init", "Sam");
        o.push(old);
        git_at(
            o.dir.path(),
            old,
            &[
                "clone",
                "-q",
                &bare.to_string_lossy(),
                &o.checkout.to_string_lossy(),
            ],
        );
        o
    }

    /// A commit on the working clone's current branch; its sha.
    fn commit(&self, at: &str, file: &str, message: &str, author: &str) -> String {
        std::fs::write(self.work.join(file), format!("{message}\n")).unwrap();
        git_at(&self.work, at, &["add", "."]);
        let who = format!("{author} <sam@example.com>");
        git_at(
            &self.work,
            at,
            &["commit", "-q", "--author", &who, "-m", message],
        );
        git_at(&self.work, at, &["rev-parse", "HEAD"])
    }

    /// Merges `branch` into main with a merge commit; its sha.
    fn merge(&self, at: &str, branch: &str, message: &str) -> String {
        git_at(&self.work, at, &["checkout", "-q", "main"]);
        git_at(
            &self.work,
            at,
            &["merge", "-q", "--no-ff", branch, "-m", message],
        );
        git_at(&self.work, at, &["rev-parse", "HEAD"])
    }

    fn branch(&self, at: &str, name: &str) {
        git_at(&self.work, at, &["checkout", "-q", "-b", name, "main"]);
    }

    fn push(&self, at: &str) {
        git_at(&self.work, at, &["push", "-q", "origin", "main"]);
    }
}

/// The node's `landed_log` on the project's checkout, as the node runs it.
struct Checkout(PathBuf);

impl GitLog for Checkout {
    fn can_read(&self, _hub: &Hub, machine: &str) -> bool {
        machine == "devbox"
    }

    fn read<'a>(
        &'a self,
        _hub: &'a Hub,
        _at: &'a (String, String),
        branch: &'a str,
        since_ms: i64,
        stop_at: Option<&'a str>,
    ) -> BoxFut<'a, Result<LandedLog, String>> {
        let (root, branch, stop_at) = (
            self.0.clone(),
            branch.to_owned(),
            stop_at.map(str::to_owned),
        );
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                crate::node::landed::landed_log(&root, &branch, since_ms, stop_at.as_deref())
            })
            .await
            .unwrap()
            .map_err(|e| e.to_string())
        })
    }
}

/// The project devbox/web with the repo checked out; X50 and X60 are Changes the train merged, T3 and T4 tasks of W2.
fn project(hub: &Hub) {
    orders(hub);
    change(
        hub,
        50,
        50,
        "W1",
        Some("T50"),
        "merged",
        "2026-10-20T08:00:00.000Z",
    );
    change(
        hub,
        60,
        60,
        "W2",
        None,
        "merged",
        "2026-10-21T08:00:00.000Z",
    );
    for n in [3, 4, 5] {
        sql(
            hub,
            "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, data) VALUES (?1, 'devbox', 'web', 'W2', 'done', '{}')",
            &[&n],
        );
    }
    sql(
        hub,
        "INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('devbox', 'web', '', '', '{}')",
        &[],
    );
    sql(
        hub,
        "INSERT INTO metric_project_repos (machine_id, project_id, repo, checked_ms) VALUES ('devbox', 'web', ?1, ?2)",
        &[&REPO, &ms(NOW)],
    );
    sql(
        hub,
        "INSERT INTO metric_repos (repo, host, default_branch) VALUES (?1, 'git', 'main')",
        &[&REPO],
    );
}

/// unit key → (route, task, workstream, PR).
type Routes = BTreeMap<String, (String, Option<String>, Option<String>, Option<i64>)>;

fn routes(hub: &Hub) -> Routes {
    rows(hub)
        .into_iter()
        .map(|r| {
            (
                r.unit_key,
                (r.route, r.task_id, r.workstream_id, r.pr_number),
            )
        })
        .collect()
}

fn routed(
    route: &str,
    task: Option<&str>,
    ws: Option<&str>,
    pr: Option<i64>,
) -> (String, Option<String>, Option<String>, Option<i64>) {
    (route.into(), task.map(Into::into), ws.map(Into::into), pr)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_with_no_host_tells_the_trains_merges_hand_merges_and_direct_pushes_apart_from_git_alone()
 {
    let (hub, clock, _home) = hub();
    project(&hub);
    let origin = Origin::new();
    hub.metrics
        .sweep
        .git
        .set(Arc::new(Checkout(origin.checkout.clone())));

    // The train's squash, with its trailer.
    let train = origin.commit(
        "2026-10-20T12:00:00Z",
        "docs.md",
        "docs (#50)\n\nAdds the docs.\n\nFleetd-Change: X50 (T50, W1)",
        "Sam",
    );
    // A squash the train made before it wrote trailers: known by the Change's merge sha.
    let older_train = origin.commit("2026-10-21T12:00:00Z", "old.md", "old squash (#60)", "Sam");
    sql(
        &hub,
        "UPDATE changes SET data = json_set(data, '$.mergedSha', ?1) WHERE n = 60",
        &[&older_train],
    );
    // A person's PR merged by hand on the host: a merge commit, no trailer.
    origin.branch("2026-10-22T09:00:00Z", "feature");
    origin.commit("2026-10-22T09:00:00Z", "feature.txt", "a feature", "Sam");
    let hand = origin.merge(
        "2026-10-22T10:00:00Z",
        "feature",
        "Merge pull request #9 from acme/feature",
    );
    // fleetd's work merged by hand: a merge that brings in an agent's commits.
    origin.branch("2026-10-22T11:00:00Z", "topic");
    origin.commit(
        "2026-10-22T11:00:00Z",
        "t3.txt",
        "fix totals\n\nFleetd-Task: T3",
        "Sam",
    );
    let fleetd_merge = origin.merge("2026-10-22T12:00:00Z", "topic", "Merge branch 'topic'");
    // ...and rebased onto main by hand: two of T4's commits in a row are one change.
    origin.commit(
        "2026-10-23T09:00:00Z",
        "t4a.txt",
        "t4 one\n\nFleetd-Task: T4",
        "Sam",
    );
    let rebased = origin.commit(
        "2026-10-23T09:00:00Z",
        "t4b.txt",
        "t4 two\n\nFleetd-Task: T4",
        "Sam",
    );
    // An agent's branch merged by hand in a repo whose commits carry no trailer: known by the branch the merge names.
    origin.branch("2026-10-23T10:00:00Z", "fleetd/T5-more");
    origin.commit("2026-10-23T10:00:00Z", "t5.txt", "more totals", "Sam");
    let by_branch = origin.merge(
        "2026-10-23T11:00:00Z",
        "fleetd/T5-more",
        "Merge pull request #11 from acme/fleetd/T5-more",
    );
    // Pushed straight to main, and a bot's push.
    let direct = origin.commit("2026-10-24T09:00:00Z", "direct.txt", "hotfix", "Sam");
    let bot = origin.commit(
        "2026-10-24T10:00:00Z",
        "deps.txt",
        "bump deps",
        "renovate[bot]",
    );
    origin.push("2026-10-24T10:00:00Z");

    sweep::pass(&hub).await;
    let errors: Vec<Option<String>> = hub
        .db
        .with(|c| {
            Ok(super::store::repos(c)?
                .into_iter()
                .filter(|r| r.repo == REPO)
                .map(|r| r.last_error)
                .collect())
        })
        .unwrap();
    assert_eq!(errors, [None]);
    let mut want = Routes::new();
    want.insert(
        "pr:50".into(),
        routed("train", Some("T50"), Some("W1"), Some(50)),
    );
    want.insert("pr:60".into(), routed("train", None, Some("W2"), Some(60)));
    want.insert(
        format!("commit:{hand}"),
        routed("outside", None, None, Some(9)),
    );
    want.insert(
        format!("commit:{fleetd_merge}"),
        routed("fleetd_by_hand", Some("T3"), Some("W2"), None),
    );
    want.insert(
        format!("commit:{rebased}"),
        routed("fleetd_by_hand", Some("T4"), Some("W2"), None),
    );
    want.insert(
        format!("commit:{direct}"),
        routed("direct", None, None, None),
    );
    want.insert(
        format!("commit:{by_branch}"),
        routed("fleetd_by_hand", Some("T5"), Some("W2"), Some(11)),
    );
    want.insert(format!("commit:{bot}"), routed("skipped", None, None, None));
    assert_eq!(routes(&hub), want);
    let stored = rows(&hub);
    let train_row = stored.iter().find(|r| r.unit_key == "pr:50").unwrap();
    assert_eq!(
        (
            train_row.merged_sha.as_deref(),
            train_row.merged_ms,
            train_row.src.as_str()
        ),
        (Some(train.as_str()), ms("2026-10-20T12:00:00.000Z"), "git")
    );
    assert!(train_row.requested_ms.is_some(), "timed from its order");
    assert!(
        stored
            .iter()
            .filter(|r| r.route != "train")
            .all(|r| r.merged_by_kind.is_none()),
        "git doesn't say who merged"
    );

    // The next read starts at the head this one saw: only the new push.
    let late = origin.commit("2026-10-25T09:00:00Z", "late.txt", "late fix", "Sam");
    origin.push("2026-10-25T09:00:00Z");
    // The node reuses a fetch under 30 s old; a quarter of an hour on, as here, it fetches again.
    git_at(&origin.checkout, NOW, &["fetch", "-q", "origin"]);
    clock.advance(std::time::Duration::from_millis(QUIET_EVERY_MS as u64));
    sweep::pass(&hub).await;
    let after = routes(&hub);
    assert_eq!(after.len(), want.len() + 1);
    assert_eq!(after[&format!("commit:{late}")].0, "direct");

    // The view: the routes counted, and what git alone can't say.
    let out = get(
        &hub,
        &admin(),
        json!({ "since": "2026-10-19T00:00:00.000Z", "tz": "UTC" }),
    )
    .await
    .unwrap();
    let by = &out.tiles.merged.by_route;
    assert_eq!(
        (
            by.train.get(),
            by.fleetd_by_hand.get(),
            by.outside.get(),
            by.direct.get()
        ),
        (2, 3, 1, 2)
    );
    assert!(
        out.merges
            .iter()
            .all(|m| m.route == MergeRoute::Train || m.merged_by.is_none())
    );
    let repo = out
        .coverage
        .repos
        .iter()
        .find(|r| r.repo.as_str() == REPO)
        .unwrap();
    assert_eq!(repo.host, GitHost::Git);
    let unknown: Vec<&str> = repo
        .unknown
        .as_ref()
        .unwrap()
        .iter()
        .map(|l| l.as_str())
        .collect();
    assert_eq!(unknown, UNKNOWN);
    assert!(unknown[0].starts_with("Who merged"));
    // fleetd's work merged by hand that git doesn't name is said to be unknowable, not silently counted as outside.
    assert!(
        unknown
            .iter()
            .any(|l| l.starts_with("fleetd's work you merged by hand")),
        "{unknown:?}"
    );
    assert!(
        out.coverage.stale.iter().all(|s| s.repo.as_str() != REPO),
        "{:?}",
        out.coverage.stale
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_with_no_host_and_no_connected_checkout_says_so_never_a_silent_zero() {
    let (hub, _clock, _home) = hub();
    project(&hub);
    let origin = Origin::new();
    struct Offline(Checkout);
    impl GitLog for Offline {
        fn can_read(&self, _hub: &Hub, _machine: &str) -> bool {
            false
        }
        fn read<'a>(
            &'a self,
            hub: &'a Hub,
            at: &'a (String, String),
            branch: &'a str,
            since_ms: i64,
            stop_at: Option<&'a str>,
        ) -> BoxFut<'a, Result<LandedLog, String>> {
            self.0.read(hub, at, branch, since_ms, stop_at)
        }
    }
    hub.metrics
        .sweep
        .git
        .set(Arc::new(Offline(Checkout(origin.checkout.clone()))));
    sweep::pass(&hub).await;
    let out = get(
        &hub,
        &admin(),
        json!({ "since": "2026-10-19T00:00:00.000Z", "tz": "UTC" }),
    )
    .await
    .unwrap();
    let stale: Vec<&str> = out
        .coverage
        .stale
        .iter()
        .filter(|s| s.repo.as_str() == REPO)
        .map(|s| s.reason.as_str())
        .collect();
    assert_eq!(
        stale,
        [
            "Its git log not read yet: no machine with it checked out is connected to read its git log"
        ]
    );
    let repo = out
        .coverage
        .repos
        .iter()
        .find(|r| r.repo.as_str() == REPO)
        .unwrap();
    assert_eq!((repo.host, repo.unknown.is_some()), (GitHost::Git, true));
}
