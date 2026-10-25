//! The host sweep over recorded GitHub answers (`fixtures/github/`), no network: a first read's 90-day backfill
//! and routes (bots, batches, other bases, merge-backs, direct pushes), the person's reviews and comments, the train's
//! richer events agreeing with it, a failing host, and when a repo is read.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use serde_json::json;

use super::host_acts::{HostAct, HostActKind, HostActs};
use super::source::github::GitHubSource;
use super::source::{GitHostSource, LandedCommit, MergedPr, MergedRead, RepoInfo, RepoRef};
use super::sweep::{self, ACTIVE_EVERY_MS, ON_READ_MS, QUIET_EVERY_MS};
use super::tests::{
    DAY, HOUR, NOW, admin, change, event, get, hub, ms, orders, project_from, rows, sql,
};
use super::{human, store};
use crate::hub::api::Hub;
use crate::hub::store::iso_ms;
use crate::hub::train::github::{GhOut, GhRunner};
use crate::hub::train::host::BoxFut;

const REPO: &str = "github.com/acme/web";
const REPO_JSON: &str = include_str!("fixtures/github/repo.json");
const MERGED_1: &str = include_str!("fixtures/github/merged-1.json");
const MERGED_2: &str = include_str!("fixtures/github/merged-2.json");
const COMMITS: &str = include_str!("fixtures/github/commits.json");
const COMMITS_LATE: &str = include_str!("fixtures/github/commits-late.json");
const ACTS: &str = include_str!("fixtures/github/acts.json");
const USER: &str = include_str!("fixtures/github/user.json");

/// `gh` answering from the recorded responses, or signed out.
#[derive(Default)]
struct Recorded {
    signed_out: Mutex<bool>,
    /// The default branch has moved on with a commit made before the first read.
    late_push: Mutex<bool>,
    runs: Mutex<Vec<Vec<String>>>,
}

impl Recorded {
    fn runs(&self) -> Vec<String> {
        self.runs
            .lock()
            .unwrap()
            .iter()
            .map(|a| a.join(" "))
            .collect()
    }

    fn merged_pages(&self) -> usize {
        self.runs()
            .iter()
            .filter(|r| r.contains("states: MERGED"))
            .count()
    }
}

impl GhRunner for Recorded {
    fn run(&self, args: Vec<String>) -> BoxFut<'_, Result<GhOut, String>> {
        let joined = args.join(" ");
        self.runs.lock().unwrap().push(args.clone());
        let reply = if *self.signed_out.lock().unwrap() {
            GhOut {
                exit_code: 4,
                stdout: String::new(),
                stderr: "To get started with GitHub CLI, please run:  gh auth login".into(),
            }
        } else {
            let body = match () {
                () if args.get(1).map(String::as_str) == Some("repos/acme/web") => REPO_JSON,
                () if args.get(1).map(String::as_str) == Some("user") => USER,
                () if joined.contains("history(") && *self.late_push.lock().unwrap() => {
                    COMMITS_LATE
                }
                () if joined.contains("history(") => COMMITS,
                () if joined.contains("reviews(last") => ACTS,
                () if joined.contains("states: MERGED") && joined.contains(" after=") => MERGED_2,
                () if joined.contains("states: MERGED") => MERGED_1,
                () => panic!("no recorded answer for gh {joined}"),
            };
            GhOut {
                exit_code: 0,
                stdout: body.into(),
                stderr: String::new(),
            }
        };
        Box::pin(async move { Ok(reply) })
    }
}

