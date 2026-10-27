use super::*;
use crate::hub::store::HubDb;
use crate::hub::usage::ports::WaitPage;
use fleetd_contracts::events::HubEvent;
use fleetd_contracts::sessions::{PendingPermission, PermissionDecision};
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
    open_orders: Mutex<Vec<&'static str>>,
    /// The hub fails to record an order's variable.
    order_save_fails: Mutex<bool>,
    /// Each variable recorded for an order.
    order_saved: Mutex<Vec<OrderEnvSaved>>,
    /// Each preview setting saved for a project; a reason fails the save.
    previews_saved: Mutex<Vec<(ProjectRef, PreviewConfig)>>,
    preview_save_fails: Mutex<Option<String>>,
    /// Each permission answer the node took: machine, thread, prompt and decision.
    answers: Mutex<Vec<(String, String, String, PermissionDecision)>>,
    /// The node fails each answer with this.
    answer_fails: Mutex<Option<NodeCommandError>>,
    /// The prompt the thread waits on, as the machine stream has it.
    pending: Mutex<Option<PendingPermission>>,
    /// The project's MCP servers, for the integrations policy.
    servers: Mutex<Vec<fleetd_contracts::mcp_servers::McpServer>>,
    /// The project is a Navi whose lead is thread t1 (true by default), and the sites it may visit unasked, each with
    /// who allowed it.
    navi: Mutex<bool>,
    sites: Mutex<Vec<(String, String)>>,
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
            open_orders: Mutex::new(vec!["W7"]),
            order_save_fails: Mutex::new(false),
            order_saved: Mutex::default(),
            previews_saved: Mutex::default(),
            preview_save_fails: Mutex::default(),
            answers: Mutex::default(),
            answer_fails: Mutex::default(),
            pending: Mutex::default(),
            servers: Mutex::default(),
            navi: Mutex::new(true),
            sites: Mutex::default(),
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
                preview_config: None,
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
    fn answer_permission(
        &self,
        m: &str,
        t: &str,
        request_id: &str,
        decision: PermissionDecision,
        _by: Option<fleetd_contracts::time::DecidedBy>,
    ) -> BoxFut<'_, Result<(), NodeCommandError>> {
        let result = match self.answer_fails.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => {
                self.answers.lock().unwrap().push((
                    m.into(),
                    t.into(),
                    request_id.into(),
                    decision,
                ));
                Ok(())
            }
        };
        Box::pin(async move { result })
    }
    fn pending_permission(&self, _: &str, _: &str) -> BoxFut<'_, Option<PendingPermission>> {
        let p = self.pending.lock().unwrap().clone();
        Box::pin(async move { p })
    }
}

impl ApprovalHub for Fake {
    fn navi_lead(&self, _: &ProjectRef, thread_id: &str) -> BoxFut<'_, bool> {
        let lead = *self.navi.lock().unwrap() && thread_id == "t1";
        Box::pin(async move { lead })
    }
    fn navi_site(&self, _: &ProjectRef, site: Option<&str>) -> BoxFut<'_, Option<bool>> {
        let known = (*self.navi.lock().unwrap()).then(|| {
            site.is_some_and(|s| {
                self.sites
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(known, _)| known == s)
            })
        });
        Box::pin(async move { known })
    }
    fn navi_site_allow(&self, _: &ProjectRef, site: &str, by: &str) -> BoxFut<'_, ()> {
        self.sites.lock().unwrap().push((site.into(), by.into()));
        Box::pin(async {})
    }
    fn mcp_servers(
        &self,
        _: &ProjectRef,
    ) -> BoxFut<'_, Vec<fleetd_contracts::mcp_servers::McpServer>> {
        let servers = self.servers.lock().unwrap().clone();
        Box::pin(async move { servers })
    }
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
        let why = (!self.open_orders.lock().unwrap().contains(&order_id))
            .then(|| format!("{order_id} is closed."));
        Box::pin(async move { why })
    }
    fn order_env_saved(&self, saved: OrderEnvSaved) -> BoxFut<'_, Result<(), String>> {
        let result = if *self.order_save_fails.lock().unwrap() {
            Err("the hub could not record it, so the node dropped it again".to_owned())
        } else {
            self.order_saved.lock().unwrap().push(saved);
            Ok(())
        };
        Box::pin(async move { result })
    }
    fn preview_config_save(
        &self,
        project: &ProjectRef,
        config: &PreviewConfig,
    ) -> BoxFut<'_, Result<(), String>> {
        let result = match self.preview_save_fails.lock().unwrap().clone() {
            Some(why) => Err(why),
            None => {
                self.previews_saved
                    .lock()
                    .unwrap()
                    .push((project.clone(), config.clone()));
                Ok(())
            }
        };
        Box::pin(async move { result })
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
        person: None,
        allows_operate: ANYWHERE,
    }
}

