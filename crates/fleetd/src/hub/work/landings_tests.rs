//! The landing scanner over a real in-memory hub and real git: an origin, the project's checkout (its remote named
//! as a GitLab or GitHub URL that git rewrites to the local origin), and a person's clone that pushes. Each kind of
//! landing (direct push, a PR merged outside the train on GitLab and on GitHub, the train's own merge) is recorded
//! with its route, ends the claims it matches, and wakes the leads only for outside routes. The node's 2000-character
//! output tail is kept, and an offline node makes the watch wait.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::model::ProjectSummary;
use fleetd_contracts::prim::{Line, List};
use fleetd_contracts::tasks::Task;
use fleetd_contracts::train::Change;
use fleetd_contracts::work::{
    ClaimOwner, ClaimOwnerKind, ClaimState, LandingRoute, RepoKey, WorkKey, WorkPath, WorkScope,
};
use serde_json::{Value, json};

use super::bind::{GitOut, NodeGit, bind_unbound, bind_with, machines_online};
use super::elsewhere::Landings;
use super::landings::{LandingPorts, LandingStore, scan, wake_line};
use super::{BoxFut, NewClaim};
use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, NewEvent, WaitInput};
use crate::hub::tasks::records::TaskRecords;
use crate::hub::train::github::MergedPull;

const START_MS: i64 = 1_792_922_400_000;
const GITLAB: &str = "git@gitlab.example.com:acme/shop.git";
const GITHUB: &str = "https://github.com/acme/shop.git";
const AT: &str = "2026-10-25T10:00:00.000Z";

/// Real git in the given directory, as a node runs it: output cut to its last 2000 characters.
#[derive(Default)]
struct LocalGit {
    offline: Mutex<HashSet<String>>,
    pulls: Mutex<Vec<MergedPull>>,
    /// GitHub's answer to "which merged PRs is this commit from", by sha.
    commit_pulls: Mutex<HashMap<String, Vec<MergedPull>>>,
}

impl NodeGit for LocalGit {
    fn git<'a>(
        &'a self,
        machine: &'a MachineId,
        cwd: &'a str,
        args: Vec<String>,
    ) -> BoxFut<'a, Option<GitOut>> {
        let offline = self.offline.lock().unwrap().contains(machine.as_str());
        Box::pin(async move {
            if offline {
                return None;
            }
            let out = Command::new("git")
                .args(&args)
                .current_dir(cwd)
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&out.stdout).into_owned()
                + &String::from_utf8_lossy(&out.stderr);
            let tail = crate::node::util::tail_utf16(&text, 2000).to_owned();
            Some(GitOut {
                code: out.status.code().map(i64::from),
                out: tail,
            })
        })
    }
}

impl LandingPorts for LocalGit {
    fn merged_pulls<'a>(&'a self, _repo: &'a str) -> BoxFut<'a, Option<Vec<MergedPull>>> {
        let pulls = self.pulls.lock().unwrap().clone();
        Box::pin(async move { Some(pulls) })
    }

    fn merged_pulls_of<'a>(
        &'a self,
        _repo: &'a str,
        sha: &'a str,
    ) -> BoxFut<'a, Option<Vec<MergedPull>>> {
        let pulls = self.commit_pulls.lock().unwrap().get(sha).cloned();
        Box::pin(async move { Some(pulls.unwrap_or_default()) })
    }
}

fn pull(number: i64, sha: &str, head: &str) -> MergedPull {
    MergedPull {
        number,
        merged_at: AT.into(),
        merge_sha: Some(sha.into()),
        base: "main".into(),
        head: head.into(),
    }
}

/// An origin, a person's clone of it, and checkouts for projects, with every commit dated from the hub's clock.
struct Repo {
    dir: tempfile::TempDir,
    remote: &'static str,
    commits: Mutex<i64>,
}

