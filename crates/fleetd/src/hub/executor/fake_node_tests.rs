//! The executor against a fake node on the other end of the link: the frames it sends for launch, send, interrupt
//! and a permission answer, and what it makes of the frames that come back.
use std::sync::Arc;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ThreadId, ThreadRef};
use fleetd_contracts::node_link::{HubToNode, NodeToHub};
use fleetd_contracts::sessions::{SessionCall, SessionWorkspace, ThreadEventFrame};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{EventLog, HubDb, HubStore, WaitInput};

const T0_MS: u64 = 1_792_231_200_000; // 2026-10-17T10:00:00Z

struct Node {
    executors: Arc<Executors>,
    events: Arc<EventLog>,
    store: Arc<HubStore>,
    machine: MachineId,
    rx: mpsc::UnboundedReceiver<HubToNode>,
    seq: u64,
}

impl Node {
    /// `cursor`: what an earlier hub process stored for the machine.
    async fn start(cursor: Option<i64>) -> Self {
        let db = HubDb::open_memory().unwrap();
        let clock = ManualClock::at(T0_MS);
        let store = Arc::new(HubStore::new(db.clone()));
        let machine = MachineId::new("lab-b").unwrap();
        if let Some(c) = cursor {
            store.cursor_set(&machine, c).unwrap();
        }
        let events = Arc::new(EventLog::new(db, clock.clone()).unwrap());
        let executors = Executors::new(store.clone(), events.clone(), clock);
        let (tx, rx) = mpsc::unbounded_channel();
        executors
            .attach(
                &machine,
                NodeSessions {
                    link_id: 1,
                    send: tx,
                },
            )
            .await;
        Self {
            executors,
            events,
            store,
            machine,
            rx,
            seq: 0,
        }
    }

    /// The next call the hub sent, with its frame id.
    async fn call(&mut self) -> (String, SessionCall) {
        match self.rx.recv().await.expect("the hub keeps the link") {
            HubToNode::SessionCall(f) => (f.id.to_string(), f.call),
            other => panic!("not a session call: {other:?}"),
        }
    }

    /// The next call other than a follow. The hub follows every session whose run is active, on its own; those
    /// follows are answered with "not found" so they end at once.
    async fn call_after_follows(&mut self) -> (String, SessionCall) {
        loop {
            let (id, call) = self.call().await;
            if !matches!(call, SessionCall::Follow { .. }) {
                return (id, call);
            }
            self.reply(
                &id,
                json!({ "err": { "code": "not_found", "message": "not followed in this test" } }),
            );
        }
    }

    fn frame(&self, v: Value) {
        let frame: NodeToHub = serde_json::from_value(v).unwrap();
        self.executors.handle_frame(&self.machine, frame);
    }

    fn reply(&self, id: &str, result: Value) {
        self.frame(json!({ "t": "session_reply", "id": id, "result": result }));
    }

    fn push(&mut self, event: Value) {
        self.seq += 1;
        self.frame(json!({ "t": "machine_event", "seq": self.seq, "at": "2026-10-17T10:00:00.000Z", "event": event }));
    }

    /// Answers the subscription with a snapshot of one project and `sessions`, and a runner that is logged in.
    async fn subscribe(&mut self, sessions: Value) {
        let (id, call) = self.call().await;
        assert_eq!(
            call,
            SessionCall::Subscribe {
                after: None,
                spans_after: None
            }
        );
        self.push(json!({ "type": "snapshot", "projects": [project()], "sessions": sessions }));
        self.push(runner_event("logged_in", None));
        self.reply(&id, json!({ "ok": { "kind": "done" } }));
        self.executors.await_live(&self.machine).await;
    }

    /// Waits for the hub to log an event of `kind` (it does once it applied the frame that caused it).
    async fn logged(&self, kind: &str) -> Value {
        let t: HubEventType = serde_json::from_value(json!(kind)).unwrap();
        let page = self
            .events
            .wait(WaitInput {
                cursor: Some(0),
                types: Some(vec![t]),
                machine_id: None,
                timeout_sec: 3600,
            })
            .await
            .unwrap();
        serde_json::to_value(page.events.last().unwrap()).unwrap()
    }

