use fleetd_contracts::integrations::{
    IntegrationKind, McpIntegration, McpToolName, ToolAction, ToolPolicy, ToolPreview,
};
use fleetd_contracts::mcp_servers::McpServer;
use fleetd_contracts::prim::List;
use serde_json::{Value, json};

use super::policy::{Never, Verdict, launch_rules, tool_policy, verdict, words};

fn server(name: &str, kind: IntegrationKind, reads: &[&str]) -> McpServer {
    let mut s: McpServer = serde_json::from_value(json!({
        "scope": { "kind": "project", "machineId": "devbox", "projectId": "navi" },
        "name": name,
        "enabled": true,
        "roles": { "lead": true, "writers": false, "reviewers": false },
        "transport": { "type": "http", "url": "http://127.0.0.1:8787/mcp" },
        "updatedAt": "2026-10-27T00:00:00Z"
    }))
    .unwrap();
    s.integration = Some(McpIntegration {
        kind,
        read_tools: List::new(
            reads
                .iter()
                .map(|r| McpToolName::new(*r).unwrap())
                .collect(),
        )
        .unwrap(),
    });
    s
}

fn navi() -> Vec<McpServer> {
    vec![
        server("google", IntegrationKind::Google, &[]),
        server("notion", IntegrationKind::Notion, &[]),
        server(
            "bank",
            IntegrationKind::Custom,
            &["get_balance", "transfer_funds"],
        ),
    ]
}

fn ask(tool: &str, input: Value) -> ToolPreview {
    match verdict(tool, &input, &navi()) {
        Some(Verdict::Ask(p)) => *p,
        other => panic!("{tool}: expected an ask, got {other:?}"),
    }
}

fn blocked(tool: &str, input: Value) -> &'static str {
    match verdict(tool, &input, &navi()) {
        Some(Verdict::Block(why)) => why,
        other => panic!("{tool}: expected a block, got {other:?}"),
    }
}

#[test]
fn reads_pass_unasked() {
    for tool in [
        "mcp__google__search_threads",
        "mcp__google__get_thread",
        "mcp__google__list_calendar_events",
        "mcp__google__workspace__drive_search",
        "mcp__google__docs__docs_read",
        "mcp__notion__API-post-search",
        "mcp__notion__API-retrieve-a-page",
        "mcp__notion__API-get-block-children",
        "mcp__bank__get_balance",
    ] {
        assert_eq!(
            verdict(tool, &json!({}), &navi()),
            Some(Verdict::Allow),
            "{tool}"
        );
    }
}

#[test]
fn an_email_asks_with_every_recipient_the_subject_and_the_whole_body() {
    let p = ask(
        "mcp__google__send_message",
        json!({
            "account": "me@example.com",
            "to": "Ana <ana@example.com>, bo@example.com",
            "cc": ["cy@example.com"],
            "bcc": ["dee@example.com"],
            "subject": "Lunch on Tuesday",
            "body": "Hi Ana,\n\nTuesday at noon?\n\nNavi"
        }),
    );
    assert_eq!(p.action, ToolAction::Send);
    assert_eq!(p.integration, IntegrationKind::Google);
    assert_eq!(p.title.as_str(), "Send an email");
    assert_eq!(p.account.as_deref(), Some("me@example.com"));
    let all = |l: &[fleetd_contracts::prim::Line<1, 320>]| {
        l.iter().map(|a| a.as_str().to_owned()).collect::<Vec<_>>()
    };
    assert_eq!(all(&p.to), ["Ana <ana@example.com>", "bo@example.com"]);
    assert_eq!(all(&p.cc), ["cy@example.com"]);
    assert_eq!(all(&p.bcc), ["dee@example.com"]);
    assert_eq!(p.subject.as_deref(), Some("Lunch on Tuesday"));
    assert_eq!(
        p.body.as_deref(),
        Some("Hi Ana,\n\nTuesday at noon?\n\nNavi")
    );
    assert!(!p.body_cut);
    // Nothing is hidden: the whole input is on the card too.
    assert!(p.input.contains("dee@example.com") && p.input.contains("\"account\""));
}

#[test]
fn a_reply_says_who_it_reaches_when_the_tool_picks_them() {
    let one = ask(
        "mcp__google__reply",
        json!({ "message_id": "18c2", "body": "Yes." }),
    );
    assert_eq!(one.action, ToolAction::Send);
    assert!(one.to.is_empty());
    assert!(one.audience.as_deref().unwrap().contains("sender"));
    assert_eq!(one.target.as_deref(), Some("Message 18c2"));
    let all = ask(
        "mcp__google__reply",
        json!({ "message_id": "18c2", "body": "Yes.", "reply_all": true }),
    );
    assert!(all.audience.as_deref().unwrap().starts_with("Everyone"));
}

