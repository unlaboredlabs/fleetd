//! The claim flow on a real in-memory database and event log, with a fake node and fake other areas.
use super::ports::{
    BoxFuture, ClaimWake, CommandRun, HumanAsk, HumanAskFiled, JudgeSpawn, PlaybookLimits, Ports,
    Refusal,
};
use super::render::claim_failed_lines;
use super::*;
use crate::clock::{Clock, SystemClock};
use crate::hub::estimates::Estimates;
use crate::hub::incidents::{IncidentFilter, Incidents};
use crate::hub::store::{EventLog, HubDb, WaitInput};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef};
use fleetd_contracts::ledger::{
    AskId, MetricValues, PlaybookRef, Workstream, WorkstreamId, WorkstreamState,
};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::model::ActionItem;
use fleetd_contracts::tasks::{Task, TaskId};
use fleetd_contracts::verification::{CheckOutcome, CheckResultRanBy, ClaimOutcome, IncidentClass};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const LEAD_BY: &str = "lead:lab-a/p1";

fn project() -> ProjectRef {
    serde_json::from_value(json!({ "machineId": "lab-a", "projectId": "p1" })).unwrap()
}

fn w1() -> WorkstreamId {
    WorkstreamId::unchecked("W1")
}

fn doc_check() -> Value {
    json!({ "type": "cmd", "machineId": "lab-a", "argv": ["test", "-f", "docs/x.md"], "expectExit": 0 })
}

/// A running workstream in lab-a/p1; `done_when` None is a draft without a brief.
fn workstream(id: &str, done_when: Option<Vec<Value>>) -> Workstream {
    let mut w = json!({
        "workstreamId": id,
        "projectRef": { "machineId": "lab-a", "projectId": "p1" },
        "title": "docs",
        "source": { "text": "write docs", "channel": "app", "by": "human", "at": "2026-10-17T10:00:00.000Z" },
        "state": "running",
        "createdAt": "2026-10-17T10:00:00.000Z",
        "updatedAt": "2026-10-17T10:00:00.000Z",
    });
    if let Some(done_when) = done_when {
        w["brief"] = json!({ "goal": "g", "why": "y", "pointers": [], "constraints": [], "tier": "S", "doneWhen": done_when });
    }
    serde_json::from_value(w).unwrap()
}

#[derive(Default)]
struct Fake {
    workstreams: Mutex<HashMap<WorkstreamId, Workstream>>,
    wakes: Mutex<Vec<ClaimWake>>,
    /// What the node answers every command: exit code and output tail.
    node: Arc<Mutex<(i64, String)>>,
    /// Each command run: machine, cwd and argv.
    commands: Arc<Mutex<Vec<Value>>>,
}

impl Ports for Fake {
    fn workstream(&self, id: &WorkstreamId) -> Option<Workstream> {
        self.workstreams.lock().unwrap().get(id).cloned()
    }
    fn put_workstream(&self, w: &Workstream) {
        self.workstreams
            .lock()
            .unwrap()
            .insert(w.workstream_id.clone(), w.clone());
    }
    fn wake(&self, _: &ProjectRef, wake: ClaimWake) {
        self.wakes.lock().unwrap().push(wake);
    }
    fn run_command(
        &self,
        machine: &MachineId,
        cwd: String,
        argv: Vec<String>,
    ) -> BoxFuture<'_, Result<CommandRun, String>> {
        self.commands
            .lock()
            .unwrap()
            .push(json!({ "machineId": machine, "cwd": cwd, "argv": argv }));
        let (code, tail) = self.node.lock().unwrap().clone();
        Box::pin(async move {
            Ok(CommandRun {
                exit_code: Some(code),
                output_tail: tail,
                timed_out: false,
            })
        })
    }
    fn workspace_root(&self, _: &ProjectRef) -> Option<String> {
        Some("/w/p1".into())
    }
    fn playbook_limits(&self, _: &PlaybookRef) -> Option<PlaybookLimits> {
        None
    }
    fn research_verdict<'a>(
        &'a self,
        _: &'a WorkstreamId,
        _: MetricValues,
    ) -> BoxFuture<'a, Result<String, Refusal>> {
        Box::pin(async { Err(super::ports::invalid("no research here", None)) })
    }
    fn task(&self, _: &TaskId) -> Option<Task> {
        None
    }
    fn tasks_of(&self, _: &ProjectRef, _: &WorkstreamId, _: usize) -> Vec<Task> {
        vec![]
    }
    fn spawn_judge(&self, _: JudgeSpawn) -> BoxFuture<'_, Result<Task, Refusal>> {
        Box::pin(async { Err(super::ports::invalid("no judges here", None)) })
    }
    fn file_human_ask(&self, _: HumanAsk) -> BoxFuture<'_, Result<HumanAskFiled, Refusal>> {
        Box::pin(async { panic!("no human is asked in these tests") })
    }
    fn ask_answer(&self, _: &AskId) -> Option<String> {
        None
    }
    fn thread_actions<'a>(
        &'a self,
        _: &'a ThreadRef,
        _: usize,
    ) -> BoxFuture<'a, Result<Vec<ActionItem>, String>> {
        Box::pin(async { Ok(vec![]) })
    }
}

