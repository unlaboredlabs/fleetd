//! Supersede, scope precedence and dedupe.
use std::sync::Arc;

use fleetd_contracts::ids::ProjectRef;
use fleetd_contracts::ledger::{
    AskKind, AskState, DecisionKey, DecisionScope, DecisionSource, DecisionState, WorkstreamId,
};
use fleetd_contracts::prim::Text;

use super::*;
use crate::clock::{Clock, SystemClock};
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
        context: None,
        recommendation: Some(Text::new(format!("rec for {k}")).unwrap()),
        recommendation_why: None,
        options: None,
        steps: None,
        verify: None,
        sink: None,
        env_name: None,
        gated: None,
        permission: None,
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

// The question card: labelled options, held answers, skip and undo.

fn labelled(k: &str, project_ref: &ProjectRef) -> AskInput {
    let options: fleetd_contracts::ledger::AskOptions = serde_json::from_value(serde_json::json!([
        { "key": "image-only", "label": "Image only", "consequence": "The link shows a PNG of the card, nothing else." },
        { "key": "public-snapshot", "label": "Public frozen snapshot", "consequence": "Anyone with the link sees a copy that never updates." }
    ]))
    .unwrap();
    AskInput {
        text: Text::new("What should a shared link show?").unwrap(),
        context: Some(Text::new("Your console shares a usage card; the link is public.").unwrap()),
        options: Some(options),
        recommendation: Some(Text::new("public-snapshot").unwrap()),
        recommendation_why: Some(
            fleetd_contracts::prim::Line::new("Nobody needs a login to see it.").unwrap(),
        ),
        proceeded_on_rec: false,
        ..ask(k, project_ref)
    }
}

#[test]
fn a_lead_decide_ask_without_labels_is_refused_with_the_command_to_send() {
    let p1 = p("p1");
    assert!(lead_decide_rule(&labelled("share.link", &p1)).is_none());
    let bare = AskInput {
        options: Some(
            serde_json::from_value(serde_json::json!(["public-snapshot", "image-only"])).unwrap(),
        ),
        recommendation: Some(Text::new("public-snapshot").unwrap()),
        blocks: Text::new("Copy link button").unwrap(),
        ..ask("share.link", &p1)
    };
    let refused = lead_decide_rule(&bare).expect("refused");
    assert_eq!(refused.code, LedgerCode::Invalid);
    assert!(
        refused
            .message
            .contains("options \"public-snapshot\", \"image-only\" have no label"),
        "{}",
        refused.message
    );
    assert!(refused.message.contains("no --why"), "{}", refused.message);
    let fix = refused.fix.unwrap();
    assert!(fix.starts_with("Send it again as: fleetd ask --key share.link --class product --text 'What about share.link?'"), "{fix}");
    assert!(
        fix.contains("--option 'public-snapshot|<short label, e.g. Public snapshot>|<what happens if the human picks this>'"),
        "{fix}"
    );
    assert!(fix.contains("--rec public-snapshot --why '<one line: why you recommend it>' --blocks 'Copy link button'"), "{fix}");

    // A recommendation that is not an option, a long question, a single option.
    let stray = AskInput {
        recommendation: Some(Text::new("something else").unwrap()),
        ..labelled("share.link", &p1)
    };
    assert!(
        lead_decide_rule(&stray)
            .unwrap()
            .message
            .contains("not one of the option keys")
    );
    let long = AskInput {
        text: Text::new("x".repeat(161)).unwrap(),
        ..labelled("share.link", &p1)
    };
    let refused = lead_decide_rule(&long).unwrap();
    assert!(refused.message.contains("put the background in --context"));
    assert!(
        refused
            .fix
            .unwrap()
            .contains("--text '<the question in one short line>'")
    );
    let none = AskInput {
        options: None,
        ..labelled("share.link", &p1)
    };
    assert!(
        lead_decide_rule(&none)
            .unwrap()
            .message
            .contains("2 to 6 options")
    );
    // Do asks are not cards with choices.
    let todo = AskInput {
        kind: AskKind::Do,
        options: None,
        recommendation: None,
        ..ask("t.k", &p1)
    };
    assert!(lead_decide_rule(&todo).is_none());
}

