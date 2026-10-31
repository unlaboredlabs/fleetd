//! `chat_image` over a real in-memory hub and a node that reads with the node's own `read_image`: a lead's and a
//! task's image come from their own working directories only, a lead message shows its project's image (and keeps it
//! past the unused-upload cleanup), and another project's image never shows.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::blocks::BlockBody;
use fleetd_contracts::chat::{ChatAuthor, ChatMessage};
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::mcp::{AttachmentGetInput, AttachmentMime, ErrorCode};
use fleetd_contracts::tasks::TaskId;
use serde_json::json;

use crate::hub::api::{Caller, Hub, HubConfig, Listen};
use crate::hub::chat::NewMessage;
use crate::hub::intake::attachments;
use crate::hub::leads::records::StoredLead;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::{CallerAgent, lead_by};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-19T10:00:00.000Z";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR a screenshot";

fn project(p: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(p),
    }
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

struct Rig {
    hub: Arc<Hub>,
    clock: Arc<ManualClock>,
    /// Each session's working directory on the node: `app-lead`, `shop-lead`, and task T1's worktree `task-1`.
    dirs: HashMap<&'static str, PathBuf>,
    _home: tempfile::TempDir,
    _work: tempfile::TempDir,
}

/// A hub with projects app and shop on devbox, each with its lead, and app's writer T1; its node reads images with
/// the node's own `read_image` in the session's directory.
async fn rig() -> Rig {
    use fleetd_contracts::node_link::{HubToNode, NodeToHub};
    use fleetd_contracts::sessions::SessionCall;
    let home = tempfile::tempdir().unwrap();
    let clock = ManualClock::at(1_792_000_000_000);
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
    };
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    for (p, thread) in [("app", "app-lead"), ("shop", "shop-lead")] {
        hub.leads
            .records
            .lead_put(&StoredLead {
                project_ref: project(p),
                thread_id: ThreadId::unchecked(thread),
                started_at: AT.into(),
                last_wake_at: None,
                session_generation: 1,
            })
            .unwrap();
    }
    let task: fleetd_contracts::tasks::Task = serde_json::from_value(json!({
        "taskId": "T1", "projectRef": { "machineId": "devbox", "projectId": "app" },
        "workstreamId": "W9", "title": "restyle it", "kind": "write", "prompt": "do it", "areas": ["ui"],
        "model": "claude-opus-5-5", "effort": "high", "state": "running", "attempt": 1, "createdAt": AT,
        "startedAt": AT, "threadRef": { "machineId": "devbox", "threadId": "task-1" },
    }))
    .unwrap();
    hub.db
        .with(|c| Ok(crate::hub::tasks::records::TaskRecords::create(c, task)?))
        .unwrap();

    let work = tempfile::tempdir().unwrap();
    let mut dirs = HashMap::new();
    for session in ["app-lead", "shop-lead", "task-1"] {
        let dir = work.path().join(session);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("shot.png"), PNG).unwrap();
        dirs.insert(session, dir);
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let machine = MachineId::unchecked("devbox");
    hub.executors
        .attach(
            &machine,
            crate::hub::executor::NodeSessions {
                link_id: 1,
                send: tx,
            },
        )
        .await;
    let (executors, roots) = (hub.executors.clone(), dirs.clone());
    tokio::spawn(async move {
        while let Some(HubToNode::SessionCall(f)) = rx.recv().await {
            let result = match &f.call {
                SessionCall::ReadImage {
                    session_id,
                    path,
                    offset,
                } => match roots.get(session_id.as_str()) {
                    None => json!({ "err": { "code": "not_found", "message": "no session" } }),
                    Some(root) => match crate::node::sessions::files::read_image(
                        root,
                        path,
                        offset.get() as u64,
                    ) {
                        Ok((name, mime, bytes, piece)) => json!({ "ok": {
                            "kind": "image", "name": name, "mime": mime, "bytes": bytes,
                            "dataB64": B64.encode(piece),
                        } }),
                        Err(why) => json!({ "err": { "code": "invalid", "message": why } }),
                    },
                },
                _ => json!({ "ok": { "kind": "done" } }),
            };
            let frame: NodeToHub = serde_json::from_value(
                json!({ "t": "session_reply", "id": f.id, "result": result }),
            )
            .unwrap();
            executors.handle_frame(&machine, frame);
        }
    });
    Rig {
        hub,
        clock,
        dirs,
        _home: home,
        _work: work,
    }
}

