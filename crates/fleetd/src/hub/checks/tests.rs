//! The claim flow on a real in-memory database and event log, with a fake node and fake other areas.
use super::ports::{
    BoxFuture, ClaimWake, CommandRun, HumanConfirmation, JudgeSpawn, PlaybookLimits, Ports, Refusal,
};
use super::render::claim_failed_lines;
use super::*;
use crate::clock::{Clock, SystemClock};
use crate::hub::incidents::{IncidentFilter, Incidents};
use crate::hub::orders::open_work::{Item, OpenWork};
use crate::hub::store::{EventLog, HubDb, WaitInput};
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectRef, ThreadRef};
use fleetd_contracts::ledger::{
    BriefHash, MetricValues, PlaybookRef, Workstream, WorkstreamId, WorkstreamState,
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
    /// The `done.<n>` decisions the lead logged from the human's answers in chat, by key.
    confirmations: Mutex<HashMap<String, HumanConfirmation>>,
    /// When the brief was last frozen or amended.
    frozen_ms: Mutex<Option<i64>>,
    /// Stored when a check runs a command: an amend landing while the claim's checks run.
    amend_on_check: Mutex<Option<Workstream>>,
    /// Stored just before the next `put_workstream_if` compares: a write that lands between a read and that write.
    lands_first: Mutex<Option<Workstream>>,
    /// The unlanded write work every workstream has.
    open_work: Mutex<Vec<OpenWork>>,
    /// Write work that starts when a check runs a command, as a review's fix spawned while the workstream verifies.
    fix_on_check: Mutex<Option<OpenWork>>,
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
    fn put_workstream_if(&self, w: &Workstream, expect: &Workstream) -> bool {
        if let Some(first) = self.lands_first.lock().unwrap().take() {
            self.put_workstream(&first);
        }
        let mut all = self.workstreams.lock().unwrap();
        let now = all.get(&w.workstream_id).unwrap();
        if now.state != expect.state || now.brief_hash != expect.brief_hash {
            return false;
        }
        all.insert(w.workstream_id.clone(), w.clone());
        true
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
        if let Some(fix) = self.fix_on_check.lock().unwrap().take() {
            self.open_work.lock().unwrap().push(fix);
        }
        if let Some(amended) = self.amend_on_check.lock().unwrap().take() {
            self.put_workstream(&amended);
        }
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
    fn open_work(&self, _: &Workstream) -> Vec<OpenWork> {
        self.open_work.lock().unwrap().clone()
    }
    fn spawn_judge(&self, _: JudgeSpawn) -> BoxFuture<'_, Result<Task, Refusal>> {
        Box::pin(async { Err(super::ports::invalid("no judges here", None)) })
    }
    fn human_confirmation(&self, _: &WorkstreamId, key: &str) -> Option<HumanConfirmation> {
        self.confirmations.lock().unwrap().get(key).cloned()
    }
    fn brief_frozen_ms(&self, _: &WorkstreamId) -> Option<i64> {
        *self.frozen_ms.lock().unwrap()
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
    let verdicts = Arc::new(JudgeVerdicts::default());
    let judges = Arc::new(Judges::new(dyn_ports.clone(), events.clone(), verdicts));
    let runner = Arc::new(CheckRunner::new(
        Arc::new(GitHub::new(Arc::new(GhCli))),
        judges,
        dyn_ports.clone(),
        clock.clone(),
    ));
    let claims = Arc::new(Claims::new(
        Arc::new(ClaimRecords::new(db.clone())),
        runner,
        dyn_ports,
        events.clone(),
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
    fn confirm(&self, key: &str, value: &str, at_ms: i64) {
        let n = self.ports.confirmations.lock().unwrap().len() + 1;
        self.ports.confirmations.lock().unwrap().insert(
            key.into(),
            HumanConfirmation {
                value: value.into(),
                decision_id: format!("D{n}"),
                at_ms,
            },
        );
    }
    fn freeze_at(&self, ms: i64) {
        *self.ports.frozen_ms.lock().unwrap() = Some(ms);
    }
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

    let failed = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
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
            "- claim C1 on W1 failed: W1 stays verifying",
            "  done:0 (on lab-a: `test -f docs/x.md` exits 0): fail, exit 1",
            "    > `test -f docs/x.md` in /w/p1 exited 1 (expected 0)",
            "    > checked /w/p1",
        ]
        .join("\n")
    );

    k.set_node(0, "");
    let passed = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
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
    let again = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap_err();
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
        k.claims
            .claim_done(&w1(), LEAD_BY, None, None)
            .await
            .unwrap();
    }
    assert!(incidents().is_empty());
    k.claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
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
    k.claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
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
    k.confirm("done.1", "yes", 2_000);
    let skipped = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
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
        .claim_done(&WorkstreamId::unchecked("W2"), LEAD_BY, None, None)
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
            .claim_done(&w1(), "lead:lab-b/p9", Some(&other), None)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    assert_eq!(
        k.claims
            .claim_done(&WorkstreamId::unchecked("W99"), LEAD_BY, None, None)
            .await
            .unwrap_err()
            .code,
        ErrorCode::NotFound
    );
    let idle = k
        .claims
        .claim_done(&WorkstreamId::unchecked("W3"), LEAD_BY, None, None)
        .await
        .unwrap_err();
    assert_eq!(
        idle.message,
        "W3 is idle: finish-all: nothing left with a value source. A finish-all run ends idle, not done."
    );
    assert!(k.commands.lock().unwrap().is_empty());
}