    fn thread(&self, id: &str) -> ThreadRef {
        ThreadRef {
            machine_id: self.machine.clone(),
            thread_id: ThreadId::unchecked(id),
        }
    }
}

fn runner_event(login: &str, problem: Option<&str>) -> Value {
    let mut v = json!({ "type": "runner_info", "runner": "claude", "version": "2.1.302",
        "supported": ">=2.1.300, <2.2.0", "versionOk": true, "login": login, "loginKind": "subscription",
        "conformanceOk": true });
    if let Some(p) = problem {
        v["problem"] = json!(p);
    }
    v
}

fn project() -> Value {
    json!({ "projectId": "p1", "title": "fixtures", "workspaceRoot": "/work/project", "updatedAt": "2026-10-17T10:00:00.000Z" })
}

fn session(id: &str, extra: Value) -> Value {
    let mut s = json!({
        "sessionId": id, "projectId": "p1", "title": "say OK", "status": "idle", "model": "claude-haiku-5-5",
        "effort": "low", "runtimeMode": "approval-required",
        "createdAt": "2026-10-17T10:00:00.000Z", "updatedAt": "2026-10-17T10:01:00.000Z",
    });
    for (k, v) in extra.as_object().unwrap() {
        s[k] = v.clone();
    }
    s
}

/// A project policy with `tools.allow: [Bash(npm test:*)]` and `tools.deny: [WebFetch]`.
struct Rules;

impl ToolPolicy for Rules {
    fn tools<'a>(&'a self, _: &'a ProjectRef) -> ToolRulesFuture<'a> {
        Box::pin(async {
            Ok(super::SessionRules {
                allow: vec!["Bash(npm test:*)".into()],
                deny: vec!["WebFetch".into()],
            })
        })
    }
}

fn launch_input(request: &str) -> LaunchInput {
    LaunchInput {
        project_id: ProjectId::unchecked("p1"),
        prompt: "reply with the word OK".into(),
        model: "claude-haiku-5-5".into(),
        effort: Effort::Low,
        runtime_mode: RuntimeMode::ApprovalRequired,
        title: None,
        client_request_id: request.into(),
    }
}