impl Repo {
    fn new(remote: &'static str) -> Self {
        let repo = Self {
            dir: tempfile::tempdir().unwrap(),
            remote,
            commits: Mutex::new(0),
        };
        let origin = repo.origin();
        std::fs::create_dir_all(&origin).unwrap();
        repo.run(&origin, &["init", "-q", "--bare", "-b", "main"], None);
        let human = repo.path("human");
        repo.run(
            repo.dir.path(),
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                human.to_str().unwrap(),
            ],
            None,
        );
        repo.run(&human, &["checkout", "-q", "-b", "main"], None);
        repo.commit("ada@example.com", "init", &[("README.md", "shop\n")]);
        repo.run(&human, &["push", "-q", "origin", "main"], None);
        repo
    }

    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    fn origin(&self) -> PathBuf {
        self.path("origin.git")
    }

    fn human(&self) -> PathBuf {
        self.path("human")
    }

    fn run(&self, cwd: &Path, args: &[&str], email: Option<&str>) -> String {
        let mut n = self.commits.lock().unwrap();
        *n += 1;
        // The repo's first commits are older than the hub's clock, so older than any watch.
        let date = format!("@{} +0000", START_MS / 1000 - 600 + *n * 60);
        let email = email.unwrap_or("t@example.com");
        let out = Command::new("git")
            .current_dir(cwd)
            .args(["-c", "commit.gpgsign=false", "-c", "user.name=t"])
            .args(["-c", &format!("user.email={email}")])
            .env("GIT_COMMITTER_EMAIL", email)
            .env("GIT_COMMITTER_DATE", &date)
            .env_remove("GIT_AUTHOR_NAME")
            .env_remove("GIT_AUTHOR_EMAIL")
            .env_remove("GIT_AUTHOR_DATE")
            .envs(
                // A cherry-pick keeps the commit's own author, as a rebase does.
                (args.first() != Some(&"cherry-pick"))
                    .then_some([
                        ("GIT_AUTHOR_EMAIL", email),
                        ("GIT_AUTHOR_DATE", date.as_str()),
                    ])
                    .into_iter()
                    .flatten(),
            )
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    /// A project's checkout whose origin is `self.remote`, which git rewrites to the local origin.
    fn checkout(&self, name: &str) -> String {
        let root = self.path(name);
        let origin = self.origin();
        self.run(
            self.dir.path(),
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                root.to_str().unwrap(),
            ],
            None,
        );
        self.run(&root, &["config", "remote.origin.url", self.remote], None);
        let rewrite = format!("url.{}.insteadOf", origin.display());
        self.run(&root, &["config", &rewrite, self.remote], None);
        root.to_string_lossy().into_owned()
    }

    /// Commits the files on the person's current branch; returns its sha.
    fn commit(&self, email: &str, message: &str, files: &[(&str, &str)]) -> String {
        let human = self.human();
        for (path, text) in files {
            let file = human.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        self.run(&human, &["add", "-A"], Some(email));
        self.run(
            &human,
            &["commit", "-q", "--allow-empty", "-m", message],
            Some(email),
        );
        self.head()
    }

    fn head(&self) -> String {
        self.run(&self.human(), &["rev-parse", "HEAD"], None)
    }

    fn push(&self) {
        self.run(&self.human(), &["push", "-q", "-f", "origin", "main"], None);
    }

    fn git(&self, args: &[&str]) -> String {
        self.run(&self.human(), args, Some("ada@example.com"))
    }
}

fn hub() -> (Arc<Hub>, Arc<ManualClock>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let clock = ManualClock::at(START_MS as u64);
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    (hub, clock, home)
}

fn project(hub: &Hub, machine: &str, id: &str, root: &str) -> ProjectRef {
    let summary: ProjectSummary = serde_json::from_value(json!({
        "machineId": machine, "projectId": id, "title": id, "workspaceRoot": root,
        "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
    }))
    .unwrap();
    hub.store
        .projects_upsert_many(&MachineId::unchecked(machine), &[summary])
        .unwrap();
    ProjectRef {
        machine_id: MachineId::unchecked(machine),
        project_id: ProjectId::unchecked(id),
    }
}

fn scope(remote: &str) -> WorkScope {
    WorkScope {
        repo_key: RepoKey::of(remote).unwrap(),
        base: Line::unchecked("main"),
    }
}

fn claim(
    hub: &Hub,
    scope: &WorkScope,
    title: &str,
    email: &str,
    keys: Vec<WorkKey>,
    branch: Option<&str>,
) -> fleetd_contracts::work::ClaimId {
    hub.work
        .claim(NewClaim {
            scope: scope.clone(),
            project_ref: None,
            owner: ClaimOwner {
                kind: ClaimOwnerKind::HumanSession,
                key_id: Line::unchecked("k7"),
                label: Some(Line::unchecked("laptop")),
            },
            title: Line::new(title).unwrap(),
            keys: List::unchecked(keys),
            branch: branch.map(Line::unchecked),
            paths: List::unchecked(vec![WorkPath::unchecked("app/theme.ts")]),
            author_email: Some(Line::unchecked(email)),
        })
        .unwrap()
        .claim_id
}

