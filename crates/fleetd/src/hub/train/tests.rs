//! The train over real git in temp repos (a bare "origin", the project's checkout, an author's clone) run by local
//! commands, a fake `gh` that answers from that origin like GitHub would (CI red iff the head has a file FAIL, or both
//! `pair-a` and `pair-b`), and a fake host for tasks, workstreams, decisions, events and wakes.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Notify;

use super::contract::*;
use super::github::{GhOut, GhRunner, TRAIN_CONTEXT, batch_heads, batch_members};
use super::host::*;
use super::records::{Db, ListFilter};
use super::service::{ReviewGate, Train, TrainOptions, Verdict};
use crate::clock::SystemClock;

const REPO: &str = "acme/storefront";
/// A project id the fake host no longer has, as after `project_remove`.
const REMOVED: &str = "removed";
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
    /// The branch it merges into: main unless a test opens it on another.
    base: String,
    title: String,
    body: String,
    state: String,
    merged: bool,
    merge_sha: Option<String>,
    merged_at: Option<String>,
    labels: Vec<String>,
    draft: bool,
    comments: Vec<String>,
}

impl FakePull {
    fn open(branch: &str, base: &str, body: &str) -> FakePull {
        FakePull {
            branch: branch.into(),
            base: base.into(),
            title: format!("change {branch}"),
            body: body.into(),
            state: "open".into(),
            merged: false,
            merge_sha: None,
            merged_at: None,
            labels: Vec::new(),
            draft: false,
            comments: Vec::new(),
        }
    }
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
    /// No workflows; main requires only the train's own `fleetd/train` status.
    TrainOnly,
    /// A CI workflow file `yaml`, whose run for the head appears from the `run_from`th check-run poll on, and whose
    /// `ci` check is green from the `green_from`th.
    Workflow {
        yaml: &'static str,
        run_from: Option<u32>,
        green_from: Option<u32>,
    },
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
    /// Check-run reads so far, the clock of `FakeCi::Workflow`.
    polls: Mutex<u32>,
    /// What happened on GitHub, in order: `merge #<n>`, `status <context> <state> <sha>`, `close #<n>`.
    log: Mutex<Vec<String>>,
    /// A branch to push an empty commit to the first time CI is read on the batch's head: an author pushing while a
    /// batch is in CI.
    push_during_ci: Mutex<Option<String>>,
    /// A branch to push an empty commit to when the next merge is asked for: a push after the train's last look.
    push_on_merge: Mutex<Option<String>>,
    /// PRs whose next close GitHub fails.
    fail_close: Mutex<Vec<i64>>,
    /// The next merge goes through, but the answer is an error.
    merge_then_fail: Mutex<bool>,
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
        let labels: Vec<Value> = p.labels.iter().map(|l| json!({ "name": l })).collect();
        json!({
            "number": n, "title": p.title, "state": p.state, "merged": p.merged, "merge_commit_sha": p.merge_sha, "merged_at": p.merged_at, "body": p.body,
            "head": { "ref": p.branch, "sha": self.head_of(&p.branch).unwrap_or_else(|| "0".repeat(40)), "repo": { "full_name": REPO } },
            "base": { "ref": p.base }, "labels": labels, "draft": p.draft,
        })
    }

    fn red(&self, sha: &str) -> bool {
        let has =
            |f: &str| git_out(&self.origin, &["cat-file", "-e", &format!("{sha}:{f}")]).is_some();
        has("FAIL") || (has("pair-a") && has("pair-b"))
    }

    fn moves_during_ci(&self, sha: &str) {
        let mut push = self.push_during_ci.lock().unwrap();
        let Some(branch) = push.clone() else { return };
        if self.head_of("fleetd/train/batch").as_deref() != Some(sha) {
            return;
        }
        self.push_empty(&branch);
        *push = None;
    }

    fn push_empty(&self, branch: &str) {
        let head = self.head_of(branch).unwrap();
        let moved = git(
            &self.origin,
            &[
                "commit-tree",
                &format!("{head}^{{tree}}"),
                "-p",
                &head,
                "-m",
                "a push while CI runs",
            ],
        );
        git(
            &self.origin,
            &["update-ref", &format!("refs/heads/{branch}"), &moved],
        );
    }

    /// Squash onto the base: the base's head as parent, the PR head's tree. Refused like GitHub when the head or
    /// the base moved.
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
        let main = self.head_of(&p.base).unwrap();
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
        git(
            &self.origin,
            &["update-ref", &format!("refs/heads/{}", p.base), &squash],
        );
        p.merged = true;
        p.state = "closed".into();
        p.merge_sha = Some(squash.clone());
        p.merged_at = Some("2026-10-17T12:00:00Z".into());
        self.merges.lock().unwrap().push((n, sha.to_string()));
        self.log.lock().unwrap().push(format!("merge #{n}"));
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
            ([], "GET") => ok(json!({ "default_branch": "main" })),
            (["pulls"], "GET") if query.contains("state=open") && !query.contains("head=") => {
                let pulls = self.pulls.lock().unwrap();
                ok(Value::Array(
                    pulls
                        .iter()
                        .filter(|(_, p)| p.state == "open")
                        .map(|(n, p)| self.pull_json(*n, p))
                        .collect(),
                ))
            }
            (["pulls"], "GET") if query.contains("head=") => {
                let head = query
                    .split('&')
                    .find_map(|kv| kv.strip_prefix("head="))
                    .and_then(|h| h.split_once(':'))
                    .map(|(_, b)| b.to_string())
                    .unwrap_or_default();
                let state = if query.contains("state=closed") {
                    "closed"
                } else {
                    "open"
                };
                let pulls = self.pulls.lock().unwrap();
                let mut found: Vec<(&i64, &FakePull)> = pulls
                    .iter()
                    .filter(|(_, p)| p.branch == head && p.state == state)
                    .collect();
                found.sort_by_key(|(n, _)| -**n);
                ok(Value::Array(
                    found
                        .into_iter()
                        .map(|(n, p)| self.pull_json(*n, p))
                        .collect(),
                ))
            }
            (["pulls"], "POST") => {
                let mut pulls = self.pulls.lock().unwrap();
                let n = 100 + pulls.len() as i64;
                let get = |k: &str| fields.get(k).copied().unwrap_or_default();
                let mut pull = FakePull::open(get("head"), get("base"), get("body"));
                pull.title = get("title").into();
                // `draft` must come as a JSON boolean (-F), as GitHub wants it.
                pull.draft = args
                    .windows(2)
                    .any(|w| w[0] == "-F" && w[1] == "draft=true");
                pulls.insert(n, pull);
                ok(json!({ "number": n }))
            }
            (["pulls", n], "PATCH")
                if {
                    let mut failing = self.fail_close.lock().unwrap();
                    let at = failing.iter().position(|f| *f == number(Some(n)));
                    at.map(|i| failing.remove(i)).is_some()
                } =>
            {
                http_error(500, "Server Error")
            }
            (["pulls", n], "PATCH") => match self.pulls.lock().unwrap().get_mut(&number(Some(n))) {
                Some(p) => {
                    for (k, v) in &fields {
                        match *k {
                            "state" => {
                                p.state = v.to_string();
                                self.log.lock().unwrap().push(format!("close #{n}"));
                            }
                            "base" => p.base = v.to_string(),
                            "title" => p.title = v.to_string(),
                            "body" => p.body = v.to_string(),
                            _ => {}
                        }
                    }
                    ok(json!({}))
                }
                None => http_error(404, "Not Found"),
            },
            (["issues", n, "comments"], "POST") => {
                match self.pulls.lock().unwrap().get_mut(&number(Some(n))) {
                    Some(p) => {
                        p.comments
                            .push(fields.get("body").copied().unwrap_or_default().to_string());
                        ok(json!({}))
                    }
                    None => http_error(404, "Not Found"),
                }
            }
            (["git", "refs", "heads", branch @ ..], "DELETE") => {
                let branch = branch.join("/");
                git_out(
                    &self.origin,
                    &["update-ref", "-d", &format!("refs/heads/{branch}")],
                );
                // GitHub closes a PR whose head branch is deleted.
                for p in self.pulls.lock().unwrap().values_mut() {
                    if p.branch == branch && p.state == "open" {
                        p.state = "closed".into();
                    }
                }
                ok(Value::Null)
            }
            (["git", "matching-refs", "heads", prefix @ ..], "GET") => {
                let prefix = prefix.join("/");
                let refs = git(
                    &self.origin,
                    &["for-each-ref", "--format=%(refname)", "refs/heads/"],
                );
                ok(Value::Array(
                    refs.lines()
                        .filter(|r| r.starts_with(&format!("refs/heads/{prefix}")))
                        .map(|r| json!({ "ref": r }))
                        .collect(),
                ))
            }
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
                if let Some(branch) = self.push_on_merge.lock().unwrap().take() {
                    self.push_empty(&branch);
                }
                if std::mem::take(&mut *self.merge_then_fail.lock().unwrap()) {
                    let n = number(Some(n));
                    if let Some(p) = self.pulls.lock().unwrap().get_mut(&n) {
                        self.merge(n, p, fields.get("sha").copied().unwrap_or_default());
                    }
                    return http_error(502, "Bad Gateway");
                }
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
            (["commits", sha, "check-runs"], _) => {
                self.moves_during_ci(sha);
                let poll = {
                    let mut polls = self.polls.lock().unwrap();
                    *polls += 1;
                    *polls
                };
                let red = match self.ci {
                    FakeCi::Actions => self.red(sha),
                    FakeCi::Workflow {
                        green_from: Some(at),
                        ..
                    } if poll >= at => false,
                    _ => return ok(json!({ "total_count": 0, "check_runs": [] })),
                };
                ok(
                    json!({ "check_runs": [{ "id": 1, "name": "ci", "status": "completed", "conclusion": if red { "failure" } else { "success" }, "html_url": format!("https://github.com/{REPO}/actions/runs/1") }] }),
                )
            }
            (["actions", "runs"], "GET") => {
                let started = match self.ci {
                    FakeCi::Actions => true,
                    FakeCi::Workflow { run_from, .. } => {
                        run_from.is_some_and(|at| *self.polls.lock().unwrap() >= at)
                    }
                    _ => false,
                };
                ok(json!({ "total_count": i32::from(started), "workflow_runs": [] }))
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
            (["contents", ..], "GET") => match self.ci {
                FakeCi::Workflow { yaml, .. } => {
                    use base64::Engine;
                    let content = base64::engine::general_purpose::STANDARD.encode(yaml);
                    ok(json!({ "encoding": "base64", "content": content }))
                }
                _ => ok(json!({ "encoding": "base64", "content": "b246IHB1bGxfcmVxdWVzdAo=" })),
            },
            (["actions", "workflows"], "GET") => match self.ci {
                FakeCi::Actions | FakeCi::Workflow { .. } => ok(
                    json!({ "total_count": 1, "workflows": [{ "name": "CI", "path": ".github/workflows/ci.yml", "state": "active" }] }),
                ),
                FakeCi::Unreadable => http_error(403, "Resource not accessible by integration"),
                // Dependabot's dynamic workflow is GitHub's, not the repo's CI.
                FakeCi::None | FakeCi::Required | FakeCi::TrainOnly => ok(
                    json!({ "total_count": 1, "workflows": [{ "name": "Dependabot Updates", "path": "dynamic/dependabot/dependabot-updates", "state": "active" }] }),
                ),
            },
            (["branches", ..], "GET") => ok(
                json!({ "name": "main", "protected": false, "protection": { "enabled": false, "required_status_checks": { "enforcement_level": "off", "contexts": [] } } }),
            ),
            (["rules", "branches", ..], "GET") => ok(match self.ci {
                FakeCi::Required => {
                    json!([{ "type": "required_status_checks", "ruleset_id": 1, "parameters": { "required_status_checks": [{ "context": "build" }] } }])
                }
                FakeCi::TrainOnly => {
                    json!([{ "type": "required_status_checks", "ruleset_id": 1, "parameters": { "required_status_checks": [{ "context": TRAIN_CONTEXT }] } }])
                }
                _ => json!([]),
            }),
            (["statuses", sha], "POST") => {
                let get = |k: &str| fields.get(k).copied().unwrap_or_default().to_string();
                self.statuses
                    .lock()
                    .unwrap()
                    .push((sha.to_string(), get("context"), get("state")));
                self.log.lock().unwrap().push(format!(
                    "status {} {} {sha}",
                    get("context"),
                    get("state")
                ));
                ok(json!({ "state": get("state") }))
            }
            _ => http_error(404, "Not Found"),
        }
    }
}

