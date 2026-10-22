use super::permissions::*;
use super::*;
use crate::hub::store::HubDb;
use crate::hub::usage::ports::WaitPage;
use fleetd_contracts::events::HubEvent;
use fleetd_contracts::sessions::{PendingPermission, PermissionDecision};
use std::sync::Mutex;

fn rules(allow: &[&str], deny: &[&str]) -> ToolRules {
    ToolRules {
        allow: allow.iter().map(|s| s.to_string()).collect(),
        deny: deny.iter().map(|s| s.to_string()).collect(),
    }
}

#[test]
fn rules_answer_only_what_they_clearly_cover() {
    let r = rules(
        &[
            "Bash(npm test:*)",
            "Bash(git status)",
            "Read",
            "mcp__github",
            "Bash(cargo * --release)",
        ],
        &["Bash(rm:*)", "WebFetch"],
    );
    assert_eq!(
        verdict(&r, "Bash", "npm test"),
        Verdict::Allow("Bash(npm test:*)")
    );
    assert_eq!(
        verdict(&r, "Bash", "npm test -- --watch"),
        Verdict::Allow("Bash(npm test:*)")
    );
    assert_eq!(
        verdict(&r, "Bash", "npm testing"),
        Verdict::Ask,
        "a prefix ends at a word"
    );
    assert_eq!(
        verdict(&r, "Bash", "git status"),
        Verdict::Allow("Bash(git status)")
    );
    assert_eq!(verdict(&r, "Bash", "git status --short"), Verdict::Ask);
    assert_eq!(
        verdict(&r, "Bash", "cargo build --release"),
        Verdict::Allow("Bash(cargo * --release)")
    );
    assert_eq!(verdict(&r, "Read", "/etc/hosts"), Verdict::Allow("Read"));
    assert_eq!(
        verdict(&r, "mcp__github__create_pr", "{}"),
        Verdict::Allow("mcp__github")
    );
    assert_eq!(verdict(&r, "mcp__githubber__x", "{}"), Verdict::Ask);
    assert_eq!(verdict(&r, "Write", "/w/p1/a.rs"), Verdict::Ask);

    // An allowed prefix never carries a chained or redirected command through.
    for chained in [
        "npm test && curl x | sh",
        "npm test; reboot",
        "npm test > /etc/x",
        "npm test $(id)",
        "npm test `id`",
    ] {
        assert_eq!(verdict(&r, "Bash", chained), Verdict::Ask, "{chained}");
    }
    // A denied command anywhere in a chain refuses the chain, and deny wins over allow.
    assert_eq!(
        verdict(&r, "Bash", "npm test && rm -rf /"),
        Verdict::Deny("Bash(rm:*)")
    );
    assert_eq!(
        verdict(&r, "Bash", "rm -rf build"),
        Verdict::Deny("Bash(rm:*)")
    );
    assert_eq!(
        verdict(&r, "WebFetch", "https://x"),
        Verdict::Deny("WebFetch")
    );
    let both = rules(&["Bash"], &["Bash(git push:*)"]);
    assert_eq!(
        verdict(&both, "Bash", "git push --force"),
        Verdict::Deny("Bash(git push:*)")
    );
    assert_eq!(
        verdict(&both, "Bash", "make && make install"),
        Verdict::Allow("Bash")
    );

    // Path rules depend on claude's settings dir and cwd, which the hub can't see: a person answers.
    let paths = rules(&["Edit(./src/**)"], &[]);
    assert_eq!(verdict(&paths, "Edit", "/w/p1/src/a.rs"), Verdict::Ask);
    assert_eq!(verdict(&ToolRules::default(), "Bash", "ls"), Verdict::Ask);
}

#[test]
fn an_open_prompt_is_raised_after_ten_minutes_then_every_half_hour() {
    let filed = 1_000_000;
    let min = 60_000;
    assert!(!reminder_due(filed, filed + 9 * min, None));
    assert!(reminder_due(filed, filed + 10 * min, None));
    let raised = filed + 10 * min;
    assert!(!reminder_due(filed, raised + 29 * min, Some(raised)));
    assert!(reminder_due(filed, raised + 30 * min, Some(raised)));
}