fn state(hub: &Hub, id: &fleetd_contracts::work::ClaimId) -> ClaimState {
    hub.work.get(id).unwrap().unwrap().state
}

fn landed_events(hub: &Hub) -> Vec<Value> {
    let page = futures_util::FutureExt::now_or_never(hub.events.wait(WaitInput {
        cursor: Some(0),
        types: Some(vec![HubEventType::WorkLanded]),
        machine_id: None,
        timeout_sec: 0,
    }))
    .unwrap()
    .unwrap();
    page.events.into_iter().filter_map(|e| e.data).collect()
}

fn landings(hub: &Hub, scope: &WorkScope) -> Vec<fleetd_contracts::work::Landing> {
    let mut all = hub.work.landings(scope, 0, 100).unwrap();
    all.reverse();
    all
}

fn task(hub: &Hub, project: &ProjectRef, branch: &str, item: &str) -> Task {
    let task: Task = serde_json::from_value(json!({
        "taskId": "T1", "projectRef": project, "workstreamId": "W1", "title": "checkout totals", "kind": "write",
        "prompt": "do it", "state": "running", "attempt": 1, "createdAt": AT, "branch": branch, "itemId": item,
    }))
    .unwrap();
    hub.db.with(|c| Ok(TaskRecords::create(c, task)?)).unwrap()
}

fn change(hub: &Hub, project: &ProjectRef, pr: u32, state: &str, merged: Option<&str>) -> Change {
    let change: Change = serde_json::from_value(json!({
        "changeId": "X1", "projectRef": project, "repo": "acme/shop", "prNumber": pr,
        "prUrl": format!("https://github.com/acme/shop/pull/{pr}"), "branch": format!("fleetd/T9-pr-{pr}"),
        "workstreamId": "W1", "headSha": "0123456789abcdef0123456789abcdef01234567", "state": state,
        "mergedSha": merged, "reviews": [], "createdAt": AT, "updatedAt": AT,
    }))
    .unwrap();
    hub.train.records().create(change)
}

#[tokio::test]
async fn a_direct_push_on_a_gitlab_repo_is_recorded_and_ends_its_authors_claim() {
    let (hub, _clock, _home) = hub();
    let repo = Repo::new(GITLAB);
    let shop = project(&hub, "devbox", "shop", &repo.checkout("shop"));
    let git = LocalGit::default();
    let shop_scope = scope(GITLAB);

    // The first scan records the project's repo and base, and starts the watch: what was there is not a landing.
    scan(&hub, &git).await;
    assert_eq!(hub.work.scope_of(&shop).unwrap(), Some(shop_scope.clone()));
    assert_eq!(shop_scope.repo_key.as_str(), "gitlab.example.com/acme/shop");
    assert_eq!(
        hub.work.watch(&shop_scope).unwrap().unwrap().last_sha,
        repo.head()
    );
    assert!(landings(&hub, &shop_scope).is_empty());

    let mine = claim(
        &hub,
        &shop_scope,
        "dark mode toggle in settings",
        "ada@example.com",
        vec![],
        None,
    );
    let theirs = claim(
        &hub,
        &shop_scope,
        "dark mode toggle in settings",
        "sam@example.com",
        vec![],
        None,
    );
    let unrelated = claim(
        &hub,
        &shop_scope,
        "checkout totals",
        "ada@example.com",
        vec![],
        None,
    );
    let sha = repo.commit(
        "Ada@Example.com",
        "feat(app): dark mode toggle for settings",
        &[("app/theme.ts", "dark\n")],
    );
    repo.push();
    scan(&hub, &git).await;

    let all = landings(&hub, &shop_scope);
    assert_eq!(all.len(), 1);
    let landing = &all[0];
    assert_eq!(landing.sha.as_str(), sha);
    assert_eq!(landing.route, LandingRoute::DirectPush);
    assert_eq!(landing.pr_number, None);
    assert_eq!(landing.author_email.as_deref(), Some("Ada@Example.com"));
    assert_eq!(
        landing.paths.iter().map(|p| p.as_str()).collect::<Vec<_>>(),
        ["app/theme.ts"]
    );
    assert_eq!(landing.claim_ids, std::slice::from_ref(&mine));
    let ended = hub.work.get(&mine).unwrap().unwrap();
    assert_eq!(ended.state, ClaimState::Landed);
    assert_eq!(ended.end.unwrap().landing.unwrap().as_str(), sha);
    assert_eq!(
        state(&hub, &theirs),
        ClaimState::Active,
        "another author's push"
    );
    assert_eq!(
        state(&hub, &unrelated),
        ClaimState::Active,
        "a different title"
    );

    let events = landed_events(&hub);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["landing"]["route"], "direct_push");
    assert!(
        hub.leads.wakes.pending(&shop),
        "an outside landing wakes the lead"
    );
    assert_eq!(
        wake_line(landing),
        format!(
            "{} \"feat(app): dark mode toggle for settings\" was pushed straight to main by Ada@Example.com; it ended claim {mine}.",
            &sha[..7]
        )
    );

    // The digest and `plan covered` read it through `Landings`.
    let store = LandingStore(hub.db.clone());
    let outside = store.outside(&shop_scope, 0, 5).unwrap();
    assert_eq!(outside.len(), 1);
    assert_eq!(outside[0].covers, [mine.to_string()]);
    assert_eq!(
        store
            .find(&shop_scope, &sha[..7])
            .unwrap()
            .unwrap()
            .sha
            .as_str(),
        sha
    );

    // Scanning again with nothing new records nothing.
    scan(&hub, &git).await;
    assert_eq!(landings(&hub, &shop_scope).len(), 1);
}

