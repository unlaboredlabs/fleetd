//! The host sweep over recorded GitLab answers (`fixtures/gitlab/`), no network: a self-hosted instance found by its
//! `/api/v4/version`, a first read's paged 90-day backfill and routes (bots by flag and by name, other bases,
//! merge-backs, a fast-forward's commits mapped to their MR, direct pushes), who merged, the person's comments and
//! approvals, a person with no way in, and the parts that read GitLab's words.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use super::source::gitlab::{self, GitLabApi, GitLabSource, LOG_IN, Reply};
use super::source::{GitHostSource, HostSources, RepoRef};
use super::sweep;
use super::tests::{DAY, HOUR, NOW, admin, get, hub, ms, orders, rows, sql};
use super::{human, store};
use crate::hub::api::Hub;
use crate::hub::store::iso_ms;
use crate::hub::usage::ports::BoxFut;

const INSTANCE: &str = "gitlab.example.com";
const REPO: &str = "gitlab.example.com/acme/web";

fn fixture(name: &str) -> &'static str {
    match name {
        "version" => include_str!("fixtures/gitlab/version.json"),
        "unauthorized" => include_str!("fixtures/gitlab/unauthorized.json"),
        "user" => include_str!("fixtures/gitlab/user.json"),
        "project" => include_str!("fixtures/gitlab/project.json"),
        "merged-1" => include_str!("fixtures/gitlab/merged-1.json"),
        "merged-2" => include_str!("fixtures/gitlab/merged-2.json"),
        "commits" => include_str!("fixtures/gitlab/commits.json"),
        "commits-late" => include_str!("fixtures/gitlab/commits-late.json"),
        "commit-mrs-50" => include_str!("fixtures/gitlab/commit-mrs-50.json"),
        "commit-mrs-open" => include_str!("fixtures/gitlab/commit-mrs-open.json"),
        "act-mrs" => include_str!("fixtures/gitlab/act-mrs.json"),
        "notes-41" => include_str!("fixtures/gitlab/notes-41.json"),
        "notes-43" => include_str!("fixtures/gitlab/notes-43.json"),
        "notes-51" => include_str!("fixtures/gitlab/notes-51.json"),
        other => panic!("no fixture {other}"),
    }
}

/// The API answering from the recorded responses; with no login, as `SystemGitLab` does when neither `glab` nor
/// git's credential helper has one.
#[derive(Default)]
struct Recorded {
    no_login: Mutex<bool>,
    late_push: Mutex<bool>,
    runs: Mutex<Vec<String>>,
    versions: Mutex<Vec<String>>,
    /// How many times `gitlab.flaky.example` was asked: it is unreachable the first time, then answers as a host
    /// that isn't GitLab.
    flaky: Mutex<usize>,
}

impl Recorded {
    fn runs(&self) -> Vec<String> {
        self.runs.lock().unwrap().clone()
    }

    fn count(&self, part: &str) -> usize {
        self.runs().iter().filter(|r| r.contains(part)).count()
    }
}

fn sha(tag: &str) -> String {
    tag.repeat(40)[..40].to_owned()
}

fn ok(body: &str) -> Reply {
    Reply {
        status: 200,
        body: body.to_owned(),
    }
}

