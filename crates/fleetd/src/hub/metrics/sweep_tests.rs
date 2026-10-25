//! The host sweep over recorded GitHub answers (`fixtures/github/`), no network: a first read's 90-day backfill
//! and routes (bots, batches, other bases, merge-backs, direct pushes), the person's reviews and comments, the train's
//! richer events agreeing with it, a failing host, and when a repo is read.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use serde_json::json;

use super::source::github::GitHubSource;
use super::sweep::{self, ACTIVE_EVERY_MS, ON_READ_MS, QUIET_EVERY_MS};
use super::tests::{DAY, NOW, admin, change, event, get, hub, ms, orders, project_from, rows, sql};
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
const ACTS: &str = include_str!("fixtures/github/acts.json");
const USER: &str = include_str!("fixtures/github/user.json");

/// `gh` answering from the recorded responses, or signed out.
#[derive(Default)]
struct Recorded {
    signed_out: Mutex<bool>,
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
        // release/2.0 is the base of #47, so merging it into main is a merge-back; so is a sync from upstream.
        ("pr:48", skipped("merge_back")),
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
            (41, "host.review".to_owned(), true),
            (41, "host.comment".to_owned(), true),
        ]
    );
    assert_eq!(swept.touches, 4);

    // Thirty days: three through the train, one fleetd PR merged by hand, one outside, one direct push.
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
        (3, 1, 1, 1)
    );
    assert_eq!(out.tiles.through_fleetd.pct.map(|p| p.get()), Some(50.0));
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
        // Into a base the train guarded when it reported it.
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
    project_from(&hub, 0);
    let from_events = routes(&hub);
    assert_eq!(from_events["pr:42"], skipped("bot"));
    assert_eq!(from_events["pr:43"], route("fleetd_by_hand"));
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
    assert_eq!(
        after["pr:47"],
        route("outside"),
        "the train judged its base; the sweep doesn't overrule it"
    );

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
        6,
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
    // The PRs the person merged by hand, fleetd's #43 and the outside #41 and #30, are theirs by the merger's login.
    let mut merges = counted("merge.by_hand");
    merges.sort();
    assert_eq!(
        merges,
        [
            (Some(30), Some("ada-lovelace".into()), true),
            (Some(41), Some("ada-lovelace".into()), true),
            (Some(43), Some("ada-lovelace".into()), true),
        ]
    );
}
