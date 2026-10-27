use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::model::MachineStatus;
use fleetd_contracts::node_link::{CAP_PREVIEWS, HubToNode, NodeToHub};
use fleetd_contracts::preview::{
    PreviewEndReason, PreviewReport, PreviewRunFrame, PreviewRunResult, PreviewState,
};
use fleetd_contracts::tasks::TaskId;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen};
use crate::hub::chat::NewMessage;
use crate::hub::link::LeadCaller;
use crate::hub::link::NodeCommands;
use crate::hub::link::commands::AttachedLink;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{HubDb, WaitInput, iso_ms};

const AT: &str = "2026-10-26T10:00:00.000Z";
const NOW_MS: u64 = 1_792_000_000_000;
const SHA: &str = "3f2a91c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6";

fn mid(m: &str) -> MachineId {
    MachineId::unchecked(m)
}

/// Project shop on devbox, whose node runs previews.
fn shop() -> ProjectRef {
    ProjectRef {
        machine_id: mid("devbox"),
        project_id: ProjectId::unchecked("shop"),
    }
}

/// Project app on mac1, whose node is too old for previews.
fn app() -> ProjectRef {
    ProjectRef {
        machine_id: mid("mac1"),
        project_id: ProjectId::unchecked("app"),
    }
}

fn config(home: &std::path::Path) -> HubConfig {
    HubConfig {
        home: home.to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
    }
}

/// A hub over `db` with devbox and mac1 online, shop on devbox and app on mac1, each with a web preview setting, and
/// shop's PR #14 (writer T14, order W12) in its merge queue.
fn hub_on(db: Arc<HubDb>, home: &std::path::Path, clock: Arc<ManualClock>) -> Arc<Hub> {
    let hub = crate::hub::serve::build_on(db, config(home), clock).unwrap();
    for (m, caps) in [("devbox", vec![CAP_PREVIEWS]), ("mac1", vec![])] {
        let machine = serde_json::from_value(json!({
            "machineId": m, "name": m, "tags": [], "status": "online", "lastSeenAt": AT, "nodeVersion": "0.1.0",
        }))
        .unwrap();
        hub.store.machine_upsert(&machine, None).unwrap();
        hub.link.set_capabilities(&mid(m), &caps);
    }
    for r in [shop(), app()] {
        hub.store
            .projects_upsert_many(
                &r.machine_id,
                &[serde_json::from_value(json!({
                    "machineId": r.machine_id, "projectId": r.project_id, "title": r.project_id,
                    "workspaceRoot": format!("/work/{}", r.project_id),
                    "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
                }))
                .unwrap()],
            )
            .unwrap();
    }
    hub
}

fn hub() -> (Arc<Hub>, Arc<ManualClock>, tempfile::TempDir) {
    let home = tempfile::tempdir().unwrap();
    let clock = ManualClock::at(NOW_MS);
    let hub = hub_on(HubDb::open_memory().unwrap(), home.path(), clock.clone());
    for r in [shop(), app()] {
        super::save_config(&hub, &r, &web()).unwrap();
    }
    pr(&hub, 14, "reviewing", "T14", "W12");
    (hub, clock, home)
}

fn web() -> fleetd_contracts::preview::PreviewConfig {
    serde_json::from_value(json!({
        "web": { "setup": ["pnpm install --frozen-lockfile"], "start": "pnpm preview --port $PORT --host 127.0.0.1" },
    }))
    .unwrap()
}

/// Puts shop's PR `number` on the merge queue's records in `state`.
fn pr(hub: &Hub, number: i64, state: &str, task: &str, order: &str) {
    let change = serde_json::from_value(json!({
        "changeId": "X1", "projectRef": shop(), "repo": "acme/shop", "prNumber": number,
        "prUrl": format!("https://github.com/acme/shop/pull/{number}"), "branch": format!("fleetd/{task}-checkout"),
        "taskId": task, "workstreamId": order, "headSha": SHA, "state": state, "reviews": [],
        "createdAt": AT, "updatedAt": AT,
    }))
    .unwrap();
    match hub.train.records().latest_for("acme/shop", number) {
        Some(mut c) => {
            c.state = serde_json::from_value(json!(state)).unwrap();
            hub.train.records().put(&c);
        }
        None => {
            hub.train.records().create(change);
        }
    }
}

fn key(kind: &str, role: &str) -> Caller {
    serde_json::from_value(json!({
        "keyId": format!("k-{kind}-{role}"), "name": "desk", "kind": kind, "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": role, "machines": "*" }],
    }))
    .unwrap()
}

fn person() -> Caller {
    key("human", "operate")
}

async fn tool(hub: &Arc<Hub>, who: &Caller, name: &str, input: Value) -> Result<Value, CallError> {
    crate::hub::api::registry()
        .call(hub, who, name, input)
        .await
}

fn refused(result: Result<Value, CallError>) -> (String, String) {
    match result {
        Err(CallError::Tool(e)) => (format!("{:?}", e.code), e.message),
        other => panic!("not refused: {other:?}"),
    }
}

fn of_pr(number: i64) -> Value {
    json!({ "kind": "pr", "repo": "acme/shop", "number": number })
}

/// A node for `m` on the hub's link: it takes every preview it is asked to run (or refuses with `refuse`), and
/// keeps every frame it gets.
struct Node {
    frames: Arc<Mutex<Vec<HubToNode>>>,
    _link: AttachedLink,
}

fn node(hub: &Arc<Hub>, m: &str, refuse: Option<&'static str>) -> Node {
    let (tx, mut rx) = mpsc::unbounded_channel::<HubToNode>();
    let link = hub.node_commands.attach(&mid(m), tx);
    let frames = Arc::new(Mutex::new(Vec::new()));
    let (seen, commands, machine) = (frames.clone(), hub.node_commands.clone(), mid(m));
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if let HubToNode::PreviewRun(run) = &frame {
                answer(&commands, &machine, run, refuse);
            }
            seen.lock().unwrap().push(frame);
        }
    });
    Node {
        frames,
        _link: link,
    }
}

fn answer(commands: &NodeCommands, m: &MachineId, run: &PreviewRunFrame, refuse: Option<&str>) {
    let error = refuse.map(|why| {
        fleetd_contracts::mcp::McpToolError::new(fleetd_contracts::mcp::ErrorCode::Failed, why)
    });
    commands.resolve(
        m,
        NodeToHub::PreviewRunResult(PreviewRunResult {
            id: run.id.clone(),
            error,
        }),
    );
}

impl Node {
    fn runs(&self) -> Vec<PreviewRunFrame> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter_map(|f| match f {
                HubToNode::PreviewRun(run) => Some(run.clone()),
                _ => None,
            })
            .collect()
    }

    fn stops(&self) -> Vec<(String, PreviewEndReason)> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .filter_map(|f| match f {
                HubToNode::PreviewStop(stop) => Some((stop.preview_id.to_string(), stop.reason)),
                _ => None,
            })
            .collect()
    }
}