#[test]
fn an_event_with_guests_is_a_send_and_one_without_is_a_write() {
    let invite = ask(
        "mcp__google__create_calendar_event",
        json!({
            "summary": "Design review",
            "description": "Agenda in the doc.",
            "start": "2026-11-03T10:00:00+01:00",
            "end": "2026-11-03T11:00:00+01:00",
            "attendees": ["ana@example.com", "bo@example.com"]
        }),
    );
    assert_eq!(invite.action, ToolAction::Send);
    assert_eq!(invite.to.len(), 2);
    assert_eq!(invite.subject.as_deref(), Some("Design review"));
    assert_eq!(
        invite.when.as_deref(),
        Some("2026-11-03T10:00:00+01:00 → 2026-11-03T11:00:00+01:00")
    );
    assert_eq!(invite.audience.as_deref(), Some("Google emails each guest"));
    let alone = ask(
        "mcp__google__create_calendar_event",
        json!({ "summary": "Focus", "start": "2026-11-03T10:00:00Z", "end": "2026-11-03T12:00:00Z" }),
    );
    assert_eq!(alone.action, ToolAction::Write);
    assert!(alone.audience.is_none());
}

#[test]
fn writes_and_deletes_ask_too() {
    assert_eq!(
        ask(
            "mcp__google__create_draft",
            json!({ "to": "a@example.com", "subject": "s", "body": "b" })
        )
        .action,
        ToolAction::Write
    );
    assert_eq!(
        ask("mcp__google__trash", json!({ "thread_id": "t1" })).action,
        ToolAction::Delete
    );
    assert_eq!(
        ask(
            "mcp__google__workspace__drive_trash",
            json!({ "fileId": "f1" })
        )
        .action,
        ToolAction::Delete
    );
    let doc = ask(
        "mcp__google__workspace__docs_append",
        json!({ "documentId": "d1", "markdown": "## Notes" }),
    );
    assert_eq!(doc.action, ToolAction::Write);
    assert_eq!(doc.target.as_deref(), Some("d1"));
    assert_eq!(doc.body.as_deref(), Some("## Notes"));
    // A tool xaq adds later, unknown here, asks.
    assert_eq!(
        ask("mcp__google__snooze_thread", json!({})).action,
        ToolAction::Write
    );
}

#[test]
fn a_notion_change_shows_the_page_and_the_text() {
    let p = ask(
        "mcp__notion__API-patch-block-children",
        json!({
            "block_id": "b1",
            "children": [{ "paragraph": { "rich_text": [{ "text": { "content": "Call the plumber" } }] } }]
        }),
    );
    assert_eq!(p.action, ToolAction::Write);
    assert_eq!(p.target.as_deref(), Some("b1"));
    assert_eq!(p.body.as_deref(), Some("Call the plumber"));
    let page = ask(
        "mcp__notion__API-post-page",
        json!({
            "parent": { "page_id": "p0" },
            "properties": { "title": { "title": [{ "text": { "content": "Trip" } }] } }
        }),
    );
    assert_eq!(page.subject.as_deref(), Some("Trip"));
    assert_eq!(page.target.as_deref(), Some("Inside p0"));
    let trash = ask(
        "mcp__notion__API-patch-page",
        json!({ "page_id": "p1", "archived": true }),
    );
    assert_eq!(trash.action, ToolAction::Delete);
    assert_eq!(trash.title.as_str(), "Move a Notion page to the trash");
    assert_eq!(
        ask(
            "mcp__notion__API-delete-a-block",
            json!({ "block_id": "b" })
        )
        .action,
        ToolAction::Delete
    );
}

#[test]
fn a_custom_tool_asks_unless_marked_as_reading() {
    let p = ask("mcp__bank__update_payee", json!({ "name": "Ana" }));
    assert_eq!(p.integration, IntegrationKind::Custom);
    assert_eq!(p.title.as_str(), "Change with update_payee on bank");
    assert_eq!(
        ask("mcp__bank__pay_invoice", json!({})).action,
        ToolAction::Spend
    );
    // The person's own servers from their claude setup aren't configured here: custom, every tool asks.
    assert_eq!(ask("mcp__mine__lookup", json!({})).server.as_str(), "mine");
}

#[test]
fn blocked_stays_blocked_even_when_marked_as_reading() {
    assert_eq!(
        blocked("mcp__bank__transfer_funds", json!({})),
        Never::Money.why()
    );
    assert_eq!(
        blocked("mcp__bank__sellStock", json!({})),
        Never::Trading.why()
    );
    assert_eq!(
        blocked("mcp__bank__place_trade", json!({})),
        Never::Trading.why()
    );
    for money in [
        "mcp__bank__send_money",
        "mcp__bank__move_money",
        "mcp__bank__send_funds",
        "mcp__bank__send_transaction",
        "mcp__bank__broadcastTx",
    ] {
        assert_eq!(blocked(money, json!({})), Never::Money.why(), "{money}");
    }
    for trade in [
        "mcp__bank__buy_stock",
        "mcp__bank__buy_shares",
        "mcp__bank__place_order",
        "mcp__bank__buy_crypto",
        "mcp__bank__close_position",
    ] {
        assert_eq!(blocked(trade, json!({})), Never::Trading.why(), "{trade}");
    }
    // Buying something that isn't a holding is spending: it asks, marked as such.
    assert_eq!(
        ask("mcp__bank__buy_ticket", json!({})).action,
        ToolAction::Spend
    );
    assert_eq!(
        blocked("mcp__bank__create_account", json!({})),
        Never::Accounts.why()
    );
    assert_eq!(
        blocked("mcp__google__sign_up", json!({})),
        Never::Accounts.why()
    );
    let rules = launch_rules(&navi());
    assert!(
        rules
            .disallowed
            .contains(&"mcp__bank__transfer_funds".to_owned())
    );
    assert!(!rules.allowed.iter().any(|r| r.contains("transfer")));
}

