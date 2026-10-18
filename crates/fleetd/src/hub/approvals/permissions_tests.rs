use super::permissions::*;
use super::*;
use crate::hub::usage::ports::{HubEvent, WaitPage};
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

/// The approvals ports over in-memory asks, a scripted node and a recorded event log.
struct Fake {
    asks: Mutex<Vec<Value>>,
    created: Mutex<Vec<Value>>,
    answers: Mutex<Vec<(String, String, String, PermissionDecision)>>,
    answer_fails: Mutex<Option<NodeCommandError>>,
    pending: Mutex<Option<PendingPermission>>,
    rules: Mutex<Result<ToolRules, String>>,
    lead_thread: Mutex<Option<String>>,
    events: Mutex<Vec<NewEvent>>,
    woken: Mutex<Vec<String>>,
}

impl Default for Fake {
    fn default() -> Self {
        Self {
            asks: Mutex::default(),
            created: Mutex::default(),
            answers: Mutex::default(),
            answer_fails: Mutex::default(),
            pending: Mutex::default(),
            rules: Mutex::new(Ok(ToolRules::default())),
            lead_thread: Mutex::default(),
            events: Mutex::default(),
            woken: Mutex::default(),
        }
    }
}

fn find<'a>(asks: &'a mut [Value], id: &str) -> &'a mut Value {
    asks.iter_mut().find(|a| a["askId"] == id).unwrap()
}

impl ApprovalAsks for Fake {
    fn get(&self, id: &str) -> BoxFut<'_, Option<Value>> {
        let a = self
            .asks
            .lock()
            .unwrap()
            .iter()
            .find(|a| a["askId"] == id)
            .cloned();
        Box::pin(async move { a })
    }
    fn list_answered(&self) -> BoxFut<'_, Vec<Value>> {
        Box::pin(async { Vec::new() })
    }
    fn create(&self, mut input: Value, by: &str) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
        assert_eq!(by, "hub:tool_permission");
        let mut asks = self.asks.lock().unwrap();
        input["askId"] = json!(format!("A{}", asks.len() + 1));
        input["state"] = json!("open");
        input["createdAt"] = json!("2026-10-18T10:00:00.000Z");
        asks.push(input.clone());
        self.created.lock().unwrap().push(input.clone());
        Box::pin(async move { Ok(input) })
    }
    fn update(
        &self,
        id: &str,
        patch: Map<String, Value>,
    ) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
        let mut asks = self.asks.lock().unwrap();
        let a = find(&mut asks, id);
        for (k, v) in patch {
            a[k] = v;
        }
        let out = a.clone();
        Box::pin(async move { Ok(out) })
    }
    fn reopen(&self, id: &str, evidence: &str) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
        let mut asks = self.asks.lock().unwrap();
        let a = find(&mut asks, id);
        a["state"] = json!("open");
        a["evidence"] = json!(evidence);
        a.as_object_mut().unwrap().remove("answer");
        let out = a.clone();
        Box::pin(async move { Ok(out) })
    }
    fn list_open(&self) -> BoxFut<'_, Vec<Value>> {
        let open = self
            .asks
            .lock()
            .unwrap()
            .iter()
            .filter(|a| a["state"] == "open")
            .cloned()
            .collect();
        Box::pin(async move { open })
    }
    fn list_closed_permissions(&self) -> BoxFut<'_, Vec<Value>> {
        let closed = self
            .asks
            .lock()
            .unwrap()
            .iter()
            .filter(|a| a["state"] == "answered" || a["state"] == "withdrawn")
            .cloned()
            .collect();
        Box::pin(async move { closed })
    }
    fn withdraw(&self, id: &str, reason: &str) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
        let mut asks = self.asks.lock().unwrap();
        let a = find(&mut asks, id);
        a["state"] = json!("withdrawn");
        a["answer"] = json!({ "value": reason, "by": "hub" });
        let out = a.clone();
        Box::pin(async move { Ok(out) })
    }
}

