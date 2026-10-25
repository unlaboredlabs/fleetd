use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::LeadCall;
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::skills::{SkillName, SkillOrigin, SkillScope};
use serde_json::{Value, json};

use super::install;
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-25T10:00:00.000Z";

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("shop"),
    }
}

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
    hub.store
        .projects_upsert_many(
            &MachineId::unchecked("devbox"),
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "shop", "title": "shop", "workspaceRoot": "/work/shop",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
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
    format!("---\nname: {name}\ndescription: {says}\n---\n\n# {name}\n")
}

async fn call(
    hub: &Arc<Hub>,
    caller: &Caller,
    tool: &str,
    input: Value,
) -> Result<Value, CallError> {
    crate::hub::api::registry()
        .call(hub, caller, tool, input)
        .await
}

fn code(e: CallError) -> ErrorCode {
    match e {
        CallError::Tool(e) => e.code,
        other => panic!("not a tool error: {other:?}"),
    }
}

#[tokio::test]
async fn a_person_creates_lists_edits_and_deletes_project_and_global_skills() {
    let (hub, home) = hub();
    let r = project();
    let set = |scope: &str, name: &str, says: &str, create: bool| {
        let mut input =
            json!({ "scope": scope, "name": name, "text": md(name, says), "create": create });
        if scope == "project" {
            input["projectRef"] = json!(r);
        }
        input
    };
    call(
        &hub,
        &person(),
        "skill_set",
        set("global", "standup", "Write the standup.", true),
    )
    .await
    .unwrap();
    call(
        &hub,
        &person(),
        "skill_set",
        set("global", "release", "Release, the hub way.", true),
    )
    .await
    .unwrap();
    call(
        &hub,
        &person(),
        "skill_set",
        set("project", "release", "Release this shop.", true),
    )
    .await
    .unwrap();
    // New refuses a name the scope has; Save replaces it.
    let again = call(
        &hub,
        &person(),
        "skill_set",
        set("project", "release", "x", true),
    )
    .await;
    assert_eq!(code(again.unwrap_err()), ErrorCode::Invalid);
    call(
        &hub,
        &person(),
        "skill_set",
        set("project", "release", "Release this shop, now.", false),
    )
    .await
    .unwrap();

    // Plain folders under the hub home, in no repo.
    let kept = home
        .path()
        .join("skills/projects/devbox/shop/release/SKILL.md");
    assert!(std::fs::read_to_string(kept).unwrap().contains("now."));
    assert!(home.path().join("skills/global/standup/SKILL.md").is_file());

    let list = call(&hub, &person(), "skills_list", json!({ "projectRef": r }))
        .await
        .unwrap();
    let rows: Vec<(String, String, Value)> = list["skills"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["origin"].as_str().unwrap().into(),
                s["name"].as_str().unwrap().into(),
                s["shadowedBy"].clone(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("project".into(), "release".into(), Value::Null),
            ("global".into(), "release".into(), json!("project")),
            ("global".into(), "standup".into(), Value::Null),
        ]
    );
    // No node here: the repo's skills are missing, and the list says why.
    assert!(
        list["repoUnavailable"]
            .as_str()
            .unwrap()
            .contains("offline")
    );
    assert_eq!(list["skills"][0]["description"], "Release this shop, now.");

    let got = call(
        &hub,
        &person(),
        "skill_get",
        json!({ "origin": "global", "name": "standup" }),
    )
    .await
    .unwrap();
    assert!(
        got["text"]
            .as_str()
            .unwrap()
            .starts_with("---\nname: standup")
    );

    call(
        &hub,
        &person(),
        "skill_delete",
        json!({ "scope": "project", "projectRef": r, "name": "release" }),
    )
    .await
    .unwrap();
    let gone = call(
        &hub,
        &person(),
        "skill_delete",
        json!({ "scope": "project", "projectRef": r, "name": "release" }),
    )
    .await;
    assert_eq!(code(gone.unwrap_err()), ErrorCode::NotFound);
    let list = call(&hub, &person(), "skills_list", json!({}))
        .await
        .unwrap();
    assert_eq!(list["skills"].as_array().unwrap().len(), 2);
    assert_eq!(list["skills"][0]["shadowedBy"], Value::Null);
}

#[tokio::test]
async fn a_bad_skill_md_a_secret_and_an_agent_key_are_refused() {
    let (hub, _home) = hub();
    let input = |text: &str| json!({ "scope": "global", "name": "deploy", "text": text });
    for text in [
        "# no frontmatter",
        "---\nname: other\ndescription: d\n---\n",
        "---\nname: deploy\n---\n",
    ] {
        let e = call(&hub, &person(), "skill_set", input(text))
            .await
            .unwrap_err();
        assert_eq!(code(e), ErrorCode::Invalid, "{text}");
    }
    let secret = format!(
        "{}\nexport TOKEN=ghp_{}\n",
        md("deploy", "d"),
        "a".repeat(36)
    );
    assert_eq!(
        code(
            call(&hub, &person(), "skill_set", input(&secret))
                .await
                .unwrap_err()
        ),
        ErrorCode::Invalid
    );
    let agent = Caller {
        kind: Some(KeyKind::Agent),
        ..person()
    };
    let e = call(&hub, &agent, "skill_set", input(&md("deploy", "d")))
        .await
        .unwrap_err();
    assert_eq!(code(e), ErrorCode::Forbidden);
    assert!(hub.db.skills().list(SkillScope::Global, None).is_empty());
}

