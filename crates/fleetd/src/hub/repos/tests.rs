//! A project's repos: an older hub's projects get their own repo at start, a plain directory gets none, a project
//! bound later gets it then, the node's refreshes keep them, removing the project removes them, and an `R<n>` is
//! never handed out twice.
use std::sync::Arc;

use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::model::ProjectSummary;
use fleetd_contracts::prim::Line;
use fleetd_contracts::repos::{ProjectRepo, RepoId, RepoName};
use fleetd_contracts::work::{RepoKey, WorkScope};
use serde_json::json;

use super::store;
use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::store::HubDb;
use crate::hub::store::migrations::MIGRATIONS;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-25T10:00:00.000Z";

fn hub_on(db: Arc<HubDb>, home: &std::path::Path) -> Arc<Hub> {
    let config = HubConfig {
        home: home.to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    crate::hub::serve::build_on(db, config, ManualClock::at(1_792_922_400_000)).unwrap()
}

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    (hub_on(HubDb::open_memory().unwrap(), home.path()), home)
}

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::new("devbox").unwrap(),
        project_id: ProjectId::new(id).unwrap(),
    }
}

/// What a node reports of its project at `root`.
fn summary(id: &str, root: &str) -> ProjectSummary {
    serde_json::from_value(json!({
        "machineId": "devbox", "projectId": id, "title": id, "workspaceRoot": root,
        "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
    }))
    .unwrap()
}

fn node_reports(hub: &Hub, projects: &[ProjectSummary]) {
    hub.store
        .projects_upsert_many(&MachineId::new("devbox").unwrap(), projects)
        .unwrap();
}

fn scope(repo_key: &str, base: &str) -> WorkScope {
    WorkScope {
        repo_key: RepoKey::new(repo_key).unwrap(),
        base: Line::new(base).unwrap(),
    }
}

fn repo(n: u32, name: &str, of: &str, scope: Option<(&str, &str)>) -> ProjectRepo {
    ProjectRepo {
        repo_id: RepoId::new(format!("R{n}")).unwrap(),
        name: RepoName::new(name).unwrap(),
        checkout: project(of),
        repo_key: scope.map(|(k, _)| RepoKey::new(k).unwrap()),
        base: scope.map(|(_, b)| Line::new(b).unwrap()),
        path: None,
    }
}

/// The repo as the hub serves it once its checkout's node reported the checkout at `path`.
fn at(repo: ProjectRepo, path: &str) -> ProjectRepo {
    ProjectRepo {
        path: Some(path.to_owned()),
        ..repo
    }
}

fn served(hub: &Hub, id: &str) -> Vec<ProjectRepo> {
    hub.store.project_get(&project(id)).unwrap().unwrap().repos
}

