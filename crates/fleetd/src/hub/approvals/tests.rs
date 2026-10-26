use super::*;
use crate::hub::store::HubDb;
use crate::hub::usage::ports::WaitPage;
use fleetd_contracts::events::HubEvent;
use std::sync::Mutex;

/// The approvals over a real request store, a scripted node and a recorded event log.
struct Fake {
    requests: Arc<Requests>,
    linked: Mutex<bool>,
    events: Mutex<Vec<NewEvent>>,
    /// Each lead wake: `<requestId> <state>`.
    woken: Mutex<Vec<String>>,
    woke: tokio::sync::Notify,
    /// Each gated command the node ran: machine and input.
    runs: Mutex<Vec<(String, Value)>>,
    gated_reply: Mutex<Result<GatedOutcome, NodeCommandError>>,
    /// Each sealed secret the node took: machine and input.
    secrets: Mutex<Vec<(String, Value)>>,
    /// The project's open orders; every other order is refused.
    open_orders: Vec<&'static str>,
    /// Each variable recorded for an order.
    order_saved: Mutex<Vec<OrderEnvSaved>>,
}

impl Default for Fake {
    fn default() -> Self {
        Self {
            requests: Requests::new(HubDb::open_memory().unwrap()),
            linked: Mutex::new(false),
            events: Mutex::default(),
            woken: Mutex::default(),
            woke: tokio::sync::Notify::new(),
            runs: Mutex::default(),
            gated_reply: Mutex::new(Ok(GatedOutcome {
                exit_code: Some(0),
                output_tail: "migrated 3 tables\n".into(),
                ..Default::default()
            })),
            secrets: Mutex::default(),
            open_orders: vec!["W7"],
            order_saved: Mutex::default(),
        }
    }
}

impl Fake {
    /// Waits until the lead was woken `n` times in all.
    async fn woken_times(&self, n: usize) {
        while self.woken.lock().unwrap().len() < n {
            self.woke.notified().await;
        }
    }
    fn request(&self, id: &str) -> HumanRequest {
        self.requests.get(id).unwrap().unwrap()
    }
    /// Stores an open command approval.
    fn stored(&self) -> HumanRequest {
        self.requests
            .create(NewRequest {
                project_ref: serde_json::from_value(
                    json!({ "machineId": "lab-a", "projectId": "p1" }),
                )
                .unwrap(),
                workstream_id: None,
                kind: RequestKind::Approval,
                text: "lab-a: ls".into(),
                secret: None,
                gated: Some(
                    serde_json::from_value(json!({ "argv": ["ls"], "cwd": "/w/p1", "class": "irreversible", "reason": "look", "timeoutSec": 60 }))
                        .unwrap(),
                ),
                permission: None,
                at: fleetd_contracts::ids::Timestamp("2026-10-18T10:00:00.000Z".into()),
                at_ms: 0,
            })
            .unwrap()
    }
}

impl ApprovalNodes for Fake {
    fn deliver_secret(
        &self,
        m: &str,
        input: Value,
    ) -> BoxFut<'_, Result<SecretOutcome, NodeCommandError>> {
        self.secrets.lock().unwrap().push((m.into(), input));
        Box::pin(async {
            Ok(SecretOutcome {
                fingerprint: Some("ab12cd34".into()),
                error: None,
            })
        })
    }
    fn run_gated(
        &self,
        m: &str,
        input: Value,
    ) -> BoxFut<'_, Result<GatedOutcome, NodeCommandError>> {
        self.runs.lock().unwrap().push((m.into(), input));
        let reply = self.gated_reply.lock().unwrap().clone();
        Box::pin(async move { reply })
    }
    fn is_linked(&self, _: &str) -> BoxFut<'_, bool> {
        let l = *self.linked.lock().unwrap();
        Box::pin(async move { l })
    }
}