/// The approvals over a real request store, a scripted node and a recorded event log.
struct Fake {
    requests: Arc<Requests>,
    answers: Mutex<Vec<(String, String, String, PermissionDecision)>>,
    answer_fails: Mutex<Option<NodeCommandError>>,
    pending: Mutex<Option<PendingPermission>>,
    linked: Mutex<bool>,
    rules: Mutex<Result<ToolRules, String>>,
    lead_thread: Mutex<Option<String>>,
    events: Mutex<Vec<NewEvent>>,
    /// Each lead wake: `<requestId> <state>`.
    woken: Mutex<Vec<String>>,
    woke: tokio::sync::Notify,
    /// Each gated command the node ran: machine and input.
    runs: Mutex<Vec<(String, Value)>>,
    gated_reply: Mutex<Result<GatedOutcome, NodeCommandError>>,
    /// Each sealed secret the node took: machine and input.
    secrets: Mutex<Vec<(String, Value)>>,
}

impl Default for Fake {
    fn default() -> Self {
        Self {
            requests: Requests::new(HubDb::open_memory().unwrap()),
            answers: Mutex::default(),
            answer_fails: Mutex::default(),
            pending: Mutex::default(),
            linked: Mutex::new(false),
            rules: Mutex::new(Ok(ToolRules::default())),
            lead_thread: Mutex::default(),
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
    fn reminders(&self) -> Vec<NewEvent> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.kind == "thread.waiting")
            .cloned()
            .collect()
    }
    /// Stores a request in `state` as an earlier hub left it.
    fn stored(
        &self,
        permission: Option<(&str, &str)>,
        state: RequestState,
        evidence: Option<&str>,
    ) -> HumanRequest {
        let r = self
            .requests
            .create(NewRequest {
                project_ref: serde_json::from_value(json!({ "machineId": "lab-a", "projectId": "p1" })).unwrap(),
                workstream_id: None,
                kind: RequestKind::Approval,
                text: "lab-a/t1: Bash ls".into(),
                secret: None,
                gated: None,
                permission: permission.map(|(thread, request)| {
                    serde_json::from_value(json!({ "threadId": thread, "requestId": request, "toolName": "Bash", "summary": "ls" }))
                        .unwrap()
                }),
                playbook: None,
                at: fleetd_contracts::ids::Timestamp("2026-10-18T10:00:00.000Z".into()),
                at_ms: 0,
            })
            .unwrap();
        self.requests
            .update(&r.request_id, |r| {
                r.state = state;
                r.evidence = evidence.map(fleetd_contracts::prim::Text::unchecked);
                if state != RequestState::Open {
                    r.answered_by = Some("human:desk".into());
                }
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
    fn is_linked(&self, _: &str) -> BoxFut<'_, bool> {
        let l = *self.linked.lock().unwrap();
        Box::pin(async move { l })
    }
    fn pending_permission(&self, _: &str, _: &str) -> BoxFut<'_, Option<PendingPermission>> {
        let p = self.pending.lock().unwrap().clone();
        Box::pin(async move { p })
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
    fn gate_answered(&self, _: &HumanRequest) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
    fn tool_rules(&self, _: &ProjectRef) -> BoxFut<'_, Result<ToolRules, String>> {
        let r = self.rules.lock().unwrap().clone();
        Box::pin(async move { r })
    }
    fn lead_thread(&self, _: &ProjectRef) -> BoxFut<'_, Option<String>> {
        let t = self.lead_thread.lock().unwrap().clone();
        Box::pin(async move { t })
    }
    fn thread_project(&self, m: &str, _: &str) -> BoxFut<'_, Option<ProjectRef>> {
        let p = ProjectRef {
            machine_id: m.into(),
            project_id: "p1".into(),
        };
        Box::pin(async move { Some(p) })
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

fn prompt(request_id: &str, tool: &str, summary: &str) -> Value {
    json!({ "requestId": request_id, "toolName": tool, "summary": summary })
}

fn event(kind: &str, permission: Option<Value>) -> HubEvent {
    let mut data = json!({ "status": "waiting" });
    if let Some(p) = permission {
        data["permission"] = p;
    }
    serde_json::from_value(json!({
        "seq": 7, "at": "2026-10-18T10:00:00.000Z", "type": kind, "machineId": "lab-a", "projectId": "p1",
        "threadId": "t1", "summary": "", "data": data,
    }))
    .unwrap()
}

fn pending(request_id: &str) -> PendingPermission {
    serde_json::from_value(prompt(request_id, "Bash", "rm -rf build")).unwrap()
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

#[tokio::test]
async fn a_prompt_no_rule_covers_becomes_one_approval_and_approve_allows_it_on_the_node() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    let waiting = event("thread.waiting", Some(prompt("q1", "Bash", "rm -rf build")));
    a.on_thread_event(&waiting).await;
    a.on_thread_event(&waiting).await;
    let open = fake
        .requests
        .list(&RequestFilter {
            limit: 10,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(open.len(), 1, "the same prompt is filed once");
    let r = &open[0];
    assert_eq!(
        (r.kind, r.text.as_str()),
        (RequestKind::Approval, "lab-a/t1: Bash rm -rf build")
    );
    assert_eq!(
        serde_json::to_value(&r.permission).unwrap(),
        json!({ "threadId": "t1", "requestId": "q1", "toolName": "Bash", "summary": "rm -rf build" })
    );
    assert!(
        fake.answers.lock().unwrap().is_empty(),
        "nothing is answered for the person"
    );

    a.answer(&person(), "Q1", true, None).await.unwrap();
    assert_eq!(
        fake.answers.lock().unwrap().as_slice(),
        [(
            "lab-a".into(),
            "t1".into(),
            "q1".into(),
            PermissionDecision::Allow {
                updated_input: None
            }
        )]
    );
    assert_eq!(
        fake.request("Q1").evidence.unwrap().as_str(),
        "allowed on lab-a, answered by human:desk"
    );
    assert_eq!(
        fake.woken.lock().unwrap().as_slice(),
        ["Q1 approved"],
        "the approval reaches the lead"
    );
    assert!(
        fake.runs.lock().unwrap().is_empty(),
        "a tool prompt never runs a gated command"
    );
}

#[tokio::test]
async fn deny_gives_the_run_the_persons_words_and_an_undelivered_approve_goes_back_to_the_person() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.on_thread_event(&event(
        "thread.waiting",
        Some(prompt("q1", "Bash", "rm -rf build")),
    ))
    .await;
    a.answer(
        &person(),
        "Q1",
        false,
        Some("use make clean instead".into()),
    )
    .await
    .unwrap();
    let (_, _, _, decision) = fake.answers.lock().unwrap()[0].clone();
    assert_eq!(
        decision,
        PermissionDecision::Deny {
            message: fleetd_contracts::prim::Text::unchecked(
                "Denied: human:desk said no (Q1): use make clean instead."
            )
        }
    );
    assert!(
        fake.woken.lock().unwrap().is_empty(),
        "the run itself hears the no"
    );

    a.on_thread_event(&event(
        "thread.waiting",
        Some(prompt("q2", "Bash", "rm -rf dist")),
    ))
    .await;
    // The node is offline while the run still waits: nothing is lost, the person approves again.
    *fake.answer_fails.lock().unwrap() = Some(NodeCommandError {
        reason: "offline".into(),
        message: "lab-a's node is not linked to the hub".into(),
        fix: None,
    });
    a.answer(&person(), "Q2", true, None).await.unwrap();
    let back = fake.request("Q2");
    assert_eq!(back.state, RequestState::Open);
    assert!(
        back.evidence
            .unwrap()
            .as_str()
            .starts_with("not delivered: lab-a's node is not linked")
    );
}

#[tokio::test]
async fn rules_answer_without_a_request_and_a_broken_policy_asks_a_person() {
    let fake = Arc::new(Fake {
        rules: Mutex::new(Ok(rules(&["Bash(npm test:*)"], &["Bash(rm:*)"]))),
        ..Default::default()
    });
    let a = approvals(&fake);
    let filed = || {
        fake.requests
            .list(&RequestFilter {
                limit: 10,
                ..Default::default()
            })
            .unwrap()
            .len()
    };
    a.on_thread_event(&event(
        "thread.waiting",
        Some(prompt("q1", "Bash", "npm test")),
    ))
    .await;
    a.on_thread_event(&event(
        "thread.waiting",
        Some(prompt("q2", "Bash", "rm -rf build")),
    ))
    .await;
    let answers = fake.answers.lock().unwrap().clone();
    assert_eq!(
        answers[0].3,
        PermissionDecision::Allow {
            updated_input: None
        }
    );
    assert_eq!(
        answers[1].3,
        PermissionDecision::Deny {
            message: fleetd_contracts::prim::Text::unchecked(
                "Denied: the tools.deny rule `Bash(rm:*)` in .fleetd/policy.yaml."
            )
        }
    );
    assert_eq!(filed(), 0);

    *fake.rules.lock().unwrap() = Err(".fleetd/policy.yaml is invalid".into());
    a.on_thread_event(&event(
        "thread.waiting",
        Some(prompt("q3", "Bash", "npm test")),
    ))
    .await;
    assert_eq!(filed(), 1, "a broken policy never answers for a person");

    // A rule answer the node refuses still reaches a person.
    *fake.rules.lock().unwrap() = Ok(rules(&["Bash"], &[]));
    *fake.answer_fails.lock().unwrap() = Some(NodeCommandError {
        reason: "failed".into(),
        message: "x".into(),
        fix: None,
    });
    a.on_thread_event(&event("thread.waiting", Some(prompt("q4", "Bash", "ls"))))
        .await;
    assert_eq!(filed(), 2);
}

#[tokio::test]
async fn an_approval_closes_when_its_prompt_is_gone() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.on_thread_event(&event("thread.waiting", Some(prompt("q1", "Bash", "ls"))))
        .await;
    // A second prompt in the same run: the first was answered some other way.
    a.on_thread_event(&event("thread.waiting", Some(prompt("q2", "Bash", "pwd"))))
        .await;
    a.on_thread_event(&event("thread.failed", None)).await;
    let states: Vec<_> = ["Q1", "Q2"]
        .iter()
        .map(|id| {
            let r = fake.request(id);
            (r.state, r.evidence.unwrap().to_string())
        })
        .collect();
    assert_eq!(
        states,
        [
            (
                RequestState::Denied,
                "closed: the prompt was answered elsewhere".to_string()
            ),
            (RequestState::Denied, "expired: the run ended".to_string()),
        ]
    );
    // A reminder is the hub's own event, never a new prompt.
    let mut reminder = event("thread.waiting", Some(prompt("q9", "Bash", "ls")));
    reminder.data.as_mut().unwrap()["reminder"] = json!(true);
    a.on_thread_event(&reminder).await;
    assert!(fake.requests.get("Q3").unwrap().is_none());
}

#[tokio::test]
async fn a_lead_answers_its_tasks_prompts_but_never_its_own() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.on_thread_event(&event(
        "thread.waiting",
        Some(prompt("q1", "Bash", "rm -rf build")),
    ))
    .await;
    *fake.pending.lock().unwrap() = Some(pending("q1"));
    let lead = agent();
    let input = |request_id: Option<&str>, allow: bool| ThreadAnswer {
        machine_id: "lab-a".into(),
        thread_id: "t1".into(),
        request_id: request_id.map(str::to_string),
        allow,
        message: None,
    };