/// An older hub's database: a project whose work is bound to its remote, a git repo with no remote known yet, and a
/// plain directory. Once migrated and started, the bound one has its own repo; the other two have none, as the hub
/// can't tell them apart yet. Starting again changes nothing.
#[test]
fn an_older_hubs_projects_get_their_own_repo_at_start() {
    let home = tempfile::tempdir().unwrap();
    let repos_at = MIGRATIONS
        .iter()
        .position(|m| m.sql.contains("CREATE TABLE repos"))
        .expect("the repos migration");
    {
        let conn = rusqlite::Connection::open(home.path().join("hub.sqlite")).unwrap();
        for m in &MIGRATIONS[..repos_at] {
            conn.execute_batch(m.sql).unwrap();
        }
        conn.pragma_update(None, "user_version", repos_at as i64)
            .unwrap();
        for (id, root) in [
            ("shop", "/home/me/src/Shop_App"),
            ("local", "/home/me/src/local"),
            ("notes", "/home/me/notes"),
        ] {
            conn.execute(
                "INSERT INTO projects (machine_id, project_id, search, last_activity_at, data) VALUES ('devbox', ?1, ?1, ?2, ?3)",
                rusqlite::params![id, AT, serde_json::to_string(&summary(id, root)).unwrap()],
            )
            .unwrap();
        }
        conn.execute_batch(
            "INSERT INTO project_settings (machine_id, project_id, medium_allowed, setup)
               VALUES ('devbox', 'shop', 1, '[\"npm ci\"]');
             INSERT INTO work_projects VALUES ('devbox', 'shop', 'github.com/acme/shop', 'main', 1);",
        )
        .unwrap();
    }

    let hub = hub_on(HubDb::open(home.path()).unwrap(), home.path());
    let shop = at(
        repo(1, "shop", "shop", Some(("github.com/acme/shop", "main"))),
        "/home/me/src/Shop_App",
    );
    assert_eq!(served(&hub, "shop"), std::slice::from_ref(&shop));
    assert_eq!(served(&hub, "local"), []);
    assert_eq!(served(&hub, "notes"), []);
    assert_eq!(
        hub.store
            .projects_list(None, None)
            .unwrap()
            .iter()
            .map(|p| p.repos.len())
            .sum::<usize>(),
        1
    );
    // Its settings stay where they were.
    let setup: Option<String> = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT setup FROM project_settings WHERE project_id = 'shop'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(setup.as_deref(), Some("[\"npm ci\"]"));

    assert_eq!(hub.repos.backfill().unwrap(), 1);
    assert_eq!(hub.repos.backfill().unwrap(), 1);
    assert_eq!(hub.repos.repos_of(&project("shop")).unwrap(), [shop]);
    let count: i64 = hub
        .db
        .with(|c| Ok(c.query_row("SELECT count(*) FROM repos", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(count, 1);
}

/// A plain directory, with no git, stays a project with no repo: reads, the backfill and node refreshes add none.
#[test]
fn a_project_with_no_repo_stays_repo_less() {
    let (hub, _home) = hub();
    node_reports(&hub, &[summary("notes", "/home/me/notes")]);
    let notes = project("notes");
    assert_eq!(hub.repos.repos_of(&notes).unwrap(), []);
    assert_eq!(hub.repos.own(&notes).unwrap(), None);
    assert_eq!(
        hub.repos
            .repo_by_name(&notes, &RepoName::new("notes").unwrap())
            .unwrap(),
        None
    );
    assert_eq!(hub.repos.backfill().unwrap(), 0);
    node_reports(&hub, &[summary("notes", "/home/me/notes")]);
    assert_eq!(served(&hub, "notes"), []);
    assert_eq!(hub.repos.checkout_owners(&notes).unwrap(), []);
}

/// A project the node adds after the hub started gets its own repo when its work is bound to its remote, and loses
/// only the repo's key and base when its origin goes away.
#[test]
fn a_project_added_later_gets_its_own_repo_once_bound() {
    let (hub, _home) = hub();
    node_reports(&hub, &[summary("api", "/srv/api")]);
    let api = project("api");
    assert_eq!(served(&hub, "api"), []);

    hub.work
        .bind_project(&api, &scope("github.com/acme/api-server", "main"))
        .unwrap();
    let own = at(
        repo(
            1,
            "api-server",
            "api",
            Some(("github.com/acme/api-server", "main")),
        ),
        "/srv/api",
    );
    assert_eq!(served(&hub, "api"), std::slice::from_ref(&own));
    assert_eq!(hub.repos.own(&api).unwrap(), Some(own.clone()));
    assert_eq!(
        hub.repos.repo(&RepoId::new("R1").unwrap()).unwrap(),
        Some((api.clone(), own.clone()))
    );
    assert_eq!(hub.repos.repo(&RepoId::new("R2").unwrap()).unwrap(), None);
    assert_eq!(
        hub.repos
            .repo_by_name(&api, &RepoName::new("api-server").unwrap())
            .unwrap(),
        Some(own.clone())
    );
    assert_eq!(
        hub.repos.checkout_owners(&api).unwrap(),
        [(api.clone(), own.repo_id.clone())]
    );

    // A new base for the same repo: the same R1, now on the new base.
    hub.work
        .bind_project(&api, &scope("github.com/acme/api-server", "trunk"))
        .unwrap();
    assert_eq!(
        served(&hub, "api"),
        [at(
            repo(
                1,
                "api-server",
                "api",
                Some(("github.com/acme/api-server", "trunk"))
            ),
            "/srv/api"
        )]
    );
    hub.work.unbind_project(&api).unwrap();
    assert_eq!(
        served(&hub, "api"),
        [at(repo(1, "api-server", "api", None), "/srv/api")]
    );
}

/// A scope bound by a writer that doesn't know about repos (an older hub's code path, or a rollback) is picked up the
/// next time the project's repos are read.
#[test]
fn a_read_gives_a_bound_project_its_own_repo() {
    let (hub, _home) = hub();
    node_reports(&hub, &[summary("web", "/srv/web")]);
    let web = project("web");
    hub.db
        .with(|c| {
            Ok(crate::hub::work::store::bind(
                c,
                &web,
                &scope("github.com/acme/web", "main"),
                1,
            )?)
        })
        .unwrap();
    assert_eq!(served(&hub, "web"), []);
    let own = at(
        repo(1, "web", "web", Some(("github.com/acme/web", "main"))),
        "/srv/web",
    );
    assert_eq!(
        hub.repos.repos_of(&web).unwrap(),
        std::slice::from_ref(&own)
    );
    assert_eq!(served(&hub, "web"), [own]);
}

/// Adding a git checkout with no remote gives the project its own repo, named for its folder.
#[test]
fn a_git_repo_with_no_remote_is_named_for_its_folder() {
    let (hub, _home) = hub();
    let local = project("local");
    let own = hub
        .repos
        .ensure_own(&local, Some("/home/me/src/My Tools/"))
        .unwrap();
    assert_eq!(own, Some(repo(1, "my-tools", "local", None)));
    // Again is the same repo; a later read without the root keeps it.
    assert_eq!(hub.repos.ensure_own(&local, Some("/x/other")).unwrap(), own);
    assert_eq!(hub.repos.repos_of(&local).unwrap(), [own.unwrap()]);
}

/// The node's refresh carries no repos (and an older node's row can't bring any): the hub's are served all the same.
#[test]
fn repos_survive_a_node_refresh() {
    let (hub, _home) = hub();
    node_reports(&hub, &[summary("shop", "/srv/shop")]);
    let shop = project("shop");
    hub.work
        .bind_project(&shop, &scope("github.com/acme/shop", "main"))
        .unwrap();
    let own = at(
        repo(1, "shop", "shop", Some(("github.com/acme/shop", "main"))),
        "/srv/shop",
    );

    node_reports(&hub, &[summary("shop", "/srv/shop")]);
    assert_eq!(served(&hub, "shop"), std::slice::from_ref(&own));
    let mut claiming = summary("shop", "/srv/shop");
    claiming.repos = vec![repo(9, "other", "shop", None)];
    node_reports(&hub, &[claiming]);
    assert_eq!(served(&hub, "shop"), std::slice::from_ref(&own));
    let listed = hub
        .store
        .projects_list(Some(&MachineId::new("devbox").unwrap()), Some("shop"))
        .unwrap();
    assert_eq!(listed[0].repos, [own]);
    let stored: String = hub
        .db
        .with(|c| {
            Ok(c.query_row(
                "SELECT data FROM projects WHERE project_id = 'shop'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert!(!stored.contains("repos"), "{stored}");
}

/// Removing a project removes its repos and any repo whose files were in it; their numbers are never handed out again.
#[test]
fn removal_cascades_and_repo_numbers_are_never_reused() {
    let (hub, _home) = hub();
    node_reports(
        &hub,
        &[summary("shop", "/srv/shop"), summary("api", "/srv/api")],
    );
    let (shop, api) = (project("shop"), project("api"));
    hub.work
        .bind_project(&shop, &scope("github.com/acme/shop", "main"))
        .unwrap();
    // `api`'s checkout attached to `shop` as a second repo, as adding a repo will.
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id)
                 VALUES ('devbox', 'shop', 'api', 'devbox', 'api')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        hub.repos.repos_of(&shop).unwrap(),
        [
            at(
                repo(1, "shop", "shop", Some(("github.com/acme/shop", "main"))),
                "/srv/shop"
            ),
            at(repo(2, "api", "api", None), "/srv/api")
        ]
    );
    assert_eq!(
        hub.repos.checkout_owners(&api).unwrap(),
        [(shop.clone(), RepoId::new("R2").unwrap())]
    );

    hub.store.project_remove(&api).unwrap();
    assert_eq!(served(&hub, "shop").len(), 1, "api's checkout is gone");
    hub.store.project_remove(&shop).unwrap();
    assert_eq!(hub.repos.repo(&RepoId::new("R1").unwrap()).unwrap(), None);
    assert_eq!(hub.repos.repos_of(&shop).unwrap(), []);

    // Its work is still bound, but a project the hub no longer has gets no repo back until its node reports it again,
    // and then under a new number.
    assert_eq!(hub.repos.own(&shop).unwrap(), None);
    node_reports(&hub, &[summary("shop", "/srv/shop")]);
    assert_eq!(
        served(&hub, "shop"),
        [at(
            repo(3, "shop", "shop", Some(("github.com/acme/shop", "main"))),
            "/srv/shop"
        )]
    );
}

#[test]
fn a_repos_name_is_a_slug_of_its_key_or_folder() {
    for (path, name) in [
        (Some("github.com/acme/shop"), "shop"),
        (Some("/home/me/src/Shop_App/"), "shop-app"),
        (Some("/srv/git/--x..y--"), "x-y"),
        (Some("/srv/Ünïcode"), "n-code"),
        (Some(&*format!("/srv/{}", "a".repeat(40))), &*"a".repeat(32)),
        (Some("/"), "repo"),
        (Some("/srv/___"), "repo"),
        (None, "repo"),
    ] {
        assert_eq!(store::name_for(path).as_str(), name, "{path:?}");
    }
}

/// A second repo by a taken name gets `-2`, kept within 32 characters.
#[test]
fn a_taken_name_gets_a_number() {
    let (hub, _home) = hub();
    let long = "b".repeat(32);
    hub.db
        .transaction(|c| {
            for name in ["shop", &long] {
                c.execute(
                    "INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id)
                     VALUES ('devbox', 'p', ?1, 'devbox', ?1)",
                    [name],
                )?;
            }
            let p = project("p");
            assert_eq!(
                store::ensure_own(c, &p, Some("/srv/shop"))?.unwrap().name.as_str(),
                "shop-2"
            );
            store::remove_project(c, &p)?;
            for name in ["shop", &long] {
                c.execute(
                    "INSERT INTO repos (machine_id, project_id, name, checkout_machine_id, checkout_project_id)
                     VALUES ('devbox', 'p', ?1, 'devbox', ?1)",
                    [name],
                )?;
            }
            let own = store::ensure_own(c, &p, Some(&format!("/srv/{long}")))?.unwrap();
            assert_eq!(own.name.as_str(), format!("{}-2", "b".repeat(30)));
            Ok(())
        })
        .unwrap();
}
