//! The train over real git in temp repos (a bare "origin", the project's checkout, an author's clone) run by local
//! commands, a fake `gh` that answers from that origin like GitHub would (CI red iff the head has a file FAIL), and a
//! fake host for tasks, workstreams, decisions, events and wakes.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Notify;

use super::contract::*;
use super::github::{GhOut, GhRunner, TRAIN_CONTEXT};
use super::host::*;
use super::records::{Db, ListFilter};
use super::service::{ReviewGate, Train, TrainOptions, Verdict};
use crate::clock::SystemClock;

const REPO: &str = "wynn-dev/lab";
const GIT_ENV: [(&str, &str); 8] = [
    ("HOME", "/tmp"),
    ("LANG", "C"),
    ("GIT_CONFIG_GLOBAL", "/dev/null"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_AUTHOR_NAME", "author"),
    ("GIT_AUTHOR_EMAIL", "author@example.invalid"),
    ("GIT_COMMITTER_NAME", "author"),
    ("GIT_COMMITTER_EMAIL", "author@example.invalid"),
];

fn git_out(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .envs(GIT_ENV)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git(cwd: &Path, args: &[&str]) -> String {
    git_out(cwd, args).unwrap_or_else(|| panic!("git {args:?} failed in {}", cwd.display()))
}

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: ProjectId::unchecked("p1"),
    }
}

fn ws() -> WorkstreamId {
    WorkstreamId::unchecked("W1")
}

struct FakePull {
    branch: String,
    body: String,
    state: String,
    merged: bool,
    merge_sha: Option<String>,
    merged_at: Option<String>,
}

/// The repo's CI as the fake answers it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum FakeCi {
    /// A `ci` check run on every head, red iff the head has a file FAIL.
    Actions,
    /// No workflows, no required checks, no check runs.
    None,
    /// No check runs (yet), but main requires a `build` check through a ruleset.
    Required,
    /// No check runs, and the workflows can't be read.
    Unreadable,
}

/// GitHub as the train sees it, answered from the origin repo.
struct FakeGh {
    origin: PathBuf,
    ci: FakeCi,
    pulls: Mutex<HashMap<i64, FakePull>>,
    statuses: Mutex<Vec<(String, String, String)>>,
    merges: Mutex<Vec<(i64, String)>>,
    /// Scripted answers to the next merge calls, before the fake merges for real.
    merge_replies: Mutex<Vec<GhOut>>,
}

fn ok(body: Value) -> GhOut {
    GhOut {
        exit_code: 0,
        stdout: body.to_string(),
        stderr: String::new(),
    }
}

fn http_error(status: u16, message: &str) -> GhOut {
    GhOut {
        exit_code: 1,
        stdout: json!({ "message": message, "status": status.to_string() }).to_string(),
        stderr: format!("gh: {message} (HTTP {status})\n"),
    }
}

impl FakeGh {
    fn head_of(&self, branch: &str) -> Option<String> {
        git_out(
            &self.origin,
            &["rev-parse", &format!("refs/heads/{branch}")],
        )
    }

    fn pull_json(&self, n: i64, p: &FakePull) -> Value {
        json!({
            "number": n, "state": p.state, "merged": p.merged, "merge_commit_sha": p.merge_sha, "merged_at": p.merged_at, "body": p.body,
            "head": { "ref": p.branch, "sha": self.head_of(&p.branch).unwrap_or_else(|| "0".repeat(40)), "repo": { "full_name": REPO } },
            "base": { "ref": "main" },
        })
    }

    /// Squash onto main: main's head as parent, the PR head's tree. Refused like GitHub when the head or main moved.
    fn merge(&self, n: i64, p: &mut FakePull, sha: &str) -> GhOut {
        if self.head_of(&p.branch).as_deref() != Some(sha) {
            return http_error(
                409,
                "Head branch was modified. Review and try the merge again.",
            );
        }
        if !self
            .statuses
            .lock()
            .unwrap()
            .iter()
            .any(|(s, c, st)| s == sha && c == TRAIN_CONTEXT && st == "success")
        {
            return http_error(405, "Required status check \"fleetd/train\" is expected.");
        }
        let main = self.head_of("main").unwrap();
        if git(&self.origin, &["merge-base", &main, sha]) != main {
            return http_error(
                405,
                "Base branch was modified. Review and try the merge again.",
            );
        }
        let squash = git(
            &self.origin,
            &[
                "commit-tree",
                &format!("{sha}^{{tree}}"),
                "-p",
                &main,
                "-m",
                &format!("squash #{n}"),
            ],
        );
        git(&self.origin, &["update-ref", "refs/heads/main", &squash]);
        p.merged = true;
        p.state = "closed".into();
        p.merge_sha = Some(squash.clone());
        p.merged_at = Some("2026-10-17T12:00:00Z".into());
        self.merges.lock().unwrap().push((n, sha.to_string()));
        ok(json!({ "sha": squash, "merged": true, "message": "Pull Request successfully merged" }))
    }