fn agent() -> Caller<'static> {
    Caller {
        human: false,
        name: "lead-key",
        person: None,
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

    // A record the hub can't keep: refused, so the person enters it again; the request stays open.
    let again = a
        .request_secret(&p1(), ask("order:lab-a:W7", Some("API_KEY")))
        .await
        .unwrap();
    *fake.order_save_fails.lock().unwrap() = true;
    let refused = a
        .submit_secret(&person(), again.request_id.as_str(), &sealed)
        .await
        .unwrap_err();
    assert_eq!(refused.code, "failed");
    assert_eq!(
        fake.request(again.request_id.as_str()).state,
        RequestState::Open
    );
    *fake.order_save_fails.lock().unwrap() = false;

    // The order closed before the person entered it: nothing reaches the node.
    fake.open_orders.lock().unwrap().clear();
    let delivered = fake.secrets.lock().unwrap().len();
    let late = a
        .submit_secret(&person(), again.request_id.as_str(), &sealed)
        .await
        .unwrap_err();
    assert!(late.message.contains("W7 is closed"), "{late:?}");
    assert_eq!(fake.secrets.lock().unwrap().len(), delivered);
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
            .starts_with("interrupted, result unknown: the hub restarted while it ran on lab-a")
    );
    assert!(fake.runs.lock().unwrap().is_empty());
}

/// An update restarts the node while an approved command runs: the link drops, and the command goes back to the person
/// as interrupted with its result unknown. It never runs again by itself, not even once the node is back.
#[tokio::test]
async fn a_command_an_update_cut_off_is_reported_interrupted_and_never_run_again() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.gated_run(&p1(), migration()).await.unwrap();
    *fake.gated_reply.lock().unwrap() = Err(NodeCommandError {
        reason: "lost".into(),
        message: "the link to lab-a's node dropped while the command ran".into(),
        fix: None,
    });
    a.answer(&person(), "Q1", true, None).await.unwrap();
    fake.woken_times(1).await;
    let back = fake.request("Q1");
    assert_eq!(back.state, RequestState::Open);
    assert_eq!(
        back.evidence.as_ref().map(|e| e.as_str()),
        Some(
            "interrupted, result unknown: the link to lab-a's node dropped while the command ran; check on lab-a whether it ran \
             before approving it again"
        )
    );
    // The node is back (and the hub restarted too): nothing runs it again.
    *fake.linked.lock().unwrap() = true;
    a.reopen_unfinished().await;
    assert_eq!(
        fake.runs.lock().unwrap().len(),
        1,
        "it ran once, when it was approved"
    );
    assert_eq!(fake.request("Q1").state, RequestState::Open);
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

fn proposal() -> PreviewConfigProposeCall {
    serde_json::from_value(json!({
        "config": { "web": { "setup": ["pnpm install --frozen-lockfile"], "start": "pnpm preview --port $PORT" } },
        "why": "the shop is a Vite app",
    }))
    .unwrap()
}

