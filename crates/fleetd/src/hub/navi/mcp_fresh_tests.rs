//! A Navi picks up the servers connected under its Integrations by itself, over a real hub and a fake node: each one
//! connected, edited or disconnected the way the app's connect screen saves it (`mcp_server_set` with an integration)
//! makes the Navi's next chat message start a fresh session, and the chat says once that a new one is there. A server
//! of another project leaves the Navi's session as it is.
use std::sync::Arc;

use fleetd_contracts::chat::{ChatAuthor, ChatMessage};
use fleetd_contracts::ids::{ProjectId, ProjectRef};
use fleetd_contracts::node_link::{CAP_ASSISTANT, CAP_MCP_SERVERS, CAP_REPOS};
use fleetd_contracts::sessions::SessionCall;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::tests::{devbox, hub, node};
use crate::hub::api::{Caller, Hub, registry};

/// The Navi's owner: an owner's or admin's device.
fn person() -> Caller {
    let c = serde_json::from_value::<Caller>(json!({
        "keyId": "k1", "name": "laptop", "prefix": "fld_abcdef", "createdAt": "2026-10-27T10:00:00.000Z",
        "grants": [{ "role": "admin", "machines": "*" }],
    }))
    .unwrap();
    Caller {
        kind: Some(fleetd_contracts::auth::KeyKind::Human),
        ..c
    }
}

async fn ok(hub: &Arc<Hub>, tool: &str, input: Value) -> Value {
    match registry().call(hub, &person(), tool, input).await {
        Ok(v) => v,
        Err(e) => panic!("{tool}: {e:?}"),
    }
}

/// The launches and sends the node got since the last look.
async fn turns(calls: &mut mpsc::UnboundedReceiver<SessionCall>) -> (usize, usize) {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    let (mut launches, mut sends) = (0, 0);
    while let Ok(call) = calls.try_recv() {
        match call {
            SessionCall::Launch(_) => launches += 1,
            SessionCall::Send { .. } => sends += 1,
            _ => {}
        }
    }
    (launches, sends)
}

struct Navi {
    hub: Arc<Hub>,
    calls: mpsc::UnboundedReceiver<SessionCall>,
    r: ProjectRef,
    _home: tempfile::TempDir,
}

impl Navi {
    /// A message from the person, once the Navi's last turn ended.
    async fn say(&mut self, text: &str) -> (usize, usize) {
        if let Some(lead) = self.hub.leads.leads.get(&self.r).unwrap() {
            let at = crate::hub::store::iso_ms(crate::hub::store::now_ms(self.hub.clock.as_ref()));
            self.hub
                .store
                .thread_upsert(&crate::hub::store::StoredThread {
                    thread: serde_json::from_value(json!({
                        "machineId": "devbox", "threadId": lead.thread_id, "projectId": self.r.project_id,
                        "title": "Navi", "status": "idle", "headline": "", "latestMessageTail": "",
                        "lastProgressAt": at, "stale": false, "asOf": at,
                    }))
                    .unwrap(),
                    last_sequence: None,
                    last_run_id: None,
                    last_run_status: None,
                })
                .unwrap();
        }
        let input = json!({ "projectRef": self.r, "text": text, "clientRequestId": text });
        ok(&self.hub, "chat_send", input).await;
        turns(&mut self.calls).await
    }

    /// Connects (or saves again) a server as the Navi's Integrations screen does: for its lead, marked an integration.
    async fn connect(&self, name: &str, url: &str) {
        let server = json!({ "scope": scope(&self.r), "name": name, "enabled": true,
            "roles": { "lead": true, "writers": false, "reviewers": false },
            "transport": { "type": "http", "url": url },
            "headers": [{ "kind": "plain", "name": "X-Team", "value": "home" }],
            "integration": {} });
        ok(&self.hub, "mcp_server_set", server).await;
    }

    fn system_lines(&self) -> Vec<String> {
        let rows: Vec<String> = self
            .hub
            .db
            .with(|c| {
                let mut stmt =
                    c.prepare("SELECT data FROM chat_messages WHERE project_id = ? ORDER BY seq")?;
                let rows = stmt
                    .query_map([self.r.project_id.as_str()], |row| row.get(0))?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(rows)
            })
            .unwrap();
        rows.iter()
            .map(|d| serde_json::from_str::<ChatMessage>(d).unwrap())
            .filter(|m| m.author == ChatAuthor::System)
            .map(|m| m.text.to_string())
            .collect()
    }
}

fn scope(r: &ProjectRef) -> Value {
    json!({ "kind": "project", "machineId": r.machine_id, "projectId": r.project_id })
}

/// A Navi whose lead started on the person's first message.
async fn navi() -> Navi {
    let (hub, home) = hub();
    let calls = node(&hub, &[CAP_REPOS, CAP_ASSISTANT, CAP_MCP_SERVERS]).await;
    // Online by its runner's verdict: a send goes now, not through the offline queue.
    hub.executors.set_runner_ready(&devbox(), true);
    let made = ok(&hub, "navi_create", json!({ "name": "Home" })).await;
    let r = ProjectRef {
        machine_id: devbox(),
        project_id: ProjectId::unchecked(made["navi"]["projectId"].as_str().unwrap()),
    };
    let mut navi = Navi {
        hub,
        calls,
        r,
        _home: home,
    };
    assert_eq!(
        navi.say("hello").await,
        (1, 0),
        "the first message starts it"
    );
    assert_eq!(
        navi.say("what's on today?").await,
        (0, 1),
        "then it resumes"
    );
    navi
}

#[tokio::test]
async fn a_server_connected_edited_or_disconnected_on_a_navi_reaches_its_next_message() {
    let mut navi = navi().await;

    navi.connect("crm", "https://crm.example.com/mcp").await;
    assert_eq!(navi.say("any new leads?").await, (1, 0), "connected: fresh");
    assert_eq!(navi.system_lines(), ["crm is connected: I can use it now."]);
    assert_eq!(navi.say("thanks").await, (0, 1), "then it resumes");

    navi.connect("crm", "https://crm2.example.com/mcp").await;
    assert_eq!(navi.say("and now?").await, (1, 0), "edited: fresh");

    let removed = json!({ "scope": scope(&navi.r), "name": "crm" });
    ok(&navi.hub, "mcp_server_remove", removed).await;
    assert_eq!(
        navi.say("still there?").await,
        (1, 0),
        "disconnected: fresh"
    );
    assert_eq!(
        navi.system_lines(),
        [
            "crm is connected: I can use it now.",
            "crm is connected: I can use it now.",
        ]
    );

    // A server of the project of code beside it doesn't reach the Navi.
    let p1 = ProjectRef {
        machine_id: devbox(),
        project_id: ProjectId::unchecked("p1"),
    };
    let server = json!({ "scope": scope(&p1), "name": "ci", "enabled": true,
        "roles": { "lead": true, "writers": true, "reviewers": false },
        "transport": { "type": "http", "url": "https://ci.example.com/mcp" } });
    ok(&navi.hub, "mcp_server_set", server).await;
    assert_eq!(navi.say("ok").await, (0, 1), "resumed");
    assert_eq!(navi.system_lines().len(), 2);
}
