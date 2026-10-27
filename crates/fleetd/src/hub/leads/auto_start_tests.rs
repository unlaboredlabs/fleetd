//! An order for a project without a lead: the lead starts and gets it, or the order waits with the reason, and the
//! lead starts once the machine comes online with a usable runner. `hub()` is shared with the prompt tests.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, ThreadRef, Timestamp};
use fleetd_contracts::ledger::{Decision, HumanRequest, IntakeChannel, WorkstreamId};
use fleetd_contracts::mcp::ErrorCode;
use fleetd_contracts::model::{ProjectSummary, ThreadCounts};

use crate::hub::executor::LaunchInput;
use crate::hub::leads::hooks::BoxFuture;
use crate::hub::leads::lead::AutoStart;
use crate::hub::leads::ports::LeadPorts;
use crate::hub::leads::wakes::{LineKind, Trigger, WAKE_COALESCE, WAKE_DEBOUNCE};
use crate::hub::leads::workstreams::IntakeInput;
use crate::hub::leads::{Area, Ctx, LeadError};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{EventLog, HubDb, HubStore, NewEvent, iso_ms};

const T0_MS: u64 = 1_792_231_200_000;
const MACHINE: &str = "lab-a";
const NOT_LOGGED_IN: &str = "claude is not logged in on this machine";
const LOGIN_FIX: &str = "On lab-a: CLAUDE_CONFIG_DIR=~/.fleetd/claude claude auth login.";

/// The node: refuses launches while the runner is unusable, as the executor's launch gate does.
#[derive(Default)]
pub(crate) struct Node {
    runner_usable: AtomicBool,
    pub(crate) launches: Mutex<Vec<LaunchInput>>,
    pub(crate) sends: Mutex<Vec<String>>,
    /// Sends fail (the write queue refused them) while set; they are still recorded.
    send_fails: AtomicBool,
}

struct Ports(Arc<Node>);

impl LeadPorts for Ports {
    fn launch(&self, _: &MachineId, input: LaunchInput) -> BoxFuture<Result<ThreadId, LeadError>> {
        let node = Arc::clone(&self.0);
        Box::pin(async move {
            if !node.runner_usable.load(Ordering::SeqCst) {
                return Err(LeadError::new(ErrorCode::Failed, NOT_LOGGED_IN, LOGIN_FIX));
            }
            let mut launches = node.launches.lock().unwrap();
            launches.push(input);
            Ok(ThreadId::unchecked(format!("lead-{}", launches.len())))
        })
    }
    fn send(&self, _: ThreadRef, message: String, _: String) -> BoxFuture<Result<bool, LeadError>> {
        self.0.sends.lock().unwrap().push(message);
        let fails = self.0.send_fails.load(Ordering::SeqCst);
        Box::pin(async move {
            if fails {
                return Err(LeadError::new(ErrorCode::Failed, "not delivered", "retry"));
            }
            Ok(false)
        })
    }
    fn open_requests(
        &self,
        _: Option<&ProjectRef>,
        _: usize,
    ) -> Result<Vec<HumanRequest>, LeadError> {
        Ok(Vec::new())
    }
    fn decisions_in_project(&self, _: &ProjectRef, _: usize) -> Result<Vec<Decision>, LeadError> {
        Ok(Vec::new())
    }
    fn decisions_of_workstream(
        &self,
        _: &WorkstreamId,
        _: usize,
    ) -> Result<Vec<Decision>, LeadError> {
        Ok(Vec::new())
    }
}

pub(crate) struct Hub {
    pub(crate) area: Arc<Area>,
    pub(crate) node: Arc<Node>,
    pub(crate) clock: Arc<ManualClock>,
    pub(crate) events: Arc<EventLog>,
    pub(crate) project: ProjectRef,
    _home: tempfile::TempDir,
}