/// An agent's proposed preview setting waits as an approval card holding it; only a person's Approve saves it, and the
/// lead hears it was saved. Denied, nothing is saved.
#[tokio::test]
async fn an_approved_preview_setting_is_saved_and_a_denied_one_never_is() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    let open = a.propose_preview(&p1(), proposal(), None).await.unwrap();
    assert_eq!(open.state, RequestState::Open);
    assert_eq!(
        open.text.as_str(),
        "Save how Try it runs this project: the shop is a Vite app"
    );
    let item = serde_json::to_value(chat_item(&open)).unwrap();
    assert_eq!(item["kind"], "command_approval");
    assert_eq!(
        item["previewConfig"]["config"]["web"]["start"],
        "pnpm preview --port $PORT"
    );
    assert!(item.get("gated").is_none());
    assert!(fake.previews_saved.lock().unwrap().is_empty());

    assert_eq!(
        a.answer(&agent(), "Q1", true, None).await.unwrap_err().code,
        "forbidden",
        "an agent never approves its own proposal"
    );
    let saved = a.answer(&person(), "Q1", true, None).await.unwrap();
    assert_eq!(saved.state, RequestState::Ran);
    assert_eq!(
        saved.evidence.as_ref().map(|e| e.as_str()),
        Some("saved as the project's preview setting, approved by human:desk")
    );
    assert_eq!(
        fake.previews_saved.lock().unwrap().as_slice(),
        [(p1(), proposal().config)]
    );
    assert!(
        fake.runs.lock().unwrap().is_empty(),
        "nothing runs on the node"
    );
    assert_eq!(fake.woken.lock().unwrap().as_slice(), ["Q1 ran"]);

    a.propose_preview(&p1(), proposal(), None).await.unwrap();
    let denied = a
        .answer(&person(), "Q2", false, Some("not yet".into()))
        .await
        .unwrap();
    assert_eq!(denied.state, RequestState::Denied);
    assert_eq!(fake.previews_saved.lock().unwrap().len(), 1);

    *fake.preview_save_fails.lock().unwrap() = Some("the project is gone".into());
    a.propose_preview(&p1(), proposal(), None).await.unwrap();
    let failed = a.answer(&person(), "Q3", true, None).await.unwrap();
    assert_eq!(
        (failed.state, failed.evidence.as_ref().map(|e| e.as_str())),
        (RequestState::Failed, Some("not saved: the project is gone"))
    );
}

/// Teams: an approval and a secret record the person who answered, next to their device.
#[tokio::test]
async fn an_approval_and_a_secret_record_the_person_who_answered() {
    let alice = fleetd_contracts::people::PersonRef {
        person_id: fleetd_contracts::people::PersonId::unchecked("p_alice234"),
        name: fleetd_contracts::people::PersonName::unchecked("Alice"),
    };
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    let alices = Caller {
        person: Some(&alice),
        ..person()
    };
    a.gated_run(&p1(), migration()).await.unwrap();
    let approved = a.answer(&alices, "Q1", true, None).await.unwrap();
    assert_eq!(approved.answered_by.as_deref(), Some("human:desk"));
    assert_eq!(approved.answered_by_person.as_ref(), Some(&alice));

    let call: fleetd_contracts::lead_calls::RequestSecretCall = serde_json::from_value(json!({
        "key": "stripe.test_key", "sink": "env:lab-a:/srv/app/.env", "text": "The Stripe test key",
    }))
    .unwrap();
    let open = a.request_secret(&p1(), call).await.unwrap();
    a.submit_secret(&alices, open.request_id.as_str(), "sealed-bytes")
        .await
        .unwrap();
    let saved = fake.request(open.request_id.as_str());
    assert_eq!(saved.answered_by_person.as_ref(), Some(&alice));
}

fn prompt(request_id: &str, tool: &str, summary: &str) -> Value {
    json!({ "requestId": request_id, "toolName": tool, "summary": summary })
}

fn event(kind: &str, permission: Option<Value>) -> HubEvent {
    let mut data = json!({ "status": "waiting" });
    if let Some(p) = permission {
        data["permission"] = p;
    }
    serde_json::from_value(json!({
        "seq": 7, "at": "2026-10-27T10:00:00.000Z", "type": kind, "machineId": "lab-a", "projectId": "p1",
        "threadId": "t1", "summary": "", "data": data,
    }))
    .unwrap()
}

fn requests(fake: &Fake) -> Vec<HumanRequest> {
    fake.requests
        .list(&RequestFilter {
            limit: 10,
            ..Default::default()
        })
        .unwrap()
}

/// A Navi's email send: what the approval shows is what runs once approved.
fn send_input() -> Value {
    json!({ "to": ["ana@example.com"], "subject": "Saturday", "body": "Could we book a cleaning?" })
}