    *fake.lead_thread.lock().unwrap() = Some("t1".into());
    let refused = a.answer_thread(&lead, input(None, true)).await.unwrap_err();
    assert_eq!(refused.code, "forbidden", "no self-approval");
    assert!(
        a.answer_thread(&person(), input(None, true)).await.is_ok(),
        "a person may"
    );
    fake.answers.lock().unwrap().clear();
    fake.requests
        .update(&ChatRequestId::unchecked("Q1"), |r| {
            r.state = RequestState::Open;
            r.evidence = None;
            r.answered_by = None;
        })
        .unwrap();

    *fake.lead_thread.lock().unwrap() = Some("lead-thread".into());
    let stale = a
        .answer_thread(&lead, input(Some("q0"), true))
        .await
        .unwrap_err();
    assert_eq!(stale.code, "not_found");
    assert!(
        stale
            .message
            .contains("it waits on q1 (Bash rm -rf build) now"),
        "{}",
        stale.message
    );

    let out = a
        .answer_thread(&lead, input(Some("q1"), false))
        .await
        .unwrap();
    assert_eq!(
        (out["decision"].as_str(), out["humanRequestId"].as_str()),
        (Some("deny"), Some("Q1"))
    );
    assert_eq!(
        fake.answers.lock().unwrap()[0].3,
        PermissionDecision::Deny {
            message: fleetd_contracts::prim::Text::unchecked(
                "Denied: agent:lead-key with thread_answer."
            )
        }
    );
    let r = fake.request("Q1");
    assert_eq!(
        (r.state, r.evidence.unwrap().as_str()),
        (
            RequestState::Denied,
            "denied on lab-a with thread_answer by agent:lead-key"
        )
    );

