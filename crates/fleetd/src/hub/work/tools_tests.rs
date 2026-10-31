//! work_claim, work_list and work_done through the hub's tool registry, as a person's Claude Code session calls them:
//! exact matches refuse (and only a human key claims anyway), strong ones refuse once until `notDuplicateOf` says
//! why, weak ones are listed, the owner's own claim on a branch is renewed rather than claimed twice, and two claims
//! made at once can't both pass. The repo is on a host that isn't GitHub.
use std::sync::Arc;
use std::time::Duration;

use fleetd_contracts::auth::{Grant, KeyKind};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::mcp::{WorkClaimInput, WorkClaimStatus, WorkListInput};
use fleetd_contracts::prim::Line;
use fleetd_contracts::tasks::Task;
use fleetd_contracts::work::{RepoKey, WorkScope};
use serde_json::{Value, json};

use crate::hub::api::{self, CallError, Caller, Hub, HubConfig, Listen};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, WaitInput};
use crate::hub::tasks::records::TaskRecords;
use crate::hub::work::BoxFut;
use crate::hub::work::bind::{GitOut, NodeGit};

const REMOTE: &str = "git@gitlab.example.com:acme/shop.git";
const AT: &str = "2026-10-25T10:00:00.000Z";

fn hub() -> (Arc<Hub>, Arc<ManualClock>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let clock = ManualClock::at(1_792_922_400_000);
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    (hub, clock, home)
}

fn key(hub: &Hub, name: &str, kind: KeyKind) -> Caller {
    let grants: Vec<Grant> =
        serde_json::from_value(json!([{ "role": "operate", "machines": "*" }])).unwrap();
    hub.auth.create_key(name, &grants, kind).unwrap().info
}

async fn call(
    hub: &Arc<Hub>,
    caller: &Caller,
    tool: &str,
    input: Value,
) -> Result<Value, CallError> {
    api::registry().call(hub, caller, tool, input).await
}

async fn claim(hub: &Arc<Hub>, caller: &Caller, input: Value) -> Value {
    let mut input = input;
    input["repo"] = json!(REMOTE);
    call(hub, caller, "work_claim", input).await.unwrap()
}

