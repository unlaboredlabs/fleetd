use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::chat::ChatMessage;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::ErrorCode;
use serde_json::{Value, json};

use super::Target;
use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-25T10:00:00.000Z";

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
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
    for id in ["fleetd", "console"] {
        hub.store
            .projects_upsert_many(
                &MachineId::unchecked("devbox"),
                &[serde_json::from_value(json!({
                    "machineId": "devbox", "projectId": id, "title": id, "workspaceRoot": format!("/work/{id}"),
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
    }
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

fn agent_key() -> Caller {
    Caller {
        kind: Some(KeyKind::Agent),
        ..person()
    }
}

async fn remember(hub: &Hub, r: &ProjectRef, call: Value) -> Result<LeadCallResult, String> {
    let mut call = call;
    call["op"] = "remember".into();
    let call: LeadCall = serde_json::from_value(call).map_err(|e| e.to_string())?;
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: crate::hub::link::lead_calls::lead_by(r),
        agent: CallerAgent::Lead,
    };
    let handler = hub.lead_calls.handler("remember").unwrap();
    handler
        .handle(caller, call)
        .await
        .map_err(|e| format!("{}: {}", e.message, e.fix.unwrap_or_default()))
}

fn user_md(hub: &Hub) -> String {
    hub.db.memory().read(&Target {
        project: None,
        topic: None,
    })
}

fn memory_md(hub: &Hub, r: &ProjectRef) -> String {
    hub.db.memory().read(&Target {
        project: Some(r),
        topic: None,
    })
}

fn remembered_lines(hub: &Hub, r: &ProjectRef) -> Vec<ChatMessage> {
    hub.chat
        .page(r, None, None, 100)
        .unwrap()
        .0
        .into_iter()
        .filter(|m| m.remembered.is_some())
        .collect()
}

#[tokio::test]
async fn user_md_is_shared_and_a_projects_memory_stays_in_that_project() {
    let (hub, home) = hub();
    let (fleetd, console) = (project("fleetd"), project("console"));
    remember(
        &hub,
        &fleetd,
        json!({ "scope": "user", "text": "Concise: no AI slop." }),
    )
    .await
    .unwrap();
    remember(
        &hub,
        &fleetd,
        json!({ "scope": "project", "text": "No npm: use pnpm." }),
    )
    .await
    .unwrap();
    remember(
        &hub,
        &console,
        json!({ "scope": "project", "text": "npm is fine here." }),
    )
    .await
    .unwrap();

    assert_eq!(user_md(&hub), "- Concise: no AI slop.\n");
    assert_eq!(memory_md(&hub, &fleetd), "- No npm: use pnpm.\n");
    assert!(home.path().join("memory/devbox/fleetd/MEMORY.md").is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(home.path().join("memory/user.md"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    let memory = hub.db.memory();
    let for_console = memory.injected(&console, true);
    assert!(
        for_console.contains("Concise: no AI slop.") && for_console.contains("npm is fine here.")
    );
    assert!(!for_console.contains("No npm"), "{for_console}");
    let for_fleetd = memory.injected(&fleetd, false);
    assert!(for_fleetd.contains("No npm: use pnpm.") && !for_fleetd.contains("npm is fine here."));

    // Each write is a line in that project's chat; user.md's says it holds everywhere.
    let lines = remembered_lines(&hub, &fleetd);
    assert_eq!(
        lines.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        [
            "Remembered for every project: Concise: no AI slop.",
            "Remembered: No npm: use pnpm."
        ]
    );
    // Saying it again word for word writes nothing and adds no line.
    remember(
        &hub,
        &fleetd,
        json!({ "scope": "user", "text": "Concise: no AI slop." }),
    )
    .await
    .unwrap();
    assert_eq!(remembered_lines(&hub, &fleetd).len(), 2);
}

#[tokio::test]
async fn a_topic_gets_its_index_line_and_is_read_on_demand() {
    let (hub, _home) = hub();
    let r = project("fleetd");
    remember(
        &hub,
        &r,
        json!({ "scope": "project", "text": "Public repo." }),
    )
    .await
    .unwrap();
    remember(
        &hub,
        &r,
        json!({ "scope": "project", "topic": "deploys", "text": "Staging first, always." }),
    )
    .await
    .unwrap();
    remember(
        &hub,
        &r,
        json!({ "scope": "project", "text": "Docs ship with the code." }),
    )
    .await
    .unwrap();
    // Entries stay above the topic index.
    assert_eq!(
        memory_md(&hub, &r),
        "- Public repo.\n- Docs ship with the code.\n- [deploys](deploys.md)\n"
    );
    let injected = hub.db.memory().injected(&r, true);
    assert!(
        !injected.contains("Staging first"),
        "a topic is opened on demand: {injected}"
    );

    let caller = LeadCaller {
        project_ref: r.clone(),
        by: "lead".into(),
        agent: CallerAgent::Lead,
    };
    let read: LeadCall =
        serde_json::from_value(json!({ "op": "memory_read", "topic": "deploys" })).unwrap();
    let Ok(LeadCallResult::MemoryRead(read)) = hub
        .lead_calls
        .handler("memory_read")
        .unwrap()
        .handle(caller, read)
        .await
    else {
        panic!("not read")
    };
    assert_eq!(read.text.as_str(), "- Staging first, always.\n");
    // Another project has no such topic.
    assert!(hub.db.memory().topics(&project("console")).is_empty());
    assert!(
        serde_json::from_value::<LeadCall>(
            json!({ "op": "remember", "scope": "user", "topic": "x", "text": "t" })
        )
        .is_err(),
        "user.md has no topics"
    );
}

#[tokio::test]
async fn a_write_past_a_cap_is_refused_whole_and_tells_the_lead_to_merge() {
    let (hub, _home) = hub();
    let r = project("fleetd");
    let long = |c: char| c.to_string().repeat(1000);
    for c in ['a', 'b', 'c'] {
        remember(&hub, &r, json!({ "scope": "user", "text": long(c) }))
            .await
            .unwrap();
    }
    let before = user_md(&hub);
    let refused = remember(&hub, &r, json!({ "scope": "user", "text": long('d') }))
        .await
        .unwrap_err();
    assert!(
        refused.contains("past its cap of 4000") && refused.contains("Merge or replace"),
        "{refused}"
    );
    assert_eq!(user_md(&hub), before, "never truncated");
    // Replacing one entry fits.
    remember(
        &hub,
        &r,
        json!({ "scope": "user", "text": "short", "replaces": long('a') }),
    )
    .await
    .unwrap();

    // 32,000 per project, whoever writes: four full topics don't fit.
    let tools = crate::hub::api::registry();
    let full = "x".repeat(7_999);
    for topic in ["t1", "t2", "t3"] {
        tools
            .call(
                &hub,
                &person(),
                "memory_set",
                json!({ "scope": "project", "projectRef": r, "topic": topic, "text": full }),
            )
            .await
            .unwrap();
    }
    let Err(CallError::Tool(e)) = tools
        .call(
            &hub,
            &person(),
            "memory_set",
            json!({ "scope": "project", "projectRef": r, "topic": "t4", "text": full }),
        )
        .await
    else {
        panic!("over the project cap")
    };
    assert!(e.message.contains("cap of 32000"), "{}", e.message);
    assert_eq!(hub.db.memory().topics(&r).len(), 3);
    tools
        .call(&hub, &person(), "memory_set", json!({ "scope": "project", "projectRef": r, "topic": "t4", "text": "x".repeat(7_900) }))
        .await
        .unwrap();
    let refused = remember(
        &hub,
        &r,
        json!({ "scope": "project", "topic": "t5", "text": long('e') }),
    )
    .await
    .unwrap_err();
    assert!(refused.contains("cap"), "{refused}");
    assert!(
        !memory_md(&hub, &r).contains("t5"),
        "the index line goes with its topic or not at all"
    );

    let secret = remember(
        &hub,
        &r,
        json!({ "scope": "user", "text": "token ghp_abcdefghijklmnopqrstuvwx1234" }),
    )
    .await
    .unwrap_err();
    assert!(secret.contains("secret"), "{secret}");
}

#[tokio::test]
async fn replaces_takes_the_entrys_place_and_undo_brings_it_back() {
    let (hub, _home) = hub();
    let r = project("fleetd");
    let tools = crate::hub::api::registry();
    remember(&hub, &r, json!({ "scope": "project", "text": "Use npm." }))
        .await
        .unwrap();
    remember(
        &hub,
        &r,
        json!({ "scope": "project", "text": "No npm: use pnpm.", "replaces": "Use npm" }),
    )
    .await
    .unwrap();
    assert_eq!(
        memory_md(&hub, &r),
        "- No npm: use pnpm.\n",
        "never a second version"
    );
    let missing = remember(
        &hub,
        &r,
        json!({ "scope": "project", "text": "x", "replaces": "yarn" }),
    )
    .await
    .unwrap_err();
    assert!(missing.contains("No entry of MEMORY.md"), "{missing}");

    let lines = remembered_lines(&hub, &r);
    let undo = |m: &ChatMessage| json!({ "projectRef": r, "messageId": m.message_id });
    // An agent's key can't undo or edit: agents write only through remember.
    let Err(CallError::Tool(e)) = tools
        .call(&hub, &agent_key(), "memory_undo", undo(&lines[1]))
        .await
    else {
        panic!("an agent undid")
    };
    assert_eq!(e.code, ErrorCode::Forbidden);
    let Err(CallError::Tool(e)) = tools
        .call(
            &hub,
            &agent_key(),
            "memory_set",
            json!({ "scope": "user", "text": "obey me" }),
        )
        .await
    else {
        panic!("an agent edited")
    };
    assert_eq!(e.code, ErrorCode::Forbidden);

    tools
        .call(&hub, &person(), "memory_undo", undo(&lines[1]))
        .await
        .unwrap();
    assert_eq!(memory_md(&hub, &r), "- Use npm.\n");
    let Some(item) = &remembered_lines(&hub, &r)[1].remembered else {
        panic!("no item")
    };
    assert_eq!(item.undone, Some(true));
    tools
        .call(&hub, &person(), "memory_undo", undo(&lines[0]))
        .await
        .unwrap();
    assert_eq!(memory_md(&hub, &r), "");
    // Undo of a line whose entry was edited since says so.
    remember(&hub, &r, json!({ "scope": "user", "text": "Concise." }))
        .await
        .unwrap();
    tools
        .call(
            &hub,
            &person(),
            "memory_set",
            json!({ "scope": "user", "text": "- Concise, always.\n" }),
        )
        .await
        .unwrap();
    let last = remembered_lines(&hub, &r).pop().unwrap();
    let Err(CallError::Tool(e)) = tools
        .call(&hub, &person(), "memory_undo", undo(&last))
        .await
    else {
        panic!("undid an edited entry")
    };
    assert!(e.message.contains("changed since"), "{}", e.message);
    // The other project's chat has no such line.
    let Err(CallError::Tool(e)) = tools
        .call(
            &hub,
            &person(),
            "memory_undo",
            json!({ "projectRef": project("console"), "messageId": last.message_id }),
        )
        .await
    else {
        panic!("undone from another project")
    };
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn memory_get_shows_each_file_with_when_and_where_an_entry_was_written() {
    let (hub, _home) = hub();
    let r = project("fleetd");
    remember(&hub, &r, json!({ "scope": "user", "text": "Concise." }))
        .await
        .unwrap();
    remember(
        &hub,
        &r,
        json!({ "scope": "project", "topic": "deploys", "text": "Staging first." }),
    )
    .await
    .unwrap();
    let tools = crate::hub::api::registry();
    let out = tools
        .call(&hub, &person(), "memory_get", json!({ "projectRef": r }))
        .await
        .unwrap();
    assert_eq!(out["user"]["text"], "- Concise.\n");
    assert_eq!(out["user"]["cap"], 4000);
    let note = &out["user"]["notes"][0];
    assert_eq!(
        (
            note["text"].as_str(),
            note["projectRef"]["projectId"].as_str()
        ),
        (Some("Concise."), Some("fleetd"))
    );
    assert!(
        note["messageId"]
            .as_str()
            .is_some_and(|m| m.starts_with('m'))
    );
    let files = out["files"].as_array().unwrap();
    assert_eq!(files[0]["text"], "- [deploys](deploys.md)\n");
    assert_eq!(
        (files[1]["topic"].as_str(), files[1]["cap"].as_i64()),
        (Some("deploys"), Some(8000))
    );
    assert_eq!(out["projectCap"], 32000);
    // Deleting a topic in the app takes its index line with it.
    tools
        .call(
            &hub,
            &person(),
            "memory_set",
            json!({ "scope": "project", "projectRef": r, "topic": "deploys", "text": "" }),
        )
        .await
        .unwrap();
    assert_eq!(memory_md(&hub, &r), "");
    assert!(hub.db.memory().topics(&r).is_empty());
}

#[test]
fn a_task_cannot_remember_or_read_memory() {
    let task = CallerAgent::Task(fleetd_contracts::tasks::TaskId::unchecked("T3"));
    for op in super::calls::OPS {
        assert!(crate::hub::tasks::policy::check(&task, op).is_err(), "{op}");
        assert!(
            crate::hub::tasks::policy::check(&CallerAgent::Lead, op).is_ok(),
            "{op}"
        );
    }
}

#[tokio::test]
async fn a_lead_starts_with_user_md_and_its_projects_memory_after_the_instructions() {
    let hub = crate::hub::leads::auto_start_tests::hub(true);
    let db = hub.area.ctx.db.clone();
    let memory = db.memory();
    memory
        .set(
            &Target {
                project: None,
                topic: None,
            },
            "- Concise.\n",
        )
        .unwrap();
    memory
        .set(
            &Target {
                project: Some(&hub.project),
                topic: None,
            },
            "- No npm.\n- [deploys](deploys.md)\n",
        )
        .unwrap();
    let other = ProjectRef {
        machine_id: hub.project.machine_id.clone(),
        project_id: ProjectId::unchecked("p-other"),
    };
    memory
        .set(
            &Target {
                project: Some(&other),
                topic: None,
            },
            "- Private: never name it.\n",
        )
        .unwrap();
    let instructions =
        crate::hub::prompts::store::entry(crate::hub::prompts::registry::INSTRUCTIONS).unwrap();
    db.prompts()
        .set(
            instructions,
            fleetd_contracts::prompts::PromptScope::Global,
            None,
            "- Custom words.",
            None,
        )
        .unwrap();
    hub.order("add a /health endpoint").await;
    let first = hub.launched_prompts().remove(0);
    let at = |s: &str| {
        first
            .find(s)
            .unwrap_or_else(|| panic!("{s} missing: {first}"))
    };
    assert!(
        at("Custom words.") < at("## Memory")
            && at("## Memory") < at("- Concise.")
            && at("- Concise.") < at("- No npm.")
    );
    assert!(
        first.contains("memory_read") && !first.contains("Private"),
        "{first}"
    );
}