    let ungranted = Caller {
        allows_operate: NOWHERE,
        ..person()
    };
    assert_eq!(
        a.answer_thread(&ungranted, input(None, true))
            .await
            .unwrap_err()
            .code,
        "forbidden"
    );
    *fake.pending.lock().unwrap() = None;
    assert_eq!(
        a.answer_thread(&person(), input(None, true))
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
}

fn now_ms() -> i64 {
    crate::hub::usage::time::system_ms(std::time::SystemTime::now())
}

#[tokio::test]
async fn a_withdrawn_approval_denies_its_prompt_and_reminders_go_on_until_it_lands() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.on_thread_event(&event(
        "thread.waiting",
        Some(prompt("q1", "Bash", "rm -rf build")),
    ))
    .await;
    *fake.pending.lock().unwrap() = Some(pending("q1"));
    *fake.answer_fails.lock().unwrap() = Some(NodeCommandError {
        reason: "offline".into(),
        message: "lab-a's node is not linked to the hub".into(),
        fix: None,
    });
    a.withdraw(&p1(), "lead:lab-a/p1", "Q1").await.unwrap();
    let t0 = now_ms();
    a.sweep_prompts(t0).await;
    assert_eq!(
        a.prompts.len(),
        1,
        "an undelivered deny keeps the prompt watched"
    );
    a.sweep_prompts(t0 + REMIND_AFTER_MS + 1000).await;
    let reminders = fake.reminders();
    assert_eq!(reminders.len(), 1);
    assert_eq!(reminders[0].attention.as_deref(), Some("loud"));

