//! A lead (a Navi's too) picks up a change to its MCP servers by itself: its next turn starts a fresh session when a
//! server it gets was added, edited, removed or had its key replaced, never in the middle of a turn, and not for a
//! change that doesn't reach it. The chat says once that a new server is there.
use std::sync::Arc;

use fleetd_contracts::chat::{ChatAuthor, ChatMessage};
use fleetd_contracts::mcp_servers::McpServer;

use super::auto_start_tests::{Hub, hub};
use crate::hub::chat::Chat;
use crate::hub::leads::wakes::{LineKind, Trigger};
use crate::hub::store::{StoredThread, iso_ms, now_ms};

/// A started lead on `lead-1`, idle and warm, with the chat wired for fleetd's lines.
async fn lead() -> Hub {
    let hub = hub(true);
    let chat = Chat::new(
        Arc::clone(&hub.area.ctx.db),
        Arc::clone(&hub.events),
        hub.clock.clone(),
    );
    let _ = hub.area.ctx.hooks.chat.set(chat);
    hub.order("fix the five bugs").await;
    hub.after_debounce().await;
    thread(&hub, "lead-1", "idle");
    hub
}

fn thread(hub: &Hub, id: &str, status: &str) {
    let at = iso_ms(now_ms(hub.clock.as_ref()));
    hub.area
        .ctx
        .store
        .thread_upsert(&StoredThread {
            thread: serde_json::from_value(serde_json::json!({
                "machineId": "lab-a", "threadId": id, "projectId": "p-a", "title": "lead", "status": status,
                "headline": "", "latestMessageTail": "", "lastProgressAt": at, "stale": false, "asOf": at,
            }))
            .unwrap(),
            last_sequence: None,
            last_run_id: None,
            last_run_status: None,
        })
        .unwrap();
}

/// Saves a server as `mcp_server_set` does: in project p-a on lab-a, or `global`, with a secret header whose key on
/// lab-a has `key` for its fingerprint.
fn server(hub: &Hub, name: &str, url: &str, roles: serde_json::Value, key: &str) -> McpServer {
    server_in(
        hub,
        serde_json::json!({ "kind": "project", "machineId": "lab-a", "projectId": "p-a" }),
        name,
        url,
        roles,
        key,
    )
}

fn server_in(
    hub: &Hub,
    scope: serde_json::Value,
    name: &str,
    url: &str,
    roles: serde_json::Value,
    key: &str,
) -> McpServer {
    let server: McpServer = serde_json::from_value(serde_json::json!({
        "scope": scope, "name": name, "enabled": true, "roles": roles,
        "transport": { "type": "http", "url": url },
        "headers": [{ "name": "Authorization", "kind": "secret",
            "sealedOn": [{ "machineId": "lab-a", "fingerprint": key }] }],
        "updatedAt": iso_ms(0),
    }))
    .unwrap();
    hub.area.ctx.db.mcp_servers().put(&server).unwrap();
    server
}

fn lead_only() -> serde_json::Value {
    serde_json::json!({ "lead": true, "writers": false, "reviewers": false })
}

impl Hub {
    /// A wake's turn; then what it did: launches and sends so far.
    async fn turn(&self, text: &str) -> (usize, usize) {
        self.area.wakes.trigger(
            &self.project,
            Trigger::Line {
                kind: LineKind::TaskResult,
                text: text.into(),
            },
        );
        self.after_debounce().await;
        (
            self.node.launches.lock().unwrap().len(),
            self.node.sends.lock().unwrap().len(),
        )
    }