/// A hub home in a temporary directory, so prompt overrides have somewhere to live.
pub(crate) fn hub(runner_usable: bool) -> Hub {
    let home = tempfile::tempdir().unwrap();
    let db = HubDb::open(home.path()).unwrap();
    let clock = ManualClock::at(T0_MS);
    let store = Arc::new(HubStore::new(db.clone()));
    let events = Arc::new(EventLog::new(db.clone(), clock.clone()).unwrap());
    let project = ProjectRef {
        machine_id: MachineId::new(MACHINE).unwrap(),
        project_id: ProjectId::unchecked("p-a"),
    };
    store
        .projects_upsert_many(
            &project.machine_id,
            &[ProjectSummary {
                machine_id: project.machine_id.clone(),
                project_id: project.project_id.clone(),
                title: "repo-a".into(),
                workspace_root: "/lab/repo-a".into(),
                threads: ThreadCounts::default(),
                last_activity_at: Timestamp::from(iso_ms(T0_MS as i64)),
                repos: Vec::new(),
            }],
        )
        .unwrap();
    let area = Area::new(Ctx::new(db, store, events.clone(), clock.clone()));
    let node = Arc::new(Node {
        runner_usable: AtomicBool::new(runner_usable),
        ..Default::default()
    });
    area.ctx.set_ports(Arc::new(Ports(node.clone())));
    Hub {
        area,
        node,
        clock,
        events,
        project,
        _home: home,
    }
}

impl Hub {
    /// A new order in the project, then its lead, as a person's message starts it.
    pub(crate) async fn order(&self, text: &str) -> (WorkstreamId, AutoStart) {
        let created = self
            .area
            .workstreams
            .intake(IntakeInput {
                project_ref: self.project.clone(),
                text: text.into(),
                client_request_id: text.into(),
                channel: IntakeChannel::Mcp,
                by: "human".into(),
            })
            .unwrap();
        let lead = self.area.leads.auto_start(&self.project, None).await;
        (created.workstream_id, lead)
    }

    pub(crate) fn launched_prompts(&self) -> Vec<String> {
        let launches = self.node.launches.lock().unwrap();
        launches.iter().map(|l| l.prompt.to_string()).collect()
    }

    fn events_of(&self, kind: HubEventType) -> usize {
        self.events
            .page(0, Some(&[kind]), None)
            .unwrap()
            .events
            .len()
    }

    /// Lets every pending wake flush.
    pub(crate) async fn after_debounce(&self) {
        settle().await;
        self.clock.advance(WAKE_DEBOUNCE + Duration::from_secs(1));
        settle().await;
    }

