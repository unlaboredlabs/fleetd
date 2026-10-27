use fleetd_contracts::integrations::{
    IntegrationKind, McpIntegration, McpToolName, ToolAction, ToolPolicy, ToolPreview,
};
use fleetd_contracts::mcp_servers::McpServer;
use fleetd_contracts::prim::List;
use serde_json::{Value, json};

use super::policy::{
    Never, Verdict, attachment_size, launch_rules, sends_credential, shown_input, tool_policy,
    verdict, words,
};

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

/// The native server as the hub gives it to a Navi with a Google account: `fleetd google-mcp`.
fn native_google() -> McpServer {
    let mut s = server("google", IntegrationKind::Google, &[]);
    s.transport = serde_json::from_value(
        json!({ "type": "stdio", "command": "fleetd", "args": ["google-mcp"] }),
    )
    .unwrap();
    s
}

fn navi() -> Vec<McpServer> {
    vec![
        native_google(),
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
        "mcp__google__get_calendar_event",
        "mcp__google__drive_search",
        "mcp__google__drive_read",
        // A draft sends nothing: the person finds it in Drafts.
        "mcp__google__create_draft",
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
    // Nothing is hidden: the whole input is on the card too.
    assert!(p.input.contains("dee@example.com") && p.input.contains("\"bcc\""));
}

#[test]
fn a_reply_shows_the_recipients_it_names() {
    let p = ask(
        "mcp__google__reply",
        json!({ "message_id": "18c2", "to": ["bo@vendor.test"], "cc": ["cy@vendor.test"], "body": "Yes." }),
    );
    assert_eq!(p.action, ToolAction::Send);
    assert_eq!(p.title.as_str(), "Reply to an email");
    assert_eq!(p.to[0].as_str(), "bo@vendor.test");
    assert_eq!(p.cc[0].as_str(), "cy@vendor.test");
    assert_eq!(p.body.as_deref(), Some("Yes."));
    assert_eq!(p.target.as_deref(), Some("Reply to message 18c2"));
}

#[test]
fn an_event_shows_its_guests_and_whether_google_emails_them() {
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
    assert_eq!(invite.body.as_deref(), Some("Agenda in the doc."));
    assert_eq!(
        invite.when.as_deref(),
        Some("2026-11-03T10:00:00+01:00 → 2026-11-03T11:00:00+01:00")
    );
    assert_eq!(
        invite.audience.as_deref(),
        Some("Google emails each guest an invitation")
    );
    let quiet = ask(
        "mcp__google__create_calendar_event",
        json!({ "summary": "Sync", "start": "2026-11-03", "end": "2026-11-04",
                "attendees": ["ana@example.com"], "notify_attendees": false }),
    );
    assert_eq!(quiet.action, ToolAction::Write);
    assert!(quiet.audience.as_deref().unwrap().contains("doesn't email"));
    let alone = ask(
        "mcp__google__create_calendar_event",
        json!({ "summary": "Focus", "start": "2026-11-03T10:00:00Z", "end": "2026-11-03T12:00:00Z" }),
    );
    assert_eq!(alone.action, ToolAction::Write);
    assert!(alone.audience.is_none());
}

#[test]
fn a_changed_event_lists_everyone_google_emails_the_removed_included() {
    let silent = ask(
        "mcp__google__update_calendar_event",
        json!({ "event_id": "e3", "summary": "Moved" }),
    );
    assert_eq!(silent.action, ToolAction::Write);
    assert_eq!(silent.target.as_deref(), Some("Event e3"));
    let told = ask(
        "mcp__google__update_calendar_event",
        json!({ "event_id": "e3", "attendees": ["bo@vendor.test"], "removed_attendees": ["cy@vendor.test"],
                "notify_attendees": true }),
    );
    assert_eq!(told.action, ToolAction::Send);
    let to: Vec<&str> = told.to.iter().map(|a| a.as_str()).collect();
    assert_eq!(to, ["bo@vendor.test", "cy@vendor.test"]);
    assert_eq!(
        told.audience.as_deref(),
        Some(
            "Google emails each guest about the change, and a cancellation to the 1 removed: cy@vendor.test"
        )
    );
}

#[test]
fn an_upload_shows_the_file_and_a_share_whom_it_reaches() {
    let up = ask(
        "mcp__google__drive_upload",
        json!({ "name": "notes.txt", "content": "line one\nline two", "folder_id": "fo1" }),
    );
    assert_eq!(up.action, ToolAction::Write);
    assert_eq!(up.title.as_str(), "Upload notes.txt to Drive");
    assert_eq!(up.subject.as_deref(), Some("notes.txt (17 bytes)"));
    assert_eq!(up.body.as_deref(), Some("line one\nline two"));
    assert_eq!(up.target.as_deref(), Some("Folder fo1"));

    let share = ask(
        "mcp__google__drive_share",
        json!({ "file_id": "f1", "emails": ["bo@vendor.test", "cy@vendor.test"], "role": "writer",
                "message": "Have a look" }),
    );
    assert_eq!(share.action, ToolAction::Share);
    assert_eq!(share.title.as_str(), "Share a Drive file as writer");
    assert_eq!(share.to.len(), 2);
    assert_eq!(share.body.as_deref(), Some("Have a look"));
    assert_eq!(share.target.as_deref(), Some("File f1"));
    assert_eq!(
        share.audience.as_deref(),
        Some("Google emails each of them a link")
    );
    // A tool added later, unknown here, asks.
    assert_eq!(
        ask("mcp__google__snooze_thread", json!({})).action,
        ToolAction::Write
    );
}

/// The policy's reads are exactly the tools the server marks read-only.
#[test]
fn the_table_reads_what_the_server_marks_read_only() {
    let mut served: Vec<&str> = crate::node::google::tools::reads().collect();
    let mut table = super::google::READS.to_vec();
    served.sort();
    table.sort();
    assert_eq!(served, table);
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
    assert_eq!(p.title.as_str(), "Use update_payee on bank");
    assert_eq!(
        ask("mcp__bank__pay_invoice", json!({})).action,
        ToolAction::Spend
    );
    // The person's own servers from their claude setup aren't configured here: custom, every tool asks.
    assert_eq!(ask("mcp__mine__lookup", json!({})).server.as_str(), "mine");
}

#[test]
fn only_the_native_server_gets_google_s_table() {
    // An xaq-style server marked Google, or one that takes the native server's name: plain custom servers, each write
    // asking with its whole input.
    let xaq = server("google", IntegrationKind::Google, &["search_threads"]);
    let mut stdio = native_google();
    stdio.name = fleetd_contracts::mcp_servers::McpServerName::new("gmail").unwrap();
    for s in [xaq, stdio] {
        let name = s.name.as_str().to_owned();
        let servers = [s];
        let tool = format!("mcp__{name}__create_draft");
        let input = json!({ "to": ["ana@example.com"], "body": "Hi" });
        let Some(Verdict::Ask(p)) = verdict(&tool, &input, &servers) else {
            panic!("{tool}: expected an ask");
        };
        assert_eq!(p.integration, IntegrationKind::Custom);
        assert_eq!(p.title.as_str(), format!("Use create_draft on {name}"));
        assert!(p.input.contains("ana@example.com") && p.input.contains("\"body\""));
        assert!(p.to.is_empty());
        assert!(
            !launch_rules(&servers)
                .allowed
                .iter()
                .any(|r| r.ends_with("__create_draft"))
        );
    }
    // What the person marked as reading still reads.
    let xaq = [server(
        "google",
        IntegrationKind::Google,
        &["search_threads"],
    )];
    assert_eq!(
        verdict("mcp__google__search_threads", &json!({}), &xaq),
        Some(Verdict::Allow)
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
fn a_long_body_comes_whole_and_too_large_a_call_is_refused() {
    let body = "x".repeat(30_000);
    let p = ask(
        "mcp__google__send_message",
        json!({ "to": "a@example.com", "subject": "s", "body": body }),
    );
    assert_eq!(p.body.as_deref(), Some(body.as_str()));
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
fn mail_with_attachments_is_refused_before_any_card() {
    // fleetd's own Google tools can't attach files yet: the person is never asked to approve a call that would fail.
    for tool in ["send_message", "reply", "create_draft"] {
        let input = json!({ "to": "a@example.com", "subject": "Lease", "body": "Attached.",
            "attachments": [{ "content_base64": "QUJD", "filename": "tenant-form.pdf" }] });
        assert_eq!(
            blocked(&format!("mcp__google__{tool}"), input),
            Never::Attachments.why(),
            "{tool}"
        );
    }
    // Without files, a draft still runs unasked.
    assert_eq!(
        verdict(
            "mcp__google__create_draft",
            &json!({ "to": "a@example.com", "body": "Hi" }),
            &navi()
        ),
        Some(Verdict::Allow)
    );
    // A file's bytes are said by their size, which no one reads: 300 KB, past the card's bound as base64.
    let shown = shown_input(
        IntegrationKind::Google,
        &json!({ "attachments": [{ "content_base64": "QUJD".repeat(100_000), "filename": "tenant-form.pdf" }] }),
    );
    let shown = shown.to_string();
    assert!(shown.contains("[the file's 300000 bytes]") && !shown.contains("QUJD"));
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
        "mcp__google__drive_search",
        "mcp__google__create_draft",
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
        ask("mcp__google__drive_share", json!({ "file_id": "f1" })).action,
        ToolAction::Share
    );
    // A change emails its guests only when told to, naming them all.
    let changed = ask(
        "mcp__google__update_calendar_event",
        json!({ "event_id": "e1", "start": "2026-11-03T10:00:00Z", "end": "2026-11-03T11:00:00Z",
                "attendees": ["bo@vendor.test"], "notify_attendees": true }),
    );
    assert_eq!(changed.action, ToolAction::Send);
    assert_eq!(changed.to[0].as_str(), "bo@vendor.test");
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

#[test]
fn only_a_google_tool_s_file_bytes_are_said_by_size_and_a_credential_anywhere_is_still_refused() {
    // A key in a field called content_base64 that doesn't decode as base64 isn't a file: read as text and refused, on
    // any server.
    assert!(sends_credential(
        IntegrationKind::Google,
        &json!({ "attachments": [{ "content_base64": "sk-ant-abcdefghijklmnop0123", "filename": "k.txt" }] })
    ));
    assert_eq!(
        blocked(
            "mcp__bank__update_payee",
            json!({ "content_base64": "sk-ant-abcdefghijklmnop0123" })
        ),
        Never::Credential.why()
    );
    // A custom server's content_base64 is shown as it is: the card hides nothing of it.
    let p = ask(
        "mcp__bank__upload_statement",
        json!({ "content_base64": "QUJD" }),
    );
    assert!(p.input.contains("\"QUJD\""));
    // An attachment without a filename isn't the shape file bytes come in: shown as it is too.
    let q = shown_input(
        IntegrationKind::Google,
        &json!({ "attachments": [{ "content_base64": "QUJD" }] }),
    );
    assert!(q.to_string().contains("\"QUJD\""));
}

#[test]
fn wrapped_and_large_attachments_are_files_and_a_key_inside_one_is_still_found() {
    use base64::Engine;
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    // A large file whose base64 happens to spell a Google API key's shape, the one shape random base64 can: a file,
    // read decoded, so it asks rather than being refused as a credential.
    let lookalike = format!(
        "{}+AIza{}{}",
        b64(&[7u8; 600]),
        "Q".repeat(35),
        b64(&[9u8; 600])
    );
    assert_ne!(crate::hub::redact::redact(&lookalike), lookalike);
    assert!(!sends_credential(
        IntegrationKind::Google,
        &json!({ "attachments": [{ "content_base64": lookalike, "filename": "photo.jpg" }] })
    ));
    // Wrapped at 76 characters, as mail tools write it: still a file, said by its size.
    let wrapped = b64(&[2u8; 1200])
        .as_bytes()
        .chunks(76)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("\r\n");
    let p = shown_input(
        IntegrationKind::Google,
        &json!({ "attachments": [{ "content_base64": wrapped, "filename": "scan.pdf" }] }),
    )
    .to_string();
    assert!(p.contains("[the file's 1200 bytes]"), "{p}");
    // A text file that holds a key: found in its decoded contents, and refused.
    let key_file = b64(format!(
        "notes\n{}\ntoken = ghp_abcdefghijklmnopqrstuvwxyz0123\n",
        "x".repeat(400)
    )
    .as_bytes());
    assert!(sends_credential(
        IntegrationKind::Google,
        &json!({ "attachments": [{ "content_base64": key_file, "filename": "notes.txt" }] })
    ));
}

/// `len` bytes that look random: no file of real mail could be refused for what they spell.
fn noise(len: usize, mut seed: u64) -> Vec<u8> {
    (0..len)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed as u8
        })
        .collect()
}

#[test]
fn a_binary_file_is_never_refused_but_a_text_file_or_plain_text_holding_a_key_is() {
    use base64::Engine;
    use base64::engine::general_purpose::{STANDARD, URL_SAFE};
    // Whether a file attached as `content` would be refused as a credential.
    let send = |content: String| {
        sends_credential(
            IntegrationKind::Google,
            &json!({ "attachments": [{ "content_base64": content, "filename": "photo.jpg" }] }),
        )
    };
    // Random 1 MB files, in both alphabets, wrapped or not: never refused, whatever their letters spell.
    for seed in 1..=8u64 {
        let bytes = noise(1_000_000, seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        for content in [
            STANDARD.encode(&bytes),
            URL_SAFE.encode(&bytes),
            URL_SAFE
                .encode(&bytes)
                .as_bytes()
                .chunks(76)
                .map(|c| std::str::from_utf8(c).unwrap())
                .collect::<Vec<_>>()
                .join("\r\n"),
        ] {
            assert!(!send(content), "random file {seed} was refused");
        }
    }
    // A text file holding a key, in either alphabet: refused.
    let notes = format!(
        "notes\n{}\ntoken = ghp_abcdefghijklmnopqrstuvwxyz0123\n",
        "x".repeat(40)
    );
    for content in [STANDARD.encode(&notes), URL_SAFE.encode(&notes)] {
        assert!(send(content));
    }
    // A key in plain text, in the body: refused.
    assert_eq!(
        blocked(
            "mcp__google__send_message",
            json!({ "to": "a@example.com", "subject": "s", "body": "here: sk-ant-abcdefghijklmnop0123" })
        ),
        Never::Credential.why()
    );
}

#[test]
fn a_short_key_can_t_go_out_as_a_tiny_file_and_both_sizes_agree() {
    use super::policy::file_bytes;
    let attach = |content: &str| json!({ "attachments": [{ "content_base64": content, "filename": "a.bin" }] });
    // An AWS key id is valid base64 for 15 bytes of binary: a tiny file, so its own text is searched too, and refused.
    let key = "AKIAQQQQQQQQQQQQQQQQ";
    assert!(file_bytes(key).is_some());
    assert!(sends_credential(IntegrationKind::Google, &attach(key)));
    // The size and the JSON agree: decoded bytes when the value decodes, its own length when it doesn't.
    assert_eq!(attachment_size("QUJDREVG"), 6);
    let shown = |content: &str| shown_input(IntegrationKind::Google, &attach(content)).to_string();
    assert!(shown("QUJDREVG").contains("[the file's 6 bytes]"));
    assert_eq!(attachment_size("not base64!"), 11);
    assert!(shown("not base64!").contains("\"not base64!\""));
}