/// acme/web checked out as devbox/web; X45 landed in a batch, X50 on its own, both through the train.
fn checkout(hub: &Hub) {
    orders(hub);
    change(
        hub,
        45,
        45,
        "W1",
        Some("T45"),
        "merged",
        "2026-10-21T08:00:00.000Z",
    );
    change(
        hub,
        50,
        50,
        "W1",
        Some("T50"),
        "merged",
        "2026-10-23T08:00:00.000Z",
    );
    sql(
        hub,
        "INSERT INTO metric_project_repos (machine_id, project_id, repo, checked_ms) VALUES ('devbox', 'web', ?1, ?2)",
        &[&REPO, &ms(NOW)],
    );
    // T7 wrote #43 (`fleetd/T7-checkout`) on the 23rd: it ran from 10:00 to 10:35, was continued, and ran again from
    // 11:40 to 11:50. The task itself started at 10:00 and ended at 11:50.
    sql(
        hub,
        "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, ended_at, data)
         VALUES (7, 'devbox', 'web', 'W1', 'done', '2026-10-23T11:50:00.000Z', ?1)",
        &[&json!({ "taskId": "T7", "createdAt": "2026-10-23T09:55:00.000Z", "startedAt": "2026-10-23T10:00:00.000Z" })
            .to_string()],
    );
    for (run, start, end) in [
        ("r1", "2026-10-23T10:00:00Z", "2026-10-23T10:35:00Z"),
        ("r2", "2026-10-23T11:40:00Z", "2026-10-23T11:50:00Z"),
    ] {
        sql(
            hub,
            "INSERT INTO time_spans (src, src_key, kind, cat, start_ms, end_ms, machine_id, project_id, task_id,
               run_id, lane, status)
             VALUES ('n', ?1, ?2, 0, ?3, ?4, 'devbox', 'web', 'T7', ?5, 'run', 0)",
            &[
                &format!("t7/{run}/run"),
                &fleetd_contracts::time::SpanKind::Run.code(),
                &ms(start),
                &ms(end),
                &run,
            ],
        );
    }
}

/// unit key → (route, why skipped).
fn routes(hub: &Hub) -> BTreeMap<String, (String, Option<String>)> {
    rows(hub)
        .into_iter()
        .map(|r| (r.unit_key, (r.route, r.skip_why)))
        .collect()
}

fn route(route: &str) -> (String, Option<String>) {
    (route.into(), None)
}

fn skipped(why: &str) -> (String, Option<String>) {
    ("skipped".into(), Some(why.into()))
}

fn sha(tag: &str) -> String {
    tag.repeat(40)[..40].to_owned()
}

