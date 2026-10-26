//! The PR views: GitHub's answers joined with the merge queue and the agents, rolled up checks and reviews, a patch as
//! numbered lines, and GitHub read once per burst, with a failed read remembered rather than retried.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::prs::{
    ChecksState, DiffLineKind, PrFileStatus, PrState, ReviewState, ReviewVerdictKind,
};
use fleetd_contracts::tasks::Task;
use fleetd_contracts::train::{Change, ChangeState, GitHubRepo};
use serde_json::{Value, json};

use super::github::{GhCheck, GhPull, GhReview, PrsGitHub};
use super::join::{self, RowCtx};
use super::tools::list_page;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::train::github::{GhOut, GhRunner};
use crate::hub::train::host::BoxFut;
use fleetd_contracts::prs::PR_LIST_MAX;

const AT: &str = "2026-10-22T10:00:00.000Z";
const SHA: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn repo() -> GitHubRepo {
    GitHubRepo::new("acme/web").unwrap()
}

fn task(id: &str, branch: &str) -> Task {
    serde_json::from_value(json!({
        "taskId": id, "projectRef": { "machineId": "devbox", "projectId": "web" }, "workstreamId": "W3",
        "title": "Add the pricing page", "kind": "write", "prompt": "do it",
        "model": "claude-opus-5-5", "effort": "high", "state": "done", "attempt": 1, "createdAt": AT,
        "branch": branch, "threadRef": { "machineId": "devbox", "threadId": format!("s-{id}") },
    }))
    .unwrap()
}

fn change(n: i64, number: i64, state: &str, reviews: Value) -> Change {
    serde_json::from_value(json!({
        "changeId": format!("X{n}"), "projectRef": { "machineId": "devbox", "projectId": "web" },
        "repo": "acme/web", "prNumber": number, "prUrl": format!("https://github.com/acme/web/pull/{number}"),
        "branch": "fleetd/T4-pricing", "taskId": "T4", "workstreamId": "W3", "serves": "done:0",
        "headSha": SHA, "patchId": "c".repeat(40), "state": state, "reviews": reviews, "position": 0,
        "lastError": "conflict in src/app.ts; token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "createdAt": AT, "updatedAt": AT,
    }))
    .unwrap()
}

fn review(task: &str, patch: &str, blocking: i64) -> Value {
    json!({ "taskId": task, "prHeadSha": SHA, "patchId": patch, "blocking": blocking, "nonBlocking": 1 })
}

fn pull(number: i64, state: &str, extra: Value) -> GhPull {
    let mut p = json!({
        "number": number, "title": format!("PR {number}"), "state": state, "isDraft": false,
        "author": { "login": "octo" }, "headRefName": format!("feature-{number}"), "headRefOid": SHA,
        "createdAt": "2026-10-20T09:00:00Z", "updatedAt": "2026-10-21T09:00:00Z",
        "reviewDecision": "", "statusCheckRollup": [],
    });
    if let (Value::Object(p), Value::Object(extra)) = (&mut p, extra) {
        p.extend(extra);
    }
    serde_json::from_value(p).unwrap()
}

fn checks(v: Value) -> Vec<GhCheck> {
    serde_json::from_value(v).unwrap()
}

#[test]
fn checks_roll_up_failing_over_pending_over_passing_without_fleetds_own() {
    let rollup = checks(json!([
        { "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS" },
        { "__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SKIPPED" },
        { "__typename": "CheckRun", "name": "build", "status": "IN_PROGRESS" },
        { "__typename": "StatusContext", "context": "fleetd/train", "state": "PENDING" },
        { "__typename": "StatusContext", "context": "deploy/preview", "state": "SUCCESS" },
    ]));
    let summary = join::checks_summary(&rollup);
    assert_eq!(summary.state, ChecksState::Pending);
    assert_eq!(
        (
            summary.passed.get(),
            summary.pending.get(),
            summary.failed.get()
        ),
        (3, 1, 0)
    );
    let mut failing = rollup.clone();
    failing.extend(checks(
        json!([{ "__typename": "CheckRun", "name": "e2e", "status": "COMPLETED", "conclusion": "TIMED_OUT" }]),
    ));
    assert_eq!(join::checks_summary(&failing).state, ChecksState::Failing);
    assert_eq!(join::checks_summary(&[]).state, ChecksState::None);
    let shown: Vec<String> = rollup
        .iter()
        .filter_map(join::check)
        .map(|c| c.name.to_string())
        .collect();
    assert_eq!(shown, ["test", "lint", "build", "deploy/preview"]);
}