async fn chat_image(
    hub: &Hub,
    p: &str,
    agent: CallerAgent,
    path: &str,
) -> Result<fleetd_contracts::chat::ChatImageResult, (ErrorCode, String)> {
    let call: LeadCall =
        serde_json::from_value(json!({ "op": "chat_image", "path": path })).unwrap();
    let caller = LeadCaller {
        project_ref: project(p),
        by: lead_by(&project(p)),
        agent,
    };
    match hub
        .lead_calls
        .handler("chat_image")
        .unwrap()
        .handle(caller, call)
        .await
    {
        Ok(LeadCallResult::ChatImage(r)) => Ok(r),
        Ok(other) => panic!("{other:?}"),
        Err(e) => Err((e.code, e.message)),
    }
}

fn image_block(id: &str) -> String {
    format!(
        "Here is the new header.\n\n```fleetd-block\n{{\"v\":1,\"kind\":\"image\",\"attachmentId\":\"{id}\",\"caption\":\"After\"}}\n```"
    )
}

fn lead_says(hub: &Hub, p: &str, text: String) -> ChatMessage {
    hub.chat
        .add(
            &project(p),
            NewMessage {
                author: Some(ChatAuthor::Lead),
                text,
                ..Default::default()
            },
        )
        .unwrap()
        .0
}

fn shown(message: &ChatMessage) -> Vec<String> {
    message
        .parts
        .iter()
        .flatten()
        .filter_map(|p| match p.block.as_ref().map(|b| &b.body) {
            Some(BlockBody::Image(m)) => Some(m.attachment_id.as_str().to_owned()),
            _ => None,
        })
        .collect()
}

async fn app_reads(hub: &Hub, p: &str, id: &str) -> Result<Vec<u8>, ErrorCode> {
    let input = AttachmentGetInput {
        project_ref: project(p),
        attachment_id: serde_json::from_value(json!(id)).unwrap(),
    };
    attachments::get(hub, &person(), input)
        .await
        .map(|got| B64.decode(got.data_b64).unwrap())
        .map_err(|e| e.code)
}

/// done:0 — a lead and a task each put a PNG of their own directory in the chat and get its id; a lead message's
/// image block of it shows, the app reads it, and it outlives the cleanup of unused uploads, which takes an image
/// nobody showed.
#[tokio::test]
async fn a_lead_and_a_task_put_a_png_in_the_chat_and_a_lead_message_shows_it() {
    let rig = rig().await;
    let hub = &rig.hub;
    let lead = chat_image(hub, "app", CallerAgent::Lead, "shot.png")
        .await
        .unwrap();
    assert_eq!(
        (lead.mime, lead.bytes.get()),
        (AttachmentMime::Png, PNG.len() as i64)
    );
    assert!(
        lead.next.as_deref().unwrap().contains("\"kind\":\"image\""),
        "{:?}",
        lead.next
    );
    let absolute = rig.dirs["task-1"].join("shot.png").display().to_string();
    let task = chat_image(
        hub,
        "app",
        CallerAgent::Task(TaskId::unchecked("T1")),
        &absolute,
    )
    .await
    .unwrap();
    assert!(
        task.next.as_deref().unwrap().contains("in your result"),
        "{:?}",
        task.next
    );
    let unshown = chat_image(hub, "app", CallerAgent::Lead, "shot.png")
        .await
        .unwrap();

    // Not the app's until a lead message shows it.
    let id = task.attachment_id.as_str().to_owned();
    assert_eq!(app_reads(hub, "app", &id).await, Err(ErrorCode::NotFound));
    let message = lead_says(hub, "app", image_block(&id));
    assert_eq!(shown(&message), std::slice::from_ref(&id));
    assert_eq!(app_reads(hub, "app", &id).await.unwrap(), PNG);
    // A streamed reply shows it once final.
    let lead_id = lead.attachment_id.as_str().to_owned();
    let (mut streamed, _) = hub
        .chat
        .add(
            &project("app"),
            NewMessage {
                author: Some(ChatAuthor::Lead),
                streaming: true,
                ..Default::default()
            },
        )
        .unwrap();
    hub.chat
        .finish(&mut streamed, &image_block(&lead_id))
        .unwrap();
    assert_eq!(shown(&streamed), std::slice::from_ref(&lead_id));

    // A day on, the next upload sweeps the image nobody showed; the shown ones stay.
    rig.clock.advance(std::time::Duration::from_secs(25 * 3600));
    chat_image(hub, "app", CallerAgent::Lead, "shot.png")
        .await
        .unwrap();
    assert_eq!(app_reads(hub, "app", &id).await.unwrap(), PNG);
    assert_eq!(app_reads(hub, "app", &lead_id).await.unwrap(), PNG);
    let gone = lead_says(hub, "app", image_block(unshown.attachment_id.as_str()));
    assert!(shown(&gone).is_empty(), "swept after 24 h unused");
}

