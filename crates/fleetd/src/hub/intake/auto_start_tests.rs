//! An order for a project without a lead: the lead starts and gets it, or the order waits with the reason, and the
//! lead starts once the machine comes online with a usable runner.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::effort::Effort;
use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, ProjectId, ProjectRef, ThreadId, ThreadRef, Timestamp};
use fleetd_contracts::ledger::{Decision, HumanRequest, IntakeChannel, WorkstreamId};
use fleetd_contracts::mcp::{ErrorCode, ThreadLaunchInput};
use fleetd_contracts::model::{ProjectSummary, ThreadCounts};

use super::SubmitInput;
use crate::hub::leads::hooks::{BoxFuture, PolicyHook};
use crate::hub::leads::ports::{CmdOutcome, LeadPorts};
use crate::hub::leads::wakes::WAKE_DEBOUNCE;
use crate::hub::leads::{Area, AreaOptions, Ctx, LeadError};
use crate::hub::store::test_clock::ManualClock;
use crate::hub::store::{EventLog, HubDb, HubStore, NewEvent, iso_ms};
use crate::hub::tasks::resolve::ModelEffort;

const T0_MS: u64 = 1_792_231_200_000;
const MACHINE: &str = "lab-a";
const NOT_LOGGED_IN: &str = "claude is not logged in on this machine";
const LOGIN_FIX: &str = "On lab-a: CLAUDE_CONFIG_DIR=~/.fleetd/claude claude auth login.";

/// The node: refuses launches while the runner is unusable, as the executor's launch gate does.
#[derive(Default)]
pub(crate) struct Node {
    runner_usable: AtomicBool,
    pub(crate) launches: Mutex<Vec<ThreadLaunchInput>>,
    pub(crate) sends: Mutex<Vec<String>>,
    /// Each `configure`: the thread and the model and effort it runs on from its next turn.
    pub(crate) configures: Mutex<Vec<(String, String, Effort)>>,
}

struct Ports(Arc<Node>);