impl ApprovalHub for Fake {
    fn box_key(&self, m: &str) -> BoxFut<'_, Option<Option<String>>> {
        let key = (m == "lab-a").then(|| Some("box-key".to_string()));
        Box::pin(async move { key })
    }
    fn workspace_root(&self, _: &ProjectRef) -> BoxFut<'_, Option<String>> {
        Box::pin(async { Some("/w/p1".into()) })
    }
    fn wake_request(&self, r: &HumanRequest) -> BoxFut<'_, ()> {
        self.woken
            .lock()
            .unwrap()
            .push(format!("{} {}", r.request_id, r.state.as_str()));
        self.woke.notify_one();
        Box::pin(async {})
    }
    fn order_refusal(&self, _: &ProjectRef, order_id: &str) -> BoxFut<'_, Option<String>> {
        let why = (!self.open_orders.contains(&order_id)).then(|| format!("{order_id} is closed."));
        Box::pin(async move { why })
    }
    fn order_env_saved(&self, saved: OrderEnvSaved) -> BoxFut<'_, ()> {
        self.order_saved.lock().unwrap().push(saved);
        Box::pin(async {})
    }
}

impl EventLog for Fake {
    fn append(&self, e: NewEvent) -> BoxFut<'_, HubEvent> {
        self.events.lock().unwrap().push(e.clone());
        Box::pin(async move {
            serde_json::from_value(json!({
                "seq": 1, "at": e.at, "type": e.kind, "machineId": e.machine_id, "projectId": e.project_id,
                "threadId": e.thread_id, "summary": e.summary, "data": e.data, "attention": e.attention,
            }))
            .unwrap()
        })
    }
    fn head(&self) -> BoxFut<'_, u64> {
        Box::pin(async { 0 })
    }
    fn wait(&self, _: WaitInput) -> BoxFut<'_, WaitPage> {
        Box::pin(async { WaitPage::default() })
    }
}

fn approvals(fake: &Arc<Fake>) -> Arc<Approvals> {
    Approvals::new(ApprovalsDeps {
        requests: fake.requests.clone(),
        nodes: fake.clone(),
        hub: fake.clone(),
        events: fake.clone(),
        clock: Arc::new(crate::clock::SystemClock),
    })
}

fn p1() -> ProjectRef {
    ProjectRef {
        machine_id: "lab-a".into(),
        project_id: "p1".into(),
    }
}

const ANYWHERE: &(dyn Fn(&str) -> bool + Sync) = &|_: &str| true;
const NOWHERE: &(dyn Fn(&str) -> bool + Sync) = &|_: &str| false;

fn person() -> Caller<'static> {
    Caller {
        human: true,
        name: "desk",
        allows_operate: ANYWHERE,
    }
}

fn agent() -> Caller<'static> {
    Caller {
        human: false,
        name: "lead-key",
        allows_operate: ANYWHERE,
    }
}

fn migration() -> GatedRunInput {
    GatedRunInput {
        argv: vec!["sh".into(), "-c".into(), "make migrate".into()],
        cwd: None,
        class: "irreversible".into(),
        reason: "apply the schema change".into(),
        secret_env: None,
        timeout_sec: 600,
        workstream_id: None,
    }
}

