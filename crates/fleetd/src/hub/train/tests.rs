//! The train over a fake `gh` that answers like GitHub would from a real bare git "origin" in a temp dir: it rebases a
//! PR's branch, merges heads into a batch branch, serves diffs, and runs CI (red iff the head has a file FAIL, or both
//! `pair-a` and `pair-b`). An author's clone pushes to it, and a fake host stands in for tasks, workstreams, events and
//! wakes.
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Notify;

use super::contract::*;
use super::github::{GhOut, GhRunner, TRAIN_CONTEXT, batch_heads};
use super::host::*;
use super::records::{Db, ListFilter};
use super::service::{ReviewGate, Train, TrainOptions, Verdict};
use crate::clock::{Clock, SystemClock};

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
    /// A CI workflow whose `ci` check only appears, green, from the `green_from`th check-run poll on.
    Workflow { green_from: u32 },
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
    /// How many reads of a PR `update-branch` just rebased still show its old head, as GitHub's can for a moment.
    stale_reads: Mutex<u32>,
    /// A rebased PR's old head and the reads left that show it.
    stale: Mutex<HashMap<i64, (String, u32)>>,
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
            "user": { "login": "ada-lovelace", "type": "User" }, "created_at": "2026-10-16T09:00:00Z",
            "merged_by": p.merged.then(|| json!({ "login": "ada-lovelace", "type": "User" })),
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
    fn merge(&self, n: i64, p: &mut FakePull, fields: &HashMap<&str, &str>) -> GhOut {
        let sha = fields.get("sha").copied().unwrap_or_default();
        let message = match (fields.get("commit_title"), fields.get("commit_message")) {
            (Some(title), Some(body)) => format!("{title}\n\n{body}"),
            (Some(title), None) => (*title).to_owned(),
            _ => format!("squash #{n}"),
        };
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
                &message,
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

    /// `git merge-tree` of `ours` and `theirs` as a commit with `parents`: None on a conflict.
    fn merged(&self, ours: &str, theirs: &str, parents: &[&str], message: &str) -> Option<String> {
        let tree = git_out(&self.origin, &["merge-tree", "--write-tree", ours, theirs])?;
        let mut args = vec!["commit-tree", tree.lines().next()?];
        for p in parents {
            args.extend(["-p", p]);
        }
        args.extend(["-m", message]);
        Some(git(&self.origin, &args))
    }

    /// `gh pr update-branch <n> --rebase`: the PR's changes as one commit on its base, unless it is already on it.
    fn update_branch(&self, n: i64) -> GhOut {
        let (branch, base) = match self.pulls.lock().unwrap().get(&n) {
            Some(p) => (p.branch.clone(), p.base.clone()),
            None => return http_error(404, "Not Found"),
        };
        let (head, onto) = (self.head_of(&branch).unwrap(), self.head_of(&base).unwrap());
        if git_out(&self.origin, &["merge-base", "--is-ancestor", &onto, &head]).is_some() {
            return GhOut {
                exit_code: 0,
                stdout: "✓ PR branch already up-to-date\n".into(),
                stderr: String::new(),
            };
        }
        let Some(rebased) = self.merged(&onto, &head, &[&onto], &format!("change {branch}")) else {
            return GhOut {
                exit_code: 1,
                stdout: String::new(),
                stderr: "X Cannot update PR branch due to conflicts\n".into(),
            };
        };
        git(
            &self.origin,
            &["update-ref", &format!("refs/heads/{branch}"), &rebased],
        );
        let lag = *self.stale_reads.lock().unwrap();
        if lag > 0 {
            self.stale.lock().unwrap().insert(n, (head, lag));
        }
        GhOut {
            exit_code: 0,
            stdout: "✓ PR branch updated\n".into(),
            stderr: String::new(),
        }
    }

    fn answer(&self, args: &[String]) -> GhOut {
        if args[..2] == ["pr", "update-branch"] {
            return self.update_branch(args[2].parse().unwrap());
        }
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
            (["compare", range], "GET") if !args.iter().any(|a| a.contains("github.diff")) => {
                let (from, head) = range.split_once("...").unwrap_or_default();
                let base = git(&self.origin, &["merge-base", from, head]);
                let commits = git(
                    &self.origin,
                    &["rev-list", "--reverse", &format!("{base}..{head}")],
                );
                let commits: Vec<Value> = commits.lines().map(|c| json!({ "sha": c })).collect();
                ok(
                    json!({ "merge_base_commit": { "sha": base }, "total_commits": commits.len(), "commits": commits }),
                )
            }
            (["compare", range], "GET") => {
                let diff = git(&self.origin, &["diff", range]);
                GhOut {
                    exit_code: 0,
                    stdout: format!("{diff}\n"),
                    stderr: String::new(),
                }
            }
            (["git", "ref", "heads", branch @ ..], "GET") => {
                match self.head_of(&branch.join("/")) {
                    Some(sha) => ok(json!({ "object": { "sha": sha } })),
                    None => http_error(404, "Not Found"),
                }
            }
            (["git", "refs"], "POST") => {
                let name = fields.get("ref").copied().unwrap_or_default();
                if git_out(&self.origin, &["rev-parse", "--verify", name]).is_some() {
                    return http_error(422, "Reference already exists");
                }
                let sha = fields.get("sha").copied().unwrap_or_default();
                git(&self.origin, &["update-ref", name, sha]);
                ok(json!({ "ref": name }))
            }
            (["merges"], "POST") => {
                let get = |k: &str| fields.get(k).copied().unwrap_or_default();
                let (branch, head) = (get("base"), get("head"));
                let Some(onto) = self.head_of(branch) else {
                    return http_error(404, "Base does not exist");
                };
                if git_out(&self.origin, &["merge-base", "--is-ancestor", head, &onto]).is_some() {
                    return ok(Value::Null);
                }
                match self.merged(&onto, head, &[&onto, head], get("commit_message")) {
                    Some(sha) => {
                        git(
                            &self.origin,
                            &["update-ref", &format!("refs/heads/{branch}"), &sha],
                        );
                        ok(json!({ "sha": sha }))
                    }
                    None => http_error(409, "Merge conflict"),
                }
            }
            (["pulls", n], "GET") => match self.pulls.lock().unwrap().get(&number(Some(n))) {
                Some(p) => {
                    let mut pull = self.pull_json(number(Some(n)), p);
                    if let Some((old, left)) = self.stale.lock().unwrap().get_mut(&number(Some(n)))
                        && *left > 0
                    {
                        *left -= 1;
                        pull["head"]["sha"] = json!(old);
                    }
                    ok(pull)
                }
                None => http_error(404, "Not Found"),
            },
            (["pulls", n, "commits"], "GET") => {
                match self.pulls.lock().unwrap().get(&number(Some(n))) {
                    // One page: the PR's commits, oldest first.
                    Some(p) if query.contains("page=1") => {
                        let range = format!("{}..{}", p.base, p.branch);
                        let log = git(
                            &self.origin,
                            &["log", "--reverse", "--format=%B%x1e", &range],
                        );
                        let commits: Vec<Value> = log
                            .split('\u{1e}')
                            .map(str::trim)
                            .filter(|m| !m.is_empty())
                            .map(|m| json!({ "commit": { "message": m } }))
                            .collect();
                        ok(Value::Array(commits))
                    }
                    Some(_) => ok(json!([])),
                    None => http_error(404, "Not Found"),
                }
            }
            (["pulls", n, "merge"], "PUT") => {
                if let Some(branch) = self.push_on_merge.lock().unwrap().take() {
                    self.push_empty(&branch);
                }
                if std::mem::take(&mut *self.merge_then_fail.lock().unwrap()) {
                    let n = number(Some(n));
                    if let Some(p) = self.pulls.lock().unwrap().get_mut(&n) {
                        self.merge(n, p, &fields);
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
                    Some(p) => self.merge(n, p, &fields),
                    None => http_error(404, "Not Found"),
                }
            }
            (["commits", sha], "GET") => GhOut {
                exit_code: 0,
                stdout: format!(
                    "{}\n",
                    git(&self.origin, &["diff", &format!("{sha}^"), sha])
                ),
                stderr: String::new(),
            },
            (["commits", sha, "check-runs"], _) => {
                self.moves_during_ci(sha);
                let poll = {
                    let mut polls = self.polls.lock().unwrap();
                    *polls += 1;
                    *polls
                };
                let red = match self.ci {
                    FakeCi::Actions => self.red(sha),
                    FakeCi::Workflow { green_from } if poll >= green_from => false,
                    _ => return ok(json!({ "total_count": 0, "check_runs": [] })),
                };
                ok(
                    json!({ "check_runs": [{ "id": 1, "name": "ci", "status": "completed", "conclusion": if red { "failure" } else { "success" }, "html_url": format!("https://github.com/{REPO}/actions/runs/1") }] }),
                )
            }
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

/// The rest of the hub: tasks, workstreams, events and wakes in memory.
struct FakeHost {
    tasks: Mutex<HashMap<String, TaskView>>,
    sends: Mutex<Vec<(String, String)>>,
    events: Mutex<Vec<EventView>>,
    appended: Notify,
    wakes: Mutex<Vec<String>>,
    /// Reviewers the real review gate asked for, and the refusal the spawn path answers with, if any.
    review_spawns: Mutex<Vec<ReviewSpawn>>,
    spawn_refusal: Mutex<Option<String>>,
    /// Tasks cancelled through the host, in order.
    cancels: Mutex<Vec<String>>,
    /// The workstream is done or stopped.
    ws_closed: Mutex<bool>,
    /// Running write tasks' branches, by task id.
    branches: Mutex<HashMap<String, String>>,
    /// Bases the landing scanner watches.
    watched: Mutex<HashSet<String>>,
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

    /// The `n`th message sent to a task (0-based), once it is sent.
    async fn nth_send(&self, n: usize) -> (String, String) {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let notified = self.appended.notified();
                if let Some(sent) = self.sends.lock().unwrap().get(n) {
                    return sent.clone();
                }
                notified.await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no message {n}"))
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
    fn landings_watched(&self, _repo: &str, base: &str) -> bool {
        self.watched.lock().unwrap().contains(base)
    }

    fn task(&self, task_id: &TaskId) -> Option<TaskView> {
        self.tasks.lock().unwrap().get(task_id.as_str()).cloned()
    }
    fn writers(&self, _: &ProjectRef) -> Vec<(TaskId, String)> {
        let tasks = self.tasks.lock().unwrap();
        self.branches
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| {
                tasks.get(*id).is_some_and(|t| {
                    ["running", "idle", "done"].contains(&t.state.as_str()) && t.kind == "write"
                })
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
        self.appended.notify_waiters();
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
                pr_url: Some(spawn.pr.clone()),
                result_tail: None,
            }),
        };
        if let Ok(task) = &answer {
            spawns.push(spawn);
            self.tasks
                .lock()
                .unwrap()
                .insert(task.task_id.to_string(), task.clone());
        }
        Box::pin(async move { answer })
    }
    fn cancel_task<'a>(
        &'a self,
        _: &'a ProjectRef,
        _: &'static str,
        task_id: &'a TaskId,
        reason: String,
    ) -> BoxFut<'a, Result<(), String>> {
        if let Some(task) = self.tasks.lock().unwrap().get_mut(task_id.as_str()) {
            task.state = "cancelled".into();
            task.result_tail = Some(reason);
        }
        self.cancels.lock().unwrap().push(task_id.to_string());
        self.push_event("task.cancelled", json!({ "taskId": task_id }));
        Box::pin(async { Ok(()) })
    }
    fn workstream(&self, workstream_id: &WorkstreamId) -> Option<WorkstreamView> {
        (*workstream_id == ws()).then(|| WorkstreamView {
            workstream_id: ws(),
            project_ref: project(),
            has_brief: true,
            open: !*self.ws_closed.lock().unwrap(),
        })
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
        (project_ref.project_id.as_str() != REMOVED).then(|| "/srv/storefront".into())
    }
    fn wake_lead<'a>(&'a self, _: &'a ProjectRef, line: String) -> BoxFut<'a, ()> {
        self.wakes.lock().unwrap().push(line);
        Box::pin(async {})
    }
}