#[tokio::test]
async fn a_first_read_backfills_90_days_and_routes_every_landed_change() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    let gh = Arc::new(Recorded::default());
    let source = GitHubSource::new(gh.clone());
    let swept = sweep::sweep_repo(&hub, &source, REPO, ms(NOW))
        .await
        .unwrap();

    let (pushed, changelog) = (
        format!("commit:{}", sha("b2")),
        format!("commit:{}", sha("b4")),
    );
    let want: BTreeMap<String, (String, Option<String>)> = [
        ("pr:50", route("train")),
        ("pr:41", route("outside")),
        ("pr:42", skipped("bot")),
        ("pr:43", route("fleetd_by_hand")),
        // The batch PR #44 is its two members, each one landed change.
        ("pr:45", route("train")),
        ("pr:46", route("train")),
        ("pr:47", skipped("other_base")),
        // Stacked: #47 went into release/2.0, then #48 took release/2.0 into main. The work counts once, as #48,
        // the PR that reached the default branch. A sync from upstream is a merge-back.
        ("pr:48", route("outside")),
        ("pr:49", skipped("merge_back")),
        // Merged on 1 September: the backfill's second page. #20 is older than 90 days.
        ("pr:30", route("outside")),
        (pushed.as_str(), route("direct")),
        (changelog.as_str(), skipped("bot")),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    assert_eq!(routes(&hub), want);
    assert_eq!(swept.rows, want.len());
    // #50's squash isn't linked to its PR yet, and the wip commit is off the default branch's own line.
    assert_eq!(gh.merged_pages(), 2, "paged until past 90 days");

    let by_key: BTreeMap<String, _> = rows(&hub)
        .into_iter()
        .map(|r| (r.unit_key.clone(), r))
        .collect();
    let outside = &by_key["pr:41"];
    assert_eq!(outside.merged_ms, ms("2026-10-24T10:00:00Z"));
    assert_eq!(outside.pr_created_ms, Some(ms("2026-10-20T08:00:00Z")));
    assert_eq!(
        (
            outside.author_kind.as_deref(),
            outside.merged_by_kind.as_deref()
        ),
        (Some("human"), Some("human"))
    );
    assert_eq!((outside.additions, outside.deletions), (Some(12), Some(3)));
    assert_eq!(outside.title.as_deref(), Some("Fix the cart total"));
    assert_eq!(
        (outside.machine_id.as_deref(), outside.project_id.as_deref()),
        (Some("devbox"), Some("web"))
    );
    let member = &by_key["pr:45"];
    assert_eq!(
        (
            member.batch_pr,
            member.change_id.as_deref(),
            member.workstream_id.as_deref()
        ),
        (Some(44), Some("X45"), Some("W1"))
    );
    assert_eq!(member.merged_ms, ms("2026-10-22T12:00:00Z"));
    assert_eq!(by_key["pr:43"].task_id.as_deref(), Some("T7"));

    // The person's two acts on #41 count toward outside work, the review of fleetd's #43 toward fleetd's; the bot's
    // comment and the pending review are not acts.
    let touches: Vec<(i64, String, bool)> = hub
        .db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT pr_number, kind, outside FROM metric_touches WHERE src = 'host' ORDER BY at_ms",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(
        touches,
        [
            (43, "host.review".to_owned(), false),
            (43, "host.review".to_owned(), false),
            (43, "host.comment".to_owned(), false),
            (41, "host.review".to_owned(), true),
            (41, "host.comment".to_owned(), true),
        ]
    );
    assert_eq!(swept.touches, 5);

    // Thirty days: three through the train, one fleetd PR merged by hand, two outside, one direct push.
    let out = get(
        &hub,
        &admin(),
        json!({ "since": iso_ms(ms(NOW) - 30 * DAY), "tz": "UTC" }),
    )
    .await
    .unwrap();
    let merged = &out.tiles.merged;
    assert_eq!(
        (
            merged.by_route.train.get(),
            merged.by_route.fleetd_by_hand.get(),
            merged.by_route.outside.get(),
            merged.by_route.direct.get()
        ),
        (3, 1, 2, 1)
    );
    let pct = out.tiles.through_fleetd.pct.unwrap().get();
    assert!((pct - 300.0 / 7.0).abs() < 1e-9, "{pct}");
    // The backfill reaches past the previous 30 days, so the delta is shown: #30 on 1 September.
    assert!((merged.previous_per_day.unwrap().get() - 1.0 / 30.0).abs() < 1e-9);
    let cov = &out.coverage.repos.as_slice()[0];
    assert_eq!(
        cov.default_branch.as_ref().map(|b| b.as_str()),
        Some("main")
    );
    assert_eq!(
        cov.known_since.as_ref().map(|t| t.as_str().to_owned()),
        Some(iso_ms(ms(NOW) - 90 * DAY))
    );
    assert!(out.coverage.stale.is_empty());
    let skipped_on_22nd = out
        .days
        .iter()
        .find(|d| d.day.as_str() == "2026-10-22")
        .unwrap();
    assert_eq!(skipped_on_22nd.not_counted.len(), 1, "#47 into release/2.0");
}

