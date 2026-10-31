//! What a lead reads of the work that isn't its own, over a real in-memory hub: the digest's Elsewhere section.
//! Landings come from a fake source, as the landing scanner will give them.
use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::prim::{Line, List};
use fleetd_contracts::tasks::Task;
use fleetd_contracts::verification::CommitSha;
use fleetd_contracts::work::{
    ClaimOwner, ClaimOwnerKind, LandingRoute, RepoKey, WorkKey, WorkPath, WorkScope,
};
use serde_json::json;

use super::elsewhere::{Landed, Landings};
use super::{NewClaim, store};
use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, StoreError, now_ms};
use crate::hub::tasks::records::TaskRecords;

const AT: &str = "2026-10-25T10:00:00.000Z";
const PUSHED: &str = "abc1234def5678abc1234def5678abc1234def56";
const MERGED: &str = "fed9876cba5432fed9876cba5432fed9876cba54";

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

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
    }
}

fn shop() -> WorkScope {
    WorkScope {
        repo_key: RepoKey::of("git@gitlab.example.com:acme/shop.git").unwrap(),
        base: Line::unchecked("main"),
    }
}

/// Landings as the scanner records them, newest first.
struct Fake(Vec<(WorkScope, Landed)>);

impl Landings for Fake {
    fn outside(
        &self,
        scope: &WorkScope,
        since_ms: i64,
        limit: usize,
    ) -> Result<Vec<Landed>, StoreError> {
        Ok(self
            .0
            .iter()
            .filter(|(s, l)| s == scope && l.at_ms >= since_ms && l.route != LandingRoute::Train)
            .map(|(_, l)| l.clone())
            .take(limit)
            .collect())
    }
}

fn landed(sha: &str, at_ms: i64, route: LandingRoute, subject: &str) -> Landed {
    Landed {
        sha: CommitSha::unchecked(sha),
        at_ms,
        route,
        pr: (route == LandingRoute::PrOutside).then(|| "#57".into()),
        subject: subject.into(),
        author_email: Some("ada@example.com".into()),
        covers: Vec::new(),
    }
}

fn landings(hub: &Hub, clock: &ManualClock) {
    let now = now_ms(clock);
    hub.work.set_landings(Arc::new(Fake(vec![
        (
            shop(),
            Landed {
                covers: vec!["P9".into()],
                ..landed(
                    PUSHED,
                    now - 60_000,
                    LandingRoute::DirectPush,
                    "feat: dark mode toggle",
                )
            },
        ),
        (
            shop(),
            landed(
                &"1".repeat(40),
                now - 120_000,
                LandingRoute::Train,
                "fix: the train's own merge",
            ),
        ),
        (
            shop(),
            landed(
                MERGED,
                now - 3_600_000,
                LandingRoute::PrOutside,
                "Search box on the catalog",
            ),
        ),
        (
            shop(),
            landed(
                &"2".repeat(40),
                now - 30 * 3_600_000,
                LandingRoute::DirectPush,
                "an old push",
            ),
        ),
    ])));
}

fn task(hub: &Hub, project: &ProjectRef, title: &str) -> Task {
    let task: Task = serde_json::from_value(json!({
        "taskId": "T1", "projectRef": project, "workstreamId": "W1", "title": title, "kind": "write",
        "prompt": "do it", "state": "running", "attempt": 1, "createdAt": AT,
    }))
    .unwrap();
    hub.db.with(|c| Ok(TaskRecords::create(c, task)?)).unwrap()
}

fn claim(hub: &Hub, owner: ClaimOwner, title: &str, keys: Vec<WorkKey>) -> super::ClaimId {
    hub.work
        .claim(NewClaim {
            scope: shop(),
            project_ref: None,
            owner,
            title: Line::new(title).unwrap(),
            keys: List::unchecked(keys),
            branch: None,
            paths: List::unchecked(vec![WorkPath::unchecked("app/theme.ts")]),
            author_email: None,
        })
        .unwrap()
        .claim_id
}

fn lead_of(project: &ProjectRef) -> ClaimOwner {
    ClaimOwner {
        kind: ClaimOwnerKind::Lead,
        key_id: Line::unchecked(format!("{}/{}", project.machine_id, project.project_id)),
        label: None,
    }
}

/// The digest's Elsewhere section, without its heading; `None` when the digest leaves it out.
async fn elsewhere(hub: &Hub, r: &ProjectRef) -> Option<String> {
    let digest = hub.leads.wakes.digest(r).await.unwrap();
    let (_, rest) = digest.split_once("## Elsewhere\n")?;
    Some(rest.split("\n\n## ").next().unwrap().to_owned())
}