/// The build brief of W4's amend, as `brief_create` writes it: a verifying workstream is running again. Its check 0 is a
/// human one too, so the research's `done.0` answer would pass it if an old answer counted.
fn build_brief(mut w: Workstream) -> Workstream {
    w.brief = Some(
        serde_json::from_value(
            json!({ "goal": "build schedules", "why": "the human chose to build", "pointers": [],
            "constraints": [], "tier": "L", "doneWhen": [
                { "type": "human", "question": "Schedules are live in the app: looks good on your end?" },
                doc_check(),
            ] }),
        )
        .unwrap(),
    );
    w.brief_hash = Some(BriefHash::unchecked("b".repeat(64)));
    w.state = WorkstreamState::Running;
    w
}

/// A research workstream with one human check ("did this answer your question?"), under brief hash a…, frozen at 1 s.
fn research_kit() -> Kit {
    let research = vec![
        json!({ "type": "human", "question": "Did the answer on scheduled work answer your question?" }),
    ];
    let k = kit(vec![workstream("W1", Some(research))]);
    let mut w = k.ports.workstream(&w1()).unwrap();
    w.brief_hash = Some(BriefHash::unchecked("a".repeat(64)));
    k.ports.put_workstream(&w);
    k.freeze_at(1_000);
    k
}

impl Kit {
    /// The lead amends W1 to the build at `at_ms`, as `brief_create` does: the new brief, its freeze, the old claim voided.
    fn amend_to_build(&self, at_ms: i64) {
        self.ports
            .put_workstream(&build_brief(self.ports.workstream(&w1()).unwrap()));
        self.freeze_at(at_ms);
        self.claims.void(&w1()).unwrap();
    }
    async fn closed(&self) -> bool {
        !self
            .events_of(&[HubEventType::WorkstreamDone, HubEventType::ClaimPassed])
            .await
            .is_empty()
    }
}

/// W4 on a real hub: a research order's answer-only brief had one human check. The human said it answered the
/// question and chose to build; the lead logged done.0 = yes and amended the brief to the build. That yes, logged for
/// the research brief, must never pass the build brief's own check 0: only an answer logged after the amend counts.
#[tokio::test]
async fn w4_a_claim_on_the_old_brief_never_closes_the_amended_build() {
    let k = research_kit();
    k.confirm("done.0", "yes", 2_000);
    k.amend_to_build(3_000);
    k.set_node(0, "");
    let stale = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
    assert_ne!(stale.state, WorkstreamState::Done, "{}", stale.next);
    let claim = stale.claim.unwrap();
    assert_eq!(claim.outcome, ClaimOutcome::Fail);
    assert!(
        claim.results[0].evidence.as_str().starts_with(
            "the answer in D1 predates the brief's latest version: ask the human in chat"
        ),
        "{}",
        claim.results[0].evidence.as_str()
    );
    assert!(!k.closed().await);

    // The human tries the build and says yes in chat; the lead logs it: now it is done.
    k.confirm("done.0", "yes", 4_000);
    let passed = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
    assert_eq!(passed.state, WorkstreamState::Done);
}