/// Ask id, outcome, value, and whether a decision came with it.
type DeliveredAnswer = (String, AnswerOutcome, Option<String>, bool);

#[derive(Default)]
struct Delivered(std::sync::Mutex<Vec<DeliveredAnswer>>);

impl AnswerSink for Delivered {
    fn on_answered(&self, _project_ref: &ProjectRef, answers: Vec<Answer>) {
        let mut got = self.0.lock().unwrap();
        for a in answers {
            got.push((
                a.ask.ask_id.to_string(),
                a.outcome,
                a.value,
                a.decision.is_some(),
            ));
        }
    }
}

struct InboxKit {
    clock: Arc<crate::hub::store::test_clock::ManualClock>,
    asks: Asks,
    decisions: Decisions,
    inbox: Arc<Inbox>,
    events: Arc<EventLog>,
    delivered: Arc<Delivered>,
}

fn inbox_kit() -> InboxKit {
    let db = HubDb::open_memory().unwrap();
    let clock = crate::hub::store::test_clock::ManualClock::at(1_760_000_000_000);
    let dyn_clock: Arc<dyn Clock> = clock.clone();
    let events = Arc::new(EventLog::new(db.clone(), dyn_clock.clone()).unwrap());
    let inbox = Inbox::new(db.clone(), events.clone(), dyn_clock.clone());
    let delivered = Arc::new(Delivered::default());
    inbox.set_answer_sink(delivered.clone());
    InboxKit {
        clock,
        asks: Asks::new(db.clone(), events.clone(), dyn_clock.clone()),
        decisions: Decisions::new(db, events.clone(), dyn_clock),
        inbox,
        events,
        delivered,
    }
}

impl InboxKit {
    fn state(&self, id: &str) -> fleetd_contracts::ledger::Ask {
        self.asks.get(id).unwrap().unwrap()
    }
    fn decisions(&self) -> usize {
        self.decisions
            .list(&DecisionFilter::default())
            .unwrap()
            .len()
    }
}

#[tokio::test]
async fn a_decide_answer_is_held_for_the_undo_window_and_undo_leaves_no_trace() {
    let k = inbox_kit();
    let p1 = p("p1");
    k.asks
        .create(&labelled("share.link", &p1), "lead:lab-a/p1")
        .unwrap();
    k.asks
        .create(&labelled("share.scope", &p1), "lead:lab-a/p1")
        .unwrap();

    let out = k
        .inbox
        .reply(&ReplyInput::new("1 a 2: only for paying users"), &human())
        .unwrap();
    assert!(out.parsed, "{:?}", out.hint);
    assert_eq!(
        out.echo.as_deref(),
        Some("Logged: 1 → Image only (undo for 10 s), 2 → only for paying users (undo for 10 s)")
    );
    assert!(
        out.applied
            .iter()
            .all(|a| a.undo_until.is_some() && a.decision_id.is_none())
    );
    assert_eq!(out.applied[0].label.as_deref(), Some("Image only"));
    let held = k.state("A1");
    assert_eq!(held.state, AskState::Answered);
    assert_eq!(held.answer.as_ref().unwrap().value, "image-only");
    assert_eq!(
        held.answer.as_ref().unwrap().kind,
        Some(fleetd_contracts::ledger::AskAnswerKind::Option)
    );
    assert_eq!(
        k.state("A2").answer.unwrap().kind,
        Some(fleetd_contracts::ledger::AskAnswerKind::Text)
    );
    // Nothing downstream has seen it: no decision, no wake.
    assert_eq!(k.decisions(), 0);
    assert!(k.delivered.0.lock().unwrap().is_empty());
    assert_eq!(summaries(&k.events, "ask.answered").len(), 2);

    // Not due yet: delivering now does nothing.
    assert!(k.inbox.deliver_due().unwrap().is_empty());

    let reopened = k
        .inbox
        .undo(&fleetd_contracts::ledger::AskId::new("A1").unwrap(), None)
        .unwrap();
    assert_eq!(
        (reopened.state, reopened.answer.is_none()),
        (AskState::Open, true)
    );
    assert_eq!(summaries(&k.events, "ask.undone").len(), 1);
    // Its batch has an open item again, so a reply can answer it.
    assert!(
        k.inbox
            .reply(&ReplyInput::new("1 b"), &human())
            .unwrap()
            .parsed
    );

    k.clock.advance(std::time::Duration::from_millis(10_000));
    let done = k.inbox.deliver_due().unwrap();
    let ids: Vec<&str> = done.iter().map(|a| a.ask_id.as_str()).collect();
    assert_eq!(ids, ["A1", "A2"]);
    assert_eq!(k.decisions(), 2);
    let a1 = k.state("A1");
    assert!(a1.answer.as_ref().unwrap().delivered_at.is_some() && a1.decision_id.is_some());
    let decision = k
        .decisions
        .list(&DecisionFilter::default())
        .unwrap()
        .into_iter()
        .find(|d| d.key.as_str() == "share.link")
        .unwrap();
    assert_eq!(
        (decision.value.as_str(), decision.source),
        ("public-snapshot", DecisionSource::Human)
    );
    assert_eq!(
        *k.delivered.0.lock().unwrap(),
        vec![
            (
                "A1".to_string(),
                AnswerOutcome::Answered,
                Some("public-snapshot".to_string()),
                true
            ),
            (
                "A2".to_string(),
                AnswerOutcome::Answered,
                Some("only for paying users".to_string()),
                true
            ),
        ]
    );
    assert_eq!(summaries(&k.events, "ask.delivered").len(), 2);
    // Delivered once, and too late to undo.
    assert!(k.inbox.deliver_due().unwrap().is_empty());
    let late = k
        .inbox
        .undo(&fleetd_contracts::ledger::AskId::new("A1").unwrap(), None)
        .unwrap_err();
    assert!(
        late.message.contains("undo window for A1 has passed"),
        "{}",
        late.message
    );
}