#[tokio::test]
async fn the_trains_events_and_the_sweep_route_a_pr_the_same_way() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    // The repo's default branch, as its project's node reported it.
    sql(
        &hub,
        "INSERT INTO metric_repos (repo, host, default_branch) VALUES (?1, 'github', 'main')",
        &[&REPO],
    );
    // What the train now reports of PRs merged without it: a bot's, and one from a fleetd branch with no Change.
    for (n, head, author, merged) in [
        (
            42,
            "dependabot/npm_and_yarn/lodash-4.17.21",
            "bot",
            "2026-10-23T15:00:00.000Z",
        ),
        (
            43,
            "fleetd/T7-checkout",
            "human",
            "2026-10-23T12:00:00.000Z",
        ),
        // Merged by hand into a release branch: not the default branch, so not landed.
        (47, "backport-cart", "human", "2026-10-22T09:00:00.000Z"),
    ] {
        event(
            &hub,
            NOW,
            HubEventType::PrMergedOutside,
            json!({ "repo": "acme/web", "prNumber": n, "mergedAt": merged, "head": head, "authorKind": author,
                    "base": if n == 47 { "release/2.0" } else { "main" } }),
        );
    }
    // An older hub's event says no base: it counts.
    event(
        &hub,
        NOW,
        HubEventType::PrMergedOutside,
        json!({ "repo": "acme/web", "prNumber": 41, "mergedSha": sha("41") }),
    );
    project_from(&hub, 0);
    let from_events = routes(&hub);
    assert_eq!(from_events["pr:42"], skipped("bot"));
    assert_eq!(from_events["pr:43"], route("fleetd_by_hand"));
    assert_eq!(from_events["pr:47"], skipped("other_base"));
    assert_eq!(from_events["pr:41"], route("outside"));
    let by_key: BTreeMap<String, _> = rows(&hub)
        .into_iter()
        .map(|r| (r.unit_key.clone(), r))
        .collect();
    assert_eq!(
        by_key["pr:43"].merged_ms,
        ms("2026-10-23T12:00:00Z"),
        "timed when it merged, not when seen"
    );

    let source = GitHubSource::new(Arc::new(Recorded::default()));
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW))
        .await
        .unwrap();
    let after = routes(&hub);
    assert_eq!(after["pr:42"], skipped("bot"));
    assert_eq!(after["pr:43"], route("fleetd_by_hand"));
    assert_eq!(after["pr:47"], skipped("other_base"));

    // A second read and a replay of the log write nothing new.
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW) + 60_000)
        .await
        .unwrap();
    project_from(&hub, 0);
    assert_eq!(routes(&hub), after);
}

#[tokio::test]
async fn a_signed_out_host_keeps_the_rows_and_the_view_says_since_when() {
    let (hub, clock, _home) = hub();
    checkout(&hub);
    let gh = Arc::new(Recorded::default());
    let source = GitHubSource::new(gh.clone());
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW))
        .await
        .unwrap();
    let before = routes(&hub);

    // The next read starts at the cursor: the first page is already past it.
    clock.advance(Duration::from_secs(15 * 60));
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW) + 15 * 60_000)
        .await
        .unwrap();
    assert_eq!(gh.merged_pages(), 3, "one page on the second read");

    *gh.signed_out.lock().unwrap() = true;
    let why = sweep::sweep_repo(&hub, &source, REPO, ms(NOW) + 30 * 60_000)
        .await
        .unwrap_err();
    assert!(why.contains("gh auth login"), "{why}");
    assert_eq!(routes(&hub), before);
    let out = get(
        &hub,
        &admin(),
        json!({ "since": iso_ms(ms(NOW) - 7 * DAY), "tz": "UTC" }),
    )
    .await
    .unwrap();
    let stale = &out.coverage.stale.as_slice()[0];
    assert_eq!(stale.repo.as_str(), REPO);
    assert_eq!(stale.since.as_str(), iso_ms(ms(NOW) + 15 * 60_000));
    assert!(
        stale
            .reason
            .as_str()
            .starts_with("GitHub not read since 12:15: GitHub isn't signed in"),
        "{}",
        stale.reason.as_str()
    );
    assert_eq!(
        out.tiles.merged.n.get(),
        7,
        "the figures stay, marked stale"
    );
}