/// The gated-run approval path: the lead's command waits as an open approval; only a person's Approve runs it, exactly
/// as stored, and the outcome reaches the lead.
#[tokio::test]
async fn approve_runs_the_stored_command_and_wakes_the_lead_with_its_outcome() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    let open = a.gated_run(&p1(), migration()).await.unwrap();
    assert_eq!(
        (open.request_id.as_str(), open.state),
        ("Q1", RequestState::Open)
    );
    assert_eq!(
        open.text.as_str(),
        "Run sh -c \"make migrate\" on lab-a in /w/p1: apply the schema change"
    );
    let item = serde_json::to_value(chat_item(&open)).unwrap();
    assert_eq!(
        (item["kind"].as_str(), item["state"].as_str()),
        (Some("command_approval"), Some("open"))
    );
    assert!(
        fake.runs.lock().unwrap().is_empty(),
        "nothing runs before a person approves it"
    );

    let refused = a.answer(&agent(), "Q1", true, None).await.unwrap_err();
    assert_eq!(refused.code, "forbidden", "an agent key never approves");
    let ungranted = Caller {
        allows_operate: NOWHERE,
        ..person()
    };
    assert_eq!(
        a.answer(&ungranted, "Q1", true, None)
            .await
            .unwrap_err()
            .code,
        "forbidden"
    );
    assert_eq!(
        a.answer(&person(), "Q9", true, None)
            .await
            .unwrap_err()
            .code,
        "not_found"
    );

    let approved = a.answer(&person(), "Q1", true, None).await.unwrap();
    assert_eq!(approved.answered_by.as_deref(), Some("human:desk"));
    fake.woken_times(1).await;
    assert_eq!(
        fake.runs.lock().unwrap().as_slice(),
        [(
            "lab-a".to_string(),
            json!({ "argv": ["sh", "-c", "make migrate"], "cwd": "/w/p1", "timeoutSec": 600 })
        )]
    );
    let ran = fake.request("Q1");
    assert_eq!(
        (
            ran.state,
            ran.exit_code,
            ran.evidence.as_ref().map(|e| e.as_str())
        ),
        (
            RequestState::Ran,
            Some(0),
            Some("exit 0 on lab-a, approved by human:desk")
        )
    );
    assert_eq!(
        ran.output_tail.as_ref().map(|t| t.as_str()),
        Some("migrated 3 tables")
    );
    // When the result came back, so the app can say how long it ran; never before it was approved.
    let finished = ran
        .finished_at
        .as_ref()
        .expect("a ran command records when it finished");
    assert!(finished.0 >= approved.answered_at.as_ref().unwrap().0);
    assert!(approved.finished_at.is_none());
    assert_eq!(fake.woken.lock().unwrap().as_slice(), ["Q1 ran"]);
    let again = a.answer(&person(), "Q1", true, None).await.unwrap_err();
    assert_eq!(
        (again.code.as_str(), again.message.as_str()),
        ("invalid", "Q1 is already ran.")
    );
    assert_eq!(
        fake.runs.lock().unwrap().len(),
        1,
        "a command runs once per approval"
    );
}

#[tokio::test]
async fn deny_never_runs_the_command_and_an_offline_node_puts_it_back_to_the_person() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.gated_run(&p1(), migration()).await.unwrap();
    let denied = a
        .answer(&person(), "Q1", false, Some("not on a Friday".into()))
        .await
        .unwrap();
    assert_eq!(
        (denied.state, denied.evidence.as_ref().map(|e| e.as_str())),
        (RequestState::Denied, Some("not on a Friday"))
    );
    assert!(fake.runs.lock().unwrap().is_empty());
    assert_eq!(fake.woken.lock().unwrap().as_slice(), ["Q1 denied"]);
    let (_, outcome) = crate::hub::usage::wire_approvals::request_outcome(&denied);
    assert_eq!(
        outcome,
        "denied by human:desk: not on a Friday; don't run it, say in the chat what you do instead"
    );

    a.gated_run(&p1(), migration()).await.unwrap();
    *fake.gated_reply.lock().unwrap() = Err(NodeCommandError {
        reason: "offline".into(),
        message: "lab-a's node is not linked to the hub".into(),
        fix: None,
    });
    a.answer(&person(), "Q2", true, None).await.unwrap();
    fake.woken_times(2).await;
    let back = fake.request("Q2");
    assert_eq!(
        back.state,
        RequestState::Open,
        "nothing ran, so the person approves it again"
    );
    assert!(back.answered_by.is_none());
    assert!(
        back.evidence
            .as_ref()
            .unwrap()
            .as_str()
            .starts_with("not run: lab-a's node was offline when human:desk approved it"),
        "{:?}",
        back.evidence
    );
}

