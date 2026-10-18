//! Supersede, scope precedence and dedupe.
use std::sync::Arc;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{
    AskKind, AskState, DecisionKey, DecisionScope, DecisionSource, DecisionState, WorkstreamId,
};
use fleetd_contracts::prim::Text;

use super::*;
use crate::clock::SystemClock;
use crate::hub::store::{EventLog, HubDb};

struct Kit {
    decisions: Decisions,
    asks: Asks,
    events: Arc<EventLog>,
}

fn kit() -> Kit {
    let db = HubDb::open_memory().unwrap();
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let events = Arc::new(EventLog::new(db.clone(), clock.clone()).unwrap());
    Kit {
        decisions: Decisions::new(db.clone(), events.clone(), clock.clone()),
        asks: Asks::new(db, events.clone(), clock),
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
    }
}

fn lead() -> Actor {
    Actor {
        source: DecisionSource::Lead,
        by: "lead:lab-a/p1".into(),
    }
}

fn project(r: &ProjectRef) -> DecisionScope {
    DecisionScope::Project {
        project_ref: r.clone(),
    }
}

fn ask(k: &str, project_ref: &ProjectRef) -> AskInput {
    AskInput {
        project_ref: Some(project_ref.clone()),
        workstream_id: None,
        kind: AskKind::Decide,
        key: key(k),
        class: "product".into(),
        text: Text::new(format!("What about {k}?")).unwrap(),
        recommendation: Some(Text::new(format!("rec for {k}")).unwrap()),
        options: None,
        steps: None,
        verify: None,
        sink: None,
        env_name: None,
        gated: None,
        blocks: Text::new("nothing").unwrap(),
        proceeded_on_rec: true,
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

#[tokio::test]
async fn answers_a_decided_key_from_the_log_and_never_batches_it() {
    let k = kit();
    let (p1, p2) = (p("p1"), p("p2"));
    let hk = "api.health.path";
    k.decisions
        .record(
            RecordInput::new(key(hk), DecisionScope::Global, "/health"),
            &human(),
        )
        .unwrap();
    k.decisions
        .record(
            RecordInput::new(key(hk), project(&p1), "/healthz"),
            &human(),
        )
        .unwrap();
    let outcome = k
        .asks
        .create(
            &AskInput {
                workstream_id: Some(WorkstreamId::new("W1").unwrap()),
                ..ask(hk, &p1)
            },
            "lead:lab-a/p1",
        )
        .unwrap();
    assert_eq!(outcome.state, asks::OutcomeState::Auto);
    assert_eq!(
        outcome.decision.as_ref().map(|d| d.decision_id.as_str()),
        Some("D2")
    );
    assert_eq!(
        (outcome.ask.ask_id.as_str(), outcome.ask.state),
        ("A1", AskState::Auto)
    );
    assert_eq!(
        outcome.ask.decision_id.as_ref().map(|d| d.as_str()),
        Some("D2")
    );
    assert!(outcome.ask.batch_id.is_none());
    let auto: Vec<_> = k
        .events
        .page(0, None, None)
        .unwrap()
        .events
        .into_iter()
        .filter(|e| e.r#type.as_str() == "ask.auto")
        .collect();
    assert_eq!(auto.len(), 1);
    assert_eq!(
        auto[0].data,
        Some(serde_json::json!({ "askId": "A1", "key": hk, "decisionId": "D2" }))
    );
    assert!(k.asks.batches(None, None, None).unwrap().is_empty());
    // Another project falls back to the global decision; a key nobody decided is asked.
    assert_eq!(
        k.asks
            .create(&ask(hk, &p2), "lead:lab-a/p2")
            .unwrap()
            .decision
            .map(|d| d.decision_id.to_string()),
        Some("D1".into())
    );
    assert_eq!(
        k.asks
            .create(&ask("api.health.method", &p2), "lead:lab-a/p2")
            .unwrap()
            .state,
        asks::OutcomeState::Open
    );
}

#[tokio::test]
async fn attaches_a_repeat_key_to_the_open_ask_in_the_same_project_not_across_projects() {
    let k = kit();
    let (p1, p2) = (p("p1"), p("p2"));
    let hk = "api.health.path";
    let first = k.asks.create(&ask(hk, &p1), "lead:lab-a/p1").unwrap();
    let again = k
        .asks
        .create(
            &AskInput {
                text: Text::new("Which path again?").unwrap(),
                ..ask(hk, &p1)
            },
            "lead:lab-a/p1",
        )
        .unwrap();
    assert_eq!(
        (again.state, again.attached),
        (asks::OutcomeState::Open, Some(true))
    );
    assert_eq!(again.ask.ask_id, first.ask.ask_id);
    let other = k.asks.create(&ask(hk, &p2), "lead:lab-a/p2").unwrap();
    assert_eq!(other.ask.ask_id.as_str(), "A2");
    let items: Vec<(i64, String)> = k.asks.batches(None, None, None).unwrap()[0]
        .items
        .iter()
        .map(|i| (i.number.get(), i.ask_id.to_string()))
        .collect();
    assert_eq!(items, [(1, "A1".to_string()), (2, "A2".to_string())]);
    assert_eq!(summaries(&k.events, "ask.created").len(), 2);
}