impl ApprovalNodes for Fake {
    fn deliver_secret(
        &self,
        _: &str,
        _: Value,
    ) -> BoxFut<'_, Result<SecretOutcome, NodeCommandError>> {
        unreachable!()
    }
    fn run_gated(&self, _: &str, _: Value) -> BoxFut<'_, Result<GatedOutcome, NodeCommandError>> {
        unreachable!("a tool prompt never runs a gated command")
    }
    fn answer_permission(
        &self,
        m: &str,
        t: &str,
        request_id: &str,
        decision: PermissionDecision,
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
    fn box_key(&self, _: &str) -> BoxFut<'_, Option<Option<String>>> {
        unreachable!()
    }
    fn workspace_root(&self, _: &ProjectRef) -> BoxFut<'_, Option<String>> {
        unreachable!()
    }
    fn wake_answer(&self, _: &ProjectRef, ask: Value, value: String) -> BoxFut<'_, ()> {
        self.woken
            .lock()
            .unwrap()
            .push(format!("{} {value}", ask["askId"].as_str().unwrap()));
        Box::pin(async {})
    }
    fn verify(&self, _: &ProjectRef, _: Option<String>, _: Value) -> BoxFut<'_, (String, String)> {
        unreachable!()
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
            HubEvent {
                seq: 1,
                at: e.at,
                kind: e.kind,
                machine_id: e.machine_id,
                project_id: e.project_id,
                thread_id: e.thread_id,
                summary: e.summary,
                data: e.data,
                attention: e.attention,
            }
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
        asks: fake.clone(),
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
    HubEvent {
        seq: 7,
        at: "2026-10-18T10:00:00.000Z".into(),
        kind: kind.into(),
        machine_id: Some("lab-a".into()),
        project_id: Some("p1".into()),
        thread_id: Some("t1".into()),
        summary: String::new(),
        data: Some(data),
        attention: None,
    }
}

fn pending(request_id: &str) -> PendingPermission {
    serde_json::from_value(prompt(request_id, "Bash", "rm -rf build")).unwrap()
}

#[tokio::test]
async fn a_prompt_no_rule_covers_becomes_one_approve_ask_and_go_allows_it_on_the_node() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    let waiting = event("thread.waiting", Some(prompt("q1", "Bash", "rm -rf build")));
    a.on_thread_event(&waiting).await;
    a.on_thread_event(&waiting).await;
    let created = fake.created.lock().unwrap().clone();
    assert_eq!(created.len(), 1, "the same prompt is filed once");
    let ask = &created[0];
    assert_eq!(
        (ask["kind"].as_str(), ask["class"].as_str()),
        (Some("approve"), Some("irreversible"))
    );
    assert_eq!(ask["text"], "lab-a/t1: Bash rm -rf build");
    assert_eq!(
        ask["permission"],
        json!({ "threadId": "t1", "requestId": "q1", "toolName": "Bash", "summary": "rm -rf build" })
    );
    assert!(
        fake.answers.lock().unwrap().is_empty(),
        "nothing is answered for the person"
    );

    let mut answered = fake.asks.lock().unwrap()[0].clone();
    answered["state"] = json!("answered");
    answered["answer"] = json!({ "value": "go", "by": "human:desk" });
    fake.asks.lock().unwrap()[0] = answered.clone();
    a.answer_from_ask(&answered).await;
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
        fake.asks.lock().unwrap()[0]["evidence"],
        "allowed on lab-a, answered by human:desk"
    );
    assert_eq!(
        fake.woken.lock().unwrap().as_slice(),
        ["A1 go"],
        "the held-back go reaches the lead"
    );
}

