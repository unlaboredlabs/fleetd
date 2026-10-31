//! A Navi's own skills (W238): `skill_save` without approval, every write a version, a person's edit, revert and off
//! switch, the last use, and a Navi's skills reaching its sessions only.
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::skills::{SkillAuthor, SkillName, SkillScope};
use serde_json::{Value, json};

use super::versions;
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, lead_by};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-25T10:00:00.000Z";

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
    }
}

fn name(n: &str) -> SkillName {
    SkillName::new(n).unwrap()
}

/// A hub with two Navis, "Home" (`navi`) and "Work" (`work`), and a coding project, `shop`.
fn hub() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    for (id, title) in [("navi", "Home"), ("work", "Work"), ("shop", "Shop")] {
        hub.store
            .projects_upsert_many(
                &MachineId::unchecked("devbox"),
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": id, "title": title, "workspaceRoot": format!("/work/{id}"),
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
    }
    hub.db
        .with(|c| {
            c.execute_batch(
                "CREATE TABLE IF NOT EXISTS assistants (
                   machine_id TEXT NOT NULL, project_id TEXT NOT NULL, created_ms INTEGER NOT NULL,
                   created_by_key TEXT NOT NULL, created_by_name TEXT NOT NULL, archived_ms INTEGER,
                   PRIMARY KEY (machine_id, project_id)
                 );
                 INSERT INTO assistants (machine_id, project_id, created_ms, created_by_key, created_by_name)
                 VALUES ('devbox', 'navi', 1792000000000, 'k1', 'desk'), ('devbox', 'work', 1792000000000, 'k1', 'desk');",
            )?;
            Ok(())
        })
        .unwrap();
    (hub, home)
}

fn person() -> Caller {
    let c = serde_json::from_value::<Caller>(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "operate", "machines": "*" }],
    }))
    .unwrap();
    Caller {
        kind: Some(KeyKind::Human),
        ..c
    }
}

fn md(name: &str, says: &str) -> String {
    format!("---\nname: {name}\ndescription: {says}\n---\n\n# {name}\n\n1. {says}\n")
}

/// `r`'s lead saves a skill: the result as JSON, or the refusal's code and words.
async fn save(
    hub: &Hub,
    r: &ProjectRef,
    agent: CallerAgent,
    skill: &str,
    says: &str,
    why: &str,
) -> Result<Value, (ErrorCode, String)> {
    let call = LeadCall::SkillSave(
        serde_json::from_value(json!({ "name": skill, "text": md(skill, says), "why": why }))
            .unwrap(),
    );
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: lead_by(r),
        agent,
    };
    let handler = hub.lead_calls.handler("skill_save").unwrap();
    match handler.handle(caller, call).await {
        Ok(LeadCallResult::SkillSave(out)) => Ok(serde_json::to_value(out).unwrap()),
        Ok(other) => panic!("not a save: {other:?}"),
        Err(e) => Err((e.code, e.message)),
    }
}

async fn call(hub: &Arc<Hub>, tool: &str, input: Value) -> Result<Value, CallError> {
    crate::hub::api::registry()
        .call(hub, &person(), tool, input)
        .await
}

fn get_input(r: &ProjectRef, skill: &str) -> Value {
    json!({ "origin": "project", "projectRef": r, "name": skill })
}

#[tokio::test]
async fn a_navi_saves_and_improves_its_own_skill_each_save_a_version_with_a_quiet_line() {
    let (hub, _home) = hub();
    let r = project("navi");
    let out = save(
        &hub,
        &r,
        CallerAgent::Lead,
        "weekly-invoices",
        "Download the invoices.",
        "Worked out where the portal hides them.",
    )
    .await
    .unwrap();
    assert_eq!(out["version"], 1);
    assert_eq!(out["created"], true);
    let out = save(
        &hub,
        &r,
        CallerAgent::Lead,
        "weekly-invoices",
        "Download the invoices as PDF.",
        "The person wants PDFs, not CSVs.",
    )
    .await
    .unwrap();
    assert_eq!(
        (out["version"].as_i64(), out["created"].as_bool()),
        (Some(2), Some(false))
    );

    let got = call(&hub, "skill_get", get_input(&r, "weekly-invoices"))
        .await
        .unwrap();
    assert!(got["text"].as_str().unwrap().contains("as PDF"));
    let versions = got["versions"].as_array().unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0]["version"], 2);
    assert_eq!(versions[0]["author"], "agent");
    assert_eq!(versions[0]["by"], "Home");
    assert_eq!(versions[0]["why"], "The person wants PDFs, not CSVs.");
    assert_eq!(got["skill"]["changed"]["version"], 2);
    // An older version's text, for the diff.
    let mut first = get_input(&r, "weekly-invoices");
    first["version"] = json!(1);
    let v1 = call(&hub, "skill_get", first).await.unwrap();
    assert!(!v1["text"].as_str().unwrap().contains("as PDF"));

    // One quiet line per save, naming the skill for the app's link.
    let (messages, ..) = hub.chat.page(&r, None, None, 50).unwrap();
    let lines: Vec<_> = messages
        .iter()
        .filter(|m| m.skill_saved.is_some())
        .collect();
    assert_eq!(lines.len(), 2);
    assert!(lines.iter().all(|m| m.author == ChatAuthor::System));
    let saved = lines[1].skill_saved.as_ref().unwrap();
    assert_eq!(
        (saved.name.as_str(), saved.version.get(), saved.created),
        ("weekly-invoices", 2, false)
    );
    assert!(
        lines[0].text.contains("Saved a new skill, weekly-invoices"),
        "{}",
        lines[0].text
    );
}