    fn machine_online(&self) {
        self.events
            .append(NewEvent {
                at: iso_ms(T0_MS as i64).into(),
                r#type: HubEventType::MachineOnline,
                machine_id: Some(self.project.machine_id.clone()),
                project_id: None,
                thread_id: None,
                summary: format!("{MACHINE} is online"),
                data: None,
                attention: None,
            })
            .unwrap();
    }
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn an_order_for_a_project_without_a_lead_starts_it_and_the_lead_gets_the_order() {
    let hub = hub(true);
    let (w1, lead) = hub.order("add a /health endpoint").await;
    assert!(matches!(lead, AutoStart::Started(_)));
    let prompts = hub.launched_prompts();
    assert_eq!(prompts.len(), 1);
    assert!(
        prompts[0].contains(w1.as_str()) && prompts[0].contains("add a /health endpoint"),
        "the lead's first message lists the order: {}",
        prompts[0]
    );
    assert!(hub.area.leads.get(&hub.project).unwrap().is_some());
    assert_eq!(hub.events_of(HubEventType::LeadStarted), 1);

    // The next order, a moment later, goes to the running lead as a wake. The first was made in the millisecond the
    // lead started, so it may have missed the first message's digest and is said once more (`LeadWakes::flush`).
    hub.clock.advance(Duration::from_millis(5));
    let (w2, lead) = hub.order("add a /ready endpoint").await;
    assert!(matches!(lead, AutoStart::Running(_)));
    hub.after_debounce().await;
    let sends = hub.node.sends.lock().unwrap().clone();
    assert_eq!(sends.len(), 1);
    for w in [&w1, &w2] {
        assert!(sends[0].contains(&format!("new order {w}")), "{}", sends[0]);
    }
    assert_eq!(hub.launched_prompts().len(), 1);
}

/// Otherwise the lead's first turn answers an empty chat ("tell me what you'd like done") and the message that
/// started it waits for a second turn.
#[tokio::test(flavor = "current_thread")]
async fn the_message_that_starts_the_lead_ends_its_first_message_and_only_that_one() {
    let hub = hub(true);
    let lead = hub
        .area
        .leads
        .auto_start(
            &hub.project,
            Some("The human writes: add a /health endpoint"),
        )
        .await;
    assert!(matches!(lead, AutoStart::Started(_)));
    let prompts = hub.launched_prompts();
    assert!(
        prompts[0].starts_with("You are the lead of project repo-a")
            && prompts[0].ends_with("\n\nThe human writes: add a /health endpoint"),
        "{}",
        prompts[0]
    );
    // The lead runs now: a later message goes in on its own, and nothing launches again.
    let lead = hub
        .area
        .leads
        .auto_start(&hub.project, Some("The human writes: and /ready"))
        .await;
    assert!(matches!(lead, AutoStart::Running(_)));
    assert_eq!(hub.launched_prompts().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn an_unusable_runner_holds_the_order_with_its_reason_until_the_machine_is_online() {
    let hub = hub(false);
    let waiting_loop = tokio::spawn(hub.area.leads.clone().run_waiting());
    settle().await;
    let (w1, lead) = hub.order("add a /health endpoint").await;
    let AutoStart::Held(e) = lead else {
        panic!("a logged-out runner starts no lead");
    };
    assert_eq!(
        (e.message.as_str(), e.fix.as_deref()),
        (NOT_LOGGED_IN, Some(LOGIN_FIX))
    );
    assert!(hub.area.leads.get(&hub.project).unwrap().is_none());
    assert_eq!(hub.events_of(HubEventType::LeadStarted), 0);
    hub.after_debounce().await;
    assert!(hub.node.sends.lock().unwrap().is_empty());

    // Still logged out when the machine reconnects: nothing starts.
    hub.machine_online();
    settle().await;
    assert!(hub.launched_prompts().is_empty());

    // Logged in: the runner is usable, the machine comes online, the lead starts with the order in its digest.
    hub.node.runner_usable.store(true, Ordering::SeqCst);
    hub.machine_online();
    settle().await;
    let prompts = hub.launched_prompts();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].contains(w1.as_str()), "{}", prompts[0]);
    assert_eq!(hub.events_of(HubEventType::LeadStarted), 1);

    // Online again later: the lead is there, so no second one.
    hub.machine_online();
    settle().await;
    assert_eq!(hub.launched_prompts().len(), 1);
    waiting_loop.abort();
}

/// An order that says more than its title (an automation's prompt, trigger and webhook body) waits while the lead
/// can't start; the lead that starts later gets it in full, not just the digest's title line.
#[tokio::test(flavor = "current_thread")]
async fn an_order_that_waited_for_its_lead_reaches_it_in_full_when_it_starts() {
    let hub = hub(false);
    let waiting_loop = tokio::spawn(hub.area.leads.clone().run_waiting());
    settle().await;
    let text = "Error alert triage\nFrom automation au_k3Jd8sQp2xYz (run ar_Qm7tZr1vBn4w, started by its webhook).\n\n\
                Find the cause from the alert's body.\n\nThe webhook's body (27 bytes):\n```\n{\"alert\":\"disk 91% on db-2\"}\n```";
    let (w1, lead) = hub.order(text).await;
    assert!(matches!(lead, AutoStart::Held(_)));
    hub.clock.advance(Duration::from_secs(600));
    hub.node.runner_usable.store(true, Ordering::SeqCst);
    hub.machine_online();
    settle().await;
    let prompts = hub.launched_prompts();
    assert_eq!(prompts.len(), 1);
    for part in [
        "Orders waiting for you:",
        "in full:",
        w1.as_str(),
        "Find the cause from the alert's body.",
        "disk 91% on db-2",
        "started by its webhook",
    ] {
        assert!(
            prompts[0].contains(part),
            "{part} missing from:\n{}",
            prompts[0]
        );
    }
    // Said once: the intent wake made before the lead started is dropped, as the first message carried it.
    hub.after_debounce().await;
    assert!(
        hub.node
            .sends
            .lock()
            .unwrap()
            .iter()
            .all(|m| !m.contains("disk 91%"))
    );
    waiting_loop.abort();
}

/// A wake says a long or many-line order whole, and a short one in its one line as before.
#[test]
fn a_wake_says_an_order_longer_than_a_line_in_full() {
    use crate::hub::leads::wakes::trigger_lines;
    let w = WorkstreamId::unchecked("W9");
    let long = format!("Error alert triage\n{}\nTHE END", "x".repeat(400));
    let lines = trigger_lines(&[
        Trigger::Intent {
            workstream_id: w.clone(),
            text: long,
        },
        Trigger::Intent {
            workstream_id: w,
            text: "add a /health endpoint".into(),
        },
    ]);
    assert!(
        lines[0].starts_with("- new order W9, in full:\n  Error alert triage\n  xxx"),
        "{}",
        lines[0]
    );
    assert!(lines[0].ends_with("\n  THE END"));
    assert_eq!(lines[1], "- new order W9: \"add a /health endpoint\"");
}

/// An order whose text is its title is in the digest already: no second copy.
#[tokio::test(flavor = "current_thread")]
async fn a_one_line_order_is_not_repeated_under_waiting_orders() {
    let hub = hub(true);
    hub.order("add a /health endpoint").await;
    let prompts = hub.launched_prompts();
    assert!(
        !prompts[0].contains("Orders waiting for you"),
        "{}",
        prompts[0]
    );
}

/// The lead's thread as the shell stream last reported it.
fn lead_thread(hub: &Hub, status: &str) {
    let at = iso_ms(T0_MS as i64);
    hub.area
        .ctx
        .store
        .thread_upsert(&crate::hub::store::StoredThread {
            thread: serde_json::from_value(serde_json::json!({
                "machineId": MACHINE, "threadId": "lead-1", "projectId": "p-a", "title": "lead", "status": status,
                "headline": "", "latestMessageTail": "", "lastProgressAt": at, "stale": false, "asOf": at,
            }))
            .unwrap(),
            last_sequence: None,
            last_run_id: None,
            last_run_status: None,
        })
        .unwrap();
}

fn line(kind: LineKind, text: &str) -> Trigger {
    Trigger::Line {
        kind,
        text: text.into(),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn a_merge_or_a_result_wakes_an_idle_lead_soon_and_a_busy_one_after_the_window() {
    let hub = hub(true);
    hub.order("fix the five bugs").await;
    hub.after_debounce().await;
    let sends = || hub.node.sends.lock().unwrap().len();
    let wakes = &hub.area.wakes;
    let start = sends();

    // Busy: a finished agent waits out the quiet window, with what comes after it.
    lead_thread(&hub, "running");
    wakes.trigger(&hub.project, line(LineKind::TaskResult, "T1 done"));
    settle().await;
    hub.clock.advance(Duration::from_secs(3));
    wakes.trigger(&hub.project, line(LineKind::TaskResult, "T2 done"));
    settle().await;
    hub.clock.advance(WAKE_DEBOUNCE - Duration::from_secs(1));
    settle().await;
    assert_eq!(sends(), start);
    hub.clock.advance(Duration::from_secs(1));
    settle().await;
    assert_eq!(sends(), start + 1, "one wake for the burst");

    // Idle, and the last wake one window ago: a merge goes WAKE_COALESCE later, not after the quiet window, and takes
    // along the batch's next merge that lands in between.
    lead_thread(&hub, "idle");
    hub.clock.advance(WAKE_DEBOUNCE);
    wakes.trigger(&hub.project, line(LineKind::Train, "#353 merged"));
    settle().await;
    hub.clock.advance(WAKE_COALESCE - Duration::from_secs(2));
    wakes.trigger(&hub.project, line(LineKind::Train, "#354 merged"));
    settle().await;
    hub.clock.advance(Duration::from_secs(1));
    settle().await;
    assert_eq!(sends(), start + 1);
    hub.clock.advance(Duration::from_secs(1));
    settle().await;
    assert_eq!(sends(), start + 2, "one wake for both merges");
    let sent = hub.node.sends.lock().unwrap()[start + 1].clone();
    assert!(sent.contains("#353 merged") && sent.contains("#354 merged"));

    // Right behind it, before the lead's status says it took the wake: no second wake at once. It comes after the
    // window, once.
    wakes.trigger(
        &hub.project,
        line(LineKind::TaskResult, "T3 review: approved"),
    );
    settle().await;
    assert_eq!(sends(), start + 2);
    hub.after_debounce().await;
    assert_eq!(sends(), start + 3);
    hub.after_debounce().await;
    assert_eq!(sends(), start + 3);

    // A person's words or a waiting agent still coalesce, idle lead or not.
    hub.clock.advance(WAKE_DEBOUNCE);
    wakes.trigger(&hub.project, line(LineKind::Human, "also the docs"));
    wakes.trigger(&hub.project, line(LineKind::TaskWaiting, "T4 asks"));
    settle().await;
    assert_eq!(sends(), start + 3);
    hub.after_debounce().await;
    assert_eq!(sends(), start + 4);
}

/// A quiet line wakes nobody: it goes with the next wake, before that wake's own lines, and only once.
#[tokio::test(flavor = "current_thread")]
async fn a_quiet_line_goes_with_the_next_wake_and_wakes_nobody() {
    let hub = hub(true);
    hub.order("fix the five bugs").await;
    hub.after_debounce().await;
    let sends = || hub.node.sends.lock().unwrap().len();
    let wakes = &hub.area.wakes;
    let start = sends();

    wakes.trigger(
        &hub.project,
        line(
            LineKind::Quiet,
            "- T1's PR: https://github.com/acme/app/pull/9",
        ),
    );
    hub.after_debounce().await;
    hub.after_debounce().await;
    assert_eq!(sends(), start, "a quiet line wakes nobody");

    wakes.trigger(&hub.project, line(LineKind::Human, "also the docs"));
    hub.after_debounce().await;
    assert_eq!(sends(), start + 1);
    let sent = hub.node.sends.lock().unwrap()[start].clone();
    let pr = sent.find("T1's PR: https://github.com/acme/app/pull/9");
    assert!(
        pr.is_some_and(|at| Some(at) < sent.find("also the docs")),
        "{sent}"
    );

    wakes.trigger(&hub.project, line(LineKind::Human, "and the tests"));
    hub.after_debounce().await;
    let sent = hub.node.sends.lock().unwrap()[start + 1].clone();
    assert!(!sent.contains("T1's PR"), "once: {sent}");
}

/// A lead idle past its prompt cache restarts fresh on its next wake, from the state block and the chat's tail,
/// instead of resuming its whole history; a warm one is resumed.
#[tokio::test(flavor = "current_thread")]
async fn a_wake_to_a_lead_idle_past_its_cache_starts_a_fresh_session_with_the_chats_tail() {
    use fleetd_contracts::chat::ChatAuthor;

    use crate::hub::chat::{Chat, NewMessage};
    use crate::hub::leads::lead::LEAD_FRESH_AFTER;

    let hub = hub(true);
    hub.order("fix the five bugs").await;
    hub.after_debounce().await;
    let chat = Chat::new(
        Arc::clone(&hub.area.ctx.db),
        Arc::clone(&hub.events),
        hub.clock.clone(),
    );
    for (author, text) in [
        (ChatAuthor::Human, "keep the old API"),
        (ChatAuthor::System, "PR #9 merged"),
        (ChatAuthor::Lead, "Will do, the old API stays."),
    ] {
        let new = NewMessage {
            author: Some(author),
            text: text.into(),
            ..Default::default()
        };
        chat.add(&hub.project, new).unwrap();
    }
    let sends = || hub.node.sends.lock().unwrap().len();
    let start = sends();

    // Warm: resumed as ever.
    lead_thread(&hub, "idle");
    hub.area
        .wakes
        .trigger(&hub.project, line(LineKind::TaskResult, "T1 done"));
    hub.after_debounce().await;
    assert_eq!((sends(), hub.launched_prompts().len()), (start + 1, 1));

    // Cold: a fresh session, and nothing sent to the old one.
    hub.clock.advance(LEAD_FRESH_AFTER);
    hub.area
        .wakes
        .trigger(&hub.project, line(LineKind::TaskResult, "T2 done"));
    hub.after_debounce().await;
    assert_eq!(sends(), start + 1);
    let prompts = hub.launched_prompts();
    assert_eq!(prompts.len(), 2);
    let fresh = &prompts[1];
    assert!(
        fresh.starts_with("You are the lead of project repo-a"),
        "{fresh}"
    );
    let tail = fresh.split("## Recent chat\n").nth(1).unwrap();
    assert!(
        tail.contains("Human: keep the old API\nYou: Will do, the old API stays.")
            && !tail.contains("PR #9")
            && tail.ends_with("T2 done"),
        "{tail}"
    );
    let lead = hub.area.leads.get(&hub.project).unwrap().unwrap();
    assert_eq!(
        (lead.thread_id.as_str(), lead.session_generation.get()),
        ("lead-2", 1)
    );

    // The fresh session takes the next wake as any lead does.
    hub.area
        .wakes
        .trigger(&hub.project, line(LineKind::TaskResult, "T3 done"));
    hub.after_debounce().await;
    assert_eq!((sends(), hub.launched_prompts().len()), (start + 2, 2));
}

impl Hub {
    /// A thread end the node reported for `thread` on the project's machine.
    fn thread_ended(&self, kind: HubEventType, thread: &str, data: serde_json::Value) {
        self.events
            .append(NewEvent {
                at: iso_ms(T0_MS as i64).into(),
                r#type: kind,
                machine_id: Some(self.project.machine_id.clone()),
                project_id: Some(self.project.project_id.clone()),
                thread_id: Some(ThreadId::unchecked(thread)),
                summary: format!("{thread} ended"),
                data: Some(data),
                attention: None,
            })
            .unwrap();
    }
}

/// An update restarts the node mid-turn: the lead carries on by itself in its thread, with no one asking, and only for
/// its node going away. A lead's own failure, or a task's thread, is not this.
#[tokio::test(flavor = "current_thread")]
async fn a_lead_its_node_cut_off_mid_turn_carries_on_by_itself() {
    let hub = hub(true);
    hub.order("fix the five bugs").await;
    hub.after_debounce().await;
    let follower = tokio::spawn(Arc::clone(&hub.area).run_cut_off());
    settle().await;
    let start = hub.node.sends.lock().unwrap().len();

    hub.thread_ended(
        HubEventType::ThreadFailed,
        "lead-1",
        serde_json::json!({ "threadId": "lead-1", "endCause": "failed", "error": { "class": "auth", "message": "401" } }),
    );
    hub.thread_ended(
        HubEventType::ThreadInterrupted,
        "task-9",
        serde_json::json!({ "threadId": "task-9", "endCause": "node_stopping" }),
    );
    hub.after_debounce().await;
    assert_eq!(
        hub.node.sends.lock().unwrap().len(),
        start,
        "neither wakes the lead"
    );

    hub.thread_ended(
        HubEventType::ThreadInterrupted,
        "lead-1",
        serde_json::json!({ "threadId": "lead-1", "endCause": "node_stopping" }),
    );
    hub.after_debounce().await;
    let sends = hub.node.sends.lock().unwrap().clone();
    assert_eq!(sends.len(), start + 1);
    assert!(
        sends[start]
            .contains("Your last turn was cut off: the node on lab-a stopped, and it is back."),
        "{}",
        sends[start]
    );
    assert_eq!(
        hub.launched_prompts().len(),
        1,
        "in its own thread, not a new lead"
    );
    follower.abort();
}

/// Agents with 3 slots free for 30 minutes of the idle stretch it holds.
struct IdleTasks(std::sync::atomic::AtomicI64);

impl crate::hub::leads::hooks::TasksHook for IdleTasks {
    fn digest_lines(&self, _: &ProjectRef, _: Option<&Timestamp>, _: usize) -> Vec<String> {
        Vec::new()
    }
    fn agents(&self, _: &ProjectRef) -> crate::hub::leads::events::AgentsLine {
        crate::hub::leads::events::AgentsLine {
            running: 1,
            cap: 4,
            queued: 0,
            source: "max agents set".into(),
            idle_since_ms: self.0.load(Ordering::SeqCst),
            idle_minutes: 30,
        }
    }
    fn live(&self, _: Option<&ProjectRef>) -> Vec<(fleetd_contracts::tasks::TaskId, ProjectRef)> {
        Vec::new()
    }
    fn cancel(
        &self,
        _: &ProjectRef,
        _: &fleetd_contracts::tasks::TaskId,
        _: &str,
    ) -> BoxFuture<()> {
        Box::pin(async {})
    }
}

/// The idle line counts as shown only once it reached the lead: a launch or a wake that failed leaves it for the
/// next message, and one that went out uses it up for the stretch.
#[tokio::test(flavor = "current_thread")]
async fn the_idle_line_is_used_up_only_by_a_message_that_went_out() {
    let hub = hub(false);
    let tasks = Arc::new(IdleTasks(1.into()));
    let _ = hub.area.ctx.hooks.tasks.set(tasks.clone());
    let (w1, _) = hub.order("add dark mode").await;
    let mut order = hub.area.records.workstream_get(&w1).unwrap().unwrap();
    order.brief = Some(
        serde_json::from_value(serde_json::json!({
            "goal": "dark mode", "why": "asked", "pointers": [], "constraints": [],
            "doneWhen": ["the app follows the system theme"],
        }))
        .unwrap(),
    );
    hub.area.records.workstream_put(&order).unwrap();
    let idle = |text: &str| text.contains("\nIdle: 3 slots have sat free for 30 min");

    // The launch was refused: its first message never went, so the next launch carries the line.
    assert!(hub.launched_prompts().is_empty());
    hub.node.runner_usable.store(true, Ordering::SeqCst);
    hub.area.leads.auto_start(&hub.project, None).await;
    assert!(
        idle(&hub.launched_prompts()[0]),
        "{}",
        hub.launched_prompts()[0]
    );

    // Shown at the start: a wake in the same stretch leaves it out.
    hub.order("add a /ready endpoint").await;
    hub.after_debounce().await;
    let sends = hub.node.sends.lock().unwrap().clone();
    assert_eq!(sends.len(), 1);
    assert!(!idle(&sends[0]), "{}", sends[0]);

    // A failed wake doesn't use up a new stretch's line; the next one that goes out carries it, once.
    tasks.0.store(2, Ordering::SeqCst);
    hub.node.send_fails.store(true, Ordering::SeqCst);
    hub.order("add a /live endpoint").await;
    hub.after_debounce().await;
    hub.node.send_fails.store(false, Ordering::SeqCst);
    for text in ["add a /metrics endpoint", "add a /version endpoint"] {
        hub.order(text).await;
        hub.after_debounce().await;
    }
    let sends = hub.node.sends.lock().unwrap().clone();
    let carried: Vec<bool> = sends.iter().map(|s| idle(s)).collect();
    assert_eq!(carried, [false, true, true, false], "{sends:#?}");
}
