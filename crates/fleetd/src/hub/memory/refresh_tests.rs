//! The nightly memory refresh: who gets one, what its session may call, and the one line it leaves.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::NaiveTime;
use chrono_tz::Tz;
use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::chat::{ChatAuthor, ChatMessage};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, ThreadRef};
use fleetd_contracts::lead_calls::LeadCall;
use fleetd_contracts::ledger::{DecisionKey, DecisionScope, DecisionSource};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::model::RuntimeMode;
use serde_json::{Value, json};

use super::Target;
use super::refresh::{self, Launcher, night_due};
use crate::hub::api::{Caller, Hub, HubConfig, Listen};
use crate::hub::chat::NewMessage;
use crate::hub::executor::{LaunchInput, LaunchOptions};
use crate::hub::leads::hooks::BoxFuture;
use crate::hub::leads::records::WorkstreamFilter;
use crate::hub::ledger::{Actor, RecordInput};
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, NewEvent, iso_ms, now_ms};

/// 2026-10-27 04:10 UTC: ten minutes into the night's window.
const NIGHT_MS: u64 = 1_793_074_200_000;
const AT: &str = "2026-10-26T10:00:00.000Z";
const DAY: Duration = Duration::from_secs(24 * 3600);

#[derive(Default)]
struct Node {
    launches: Mutex<Vec<LaunchInput>>,
    options: Mutex<Vec<LaunchOptions>>,
    stops: Mutex<Vec<ThreadId>>,
}

impl Launcher for Node {
    fn launch(
        &self,
        _: &MachineId,
        input: LaunchInput,
        options: LaunchOptions,
    ) -> BoxFuture<Result<ThreadId, String>> {
        let mut launches = self.launches.lock().unwrap();
        launches.push(input);
        self.options.lock().unwrap().push(options);
        let id = ThreadId::unchecked(format!("refresh-{}", launches.len()));
        Box::pin(async move { Ok(id) })
    }

    fn stop(&self, thread: &ThreadRef) -> BoxFuture<Result<(), String>> {
        self.stops.lock().unwrap().push(thread.thread_id.clone());
        Box::pin(async { Ok(()) })
    }
}

fn project(id: &str) -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked(id),
    }
}

/// A hub with one project, whose person's zone is UTC.
fn hub() -> (Arc<Hub>, Arc<ManualClock>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    };
    let clock = ManualClock::at(NIGHT_MS);
    let hub =
        crate::hub::serve::build_on(HubDb::open_memory().unwrap(), config, clock.clone()).unwrap();
    hub.store
        .projects_upsert_many(
            &MachineId::unchecked("devbox"),
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "shop", "title": "shop", "workspaceRoot": "/work/shop",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    global(&hub, "policy.tz", "UTC");
    hub.link.set_capabilities(
        &MachineId::unchecked("devbox"),
        &[fleetd_contracts::node_link::CAP_ALLOWED_ONLY],
    );
    (hub, clock, home)
}

fn global(hub: &Hub, key: &str, value: &str) {
    hub.decisions
        .record(
            RecordInput::new(DecisionKey::unchecked(key), DecisionScope::Global, value),
            &Actor {
                source: DecisionSource::Human,
                by: "human:desk".into(),
                person: None,
            },
        )
        .unwrap();
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

fn say(hub: &Hub, r: &ProjectRef, author: ChatAuthor, text: &str) {
    hub.chat
        .add(
            r,
            NewMessage {
                author: Some(author),
                text: text.into(),
                ..Default::default()
            },
        )
        .unwrap();
}

fn memory_md(hub: &Hub, r: &ProjectRef) -> String {
    hub.db.memory().read(&Target {
        project: Some(r),
        topic: None,
    })
}

fn put_memory(hub: &Hub, r: &ProjectRef, text: &str) {
    hub.db
        .memory()
        .set(
            &Target {
                project: Some(r),
                topic: None,
            },
            text,
        )
        .unwrap();
}

/// A call from the refresh's session, through the policy as the link applies it.
async fn refresh_call(hub: &Hub, r: &ProjectRef, op: &str, call: Value) -> Result<(), String> {
    let mut call = call;
    call["op"] = op.into();
    let call: LeadCall = serde_json::from_value(call).map_err(|e| e.to_string())?;
    let agent = CallerAgent::MemoryRefresh;
    crate::hub::tasks::policy::check_call(&agent, &call).map_err(|e| e.message)?;
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: crate::hub::link::lead_calls::lead_by(r),
        agent,
    };
    let handler = hub
        .lead_calls
        .handler(op)
        .ok_or_else(|| format!("no handler for {op}"))?;
    handler
        .handle(caller, call)
        .await
        .map(|_| ())
        .map_err(|e| e.message)
}