struct Kit {
    claims: Arc<Claims>,
    ports: Arc<Fake>,
    events: Arc<EventLog>,
    incidents: Arc<Incidents>,
    /// What the fake node answers to every `cmd_check`: exit code and output tail.
    node: Arc<Mutex<(i64, String)>>,
    commands: Arc<Mutex<Vec<Value>>>,
}

fn kit(workstreams: Vec<Workstream>) -> Kit {
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let db = HubDb::open_memory().unwrap();
    let events = Arc::new(EventLog::new(db.clone(), clock.clone()).unwrap());
    let ports = Arc::new(Fake::default());
    for w in workstreams {
        ports.put_workstream(&w);
    }
    let dyn_ports: Arc<dyn Ports> = ports.clone();
    let incidents = Arc::new(Incidents::new(db.clone(), events.clone(), clock.clone()));
    let estimates = Arc::new(Estimates::new(
        db.clone(),
        dyn_ports.clone(),
        incidents.clone(),
        clock.clone(),
    ));
    let verdicts = Arc::new(JudgeVerdicts::default());
    let judges = Arc::new(Judges::new(dyn_ports.clone(), events.clone(), verdicts));
    let runner = Arc::new(CheckRunner::new(
        Arc::new(GitHub::new(Arc::new(GhCli))),
        judges,
        dyn_ports.clone(),
        events.clone(),
        clock.clone(),
    ));
    let claims = Arc::new(Claims::new(
        Arc::new(ClaimRecords::new(db.clone())),
        runner,
        dyn_ports,
        events.clone(),
        estimates,
        incidents.clone(),
        clock,
        INLINE_WAIT,
    ));
    Kit {
        claims,
        ports: ports.clone(),
        events,
        incidents,
        node: ports.node.clone(),
        commands: ports.commands.clone(),
    }
}

impl Kit {
    fn set_node(&self, code: i64, tail: &str) {
        *self.node.lock().unwrap() = (code, tail.into());
    }
    fn state(&self) -> WorkstreamState {
        self.ports.workstream(&w1()).unwrap().state
    }
    async fn events_of(&self, types: &[HubEventType]) -> Vec<(HubEventType, String, Value)> {
        let page = self
            .events
            .wait(WaitInput {
                cursor: Some(0),
                types: Some(types.to_vec()),
                machine_id: None,
                timeout_sec: 0,
            })
            .await
            .unwrap();
        page.events
            .into_iter()
            .map(|e| {
                (
                    e.r#type,
                    e.summary.as_str().to_owned(),
                    e.data.unwrap_or(Value::Null),
                )
            })
            .collect()
    }
}

