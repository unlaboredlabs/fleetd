//! The ops areas' ports over the real hub: one `OpsPorts` per hub, built empty in `serve::build_on` (before the
//! `Hub` exists) and bound to it in `serve::start_loops`. Every method reads the other areas through `Hub`.
use super::ports::{self, BoxFut, HubEvent, NewEvent, ThreadRef, WaitInput, WaitPage};
use super::service::{UsageOwners, UsageQueue};
use super::source::{UsageReading, UsageSource};
use super::state::{Owner, ParkedThread};
use crate::hub::api::Hub;
use crate::hub::store;
use serde_json::Value;
use std::sync::{Arc, OnceLock, Weak};

#[derive(Default)]
pub struct OpsPorts {
    hub: OnceLock<Weak<Hub>>,
}

impl OpsPorts {
    pub fn bind(&self, hub: &Arc<Hub>) {
        let _ = self.hub.set(Arc::downgrade(hub));
    }

    pub(crate) fn hub(&self) -> Arc<Hub> {
        self.hub
            .get()
            .and_then(Weak::upgrade)
            .expect("ops ports are bound in start_loops before any use")
    }
}

/// A contracts value as the ops areas' wire JSON, and back: both sides serialise to the same JSON.
pub(crate) fn convert<A: serde::Serialize, B: serde::de::DeserializeOwned>(a: &A) -> Option<B> {
    serde_json::from_value(serde_json::to_value(a).ok()?).ok()
}

impl ports::EventLog for OpsPorts {
    fn append(&self, event: NewEvent) -> BoxFut<'_, HubEvent> {
        Box::pin(async move {
            let mut json =
                serde_json::json!({ "at": event.at, "type": event.kind, "summary": event.summary });
            for (k, v) in [
                ("machineId", event.machine_id.map(Value::String)),
                ("projectId", event.project_id.map(Value::String)),
                ("threadId", event.thread_id.map(Value::String)),
                ("data", event.data),
                ("attention", event.attention.map(Value::String)),
            ] {
                if let Some(v) = v {
                    json[k] = v;
                }
            }
            let typed: store::NewEvent =
                serde_json::from_value(json).expect("ops events use contract event types");
            let appended = self
                .hub()
                .events
                .append(typed)
                .expect("the event log appends");
            convert(&appended).expect("a hub event reads back")
        })
    }

    fn head(&self) -> BoxFut<'_, u64> {
        Box::pin(async move { self.hub().events.head().max(0) as u64 })
    }

    fn wait(&self, input: WaitInput) -> BoxFut<'_, WaitPage> {
        Box::pin(async move {
            let types = (!input.types.is_empty()).then(|| {
                input
                    .types
                    .iter()
                    .filter_map(|t| convert(&t.to_string()))
                    .collect()
            });
            let machine_id = input.machine_id.as_ref().and_then(convert);
            let hub = self.hub();
            match hub
                .events
                .wait(store::WaitInput {
                    cursor: Some(input.cursor as i64),
                    types,
                    machine_id,
                    timeout_sec: input.timeout_sec,
                })
                .await
            {
                Ok(page) => WaitPage {
                    events: page.events.iter().filter_map(convert).collect(),
                    cursor: page.cursor.max(0) as u64,
                    more: page.more,
                },
                Err(error) => {
                    tracing::warn!(%error, "ops: event log wait failed");
                    WaitPage {
                        events: Vec::new(),
                        cursor: input.cursor,
                        more: false,
                    }
                }
            }
        })
    }
}

// WIRE(tasks, leads): TaskRecords::by_thread / get and LeadRecords::leads list.
impl UsageOwners for OpsPorts {
    fn owner_of(&self, _thread: &ThreadRef) -> BoxFut<'_, Option<Owner>> {
        Box::pin(async { None })
    }
    fn still_parked(&self, _parked: &ParkedThread) -> BoxFut<'_, bool> {
        Box::pin(async { false })
    }
}

// WIRE(queue): WriteQueue::send.
impl UsageQueue for OpsPorts {
    fn send(
        &self,
        _thread: &ThreadRef,
        _message: &str,
        _id: &str,
    ) -> BoxFut<'_, Result<(), String>> {
        Box::pin(async { Err("the write queue is not wired".to_string()) })
    }
}