/// Ready at once with a clean review of the patch it is handed, unless the test holds the PR for its own review;
/// records what it was handed.
#[derive(Default)]
struct FakeGate {
    reviewed: Mutex<Vec<Change>>,
    /// PR numbers that stay in review until the test marks them ready.
    held: Mutex<HashSet<i64>>,
    /// Ready with no review at all, as a hub from before every PR was reviewed could have left a Change.
    unreviewed: Mutex<bool>,
}

impl ReviewGate for FakeGate {
    fn review(&self, change: Change) -> BoxFut<'_, Verdict> {
        let clean = change.patch_id.clone().map(|patch_id| ChangeReview {
            task_id: TaskId::unchecked("T90"),
            pr_head_sha: change.head_sha.clone(),
            patch_id,
            blocking: Count::unchecked(0),
            non_blocking: Count::unchecked(0),
        });
        let verdict = if self.held.lock().unwrap().contains(&change.pr_number.get()) {
            Verdict::Pending
        } else if *self.unreviewed.lock().unwrap() {
            Verdict::Ready(Vec::new())
        } else {
            clean.map_or(Verdict::Pending, |r| Verdict::Ready(vec![r]))
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
    db: Db,
    /// The hub's own review gate, following verdicts, when the kit has it.
    _reviews: Option<Arc<crate::hub::reviews::Reviews>>,
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
        Kit::build(ci, tweak, false, Arc::new(SystemClock))
    }

    /// With the hub's own review gate in place of the fake one.
    fn with_reviews() -> Kit {
        Kit::build(FakeCi::Actions, |_| {}, true, Arc::new(SystemClock))
    }

    /// On `clock`, with the default options but the sweeps due on every pass and no loop.
    fn on_clock(ci: FakeCi, clock: Arc<dyn Clock>) -> Kit {
        Kit::build(ci, |_| {}, false, clock)
    }