fn complete(hub: &Hub, thread: &str) {
    hub.events
        .append(NewEvent {
            at: iso_ms(now_ms(hub.clock.as_ref())).into(),
            r#type: HubEventType::ThreadCompleted,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: Some(ProjectId::unchecked("shop")),
            thread_id: Some(ThreadId::unchecked(thread)),
            summary: "completed".into(),
            data: None,
            attention: None,
        })
        .unwrap();
}

fn lines(hub: &Hub, r: &ProjectRef) -> Vec<ChatMessage> {
    hub.chat.page(r, None, None, 100).unwrap().0
}

fn refreshed_lines(hub: &Hub, r: &ProjectRef) -> Vec<ChatMessage> {
    lines(hub, r)
        .into_iter()
        .filter(|m| m.memory_refreshed.is_some())
        .collect()
}

#[test]
fn the_night_is_due_from_its_hour_for_three_hours_in_the_persons_zone() {
    let four = NaiveTime::from_hms_opt(4, 0, 0).unwrap();
    let ms = |s: &str| {
        chrono::DateTime::parse_from_rfc3339(s)
            .unwrap()
            .timestamp_millis()
    };
    assert_eq!(night_due(ms("2026-10-27T03:59:00Z"), Tz::UTC, four), None);
    let night = ms("2026-10-27T04:00:00Z");
    assert_eq!(night_due(night, Tz::UTC, four), Some(night));
    assert_eq!(
        night_due(ms("2026-10-27T06:59:00Z"), Tz::UTC, four),
        Some(night)
    );
    assert_eq!(night_due(ms("2026-10-27T07:00:00Z"), Tz::UTC, four), None);
    // 04:00 in Berlin (CET, after the clocks went back) is 03:00 UTC.
    assert_eq!(
        night_due(ms("2026-10-27T03:30:00Z"), Tz::Europe__Berlin, four),
        Some(ms("2026-10-27T03:00:00Z"))
    );
    // Just after midnight, the night due is still none: yesterday's window closed at 07:00.
    assert_eq!(night_due(ms("2026-10-27T00:30:00Z"), Tz::UTC, four), None);
    // Berlin's clocks skip 02:00-03:00 on 2026-03-29: a 02:30 night runs at 03:00 CEST (01:00 UTC), not never.
    let gap = NaiveTime::from_hms_opt(2, 30, 0).unwrap();
    assert_eq!(
        night_due(ms("2026-03-29T00:59:00Z"), Tz::Europe__Berlin, gap),
        None
    );
    let after = ms("2026-03-29T01:00:00Z");
    assert_eq!(night_due(after, Tz::Europe__Berlin, gap), Some(after));
    assert_eq!(
        night_due(ms("2026-03-29T03:59:00Z"), Tz::Europe__Berlin, gap),
        Some(after)
    );
}