#[tokio::test]
async fn no_denies_with_the_answerers_words_and_an_undelivered_answer_goes_back_to_the_person() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.on_thread_event(&event(
        "thread.waiting",
        Some(prompt("q1", "Bash", "rm -rf build")),
    ))
    .await;
    let mut ask = fake.asks.lock().unwrap()[0].clone();
    ask["state"] = json!("answered");
    ask["answer"] = json!({ "value": "use make clean instead", "by": "human:desk" });

    // The node is offline while the run still waits: nothing is lost, the person answers again.
    *fake.answer_fails.lock().unwrap() = Some(NodeCommandError {
        reason: "offline".into(),
        message: "lab-a's node is not linked to the hub".into(),
        fix: None,
    });
    a.answer_from_ask(&ask).await;
    let back = fake.asks.lock().unwrap()[0].clone();
    assert_eq!(back["state"], "open");
    assert!(
        back["evidence"]
            .as_str()
            .unwrap()
            .starts_with("not delivered: lab-a's node is not linked")
    );

    *fake.answer_fails.lock().unwrap() = None;
    a.answer_from_ask(&ask).await;
    let (_, _, _, decision) = fake.answers.lock().unwrap()[0].clone();
    assert_eq!(
        decision,
        PermissionDecision::Deny {
            message: fleetd_contracts::prim::Text::unchecked(
                "Denied by human:desk (A1): use make clean instead"
            )
        }
    );
    assert!(
        fake.woken.lock().unwrap().is_empty(),
        "the ledger already woke the lead with the no"
    );
}