/// done:1 — a path outside the caller's own directory (another session's, absolute or through `..`), a symlink out
/// of it and a file that isn't an image are each refused, and nothing is stored.
#[tokio::test]
async fn chat_image_reads_only_an_image_in_the_callers_own_directory() {
    use std::os::unix::fs::symlink;
    let rig = rig().await;
    let hub = &rig.hub;
    let lead_dir = &rig.dirs["app-lead"];
    let task_dir = &rig.dirs["task-1"];
    std::fs::write(
        task_dir.join("notes.png"),
        b"DATABASE_URL=postgres://secret",
    )
    .unwrap();
    std::fs::write(task_dir.join(".env"), b"TOKEN=secret").unwrap();
    symlink(lead_dir.join("shot.png"), task_dir.join("lead.png")).unwrap();
    symlink(lead_dir, task_dir.join("lead")).unwrap();
    let task = || CallerAgent::Task(TaskId::unchecked("T1"));
    for (path, why) in [
        (
            lead_dir.join("shot.png").display().to_string(),
            "outside your working directory",
        ),
        (
            "../app-lead/shot.png".to_owned(),
            "outside your working directory",
        ),
        ("lead.png".to_owned(), "outside your working directory"),
        ("lead/shot.png".to_owned(), "outside your working directory"),
        ("notes.png".to_owned(), "does not hold the image"),
        (".env".to_owned(), "is not a .png"),
    ] {
        let (code, message) = chat_image(hub, "app", task(), &path).await.unwrap_err();
        assert_eq!(code, ErrorCode::Invalid, "{path}: {message}");
        assert!(message.contains(why), "{path}: {message}");
    }
    let stored: i64 = hub
        .db
        .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(stored, 0);
    // A session the hub doesn't know of reads nothing.
    let (code, _) = chat_image(
        hub,
        "app",
        CallerAgent::Task(TaskId::unchecked("T9")),
        "shot.png",
    )
    .await
    .unwrap_err();
    assert_eq!(code, ErrorCode::NotFound);
}

/// done:1 — an image belongs to its project: another project's lead message doesn't show it, nor does the app read
/// it there, and a person's own upload never sent to the project doesn't show either.
#[tokio::test]
async fn another_projects_image_never_shows() {
    let rig = rig().await;
    let hub = &rig.hub;
    let shops = chat_image(hub, "shop", CallerAgent::Lead, "shot.png")
        .await
        .unwrap();
    let id = shops.attachment_id.as_str().to_owned();
    let elsewhere = lead_says(hub, "app", image_block(&id));
    assert!(
        shown(&elsewhere).is_empty(),
        "app's chat shows the fence as text"
    );
    assert_eq!(app_reads(hub, "app", &id).await, Err(ErrorCode::NotFound));
    // Still shop's to show, and only there.
    assert_eq!(
        shown(&lead_says(hub, "shop", image_block(&id))),
        std::slice::from_ref(&id)
    );
    assert_eq!(app_reads(hub, "shop", &id).await.unwrap(), PNG);
    assert_eq!(app_reads(hub, "app", &id).await, Err(ErrorCode::NotFound));
    assert!(shown(&lead_says(hub, "app", image_block(&id))).is_empty());

    let input: fleetd_contracts::mcp::AttachmentPutInput = serde_json::from_value(json!({
        "name": "mine.png", "mime": "image/png", "dataB64": B64.encode(PNG),
    }))
    .unwrap();
    let mine = attachments::put(hub, &person(), input)
        .await
        .unwrap()
        .attachment_id;
    assert!(shown(&lead_says(hub, "app", image_block(mine.as_str()))).is_empty());
}
