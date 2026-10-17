//! The claim flow on a real in-memory database and event log, with a fake node and fake other areas.
//! TS spec: apps/hub/src/checks/Claims.test.ts.
use super::ports::{BoxFuture, ClaimWake, HumanAsk, HumanAskFiled, JudgeSpawn, PlaybookLimits, Ports, Refusal};
use super::render::claim_failed_lines;
use super::*;
use crate::clock::{Clock, SystemClock};
use crate::hub::estimates::Estimates;
use crate::hub::incidents::{IncidentFilter, Incidents};
use crate::hub::store::{EventLog, HubDb, WaitInput};
use fleetd_contracts::{
    ActionItem, AskId, Brief, CheckOutcome, CheckSpec, ClaimOutcome, HubEventType, IncidentClass, MachineId, MetricValues,
    PlaybookRef, ProjectId, ProjectRef, RanBy, Task, TaskId, ThreadRef, Tier, Workstream, WorkstreamId, WorkstreamState,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const LEAD_BY: &str = "lead:lab-a/p1";

fn project() -> ProjectRef {
    ProjectRef { machine_id: MachineId("lab-a".into()), project_id: ProjectId("p1".into()) }
}

fn w1() -> WorkstreamId {
    WorkstreamId("W1".into())
}

fn doc_check() -> CheckSpec {
    CheckSpec::Cmd { machine_id: MachineId("lab-a".into()), argv: vec!["test".into(), "-f".into(), "docs/x.md".into()], expect_exit: 0 }
}

fn workstream(id: &str, done_when: Option<Vec<CheckSpec>>) -> Workstream {
    Workstream {
        workstream_id: WorkstreamId(id.into()),
        project_ref: project(),
        title: "docs".into(),
        brief: done_when.map(|done_when| Brief {
            goal: "g".into(),
            why: "y".into(),
            pointers: vec![],
            constraints: vec![],
            done_when,
            tier: Tier::S,
            estimate: None,
            baseline: None,
            metric: None,
        }),
        state: WorkstreamState::Running,
        estimate_actual: None,
        playbook: None,
        created_at: "2026-10-17T10:00:00.000Z".into(),
        updated_at: "2026-10-17T10:00:00.000Z".into(),
    }
}

#[derive(Default)]
struct Fake {
    workstreams: Mutex<HashMap<WorkstreamId, Workstream>>,
    wakes: Mutex<Vec<ClaimWake>>,
}

impl Ports for Fake {
    fn workstream(&self, id: &WorkstreamId) -> Option<Workstream> {
        self.workstreams.lock().unwrap().get(id).cloned()
    }
    fn put_workstream(&self, w: &Workstream) {
        self.workstreams.lock().unwrap().insert(w.workstream_id.clone(), w.clone());
    }
    fn wake(&self, _: &ProjectRef, wake: ClaimWake) {
        self.wakes.lock().unwrap().push(wake);
    }
    fn workspace_root(&self, _: &ProjectRef) -> Option<String> {
        Some("/w/p1".into())
    }
    fn playbook_limits(&self, _: &PlaybookRef) -> Option<PlaybookLimits> {
        None
    }
    fn research_verdict<'a>(&'a self, _: &'a WorkstreamId, _: MetricValues) -> BoxFuture<'a, Result<String, Refusal>> {
        Box::pin(async { Err(Refusal::invalid("no research here", None)) })
    }
    fn task(&self, _: &TaskId) -> Option<Task> {
        None
    }
    fn tasks_of(&self, _: &ProjectRef, _: &WorkstreamId, _: usize) -> Vec<Task> {
        vec![]
    }
    fn spawn_judge(&self, _: JudgeSpawn) -> BoxFuture<'_, Result<Task, Refusal>> {
        Box::pin(async { Err(Refusal::invalid("no judges here", None)) })
    }
    fn file_human_ask(&self, _: HumanAsk) -> BoxFuture<'_, Result<HumanAskFiled, Refusal>> {
        Box::pin(async { panic!("no human is asked in these tests") })
    }
    fn ask_answer(&self, _: &AskId) -> Option<String> {
        None
    }
    fn thread_actions<'a>(&'a self, _: &'a ThreadRef, _: usize) -> BoxFuture<'a, Result<Vec<ActionItem>, String>> {
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
    _link: LinkGuard,
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
    let estimates = Arc::new(Estimates::new(db.clone(), dyn_ports.clone(), incidents.clone(), clock.clone()));
    let commands = NodeCommands::new();
    let node = Arc::new(Mutex::new((0, String::new())));
    let sent = Arc::new(Mutex::new(Vec::new()));
    let link = {
        let (weak, node, sent) = (Arc::downgrade(&commands), node.clone(), sent.clone());
        commands.attach(
            MachineId("lab-a".into()),
            Arc::new(move |frame: Value| {
                sent.lock().unwrap().push(frame.clone());
                let (code, tail) = node.lock().unwrap().clone();
                let reply = json!({ "t": "cmd_result", "id": frame["id"], "exitCode": code, "outputTail": tail, "timedOut": false });
                weak.upgrade().unwrap().resolve(&MachineId("lab-a".into()), &reply);
                true
            }),
        )
    };
    let verdicts = Arc::new(JudgeVerdicts::default());
    let judges = Arc::new(Judges::new(dyn_ports.clone(), events.clone(), verdicts));
    let runner = Arc::new(CheckRunner::new(commands, Arc::new(GitHub::new(Arc::new(GhCli))), judges, dyn_ports.clone(), events.clone(), clock.clone()));
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
    Kit { claims, ports, events, incidents, node, commands: sent, _link: link }
}