/// The amend lands while the old brief's claim runs its checks: that claim never counts, and the build brief stays.
#[tokio::test]
async fn a_claim_finishing_after_the_amend_never_counts() {
    let k = kit(vec![workstream("W1", Some(vec![doc_check()]))]);
    let mut w = k.ports.workstream(&w1()).unwrap();
    w.brief_hash = Some(BriefHash::unchecked("a".repeat(64)));
    k.ports.put_workstream(&w);
    k.set_node(0, "");
    *k.ports.amend_on_check.lock().unwrap() = Some(build_brief(w));
    k.claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
    assert!(!k.closed().await);
    let w = k.ports.workstream(&w1()).unwrap();
    assert_eq!(
        (w.state, w.brief_hash.unwrap().as_str().starts_with('b')),
        (WorkstreamState::Running, true)
    );
    assert!(
        k.claims
            .list(&ClaimFilter {
                workstream_id: Some(w1()),
                limit: 5,
                ..Default::default()
            })
            .unwrap()
            .is_empty(),
        "a claim that never counts is never recorded"
    );
}

/// An amend lands between the claim's read and its verifying write: the claim is refused, and the build brief stays.
#[tokio::test]
async fn an_amend_racing_the_claim_start_wins() {
    let k = research_kit();
    let amended = build_brief(k.ports.workstream(&w1()).unwrap());
    *k.ports.lands_first.lock().unwrap() = Some(amended);
    let refused = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap_err();
    assert_eq!(
        (refused.code, refused.message.as_str()),
        (ErrorCode::Invalid, "W1 changed while you claimed it.")
    );
    let w = k.ports.workstream(&w1()).unwrap();
    assert_eq!(
        (w.state, w.brief_hash.unwrap().as_str().starts_with('b')),
        (WorkstreamState::Running, true)
    );
}

/// A human check is a question the lead asks in chat; it passes only on a yes logged for the brief as it stands now.
#[tokio::test]
async fn a_human_check_passes_on_a_yes_logged_after_the_brief_froze() {
    let k = kit(vec![workstream(
        "W1",
        Some(vec![
            doc_check(),
            json!({ "type": "human", "question": "Looks good on your end?" }),
        ]),
    )]);
    k.set_node(0, "");
    k.freeze_at(1_000);
    let result = |c: &fleetd_contracts::verification::Claim| c.results[1].clone();

    let missing = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
    let r = result(missing.claim.as_ref().unwrap());
    assert_eq!(
        (r.result, r.ran_by),
        (CheckOutcome::Fail, CheckResultRanBy::Human)
    );
    assert_eq!(
        r.evidence.as_str(),
        "not confirmed yet: ask the human in chat: \"Looks good on your end?\", then log their answer with decide {key: \"done.1\", value: \"yes\" or \"no\", workstreamId: \"W1\"}"
    );

    k.confirm("done.1", "no", 2_000);
    let no = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
    let r = result(no.claim.as_ref().unwrap());
    assert_eq!(r.result, CheckOutcome::Fail);
    assert_eq!(r.evidence.as_str(), "the human said \"no\" in chat (D1)");

    k.confirm("done.1", "yes", 3_000);
    let yes = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
    let claim = yes.claim.unwrap();
    assert_eq!(claim.outcome, ClaimOutcome::Pass);
    assert_eq!(
        result(&claim).evidence.as_str(),
        "the human said yes in chat (D2)"
    );
}

/// The review fix of a live hub's W1, T4, spawned from its PR's review findings while W1 verified.
fn t4() -> OpenWork {
    OpenWork {
        item: Item::Task(TaskId::new("T4").unwrap()),
        line:
            "\"Share card: fresh link after changes, flag unpriced tokens, uncap counts\" (running)"
                .into(),
    }
}

#[tokio::test]
async fn a_review_fix_spawned_while_the_order_verifies_keeps_it_open_and_the_lead_is_told() {
    // W1/T4: the claim started with nothing open; the fix was spawned while its checks ran; the checks passed.
    let k = kit(vec![workstream("W1", Some(vec![doc_check()]))]);
    k.set_node(0, "");
    *k.ports.fix_on_check.lock().unwrap() = Some(t4());

    let held = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
    assert_eq!(
        held.claim.as_ref().map(|c| c.outcome),
        Some(ClaimOutcome::Pass),
        "the checks themselves passed"
    );
    assert_eq!(
        (held.state, k.state()),
        (WorkstreamState::Running, WorkstreamState::Running)
    );
    assert!(held.next.contains("stays open"), "{}", held.next);
    assert!(
        k.events_of(&[HubEventType::WorkstreamDone, HubEventType::ClaimPassed])
            .await
            .is_empty(),
        "never done over the fix, so nothing cancels it"
    );
    let states = k.events_of(&[HubEventType::WorkstreamState]).await;
    let (_, summary, data) = states.last().unwrap();
    assert_eq!(data["state"], "running");
    assert_eq!(
        data["reason"],
        format!("work that hasn't landed is still open: {}", t4().line)
    );
    assert!(summary.starts_with("W1 stays open: C1 passed"), "{summary}");
    let wakes = k.ports.wakes.lock().unwrap().clone();
    assert!(
        matches!(wakes.last(), Some(ClaimWake::Held { work, .. }) if work == &[t4()]),
        "{wakes:?}"
    );

    // The fix landed: the next claim makes it done.
    k.ports.open_work.lock().unwrap().clear();
    let done = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap();
    assert_eq!(
        (done.state, k.state()),
        (WorkstreamState::Done, WorkstreamState::Done)
    );
}