    fn build(
        ci: FakeCi,
        tweak: impl FnOnce(&mut TrainOptions),
        real_reviews: bool,
        clock: Arc<dyn Clock>,
    ) -> Kit {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "fleetd-train-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (origin, author) = (dir.join("origin.git"), dir.join("author"));
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
            stale_reads: Mutex::default(),
            stale: Mutex::default(),
        });
        let host = Arc::new(FakeHost {
            tasks: Mutex::default(),
            sends: Mutex::default(),
            events: Mutex::default(),
            appended: Notify::new(),
            wakes: Mutex::default(),
            review_spawns: Mutex::default(),
            spawn_refusal: Mutex::default(),
            cancels: Mutex::default(),
            ws_closed: Mutex::default(),
            branches: Mutex::default(),
            watched: Mutex::default(),
        });
        let gate = Arc::new(FakeGate::default());
        let mut options = TrainOptions {
            auto_run: false,
            bypass_every: Duration::ZERO,
            ready_every: Duration::ZERO,
            ..TrainOptions::default()
        };
        tweak(&mut options);
        let gate_for_train = gate.clone();
        let (train, reviews) = if real_reviews {
            let (train, reviews) = crate::hub::reviews::service::build(
                host.clone(),
                clock.clone(),
                db.clone(),
                gh.clone(),
                options,
            );
            reviews.start();
            (train, Some(reviews))
        } else {
            let train = Train::new(
                host.clone(),
                clock.clone(),
                db.clone(),
                gh.clone(),
                options,
                |_| gate_for_train,
            );
            (train, None)
        };
        train.start();
        Kit {
            _dir: TempDir(dir),
            author,
            gh,
            host,
            gate,
            train,
            db,
            _reviews: reviews,
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

    /// A PR from `branch`, pushed with `files` on top of main.
    fn open_pr(&self, number: i64, branch: &str, files: &[(&str, Option<&str>)]) -> String {
        self.open_pr_on("main", number, branch, files)
    }

    /// A PR into `base`, which starts at main when the origin lacks it.
    fn open_pr_on(
        &self,
        base: &str,
        number: i64,
        branch: &str,
        files: &[(&str, Option<&str>)],
    ) -> String {
        if self.gh.head_of(base).is_none() {
            git(&self.gh.origin, &["branch", base, "main"]);
        }
        self.commit(branch, files, Some(&format!("origin/{base}")));
        self.gh
            .pulls
            .lock()
            .unwrap()
            .insert(number, FakePull::open(branch, base, ""));
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
            .insert(number, FakePull::open(branch, parent, ""));
        format!("https://github.com/{REPO}/pull/{number}")
    }

    async fn enqueue(&self, pr_url: String) -> Change {
        self.train
            .enqueue(&project(), enqueue_call(pr_url))
            .await
            .expect("enqueued")
    }

    /// Enqueued, and kept in review until the test marks it ready.
    async fn enqueue_held(&self, pr_url: String) -> Change {
        let number = pr_url.rsplit('/').next().unwrap().parse().unwrap();
        self.gate.held.lock().unwrap().insert(number);
        self.enqueue(pr_url).await
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
            pr_url: pr_url.map(String::from),
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

fn enqueue_call(pr_url: String) -> ChangeEnqueueCall {
    ChangeEnqueueCall {
        task_id: None,
        pr_url: GitHubPrUrl::unchecked(pr_url),
        workstream_id: Some(ws()),
    }
}

fn add(file: &'static str, content: &'static str) -> (&'static str, Option<&'static str>) {
    (file, Some(content))
}

#[tokio::test(flavor = "multi_thread")]
async fn auto_enqueues_a_write_tasks_pr_rebases_it_onto_the_moved_base_and_merges_pinned_with_fleetd_train()
 {
    let kit = Kit::new();
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")]);
    let (task_id, change_id) = kit.author_task(Some(&pr)).await;
    // Ready once its patch id is read and the review of that patch is clean.
    let before = kit.get(&change_id);
    assert_eq!(
        (
            before.state,
            before.task_id.as_ref(),
            before.position.map(|p| p.get()),
            before.branch.as_str()
        ),
        (ChangeState::Ready, Some(&task_id), Some(0), "docs")
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
    // The squash names the Change, so git alone tells the train's merge apart.
    let message = git(&kit.gh.origin, &["log", "-1", "--format=%B", "main"]);
    assert!(
        message.starts_with("change docs (#7)\n\n")
            && message.ends_with(&format!("\n\nFleetd-Change: {change_id} ({task_id}, W1)")),
        "{message}"
    );
    let mut landed = kit.host.events_of("pr.merged");
    let merged_at = landed[0]["mergedAt"].take();
    assert!(merged_at.is_string(), "{merged_at}");
    landed[0].as_object_mut().unwrap().remove("mergedAt");
    assert_eq!(
        landed,
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
        (state.repo.as_str(), state.head, state.queue.into_inner()),
        (REPO, None, vec![])
    );
}

/// The train's squash keeps GitHub's own message, here a commit's `Co-Authored-By` trailer, and adds the Change's to
/// the same trailer block, so both stay trailers.
#[tokio::test(flavor = "multi_thread")]
async fn the_squash_keeps_githubs_message_and_its_co_author_trailer_and_adds_the_changes() {
    let kit = Kit::new();
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")]);
    git(
        &kit.author,
        &[
            "commit",
            "-q",
            "--amend",
            "-m",
            "Add the docs\n\nWhat they cover.\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
        ],
    );
    git(&kit.author, &["push", "-q", "--force", "origin", "docs"]);
    let (task_id, change_id) = kit.author_task(Some(&pr)).await;
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::Merged);
    let message = git(&kit.gh.origin, &["log", "-1", "--format=%B", "main"]);
    assert_eq!(
        message,
        format!(
            "Add the docs (#7)\n\nWhat they cover.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\
             Fleetd-Change: {change_id} ({task_id}, W1)"
        )
    );
    let trailers = git(
        &kit.gh.origin,
        &["log", "-1", "--format=%(trailers:only,unfold)", "main"],
    );
    assert_eq!(
        trailers,
        format!(
            "Co-Authored-By: Claude <noreply@anthropic.com>\nFleetd-Change: {change_id} ({task_id}, W1)"
        )
    );
}

/// Several commits squash as GitHub writes them: the PR's title, a line per commit, co-authors once at the end.
#[test]
fn a_squash_of_several_commits_reads_as_githubs_with_co_authors_once() {
    let pull: super::github::Pull = serde_json::from_value(json!({
        "number": 9, "title": "Checkout totals", "state": "open", "body": "The PR's body",
        "head": { "ref": "t", "sha": "a" }, "base": { "ref": "main" },
    }))
    .unwrap();
    let co = "Co-authored-by: Claude <noreply@anthropic.com>";
    let messages = [format!("fix totals\n\n{co}"), format!("add a test\n\n{co}")];
    let squash = |title, body| super::github::squash_text(&pull, title, body, &messages);
    assert_eq!(
        squash("COMMIT_OR_PR_TITLE", "COMMIT_MESSAGES"),
        (
            "Checkout totals (#9)".to_owned(),
            format!("* fix totals\n\n* add a test\n\n---------\n\n{co}")
        )
    );
    assert_eq!(
        squash("PR_TITLE", "PR_BODY"),
        (
            "Checkout totals (#9)".to_owned(),
            "The PR's body".to_owned()
        )
    );
    assert_eq!(squash("PR_TITLE", "BLANK").1, "");
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
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")]);
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::Merged);
    assert_eq!(
        kit.train.records().train(REPO).unwrap().project_ref,
        project()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_a_conflicting_pr_back_to_its_author_moves_on_and_merges_it_after_the_author_pushes()
{
    let kit = Kit::new();
    let pr = kit.open_pr(
        7,
        "edit-a",
        &[("a.txt", Some(&a_with(&[(5, "author's line 5")])))],
    );
    let (_, first) = kit.author_task(Some(&pr)).await;
    kit.commit(
        "main",
        &[("a.txt", Some(&a_with(&[(5, "main's line 5")])))],
        None,
    );

    assert!(kit.train.step(REPO).await);
    let parked = kit.get(&first);
    assert_eq!(
        (parked.state, parked.last_error.as_deref()),
        (ChangeState::NeedsRebase, Some("conflicts with main"))
    );
    assert_eq!(
        kit.host.events_of("change.needs_rebase"),
        [json!({ "changeId": first, "workstreamId": "W1" })]
    );
    let (to, message) = kit.host.sends.lock().unwrap().last().cloned().unwrap();
    assert_eq!(to, "T1");
    assert!(message.contains("could not rebase it: it conflicts with main"));

    // The train moves on to the next ready PR.
    let other = kit
        .enqueue(kit.open_pr(8, "other", &[add("b.txt", "b\n")]))
        .await;
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
    let pr = kit.open_pr(7, "red", &[add("FAIL", "x\n")]);
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

/// No wait for CI that never comes: one poll decides.
fn one_poll(options: &mut TrainOptions) {
    options.ci_timeout = Duration::ZERO;
}

/// A reviewed, ready PR on a repo with no CI: it waits with the fix, untouched, and the doctor names the repo.
async fn held_for_no_ci(ci: FakeCi) {
    let kit = Kit::with(ci, one_poll);
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")]);
    let head = kit.head_of("docs");
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    kit.train.step(REPO).await;
    let held = kit.get(&change_id);
    assert_eq!(held.state, ChangeState::Ready);
    assert_eq!(held.last_error.as_deref(), Some(super::batch::NO_CI));
    assert_eq!(kit.head_of("docs"), head, "never rebased or pushed");
    assert!(kit.gh.merges.lock().unwrap().is_empty());
    assert!(kit.gh.statuses.lock().unwrap().is_empty());
    assert_eq!(kit.train.repos_without_ci(), [REPO]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repo_with_no_ci_holds_its_ready_pr_with_the_add_ci_fix() {
    held_for_no_ci(FakeCi::None).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_trains_own_required_status_is_not_ci() {
    held_for_no_ci(FakeCi::TrainOnly).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_workflow_whose_check_never_comes_times_out_rather_than_merging() {
    let kit = Kit::with(
        FakeCi::Workflow {
            green_from: u32::MAX,
        },
        one_poll,
    );
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")]);
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::CiFailed);
    assert!(kit.gh.merges.lock().unwrap().is_empty());
    assert!(kit.train.repos_without_ci().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn merges_into_the_pull_requests_own_base_when_it_is_not_the_default_branch() {
    let kit = Kit::new();
    let first = kit.open_pr_on(
        "slot/1/main",
        8,
        "slot/1/fleetd/T9-other",
        &[add("other.txt", "other\n")],
    );
    let second = kit.open_pr_on(
        "slot/1/main",
        7,
        "slot/1/fleetd/T1-docs",
        &[add("docs.md", "docs\n")],
    );
    let first = kit.enqueue(first).await;
    assert!(kit.train.step(REPO).await);
    let second = kit.enqueue(second).await;
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
async fn a_merge_outside_the_train_is_reported_once_and_only_into_a_base_the_train_guards() {
    let kit = Kit::new();
    let pr = kit.open_pr_on(
        "slot/1/main",
        7,
        "slot/1/fleetd/T1-docs",
        &[add("docs.md", "docs\n")],
    );
    kit.enqueue(pr).await;
    assert!(kit.train.step(REPO).await);
    merged_outside(&kit, 8, "slot/2/main");
    merged_outside(&kit, 9, "slot/1/main");
    merged_outside(&kit, 10, "main");
    // The train's own batch PR, from its scratch branch, is its merge.
    let batch = FakePull {
        branch: "fleetd/train/batch-1".into(),
        ..kit.gh.pulls.lock().unwrap().remove(&10).unwrap()
    };
    kit.gh.pulls.lock().unwrap().insert(11, batch);
    merged_outside(&kit, 10, "main");

    kit.train.step(REPO).await;
    kit.train.step(REPO).await;
    let mut reported: Vec<i64> = kit
        .host
        .events_of("pr.merged_outside")
        .iter()
        .map(|e| e["prNumber"].as_i64().unwrap())
        .collect();
    reported.sort_unstable();
    assert_eq!(reported, [9, 10], "each once");
    // What the metrics need of it: where it merged from and into, when, and who opened it.
    let ten = kit
        .host
        .events_of("pr.merged_outside")
        .into_iter()
        .find(|e| e["prNumber"] == json!(10))
        .unwrap();
    assert_eq!(
        (
            &ten["head"],
            &ten["base"],
            &ten["authorKind"],
            &ten["prCreatedAt"]
        ),
        (
            &json!("outside-10"),
            &json!("main"),
            &json!("human"),
            &json!("2026-10-16T09:00:00.000Z")
        )
    );
    assert!(ten["mergedAt"].is_string());
    assert_eq!(
        (&ten["mergedBy"], &ten["mergedByKind"]),
        (&json!("ada-lovelace"), &json!("human"))
    );
    let wakes = kit.host.wakes.lock().unwrap().clone();
    assert!(
        wakes.iter().any(|w| w.contains(&format!(
            "{REPO}#10 was merged into main without the merge train"
        ))),
        "{wakes:?}"
    );
}

/// The minute-by-minute check reads back to its watch, so the watch moves past the train's own merges too: a busy
/// repo where only the train merges stays at one page a minute.
#[tokio::test(flavor = "multi_thread")]
async fn the_outside_merge_watch_moves_past_the_trains_own_merges() {
    let kit = Kit::new();
    let pr = kit.open_pr(7, "a", &[add("a.txt", "a\n")]);
    kit.enqueue(pr).await;
    assert!(kit.train.step(REPO).await);
    merged_outside(&kit, 11, "main");
    let batch = FakePull {
        branch: "fleetd/train/batch-1".into(),
        ..kit.gh.pulls.lock().unwrap().remove(&11).unwrap()
    };
    let at = crate::hub::store::parse_ms(batch.merged_at.as_deref().unwrap()).unwrap();
    kit.gh.pulls.lock().unwrap().insert(11, batch);

    kit.train.step(REPO).await;
    assert!(kit.host.events_of("pr.merged_outside").is_empty());
    assert_eq!(kit.train.records().train(REPO).unwrap().watch_since_ms, at);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_merge_outside_the_train_into_a_base_the_landing_scanner_watches_wakes_the_lead_only_from_there()
 {
    let kit = Kit::new();
    kit.host.watched.lock().unwrap().insert("main".into());
    let pr = kit.open_pr_on("main", 7, "fleetd/T1-docs", &[add("docs.md", "docs\n")]);
    kit.enqueue(pr).await;
    assert!(kit.train.step(REPO).await);
    merged_outside(&kit, 9, "main");
    kit.train.step(REPO).await;
    let reported: Vec<i64> = kit
        .host
        .events_of("pr.merged_outside")
        .iter()
        .map(|e| e["prNumber"].as_i64().unwrap())
        .collect();
    assert_eq!(reported, [9], "still an event");
    let wakes = kit.host.wakes.lock().unwrap().clone();
    assert!(
        !wakes.iter().any(|w| w.contains("without the merge train")),
        "the scanner's work.landed line tells the lead: {wakes:?}"
    );
}

/// The train merges a PR into its own base, so a PR based on another open PR's branch would land in that PR: it is
/// refused with how to go on once its parent merges.
#[tokio::test(flavor = "multi_thread")]
async fn a_pr_based_on_another_open_prs_branch_is_refused() {
    let kit = Kit::new();
    let parent = kit.open_pr(7, "p", &[add("p.txt", "p\n")]);
    kit.enqueue(parent).await;
    let child = kit.stacked_pr(8, "c", "p", &[add("c.txt", "c\n")]);
    let refused = kit
        .train
        .enqueue(&project(), enqueue_call(child))
        .await
        .unwrap_err();
    assert!(
        refused.message.contains("based on #7's branch"),
        "{}",
        refused.message
    );
    assert!(
        refused
            .fix
            .as_deref()
            .is_some_and(|f| f.contains("gh pr edit 8 --base")),
        "{:?}",
        refused.fix
    );
}

/// GitHub may take minutes to start a run: the train waits for the check however long it takes to appear.
#[tokio::test(flavor = "multi_thread")]
async fn waits_for_a_check_however_long_github_takes_to_start_it() {
    let kit = Kit::with(FakeCi::Workflow { green_from: 4 }, |o| {
        o.poll_interval = Duration::ZERO;
    });
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")]);
    let (_, change_id) = kit.author_task(Some(&pr)).await;
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::Merged);
    assert!(*kit.gh.polls.lock().unwrap() >= 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_waiting_for_checks_a_repo_without_check_runs_requires() {
    let kit = Kit::with(FakeCi::Required, one_poll);
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")]);
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
async fn never_takes_a_failed_ci_read_for_no_ci() {
    let kit = Kit::with(FakeCi::Unreadable, one_poll);
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")]);
    let (_, change_id) = kit.author_task(Some(&pr)).await;

    assert!(kit.train.step(REPO).await);
    // Not held for want of CI: it waited for checks that never came, and nothing merged.
    let parked = kit.get(&change_id);
    assert_eq!(parked.state, ChangeState::CiFailed);
    assert!(kit.train.repos_without_ci().is_empty());
    assert!(kit.gh.merges.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn requeues_at_the_front_when_github_refuses_the_pinned_merge_with_409_then_merges() {
    let kit = Kit::new();
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("b.txt", "b\n")]))
        .await;
    // Behind it in the queue, in review.
    let b = kit
        .enqueue_held(kit.open_pr(8, "b", &[add("c.txt", "c\n")]))
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
async fn sends_a_change_back_to_reviewing_when_a_clean_rebase_changes_its_patch_id_and_refuses_reviews_of_the_old_patch()
 {
    let kit = Kit::new();
    let change = kit
        .enqueue_held(kit.open_pr(7, "m", &[("a.txt", Some(&a_with(&[(6, "pr line 6")])))]))
        .await;
    assert_eq!(change.state, ChangeState::Reviewing);
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

/// The merges GitHub saw, by PR number.
fn merged_prs(kit: &Kit) -> Vec<i64> {
    kit.gh.merges.lock().unwrap().iter().map(|m| m.0).collect()
}

fn state_of(kit: &Kit, change: &Change) -> ChangeState {
    kit.get(&change.change_id).state
}

/// The members of the first PR GitHub merged, a batch, by PR number.
fn members_of_batch(kit: &Kit) -> Vec<i64> {
    let batch = kit.gh.merges.lock().unwrap()[0].0;
    batch_heads(&kit.gh.pulls.lock().unwrap()[&batch].body)
        .into_iter()
        .map(|(n, _)| n)
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn batches_three_ready_prs_into_one_ci_run_and_one_squash_and_closes_each_with_a_link() {
    let kit = Kit::new();
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    let b = kit
        .enqueue(kit.open_pr(8, "b", &[add("b1.txt", "b\n")]))
        .await;
    let c = kit
        .enqueue(kit.open_pr(9, "c", &[add("c1.txt", "c\n")]))
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
    // The batch's squash names each Change it landed, last.
    let message = git(&kit.gh.origin, &["log", "-1", "--format=%B", "main"]);
    let trailers: Vec<&str> = message.lines().rev().take(3).collect();
    assert_eq!(
        trailers,
        [&c, &b, &a].map(|x| format!("Fleetd-Change: {} (W1)", x.change_id)),
        "{message}"
    );
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
    assert!(
        merged_events
            .iter()
            .all(|e| e["batchPr"] == json!(batch_pr) && e["mergedAt"].is_string()),
        "{merged_events:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_red_batch_sends_each_member_through_alone() {
    let kit = Kit::new();
    // Each green alone; pair-a and pair-b together are red.
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    let b = kit
        .enqueue(kit.open_pr(8, "b", &[add("pair-a", "a\n")]))
        .await;
    let c = kit
        .enqueue(kit.open_pr(9, "c", &[add("pair-b", "b\n")]))
        .await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(merged_prs(&kit), [7, 8], "each alone, in queue order");
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(state_of(&kit, &b), ChangeState::Merged);
    // Alone, on the new main, it is red: its author hears it, and it never merges.
    assert_eq!(state_of(&kit, &c), ChangeState::CiFailed);
    assert!(kit.main_file("pair-b").is_none());
    assert_eq!(
        kit.host.events_of("change.ci_failed").len(),
        1,
        "nobody is blamed for the red batch itself"
    );
}

/// a, b and c, green alone but red together (pair-a, pair-b): their batch is red, so each goes alone, and GitHub refuses
/// a's merge once.
async fn red_batch_then_a_refused(kit: &Kit) -> [Change; 3] {
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    let b = kit
        .enqueue(kit.open_pr(8, "b", &[add("pair-a", "a\n")]))
        .await;
    let c = kit
        .enqueue(kit.open_pr(9, "c", &[add("pair-b", "b\n")]))
        .await;
    kit.gh
        .merge_replies
        .lock()
        .unwrap()
        .push(http_error(405, "Pull Request is not mergeable"));
    assert!(kit.train.step(REPO).await);
    [a, b, c]
}

#[tokio::test(flavor = "multi_thread")]
async fn a_merge_github_refuses_keeps_the_pr_first_in_line_and_says_why() {
    let kit = Kit::new();
    let [a, b, c] = red_batch_then_a_refused(&kit).await;

    let why = "GitHub refused the merge (HTTP 405): Pull Request is not mergeable";
    let back = kit.get(&a.change_id);
    assert_eq!(
        (
            back.state,
            back.position.map(|p| p.get()),
            back.last_error.as_deref()
        ),
        (ChangeState::Ready, Some(0), Some(why))
    );
    let moves = kit.host.events_of("change.state");
    let of = |change: &Change, from: &str| {
        moves
            .iter()
            .find(|e| e["changeId"] == json!(change.change_id) && e["from"] == from)
            .unwrap_or_else(|| panic!("no {from} move of {}: {moves:?}", change.change_id))
    };
    let bounce = of(&a, "merging");
    assert_eq!(
        (&bounce["to"], &bounce["reason"]),
        (&json!("ready"), &json!(why))
    );
    // Nothing behind it went first: they wait, in order, with the red batch as their reason.
    assert!(merged_prs(&kit).is_empty());
    assert_eq!(
        kit.train.state(REPO).queue.into_inner(),
        [
            a.change_id.clone(),
            b.change_id.clone(),
            c.change_id.clone()
        ]
    );
    for change in [&b, &c] {
        let left = of(change, "ci");
        assert_eq!(left["to"], json!("ready"));
        let reason = left["reason"].as_str().unwrap();
        assert!(reason.contains("CI red"), "{reason}");
        assert_eq!(state_of(&kit, change), ChangeState::Ready);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn ready_prs_merge_in_queue_order_after_a_bounce() {
    let kit = Kit::new();
    let [a, b, c] = red_batch_then_a_refused(&kit).await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(merged_prs(&kit), [7, 8], "a first, then b");
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(state_of(&kit, &b), ChangeState::Merged);
    // Alone on the new main, it is red.
    assert_eq!(state_of(&kit, &c), ChangeState::CiFailed);
}

/// Time that moves only by the train's own sleeps, each over at once and kept: the train's waits without waiting.
#[derive(Default)]
struct Sleeps(Mutex<Vec<Duration>>);

impl Sleeps {
    fn taken(&self) -> Vec<Duration> {
        self.0.lock().unwrap().clone()
    }
}

impl Clock for Sleeps {
    fn now(&self) -> std::time::SystemTime {
        std::time::UNIX_EPOCH
            + Duration::from_secs(1_800_000_000)
            + self.0.lock().unwrap().iter().sum::<Duration>()
    }
    fn sleep(
        &self,
        duration: Duration,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        self.0.lock().unwrap().push(duration);
        Box::pin(std::future::ready(()))
    }
}

fn clean_review(change: &Change) -> ChangeReview {
    ChangeReview {
        task_id: TaskId::unchecked("T9"),
        pr_head_sha: change.head_sha.clone(),
        patch_id: change.patch_id.clone().unwrap(),
        blocking: Count::unchecked(0),
        non_blocking: Count::unchecked(0),
    }
}

/// A head in CI is read every 2 s at first, then less often as the run goes on, and never less often than an idle
/// pass: a short CI is seen green within seconds, a long one settles at the idle rate.
#[tokio::test(flavor = "multi_thread")]
async fn a_head_in_ci_is_read_soon_then_at_the_idle_rate() {
    let clock = Arc::new(Sleeps::default());
    let kit = Kit::on_clock(FakeCi::Workflow { green_from: 40 }, clock.clone());
    let pr = kit.open_pr(7, "docs", &[add("docs.md", "docs\n")]);
    let (_, change_id) = kit.author_task(Some(&pr)).await;
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change_id).state, ChangeState::Merged);

    let waits = clock.taken();
    let idle = TrainOptions::default().poll_interval;
    assert_eq!(waits[..8], [Duration::from_secs(2); 8], "{waits:?}");
    assert!(waits.windows(2).all(|w| w[0] <= w[1]), "{waits:?}");
    assert_eq!(waits.iter().max(), Some(&idle), "{waits:?}");
    let first_minute = waits
        .iter()
        .scan(Duration::ZERO, |at, w| {
            *at += *w;
            Some(*at)
        })
        .take_while(|at| *at <= Duration::from_secs(60))
        .count();
    assert!(
        first_minute <= 24,
        "{first_minute} reads in CI's first minute"
    );
}

/// GitHub shows a rebased head within a second or two: the train reads the PR again after 1 s, not after an idle pass.
#[tokio::test(flavor = "multi_thread")]
async fn a_rebased_pr_is_read_again_within_a_second() {
    let clock = Arc::new(Sleeps::default());
    let kit = Kit::on_clock(FakeCi::Actions, clock.clone());
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("b.txt", "b\n")]))
        .await;
    kit.commit("main", &[add("other.txt", "other\n")], None);
    *kit.gh.stale_reads.lock().unwrap() = 2;

    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(clock.taken(), [Duration::from_secs(1); 2]);
}

/// The running train, its idle pass an hour away: each review verdict moves it at once, and the second Change,
/// rebased onto the first's merge while GitHub still shows its old head, merges within seconds too.
#[tokio::test(flavor = "multi_thread")]
async fn verdicts_move_the_running_train_at_once() {
    let kit = Kit::with(FakeCi::Actions, |o| {
        o.auto_run = true;
        o.poll_interval = Duration::from_secs(3600);
    });
    let a = kit
        .enqueue_held(kit.open_pr(7, "a", &[add("b.txt", "b\n")]))
        .await;
    let b = kit
        .enqueue_held(kit.open_pr(8, "b", &[add("c.txt", "c\n")]))
        .await;
    *kit.gh.stale_reads.lock().unwrap() = 1;
    for change in [&a, &b] {
        let cursor = kit.host.events_head();
        kit.train
            .mark_ready(&change.change_id, vec![clean_review(change)])
            .unwrap();
        kit.host.next_event(cursor, "pr.merged").await;
        assert_eq!(state_of(&kit, change), ChangeState::Merged);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn waits_for_github_to_show_the_rebased_head_and_merges_that_head() {
    let kit = Kit::with(FakeCi::Actions, |o| {
        o.poll_interval = Duration::from_millis(10)
    });
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("b.txt", "b\n")]))
        .await;
    kit.commit("main", &[add("other.txt", "other\n")], None);
    let old = kit.head_of("a");
    *kit.gh.stale_reads.lock().unwrap() = 2;

    assert!(kit.train.step(REPO).await);
    let rebased = kit.head_of("a");
    assert_ne!(rebased, old);
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(*kit.gh.merges.lock().unwrap(), [(7, rebased.clone())]);
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
        [rebased],
        "fleetd/train only on the rebased head"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_that_conflicts_in_the_batch_goes_back_to_its_writer_and_the_rest_merge() {
    let kit = Kit::new();
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[("a.txt", Some(&a_with(&[(2, "a")])))]))
        .await;
    let b = kit
        .enqueue(kit.open_pr(8, "b", &[("a.txt", Some(&a_with(&[(2, "b")])))]))
        .await;
    let c = kit
        .enqueue(kit.open_pr(9, "c", &[add("c1.txt", "c\n")]))
        .await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(members_of_batch(&kit), [7, 9]);
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(state_of(&kit, &c), ChangeState::Merged);
    let parked = kit.get(&b.change_id);
    assert_eq!(
        (parked.state, parked.last_error.as_deref()),
        (
            ChangeState::NeedsRebase,
            Some("conflicts with main and the PRs ahead of it in the train")
        )
    );
    assert_eq!(kit.host.events_of("change.needs_rebase").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn only_reviewed_held_free_and_own_green_prs_join_a_batch() {
    let kit = Kit::new();
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    // In review until a review marks it ready.
    let m = kit
        .enqueue_held(kit.open_pr(8, "m", &[add("m1.txt", "m\n")]))
        .await;
    let held = kit
        .enqueue(kit.open_pr(9, "h", &[add("h1.txt", "h\n")]))
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
        .enqueue(kit.open_pr(10, "r", &[add("FAIL", "x\n")]))
        .await;
    let d = kit
        .enqueue(kit.open_pr(11, "d", &[add("d1.txt", "d\n")]))
        .await;

    assert!(kit.train.step(REPO).await);
    assert_eq!(members_of_batch(&kit), [7, 11]);
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
    // Checks the base requires never report: neither is green on its own, so no batch forms, and each alone times out,
    // never merging.
    let kit = Kit::with(FakeCi::Required, one_poll);
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    let b = kit
        .enqueue(kit.open_pr(8, "b", &[add("b1.txt", "b\n")]))
        .await;
    for _ in 0..3 {
        kit.train.step(REPO).await;
    }
    assert!(merged_prs(&kit).is_empty());
    assert_eq!(state_of(&kit, &a), ChangeState::CiFailed);
    assert_eq!(state_of(&kit, &b), ChangeState::CiFailed);

    // GitHub refuses the batch PR (say, it wants an approval): each member goes alone, through GitHub's rules again.
    let kit = Kit::new();
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    let b = kit
        .enqueue(kit.open_pr(8, "b", &[add("b1.txt", "b\n")]))
        .await;
    kit.gh.merge_replies.lock().unwrap().push(http_error(
        405,
        "At least 1 approving review is required by reviewers with write access.",
    ));
    assert!(kit.train.step(REPO).await);
    assert_eq!(merged_prs(&kit), [7, 8], "each alone");
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(state_of(&kit, &b), ChangeState::Merged);
    // The next pass deletes the batch's branch, which closes its PR.
    kit.train.step(REPO).await;
    let batch = kit
        .gh
        .pulls
        .lock()
        .unwrap()
        .values()
        .find(|p| p.branch == "fleetd/train/batch")
        .map(|p| (p.state.clone(), p.merged))
        .unwrap();
    assert_eq!(batch, ("closed".into(), false));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_member_pushed_to_while_the_batch_is_in_ci_leaves_it_untested_code_never_lands() {
    let kit = Kit::new();
    let a = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    let b = kit
        .enqueue(kit.open_pr(8, "b", &[add("b1.txt", "b\n")]))
        .await;
    let c = kit
        .enqueue(kit.open_pr(9, "c", &[add("c1.txt", "c\n")]))
        .await;
    *kit.gh.push_during_ci.lock().unwrap() = Some("b".into());

    // The batch did not test b's new head: it goes, and nothing merges.
    assert!(kit.train.step(REPO).await);
    assert!(merged_prs(&kit).is_empty());
    for change in [&a, &b, &c] {
        assert_eq!(state_of(&kit, change), ChangeState::Ready);
    }

    // The next one goes without b, whose new head (same patch) goes after it.
    assert!(kit.train.step(REPO).await);
    assert_eq!(members_of_batch(&kit), [7, 9]);
    assert_eq!(state_of(&kit, &a), ChangeState::Merged);
    assert_eq!(state_of(&kit, &c), ChangeState::Merged);
    assert_eq!(state_of(&kit, &b), ChangeState::Ready);
    assert!(kit.train.step(REPO).await);
    assert_eq!(state_of(&kit, &b), ChangeState::Merged);
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

/// Three PRs, each adding its own file, reviewed and ready: 7 (a), 8 (b), 9 (c).
async fn three_ready(kit: &Kit) -> [Change; 3] {
    let mut out = Vec::new();
    for (n, branch) in [(7, "a"), (8, "b"), (9, "c")] {
        let file = format!("{branch}1.txt");
        let pr = kit.open_pr(n, branch, &[(file.as_str(), Some("x\n"))]);
        out.push(kit.enqueue(pr).await);
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
    // What a hub that restarted mid-way left: batches, each with an open PR.
    for (n, branch) in [(50, "fleetd/train/batch-99"), (51, "fleetd/train/batch")] {
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
    // Held, so the first pass only sweeps.
    let ready = three_ready(&kit).await;
    let hold = |on: bool| {
        let mut pulls = kit.gh.pulls.lock().unwrap();
        for c in &ready {
            pulls.get_mut(&c.pr_number.get()).unwrap().labels =
                if on { vec!["hold".into()] } else { Vec::new() };
        }
    };
    hold(true);

    assert!(!kit.train.step(REPO).await);
    assert!(kit.gh.head_of("fleetd/train/batch-99").is_none());
    assert!(kit.gh.head_of("fleetd/train/batch").is_none());
    assert!(kit.gh.head_of("fleetd/T3-docs").is_some());
    let states = {
        let pulls = kit.gh.pulls.lock().unwrap();
        (pulls[&50].state.clone(), pulls[&51].state.clone())
    };
    assert_eq!(states, ("closed".into(), "closed".into()));

    hold(false);
    assert!(kit.train.step(REPO).await);
    assert_eq!(merged_prs(&kit).len(), 1);
    kit.train.step(REPO).await;
    assert!(
        kit.gh.head_of("fleetd/train/batch").is_none(),
        "the next pass deletes it"
    );
}

impl Kit {
    fn running_task(&self, id: &str, kind: &str) -> TaskId {
        let task = TaskView {
            task_id: TaskId::unchecked(id),
            project_ref: project(),
            workstream_id: ws(),
            kind: kind.into(),
            state: "running".into(),
            pr_url: None,
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
    let kit = Kit::new();
    kit.gate.held.lock().unwrap().extend([7, 8]);
    let writer = kit.running_task("T1", "write");
    let slice = |pr: &str| GitHubPrUrl::unchecked(pr);

    let first = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]);
    let change = slice_ready(&kit.train, &project(), &writer, slice(&first))
        .await
        .unwrap();
    assert_eq!(
        (change.state, change.task_id.as_ref()),
        (ChangeState::Reviewing, Some(&writer))
    );
    assert_eq!(
        kit.gate.reviewed.lock().unwrap().len(),
        1,
        "reviewed at once"
    );
    // The writer reports the same head again: the same Change, no second round.
    let again = slice_ready(&kit.train, &project(), &writer, slice(&first))
        .await
        .unwrap();
    assert_eq!(again.change_id, change.change_id);
    assert_eq!(kit.gate.reviewed.lock().unwrap().len(), 1);
    // Pending reviews hold it: it is never ready, so never merged, without them.
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Reviewing);

    // The next slice gets its own review while the first still waits on its own.
    let second = kit.open_pr(8, "slice-2", &[add("a2.txt", "b\n")]);
    let other = slice_ready(&kit.train, &project(), &writer, slice(&second))
        .await
        .unwrap();
    assert_ne!(other.change_id, change.change_id);
    assert_eq!(kit.gate.reviewed.lock().unwrap().len(), 2);

    // The train's checks still refuse: a reviewer is no writer.
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

/// A ready slice gets one reviewer, spawned by the gate through the tasks' spawn path, once per head. When that path refuses (the lead's fan-out limit), nothing is waived: the
/// slice stays in review and can't merge.
#[tokio::test(flavor = "multi_thread")]
async fn a_ready_slice_gets_the_orders_reviewer_and_a_refused_spawn_never_lets_it_through() {
    use super::calls::slice_ready;
    let kit = Kit::with_reviews();
    let writer = kit.running_task("T1", "write");
    let slice = |pr: &str| GitHubPrUrl::unchecked(pr);
    let first = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]);
    let change = slice_ready(&kit.train, &project(), &writer, slice(&first))
        .await
        .unwrap();
    let spawned: Vec<(String, &str)> = kit
        .host
        .review_spawns
        .lock()
        .unwrap()
        .iter()
        .map(|s| (s.pr.clone(), s.by))
        .collect();
    assert_eq!(spawned, [(first.clone(), "hub:reviews")]);
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
    let second = kit.open_pr(8, "slice-2", &[add("a2.txt", "b\n")]);
    let held = slice_ready(&kit.train, &project(), &writer, slice(&second))
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

/// A closed workstream never gets a reviewer: its Change leaves the train instead of waiting in reviewing, and the
/// lead hears why.
#[tokio::test(flavor = "multi_thread")]
async fn a_refused_reviewer_for_a_closed_workstream_sends_the_change_to_the_lead() {
    let kit = Kit::with_reviews();
    *kit.host.ws_closed.lock().unwrap() = true;
    *kit.host.spawn_refusal.lock().unwrap() =
        Some("Workstream W1 is done; tasks run only for open workstreams.".into());
    let change = kit
        .enqueue(kit.open_pr(7, "late", &[add("l.txt", "l\n")]))
        .await;
    let left = kit.get(&change.change_id);
    assert_eq!(left.state, ChangeState::Abandoned);
    let wakes = kit.host.wakes.lock().unwrap().clone();
    assert!(
        wakes
            .iter()
            .any(|w| w
                .contains("left the train: could not spawn the reviewer: Workstream W1 is done")),
        "{wakes:?}"
    );
}

/// The hub's own gate: one fresh reviewer per patch. Nothing merges before a clean verdict on the current patch;
/// blocking findings go to the author, and its new head is reviewed again by a new reviewer, from the delta.
#[tokio::test(flavor = "multi_thread")]
async fn a_pr_merges_only_on_a_clean_review_of_its_current_patch() {
    let kit = Kit::with_reviews();
    let writer = kit.running_task("T1", "write");
    let pr = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]);
    let first_head = kit.head_of("slice-1");
    let change = kit
        .train
        .enqueue(
            &project(),
            ChangeEnqueueCall {
                task_id: Some(writer.clone()),
                ..enqueue_call(pr)
            },
        )
        .await
        .unwrap();
    assert_eq!(change.state, ChangeState::Reviewing);
    assert_eq!(kit.host.review_spawns.lock().unwrap().len(), 1);
    kit.train.step(REPO).await;
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Reviewing);
    assert!(merged_prs(&kit).is_empty(), "no review, no merge");

    kit.host.push_event(
        "review.verdict",
        json!({ "taskId": "T50", "prHeadSha": first_head, "blocking": 2, "nonBlocking": 0 }),
    );
    let (to, text) = kit.host.nth_send(0).await;
    assert_eq!(to, writer.as_str(), "blocking findings go to the author");
    assert!(text.contains("T50"), "{text}");
    kit.train.step(REPO).await;
    assert!(merged_prs(&kit).is_empty());

    // The author's fix is a new head: a new reviewer starts from what changed since the reviewed head.
    let fixed_head = kit.commit("slice-1", &[add("a2.txt", "fixed\n")], None);
    kit.train.step(REPO).await;
    {
        let spawns = kit.host.review_spawns.lock().unwrap();
        assert_eq!(spawns.len(), 2, "a new head needs a new review");
        assert!(
            spawns[1]
                .prompt
                .contains(&format!("git range-diff {first_head}...{fixed_head}")),
            "{}",
            spawns[1].prompt
        );
    }
    assert!(merged_prs(&kit).is_empty());
    // The old reviewer's clean word on the old head counts for nothing.
    kit.host.push_event(
        "review.verdict",
        json!({ "taskId": "T50", "prHeadSha": first_head, "blocking": 0, "nonBlocking": 0 }),
    );
    let cursor = kit.host.events_head();
    kit.host.push_event(
        "review.verdict",
        json!({ "taskId": "T51", "prHeadSha": fixed_head, "blocking": 0, "nonBlocking": 1 }),
    );
    kit.host.next_event(cursor, "change.ready").await;
    let ready = kit.get(&change.change_id);
    assert_eq!(
        ready
            .reviews
            .iter()
            .map(|r| r.task_id.as_str())
            .collect::<Vec<_>>(),
        ["T51"]
    );
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
}

/// Waits until `done` holds, as the gate follows events on its own task.
async fn eventually(what: &str, done: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("never: {what}"));
}

impl Kit {
    fn spawned(&self) -> usize {
        self.host.review_spawns.lock().unwrap().len()
    }

    /// The task ends as `event` (`task.completed`, ...) says, with `tail` as its last lines.
    fn end_task(&self, task_id: &str, event: &str, tail: &str) {
        if let Some(task) = self.host.tasks.lock().unwrap().get_mut(task_id) {
            task.state = match event {
                "task.completed" => "done",
                "task.failed" => "failed",
                _ => "cancelled",
            }
            .into();
            task.result_tail = Some(tail.into());
        }
        self.host.push_event(event, json!({ "taskId": task_id }));
    }

    /// A PR into main from two commits, its parent's (p.txt) and its own (o.txt), approved at that head. Returns the
    /// Change, ready, and the approved head.
    async fn approved_with_its_parent(&self) -> (Change, String) {
        self.commit("slice-1", &[add("p.txt", "parent\n")], Some("origin/main"));
        let approved = self.commit("slice-1", &[add("o.txt", "own\n")], None);
        self.gh
            .pulls
            .lock()
            .unwrap()
            .insert(7, FakePull::open("slice-1", "main", ""));
        let pr = format!("https://github.com/{REPO}/pull/7");
        let change = self.enqueue(pr).await;
        assert_eq!(self.spawned(), 1);
        let cursor = self.host.events_head();
        self.host.push_event(
            "review.verdict",
            json!({ "taskId": "T50", "prHeadSha": approved, "blocking": 0, "nonBlocking": 0 }),
        );
        self.host.next_event(cursor, "change.ready").await;
        (change, approved)
    }

    /// `approved_with_its_parent`, then the parent lands on main as one squash, and the author rebases onto it, which
    /// drops the parent's commit.
    async fn approved_then_rebased_past_its_parent(&self) -> (Change, String) {
        let (change, approved) = self.approved_with_its_parent().await;
        self.commit("main", &[add("p.txt", "parent\n")], Some("origin/main"));
        git(&self.author, &["fetch", "-q", "origin"]);
        git(
            &self.author,
            &["checkout", "-q", "-B", "slice-1", &approved],
        );
        git(&self.author, &["rebase", "-q", "origin/main"]);
        (change, approved)
    }

    fn push_author(&self, branch: &str) -> String {
        let to = format!("HEAD:refs/heads/{branch}");
        git(&self.author, &["push", "-q", "--force", "origin", &to]);
        self.head_of(branch)
    }
}

/// A reviewer that ends without a verdict, however it ends, is replaced by a new one for the same head, twice. When
/// the third ends without one too, no more start and the lead is told once, with the PR and that reviewer's last lines.
#[tokio::test(flavor = "multi_thread")]
async fn a_reviewer_that_ends_without_a_verdict_is_retried_twice_then_the_lead_is_told() {
    let kit = Kit::with_reviews();
    let pr = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]);
    let head = kit.head_of("slice-1");
    let change = kit.enqueue(pr.clone()).await;
    assert_eq!(kit.spawned(), 1);

    kit.end_task("T50", "task.completed", "Done.");
    eventually("a second reviewer", || kit.spawned() == 2).await;
    kit.end_task("T51", "task.cancelled", "Cancelled by the person.");
    eventually("a third reviewer", || kit.spawned() == 3).await;
    {
        let spawns = kit.host.review_spawns.lock().unwrap();
        assert!(
            spawns
                .iter()
                .all(|s| s.pr == pr && s.prompt.contains(&head))
        );
    }
    let stalled = || {
        let wakes = kit.host.wakes.lock().unwrap();
        wakes
            .iter()
            .filter(|w| w.contains("not reviewed"))
            .cloned()
            .collect::<Vec<_>>()
    };
    assert!(stalled().is_empty());

    kit.end_task("T52", "task.failed", "reading the diff\nran out of turns");
    eventually("the lead told", || !stalled().is_empty()).await;
    let told = stalled();
    assert_eq!(told.len(), 1);
    assert!(
        told[0].starts_with(
            "- PR #7 not reviewed: 3 reviewers in a row ended without a verdict, the last T52"
        ) && told[0].contains(&pr)
            && told[0].ends_with("  > reading the diff\n  > ran out of turns"),
        "{told:?}"
    );
    let parked = kit.get(&change.change_id);
    assert_eq!(parked.state, ChangeState::Reviewing);
    assert!(
        parked
            .last_error
            .as_ref()
            .is_some_and(|e| e.contains("the lead was told")),
        "{:?}",
        parked.last_error
    );

    // Its end seen again starts nothing and tells nobody twice; a verdict that comes after all still counts.
    kit.end_task("T52", "task.failed", "ran out of turns");
    let cursor = kit.host.events_head();
    kit.host.push_event(
        "review.verdict",
        json!({ "taskId": "T52", "prHeadSha": head, "blocking": 0, "nonBlocking": 0 }),
    );
    kit.host.next_event(cursor, "change.ready").await;
    assert_eq!(kit.spawned(), 3);
    assert_eq!(stalled().len(), 1);
}

/// The lead hears of a stalled review once, even across a hub restart: a fresh gate over the same database tells
/// nobody again.
#[tokio::test(flavor = "multi_thread")]
async fn a_stalled_review_is_told_once_across_a_restart() {
    let kit = Kit::with_reviews();
    let change = kit
        .enqueue(kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]))
        .await;
    for (n, task) in ["T50", "T51", "T52"].into_iter().enumerate() {
        eventually("a reviewer", || kit.spawned() == n + 1).await;
        kit.end_task(task, "task.completed", "Done.");
    }
    let stalled = || {
        let wakes = kit.host.wakes.lock().unwrap();
        wakes.iter().filter(|w| w.contains("not reviewed")).count()
    };
    eventually("the lead told", || stalled() == 1).await;

    let restarted = crate::hub::reviews::Reviews::new(
        kit.host.clone(),
        kit.db.clone(),
        Arc::downgrade(&kit.train),
    );
    let verdict = restarted.again(kit.get(&change.change_id)).await;
    assert_eq!(verdict, Verdict::Pending);
    assert_eq!(stalled(), 1);
    assert_eq!(kit.spawned(), 3);
}

/// A replacement reviewer the tasks' spawn path refuses (the project's fan-out limit) is started on a later pass of
/// the train, as soon as it can be.
#[tokio::test(flavor = "multi_thread")]
async fn a_refused_replacement_reviewer_starts_on_a_later_pass() {
    let kit = Kit::with_reviews();
    let change = kit
        .enqueue(kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]))
        .await;
    assert_eq!(kit.spawned(), 1);
    *kit.host.spawn_refusal.lock().unwrap() = Some(
        "This project already has 32 open tasks, the most one lead may have at once (32).".into(),
    );
    kit.end_task("T50", "task.completed", "Done.");
    let error = || {
        kit.get(&change.change_id)
            .last_error
            .map(|e| e.to_string())
            .unwrap_or_default()
    };
    eventually("the refusal noted", || {
        error().contains("could not spawn the reviewer")
    })
    .await;
    kit.train.step(REPO).await;
    assert_eq!(kit.spawned(), 1, "still refused");

    *kit.host.spawn_refusal.lock().unwrap() = None;
    kit.train.step(REPO).await;
    assert_eq!(kit.spawned(), 2);
    assert!(
        error().contains("T51 reviews it again (retry 1 of 2)"),
        "{}",
        error()
    );
    kit.train.step(REPO).await;
    assert_eq!(kit.spawned(), 2, "one replacement while it runs");
}

/// A new head while its review runs: the new head's reviewer starts and the old one is cancelled. Whatever the old
/// one reports later, even on the new head, counts for nothing, and its cancel starts no other reviewer.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_head_stops_the_old_heads_reviewer_and_ignores_its_verdict() {
    let kit = Kit::with_reviews();
    let writer = kit.running_task("T1", "write");
    let pr = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]);
    let change = kit
        .train
        .enqueue(
            &project(),
            ChangeEnqueueCall {
                task_id: Some(writer.clone()),
                ..enqueue_call(pr)
            },
        )
        .await
        .unwrap();
    assert_eq!(kit.spawned(), 1);

    let new_head = kit.commit("slice-1", &[add("a2.txt", "b\n")], None);
    kit.train.step(REPO).await;
    assert_eq!(kit.spawned(), 2);
    assert_eq!(*kit.host.cancels.lock().unwrap(), ["T50"]);
    let old = kit.host.task(&TaskId::unchecked("T50")).unwrap();
    assert_eq!(old.state, "cancelled");
    assert!(old.result_tail.unwrap().contains("Superseded"));

    kit.host.push_event(
        "review.verdict",
        json!({ "taskId": "T50", "prHeadSha": new_head, "blocking": 0, "nonBlocking": 0 }),
    );
    kit.host.push_event(
        "review.verdict",
        json!({ "taskId": "T51", "prHeadSha": new_head, "blocking": 1, "nonBlocking": 0 }),
    );
    let (to, text) = kit.host.nth_send(0).await;
    assert_eq!(to, writer.as_str());
    assert!(text.contains("T51"), "{text}");
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Reviewing);
    assert_eq!(kit.spawned(), 2);
}

/// A rebase that only drops commits already on the base keeps the approval: the PR's own commits are as reviewed
/// (`git range-diff` shows them unchanged), so it merges with no second review.
#[tokio::test(flavor = "multi_thread")]
async fn a_rebase_that_only_drops_commits_already_on_the_base_keeps_the_approval() {
    let kit = Kit::with_reviews();
    let (change, approved) = kit.approved_then_rebased_past_its_parent().await;
    let rebased = kit.push_author("slice-1");
    assert_eq!(
        git(
            &kit.gh.origin,
            &["rev-list", "--count", &format!("main..{rebased}")]
        ),
        "1",
        "the parent's commit is gone"
    );

    kit.train.step(REPO).await;
    let kept = kit.get(&change.change_id);
    assert_eq!(kept.state, ChangeState::Ready, "{:?}", kept.last_error);
    assert_eq!(kept.head_sha.as_str(), rebased);
    assert_ne!(
        kept.patch_id, change.patch_id,
        "the PR-level patch id did change"
    );
    let carried = kept.reviews.last().unwrap();
    assert_eq!(
        (carried.task_id.as_str(), carried.pr_head_sha.as_str()),
        ("T50", rebased.as_str())
    );
    assert_ne!(rebased, approved);
    assert!(kit.train.step(REPO).await);
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Merged);
    assert_eq!(kit.spawned(), 1, "no second review");
}

/// A new head that drops a commit the base lacks is reviewed again, though its own commits are as approved: approved
/// at base + A + B, then B alone is pushed onto a base without A.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_head_that_drops_a_commit_the_base_lacks_is_reviewed_again() {
    let kit = Kit::with_reviews();
    let (change, approved) = kit.approved_with_its_parent().await;
    git(&kit.author, &["fetch", "-q", "origin"]);
    git(
        &kit.author,
        &["checkout", "-q", "-B", "slice-1", "origin/main"],
    );
    git(&kit.author, &["cherry-pick", &approved]);
    let alone = kit.push_author("slice-1");
    assert!(kit.main_file("p.txt").is_none(), "the base lacks A");
    assert_eq!(
        git(
            &kit.gh.origin,
            &["rev-list", "--count", &format!("main..{alone}")]
        ),
        "1"
    );

    kit.train.step(REPO).await;
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Reviewing);
    assert_eq!(kit.spawned(), 2);
    kit.train.step(REPO).await;
    assert!(merged_prs(&kit).is_empty());
}