#[test]
fn a_repo_is_read_every_15_minutes_while_active_else_hourly_and_within_a_minute_of_a_read() {
    let now = ms(NOW);
    assert!(sweep::due(None, None, false, now), "never read");
    let active = Some(now - DAY);
    let quiet = Some(now - 8 * DAY);
    assert!(!sweep::due(
        Some(now - ACTIVE_EVERY_MS + 1),
        active,
        false,
        now
    ));
    assert!(sweep::due(Some(now - ACTIVE_EVERY_MS), active, false, now));
    assert!(!sweep::due(Some(now - ACTIVE_EVERY_MS), quiet, false, now));
    assert!(sweep::due(Some(now - QUIET_EVERY_MS), quiet, false, now));
    assert!(!sweep::due(Some(now - ON_READ_MS + 1), quiet, true, now));
    assert!(sweep::due(Some(now - ON_READ_MS), quiet, true, now));
}

#[tokio::test]
async fn a_pass_reads_each_due_repo_once_and_a_metrics_read_asks_again_after_a_minute() {
    let (hub, clock, _home) = hub();
    checkout(&hub);
    assert!(
        hub.metrics.sweep.source("github").is_none(),
        "a hub built for tests reads no git host"
    );
    let gh = Arc::new(Recorded::default());
    hub.metrics
        .sweep
        .use_github(Arc::new(GitHubSource::new(gh.clone())));
    let reads = || {
        gh.runs()
            .iter()
            .filter(|r| r.contains("repos/acme/web"))
            .count()
    };

    sweep::pass(&hub).await;
    assert_eq!(reads(), 1, "every project's repo, train or not");
    sweep::pass(&hub).await;
    assert_eq!(reads(), 1, "not due again yet");

    clock.advance(Duration::from_secs(61));
    sweep::pass(&hub).await;
    assert_eq!(reads(), 1, "an active repo waits 15 minutes");
    get(
        &hub,
        &admin(),
        json!({ "since": iso_ms(ms(NOW) - 7 * DAY), "tz": "UTC" }),
    )
    .await
    .unwrap();
    sweep::pass(&hub).await;
    assert_eq!(reads(), 2, "a metrics read asked for it");

    clock.advance(Duration::from_secs(15 * 60));
    sweep::pass(&hub).await;
    assert_eq!(reads(), 3);
}

#[tokio::test]
async fn the_hubs_own_login_is_the_persons_and_only_its_reviews_and_merges_count() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    let source = GitHubSource::new(Arc::new(Recorded::default()));
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW))
        .await
        .unwrap();

    let (ids, touches) = hub
        .db
        .with(|c| Ok((store::identities(c)?, store::touches(c, 0, i64::MAX)?)))
        .unwrap();
    assert_eq!(ids, ["ada-lovelace"], "the account gh reads GitHub as");
    let ids = human::Identities::new(&ids);
    let counted = |kind: &str| -> Vec<(Option<i64>, Option<String>, bool)> {
        touches
            .iter()
            .filter(|t| t.kind == kind)
            .map(|t| (t.pr_number, t.key_id.clone(), human::attributed(t, &ids)))
            .collect()
    };
    // Two reviews of #43: the person's counts, a colleague's on the same PR doesn't.
    let mut reviews = counted("host.review");
    reviews.sort();
    assert_eq!(
        reviews,
        [
            (Some(41), Some("ada-lovelace".into()), true),
            (Some(43), Some("ada-lovelace".into()), true),
            (Some(43), Some("grace-hopper".into()), false),
        ]
    );
    // The PRs the person merged by hand, fleetd's #43 and the outside #41, #30 and #48, are theirs by the merger's login.
    let mut merges = counted("merge.by_hand");
    merges.sort();
    assert_eq!(
        merges,
        [
            (Some(30), Some("ada-lovelace".into()), true),
            (Some(41), Some("ada-lovelace".into()), true),
            (Some(43), Some("ada-lovelace".into()), true),
            (Some(48), Some("ada-lovelace".into()), true),
        ]
    );
}

