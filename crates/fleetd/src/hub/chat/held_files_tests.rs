//! A held chat message's files reach the node once: while its lead can't start, each minute's retry asks the node
//! whether it already has each file (`has_file`) and sends only what it lacks. A node from before `has_file` gets
//! every file on every try, as before.
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::node_link::{CAP_HAS_FILE, HubToNode, NodeToHub};
use serde_json::{Value, json};

use super::flow;
use crate::hub::api::{Caller, Hub, HubConfig, Listen};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;
use crate::node::sessions::files;

const AT: &str = "2026-10-19T10:00:00.000Z";

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("app"),
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

/// What the node was sent: every frame's bytes on the link, and the bytes of each file put.
#[derive(Default)]
struct Wire {
    frame_bytes: usize,
    put_bytes: usize,
    puts: usize,
}

/// A hub with project app on devbox and no lead, linked to a node that writes files with the node's own `put_file`
/// and `has_file` into `root`, and whose claude is logged out, so its lead can't start. `caps` is what its hello
/// listed.
async fn rig(root: &Path, caps: &[&str]) -> (Arc<Hub>, Arc<Mutex<Wire>>, tempfile::TempDir) {
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
    hub.store
        .projects_upsert_many(
            &project().machine_id,
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "app", "title": "app", "workspaceRoot": root,
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    let machine = MachineId::unchecked("devbox");
    hub.link.set_capabilities(&machine, caps);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    hub.executors
        .attach(
            &machine,
            crate::hub::executor::NodeSessions {
                link_id: 1,
                send: tx,
            },
        )
        .await;
    let wire = Arc::new(Mutex::new(Wire::default()));
    let (executors, seen, root) = (hub.executors.clone(), wire.clone(), root.to_path_buf());
    tokio::spawn(async move {
        while let Some(HubToNode::SessionCall(f)) = rx.recv().await {
            seen.lock().unwrap().frame_bytes += serde_json::to_string(&f).unwrap().len();
            let call = serde_json::to_value(&f.call).unwrap();
            let s = |k: &str| call[k].as_str().unwrap_or_default().to_owned();
            let result = match call["op"].as_str() {
                Some("put_file") => {
                    let bytes = B64.decode(s("dataB64")).unwrap();
                    let mut w = seen.lock().unwrap();
                    w.put_bytes += bytes.len();
                    w.puts += 1;
                    match files::put_file(&root, &s("relPath"), &bytes) {
                        Ok(()) => json!({ "ok": { "kind": "done" } }),
                        Err(why) => json!({ "err": { "code": "invalid", "message": why } }),
                    }
                }
                Some("has_file") => {
                    let has = files::has_file(&root, &s("relPath"), &s("sha256"));
                    json!({ "ok": { "kind": "has_file", "has": has } })
                }
                Some("runner_info") => json!({ "ok": {
                    "kind": "runner_info", "runner": "claude", "version": "2.1.302", "supported": ">=2.1.300",
                    "versionOk": true, "login": "logged_out", "conformanceOk": true,
                } }),
                _ => json!({ "ok": { "kind": "done" } }),
            };
            let frame: NodeToHub = serde_json::from_value(
                json!({ "t": "session_reply", "id": f.id, "result": result }),
            )
            .unwrap();
            executors.handle_frame(&machine, frame);
        }
    });
    (hub, wire, home)
}

/// A person's message with a 2 MiB file, sent while the lead can't start: held.
async fn send_with_file(hub: &Arc<Hub>, data: &[u8]) -> Value {
    let tools = crate::hub::api::registry();
    let put = tools
        .call(
            hub,
            &person(),
            "attachment_put",
            json!({ "name": "report.pdf", "mime": "application/pdf", "dataB64": B64.encode(data) }),
        )
        .await
        .unwrap();
    tools
        .call(
            hub,
            &person(),
            "chat_send",
            json!({ "projectRef": { "machineId": "devbox", "projectId": "app" }, "text": "read this",
              "attachments": [put["attachmentId"]], "clientRequestId": "c1" }),
        )
        .await
        .unwrap()
}

fn pdf() -> Vec<u8> {
    let mut data = b"%PDF-1.7\n".to_vec();
    data.resize(2 * 1024 * 1024, b'x');
    data
}

#[tokio::test]
async fn a_held_messages_file_goes_to_the_node_once_while_its_lead_cant_start() {
    let root = tempfile::tempdir().unwrap();
    let (hub, wire, _home) = rig(root.path(), &[CAP_HAS_FILE]).await;
    let data = pdf();
    let sent = send_with_file(&hub, &data).await;
    let why = sent["leadWaiting"].as_str().unwrap_or_default();
    assert!(why.contains("claude is not logged in"), "{sent}");
    // The minute's sweep tries three more times; the lead fails to start each time.
    let sent_first = wire.lock().unwrap().frame_bytes;
    for _ in 0..3 {
        flow::send_held(&hub, &project()).await;
        assert_eq!(hub.chat.held(&project()).unwrap().len(), 1, "still held");
    }
    let w = wire.lock().unwrap();
    let per_retry = (w.frame_bytes - sent_first) / 3;
    eprintln!("to the node: {sent_first} bytes on send, then {per_retry} bytes per minute's retry");
    assert_eq!(
        (w.puts, w.put_bytes),
        (1, data.len()),
        "the file's bytes went to the node once"
    );
    assert!(per_retry < 2048, "a retry costs {per_retry} bytes");
    let placed = root.path().join(".fleetd/attachments/chat/report.pdf");
    assert_eq!(std::fs::read(placed).unwrap(), data);
}

/// A file the node lost, or one another message put at the same path, is sent again; a node from before `has_file`
/// gets it on every try.
#[tokio::test]
async fn a_file_the_node_lacks_is_still_sent() {
    let root = tempfile::tempdir().unwrap();
    let (hub, wire, _home) = rig(root.path(), &[CAP_HAS_FILE]).await;
    let data = pdf();
    send_with_file(&hub, &data).await;
    let placed = root.path().join(".fleetd/attachments/chat/report.pdf");
    std::fs::remove_file(&placed).unwrap();
    flow::send_held(&hub, &project()).await;
    std::fs::write(&placed, b"another report").unwrap();
    flow::send_held(&hub, &project()).await;
    assert_eq!(
        wire.lock().unwrap().puts,
        3,
        "gone, then changed: sent each time"
    );
    assert_eq!(std::fs::read(&placed).unwrap(), data);

    let older = tempfile::tempdir().unwrap();
    let (hub, wire, _home) = rig(older.path(), &[]).await;
    send_with_file(&hub, &data).await;
    flow::send_held(&hub, &project()).await;
    let w = wire.lock().unwrap();
    assert_eq!(
        (w.puts, w.put_bytes),
        (2, 2 * data.len()),
        "an older node, as before"
    );
}