/// A rebase that changes the PR's own diff, as a conflict resolution can, is reviewed again, from the delta.
#[tokio::test(flavor = "multi_thread")]
async fn a_rebase_that_changes_the_prs_own_diff_is_reviewed_again() {
    let kit = Kit::with_reviews();
    let (change, approved) = kit.approved_then_rebased_past_its_parent().await;
    std::fs::write(kit.author.join("o.txt"), "own, resolved another way\n").unwrap();
    git(&kit.author, &["commit", "-q", "-a", "--amend", "--no-edit"]);
    let rebased = kit.push_author("slice-1");

    kit.train.step(REPO).await;
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Reviewing);
    assert_eq!(kit.spawned(), 2);
    let prompt = kit.host.review_spawns.lock().unwrap()[1].prompt.clone();
    assert!(
        prompt.contains(&format!("git range-diff {approved}...{rebased}")),
        "{prompt}"
    );
    kit.train.step(REPO).await;
    assert!(merged_prs(&kit).is_empty());
}

/// A Change ready with no clean review of its patch (as a hub from before every PR was reviewed could leave one) is
/// never taken: it goes back to review.
#[tokio::test(flavor = "multi_thread")]
async fn a_ready_change_without_a_review_goes_back_to_review() {
    let kit = Kit::new();
    *kit.gate.unreviewed.lock().unwrap() = true;
    let change = kit
        .enqueue(kit.open_pr(7, "a", &[add("a1.txt", "a\n")]))
        .await;
    assert_eq!(change.state, ChangeState::Ready);
    kit.gate.held.lock().unwrap().insert(7);

    kit.train.step(REPO).await;
    assert_eq!(kit.get(&change.change_id).state, ChangeState::Reviewing);
    assert_eq!(kit.gate.reviewed.lock().unwrap().len(), 2);
    kit.train.step(REPO).await;
    assert!(merged_prs(&kit).is_empty());
}