    fn answer(&self, args: &[String]) -> GhOut {
        let method = args
            .iter()
            .position(|a| a == "-X")
            .and_then(|i| args.get(i + 1))
            .map_or("GET", String::as_str);
        let target = args
            .iter()
            .find(|a| a.starts_with("repos/"))
            .cloned()
            .unwrap_or_default();
        let fields: HashMap<&str, &str> = args
            .windows(2)
            .filter(|w| w[0] == "-f")
            .filter_map(|w| w[1].split_once('='))
            .collect();
        let (path, query) = target.split_once('?').unwrap_or((&target, ""));
        let parts: Vec<&str> = path.split('/').skip(3).collect();
        let number = |s: Option<&&str>| s.and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
        match (parts.as_slice(), method) {
            (["pulls"], _) if query.contains("state=closed") => {
                let pulls = self.pulls.lock().unwrap();
                ok(Value::Array(
                    pulls
                        .iter()
                        .filter(|(_, p)| p.state == "closed")
                        .map(|(n, p)| self.pull_json(*n, p))
                        .collect(),
                ))
            }
            (["pulls", n], "GET") => match self.pulls.lock().unwrap().get(&number(Some(n))) {
                Some(p) => ok(self.pull_json(number(Some(n)), p)),
                None => http_error(404, "Not Found"),
            },
            (["pulls", n, "merge"], "PUT") => {
                let mut scripted = self.merge_replies.lock().unwrap();
                if !scripted.is_empty() {
                    return scripted.remove(0);
                }
                drop(scripted);
                let n = number(Some(n));
                match self.pulls.lock().unwrap().get_mut(&n) {
                    Some(p) => self.merge(n, p, fields.get("sha").copied().unwrap_or_default()),
                    None => http_error(404, "Not Found"),
                }
            }
            (["commits", _, "check-runs"], _) if self.ci != FakeCi::Actions => {
                ok(json!({ "total_count": 0, "check_runs": [] }))
            }
            (["commits", sha, "check-runs"], _) => {
                let red =
                    git_out(&self.origin, &["cat-file", "-e", &format!("{sha}:FAIL")]).is_some();
                ok(
                    json!({ "check_runs": [{ "id": 1, "name": "ci", "status": "completed", "conclusion": if red { "failure" } else { "success" }, "html_url": format!("https://github.com/{REPO}/actions/runs/1") }] }),
                )
            }
            (["commits", sha, "status"], "GET") => {
                let statuses = self.statuses.lock().unwrap();
                let mine: Vec<Value> = statuses
                    .iter()
                    .filter(|(s, ..)| s == sha)
                    .map(|(_, context, state)| json!({ "context": context, "state": state }))
                    .collect();
                ok(json!({ "total_count": mine.len(), "statuses": mine }))
            }
            (["actions", "workflows"], "GET") => match self.ci {
                FakeCi::Actions => ok(
                    json!({ "total_count": 1, "workflows": [{ "name": "CI", "path": ".github/workflows/ci.yml", "state": "active" }] }),
                ),
                FakeCi::Unreadable => http_error(403, "Resource not accessible by integration"),
                // Dependabot's dynamic workflow is GitHub's, not the repo's CI.
                FakeCi::None | FakeCi::Required => ok(
                    json!({ "total_count": 1, "workflows": [{ "name": "Dependabot Updates", "path": "dynamic/dependabot/dependabot-updates", "state": "active" }] }),
                ),
            },
            (["branches", "main"], "GET") => ok(
                json!({ "name": "main", "protected": false, "protection": { "enabled": false, "required_status_checks": { "enforcement_level": "off", "contexts": [] } } }),
            ),
            (["rules", "branches", "main"], "GET") => ok(if self.ci == FakeCi::Required {
                json!([{ "type": "required_status_checks", "ruleset_id": 1, "parameters": { "required_status_checks": [{ "context": "build" }] } }])
            } else {
                json!([])
            }),
            (["statuses", sha], "POST") => {
                let get = |k: &str| fields.get(k).copied().unwrap_or_default().to_string();
                self.statuses
                    .lock()
                    .unwrap()
                    .push((sha.to_string(), get("context"), get("state")));
                ok(json!({ "state": get("state") }))
            }
            _ => http_error(404, "Not Found"),
        }
    }
}

impl GhRunner for FakeGh {
    fn run(&self, args: Vec<String>) -> BoxFut<'_, Result<GhOut, String>> {
        let out = self.answer(&args);
        Box::pin(async move { Ok(out) })
    }
}

/// The rest of the hub: tasks, workstreams, decisions, incidents, events and wakes in memory; commands run locally.
struct FakeHost {
    checkout: PathBuf,
    tasks: Mutex<HashMap<String, TaskView>>,
    sends: Mutex<Vec<(String, String)>>,
    decisions: Mutex<HashMap<String, DecisionView>>,
    incidents: Mutex<Vec<IncidentInput>>,
    events: Mutex<Vec<EventView>>,
    appended: Notify,
    wakes: Mutex<Vec<String>>,
}