async fn start(hub: &Arc<Hub>, who: &Caller, number: i64) -> Result<Value, CallError> {
    tool(
        hub,
        who,
        "preview_start",
        json!({ "projectRef": shop(), "of": of_pr(number) }),
    )
    .await
}

fn report(id: &str, state: &str, extra: Value) -> PreviewReport {
    let mut v = json!({ "previewId": id, "state": state });
    v.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(v).unwrap()
}

fn events(hub: &Hub) -> Vec<Value> {
    let page = futures_util::FutureExt::now_or_never(hub.events.wait(WaitInput {
        cursor: Some(0),
        types: Some(vec![HubEventType::PreviewState]),
        machine_id: None,
        timeout_sec: 0,
    }))
    .unwrap()
    .unwrap();
    page.events
        .into_iter()
        .map(|e| e.data.unwrap_or_default())
        .collect()
}

fn stored(hub: &Hub, id: &str) -> fleetd_contracts::preview::Preview {
    super::get(hub, &fleetd_contracts::preview::PreviewId::unchecked(id))
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn a_project_keeps_its_preview_setting_and_one_with_no_target_turns_it_off() {
    let (hub, _clock, _home) = hub();
    let admin = key("human", "admin");
    let r = json!({ "machineId": "devbox", "projectId": "shop" });
    let set = |preview: Value| {
        let mut input = r.clone();
        input["preview"] = preview;
        input
    };
    let out = tool(
        &hub,
        &admin,
        "project_settings_set",
        set(json!({ "web": { "build": "pnpm build", "start": "pnpm preview --port $PORT", "ready": "/healthz" }, "idleMinutes": 15 })),
    )
    .await
    .unwrap();
    assert_eq!(out["settings"]["preview"]["web"]["ready"], "/healthz");
    assert_eq!(out["settings"]["preview"]["idleMinutes"], 15);
    assert!(out["next"].as_str().unwrap().contains("nothing starts now"));
    let got = tool(&hub, &admin, "project_settings_get", r.clone())
        .await
        .unwrap();
    assert_eq!(got["settings"]["preview"]["web"]["build"], "pnpm build");
    let off = tool(&hub, &admin, "project_settings_set", set(json!({})))
        .await
        .unwrap();
    assert!(off["settings"].get("preview").is_none());
    let (_, why) = refused(start(&hub, &person(), 14).await);
    assert!(why.contains("doesn't say how to run"), "{why}");
}

#[tokio::test]
async fn only_a_persons_admin_or_operate_key_starts_ends_or_sends_feedback() {
    let (hub, _clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    for (who, can) in [
        (key("human", "admin"), true),
        (key("human", "operate"), true),
        (key("human", "read"), false),
        (key("agent", "operate"), false),
    ] {
        let list = tool(&hub, &who, "previews_list", json!({ "projectRef": shop() }))
            .await
            .unwrap();
        assert_eq!(list["canStart"], can, "{:?} {:?}", who.kind, who.grants);
    }
    let (code, _) = refused(start(&hub, &key("human", "read"), 14).await);
    assert_eq!(code, "Forbidden");
    let (code, why) = refused(start(&hub, &key("agent", "operate"), 14).await);
    assert_eq!(code, "Forbidden");
    assert!(why.contains("Only a person"), "{why}");
    assert!(devbox.runs().is_empty(), "nothing reached the node");

    let started = start(&hub, &key("human", "admin"), 14).await.unwrap();
    let id = started["preview"]["previewId"].as_str().unwrap().to_owned();
    assert_eq!(started["preview"]["askedBy"]["words"], "you");
    // A read key sees what runs, and ends nothing.
    let seen = tool(
        &hub,
        &key("human", "read"),
        "previews_list",
        json!({ "projectRef": shop() }),
    )
    .await
    .unwrap();
    assert_eq!(seen["previews"][0]["previewId"], id.as_str());
    let (code, _) = refused(
        tool(
            &hub,
            &key("human", "read"),
            "preview_end",
            json!({ "previewId": id }),
        )
        .await,
    );
    assert_eq!(code, "Forbidden");
    let pins = json!([{ "x": 7600, "y": 7600, "note": "wraps" }]);
    let (code, _) = refused(
        tool(
            &hub,
            &key("agent", "operate"),
            "preview_feedback",
            json!({ "previewId": id, "pins": pins }),
        )
        .await,
    );
    assert_eq!(code, "Forbidden");
    let ended = tool(&hub, &person(), "preview_end", json!({ "previewId": id }))
        .await
        .unwrap();
    assert_eq!(
        (
            ended["preview"]["state"].as_str(),
            ended["preview"]["endReason"].as_str()
        ),
        (Some("ended"), Some("ended"))
    );
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(devbox.stops(), [(id, PreviewEndReason::Ended)]);
}

#[tokio::test]
async fn a_preview_goes_only_to_a_node_that_runs_previews() {
    let (hub, _clock, _home) = hub();
    // Offline: no node linked for devbox.
    let (_, why) = refused(start(&hub, &person(), 14).await);
    assert!(why.contains("devbox is offline"), "{why}");

    let mac1 = node(&hub, "mac1", None);
    let (_, why) = refused(
        tool(
            &hub,
            &person(),
            "preview_start",
            json!({ "projectRef": app(), "of": { "kind": "order", "workstreamId": "W1" } }),
        )
        .await,
    );
    assert!(why.contains("no order W1"), "{why}");
    assert!(mac1.runs().is_empty());
    let (_, why) = refused(
        super::place(&hub, &app())
            .map(|_| Value::Null)
            .map_err(CallError::Tool),
    );
    assert!(
        why.contains("mac1's fleetd doesn't run previews yet"),
        "{why}"
    );

    let devbox = node(&hub, "devbox", None);
    hub.db
        .with(|c| {
            crate::hub::machine_roles::set_roles(
                c,
                &mid("devbox"),
                &crate::hub::machine_roles::Roles {
                    agents: true,
                    sessions: false,
                    max_sessions: None,
                },
            )
        })
        .unwrap();
    let (_, why) = refused(start(&hub, &person(), 14).await);
    assert!(why.contains("hosts no sessions"), "{why}");
    hub.db
        .with(|c| crate::hub::machine_roles::set_roles(c, &mid("devbox"), &Default::default()))
        .unwrap();

    let out = start(&hub, &person(), 14).await.unwrap();
    let preview = &out["preview"];
    assert_eq!(
        (
            preview["state"].as_str(),
            preview["machineId"].as_str(),
            preview["head"].as_str()
        ),
        (Some("starting"), Some("devbox"), Some(SHA))
    );
    let runs = devbox.runs();
    assert_eq!(runs.len(), 1);
    let run = serde_json::to_value(&runs[0]).unwrap();
    assert_eq!(run["previewId"], preview["previewId"]);
    assert_eq!(run["projectId"], "shop");
    assert_eq!(
        run["heads"],
        json!([{ "branch": "fleetd/T14-checkout", "sha": SHA }])
    );
    assert_eq!(
        run["web"]["start"],
        "pnpm preview --port $PORT --host 127.0.0.1"
    );
    assert_eq!(run["idleMinutes"], 30);
    assert!(run.get("base").is_none());
    assert!(mac1.runs().is_empty());
    assert_eq!(events(&hub).len(), 1);

    // The same PR again opens the one that runs.
    let again = start(&hub, &person(), 14).await.unwrap();
    assert_eq!(again["preview"]["previewId"], preview["previewId"]);
    assert_eq!(devbox.runs().len(), 1);

    // A merged PR has nothing left to try.
    pr(&hub, 15, "merged", "T15", "W13");
    let (_, why) = refused(start(&hub, &person(), 15).await);
    assert!(why.contains("#15 is merged"), "{why}");
}

#[tokio::test]
async fn a_node_that_refuses_the_run_leaves_it_failed() {
    let (hub, _clock, _home) = hub();
    let _devbox = node(&hub, "devbox", Some("no free port in 8400-8499"));
    let (code, why) = refused(start(&hub, &person(), 14).await);
    assert_eq!(code, "Failed");
    assert!(why.contains("no free port"), "{why}");
    let list = super::list(&hub, &shop()).unwrap();
    assert_eq!(list[0].state, PreviewState::Failed);
    assert!(list[0].note.as_ref().unwrap().contains("no free port"));
}

#[tokio::test]
async fn reports_move_a_preview_and_only_its_machine_reports_it() {
    let (hub, _clock, _home) = hub();
    let _devbox = node(&hub, "devbox", None);
    let out = start(&hub, &person(), 14).await.unwrap();
    let id = out["preview"]["previewId"].as_str().unwrap().to_owned();
    let step = json!([{ "words": "Build: pnpm build", "state": "running" }]);
    super::on_report(
        &hub,
        &mid("devbox"),
        report(&id, "starting", json!({ "steps": step })),
    );
    assert_eq!(stored(&hub, &id).steps.len(), 1);
    // Another machine's word on it changes nothing.
    super::on_report(&hub, &mid("mac1"), report(&id, "failed", json!({})));
    assert_eq!(stored(&hub, &id).state, PreviewState::Starting);

    super::on_report(
        &hub,
        &mid("devbox"),
        report(
            &id,
            "ready",
            json!({ "url": "http://devbox:8414", "sessionId": format!("B{}", "a".repeat(32)) }),
        ),
    );
    let ready = stored(&hub, &id);
    assert_eq!(ready.state, PreviewState::Ready);
    assert_eq!(ready.url.as_deref(), Some("http://devbox:8414"));
    assert_eq!(
        ready.ready_at.as_ref().map(|t| t.as_str()),
        Some(iso_ms(NOW_MS as i64).as_str())
    );
    assert_eq!(
        ready.idle_until.as_ref().map(|t| t.as_str()),
        Some(iso_ms(NOW_MS as i64 + 30 * 60_000).as_str()),
        "idle ends it 30 minutes on unless it is used"
    );
    // Used: only idleUntil moves, and the app hears nothing new.
    let n = events(&hub).len();
    let later = iso_ms(NOW_MS as i64 + 45 * 60_000);
    super::on_report(
        &hub,
        &mid("devbox"),
        report(&id, "ready", json!({ "idleUntil": later })),
    );
    assert_eq!(
        stored(&hub, &id).idle_until.as_ref().map(|t| t.as_str()),
        Some(later.as_str())
    );
    assert_eq!(events(&hub).len(), n);

    super::on_report(
        &hub,
        &mid("devbox"),
        report(&id, "ended", json!({ "endReason": "idle" })),
    );
    let ended = stored(&hub, &id);
    assert_eq!(
        (ended.state, ended.end_reason),
        (PreviewState::Ended, Some(PreviewEndReason::Idle))
    );
    // Ended stays ended.
    super::on_report(&hub, &mid("devbox"), report(&id, "ready", json!({})));
    assert_eq!(stored(&hub, &id).state, PreviewState::Ended);
    let states: Vec<String> = events(&hub)
        .iter()
        .map(|e| e["state"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(states, ["starting", "starting", "ready", "ended"]);
}

#[tokio::test]
async fn the_sweep_ends_previews_idle_at_the_cap_merged_or_lost() {
    let (hub, clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    let ready = |id: &str| {
        super::on_report(&hub, &mid("devbox"), report(id, "ready", json!({})));
    };
    let first = start(&hub, &person(), 14).await.unwrap()["preview"]["previewId"]
        .as_str()
        .unwrap()
        .to_owned();
    ready(&first);
    assert_eq!(super::sweep(&hub).unwrap(), 0);
    clock.advance(Duration::from_secs(31 * 60));
    assert_eq!(super::sweep(&hub).unwrap(), 1);
    assert_eq!(
        stored(&hub, &first).end_reason,
        Some(PreviewEndReason::Idle)
    );
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(devbox.stops(), [(first.clone(), PreviewEndReason::Idle)]);

    // Used all along, it still ends at 4 hours.
    let second = start(&hub, &person(), 14).await.unwrap()["preview"]["previewId"]
        .as_str()
        .unwrap()
        .to_owned();
    for _ in 0..8 {
        clock.advance(Duration::from_secs(30 * 60));
        let until = iso_ms(crate::hub::store::now_ms(clock.as_ref()) + 20 * 60_000);
        super::on_report(
            &hub,
            &mid("devbox"),
            report(&second, "ready", json!({ "idleUntil": until })),
        );
        super::sweep(&hub).unwrap();
    }
    assert_eq!(
        stored(&hub, &second).end_reason,
        Some(PreviewEndReason::Cap)
    );

    // Its PR merged.
    let third = start(&hub, &person(), 14).await.unwrap()["preview"]["previewId"]
        .as_str()
        .unwrap()
        .to_owned();
    pr(&hub, 14, "merged", "T14", "W12");
    super::sweep(&hub).unwrap();
    let merged = stored(&hub, &third);
    assert_eq!(merged.end_reason, Some(PreviewEndReason::Done));
    assert_eq!(merged.note.as_deref(), Some("#14 merged"));

    // Its machine went offline: nothing to tell it.
    pr(&hub, 14, "reviewing", "T14", "W12");
    let fourth = start(&hub, &person(), 14).await.unwrap()["preview"]["previewId"]
        .as_str()
        .unwrap()
        .to_owned();
    let stops = devbox.stops().len();
    hub.store
        .machine_set_status(&mid("devbox"), MachineStatus::Offline, &AT.into())
        .unwrap();
    super::sweep(&hub).unwrap();
    assert_eq!(
        stored(&hub, &fourth).end_reason,
        Some(PreviewEndReason::Lost)
    );
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(devbox.stops().len(), stops);
}

#[tokio::test]
async fn a_restarted_hub_keeps_its_previews_and_takes_their_reports() {
    let home = tempfile::tempdir().unwrap();
    let clock = ManualClock::at(NOW_MS);
    let id = {
        let hub = hub_on(
            HubDb::open(home.path()).unwrap(),
            home.path(),
            clock.clone(),
        );
        super::save_config(&hub, &shop(), &web()).unwrap();
        pr(&hub, 14, "reviewing", "T14", "W12");
        let _devbox = node(&hub, "devbox", None);
        let out = start(&hub, &person(), 14).await.unwrap();
        out["preview"]["previewId"].as_str().unwrap().to_owned()
    };
    let hub = hub_on(
        HubDb::open(home.path()).unwrap(),
        home.path(),
        clock.clone(),
    );
    let list = tool(
        &hub,
        &person(),
        "previews_list",
        json!({ "projectRef": shop() }),
    )
    .await
    .unwrap();
    assert_eq!(list["previews"][0]["previewId"], id.as_str());
    assert_eq!(list["previews"][0]["state"], "starting");
    super::on_report(
        &hub,
        &mid("devbox"),
        report(&id, "ready", json!({ "url": "http://devbox:8414" })),
    );
    assert_eq!(stored(&hub, &id).state, PreviewState::Ready);
    // The settings came back too: the same PR opens the one that runs.
    let _devbox = node(&hub, "devbox", None);
    let again = start(&hub, &person(), 14).await.unwrap();
    assert_eq!(again["preview"]["previewId"], id.as_str());
}

/// A lead call the node makes for `agent` in shop.
async fn call(
    hub: &Hub,
    agent: CallerAgent,
    mut call: Value,
    op: &str,
) -> Result<LeadCallResult, String> {
    call["op"] = op.into();
    let call: LeadCall = serde_json::from_value(call).map_err(|e| e.to_string())?;
    let caller = LeadCaller {
        project_ref: shop(),
        by: crate::hub::link::lead_calls::lead_by(&shop()),
        agent,
    };
    let handler = hub.lead_calls.handler(op).unwrap();
    handler
        .handle(caller, call)
        .await
        .map_err(|e| format!("{:?} {}", e.code, e.message))
}

fn writer() -> CallerAgent {
    CallerAgent::Task(TaskId::unchecked("T14"))
}

#[tokio::test]
async fn a_suggestion_shows_once_per_pr_and_starts_nothing() {
    let (hub, _clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    let suggest = json!({
        "prUrl": "https://github.com/acme/shop/pull/14",
        "why": "the checkout's buttons read differently in German and Dutch",
    });
    let LeadCallResult::PreviewSuggest(first) =
        call(&hub, writer(), suggest.clone(), "preview_suggest")
            .await
            .unwrap()
    else {
        panic!("not a suggestion")
    };
    assert!(first.shown);
    let LeadCallResult::PreviewSuggest(again) =
        call(&hub, CallerAgent::Lead, suggest, "preview_suggest")
            .await
            .unwrap()
    else {
        panic!("not a suggestion")
    };
    assert!(!again.shown, "once per PR");
    let (messages, _, _) = hub.chat.page(&shop(), None, None, 10).unwrap();
    let lines: Vec<_> = messages
        .iter()
        .filter(|m| m.preview_suggestion.is_some())
        .collect();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].author, ChatAuthor::Agent);
    assert_eq!(
        lines[0].text.as_str(),
        "#14's writer suggests trying #14: the checkout's buttons read differently in German and Dutch"
    );
    let list = tool(
        &hub,
        &person(),
        "previews_list",
        json!({ "projectRef": shop() }),
    )
    .await
    .unwrap();
    assert_eq!(list["suggestions"][0]["by"], "#14's writer");
    assert!(list["previews"].as_array().unwrap().is_empty());
    assert!(devbox.runs().is_empty(), "a suggestion starts nothing");
    // Once the person tries it, the suggestion has done its job.
    start(&hub, &person(), 14).await.unwrap();
    let list = tool(
        &hub,
        &person(),
        "previews_list",
        json!({ "projectRef": shop() }),
    )
    .await
    .unwrap();
    assert!(list["suggestions"].as_array().unwrap().is_empty());

    let other =
        json!({ "prUrl": "https://github.com/acme/elsewhere/pull/3", "why": "looks different" });
    let refused = call(&hub, writer(), other, "preview_suggest")
        .await
        .unwrap_err();
    assert!(refused.contains("not a PR of your project"), "{refused}");
}

#[tokio::test]
async fn a_proposed_setting_is_saved_only_once_a_person_approves_it() {
    let (hub, _clock, _home) = hub();
    // The approvals' hub port, as start_loops binds it.
    hub.ops.bind(&hub);
    hub.db
        .project_settings()
        .set_preview(&shop(), &serde_json::from_value(json!({})).unwrap())
        .unwrap();
    let propose = json!({
        "config": { "web": { "setup": ["pnpm install"], "build": "pnpm build", "start": "pnpm preview --port $PORT" } },
        "why": "the shop is a Vite app",
    });
    let LeadCallResult::PreviewConfigPropose(open) =
        call(&hub, writer(), propose, "preview_config_propose")
            .await
            .unwrap()
    else {
        panic!("not a request")
    };
    assert!(
        hub.db
            .project_settings()
            .preview(&shop())
            .unwrap()
            .is_none()
    );
    let empty = json!({ "config": {}, "why": "nothing" });
    let refused = call(&hub, writer(), empty, "preview_config_propose")
        .await
        .unwrap_err();
    assert!(refused.contains("runs nothing"), "{refused}");
    let (code, _) = refused_of(
        tool(
            &hub,
            &key("agent", "admin"),
            "approval_answer",
            json!({ "requestId": open.request_id, "decision": "approve" }),
        )
        .await,
    );
    assert_eq!(code, "Forbidden");
    let answered = tool(
        &hub,
        &person(),
        "approval_answer",
        json!({ "requestId": open.request_id, "decision": "approve" }),
    )
    .await
    .unwrap();
    assert_eq!(answered["request"]["state"], "ran");
    let saved = hub.db.project_settings().preview(&shop()).unwrap().unwrap();
    assert_eq!(saved.web.unwrap().build.unwrap().as_str(), "pnpm build");
}

fn refused_of(result: Result<Value, CallError>) -> (String, String) {
    refused(result)
}

#[tokio::test]
async fn a_lead_starts_a_preview_only_in_a_turn_answering_the_person() {
    let (hub, clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    let start_call = json!({ "of": of_pr(14) });
    let refused = call(&hub, CallerAgent::Lead, start_call.clone(), "preview_start")
        .await
        .unwrap_err();
    assert!(refused.contains("only in a turn that answers"), "{refused}");
    let refused = call(&hub, writer(), start_call.clone(), "preview_start")
        .await
        .unwrap_err();
    assert!(refused.starts_with("Forbidden"), "{refused}");

    let (asked, _) = hub
        .chat
        .add(
            &shop(),
            NewMessage {
                author: Some(ChatAuthor::Human),
                text: "let me try #14".into(),
                ..Default::default()
            },
        )
        .unwrap();
    let LeadCallResult::PreviewStart(out) =
        call(&hub, CallerAgent::Lead, start_call.clone(), "preview_start")
            .await
            .unwrap()
    else {
        panic!("not a start")
    };
    assert_eq!(
        out.preview.asked_by.words.as_str(),
        format!(
            "the lead, because you asked at {}",
            &iso_ms(NOW_MS as i64)[11..16]
        )
    );
    assert_eq!(out.preview.asked_by.message_id, Some(asked.message_id));
    assert_eq!(devbox.runs().len(), 1);

    // Once the lead has answered, a later turn of its own starts nothing.
    super::end(&hub, out.preview, PreviewEndReason::Ended, None).unwrap();
    hub.chat
        .add(
            &shop(),
            NewMessage {
                author: Some(ChatAuthor::Lead),
                text: "it runs".into(),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(
        call(&hub, CallerAgent::Lead, start_call.clone(), "preview_start")
            .await
            .is_err()
    );
    // Nor does an old ask.
    hub.chat
        .add(
            &shop(),
            NewMessage {
                author: Some(ChatAuthor::Human),
                text: "try it again".into(),
                ..Default::default()
            },
        )
        .unwrap();
    clock.advance(Duration::from_secs(2 * 3600));
    assert!(
        call(&hub, CallerAgent::Lead, start_call, "preview_start")
            .await
            .is_err()
    );
    assert_eq!(devbox.runs().len(), 1);
}

#[tokio::test]
async fn feedback_goes_to_the_lead_when_the_writer_is_gone_in_plain_words() {
    let (hub, _clock, _home) = hub();
    let _devbox = node(&hub, "devbox", None);
    let out = start(&hub, &person(), 14).await.unwrap();
    let p = stored(&hub, out["preview"]["previewId"].as_str().unwrap());
    let to = super::tools::feedback_to(&hub, &p).unwrap();
    assert_eq!(
        serde_json::to_value(&to.target).unwrap(),
        json!({ "workstreamId": "W12" })
    );
    assert_eq!(to.words, "the lead of W12, who decides how it's fixed");
    let pins: Vec<fleetd_contracts::preview::PreviewPin> = serde_json::from_value(json!([
        { "x": 7600, "y": 7650, "note": "In Dutch the button wraps onto two lines.\nKeep it on one.",
          "what": "the button \"Bestelling plaatsen en betalen\"", "at": "/checkout?lang=nl" },
        { "x": 100, "y": 200 },
    ]))
    .unwrap();
    let (head, lines) = super::tools::fix_request(&p, &pins, &to);
    assert_eq!(
        head,
        "Fix request from the person, who tried #14 on the web at 3f2a91c: 2 points, below. Decide how it's fixed, \
         and push the fix to the PR it belongs to."
    );
    assert_eq!(
        lines,
        [
            "1. In Dutch the button wraps onto two lines. Keep it on one. Pin 1: the button \"Bestelling plaatsen en \
             betalen\", on /checkout?lang=nl, 76% across, 76% down.",
            "2. (no words: see the screenshot) Pin 2: the point, 1% across, 2% down.",
        ]
    );
    // A PR no order's agent wrote has nobody to send it to.
    let mut other = p.clone();
    other.of = serde_json::from_value(of_pr(99)).unwrap();
    assert!(super::tools::feedback_to(&hub, &other).is_err());
}

#[test]
fn the_owner_login_is_the_machine_users() {
    let status = r#"{ "Self": { "UserID": 42, "HostName": "devbox" },
        "User": { "42": { "ID": 42, "LoginName": "ada@github" }, "7": { "ID": 7, "LoginName": "other@github" } } }"#;
    assert_eq!(
        super::login_of_status(status).as_deref(),
        Some("ada@github")
    );
    assert_eq!(super::login_of_status("{}"), None);
    assert_eq!(super::login_of_status("not json"), None);
}

fn started(out: Value) -> String {
    out["preview"]["previewId"].as_str().unwrap().to_owned()
}

/// The node resends its previews on a new link and answers a stop it can't place with an ended report, so a report
/// of a preview the hub doesn't hold, or one it ended, gets a stop.
#[tokio::test]
async fn a_node_is_told_to_stop_a_preview_the_hub_doesnt_hold_or_has_ended() {
    let (hub, _clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    let unknown = format!("P{}", "b".repeat(32));
    super::on_report(&hub, &mid("devbox"), report(&unknown, "ready", json!({})));
    // Its ended answer settles it: nothing more to say.
    super::on_report(
        &hub,
        &mid("devbox"),
        report(&unknown, "ended", json!({ "endReason": "lost" })),
    );
    assert!(
        super::get(
            &hub,
            &fleetd_contracts::preview::PreviewId::unchecked(&unknown)
        )
        .unwrap()
        .is_none()
    );

    let id = started(start(&hub, &person(), 14).await.unwrap());
    tool(&hub, &person(), "preview_end", json!({ "previewId": id }))
        .await
        .unwrap();
    // The node, back from a blip, still reports it running.
    super::on_report(&hub, &mid("devbox"), report(&id, "ready", json!({})));
    assert_eq!(stored(&hub, &id).state, PreviewState::Ended);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        devbox.stops(),
        [
            (unknown, PreviewEndReason::Lost),
            (id.clone(), PreviewEndReason::Ended),
            (id, PreviewEndReason::Ended),
        ]
    );
}

/// After a restart, the hub stops each running preview its node doesn't report again on its new link within
/// SETTLE_MS; the node's ended answer settles it, and one it did report runs on.
#[tokio::test]
async fn a_restarted_hub_stops_the_previews_its_node_no_longer_reports() {
    let home = tempfile::tempdir().unwrap();
    let clock = ManualClock::at(NOW_MS);
    let (kept, gone) = {
        let hub = hub_on(
            HubDb::open(home.path()).unwrap(),
            home.path(),
            clock.clone(),
        );
        super::save_config(&hub, &shop(), &web()).unwrap();
        pr(&hub, 14, "reviewing", "T14", "W12");
        pr(&hub, 15, "reviewing", "T15", "W13");
        let _devbox = node(&hub, "devbox", None);
        (
            started(start(&hub, &person(), 14).await.unwrap()),
            started(start(&hub, &person(), 15).await.unwrap()),
        )
    };
    let hub = hub_on(
        HubDb::open(home.path()).unwrap(),
        home.path(),
        clock.clone(),
    );
    let devbox = node(&hub, "devbox", None);
    // The node resends what it still runs: only the first.
    super::on_report(
        &hub,
        &mid("devbox"),
        report(&kept, "ready", json!({ "url": "http://devbox:8414" })),
    );
    assert_eq!(super::sweep(&hub).unwrap(), 0);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        devbox.stops().is_empty(),
        "the link gets its time to report"
    );

    clock.advance(Duration::from_millis(super::SETTLE_MS as u64));
    assert_eq!(super::sweep(&hub).unwrap(), 0);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(devbox.stops(), [(gone.clone(), PreviewEndReason::Lost)]);
    super::on_report(
        &hub,
        &mid("devbox"),
        report(&gone, "ended", json!({ "endReason": "lost" })),
    );
    let settled = stored(&hub, &gone);
    assert_eq!(
        (settled.state, settled.end_reason),
        (PreviewState::Ended, Some(PreviewEndReason::Lost))
    );
    assert_eq!(stored(&hub, &kept).state, PreviewState::Ready);
    // Stopped once, not at every sweep.
    super::sweep(&hub).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(devbox.stops().len(), 1);
}

/// The node gives a preview its order's variables: the order a PR belongs to, or the order itself.
#[tokio::test]
async fn a_run_names_the_order_whose_variables_it_gets() {
    use crate::hub::leads::records::NewWorkstream;
    use fleetd_contracts::ledger::IntakeChannel;
    let (hub, _clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    start(&hub, &person(), 14).await.unwrap();
    let (order, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: shop(),
            title: "Checkout in Dutch".into(),
            text: "Checkout in Dutch".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    pr(&hub, 16, "reviewing", "T16", order.workstream_id.as_str());
    tool(
        &hub,
        &person(),
        "preview_start",
        json!({ "projectRef": shop(), "of": { "kind": "order", "workstreamId": order.workstream_id } }),
    )
    .await
    .unwrap();
    let orders: Vec<Option<String>> = devbox
        .runs()
        .iter()
        .map(|r| r.order_id.as_ref().map(|w| w.to_string()))
        .collect();
    assert_eq!(
        orders,
        [
            Some("W12".to_owned()),
            Some(order.workstream_id.to_string())
        ]
    );
}

/// A preview's in-app view is a browser session the person holds, with no agent behind it: its node reports it and
/// uploads its recording under the preview's id (#578), which the hub takes while the preview runs. Ended, it takes
/// only the recording's upload and the closing report, for as long as the node tries (the upload starts once the
/// session closes, after the end); an unknown preview's id is refused.
#[tokio::test]
async fn a_held_sessions_report_and_upload_go_under_its_preview_until_a_week_after_it_ends() {
    let (hub, clock, _home) = hub();
    let _devbox = node(&hub, "devbox", None);
    let id = started(start(&hub, &person(), 14).await.unwrap());
    let session = format!("B{}", "c".repeat(32));
    let as_node = |thread: &str, op: &str, call: Value| {
        let hub = hub.clone();
        let (thread, op) = (thread.to_owned(), op.to_owned());
        async move {
            let thread = fleetd_contracts::ids::ThreadRef {
                machine_id: mid("devbox"),
                thread_id: fleetd_contracts::ids::ThreadId::unchecked(thread),
            };
            // As the link answers a node's call: the project from its cwd (the node's preview slot, outside every
            // workspace) or else its session, then who the session is.
            let projects = hub.store.projects_list(Some(&mid("devbox")), None).unwrap();
            let project = hub
                .lead_calls
                .call_project(
                    &mid("devbox"),
                    &projects,
                    "/home/u/.fleetd/node/previews/1",
                    Some(&thread),
                )
                .map_err(|e| e.message)?;
            assert_eq!(project, shop());
            let agent = hub
                .lead_calls
                .agent_of(Some(&thread), &project)
                .map_err(|e| e.message)?;
            let mut call = call;
            call["op"] = op.as_str().into();
            let call: LeadCall = serde_json::from_value(call).unwrap();
            crate::hub::tasks::policy::check_call(&agent, &call).map_err(|e| e.message)?;
            let caller = LeadCaller {
                project_ref: shop(),
                by: crate::hub::link::lead_calls::lead_by(&shop()),
                agent,
            };
            hub.lead_calls
                .handler(&op)
                .unwrap()
                .handle(caller, call)
                .await
                .map(|_| ())
                .map_err(|e| e.message)
        }
    };
    let live = json!({
        "sessionId": session, "threadId": id, "purpose": "Try #14", "state": "live", "control": "human",
        "startedAt": AT, "files": [],
    });
    let part = json!({ "sessionId": session, "file": "video", "offset": 0, "dataB64": "AAAA" });
    as_node(&id, "browser_session", live.clone()).await.unwrap();
    as_node(&id, "browser_recording_part", part.clone())
        .await
        .unwrap();
    let held = crate::hub::browser::get(
        &hub.db,
        &fleetd_contracts::browser::BrowserSessionId::unchecked(&session),
    )
    .unwrap()
    .unwrap();
    assert_eq!((held.project_ref, held.task_id), (shop(), None));
    // Its session only reports itself.
    let why = as_node(
        &id,
        "preview_suggest",
        json!({ "prUrl": "https://github.com/acme/shop/pull/14", "why": "x" }),
    )
    .await
    .unwrap_err();
    assert!(why.contains("isn't a call of preview"), "{why}");

    let unknown = format!("P{}", "d".repeat(32));
    let why = as_node(&unknown, "browser_session", live.clone())
        .await
        .unwrap_err();
    assert!(why.contains("holds no preview"), "{why}");
    // Ended, the session closes and its recording uploads: only that and its closing report are taken.
    tool(&hub, &person(), "preview_end", json!({ "previewId": id }))
        .await
        .unwrap();
    let why = as_node(&id, "browser_session", live.clone())
        .await
        .unwrap_err();
    assert!(why.contains("can't be live"), "{why}");
    let why = as_node(
        &id,
        "browser_takeover",
        json!({ "sessionId": session, "reason": "a captcha" }),
    )
    .await
    .unwrap_err();
    assert!(why.contains("only uploads its recording"), "{why}");
    let rest = json!({ "sessionId": session, "file": "video", "offset": 3, "dataB64": "AAAA" });
    as_node(&id, "browser_recording_part", rest).await.unwrap();
    let mut recorded = live.clone();
    recorded["state"] = "recorded".into();
    recorded["files"] = json!([{ "file": "video", "bytes": 6 }]);
    as_node(&id, "browser_session", recorded).await.unwrap();
    // A week on, nothing more.
    clock.advance(Duration::from_millis(super::HELD_UPLOAD_MS as u64));
    let why = as_node(&id, "browser_recording_part", part)
        .await
        .unwrap_err();
    assert!(why.contains("ended over a week ago"), "{why}");
}

/// A preview runs the PR's code on our machine, so only a head that is a branch of the repo itself is checked out: a
/// fork's is refused, and so is one whose repo was deleted (GitHub names none).
#[test]
fn a_head_from_a_fork_or_a_deleted_repo_is_never_checked_out() {
    let head = |repo: Value| -> crate::hub::train::github::PullHead {
        serde_json::from_value(json!({ "ref": "fix", "sha": SHA, "repo": repo })).unwrap()
    };
    assert!(super::head_in(
        &head(json!({ "full_name": "Acme/Shop" })),
        "acme/shop"
    ));
    assert!(!super::head_in(
        &head(json!({ "full_name": "mallory/shop" })),
        "acme/shop"
    ));
    assert!(!super::head_in(&head(Value::Null), "acme/shop"));
}

/// Two quick asks for the same PR start one preview: the second, which read GitHub while the first did, gets the
/// first one back when it comes to store its own.
#[tokio::test]
async fn two_quick_asks_for_one_pr_start_one_preview() {
    let (hub, _clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    let first = started(start(&hub, &person(), 14).await.unwrap());
    let mut second = stored(&hub, &first);
    second.preview_id = super::new_id();
    let claimed = hub.db.transaction(|c| super::claim_on(c, &second)).unwrap();
    assert_eq!(
        claimed.map(|p| p.preview_id.to_string()),
        Some(first.clone())
    );
    assert!(super::get(&hub, &second.preview_id).unwrap().is_none());
    assert_eq!(super::running(&hub).unwrap().len(), 1);
    // Another PR is a preview of its own.
    second.of = serde_json::from_value(of_pr(15)).unwrap();
    assert!(
        hub.db
            .transaction(|c| super::claim_on(c, &second))
            .unwrap()
            .is_none()
    );
    assert_eq!(super::running(&hub).unwrap().len(), 2);
    assert_eq!(devbox.runs().len(), 1);
}

/// Ended is final: a report the node sent before it heard the stop, written after the preview ended, changes
/// nothing.
#[tokio::test]
async fn a_late_report_never_moves_an_ended_preview_back() {
    let (hub, _clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    let id = started(start(&hub, &person(), 14).await.unwrap());
    super::on_report(&hub, &mid("devbox"), report(&id, "ready", json!({})));
    let read_before_the_end = stored(&hub, &id);
    tool(&hub, &person(), "preview_end", json!({ "previewId": id }))
        .await
        .unwrap();
    assert!(
        !hub.db
            .transaction(|c| super::put_running_on(c, &read_before_the_end))
            .unwrap()
    );
    let ended = stored(&hub, &id);
    assert_eq!(
        (ended.state, ended.end_reason),
        (PreviewState::Ended, Some(PreviewEndReason::Ended))
    );
    super::on_report(
        &hub,
        &mid("devbox"),
        report(&id, "ready", json!({ "url": "http://devbox:8414" })),
    );
    let still = stored(&hub, &id);
    assert_eq!((still.state, still.url), (PreviewState::Ended, None));
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(devbox.stops().len(), 2, "told to stop, then told again");
}

/// A report read before the preview ended and written after it: the preview stays as it ended, and its node is told
/// again to stop, with the reason it ended for.
#[tokio::test]
async fn a_report_that_lost_the_race_tells_the_node_why_it_ended() {
    let (hub, _clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    let id = started(start(&hub, &person(), 14).await.unwrap());
    super::on_report(&hub, &mid("devbox"), report(&id, "ready", json!({})));
    let read = stored(&hub, &id);
    super::end(&hub, read.clone(), PreviewEndReason::Cap, None).unwrap();
    super::apply(
        &hub,
        &mid("devbox"),
        read,
        report(&id, "ready", json!({ "url": "http://devbox:8414" })),
    )
    .unwrap();
    let ended = stored(&hub, &id);
    assert_eq!(
        (ended.state, ended.end_reason, ended.url),
        (PreviewState::Ended, Some(PreviewEndReason::Cap), None)
    );
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(
        devbox.stops(),
        [
            (id.clone(), PreviewEndReason::Cap),
            (id, PreviewEndReason::Cap)
        ]
    );
}

/// Ended is final for the hub's own writes too: End on a copy read before the node said it ended, and a refusal
/// that arrives after the node's ended report, both leave it as the node ended it.
#[tokio::test]
async fn neither_end_nor_a_refused_start_overwrites_a_finished_preview() {
    let (hub, _clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    let id = started(start(&hub, &person(), 14).await.unwrap());
    let read = stored(&hub, &id);
    super::on_report(
        &hub,
        &mid("devbox"),
        report(&id, "ended", json!({ "endReason": "idle" })),
    );
    let kept = super::end(&hub, read, PreviewEndReason::Ended, Some("ended by hand")).unwrap();
    assert_eq!(
        (kept.state, kept.end_reason, kept.note),
        (PreviewState::Ended, Some(PreviewEndReason::Idle), None)
    );
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(devbox.stops().is_empty(), "nothing left to stop");
    drop(devbox);

    // A node that reports the run lost, then refuses it.
    let (tx, mut rx) = mpsc::unbounded_channel::<HubToNode>();
    let _link = hub.node_commands.attach(&mid("devbox"), tx);
    let (node_hub, commands) = (hub.clone(), hub.node_commands.clone());
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if let HubToNode::PreviewRun(run) = &frame {
                super::on_report(
                    &node_hub,
                    &mid("devbox"),
                    report(
                        run.preview_id.as_str(),
                        "ended",
                        json!({ "endReason": "lost" }),
                    ),
                );
                answer(&commands, &mid("devbox"), run, Some("the worktree is gone"));
            }
        }
    });
    let (_, why) = refused(start(&hub, &person(), 14).await);
    assert!(why.contains("the worktree is gone"), "{why}");
    let latest = super::list(&hub, &shop())
        .unwrap()
        .into_iter()
        .find(|p| p.preview_id.as_str() != id)
        .unwrap();
    assert_eq!(
        (latest.state, latest.end_reason),
        (PreviewState::Ended, Some(PreviewEndReason::Lost))
    );
}

/// GitHub's repo names ignore case: a preview of acme/shop#14 is the one of Acme/Shop#14.
#[tokio::test]
async fn a_pr_is_the_same_whatever_its_repo_names_case() {
    let (hub, _clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    let id = started(start(&hub, &person(), 14).await.unwrap());
    let upper = json!({ "kind": "pr", "repo": "Acme/Shop", "number": 14 });
    let again = tool(
        &hub,
        &person(),
        "preview_start",
        json!({ "projectRef": shop(), "of": upper }),
    )
    .await
    .unwrap();
    assert_eq!(again["preview"]["previewId"], id.as_str());
    assert_eq!(devbox.runs().len(), 1);
    let listed = tool(
        &hub,
        &person(),
        "previews_list",
        json!({ "projectRef": shop(), "of": upper }),
    )
    .await
    .unwrap();
    assert_eq!(listed["previews"][0]["previewId"], id.as_str());
    let mut other = stored(&hub, &id);
    other.of = serde_json::from_value(upper).unwrap();
    other.preview_id = super::new_id();
    assert!(
        hub.db
            .transaction(|c| super::claim_on(c, &other))
            .unwrap()
            .is_some()
    );
}

/// A node that never answers the run may have taken it all the same: the hub gives up, marks it failed and tells the
/// node to stop, so nothing of it keeps running there.
#[tokio::test(start_paused = true)]
async fn a_start_the_node_never_answers_is_stopped_there() {
    let (hub, _clock, _home) = hub();
    let (tx, mut rx) = mpsc::unbounded_channel::<HubToNode>();
    let _link = hub.node_commands.attach(&mid("devbox"), tx);
    let (_, why) = refused(start(&hub, &person(), 14).await);
    assert!(why.contains("did not answer"), "{why}");
    let failed = super::running(&hub).unwrap();
    assert!(failed.is_empty(), "nothing is left running");
    let mut stops = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        if let HubToNode::PreviewStop(stop) = frame {
            stops.push(stop.reason);
        }
    }
    assert_eq!(stops, [PreviewEndReason::Lost]);
}

/// An order's PRs run together only from one repo: across several, Try it says so plainly and asks GitHub nothing.
#[tokio::test]
async fn an_order_across_several_repos_is_refused_in_plain_words() {
    use crate::hub::leads::records::NewWorkstream;
    use fleetd_contracts::ledger::IntakeChannel;
    let (hub, _clock, _home) = hub();
    let devbox = node(&hub, "devbox", None);
    let (order, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: shop(),
            title: "Checkout in Dutch".into(),
            text: "Checkout in Dutch".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    let w = order.workstream_id.to_string();
    pr(&hub, 16, "reviewing", "T16", &w);
    hub.train.records().create(
        serde_json::from_value(json!({
            "changeId": "X1", "projectRef": shop(), "repo": "acme/admin", "prNumber": 3,
            "prUrl": "https://github.com/acme/admin/pull/3", "branch": "fleetd/T17-admin", "taskId": "T17",
            "workstreamId": w, "headSha": SHA, "state": "reviewing", "reviews": [], "createdAt": AT, "updatedAt": AT,
        }))
        .unwrap(),
    );
    let (code, why) = refused(
        tool(
            &hub,
            &person(),
            "preview_start",
            json!({ "projectRef": shop(), "of": { "kind": "order", "workstreamId": w } }),
        )
        .await,
    );
    assert_eq!(code, "Invalid");
    assert_eq!(
        why,
        format!(
            "{w}'s PRs are in 2 repos (acme/admin, acme/shop), so they can't run together as one app."
        )
    );
    assert!(devbox.runs().is_empty());
}

/// The hub owner's login is kept once found; a lookup that found none is tried again a minute on, never kept.
#[tokio::test]
async fn an_owner_lookup_that_failed_is_tried_again() {
    let (hub, clock, _home) = hub();
    let asked = Arc::new(Mutex::new(0));
    let lookup = |found: Option<&'static str>| {
        let asked = asked.clone();
        move || async move {
            *asked.lock().unwrap() += 1;
            found.map(str::to_owned)
        }
    };
    assert_eq!(super::owner_login(&hub, lookup(None)).await, None);
    assert_eq!(
        super::owner_login(&hub, lookup(Some("me@example.com"))).await,
        None
    );
    assert_eq!(*asked.lock().unwrap(), 1, "not again within the minute");
    clock.advance(Duration::from_millis(super::OWNER_RETRY_MS as u64));
    let found = super::owner_login(&hub, lookup(Some("me@example.com"))).await;
    assert_eq!(found.as_deref(), Some("me@example.com"));
    clock.advance(Duration::from_millis(super::OWNER_RETRY_MS as u64));
    let kept = super::owner_login(&hub, lookup(None)).await;
    assert_eq!(kept.as_deref(), Some("me@example.com"));
    assert_eq!(*asked.lock().unwrap(), 2);
}

/// A preview of a PR the merge train never queued ends once GitHub says the PR merged or closed; GitHub is asked about
/// it every few minutes, and never about a PR the train tracks.
#[tokio::test]
async fn a_preview_of_an_untracked_pr_ends_when_it_merges_or_closes() {
    let (hub, clock, _home) = hub();
    let _devbox = node(&hub, "devbox", None);
    let tracked = started(start(&hub, &person(), 14).await.unwrap());
    let untracked = |n: i64| {
        let mut p = stored(&hub, &tracked);
        p.preview_id = super::new_id();
        p.of = serde_json::from_value(of_pr(n)).unwrap();
        assert!(
            hub.db
                .transaction(|c| super::claim_on(c, &p))
                .unwrap()
                .is_none()
        );
        p.preview_id.to_string()
    };
    let (merged, closed) = (untracked(30), untracked(31));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let github = |answer: fn(i64) -> Option<(String, bool)>| {
        let asked = asked.clone();
        move |repo: String, n: i64| {
            asked.lock().unwrap().push(format!("{repo}#{n}"));
            async move { answer(n) }
        }
    };
    let open = github(|_| Some(("open".to_owned(), false)));
    assert_eq!(super::end_untracked(&hub, &open).await.unwrap(), 0);
    assert_eq!(super::end_untracked(&hub, &open).await.unwrap(), 0);
    assert_eq!(*asked.lock().unwrap(), ["acme/shop#30", "acme/shop#31"]);

    clock.advance(Duration::from_millis(super::UNTRACKED_EVERY_MS as u64));
    let done = github(|n| Some(("closed".to_owned(), n == 30)));
    assert_eq!(super::end_untracked(&hub, &done).await.unwrap(), 2);
    for (id, note) in [(&merged, "#30 merged"), (&closed, "#31 closed")] {
        let p = stored(&hub, id);
        assert_eq!(
            (p.state, p.end_reason, p.note.as_deref()),
            (
                PreviewState::Ended,
                Some(PreviewEndReason::Done),
                Some(note)
            )
        );
    }
    assert_eq!(stored(&hub, &tracked).state, PreviewState::Starting);
    assert_eq!(asked.lock().unwrap().len(), 4);
}