#[test]
fn sources_parse_as_skills_sh_writes_them() {
    let p = |s: &str| install::parse(s).unwrap();
    let s = p("vercel-labs/agent-skills");
    assert_eq!(
        (s.url.as_str(), s.git_ref.as_str(), s.path.as_str(), s.skill),
        (
            "https://github.com/vercel-labs/agent-skills.git",
            "HEAD",
            "",
            None
        )
    );
    assert_eq!(
        p("vercel-labs/agent-skills@web-design-guidelines")
            .skill
            .unwrap()
            .as_str(),
        "web-design-guidelines"
    );
    let s = p("https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines");
    assert_eq!(
        (s.url.as_str(), s.git_ref.as_str(), s.path.as_str()),
        (
            "https://github.com/vercel-labs/agent-skills.git",
            "main",
            "skills/web-design-guidelines"
        )
    );
    assert_eq!(
        p("https://github.com/o/r.git").url,
        "https://github.com/o/r.git"
    );
    assert_eq!(p("git@gitlab.com:o/r.git").url, "git@gitlab.com:o/r.git");
    for bad in [
        "just-a-word",
        "-u x/y",
        "o/r/x/y",
        "o/r@Bad_Name",
        "https://github.com/o",
    ] {
        assert!(install::parse(bad).is_err(), "{bad}");
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@example.com",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn put(dir: &Path, rel: &str, text: &str) {
    let p = dir.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/// A source repo with two skills under skills/, committed.
fn source_repo() -> tempfile::TempDir {
    let repo = tempfile::tempdir().unwrap();
    git(repo.path(), &["init", "-q", "-b", "main"]);
    put(
        repo.path(),
        "skills/pdf/SKILL.md",
        &md("pdf", "Fill PDF forms."),
    );
    put(repo.path(), "skills/pdf/scripts/fill.py", "print('fill')\n");
    put(
        repo.path(),
        "skills/web-review/SKILL.md",
        &md("web-review", "Review a web page."),
    );
    put(repo.path(), "README.md", "not a skill\n");
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "-q", "-m", "one"]);
    repo
}

#[tokio::test]
async fn an_install_is_pinned_and_moves_only_on_update() {
    let (hub, _home) = hub();
    let r = project();
    let repo = source_repo();
    let url = format!("file://{}", repo.path().display());
    let first = git(repo.path(), &["rev-parse", "HEAD"]);

    let out = call(
        &hub,
        &person(),
        "skill_install",
        json!({ "scope": "project", "projectRef": r, "source": url }),
    )
    .await
    .unwrap();
    let names: Vec<&str> = out["installed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["pdf", "web-review"]);
    let pdf = &out["installed"][0];
    assert_eq!(pdf["install"]["commit"], first);
    assert_eq!(pdf["install"]["path"], "skills/pdf");
    assert_eq!(pdf["install"]["ref"], "HEAD");
    assert_eq!(pdf["files"], json!(["scripts/fill.py"]));

    // The source moves on; the pin doesn't, until Update.
    put(
        repo.path(),
        "skills/pdf/SKILL.md",
        &md("pdf", "Fill PDF forms, v2."),
    );
    git(repo.path(), &["commit", "-qam", "two"]);
    let second = git(repo.path(), &["rev-parse", "HEAD"]);
    let kept = hub
        .db
        .skills()
        .get(SkillScope::Project, Some(&r), &SkillName::unchecked("pdf"))
        .unwrap();
    assert_eq!(kept.install.unwrap().commit.as_str(), first);
    assert!(kept.text.contains("Fill PDF forms."));

    let up = call(
        &hub,
        &person(),
        "skill_update",
        json!({ "scope": "project", "projectRef": r, "name": "pdf" }),
    )
    .await
    .unwrap();
    assert_eq!(up["updated"], true);
    assert_eq!(up["skill"]["install"]["commit"], second);
    assert_eq!(up["skill"]["description"], "Fill PDF forms, v2.");
    let up = call(
        &hub,
        &person(),
        "skill_update",
        json!({ "scope": "project", "projectRef": r, "name": "pdf" }),
    )
    .await
    .unwrap();
    assert_eq!(up["updated"], false);

    // One skill of a source, into the global scope.
    let one = call(
        &hub,
        &person(),
        "skill_install",
        json!({ "scope": "global", "source": url, "skill": "web-review" }),
    )
    .await
    .unwrap();
    assert_eq!(one["installed"].as_array().unwrap().len(), 1);
    let none = call(
        &hub,
        &person(),
        "skill_install",
        json!({ "scope": "global", "source": url, "skill": "nope" }),
    )
    .await;
    assert_eq!(code(none.unwrap_err()), ErrorCode::Invalid);

    // A skill written here has nothing to update from.
    call(
        &hub,
        &person(),
        "skill_set",
        json!({ "scope": "global", "name": "mine", "text": md("mine", "Mine.") }),
    )
    .await
    .unwrap();
    let e = call(
        &hub,
        &person(),
        "skill_update",
        json!({ "scope": "global", "name": "mine" }),
    )
    .await
    .unwrap_err();
    assert_eq!(code(e), ErrorCode::Invalid);
}

#[tokio::test]
async fn a_repo_that_is_one_skill_installs_under_its_frontmatter_name_or_its_repos() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("pdf-tools");
    std::fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    put(
        &repo,
        "SKILL.md",
        "---\ndescription: The repo is the skill.\n---\n",
    );
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "one"]);
    let source = install::parse(&format!("file://{}", repo.display())).unwrap();
    let fetched = install::fetch(&source).await.unwrap();
    let found = install::find(fetched.tree.path(), &source, None).unwrap();
    let got: Vec<(&str, &str)> = found
        .iter()
        .map(|f| (f.name.as_str(), f.path.as_str()))
        .collect();
    assert_eq!(got, [("pdf-tools", "")]);
}