/// A writer's ready PR, from its branch or one named after it, is a ready slice found on the train's own pass (no
/// webhook, nothing from the writer): it goes to the review gate once per head. A draft waits, and so does a PR from a
/// branch that is no writer's.
#[tokio::test(flavor = "multi_thread")]
async fn a_writers_ready_pr_is_reviewed_on_the_trains_pass_once_per_head() {
    let kit = Kit::new();
    let writer = kit.running_task("T1", "write");
    kit.host
        .branches
        .lock()
        .unwrap()
        .insert("T1".into(), "fleetd/T1-slice".into());
    let own = kit.open_pr(7, "fleetd/T1-slice", &[add("a1.txt", "a\n")]);
    kit.gate.held.lock().unwrap().extend([7, 8, 9]);
    kit.open_pr(8, "fleetd/T1-slice-2", &[add("a2.txt", "b\n")]);
    kit.open_pr(9, "fleetd/T1-slicer", &[add("a3.txt", "c\n")]);
    // A second train change keeps the repo's train (and its pass) alive.
    let other = kit.open_pr(3, "other", &[add("o.txt", "o\n")]);
    kit.enqueue(other).await;
    kit.gh.pulls.lock().unwrap().get_mut(&8).unwrap().draft = true;
    let reviewed = |n: i64| {
        kit.gate
            .reviewed
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.pr_number.get() == n)
            .count()
    };

    kit.train.step(REPO).await;
    assert_eq!(
        (reviewed(7), reviewed(8), reviewed(9)),
        (1, 0, 0),
        "its branch at once; a draft waits; another branch is not its"
    );
    let change = kit
        .train
        .list(&ListFilter {
            limit: 10,
            ..Default::default()
        })
        .into_iter()
        .find(|c| c.pr_url.as_str() == own)
        .unwrap();
    assert_eq!(
        (change.state, change.task_id.as_ref()),
        (ChangeState::Reviewing, Some(&writer))
    );
    kit.gh.pulls.lock().unwrap().get_mut(&8).unwrap().draft = false;
    kit.train.step(REPO).await;
    assert_eq!(
        (reviewed(7), reviewed(8)),
        (1, 1),
        "marked ready: a slice; once per head"
    );
}