#[tokio::test]
async fn only_a_navis_own_lead_saves_and_never_over_an_installed_skill() {
    let (hub, _home) = hub();
    let (code, why) = save(
        &hub,
        &project("shop"),
        CallerAgent::Lead,
        "deploy",
        "Deploy.",
        "Learned it.",
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    assert!(why.contains("Only a Navi"), "{why}");
    let task = CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T3"));
    let (code, _) = save(
        &hub,
        &project("navi"),
        task,
        "deploy",
        "Deploy.",
        "Learned it.",
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
    for op in super::saves::OPS {
        let task = CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T3"));
        assert!(crate::hub::tasks::policy::check(&task, op).is_err());
    }
    // An installed skill is the person's, pinned to its source.
    let r = project("navi");
    let install: fleetd_contracts::skills::SkillInstall = serde_json::from_value(json!({
        "source": "acme/skills", "url": "https://github.com/acme/skills.git", "ref": "HEAD",
        "commit": "a".repeat(40), "path": "", "installedAt": AT,
    }))
    .unwrap();
    hub.db
        .skills()
        .put_folders(
            SkillScope::Project,
            Some(&r),
            &[(
                name("pdf"),
                vec![("SKILL.md".into(), md("pdf", "Fill PDFs.").into_bytes())],
                install,
            )],
            &super::Who::person("desk", None, 0),
        )
        .unwrap();
    let (code, why) = save(&hub, &r, CallerAgent::Lead, "pdf", "Mine.", "Better.")
        .await
        .unwrap_err();
    assert_eq!(code, ErrorCode::Invalid);
    assert!(why.contains("installed"), "{why}");
    // A malformed SKILL.md is refused, as from the app.
    let bad = LeadCall::SkillSave(
        serde_json::from_value(json!({ "name": "notes", "text": "# no frontmatter", "why": "w" }))
            .unwrap(),
    );
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: lead_by(&r),
        agent: CallerAgent::Lead,
    };
    let e = hub
        .lead_calls
        .handler("skill_save")
        .unwrap()
        .handle(caller, bad)
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Invalid);
}

#[tokio::test]
async fn a_navis_skill_reaches_its_next_session_only() {
    let (hub, _home) = hub();
    let home = project("navi");
    save(
        &hub,
        &home,
        CallerAgent::Lead,
        "groceries",
        "Order the groceries.",
        "The person showed me how.",
    )
    .await
    .unwrap();
    let names = |r: &ProjectRef| -> Vec<String> {
        hub.db
            .skills()
            .bundles(r)
            .iter()
            .map(|b| b.name.to_string())
            .collect()
    };
    // The launch path every session starts from carries it to Home's sessions, and to no other Navi's or project's.
    assert_eq!(names(&home), ["groceries"]);
    let bundle = &hub.db.skills().bundles(&home)[0];
    assert!(bundle.files[0].text.contains("Order the groceries."));
    assert!(names(&project("work")).is_empty());
    assert!(names(&project("shop")).is_empty());
    let launch = hub
        .executors
        .skill_bundles(&home.machine_id, &home.project_id);
    assert_eq!(launch.len(), 1);
    // Another Navi's list doesn't show it.
    let listed = call(
        &hub,
        "skills_list",
        json!({ "projectRef": project("work") }),
    )
    .await
    .unwrap();
    assert!(listed["skills"].as_array().unwrap().is_empty(), "{listed}");
}