#[test]
fn reviews_count_only_verdicts_on_the_current_change() {
    let patch = "c".repeat(40);
    let clean = change(
        1,
        7,
        "reviewing",
        json!([review("T5", &patch, 0), review("T6", &"d".repeat(40), 0)]),
    );
    let s = join::review_summary(Some(&clean), 2, None);
    assert_eq!(
        (s.state, s.done.get(), s.needed.get()),
        (ReviewState::Pending, 1, 2)
    );
    let both = change(
        1,
        7,
        "ready",
        json!([review("T5", &patch, 0), review("T6", &patch, 0)]),
    );
    assert_eq!(
        join::review_summary(Some(&both), 2, None).state,
        ReviewState::Approved
    );
    let blocked = change(
        1,
        7,
        "reviewing",
        json!([review("T5", &patch, 0), review("T7", &patch, 2)]),
    );
    assert_eq!(
        join::review_summary(Some(&blocked), 2, None).state,
        ReviewState::ChangesRequested
    );
    assert_eq!(
        join::review_summary(None, 0, Some("APPROVED")).state,
        ReviewState::Approved,
        "a PR fleetd doesn't land takes GitHub's decision"
    );
    assert_eq!(
        join::review_summary(None, 0, Some("")).state,
        ReviewState::None
    );
}

#[test]
fn the_list_joins_github_with_the_queue_and_names_the_writing_agent() {
    let tasks = vec![task("T4", "fleetd/T4-pricing"), task("T8", "feature-9")];
    let mut ctx = RowCtx::with_tasks(&tasks);
    ctx.queues.insert("acme/web".into(), 3);
    let pulls = vec![
        (
            repo(),
            pull(
                7,
                "OPEN",
                json!({ "headRefName": "fleetd/T4-pricing", "updatedAt": "2026-10-22T08:00:00Z" }),
            ),
        ),
        (
            repo(),
            pull(
                9,
                "OPEN",
                json!({ "isDraft": true, "reviewDecision": "REVIEW_REQUIRED" }),
            ),
        ),
        (
            repo(),
            pull(11, "OPEN", json!({ "updatedAt": "2026-10-22T09:00:00Z" })),
        ),
        (
            repo(),
            pull(
                3,
                "MERGED",
                json!({ "mergedAt": "2026-10-21T12:00:00Z", "updatedAt": "2026-10-21T12:00:00Z" }),
            ),
        ),
        (
            repo(),
            pull(
                2,
                "CLOSED",
                json!({ "closedAt": "2026-09-01T12:00:00Z", "updatedAt": "2026-09-01T12:00:00Z" }),
            ),
        ),
    ];
    let changes = vec![
        change(1, 7, "needs_rebase", json!([])),
        change(2, 5, "queued", json!([])),
    ];
    let (rows, truncated) = join::rows(&pulls, &changes, "2026-10-15T00:00:00.000Z", &ctx, 60);
    assert!(!truncated);
    let order: Vec<i64> = rows.iter().map(|r| r.number.get()).collect();
    assert_eq!(
        order,
        [5, 11, 7, 9, 3],
        "open first by last update, PR 2 closed before the window"
    );

    let seven = &rows[2];
    assert_eq!(seven.state, PrState::Open);
    assert_eq!(
        seven.author.task_id.as_ref().map(|t| t.as_str()),
        Some("T4")
    );
    assert_eq!(seven.author.login.as_deref(), Some("octo"));
    let queue = seven.queue.as_ref().unwrap();
    assert_eq!(
        (queue.state, queue.length.get()),
        (ChangeState::NeedsRebase, 3)
    );
    let reason = queue.reason.as_deref().unwrap();
    assert!(
        reason.starts_with("conflict in src/app.ts") && !reason.contains("ghp_"),
        "{reason}"
    );
    assert_eq!(
        seven.review.needed.get(),
        1,
        "every PR the train lands needs one review"
    );

    let five = &rows[0];
    assert!(
        five.checks.is_none(),
        "GitHub's lists didn't carry it: fleetd's record only"
    );
    assert_eq!(
        five.title.as_str(),
        "Add the pricing page",
        "titled by its writer's task"
    );
    assert!(
        five.queue.as_ref().unwrap().reason.is_none(),
        "only a held PR says why"
    );

    let nine = &rows[3];
    assert_eq!(nine.state, PrState::Draft);
    assert_eq!(
        nine.author.task_id.as_ref().map(|t| t.as_str()),
        Some("T8"),
        "matched by its branch"
    );
    assert_eq!(nine.review.state, ReviewState::Pending);
    assert!(nine.queue.is_none());

    assert_eq!(rows[4].state, PrState::Merged);
    assert_eq!(
        rows[4].merged_at.as_ref().unwrap().as_str(),
        "2026-10-21T12:00:00.000Z"
    );
}

