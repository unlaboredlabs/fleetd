//! Automations on the hub clock: a schedule fires and the lead takes its order with no human message, a schedule
//! missed while the hub was down runs once, one run at a time, pause; the webhook over HTTP (a wrong secret refused
//! and written nowhere); the lead's tools.
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::automations::{
    AutomationRunState, AutomationSchedule, AutomationTrigger, WEBHOOK_BODY_MAX,
};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, Timestamp};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::ledger::{IntakeChannel, WorkstreamState};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::model::{ProjectSummary, ThreadCounts};
use serde_json::json;

use super::*;
use crate::hub::leads::auto_start_tests::{self, hub as lead_hub};
use crate::hub::leads::workstreams::IntakeInput;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::test_clock::ManualClock;

const MIN: u64 = 60;

async fn settle() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
}

fn schedule(cron: &str, tz: &str) -> AutomationSchedule {
    serde_json::from_value(json!({ "cron": cron, "tz": tz })).unwrap()
}

fn new(r: &ProjectRef, s: Option<AutomationSchedule>, webhook: bool) -> NewAutomation {
    NewAutomation {
        project_ref: r.clone(),
        name: Line::unchecked("Nightly dependency check"),
        prompt: serde_json::from_value(json!(
            "Check the dependencies for updates; open a PR for safe ones."
        ))
        .unwrap(),
        schedule: s,
        webhook,
        by: "human".into(),
        client_request_id: None,
    }
}

/// The automations of a lead test hub (project lab-a/p-a, a usable runner, the clock at Sat 2026-10-17 10:00 UTC).
fn over(h: &auto_start_tests::Hub) -> Arc<Automations> {
    Automations::new(
        h.area.ctx.db.clone(),
        h.events.clone(),
        h.clock.clone(),
        h.area.clone(),
    )
}

fn events_of(
    h: &auto_start_tests::Hub,
    kind: HubEventType,
) -> Vec<fleetd_contracts::events::HubEvent> {
    h.events.page(0, Some(&[kind]), None).unwrap().events
}

#[tokio::test(flavor = "current_thread")]
async fn a_schedule_fires_at_its_cron_time_and_the_lead_takes_the_order_without_a_human_message() {
    let h = lead_hub(true);
    let autos = over(&h);
    // 12:30 in Berlin is 10:30 UTC in October (CEST).
    let (a, secret) = autos
        .create(new(
            &h.project,
            Some(schedule("30 12 * * *", "Europe/Berlin")),
            false,
        ))
        .unwrap();
    assert!(secret.is_none());
    assert_eq!(
        a.next_run_at.as_ref().unwrap().as_str(),
        "2026-10-17T10:30:00.000Z"
    );
    autos.start();
    settle().await;

    h.clock.advance(Duration::from_secs(29 * MIN));
    settle().await;
    assert!(autos.runs(a.automation_id.as_str(), 10).unwrap().is_empty());
    assert!(h.launched_prompts().is_empty());

    h.clock.advance(Duration::from_secs(MIN));
    settle().await;
    let runs = autos.runs(a.automation_id.as_str(), 10).unwrap();
    assert_eq!(runs.len(), 1);
    let run = &runs[0];
    assert_eq!(
        (run.trigger, run.state),
        (AutomationTrigger::Schedule, AutomationRunState::Running)
    );
    assert_eq!(
        run.scheduled_at.as_ref().unwrap().as_str(),
        "2026-10-17T10:30:00.000Z"
    );
    assert!(run.late_min.is_none());

    // The order is the automation's, and the lead started with it: no chat message, no person.
    let w = run.workstream_id.clone().unwrap();
    let order = h.area.workstreams.get(&w).unwrap().unwrap();
    assert_eq!(order.source.channel, IntakeChannel::Automation);
    assert_eq!(order.source.by, format!("automation:{}", a.automation_id));
    assert_eq!(order.title.as_str(), "Nightly dependency check");
    let prompts = h.launched_prompts();
    assert_eq!(prompts.len(), 1, "the lead started once");
    assert!(
        prompts[0].contains(w.as_str())
            && prompts[0].contains("Check the dependencies for updates"),
        "the lead's first message lists the order: {}",
        prompts[0]
    );
    assert!(prompts[0].contains("## Automations"));
    assert!(h.area.leads.get(&h.project).unwrap().is_some());

    // The next run is tomorrow's.
    let after = autos.get(a.automation_id.as_str()).unwrap().unwrap();
    assert_eq!(
        after.next_run_at.unwrap().as_str(),
        "2026-10-18T10:30:00.000Z"
    );
    assert_eq!(after.last_run.unwrap().run_id, run.run_id);
    let ran = events_of(&h, HubEventType::AutomationRun);
    assert_eq!(ran.len(), 1);
    assert!(
        ran[0].summary.as_str().contains("on schedule"),
        "{}",
        ran[0].summary.as_str()
    );
    autos.stop();
}