impl FakeHost {
    fn events_of(&self, event_type: &str) -> Vec<Value> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.event_type == event_type)
            .map(|e| e.data.clone())
            .collect()
    }

    /// The first event of this type after `cursor`, waiting for it.
    async fn next_event(&self, cursor: i64, event_type: &str) -> Value {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let notified = self.appended.notified();
                if let Some(e) = self
                    .events
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|e| e.seq > cursor && e.event_type == event_type)
                {
                    return e.data.clone();
                }
                notified.await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no {event_type} event"))
    }

    fn push_event(&self, event_type: &str, data: Value) {
        let mut events = self.events.lock().unwrap();
        let seq = events.len() as i64 + 1;
        events.push(EventView {
            seq,
            event_type: event_type.into(),
            data,
        });
        drop(events);
        self.appended.notify_waiters();
    }
}

impl TrainHost for FakeHost {
    fn task(&self, task_id: &TaskId) -> Option<TaskView> {
        self.tasks.lock().unwrap().get(task_id.as_str()).cloned()
    }
    fn message_task<'a>(
        &'a self,
        _: &'a ProjectRef,
        _: &'static str,
        task_id: &'a TaskId,
        text: String,
    ) -> BoxFut<'a, Result<(), String>> {
        self.sends.lock().unwrap().push((task_id.to_string(), text));
        Box::pin(async { Ok(()) })
    }
    fn spawn_review(&self, _: ReviewSpawn) -> BoxFut<'_, Result<TaskView, String>> {
        Box::pin(async { Err("no reviews in train tests".into()) })
    }
    fn workstream(&self, workstream_id: &WorkstreamId) -> Option<WorkstreamView> {
        (*workstream_id == ws()).then(|| WorkstreamView {
            workstream_id: ws(),
            project_ref: project(),
            brief: Some(BriefView {
                tier: Tier::S,
                done_when: 1,
            }),
            playbook: None,
        })
    }
    fn playbook(&self, _: &str) -> Option<PlaybookView> {
        None
    }
    fn resolve_decision(&self, key: &str, _: &ProjectRef) -> Option<DecisionView> {
        self.decisions.lock().unwrap().get(key).cloned()
    }
    fn record_decision(
        &self,
        _: &str,
        _: &ProjectRef,
        _: &str,
        _: Option<&str>,
        _: bool,
        _: &str,
    ) -> Result<(), String> {
        Err("decisions are set directly in train tests".into())
    }
    fn retire_decision(&self, _: &str) -> Result<(), String> {
        Err("decisions are set directly in train tests".into())
    }
    fn record_incident(&self, incident: IncidentInput) {
        self.incidents.lock().unwrap().push(incident);
    }
    fn append_event(&self, _: &ProjectRef, event_type: &'static str, _: String, data: Value) {
        self.push_event(event_type, data);
    }
    fn events_head(&self) -> i64 {
        self.events.lock().unwrap().len() as i64
    }
    fn events_wait<'a>(
        &'a self,
        cursor: i64,
        types: &'a [&'static str],
        _: u64,
    ) -> BoxFut<'a, (Vec<EventView>, i64)> {
        Box::pin(async move {
            loop {
                let notified = self.appended.notified();
                {
                    let events = self.events.lock().unwrap();
                    let head = events.len() as i64;
                    if head > cursor {
                        let page = events
                            .iter()
                            .filter(|e| e.seq > cursor && types.contains(&e.event_type.as_str()))
                            .cloned()
                            .collect();
                        return (page, head);
                    }
                }
                notified.await;
            }
        })
    }
    fn project_root(&self, _: &ProjectRef) -> Option<String> {
        Some(self.checkout.display().to_string())
    }
    fn wake_lead<'a>(&'a self, _: &'a ProjectRef, line: String) -> BoxFut<'a, ()> {
        self.wakes.lock().unwrap().push(line);
        Box::pin(async {})
    }
    fn run_command<'a>(
        &'a self,
        _: &'a MachineId,
        cwd: &'a str,
        argv: Vec<String>,
        _: u64,
    ) -> BoxFut<'a, Result<CmdOut, String>> {
        let cwd = cwd.to_string();
        Box::pin(async move {
            let out = tokio::task::spawn_blocking(move || {
                Command::new(&argv[0])
                    .args(&argv[1..])
                    .current_dir(&cwd)
                    .env_clear()
                    .env("PATH", std::env::var("PATH").unwrap_or_default())
                    .envs(GIT_ENV)
                    .output()
            })
            .await
            .map_err(|e| e.to_string())?;
            Ok(match out {
                Ok(out) => {
                    let text = format!(
                        "{}{}",
                        String::from_utf8_lossy(&out.stdout),
                        String::from_utf8_lossy(&out.stderr)
                    );
                    let tail: String = text
                        .chars()
                        .rev()
                        .take(2000)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    CmdOut {
                        exit_code: out.status.code(),
                        output_tail: tail,
                        timed_out: false,
                    }
                }
                Err(e) => CmdOut {
                    exit_code: None,
                    output_tail: format!("could not run: {e}"),
                    timed_out: false,
                },
            })
        })
    }
    fn provider_instances<'a>(
        &'a self,
        _: &'a MachineId,
    ) -> BoxFut<'a, Result<Vec<ProviderView>, String>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn review_refusal(
        &self,
        _: &WorkstreamId,
        _: &str,
        _: &str,
        _: &[PrVerdict],
    ) -> Option<ReviewRefusal> {
        None
    }
}

