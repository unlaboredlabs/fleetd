//! Supersede and scope precedence.
use std::sync::Arc;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{
    DecisionKey, DecisionScope, DecisionSource, DecisionState, WorkstreamId,
};

use super::*;
use crate::clock::{Clock, SystemClock};
use crate::hub::store::{EventLog, HubDb};

struct Kit {
    decisions: Decisions,
    events: Arc<EventLog>,
}

fn kit() -> Kit {
    kit_on(Arc::new(SystemClock))
}

fn kit_on(clock: Arc<dyn Clock>) -> Kit {
    let db = HubDb::open_memory().unwrap();
    let events = Arc::new(EventLog::new(db.clone(), clock.clone()).unwrap());
    Kit {
        decisions: Decisions::new(db, events.clone(), clock),
        events,
    }
}

fn p(project: &str) -> ProjectRef {
    serde_json::from_value(serde_json::json!({ "machineId": "lab-a", "projectId": project }))
        .unwrap()
}

fn key(k: &str) -> DecisionKey {
    DecisionKey::new(k).unwrap()
}

fn human() -> Actor {
    Actor {
        source: DecisionSource::Human,
        by: "human:desk".into(),
        person: None,
    }
}

fn lead() -> Actor {
    Actor {
        source: DecisionSource::Lead,
        by: "lead:lab-a/p1".into(),
        person: None,
    }
}

fn project(r: &ProjectRef) -> DecisionScope {
    DecisionScope::Project {
        project_ref: r.clone(),
    }
}

fn summaries(events: &EventLog, kind: &str) -> Vec<String> {
    events
        .page(0, None, None)
        .unwrap()
        .events
        .into_iter()
        .filter(|e| e.r#type.as_str() == kind)
        .map(|e| e.summary.to_string())
        .collect()
}

#[tokio::test]
async fn supersedes_the_active_decision_on_the_same_key_and_scope_only() {
    let k = kit();
    let p1 = p("p1");
    let d1 = k
        .decisions
        .record(
            RecordInput::new(key("db.engine"), project(&p1), "sqlite"),
            &human(),
        )
        .unwrap();
    let g = k
        .decisions
        .record(
            RecordInput::new(key("db.engine"), DecisionScope::Global, "postgres"),
            &human(),
        )
        .unwrap();
    let d2 = k
        .decisions
        .record(
            RecordInput {
                why: Some("analytics".into()),
                ..RecordInput::new(key("db.engine"), project(&p1), "duckdb")
            },
            &lead(),
        )
        .unwrap();
    assert_eq!(d2.decision_id.as_str(), "D3");
    assert_eq!(d2.supersedes.as_ref().map(|d| d.as_str()), Some("D1"));
    assert_eq!(
        (d2.source, d2.by.as_deref(), d2.state),
        (
            DecisionSource::Lead,
            Some("lead:lab-a/p1"),
            DecisionState::Active
        )
    );
    assert_eq!(
        k.decisions.get(&d1.decision_id).unwrap().unwrap().state,
        DecisionState::Superseded
    );
    assert_eq!(
        k.decisions.get(&g.decision_id).unwrap().unwrap().state,
        DecisionState::Active
    );
    assert_eq!(
        summaries(&k.events, "decision.recorded"),
        [
            "D1 db.engine = sqlite",
            "D2 db.engine = postgres",
            "D3 db.engine = duckdb"
        ]
    );
}

#[tokio::test]
async fn resolves_workstream_then_project_then_global_skipping_other_projects_and_retired() {
    let k = kit();
    let (p1, p2) = (p("p1"), p("p2"));
    let w1 = WorkstreamId::new("W1").unwrap();
    let hk = "api.health.path";
    let chain = Chain {
        project_ref: p1.clone(),
        workstream_id: Some(w1.clone()),
    };
    let value = |chain: &Chain| {
        k.decisions
            .resolve(hk, chain)
            .unwrap()
            .map(|d| d.value.to_string())
    };
    assert_eq!(value(&chain), None);
    k.decisions
        .record(
            RecordInput::new(key(hk), DecisionScope::Global, "/health"),
            &human(),
        )
        .unwrap();
    assert_eq!(value(&chain).as_deref(), Some("/health"));
    k.decisions
        .record(RecordInput::new(key(hk), project(&p2), "/p2"), &human())
        .unwrap();
    assert_eq!(value(&chain).as_deref(), Some("/health"));
    let proj = k
        .decisions
        .record(
            RecordInput::new(key(hk), project(&p1), "/healthz"),
            &human(),
        )
        .unwrap();
    assert_eq!(value(&chain).as_deref(), Some("/healthz"));
    let ws = k
        .decisions
        .record(
            RecordInput {
                project_ref: Some(p1.clone()),
                ..RecordInput::new(
                    key(hk),
                    DecisionScope::Workstream { workstream_id: w1 },
                    "/ws",
                )
            },
            &lead(),
        )
        .unwrap();
    assert_eq!(value(&chain).as_deref(), Some("/ws"));
    assert_eq!(
        value(&Chain {
            project_ref: p1.clone(),
            workstream_id: None
        })
        .as_deref(),
        Some("/healthz")
    );
    k.decisions.retire(&ws.decision_id).unwrap();
    assert_eq!(
        k.decisions
            .resolve(hk, &chain)
            .unwrap()
            .unwrap()
            .decision_id,
        proj.decision_id
    );
    let again = k.decisions.retire(&ws.decision_id).unwrap_err();
    assert!(
        again.message.contains("already retired"),
        "{}",
        again.message
    );
    assert_eq!(
        k.decisions.retire("D99").unwrap_err().code,
        LedgerCode::NotFound
    );
}