impl Kit {
    fn set_node(&self, code: i64, tail: &str) {
        *self.node.lock().unwrap() = (code, tail.into());
    }
    fn state(&self) -> WorkstreamState {
        self.ports.workstream(&w1()).unwrap().state
    }
    async fn events_of(&self, types: &[HubEventType]) -> Vec<(HubEventType, String, Value)> {
        let page = self.events.wait(WaitInput { cursor: Some(0), types: Some(types.to_vec()), machine_id: None, timeout_sec: 0 }).await.unwrap();
        page.events.into_iter().map(|e| (e.r#type, e.summary, e.data.unwrap_or(Value::Null))).collect()
    }
}

#[tokio::test]
async fn fails_while_the_file_is_missing_then_passes_and_marks_the_workstream_done() {
    let k = kit(vec![workstream("W1", Some(vec![doc_check()]))]);
    k.set_node(1, "checked /w/p1\n");

    let failed = k.claims.claim_done(&w1(), LEAD_BY, None).await.unwrap();
    assert_eq!((failed.claim_id.as_str(), failed.state), ("C1", WorkstreamState::Verifying));
    let claim = failed.claim.as_ref().unwrap();
    assert_eq!((claim.by.as_str(), claim.outcome), (LEAD_BY, ClaimOutcome::Fail));
    let r = &claim.results[0];
    assert_eq!((r.check_index, r.result, r.exit_code, r.ran_by), (0, CheckOutcome::Fail, Some(1), RanBy::Node));
    assert!(failed.next.contains("done:0 did not pass"), "{}", failed.next);
    assert_eq!(k.state(), WorkstreamState::Verifying);
    assert_eq!(k.commands.lock().unwrap()[0]["cwd"], "/w/p1");
    let lifecycle = [HubEventType::WorkstreamState, HubEventType::ClaimFailed, HubEventType::ClaimPassed, HubEventType::WorkstreamDone];
    assert_eq!(
        k.events_of(&lifecycle).await,
        vec![
            (HubEventType::WorkstreamState, "W1 is verifying (C1)".into(), json!({ "workstreamId": "W1", "state": "verifying", "claimId": "C1" })),
            (
                HubEventType::ClaimFailed,
                "C1 on W1 failed: 1 of 1 checks did not pass".into(),
                json!({ "claimId": "C1", "workstreamId": "W1", "failing": [0] })
            ),
        ]
    );
    let wakes = k.ports.wakes.lock().unwrap().clone();
    let [ClaimWake::Failed { claim_id, workstream_id, failures }] = wakes.as_slice() else { panic!("one claim_failed wake: {wakes:?}") };
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
    assert_eq!((passed.claim_id.as_str(), passed.state), ("C2", WorkstreamState::Done));
    let claim = passed.claim.as_ref().unwrap();
    assert_eq!((claim.outcome, claim.results[0].result, claim.results[0].exit_code), (ClaimOutcome::Pass, CheckOutcome::Pass, Some(0)));
    assert_eq!(k.state(), WorkstreamState::Done);
    let ends: Vec<_> = k.events_of(&[HubEventType::ClaimPassed, HubEventType::WorkstreamDone]).await.into_iter().map(|e| e.0).collect();
    assert_eq!(ends, [HubEventType::ClaimPassed, HubEventType::WorkstreamDone]);
    let listed: Vec<_> = k
        .claims
        .list(&ClaimFilter { workstream_id: Some(w1()), limit: 10, ..Default::default() })
        .unwrap()
        .into_iter()
        .map(|c| (c.claim_id.0, c.outcome))
        .collect();
    assert_eq!(listed, [("C2".into(), ClaimOutcome::Pass), ("C1".into(), ClaimOutcome::Fail)]);
    let again = k.claims.claim_done(&w1(), LEAD_BY, None).await.unwrap_err();
    assert_eq!((again.code, again.message.as_str()), ("invalid", "W1 is already done."));
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
    assert_eq!((i.incident_id.as_str(), i.class, &i.project_ref, i.workstream_id.as_ref()), ("I1", IncidentClass::FalseClaim, &project(), Some(&w1())));
    let expected: Vec<String> =
        (1..=3).map(|n| format!("C{n} failed: done:0 fail (exit 1): `test -f docs/x.md` in /w/p1 exited 1 (expected 0)")).collect();
    assert_eq!(i.evidence, expected);
    k.claims.claim_done(&w1(), LEAD_BY, None).await.unwrap();
    assert_eq!(incidents().len(), 1);
    assert_eq!(k.state(), WorkstreamState::Verifying);
}

#[tokio::test]
async fn asks_no_one_once_an_automatic_check_failed() {
    let k = kit(vec![workstream("W1", Some(vec![doc_check(), CheckSpec::Human { question: "Does the page read well?".into() }]))]);
    k.set_node(1, "");
    // The fake panics if a human ask is filed.
    let skipped = k.claims.claim_done(&w1(), LEAD_BY, None).await.unwrap();
    let r = &skipped.claim.unwrap().results[1];
    assert_eq!((r.result, r.ran_by), (CheckOutcome::Error, RanBy::Human));
    assert_eq!(r.evidence, "not run: a judge or the human is asked only once every earlier check passes");
}

#[tokio::test]
async fn refuses_drafts_other_projects_and_unknown_workstreams() {
    let mut finish_all = workstream("W3", Some(vec![doc_check()]));
    finish_all.state = WorkstreamState::Idle;
    finish_all.playbook = Some(PlaybookRef(format!("finish-all@{}", "a".repeat(40))));
    let k = kit(vec![workstream("W1", Some(vec![doc_check()])), workstream("W2", None), finish_all]);
    let draft = k.claims.claim_done(&WorkstreamId("W2".into()), LEAD_BY, None).await.unwrap_err();
    assert_eq!((draft.code, draft.message.as_str()), ("invalid", "W2 has no frozen brief, so it has no done-when checks to run."));
    let other = ProjectRef { machine_id: MachineId("lab-b".into()), project_id: ProjectId("p9".into()) };
    assert_eq!(k.claims.claim_done(&w1(), "lead:lab-b/p9", Some(&other)).await.unwrap_err().code, "not_found");
    assert_eq!(k.claims.claim_done(&WorkstreamId("W99".into()), LEAD_BY, None).await.unwrap_err().code, "not_found");
    let idle = k.claims.claim_done(&WorkstreamId("W3".into()), LEAD_BY, None).await.unwrap_err();
    assert_eq!(idle.message, "W3 is idle: finish-all: nothing left with a value source. A finish-all run ends idle, not done.");
    assert!(k.commands.lock().unwrap().is_empty());
}
