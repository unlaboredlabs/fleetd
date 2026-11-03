//! `chat_image` over a real in-memory hub and a node that reads with the node's own `read_image`: a lead's and a
//! task's image come from their own working directories only, a lead message shows its project's image (and keeps it
//! past the unused-upload cleanup), and another project's image never shows. `chat_file` does the same for any file
//! the chat takes, and a person's Office file reaches the lead with its text beside it.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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

/// The files the hub put in a project on the node (`put_file`): each path and its bytes.
type Placed = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

struct Rig {
    hub: Arc<Hub>,
    clock: Arc<ManualClock>,
    /// Each session's working directory on the node: `app-lead`, `shop-lead`, and task T1's worktree `task-1`.
    dirs: HashMap<&'static str, PathBuf>,
    placed: Placed,
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
    let placed: Placed = Arc::new(Mutex::new(Vec::new()));
    let put = placed.clone();
    tokio::spawn(async move {
        while let Some(HubToNode::SessionCall(f)) = rx.recv().await {
            let result = match &f.call {
                SessionCall::ReadImage {
                    session_id,
                    path,
                    offset,
                    file,
                } => match roots.get(session_id.as_str()) {
                    None => json!({ "err": { "code": "not_found", "message": "no session" } }),
                    Some(root) => match crate::node::sessions::files::read_image(
                        root,
                        path,
                        offset.get() as u64,
                        *file,
                    ) {
                        Ok((name, mime, bytes, piece)) => json!({ "ok": {
                            "kind": "image", "name": name, "mime": mime, "bytes": bytes,
                            "dataB64": B64.encode(piece),
                        } }),
                        Err(why) => json!({ "err": { "code": "invalid", "message": why } }),
                    },
                },
                SessionCall::PutFile {
                    rel_path, data_b64, ..
                } => {
                    put.lock()
                        .unwrap()
                        .push((rel_path.to_string(), B64.decode(data_b64.as_str()).unwrap()));
                    json!({ "ok": { "kind": "done" } })
                }
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
        placed,
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
    lead_call(hub, p, agent, "chat_image", path).await
}

async fn lead_call(
    hub: &Hub,
    p: &str,
    agent: CallerAgent,
    op: &str,
    path: &str,
) -> Result<fleetd_contracts::chat::ChatImageResult, (ErrorCode, String)> {
    let call: LeadCall = serde_json::from_value(json!({ "op": op, "path": path })).unwrap();
    let caller = LeadCaller {
        project_ref: project(p),
        by: lead_by(&project(p)),
        agent,
    };
    match hub
        .lead_calls
        .handler(op)
        .unwrap()
        .handle(caller, call)
        .await
    {
        Ok(LeadCallResult::ChatImage(r) | LeadCallResult::ChatFile(r)) => Ok(r),
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

/// A Navi's made files reach the chat: `chat_file` takes a PDF, a CSV and a Word document from the lead's own
/// directory, a lead message's file block shows each as a card with its name, type and size, and the app reads it. A
/// file whose bytes aren't what its name says, or a type the chat doesn't take, is refused; text under another name
/// gets `.txt`, so nothing opens it as a script. `chat_image` still takes images only.
#[tokio::test]
async fn chat_file_puts_a_made_file_in_the_chat_as_a_card() {
    let rig = rig().await;
    let hub = &rig.hub;
    let dir = &rig.dirs["app-lead"];
    let pdf = b"%PDF-1.7 itinerary".to_vec();
    std::fs::write(dir.join("itinerary.pdf"), &pdf).unwrap();
    std::fs::write(dir.join("receipts.csv"), b"date,amount\n2026-10-01,12.50\n").unwrap();
    std::fs::write(dir.join("letter.docx"), b"PK\x03\x04 a document").unwrap();
    std::fs::write(dir.join("run.command"), b"#!/bin/sh\necho hi\n").unwrap();
    std::fs::write(dir.join("fake.pdf"), b"not a pdf at all").unwrap();
    std::fs::write(dir.join("song.mp3"), b"ID3\x04\0\0\0\0\0\x01\xff\xfe\0").unwrap();
    let lead = || CallerAgent::Lead;

    let made = lead_call(hub, "app", lead(), "chat_file", "itinerary.pdf")
        .await
        .unwrap();
    assert_eq!(
        (made.mime, made.bytes.get()),
        (AttachmentMime::Pdf, pdf.len() as i64)
    );
    assert!(
        made.next.as_deref().unwrap().contains("\"kind\":\"file\""),
        "{:?}",
        made.next
    );
    let csv = lead_call(hub, "app", lead(), "chat_file", "receipts.csv")
        .await
        .unwrap();
    assert_eq!(csv.mime, AttachmentMime::Csv);
    let docx = lead_call(hub, "app", lead(), "chat_file", "letter.docx")
        .await
        .unwrap();
    assert_eq!(docx.mime, AttachmentMime::Docx);
    let script = lead_call(hub, "app", lead(), "chat_file", "run.command")
        .await
        .unwrap();
    assert_eq!(script.mime, AttachmentMime::Text);
    for (path, why) in [
        ("fake.pdf", "aren't what its name says"),
        ("song.mp3", "not a file the chat takes"),
    ] {
        let (code, message) = lead_call(hub, "app", lead(), "chat_file", path)
            .await
            .unwrap_err();
        assert_eq!(code, ErrorCode::Invalid, "{path}: {message}");
        assert!(message.contains(why), "{path}: {message}");
    }
    let (_, message) = chat_image(hub, "app", lead(), "itinerary.pdf")
        .await
        .unwrap_err();
    assert!(message.contains("is not a .png"), "{message}");

    let block = |id: &str| {
        format!("```fleetd-block\n{{\"v\":1,\"kind\":\"file\",\"attachmentId\":\"{id}\"}}\n```")
    };
    let ids = [&made, &csv, &script].map(|r| r.attachment_id.as_str().to_owned());
    let message = lead_says(
        hub,
        "app",
        format!(
            "Here they are.\n\n{}",
            ids.iter()
                .map(|id| block(id))
                .collect::<Vec<_>>()
                .join("\n\n")
        ),
    );
    let cards: Vec<(String, Option<AttachmentMime>, i64)> = message
        .parts
        .iter()
        .flatten()
        .filter_map(|p| match p.block.as_ref().map(|b| &b.body) {
            Some(BlockBody::File(f)) => Some((
                f.name.as_ref().unwrap().as_str().to_owned(),
                f.mime,
                f.bytes.unwrap().get(),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(
        cards,
        [
            (
                "itinerary.pdf".to_owned(),
                Some(AttachmentMime::Pdf),
                pdf.len() as i64
            ),
            ("receipts.csv".to_owned(), Some(AttachmentMime::Csv), 29),
            ("run.command.txt".to_owned(), Some(AttachmentMime::Text), 18),
        ]
    );
    assert_eq!(app_reads(hub, "app", &ids[0]).await.unwrap(), pdf);
    // An image block of a file that isn't an image shows as its card.
    let docx_id = docx.attachment_id.as_str().to_owned();
    let as_image = lead_says(hub, "app", image_block(&docx_id));
    assert!(matches!(
        as_image.parts.as_ref().unwrap()[1].block.as_ref().map(|b| &b.body),
        Some(BlockBody::File(f)) if f.mime == Some(AttachmentMime::Docx)
    ));
}

/// A person's Word document, workbook and CSV reach the lead in its project's folder, each in its line: an Office file
/// with its text written beside it for Read, a CSV as itself.
#[tokio::test]
async fn an_office_file_reaches_the_lead_with_its_text_beside_it() {
    let rig = rig().await;
    let hub = &rig.hub;
    let send = |name: &str, mime: AttachmentMime, bytes: &[u8]| {
        serde_json::from_value::<fleetd_contracts::mcp::AttachmentPutInput>(
            json!({ "name": name, "mime": mime, "dataB64": B64.encode(bytes) }),
        )
        .unwrap()
    };
    let docx = crate::hub::intake::office::tests::docx(&["Rent is due on the 1st."]);
    let mut ids = Vec::new();
    for (name, mime, bytes) in [
        ("lease.docx", AttachmentMime::Docx, docx.as_slice()),
        ("bank.csv", AttachmentMime::Csv, b"date,amount\n".as_slice()),
        (
            "empty.xlsx",
            AttachmentMime::Xlsx,
            b"PK\x03\x04 broken".as_slice(),
        ),
    ] {
        ids.push(
            attachments::put(hub, &person(), send(name, mime, bytes))
                .await
                .unwrap()
                .attachment_id,
        );
    }
    let lines = attachments::place(hub, &ids, &project("app"), "chat", None)
        .await
        .unwrap();
    assert_eq!(
        lines,
        [
            "  - .fleetd/attachments/chat/lease.docx (a Word document, 367 B); its text is in \
             .fleetd/attachments/chat/lease.docx.txt: open that with Read.",
            "  - .fleetd/attachments/chat/bank.csv (a CSV spreadsheet, 12 B); open it with Read.",
            "  - .fleetd/attachments/chat/empty.xlsx (an Excel spreadsheet, 11 B); fleetd found no text in it: read \
             it with a tool that opens it.",
        ]
    );
    let placed = rig.placed.lock().unwrap();
    let text = placed
        .iter()
        .find(|(path, _)| path == ".fleetd/attachments/chat/lease.docx.txt")
        .unwrap();
    assert_eq!(text.1, b"Rent is due on the 1st.\n");
}