    *fake.answer_fails.lock().unwrap() = None;
    a.sweep_prompts(t0 + REMIND_AFTER_MS + 2000).await;
    let (_, _, request, decision) = fake.answers.lock().unwrap()[0].clone();
    assert_eq!(request, "q1");
    let PermissionDecision::Deny { message } = decision else {
        panic!("a withdrawn approval never allows")
    };
    assert!(
        message
            .as_str()
            .starts_with("Denied: lead:lab-a/p1 withdrew Q1 before anyone answered it"),
        "{}",
        message.as_str()
    );
    assert_eq!(
        fake.request("Q1").evidence.unwrap().as_str(),
        "denied on lab-a, answered by lead:lab-a/p1"
    );
    assert_eq!(a.prompts.len(), 0);
    a.sweep_prompts(t0 + 10 * REMIND_EVERY_MS).await;
    assert_eq!(fake.reminders().len(), 1, "nothing left to remind about");
    assert_eq!(fake.answers.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn after_a_restart_an_answer_with_no_delivery_record_is_delivered() {
    let fake = Arc::new(Fake::default());
    fake.stored(Some(("t1", "q1")), RequestState::Approved, None);
    fake.stored(
        Some(("t1", "q2")),
        RequestState::Approved,
        Some("allowed on lab-a, answered by human:desk"),
    );
    let a = approvals(&fake);
    a.seed_prompts().await;
    a.sweep_prompts(now_ms()).await;
    let answers = fake.answers.lock().unwrap().clone();
    assert_eq!(answers.len(), 1, "a delivered answer is never sent twice");
    assert_eq!(
        (answers[0].2.as_str(), &answers[0].3),
        (
            "q1",
            &PermissionDecision::Allow {
                updated_input: None
            }
        )
    );
    assert_eq!(
        fake.request("Q1").evidence.unwrap().as_str(),
        "allowed on lab-a, answered by human:desk"
    );
}

#[tokio::test]
async fn a_prompt_whose_run_ended_while_the_hub_was_down_closes_quietly() {
    let fake = Arc::new(Fake::default());
    fake.stored(Some(("t1", "q1")), RequestState::Open, None);
    let a = approvals(&fake);
    a.seed_prompts().await;
    let late = now_ms();
    // Offline: the hub can't tell, so it keeps reminding.
    a.sweep_prompts(late).await;
    a.sweep_prompts(late + 1).await;
    assert_eq!(a.prompts.len(), 1);
    assert_eq!(fake.reminders().len(), 1, "an old prompt is reminded about");
    // Linked, and the node's snapshot shows another prompt (or none): once is not enough, twice closes it.
    *fake.linked.lock().unwrap() = true;
    *fake.pending.lock().unwrap() = Some(pending("q7"));
    a.sweep_prompts(late + 2).await;
    assert_eq!(a.prompts.len(), 1);
    a.sweep_prompts(late + 60_000).await;
    assert_eq!(a.prompts.len(), 0);
    let r = fake.request("Q1");
    assert_eq!(
        (r.state, r.evidence.unwrap().as_str()),
        (
            RequestState::Denied,
            "expired: the run ended while the hub was down"
        )
    );
    assert_eq!(
        fake.reminders().len(),
        1,
        "closed quietly: no further reminder"
    );
    assert!(
        fake.answers.lock().unwrap().is_empty(),
        "nothing is sent to the node"
    );
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
    let r = fake.stored(Some(("t1", "q1")), RequestState::Open, None);
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