#[tokio::test(flavor = "current_thread")]
async fn runs_missed_while_the_hub_was_down_run_once_late() {
    let h = lead_hub(true);
    let before = over(&h);
    let (a, _) = before
        .create(new(&h.project, Some(schedule("0 * * * *", "UTC")), false))
        .unwrap();
    // Down from 10:00 to 13:20: the 11:00, 12:00 and 13:00 runs were missed.
    h.clock.advance(Duration::from_secs(200 * MIN));
    let autos = over(&h);
    autos.start();
    settle().await;
    let runs = autos.runs(a.automation_id.as_str(), 10).unwrap();
    assert_eq!(runs.len(), 1, "one run for the whole downtime");
    assert_eq!(
        runs[0].scheduled_at.as_ref().unwrap().as_str(),
        "2026-10-17T11:00:00.000Z"
    );
    assert_eq!(runs[0].late_min.as_ref().map(|n| n.get()), Some(140));
    let order = h
        .area
        .workstreams
        .get(runs[0].workstream_id.as_ref().unwrap())
        .unwrap()
        .unwrap();
    assert!(order.source.text.as_str().contains("140 min late, once"));
    let after = autos.get(a.automation_id.as_str()).unwrap().unwrap();
    assert_eq!(
        after.next_run_at.unwrap().as_str(),
        "2026-10-17T14:00:00.000Z"
    );
    autos.stop();
}

