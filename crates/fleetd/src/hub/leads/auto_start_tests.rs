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
use crate::hub::leads::wakes::{LineKind, Trigger, WAKE_DEBOUNCE};
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
        Box::pin(async { Ok(false) })
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
    clock: Arc<ManualClock>,
    events: Arc<EventLog>,
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
        let lead = self.area.leads.auto_start(&self.project).await;
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
async fn a_merge_or_a_result_wakes_an_idle_lead_at_once_and_a_busy_one_after_the_window() {
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

    // Idle, and the last wake one window ago: a merge goes now, without the clock moving.
    lead_thread(&hub, "idle");
    hub.clock.advance(WAKE_DEBOUNCE);
    wakes.trigger(&hub.project, line(LineKind::Train, "#353 merged"));
    settle().await;
    assert_eq!(sends(), start + 2);
    assert!(hub.node.sends.lock().unwrap()[start + 1].contains("#353 merged"));

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