#[tokio::test]
async fn fails_while_the_file_is_missing_then_passes_and_marks_the_workstream_done() {
    let k = kit(vec![workstream("W1", Some(vec![doc_check()]))]);
    k.set_node(1, "checked /w/p1\n");

    let failed = k.claims.claim_done(&w1(), LEAD_BY, None).await.unwrap();
    assert_eq!(
        (failed.claim_id.as_str(), failed.state),
        ("C1", WorkstreamState::Verifying)
    );
    let claim = failed.claim.as_ref().unwrap();
    assert_eq!(
        (claim.by.as_str(), claim.outcome),
        (LEAD_BY, ClaimOutcome::Fail)
    );
    let r = &claim.results[0];
    assert_eq!(
        (r.check_index.get(), r.result, r.exit_code, r.ran_by),
        (0, CheckOutcome::Fail, Some(1), CheckResultRanBy::Node)
    );
    assert!(
        failed.next.contains("done:0 did not pass"),
        "{}",
        failed.next
    );
    assert_eq!(k.state(), WorkstreamState::Verifying);
    assert_eq!(k.commands.lock().unwrap()[0]["cwd"], "/w/p1");
    let lifecycle = [
        HubEventType::WorkstreamState,
        HubEventType::ClaimFailed,
        HubEventType::ClaimPassed,
        HubEventType::WorkstreamDone,
    ];
    assert_eq!(
        k.events_of(&lifecycle).await,
        vec![
            (
                HubEventType::WorkstreamState,
                "W1 is verifying (C1)".into(),
                json!({ "workstreamId": "W1", "state": "verifying", "claimId": "C1" })
            ),
            (
                HubEventType::ClaimFailed,
                "C1 on W1 failed: 1 of 1 checks did not pass".into(),
                json!({ "claimId": "C1", "workstreamId": "W1", "failing": [0] })
            ),
        ]
    );
    let wakes = k.ports.wakes.lock().unwrap().clone();
    let [
        ClaimWake::Failed {
            claim_id,
            workstream_id,
            failures,
        },
    ] = wakes.as_slice()
    else {
        panic!("one claim_failed wake: {wakes:?}")
    };
    assert_eq!(
        claim_failed_lines(claim_id, workstream_id, failures),
        [
            "- Claim C1 on W1 failed; W1 stays verifying. Checks that did not pass:",
            "  done:0 (on lab-a: `test -f docs/x.md` exits 0): fail, exit 1",
            "    > `test -f docs/x.md` in /w/p1 exited 1 (expected 0)",
            "    > checked /w/p1",
            "  next: fix what failed (e.g. a task with --serves done:0), then `fleetd claim done --workstream W1` again.",
        ]
        .join("\n")
    );

    k.set_node(0, "");
    let passed = k.claims.claim_done(&w1(), LEAD_BY, None).await.unwrap();
    assert_eq!(
        (passed.claim_id.as_str(), passed.state),
        ("C2", WorkstreamState::Done)
    );
    let claim = passed.claim.as_ref().unwrap();
    assert_eq!(
        (
            claim.outcome,
            claim.results[0].result,
            claim.results[0].exit_code
        ),
        (ClaimOutcome::Pass, CheckOutcome::Pass, Some(0))
    );
    assert_eq!(k.state(), WorkstreamState::Done);
    let ends: Vec<_> = k
        .events_of(&[HubEventType::ClaimPassed, HubEventType::WorkstreamDone])
        .await
        .into_iter()
        .map(|e| e.0)
        .collect();
    assert_eq!(
        ends,
        [HubEventType::ClaimPassed, HubEventType::WorkstreamDone]
    );
    let listed: Vec<_> = k
        .claims
        .list(&ClaimFilter {
            workstream_id: Some(w1()),
            limit: 10,
            ..Default::default()
        })
        .unwrap()
        .into_iter()
        .map(|c| (c.claim_id.as_str().to_owned(), c.outcome))
        .collect();
    assert_eq!(
        listed,
        [
            ("C2".into(), ClaimOutcome::Pass),
            ("C1".into(), ClaimOutcome::Fail)
        ]
    );
    let again = k.claims.claim_done(&w1(), LEAD_BY, None).await.unwrap_err();
    assert_eq!(
        (again.code, again.message.as_str()),
        (ErrorCode::Invalid, "W1 is already done.")
    );
}

