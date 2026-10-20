//! Runs one done-when check and says pass, fail or error (could not run), with evidence. `cmd` runs on the node,
//! `http` and the GitHub checks on the hub, `judge` through a review task, `human` from the decision the lead logged after
//! asking in chat.
use super::github::{GhError, GitHub};
use super::judges::{JudgeInput, Judges};
use super::ports::Ports;
use super::{units, utf16_prefix, utf16_suffix};
use crate::clock::Clock;
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::ledger::{CheckSpec, Workstream, WorkstreamId};
use fleetd_contracts::prim::{Count, Text};
use fleetd_contracts::verification::{CheckOutcome, CheckResult, CheckResultRanBy, ClaimId};
use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

pub const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// Recorded as the source of what the claims area writes.
pub const CLAIMS_BY: &str = "hub:claims";

/// The decision a `human` check reads: `done.<index>`, the check's place in the brief's doneWhen.
pub fn human_check_key(index: u32) -> String {
    format!("done.{index}")
}
const EVIDENCE_MAX: usize = 2000;

pub struct CheckContext<'a> {
    pub workstream: &'a Workstream,
    pub claim_id: &'a ClaimId,
}

/// What a check outside a claim runs against: the project, and the workstream whose PRs it may look at.
#[derive(Debug, Clone)]
pub struct CheckScope {
    pub project_ref: ProjectRef,
    pub workstream_id: Option<WorkstreamId>,
}

pub fn ran_by_of(spec: &CheckSpec) -> CheckResultRanBy {
    match spec {
        CheckSpec::Cmd { .. } => CheckResultRanBy::Node,
        CheckSpec::Judge { .. } => CheckResultRanBy::Judge,
        CheckSpec::Human { .. } => CheckResultRanBy::Human,
        _ => CheckResultRanBy::Hub,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub result: CheckOutcome,
    pub evidence: String,
    pub exit_code: Option<i64>,
}

fn verdict(result: CheckOutcome, evidence: impl Into<String>) -> Verdict {
    Verdict {
        result,
        evidence: evidence.into(),
        exit_code: None,
    }
}

/// A header line, then as much of the tail as fits.
fn with_tail(head: &str, tail: &str) -> String {
    let room = EVIDENCE_MAX as i64 - units(head) as i64 - 1;
    let t = tail.trim();
    if t.is_empty() || room <= 0 {
        return utf16_prefix(head, EVIDENCE_MAX).to_owned();
    }
    let room = room as usize;
    if units(t) <= room {
        format!("{head}\n{t}")
    } else {
        format!("{head}\n…{}", utf16_suffix(t, room - 1))
    }
}

fn short(sha: &str) -> &str {
    utf16_prefix(sha, 12)
}

static PULL_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)github\.com/([^/\s]+/[^/\s]+)/pull/(\d+)").expect("pull regex")
});

// The slices of GitHub's REST answers the checks read.
#[derive(Deserialize)]
struct Pull {
    merged: bool,
    state: String,
    merge_commit_sha: Option<String>,
    merged_at: Option<String>,
    #[serde(default)]
    head: Option<PullHead>,
}
#[derive(Deserialize)]
struct PullHead {
    sha: String,
}
#[derive(Deserialize)]
struct RepoInfo {
    default_branch: String,
}
#[derive(Deserialize, Clone)]
struct CheckRun {
    id: f64,
    name: String,
    status: String,
    conclusion: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
}
#[derive(Deserialize)]
struct CheckRuns {
    check_runs: Vec<CheckRun>,
}

fn is_green(run: &CheckRun) -> bool {
    run.status == "completed"
        && matches!(
            run.conclusion.as_deref(),
            Some("success" | "neutral" | "skipped")
        )
}

fn run_state(run: &CheckRun) -> String {
    if run.status == "completed" {
        run.conclusion.clone().unwrap_or_else(|| "completed".into())
    } else {
        run.status.clone()
    }
}