/// A Navi with Google connected, as the integrations policy reads it.
fn google() -> fleetd_contracts::mcp_servers::McpServer {
    let mut s: fleetd_contracts::mcp_servers::McpServer = serde_json::from_value(json!({
        "scope": { "kind": "project", "machineId": "lab-a", "projectId": "p1" },
        "name": "google", "enabled": true,
        "roles": { "lead": true, "writers": false, "reviewers": false },
        "transport": { "type": "http", "url": "http://127.0.0.1:8787/mcp" },
        "updatedAt": "2026-10-27T00:00:00Z"
    }))
    .unwrap();
    s.integration = Some(fleetd_contracts::integrations::McpIntegration {
        kind: fleetd_contracts::integrations::IntegrationKind::Google,
        read_tools: fleetd_contracts::prim::List::new(vec![]).unwrap(),
    });
    s
}

fn pending_with(request_id: &str, tool: &str, input: Option<Value>) -> PendingPermission {
    let mut p = prompt(request_id, tool, "a call");
    if let Some(input) = input {
        p["input"] = input;
    }
    serde_json::from_value(p).unwrap()
}

#[tokio::test]
async fn a_prompt_becomes_one_approval_and_approve_runs_the_tool_with_exactly_the_input_shown() {
    let fake = Arc::new(Fake::default());
    *fake.servers.lock().unwrap() = vec![google()];
    let a = approvals(&fake);
    let tool = "mcp__google__send_message";
    *fake.pending.lock().unwrap() = Some(
        serde_json::from_value(json!({
            "requestId": "q1", "toolName": tool, "summary": "send to ana@example.com", "input": send_input(),
        }))
        .unwrap(),
    );
    let waiting = event(
        "thread.waiting",
        Some(prompt("q1", tool, "send to ana@example.com")),
    );
    a.on_thread_event(&waiting).await;
    a.on_thread_event(&waiting).await;
    let open = requests(&fake);
    assert_eq!(open.len(), 1, "the same prompt is filed once");
    let r = &open[0];
    assert_eq!(
        (r.kind, r.state, r.text.as_str()),
        (
            RequestKind::Approval,
            RequestState::Open,
            "mcp__google__send_message: send to ana@example.com"
        )
    );
    let permission = serde_json::to_value(&r.permission).unwrap();
    assert_eq!(
        (
            &permission["threadId"],
            &permission["requestId"],
            &permission["toolName"],
            &permission["input"]
        ),
        (&json!("t1"), &json!("q1"), &json!(tool), &send_input())
    );
    // The integration's card: every recipient, the subject and the body.
    assert_eq!(permission["preview"]["to"], json!(["ana@example.com"]));
    assert_eq!(permission["preview"]["subject"], "Saturday");
    assert_eq!(permission["preview"]["body"], "Could we book a cleaning?");
    // The chat shows it like a gated command, with the tool, its input and the card.
    let item = serde_json::to_value(chat_item(r)).unwrap();
    assert_eq!(item["kind"], "command_approval");
    assert_eq!(item["permission"]["input"], send_input());
    assert_eq!(item["permission"]["preview"]["title"], "Send an email");
    assert!(
        fake.answers.lock().unwrap().is_empty(),
        "nothing is answered for the person"
    );

    // Only a person answers it.
    assert!(a.answer(&agent(), "Q1", true, None).await.is_err());
    a.answer(&person(), "Q1", true, None).await.unwrap();
    assert_eq!(
        fake.answers.lock().unwrap().as_slice(),
        [(
            "lab-a".into(),
            "t1".into(),
            "q1".into(),
            PermissionDecision::Allow {
                updated_input: Some(send_input())
            }
        )]
    );
    assert_eq!(
        fake.request("Q1").evidence.unwrap().as_str(),
        "allowed on lab-a, answered by human:desk"
    );
    assert!(
        fake.runs.lock().unwrap().is_empty(),
        "a tool prompt never runs a gated command"
    );
    assert!(
        fake.woken.lock().unwrap().is_empty(),
        "the run itself goes on: no wake"
    );
}

#[tokio::test]
async fn deny_tells_the_run_who_said_no_and_an_undelivered_approve_goes_back_to_the_person() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    bash(&a, &fake, "q1", "rm -rf ~/Mail").await;
    a.answer(&person(), "Q1", false, Some("not my mail".into()))
        .await
        .unwrap();
    let answers = fake.answers.lock().unwrap().clone();
    let PermissionDecision::Deny { message } = &answers[0].3 else {
        panic!("{answers:?}")
    };
    assert_eq!(message.as_str(), "human:desk said no (Q1): not my mail");
    assert_eq!(fake.request("Q1").state, RequestState::Denied);

    // The node is offline when the person approves: nothing ran, so it is theirs to approve again.
    bash(&a, &fake, "q2", "ls").await;
    *fake.answer_fails.lock().unwrap() = Some(NodeCommandError {
        reason: "offline".into(),
        message: "lab-a is offline".into(),
        fix: None,
    });
    a.answer(&person(), "Q2", true, None).await.unwrap();
    let q2 = fake.request("Q2");
    assert_eq!(q2.state, RequestState::Open);
    assert!(q2.evidence.unwrap().as_str().starts_with("not delivered"));
}