#[tokio::test]
async fn records_one_false_claim_incident_at_the_third_failed_claim() {
    let k = kit(vec![workstream("W1", Some(vec![doc_check()]))]);
    k.set_node(1, "");
    let incidents = || k.incidents.list(&IncidentFilter::default(), 10).unwrap();
    for _ in 0..2 {
        k.claims.claim_done(&w1(), LEAD_BY, None).await.unwrap();
    }
    assert!(incidents().is_empty());
    k.claims.claim_done(&w1(), LEAD_BY, None).await.unwrap();
    let recorded = incidents();
    assert_eq!(recorded.len(), 1);
    let i = &recorded[0];
    assert_eq!(
        (
            i.incident_id.as_str(),
            i.class,
            &i.project_ref,
            i.workstream_id.as_ref()
        ),
        ("I1", IncidentClass::FalseClaim, &project(), Some(&w1()))
    );
    let expected: Vec<String> =
        (1..=3).map(|n| format!("C{n} failed: done:0 fail (exit 1): `test -f docs/x.md` in /w/p1 exited 1 (expected 0)")).collect();
    assert_eq!(
        i.evidence
            .iter()
            .map(|l| l.as_str().to_owned())
            .collect::<Vec<_>>(),
        expected
    );
    k.claims.claim_done(&w1(), LEAD_BY, None).await.unwrap();
    assert_eq!(incidents().len(), 1);
    assert_eq!(k.state(), WorkstreamState::Verifying);
}

#[tokio::test]
async fn asks_no_one_once_an_automatic_check_failed() {
    let k = kit(vec![workstream(
        "W1",
        Some(vec![
            doc_check(),
            json!({ "type": "human", "question": "Does the page read well?" }),
        ]),
    )]);
    k.set_node(1, "");
    // The fake panics if a human ask is filed.
    let skipped = k.claims.claim_done(&w1(), LEAD_BY, None).await.unwrap();
    let r = &skipped.claim.unwrap().results[1];
    assert_eq!(
        (r.result, r.ran_by),
        (CheckOutcome::Error, CheckResultRanBy::Human)
    );
    assert_eq!(
        r.evidence.as_str(),
        "not run: a judge or the human is asked only once every earlier check passes"
    );
}

#[tokio::test]
async fn refuses_drafts_other_projects_and_unknown_workstreams() {
    let mut finish_all = workstream("W3", Some(vec![doc_check()]));
    finish_all.state = WorkstreamState::Idle;
    finish_all.playbook = Some(PlaybookRef::unchecked(format!(
        "finish-all@{}",
        "a".repeat(40)
    )));
    let k = kit(vec![
        workstream("W1", Some(vec![doc_check()])),
        workstream("W2", None),
        finish_all,
    ]);
    let draft = k
        .claims
        .claim_done(&WorkstreamId::unchecked("W2"), LEAD_BY, None)
        .await
        .unwrap_err();
    assert_eq!(
        (draft.code, draft.message.as_str()),
        (
            ErrorCode::Invalid,
            "W2 has no frozen brief, so it has no done-when checks to run."
        )
    );
    let other: ProjectRef =
        serde_json::from_value(json!({ "machineId": "lab-b", "projectId": "p9" })).unwrap();
    assert_eq!(
        k.claims
            .claim_done(&w1(), "lead:lab-b/p9", Some(&other))
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        k.claims
            .claim_done(&WorkstreamId::unchecked("W99"), LEAD_BY, None)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    let idle = k
        .claims
        .claim_done(&WorkstreamId::unchecked("W3"), LEAD_BY, None)
        .await
        .unwrap_err();
    assert_eq!(
        idle.message,
        "W3 is idle: finish-all: nothing left with a value source. A finish-all run ends idle, not done."
    );
    assert!(k.commands.lock().unwrap().is_empty());
}