#[tokio::test]
async fn launch_send_interrupt_and_a_permission_answer_go_out_as_session_calls() {
    let mut node = Node::start(None).await;
    // A thread the hub stored before the native runner, which the node has never heard of.
    let old = node.thread("pre-runner-thread");
    node.store
        .thread_upsert(&crate::hub::store::StoredThread {
            thread: serde_json::from_value(json!({
                "machineId": "lab-b", "threadId": "pre-runner-thread", "projectId": "p1", "title": "old", "status": "running",
                "headline": "", "latestMessageTail": "", "lastProgressAt": "2026-10-01T10:00:00.000Z",
                "stale": false, "asOf": "2026-10-01T10:00:00.000Z",
            }))
            .unwrap(),
            last_sequence: Some(4000),
            last_run_id: None,
            last_run_status: None,
        })
        .unwrap();
    node.subscribe(json!([])).await;
    assert!(node.executors.is_connected(&node.machine));

    // Launch: one call, ids derived from the request id so a retry lands on the same session, with the project's
    // tool rules.
    node.executors.set_tool_policy(Arc::new(Rules));
    let executors = node.executors.clone();
    let machine = node.machine.clone();
    let launched = tokio::spawn(async move {
        executors
            .launch(&machine, &launch_input("req-1"), LaunchOptions::default())
            .await
    });
    let (id, call) = node.call().await;
    let SessionCall::Launch(l) = call else {
        panic!("not a launch: {call:?}")
    };
    assert_eq!(l.model.as_str(), "claude-haiku-5-5");
    assert_eq!(l.prompt.as_str(), "reply with the word OK");
    assert_eq!(l.title.as_deref(), Some("reply with the word OK"));
    assert_eq!(l.workspace, SessionWorkspace::Root);
    assert_eq!(l.runtime_mode, RuntimeMode::ApprovalRequired);
    assert_eq!(
        (l.allowed_tools.as_slice(), l.disallowed_tools.as_slice()),
        (
            &["Bash(npm test:*)".to_owned()][..],
            &["WebFetch".to_owned()][..]
        )
    );
    let (session_id, run_id) = (l.session_id.to_string(), l.run_id.to_string());
    node.reply(
        &id,
        json!({ "ok": { "kind": "launched", "summary": session(&session_id, json!({})) } }),
    );
    assert_eq!(launched.await.unwrap().unwrap().as_str(), session_id);
    let executors = node.executors.clone();
    let machine = node.machine.clone();
    let again = tokio::spawn(async move {
        executors
            .launch(&machine, &launch_input("req-1"), LaunchOptions::default())
            .await
    });
    let (id, call) = node.call().await;
    let SessionCall::Launch(retry) = call else {
        panic!("not a launch")
    };
    assert_eq!(
        (retry.session_id.to_string(), retry.run_id.to_string()),
        (session_id.clone(), run_id.clone())
    );
    node.reply(
        &id,
        json!({ "ok": { "kind": "launched", "summary": session(&session_id, json!({})) } }),
    );
    again.await.unwrap().unwrap();

    // The run starts: thread.started, and the old row is now stale and no longer counts as running.
    node.push(json!({ "type": "session_updated", "status": "running", "activeRunId": run_id,
        "latestRun": { "id": run_id, "status": "running", "ordinal": 1 },
        "sessionId": session_id, "projectId": "p1", "title": "say OK", "model": "claude-haiku-5-5", "effort": "low",
        "runtimeMode": "approval-required", "createdAt": "2026-10-17T10:00:00.000Z", "updatedAt": "2026-10-17T10:01:00.000Z" }));
    let started = node.logged("thread.started").await;
    assert_eq!(started["threadId"], session_id.as_str());
    let stale = node.store.thread_get(&old).unwrap().unwrap();
    assert!(stale.thread.stale);
    assert!(
        node.store
            .threads_running()
            .unwrap()
            .iter()
            .all(|t| t.thread_id.as_str() != "pre-runner-thread")
    );
    let r = node.thread(&session_id);
    assert_eq!(
        node.executors.latest_run(&r),
        Some(LatestRun {
            run_id: Some(run_id.clone()),
            running: true
        })
    );

    // A send while the run is active waits behind it.
    let executors = node.executors.clone();
    let target = r.clone();
    let sent = tokio::spawn(async move { executors.send(&target, "and then?", "req-2").await });
    let (id, call) = node.call_after_follows().await;
    let SessionCall::Send {
        session_id: to,
        run_id: next_run,
        text,
        ..
    } = call
    else {
        panic!("not a send")
    };
    assert_eq!(
        (to.as_str(), text.as_str()),
        (session_id.as_str(), "and then?")
    );
    node.reply(
        &id,
        json!({ "ok": { "kind": "sent", "runId": next_run.as_str(), "queued": true } }),
    );
    assert_eq!(
        sent.await.unwrap().unwrap(),
        SendOutcome {
            run_id: Some(next_run.to_string()),
            queued: true
        }
    );

    // A permission prompt: thread.waiting with what it asks, and the pending question.
    node.push(json!({ "type": "session_updated", "status": "waiting", "activeRunId": run_id,
        "latestRun": { "id": run_id, "status": "waiting", "ordinal": 1 },
        "pendingPermission": { "requestId": "q1", "toolName": "Bash", "summary": "touch notes.txt" },
        "sessionId": session_id, "projectId": "p1", "title": "say OK", "model": "claude-haiku-5-5", "effort": "low",
        "runtimeMode": "approval-required", "createdAt": "2026-10-17T10:00:00.000Z", "updatedAt": "2026-10-17T10:02:00.000Z" }));
    let waiting = node.logged("thread.waiting").await;
    assert_eq!(waiting["data"]["permission"]["requestId"], "q1");
    assert_eq!(
        node.executors
            .pending_question(&r)
            .await
            .unwrap()
            .as_deref(),
        Some("approve Bash: touch notes.txt")
    );

    // Interrupt names the active run.
    let executors = node.executors.clone();
    let target = r.clone();
    let interrupted = tokio::spawn(async move { executors.interrupt(&target, "req-3").await });
    let (id, call) = node.call_after_follows().await;
    assert_eq!(
        call,
        SessionCall::Interrupt {
            session_id: ThreadId::unchecked(session_id.as_str()),
            run_id: Some(NonEmpty::unchecked(run_id.as_str())),
            reason: Some("interrupted through fleetd".into()),
        }
    );
    node.reply(&id, json!({ "ok": { "kind": "done" } }));
    interrupted.await.unwrap().unwrap();

    // A send to a session the node does not know is an unknown thread.
    let executors = node.executors.clone();
    let target = node.thread("nope");
    let unknown = tokio::spawn(async move { executors.send(&target, "hi", "req-4").await });
    let (id, _) = node.call_after_follows().await;
    node.reply(
        &id,
        json!({ "err": { "code": "not_found", "message": "no session nope" } }),
    );
    assert!(matches!(
        unknown.await.unwrap(),
        Err(ExecutorError::ThreadNotFound { .. })
    ));
}