/// A kit whose ready sweep never comes due on its own, with writer T1 on `fleetd/T1` and a held PR keeping the repo's
/// train alive; its first pass has read the open PRs, before the writer opened any.
async fn swept_kit() -> Kit {
    let kit = Kit::with(FakeCi::Actions, |o| {
        o.ready_every = Duration::from_secs(3600)
    });
    kit.running_task("T1", "write");
    kit.host
        .branches
        .lock()
        .unwrap()
        .insert("T1".into(), "fleetd/T1".into());
    kit.enqueue_held(kit.open_pr(3, "other", &[add("o.txt", "o\n")]))
        .await;
    kit.train.step(REPO).await;
    kit
}

fn writers_changes(kit: &Kit) -> Vec<(i64, Option<String>)> {
    let mut out: Vec<_> = kit
        .train
        .list(&ListFilter {
            limit: 10,
            ..Default::default()
        })
        .into_iter()
        .filter(|c| c.pr_number.get() != 3)
        .map(|c| (c.pr_number.get(), c.task_id.map(|t| t.to_string())))
        .collect();
    out.sort();
    out
}

/// A writer's PR, once the hub sees it opened, is queued on the next pass, not at the next sweep.
#[tokio::test(flavor = "multi_thread")]
async fn a_writers_opened_pr_is_queued_on_the_next_pass_not_the_next_sweep() {
    let kit = swept_kit().await;
    kit.gate.held.lock().unwrap().insert(7);
    kit.open_pr(7, "fleetd/T1-one", &[add("a1.txt", "a\n")]);
    kit.train.step(REPO).await;
    assert_eq!(writers_changes(&kit), [], "the sweep is not due");

    kit.train.writer_opened_pr(&project());
    kit.train.step(REPO).await;
    assert_eq!(writers_changes(&kit), [(7, Some("T1".into()))]);
}

