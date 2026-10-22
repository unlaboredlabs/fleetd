//! A hub-wide playbook gate change settles only on a person's say. One that relaxes a gate waits on a person's approve
//! of its request in the chat; one that only tightens takes the lead's decision once the human wrote in that project's
//! chat after the change was proposed. A person's global decision settles either.
use std::sync::Arc;

use fleetd_contracts::chat::ChatAuthor;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef};
use fleetd_contracts::lead_calls::LeadCall;
use fleetd_contracts::ledger::{DecisionScope, DecisionSource};
use serde_json::json;

use super::service::gate_key;
use super::types::{RetroMetric, RetroProposal};
use crate::hub::api::{Hub, HubConfig, Listen};
use crate::hub::chat::NewMessage;
use crate::hub::ledger::{Actor, RecordInput};
use crate::hub::store::HubDb;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::usage::time::iso;

const T: i64 = 1_792_000_000_000;

fn project() -> ProjectRef {
    ProjectRef {
        machine_id: MachineId::unchecked("devbox"),
        project_id: ProjectId::unchecked("app"),
    }
}

const RELAX: &str = "@@ -9,1 +9,1 @@\n-  M: { reviewers: 1, verifier: false, planFirst: false }\n+  M: { reviewers: 0, verifier: false, planFirst: false }\n";
const TIGHTEN: &str = "@@ -9,1 +9,1 @@\n-  M: { reviewers: 1, verifier: false, planFirst: false }\n+  M: { reviewers: 2, verifier: false, planFirst: false }\n";

/// A hub with one pending gate change to the bugfix playbook, proposed a minute ago; returns its decision key. A
/// relaxing one has its approval open in the project's chat, as the retro opens it.
async fn hub(diff: &str, relaxes: bool) -> (Arc<Hub>, tempfile::TempDir, String) {
    hub_on(diff, relaxes, HubDb::open_memory().unwrap()).await
}

async fn hub_on(
    diff: &str,
    relaxes: bool,
    db: Arc<HubDb>,
) -> (Arc<Hub>, tempfile::TempDir, String) {
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
        retro_model: None,
    };
    let hub = crate::hub::serve::build_on(db, config, ManualClock::at(T as u64)).unwrap();
    // The retro reads playbooks and decisions through the ops ports, which `start_loops` binds on a serving hub.
    hub.ops.bind(&hub);
    let mut proposal = RetroProposal {
        proposal_id: "R1".into(),
        run: 1,
        at: iso(T - 60_000),
        playbook: "bugfix".into(),
        kind: "gate".into(),
        claimed_kind: "gate".into(),
        diff: diff.into(),
        fields: vec!["reviewRules".into()],
        fixes_incidents: vec![],
        metric: RetroMetric {
            class: "false_claim".into(),
            op: "decrease".into(),
            window_days: 7,
        },
        expected: "fewer false claims".into(),
        state: "pending".into(),
        reference: None,
        previous_ref: None,
        applied_at: None,
        due_at: None,
        baseline: None,
        measured: None,
        note: None,
        relaxes: Some(relaxes),
        request_id: None,
    };
    if relaxes {
        let change = serde_json::from_value(json!({ "proposalId": "R1", "playbook": "bugfix",
            "summary": "Bugfixes, medium-size work: reviewers 1 → 0", "diff": diff }))
        .unwrap();
        let r = crate::hub::usage::ports::ProjectRef {
            machine_id: "devbox".into(),
            project_id: "app".into(),
        };
        let request = hub.approvals.playbook_change(&r, change).await.unwrap();
        proposal.request_id = Some(request.request_id.to_string());
    }
    let key = gate_key(&proposal);
    hub.db
        .with(|c| {
            c.execute(
                "INSERT INTO retro_proposals (run_n, playbook, state, machines, data) VALUES (1, 'bugfix', 'pending', '[]', ?1)",
                [serde_json::to_string(&proposal).unwrap()],
            )?;
            Ok(())
        })
        .unwrap();
    (hub, home, key)
}

fn lead_decides(hub: &Hub, key: &str) -> Result<(), crate::hub::ledger::LedgerError> {
    let call = serde_json::from_value(json!({ "key": key, "value": "apply", "scope": "project" }))
        .unwrap();
    crate::hub::ledger::lead_call(hub, &project(), "lead:devbox/app", LeadCall::Decide(call))
        .map(|_| ())
}

fn human_says(hub: &Hub, text: &str, at: i64) {
    hub.chat
        .add(
            &project(),
            NewMessage {
                author: Some(ChatAuthor::Human),
                text: text.into(),
                created_ms: Some(at),
                ..Default::default()
            },
        )
        .unwrap();
}

async fn answer(hub: &Hub, approve: bool) {
    let anywhere = |_: &str| true;
    let person = crate::hub::approvals::Caller {
        human: true,
        name: "desk",
        allows_operate: &anywhere,
    };
    hub.approvals
        .answer(&person, "Q1", approve, None)
        .await
        .unwrap();
}

fn state(hub: &Hub) -> String {
    hub.retro.proposals(None, 5)[0].proposal.state.clone()
}