#[tokio::test]
async fn a_commit_made_before_the_last_read_and_pushed_after_it_is_a_direct_push() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    let gh = Arc::new(Recorded::default());
    let source = GitHubSource::new(gh.clone());
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW))
        .await
        .unwrap();

    // An hour on, main has one more commit, dated 1 October: long before the last read.
    *gh.late_push.lock().unwrap() = true;
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW) + HOUR)
        .await
        .unwrap();
    let late = format!("commit:{}", sha("c7"));
    assert_eq!(routes(&hub).get(&late), Some(&route("direct")));
    let history = gh
        .runs()
        .into_iter()
        .rfind(|r| r.contains("history("))
        .unwrap();
    assert!(
        !history.contains(" since="),
        "read back to the last head, not by date: {history}"
    );
    let head: Option<String> = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT commits_cursor_sha FROM metric_repos WHERE repo = ?1",
                [REPO],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(head, Some(sha("c7")));
}

#[test]
fn the_default_branch_is_read_back_to_the_last_head_or_by_date_once_that_head_is_gone() {
    let commit = |tag: &str, at: &str, parent: Option<&str>| LandedCommit {
        sha: sha(tag),
        at_ms: ms(at),
        first_parent: parent.map(sha),
        prs: Some(Vec::new()),
        ..LandedCommit::default()
    };
    let commits = [
        commit("c7", "2026-10-01T09:00:00Z", Some("50")),
        commit("50", "2026-10-24T12:00:00Z", Some("41")),
        commit("41", "2026-10-24T10:00:00Z", None),
    ];
    let shas = |cs: Vec<&LandedCommit>| {
        cs.into_iter()
            .map(|c| c.sha[..2].to_owned())
            .collect::<Vec<_>>()
    };
    let since = ms("2026-10-24T11:00:00Z");
    assert_eq!(
        shas(sweep::landed_since(&commits, Some(&sha("50")), since)),
        ["c7"]
    );
    assert!(
        sweep::landed_since(&commits, Some(&sha("c7")), since).is_empty(),
        "nothing new"
    );
    // A force push left the last head off the line: the date window it is.
    assert_eq!(
        shas(sweep::landed_since(&commits, Some(&sha("ff")), since)),
        ["50"]
    );
    assert_eq!(shas(sweep::landed_since(&commits, None, since)), ["50"]);
}

#[tokio::test]
async fn fleetds_own_comments_and_an_agents_during_its_run_are_not_the_persons() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    let source = GitHubSource::new(Arc::new(Recorded::default()));
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW))
        .await
        .unwrap();
    let comments: Vec<(Option<i64>, i64)> = hub
        .db
        .with(|c| store::touches(c, 0, i64::MAX))
        .unwrap()
        .into_iter()
        .filter(|t| t.kind == "host.comment")
        .map(|t| (t.pr_number, t.at_ms))
        .collect();
    // On #43, T7's agent commented at 10:30 during its run, and the person at 12:30. On #45 the train left its
    // comment, marked, and one from before it marked them.
    assert_eq!(
        comments,
        [
            (Some(43), ms("2026-10-23T12:30:00Z")),
            (Some(41), ms("2026-10-24T09:40:00Z")),
        ]
    );
    let act = |at: &str| HostAct {
        kind: HostActKind::Comment,
        id: "1".into(),
        pr_number: 43,
        at_ms: ms(at),
        login: Some("ada-lovelace".into()),
        bot: false,
        head: Some("slot/1/fleetd/T7-checkout".into()),
        lines: None,
    };
    let agents = |at: &str| sweep::agents_act(&hub.db, REPO, &act(at), ms(NOW)).unwrap();
    assert!(agents("2026-10-23T10:35:00Z"));
    assert!(!agents("2026-10-23T11:00:00Z"), "between its two runs");
    assert!(agents("2026-10-23T11:45:00Z"));
    assert!(!agents("2026-10-23T12:00:00Z"));
    // Another fleet's `fleetd/T7-…` on a repo none of this hub's projects has is not this hub's T7.
    assert!(
        !sweep::agents_act(
            &hub.db,
            "github.com/other/web",
            &act("2026-10-23T10:30:00Z"),
            ms(NOW)
        )
        .unwrap()
    );
}