#[tokio::test]
async fn a_node_that_cant_hold_the_session_to_its_memory_tools_gets_no_refresh_until_it_can() {
    let (hub, _clock, _home) = hub();
    let r = project("shop");
    say(&hub, &r, ChatAuthor::Human, "Keep answers short.");
    // A node from before `allowed_only` would let claude read the project's files unasked.
    hub.link.set_capabilities(&r.machine_id, &[]);
    let node = Node::default();
    refresh::tick(&hub, &node).await.unwrap();
    assert!(node.launches.lock().unwrap().is_empty());
    // Updated within the night's window: it starts then.
    hub.link.set_capabilities(
        &r.machine_id,
        &[fleetd_contracts::node_link::CAP_ALLOWED_ONLY],
    );
    refresh::tick(&hub, &node).await.unwrap();
    assert_eq!(node.launches.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_quiet_project_gets_no_refresh_and_no_line() {
    let (hub, _clock, _home) = hub();
    let r = project("shop");
    // A line of fleetd's own is not activity.
    hub.chat.system_line(&r, "PR #4 merged").unwrap();
    let node = Node::default();
    refresh::tick(&hub, &node).await.unwrap();
    assert!(node.launches.lock().unwrap().is_empty());
    assert!(refreshed_lines(&hub, &r).is_empty());
}

#[tokio::test]
async fn the_project_setting_turns_the_refresh_off() {
    let (hub, _clock, _home) = hub();
    let r = project("shop");
    let tools = crate::hub::api::registry();
    let get = json!({ "machineId": "devbox", "projectId": "shop" });
    let on = tools
        .call(&hub, &person(), "project_settings_get", get.clone())
        .await
        .unwrap();
    assert_eq!(on["settings"]["memoryRefresh"], true, "on by default");
    let off = tools
        .call(
            &hub,
            &person(),
            "project_settings_set",
            json!({ "machineId": "devbox", "projectId": "shop", "memoryRefresh": false }),
        )
        .await
        .unwrap();
    assert_eq!(off["settings"]["memoryRefresh"], false);
    say(
        &hub,
        &r,
        ChatAuthor::Human,
        "From now on, no npm here: pnpm only.",
    );
    let node = Node::default();
    refresh::tick(&hub, &node).await.unwrap();
    assert!(
        node.launches.lock().unwrap().is_empty(),
        "off: nothing starts"
    );

    tools
        .call(
            &hub,
            &person(),
            "project_settings_set",
            json!({ "machineId": "devbox", "projectId": "shop", "memoryRefresh": true }),
        )
        .await
        .unwrap();
    refresh::tick(&hub, &node).await.unwrap();
    assert_eq!(
        node.launches.lock().unwrap().len(),
        1,
        "back on: it runs that night"
    );
}

#[tokio::test]
async fn an_active_project_gets_one_session_that_reads_its_chat_memory_and_decisions_and_opens_no_order()
 {
    let (hub, clock, _home) = hub();
    let r = project("shop");
    put_memory(&hub, &r, "- Deploys freeze on Fridays.\n");
    say(
        &hub,
        &r,
        ChatAuthor::Human,
        "The Friday freeze is over since the launch.",
    );
    say(&hub, &r, ChatAuthor::Lead, "Noted: deploys any day now.");
    let node = Node::default();
    refresh::tick(&hub, &node).await.unwrap();
    assert_eq!(node.launches.lock().unwrap().len(), 1);
    let input = node.launches.lock().unwrap()[0].clone();
    assert_eq!(input.title.as_deref(), Some("fleetd memory refresh: shop"));
    for needle in [
        "tonight's memory refresh",
        "Only `memory_read`, `remember` and `forget`",
        "- Deploys freeze on Fridays.",
        "Human: The Friday freeze is over since the launch.",
        "Lead: Noted: deploys any day now.",
    ] {
        assert!(
            input.prompt.contains(needle),
            "{needle} not in:\n{}",
            input.prompt
        );
    }
    // It opened no order, and the chat is as it was.
    let orders = hub
        .leads
        .records
        .workstreams_list(&WorkstreamFilter {
            project_ref: Some(r.clone()),
            state: None,
            limit: 100,
        })
        .unwrap();
    assert!(orders.is_empty());
    assert_eq!(lines(&hub, &r).len(), 2);
    // The next pass the same night starts nothing more.
    clock.advance(Duration::from_secs(60));
    refresh::tick(&hub, &node).await.unwrap();
    assert_eq!(node.launches.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn the_refresh_session_may_only_read_and_write_memory_and_only_add_to_user_md() {
    let (hub, _clock, _home) = hub();
    let r = project("shop");
    say(&hub, &r, ChatAuthor::Human, "Keep answers short.");
    let node = Node::default();
    refresh::tick(&hub, &node).await.unwrap();
    let thread = ThreadRef {
        machine_id: r.machine_id.clone(),
        thread_id: ThreadId::unchecked("refresh-1"),
    };
    let agent = hub.lead_calls.agent_of(Some(&thread), &r).unwrap();
    assert_eq!(agent, CallerAgent::MemoryRefresh);
    for op in [
        "task_spawn",
        "brief_create",
        "close",
        "decide",
        "checklist",
        "gated_run",
        "ask",
    ] {
        let refused = crate::hub::tasks::policy::check(&agent, op).unwrap_err();
        assert_eq!(refused.code, ErrorCode::Forbidden, "{op}");
    }
    for op in ["memory_read", "remember", "forget"] {
        assert!(crate::hub::tasks::policy::check(&agent, op).is_ok(), "{op}");
    }
    // user.md: add only.
    refresh_call(
        &hub,
        &r,
        "remember",
        json!({ "scope": "user", "text": "Keep answers short." }),
    )
    .await
    .unwrap();
    let replace = refresh_call(
        &hub,
        &r,
        "remember",
        json!({ "scope": "user", "text": "Short answers.", "replaces": "Keep answers short" }),
    )
    .await
    .unwrap_err();
    assert!(replace.contains("only adds to user.md"), "{replace}");
    let forget = refresh_call(
        &hub,
        &r,
        "forget",
        json!({ "scope": "user", "entry": "Keep answers" }),
    )
    .await
    .unwrap_err();
    assert!(forget.contains("only adds to user.md"), "{forget}");
    // The lead itself still may.
    assert!(
        crate::hub::tasks::policy::check_call(
            &CallerAgent::Lead,
            &serde_json::from_value(
                json!({ "op": "forget", "scope": "user", "entry": "Keep answers" })
            )
            .unwrap()
        )
        .is_ok()
    );
    // Once it ended, its session is no one's: no more calls.
    complete(&hub, "refresh-1");
    refresh::tick(&hub, &node).await.unwrap();
    assert!(hub.lead_calls.agent_of(Some(&thread), &r).is_err());
}

#[tokio::test]
async fn the_refresh_is_held_to_the_caps() {
    let (hub, _clock, _home) = hub();
    let r = project("shop");
    hub.db
        .set_memory_caps(&fleetd_contracts::memory::MemoryCaps {
            index: fleetd_contracts::memory::FileCap::unchecked(1_000),
            ..Default::default()
        })
        .unwrap();
    put_memory(&hub, &r, &format!("- {}\n", "a".repeat(990)));
    say(&hub, &r, ChatAuthor::Human, "Remember the staging URL.");
    let node = Node::default();
    refresh::tick(&hub, &node).await.unwrap();
    let refused = refresh_call(
        &hub,
        &r,
        "remember",
        json!({ "scope": "project", "text": "Staging is at staging.shop.test." }),
    )
    .await
    .unwrap_err();
    assert!(refused.contains("past its cap of 1000"), "{refused}");
    // Merging stays under it.
    refresh_call(
        &hub,
        &r,
        "remember",
        json!({ "scope": "project", "text": "Staging is at staging.shop.test.", "replaces": "aaaa" }),
    )
    .await
    .unwrap();
    assert_eq!(memory_md(&hub, &r), "- Staging is at staging.shop.test.\n");
}

#[tokio::test]
async fn a_refresh_posts_one_line_with_undo_per_change_and_undo_all_and_nothing_on_a_quiet_night() {
    let (hub, clock, _home) = hub();
    let r = project("shop");
    let tools = crate::hub::api::registry();
    put_memory(
        &hub,
        &r,
        "- Deploys freeze on Fridays.\n- Use npm.\n- Run the e2e suite before a release.\n",
    );
    say(
        &hub,
        &r,
        ChatAuthor::Human,
        "No npm here, pnpm only. The Friday freeze is over.",
    );
    let node = Node::default();
    refresh::tick(&hub, &node).await.unwrap();
    refresh_call(
        &hub,
        &r,
        "remember",
        json!({ "scope": "project", "text": "Staging deploys need the VPN." }),
    )
    .await
    .unwrap();
    refresh_call(
        &hub,
        &r,
        "remember",
        json!({ "scope": "project", "text": "No npm: use pnpm.", "replaces": "Use npm" }),
    )
    .await
    .unwrap();
    refresh_call(
        &hub,
        &r,
        "forget",
        json!({ "scope": "project", "entry": "Friday", "reason": "The freeze ended." }),
    )
    .await
    .unwrap();
    assert_eq!(
        memory_md(&hub, &r),
        "- No npm: use pnpm.\n- Run the e2e suite before a release.\n- Staging deploys need the VPN.\n"
    );
    // Nothing in the chat until it ends.
    assert_eq!(lines(&hub, &r).len(), 1);

    complete(&hub, "refresh-1");
    refresh::tick(&hub, &node).await.unwrap();
    let posted = refreshed_lines(&hub, &r);
    assert_eq!(posted.len(), 1, "one line");
    assert_eq!(posted[0].text.as_str(), "Memory refreshed: +1 ~1 −1");
    assert_eq!(posted[0].author, ChatAuthor::System);
    let items = &posted[0].memory_refreshed.as_ref().unwrap().items;
    assert_eq!(items[1].replaced.as_ref().unwrap().as_str(), "Use npm.");
    assert_eq!(items[2].forgotten, Some(true));
    assert_eq!(
        items[2].reason.as_ref().unwrap().as_str(),
        "The freeze ended."
    );

    // Undo one change: npm comes back.
    let undo = |item: Option<i64>| {
        let mut input = json!({ "projectRef": r, "messageId": posted[0].message_id });
        if let Some(i) = item {
            input["item"] = i.into();
        }
        input
    };
    tools
        .call(&hub, &person(), "memory_undo", undo(Some(1)))
        .await
        .unwrap();
    assert_eq!(
        memory_md(&hub, &r),
        "- Use npm.\n- Run the e2e suite before a release.\n- Staging deploys need the VPN.\n"
    );
    let line = &refreshed_lines(&hub, &r)[0];
    let undone: Vec<_> = line
        .memory_refreshed
        .as_ref()
        .unwrap()
        .items
        .iter()
        .map(|i| i.undone)
        .collect();
    assert_eq!(undone, [None, Some(true), None]);
    // Undo all: the rest, and the memory is as the night found it but for the order of the entry put back.
    tools
        .call(&hub, &person(), "memory_undo", undo(None))
        .await
        .unwrap();
    assert_eq!(
        memory_md(&hub, &r),
        "- Use npm.\n- Run the e2e suite before a release.\n- Deploys freeze on Fridays.\n"
    );
    let line = &refreshed_lines(&hub, &r)[0];
    assert!(
        line.memory_refreshed
            .as_ref()
            .unwrap()
            .items
            .iter()
            .all(|i| i.undone == Some(true))
    );
    let again = tools
        .call(&hub, &person(), "memory_undo", undo(None))
        .await
        .unwrap();
    assert_eq!(again["next"], "Already undone.");

    // The next night: nothing said since, so no session and no line.
    clock.advance(DAY);
    refresh::tick(&hub, &node).await.unwrap();
    assert_eq!(node.launches.lock().unwrap().len(), 1);
    // A night whose refresh changes nothing posts nothing.
    say(&hub, &r, ChatAuthor::Human, "Thanks.");
    clock.advance(DAY);
    refresh::tick(&hub, &node).await.unwrap();
    assert_eq!(node.launches.lock().unwrap().len(), 2);
    // It reads only what was said since the last refresh.
    let prompt = node.launches.lock().unwrap()[1].prompt.clone();
    assert!(
        prompt.contains("Human: Thanks.") && !prompt.contains("pnpm only"),
        "{prompt}"
    );
    complete(&hub, "refresh-2");
    refresh::tick(&hub, &node).await.unwrap();
    assert_eq!(refreshed_lines(&hub, &r).len(), 1);
}

#[tokio::test]
async fn the_session_may_use_only_the_memory_tools_and_only_fleetds_mcp_server() {
    let (hub, _clock, _home) = hub();
    let r = project("shop");
    say(&hub, &r, ChatAuthor::Human, "Keep answers short.");
    let node = Node::default();
    refresh::tick(&hub, &node).await.unwrap();
    let options = node.options.lock().unwrap()[0].clone();
    // An allowlist, in place of the project's own allow rules: the node refuses any other tool (node/sessions'
    // `auto_answer`), and claude loads no runtime tool of its own (`--tools ""`, node/runner/claude).
    let only = options.only_tools.expect("held to its allowed tools");
    assert_eq!(
        only,
        [
            "mcp__fleetd__memory_read",
            "mcp__fleetd__remember",
            "mcp__fleetd__forget"
        ]
    );
    assert!(crate::node::runner::claude::runtime_tools(&only).is_empty());
    // Each names a tool fleetd's server lists for a lead, and one the hub takes from the refresh.
    let listed: Vec<&str> = crate::cli::agent_mcp::tools_for(crate::cli::agent_mcp::Role::Lead)
        .map(|t| t.name)
        .collect();
    for tool in &only {
        let name = tool.strip_prefix("mcp__fleetd__").unwrap();
        assert!(listed.contains(&name), "{name}");
        crate::hub::tasks::policy::check(&CallerAgent::MemoryRefresh, name).unwrap();
    }
    // Under approval, so a node that doesn't know the allowlist asks rather than runs anything.
    let input = node.launches.lock().unwrap()[0].clone();
    assert_eq!(input.runtime_mode, RuntimeMode::ApprovalRequired);
    assert_eq!(
        options.role,
        fleetd_contracts::sessions::SessionRole::Lead,
        "fleetd's lead tools, held to memory by the hub"
    );
    let mcp = options.mcp.expect("its own MCP servers");
    assert!(!mcp.user_servers && mcp.servers.is_empty(), "{mcp:?}");
    // The prompt says so.
    assert!(
        input.prompt.contains("no shell, file or web tools"),
        "{}",
        input.prompt
    );
}

#[tokio::test]
async fn a_session_past_the_hour_or_that_failed_is_stopped_and_its_changes_still_posted() {
    let (hub, clock, _home) = hub();
    let r = project("shop");
    say(&hub, &r, ChatAuthor::Human, "Staging needs the VPN.");
    let node = Node::default();
    refresh::tick(&hub, &node).await.unwrap();
    refresh_call(
        &hub,
        &r,
        "remember",
        json!({ "scope": "project", "text": "Staging needs the VPN." }),
    )
    .await
    .unwrap();
    // Within the hour it runs on.
    clock.advance(Duration::from_millis(refresh::RUN_LIMIT_MS as u64));
    refresh::tick(&hub, &node).await.unwrap();
    assert!(node.stops.lock().unwrap().is_empty());
    clock.advance(Duration::from_secs(60));
    refresh::tick(&hub, &node).await.unwrap();
    assert_eq!(
        *node.stops.lock().unwrap(),
        [ThreadId::unchecked("refresh-1")]
    );
    let posted = refreshed_lines(&hub, &r);
    assert_eq!(posted.len(), 1);
    assert_eq!(posted[0].text.as_str(), "Memory refreshed: +1");
    let thread = ThreadRef {
        machine_id: r.machine_id.clone(),
        thread_id: ThreadId::unchecked("refresh-1"),
    };
    assert!(
        hub.lead_calls.agent_of(Some(&thread), &r).is_err(),
        "its calls are refused from then on"
    );

    // It didn't complete, so the next night reads the same chat again; one that fails is stopped too.
    clock.advance(DAY);
    refresh::tick(&hub, &node).await.unwrap();
    let prompt = node.launches.lock().unwrap()[1].prompt.clone();
    assert!(prompt.contains("Human: Staging needs the VPN."), "{prompt}");
    hub.events
        .append(NewEvent {
            at: iso_ms(now_ms(hub.clock.as_ref())).into(),
            r#type: HubEventType::ThreadFailed,
            machine_id: Some(MachineId::unchecked("devbox")),
            project_id: Some(ProjectId::unchecked("shop")),
            thread_id: Some(ThreadId::unchecked("refresh-2")),
            summary: "failed".into(),
            data: None,
            attention: None,
        })
        .unwrap();
    refresh::tick(&hub, &node).await.unwrap();
    assert_eq!(node.stops.lock().unwrap().len(), 2);
    // A completed one is over by itself: nothing to stop.
    say(&hub, &r, ChatAuthor::Human, "Thanks.");
    clock.advance(DAY);
    refresh::tick(&hub, &node).await.unwrap();
    complete(&hub, "refresh-3");
    refresh::tick(&hub, &node).await.unwrap();
    assert_eq!(node.stops.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_refresh_of_more_changes_than_a_line_lists_still_posts_and_undo_all_takes_them_all_back()
{
    let (hub, _clock, _home) = hub();
    let r = project("shop");
    let tools = crate::hub::api::registry();
    say(&hub, &r, ChatAuthor::Human, "Lots to remember.");
    let node = Node::default();
    refresh::tick(&hub, &node).await.unwrap();
    let n = fleetd_contracts::memory::REFRESHED_LISTED + 5;
    for i in 0..n {
        refresh_call(
            &hub,
            &r,
            "remember",
            json!({ "scope": "project", "text": format!("Rule {i}.") }),
        )
        .await
        .unwrap();
    }
    complete(&hub, "refresh-1");
    refresh::tick(&hub, &node).await.unwrap();
    let posted = refreshed_lines(&hub, &r);
    assert_eq!(posted.len(), 1);
    assert_eq!(posted[0].text.as_str(), format!("Memory refreshed: +{n}"));
    let refreshed = posted[0].memory_refreshed.as_ref().unwrap();
    assert_eq!(
        refreshed.items.len(),
        fleetd_contracts::memory::REFRESHED_LISTED
    );
    assert_eq!(refreshed.total.map(|t| t.get()), Some(n as i64));
    // Settings > Memory links a listed entry to the line.
    let got = tools
        .call(&hub, &person(), "memory_get", json!({ "projectRef": r }))
        .await
        .unwrap();
    let notes = got["files"][0]["notes"].as_array().unwrap();
    assert!(
        notes
            .iter()
            .any(|n| n["text"] == "Rule 0." && n["messageId"] == posted[0].message_id.as_str()),
        "{notes:?}"
    );

    let undo = |item: Option<i64>| {
        let mut input = json!({ "projectRef": r, "messageId": posted[0].message_id });
        if let Some(i) = item {
            input["item"] = i.into();
        }
        input
    };
    tools
        .call(&hub, &person(), "memory_undo", undo(Some(0)))
        .await
        .unwrap();
    assert!(!memory_md(&hub, &r).contains("- Rule 0.\n"));
    // The line counts it undone, so the app keeps Undo all for the rest, which it doesn't list.
    let line = &refreshed_lines(&hub, &r)[0];
    assert_eq!(
        line.memory_refreshed
            .as_ref()
            .unwrap()
            .undone
            .map(|u| u.get()),
        Some(1)
    );
    tools
        .call(&hub, &person(), "memory_undo", undo(None))
        .await
        .unwrap();
    assert_eq!(memory_md(&hub, &r), "", "the unlisted ones too");
    let line = &refreshed_lines(&hub, &r)[0];
    let refreshed = line.memory_refreshed.as_ref().unwrap();
    assert!(refreshed.items.iter().all(|i| i.undone == Some(true)));
    assert_eq!(refreshed.total.map(|t| t.get()), Some(n as i64));
    assert_eq!(refreshed.undone.map(|u| u.get()), Some(n as i64));
}