// WIRE(executor): server.getConfig's provider status and env names, and the T3 URL.
impl UsageSource for OpsPorts {
    fn read(&self, machine_id: &str) -> BoxFut<'_, Result<UsageReading, String>> {
        let m = machine_id.to_string();
        Box::pin(async move { Err(format!("{m}'s T3 is not wired")) })
    }
}

use crate::hub::approvals::{
    ApprovalAsks, ApprovalHub, ApprovalNodes, ApprovalRefused, GatedOutcome, NodeCommandError,
    SecretOutcome,
};
use crate::hub::doctor::checks::MachineView;
use crate::hub::doctor::service::ActionOutcome;
use crate::hub::doctor::{DoctorFleet, T3Settings};
use crate::hub::retro::metrics::RetroWork;
use crate::hub::retro::records::SqlRunner;
use crate::hub::retro::service::{RetroLedger, RetroPlaybooks, RetroRunner};
use crate::hub::retro::types::OrchestratorRun;
use crate::hub::retro::validate::PlaybookParser;
use crate::hub::usage::service::UsageStatus;
use serde_json::Map;

fn unwired<T>(what: &str) -> Result<T, String> {
    Err(format!("{what} is not wired"))
}

impl DoctorFleet for OpsPorts {
    fn machines(&self) -> BoxFut<'_, Vec<MachineView>> {
        Box::pin(async move {
            self.hub()
                .store
                .machines_list()
                .map(|ms| ms.iter().filter_map(convert).collect())
                .unwrap_or_default()
        })
    }
    // WIRE(executor): Executors::is_connected / await_live.
    fn connected(&self, _machine_id: &str) -> BoxFut<'_, bool> {
        Box::pin(async { false })
    }
    fn await_live(&self, _machine_id: &str) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
    fn usage(&self, machine_id: &str) -> BoxFut<'_, UsageStatus> {
        let m = machine_id.to_string();
        Box::pin(async move {
            let hub = self.hub();
            hub.usage
                .status(&m, UsageSource::read(self, &m).await)
                .await
        })
    }
    // WIRE(link): NodeCommands::run_action.
    fn node_action(
        &self,
        machine_id: &str,
        _action: &str,
    ) -> BoxFut<'_, Result<ActionOutcome, String>> {
        let m = machine_id.to_string();
        Box::pin(async move { Err(format!("{m}'s node is not linked to the hub")) })
    }
}

// WIRE(executor): settings_read / settings_update.
impl T3Settings for OpsPorts {
    fn read(&self, _machine_id: &str) -> BoxFut<'_, Result<Value, String>> {
        Box::pin(async { unwired("T3 settings") })
    }
    fn update(
        &self,
        _machine_id: &str,
        _patch: Value,
        _m: Option<Value>,
    ) -> BoxFut<'_, Result<Value, String>> {
        Box::pin(async { unwired("T3 settings") })
    }
}

fn unwired_refusal<T>() -> Result<T, ApprovalRefused> {
    Err(ApprovalRefused {
        code: "invalid".into(),
        message: "the ledger is not wired".into(),
        fix: None,
    })
}

// WIRE(ledger): Asks get / list / create / update / reopen.
impl ApprovalAsks for OpsPorts {
    fn get(&self, _ask_id: &str) -> BoxFut<'_, Option<Value>> {
        Box::pin(async { None })
    }
    fn list_answered(&self) -> BoxFut<'_, Vec<Value>> {
        Box::pin(async { Vec::new() })
    }
    fn create(&self, _input: Value, _by: &str) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
        Box::pin(async { unwired_refusal() })
    }
    fn update(
        &self,
        _ask_id: &str,
        _patch: Map<String, Value>,
    ) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
        Box::pin(async { unwired_refusal() })
    }
    fn reopen(&self, _ask_id: &str, _evidence: &str) -> BoxFut<'_, Result<Value, ApprovalRefused>> {
        Box::pin(async { unwired_refusal() })
    }
}