/// A writer that opened two PRs and ended, its result naming only the last: both are queued as its own.
#[tokio::test(flavor = "multi_thread")]
async fn every_pr_a_writer_opened_is_queued_when_it_ends() {
    let kit = swept_kit().await;
    kit.gate.held.lock().unwrap().extend([7, 8]);
    kit.open_pr(7, "fleetd/T1-one", &[add("a1.txt", "a\n")]);
    let last = kit.open_pr(8, "fleetd/T1-two", &[add("a2.txt", "b\n")]);
    {
        let mut tasks = kit.host.tasks.lock().unwrap();
        let writer = tasks.get_mut("T1").unwrap();
        writer.state = "done".into();
        writer.pr_url = Some(last);
    }
    let cursor = kit.host.events_head();
    kit.host
        .push_event("task.completed", json!({ "taskId": "T1" }));
    kit.host.next_event(cursor, "change.queued").await;
    kit.train.step(REPO).await;
    assert_eq!(
        writers_changes(&kit),
        [(7, Some("T1".into())), (8, Some("T1".into()))]
    );
}

/// The ready pass and a writer's result may enqueue one PR at once: one Change, one review round.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_enqueues_of_one_pr_make_one_change_and_one_review_round() {
    use super::calls::slice_ready;
    let kit = Kit::with_reviews();
    let writer = kit.running_task("T1", "write");
    let pr = kit.open_pr(7, "slice-1", &[add("a1.txt", "a\n")]);
    let call = || GitHubPrUrl::unchecked(pr.clone());
    let input = || ChangeEnqueueCall {
        task_id: Some(writer.clone()),
        ..enqueue_call(pr.clone())
    };
    let r = project();
    let (a, b, c, d) = tokio::join!(
        slice_ready(&kit.train, &r, &writer, call()),
        slice_ready(&kit.train, &r, &writer, call()),
        kit.train.enqueue(&r, input()),
        kit.train.enqueue(&r, input()),
    );
    let ids: std::collections::HashSet<String> = [
        a.unwrap().change_id,
        b.unwrap().change_id,
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
async fn a_stopped_order_takes_its_prs_off_the_train_and_leaves_them_open() {
    let kit = Kit::new();
    // Both wait for reviews, so both are leftovers when the order is stopped.
    let first = kit
        .enqueue_held(kit.open_pr(7, "left", &[add("l.txt", "l\n")]))
        .await;
    let second = kit
        .enqueue_held(kit.open_pr(8, "fix", &[add("f.txt", "f\n")]))
        .await;

    let taken = kit
        .train
        .take_leftovers(&project(), &ws(), "W1 was stopped");
    let mut numbers: Vec<_> = taken.iter().map(|c| c.pr_number.get()).collect();
    numbers.sort();
    assert_eq!(numbers, [7, 8]);
    for change in [&first, &second] {
        assert_eq!(kit.get(&change.change_id).state, ChangeState::Abandoned);
    }
    let log = kit.gh.log.lock().unwrap();
    assert!(!log.iter().any(|l| l.starts_with("close")), "{log:?}");
    let pulls = kit.gh.pulls.lock().unwrap();
    assert_eq!(
        (pulls[&7].state.as_str(), pulls[&8].state.as_str()),
        ("open", "open")
    );
}
