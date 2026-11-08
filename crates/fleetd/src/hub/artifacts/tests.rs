//! `artifact_publish`, `artifacts_list` and `artifact_get` over a real in-memory hub: a lead and a task publish
//! Markdown and HTML, each publish posts its card in the chat, a name published again keeps a new version with the
//! older one still readable, and one project's artifacts never show in another's. `artifact_read` gives an agent one
//! of its own project's back, whoever published it.
use std::sync::Arc;

use fleetd_contracts::artifacts::{
    ARTIFACT_READ_CAP, ArtifactFormat, ArtifactName, ArtifactPublishResult, ArtifactReadResult,
};
use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{ArtifactGetInput, ArtifactsListInput, ErrorCode};
use fleetd_contracts::prim::Int;
use fleetd_contracts::tasks::TaskId;
use serde_json::{Value, json};

use super::{artifact_get, artifacts_list};
use crate::hub::api::{Caller, Hub, HubConfig, Listen};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, lead_by};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-11-03T10:00:00.000Z";

fn project(p: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(p),
    }
}

fn person() -> Caller {
    let c = serde_json::from_value::<Caller>(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": "read", "machines": "*" }],
    }))
    .unwrap();
    Caller {
        kind: Some(KeyKind::Human),
        ..c
    }
}

/// A hub with app's writer T1, "Sweep the dependencies".
fn rig() -> (Arc<Hub>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        config,
        ManualClock::at(1_792_000_000_000),
    )
    .unwrap();
    let task: fleetd_contracts::tasks::Task = serde_json::from_value(json!({
        "taskId": "T1", "projectRef": { "machineId": "devbox", "projectId": "app" },
        "workstreamId": "W9", "title": "Sweep the dependencies", "kind": "read", "prompt": "do it",
        "areas": ["deps"], "model": "claude-opus-5-5", "effort": "high", "state": "running", "attempt": 1,
        "createdAt": AT, "startedAt": AT, "threadRef": { "machineId": "devbox", "threadId": "task-1" },
    }))
    .unwrap();
    hub.db
        .with(|c| Ok(crate::hub::tasks::records::TaskRecords::create(c, task)?))
        .unwrap();
    (hub, home)
}

async fn publish(
    hub: &Hub,
    p: &str,
    agent: CallerAgent,
    call: Value,
) -> Result<ArtifactPublishResult, (ErrorCode, String)> {
    let mut call = call;
    call["op"] = "artifact_publish".into();
    let call: LeadCall = serde_json::from_value(call).unwrap();
    crate::hub::tasks::policy::check_call(&agent, &call).map_err(|e| (e.code, e.message))?;
    let caller = LeadCaller {
        project_ref: project(p),
        by: lead_by(&project(p)),
        agent,
    };
    match hub
        .lead_calls
        .handler("artifact_publish")
        .unwrap()
        .handle(caller, call)
        .await
    {
        Ok(LeadCallResult::ArtifactPublish(r)) => Ok(r),
        Ok(other) => panic!("{other:?}"),
        Err(e) => Err((e.code, e.message)),
    }
}

/// `artifact_read` from `agent` in project `p`.
async fn agent_reads(
    hub: &Hub,
    p: &str,
    agent: CallerAgent,
    call: Value,
) -> Result<ArtifactReadResult, (ErrorCode, String)> {
    let mut call = call;
    call["op"] = "artifact_read".into();
    let call: LeadCall = serde_json::from_value(call).unwrap();
    crate::hub::tasks::policy::check_call(&agent, &call).map_err(|e| (e.code, e.message))?;
    let caller = LeadCaller {
        project_ref: project(p),
        by: lead_by(&project(p)),
        agent,
    };
    match hub
        .lead_calls
        .handler("artifact_read")
        .unwrap()
        .handle(caller, call)
        .await
    {
        Ok(LeadCallResult::ArtifactRead(r)) => Ok(r),
        Ok(other) => panic!("{other:?}"),
        Err(e) => Err((e.code, e.message.to_string())),
    }
}

async fn read(
    hub: &Arc<Hub>,
    p: &str,
    name: &str,
    version: Option<i64>,
) -> Result<(String, Value), ErrorCode> {
    let input = ArtifactGetInput {
        project_ref: project(p),
        name: ArtifactName::new(name).unwrap(),
        version: version.map(Int::unchecked),
    };
    artifact_get(hub.clone(), person(), input)
        .await
        .map(|got| {
            (
                got.content.as_str().to_owned(),
                serde_json::to_value(&got).unwrap(),
            )
        })
        .map_err(|e| e.code)
}

const REPORT: &str = "# Sweep\n\n- 12 crates behind\n- 2 with advisories";
const CHART: &str =
    "<!doctype html><svg id=c></svg><script>c.innerHTML='<rect width=40 height=10/>'</script>";