#[tokio::test]
async fn a_gitlab_merge_request_merged_outside_the_train_ends_the_claims_on_its_branch_mr_and_closed_issues()
 {
    let (hub, _clock, _home) = hub();
    let repo = Repo::new(GITLAB);
    project(&hub, "devbox", "shop", &repo.checkout("shop"));
    let git = LocalGit::default();
    let shop = scope(GITLAB);
    scan(&hub, &git).await;

    let on_branch = claim(
        &hub,
        &shop,
        "dark mode",
        "sam@example.com",
        vec![],
        Some("ada/dark-mode"),
    );
    let on_mr = claim(
        &hub,
        &shop,
        "something else",
        "sam@example.com",
        vec![WorkKey::Pr(fleetd_contracts::tasks::PrUrl::unchecked(
            "https://gitlab.example.com/acme/shop/-/merge_requests/12",
        ))],
        None,
    );
    let on_issue = claim(
        &hub,
        &shop,
        "another thing",
        "sam@example.com",
        vec![WorkKey::Issue(Line::unchecked("SHOP-7"))],
        None,
    );
    let other_mr = claim(
        &hub,
        &shop,
        "other",
        "sam@example.com",
        vec![WorkKey::Pr(fleetd_contracts::tasks::PrUrl::unchecked(
            "https://gitlab.example.com/acme/shop/-/merge_requests/13",
        ))],
        None,
    );
    let issue = |key: &str| {
        claim(
            &hub,
            &shop,
            "an issue",
            "sam@example.com",
            vec![WorkKey::Issue(Line::unchecked(key))],
            None,
        )
    };
    let mentioned = issue("#3");
    let same_repo_url = issue("https://gitlab.example.com/acme/shop/-/issues/8");
    let other_repo_url = issue("https://gitlab.example.com/acme/other/-/issues/9");
    repo.git(&["checkout", "-q", "-b", "ada/dark-mode"]);
    repo.commit(
        "ada@example.com",
        "dark mode toggle",
        &[("app/theme.ts", "dark\n")],
    );
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&[
        "merge",
        "-q",
        "--no-ff",
        "ada/dark-mode",
        "-m",
        "Merge branch 'ada/dark-mode' into 'main'",
        "-m",
        "dark mode toggle, a follow-up to #3\n\nCloses SHOP-7\nFixes #8\nFixes https://gitlab.example.com/acme/other/-/issues/9\n\nSee merge request acme/shop!12",
    ]);
    let merge = repo.head();
    repo.push();
    scan(&hub, &git).await;

    let all = landings(&hub, &shop);
    assert_eq!(
        all.len(),
        1,
        "the first-parent line only: the merge, not its branch's commit"
    );
    let landing = &all[0];
    assert_eq!(landing.sha.as_str(), merge);
    assert_eq!(landing.route, LandingRoute::PrOutside);
    assert_eq!(landing.pr_number.map(|n| n.get()), Some(12));
    assert_eq!(
        landing.pr_url.as_ref().map(|u| u.as_str()),
        Some("https://gitlab.example.com/acme/shop/-/merge_requests/12")
    );
    assert_eq!(landing.head_branch.as_deref(), Some("ada/dark-mode"));
    assert_eq!(
        landing.paths.iter().map(|p| p.as_str()).collect::<Vec<_>>(),
        ["app/theme.ts"]
    );
    for id in [&on_branch, &on_mr, &on_issue, &same_repo_url] {
        assert_eq!(state(&hub, id), ClaimState::Landed, "{id}");
    }
    // Another MR, an issue only mentioned, and an issue of another repo stay claimed.
    for id in [&other_mr, &mentioned, &other_repo_url] {
        assert_eq!(state(&hub, id), ClaimState::Active, "{id}");
    }
    let reason = hub
        .work
        .get(&on_branch)
        .unwrap()
        .unwrap()
        .end
        .unwrap()
        .reason;
    assert_eq!(
        reason.as_str(),
        format!("{} landed on main: branch ada/dark-mode", &merge[..7])
    );
}