impl LeadPorts for Ports {
    fn launch(
        &self,
        _: &MachineId,
        input: ThreadLaunchInput,
    ) -> BoxFuture<Result<ThreadId, LeadError>> {
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
    fn configure(
        &self,
        thread: ThreadRef,
        model: String,
        effort: Effort,
    ) -> BoxFuture<Result<(), LeadError>> {
        self.0
            .configures
            .lock()
            .unwrap()
            .push((thread.thread_id.to_string(), model, effort));
        Box::pin(async { Ok(()) })
    }
    fn run_command(
        &self,
        _: &MachineId,
        _: String,
        _: Vec<String>,
        _: u32,
    ) -> BoxFuture<Result<CmdOutcome, String>> {
        Box::pin(async { Err("no commands here".to_string()) })
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
    fn decision(&self, _: &str) -> Result<Option<Decision>, LeadError> {
        Ok(None)
    }
}

/// `lead.autoStart` and `defaults` from the project's policy file. Reading it goes through the node, which takes a
/// few ms.
struct Policy {
    auto_start: bool,
    clock: Arc<ManualClock>,
    defaults: Arc<Mutex<ModelEffort>>,
}

impl PolicyHook for Policy {
    fn max_children(&self, _: &ProjectRef) -> BoxFuture<Result<Option<u32>, LeadError>> {
        Box::pin(async { Ok(None) })
    }
    fn auto_start(&self, _: &ProjectRef) -> BoxFuture<Result<bool, LeadError>> {
        self.clock.advance(Duration::from_millis(5));
        let on = self.auto_start;
        Box::pin(async move { Ok(on) })
    }
    fn defaults(&self, _: &ProjectRef) -> BoxFuture<Option<ModelEffort>> {
        let defaults = self.defaults.lock().unwrap().clone();
        Box::pin(async move { Some(defaults) })
    }
}

pub(crate) struct Hub {
    pub(crate) area: Arc<Area>,
    pub(crate) node: Arc<Node>,
    /// What the project's policy file says under `defaults`.
    pub(crate) policy_defaults: Arc<Mutex<ModelEffort>>,
    clock: Arc<ManualClock>,
    events: Arc<EventLog>,
    pub(crate) project: ProjectRef,
    _home: tempfile::TempDir,
}

/// A hub home in a temporary directory, so prompt overrides have somewhere to live.
pub(crate) fn hub(runner_usable: bool, auto_start: bool) -> Hub {
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
    let area = Area::new(
        Ctx::new(db, store, events.clone(), clock.clone()),
        AreaOptions {
            home: home.path(),
        },
    )
    .unwrap();
    let node = Arc::new(Node {
        runner_usable: AtomicBool::new(runner_usable),
        ..Default::default()
    });
    area.ctx.set_ports(Arc::new(Ports(node.clone())));
    let policy_defaults = Arc::new(Mutex::new(ModelEffort::default()));
    let _ = area.ctx.hooks.policy.set(Arc::new(Policy {
        auto_start,
        clock: clock.clone(),
        defaults: policy_defaults.clone(),
    }));
    Hub {
        area,
        node,
        policy_defaults,
        clock,
        events,
        project,
        _home: home,
    }
}

impl Hub {
    pub(crate) async fn order(&self, text: &str) -> (WorkstreamId, String, Option<String>) {
        let placed = self
            .area
            .intake
            .submit(SubmitInput {
                text: text.into(),
                template: None,
                project_ref: Some(self.project.clone()),
                client_request_id: text.into(),
                channel: IntakeChannel::Mcp,
                by: "human".into(),
                allows: Box::new(|_| true),
            })
            .await
            .unwrap();
        (
            placed.workstream_id,
            placed.next.unwrap(),
            placed.lead_waiting,
        )
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
    let hub = hub(true, true);
    let (w1, next, waiting) = hub.order("add a /health endpoint").await;
    assert_eq!(waiting, None);
    assert!(next.contains("is starting and picks it up"), "{next}");
    let prompts = hub.launched_prompts();
    assert_eq!(prompts.len(), 1);
    assert!(
        prompts[0].contains(w1.as_str()) && prompts[0].contains("add a /health endpoint"),
        "the lead's first message lists the order: {}",
        prompts[0]
    );
    assert!(hub.area.leads.get(&hub.project).unwrap().is_some());
    assert_eq!(hub.events_of(HubEventType::LeadStarted), 1);

    // The next order goes to the running lead as a wake; the first one is not said twice.
    let (w2, _, waiting) = hub.order("add a /ready endpoint").await;
    assert_eq!(waiting, None);
    hub.after_debounce().await;
    let sends = hub.node.sends.lock().unwrap().clone();
    assert_eq!(sends.len(), 1);
    assert!(
        sends[0].contains(&format!("new order {w2}")),
        "{}",
        sends[0]
    );
    assert!(
        !sends[0].contains(&format!("new order {w1}")),
        "{}",
        sends[0]
    );
    assert_eq!(hub.launched_prompts().len(), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn an_unusable_runner_holds_the_order_with_its_reason_until_the_machine_is_online() {
    let hub = hub(false, true);
    let waiting_loop = tokio::spawn(hub.area.leads.clone().run_waiting());
    settle().await;
    let (w1, next, waiting) = hub.order("add a /health endpoint").await;
    assert_eq!(
        waiting.as_deref(),
        Some(format!("{NOT_LOGGED_IN} {LOGIN_FIX}").as_str())
    );
    assert!(
        next.contains(NOT_LOGGED_IN) && next.contains(LOGIN_FIX),
        "{next}"
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

#[tokio::test(flavor = "current_thread")]
async fn a_policy_that_turns_auto_start_off_keeps_the_order_a_draft_and_says_so() {
    let hub = hub(true, false);
    let waiting_loop = tokio::spawn(hub.area.leads.clone().run_waiting());
    settle().await;
    let (_, next, waiting) = hub.order("add a /health endpoint").await;
    assert!(
        waiting
            .as_deref()
            .is_some_and(|w| w.contains("lead.autoStart: false") && w.contains("lead_start")),
        "{waiting:?}"
    );
    assert!(next.contains("waiting for its lead"), "{next}");
    hub.machine_online();
    settle().await;
    assert!(hub.launched_prompts().is_empty());
    assert!(hub.area.leads.get(&hub.project).unwrap().is_none());
    waiting_loop.abort();
}