#[tokio::test]
async fn claim_done_refuses_over_unlanded_work_in_plain_words_until_closed_over_on_purpose() {
    let k = kit(vec![workstream("W1", Some(vec![doc_check()]))]);
    k.set_node(0, "");
    let pr = OpenWork {
        item: Item::Pr(fleetd_contracts::train::ChangeId::new("X3").unwrap()),
        line: "the pull request for \"Uncap counts\" (in review)".into(),
    };
    k.ports.open_work.lock().unwrap().extend([t4(), pr.clone()]);

    let refused = k
        .claims
        .claim_done(&w1(), LEAD_BY, None, None)
        .await
        .unwrap_err();
    assert!(
        refused.message.starts_with(&format!(
            "W1 has write work that hasn't landed: {}; {} (ids, for tools only: T4, X3).",
            t4().line,
            pr.line
        )),
        "{}",
        refused.message
    );
    assert!(
        refused
            .fix
            .as_deref()
            .unwrap()
            .contains("plain words, no ids")
    );
    assert_eq!(k.state(), WorkstreamState::Running);
    assert!(k.commands.lock().unwrap().is_empty(), "no check ran");

    // On purpose, with why: done, and the record says what was dropped and why.
    let closed = k
        .claims
        .claim_done(
            &w1(),
            LEAD_BY,
            None,
            Some("the PR's author left; redone in the next order"),
        )
        .await
        .unwrap();
    assert_eq!(closed.state, WorkstreamState::Done);
    assert!(
        closed.next.contains(&format!(
            "closed on purpose over {}; {}, which is dropped",
            t4().line,
            pr.line
        )),
        "the reply names what is dropped, for the chat line: {}",
        closed.next
    );
    let done = k.events_of(&[HubEventType::WorkstreamDone]).await;
    let (_, summary, data) = done.last().unwrap();
    let reason = format!(
        "closed on purpose: the PR's author left; redone in the next order (dropping {}; {})",
        t4().line,
        pr.line
    );
    assert_eq!(data["reason"], reason);
    assert!(
        summary.starts_with("W1 is done, closed on purpose: the PR's author left"),
        "{summary}"
    );
}

#[tokio::test]
async fn closing_over_work_on_purpose_never_drops_work_spawned_after_the_claim() {
    // The W1/T4 timing with closeOver: the lead closed over an old PR, and a review's fix appeared while the checks ran.
    let k = kit(vec![workstream("W1", Some(vec![doc_check()]))]);
    k.set_node(0, "");
    let old_pr = OpenWork {
        item: Item::Pr(fleetd_contracts::train::ChangeId::new("X2").unwrap()),
        line: "a pull request in o/testbed (needs a rebase)".into(),
    };
    k.ports.open_work.lock().unwrap().push(old_pr);
    *k.ports.fix_on_check.lock().unwrap() = Some(t4());

    let held = k
        .claims
        .claim_done(
            &w1(),
            LEAD_BY,
            None,
            Some("the old PR was redone elsewhere"),
        )
        .await
        .unwrap();
    assert_eq!(
        (held.state, k.state()),
        (WorkstreamState::Running, WorkstreamState::Running)
    );
    assert!(
        k.events_of(&[HubEventType::WorkstreamDone])
            .await
            .is_empty()
    );
    let wakes = k.ports.wakes.lock().unwrap().clone();
    assert!(
        matches!(wakes.last(), Some(ClaimWake::Held { work, .. }) if work == &[t4()]),
        "held over the work the lead never saw: {wakes:?}"
    );

    // Shown it now, the lead may close over both on purpose.
    let done = k
        .claims
        .claim_done(
            &w1(),
            LEAD_BY,
            None,
            Some("both are redone in the next order"),
        )
        .await
        .unwrap();
    assert_eq!(done.state, WorkstreamState::Done);
}