#[tokio::test]
async fn a_github_squash_merge_takes_its_branch_from_github_and_links_the_task() {
    let (hub, _clock, _home) = hub();
    let repo = Repo::new(GITHUB);
    let shop = project(&hub, "devbox", "shop", &repo.checkout("shop"));
    let git = LocalGit::default();
    let scope = scope(GITHUB);
    scan(&hub, &git).await;
    let task = task(&hub, &shop, "fleetd/T1-checkout-totals", "P5");
    let held = claim(
        &hub,
        &scope,
        "totals",
        "sam@example.com",
        vec![],
        Some("fleetd/T1-checkout-totals"),
    );

    let sha = repo.commit(
        "ada@example.com",
        "feat: checkout totals (#58)",
        &[("app/cart.ts", "1\n")],
    );
    repo.push();
    git.pulls.lock().unwrap().push(MergedPull {
        number: 58,
        merged_at: AT.into(),
        merge_sha: Some(sha.to_uppercase()),
        base: "main".into(),
        head: "fleetd/T1-checkout-totals".into(),
    });
    scan(&hub, &git).await;

    let landing = &landings(&hub, &scope)[0];
    assert_eq!(
        landing.route,
        LandingRoute::PrOutside,
        "no Change merged it"
    );
    assert_eq!(
        landing.pr_url.as_ref().map(|u| u.as_str()),
        Some("https://github.com/acme/shop/pull/58")
    );
    assert_eq!(
        landing.head_branch.as_deref(),
        Some("fleetd/T1-checkout-totals")
    );
    assert_eq!(landing.task_id.as_ref(), Some(&task.task_id));
    assert_eq!(
        landing
            .item_ids
            .iter()
            .map(|i| i.as_str())
            .collect::<Vec<_>>(),
        ["P5"]
    );
    assert_eq!(state(&hub, &held), ClaimState::Landed);
    assert!(wake_line(landing).ends_with(&format!(
        "; it ended claim {held}; it is {}'s work, item P5.",
        task.task_id
    )));

    // A commit with no marker that GitHub says a PR merged is that PR's.
    let rebased = repo.commit(
        "ada@example.com",
        "checkout rounding",
        &[("app/cart.ts", "2\n")],
    );
    repo.push();
    git.pulls.lock().unwrap().push(MergedPull {
        number: 59,
        merged_at: AT.into(),
        merge_sha: Some(rebased.clone()),
        base: "main".into(),
        head: "ada/rounding".into(),
    });
    scan(&hub, &git).await;
    let landing = &landings(&hub, &scope)[1];
    assert_eq!(
        (landing.route, landing.pr_number.map(|n| n.get())),
        (LandingRoute::PrOutside, Some(59))
    );
}