/// The newest run of each name; re-runs replace earlier attempts.
fn latest_by_name(runs: Vec<CheckRun>) -> Vec<CheckRun> {
    let mut latest: HashMap<String, CheckRun> = HashMap::new();
    for run in runs {
        if latest.get(&run.name).is_none_or(|l| l.id < run.id) {
            latest.insert(run.name.clone(), run);
        }
    }
    let mut out: Vec<CheckRun> = latest.into_values().collect();
    // Approximates JS localeCompare: case-insensitive first.
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

/// `encodeURIComponent`.
fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A PR the merge train landed as part of a batch.
#[derive(Debug, PartialEq)]
struct BatchLanding {
    batch: i64,
    sha: String,
    merged_at: Option<String>,
}

static LANDED_IN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Landed in #(\d+)").expect("landed regex"));

/// The batch a closed PR landed in, verified on GitHub as equivalent to merging it: the train's closing comment names
/// the batch, that PR is merged with `fleetd/train=success` (which only the train posts) on its head, and its
/// `fleetd-batch:` line recorded this PR at `member_head`, the head it has now. A push after batching, or a batch
/// that recorded no head, is not landed.
async fn landed_in_batch(
    github: &GitHub,
    repo: &str,
    pr: i64,
    member_head: &str,
) -> Result<Option<BatchLanding>, GhError> {
    #[derive(Deserialize)]
    struct Comment {
        body: Option<String>,
    }
    #[derive(Deserialize)]
    struct Head {
        sha: String,
    }
    #[derive(Deserialize)]
    struct BatchPull {
        merged: bool,
        merge_commit_sha: Option<String>,
        merged_at: Option<String>,
        body: Option<String>,
        head: Head,
    }
    fn parse<T: for<'de> Deserialize<'de>>(
        path: &str,
        json: serde_json::Value,
    ) -> Result<T, GhError> {
        serde_json::from_value(json).map_err(|_| GhError {
            kind: super::github::GhErrorKind::Failed,
            message: format!("gh api {path} returned an unexpected shape"),
        })
    }
    let path = format!("repos/{repo}/issues/{pr}/comments?per_page=100");
    let comments: Vec<Comment> = parse(&path, github.api(&path).await?)?;
    let batches: Vec<i64> = comments
        .iter()
        .filter_map(|c| LANDED_IN.captures(c.body.as_deref()?)?[1].parse().ok())
        .collect();
    for batch in batches {
        let path = format!("repos/{repo}/pulls/{batch}");
        let pull: BatchPull = parse(&path, github.api(&path).await?)?;
        let member_head = member_head.to_lowercase();
        let lists_it =
            crate::hub::train::github::batch_heads(pull.body.as_deref().unwrap_or_default())
                .into_iter()
                .any(|(n, built)| n == pr && built.as_deref() == Some(member_head.as_str()));
        let (true, true, Some(sha)) = (pull.merged, lists_it, pull.merge_commit_sha) else {
            continue;
        };
        let path = format!("repos/{repo}/commits/{}/status?per_page=100", pull.head.sha);
        let status = github.api(&path).await?;
        let by_train = status["statuses"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|s| {
                s["context"] == crate::hub::train::github::TRAIN_CONTEXT && s["state"] == "success"
            });
        if by_train {
            return Ok(Some(BatchLanding {
                batch,
                sha,
                merged_at: pull.merged_at,
            }));
        }
    }
    Ok(None)
}

pub struct CheckRunner {
    github: Arc<GitHub>,
    judges: Arc<Judges>,
    ports: Arc<dyn Ports>,
    clock: Arc<dyn Clock>,
    http: reqwest::Client,
    time: std::sync::OnceLock<crate::hub::time::TimeSink>,
}

impl CheckRunner {
    pub fn new(
        github: Arc<GitHub>,
        judges: Arc<Judges>,
        ports: Arc<dyn Ports>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            github,
            judges,
            ports,
            clock,
            http: reqwest::Client::new(),
            time: std::sync::OnceLock::new(),
        }
    }

    pub fn set_time(&self, sink: crate::hub::time::TimeSink) {
        let _ = self.time.set(sink);
    }

    async fn api<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, GhError> {
        let json = self.github.api(path).await?;
        serde_json::from_value(json).map_err(|_| GhError {
            kind: super::github::GhErrorKind::Failed,
            message: format!("gh api {path} returned an unexpected shape"),
        })
    }

    async fn cmd(
        &self,
        scope: &CheckScope,
        machine_id: &MachineId,
        argv: &[String],
        expect_exit: i64,
    ) -> Verdict {
        let home = &scope.project_ref.machine_id;
        if machine_id != home {
            return verdict(
                CheckOutcome::Error,
                format!(
                    "cmd checks run in the project's workspace, which is on {home}; this check names {machine_id}"
                ),
            );
        }
        let Some(root) = self.ports.workspace_root(&scope.project_ref) else {
            return verdict(
                CheckOutcome::Error,
                format!(
                    "the hub has no record of project {} on {home}",
                    scope.project_ref.project_id
                ),
            );
        };
        let shown = format!("`{}`", argv.join(" "));
        let started = crate::hub::store::now_ms(self.clock.as_ref());
        let ran = self
            .ports
            .run_command(machine_id, root.clone(), argv.to_vec())
            .await;
        if let Some(time) = self.time.get() {
            let exit = ran.as_ref().ok().and_then(|o| o.exit_code);
            let end = crate::hub::store::now_ms(self.clock.as_ref());
            time.span(crate::hub::time::NewSpan {
                src_key: format!("claim/{}/{started}/{}", machine_id, rand::random::<u32>()),
                kind: fleetd_contracts::time::SpanKind::CheckClaim,
                start_ms: started,
                end_ms: Some(end.max(started)),
                ids: crate::hub::time::Ids {
                    machine_id: Some(machine_id.to_string()),
                    project_id: Some(scope.project_ref.project_id.to_string()),
                    workstream_id: scope.workstream_id.as_ref().map(|w| w.to_string()),
                    ..Default::default()
                },
                lane: match &scope.workstream_id {
                    Some(w) => format!("checks:{w}"),
                    None => format!("checks:{}/{}", machine_id, scope.project_ref.project_id),
                },
                label: Some(argv.join(" ")),
                exit_code: exit,
                status: if exit == Some(expect_exit) {
                    fleetd_contracts::time::SpanStatus::Ok
                } else {
                    fleetd_contracts::time::SpanStatus::Failed
                },
                ..Default::default()
            });
        }
        let out = match ran {
            Ok(out) => out,
            Err(message) => {
                return verdict(
                    CheckOutcome::Error,
                    format!("{shown} did not run on {machine_id}: {message}"),
                );
            }
        };
        let tail = out.output_tail.as_str();
        if out.timed_out {
            return verdict(
                CheckOutcome::Fail,
                with_tail(&format!("{shown} timed out and was killed"), tail),
            );
        }
        let Some(code) = out.exit_code else {
            return verdict(
                CheckOutcome::Error,
                with_tail(&format!("{shown} did not exit on its own"), tail),
            );
        };
        let head = format!("{shown} in {root} exited {code} (expected {expect_exit})");
        Verdict {
            result: if code == expect_exit {
                CheckOutcome::Pass
            } else {
                CheckOutcome::Fail
            },
            evidence: with_tail(&head, tail),
            exit_code: Some(code),
        }
    }

    async fn http(&self, url: &str, status: i64, contains: Option<&str>) -> Verdict {
        let fetched = async {
            let response = self.http.get(url).timeout(HTTP_TIMEOUT).send().await?;
            let code = response.status().as_u16();
            let body = response.text().await?;
            Ok::<_, reqwest::Error>((code, utf16_prefix(&body, 100_000).to_owned()))
        }
        .await;
        let (code, body) = match fetched {
            Ok(got) => got,
            Err(e) => {
                let why = if e.is_timeout() {
                    "no answer within 10 s".to_owned()
                } else {
                    describe_fetch_error(&e)
                };
                // The probe ran and the target did not answer: that is the check failing, not fleetd.
                return verdict(CheckOutcome::Fail, format!("GET {url} failed: {why}"));
            }
        };
        let status_ok = i64::from(code) == status;
        let contains_ok = contains.is_none_or(|c| body.contains(c));
        let mut head = vec![format!("GET {url} → HTTP {code} (expected {status})")];
        if let Some(c) = contains {
            head.push(if contains_ok {
                format!("body contains \"{c}\"")
            } else {
                format!("body does not contain \"{c}\"")
            });
        }
        let head = head.join("; ");
        if status_ok && contains_ok {
            verdict(CheckOutcome::Pass, head)
        } else {
            verdict(
                CheckOutcome::Fail,
                with_tail(&head, utf16_prefix(&body, 500)),
            )
        }
    }

    /// PR numbers in `repo` that the workstream's tasks opened, newest first.
    fn workstream_prs(&self, scope: &CheckScope, repo: &str) -> Vec<i64> {
        let Some(w) = &scope.workstream_id else {
            return vec![];
        };
        let mut numbers = Vec::new();
        for t in self.ports.tasks_of(&scope.project_ref, w, 50) {
            let url = t
                .result
                .as_ref()
                .and_then(|r| r.pr_url.as_ref())
                .map(|u| u.as_str().to_owned())
                .unwrap_or_default();
            if let Some(m) = PULL_URL.captures(&url)
                && m[1].eq_ignore_ascii_case(repo)
                && let Ok(n) = m[2].parse::<i64>()
                && !numbers.contains(&n)
            {
                numbers.push(n);
            }
        }
        numbers
    }

    /// The commit CI is judged on: the merge commit of the workstream's newest merged PR, else the default branch's head.
    async fn target_ref(
        &self,
        scope: &CheckScope,
        repo: &str,
    ) -> Result<(String, String), GhError> {
        if let Some(newest) = self.workstream_prs(scope, repo).first() {
            let pull: Pull = self.api(&format!("repos/{repo}/pulls/{newest}")).await?;
            if pull.merged
                && let Some(sha) = pull.merge_commit_sha
            {
                let label = format!("merge commit {} of #{newest}", short(&sha));
                return Ok((sha, label));
            }
        }
        let info: RepoInfo = self.api(&format!("repos/{repo}")).await?;
        let label = format!("the head of {}", info.default_branch);
        Ok((info.default_branch, label))
    }

    async fn check_runs(
        &self,
        repo: &str,
        r#ref: &str,
        name: Option<&str>,
    ) -> Result<Vec<CheckRun>, GhError> {
        let filter = name
            .map(|n| format!("&check_name={}", encode_uri_component(n)))
            .unwrap_or_default();
        let runs: CheckRuns = self
            .api(&format!(
                "repos/{repo}/commits/{}/check-runs?per_page=100{filter}",
                encode_uri_component(r#ref)
            ))
            .await?;
        Ok(latest_by_name(runs.check_runs))
    }

    async fn pr_merged(&self, scope: &CheckScope, repo: &str, pr: Option<i64>) -> Verdict {
        let Some(pr) = pr.or_else(|| self.workstream_prs(scope, repo).first().copied()) else {
            let of = scope
                .workstream_id
                .as_ref()
                .map(|w| w.to_string())
                .unwrap_or_else(|| "the workstream".into());
            return verdict(
                CheckOutcome::Error,
                format!(
                    "no PR to check: the check names none and no task of {of} opened a PR in {repo}"
                ),
            );
        };
        match self.api::<Pull>(&format!("repos/{repo}/pulls/{pr}")).await {
            Err(e) => verdict(CheckOutcome::Error, e.message),
            Ok(pull) if pull.merged => {
                let at = pull
                    .merged_at
                    .map(|a| format!(" at {a}"))
                    .unwrap_or_default();
                let sha = pull
                    .merge_commit_sha
                    .map(|s| format!(" as {}", short(&s)))
                    .unwrap_or_default();
                verdict(CheckOutcome::Pass, format!("{repo}#{pr} merged{at}{sha}"))
            }
            Ok(Pull {
                state,
                head: Some(head),
                ..
            }) if state == "closed" => {
                match landed_in_batch(&self.github, repo, pr, &head.sha).await {
                    Ok(Some(landed)) => verdict(
                        CheckOutcome::Pass,
                        format!(
                            "{repo}#{pr} landed in the train's batch #{}, merged{} as {}",
                            landed.batch,
                            landed
                                .merged_at
                                .map(|a| format!(" at {a}"))
                                .unwrap_or_default(),
                            short(&landed.sha)
                        ),
                    ),
                    Ok(None) => verdict(
                        CheckOutcome::Fail,
                        format!("{repo}#{pr} is closed, not merged"),
                    ),
                    Err(e) => verdict(CheckOutcome::Error, e.message),
                }
            }
            Ok(pull) => verdict(
                CheckOutcome::Fail,
                format!("{repo}#{pr} is {}, not merged", pull.state),
            ),
        }
    }

    async fn ci_green(&self, scope: &CheckScope, repo: &str, r#ref: Option<&str>) -> Verdict {
        let result = async {
            let (target, label) = match r#ref {
                Some(r) => (r.to_owned(), r.to_owned()),
                None => self.target_ref(scope, repo).await?,
            };
            let runs = self.check_runs(repo, &target, None).await?;
            if runs.is_empty() {
                return Ok(verdict(
                    CheckOutcome::Fail,
                    format!("no check runs on {label} in {repo}"),
                ));
            }
            let red: Vec<&CheckRun> = runs.iter().filter(|r| !is_green(r)).collect();
            if red.is_empty() {
                let s = if runs.len() == 1 { "" } else { "s" };
                return Ok(verdict(
                    CheckOutcome::Pass,
                    format!(
                        "{} check run{s} on {label} in {repo}, all green",
                        runs.len()
                    ),
                ));
            }
            let names: Vec<String> = red
                .iter()
                .map(|r| format!("{}: {}", r.name, run_state(r)))
                .collect();
            let text = format!(
                "{} of {} check runs on {label} in {repo} are not green: {}",
                red.len(),
                runs.len(),
                names.join(", ")
            );
            Ok(verdict(
                CheckOutcome::Fail,
                utf16_prefix(&text, EVIDENCE_MAX),
            ))
        }
        .await;
        result.unwrap_or_else(|e: GhError| verdict(CheckOutcome::Error, e.message))
    }

    async fn test(&self, scope: &CheckScope, repo: &str, test_id: &str) -> Verdict {
        let result = async {
            let (target, label) = self.target_ref(scope, repo).await?;
            let runs = self.check_runs(repo, &target, Some(test_id)).await?;
            let Some(run) = runs.first() else {
                return Ok(verdict(
                    CheckOutcome::Fail,
                    format!("no check run named \"{test_id}\" on {label} in {repo}"),
                ));
            };
            let place = run
                .html_url
                .as_deref()
                .filter(|u| !u.is_empty())
                .map(|u| format!(" ({u})"))
                .unwrap_or_default();
            let text = format!("\"{test_id}\" on {label}: {}{place}", run_state(run));
            Ok(verdict(
                if is_green(run) {
                    CheckOutcome::Pass
                } else {
                    CheckOutcome::Fail
                },
                utf16_prefix(&text, EVIDENCE_MAX),
            ))
        }
        .await;
        result.unwrap_or_else(|e: GhError| verdict(CheckOutcome::Error, e.message))
    }

    /// A `human` check: the lead asks the question in chat and logs the person's answer as the decision
    /// `done.<index>` on the workstream. Only an answer given for the brief as it stands counts: one logged before its
    /// latest freeze or amend may be about another check under the same index.
    fn human(&self, ctx: &CheckContext<'_>, index: u32, question: &str) -> Verdict {
        let w = ctx.workstream;
        let key = human_check_key(index);
        let ask_again = format!(
            "ask the human in chat: \"{question}\", then log their answer with decide {{key: \"{key}\", value: \"yes\" or \"no\", workstreamId: \"{}\"}}",
            w.workstream_id
        );
        let frozen = self.ports.brief_frozen_ms(&w.workstream_id);
        let Some(answer) = self.ports.human_confirmation(&w.workstream_id, &key) else {
            return verdict(
                CheckOutcome::Fail,
                utf16_prefix(&format!("not confirmed yet: {ask_again}"), EVIDENCE_MAX),
            );
        };
        if frozen.is_some_and(|at| answer.at_ms < at) {
            return verdict(
                CheckOutcome::Fail,
                utf16_prefix(
                    &format!("the answer in {} predates the brief's latest version: {ask_again}", answer.decision_id),
                    EVIDENCE_MAX,
                ),
            );
        }
        let value = answer.value.trim().to_lowercase();
        if matches!(value.as_str(), "yes" | "done" | "pass") {
            verdict(
                CheckOutcome::Pass,
                format!("the human said yes in chat ({})", answer.decision_id),
            )
        } else {
            verdict(
                CheckOutcome::Fail,
                utf16_prefix(
                    &format!("the human said \"{}\" in chat ({})", answer.value, answer.decision_id),
                    EVIDENCE_MAX,
                ),
            )
        }
    }

    /// A check fleetd runs itself: everything but `judge` and `human`.
    async fn own(&self, scope: &CheckScope, spec: &CheckSpec) -> Option<Verdict> {
        Some(match spec {
            CheckSpec::Cmd {
                machine_id,
                argv,
                expect_exit,
            } => self.cmd(scope, machine_id, argv, *expect_exit).await,
            CheckSpec::Http {
                url,
                status,
                contains,
            } => self.http(url, status.get(), contains.as_deref()).await,
            CheckSpec::PrMerged { repo, pr } => {
                self.pr_merged(scope, repo, pr.map(|p| p.get())).await
            }
            CheckSpec::CiGreen { repo, r#ref } => {
                self.ci_green(scope, repo, r#ref.as_deref()).await
            }
            CheckSpec::Test { repo, test_id } => self.test(scope, repo, test_id).await,
            CheckSpec::Judge { .. } | CheckSpec::Human { .. } => return None,
        })
    }

    pub async fn run(
        &self,
        ctx: &CheckContext<'_>,
        check_index: u32,
        spec: &CheckSpec,
    ) -> CheckResult {
        let w = ctx.workstream;
        let scope = CheckScope {
            project_ref: w.project_ref.clone(),
            workstream_id: Some(w.workstream_id.clone()),
        };
        let outcome = match spec {
            CheckSpec::Judge { criteria } => {
                let judged = self
                    .judges
                    .judge(JudgeInput {
                        workstream: w,
                        claim_id: ctx.claim_id,
                        check_index,
                        criteria,
                    })
                    .await;
                Verdict {
                    result: judged.result,
                    evidence: judged.evidence,
                    exit_code: None,
                }
            }
            CheckSpec::Human { question } => self.human(ctx, check_index, question),
            _ => self.own(&scope, spec).await.expect("own check"),
        };
        CheckResult {
            check_index: Count::unchecked(i64::from(check_index)),
            spec: spec.clone(),
            result: outcome.result,
            evidence: Text::unchecked(utf16_prefix(&outcome.evidence, EVIDENCE_MAX)),
            exit_code: outcome.exit_code,
            ran_by: ran_by_of(spec),
            at: super::now_ts(self.clock.as_ref()),
        }
    }
}

/// The useful part of a transport error: its innermost cause.
fn describe_fetch_error(e: &reqwest::Error) -> String {
    let mut source: &dyn std::error::Error = e;
    while let Some(next) = source.source() {
        source = next;
    }
    utf16_prefix(&source.to_string(), 300).to_owned()
}

#[cfg(test)]
mod batch_tests {
    use super::super::github::{GhOutput, GhRunner, GhSpawnError};
    use super::super::ports::BoxFuture;
    use super::*;

    /// Answers `gh api <path>` from a map of path to JSON; anything else is a 404.
    struct Paths(HashMap<String, serde_json::Value>);

    impl GhRunner for Paths {
        fn run(&self, args: Vec<String>) -> BoxFuture<'_, Result<GhOutput, GhSpawnError>> {
            let path = args.last().cloned().unwrap_or_default();
            let out = match self.0.get(&path) {
                Some(v) => GhOutput {
                    exit_code: 0,
                    stdout: v.to_string(),
                    stderr: String::new(),
                },
                None => GhOutput {
                    exit_code: 1,
                    stdout: String::new(),
                    stderr: "gh: Not Found (HTTP 404)".into(),
                },
            };
            Box::pin(async move { Ok(out) })
        }
    }

    fn github(train_status: &str, body: &str) -> GitHub {
        let repo = "acme/storefront";
        let paths = HashMap::from([
            (
                format!("repos/{repo}/issues/8/comments?per_page=100"),
                serde_json::json!([{ "body": "Landed in #20 (abc) by the fleetd merge train" }]),
            ),
            (
                format!("repos/{repo}/pulls/20"),
                serde_json::json!({ "merged": true, "merge_commit_sha": "f00d", "merged_at": "2026-10-19T12:00:00Z", "body": body, "head": { "sha": "beef" } }),
            ),
            (
                format!("repos/{repo}/commits/beef/status?per_page=100"),
                serde_json::json!({ "statuses": [{ "context": "fleetd/train", "state": train_status }] }),
            ),
        ]);
        GitHub::new(Arc::new(Paths(paths)))
    }

    /// Whether PR 8, now at `member_head`, landed in batch #20 whose body is `body` and whose head has the train's
    /// status `train_status`.
    async fn landed(train_status: &str, body: &str, member_head: &str) -> Option<BatchLanding> {
        landed_in_batch(
            &github(train_status, body),
            "acme/storefront",
            8,
            member_head,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn a_closed_pr_counts_as_merged_only_when_the_trains_batch_landed_it_at_its_current_head()
    {
        assert_eq!(
            landed("success", "fleetd-batch: #7@aaa #8@CAFE", "cafe").await,
            Some(BatchLanding {
                batch: 20,
                sha: "f00d".into(),
                merged_at: Some("2026-10-19T12:00:00Z".into())
            })
        );
        // Pushed to after the batch was built: what landed is not its head.
        assert_eq!(
            landed("success", "fleetd-batch: #7@aaa #8@cafe", "d00d").await,
            None
        );
        // A batch that recorded no head for it proves nothing about its head.
        assert_eq!(
            landed("success", "fleetd-batch: #7@aaa #8", "cafe").await,
            None
        );
        // Not in the batch.
        assert_eq!(
            landed("success", "fleetd-batch: #7@aaa", "cafe").await,
            None
        );
        // Merged without the train's status: a bypass, not the train's merge.
        assert_eq!(
            landed("pending", "fleetd-batch: #7@aaa #8@cafe", "cafe").await,
            None
        );
    }
}