impl GitLabApi for Recorded {
    fn get<'a>(&'a self, instance: &'a str, path: &'a str) -> BoxFut<'a, Result<Reply, String>> {
        assert_eq!(instance, INSTANCE);
        self.runs.lock().unwrap().push(path.to_owned());
        let reply = if *self.no_login.lock().unwrap() {
            Err(LOG_IN.to_owned())
        } else {
            let name = match path {
                "user" => "user",
                "projects/acme%2Fweb" => "project",
                p if p.contains("state=merged") && p.ends_with("&page=1") => "merged-1",
                p if p.contains("state=merged") && p.ends_with("&page=2") => "merged-2",
                p if p.contains("/repository/commits?") && *self.late_push.lock().unwrap() => {
                    "commits-late"
                }
                p if p.contains("/repository/commits?") => "commits",
                p if p.contains(&format!("/commits/{}/merge_requests", sha("e5"))) => {
                    "commit-mrs-50"
                }
                p if p.contains(&format!("/commits/{}/merge_requests", sha("b2"))) => {
                    "commit-mrs-open"
                }
                p if p.contains("/merge_requests") && p.contains("/repository/commits/") => {
                    return Box::pin(async { Ok(ok("[]")) });
                }
                p if p.contains("state=all") && p.ends_with("&page=1") => "act-mrs",
                p if p.contains("merge_requests/41/notes") => "notes-41",
                p if p.contains("merge_requests/43/notes") => "notes-43",
                p if p.contains("merge_requests/51/notes") => "notes-51",
                p => panic!("no recorded answer for GET {p}"),
            };
            Ok(ok(fixture(name)))
        };
        Box::pin(async move { reply })
    }

    fn version<'a>(&'a self, instance: &'a str) -> BoxFut<'a, Result<Reply, String>> {
        self.versions.lock().unwrap().push(instance.to_owned());
        let reply = match instance {
            "gitlab.flaky.example" => {
                let mut asked = self.flaky.lock().unwrap();
                *asked += 1;
                if *asked == 1 {
                    return Box::pin(async {
                        Err("gitlab.flaky.example couldn't be reached".to_owned())
                    });
                }
                Reply {
                    status: 404,
                    body: "<html>Not Found</html>".into(),
                }
            }
            "gitlab.down.example" => Reply {
                status: 502,
                body: "<html>502 Bad Gateway</html>".into(),
            },
            INSTANCE => ok(fixture("version")),
            "gitlab.locked.example" => Reply {
                status: 401,
                body: fixture("unauthorized").to_owned(),
            },
            _ => Reply {
                status: 404,
                body: "<html>Not Found</html>".into(),
            },
        };
        Box::pin(async move { Ok(reply) })
    }
}

/// acme/web on the company's GitLab, checked out as devbox/web.
fn checkout(hub: &Hub) {
    orders(hub);
    sql(
        hub,
        "INSERT INTO metric_project_repos (machine_id, project_id, repo, checked_ms) VALUES ('devbox', 'web', ?1, ?2)",
        &[&REPO, &ms(NOW)],
    );
}

fn source(api: &Arc<Recorded>) -> GitLabSource {
    GitLabSource::new(api.clone(), INSTANCE).with_page_cap(8)
}

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