#[tokio::test]
async fn a_prompt_that_goes_away_closes_its_request() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    bash(&a, &fake, "q1", "ls").await;
    // A second prompt in the same run: the first was answered elsewhere.
    bash(&a, &fake, "q2", "pwd").await;
    assert_eq!(fake.request("Q1").state, RequestState::Denied);
    assert_eq!(fake.request("Q2").state, RequestState::Open);
    // The run ends.
    a.on_thread_event(&event("thread.interrupted", None)).await;
    let q2 = fake.request("Q2");
    assert_eq!(q2.state, RequestState::Denied);
    assert_eq!(q2.evidence.unwrap().as_str(), "expired: the run ended");
    assert!(fake.answers.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_integrations_read_runs_unasked_and_a_blocked_or_unshowable_call_is_refused_with_nothing_filed()
 {
    let fake = Arc::new(Fake::default());
    *fake.servers.lock().unwrap() = vec![google()];
    let a = approvals(&fake);
    for (id, tool, input) in [
        (
            "q1",
            "mcp__google__search_threads",
            Some(json!({ "query": "dentist" })),
        ),
        (
            "q2",
            "mcp__google__send_money",
            Some(json!({ "to": "bo@example.com", "amount": 50 })),
        ),
        // The node sent no input: the card could not show what approving it sends.
        ("q3", "mcp__google__send_message", None),
    ] {
        *fake.pending.lock().unwrap() = Some(pending_with(id, tool, input));
        a.on_thread_event(&event("thread.waiting", Some(prompt(id, tool, "a call"))))
            .await;
    }
    assert!(requests(&fake).is_empty(), "nothing asks the person");
    let answers = fake.answers.lock().unwrap().clone();
    assert_eq!(answers.len(), 3);
    assert_eq!(
        answers[0].3,
        PermissionDecision::Allow {
            updated_input: None
        }
    );
    for (_, _, id, decision) in &answers[1..] {
        let PermissionDecision::Deny { message } = decision else {
            panic!("{id}: {decision:?}")
        };
        assert!(
            message.as_str().starts_with("Blocked by fleetd"),
            "{id}: {}",
            message.as_str()
        );
    }
}

/// A command prompt on the Navi's lead, its input as the node sends it.
async fn bash(a: &Approvals, fake: &Fake, id: &str, command: &str) {
    *fake.pending.lock().unwrap() = Some(pending_with(
        id,
        "Bash",
        Some(json!({ "command": command })),
    ));
    a.on_thread_event(&event("thread.waiting", Some(prompt(id, "Bash", command))))
        .await;
}

fn fetch(id: &str, url: &str) -> (HubEvent, PendingPermission) {
    let input = json!({ "url": url, "prompt": "the opening hours" });
    (
        event("thread.waiting", Some(prompt(id, "WebFetch", url))),
        pending_with(id, "WebFetch", Some(input)),
    )
}

async fn prompted(a: &Approvals, fake: &Fake, (event, pending): (HubEvent, PendingPermission)) {
    *fake.pending.lock().unwrap() = Some(pending);
    a.on_thread_event(&event).await;
}

/// A Navi's first fetch to a site asks the person; approving it allows the site, so the next fetch there goes through
/// unasked; a site they revoke asks again.
#[tokio::test]
async fn a_navis_first_visit_to_a_site_asks_and_its_approval_allows_the_site() {
    let fake = Arc::new(Fake::default());
    *fake.navi.lock().unwrap() = true;
    let a = approvals(&fake);
    prompted(&a, &fake, fetch("q1", "https://www.dentist.example/hours")).await;
    let open = requests(&fake);
    assert_eq!(open.len(), 1, "the first visit asks");
    let permission = open[0].permission.as_ref().unwrap();
    assert_eq!(permission.site.as_deref(), Some("dentist.example"));
    let item = serde_json::to_value(chat_item(&open[0])).unwrap();
    assert_eq!(item["permission"]["site"], "dentist.example");
    a.answer(&person(), "Q1", true, None).await.unwrap();
    assert_eq!(
        fake.sites.lock().unwrap().as_slice(),
        [("dentist.example".to_owned(), "human:desk".to_owned())]
    );
    assert_eq!(fake.answers.lock().unwrap().len(), 1);

    // The same site again, another page: allowed at once, nothing filed.
    prompted(&a, &fake, fetch("q2", "https://dentist.example/book")).await;
    assert_eq!(requests(&fake).len(), 1, "a second visit doesn't ask");
    let answers = fake.answers.lock().unwrap().clone();
    assert_eq!(
        (answers[1].2.as_str(), &answers[1].3),
        (
            "q2",
            &PermissionDecision::Allow {
                updated_input: None
            }
        )
    );

    // Another site asks; a denied first visit allows nothing.
    prompted(&a, &fake, fetch("q3", "https://elsewhere.example/")).await;
    a.answer(&person(), "Q2", false, None).await.unwrap();
    assert_eq!(fake.sites.lock().unwrap().len(), 1);

    // Revoked: the next visit asks again.
    fake.sites.lock().unwrap().clear();
    prompted(&a, &fake, fetch("q4", "https://dentist.example/book")).await;
    let open = requests(&fake);
    assert_eq!(open.len(), 3);
    assert_eq!(
        open.iter()
            .filter(|r| r.state == RequestState::Open)
            .count(),
        1
    );
}

/// A browser visit goes through the same gate; the relay answers a Navi lead's prompts only.
#[tokio::test]
async fn a_browser_open_is_a_visit_and_any_other_sessions_prompt_is_left_alone() {
    let fake = Arc::new(Fake::default());
    *fake.navi.lock().unwrap() = true;
    fake.sites
        .lock()
        .unwrap()
        .push(("bank.example".into(), "human:desk".into()));
    let a = approvals(&fake);
    let open = |id: &str, command: &str| {
        (
            event("thread.waiting", Some(prompt(id, "Bash", command))),
            pending_with(id, "Bash", Some(json!({ "command": command }))),
        )
    };
    prompted(
        &a,
        &fake,
        open("q1", "agent-browser open https://bank.example/login"),
    )
    .await;
    assert!(requests(&fake).is_empty(), "an allowed site opens unasked");
    // A command that does more than open a page asks each time, with no site to remember.
    prompted(
        &a,
        &fake,
        open(
            "q2",
            "agent-browser open https://bank.example && curl https://x.example",
        ),
    )
    .await;
    let filed = requests(&fake);
    assert_eq!(
        (
            filed.len(),
            filed[0].permission.as_ref().unwrap().site.as_deref()
        ),
        (1, None)
    );

    // Any other session's prompt is left alone: the relay is a Navi lead's.
    *fake.navi.lock().unwrap() = false;
    prompted(&a, &fake, fetch("q3", "https://docs.example/")).await;
    assert_eq!(requests(&fake).len(), 1);
    assert_eq!(
        fake.answers.lock().unwrap().len(),
        1,
        "only the allowed site's open"
    );
}

/// A prompt whose input the node didn't send (over 64 KiB) can't be shown, so it is refused rather than approved blind.
#[tokio::test]
async fn a_prompt_whose_input_cant_be_shown_is_refused() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.on_thread_event(&event(
        "thread.waiting",
        Some(prompt("q1", "Bash", "a long command")),
    ))
    .await;
    assert!(requests(&fake).is_empty());
    let answers = fake.answers.lock().unwrap().clone();
    let PermissionDecision::Deny { message } = &answers[0].3 else {
        panic!("{answers:?}")
    };
    assert!(
        message.as_str().starts_with("Blocked by fleetd"),
        "{}",
        message.as_str()
    );
}