#[tokio::test]
async fn a_relaxing_change_logged_by_a_lead_is_refused() {
    let (hub, _home, key) = hub(RELAX, true).await;
    human_says(&hub, "1 go", T);
    let refused = lead_decides(&hub, &key).unwrap_err();
    assert_eq!(
        refused.message,
        "R1 relaxes a gate, so only a person can apply it: they approve or deny Q1 in the chat."
    );
    hub.retro.settle_gates().await;
    assert_eq!(state(&hub), "pending");
}

#[tokio::test]
async fn a_relaxing_change_applies_on_a_persons_approve() {
    let (hub, _home, _) = hub(RELAX, true).await;
    let item = serde_json::to_value(crate::hub::approvals::chat_item(
        &hub.approvals.get("Q1").unwrap(),
    ))
    .unwrap();
    assert_eq!(
        item["playbook"]["summary"],
        "Bugfixes, medium-size work: reviewers 1 → 0"
    );
    answer(&hub, true).await;
    // The answer only records the approve; settling is the retro's, off the answer's path.
    hub.retro.on_gate_answered().await;
    assert_eq!(state(&hub), "applied");
}

#[tokio::test]
async fn a_relaxing_change_never_applies_on_a_deny() {
    let (hub, _home, _) = hub(RELAX, true).await;
    answer(&hub, false).await;
    hub.retro.on_gate_answered().await;
    assert_eq!(state(&hub), "rejected");
}

#[tokio::test]
async fn a_tightening_change_applies_once_the_human_replied_in_chat() {
    let (hub, _home, key) = hub(TIGHTEN, false).await;
    human_says(&hub, "1 go", T);
    lead_decides(&hub, &key).unwrap();
    hub.retro.settle_gates().await;
    assert_eq!(state(&hub), "applied");
}

#[tokio::test]
async fn a_tightening_change_without_a_human_reply_is_refused() {
    let (hub, _home, key) = hub(TIGHTEN, false).await;
    // A human message from before the proposal is not an answer to it.
    human_says(&hub, "fix the flaky test", T - 120_000);
    let refused = lead_decides(&hub, &key).unwrap_err();
    assert_eq!(
        refused.message,
        format!("The human has not answered {key} in this project's chat yet.")
    );
    assert!(refused.fix.unwrap().starts_with("Ask in chat first"));
    hub.retro.settle_gates().await;
    assert_eq!(state(&hub), "pending");
}

#[tokio::test]
async fn a_persons_global_decision_applies_either_kind() {
    for (diff, relaxes) in [(RELAX, true), (TIGHTEN, false)] {
        let (hub, _home, key) = hub(diff, relaxes).await;
        hub.decisions
            .record(
                RecordInput::new(
                    serde_json::from_value(json!(key)).unwrap(),
                    DecisionScope::Global,
                    "apply",
                ),
                &Actor {
                    source: DecisionSource::Human,
                    by: "human:desk".into(),
                },
            )
            .unwrap();
        hub.retro.settle_gates().await;
        assert_eq!(state(&hub), "applied", "relaxes: {relaxes}");
    }
}

/// A retro run holds its lock for a whole claude turn: the person's answer is stored at once all the same, and the
/// change applies once the lock is free.
#[tokio::test]
async fn an_answer_never_waits_on_a_running_retro() {
    let (hub, _home, _) = hub(RELAX, true).await;
    let running = hub.retro.lock.lock().await;
    // Not awaited on the lock: if the answer waited for it, this would never return.
    answer(&hub, true).await;
    assert_eq!(
        hub.approvals.get("Q1").unwrap().state,
        fleetd_contracts::ledger::RequestState::Approved
    );
    assert_eq!(state(&hub), "pending", "applied only once the run is done");
    drop(running);
    hub.retro.on_gate_answered().await;
    assert_eq!(state(&hub), "applied");
}

/// The person approved, then the hub stopped before the change applied: the restarted hub applies it when its retro
/// starts, not at the next weekly run.
#[tokio::test]
async fn an_approved_change_applies_when_the_restarted_hub_starts() {
    let dir = tempfile::tempdir().unwrap();
    {
        let (hub, _home, _) = hub_on(RELAX, true, HubDb::open(dir.path()).unwrap()).await;
        // The approve is stored; the hub stops before its settle runs.
        crate::hub::approvals::store::Requests::new(hub.db.clone())
            .update_from(
                &fleetd_contracts::chat::ChatRequestId::unchecked("Q1"),
                fleetd_contracts::ledger::RequestState::Open,
                |r| r.state = fleetd_contracts::ledger::RequestState::Approved,
            )
            .unwrap();
        assert_eq!(state(&hub), "pending");
    }
    let home = tempfile::tempdir().unwrap();
    let config = HubConfig {
        home: home.path().to_path_buf(),
        listen: Listen::default(),
        url: None,
        queue_ttl_sec: None,
        retro_model: None,
    };
    let restarted = crate::hub::serve::build_on(
        HubDb::open(dir.path()).unwrap(),
        config,
        ManualClock::at(T as u64),
    )
    .unwrap();
    restarted.ops.bind(&restarted);
    restarted.retro.settle_on_start().await;
    assert_eq!(state(&restarted), "applied");
}
