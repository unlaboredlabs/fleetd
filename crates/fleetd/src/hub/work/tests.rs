//! The work ledger over a real in-memory hub: claims are numbered, renewed, ended and expired by the sweep with
//! their events; the in-flight view reads every project on a repo's base and nothing else, shows a writer once, and
//! carries each writer's changed paths. The repo is on a host that isn't GitHub wherever the source allows it.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadRef};
use fleetd_contracts::prim::{Line, List};
use fleetd_contracts::tasks::Task;
use fleetd_contracts::train::Change;
use fleetd_contracts::work::{
    CLAIM_TTL_MS, ClaimObserved, ClaimOwner, ClaimOwnerKind, ClaimState, EXPIRED_SHOWN_MS, RepoKey,
    WorkItem, WorkItemKind, WorkKey, WorkPath, WorkScope,
};
use serde_json::{Value, json};

use super::*;
use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, WaitInput, parse_ms};

const AT: &str = "2026-10-25T10:00:00.000Z";
const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

fn hub() -> (Arc<Hub>, Arc<ManualClock>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let clock = ManualClock::at(1_792_922_400_000);
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    (hub, clock, home)
}

fn project(machine: &str, id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked(machine),
        project_id: ProjectId::unchecked(id),
    }
}

fn scope(remote: &str, base: &str) -> WorkScope {
    WorkScope {
        repo_key: RepoKey::of(remote).unwrap(),
        base: Line::new(base).unwrap(),
    }
}

fn human() -> ClaimOwner {
    ClaimOwner {
        kind: ClaimOwnerKind::HumanSession,
        key_id: Line::unchecked("k7"),
        label: Some(Line::unchecked("laptop")),
    }
}

fn new_claim(scope: &WorkScope, title: &str) -> NewClaim {
    NewClaim {
        scope: scope.clone(),
        project_ref: None,
        owner: human(),
        title: Line::new(title).unwrap(),
        keys: List::unchecked(vec![WorkKey::Issue(Line::unchecked("SHOP-12"))]),
        branch: Some(Line::unchecked("ada/dark-mode")),
        paths: List::unchecked(vec![WorkPath::unchecked("app/theme.ts")]),
        author_email: Some(Line::unchecked("ada@example.com")),
    }
}

fn events_of(hub: &Hub, t: HubEventType) -> Vec<Value> {
    let page = futures_util::FutureExt::now_or_never(hub.events.wait(WaitInput {
        cursor: Some(0),
        types: Some(vec![t]),
        machine_id: None,
        timeout_sec: 0,
    }))
    .unwrap()
    .unwrap();
    page.events.into_iter().filter_map(|e| e.data).collect()
}

fn task(
    hub: &Hub,
    project: &ProjectRef,
    title: &str,
    kind: &str,
    state: &str,
    extra: Value,
) -> Task {
    let mut data = json!({
        "taskId": "T1", "projectRef": project, "workstreamId": "W1", "title": title, "kind": kind,
        "prompt": "do it", "state": state, "attempt": 1, "createdAt": AT,
    });
    data.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let task: Task = serde_json::from_value(data).unwrap();
    hub.db.with(|c| Ok(TaskRecords::create(c, task)?)).unwrap()
}

fn change(hub: &Hub, project: &ProjectRef, task: Option<&Task>, pr: u32, state: &str) -> Change {
    let change: Change = serde_json::from_value(json!({
        "changeId": "X1", "projectRef": project, "repo": "acme/shop", "prNumber": pr,
        "prUrl": format!("https://github.com/acme/shop/pull/{pr}"),
        "branch": task.and_then(|t| t.branch.clone()).map_or(format!("pr-{pr}"), |b| b.as_str().to_owned()),
        "taskId": task.map(|t| t.task_id.clone()), "workstreamId": "W1", "headSha": SHA, "state": state,
        "reviews": [], "createdAt": AT, "updatedAt": AT,
    }))
    .unwrap();
    hub.train.records().create(change)
}

/// A Change on `repo` (`owner/name`); the train's PR URL is GitHub's, whichever host the project's remote names.
fn change_on(hub: &Hub, project: &ProjectRef, repo: &str, pr: u32) -> Change {
    let change: Change = serde_json::from_value(json!({
        "changeId": "X1", "projectRef": project, "repo": repo, "prNumber": pr,
        "prUrl": format!("https://github.com/{repo}/pull/{pr}"), "branch": format!("pr-{pr}"),
        "workstreamId": "W1", "headSha": SHA, "state": "queued", "reviews": [], "createdAt": AT, "updatedAt": AT,
    }))
    .unwrap();
    hub.train.records().create(change)
}