#[tokio::test]
async fn a_lead_installs_from_a_remote_source_only_and_a_task_not_at_all() {
    let (hub, _home) = hub();
    let r = project();
    let repo = source_repo();
    let call = LeadCall::SkillInstall(
        serde_json::from_value(
            json!({ "source": format!("file://{}", repo.path().display()), "scope": "project" }),
        )
        .unwrap(),
    );
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: crate::hub::link::lead_calls::lead_by(&r),
        agent: CallerAgent::Lead,
    };
    let handler = hub.lead_calls.handler("skill_install").unwrap();
    let e = handler.handle(caller, call).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    assert!(
        hub.db
            .skills()
            .list(SkillScope::Project, Some(&r))
            .is_empty()
    );
    for op in super::calls::OPS {
        let task = CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T3"));
        assert!(crate::hub::tasks::policy::check(&task, op).is_err());
        assert!(crate::hub::tasks::policy::check(&CallerAgent::Lead, op).is_ok());
    }
}

#[test]
fn a_launch_carries_the_projects_skills_then_the_global_ones_of_other_names() {
    let home = tempfile::tempdir().unwrap();
    let db = HubDb::open_memory().unwrap();
    db.set_skills_dir(home.path().join("skills"));
    let skills = db.skills();
    let r = project();
    let name = |n: &str| SkillName::new(n).unwrap();
    skills
        .set(
            SkillScope::Global,
            None,
            &name("release"),
            &md("release", "global"),
            true,
        )
        .unwrap();
    skills
        .set(
            SkillScope::Global,
            None,
            &name("standup"),
            &md("standup", "global"),
            true,
        )
        .unwrap();
    skills
        .set(
            SkillScope::Project,
            Some(&r),
            &name("release"),
            &md("release", "project"),
            true,
        )
        .unwrap();
    std::fs::write(
        home.path().join("skills/global/standup/notes.md"),
        "Notes.\n",
    )
    .unwrap();
    let bundles = skills.bundles(&r);
    let got: Vec<(&str, SkillOrigin, usize)> = bundles
        .iter()
        .map(|b| (b.name.as_str(), b.origin, b.files.len()))
        .collect();
    assert_eq!(
        got,
        [
            ("release", SkillOrigin::Project, 1),
            ("standup", SkillOrigin::Global, 2)
        ]
    );
    assert!(bundles[0].files[0].text.contains("project"));
    // Another project gets only the global ones.
    let other = ProjectRef {
        project_id: ProjectId::unchecked("blog"),
        ..r
    };
    let got: Vec<SkillOrigin> = skills.bundles(&other).iter().map(|b| b.origin).collect();
    assert_eq!(got, [SkillOrigin::Global, SkillOrigin::Global]);
}

#[tokio::test]
async fn the_leads_copy_of_a_message_names_the_skills_the_person_picked() {
    let (hub, _home) = hub();
    let r = project();
    hub.db
        .skills()
        .set(
            SkillScope::Global,
            None,
            &SkillName::unchecked("standup"),
            &md("standup", "Write the standup."),
            true,
        )
        .unwrap();
    let (message, _) = hub
        .chat
        .add(
            &r,
            crate::hub::chat::NewMessage {
                author: Some(fleetd_contracts::chat::ChatAuthor::Human),
                text: "Use $standup and $triage today.".into(),
                skills: vec![
                    SkillName::unchecked("standup"),
                    SkillName::unchecked("triage"),
                ],
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(message.skills.as_ref().unwrap().len(), 2);
    let lines = crate::hub::chat::flow::skills_of(&hub, &r, &message);
    assert!(
        lines.contains("- fleetd:standup (a global skill): Write the standup."),
        "{lines}"
    );
    assert!(
        lines.contains("- fleetd:triage (from the repo's"),
        "{lines}"
    );
}
