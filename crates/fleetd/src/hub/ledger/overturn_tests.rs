//! decisions_list and decisions_overturn, through the hub's tools: only a person overturns, and the lead reads it.
use std::sync::Arc;

use fleetd_contracts::auth::KeyKind;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::{LeadCall, LeadCallResult};
use fleetd_contracts::ledger::{Decision, IntakeChannel};
use fleetd_contracts::mcp::ErrorCode;
use serde_json::{Value, json};

use crate::hub::api::{CallError, Caller, Hub, HubConfig, Listen, registry};
use crate::hub::leads::records::NewWorkstream;
use crate::hub::link::LeadCaller;
use crate::hub::link::lead_calls::CallerAgent;
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;

const AT: &str = "2026-10-25T10:00:00.000Z";

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("shop"),
    }
}

fn hub() -> (Arc<Hub>, tempfile::TempDir) {
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
            &MachineId::unchecked("devbox"),
            &[serde_json::from_value(json!({
                "machineId": "devbox", "projectId": "shop", "title": "shop", "workspaceRoot": "/work/shop",
                "threads": { "running": 0, "waiting": 0, "idle": 0, "failed": 0 }, "lastActivityAt": AT,
            }))
            .unwrap()],
        )
        .unwrap();
    (hub, home)
}

fn key(kind: KeyKind, role: &str) -> Caller {
    let c = serde_json::from_value::<Caller>(json!({
        "keyId": "k1", "name": "desk", "prefix": "fld_abcdef", "createdAt": AT,
        "grants": [{ "role": role, "machines": "*" }],
    }))
    .unwrap();
    Caller {
        kind: Some(kind),
        ..c
    }
}

fn person() -> Caller {
    key(KeyKind::Human, "operate")
}

/// The lead's `fleetd decide`.
async fn decide(hub: &Hub, call: Value) -> Decision {
    let mut call = call;
    call["op"] = "decide".into();
    let call: LeadCall = serde_json::from_value(call).unwrap();
    let r = project();
    let caller = LeadCaller {
        project_ref: r.clone(),
        by: crate::hub::link::lead_calls::lead_by(&r),
        agent: CallerAgent::Lead,
    };
    match hub
        .lead_calls
        .handler("decide")
        .unwrap()
        .handle(caller, call)
        .await
    {
        Ok(LeadCallResult::Decide(out)) => out.decision,
        other => panic!("decide: {other:?}"),
    }
}

async fn call(
    hub: &Arc<Hub>,
    caller: &Caller,
    tool: &str,
    input: Value,
) -> Result<Value, CallError> {
    registry().call(hub, caller, tool, input).await
}

async fn list(hub: &Arc<Hub>) -> Value {
    call(
        hub,
        &person(),
        "decisions_list",
        json!({ "projectRef": project() }),
    )
    .await
    .unwrap()
}

fn refused(result: Result<Value, CallError>) -> ErrorCode {
    match result {
        Err(CallError::Tool(e)) => e.code,
        other => panic!("not refused: {other:?}"),
    }
}

#[tokio::test]
async fn only_a_person_with_operate_overturns_a_decision() {
    let (hub, _home) = hub();
    let d = decide(
        &hub,
        json!({ "key": "api.health.path", "value": "/healthz", "scope": "project" }),
    )
    .await;
    let revoke = json!({ "decisionId": d.decision_id, "why": "the probe moved" });

    // An agent's key never does, whatever its grant: agents and leads record decisions, a person overturns them.
    let agent = call(
        &hub,
        &key(KeyKind::Agent, "admin"),
        "decisions_overturn",
        revoke.clone(),
    )
    .await;
    assert_eq!(refused(agent), ErrorCode::Forbidden);
    let reader = call(
        &hub,
        &key(KeyKind::Human, "read"),
        "decisions_overturn",
        revoke.clone(),
    )
    .await;
    assert_eq!(refused(reader), ErrorCode::Forbidden);
    let missing = call(
        &hub,
        &person(),
        "decisions_overturn",
        json!({ "decisionId": "D99", "why": "x" }),
    )
    .await;
    assert_eq!(refused(missing), ErrorCode::NotFound);

    let listed = list(&hub).await;
    assert_eq!(listed["decisions"][0]["state"], "active", "{listed}");
    assert!(
        hub.leads.wakes.held(&project()).is_empty(),
        "nothing for the lead"
    );
}