#[tokio::test]
async fn a_tail_follows_the_session_and_fetches_cut_outputs() {
    // A hub restart: the first snapshot is diffed against the store, so a run that ended meanwhile is reported.
    let mut node = Node::start(Some(5)).await;
    node.subscribe(json!([session(
        "s1",
        json!({ "latestRun": { "id": "r1", "status": "completed", "ordinal": 1 } })
    )]))
    .await;
    let late = node.logged("thread.completed").await;
    assert_eq!(late["data"]["late"], true);
    let r = node.thread("s1");
    let executors = node.executors.clone();
    let target = r.clone();
    let tail = tokio::spawn(async move { executors.tail(&target, 10, None).await });
    let (id, call) = node.call().await;
    assert_eq!(
        call,
        SessionCall::Follow {
            session_id: ThreadId::unchecked("s1")
        }
    );
    node.reply(&id, json!({ "ok": { "kind": "done" } }));
    let snapshot: ThreadEventFrame = serde_json::from_value(json!({
        "sessionId": "s1", "at": "2026-10-17T10:03:00.000Z",
        "event": { "type": "snapshot", "summary": session("s1", json!({})), "truncated": false,
            "runs": [{ "id": "r1", "status": "completed", "ordinal": 1 }],
            "messages": [{ "id": "m1", "runId": "r1", "role": "assistant", "text": "OK", "createdAt": "2026-10-17T10:02:00.000Z" }],
            "items": [{ "id": "i1", "runId": "r1", "status": "completed", "title": "",
                "startedAt": "2026-10-17T10:01:00.000Z", "completedAt": "2026-10-17T10:01:30.000Z",
                "updatedAt": "2026-10-17T10:01:30.000Z",
                "kind": { "type": "command", "command": "npm test", "output": "…tail", "outputOmitted": true, "exitCode": 0 } }],
        },
    }))
    .unwrap();
    node.executors
        .handle_frame(&node.machine, NodeToHub::ThreadEvent(snapshot));
    let (id, call) = node.call().await;
    assert_eq!(
        call,
        SessionCall::ReadItem {
            session_id: ThreadId::unchecked("s1"),
            item_id: NonEmpty::unchecked("i1")
        }
    );
    node.reply(&id, json!({ "ok": { "kind": "item", "item": { "id": "i1", "runId": "r1", "status": "completed",
        "title": "", "startedAt": "2026-10-17T10:01:00.000Z", "completedAt": "2026-10-17T10:01:30.000Z",
        "updatedAt": "2026-10-17T10:01:30.000Z",
        "kind": { "type": "command", "command": "npm test", "output": "all 12 tests passed", "exitCode": 0 } } } }));
    let tail = tail.await.unwrap().unwrap();
    assert_eq!(tail.thread.headline, "OK");
    let rows = serde_json::to_value(&tail.items).unwrap();
    assert_eq!(rows[0]["kind"], "message");
    assert_eq!(rows[1]["action"]["outputTail"], "all 12 tests passed");
    // Followed, so the watchdog sees progress.
    assert!(node.executors.progress(&r).is_some());

    // The link drops: the machine is offline and calls fail at once.
    node.executors.detach_link(&node.machine, 1).await;
    assert!(!node.executors.is_connected(&node.machine));
    assert!(node.executors.progress(&r).is_none());
    assert!(matches!(
        node.executors.send(&r, "hi", "req-9").await,
        Err(ExecutorError::MachineNotConnected { .. })
    ));
}