/// done:0, done:1 — a task publishes a Markdown report and the lead an HTML chart; each posts a card in the chat and
/// lists in the tab; publishing the report again keeps version 2, and version 1 still reads.
#[tokio::test]
async fn a_lead_and_a_task_publish_and_a_name_again_is_a_new_version() {
    let (hub, _home) = rig();
    let task = CallerAgent::Task(TaskId::unchecked("T1"));
    let first = publish(
        &hub,
        "app",
        task.clone(),
        json!({ "name": "sweep-report", "title": "Dependency sweep", "content": REPORT }),
    )
    .await
    .unwrap();
    assert_eq!(first.version.get(), 1);
    let next = first.next.unwrap();
    assert!(
        next.contains("[Dependency sweep](artifact:sweep-report)")
            && next.contains("in your result"),
        "{next}"
    );
    let chart = publish(&hub, "app", CallerAgent::Lead, json!({ "name": "build-times", "title": "Build times", "format": "html", "content": CHART }))
        .await
        .unwrap();
    assert!(chart.next.unwrap().contains("artifact:build-times@1"));

    // Each publish is a system line with its card.
    let (messages, _, _) = hub.chat.page(&project("app"), None, None, 50).unwrap();
    let cards: Vec<_> = messages
        .iter()
        .filter_map(|m| {
            m.artifact
                .as_ref()
                .map(|a| (m.author, m.text.as_str().to_owned(), a.clone()))
        })
        .collect();
    assert_eq!(cards.len(), 2);
    assert_eq!(cards[0].0, ChatAuthor::System);
    assert_eq!(
        cards[0].1,
        "Sweep the dependencies published Dependency sweep"
    );
    assert_eq!(
        (cards[0].2.name.as_str(), cards[0].2.format),
        ("sweep-report", ArtifactFormat::Md)
    );
    assert_eq!(
        (cards[1].1.as_str(), cards[1].2.by.as_str()),
        ("Lead published Build times", "Lead")
    );
    assert_eq!(cards[1].2.format, ArtifactFormat::Html);

    // Again: version 2, the first still there.
    let again = publish(&hub, "app", task, json!({ "name": "sweep-report", "title": "Dependency sweep", "content": "# Sweep\n\nAll current." }))
        .await
        .unwrap();
    assert_eq!(again.version.get(), 2);
    let (messages, _, _) = hub.chat.page(&project("app"), None, None, 50).unwrap();
    assert_eq!(
        messages.last().unwrap().text.as_str(),
        "Sweep the dependencies published Dependency sweep, version 2"
    );
    let (newest, got) = read(&hub, "app", "sweep-report", None).await.unwrap();
    assert_eq!(newest, "# Sweep\n\nAll current.");
    assert_eq!(got["artifact"]["version"], 2);
    assert_eq!(got["versions"].as_array().unwrap().len(), 2);
    assert_eq!(got["versions"][1]["bytes"], REPORT.len());
    assert_eq!(
        read(&hub, "app", "sweep-report", Some(1)).await.unwrap().0,
        REPORT
    );
    assert_eq!(
        read(&hub, "app", "sweep-report", Some(3))
            .await
            .unwrap_err(),
        ErrorCode::NotFound
    );
    assert_eq!(
        read(&hub, "app", "build-times", None).await.unwrap().0,
        CHART
    );

    // The tab lists each name once, at its newest version, the newest published first.
    let list = artifacts_list(
        hub.clone(),
        person(),
        ArtifactsListInput {
            project_ref: project("app"),
        },
    )
    .await
    .unwrap();
    let rows: Vec<_> = list
        .artifacts
        .iter()
        .map(|a| {
            (
                a.name.as_str(),
                a.newest.version.get(),
                a.newest.title.as_str(),
                a.newest.by.as_str(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            (
                "sweep-report",
                2,
                "Dependency sweep",
                "Sweep the dependencies"
            ),
            ("build-times", 1, "Build times", "Lead")
        ]
    );
}

/// Another project's chat has none of them, and its name is free there; a publish without content is refused.
#[tokio::test]
async fn artifacts_are_their_projects_own() {
    let (hub, _home) = rig();
    publish(
        &hub,
        "app",
        CallerAgent::Lead,
        json!({ "name": "notes", "title": "Notes", "content": "app's" }),
    )
    .await
    .unwrap();
    assert_eq!(
        read(&hub, "shop", "notes", None).await.unwrap_err(),
        ErrorCode::NotFound
    );
    let shop = publish(
        &hub,
        "shop",
        CallerAgent::Lead,
        json!({ "name": "notes", "title": "Notes", "content": "shop's" }),
    )
    .await
    .unwrap();
    assert_eq!(shop.version.get(), 1);
    assert_eq!(read(&hub, "app", "notes", None).await.unwrap().0, "app's");
    let (code, message) = publish(
        &hub,
        "app",
        CallerAgent::Lead,
        json!({ "name": "notes", "title": "Notes", "path": "notes.md" }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Invalid);
    assert!(message.contains("no content"), "{message}");
    // The nightly memory refresh publishes nothing.
    let (code, _) = publish(
        &hub,
        "app",
        CallerAgent::MemoryRefresh,
        json!({ "name": "notes", "title": "N", "content": "x" }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::Forbidden);
}

/// The tab lists the files sent in the chat beside the artifacts: a file the chat's own (a person attached it, or its
/// lead showed it), newest first; a file of another chat, or an upload never sent, not.
#[tokio::test]
async fn the_list_carries_the_files_sent_in_the_chat() {
    let (hub, _home) = rig();
    let add = |name: &str, mime: &str, project: Option<&str>, at_ms: i64| {
        hub.db
            .with(|c| {
                c.execute(
                    "INSERT INTO attachments (sha256, name, mime, bytes, by, created_ms, project) \
                     VALUES ('s', ?1, ?2, 2048, 'k1', ?3, ?4)",
                    rusqlite::params![name, mime, at_ms, project],
                )?;
                Ok(())
            })
            .unwrap();
    };
    add("plan.pdf", "application/pdf", Some("devbox/app"), 1_000);
    add("shot.png", "image/png", Some("devbox/app"), 2_000);
    add("theirs.csv", "text/csv", Some("devbox/shop"), 3_000);
    add("unsent.pdf", "application/pdf", None, 4_000);
    let got = artifacts_list(
        hub.clone(),
        person(),
        ArtifactsListInput {
            project_ref: project("app"),
        },
    )
    .await
    .unwrap();
    let names: Vec<_> = got.files.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["shot.png", "plan.pdf"]);
    let first = serde_json::to_value(&got.files[0]).unwrap();
    assert_eq!(first["attachmentId"], "F2", "{first}");
    assert_eq!(first["mime"], "image/png");
    assert_eq!(first["bytes"], 2048);
    assert!(got.artifacts.is_empty());
}

/// A task reads back a report another task published in its project, newest or one version; a task of another project
/// can't, and a report past the cap comes cut, with a note saying so.
#[tokio::test]
async fn an_agent_reads_its_projects_artifacts_and_only_those() {
    let (hub, _home) = rig();
    let writer = CallerAgent::Task(TaskId::unchecked("T1"));
    for content in [REPORT, "# Sweep\n\nAll current."] {
        publish(
            &hub,
            "app",
            writer.clone(),
            json!({ "name": "sweep-report", "title": "Dependency sweep", "content": content }),
        )
        .await
        .unwrap();
    }
    let reader = CallerAgent::Task(TaskId::unchecked("T2"));
    let newest = agent_reads(
        &hub,
        "app",
        reader.clone(),
        json!({ "name": "sweep-report" }),
    )
    .await
    .unwrap();
    assert_eq!(newest.content.as_str(), "# Sweep\n\nAll current.");
    assert_eq!(
        (newest.artifact.version.get(), newest.artifact.by.as_str()),
        (2, "Sweep the dependencies")
    );
    assert_eq!(
        newest.versions.iter().map(|v| v.get()).collect::<Vec<_>>(),
        [2, 1]
    );
    assert_eq!(newest.truncated, None);
    let first = agent_reads(
        &hub,
        "app",
        reader.clone(),
        json!({ "name": "sweep-report", "version": 1 }),
    )
    .await
    .unwrap();
    assert_eq!(first.content.as_str(), REPORT);
    // The lead reads it too.
    let lead = agent_reads(
        &hub,
        "app",
        CallerAgent::Lead,
        json!({ "name": "sweep-report" }),
    )
    .await
    .unwrap();
    assert_eq!(lead.artifact.version.get(), 2);

    // Another project's agent finds none, and is told what its own project has.
    publish(
        &hub,
        "shop",
        CallerAgent::Lead,
        json!({ "name": "shop-notes", "title": "Notes", "content": "shop's" }),
    )
    .await
    .unwrap();
    let (code, message) = agent_reads(
        &hub,
        "shop",
        reader.clone(),
        json!({ "name": "sweep-report" }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::NotFound);
    assert!(
        message.contains("No artifact sweep-report in this project"),
        "{message}"
    );
    let (code, _) = agent_reads(
        &hub,
        "app",
        reader.clone(),
        json!({ "name": "sweep-report", "version": 3 }),
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::NotFound);

    // Past the cap: its head, and a last line saying where it was cut.
    let long = "x".repeat(ARTIFACT_READ_CAP + 5000);
    publish(
        &hub,
        "app",
        writer,
        json!({ "name": "big", "title": "Big", "content": long }),
    )
    .await
    .unwrap();
    let big = agent_reads(&hub, "app", reader, json!({ "name": "big" }))
        .await
        .unwrap();
    assert_eq!(big.truncated, Some(true));
    let content = big.content.as_str();
    assert!(
        content.starts_with(&"x".repeat(ARTIFACT_READ_CAP)),
        "{}",
        &content[..40]
    );
    assert!(
        content.ends_with("[cut at 64 KB of 69 KB]"),
        "{}",
        &content[content.len() - 80..]
    );
}