/// A task's act on its PR, through `gh` under the person's login.
fn task_act(task: i64, at: &str) -> HostAct {
    HostAct {
        kind: HostActKind::Comment,
        id: "1".into(),
        pr_number: 90 + task,
        at_ms: ms(at),
        login: Some("ada-lovelace".into()),
        bot: false,
        head: Some(format!("fleetd/T{task}-x")),
        lines: None,
    }
}

fn task_row(hub: &Hub, n: i64, state: &str, started: &str, ended: Option<&str>) {
    sql(
        hub,
        "INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, ended_at, data)
         VALUES (?1, 'devbox', 'web', 'W1', ?2, ?3, ?4)",
        &[
            &n,
            &state,
            &ended,
            &json!({ "taskId": format!("T{n}"), "createdAt": started, "startedAt": started })
                .to_string(),
        ],
    );
}

#[tokio::test]
async fn an_act_during_a_run_still_open_or_past_the_span_retention_is_the_agents() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    let agents =
        |n: i64, at: &str| sweep::agents_act(&hub.db, REPO, &task_act(n, at), ms(NOW)).unwrap();

    // T8 first ran on the 20th, and was continued at 09:00 today: that run is open, and its spans come only when it
    // ends.
    task_row(&hub, 8, "running", "2026-10-20T08:00:00.000Z", None);
    sql(
        &hub,
        "INSERT INTO events (created_ms, type, machine_id, data) VALUES (?1, 'task.started', 'devbox', ?2)",
        &[
            &ms("2026-10-25T09:00:00Z"),
            &json!({ "type": "task.started", "data": { "taskId": "T8" } }).to_string(),
        ],
    );
    assert!(agents(8, "2026-10-25T10:00:00Z"), "during the open run");
    assert!(
        !agents(8, "2026-10-25T08:30:00Z"),
        "before this attempt, with no span for the last"
    );

    // T9 ran on 1 September, past the 30 days its spans are kept: its own start and end stand in.
    task_row(
        &hub,
        9,
        "done",
        "2026-09-01T10:00:00.000Z",
        Some("2026-09-01T12:00:00.000Z"),
    );
    assert!(agents(9, "2026-09-01T11:00:00Z"));
    assert!(!agents(9, "2026-09-01T13:00:00Z"));
    // A task within the retention with no span covering the act: between runs, the person's.
    task_row(
        &hub,
        10,
        "done",
        "2026-10-24T10:00:00.000Z",
        Some("2026-10-24T12:00:00.000Z"),
    );
    assert!(!agents(10, "2026-10-24T11:00:00Z"));
}

#[tokio::test]
async fn a_review_between_two_runs_of_the_same_task_is_the_persons() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    let source = GitHubSource::new(Arc::new(Recorded::default()));
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW))
        .await
        .unwrap();
    let reviews: Vec<(i64, Option<String>)> = hub
        .db
        .with(|c| store::touches(c, 0, i64::MAX))
        .unwrap()
        .into_iter()
        .filter(|t| t.kind == "host.review" && t.pr_number == Some(43))
        .map(|t| (t.at_ms, t.key_id))
        .collect();
    // T7 was continued: its task spans 10:00 to 11:50, but it ran only until 10:35 and from 11:40. The person's
    // review at 11:00 and a colleague's at 11:30 fall between the runs.
    assert_eq!(
        reviews,
        [
            (ms("2026-10-23T11:00:00Z"), Some("ada-lovelace".into())),
            (ms("2026-10-23T11:30:00Z"), Some("grace-hopper".into())),
        ]
    );
}