#[tokio::test]
async fn the_trains_own_merge_is_a_train_landing_and_wakes_no_one() {
    let (hub, clock, _home) = hub();
    let repo = Repo::new(GITHUB);
    let shop = project(&hub, "devbox", "shop", &repo.checkout("shop"));
    let git = LocalGit::default();
    let scope = scope(GITHUB);
    scan(&hub, &git).await;

    let sha = repo.commit(
        "bot@example.com",
        "feat: docs page (#7)",
        &[("docs.md", "d\n")],
    );
    repo.push();
    let merged = change(&hub, &shop, 7, "merged", Some(&sha));
    scan(&hub, &git).await;
    let landing = &landings(&hub, &scope)[0];
    assert_eq!(landing.route, LandingRoute::Train);
    assert_eq!(landing.change_id.as_ref(), Some(&merged.change_id));
    assert!(
        !hub.leads.wakes.pending(&shop),
        "the train already told the lead"
    );

    // While the train is merging, a commit it may not have recorded yet waits for the next scan.
    change(&hub, &shop, 8, "merging", None);
    let pushed = repo.commit("ada@example.com", "fix: typo", &[("docs.md", "e\n")]);
    repo.push();
    scan(&hub, &git).await;
    assert_eq!(landings(&hub, &scope).len(), 1);
    // A Change stuck merging for over 10 minutes holds nothing back.
    clock.advance(Duration::from_secs(11 * 60));
    scan(&hub, &git).await;
    let landing = &landings(&hub, &scope)[1];
    assert_eq!(
        (landing.sha.as_str(), landing.route),
        (pushed.as_str(), LandingRoute::DirectPush)
    );
}

#[tokio::test]
async fn every_commit_of_a_github_rebase_merge_is_its_prs() {
    let (hub, _clock, _home) = hub();
    let repo = Repo::new(GITHUB);
    let shop = project(&hub, "devbox", "shop", &repo.checkout("shop"));
    let git = LocalGit::default();
    let scope = scope(GITHUB);
    scan(&hub, &git).await;

    // GitHub rebases the PR's two commits onto main and names only the last as its merge commit.
    let first = repo.commit(
        "ada@example.com",
        "rounding: helper",
        &[("app/round.ts", "1\n")],
    );
    let last = repo.commit(
        "ada@example.com",
        "rounding: use it",
        &[("app/cart.ts", "1\n")],
    );
    let pushed = repo.commit("sam@example.com", "docs: typo", &[("README.md", "shop!\n")]);
    repo.push();
    git.pulls
        .lock()
        .unwrap()
        .push(pull(60, &last, "ada/rounding"));
    git.commit_pulls
        .lock()
        .unwrap()
        .insert(first.clone(), vec![pull(60, &last, "ada/rounding")]);
    scan(&hub, &git).await;

    let routes: Vec<(String, LandingRoute, Option<i64>, Option<String>)> = landings(&hub, &scope)
        .iter()
        .map(|l| {
            (
                l.sha.to_string(),
                l.route,
                l.pr_number.map(|n| n.get()),
                l.head_branch.as_ref().map(|b| b.to_string()),
            )
        })
        .collect();
    let rounding = Some("ada/rounding".to_owned());
    assert_eq!(
        routes,
        [
            (first, LandingRoute::PrOutside, Some(60), rounding.clone()),
            (last, LandingRoute::PrOutside, Some(60), rounding),
            (pushed, LandingRoute::DirectPush, None, None),
        ]
    );
    assert!(hub.leads.wakes.pending(&shop));
}

#[tokio::test]
async fn a_remote_git_cant_reach_is_told_to_the_lead_once_per_outage() {
    let (hub, clock, _home) = hub();
    let repo = Repo::new(GITLAB);
    let root = repo.checkout("shop");
    let shop = project(&hub, "devbox", "shop", &root);
    let git = LocalGit::default();
    let gone = repo.path("gone.git");
    let rewrite = format!("url.{}.insteadOf", repo.origin().display());
    repo.run(Path::new(&root), &["config", "--unset-all", &rewrite], None);
    let rewrite = format!("url.{}.insteadOf", gone.display());
    repo.run(Path::new(&root), &["config", &rewrite, GITLAB], None);

    scan(&hub, &git).await;
    assert_eq!(hub.work.scope_of(&shop).unwrap(), Some(scope(GITLAB)));
    // Why, as #407 and #431 word a failed fetch: here, git's own line.
    let why = hub.work.scan_failure(&shop).unwrap();
    assert!(why.contains("gone.git"), "{why}");
    assert!(hub.leads.wakes.pending(&shop), "the lead is told");
    scan(&hub, &git).await;
    assert!(
        !hub.work.scan_failed(&shop, &why),
        "told once: the same failure again is not news"
    );

    // Reachable again: the watch starts. A failure soon after is the same outage (a flaky network); one after an hour
    // without failures is a new one.
    repo.run(Path::new(&root), &["config", "--unset-all", &rewrite], None);
    let rewrite = format!("url.{}.insteadOf", repo.origin().display());
    repo.run(Path::new(&root), &["config", &rewrite, GITLAB], None);
    scan(&hub, &git).await;
    assert!(hub.work.watch(&scope(GITLAB)).unwrap().is_some());
    scan(&hub, &git).await;
    assert_eq!(hub.work.scan_failure(&shop), None);
    assert!(!hub.work.scan_failed(&shop, &why));
    assert_eq!(hub.work.scan_failure(&shop).as_deref(), Some(why.as_str()));
    clock.advance(Duration::from_millis(super::OUTAGE_GAP_MS as u64));
    assert!(hub.work.scan_failed(&shop, &why));
}