#[test]
fn a_patch_reads_as_numbered_lines_without_secrets() {
    let patch = "@@ -10,4 +10,5 @@ fn main() {\n let a = 1;\n-let b = 2;\n+let b = 3;\n+let key = \"sk-ant-api03-abcdefghijklmnop\";\n let c = 4;\n\\ No newline at end of file";
    let lines = join::diff_lines(patch);
    let kinds: Vec<DiffLineKind> = lines.iter().map(|l| l.kind).collect();
    use DiffLineKind::*;
    assert_eq!(kinds, [Hunk, Context, Del, Add, Add, Context]);
    assert_eq!(lines[0].text.as_str(), "fn main() {");
    let nums: Vec<(Option<i64>, Option<i64>)> = lines
        .iter()
        .map(|l| (l.old.map(|n| n.get()), l.new.map(|n| n.get())))
        .collect();
    assert_eq!(
        nums,
        [
            (Some(10), Some(10)),
            (Some(10), Some(10)),
            (Some(11), None),
            (None, Some(11)),
            (None, Some(12)),
            (Some(12), Some(13)),
        ]
    );
    assert_eq!(lines[4].text.as_str(), "let key = \"[secret]\";");
    let long = format!("@@ -1 +1 @@\n+{}", "x".repeat(1000));
    let cut = &join::diff_lines(&long)[1];
    assert_eq!((cut.text.len(), cut.cut), (400, Some(true)));
    let file: super::github::GhFile = serde_json::from_value(
        json!({ "filename": "logo.png", "status": "added", "additions": 0, "deletions": 0 }),
    )
    .unwrap();
    let shown = join::file(&file).unwrap();
    assert_eq!(
        (shown.status, shown.diff_lines),
        (PrFileStatus::Added, None)
    );
}

#[test]
fn a_persons_pending_review_is_left_out_and_secrets_never_shown() {
    let review = |state: &str| -> GhReview {
        serde_json::from_value(json!({
            "author": { "login": "dana" }, "state": state, "body": "LGTM, but rotate AKIAABCDEFGHIJKLMNOP",
            "submittedAt": "2026-10-22T09:00:00Z", "commit": { "oid": SHA },
        }))
        .unwrap()
    };
    assert!(super::person_review(&review("PENDING"), SHA).is_none());
    let shown = super::person_review(&review("CHANGES_REQUESTED"), SHA).unwrap();
    assert_eq!(shown.verdict, ReviewVerdictKind::ChangesRequested);
    assert!(shown.current);
    assert_eq!(shown.text.as_str(), "LGTM, but rotate [secret]");
    assert!(
        !super::person_review(&review("APPROVED"), "other")
            .unwrap()
            .current
    );
}

/// Answers every `gh` run with the next canned reply and counts the runs.
struct Canned {
    replies: Mutex<Vec<(i32, String, String)>>,
    runs: Mutex<Vec<Vec<String>>>,
}