#[tokio::test]
async fn a_logged_out_runner_refuses_launches_until_it_logs_back_in() {
    let mut node = Node::start(None).await;
    node.subscribe(json!([])).await;
    let mut runner = node.executors.runner_watch(&node.machine);
    let problem = "claude is not logged in for fleetd on lab-b";
    node.push(runner_event("logged_out", Some(problem)));
    runner.changed().await.unwrap();
    let seen = runner.borrow_and_update().clone().unwrap();
    // What the link server announces: degraded with the node's own words.
    assert_eq!(providers::runner_problem(&seen).as_deref(), Some(problem));
    // Refused by the hub before any call goes out, with the fix to run on the machine.
    match node
        .executors
        .launch(
            &node.machine,
            &launch_input("req-1"),
            LaunchOptions::default(),
        )
        .await
    {
        Err(ExecutorError::NodeRequestFailed { message, fix, .. }) => {
            assert_eq!(message, problem);
            assert!(fix.unwrap().contains("claude auth login"));
        }
        other => panic!("{other:?}"),
    }
    assert!(node.rx.try_recv().is_err());
    // And a send to it fails the same way rather than waiting in the offline queue.
    let refused =
        crate::hub::queue::ports::ThreadWriter::refusal(node.executors.as_ref(), &node.machine);
    assert!(matches!(
        refused,
        Some(crate::hub::queue::ports::ExecutorError::NodeRequestFailed { message, .. }) if message == problem
    ));

    node.push(runner_event("logged_in", None));
    runner.changed().await.unwrap();
    let seen = runner.borrow_and_update().clone().unwrap();
    assert_eq!(providers::runner_problem(&seen), None);
    assert!(
        crate::hub::queue::ports::ThreadWriter::refusal(node.executors.as_ref(), &node.machine)
            .is_none()
    );
    assert_eq!(node.executors.cached_runner(&node.machine), Some(seen));
    let executors = node.executors.clone();
    let machine = node.machine.clone();
    let launched = tokio::spawn(async move {
        executors
            .launch(&machine, &launch_input("req-2"), LaunchOptions::default())
            .await
    });
    let (id, call) = node.call().await;
    let SessionCall::Launch(l) = call else {
        panic!("not a launch: {call:?}")
    };
    node.reply(
        &id,
        json!({ "ok": { "kind": "launched", "summary": session(l.session_id.as_str(), json!({})) } }),
    );
    launched.await.unwrap().unwrap();
}

#[tokio::test]
async fn queued_writes_wait_for_the_online_verdict_not_just_the_link() {
    use crate::hub::queue::ports::ThreadWriter;
    let mut node = Node::start(None).await;
    node.subscribe(json!([])).await;
    // Linked and subscribed, but the link server has not announced it online yet: the queue holds its writes.
    assert!(node.executors.is_connected(&node.machine));
    assert!(!ThreadWriter::is_connected(
        node.executors.as_ref(),
        &node.machine
    ));
    let executors = node.executors.clone();
    let machine = node.machine.clone();
    let waiting =
        tokio::spawn(async move { ThreadWriter::await_live(executors.as_ref(), &machine).await });
    // What the link server does right after logging machine.online.
    node.executors.set_runner_ready(&node.machine, true);
    waiting.await.unwrap();
    assert!(ThreadWriter::is_connected(
        node.executors.as_ref(),
        &node.machine
    ));
    // Degraded again (a login that expired): no more deliveries.
    node.executors.set_runner_ready(&node.machine, false);
    assert!(!ThreadWriter::is_connected(
        node.executors.as_ref(),
        &node.machine
    ));
    node.executors.set_runner_ready(&node.machine, true);
    // A dropped link clears it, so a relink waits for its own verdict.
    node.executors.detach_link(&node.machine, 1).await;
    // Away now, so even a logged-out runner's machine queues rather than refuses.
    node.push(runner_event("logged_out", Some("claude is not logged in")));
    assert!(ThreadWriter::refusal(node.executors.as_ref(), &node.machine).is_none());
    assert!(!ThreadWriter::is_connected(
        node.executors.as_ref(),
        &node.machine
    ));
    node.executors
        .attach(
            &node.machine,
            NodeSessions {
                link_id: 2,
                send: mpsc::unbounded_channel().0,
            },
        )
        .await;
    assert!(!ThreadWriter::is_connected(
        node.executors.as_ref(),
        &node.machine
    ));
}