impl GhRunner for FakeGh {
    fn run(&self, args: Vec<String>) -> BoxFut<'_, Result<GhOut, String>> {
        let out = self.answer(&args);
        // Like a real `gh` call, an answer is a suspension point, so racing callers interleave.
        Box::pin(async move {
            tokio::task::yield_now().await;
            Ok(out)
        })
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
    /// The node's cmdRoots, when a test sets them: commands elsewhere are refused as the node refuses them.
    cmd_roots: Mutex<Option<Vec<String>>>,
    /// Reviewers the real review gate asked for, and the refusal the spawn path answers with, if any.
    review_spawns: Mutex<Vec<ReviewSpawn>>,
    spawn_refusal: Mutex<Option<String>>,
    /// Running write tasks' branches, by task id.
    branches: Mutex<HashMap<String, String>>,
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
    fn running_writers(&self, _: &ProjectRef) -> Vec<(TaskId, String)> {
        let tasks = self.tasks.lock().unwrap();
        self.branches
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| {
                tasks
                    .get(*id)
                    .is_some_and(|t| t.state == "running" && t.kind == "write")
            })
            .map(|(id, b)| (TaskId::unchecked(id), b.clone()))
            .collect()
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
    fn spawn_review(&self, spawn: ReviewSpawn) -> BoxFut<'_, Result<TaskView, String>> {
        let refused = self.spawn_refusal.lock().unwrap().clone();
        let mut spawns = self.review_spawns.lock().unwrap();
        let answer = match refused {
            Some(why) => Err(why),
            None => Ok(TaskView {
                task_id: TaskId::unchecked(format!("T{}", 50 + spawns.len())),
                project_ref: spawn.project_ref.clone(),
                workstream_id: spawn.workstream_id.clone(),
                kind: "review".into(),
                state: "running".into(),
                serves: Some(spawn.serves.clone()),
                tier: Some(spawn.tier),
                pr_url: Some(spawn.pr.clone()),
                receipt_commands: 0,
                claims_unverified: false,
                result_tail: None,
            }),
        };
        if answer.is_ok() {
            spawns.push(spawn);
        }
        Box::pin(async move { answer })
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
    fn project_root(&self, project_ref: &ProjectRef) -> Option<String> {
        (project_ref.project_id.as_str() != REMOVED).then(|| self.checkout.display().to_string())
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
        let roots = self.cmd_roots.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(Err(why)) = roots.map(|r| crate::node::cmd::confine(&cwd, &r)) {
                return Ok(CmdOut {
                    exit_code: None,
                    output_tail: format!("{}{why}", crate::node::cmd::REFUSED),
                    timed_out: false,
                });
            }
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
        Kit::build(ci, tweak, false)
    }

    /// With the hub's own review gate in place of the fake one.
    fn with_reviews() -> Kit {
        Kit::build(FakeCi::Actions, |_| {}, true)
    }