impl GhRunner for Canned {
    fn run(&self, args: Vec<String>) -> BoxFut<'_, Result<GhOut, String>> {
        self.runs.lock().unwrap().push(args);
        let (exit_code, stdout, stderr) = self.replies.lock().unwrap().remove(0);
        Box::pin(async move {
            Ok(GhOut {
                exit_code,
                stdout,
                stderr,
            })
        })
    }
}

fn canned(replies: Vec<(i32, &str, &str)>) -> Arc<Canned> {
    Arc::new(Canned {
        replies: Mutex::new(
            replies
                .into_iter()
                .map(|(c, o, e)| (c, o.to_owned(), e.to_owned()))
                .collect(),
        ),
        runs: Mutex::default(),
    })
}

/// A page of PRs as `gh api graphql` answers it; `next` is the end cursor when there are more.
fn gql_page(pulls: Vec<Value>, next: Option<&str>) -> String {
    json!({ "data": { "repository": { "pullRequests": {
        "pageInfo": { "hasNextPage": next.is_some(), "endCursor": next },
        "nodes": pulls,
    } } } })
    .to_string()
}

/// PR `number`, updated `minutes` after AT's hour, as the GraphQL list carries it.
fn gql_pull(number: i64, state: &str, minutes: i64) -> Value {
    let at = format!(
        "2026-10-22T{:02}:{:02}:00Z",
        10 + minutes / 60,
        minutes % 60
    );
    json!({ "number": number, "title": format!("PR {number}"), "state": state, "isDraft": false,
            "author": { "login": "octo" }, "headRefName": format!("f-{number}"), "headRefOid": SHA,
            "createdAt": AT, "updatedAt": at, "closedAt": (state != "OPEN").then_some(&at),
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "contexts": { "nodes": [
                { "__typename": "CheckRun", "name": "ci", "status": "COMPLETED", "conclusion": "SUCCESS" }
            ] } } } }] } })
}

#[tokio::test]
async fn a_burst_of_reads_asks_github_once_per_minute() {
    let list = gql_page(vec![gql_pull(4, "OPEN", 0)], None);
    let gh = canned(vec![(0, &list, ""), (0, &list, "")]);
    let clock = ManualClock::at(1_792_000_000_000);
    let github = Arc::new(PrsGitHub::new(gh.clone(), clock.clone()));
    let reads = (0..5).map(|_| {
        let github = github.clone();
        tokio::spawn(async move { github.page("acme/web", false, None).await })
    });
    for read in futures_util::future::join_all(reads).await {
        let read = read.unwrap();
        let page = read.value.unwrap();
        assert_eq!(page.pulls[0].title, "PR 4");
        assert_eq!(
            page.pulls[0].status_check_rollup[0].name.as_deref(),
            Some("ci")
        );
        assert_eq!(page.next, None);
        assert!(read.error.is_none());
    }
    assert_eq!(gh.runs.lock().unwrap().len(), 1, "five reads, one gh run");
    let argv = gh.runs.lock().unwrap()[0].join(" ");
    assert!(argv.starts_with("api graphql -f query="), "{argv}");
    assert!(
        argv.contains("states: [OPEN]") && argv.contains("-f owner=acme -f name=web"),
        "{argv}"
    );
    clock.advance(Duration::from_secs(61));
    github.page("acme/web", false, None).await;
    assert_eq!(
        gh.runs.lock().unwrap().len(),
        2,
        "read again once the minute passed"
    );
}