#[tokio::test]
async fn an_offline_node_makes_the_watch_wait_and_another_checkout_of_the_repo_reads_it() {
    let (hub, _clock, _home) = hub();
    let repo = Repo::new(GITLAB);
    project(&hub, "devbox", "shop", &repo.checkout("shop"));
    let git = LocalGit::default();
    let scope = scope(GITLAB);
    scan(&hub, &git).await;

    git.offline.lock().unwrap().insert("devbox".into());
    let first = repo.commit("ada@example.com", "one", &[("a.txt", "1\n")]);
    repo.push();
    scan(&hub, &git).await;
    assert!(
        landings(&hub, &scope).is_empty(),
        "nothing is guessed while offline"
    );

    // A second machine's checkout of the same repo is in the scope, and reads it.
    let laptop = project(&hub, "laptop", "shop", &repo.checkout("laptop-shop"));
    let second = repo.commit("ada@example.com", "two", &[("a.txt", "2\n")]);
    repo.push();
    scan(&hub, &git).await;
    assert_eq!(hub.work.scope_of(&laptop).unwrap(), Some(scope.clone()));
    let shas: Vec<String> = landings(&hub, &scope)
        .iter()
        .map(|l| l.sha.to_string())
        .collect();
    assert_eq!(shas, [first, second], "caught up, oldest first");
}

#[tokio::test]
async fn a_base_far_behind_is_read_from_the_nodes_output_tail_and_a_force_push_reports_only_new_commits()
 {
    let (hub, _clock, _home) = hub();
    let repo = Repo::new(GITLAB);
    project(&hub, "devbox", "shop", &repo.checkout("shop"));
    let git = LocalGit::default();
    let scope = scope(GITLAB);
    scan(&hub, &git).await;
    let before = repo.head();

    // 60 commits: more shas than the node's 2000-character tail holds, so the scan reads them in rounds.
    let mut pushed = Vec::new();
    for n in 0..60 {
        pushed.push(repo.commit(
            "ada@example.com",
            &format!("step {n}"),
            &[("a.txt", &format!("{n}\n"))],
        ));
    }
    repo.push();
    scan(&hub, &git).await;
    let shas: Vec<String> = landings(&hub, &scope)
        .iter()
        .map(|l| l.sha.to_string())
        .collect();
    assert_eq!(shas, pushed);

    // The base is rewritten: its last two commits are rebased (new shas, same author, author time and subject) and a
    // new one follows. Only the new one is a landing.
    repo.git(&["reset", "-q", "--hard", &pushed[57]]);
    repo.git(&["cherry-pick", &pushed[58], &pushed[59]]);
    assert_ne!(repo.head(), pushed[59]);
    let redo = repo.commit("ada@example.com", "redo", &[("b.txt", "b\n")]);
    repo.push();
    scan(&hub, &git).await;
    let all = landings(&hub, &scope);
    assert_eq!(all.len(), 61);
    assert_eq!(all[60].sha.as_str(), redo);
    assert_eq!(hub.work.watch(&scope).unwrap().unwrap().last_sha, redo);

    // Rewritten back to where the watch started: nothing older than the watch is reported.
    repo.git(&["reset", "-q", "--hard", &before]);
    let again = repo.commit("ada@example.com", "again", &[("c.txt", "c\n")]);
    repo.push();
    scan(&hub, &git).await;
    let all = landings(&hub, &scope);
    assert_eq!((all.len(), all[61].sha.as_str()), (62, again.as_str()));
}