#[tokio::test]
async fn rules_answer_without_an_ask_and_a_broken_policy_asks_a_person() {
    let fake = Arc::new(Fake {
        rules: Mutex::new(Ok(rules(&["Bash(npm test:*)"], &["Bash(rm:*)"]))),
        ..Default::default()
    });
    let a = approvals(&fake);
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
                "Denied by the tools.deny rule `Bash(rm:*)` in .fleetd/policy.yaml."
            )
        }
    );
    assert!(fake.created.lock().unwrap().is_empty());

    *fake.rules.lock().unwrap() = Err(".fleetd/policy.yaml is invalid".into());
    a.on_thread_event(&event(
        "thread.waiting",
        Some(prompt("q3", "Bash", "npm test")),
    ))
    .await;
    assert_eq!(
        fake.created.lock().unwrap().len(),
        1,
        "a broken policy never answers for a person"
    );

    // A rule answer the node refuses still reaches a person.
    *fake.rules.lock().unwrap() = Ok(rules(&["Bash"], &[]));
    *fake.answer_fails.lock().unwrap() = Some(NodeCommandError {
        reason: "failed".into(),
        message: "x".into(),
        fix: None,
    });
    a.on_thread_event(&event("thread.waiting", Some(prompt("q4", "Bash", "ls"))))
        .await;
    assert_eq!(fake.created.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn an_ask_closes_when_its_prompt_is_gone() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.on_thread_event(&event("thread.waiting", Some(prompt("q1", "Bash", "ls"))))
        .await;
    // A second prompt in the same run: the first was answered some other way.
    a.on_thread_event(&event("thread.waiting", Some(prompt("q2", "Bash", "pwd"))))
        .await;
    a.on_thread_event(&event("thread.failed", None)).await;
    let asks = fake.asks.lock().unwrap().clone();
    let states: Vec<_> = asks
        .iter()
        .map(|a| (a["state"].clone(), a["answer"]["value"].clone()))
        .collect();
    assert_eq!(
        states,
        [
            (
                json!("withdrawn"),
                json!("closed: the prompt was answered elsewhere")
            ),
            (json!("withdrawn"), json!("expired: the run ended")),
        ]
    );
    // A reminder is the hub's own event, never a new prompt.
    let mut reminder = event("thread.waiting", Some(prompt("q9", "Bash", "ls")));
    reminder.data.as_mut().unwrap()["reminder"] = json!(true);
    a.on_thread_event(&reminder).await;
    assert_eq!(fake.created.lock().unwrap().len(), 2);
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
    let operate = |_: &str| true;
    let lead = Caller {
        human: false,
        name: "lead-key",
        allows_operate: &operate,
    };
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
    let human = Caller {
        human: true,
        name: "desk",
        allows_operate: &operate,
    };
    assert!(
        a.answer_thread(&human, input(None, true)).await.is_ok(),
        "a person may"
    );
    fake.answers.lock().unwrap().clear();
    fake.asks.lock().unwrap()[0]["state"] = json!("open");

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
        (out["decision"].as_str(), out["askId"].as_str()),
        (Some("deny"), Some("A1"))
    );
    assert_eq!(
        fake.answers.lock().unwrap()[0].3,
        PermissionDecision::Deny {
            message: fleetd_contracts::prim::Text::unchecked(
                "Denied by agent:lead-key with thread_answer."
            )
        }
    );
    let ask = fake.asks.lock().unwrap()[0].clone();
    assert_eq!(
        (ask["state"].as_str(), ask["answer"]["raw"].as_str()),
        (Some("answered"), Some("thread_answer"))
    );

    let nowhere = |_: &str| false;
    let ungranted = Caller {
        human: true,
        name: "desk",
        allows_operate: &nowhere,
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
        a.answer_thread(&human, input(None, true))
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
async fn a_withdrawn_ask_denies_its_prompt_and_reminders_go_on_until_it_is_answered() {
    let fake = Arc::new(Fake::default());
    let a = approvals(&fake);
    a.on_thread_event(&event(
        "thread.waiting",
        Some(prompt("q1", "Bash", "rm -rf build")),
    ))
    .await;
    // The lead runs `fleetd ask withdraw A1`: the ledger closes the ask and records no answer.
    fake.asks.lock().unwrap()[0]["state"] = json!("withdrawn");
    *fake.pending.lock().unwrap() = Some(pending("q1"));
    *fake.answer_fails.lock().unwrap() = Some(NodeCommandError {
        reason: "offline".into(),
        message: "lab-a's node is not linked to the hub".into(),
        fix: None,
    });
    let t0 = now_ms();
    a.sweep_prompts(t0).await;
    assert_eq!(
        a.prompts.len(),
        1,
        "an undelivered deny keeps the prompt watched"
    );
    a.sweep_prompts(t0 + REMIND_AFTER_MS + 1000).await;
    let reminders = fake.events.lock().unwrap().clone();
    assert_eq!(reminders.len(), 1);
    assert_eq!(
        (
            reminders[0].kind.as_str(),
            reminders[0].attention.as_deref()
        ),
        ("thread.waiting", Some("loud"))
    );

    *fake.answer_fails.lock().unwrap() = None;
    a.sweep_prompts(t0 + REMIND_AFTER_MS + 2000).await;
    let (_, _, request, decision) = fake.answers.lock().unwrap()[0].clone();
    assert_eq!(request, "q1");
    let PermissionDecision::Deny { message } = decision else {
        panic!("a withdrawn ask never allows")
    };
    assert!(
        message
            .as_str()
            .starts_with("Not approved: A1 was withdrawn by its lead"),
        "{}",
        message.as_str()
    );
    assert_eq!(
        fake.asks.lock().unwrap()[0]["evidence"],
        "denied on lab-a: withdrawn before anyone approved it"
    );
    assert_eq!(a.prompts.len(), 0);
    a.sweep_prompts(t0 + 10 * REMIND_EVERY_MS).await;
    assert_eq!(
        fake.events.lock().unwrap().len(),
        1,
        "nothing left to remind about"
    );
    assert_eq!(fake.answers.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn after_a_restart_an_answer_with_no_delivery_record_is_delivered() {
    let fake = Arc::new(Fake::default());
    let ask = |id: &str, request: &str, evidence: Option<&str>| {
        let mut a = json!({
            "askId": id, "kind": "approve", "state": "answered", "createdAt": "2026-10-18T10:00:00.000Z",
            "projectRef": { "machineId": "lab-a", "projectId": "p1" },
            "permission": { "threadId": "t1", "requestId": request, "toolName": "Bash", "summary": "ls" },
            "answer": { "value": "go", "by": "human:desk" },
        });
        if let Some(e) = evidence {
            a["evidence"] = json!(e);
        }
        a
    };
    fake.asks.lock().unwrap().extend([
        ask("A1", "q1", None),
        ask("A2", "q2", Some("allowed on lab-a, answered by human:desk")),
    ]);
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
        fake.asks.lock().unwrap()[0]["evidence"],
        "allowed on lab-a, answered by human:desk"
    );
}