#[tokio::test]
async fn the_digest_shows_work_elsewhere_on_its_repo_and_base_and_none_of_its_own() {
    let (hub, clock, _home) = hub();
    let (app, api, docs) = (project("app"), project("api"), project("docs"));
    assert_eq!(
        elsewhere(&hub, &app).await,
        None,
        "a project whose repo and base aren't known has no section"
    );
    hub.work.bind_project(&app, &shop()).unwrap();
    assert_eq!(
        elsewhere(&hub, &app).await,
        None,
        "nor one with nothing elsewhere"
    );

    hub.work.bind_project(&api, &shop()).unwrap();
    let other_base = WorkScope {
        base: Line::unchecked("release"),
        ..shop()
    };
    hub.work.bind_project(&docs, &other_base).unwrap();
    task(&hub, &app, "own writer: settings page");
    let theirs = task(&hub, &api, "rate limits on the search API");
    task(&hub, &docs, "release notes");
    claim(&hub, lead_of(&app), "held back by this lead", vec![]);
    claim(&hub, lead_of(&api), "checkout retries", vec![]);
    let gone = claim(
        &hub,
        ClaimOwner {
            kind: ClaimOwnerKind::AgentKey,
            key_id: Line::unchecked("k9"),
            label: None,
        },
        "an old experiment",
        vec![],
    );
    hub.db
        .with(|c| {
            let mut gone = store::get(c, &gone)?.unwrap();
            gone.expires_at = fleetd_contracts::ids::Timestamp("2026-10-24T00:00:00.000Z".into());
            Ok(store::put(c, &gone)?)
        })
        .unwrap();
    hub.work.expire_due().unwrap();
    clock.advance(std::time::Duration::from_secs(60));
    let human = claim(
        &hub,
        ClaimOwner {
            kind: ClaimOwnerKind::HumanSession,
            key_id: Line::unchecked("k7"),
            label: Some(Line::unchecked("laptop")),
        },
        "dark mode toggle in settings",
        vec![WorkKey::Issue(Line::unchecked("SHOP-12"))],
    );
    landings(&hub, &clock);

    let section = elsewhere(&hub, &app).await.unwrap();
    let lines: Vec<&str> = section.lines().collect();
    assert_eq!(
        lines,
        [
            &format!(
                "- {human} claimed by a person (laptop): dark mode toggle in settings · on SHOP-12"
            ),
            &format!(
                "- {} writer of devbox/api, running: rate limits on the search API",
                theirs.task_id
            ),
            "- C2 claimed by the lead of devbox/api: checkout retries",
            "- abc1234 pushed straight to main, outside fleetd by ada@example.com: feat: dark mode toggle · covers P9",
            "- fed9876 PR #57 merged outside fleetd by ada@example.com: Search box on the catalog",
            &format!("- {gone} expired claim by an agent key: an old experiment"),
        ],
        "a person's claims first, then other projects' work, landings outside the train from the last day, and \
         expired claims last; never this project's own work, another base's, or the train's landings"
    );
    assert!(
        !section.contains("own writer") && !section.contains("held back"),
        "{section}"
    );

    let api_view = elsewhere(&hub, &api).await.unwrap();
    assert!(
        api_view.contains("writer of devbox/app, running: own writer: settings page"),
        "{api_view}"
    );
    assert!(
        api_view.contains("C1 claimed by the lead of devbox/app"),
        "{api_view}"
    );
    assert!(!api_view.contains("C2 "), "{api_view}");
}

#[tokio::test]
async fn a_long_elsewhere_keeps_the_digest_short_and_cuts_landings_before_a_persons_claims() {
    let (hub, clock, _home) = hub();
    let app = project("app");
    hub.work.bind_project(&app, &shop()).unwrap();
    landings(&hub, &clock);
    let person = ClaimOwner {
        kind: ClaimOwnerKind::HumanSession,
        key_id: Line::unchecked("k7"),
        label: Some(Line::unchecked("laptop")),
    };
    for n in 0..6 {
        claim(&hub, person.clone(), &format!("piece {n}"), vec![]);
    }
    let section = elsewhere(&hub, &app).await.unwrap();
    assert_eq!(section.lines().count(), 8, "6 claims and 2 landings fit");
    assert!(section.lines().nth(6).unwrap().starts_with("- abc1234 "));

    for n in 6..40 {
        claim(
            &hub,
            person.clone(),
            &format!("{n} {}", "a very long piece of work ".repeat(4)),
            vec![],
        );
    }
    let section = elsewhere(&hub, &app).await.unwrap();
    assert_eq!(section.lines().count(), 8 + 1, "{section}");
    assert!(
        section
            .lines()
            .take(8)
            .all(|l| l.contains("claimed by a person")),
        "a person's claims are kept, landings cut first: {section}"
    );
    assert!(
        section.ends_with("(+34 more: expired claims, then landings, are cut first)"),
        "{section}"
    );
    assert!(section.lines().all(|l| l.chars().count() <= 200));
    let digest = hub.leads.wakes.digest(&app).await.unwrap();
    assert!(
        digest.chars().count() <= crate::hub::leads::digest::DIGEST_MAX_CHARS,
        "{}",
        digest.len()
    );
}