/// GitHub's reads with the merged PRs cut short after the first page, as the page cap does to a busy repo.
struct CutShort {
    inner: GitHubSource,
    afters: Mutex<Vec<Option<String>>>,
}

impl GitHostSource for CutShort {
    fn signed_in(&self) -> BoxFut<'_, Result<Option<String>, String>> {
        self.inner.signed_in()
    }

    fn repo_info<'a>(&'a self, repo: &'a RepoRef) -> BoxFut<'a, Result<RepoInfo, String>> {
        self.inner.repo_info(repo)
    }

    fn merged_since<'a>(
        &'a self,
        repo: &'a RepoRef,
        since_ms: i64,
        after: Option<&'a str>,
    ) -> BoxFut<'a, Result<MergedRead, String>> {
        Box::pin(async move {
            self.afters.lock().unwrap().push(after.map(str::to_owned));
            let all = self.inner.merged_since(repo, since_ms, None).await?.pulls;
            let first = |p: &MergedPr| p.updated_ms >= ms("2026-10-20T09:00:00Z");
            Ok(match after {
                // A read from the cursor of a later pass fits in a page.
                None if since_ms >= ms("2026-10-20T09:00:00Z") => MergedRead {
                    pulls: all,
                    rest: None,
                },
                None => MergedRead {
                    pulls: all.into_iter().filter(first).collect(),
                    rest: Some(("page-2".into(), ms("2026-10-20T09:00:00Z"))),
                },
                Some(_) => MergedRead {
                    pulls: all.into_iter().filter(|p| !first(p)).collect(),
                    rest: None,
                },
            })
        })
    }

    fn default_commits<'a>(
        &'a self,
        repo: &'a RepoRef,
        branch: &'a str,
        since_ms: i64,
        stop_at: Option<&'a str>,
    ) -> BoxFut<'a, Result<Vec<LandedCommit>, String>> {
        self.inner.default_commits(repo, branch, since_ms, stop_at)
    }

    fn prs_of_commit<'a>(
        &'a self,
        repo: &'a RepoRef,
        sha: &'a str,
    ) -> BoxFut<'a, Result<Vec<i64>, String>> {
        self.inner.prs_of_commit(repo, sha)
    }

    fn acts(&self) -> &dyn HostActs {
        self.inner.acts()
    }
}

#[tokio::test]
async fn a_read_the_page_cap_cut_short_goes_on_at_the_next_and_shows_partly_read_until_done() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    let source = CutShort {
        inner: GitHubSource::new(Arc::new(Recorded::default())),
        afters: Mutex::default(),
    };
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW))
        .await
        .unwrap();
    assert!(
        !routes(&hub).contains_key("pr:30"),
        "on the page not read yet"
    );
    let coverage = |out: &fleetd_contracts::mcp::MetricsGetOutput| {
        let c = &out.coverage.repos.as_slice()[0];
        (
            c.partly_read,
            c.known_since.as_ref().map(|t| t.as_str().to_owned()),
        )
    };
    let who = admin();
    let read = || {
        get(
            &hub,
            &who,
            json!({ "since": iso_ms(ms(NOW) - 7 * DAY), "tz": "UTC" }),
        )
    };
    assert_eq!(
        coverage(&read().await.unwrap()),
        (Some(true), Some(iso_ms(ms("2026-10-20T09:00:00Z")))),
        "known only as far as the read reached"
    );

    sweep::sweep_repo(&hub, &source, REPO, ms(NOW) + HOUR)
        .await
        .unwrap();
    assert_eq!(
        source.afters.lock().unwrap().as_slice(),
        [None, None, Some("page-2".into())],
        "the next read goes on from where the cap stopped"
    );
    assert_eq!(routes(&hub).get("pr:30"), Some(&route("outside")));
    assert_eq!(
        coverage(&read().await.unwrap()),
        (None, Some(iso_ms(ms(NOW) - 90 * DAY)))
    );
}