#[tokio::test]
async fn skip_keeps_the_recommendation_and_records_no_decision() {
    let k = inbox_kit();
    let p1 = p("p1");
    k.asks
        .create(&labelled("share.link", &p1), "lead:lab-a/p1")
        .unwrap();
    let out = k.inbox.reply(&ReplyInput::new("1 skip"), &human()).unwrap();
    assert_eq!(
        out.echo.as_deref(),
        Some("Logged: 1 → skipped, the lead keeps Public frozen snapshot (undo for 10 s)")
    );
    assert_eq!(
        out.applied[0].outcome,
        fleetd_contracts::mcp::InboxReplyOutcome::Skipped
    );
    assert_eq!(k.state("A1").state, AskState::Defaulted);

    k.clock.advance(std::time::Duration::from_millis(10_000));
    k.inbox.deliver_due().unwrap();
    assert_eq!(k.decisions(), 0, "a skip is not a decision");
    assert_eq!(
        *k.delivered.0.lock().unwrap(),
        vec![(
            "A1".to_string(),
            AnswerOutcome::Skipped,
            Some("public-snapshot".to_string()),
            false
        )]
    );
    let answer = k.state("A1").answer.unwrap();
    assert_eq!(
        answer.display(&k.state("A1")),
        "Skipped for now (lead keeps: Public frozen snapshot)"
    );
}

#[tokio::test]
async fn answers_other_than_decide_are_not_held() {
    let k = inbox_kit();
    let p1 = p("p1");
    let todo = AskInput {
        kind: AskKind::Do,
        recommendation: None,
        steps: Some(
            serde_json::from_value(
                serde_json::json!([{ "text": "Create the token", "where": "browser" }]),
            )
            .unwrap(),
        ),
        ..ask("token.make", &p1)
    };
    k.asks.create(&todo, "lead:lab-a/p1").unwrap();
    let out = k.inbox.reply(&ReplyInput::new("1 done"), &human()).unwrap();
    assert!(out.applied[0].undo_until.is_none() && out.applied[0].decision_id.is_some());
    assert_eq!(k.delivered.0.lock().unwrap().len(), 1);
}