    /// fleetd's lines in the project's chat, oldest first.
    fn system_lines(&self) -> Vec<String> {
        let rows: Vec<String> = self
            .area
            .ctx
            .db
            .with(|c| {
                let mut stmt = c.prepare("SELECT data FROM chat_messages ORDER BY seq")?;
                let rows = stmt
                    .query_map([], |row| row.get(0))?
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

    fn lead_thread(&self) -> String {
        let lead = self.area.leads.get(&self.project).unwrap().unwrap();
        lead.thread_id.to_string()
    }
}

/// An added server: the next turn is a fresh session, like a cold lead's, and the chat says once it is there. The
/// fresh session then takes its turns as any lead does.
#[tokio::test(flavor = "current_thread")]
async fn an_added_server_starts_the_next_turn_fresh_and_says_so_once() {
    let hub = lead().await;
    let (launches, sends) = hub.turn("T1 done").await;
    assert_eq!(launches, 1, "warm and unchanged: resumed");

    server(
        &hub,
        "docs",
        "https://docs.example.com/mcp",
        lead_only(),
        "0000aaaa",
    );
    assert_eq!(
        hub.turn("T2 done").await,
        (2, sends),
        "fresh, nothing sent to the old session"
    );
    let fresh = hub.launched_prompts().pop().unwrap();
    assert!(fresh.ends_with("T2 done"), "{fresh}");
    assert_eq!(hub.lead_thread(), "lead-2");
    assert_eq!(hub.system_lines(), ["docs is connected: I can use it now."]);

    thread(&hub, "lead-2", "idle");
    assert_eq!(
        hub.turn("T3 done").await,
        (2, sends + 1),
        "the new session resumes"
    );
    assert_eq!(hub.system_lines().len(), 1);
}

/// An edited server, and one whose key was replaced, each reach the lead at its next turn; a removed one does too,
/// without a line.
#[tokio::test(flavor = "current_thread")]
async fn an_edited_a_rekeyed_and_a_removed_server_each_start_the_next_turn_fresh() {
    let hub = lead().await;
    server(
        &hub,
        "docs",
        "https://docs.example.com/mcp",
        lead_only(),
        "0000aaaa",
    );
    server(
        &hub,
        "pg",
        "https://pg.example.com/mcp",
        lead_only(),
        "0000bbbb",
    );
    assert_eq!(hub.turn("T1 done").await.0, 2);
    thread(&hub, "lead-2", "idle");

    server(
        &hub,
        "docs",
        "https://docs2.example.com/mcp",
        lead_only(),
        "0000aaaa",
    );
    assert_eq!(hub.turn("edited").await.0, 3);
    thread(&hub, "lead-3", "idle");

    server(
        &hub,
        "pg",
        "https://pg.example.com/mcp",
        lead_only(),
        "0000cccc",
    );
    assert_eq!(hub.turn("rekeyed").await.0, 4);
    thread(&hub, "lead-4", "idle");

    let pg: fleetd_contracts::mcp_servers::McpServerName =
        serde_json::from_value("pg".into()).unwrap();
    let scope = serde_json::from_value(
        serde_json::json!({ "kind": "project", "machineId": "lab-a", "projectId": "p-a" }),
    )
    .unwrap();
    assert!(hub.area.ctx.db.mcp_servers().remove(&scope, &pg).unwrap());
    assert_eq!(hub.turn("removed").await.0, 5);
    assert_eq!(hub.lead_thread(), "lead-5");
    assert_eq!(
        hub.system_lines(),
        [
            "docs and pg are connected: I can use them now.",
            "docs is connected: I can use it now.",
            "pg is connected: I can use it now.",
        ]
    );
}

/// A change that doesn't reach the lead's session leaves it resumed, its prompt cache intact: a server for other roles
/// only, another role on a lead's server, another project's server.
#[tokio::test(flavor = "current_thread")]
async fn a_change_that_doesnt_reach_the_lead_leaves_its_session_alone() {
    let hub = lead().await;
    server(
        &hub,
        "docs",
        "https://docs.example.com/mcp",
        lead_only(),
        "0000aaaa",
    );
    assert_eq!(hub.turn("T1 done").await.0, 2);
    thread(&hub, "lead-2", "idle");
    let lines = hub.system_lines();

    let writers = serde_json::json!({ "lead": false, "writers": true, "reviewers": true });
    server(
        &hub,
        "ci",
        "https://ci.example.com/mcp",
        writers,
        "0000dddd",
    );
    let all = serde_json::json!({ "lead": true, "writers": true, "reviewers": true });
    server(
        &hub,
        "docs",
        "https://docs.example.com/mcp",
        all,
        "0000aaaa",
    );
    let other =
        serde_json::json!({ "kind": "project", "machineId": "lab-a", "projectId": "p-other" });
    server_in(
        &hub,
        other,
        "wiki",
        "https://wiki.example.com/mcp",
        lead_only(),
        "0000eeee",
    );
    let (launches, sends) = hub.turn("T2 done").await;
    assert_eq!(launches, 2, "resumed");
    assert!(sends > 0);
    assert_eq!(hub.lead_thread(), "lead-2");
    assert_eq!(hub.system_lines(), lines);
}

/// A change while the lead works waits for the turn to end: that turn goes on in the same session, and the next one
/// starts fresh with the server.
#[tokio::test(flavor = "current_thread")]
async fn a_change_during_a_turn_applies_at_the_next_one() {
    let hub = lead().await;
    thread(&hub, "lead-1", "running");
    server(
        &hub,
        "docs",
        "https://docs.example.com/mcp",
        lead_only(),
        "0000aaaa",
    );
    let (launches, sends) = hub.turn("T1 done").await;
    assert_eq!(
        (launches, hub.lead_thread().as_str()),
        (1, "lead-1"),
        "not cut short"
    );
    assert!(hub.system_lines().is_empty());

    thread(&hub, "lead-1", "idle");
    assert_eq!(hub.turn("T2 done").await, (2, sends));
    assert_eq!(hub.system_lines(), ["docs is connected: I can use it now."]);
}