/// Tier S ready at once, the rest pending until the test marks them ready; records what it was handed.
#[derive(Default)]
struct FakeGate {
    reviewed: Mutex<Vec<Change>>,
}

impl ReviewGate for FakeGate {
    fn review(&self, change: Change) -> BoxFut<'_, Verdict> {
        let verdict = if change.tier == Tier::S {
            Verdict::Ready
        } else {
            Verdict::Pending
        };
        self.reviewed.lock().unwrap().push(change);
        Box::pin(async move { verdict })
    }
}

struct Kit {
    _dir: TempDir,
    author: PathBuf,
    gh: Arc<FakeGh>,
    host: Arc<FakeHost>,
    gate: Arc<FakeGate>,
    train: Arc<Train>,
}

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn a_with(edits: &[(usize, &str)]) -> String {
    (1..=10)
        .map(|i| {
            edits
                .iter()
                .find(|(n, _)| *n == i)
                .map_or(format!("line {i}"), |(_, s)| s.to_string())
                + "\n"
        })
        .collect()
}

impl Kit {
    fn new() -> Kit {
        Kit::with(FakeCi::Actions, |_| {})
    }

    fn with(ci: FakeCi, tweak: impl FnOnce(&mut TrainOptions)) -> Kit {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "fleetd-train-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (origin, author, checkout) = (
            dir.join("origin.git"),
            dir.join("author"),
            dir.join("project"),
        );
        git(
            &dir,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                origin.to_str().unwrap(),
            ],
        );
        git(
            &dir,
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                author.to_str().unwrap(),
            ],
        );
        std::fs::write(author.join("a.txt"), a_with(&[])).unwrap();
        git(&author, &["add", "-A"]);
        git(&author, &["commit", "-q", "-m", "base"]);
        git(&author, &["push", "-q", "origin", "HEAD:main"]);
        git(
            &dir,
            &[
                "clone",
                "-q",
                origin.to_str().unwrap(),
                checkout.to_str().unwrap(),
            ],
        );

        let db: Db = crate::hub::store::HubDb::open_memory().unwrap();
        let gh = Arc::new(FakeGh {
            origin,
            ci,
            pulls: Mutex::default(),
            statuses: Mutex::default(),
            merges: Mutex::default(),
            merge_replies: Mutex::default(),
        });
        let host = Arc::new(FakeHost {
            checkout,
            tasks: Mutex::default(),
            sends: Mutex::default(),
            decisions: Mutex::default(),
            incidents: Mutex::default(),
            events: Mutex::default(),
            appended: Notify::new(),
            wakes: Mutex::default(),
        });
        let gate = Arc::new(FakeGate::default());
        let worktree = dir.join("train-wt").display().to_string();
        let mut options = TrainOptions {
            auto_run: false,
            bypass_every: Duration::ZERO,
            worktree_for: Arc::new(move |_| worktree.clone()),
            ..TrainOptions::default()
        };
        tweak(&mut options);
        let gate_for_train = gate.clone();
        let train = Train::new(
            host.clone(),
            Arc::new(SystemClock),
            db,
            gh.clone(),
            options,
            |_| gate_for_train,
        );
        train.start();
        Kit {
            _dir: TempDir(dir),
            author,
            gh,
            host,
            gate,
            train,
        }
    }

    fn head_of(&self, branch: &str) -> String {
        self.gh.head_of(branch).unwrap()
    }

    fn main_file(&self, file: &str) -> Option<String> {
        git_out(&self.gh.origin, &["show", &format!("main:{file}")])
    }

    /// Commits `files` (None deletes) on `branch` from `from` in the author's clone and pushes it. Returns the head.
    fn commit(&self, branch: &str, files: &[(&str, Option<&str>)], from: Option<&str>) -> String {
        let from = from.map_or(format!("origin/{branch}"), String::from);
        git(&self.author, &["fetch", "-q", "origin"]);
        let start = if git_out(&self.author, &["rev-parse", "--verify", &from]).is_some() {
            from
        } else {
            "origin/main".into()
        };
        git(&self.author, &["checkout", "-q", "-B", branch, &start]);
        for (file, content) in files {
            match content {
                Some(c) => std::fs::write(self.author.join(file), c).unwrap(),
                None => std::fs::remove_file(self.author.join(file)).unwrap(),
            }
        }
        git(&self.author, &["add", "-A"]);
        git(
            &self.author,
            &["commit", "-q", "-m", &format!("change {branch}")],
        );
        git(
            &self.author,
            &[
                "push",
                "-q",
                "--force",
                "origin",
                &format!("HEAD:refs/heads/{branch}"),
            ],
        );
        self.head_of(branch)
    }

    /// A PR from `branch` (pushed with `files` on top of main) with `body`.
    fn open_pr(
        &self,
        number: i64,
        branch: &str,
        files: &[(&str, Option<&str>)],
        body: &str,
    ) -> String {
        self.commit(branch, files, Some("origin/main"));
        let pull = FakePull {
            branch: branch.into(),
            body: body.into(),
            state: "open".into(),
            merged: false,
            merge_sha: None,
            merged_at: None,
        };
        self.gh.pulls.lock().unwrap().insert(number, pull);
        format!("https://github.com/{REPO}/pull/{number}")
    }

    async fn enqueue(&self, pr_url: String, tier: Option<Tier>) -> Change {
        let input = ChangeEnqueueCall {
            tier,
            ..enqueue_call(pr_url, None)
        };
        self.train
            .enqueue(&project(), input)
            .await
            .expect("enqueued")
    }

    /// A write task that opened `pr_url`, completed: the train auto-enqueues it. Returns the ready Change's id.
    async fn author_task(&self, pr_url: Option<&str>) -> (TaskId, ChangeId) {
        let task_id = TaskId::unchecked("T1");
        let task = TaskView {
            task_id: task_id.clone(),
            project_ref: project(),
            workstream_id: ws(),
            kind: "write".into(),
            state: "done".into(),
            serves: Some("done:0".into()),
            tier: None,
            pr_url: pr_url.map(String::from),
            receipt_commands: 0,
            claims_unverified: false,
            result_tail: None,
        };
        self.host
            .tasks
            .lock()
            .unwrap()
            .insert(task_id.to_string(), task);
        let cursor = self.host.events_head();
        self.host
            .push_event("task.completed", json!({ "taskId": task_id }));
        let ready = self.host.next_event(cursor, "change.ready").await;
        (
            task_id,
            ChangeId::unchecked(ready["changeId"].as_str().unwrap()),
        )
    }

    fn get(&self, id: &ChangeId) -> Change {
        self.train.get(id).unwrap()
    }
}