fn refused(result: Result<Value, CallError>) -> fleetd_contracts::mcp::McpToolError {
    match result {
        Err(CallError::Tool(error)) => error,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn summaries(hub: &Hub, t: HubEventType) -> Vec<String> {
    let page = futures_util::FutureExt::now_or_never(hub.events.wait(WaitInput {
        cursor: Some(0),
        types: Some(vec![t]),
        machine_id: None,
        timeout_sec: 0,
    }))
    .unwrap()
    .unwrap();
    page.events
        .into_iter()
        .map(|e| e.summary.as_str().to_owned())
        .collect()
}

fn ids(answer: &Value) -> Vec<(String, String)> {
    answer["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["item"]["id"].as_str().unwrap().to_owned(),
                m["strength"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn shop() -> WorkScope {
    WorkScope {
        repo_key: RepoKey::of(REMOTE).unwrap(),
        base: Line::unchecked("main"),
    }
}

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("shop"),
    }
}

/// A lead's running writer on the shop, its project bound to the shop's repo and base.
fn lead_task(hub: &Hub, title: &str, branch: &str) -> Task {
    hub.work.bind_project(&project(), &shop()).unwrap();
    running_task(hub, title, branch)
}

fn running_task(hub: &Hub, title: &str, branch: &str) -> Task {
    let task: Task = serde_json::from_value(json!({
        "taskId": "T1", "projectRef": project(), "workstreamId": "W1", "title": title, "kind": "write",
        "prompt": "do it", "state": "running", "attempt": 1, "createdAt": AT, "branch": branch,
    }))
    .unwrap();
    hub.db.with(|c| Ok(TaskRecords::create(c, task)?)).unwrap()
}

#[tokio::test]
async fn a_claim_is_made_from_any_remote_form_and_the_same_branch_again_renews_it() {
    let (hub, _clock, _home) = hub();
    let laptop = key(&hub, "laptop", KeyKind::Agent);
    let first = claim(
        &hub,
        &laptop,
        json!({ "title": "dark mode toggle in settings", "branch": "ada/dark-mode",
                "changed": ["app/theme.ts"], "authorEmail": "ada@example.com" }),
    )
    .await;
    assert_eq!(first["status"], "claimed");
    assert_eq!(first["message"], "claimed C1");
    assert_eq!(first["claim"]["repoKey"], "gitlab.example.com/acme/shop");
    assert_eq!(first["claim"]["base"], "main", "nothing names a base: main");
    assert_eq!(
        first["claim"]["owner"]["kind"], "agent_key",
        "only a human key's claim is a person's"
    );
    assert_eq!(first["claim"]["owner"]["label"], "laptop");
    assert_eq!(first["claim"]["observed"]["paths"], json!(["app/theme.ts"]));
    assert!(first["next"].as_str().unwrap().contains("work_done"));

    let again = claim(
        &hub,
        &laptop,
        json!({ "title": "dark mode toggle, settings and header", "branch": "ada/dark-mode",
                "changed": ["app/theme.ts", "app/header.tsx"] }),
    )
    .await;
    assert_eq!(again["status"], "renewed");
    assert_eq!(again["claim"]["claimId"], "C1", "never claimed twice");
    assert_eq!(
        again["claim"]["title"],
        "dark mode toggle, settings and header"
    );
    assert_eq!(
        again["claim"]["observed"]["paths"],
        json!(["app/theme.ts", "app/header.tsx"])
    );
    assert_eq!(again["claim"]["authorEmail"], "ada@example.com", "kept");
    assert!(ids(&again).is_empty(), "its own claim is no match");

    let list = call(
        &hub,
        &laptop,
        "work_list",
        json!({ "repo": "https://gitlab.example.com/Acme/shop" }),
    )
    .await
    .unwrap();
    assert_eq!(list["scope"]["repoKey"], "gitlab.example.com/acme/shop");
    let items = list["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], "C1");
    assert_eq!(items[0]["keys"], json!([{ "branch": "ada/dark-mode" }]));
}

#[tokio::test]
async fn an_exact_match_is_taken_and_only_a_human_key_claims_it_anyway() {
    let (hub, _clock, _home) = hub();
    let laptop = key(&hub, "laptop", KeyKind::Agent);
    let desktop = key(&hub, "desktop", KeyKind::Human);
    let robot = key(&hub, "robot", KeyKind::Agent);
    lead_task(&hub, "search box on the header", "fleetd/T1-search");
    claim(
        &hub,
        &laptop,
        json!({ "title": "dark mode toggle", "keys": [{ "issue": "SHOP-12" }] }),
    )
    .await;

    let task = claim(
        &hub,
        &desktop,
        json!({ "title": "header search", "branch": "fleetd/T1-search" }),
    )
    .await;
    assert_eq!(task["status"], "taken");
    assert!(task["claim"].is_null());
    assert_eq!(
        task["message"],
        "taken by T1 (an agent of devbox/shop): search box on the header (same branch fleetd/T1-search; 2 shared words: header, search)"
    );
    assert!(task["next"].as_str().unwrap().contains("Tell the user"));

    // An issue key only written in the new claim's title may be a follow-up: strong, not exact. Declared, it's taken.
    let written = claim(&hub, &desktop, json!({ "title": "SHOP-12: theme switch" })).await;
    assert_eq!(written["status"], "possible_duplicate");
    assert_eq!(ids(&written)[0], ("C1".to_owned(), "strong".to_owned()));
    let person = claim(
        &hub,
        &desktop,
        json!({ "title": "theme switch", "keys": [{ "issue": "SHOP-12" }] }),
    )
    .await;
    assert_eq!(person["status"], "taken");
    assert_eq!(ids(&person)[0], ("C1".to_owned(), "exact".to_owned()));

    // An agent key, which a fleetd agent that loaded the person's MCP config holds too, never overrides a claim,
    // whatever it says about itself.
    let agent = claim(
        &hub,
        &robot,
        json!({ "title": "theme switch", "keys": [{ "issue": "SHOP-12" }], "anyway": true }),
    )
    .await;
    assert_eq!(agent["status"], "taken");
    assert!(
        agent["next"]
            .as_str()
            .unwrap()
            .contains("Only a person can claim taken work, with a human key")
    );
    // fleetd's own agent on its task's branch: the task holds the work, and nothing is claimed over it.
    let own_task = claim(
        &hub,
        &robot,
        json!({ "title": "header search", "branch": "fleetd/T1-search" }),
    )
    .await;
    assert_eq!(own_task["status"], "yours");
    assert_eq!(own_task["message"], "yours (task T1)");
    assert!(own_task["claim"].is_null());
    assert!(!ids(&own_task).iter().any(|(id, _)| id == "T1"));
    assert!(own_task["next"].as_str().unwrap().contains("Go on"));

    let anyway = claim(
        &hub,
        &desktop,
        json!({ "title": "theme switch", "keys": [{ "issue": "SHOP-12" }], "anyway": true }),
    )
    .await;
    assert_eq!(anyway["status"], "claimed");
    assert_eq!(anyway["claim"]["claimId"], "C2");
    assert_eq!(anyway["claim"]["owner"]["kind"], "human_session");
    assert!(
        summaries(&hub, HubEventType::WorkClaimed)[1].contains("anyway, though C1 holds it"),
        "the override is logged"
    );
}

#[tokio::test]
async fn a_strong_match_refuses_once_until_not_duplicate_of_says_why_and_weak_ones_are_listed() {
    let (hub, _clock, _home) = hub();
    let laptop = key(&hub, "laptop", KeyKind::Agent);
    let desktop = key(&hub, "desktop", KeyKind::Agent);
    claim(
        &hub,
        &laptop,
        json!({ "title": "dark mode toggle in settings" }),
    )
    .await;

    let strong = claim(
        &hub,
        &desktop,
        json!({ "title": "add a dark mode toggle to the settings page" }),
    )
    .await;
    assert_eq!(strong["status"], "possible_duplicate");
    assert_eq!(ids(&strong), [("C1".to_owned(), "strong".to_owned())]);
    assert!(
        strong["next"]
            .as_str()
            .unwrap()
            .contains(r#"notDuplicateOf: ["C1"]"#)
    );

    let no_reason = call(
        &hub,
        &desktop,
        "work_claim",
        json!({ "repo": REMOTE, "title": "add a dark mode toggle to the settings page", "notDuplicateOf": ["C1"] }),
    )
    .await;
    assert!(matches!(no_reason, Err(CallError::Invalid(m)) if m.contains("notDuplicateWhy")));

    let through = claim(
        &hub,
        &desktop,
        json!({ "title": "add a dark mode toggle to the settings page", "notDuplicateOf": ["C1"],
                "notDuplicateWhy": "C1 is the mobile app's settings" }),
    )
    .await;
    assert_eq!(through["status"], "claimed");
    assert_eq!(
        through["message"],
        "claimed C2 (not a duplicate of C1: C1 is the mobile app's settings)"
    );
    assert!(summaries(&hub, HubEventType::WorkClaimed)[1].contains("not a duplicate of C1"));

    let weak = claim(&hub, &desktop, json!({ "title": "dark sidebar mode" })).await;
    assert_eq!(weak["status"], "claimed", "weak matches never refuse");
    assert!(ids(&weak).contains(&("C1".to_owned(), "weak".to_owned())));
}

#[tokio::test]
async fn a_renewal_that_adds_someone_elses_issue_is_taken_and_a_plain_one_renews() {
    let (hub, _clock, _home) = hub();
    let laptop = key(&hub, "laptop", KeyKind::Agent);
    let desktop = key(&hub, "desktop", KeyKind::Agent);
    let phone = key(&hub, "phone", KeyKind::Human);
    claim(
        &hub,
        &desktop,
        json!({ "title": "checkout totals", "keys": [{ "issue": "SHOP-9" }] }),
    )
    .await;
    let mine = json!({ "title": "dark mode toggle", "branch": "ada/dark-mode", "keys": [{ "issue": "SHOP-12" }] });
    assert_eq!(
        claim(&hub, &laptop, mine.clone()).await["status"],
        "claimed"
    );

    let plain = claim(&hub, &laptop, mine).await;
    assert_eq!(plain["status"], "renewed", "the same keys: a plain renewal");

    let adds = claim(
        &hub,
        &laptop,
        json!({ "title": "dark mode toggle", "branch": "ada/dark-mode",
                "keys": [{ "issue": "SHOP-12" }, { "issue": "SHOP-9" }], "anyway": true }),
    )
    .await;
    assert_eq!(
        adds["status"], "taken",
        "an agent key can't add a held issue, anyway or not"
    );
    assert_eq!(ids(&adds)[0], ("C1".to_owned(), "exact".to_owned()));
    let c2 = hub
        .work
        .get(&fleetd_contracts::work::ClaimId::unchecked("C2"))
        .unwrap()
        .unwrap();
    assert_eq!(c2.keys.len(), 1, "the claim is left as it was");

    // A human key's own claim may take it anyway.
    let theirs = json!({ "title": "theme switch", "branch": "ada/theme" });
    assert_eq!(claim(&hub, &phone, theirs).await["status"], "claimed");
    let taken =
        json!({ "title": "theme switch", "branch": "ada/theme", "keys": [{ "issue": "SHOP-9" }] });
    assert_eq!(claim(&hub, &phone, taken.clone()).await["status"], "taken");
    let mut anyway = taken;
    anyway["anyway"] = json!(true);
    let renewed = claim(&hub, &phone, anyway).await;
    assert_eq!(renewed["status"], "renewed");
    assert_eq!(renewed["claim"]["keys"], json!([{ "issue": "SHOP-9" }]));
}

#[tokio::test]
async fn an_expired_claim_matches_as_weak_only() {
    let (hub, clock, _home) = hub();
    let laptop = key(&hub, "laptop", KeyKind::Agent);
    let desktop = key(&hub, "desktop", KeyKind::Agent);
    claim(
        &hub,
        &laptop,
        json!({ "title": "dark mode toggle", "branch": "ada/dark-mode" }),
    )
    .await;
    clock.advance(Duration::from_secs(13 * 3600));
    assert_eq!(hub.work.expire_due().unwrap(), 1);
    let after = claim(
        &hub,
        &desktop,
        json!({ "title": "dark mode toggle", "branch": "ada/dark-mode" }),
    )
    .await;
    assert_eq!(after["status"], "claimed");
    assert_eq!(ids(&after), [("C1".to_owned(), "weak".to_owned())]);
}

#[tokio::test]
async fn work_list_only_reads_and_takes_the_base_of_a_project_on_the_repo() {
    let (hub, clock, _home) = hub();
    let laptop = key(&hub, "laptop", KeyKind::Agent);
    let develop = WorkScope {
        base: Line::unchecked("develop"),
        ..shop()
    };
    hub.work.bind_project(&project(), &develop).unwrap();
    let made = claim(&hub, &laptop, json!({ "title": "dark mode toggle" })).await;
    assert_eq!(
        made["claim"]["base"], "develop",
        "the base its project lands on"
    );
    let expires = made["claim"]["expiresAt"].clone();

    clock.advance(Duration::from_secs(3600));
    let list = call(&hub, &laptop, "work_list", json!({ "repo": REMOTE }))
        .await
        .unwrap();
    assert_eq!(list["scope"]["base"], "develop");
    let c1 = || {
        hub.work
            .get(&fleetd_contracts::work::ClaimId::unchecked("C1"))
            .unwrap()
            .unwrap()
    };
    assert_eq!(json!(c1().expires_at), expires, "a read renews nothing");
    let again = claim(&hub, &laptop, json!({ "title": "dark mode toggle" })).await;
    assert_eq!(again["status"], "renewed");
    assert_ne!(
        json!(c1().expires_at),
        expires,
        "work_claim again renews it"
    );

    let main = call(
        &hub,
        &laptop,
        "work_list",
        json!({ "repo": REMOTE, "base": "main" }),
    )
    .await
    .unwrap();
    assert!(main["items"].as_array().unwrap().is_empty(), "another base");
}

/// The scanner's landings: whatever the scope asks for, cut to `limit`, as its store answers.
struct Landed(Vec<crate::hub::work::elsewhere::Landed>);

impl crate::hub::work::elsewhere::Landings for Landed {
    fn outside(
        &self,
        _scope: &WorkScope,
        since_ms: i64,
        limit: usize,
    ) -> Result<Vec<crate::hub::work::elsewhere::Landed>, crate::hub::store::StoreError> {
        Ok(self
            .0
            .iter()
            .filter(|l| l.at_ms >= since_ms)
            .take(limit)
            .cloned()
            .collect())
    }
}

#[tokio::test]
async fn work_list_shows_what_landed_outside_the_train_in_the_last_day() {
    use fleetd_contracts::verification::CommitSha;
    use fleetd_contracts::work::LandingRoute;

    let (hub, _clock, _home) = hub();
    let laptop = key(&hub, "laptop", KeyKind::Agent);
    let list = call(&hub, &laptop, "work_list", json!({ "repo": REMOTE }))
        .await
        .unwrap();
    assert_eq!(
        list["recentLandings"],
        json!([]),
        "none until the scanner is set"
    );

    let now = 1_792_922_400_000;
    hub.work.set_landings(Arc::new(Landed(vec![
        crate::hub::work::elsewhere::Landed {
            sha: CommitSha::unchecked("a".repeat(40)),
            at_ms: now - 60_000,
            route: LandingRoute::DirectPush,
            pr: None,
            subject: "feat: dark mode toggle".into(),
            author_email: Some("ada@example.com".into()),
            covers: vec!["P5".into()],
        },
        crate::hub::work::elsewhere::Landed {
            sha: CommitSha::unchecked("b".repeat(40)),
            at_ms: now - 25 * 3_600_000,
            route: LandingRoute::PrOutside,
            pr: Some("#57".into()),
            subject: "fix: older than a day".into(),
            author_email: None,
            covers: Vec::new(),
        },
    ])));
    let list = call(
        &hub,
        &laptop,
        "work_list",
        json!({ "repo": REMOTE, "paths": false }),
    )
    .await
    .unwrap();
    assert_eq!(
        list["recentLandings"],
        json!([{
            "sha": "a".repeat(40),
            "at": "2026-10-25T09:59:00.000Z",
            "route": "direct_push",
            "subject": "feat: dark mode toggle",
            "authorEmail": "ada@example.com",
            "covers": ["P5"],
        }]),
        "the last 24 h only, with the commit's time"
    );
}

#[tokio::test]
async fn a_call_names_a_repo_or_a_known_project() {
    let (hub, _clock, _home) = hub();
    let laptop = key(&hub, "laptop", KeyKind::Agent);
    let neither = call(&hub, &laptop, "work_list", json!({})).await;
    assert!(matches!(neither, Err(CallError::Invalid(m)) if m.contains("give repo")));
    let unknown = refused(
        call(
            &hub,
            &laptop,
            "work_claim",
            json!({ "projectRef": project(), "title": "x" }),
        )
        .await,
    );
    assert_eq!(unknown.code, fleetd_contracts::mcp::ErrorCode::NotFound);
    let not_a_remote = refused(call(&hub, &laptop, "work_list", json!({ "repo": " " })).await);
    assert!(not_a_remote.message.contains("is not a git remote"));
}

#[tokio::test]
async fn work_done_ends_the_owners_claim_and_a_human_key_may_end_anyones() {
    let (hub, _clock, _home) = hub();
    let laptop = key(&hub, "laptop", KeyKind::Agent);
    let robot = key(&hub, "robot", KeyKind::Agent);
    let phone = key(&hub, "phone", KeyKind::Human);
    claim(&hub, &laptop, json!({ "title": "dark mode toggle" })).await;
    claim(&hub, &laptop, json!({ "title": "search box" })).await;

    let other = refused(
        call(
            &hub,
            &robot,
            "work_done",
            json!({ "claimId": "C1", "outcome": "landed" }),
        )
        .await,
    );
    assert_eq!(other.code, fleetd_contracts::mcp::ErrorCode::Forbidden);

    let sha = "0123456789abcdef0123456789abcdef01234567";
    let landed = call(
        &hub,
        &laptop,
        "work_done",
        json!({ "claimId": "C1", "outcome": "landed", "landing": sha }),
    )
    .await
    .unwrap();
    assert_eq!(landed["claim"]["state"], "landed");
    assert_eq!(landed["claim"]["end"]["landing"], sha);
    let twice = refused(
        call(
            &hub,
            &laptop,
            "work_done",
            json!({ "claimId": "C1", "outcome": "dropped" }),
        )
        .await,
    );
    assert!(twice.message.contains("already ended: landed"));

    let dropped = call(
        &hub,
        &phone,
        "work_done",
        json!({ "claimId": "C2", "outcome": "dropped", "reason": "done in another PR" }),
    )
    .await
    .unwrap();
    assert_eq!(dropped["claim"]["state"], "released");
    assert_eq!(dropped["claim"]["end"]["reason"], "done in another PR");

    let missing = refused(
        call(
            &hub,
            &laptop,
            "work_done",
            json!({ "claimId": "C9", "outcome": "dropped" }),
        )
        .await,
    );
    assert_eq!(missing.code, fleetd_contracts::mcp::ErrorCode::NotFound);
    assert_eq!(summaries(&hub, HubEventType::WorkEnded).len(), 2);
}

/// The view is read before the claim is saved, with node lookups in between: a claim another session saved in that
/// time is seen where this one is saved, and refuses it as it would have.
#[tokio::test]
async fn a_claim_saved_while_another_was_checked_refuses_it() {
    let (hub, _clock, _home) = hub();
    let laptop = key(&hub, "laptop", KeyKind::Agent);
    let desktop = key(&hub, "desktop", KeyKind::Agent);
    let input: WorkClaimInput = serde_json::from_value(
        json!({ "repo": REMOTE, "title": "dark mode toggle", "branch": "ada/dark-mode" }),
    )
    .unwrap();
    let before = hub.work.in_flight(&shop()).await.unwrap();
    assert!(before.is_empty());

    let first = claim(
        &hub,
        &laptop,
        json!({ "title": "theme switch", "branch": "ada/dark-mode" }),
    )
    .await;
    assert_eq!(first["status"], "claimed");

    let second = super::tools::settle(&hub, &desktop, &input, &shop(), &before).unwrap();
    assert_eq!(second.status, WorkClaimStatus::Taken);
    assert!(second.claim.is_none());
    assert_eq!(second.matches[0].item.id.as_str(), "C1");
    assert!(
        hub.work
            .get(&fleetd_contracts::work::ClaimId::unchecked("C2"))
            .unwrap()
            .is_none(),
        "nothing saved"
    );
    assert_eq!(summaries(&hub, HubEventType::WorkClaimed).len(), 1);

    // With nothing in the way, the same stale view saves it.
    let other: WorkClaimInput = serde_json::from_value(
        json!({ "repo": REMOTE, "title": "search box", "branch": "ada/search" }),
    )
    .unwrap();
    let third = super::tools::settle(&hub, &desktop, &other, &shop(), &before).unwrap();
    assert_eq!(third.status, WorkClaimStatus::Claimed);
}

/// A node's git in a checkout of `remote` whose origin/HEAD is main; `None` stands for a node that is away.
struct FakeGit(Option<&'static str>);

impl NodeGit for FakeGit {
    fn git<'a>(
        &'a self,
        _machine: &'a MachineId,
        _cwd: &'a str,
        args: Vec<String>,
    ) -> BoxFut<'a, Option<GitOut>> {
        Box::pin(async move {
            let remote = self.0?;
            let has = |a: &str| args.iter().any(|x| x == a);
            let out = if has("remote.origin.url") {
                remote
            } else if has("refs/remotes/origin/HEAD") {
                "origin/main"
            } else {
                return Some(GitOut {
                    code: Some(1),
                    out: String::new(),
                });
            };
            Some(GitOut {
                code: Some(0),
                out: format!("{out}\n"),
            })
        })
    }
}

/// A project added before the ledger is in no scope until its repo and base are read. A call naming only its repo
/// reads them first, so a person's claim sees its agents' work; while its node is away, the answer says what it may
/// be missing.
#[tokio::test]
async fn a_repo_no_project_is_bound_to_reads_the_callers_unbound_projects_first() {
    let (hub, _clock, _home) = hub();
    let desktop = key(&hub, "desktop", KeyKind::Human);
    let laptop = key(&hub, "laptop", KeyKind::Human);
    hub.store
        .projects_upsert_many(
            &project().machine_id,
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "shop", "title": "shop", "workspaceRoot": "/work/shop",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    running_task(&hub, "search box on the header", "fleetd/T1-search");
    assert_eq!(hub.work.scope_of(&project()).unwrap(), None);
    let input: WorkClaimInput = serde_json::from_value(json!({
        "repo": "https://gitlab.example.com/acme/shop", "title": "header search", "branch": "fleetd/T1-search",
    }))
    .unwrap();

    let away = super::tools::claim_on(&hub, &desktop, &input, &FakeGit(None))
        .await
        .unwrap();
    assert_eq!(away.status, WorkClaimStatus::Claimed);
    assert_eq!(
        away.warning.as_deref(),
        Some("no project bound to gitlab.example.com/acme/shop yet; agents' work may be missing")
    );
    assert_eq!(hub.work.scope_of(&project()).unwrap(), None);

    let back = super::tools::claim_on(&hub, &laptop, &input, &FakeGit(Some(REMOTE)))
        .await
        .unwrap();
    assert_eq!(hub.work.scope_of(&project()).unwrap(), Some(shop()));
    assert_eq!(back.status, WorkClaimStatus::Taken);
    assert!(back.matches.iter().any(|m| m.item.id.as_str() == "T1"));
    assert_eq!(back.warning, None);

    let list: WorkListInput = serde_json::from_value(json!({ "repo": REMOTE })).unwrap();
    let listed = super::tools::list_on(&hub, &laptop, &list, &FakeGit(None))
        .await
        .unwrap();
    assert_eq!(listed.warning, None);
    assert!(listed.items.iter().any(|i| i.id.as_str() == "T1"));
}