// WIRE(link): NodeCommands::deliver_secret / run_gated.
impl ApprovalNodes for OpsPorts {
    fn deliver_secret(
        &self,
        m: &str,
        _input: Value,
    ) -> BoxFut<'_, Result<SecretOutcome, NodeCommandError>> {
        let message = format!("{m}'s node is not linked to the hub");
        Box::pin(async move {
            Err(NodeCommandError {
                reason: "offline".into(),
                message,
            })
        })
    }
    fn run_gated(
        &self,
        m: &str,
        _input: Value,
    ) -> BoxFut<'_, Result<GatedOutcome, NodeCommandError>> {
        let message = format!("{m}'s node is not linked to the hub");
        Box::pin(async move {
            Err(NodeCommandError {
                reason: "offline".into(),
                message,
            })
        })
    }
}

impl ApprovalHub for OpsPorts {
    fn box_key(&self, machine_id: &str) -> BoxFut<'_, Option<Option<String>>> {
        let m: Option<fleetd_contracts::ids::MachineId> = convert(&machine_id);
        Box::pin(async move {
            let machine = self.hub().store.machine_get(&m?).ok()??;
            Some(machine.box_pub_key.as_ref().and_then(convert))
        })
    }
    fn workspace_root(&self, project: &ports::ProjectRef) -> BoxFut<'_, Option<String>> {
        let r: Option<fleetd_contracts::ids::ProjectRef> = convert(project);
        Box::pin(async move { Some(self.hub().store.project_get(&r?).ok()??.workspace_root) })
    }
    // WIRE(leads): LeadWakes::trigger with an answer.
    fn wake_answer(
        &self,
        _project: &ports::ProjectRef,
        _ask: Value,
        _value: String,
    ) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
    // WIRE(checks): CheckRunner::verify.
    fn verify(
        &self,
        _p: &ports::ProjectRef,
        _w: Option<String>,
        _v: Value,
    ) -> BoxFut<'_, (String, String)> {
        Box::pin(async { ("error".to_string(), "checks are not wired".to_string()) })
    }
}

impl SqlRunner for OpsPorts {
    fn run(
        &self,
        f: &mut dyn FnMut(&rusqlite::Connection) -> rusqlite::Result<()>,
    ) -> Result<(), String> {
        self.hub()
            .db
            .with(|c| f(c).map_err(store::StoreError::from))
            .map_err(|e| e.to_string())
    }
}

// WIRE(intake): the router's one-shot claude runner with RUN_TIMEOUT_MS.
impl RetroRunner for OpsPorts {
    fn ask(&self, _prompt: String) -> BoxFut<'_, (Option<String>, OrchestratorRun)> {
        Box::pin(async {
            let run = OrchestratorRun {
                kind: "orchestrator".into(),
                model: "claude-haiku-5-5".into(),
                duration_ms: 0,
                ok: false,
                input_tokens: None,
                output_tokens: None,
                error: Some("the claude runner is not wired".into()),
            };
            (None, run)
        })
    }
}

struct NoParser;
impl PlaybookParser for NoParser {
    fn parse(&self, _t: &str, place: &str, _e: Option<&str>) -> Result<Map<String, Value>, String> {
        Err(format!(
            "playbook {place} cannot be read: playbooks are not wired"
        ))
    }
}

// WIRE(playbooks): Playbooks current / override / set_override and parse_playbook.
impl RetroPlaybooks for OpsPorts {
    fn current(&self, name: &str) -> (String, String) {
        (String::new(), format!("{name}@unknown"))
    }
    fn override_text(&self, _name: &str) -> Option<String> {
        None
    }
    fn set_override(&self, _name: &str, _text: Option<&str>) -> Result<String, String> {
        unwired("playbooks")
    }
    fn parser(&self) -> &dyn PlaybookParser {
        &NoParser
    }
}