#[tokio::test]
async fn a_revoke_records_who_and_why_and_the_lead_reads_it_at_its_next_wake() {
    let (hub, _home) = hub();
    let d = decide(
        &hub,
        json!({ "key": "api.health.path", "value": "/healthz", "scope": "project" }),
    )
    .await;
    let digest = hub.leads.wakes.digest(&project()).await.unwrap();
    assert!(digest.contains("api.health.path = /healthz"), "{digest}");

    let out = call(
        &hub,
        &person(),
        "decisions_overturn",
        json!({ "decisionId": d.decision_id, "why": "the load balancer probes /livez" }),
    )
    .await
    .unwrap();
    assert_eq!(out["overturned"]["state"], "retired", "{out}");
    assert_eq!(out["overturned"]["retired"]["by"], "human:desk");
    assert_eq!(
        out["overturned"]["retired"]["why"],
        "the load balancer probes /livez"
    );
    assert!(out.get("decision").is_none(), "{out}");

    // Its next wake: the line saying so, and a state that no longer lists it.
    let held = hub.leads.wakes.held(&project());
    assert_eq!(
        held,
        vec![format!(
            "- the human revoked {} api.health.path (was \"/healthz\"): \"the load balancer probes /livez\"; it is open again, so ask before deciding it",
            d.decision_id
        )]
    );
    assert!(
        !hub.leads.wakes.pending(&project()),
        "a revoke alone never wakes the lead"
    );
    let digest = hub.leads.wakes.digest(&project()).await.unwrap();
    assert!(!digest.contains("/healthz"), "{digest}");

    let listed = list(&hub).await;
    assert_eq!(listed["decisions"][0]["state"], "retired", "{listed}");
    let retired = hub.events.page(0, None, None).unwrap().events;
    assert!(
        retired
            .iter()
            .any(|e| e.r#type.as_str() == "decision.retired")
    );

    let again = call(
        &hub,
        &person(),
        "decisions_overturn",
        json!({ "decisionId": d.decision_id, "why": "again" }),
    )
    .await;
    assert_eq!(refused(again), ErrorCode::Invalid);
}

#[tokio::test]
async fn a_new_value_supersedes_it_as_the_person_s_and_the_list_keeps_both() {
    let (hub, _home) = hub();
    let (w, _) = hub
        .leads
        .records
        .workstream_create(NewWorkstream {
            project_ref: project(),
            title: "Checkout v2".into(),
            text: "rebuild checkout".into(),
            channel: IntakeChannel::App,
            by: "human".into(),
            at: AT.into(),
            client_request_id: None,
        })
        .unwrap();
    let d = decide(
        &hub,
        json!({ "key": "payments.provider", "value": "stripe", "why": "already integrated", "workstreamId": w.workstream_id }),
    )
    .await;

    let out = call(
        &hub,
        &person(),
        "decisions_overturn",
        json!({ "decisionId": d.decision_id, "value": "adyen", "why": "the contract is signed" }),
    )
    .await
    .unwrap();
    let new = &out["decision"];
    assert_eq!(new["value"], "adyen", "{out}");
    assert_eq!(new["source"], "human");
    assert_eq!(new["by"], "human:desk");
    assert_eq!(new["why"], "the contract is signed");
    assert_eq!(new["supersedes"], json!(d.decision_id));
    assert_eq!(
        new["scope"],
        json!({ "kind": "workstream", "workstreamId": w.workstream_id })
    );
    assert_eq!(out["overturned"]["state"], "superseded");

    let listed = list(&hub).await;
    let states: Vec<&Value> = listed["decisions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| &d["state"])
        .collect();
    assert_eq!(states, [&json!("active"), &json!("superseded")], "{listed}");
    assert_eq!(
        listed["orders"],
        json!([{ "workstreamId": w.workstream_id, "title": "Checkout v2" }])
    );

    let held = hub.leads.wakes.held(&project());
    assert_eq!(held.len(), 1, "{held:?}");
    assert!(
        held[0].starts_with(&format!(
            "- the human replaced {} payments.provider \"stripe\" with ",
            d.decision_id
        )),
        "{held:?}"
    );
    let digest = hub.leads.wakes.digest(&project()).await.unwrap();
    assert!(digest.contains("payments.provider = adyen"), "{digest}");
    assert!(!digest.contains("= stripe"), "{digest}");
}

#[tokio::test]
async fn the_list_is_the_project_s_and_needs_read_on_its_machine() {
    let (hub, _home) = hub();
    decide(
        &hub,
        json!({ "key": "api.health.path", "value": "/healthz", "scope": "project" }),
    )
    .await;
    let elsewhere = serde_json::from_value::<Caller>(json!({
        "keyId": "k2", "name": "laptop", "prefix": "fld_abcdeg", "createdAt": AT,
        "grants": [{ "role": "read", "machines": ["laptop"] }],
    }))
    .unwrap();
    let refusal = call(
        &hub,
        &elsewhere,
        "decisions_list",
        json!({ "projectRef": project() }),
    )
    .await;
    assert_eq!(refused(refusal), ErrorCode::Forbidden);
    let unknown = call(
        &hub,
        &person(),
        "decisions_list",
        json!({ "projectRef": { "machineId": "devbox", "projectId": "nope" } }),
    )
    .await;
    assert_eq!(refused(unknown), ErrorCode::NotFound);
    let reader = call(
        &hub,
        &key(KeyKind::Agent, "read"),
        "decisions_list",
        json!({ "projectRef": project() }),
    )
    .await
    .unwrap();
    assert_eq!(reader["decisions"].as_array().unwrap().len(), 1);
}