fn ids(items: &[WorkItem]) -> Vec<&str> {
    let mut ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
    ids.sort();
    ids
}

#[tokio::test]
async fn a_claim_is_numbered_good_for_12_hours_and_announced() {
    let (hub, _clock, _home) = hub();
    let shop = scope("git@gitlab.example.com:acme/shop.git", "main");
    let claim = hub
        .work
        .claim(new_claim(&shop, "dark mode toggle in settings"))
        .unwrap();
    assert_eq!(claim.claim_id.as_str(), "C1");
    assert_eq!(claim.state, ClaimState::Active);
    assert_eq!(claim.repo_key.as_str(), "gitlab.example.com/acme/shop");
    assert_eq!(
        parse_ms(claim.expires_at.as_str()).unwrap() - parse_ms(claim.created_at.as_str()).unwrap(),
        CLAIM_TTL_MS
    );
    assert_eq!(hub.work.get(&claim.claim_id).unwrap().unwrap(), claim);
    let second = hub.work.claim(new_claim(&shop, "search box")).unwrap();
    assert_eq!(second.claim_id.as_str(), "C2");

    let claimed = events_of(&hub, HubEventType::WorkClaimed);
    assert_eq!(claimed.len(), 2);
    assert_eq!(claimed[0]["claimId"], "C1");
    assert_eq!(claimed[0]["repoKey"], "gitlab.example.com/acme/shop");
    assert_eq!(claimed[0]["ownerKind"], "human_session");
    assert_eq!(claimed[0]["state"], "active");
}

#[tokio::test]
async fn a_renewal_extends_a_claim_and_keeps_what_its_branch_changed() {
    let (hub, clock, _home) = hub();
    let shop = scope("https://git.example.org/acme/shop", "main");
    let claim = hub
        .work
        .claim(new_claim(&shop, "dark mode toggle"))
        .unwrap();
    clock.advance(Duration::from_secs(3600));
    let observed = ClaimObserved {
        paths: List::unchecked(vec![WorkPath::unchecked("app/settings/page.tsx")]),
        head_sha: Some(CommitSha::unchecked(SHA)),
        at: Timestamp(iso_ms(now_ms(clock.as_ref()))),
    };
    let renewed = hub
        .work
        .renew(&claim.claim_id, Some(observed.clone()))
        .unwrap()
        .unwrap();
    assert_eq!(
        parse_ms(renewed.expires_at.as_str()).unwrap(),
        now_ms(clock.as_ref()) + CLAIM_TTL_MS
    );
    assert_eq!(renewed.observed, Some(observed.clone()));
    let again = hub.work.renew(&claim.claim_id, None).unwrap().unwrap();
    assert_eq!(
        again.observed,
        Some(observed),
        "a renewal without paths keeps the last ones"
    );
}

#[tokio::test]
async fn an_ended_claim_stays_ended_and_says_how_it_ended() {
    let (hub, _clock, _home) = hub();
    let shop = scope("git@bitbucket.org:acme/shop.git", "main");
    let landed = hub
        .work
        .claim(new_claim(&shop, "dark mode toggle"))
        .unwrap();
    let ended = hub
        .work
        .end(
            &landed.claim_id,
            Ending::Landed,
            "abc1234 landed on main",
            Some(CommitSha::unchecked(SHA)),
        )
        .unwrap()
        .unwrap();
    assert_eq!(ended.state, ClaimState::Landed);
    assert_eq!(
        ended
            .end
            .as_ref()
            .unwrap()
            .landing
            .as_ref()
            .unwrap()
            .as_str(),
        SHA
    );
    assert!(
        hub.work.renew(&landed.claim_id, None).unwrap().is_none(),
        "a landed claim is not renewed"
    );
    assert!(
        hub.work
            .end(&landed.claim_id, Ending::Released, "dropped", None)
            .unwrap()
            .is_none(),
        "it ends once"
    );
    assert!(
        hub.work
            .end(
                &ClaimId::unchecked("C99"),
                Ending::Released,
                "dropped",
                None
            )
            .unwrap()
            .is_none()
    );

    let ended = events_of(&hub, HubEventType::WorkEnded);
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0]["state"], "landed");
    assert_eq!(ended[0]["landing"], SHA);
    assert_eq!(ended[0]["reason"], "abc1234 landed on main");
}