// WIRE(ledger, incidents): global decisions, asks and incidents.
impl RetroLedger for OpsPorts {
    fn global_value(&self, _key: &str) -> BoxFut<'_, Option<String>> {
        Box::pin(async { None })
    }
    fn decision_value(&self, _id: &str) -> BoxFut<'_, Option<String>> {
        Box::pin(async { None })
    }
    fn ask_state(&self, _id: &str) -> BoxFut<'_, Option<(String, Option<String>)>> {
        Box::pin(async { None })
    }
    fn create_ask(&self, _input: Value, _by: &str) -> BoxFut<'_, Result<String, String>> {
        Box::pin(async { unwired("the ledger") })
    }
    fn incident(&self, _id: &str) -> BoxFut<'_, Option<Value>> {
        Box::pin(async { None })
    }
    fn incident_count(&self, _class: &str, _since: i64) -> BoxFut<'_, u64> {
        Box::pin(async { 0 })
    }
    fn record_incident(&self, _input: Value) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
}

// WIRE(incidents, leads, tasks).
impl RetroWork for OpsPorts {
    fn incidents(&self, _from: i64, _to: Option<i64>, _limit: usize) -> BoxFut<'_, Vec<Value>> {
        Box::pin(async { Vec::new() })
    }
    fn workstream_playbook(&self, _id: &str) -> BoxFut<'_, Option<String>> {
        Box::pin(async { None })
    }
    fn done_workstreams(&self, _limit: usize) -> BoxFut<'_, Vec<(String, Option<String>, String)>> {
        Box::pin(async { Vec::new() })
    }
    fn task_spans(&self, _id: &str) -> BoxFut<'_, Vec<(Option<String>, Option<String>)>> {
        Box::pin(async { Vec::new() })
    }
}

/// The four ops services over one set of ports, for `serve::build_on`.
pub struct Ops {
    pub ports: Arc<OpsPorts>,
    pub usage: Arc<super::Usage>,
    pub doctor: Arc<crate::hub::doctor::Doctor>,
    pub retro: Arc<crate::hub::retro::Retro>,
    pub approvals: Arc<crate::hub::approvals::Approvals>,
}

pub fn build(config: &crate::hub::api::HubConfig, clock: Arc<dyn crate::clock::Clock>) -> Ops {
    let ports = Arc::new(OpsPorts::default());
    let usage = Arc::new(super::Usage::new(super::UsageDeps {
        events: ports.clone(),
        queue: ports.clone(),
        owners: ports.clone(),
        clock: clock.clone(),
    }));
    let doctor = crate::hub::doctor::Doctor::new(crate::hub::doctor::DoctorDeps {
        listen_host: config.listen.host.clone(),
        listen_port: config.listen.port,
        home: config.home.clone(),
        fleet: ports.clone(),
        settings: ports.clone(),
        events: ports.clone(),
        clock: clock.clone(),
    });
    let retro = crate::hub::retro::Retro::new(crate::hub::retro::RetroDeps {
        db: ports.clone(),
        runner: ports.clone(),
        playbooks: ports.clone(),
        ledger: ports.clone(),
        work: ports.clone(),
        events: ports.clone(),
        clock: clock.clone(),
    });
    let approvals = crate::hub::approvals::Approvals::new(crate::hub::approvals::ApprovalsDeps {
        asks: ports.clone(),
        nodes: ports.clone(),
        hub: ports.clone(),
        events: ports.clone(),
        clock,
    });
    Ops {
        ports,
        usage,
        doctor,
        retro,
        approvals,
    }
}

/// Binds the ports to the hub and starts the ops loops: usage's follower, approvals' answers, the retro's schedule,
/// and the doctor's 15-minute run.
pub fn start(hub: &Arc<Hub>) -> Vec<tokio::task::JoinHandle<()>> {
    hub.ops.bind(hub);
    let (usage, approvals, retro, doctor, stop) = (
        hub.usage.clone(),
        hub.approvals.clone(),
        hub.retro.clone(),
        hub.doctor.clone(),
        hub.shutdown.clone(),
    );
    let until_stop = move |f: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>| {
        let stop = stop.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = f => {}
                () = stop.wait() => {}
            }
        })
    };
    let clock = hub.clock.clone();
    vec![
        until_stop(Box::pin(async move { usage.serve().await })),
        until_stop(Box::pin(async move { approvals.serve().await })),
        until_stop(Box::pin(async move { retro.serve().await })),
        until_stop(Box::pin(async move {
            loop {
                doctor.run_if_due().await;
                clock.sleep(std::time::Duration::from_secs(60)).await;
            }
        })),
    ]
}