/// A Navi's server of `kind`, named `name`, with the tools the person marked as reads.
fn integration(name: &str, kind: &str, reads: &[&str]) -> fleetd_contracts::mcp_servers::McpServer {
    serde_json::from_value(json!({
        "scope": { "kind": "project", "machineId": "lab-a", "projectId": "p1" },
        "name": name, "enabled": true,
        "roles": { "lead": true, "writers": false, "reviewers": false },
        "transport": { "type": "http", "url": "https://mcp.example.com/mcp" },
        "integration": { "kind": kind, "readTools": reads },
        "updatedAt": "2026-10-27T00:00:00Z"
    }))
    .unwrap()
}

#[tokio::test]
async fn through_the_relay_notion_custom_servers_and_attachments_get_their_policy_and_approve_runs_the_real_bytes()
 {
    use base64::Engine;
    let fake = Arc::new(Fake::default());
    *fake.servers.lock().unwrap() = vec![
        google(),
        integration("notion", "notion", &[]),
        integration("crm", "custom", &["list_contacts"]),
    ];
    let a = approvals(&fake);
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let photo = b64(&[0u8, 1, 2, 3, 255, 254, 7, 8].repeat(500));
    let mail = |content: &str, name: &str| {
        json!({ "account": "me@example.com", "to": ["ana@example.com"], "bcc": ["sam@example.com"],
            "subject": "Lease", "body": "Attached.",
            "attachments": [{ "content_base64": content, "filename": name }] })
    };
    let notes = b64(b"tenant notes\ntoken = ghp_abcdefghijklmnopqrstuvwxyz0123\n");
    for (id, tool, input) in [
        // A custom server's tool the person marked as a read: unasked.
        ("q1", "mcp__crm__list_contacts", json!({})),
        // Its money tool: blocked, whatever was marked.
        ("q2", "mcp__crm__transfer_funds", json!({ "amount": 50 })),
        // A Notion page to the trash: asks as a delete.
        (
            "q3",
            "mcp__notion__API-patch-page",
            json!({ "page_id": "p9", "archived": true }),
        ),
        // A text file holding a key: refused.
        ("q4", "mcp__google__send_message", mail(&notes, "notes.txt")),
        // A binary file: asks, shown by name and size.
        ("q5", "mcp__google__send_message", mail(&photo, "photo.jpg")),
    ] {
        *fake.pending.lock().unwrap() = Some(pending_with(id, tool, Some(input)));
        a.on_thread_event(&event("thread.waiting", Some(prompt(id, tool, "a call"))))
            .await;
    }
    let answers = fake.answers.lock().unwrap().clone();
    let decided: Vec<(&str, &PermissionDecision)> = answers
        .iter()
        .map(|(_, _, id, d)| (id.as_str(), d))
        .collect();
    assert_eq!(decided.len(), 3, "{decided:?}");
    assert_eq!(
        decided[0],
        (
            "q1",
            &PermissionDecision::Allow {
                updated_input: None
            }
        )
    );
    for (id, why) in [("q2", "moves money"), ("q4", "password, key or token")] {
        let (_, PermissionDecision::Deny { message }) =
            decided.iter().find(|(i, _)| *i == id).unwrap()
        else {
            panic!("{id} wasn't denied")
        };
        assert!(message.as_str().contains(why), "{id}: {}", message.as_str());
    }

    // Two cards wait for the person: the Notion delete, and the email with its photo.
    let open = requests(&fake);
    assert_eq!(open.len(), 2);
    let card =
        |r: &HumanRequest| serde_json::to_value(&r.permission.as_ref().unwrap().preview).unwrap();
    let trash = open
        .iter()
        .find(|r| r.permission.as_ref().unwrap().request_id == "q3")
        .unwrap();
    assert_eq!(card(trash)["action"], "delete");
    assert_eq!(card(trash)["title"], "Move a Notion page to the trash");
    let send = open
        .iter()
        .find(|r| r.permission.as_ref().unwrap().request_id == "q5")
        .unwrap();
    let preview = card(send);
    assert_eq!(preview["account"], "me@example.com");
    assert_eq!(preview["bcc"], json!(["sam@example.com"]));
    assert_eq!(
        preview["attachments"],
        json!([{ "name": "photo.jpg", "bytes": 4000 }])
    );
    assert!(
        preview["input"]
            .as_str()
            .unwrap()
            .contains("[the file's 4000 bytes]")
    );

    // Approved, the send runs with the real bytes, not the card's summary of them.
    a.answer(&person(), send.request_id.as_str(), true, None)
        .await
        .unwrap();
    let answers = fake.answers.lock().unwrap().clone();
    assert_eq!(
        answers.last().unwrap().3,
        PermissionDecision::Allow {
            updated_input: Some(mail(&photo, "photo.jpg"))
        }
    );
}