#[tokio::test]
async fn a_secret_is_entered_by_request_id_and_only_its_fingerprint_is_kept() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    let call: fleetd_contracts::lead_calls::RequestSecretCall = serde_json::from_value(json!({
        "key": "stripe.test_key", "sink": "env:lab-a:/srv/app/.env", "text": "The Stripe test key",
    }))
    .unwrap();
    let open = a.request_secret(&p1(), call).await.unwrap();
    let item = serde_json::to_value(chat_item(&open)).unwrap();
    assert_eq!(
        (item["kind"].as_str(), item["requestId"].as_str()),
        (Some("secret_request"), Some("Q1"))
    );

    let refused = a
        .submit_secret(&agent(), "Q1", "sealed-bytes")
        .await
        .unwrap_err();
    assert_eq!(
        refused.code, "forbidden",
        "agent keys never handle secret values"
    );
    let saved = a
        .submit_secret(&person(), "Q1", "sealed-bytes")
        .await
        .unwrap();
    assert_eq!(saved["fingerprint"], "ab12cd34");
    assert_eq!(
        fake.secrets.lock().unwrap().as_slice(),
        [(
            "lab-a".to_string(),
            json!({ "sink": "env:lab-a:/srv/app/.env", "sealed": "sealed-bytes", "secretKey": "stripe.test_key" })
        )]
    );
    let stored = fake.request("Q1");
    assert_eq!(stored.state, RequestState::Stored);
    assert_eq!(
        stored.secret.unwrap().fingerprint.unwrap().as_str(),
        "ab12cd34"
    );
    assert_eq!(fake.woken.lock().unwrap().as_slice(), ["Q1 stored"]);
    let stored_text = serde_json::to_string(&fake.request("Q1")).unwrap();
    let events = serde_json::to_string(
        &*fake
            .events
            .lock()
            .unwrap()
            .iter()
            .map(|e| (e.summary.clone(), e.data.clone()))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    assert!(
        !stored_text.contains("sealed-bytes") && !events.contains("sealed-bytes"),
        "the ciphertext is never kept"
    );
    assert_eq!(
        a.submit_secret(&person(), "Q1", "again")
            .await
            .unwrap_err()
            .code,
        "invalid"
    );
}

/// An `order:` sink: only an open order of the project, on its machine, under a name an order may set; the node gets
/// the project with the box, and the hub records the variable's name, fingerprint and size for the order.
#[tokio::test]
async fn an_order_sink_reaches_that_orders_node_and_is_recorded_for_it() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    let ask = |sink: &str, env: Option<&str>| {
        let mut call = json!({ "key": "db.url", "sink": sink, "text": "W7's writer needs the staging database" });
        if let Some(env) = env {
            call["envName"] = env.into();
        }
        serde_json::from_value::<fleetd_contracts::lead_calls::RequestSecretCall>(call).unwrap()
    };
    for (sink, env) in [
        ("order:lab-b:W7", None),
        ("order:lab-a:W8", None),
        ("order:lab-a:W7", Some("CLAUDE_CODE_USE_BEDROCK")),
    ] {
        let refused = a.request_secret(&p1(), ask(sink, env)).await;
        assert!(refused.is_err(), "{sink} {env:?}");
    }
    let open = a
        .request_secret(&p1(), ask("order:lab-a:W7", None))
        .await
        .unwrap();
    assert_eq!(open.workstream_id.as_ref().map(|w| w.as_str()), Some("W7"));
    // 10 bytes sealed: 58 bytes of box.
    let sealed = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [7u8; 58]);
    a.submit_secret(&person(), open.request_id.as_str(), &sealed)
        .await
        .unwrap();
    assert_eq!(
        fake.secrets.lock().unwrap().as_slice(),
        [(
            "lab-a".to_string(),
            json!({ "sink": "order:lab-a:W7", "sealed": sealed, "secretKey": "db.url", "projectId": "p1" })
        )]
    );
    assert_eq!(
        fake.order_saved.lock().unwrap().as_slice(),
        [OrderEnvSaved {
            project: p1(),
            order_id: "W7".into(),
            name: "DB_URL".into(),
            fingerprint: "ab12cd34".into(),
            bytes: 10,
            request_id: open.request_id.to_string(),
        }]
    );
    assert_eq!(
        fake.request(open.request_id.as_str()).state,
        RequestState::Stored
    );
}

#[tokio::test]
async fn a_lead_withdraws_its_own_projects_requests_only() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.gated_run(&p1(), migration()).await.unwrap();
    let other = ProjectRef {
        machine_id: "lab-a".into(),
        project_id: "p2".into(),
    };
    assert_eq!(
        a.withdraw(&other, "lead:lab-a/p2", "Q1")
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    let done = a.withdraw(&p1(), "lead:lab-a/p1", "Q1").await.unwrap();
    assert_eq!(done.state, RequestState::Denied);
    assert_eq!(
        a.answer(&person(), "Q1", true, None)
            .await
            .unwrap_err()
            .code,
        "invalid"
    );
    assert!(fake.runs.lock().unwrap().is_empty());
}