#[tokio::test]
async fn revoking_an_owner_releases_only_its_active_claims() {
    let (hub, _clock, _home) = hub();
    let shop = scope("git@gitlab.example.com:acme/shop.git", "main");
    let a = hub
        .work
        .claim(new_claim(&shop, "dark mode toggle"))
        .unwrap();
    let b = hub.work.claim(new_claim(&shop, "search box")).unwrap();
    hub.work
        .end(&b.claim_id, Ending::Landed, "landed", None)
        .unwrap();
    let mut other = new_claim(&shop, "checkout flow");
    other.owner.key_id = Line::unchecked("k8");
    let c = hub.work.claim(other).unwrap();

    let released = hub.work.release_owner("k7", "key revoked").unwrap();
    assert_eq!(released.len(), 1);
    assert_eq!(released[0].claim_id, a.claim_id);
    assert_eq!(
        hub.work.get(&a.claim_id).unwrap().unwrap().state,
        ClaimState::Released
    );
    assert_eq!(
        hub.work.get(&b.claim_id).unwrap().unwrap().state,
        ClaimState::Landed
    );
    assert_eq!(
        hub.work.get(&c.claim_id).unwrap().unwrap().state,
        ClaimState::Active
    );
}

#[tokio::test]
async fn the_sweep_expires_a_claim_not_renewed_and_the_view_keeps_it_a_day() {
    let (hub, clock, _home) = hub();
    let shop = scope("git@gitlab.example.com:acme/shop.git", "main");
    let stale = hub
        .work
        .claim(new_claim(&shop, "dark mode toggle"))
        .unwrap();
    clock.advance(Duration::from_secs(6 * 3600));
    let fresh = hub.work.claim(new_claim(&shop, "search box")).unwrap();
    clock.advance(Duration::from_secs(6 * 3600));
    hub.sweep.run_once().await;

    assert_eq!(
        hub.work.get(&stale.claim_id).unwrap().unwrap().state,
        ClaimState::Expired
    );
    assert_eq!(
        hub.work.get(&fresh.claim_id).unwrap().unwrap().state,
        ClaimState::Active
    );
    let ended = events_of(&hub, HubEventType::WorkEnded);
    assert_eq!(ended.len(), 1);
    assert_eq!(
        (ended[0]["claimId"].as_str(), ended[0]["state"].as_str()),
        (Some("C1"), Some("expired"))
    );
    assert_eq!(ended[0]["reason"], "not renewed for 12 h");
    hub.sweep.run_once().await;
    assert_eq!(
        events_of(&hub, HubEventType::WorkEnded).len(),
        1,
        "expired once"
    );

    let items = hub.work.in_flight(&shop).await.unwrap();
    let states: Vec<(&str, &str)> = items
        .iter()
        .map(|i| (i.id.as_str(), i.state.as_str()))
        .collect();
    assert_eq!(
        states,
        [("C2", "active"), ("C1", "expired")],
        "an expired claim comes last"
    );

    clock.advance(Duration::from_millis(EXPIRED_SHOWN_MS as u64));
    hub.sweep.run_once().await;
    let items = hub.work.in_flight(&shop).await.unwrap();
    let states: Vec<(&str, &str)> = items
        .iter()
        .map(|i| (i.id.as_str(), i.state.as_str()))
        .collect();
    assert_eq!(
        states,
        [("C2", "expired")],
        "C1 expired over a day ago, C2 just now"
    );
}

#[tokio::test]
async fn renewing_an_expired_claim_makes_it_active_again() {
    let (hub, clock, _home) = hub();
    let shop = scope("git@gitlab.example.com:acme/shop.git", "main");
    let claim = hub
        .work
        .claim(new_claim(&shop, "dark mode toggle"))
        .unwrap();
    clock.advance(Duration::from_millis(CLAIM_TTL_MS as u64));
    assert_eq!(hub.work.expire_due().unwrap(), 1);
    let renewed = hub.work.renew(&claim.claim_id, None).unwrap().unwrap();
    assert_eq!(renewed.state, ClaimState::Active);
    assert!(renewed.end.is_none());
    assert_eq!(
        events_of(&hub, HubEventType::WorkClaimed).len(),
        2,
        "claimed, then active again"
    );
    assert_eq!(hub.work.expire_due().unwrap(), 0);
}

#[tokio::test]
async fn a_project_is_bound_to_one_repo_and_base() {
    let (hub, _clock, _home) = hub();
    let app = project("devbox", "app");
    assert!(hub.work.scope_of(&app).unwrap().is_none());
    hub.work
        .bind_project(&app, &scope("git@github.com:acme/shop.git", "main"))
        .unwrap();
    hub.work
        .bind_project(&app, &scope("git@github.com:acme/shop.git", "trunk"))
        .unwrap();
    assert_eq!(
        hub.work.scope_of(&app).unwrap(),
        Some(scope("https://github.com/acme/shop", "trunk"))
    );
}