#[tokio::test(flavor = "current_thread")]
async fn a_trigger_while_a_run_is_open_is_skipped_and_recorded() {
    let h = lead_hub(true);
    let autos = over(&h);
    let (a, _) = autos.create(new(&h.project, None, false)).unwrap();
    let id = a.automation_id.as_str();
    let first = autos
        .run(id, Start::Manual { by: "human".into() })
        .await
        .unwrap();
    assert_eq!(first.state, AutomationRunState::Running);
    let w = first.workstream_id.clone().unwrap();

    let second = autos
        .run(
            id,
            Start::Webhook {
                payload: "{}".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(second.state, AutomationRunState::Skipped);
    assert!(second.workstream_id.is_none());
    assert!(second.why.as_ref().unwrap().as_str().contains(w.as_str()));
    assert_eq!(
        h.area
            .workstreams
            .list(&crate::hub::leads::records::WorkstreamFilter {
                project_ref: None,
                state: None,
                limit: 100
            })
            .unwrap()
            .len(),
        1,
        "no second order"
    );

    // A third trigger while the first order is still open is skipped too: the skipped run is the newest, not the
    // one that counts.
    let third_while_open = autos
        .run(
            id,
            Start::Schedule {
                due_ms: 1_792_231_200_000,
            },
        )
        .await
        .unwrap();
    assert_eq!(third_while_open.state, AutomationRunState::Skipped);
    let now_too = autos
        .run(id, Start::Manual { by: "human".into() })
        .await
        .unwrap();
    assert_eq!(now_too.state, AutomationRunState::Skipped);
    assert_eq!(
        h.area
            .workstreams
            .list(&crate::hub::leads::records::WorkstreamFilter {
                project_ref: None,
                state: None,
                limit: 100
            })
            .unwrap()
            .len(),
        1,
        "still one order"
    );

    // Once its order is closed the run is over, and the next trigger runs.
    h.area
        .workstreams
        .close(&h.project, &w, "deps are current", "lead:lab-a/p-a")
        .await
        .unwrap();
    let third = autos
        .run(id, Start::Manual { by: "human".into() })
        .await
        .unwrap();
    assert_eq!(third.state, AutomationRunState::Running);
    let runs = autos.runs(id, 10).unwrap();
    assert_eq!(
        runs.iter().map(|r| r.state).collect::<Vec<_>>(),
        vec![
            AutomationRunState::Running,
            AutomationRunState::Skipped,
            AutomationRunState::Skipped,
            AutomationRunState::Skipped,
            AutomationRunState::Done
        ]
    );
    assert!(runs[4].ended_at.is_some());
    // The lead started with the first run; the third reaches it as a wake with the whole prompt.
    h.after_debounce().await;
    let sends = h.node.sends.lock().unwrap().clone();
    let w3 = third.workstream_id.unwrap();
    assert!(
        sends
            .iter()
            .any(|m| m.contains(w3.as_str()) && m.contains("open a PR for safe ones")),
        "{sends:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_paused_automation_runs_only_on_run_now_and_resumes_from_now() {
    let h = lead_hub(true);
    let autos = over(&h);
    let (a, _) = autos
        .create(new(&h.project, Some(schedule("0 * * * *", "UTC")), false))
        .unwrap();
    let id = a.automation_id.as_str();
    autos.start();
    let paused = autos.pause(id, true, "human").unwrap();
    assert!(paused.paused && paused.next_run_at.is_none());
    h.clock.advance(Duration::from_secs(150 * MIN));
    settle().await;
    assert!(
        autos.runs(id, 10).unwrap().is_empty(),
        "the schedule started nothing"
    );

    let hook = autos
        .run(
            id,
            Start::Webhook {
                payload: "x".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(hook.state, AutomationRunState::Skipped);
    assert_eq!(hook.why.unwrap().as_str(), "the automation is paused");
    let now = autos
        .run(id, Start::Manual { by: "human".into() })
        .await
        .unwrap();
    assert_eq!(now.state, AutomationRunState::Running);

    // 12:30 now: the next run is 13:00, and the missed 11:00 and 12:00 don't run.
    let resumed = autos.pause(id, false, "human").unwrap();
    assert_eq!(
        resumed.next_run_at.unwrap().as_str(),
        "2026-10-17T13:00:00.000Z"
    );
    let changes: Vec<String> = events_of(&h, HubEventType::AutomationChanged)
        .iter()
        .map(|e| {
            e.data.as_ref().unwrap()["change"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(changes, vec!["created", "paused", "resumed"]);
    autos.stop();
}

#[test]
fn schedules_that_never_run_or_do_not_parse_are_refused() {
    let h = lead_hub(true);
    let autos = over(&h);
    for (cron, tz) in [
        ("0 9 30 2 *", "UTC"),
        ("61 * * * *", "UTC"),
        ("0 9 * *", "UTC"),
    ] {
        let e = autos
            .create(new(&h.project, Some(schedule(cron, tz)), false))
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Invalid, "{cron}");
        assert!(e.fix.is_some());
    }
}

#[test]
fn a_long_webhook_body_is_cut_to_fit_the_order_and_points_at_the_whole_one() {
    let h = lead_hub(true);
    let autos = over(&h);
    let (a, _) = autos.create(new(&h.project, None, true)).unwrap();
    let run = AutomationRun {
        run_id: AutomationRunId::unchecked("ar_abcdefgh"),
        automation_id: a.automation_id.clone(),
        trigger: AutomationTrigger::Webhook,
        at: Timestamp::from("2026-10-17T10:00:00.000Z".to_owned()),
        state: AutomationRunState::Running,
        workstream_id: None,
        scheduled_at: None,
        late_min: None,
        payload_bytes: None,
        why: None,
        by: None,
        ended_at: None,
    };
    let short = order_text(&a, &run, Some("{\"alert\":\"disk 91%\"}"));
    assert!(
        short.contains("```\n{\"alert\":\"disk 91%\"}\n```"),
        "{short}"
    );
    let body = "x".repeat(WEBHOOK_BODY_MAX);
    let long = order_text(&a, &run, Some(&body));
    assert!(long.chars().count() <= 4000);
    assert!(
        long.ends_with("automation_runs with runId ar_abcdefgh has the whole body."),
        "{long}"
    );
    // A body with a fence of its own can't close the block early.
    assert!(order_text(&a, &run, Some("a ``` b")).contains("````\na ``` b\n````"));
}

#[test]
fn hashes_compare_whole() {
    let a = secret_hash("one");
    assert!(same_hash(&a, &secret_hash("one")));
    assert!(!same_hash(&a, &secret_hash("two")));
    assert_eq!(unhex(&hex(&a)), Some(a));
    assert_eq!(unhex("zz"), None);
}

// ---- the webhook over HTTP -----------------------------------------------------------------------

/// Everything the hub logs while the test runs.
#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);

impl Write for Logs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Logs {
    type Writer = Logs;
    fn make_writer(&'a self) -> Logs {
        self.clone()
    }
}

fn full_hub(home: &std::path::Path) -> (Arc<crate::hub::api::Hub>, ProjectRef) {
    use crate::hub::api::{HubConfig, Listen};
    let hub = crate::hub::serve::build_on(
        HubDb::open_memory().unwrap(),
        HubConfig {
            home: home.to_path_buf(),
            listen: Listen::default(),
            url: None,
        },
        ManualClock::at(1_792_231_200_000),
    )
    .unwrap();
    let r = ProjectRef {
        machine_id: MachineId::new("lab-a").unwrap(),
        project_id: ProjectId::unchecked("p-a"),
    };
    hub.store
        .projects_upsert_many(
            &r.machine_id,
            &[ProjectSummary {
                machine_id: r.machine_id.clone(),
                project_id: r.project_id.clone(),
                title: "repo-a".into(),
                workspace_root: "/lab/repo-a".into(),
                threads: ThreadCounts::default(),
                last_activity_at: Timestamp::from("2026-10-17T10:00:00.000Z".to_owned()),
                repos: Vec::new(),
                kind: None,
                created_by: None,
                owner: None,
                archived_at: None,
                avatar: None,
                icon: None,
            }],
        )
        .unwrap();
    (hub, r)
}

#[tokio::test(flavor = "current_thread")]
async fn a_webhook_post_with_its_secret_runs_with_the_body_and_a_wrong_secret_is_refused_unlogged()
{
    let logs = Logs::default();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(logs.clone())
        .with_max_level(tracing::Level::TRACE)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let home = tempfile::tempdir().unwrap();
    let (hub, r) = full_hub(home.path());
    let (a, secret) = hub.automations.create(new(&r, None, true)).unwrap();
    let secret = secret.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let router = crate::hub::http::router(hub.clone(), Arc::new(crate::hub::api::registry()));
    tokio::spawn(async move { axum::serve(listener, router).await });
    let http = reqwest::Client::new();
    let post = |url: String, body: String| {
        let http = http.clone();
        async move { http.post(url).body(body).send().await.unwrap() }
    };

    // A wrong secret: refused, no run, no order, and neither it nor the body written anywhere.
    let wrong = "wrongsecret-ZQ9x7Lm2wrongsecret-ZQ9x7Lm2abc";
    let res = post(
        format!("{base}/hooks/{}/{wrong}", a.automation_id),
        "{\"leak\":\"body-7781\"}".into(),
    )
    .await;
    assert_eq!(res.status(), 404);
    let unknown = post(format!("{base}/hooks/au_nosuchthing/{secret}"), "{}".into()).await;
    assert_eq!(
        unknown.status(),
        404,
        "an unknown automation looks the same"
    );
    assert!(
        hub.automations
            .runs(a.automation_id.as_str(), 10)
            .unwrap()
            .is_empty()
    );
    let all = hub.events.page(0, None, None).unwrap().events;
    let stored = serde_json::to_string(&all).unwrap();
    assert!(!stored.contains(wrong) && !stored.contains("body-7781"));
    assert!(all.iter().all(|e| e.r#type != HubEventType::AutomationRun));

    // The right secret: a run with the body as its order's context.
    let body = "{\"alert\":\"disk 91% on db-2\"}";
    let res = post(webhook_url(&base, &a.automation_id, &secret), body.into()).await;
    assert_eq!(res.status(), 202);
    let answer: serde_json::Value = res.json().await.unwrap();
    assert_eq!(answer["state"], "running");
    let runs = hub.automations.runs(a.automation_id.as_str(), 10).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(
        (
            runs[0].trigger,
            runs[0].payload_bytes.as_ref().map(|n| n.get())
        ),
        (AutomationTrigger::Webhook, Some(body.len() as i64))
    );
    let w = runs[0].workstream_id.clone().unwrap();
    assert_eq!(answer["workstreamId"], w.as_str());
    let order = hub.leads.workstreams.get(&w).unwrap().unwrap();
    assert!(
        order.source.text.as_str().contains(body),
        "{}",
        order.source.text.as_str()
    );
    assert_eq!(order.state, WorkstreamState::Open);
    let (_, payload) = hub
        .automations
        .run_with_payload(a.automation_id.as_str(), runs[0].run_id.as_str())
        .unwrap()
        .unwrap();
    assert_eq!(payload.as_deref(), Some(body));

    // Over the cap: refused before a run.
    let big = post(
        webhook_url(&base, &a.automation_id, &secret),
        "x".repeat(WEBHOOK_BODY_MAX + 1),
    )
    .await;
    assert_eq!(big.status(), 413);

    // A rotated URL: the old secret stops working.
    let (_, rotated) = hub
        .automations
        .rotate(a.automation_id.as_str(), "human")
        .unwrap();
    let old = post(webhook_url(&base, &a.automation_id, &secret), "{}".into()).await;
    assert_eq!(old.status(), 404);
    let new = post(webhook_url(&base, &a.automation_id, &rotated), "{}".into()).await;
    assert_eq!(
        new.status(),
        200,
        "skipped: the first run's order is still open"
    );
    assert_eq!(
        hub.automations
            .runs(a.automation_id.as_str(), 10)
            .unwrap()
            .len(),
        2
    );
    settle().await;

    let logged = String::from_utf8_lossy(&logs.0.lock().unwrap()).into_owned();
    for secret_text in [
        wrong,
        secret.as_str(),
        rotated.as_str(),
        "body-7781",
        "disk 91%",
    ] {
        assert!(
            !logged.contains(secret_text),
            "{secret_text} was logged:\n{logged}"
        );
    }
    let row: String = hub
        .db
        .with(|c| Ok(c.query_row("SELECT data FROM automations", [], |r| r.get(0))?))
        .unwrap();
    assert!(!row.contains(&rotated), "only the secret's hash is kept");
}

// ---- the lead's tools ----------------------------------------------------------------------------

fn lead(r: &ProjectRef) -> LeadCaller {
    LeadCaller {
        project_ref: r.clone(),
        by: format!("lead:{}/{}", r.machine_id, r.project_id),
        agent: CallerAgent::Lead,
    }
}

async fn call(
    autos: &Automations,
    caller: &LeadCaller,
    tool: &str,
    args: serde_json::Value,
) -> Result<LeadCallResult, McpToolError> {
    use crate::cli::agent_mcp::{Role, call_of};
    let frame = call_of(Role::Lead, tool, args).unwrap();
    let call: LeadCall = serde_json::from_value(frame).unwrap();
    calls::answer(autos, caller, call).await
}

use fleetd_contracts::mcp::McpToolError;

#[tokio::test(flavor = "current_thread")]
async fn the_lead_makes_lists_edits_pauses_runs_and_deletes_its_projects_automations() {
    let h = lead_hub(true);
    let autos = over(&h);
    let me = lead(&h.project);
    let LeadCallResult::AutomationCreate(made) = call(
        &autos,
        &me,
        "automation_create",
        json!({ "name": "Weekly report", "prompt": "Write the weekly report of slow pages.",
                "schedule": { "cron": "0 9 * * 1", "tz": "Europe/Berlin" } }),
    )
    .await
    .unwrap() else {
        panic!("not a create result")
    };
    let a = made.automation;
    assert!(!a.webhook, "the lead never gets a webhook secret");
    assert_eq!(a.created_by, "lead:lab-a/p-a");
    // Monday 2026-10-19, 09:00 in Berlin.
    assert_eq!(
        a.next_run_at.as_ref().unwrap().as_str(),
        "2026-10-19T07:00:00.000Z"
    );
    let id = a.automation_id.to_string();

    let LeadCallResult::AutomationList(list) = call(&autos, &me, "automation_list", json!({}))
        .await
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(list.automations.len(), 1);

    let LeadCallResult::AutomationUpdate(edited) = call(
        &autos,
        &me,
        "automation_update",
        json!({ "automationId": id, "prompt": "Write the report; link each slow page.", "removeSchedule": true }),
    )
    .await
    .unwrap() else {
        panic!()
    };
    assert!(edited.automation.schedule.is_none() && edited.automation.next_run_at.is_none());
    assert_eq!(
        edited.automation.name.as_str(),
        "Weekly report",
        "fields left out stay"
    );

    let LeadCallResult::AutomationPause(paused) = call(
        &autos,
        &me,
        "automation_pause",
        json!({ "automationId": id, "paused": true }),
    )
    .await
    .unwrap() else {
        panic!()
    };
    assert!(paused.automation.paused);

    let LeadCallResult::AutomationRun(ran) =
        call(&autos, &me, "automation_run", json!({ "automationId": id }))
            .await
            .unwrap()
    else {
        panic!()
    };
    assert_eq!(ran.run.state, AutomationRunState::Running);
    assert_eq!(ran.run.by.as_deref(), Some("lead:lab-a/p-a"));
    let order = h
        .area
        .workstreams
        .get(ran.run.workstream_id.as_ref().unwrap())
        .unwrap()
        .unwrap();
    assert!(order.source.text.as_str().contains("link each slow page"));

    let LeadCallResult::AutomationRuns(runs) = call(
        &autos,
        &me,
        "automation_runs",
        json!({ "automationId": id, "runId": ran.run.run_id }),
    )
    .await
    .unwrap() else {
        panic!()
    };
    assert_eq!(runs.runs.len(), 1);
    assert!(runs.payload.is_none());

    // Another project's lead can't touch it.
    let other = lead(&ProjectRef {
        machine_id: h.project.machine_id.clone(),
        project_id: ProjectId::unchecked("p-b"),
    });
    let refused = call(
        &autos,
        &other,
        "automation_delete",
        json!({ "automationId": id }),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Forbidden);

    call(
        &autos,
        &me,
        "automation_delete",
        json!({ "automationId": id }),
    )
    .await
    .unwrap();
    assert!(autos.list(&h.project).unwrap().is_empty());
    assert!(autos.runs(&id, 10).unwrap().is_empty());
    let gone = call(&autos, &me, "automation_run", json!({ "automationId": id }))
        .await
        .unwrap_err();
    assert_eq!(gone.code, ErrorCode::NotFound);
}

#[test]
fn a_webhook_url_starts_with_the_url_init_kept_else_the_listen_address() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(crate::hub::serve::configured_url(home.path()), None);
    let setup = |url: &str| {
        std::fs::write(
            home.path().join("setup.json"),
            json!({ "listen": "0.0.0.0:4790", "url": url, "unitSuffix": "", "machines": {} })
                .to_string(),
        )
        .unwrap();
        crate::hub::serve::configured_url(home.path())
    };
    assert_eq!(setup("http://0.0.0.0:4790"), None);
    let url = setup("http://hub.example.com:4790").unwrap();
    let id = AutomationId::unchecked("au_k3Jd8sQp2xYz");
    assert_eq!(
        webhook_url(&url, &id, "s3cr3t"),
        "http://hub.example.com:4790/hooks/au_k3Jd8sQp2xYz/s3cr3t"
    );
    let fallback = crate::hub::api::HubConfig {
        home: home.path().to_path_buf(),
        listen: crate::hub::api::Listen::default(),
        url: None,
    };
    assert_eq!(
        webhook_url(&fallback.url(), &id, "s"),
        "http://127.0.0.1:4790/hooks/au_k3Jd8sQp2xYz/s"
    );
}

// ---- a removed project, a stop mid-run -----------------------------------------------------------

fn removed(h: &auto_start_tests::Hub) {
    h.area.ctx.store.project_remove(&h.project).unwrap();
    h.events
        .append(NewEvent {
            at: iso_ms(1_792_231_200_000).into(),
            r#type: HubEventType::ProjectRemoved,
            machine_id: Some(h.project.machine_id.clone()),
            project_id: Some(h.project.project_id.clone()),
            thread_id: None,
            summary: "repo-a was removed".into(),
            data: None,
            attention: None,
        })
        .unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn a_removed_projects_automations_go_their_schedule_stops_and_their_webhook_url_is_refused() {
    let h = lead_hub(true);
    let autos = over(&h);
    let (scheduled, _) = autos
        .create(new(&h.project, Some(schedule("30 * * * *", "UTC")), false))
        .unwrap();
    let (hooked, secret) = autos.create(new(&h.project, None, true)).unwrap();
    let secret = secret.unwrap();
    autos.start();
    settle().await;

    // Removed from the cache: the URL works no more at once, before the event is followed.
    h.area.ctx.store.project_remove(&h.project).unwrap();
    assert!(
        autos
            .webhook_target(hooked.automation_id.as_str(), &secret)
            .unwrap()
            .is_none()
    );
    removed(&h);
    settle().await;
    assert!(autos.list(&h.project).unwrap().is_empty());
    assert!(
        autos
            .get(scheduled.automation_id.as_str())
            .unwrap()
            .is_none()
    );

    // Its schedule's time passes: nothing runs, no order opens.
    h.clock.advance(Duration::from_secs(60 * MIN));
    settle().await;
    let orders = h
        .area
        .workstreams
        .list(&crate::hub::leads::records::WorkstreamFilter {
            project_ref: None,
            state: None,
            limit: 100,
        })
        .unwrap();
    assert!(orders.is_empty());
    assert!(h.launched_prompts().is_empty());
    let deleted = events_of(&h, HubEventType::AutomationChanged)
        .iter()
        .filter(|e| e.data.as_ref().unwrap()["change"] == "deleted with its project")
        .count();
    assert_eq!(deleted, 2);
    autos.stop();
}

#[tokio::test(flavor = "current_thread")]
async fn removed_while_the_hub_was_down_its_automations_go_at_start() {
    let h = lead_hub(true);
    let before = over(&h);
    let (a, _) = before
        .create(new(&h.project, Some(schedule("30 * * * *", "UTC")), false))
        .unwrap();
    h.area.ctx.store.project_remove(&h.project).unwrap();
    let autos = over(&h);
    autos.start();
    settle().await;
    assert!(autos.get(a.automation_id.as_str()).unwrap().is_none());
    autos.stop();
}

/// The run a hub stop left between recording it and opening its order, as the database then holds it.
fn left_starting(autos: &Automations, a: &Automation, payload: Option<&str>) -> AutomationRun {
    let run = AutomationRun {
        run_id: AutomationRunId::unchecked(random_id("ar_")),
        automation_id: a.automation_id.clone(),
        trigger: if payload.is_some() {
            AutomationTrigger::Webhook
        } else {
            AutomationTrigger::Manual
        },
        at: iso_ms(1_792_231_200_000).into(),
        state: AutomationRunState::Running,
        workstream_id: None,
        scheduled_at: None,
        late_min: None,
        payload_bytes: payload.map(|p| Count::unchecked(p.len() as i64)),
        why: None,
        by: None,
        ended_at: None,
    };
    autos
        .db
        .with(|c| {
            c.execute(
                "INSERT INTO automation_runs (run_id, automation_id, at_ms, state, workstream_id, payload, data)
                 VALUES (?, ?, ?, 'running', NULL, ?, ?)",
                params![
                    run.run_id.as_str(),
                    a.automation_id.as_str(),
                    1_792_231_200_000_i64,
                    payload,
                    serde_json::to_string(&run)?
                ],
            )?;
            Ok(())
        })
        .unwrap();
    run
}

#[tokio::test(flavor = "current_thread")]
async fn a_run_a_stop_left_without_its_order_opens_it_at_start_and_never_blocks_the_automation() {
    let h = lead_hub(true);
    let before = over(&h);
    let (a, _) = before.create(new(&h.project, None, true)).unwrap();
    let stuck = left_starting(&before, &a, Some("{\"alert\":\"disk 91% on db-2\"}"));

    // The next hub opens its order, with the body, and the lead gets it.
    let autos = over(&h);
    autos.start();
    settle().await;
    let runs = autos.runs(a.automation_id.as_str(), 10).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].run_id, stuck.run_id);
    assert_eq!(runs[0].state, AutomationRunState::Running);
    let w = runs[0].workstream_id.clone().unwrap();
    let order = h.area.workstreams.get(&w).unwrap().unwrap();
    assert!(order.source.text.as_str().contains("disk 91% on db-2"));
    assert!(
        h.launched_prompts()[0].contains("disk 91% on db-2"),
        "{:?}",
        h.launched_prompts()
    );

    // Its order closes: the automation runs again.
    h.area
        .workstreams
        .close(&h.project, &w, "fixed", "lead:lab-a/p-a")
        .await
        .unwrap();
    let next = autos
        .run(
            a.automation_id.as_str(),
            Start::Manual { by: "human".into() },
        )
        .await
        .unwrap();
    assert_eq!(next.state, AutomationRunState::Running);
    autos.stop();
}

#[tokio::test(flavor = "current_thread")]
async fn a_run_whose_order_opened_just_before_a_stop_finds_that_order_and_makes_no_second() {
    let h = lead_hub(true);
    let autos = over(&h);
    let (a, _) = autos.create(new(&h.project, None, false)).unwrap();
    let stuck = left_starting(&autos, &a, None);
    // The order was made under the run's id; the stop came before the run recorded it.
    let made = h
        .area
        .workstreams
        .intake(IntakeInput {
            project_ref: h.project.clone(),
            text: order_text(&a, &stuck, None),
            client_request_id: stuck.run_id.to_string(),
            channel: IntakeChannel::Automation,
            by: format!("automation:{}", a.automation_id),
        })
        .unwrap()
        .workstream_id;

    // Without a restart, the next trigger finds the stuck run, gives it its order, and skips for it: not "still
    // starting" forever, and no second order.
    let now = autos
        .run(
            a.automation_id.as_str(),
            Start::Manual { by: "human".into() },
        )
        .await
        .unwrap();
    assert_eq!(now.state, AutomationRunState::Skipped);
    assert!(now.why.unwrap().as_str().contains(made.as_str()));
    let recovered = autos.runs(a.automation_id.as_str(), 10).unwrap();
    assert_eq!(recovered[1].workstream_id.as_ref(), Some(&made));
    let orders = h
        .area
        .workstreams
        .list(&crate::hub::leads::records::WorkstreamFilter {
            project_ref: None,
            state: None,
            limit: 100,
        })
        .unwrap();
    assert_eq!(orders.len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn a_stuck_run_of_a_deleted_automation_fails_at_start() {
    let h = lead_hub(true);
    let before = over(&h);
    let (a, _) = before.create(new(&h.project, None, false)).unwrap();
    let stuck = left_starting(&before, &a, None);
    before
        .db
        .with(|c| {
            c.execute(
                "DELETE FROM automations WHERE automation_id = ?",
                [a.automation_id.as_str()],
            )?;
            Ok(())
        })
        .unwrap();
    let autos = over(&h);
    autos.start();
    settle().await;
    let (run, _) = autos
        .run_with_payload(a.automation_id.as_str(), stuck.run_id.as_str())
        .unwrap()
        .unwrap();
    assert_eq!(run.state, AutomationRunState::Failed);
    assert!(run.why.unwrap().as_str().contains("automation is gone"));
    autos.stop();
}