#[tokio::test]
async fn after_a_restart_an_approved_command_goes_back_to_the_person_and_never_runs_late() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.gated_run(&p1(), migration()).await.unwrap();
    a.gated_run(&p1(), migration()).await.unwrap();
    for (id, evidence) in [
        ("Q1", None),
        ("Q2", Some("running on lab-a, approved by human:desk")),
    ] {
        fake.requests
            .update(&ChatRequestId::unchecked(id), |r| {
                r.state = RequestState::Approved;
                r.evidence = evidence.map(fleetd_contracts::prim::Text::unchecked);
            })
            .unwrap();
    }
    a.reopen_unfinished().await;
    assert_eq!(fake.request("Q1").state, RequestState::Open);
    assert_eq!(
        fake.request("Q1").evidence.unwrap().as_str(),
        NOT_RUN_AFTER_RESTART
    );
    assert!(
        fake.request("Q2")
            .evidence
            .unwrap()
            .as_str()
            .starts_with("result unknown: the hub restarted while it ran on lab-a")
    );
    assert!(fake.runs.lock().unwrap().is_empty());
}

/// Two people answer the same approval at once: exactly one answer counts, and the command runs once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_answers_at_once_run_the_command_once() {
    for _ in 0..20 {
        let fake = Arc::new(Fake::default());
        let a = approvals(&fake);
        a.gated_run(&p1(), migration()).await.unwrap();
        let (one, two) = tokio::join!(
            {
                let a = a.clone();
                tokio::spawn(async move { a.answer(&person(), "Q1", true, None).await })
            },
            {
                let a = a.clone();
                tokio::spawn(async move { a.answer(&person(), "Q1", true, None).await })
            },
        );
        let results = [one.unwrap(), two.unwrap()];
        assert_eq!(
            results.iter().filter(|r| r.is_ok()).count(),
            1,
            "one answer counts"
        );
        let refused = results.iter().find_map(|r| r.as_ref().err()).unwrap();
        assert_eq!(refused.code, "invalid");
        fake.woken_times(1).await;
        assert_eq!(fake.runs.lock().unwrap().len(), 1, "the command runs once");
        assert_eq!(fake.request("Q1").state, RequestState::Ran);
    }
}

/// An approve racing a deny: whichever lands first decides, and a denied command never ran.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_approve_racing_a_deny_never_ends_denied_after_running() {
    for _ in 0..20 {
        let fake = Arc::new(Fake::default());
        let a = approvals(&fake);
        a.gated_run(&p1(), migration()).await.unwrap();
        let (go, no) = tokio::join!(
            {
                let a = a.clone();
                tokio::spawn(async move { a.answer(&person(), "Q1", true, None).await })
            },
            {
                let a = a.clone();
                tokio::spawn(async move { a.answer(&person(), "Q1", false, None).await })
            },
        );
        let (go, no) = (go.unwrap(), no.unwrap());
        assert!(go.is_ok() != no.is_ok(), "exactly one answer counts");
        fake.woken_times(1).await;
        let r = fake.request("Q1");
        if go.is_ok() {
            assert_eq!(
                (r.state, fake.runs.lock().unwrap().len()),
                (RequestState::Ran, 1)
            );
        } else {
            assert_eq!(
                (r.state, fake.runs.lock().unwrap().len()),
                (RequestState::Denied, 0)
            );
        }
    }
}

/// The store's guard itself: of many writers moving one open request, exactly one wins.
#[test]
fn only_one_guarded_write_moves_a_request() {
    let fake = Fake::default();
    let r = fake.stored();
    let requests = fake.requests.clone();
    let won: usize = std::thread::scope(|s| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (requests, id) = (requests.clone(), r.request_id.clone());
                s.spawn(move || {
                    requests
                        .update_from(&id, RequestState::Open, |r| {
                            r.state = RequestState::Approved
                        })
                        .is_ok() as usize
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).sum()
    });
    assert_eq!(won, 1);
    let moved = requests
        .update_from(&r.request_id, RequestState::Open, |r| {
            r.state = RequestState::Denied
        })
        .unwrap_err();
    assert_eq!(moved.to_string(), "Q1 is already approved");
}