#[test]
fn a_send_holding_a_credential_is_blocked() {
    assert_eq!(
        blocked(
            "mcp__google__send_message",
            json!({ "to": "x@example.com", "subject": "key", "body": "here: ghp_abcdefghijklmnopqrstuvwxyz0123" })
        ),
        Never::Credential.why()
    );
    assert_eq!(
        blocked(
            "mcp__notion__API-post-page",
            json!({ "properties": { "title": { "title": [{ "text": { "content": "api_key = sk-proj-abcdefghijklmnopqrstuvwx" } }] } } })
        ),
        Never::Credential.why()
    );
}

#[test]
fn only_mcp_tools_are_this_table_s() {
    for tool in [
        "Bash",
        "Read",
        "mcp__fleetd__chat_send",
        "mcp__",
        "mcp__google",
    ] {
        assert_eq!(verdict(tool, &json!({}), &navi()), None, "{tool}");
    }
}

#[test]
fn a_long_body_is_cut_on_the_card_but_the_input_never_is() {
    let body = "x".repeat(30_000);
    let p = ask(
        "mcp__google__send_message",
        json!({ "to": "a@example.com", "subject": "s", "body": body }),
    );
    assert!(p.body_cut);
    assert_eq!(p.body.as_deref().unwrap().chars().count(), 20_000);
    assert!(p.input.contains(&body));
    // Too large to show whole: refused, never asked about half-seen.
    assert_eq!(
        blocked(
            "mcp__google__send_message",
            json!({ "to": "a@example.com", "subject": "s", "body": "x".repeat(120_000) })
        ),
        super::policy::TOO_LARGE
    );
}

#[test]
fn launch_rules_allow_the_reads_of_the_lead_s_servers_only() {
    let mut servers = navi();
    let mut off = server("other", IntegrationKind::Custom, &["peek"]);
    off.enabled = false;
    servers.push(off);
    let rules = launch_rules(&servers);
    for r in [
        "mcp__google__search_threads",
        "mcp__google__workspace__drive_search",
        "mcp__notion__API-post-search",
        "mcp__bank__get_balance",
    ] {
        assert!(rules.allowed.contains(&r.to_owned()), "{r}");
    }
    assert!(!rules.allowed.iter().any(|r| r.contains("send_message")));
    assert!(!rules.allowed.iter().any(|r| r.starts_with("mcp__other__")));
}

#[test]
fn the_connect_screen_s_policy_by_name() {
    let s = navi();
    assert_eq!(tool_policy(&s[0], "get_thread"), ToolPolicy::Read);
    assert_eq!(tool_policy(&s[0], "send_message"), ToolPolicy::Ask);
    assert_eq!(tool_policy(&s[2], "transfer_funds"), ToolPolicy::Blocked);
}

#[test]
fn names_split_into_words() {
    assert_eq!(words("createAccount"), ["create", "account"]);
    assert_eq!(
        words("API-create-a-comment"),
        ["api", "create", "a", "comment"]
    );
    assert_eq!(words("sign_up"), ["sign", "up"]);
    assert_eq!(words("getHTTPStatus"), ["get", "httpstatus"]);
}

#[test]
fn review_follow_ups_a_share_reads_as_a_share_a_changed_event_reaches_its_guests_and_an_encoded_key_is_found()
 {
    assert_eq!(
        ask(
            "mcp__google__workspace__drive_share",
            json!({ "fileId": "f1" })
        )
        .action,
        ToolAction::Share
    );
    let changed = ask(
        "mcp__google__update_calendar_event",
        json!({ "event_id": "e1", "start": "2026-11-03T10:00:00Z", "end": "2026-11-03T11:00:00Z" }),
    );
    assert_eq!(changed.action, ToolAction::Send);
    assert!(
        changed
            .audience
            .as_deref()
            .unwrap()
            .contains("Google emails them")
    );
    let quiet = ask(
        "mcp__google__update_calendar_event",
        json!({ "event_id": "e1", "summary": "Focus", "notify_attendees": false }),
    );
    assert_eq!(quiet.action, ToolAction::Write);
    let encoded = json!({ "block_id": "b1", "children": "[{\"paragraph\":{\"text\":\"api_key = abcd1234efgh5678\"}}]" });
    assert_eq!(
        blocked("mcp__notion__API-patch-block-children", encoded),
        Never::Credential.why()
    );
}