fn enqueue_call(pr_url: String, serves: Option<&str>) -> ChangeEnqueueCall {
    ChangeEnqueueCall {
        task_id: None,
        pr_url: GitHubPrUrl::unchecked(pr_url),
        workstream_id: Some(ws()),
        serves: serves.map(Serves::unchecked),
        tier: None,
    }
}

fn add(file: &'static str, content: &'static str) -> (&'static str, Option<&'static str>) {
    (file, Some(content))
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_pr_without_a_valid_source_line_writing_a_refused_row_only_when_the_serves_is_known()
 {
    let kit = Kit::new();
    let bare = kit.open_pr(3, "no-source", &[add("b.txt", "b\n")], "Adds b.");
    let refused = kit
        .train
        .enqueue(&project(), enqueue_call(bare, None))
        .await
        .unwrap_err();
    assert_eq!(
        (refused.code, refused.fix.as_deref()),
        ("invalid", Some("add 'Source: done:0' to the PR body"))
    );
    assert!(
        kit.train
            .list(&ListFilter {
                limit: 10,
                ..Default::default()
            })
            .is_empty()
    );

    let wrong = kit.open_pr(4, "wrong-source", &[add("c.txt", "c\n")], "Source: done:5");
    let input = enqueue_call(wrong, Some("done:0"));
    let mismatch = kit.train.enqueue(&project(), input).await.unwrap_err();
    assert_eq!(
        mismatch.fix.as_deref(),
        Some("change the PR body's line to 'Source: done:0'")
    );
    let listed = kit.train.list(&ListFilter {
        limit: 10,
        ..Default::default()
    });
    assert_eq!(
        listed
            .iter()
            .map(|c| (c.pr_number.get(), c.state, c.serves.as_str()))
            .collect::<Vec<_>>(),
        [(4, ChangeState::Refused, "done:0")]
    );

    let fixes: Vec<Value> = kit
        .host
        .events_of("change.refused")
        .into_iter()
        .map(|d| d["fix"].clone())
        .collect();
    assert_eq!(
        fixes,
        [
            json!("add 'Source: done:0' to the PR body"),
            json!("change the PR body's line to 'Source: done:0'")
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_enqueues_a_write_tasks_pr_rebases_it_onto_the_moved_base_and_merges_pinned_with_fleetd_train()
 {
    let kit = Kit::new();
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")], "Source: done:0");
    let (task_id, change_id) = kit.author_task(Some(&pr)).await;
    // Ready once its patch id is read, since tier S needs no review.
    let before = kit.get(&change_id);
    assert_eq!(
        (
            before.state,
            before.task_id.as_ref(),
            before.tier,
            before.position.map(|p| p.get()),
            before.branch.as_str()
        ),
        (ChangeState::Ready, Some(&task_id), Tier::S, Some(0), "docs")
    );

    // main moves on in another file: a clean rebase that keeps the patch id.
    kit.commit("main", &[add("other.txt", "other\n")], None);
    assert!(kit.train.step(REPO).await);

    let merged = kit.get(&change_id);
    assert_eq!(merged.state, ChangeState::Merged);
    assert_eq!(merged.patch_id, before.patch_id);
    assert_ne!(merged.head_sha, before.head_sha);
    assert_eq!(
        *kit.gh.merges.lock().unwrap(),
        [(7, merged.head_sha.to_string())]
    );
    assert_eq!(
        *kit.gh.statuses.lock().unwrap(),
        [(
            merged.head_sha.to_string(),
            "fleetd/train".to_string(),
            "success".to_string()
        )]
    );
    assert_eq!(
        merged.merged_sha.as_deref(),
        Some(kit.head_of("main").as_str())
    );
    assert_eq!(kit.main_file("docs.md").as_deref(), Some("docs"));
    assert_eq!(kit.main_file("other.txt").as_deref(), Some("other"));
    assert_eq!(
        kit.host.events_of("pr.merged"),
        [
            json!({ "changeId": change_id, "repo": REPO, "prNumber": 7, "mergedSha": merged.merged_sha })
        ]
    );
    let state = kit.train.state(REPO);
    assert_eq!(
        (
            state.repo.as_str(),
            state.frozen,
            state.head,
            state.queue.into_inner()
        ),
        (REPO, false, None, vec![])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_a_conflicting_pr_back_to_its_author_with_the_paths_moves_on_and_merges_it_after_the_author_pushes()
 {
    let kit = Kit::new();
    let pr = kit.open_pr(
        7,
        "edit-a",
        &[("a.txt", Some(&a_with(&[(5, "author's line 5")])))],
        "Source: done:0",
    );
    let (_, first) = kit.author_task(Some(&pr)).await;
    let other = kit
        .enqueue(
            kit.open_pr(8, "other", &[add("b.txt", "b\n")], "Source: done:0"),
            None,
        )
        .await;
    kit.commit(
        "main",
        &[("a.txt", Some(&a_with(&[(5, "main's line 5")])))],
        None,
    );

    assert!(kit.train.step(REPO).await);
    let parked = kit.get(&first);
    assert_eq!(
        (parked.state, parked.last_error.as_deref()),
        (
            ChangeState::NeedsRebase,
            Some("conflicts with origin/main in a.txt")
        )
    );
    assert_eq!(
        kit.host.events_of("change.needs_rebase"),
        [json!({ "changeId": first, "paths": ["a.txt"] })]
    );
    let (to, message) = kit.host.sends.lock().unwrap().last().cloned().unwrap();
    assert_eq!(to, "T1");
    assert!(message.contains("conflicts with origin/main in a.txt"));

    // The train moves on to the next ready PR.
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&other.change_id).state, ChangeState::Merged);

    // The author resolves onto the new main and pushes; the train takes the new head.
    kit.commit(
        "edit-a",
        &[("a.txt", Some(&a_with(&[(5, "both line 5")])))],
        Some("origin/main"),
    );
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&first).state, ChangeState::Merged);
    assert!(kit.main_file("a.txt").unwrap().contains("both line 5"));
    let merged: Vec<Value> = kit
        .host
        .events_of("pr.merged")
        .into_iter()
        .map(|d| d["changeId"].clone())
        .collect();
    assert_eq!(merged, [json!(other.change_id), json!(first)]);
}

#[tokio::test(flavor = "multi_thread")]
async fn parks_a_pr_whose_ci_is_red_wakes_its_author_with_the_failing_check_and_log_and_never_merges_it()
 {
    let kit = Kit::new();
    let pr = kit.open_pr(7, "red", &[add("FAIL", "x\n")], "Source: done:0");
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::CiFailed);
    let log_url = format!("https://github.com/{REPO}/actions/runs/1");
    assert_eq!(
        kit.host.events_of("change.ci_failed"),
        [json!({ "changeId": change_id, "checks": ["ci"], "logUrl": log_url })]
    );
    assert!(
        kit.host
            .sends
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .1
            .contains(&format!("ci (failure) (log: {log_url})"))
    );
    assert!(kit.gh.statuses.lock().unwrap().is_empty());
    // Nothing new pushed: it stays parked.
    assert!(!kit.train.step(REPO).await);
    assert!(kit.gh.merges.lock().unwrap().is_empty());
}

/// No grace before asking whether the repo has CI, and no wait for CI that never comes: one poll decides.
fn one_poll(options: &mut TrainOptions) {
    options.no_ci_grace = Duration::ZERO;
    options.ci_timeout = Duration::ZERO;
}

#[tokio::test(flavor = "multi_thread")]
async fn merges_on_local_checks_when_the_repo_has_no_ci_and_says_so_on_the_merge() {
    let kit = Kit::with(FakeCi::None, one_poll);
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")], "Source: done:0");
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    let merged = kit.get(&change_id);
    assert_eq!(merged.state, ChangeState::Merged);
    assert_eq!(kit.main_file("docs.md").as_deref(), Some("docs"));
    assert_eq!(
        kit.host.events_of("pr.merged"),
        [
            json!({ "changeId": change_id, "repo": REPO, "prNumber": 7, "mergedSha": merged.merged_sha, "ci": format!("no CI on {REPO}: used local checks") })
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_waiting_for_checks_a_repo_without_check_runs_requires() {
    let kit = Kit::with(FakeCi::Required, one_poll);
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")], "Source: done:0");
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    let parked = kit.get(&change_id);
    assert_eq!(parked.state, ChangeState::CiFailed);
    assert!(
        parked
            .last_error
            .as_deref()
            .unwrap()
            .ends_with("did not finish within 0 min"),
        "{:?}",
        parked.last_error
    );
    assert!(kit.gh.merges.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn never_takes_a_failed_ci_read_for_no_ci_and_says_what_failed() {
    let kit = Kit::with(FakeCi::Unreadable, one_poll);
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")], "Source: done:0");
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    let parked = kit.get(&change_id);
    assert_eq!(parked.state, ChangeState::CiFailed);
    let why = parked.last_error.as_deref().unwrap();
    assert!(
        why.contains(&format!("could not tell whether {REPO} has CI"))
            && why.contains("Resource not accessible by integration"),
        "{why}"
    );
    assert!(kit.gh.merges.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn requeues_at_the_front_when_github_refuses_the_pinned_merge_with_409_then_merges() {
    let kit = Kit::new();
    let a = kit
        .enqueue(
            kit.open_pr(7, "a", &[add("b.txt", "b\n")], "Source: done:0"),
            None,
        )
        .await;
    let b = kit
        .enqueue(
            kit.open_pr(8, "b", &[add("c.txt", "c\n")], "Source: done:0"),
            None,
        )
        .await;
    kit.gh.merge_replies.lock().unwrap().push(GhOut {
        exit_code: 1,
        stdout: "{}".into(),
        stderr: "gh: Head branch was modified. (HTTP 409)\n".into(),
    });

    assert!(kit.train.step(REPO).await);
    let back = kit.get(&a.change_id);
    assert_eq!(
        (
            back.state,
            back.position.map(|p| p.get()),
            back.last_error.as_ref().map(|e| e.as_str())
        ),
        (
            ChangeState::Ready,
            Some(0),
            Some("GitHub refused the merge (HTTP 409): Head branch was modified. (HTTP 409)")
        )
    );
    assert_eq!(
        kit.train.state(REPO).queue.into_inner(),
        [a.change_id.clone(), b.change_id.clone()]
    );

    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&a.change_id).state, ChangeState::Merged);
    assert_eq!(
        kit.gh
            .merges
            .lock()
            .unwrap()
            .iter()
            .map(|m| m.0)
            .collect::<Vec<_>>(),
        [7]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn holds_while_the_freeze_decision_is_true_and_resumes_when_it_goes() {
    let kit = Kit::new();
    let change = kit
        .enqueue(
            kit.open_pr(7, "a", &[add("b.txt", "b\n")], "Source: done:0"),
            None,
        )
        .await;
    let key = "policy.freeze.wynn-dev.lab";
    let freeze = DecisionView {
        decision_id: "D1".into(),
        key: key.into(),
        value: "true".into(),
        why: Some("release week".into()),
        global: false,
    };
    kit.host
        .decisions
        .lock()
        .unwrap()
        .insert(key.into(), freeze);

    assert!(!kit.train.step(REPO).await);
    assert!(!kit.train.step(REPO).await);
    assert_eq!(
        kit.host.events_of("train.frozen"),
        [json!({ "repo": REPO, "reason": "release week" })]
    );
    let held = kit.train.state(REPO);
    assert!(held.frozen && held.queue.into_inner() == [change.change_id.clone()]);
    assert!(kit.gh.merges.lock().unwrap().is_empty());

    kit.host.decisions.lock().unwrap().clear();
    assert!(kit.train.step(REPO).await);
    assert_eq!(
        kit.host.events_of("train.resumed"),
        [json!({ "repo": REPO })]
    );
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_a_change_back_to_reviewing_when_a_clean_rebase_changes_its_patch_id_and_refuses_reviews_of_the_old_patch()
 {
    let kit = Kit::new();
    let change = kit
        .enqueue(
            kit.open_pr(
                7,
                "m",
                &[("a.txt", Some(&a_with(&[(6, "pr line 6")])))],
                "Source: done:0",
            ),
            Some(Tier::M),
        )
        .await;
    assert_eq!(
        (change.state, change.tier),
        (ChangeState::Reviewing, Tier::M)
    );
    assert_eq!(
        kit.gate
            .reviewed
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.change_id.clone())
            .collect::<Vec<_>>(),
        std::slice::from_ref(&change.change_id)
    );
    let review = ChangeReview {
        task_id: TaskId::unchecked("T9"),
        pr_head_sha: change.head_sha.clone(),
        patch_id: change.patch_id.clone().unwrap(),
        blocking: Count::unchecked(0),
        non_blocking: Count::unchecked(1),
    };
    let ready = kit
        .train
        .mark_ready(&change.change_id, vec![review.clone()])
        .unwrap();
    assert_eq!(
        (ready.state, ready.reviews.clone()),
        (ChangeState::Ready, vec![review.clone()])
    );

    // main edits a line inside the PR hunk's context: the rebase is clean but the patch differs.
    kit.commit(
        "main",
        &[("a.txt", Some(&a_with(&[(4, "main line 4")])))],
        None,
    );
    assert!(kit.train.step(REPO).await);
    let after = kit.get(&change.change_id);
    assert_eq!(after.state, ChangeState::Reviewing);
    assert_ne!(after.patch_id, change.patch_id);
    assert_eq!(after.head_sha.as_str(), kit.head_of("m"));
    assert_eq!(
        kit.gate
            .reviewed
            .lock()
            .unwrap()
            .iter()
            .map(|c| c.patch_id.clone())
            .collect::<Vec<_>>(),
        [change.patch_id.clone(), after.patch_id.clone()]
    );
    assert!(kit.gh.merges.lock().unwrap().is_empty());

    let stale = kit
        .train
        .mark_ready(&change.change_id, vec![review.clone()])
        .unwrap_err();
    assert!(stale.message.contains("T9 reviewed patch"));
    let fresh = ChangeReview {
        task_id: TaskId::unchecked("T10"),
        pr_head_sha: after.head_sha.clone(),
        patch_id: after.patch_id.clone().unwrap(),
        ..review
    };
    kit.train
        .mark_ready(&change.change_id, vec![fresh])
        .unwrap();
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
}

#[tokio::test(flavor = "multi_thread")]
async fn replaces_a_stale_train_worktree_left_by_an_earlier_clone() {
    let kit = Kit::new();
    let dir = kit.author.parent().unwrap().to_path_buf();
    // An earlier clone of the project made the train worktree, then was deleted: its .git file points nowhere.
    let earlier = dir.join("earlier");
    git(
        &dir,
        &[
            "clone",
            "-q",
            kit.gh.origin.to_str().unwrap(),
            earlier.to_str().unwrap(),
        ],
    );
    let worktree = dir.join("train-wt");
    git(
        &earlier,
        &[
            "worktree",
            "add",
            "-q",
            "--detach",
            worktree.to_str().unwrap(),
        ],
    );
    std::fs::remove_dir_all(&earlier).unwrap();

    let pr = kit.open_pr(5, "stale", &[add("b.txt", "b\n")], "Source: done:0");
    let change = kit.enqueue(pr, None).await;
    assert_eq!(
        (
            change.last_error.as_ref().map(|e| e.as_str()),
            change.patch_id.is_some()
        ),
        (None, true)
    );
    let common = git(
        &worktree,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    assert!(common.ends_with("/project/.git"), "{common}");

    // A healthy worktree is kept as it is.
    std::fs::write(worktree.join("kept"), "").unwrap();
    let next = kit.open_pr(6, "next", &[add("c.txt", "c\n")], "Source: done:0");
    assert!(kit.enqueue(next, None).await.last_error.is_none());
    assert!(worktree.join("kept").exists());
    assert!(kit.host.events_of("train.blocked").is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn leaves_what_is_not_the_trains_where_its_worktree_goes_and_says_what_to_move() {
    let kit = Kit::new();
    let worktree = kit.author.parent().unwrap().join("train-wt");
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(worktree.join("notes.txt"), "mine\n").unwrap();
    let path = worktree.display().to_string();

    let pr = kit.open_pr(6, "blocked", &[add("b.txt", "b\n")], "Source: done:0");
    let change = kit.enqueue(pr, None).await;
    assert_eq!(change.state, ChangeState::Queued);
    let error = change.last_error.unwrap();
    assert!(
        error
            .as_str()
            .contains(&format!("`mv {path} {path}.moved`")),
        "{}",
        error.as_str()
    );
    assert_eq!(
        std::fs::read_to_string(worktree.join("notes.txt")).unwrap(),
        "mine\n"
    );
    let blocked = kit.host.events_of("train.blocked");
    assert_eq!(
        (blocked.len(), blocked[0]["changeId"].as_str()),
        (1, Some(change.change_id.as_str()))
    );

    // Each pass retries, but the event is not repeated for the same error; once moved, the train goes on.
    kit.train.step(REPO).await;
    assert_eq!(kit.host.events_of("train.blocked").len(), 1);
    std::fs::rename(&worktree, format!("{path}.moved")).unwrap();
    kit.train.step(REPO).await;
    let after = kit.get(&change.change_id);
    assert_eq!(
        (
            after.last_error.as_ref().map(|e| e.as_str()),
            after.patch_id.is_some()
        ),
        (None, true)
    );
}