#[tokio::test]
async fn a_first_read_of_gitlab_backfills_90_days_and_routes_every_landed_change() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    let api = Arc::new(Recorded::default());
    let swept = sweep::sweep_repo(&hub, &source(&api), REPO, ms(NOW))
        .await
        .unwrap();

    let want: BTreeMap<String, (String, Option<String>)> = [
        ("pr:50", route("outside")),
        ("pr:41", route("outside")),
        // Renovate says it is a bot; the project access token's bot only by its name, on an older GitLab.
        ("pr:42", skipped("bot")),
        ("pr:44", skipped("bot")),
        ("pr:43", route("fleetd_by_hand")),
        ("pr:47", skipped("other_base")),
        // release/2.0 into main is landed: !47 into it wasn't, so the work counts once. A sync from the upstream is
        // a merge-back.
        ("pr:48", route("outside")),
        ("pr:49", skipped("merge_back")),
        // Merged on 1 September: the backfill's second page. !20 is older than 90 days.
        ("pr:30", route("outside")),
        (format!("commit:{}", sha("b2")).as_str(), route("direct")),
        (format!("commit:{}", sha("b4")).as_str(), skipped("bot")),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    assert_eq!(routes(&hub), want);
    assert_eq!(swept.rows, want.len());
    assert_eq!(api.count("state=merged"), 2, "paged until past 90 days");
    let merged = api
        .runs()
        .into_iter()
        .find(|r| r.contains("state=merged"))
        .unwrap();
    assert!(
        merged.contains(&format!(
            "updated_after={}",
            iso_ms(ms(NOW) - 90 * DAY).replace(':', "%3A")
        )),
        "{merged}"
    );
    // !50 was fast-forwarded: its earlier commit is asked about and found to be its; the squash of !43 and the merge
    // of !41 are the MRs' own. The direct push and the bot's commit belong to no merged MR (one open MR has it).
    let asked: Vec<String> = api
        .runs()
        .into_iter()
        .filter(|r| r.ends_with("/merge_requests") && r.contains("/repository/commits/"))
        .collect();
    assert_eq!(asked.len(), 3, "{asked:?}");

    let by_key: BTreeMap<String, _> = rows(&hub)
        .into_iter()
        .map(|r| (r.unit_key.clone(), r))
        .collect();
    let outside = &by_key["pr:41"];
    assert_eq!(outside.merged_ms, ms("2026-10-24T10:00:00Z"));
    assert_eq!(outside.pr_created_ms, Some(ms("2026-10-20T08:00:00Z")));
    assert_eq!(outside.merged_sha.as_deref(), Some(sha("41").as_str()));
    assert_eq!(outside.title.as_deref(), Some("Fix the cart total"));
    assert_eq!(
        outside.url.as_deref(),
        Some("https://gitlab.example.com/acme/web/-/merge_requests/41")
    );
    assert_eq!(
        (outside.machine_id.as_deref(), outside.project_id.as_deref()),
        (Some("devbox"), Some("web"))
    );
    let ff = &by_key["pr:50"];
    assert_eq!(
        (ff.author_kind.as_deref(), ff.merged_by_kind.as_deref()),
        (Some("human"), Some("human")),
        "who opened and merged it: the merge touch below names grace-hopper"
    );
    assert_eq!(by_key["pr:43"].task_id.as_deref(), Some("T7"));
    assert_eq!(
        by_key["pr:43"].merged_sha.as_deref(),
        Some(sha("43").as_str()),
        "the squash"
    );
    assert_eq!(
        by_key[&format!("commit:{}", sha("b2"))].url.as_deref(),
        Some(format!("https://gitlab.example.com/acme/web/-/commit/{}", sha("b2")).as_str())
    );

    // The approval and the change request are reviews, the people's notes comments; the bot's note, a push's system
    // note and one older than 90 days are not acts.
    let touches: Vec<(i64, String, Option<String>, bool)> = hub
        .db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT pr_number, kind, key_id, outside FROM metric_touches WHERE src = 'host' ORDER BY at_ms",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .unwrap();
    let ada = Some("ada-lovelace".to_owned());
    assert_eq!(
        touches,
        [
            (41, "host.review".to_owned(), ada.clone(), true),
            (41, "host.comment".to_owned(), ada.clone(), true),
            (
                43,
                "host.comment".to_owned(),
                Some("grace-hopper".into()),
                false
            ),
            (43, "host.review".to_owned(), ada, false),
        ]
    );
    assert_eq!(swept.touches, 4);

    // Thirty days: one fleetd MR merged by hand, three outside, one direct push; nothing through the train.
    let out = get(
        &hub,
        &admin(),
        json!({ "since": iso_ms(ms(NOW) - 30 * DAY), "tz": "UTC" }),
    )
    .await
    .unwrap();
    let m = &out.tiles.merged;
    assert_eq!(
        (
            m.by_route.train.get(),
            m.by_route.fleetd_by_hand.get(),
            m.by_route.outside.get(),
            m.by_route.direct.get()
        ),
        (0, 1, 3, 1)
    );
    let cov = &out.coverage.repos.as_slice()[0];
    assert_eq!(cov.host, fleetd_contracts::metrics::GitHost::GitLab);
    assert_eq!(
        cov.default_branch.as_ref().map(|b| b.as_str()),
        Some("main")
    );
    assert_eq!(
        cov.known_since.as_ref().map(|t| t.as_str().to_owned()),
        Some(iso_ms(ms(NOW) - 90 * DAY))
    );
    assert!(out.coverage.stale.is_empty());
}