#[tokio::test]
async fn a_project_is_bound_from_its_root_on_any_host_and_not_without_a_remote() {
    let (hub, _clock, _home) = hub();
    let git = LocalGit::default();
    let repo = Repo::new(GITLAB);
    let root = repo.checkout("shop");
    let shop = project(&hub, "devbox", "shop", &root);
    assert_eq!(
        bind_with(&hub, &git, &shop, &root).await.unwrap(),
        Some(scope(GITLAB))
    );

    // Without origin/HEAD the remote's own HEAD names the base.
    repo.run(
        Path::new(&root),
        &["remote", "set-head", "origin", "--delete"],
        None,
    );
    let other = project(&hub, "devbox", "other", &root);
    assert_eq!(
        bind_with(&hub, &git, &other, &root).await.unwrap(),
        Some(scope(GITLAB))
    );

    // origin/HEAD names the base, as the lab points it at its slot's.
    repo.git(&["push", "-q", "origin", "main:slot/3/main"]);
    repo.run(Path::new(&root), &["fetch", "-q", "origin"], None);
    repo.run(
        Path::new(&root),
        &["remote", "set-head", "origin", "slot/3/main"],
        None,
    );
    let bound = bind_with(&hub, &git, &shop, &root).await.unwrap().unwrap();
    assert_eq!(bound.base.as_str(), "slot/3/main");
    assert_eq!(hub.work.scope_of(&shop).unwrap(), Some(bound));

    // Offline: what was recorded.
    git.offline.lock().unwrap().insert("devbox".into());
    assert_eq!(
        bind_with(&hub, &git, &shop, &root)
            .await
            .unwrap()
            .map(|s| s.base.to_string()),
        Some("slot/3/main".into())
    );
    git.offline.lock().unwrap().clear();

    let bare = repo.path("bare");
    std::fs::create_dir_all(&bare).unwrap();
    repo.run(&bare, &["init", "-q"], None);
    let local = project(&hub, "devbox", "local", bare.to_str().unwrap());
    assert_eq!(
        bind_with(&hub, &git, &local, bare.to_str().unwrap())
            .await
            .unwrap(),
        None
    );
    assert_eq!(hub.work.scope_of(&local).unwrap(), None);

    // Its origin removed, a bound project is unbound: its work no longer lands anywhere fleetd can see.
    repo.run(Path::new(&root), &["remote", "remove", "origin"], None);
    assert_eq!(bind_with(&hub, &git, &shop, &root).await.unwrap(), None);
    assert_eq!(hub.work.scope_of(&shop).unwrap(), None);
}

#[tokio::test]
async fn a_project_from_before_the_ledger_is_bound_once_its_node_connects() {
    let (hub, _clock, _home) = hub();
    let repo = Repo::new(GITLAB);
    let git = LocalGit::default();
    // Projects the hub already had, never bound: one on the machine that connects, one on another.
    let shop = project(&hub, "devbox", "shop", &repo.checkout("shop"));
    let other = project(&hub, "laptop", "shop", &repo.checkout("laptop-shop"));
    let cursor = hub.events.head();
    hub.events
        .append(NewEvent {
            at: fleetd_contracts::ids::Timestamp(AT.into()),
            r#type: HubEventType::MachineOnline,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: None,
            thread_id: None,
            summary: "devbox is online".into(),
            data: None,
            attention: None,
        })
        .unwrap();

    let (machines, next) = machines_online(&hub, cursor, 0).await;
    assert_eq!(machines, [MachineId::unchecked("devbox")]);
    assert!(next > cursor);
    for machine in &machines {
        assert_eq!(bind_unbound(&hub, &git, Some(machine)).await, 1);
    }
    assert_eq!(hub.work.scope_of(&shop).unwrap(), Some(scope(GITLAB)));
    assert_eq!(
        hub.work.scope_of(&other).unwrap(),
        None,
        "its node hasn't connected"
    );
    // A bound project is skipped; the hub-start pass takes the rest.
    assert_eq!(
        bind_unbound(&hub, &git, Some(&MachineId::unchecked("devbox"))).await,
        0
    );
    assert_eq!(bind_unbound(&hub, &git, None).await, 1);
    assert_eq!(hub.work.scope_of(&other).unwrap(), Some(scope(GITLAB)));
}