/// Two projects on two machines share acme/shop's main; a third works on another base, a fourth on another repo.
fn shared_repo(hub: &Hub) -> (WorkScope, ProjectRef, ProjectRef) {
    let shop = scope("git@github.com:acme/shop.git", "main");
    let (app, web) = (project("devbox", "app"), project("laptop", "web"));
    hub.work.bind_project(&app, &shop).unwrap();
    hub.work
        .bind_project(&web, &scope("https://github.com/Acme/Shop", "main"))
        .unwrap();
    hub.work
        .bind_project(
            &project("devbox", "slot1"),
            &scope("git@github.com:acme/shop.git", "slot/1/main"),
        )
        .unwrap();
    hub.work
        .bind_project(
            &project("devbox", "blog"),
            &scope("git@github.com:acme/blog.git", "main"),
        )
        .unwrap();
    (shop, app, web)
}

#[tokio::test]
async fn the_view_reads_every_project_on_the_repos_base_and_nothing_else() {
    let (hub, _clock, _home) = hub();
    let (shop, app, web) = shared_repo(&hub);
    let ours = task(
        &hub,
        &app,
        "dark mode toggle",
        "write",
        "running",
        json!({ "branch": "fleetd/T1-dark-mode", "itemId": "P5" }),
    );
    let theirs = task(&hub, &web, "search box", "write", "queued", json!({}));
    task(
        &hub,
        &project("devbox", "slot1"),
        "slot work",
        "write",
        "running",
        json!({}),
    );
    task(
        &hub,
        &project("devbox", "blog"),
        "blog work",
        "write",
        "running",
        json!({}),
    );
    task(&hub, &app, "read the code", "read", "running", json!({}));
    task(&hub, &app, "finished", "write", "done", json!({}));
    let mut claim = new_claim(&shop, "checkout flow");
    claim.project_ref = Some(web.clone());
    hub.work.claim(claim).unwrap();
    hub.work
        .claim(new_claim(
            &scope("git@github.com:acme/shop.git", "slot/1/main"),
            "slot claim",
        ))
        .unwrap();

    let items = hub.work.in_flight(&shop).await.unwrap();
    assert_eq!(
        ids(&items),
        ["C1", ours.task_id.as_str(), theirs.task_id.as_str()]
    );
    let dark = items
        .iter()
        .find(|i| i.task_id.as_ref() == Some(&ours.task_id))
        .unwrap();
    assert_eq!(dark.kind, WorkItemKind::Task);
    assert_eq!(dark.state, "running");
    assert_eq!(dark.project_ref.as_ref(), Some(&app));
    assert_eq!(
        dark.keys.to_vec(),
        [
            WorkKey::Item(fleetd_contracts::plan::PlanItemId::unchecked("P5")),
            WorkKey::Branch(Line::unchecked("fleetd/T1-dark-mode"))
        ]
    );
    let claim = items
        .iter()
        .find(|i| i.kind == WorkItemKind::Claim)
        .unwrap();
    assert_eq!(
        claim.owner.as_ref().unwrap().kind,
        ClaimOwnerKind::HumanSession
    );
    assert_eq!(
        claim.keys.to_vec(),
        [
            WorkKey::Issue(Line::unchecked("SHOP-12")),
            WorkKey::Branch(Line::unchecked("ada/dark-mode"))
        ],
        "a claim's branch is one of its keys"
    );
    assert_eq!(claim.paths.to_vec(), [WorkPath::unchecked("app/theme.ts")]);

    assert!(
        hub.work
            .in_flight(&scope("git@github.com:acme/other.git", "main"))
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_writer_appears_once_its_change_takes_over_until_it_merges() {
    let (hub, _clock, _home) = hub();
    let (shop, app, _web) = shared_repo(&hub);
    let enqueued = task(
        &hub,
        &app,
        "dark mode toggle",
        "write",
        "idle",
        json!({ "branch": "fleetd/T1-dark-mode", "itemId": "P5" }),
    );
    let x = change(&hub, &app, Some(&enqueued), 41, "ci");
    let abandoned = task(
        &hub,
        &app,
        "search box",
        "write",
        "idle",
        json!({ "branch": "fleetd/T2-search" }),
    );
    change(&hub, &app, Some(&abandoned), 42, "abandoned");
    let gone = task(&hub, &app, "merged one", "write", "done", json!({}));
    change(&hub, &app, Some(&gone), 43, "merged");
    let lead_pr = change(&hub, &app, None, 44, "queued");
    let refused = change(&hub, &app, None, 45, "refused");

    let items = hub.work.in_flight(&shop).await.unwrap();
    assert_eq!(
        ids(&items),
        [
            abandoned.task_id.as_str(),
            x.change_id.as_str(),
            lead_pr.change_id.as_str(),
            refused.change_id.as_str()
        ]
    );
    let ci = items
        .iter()
        .find(|i| i.change_id.as_ref() == Some(&x.change_id))
        .unwrap();
    assert_eq!(ci.kind, WorkItemKind::Change);
    assert_eq!(
        (ci.title.as_str(), ci.state.as_str()),
        ("dark mode toggle", "ci")
    );
    assert_eq!(ci.task_id.as_ref(), Some(&enqueued.task_id));
    assert!(ci.keys.contains(&WorkKey::Item(
        fleetd_contracts::plan::PlanItemId::unchecked("P5")
    )));
    assert!(
        ci.keys
            .contains(&WorkKey::Branch(Line::unchecked("fleetd/T1-dark-mode")))
    );
    let by_lead = items
        .iter()
        .find(|i| i.change_id.as_ref() == Some(&lead_pr.change_id))
        .unwrap();
    assert_eq!(
        by_lead.title, "#44 pr-44",
        "a PR no task wrote is named by number and branch"
    );
}

struct FakePaths(HashMap<String, Vec<String>>);

impl WorkPorts for FakePaths {
    fn changed_paths<'a>(&'a self, thread: &'a ThreadRef) -> BoxFut<'a, Option<Vec<String>>> {
        Box::pin(async move { self.0.get(thread.thread_id.as_str()).cloned() })
    }
}

#[tokio::test]
async fn each_writer_carries_the_paths_it_has_changed_so_far() {
    let (hub, _clock, _home) = hub();
    let (shop, app, _web) = shared_repo(&hub);
    let thread = |id: &str| json!({ "machineId": "devbox", "threadId": id });
    let running = task(
        &hub,
        &app,
        "dark mode toggle",
        "write",
        "running",
        json!({ "threadRef": thread("th1") }),
    );
    let enqueued = task(
        &hub,
        &app,
        "search box",
        "write",
        "done",
        json!({ "threadRef": thread("th2") }),
    );
    change(&hub, &app, Some(&enqueued), 41, "reviewing");
    let unknown = task(
        &hub,
        &app,
        "offline one",
        "write",
        "running",
        json!({ "threadRef": thread("th3") }),
    );
    let work = Work::new(
        hub.db.clone(),
        hub.events.clone(),
        hub.clock.clone(),
        Arc::new(FakePaths(HashMap::from([
            (
                "th1".to_owned(),
                vec![
                    "app/theme.ts".to_owned(),
                    "app/theme.ts".to_owned(),
                    String::new(),
                ],
            ),
            ("th2".to_owned(), vec!["app/search.ts".to_owned()]),
        ]))),
    );
    let items = work.in_flight(&shop).await.unwrap();
    let paths = |task: &Task| -> Vec<String> {
        items
            .iter()
            .find(|i| i.task_id.as_ref() == Some(&task.task_id))
            .unwrap()
            .paths
            .iter()
            .map(|p| p.as_str().to_owned())
            .collect()
    };
    assert_eq!(
        paths(&running),
        ["app/theme.ts"],
        "deduplicated, empty paths dropped"
    );
    assert_eq!(
        paths(&enqueued),
        ["app/search.ts"],
        "a Change carries its writer's paths"
    );
    assert!(
        paths(&unknown).is_empty(),
        "a node that could not say gives no paths"
    );
}

#[tokio::test]
async fn a_change_is_matched_to_its_repo_on_any_host() {
    let (hub, _clock, _home) = hub();
    for (n, remote) in [
        "git@gitlab.example.com:Acme/Shop.git",
        "https://ghe.example.com/acme/shop",
        "ssh://git@gitea.example.com:2222/acme/shop.git",
    ]
    .into_iter()
    .enumerate()
    {
        let app = project("devbox", &format!("app{n}"));
        let shop = scope(remote, "main");
        hub.work.bind_project(&app, &shop).unwrap();
        let ours = change_on(&hub, &app, "acme/shop", 40);
        change_on(&hub, &app, "acme/blog", 41);
        let items = hub.work.in_flight(&shop).await.unwrap();
        assert_eq!(ids(&items), [ours.change_id.as_str()], "{remote}");
    }
}