#[tokio::test]
async fn the_gitlab_login_is_the_persons_and_only_its_acts_and_merges_count() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    let api = Arc::new(Recorded::default());
    sweep::sweep_repo(&hub, &source(&api), REPO, ms(NOW))
        .await
        .unwrap();
    let (ids, touches) = hub
        .db
        .with(|c| Ok((store::identities(c)?, store::touches(c, 0, i64::MAX)?)))
        .unwrap();
    assert_eq!(ids, ["ada-lovelace"], "the account GitLab is read as");
    let ids = human::Identities::new(&ids);
    let mut merges: Vec<(Option<i64>, Option<String>, bool)> = touches
        .iter()
        .filter(|t| t.kind == "merge.by_hand")
        .map(|t| (t.pr_number, t.key_id.clone(), human::attributed(t, &ids)))
        .collect();
    merges.sort();
    assert_eq!(
        merges,
        [
            (Some(30), Some("ada-lovelace".into()), true),
            (Some(41), Some("ada-lovelace".into()), true),
            (Some(43), Some("ada-lovelace".into()), true),
            (Some(48), Some("ada-lovelace".into()), true),
            (Some(50), Some("grace-hopper".into()), false),
        ]
    );
}

#[tokio::test]
async fn a_commit_pushed_after_the_last_read_is_read_back_to_the_last_head() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    let api = Arc::new(Recorded::default());
    let source = source(&api);
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW))
        .await
        .unwrap();
    *api.late_push.lock().unwrap() = true;
    sweep::sweep_repo(&hub, &source, REPO, ms(NOW) + HOUR)
        .await
        .unwrap();
    let late = format!("commit:{}", sha("c7"));
    assert_eq!(routes(&hub).get(&late), Some(&route("direct")));
    let history = api
        .runs()
        .into_iter()
        .rfind(|r| r.contains("/repository/commits?"))
        .unwrap();
    assert!(
        !history.contains("&since="),
        "read back to the last head, not by date: {history}"
    );
    assert!(
        history.contains("ref_name=main&first_parent=true"),
        "{history}"
    );
}

#[tokio::test]
async fn with_no_glab_login_and_no_token_the_view_says_to_log_in() {
    let (hub, _clock, _home) = hub();
    checkout(&hub);
    let api = Arc::new(Recorded::default());
    *api.no_login.lock().unwrap() = true;
    let why = sweep::sweep_repo(&hub, &source(&api), REPO, ms(NOW))
        .await
        .unwrap_err();
    assert_eq!(why, LOG_IN);
    assert!(rows(&hub).is_empty());
    let out = get(
        &hub,
        &admin(),
        json!({ "since": iso_ms(ms(NOW) - 7 * DAY), "tz": "UTC" }),
    )
    .await
    .unwrap();
    let stale = &out.coverage.stale.as_slice()[0];
    assert_eq!(stale.repo.as_str(), REPO);
    assert_eq!(
        stale.reason.as_str(),
        "GitLab not read: log in with `glab auth login`"
    );
}