    fn build(ci: FakeCi, tweak: impl FnOnce(&mut TrainOptions), real_reviews: bool) -> Kit {
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
            polls: Mutex::default(),
            log: Mutex::default(),
            push_during_ci: Mutex::default(),
            push_on_merge: Mutex::default(),
            fail_close: Mutex::default(),
            merge_then_fail: Mutex::default(),
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
            cmd_roots: Mutex::default(),
            review_spawns: Mutex::default(),
            spawn_refusal: Mutex::default(),
            branches: Mutex::default(),
        });
        let gate = Arc::new(FakeGate::default());
        let worktree = dir.join("train-wt").display().to_string();
        let mut options = TrainOptions {
            auto_run: false,
            bypass_every: Duration::ZERO,
            ready_every: Duration::ZERO,
            worktree_for: Arc::new(move |_| worktree.clone()),
            ..TrainOptions::default()
        };
        tweak(&mut options);
        let gate_for_train = gate.clone();
        let train = if real_reviews {
            crate::hub::reviews::service::build(
                host.clone(),
                Arc::new(SystemClock),
                db,
                gh.clone(),
                options,
            )
            .0
        } else {
            Train::new(
                host.clone(),
                Arc::new(SystemClock),
                db,
                gh.clone(),
                options,
                |_| gate_for_train,
            )
        };
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
        self.file_on("main", file)
    }

    fn file_on(&self, branch: &str, file: &str) -> Option<String> {
        git_out(&self.gh.origin, &["show", &format!("{branch}:{file}")])
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
        self.open_pr_on("main", number, branch, files, body)
    }

    /// A PR into `base`, which starts at main when the origin lacks it.
    fn open_pr_on(
        &self,
        base: &str,
        number: i64,
        branch: &str,
        files: &[(&str, Option<&str>)],
        body: &str,
    ) -> String {
        if self.gh.head_of(base).is_none() {
            git(&self.gh.origin, &["branch", base, "main"]);
        }
        self.commit(branch, files, Some(&format!("origin/{base}")));
        self.gh
            .pulls
            .lock()
            .unwrap()
            .insert(number, FakePull::open(branch, base, body));
        format!("https://github.com/{REPO}/pull/{number}")
    }

    /// A PR from `branch`, one commit with `files` on top of `parent`'s branch, into that branch: a stacked PR.
    fn stacked_pr(
        &self,
        number: i64,
        branch: &str,
        parent: &str,
        files: &[(&str, Option<&str>)],
    ) -> String {
        self.commit(branch, files, Some(&format!("origin/{parent}")));
        self.gh
            .pulls
            .lock()
            .unwrap()
            .insert(number, FakePull::open(branch, parent, "Source: done:0"));
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
        item: None,
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
            json!({ "changeId": change_id, "workstreamId": "W1", "taskId": task_id, "repo": REPO, "prNumber": 7, "mergedSha": merged.merged_sha })
        ]
    );
    let moves: Vec<(String, String)> = kit
        .host
        .events_of("change.state")
        .iter()
        .map(|d| {
            (
                d["from"].as_str().unwrap().into(),
                d["to"].as_str().unwrap().into(),
            )
        })
        .collect();
    assert!(
        moves.ends_with(&[
            ("ready".into(), "rebasing".into()),
            ("rebasing".into(), "ci".into()),
            ("ci".into(), "merging".into()),
            ("merging".into(), "merged".into()),
        ]),
        "{moves:?}"
    );
    let ci_main = kit.host.events_of("ci.main");
    assert_eq!(
        ci_main.len(),
        1,
        "one read per minute, one event per state change"
    );
    assert_eq!(ci_main[0]["state"], "green");

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