#[tokio::test]
async fn the_person_edits_reverts_turns_off_and_deletes_a_navis_skill() {
    let (hub, _home) = hub();
    let r = project("navi");
    save(
        &hub,
        &r,
        CallerAgent::Lead,
        "taxes",
        "File the taxes.",
        "First time through.",
    )
    .await
    .unwrap();
    // The person's edit is a version of theirs, with their optional line.
    let edited = call(
        &hub,
        "skill_set",
        json!({ "scope": "project", "projectRef": r, "name": "taxes", "text": md("taxes", "File by April."), "why": "Deadline." }),
    )
    .await
    .unwrap();
    assert_eq!(edited["skill"]["changed"]["author"], "person");
    assert_eq!(edited["skill"]["changed"]["by"], "desk");
    assert_eq!(edited["skill"]["changed"]["version"], 2);
    // Revert puts version 1's text back, as version 3.
    let reverted = call(
        &hub,
        "skill_revert",
        json!({ "scope": "project", "projectRef": r, "name": "taxes", "version": 1 }),
    )
    .await
    .unwrap();
    assert_eq!(reverted["skill"]["changed"]["version"], 3);
    assert_eq!(reverted["skill"]["changed"]["why"], "Back to version 1");
    let got = call(&hub, "skill_get", get_input(&r, "taxes"))
        .await
        .unwrap();
    assert!(got["text"].as_str().unwrap().contains("File the taxes."));
    let authors: Vec<&str> = got["versions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["author"].as_str().unwrap())
        .collect();
    assert_eq!(authors, ["person", "person", "agent"]);
    let missing = call(
        &hub,
        "skill_revert",
        json!({ "scope": "project", "projectRef": r, "name": "taxes", "version": 9 }),
    )
    .await
    .unwrap_err();
    assert!(matches!(missing, CallError::Tool(e) if e.code == ErrorCode::NotFound));

    // Off: listed as off, and no session gets it; back on, they do.
    call(
        &hub,
        "skill_off",
        json!({ "projectRef": r, "name": "taxes", "off": true }),
    )
    .await
    .unwrap();
    let listed = call(&hub, "skills_list", json!({ "projectRef": r }))
        .await
        .unwrap();
    assert_eq!(listed["skills"][0]["off"], true);
    assert!(hub.db.skills().bundles(&r).is_empty());
    let out = save(
        &hub,
        &r,
        CallerAgent::Lead,
        "taxes",
        "File the taxes early.",
        "Learned more.",
    )
    .await
    .unwrap();
    assert!(out["next"].as_str().unwrap().contains("off"), "{out}");
    call(
        &hub,
        "skill_off",
        json!({ "projectRef": r, "name": "taxes", "off": false }),
    )
    .await
    .unwrap();
    assert_eq!(hub.db.skills().bundles(&r).len(), 1);

    // Delete takes its history with it: saved again, it starts over at version 1.
    call(
        &hub,
        "skill_delete",
        json!({ "scope": "project", "projectRef": r, "name": "taxes" }),
    )
    .await
    .unwrap();
    assert!(
        versions::list(&hub.db, SkillScope::Project, Some(&r), &name("taxes"))
            .unwrap()
            .is_empty()
    );
    let out = save(&hub, &r, CallerAgent::Lead, "taxes", "Again.", "Back.")
        .await
        .unwrap();
    assert_eq!(out["version"], 1);
}

#[test]
fn only_the_newest_versions_are_kept() {
    let home = tempfile::tempdir().unwrap();
    let db = HubDb::open_memory().unwrap();
    db.set_skills_dir(home.path().join("skills"));
    let r = project("navi");
    let skills = db.skills();
    let kept = fleetd_contracts::skills::SKILL_VERSIONS_KEPT;
    for i in 0..kept + 3 {
        let who = super::Who::agent("Home", &format!("change {i}"), i as i64);
        skills
            .set(
                SkillScope::Project,
                Some(&r),
                &name("notes"),
                &md("notes", &format!("v{i}")),
                false,
                &who,
            )
            .unwrap();
    }
    let list = versions::list(&db, SkillScope::Project, Some(&r), &name("notes")).unwrap();
    assert_eq!(list.len(), kept);
    assert_eq!(list[0].version.get(), (kept + 3) as i64);
    assert_eq!(list[0].author, SkillAuthor::Agent);
    assert_eq!(list.last().unwrap().version.get(), 4);
}

#[test]
fn a_sessions_skill_call_is_its_projects_last_use() {
    let db = HubDb::open_memory().unwrap();
    let thread = ThreadRef {
        machine_id: MachineId::unchecked("devbox"),
        thread_id: ThreadId::unchecked("th1"),
    };
    db.with(|c| {
        c.execute(
            "INSERT INTO threads (machine_id, thread_id, project_id, last_progress_at, data) \
             VALUES ('devbox', 'th1', 'navi', ?, '{}')",
            [AT],
        )?;
        Ok(())
    })
    .unwrap();
    versions::ran(&db, &thread, "fleetd:groceries", 1_792_000_000_000).unwrap();
    // A skill that isn't the hub's (no prefix) and an unknown session leave nothing.
    versions::ran(&db, &thread, "dataviz", 1).unwrap();
    let other = ThreadRef {
        thread_id: ThreadId::unchecked("th2"),
        ..thread.clone()
    };
    versions::ran(&db, &other, "fleetd:groceries", 1).unwrap();
    let uses = versions::uses(&db, &project("navi")).unwrap();
    assert_eq!(uses.len(), 1);
    assert_eq!(uses["groceries"].last_used_ms, Some(1_792_000_000_000));
    assert!(!uses["groceries"].off);
}