#[tokio::test]
async fn a_self_hosted_gitlab_is_found_by_its_version_and_read_and_another_host_is_not() {
    let (hub, clock, _home) = hub();
    checkout(&hub);
    // Both as the sweep first sees them: on a host fleetd has no name for.
    let other = "git.internal/srv/tools";
    for repo in [REPO, other] {
        sql(
            &hub,
            "INSERT INTO metric_repos (repo, host) VALUES (?1, 'git')",
            &[&repo],
        );
    }
    let api = Arc::new(Recorded::default());
    hub.metrics.sweep.use_gitlab(api.clone());

    sweep::pass(&hub).await;
    let hosts: BTreeMap<String, String> = hub
        .db
        .with(|c| {
            let mut stmt = c.prepare("SELECT repo, host FROM metric_repos")?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(hosts[REPO], "gitlab");
    assert_eq!(hosts[other], "git");
    assert_eq!(api.count("projects/acme%2Fweb"), 1, "read once found");
    assert!(!routes(&hub).is_empty());
    assert_eq!(*api.versions.lock().unwrap(), ["git.internal", INSTANCE]);

    // A host that isn't GitLab is asked again after a day; one known as GitLab never again.
    clock.advance(Duration::from_secs(3 * 3600));
    sweep::pass(&hub).await;
    assert_eq!(api.versions.lock().unwrap().len(), 2);
    clock.advance(Duration::from_secs(24 * 3600));
    sweep::pass(&hub).await;
    assert_eq!(
        *api.versions.lock().unwrap(),
        ["git.internal", INSTANCE, "git.internal"]
    );
}

#[tokio::test]
async fn gitlab_com_needs_no_asking_and_a_locked_instance_is_still_gitlab() {
    assert_eq!(
        super::source::host_of("gitlab.com/acme/web"),
        "gitlab",
        "gitlab.com is known by name"
    );
    let (hub, _clock, _home) = hub();
    hub.metrics.sweep.use_gitlab(Arc::new(Recorded::default()));
    let source = hub
        .metrics
        .sweep
        .source("gitlab", "gitlab.com/acme/web")
        .unwrap();
    assert_eq!(source.host(), "gitlab");
    let api = Recorded::default();
    assert_eq!(gitlab::is_gitlab(&api, INSTANCE).await, Some(true));
    assert_eq!(
        gitlab::is_gitlab(&api, "gitlab.locked.example").await,
        Some(true),
        "GitLab's own 401 without credentials"
    );
    assert_eq!(gitlab::is_gitlab(&api, "git.internal").await, Some(false));
    assert_eq!(
        gitlab::is_gitlab(&api, "gitlab.down.example").await,
        None,
        "a server error says nothing either way"
    );
    assert_eq!(
        gitlab::is_gitlab(&api, "gitlab.flaky.example").await,
        None,
        "unreachable"
    );
}

#[test]
fn gitlabs_words_are_read_as_they_come() {
    assert_eq!(
        gitlab::split_remote("gitlab.example.com:8443/team/sub/api"),
        Some(("gitlab.example.com:8443", "team/sub/api")),
        "a key's port is the web port"
    );
    assert_eq!(
        gitlab::split_remote("gitlab.example.com/team/api"),
        Some(("gitlab.example.com", "team/api"))
    );
    assert_eq!(gitlab::split_remote("gitlab.com"), None);
    assert_eq!(
        gitlab::credential_password(
            "protocol=https\nhost=gitlab.example.com\nusername=oauth2\npassword=glpat-x\n"
        ),
        Some("glpat-x".to_owned())
    );
    assert_eq!(
        gitlab::credential_password("protocol=https\nhost=gitlab.example.com\n"),
        None
    );
    assert_eq!(
        gitlab::glab_status("glab: 404 Project Not Found (HTTP 404)\n"),
        Some(404)
    );
    assert_eq!(gitlab::glab_status("could not resolve host"), None);
}

#[tokio::test]
async fn gitlabs_refusals_say_what_to_do() {
    struct Status(u16, &'static str);
    impl GitLabApi for Status {
        fn get<'a>(&'a self, _: &'a str, _: &'a str) -> BoxFut<'a, Result<Reply, String>> {
            let reply = Reply {
                status: self.0,
                body: self.1.into(),
            };
            Box::pin(async move { Ok(reply) })
        }
        fn version<'a>(&'a self, _: &'a str) -> BoxFut<'a, Result<Reply, String>> {
            unreachable!()
        }
    }
    async fn read(status: u16, body: &'static str) -> String {
        let repo = RepoRef {
            remote: REPO.into(),
            path: "acme/web".into(),
        };
        GitLabSource::new(Arc::new(Status(status, body)), INSTANCE)
            .repo_info(&repo)
            .await
            .unwrap_err()
    }
    assert_eq!(read(401, r#"{"message":"401 Unauthorized"}"#).await, LOG_IN);
    assert!(
        read(403, r#"{"error":"insufficient_scope"}"#)
            .await
            .contains("read_api"),
    );
    assert!(
        read(404, r#"{"message":"404 Project Not Found"}"#)
            .await
            .contains("doesn't know this project")
    );
    assert_eq!(
        read(502, "Bad Gateway").await,
        "GitLab couldn't be read: HTTP 502"
    );
}

/// A test hub (`build_on`) and a lab hub (`FLEETD_HOST_SWEEP=off`) read no GitLab: no `glab`, no `/api/v4/version`
/// probe and no `git credential fill`, so a lab run needs no network and its coverage shows nothing stale.
#[tokio::test]
async fn a_hub_that_reads_no_host_makes_no_gitlab_calls() {
    let off = HostSources::for_hub(Some("off"));
    assert!(off.gitlab.is_none() && off.github.is_none());
    assert!(off.get("gitlab", REPO).is_none());
    let shipped = HostSources::for_hub(None);
    assert!(shipped.gitlab.is_some() && shipped.github.is_some());

    let (hub, clock, _home) = hub();
    checkout(&hub);
    for (repo, host) in [(REPO, "gitlab"), ("git.internal/srv/tools", "git")] {
        sql(
            &hub,
            "INSERT INTO metric_repos (repo, host) VALUES (?1, ?2)",
            &[&repo, &host],
        );
    }
    assert!(hub.metrics.sweep.source("gitlab", REPO).is_none());
    for _ in 0..2 {
        sweep::pass(&hub).await;
        clock.advance(Duration::from_secs(25 * 3600));
    }
    let repos: Vec<(String, String, Option<i64>, Option<String>)> = hub
        .db
        .with(|c| {
            let mut stmt = c.prepare(
                "SELECT repo, host, last_ok_ms, last_error FROM metric_repos ORDER BY repo",
            )?;
            let rows = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(
        repos,
        [
            (
                "git.internal/srv/tools".to_owned(),
                "git".to_owned(),
                None,
                None
            ),
            (REPO.to_owned(), "gitlab".to_owned(), None, None),
        ],
        "not probed, not read, no error"
    );
    assert!(rows(&hub).is_empty());
    let out = get(
        &hub,
        &admin(),
        json!({ "since": iso_ms(ms(NOW) - 7 * DAY), "tz": "UTC" }),
    )
    .await
    .unwrap();
    assert!(out.coverage.stale.is_empty());
}

/// A self-hosted GitLab on its own web port is read on that port; the port of an ssh clone is the ssh server's, and
/// is left out of the repo's key, so both clones of a repo on the default port are one repo.
#[test]
fn a_web_port_stays_in_the_key_and_an_ssh_port_does_not() {
    use super::source::remote_key;
    let key = |url: &str| remote_key(url).unwrap();
    assert_eq!(
        key("https://gitlab.example.com:8443/team/api.git"),
        "gitlab.example.com:8443/team/api"
    );
    assert_eq!(
        gitlab::split_remote(&key("https://gitlab.example.com:8443/team/api.git")),
        Some(("gitlab.example.com:8443", "team/api"))
    );
    for ssh in [
        "ssh://git@gitlab.example.com:2222/team/api.git",
        "git@gitlab.example.com:team/api.git",
        "https://gitlab.example.com/team/api.git",
    ] {
        assert_eq!(key(ssh), "gitlab.example.com/team/api", "{ssh}");
    }
}

/// A host that gave no answer when asked whether it is GitLab is asked again on the next pass, not a day later; one
/// that answered as something else waits the day.
#[tokio::test]
async fn an_unreachable_host_is_asked_again_and_only_a_clear_no_waits_a_day() {
    let (hub, clock, _home) = hub();
    let repo = "gitlab.flaky.example/team/api";
    sql(
        &hub,
        "INSERT INTO metric_repos (repo, host) VALUES (?1, 'git')",
        &[&repo],
    );
    let api = Arc::new(Recorded::default());
    hub.metrics.sweep.use_gitlab(api.clone());
    let asked = || *api.flaky.lock().unwrap();

    sweep::pass(&hub).await;
    assert_eq!(asked(), 1, "unreachable");
    clock.advance(Duration::from_secs(61));
    sweep::pass(&hub).await;
    assert_eq!(
        asked(),
        2,
        "asked again on the next pass: this time a clear no"
    );
    clock.advance(Duration::from_secs(3 * 3600));
    sweep::pass(&hub).await;
    assert_eq!(asked(), 2, "a clear no waits a day");
    clock.advance(Duration::from_secs(24 * 3600));
    sweep::pass(&hub).await;
    assert_eq!(asked(), 3);
    let host: String = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT host FROM metric_repos WHERE repo = ?1",
                [repo],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(host, "git");
}