#[tokio::test]
async fn a_failed_read_keeps_the_last_answer_and_waits_a_minute_to_ask_again() {
    let detail = json!({ "number": 4, "title": "Fix login", "state": "OPEN", "headRefName": "fix", "headRefOid": SHA,
                          "createdAt": AT, "updatedAt": AT, "body": "Fixes the login.", "changedFiles": 1 })
    .to_string();
    let gh = canned(vec![
        (0, &detail, ""),
        (
            1,
            "",
            "gh: API rate limit exceeded for user ID 1 (HTTP 403)",
        ),
        (0, &detail, ""),
    ]);
    let clock = ManualClock::at(1_792_000_000_000);
    let github = PrsGitHub::new(gh.clone(), clock.clone());
    assert!(github.detail("acme/web", 4).await.error.is_none());
    clock.advance(Duration::from_secs(31));
    let limited = github.detail("acme/web", 4).await;
    assert_eq!(
        limited.value.unwrap().body,
        "Fixes the login.",
        "the last answer stays"
    );
    assert!(limited.error.unwrap().contains("rate limit"));
    clock.advance(Duration::from_secs(30));
    let again = github.detail("acme/web", 4).await;
    assert!(again.error.is_some(), "not asked again within the minute");
    assert_eq!(gh.runs.lock().unwrap().len(), 2);
    clock.advance(Duration::from_secs(31));
    assert!(github.detail("acme/web", 4).await.error.is_none());
    assert_eq!(gh.runs.lock().unwrap().len(), 3);
}

#[test]
fn gh_failures_read_as_what_to_do() {
    assert!(super::github::explain(4, "").contains("gh auth login"));
    assert!(
        super::github::explain(
            1,
            "To get started with GitHub CLI, please run:  gh auth login"
        )
        .contains("signed in")
    );
    assert!(
        super::github::explain(
            1,
            "gh: Could not resolve to a PullRequest with the number of 9."
        )
        .contains("doesn't know")
    );
    let other = super::github::explain(1, "gh: something broke");
    assert_eq!(other, "GitHub couldn't be read: something broke");
}

/// The first page costs one GitHub read per list; Load more pages on into older PRs by GitHub's cursor, reading each
/// GitHub page once, and the last page says there is no more.
#[tokio::test]
async fn the_list_loads_older_prs_past_the_first_page() {
    let open_1 = gql_page(
        (1..=50)
            .map(|n| gql_pull(200 - n, "OPEN", 200 - n))
            .collect(),
        Some("open-2"),
    );
    let closed_1 = gql_page(
        (1..=30)
            .map(|n| gql_pull(100 - n, "MERGED", 100 - n))
            .collect(),
        None,
    );
    let open_2 = gql_page(
        (51..=70)
            .map(|n| gql_pull(200 - n, "OPEN", 200 - n))
            .collect(),
        None,
    );
    let gh = canned(vec![(0, &open_1, ""), (0, &closed_1, ""), (0, &open_2, "")]);
    let github = PrsGitHub::new(gh.clone(), ManualClock::at(1_792_000_000_000));
    let tasks: Vec<Task> = Vec::new();
    let ctx = RowCtx::with_tasks(&tasks);
    let repos = [repo()];
    let numbers = |rows: &[fleetd_contracts::prs::PrRow]| {
        rows.iter().map(|r| r.number.get()).collect::<Vec<_>>()
    };

    let first = list_page(&github, &repos, &[], "", &ctx, None).await;
    assert!(first.error.is_none());
    assert_eq!(
        numbers(&first.rows),
        (150..=199).rev().collect::<Vec<_>>(),
        "open ones before any closed"
    );
    assert!(first.more);
    assert_eq!(
        gh.runs.lock().unwrap().len(),
        2,
        "the first page of each list, no more"
    );

    let cursor = join::cursor_of(&join::row_key(first.rows.last().unwrap()));
    let key = join::key_of_cursor(&cursor).unwrap();
    let second = list_page(&github, &repos, &[], "", &ctx, Some(&key)).await;
    let runs = gh.runs.lock().unwrap().clone();
    assert_eq!(
        runs.len(),
        3,
        "the first pages are reused; the open list's second is read"
    );
    assert!(
        runs[2].join(" ").ends_with("-f after=open-2"),
        "{:?}",
        runs[2]
    );
    assert!(!second.more, "nothing past the last page");
    let open_after: Vec<i64> = (130..=149).rev().collect();
    let merged: Vec<i64> = (70..=99).rev().collect();
    assert_eq!(numbers(&second.rows), [open_after, merged].concat());
    assert!(second.rows.len() <= PR_LIST_MAX);
    assert!(join::key_of_cursor("not a cursor").is_none());
}