/// A repo removed and re-added as a new project keeps its train: the next Change merges and the train follows it.
#[tokio::test(flavor = "multi_thread")]
async fn moves_the_train_to_the_repos_new_project_when_its_first_project_was_removed() {
    let kit = Kit::new();
    let removed = ProjectRef {
        machine_id: MachineId::unchecked("lab-a"),
        project_id: ProjectId::unchecked(REMOVED),
    };
    kit.train.records().ensure_train(REPO, &removed, 0);
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")], "Source: done:0");
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::Merged);
    assert_eq!(
        kit.train.records().train(REPO).unwrap().project_ref,
        project()
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
        [json!({ "changeId": first, "workstreamId": "W1", "paths": ["a.txt"] })]
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
        [
            json!({ "changeId": change_id, "workstreamId": "W1", "checks": ["ci"], "logUrl": log_url })
        ]
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

/// The one-at-a-time path: no batches.
fn one_at_a_time(options: &mut TrainOptions) {
    options.batch_max = 1;
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
    let (task_id, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    let merged = kit.get(&change_id);
    assert_eq!(merged.state, ChangeState::Merged);
    assert_eq!(kit.main_file("docs.md").as_deref(), Some("docs"));
    assert_eq!(
        kit.host.events_of("pr.merged"),
        [
            json!({ "changeId": change_id, "repo": REPO, "prNumber": 7, "mergedSha": merged.merged_sha, "ci": format!("no CI on {REPO}: used local checks"), "workstreamId": "W1", "taskId": task_id })
        ]
    );
}

/// Merges `docs.md` alone and returns the `pr.merged` event's `ci` note, if any.
async fn merge_docs(kit: &Kit) -> Option<Value> {
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")], "Source: done:0");
    let (_, change_id) = kit.author_task(Some(&pr)).await;
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::Merged);
    assert_eq!(kit.main_file("docs.md").as_deref(), Some("docs"));
    kit.host.events_of("pr.merged")[0].get("ci").cloned()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_trains_own_required_status_is_not_ci() {
    let kit = Kit::with(FakeCi::TrainOnly, one_poll);
    assert_eq!(
        merge_docs(&kit).await,
        Some(json!(format!("no CI on {REPO}: used local checks")))
    );
}

const ON_PULL_REQUEST: &str = "on:\n  pull_request:\n";
const IGNORES_NOCI: &str =
    "on:\n  pull_request:\n    branches-ignore: [\"noci/**\"]\n  push:\n    branches: [main]\n";

#[tokio::test(flavor = "multi_thread")]
async fn a_workflow_whose_triggers_skip_the_pr_is_not_ci() {
    let workflow = FakeCi::Workflow {
        yaml: "on:\n  pull_request:\n    branches: [release]\n",
        run_from: None,
        green_from: None,
    };
    let kit = Kit::with(workflow, one_poll);
    assert_eq!(
        merge_docs(&kit).await,
        Some(json!(format!("no CI on {REPO}: used local checks")))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_started_workflow_run_with_no_checks_yet_is_waited_for() {
    let workflow = FakeCi::Workflow {
        yaml: "on: workflow_dispatch\n",
        run_from: Some(1),
        green_from: None,
    };
    let kit = Kit::with(workflow, one_poll);
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")], "Source: done:0");
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::CiFailed);
    assert!(kit.gh.merges.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn merges_into_the_pull_requests_own_base_when_it_is_not_the_default_branch() {
    let kit = Kit::with(FakeCi::Actions, one_at_a_time);
    kit.open_pr_on(
        "slot/1/main",
        8,
        "slot/1/fleetd/T9-other",
        &[add("other.txt", "other\n")],
        "Source: done:0",
    );
    let first = kit
        .enqueue("https://github.com/acme/storefront/pull/8".into(), None)
        .await;
    let pr = kit.open_pr_on(
        "slot/1/main",
        7,
        "slot/1/fleetd/T1-docs",
        &[add("docs.md", "docs\n")],
        "Source: done:0",
    );
    let second = kit.enqueue(pr, None).await;

    assert!(kit.train.step(REPO).await);
    assert!(kit.train.step(REPO).await);
    for change in [&first, &second] {
        assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
    }
    // The second was rebased onto the first's merge on slot/1/main; main never moved.
    assert_eq!(
        kit.file_on("slot/1/main", "other.txt").as_deref(),
        Some("other")
    );
    assert_eq!(
        kit.file_on("slot/1/main", "docs.md").as_deref(),
        Some("docs")
    );
    assert_eq!(kit.main_file("docs.md"), None);
    assert_eq!(kit.main_file("other.txt"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn merges_on_local_checks_into_a_base_its_workflows_ignore() {
    let workflow = FakeCi::Workflow {
        yaml: IGNORES_NOCI,
        run_from: None,
        green_from: None,
    };
    let kit = Kit::with(workflow, one_poll);
    let pr = kit.open_pr_on(
        "noci/1/main",
        7,
        "noci/1/fleetd/T1-docs",
        &[add("docs.md", "docs\n")],
        "Source: done:0",
    );
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::Merged);
    assert_eq!(
        kit.file_on("noci/1/main", "docs.md").as_deref(),
        Some("docs")
    );
    assert_eq!(kit.main_file("docs.md"), None);
    assert_eq!(
        kit.host.events_of("pr.merged")[0]["ci"],
        json!(format!("no CI on {REPO}: used local checks"))
    );
}

/// PR `number`, merged into `base` without the train, after the train started watching.
fn merged_outside(kit: &Kit, number: i64, base: &str) {
    let merged_at = (chrono::Utc::now() + chrono::Duration::hours(1))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    let pull = FakePull {
        state: "closed".into(),
        merged: true,
        merge_sha: Some("f".repeat(40)),
        merged_at: Some(merged_at),
        ..FakePull::open(&format!("outside-{number}"), base, "")
    };
    kit.gh.pulls.lock().unwrap().insert(number, pull);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_merge_outside_the_train_is_a_bypass_only_into_a_base_the_train_guards() {
    let kit = Kit::new();
    let pr = kit.open_pr_on(
        "slot/1/main",
        7,
        "slot/1/fleetd/T1-docs",
        &[add("docs.md", "docs\n")],
        "Source: done:0",
    );
    kit.enqueue(pr, None).await;
    assert!(kit.train.step(REPO).await);
    merged_outside(&kit, 8, "slot/2/main");
    merged_outside(&kit, 9, "slot/1/main");
    merged_outside(&kit, 10, "main");

    kit.train.step(REPO).await;
    let flagged: Vec<String> = kit
        .host
        .incidents
        .lock()
        .unwrap()
        .iter()
        .map(|i| i.evidence[0].clone())
        .collect();
    assert_eq!(flagged.len(), 2, "{flagged:?}");
    assert!(flagged.iter().any(|e| e.starts_with(&format!("{REPO}#9 "))));
    assert!(
        flagged
            .iter()
            .any(|e| e.starts_with(&format!("{REPO}#10 ")))
    );
}

/// GitHub may take minutes to start a run. A workflow whose trigger matches the PR is CI before any run exists: with
/// no grace at all, the train still waits for its check instead of merging on local checks.
#[tokio::test(flavor = "multi_thread")]
async fn a_triggered_workflow_is_ci_however_long_github_takes_to_start_it() {
    let workflow = FakeCi::Workflow {
        yaml: ON_PULL_REQUEST,
        run_from: None,
        green_from: Some(4),
    };
    let kit = Kit::with(workflow, |o| {
        o.poll_interval = Duration::ZERO;
        o.no_ci_grace = Duration::ZERO;
    });
    assert_eq!(merge_docs(&kit).await, None);
    assert!(*kit.gh.polls.lock().unwrap() >= 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_lab_workflow_is_ci_for_a_slot_base_and_not_for_a_noci_one() {
    let workflow = FakeCi::Workflow {
        yaml: IGNORES_NOCI,
        run_from: None,
        green_from: None,
    };
    let kit = Kit::with(workflow, one_poll);
    let pr = kit.open_pr_on(
        "slot/1/main",
        7,
        "slot/1/fleetd/T1-docs",
        &[add("docs.md", "docs\n")],
        "Source: done:0",
    );
    let (_, change_id) = kit.author_task(Some(&pr)).await;
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::CiFailed);
    assert!(kit.gh.merges.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreadable_workflow_file_is_ci() {
    let workflow = FakeCi::Workflow {
        yaml: "on: [::",
        run_from: None,
        green_from: None,
    };
    let kit = Kit::with(workflow, one_poll);
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")], "Source: done:0");
    let (_, change_id) = kit.author_task(Some(&pr)).await;
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::CiFailed);
    assert!(kit.gh.merges.lock().unwrap().is_empty());
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
    let kit = Kit::with(FakeCi::Actions, one_at_a_time);
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
    let key = "policy.freeze.acme.storefront";
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

/// The merges GitHub saw, by PR number.
fn merged_prs(kit: &Kit) -> Vec<i64> {
    kit.gh.merges.lock().unwrap().iter().map(|m| m.0).collect()
}

fn state_of(kit: &Kit, change: &Change) -> ChangeState {
    kit.get(&change.change_id).state
}

#[tokio::test(flavor = "multi_thread")]
async fn batches_three_disjoint_ready_prs_into_one_ci_run_and_one_squash_and_closes_each_with_a_link()
 {
    let kit = Kit::new();
    let a = kit
        .enqueue(
            kit.open_pr(7, "a", &[add("a1.txt", "a\n")], "Source: done:0"),
            None,
        )
        .await;
    let b = kit
        .enqueue(
            kit.open_pr(8, "b", &[add("b1.txt", "b\n")], "Source: done:0"),
            None,
        )
        .await;
    let c = kit
        .enqueue(
            kit.open_pr(9, "c", &[add("c1.txt", "c\n")], "Source: done:0"),
            None,
        )
        .await;
    kit.commit("main", &[add("other.txt", "other\n")], None);

    assert!(kit.train.step(REPO).await);
    let merges = kit.gh.merges.lock().unwrap().clone();
    assert_eq!(merges.len(), 1, "one squash for the three: {merges:?}");
    let (batch_pr, batch_head) = merges[0].clone();
    let train_statuses: Vec<String> = kit
        .gh
        .statuses
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, ctx, _)| ctx == TRAIN_CONTEXT)
        .map(|(sha, ..)| sha.clone())
        .collect();
    assert_eq!(
        train_statuses,
        std::slice::from_ref(&batch_head),
        "fleetd/train only on the batch's head"
    );
    let main = kit.head_of("main");
    for (change, file) in [(&a, "a1.txt"), (&b, "b1.txt"), (&c, "c1.txt")] {
        let merged = kit.get(&change.change_id);
        assert_eq!(
            (merged.state, merged.merged_sha.as_deref()),
            (ChangeState::Merged, Some(main.as_str()))
        );
        assert!(kit.main_file(file).is_some(), "{file} on main");
    }
    let pulls = kit.gh.pulls.lock().unwrap();
    let batch = &pulls[&batch_pr];
    assert!(
        batch.branch.starts_with("fleetd/train/"),
        "{}",
        batch.branch
    );
    // Each member with the exact head it was built from, which the pr_merged check holds its PR to.
    let heads: Vec<(i64, Option<String>)> = ["a", "b", "c"]
        .iter()
        .zip([7, 8, 9])
        .map(|(branch, n)| (n, Some(kit.head_of(branch))))
        .collect();
    assert_eq!(batch_heads(&batch.body), heads, "{}", batch.body);
    for n in [7, 8, 9] {
        let member = &pulls[&n];
        assert_eq!(member.state, "closed");
        assert!(
            !member.merged,
            "members are closed, the batch is what merged"
        );
        assert!(
            member
                .comments
                .iter()
                .any(|c| c.starts_with(&format!("Landed in #{batch_pr}"))),
            "{:?}",
            member.comments
        );
    }
    drop(pulls);
    let merged_events = kit.host.events_of("pr.merged");
    assert_eq!(merged_events.len(), 3);
    assert!(merged_events.iter().all(|e| e["mergedSha"] == json!(main)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_red_batch_drops_its_last_member_merges_the_rest_and_tests_the_dropped_one_alone() {
    let kit = Kit::new();
    // Each green alone; pair-a and pair-b together are red.
    let a = kit
        .enqueue(
            kit.open_pr(7, "a", &[add("a1.txt", "a\n")], "Source: done:0"),
            None,
        )
        .await;
    let b = kit
        .enqueue(
            kit.open_pr(8, "b", &[add("pair-a", "a\n")], "Source: done:0"),
            None,
        )
        .await;
    let c = kit
        .enqueue(
            kit.open_pr(9, "c", &[add("pair-b", "b\n")], "Source: done:0"),
            None,
        )
        .await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(state_of(&kit, &b), ChangeState::Merged);
    assert_eq!(
        state_of(&kit, &c),
        ChangeState::Ready,
        "dropped from the red batch, waiting its turn"
    );
    assert_eq!(merged_prs(&kit).len(), 1);
    assert!(
        kit.host.events_of("change.ci_failed").is_empty(),
        "nobody is blamed for a red batch"
    );

    // Alone, on the new main, it is red: its author hears it, and it never merges.
    kit.enqueue(
        kit.open_pr(10, "d", &[add("d1.txt", "d\n")], "Source: done:0"),
        None,
    )
    .await;
    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &c), ChangeState::CiFailed);
    assert!(kit.main_file("pair-b").is_none());
    assert_eq!(kit.host.events_of("change.ci_failed").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_batch_of_one_is_the_old_path_and_overlapping_files_never_batch() {
    let kit = Kit::with(FakeCi::Actions, one_at_a_time);
    kit.enqueue(
        kit.open_pr(7, "a", &[add("a1.txt", "a\n")], "Source: done:0"),
        None,
    )
    .await;
    let b = kit
        .enqueue(
            kit.open_pr(8, "b", &[add("b1.txt", "b\n")], "Source: done:0"),
            None,
        )
        .await;
    assert!(kit.train.step(REPO).await);
    assert_eq!(merged_prs(&kit), [7], "the PR itself merges, no batch PR");
    assert_eq!(state_of(&kit, &b), ChangeState::Ready);

    let kit = Kit::new();
    kit.enqueue(
        kit.open_pr(
            7,
            "a",
            &[("a.txt", Some(&a_with(&[(2, "a")])))],
            "Source: done:0",
        ),
        None,
    )
    .await;
    kit.enqueue(
        kit.open_pr(
            8,
            "b",
            &[("a.txt", Some(&a_with(&[(9, "b")])))],
            "Source: done:0",
        ),
        None,
    )
    .await;
    assert!(kit.train.step(REPO).await);
    assert_eq!(
        merged_prs(&kit),
        [7],
        "both touch a.txt: the first goes alone"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn only_reviewed_held_free_and_own_green_prs_join_a_batch() {
    let kit = Kit::new();
    let a = kit
        .enqueue(
            kit.open_pr(7, "a", &[add("a1.txt", "a\n")], "Source: done:0"),
            None,
        )
        .await;
    // Tier M: reviewing until a review marks it ready.
    let m = kit
        .enqueue(
            kit.open_pr(8, "m", &[add("m1.txt", "m\n")], "Source: done:0"),
            Some(Tier::M),
        )
        .await;
    let held = kit
        .enqueue(
            kit.open_pr(9, "h", &[add("h1.txt", "h\n")], "Source: done:0"),
            None,
        )
        .await;
    kit.gh
        .pulls
        .lock()
        .unwrap()
        .get_mut(&9)
        .unwrap()
        .labels
        .push("hold".into());
    let red = kit
        .enqueue(
            kit.open_pr(10, "r", &[add("FAIL", "x\n")], "Source: done:0"),
            None,
        )
        .await;
    let d = kit
        .enqueue(
            kit.open_pr(11, "d", &[add("d1.txt", "d\n")], "Source: done:0"),
            None,
        )
        .await;

    assert!(kit.train.step(REPO).await);
    let batch = kit.gh.merges.lock().unwrap()[0].0;
    assert_eq!(
        batch_members(&kit.gh.pulls.lock().unwrap()[&batch].body),
        [7, 11]
    );
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(state_of(&kit, &d), ChangeState::Merged);
    assert_eq!(state_of(&kit, &m), ChangeState::Reviewing);
    let held_now = kit.get(&held.change_id);
    assert_eq!(held_now.state, ChangeState::Ready);
    assert!(held_now.last_error.as_deref().unwrap().starts_with("held:"));

    // Red on its own head: it goes alone, fails, and never merges; the held one is still skipped.
    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &red), ChangeState::CiFailed);
    assert!(
        !kit.train.step(REPO).await,
        "only the held one is left, and it waits"
    );
    assert_eq!(state_of(&kit, &held), ChangeState::Ready);

    kit.gh
        .pulls
        .lock()
        .unwrap()
        .get_mut(&9)
        .unwrap()
        .labels
        .clear();
    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &held), ChangeState::Merged);
    assert_eq!(
        state_of(&kit, &m),
        ChangeState::Reviewing,
        "never merged without its review"
    );
    assert!(kit.main_file("m1.txt").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn required_checks_and_githubs_rules_still_block_a_batch() {
    // Checks the base requires never report: the batch times out, and each alone times out too, never merging.
    let kit = Kit::with(FakeCi::Required, one_poll);
    let a = kit
        .enqueue(
            kit.open_pr(7, "a", &[add("a1.txt", "a\n")], "Source: done:0"),
            None,
        )
        .await;
    let b = kit
        .enqueue(
            kit.open_pr(8, "b", &[add("b1.txt", "b\n")], "Source: done:0"),
            None,
        )
        .await;
    for _ in 0..3 {
        kit.train.step(REPO).await;
    }
    assert!(merged_prs(&kit).is_empty());
    assert_eq!(state_of(&kit, &a), ChangeState::CiFailed);
    assert_eq!(state_of(&kit, &b), ChangeState::CiFailed);

    // GitHub refuses the batch PR (say, it wants an approval): after the merge attempts, batching is off for the
    // repo and each goes alone, through GitHub's rules again.
    let kit = Kit::new();
    let a = kit
        .enqueue(
            kit.open_pr(7, "a", &[add("a1.txt", "a\n")], "Source: done:0"),
            None,
        )
        .await;
    let b = kit
        .enqueue(
            kit.open_pr(8, "b", &[add("b1.txt", "b\n")], "Source: done:0"),
            None,
        )
        .await;
    for _ in 0..3 {
        kit.gh.merge_replies.lock().unwrap().push(http_error(
            405,
            "At least 1 approving review is required by reviewers with write access.",
        ));
    }
    assert!(kit.train.step(REPO).await);
    assert!(merged_prs(&kit).is_empty());
    let back = kit.get(&a.change_id);
    assert_eq!(back.state, ChangeState::Ready);
    assert!(
        back.last_error
            .as_deref()
            .unwrap()
            .contains("approving review"),
        "{:?}",
        back.last_error
    );
    let batch_pr = kit
        .gh
        .pulls
        .lock()
        .unwrap()
        .iter()
        .find(|(_, p)| p.branch == "fleetd/train/batch")
        .map(|(n, p)| (*n, p.state.clone()))
        .unwrap();
    assert_eq!(batch_pr.1, "closed", "the batch PR is dissolved");
    assert!(kit.train.step(REPO).await);
    assert!(kit.train.step(REPO).await);
    assert_eq!(merged_prs(&kit), [7, 8], "one at a time now");
    assert_eq!(state_of(&kit, &b), ChangeState::Merged);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_pushed_to_while_the_batch_is_in_ci_leaves_it_untested_code_never_lands() {
    let kit = Kit::new();
    let a = kit
        .enqueue(
            kit.open_pr(7, "a", &[add("a1.txt", "a\n")], "Source: done:0"),
            None,
        )
        .await;
    let b = kit
        .enqueue(
            kit.open_pr(8, "b", &[add("b1.txt", "b\n")], "Source: done:0"),
            None,
        )
        .await;
    let c = kit
        .enqueue(
            kit.open_pr(9, "c", &[add("c1.txt", "c\n")], "Source: done:0"),
            None,
        )
        .await;
    *kit.gh.push_during_ci.lock().unwrap() = Some("b".into());

    assert!(kit.train.step(REPO).await);
    let batch = kit.gh.merges.lock().unwrap()[0].0;
    assert_eq!(
        batch_members(&kit.gh.pulls.lock().unwrap()[&batch].body),
        [7, 9]
    );
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(state_of(&kit, &c), ChangeState::Merged);
    assert_eq!(state_of(&kit, &b), ChangeState::Ready);
    assert_eq!(kit.gh.pulls.lock().unwrap()[&8].state, "open");

    // Its new head, same patch, goes next.
    assert!(kit.train.step(REPO).await);
    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &b), ChangeState::Merged);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stacked_pr_is_green_on_its_parent_before_it_lands_and_merges_after_it_retargeted() {
    let kit = Kit::new();
    // The parent in two commits, the second rewriting the first's line: replaying them onto its own squash conflicts.
    kit.commit("p", &[add("p.txt", "one\n")], Some("origin/main"));
    let parent_url = kit.open_pr(7, "p", &[add("p.txt", "two\n")], "Source: done:0");
    kit.gh.pulls.lock().unwrap().get_mut(&7).unwrap().branch = "p".into();
    let child_url = kit.stacked_pr(8, "c", "p", &[add("c.txt", "c\n")]);
    // Frozen: nothing merges, speculative CI still runs.
    let key = "policy.freeze.acme.storefront";
    kit.host.decisions.lock().unwrap().insert(
        key.into(),
        DecisionView {
            decision_id: "D1".into(),
            key: key.into(),
            value: "true".into(),
            why: None,
            global: false,
        },
    );
    let parent = kit.enqueue(parent_url, None).await;
    let child = kit.enqueue(child_url, None).await;
    let child_head = kit.head_of("c");

    assert!(!kit.train.step(REPO).await);
    assert!(!kit.train.step(REPO).await);
    let spec = kit
        .gh
        .pulls
        .lock()
        .unwrap()
        .iter()
        .find(|(_, p)| p.branch == "fleetd/train/stack-8")
        .map(|(n, p)| (*n, p.base.clone(), p.draft))
        .expect("a speculative PR");
    assert_eq!((spec.1.as_str(), spec.2), ("main", true));
    let green = format!("status fleetd/stack success {child_head}");
    assert!(
        kit.gh.log.lock().unwrap().contains(&green),
        "{:?}",
        kit.gh.log.lock().unwrap()
    );
    assert!(merged_prs(&kit).is_empty());

    // Thawed, and main moved: the parent is rebased (its branch rewritten), lands alone, then the child is
    // retargeted, rebased onto the parent's squash without replaying the parent's commits, and lands after CI.
    kit.host.decisions.lock().unwrap().clear();
    kit.commit("main", &[add("other.txt", "other\n")], None);
    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &parent), ChangeState::Merged);
    assert_eq!(
        state_of(&kit, &child),
        ChangeState::Ready,
        "it waits for its parent, not in a batch with it"
    );
    assert!(kit.train.step(REPO).await);
    let merged = kit.get(&child.change_id);
    assert_eq!(merged.state, ChangeState::Merged, "{:?}", merged.last_error);
    assert_eq!(kit.main_file("p.txt").as_deref(), Some("two"));
    assert_eq!(kit.main_file("c.txt").as_deref(), Some("c"));
    let log = kit.gh.log.lock().unwrap().clone();
    let green_at = log.iter().position(|l| *l == green).unwrap();
    let parent_merged_at = log.iter().position(|l| *l == "merge #7").unwrap();
    assert!(green_at < parent_merged_at, "{log:?}");
    let pulls = kit.gh.pulls.lock().unwrap();
    assert_eq!(pulls[&8].base, "main");
    assert_eq!(
        pulls[&spec.0].state, "closed",
        "the speculative build is closed once its parent landed"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stacked_pr_never_lands_before_its_parent_and_hears_when_it_is_red_on_it() {
    let kit = Kit::new();
    let parent_url = kit.open_pr(7, "p", &[add("pair-a", "a\n")], "Source: done:0");
    let child_url = kit.stacked_pr(8, "c", "p", &[add("pair-b", "b\n")]);
    // The parent needs a review it never gets; the child is ready at once.
    let parent = kit.enqueue(parent_url, Some(Tier::M)).await;
    let (task_id, child_id) = kit.author_task(Some(&child_url)).await;

    for _ in 0..3 {
        kit.train.step(REPO).await;
    }
    assert!(merged_prs(&kit).is_empty());
    assert_eq!(kit.get(&child_id).state, ChangeState::Ready);
    assert_eq!(state_of(&kit, &parent), ChangeState::Reviewing);
    let child_head = kit.head_of("c");
    assert!(
        kit.gh
            .log
            .lock()
            .unwrap()
            .contains(&format!("status fleetd/stack failure {child_head}"))
    );
    let (to, text) = kit.host.sends.lock().unwrap().last().cloned().unwrap();
    assert_eq!(to, task_id.to_string());
    assert!(
        text.contains("on top of #7 (not merged yet) failed"),
        "{text}"
    );
}

#[test]
fn a_cancelled_check_is_red_only_once_nothing_else_runs() {
    use super::github::CheckRun;
    use super::service::{Checks, checks};
    let run = |name: &str, status: &str, conclusion: Option<&str>| CheckRun {
        id: 1.0,
        name: name.into(),
        status: status.into(),
        conclusion: conclusion.map(String::from),
        html_url: None,
        started_at: None,
        completed_at: None,
        head_sha: None,
    };
    let cancelled = run("lint", "completed", Some("cancelled"));
    assert!(matches!(
        checks(&[cancelled.clone(), run("test", "in_progress", None)]),
        Checks::Pending
    ));
    assert!(matches!(
        checks(&[cancelled, run("test", "completed", Some("success"))]),
        Checks::Red(_)
    ));
    assert!(matches!(
        checks(&[
            run("test", "completed", Some("failure")),
            run("x", "queued", None)
        ]),
        Checks::Red(_)
    ));
}

/// Three disjoint tier-S PRs, ready: 7 (a), 8 (b), 9 (c).
async fn three_ready(kit: &Kit) -> [Change; 3] {
    let mut out = Vec::new();
    for (n, branch) in [(7, "a"), (8, "b"), (9, "c")] {
        let file = format!("{branch}1.txt");
        let pr = kit.open_pr(n, branch, &[(file.as_str(), Some("x\n"))], "Source: done:0");
        out.push(kit.enqueue(pr, None).await);
    }
    out.try_into().unwrap_or_else(|_| unreachable!())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_pushed_to_after_the_last_look_is_neither_closed_nor_merged_and_its_new_head_goes_next()
 {
    let kit = Kit::new();
    let [a, b, c] = three_ready(&kit).await;
    *kit.gh.push_on_merge.lock().unwrap() = Some("b".into());

    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(state_of(&kit, &c), ChangeState::Merged);
    let moved = kit.get(&b.change_id);
    assert_eq!(moved.state, ChangeState::Ready);
    assert!(
        moved
            .last_error
            .as_deref()
            .unwrap()
            .starts_with("pushed to while batch"),
        "{:?}",
        moved.last_error
    );
    let pulls = kit.gh.pulls.lock().unwrap();
    assert_eq!(pulls[&8].state, "open", "never closed as landed");
    assert!(pulls[&8].comments.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_close_that_failed_after_the_merge_is_retried_by_the_next_pass() {
    let kit = Kit::new();
    let [a, ..] = three_ready(&kit).await;
    kit.gh.fail_close.lock().unwrap().push(7);

    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(kit.gh.pulls.lock().unwrap()[&7].state, "open");

    kit.train.step(REPO).await;
    let pulls = kit.gh.pulls.lock().unwrap();
    assert_eq!(pulls[&7].state, "closed");
    assert!(
        pulls[&7]
            .comments
            .iter()
            .any(|c| c.starts_with("Landed in #"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_merge_github_did_but_answered_with_an_error_is_finished_by_the_next_pass_never_merged_twice()
 {
    let kit = Kit::new();
    let changes = three_ready(&kit).await;
    *kit.gh.merge_then_fail.lock().unwrap() = true;

    assert!(kit.train.step(REPO).await);
    assert_eq!(merged_prs(&kit).len(), 1);
    assert!(
        changes
            .iter()
            .all(|c| state_of(&kit, c) == ChangeState::Ready)
    );

    kit.train.step(REPO).await;
    assert_eq!(merged_prs(&kit).len(), 1, "the batch is not merged again");
    let main = kit.head_of("main");
    for c in &changes {
        let done = kit.get(&c.change_id);
        assert_eq!(
            (done.state, done.merged_sha.as_deref()),
            (ChangeState::Merged, Some(main.as_str()))
        );
        assert_eq!(
            kit.gh.pulls.lock().unwrap()[&c.pr_number.get()].state,
            "closed"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn scratch_branches_and_prs_nothing_uses_are_swept_and_a_merged_batch_leaves_no_branch() {
    let kit = Kit::new();
    // What a hub that restarted mid-way left: a speculative build and a batch, each with an open PR.
    for (n, branch) in [(50, "fleetd/train/stack-99"), (51, "fleetd/train/batch")] {
        kit.commit(branch, &[add("left.txt", "left\n")], Some("origin/main"));
        kit.gh
            .pulls
            .lock()
            .unwrap()
            .insert(n, FakePull::open(branch, "main", "left over"));
    }
    // A task branch outside the train's namespace is never touched.
    kit.commit(
        "fleetd/T3-docs",
        &[add("t3.txt", "t3\n")],
        Some("origin/main"),
    );
    // Frozen, so the first pass only sweeps.
    three_ready(&kit).await;
    let key = "policy.freeze.acme.storefront";
    let freeze = DecisionView {
        decision_id: "D1".into(),
        key: key.into(),
        value: "true".into(),
        why: None,
        global: false,
    };
    kit.host
        .decisions
        .lock()
        .unwrap()
        .insert(key.into(), freeze);

    assert!(!kit.train.step(REPO).await);
    assert!(kit.gh.head_of("fleetd/train/stack-99").is_none());
    assert!(kit.gh.head_of("fleetd/train/batch").is_none());
    assert!(kit.gh.head_of("fleetd/T3-docs").is_some());
    let states = {
        let pulls = kit.gh.pulls.lock().unwrap();
        (pulls[&50].state.clone(), pulls[&51].state.clone())
    };
    assert_eq!(states, ("closed".into(), "closed".into()));

    kit.host.decisions.lock().unwrap().clear();
    assert!(kit.train.step(REPO).await);
    assert_eq!(merged_prs(&kit).len(), 1);
    assert!(
        kit.gh.head_of("fleetd/train/batch").is_none(),
        "deleted once merged"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_speculative_build_follows_its_parents_new_head_not_the_childs_stale_copy() {
    let kit = Kit::new();
    // The parent never gets its review, so it waits; the child is ready.
    let parent_url = kit.open_pr(7, "p", &[add("p.txt", "p\n")], "Source: done:0");
    kit.enqueue(parent_url, Some(Tier::M)).await;
    let child_url = kit.stacked_pr(8, "c", "p", &[add("pair-b", "b\n")]);
    kit.enqueue(child_url, None).await;
    let child_head = kit.head_of("c");
    kit.train.step(REPO).await;
    kit.train.step(REPO).await;
    let status = |state: &str| format!("status fleetd/stack {state} {child_head}");
    assert!(kit.gh.log.lock().unwrap().contains(&status("success")));

    // The parent's author pushes a commit the child doesn't have; together they are now red.
    kit.commit("p", &[add("pair-a", "a\n")], None);
    for _ in 0..3 {
        kit.train.step(REPO).await;
    }
    let log = kit.gh.log.lock().unwrap();
    let green = log.iter().position(|l| *l == status("success")).unwrap();
    let red = log.iter().rposition(|l| *l == status("failure"));
    assert!(
        red.is_some_and(|r| r > green),
        "rebuilt on the parent's new head: {log:?}"
    );
    assert!(merged_prs(&kit).is_empty());
}

impl Kit {
    fn running_task(&self, id: &str, kind: &str) -> TaskId {
        let task = TaskView {
            task_id: TaskId::unchecked(id),
            project_ref: project(),
            workstream_id: ws(),
            kind: kind.into(),
            state: "running".into(),
            serves: Some("done:0".into()),
            tier: Some(Tier::M),
            pr_url: None,
            receipt_commands: 0,
            claims_unverified: false,
            result_tail: None,
        };
        self.host.tasks.lock().unwrap().insert(id.into(), task);
        TaskId::unchecked(id)
    }
}

/// A writer's ready slice goes to the review gate while the writer still runs, once per head, and only through every
/// check `change_enqueue` makes: the gate keeps it from merging until its reviews are in.
#[tokio::test(flavor = "multi_thread")]
async fn a_writers_ready_slice_is_reviewed_at_once_once_per_head_and_never_past_the_gates() {
    use super::calls::slice_ready;
    use fleetd_contracts::lead_calls::SliceReadyCall;
    let kit = Kit::new();
    let writer = kit.running_task("T1", "write");
    let slice = |pr: &str| SliceReadyCall {
        pr_url: GitHubPrUrl::unchecked(pr),
    };

    let first = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")], "Source: done:0");
    let (change, next) = slice_ready(&kit.train, &project(), &writer, slice(&first))
        .await
        .unwrap();
    assert_eq!(
        (change.state, change.task_id.as_ref(), change.tier),
        (ChangeState::Reviewing, Some(&writer), Tier::M)
    );
    assert!(next.starts_with("go on with your next slice"), "{next}");
    assert_eq!(
        kit.gate.reviewed.lock().unwrap().len(),
        1,
        "reviewed at once"
    );
    // The writer reports the same head again: the same Change, no second round.
    let (again, _) = slice_ready(&kit.train, &project(), &writer, slice(&first))
        .await
        .unwrap();
    assert_eq!(again.change_id, change.change_id);
    assert_eq!(kit.gate.reviewed.lock().unwrap().len(), 1);
    // Pending reviews hold it: it is never ready, so never merged, without them.
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Reviewing);

    // The next slice gets its own review while the first still waits on its own.
    let second = kit.open_pr(8, "slice-2", &[add("a2.txt", "b\n")], "Source: done:0");
    let (other, _) = slice_ready(&kit.train, &project(), &writer, slice(&second))
        .await
        .unwrap();
    assert_ne!(other.change_id, change.change_id);
    assert_eq!(kit.gate.reviewed.lock().unwrap().len(), 2);

    // The train's checks still refuse: no Source line, and a reviewer is no writer.
    let bare = kit.open_pr(9, "slice-3", &[add("a3.txt", "c\n")], "No source.");
    let refused = slice_ready(&kit.train, &project(), &writer, slice(&bare))
        .await
        .unwrap_err();
    assert_eq!(
        refused.fix.as_deref(),
        Some("add 'Source: done:0' to the PR body")
    );
    let reviewer = kit.running_task("T2", "review");
    let not_writer = slice_ready(&kit.train, &project(), &reviewer, slice(&second))
        .await
        .unwrap_err();
    assert!(
        not_writer.message.contains("not a write task"),
        "{}",
        not_writer.message
    );
    assert_eq!(kit.gate.reviewed.lock().unwrap().len(), 2);
}

/// The order's review policy picks the reviewers of a ready slice (tier M: one reviewer, spawned by the gate through
/// the tasks' spawn path), once per head. When that path refuses (the lead's fan-out limit), nothing is waived: the
/// slice stays in review and can't merge.
#[tokio::test(flavor = "multi_thread")]
async fn a_ready_slice_gets_the_orders_reviewer_and_a_refused_spawn_never_lets_it_through() {
    use super::calls::slice_ready;
    use fleetd_contracts::lead_calls::SliceReadyCall;
    let kit = Kit::with_reviews();
    let writer = kit.running_task("T1", "write");
    let slice = |pr: &str| SliceReadyCall {
        pr_url: GitHubPrUrl::unchecked(pr),
    };
    let first = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")], "Source: done:0");
    let (change, _) = slice_ready(&kit.train, &project(), &writer, slice(&first))
        .await
        .unwrap();
    let spawned: Vec<(String, &str, Tier)> = kit
        .host
        .review_spawns
        .lock()
        .unwrap()
        .iter()
        .map(|s| (s.pr.clone(), s.by, s.tier))
        .collect();
    assert_eq!(spawned, [(first.clone(), "hub:reviews", Tier::M)]);
    slice_ready(&kit.train, &project(), &writer, slice(&first))
        .await
        .unwrap();
    assert_eq!(
        kit.host.review_spawns.lock().unwrap().len(),
        1,
        "once per head"
    );
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Reviewing);

    *kit.host.spawn_refusal.lock().unwrap() = Some(
        "This project already has 32 open tasks, the most one lead may have at once (32).".into(),
    );
    let second = kit.open_pr(8, "slice-2", &[add("a2.txt", "b\n")], "Source: done:0");
    let (held, _) = slice_ready(&kit.train, &project(), &writer, slice(&second))
        .await
        .unwrap();
    let held = kit.get(&held.change_id);
    assert_eq!(held.state, ChangeState::Reviewing);
    assert!(
        held.last_error.as_ref().is_some_and(|e| e
            .as_str()
            .contains("could not spawn the reviewer: This project already has 32")),
        "{:?}",
        held.last_error
    );
    assert_eq!(kit.host.review_spawns.lock().unwrap().len(), 1);
}

/// A running writer's draft PR marked ready is a ready slice, found on the train's own pass (no webhook): it goes to
/// the review gate once per head. A PR that was never a draft waits for the writer's result as before.
#[tokio::test(flavor = "multi_thread")]
async fn a_writers_draft_marked_ready_is_reviewed_on_the_trains_pass_once_per_head() {
    let kit = Kit::new();
    let writer = kit.running_task("T1", "write");
    kit.host
        .branches
        .lock()
        .unwrap()
        .insert("T1".into(), "fleetd/T1-slice".into());
    let pr = kit.open_pr(
        7,
        "fleetd/T1-slice",
        &[add("a1.txt", "a\n")],
        "Source: done:0",
    );
    // A second train change keeps the repo's train (and its pass) alive.
    let other = kit.open_pr(3, "other", &[add("o.txt", "o\n")], "Source: done:0");
    kit.enqueue(other, None).await;
    kit.gh.pulls.lock().unwrap().get_mut(&7).unwrap().draft = true;
    let reviewed = || {
        kit.gate
            .reviewed
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.pr_number.get() == 7)
            .count()
    };

    kit.train.step(REPO).await;
    assert_eq!(reviewed(), 0, "a draft is not a slice yet");
    kit.gh.pulls.lock().unwrap().get_mut(&7).unwrap().draft = false;
    kit.train.step(REPO).await;
    assert_eq!(reviewed(), 1, "marked ready: reviewed at once");
    let change = kit
        .train
        .list(&ListFilter {
            limit: 10,
            ..Default::default()
        })
        .into_iter()
        .find(|c| c.pr_url.as_str() == pr)
        .unwrap();
    assert_eq!(
        (change.state, change.task_id.as_ref()),
        (ChangeState::Reviewing, Some(&writer))
    );
    kit.train.step(REPO).await;
    assert_eq!(reviewed(), 1, "once per head");

    // Opened ready, never seen as a draft: left for the writer's result.
    kit.host
        .branches
        .lock()
        .unwrap()
        .insert("T1".into(), "fleetd/T1-later".into());
    kit.open_pr(
        8,
        "fleetd/T1-later",
        &[add("a2.txt", "b\n")],
        "Source: done:0",
    );
    kit.train.step(REPO).await;
    assert!(
        kit.train
            .list(&ListFilter {
                limit: 10,
                ..Default::default()
            })
            .iter()
            .all(|c| c.pr_number.get() != 8)
    );
}

/// A writer's report, its result and the draft-ready pass may enqueue one PR at once: one Change, one review round.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_enqueues_of_one_pr_make_one_change_and_one_review_round() {
    use super::calls::slice_ready;
    use fleetd_contracts::lead_calls::SliceReadyCall;
    let kit = Kit::with_reviews();
    let writer = kit.running_task("T1", "write");
    let pr = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")], "Source: done:0");
    let call = || SliceReadyCall {
        pr_url: GitHubPrUrl::unchecked(pr.clone()),
    };
    let input = || ChangeEnqueueCall {
        task_id: Some(writer.clone()),
        ..enqueue_call(pr.clone(), None)
    };
    let r = project();
    let (a, b, c, d) = tokio::join!(
        slice_ready(&kit.train, &r, &writer, call()),
        slice_ready(&kit.train, &r, &writer, call()),
        kit.train.enqueue(&r, input()),
        kit.train.enqueue(&r, input()),
    );
    let ids: std::collections::HashSet<String> = [
        a.unwrap().0.change_id,
        b.unwrap().0.change_id,
        c.unwrap().change_id,
        d.unwrap().change_id,
    ]
    .into_iter()
    .map(|id| id.to_string())
    .collect();
    assert_eq!(ids.len(), 1, "{ids:?}");
    let listed = kit.train.list(&ListFilter {
        limit: 10,
        ..Default::default()
    });
    assert_eq!(listed.len(), 1);
    assert_eq!(
        kit.host.review_spawns.lock().unwrap().len(),
        1,
        "one review round"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_checkout_outside_the_nodes_cmd_roots_says_so_and_needs_a_person() {
    let kit = Kit::new();
    let elsewhere = tempfile::tempdir().unwrap();
    *kit.host.cmd_roots.lock().unwrap() = Some(vec![elsewhere.path().display().to_string()]);

    let pr = kit.open_pr(7, "outside", &[add("b.txt", "b\n")], "Source: done:0");
    let change = kit.enqueue(pr, None).await;
    assert_eq!(change.state, ChangeState::Queued);
    let error = change.last_error.unwrap();
    assert!(
        error.as_str().contains("is outside cmdRoots"),
        "{}",
        error.as_str()
    );
    assert!(
        error.as_str().contains("\"cmdRoots\" in node.json"),
        "{}",
        error.as_str()
    );
    assert!(
        !error.as_str().contains("not a git checkout"),
        "{}",
        error.as_str()
    );
    assert_eq!(kit.host.events_of("train.blocked").len(), 1);

    // Once the node runs commands there, the train goes on.
    *kit.host.cmd_roots.lock().unwrap() = None;
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

#[tokio::test(flavor = "multi_thread")]
async fn a_done_order_closes_its_leftover_prs_but_keeps_the_review_fixes_it_is_told_to() {
    let kit = Kit::new();
    // Tier M: both wait for reviews, so both are leftovers when the order is done.
    let leftover = kit
        .enqueue(
            kit.open_pr(7, "left", &[add("l.txt", "l\n")], "Source: done:0"),
            Some(Tier::M),
        )
        .await;
    let fix = kit
        .enqueue(
            kit.open_pr(8, "fix", &[add("f.txt", "f\n")], "Source: done:0"),
            Some(Tier::M),
        )
        .await;

    let closed = kit
        .train
        .close_leftovers(
            &project(),
            &ws(),
            "W1 is done",
            std::slice::from_ref(&fix.change_id),
        )
        .await;
    assert_eq!(
        closed.iter().map(|c| c.pr_number.get()).collect::<Vec<_>>(),
        [7]
    );
    assert_eq!(kit.get(&leftover.change_id).state, ChangeState::Abandoned);
    assert_eq!(kit.get(&fix.change_id).state, ChangeState::Reviewing);
    let pulls = kit.gh.pulls.lock().unwrap();
    assert_eq!(
        (pulls[&7].state.as_str(), pulls[&8].state.as_str()),
        ("closed", "open")
    );
}
