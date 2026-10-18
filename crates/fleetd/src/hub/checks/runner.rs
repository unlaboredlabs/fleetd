//! Runs one done-when check and says pass, fail or error (could not run), with evidence. `cmd` runs on the node,
//! `http` and the GitHub checks on the hub, `judge` through a review task, `human` through a do-ask.
use super::github::{GhError, GitHub};
use super::judges::{JudgeInput, Judges};
use super::ports::{HumanAsk, Ports};
use super::{units, utf16_prefix, utf16_suffix};
use crate::clock::Clock;
use crate::hub::store::{EventLog, WaitInput};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef};
use fleetd_contracts::ledger::{AskId, CheckSpec, Workstream, WorkstreamId};
use fleetd_contracts::prim::{Count, Text};
use fleetd_contracts::verification::{CheckOutcome, CheckResult, CheckResultRanBy, ClaimId};
use regex::Regex;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

pub const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// Recorded as the filer of `human` check asks.
pub const CLAIMS_BY: &str = "hub:claims";
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

pub struct CheckRunner {
    github: Arc<GitHub>,
    judges: Arc<Judges>,
    ports: Arc<dyn Ports>,
    events: Arc<EventLog>,
    clock: Arc<dyn Clock>,
    http: reqwest::Client,
}

impl CheckRunner {
    pub fn new(
        github: Arc<GitHub>,
        judges: Arc<Judges>,
        ports: Arc<dyn Ports>,
        events: Arc<EventLog>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            github,
            judges,
            ports,
            events,
            clock,
            http: reqwest::Client::new(),
        }
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
        let out = match self
            .ports
            .run_command(machine_id, root.clone(), argv.to_vec())
            .await
        {
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
                .unwrap_or_else(|| "this ask's workstream".into());
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

    /// Waits for the human's answer to `ask_id`, read off the decision its answer records.
    async fn answer_to(&self, cursor: i64, ask_id: &AskId) -> String {
        let mut after = cursor;
        loop {
            let input = WaitInput {
                cursor: Some(after),
                types: Some(vec![HubEventType::DecisionRecorded]),
                machine_id: None,
                timeout_sec: 3600,
            };
            let Ok(page) = self.events.wait(input).await else {
                continue;
            };
            after = page.cursor;
            let answered = page.events.iter().any(|e| {
                e.data
                    .as_ref()
                    .and_then(|d| d.get("askId"))
                    .and_then(|v| v.as_str())
                    == Some(ask_id.as_str())
            });
            if answered && let Some(value) = self.ports.ask_answer(ask_id) {
                return value;
            }
        }
    }

    async fn human(&self, ctx: &CheckContext<'_>, index: u32, question: &str) -> Verdict {
        let w = ctx.workstream;
        // One ask per claim, so an earlier answer never stands in for a fresh look.
        let key = format!(
            "{}.{}.done-{index}",
            w.workstream_id.as_str().to_lowercase(),
            ctx.claim_id.as_str().to_lowercase()
        );
        let cursor = self.events.head();
        let ask = HumanAsk {
            project_ref: w.project_ref.clone(),
            workstream_id: w.workstream_id.clone(),
            key,
            text: utf16_prefix(
                &format!(
                    "Check done:{index} of {} ({}): {question}",
                    w.workstream_id, w.title
                ),
                500,
            )
            .to_owned(),
            step_text: question.to_owned(),
            step_expect: "reply \"done\" when it holds; anything else fails the check".into(),
            blocks: format!("{} being marked done", w.workstream_id),
        };
        let filed = match self.ports.file_human_ask(ask).await {
            Ok(filed) => filed,
            Err(e) => {
                return verdict(
                    CheckOutcome::Error,
                    format!("could not ask the human: {}", e.message),
                );
            }
        };
        let value = match filed.auto_value {
            Some(v) => v,
            None => self.answer_to(cursor, &filed.ask_id).await,
        };
        if value.trim().to_lowercase() == "done" {
            verdict(
                CheckOutcome::Pass,
                format!("the human answered done to {}", filed.ask_id),
            )
        } else {
            verdict(
                CheckOutcome::Fail,
                utf16_prefix(
                    &format!("the human answered \"{value}\" to {}", filed.ask_id),
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
            CheckSpec::Human { question } => self.human(ctx, check_index, question).await,
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

    /// A do ask's `verify` check, once the human ticked it done. `judge` and `human` specs are refused with `error`.
    pub async fn verify(&self, scope: &CheckScope, spec: &CheckSpec) -> (CheckOutcome, String) {
        match self.own(scope, spec).await {
            Some(v) => (v.result, utf16_prefix(&v.evidence, EVIDENCE_MAX).to_owned()),
            None => (
                CheckOutcome::Error,
                "a verify check is one fleetd runs itself, not a judge or a human".into(),
            ),
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
