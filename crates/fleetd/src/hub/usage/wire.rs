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

// PORT(tasks, leads): TaskRecords::by_thread / get and LeadRecords::leads list.
impl UsageOwners for OpsPorts {
    fn owner_of(&self, _thread: &ThreadRef) -> BoxFut<'_, Option<Owner>> {
        Box::pin(async { None })
    }
    fn still_parked(&self, _parked: &ParkedThread) -> BoxFut<'_, bool> {
        Box::pin(async { false })
    }
}

impl UsageQueue for OpsPorts {
    fn send(&self, thread: &ThreadRef, message: &str, id: &str) -> BoxFut<'_, Result<(), String>> {
        let target: Option<fleetd_contracts::ids::ThreadRef> = convert(thread);
        let (message, id) = (message.to_owned(), id.to_owned());
        Box::pin(async move {
            let target = target.ok_or("not a thread ref")?;
            self.hub()
                .queue
                .send(&target, &message, &id, None)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
    }
}

fn machine(m: &str) -> Option<fleetd_contracts::ids::MachineId> {
    convert(&m)
}

impl UsageSource for OpsPorts {
    fn read(&self, machine_id: &str) -> BoxFut<'_, Result<UsageReading, String>> {
        let m = machine(machine_id);
        Box::pin(async move {
            let m = m.ok_or("not a machine id")?;
            let hub = self.hub();
            let config = hub
                .executors
                .server_config(&m)
                .await
                .map_err(|e| e.to_string())?;
            let fleetd_instance = crate::hub::doctor::checks::FLEETD_INSTANCE;
            let fleetd = config
                .providers
                .iter()
                .find(|p| p.instance_id == fleetd_instance);
            let env: Vec<String> = config
                .settings
                .provider_instances
                .as_ref()
                .and_then(|i| i.get(fleetd_instance))
                .and_then(|i| i.environment.clone())
                .unwrap_or_default()
                .into_iter()
                .map(|v| v.name)
                .collect();
            let names: Vec<&str> = env.iter().map(String::as_str).collect();
            Ok(UsageReading {
                login: super::source::login_kind_of(
                    fleetd.and_then(|p| p.auth.kind.as_deref()),
                    fleetd.map(|p| p.auth.status.as_str()),
                    &names,
                ),
                logs_dir: Some(config.observability.logs_directory_path.clone()),
                local: super::source::is_loopback_url(
                    &hub.executors.t3_url(&m).unwrap_or_default(),
                ),
            })
        })
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
    fn connected(&self, machine_id: &str) -> BoxFut<'_, bool> {
        let m = machine(machine_id);
        Box::pin(async move { m.is_some_and(|m| self.hub().executors.is_connected(&m)) })
    }
    fn await_live(&self, machine_id: &str) -> BoxFut<'_, ()> {
        let m = machine(machine_id);
        Box::pin(async move {
            match m {
                Some(m) => self.hub().executors.await_live(&m).await,
                None => std::future::pending().await,
            }
        })
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
    fn node_action(
        &self,
        machine_id: &str,
        action: &str,
    ) -> BoxFut<'_, Result<ActionOutcome, String>> {
        let m = machine(machine_id);
        let kind: Option<fleetd_contracts::node_link::NodeActionKind> = convert(&action);
        Box::pin(async move {
            let (m, kind) = (
                m.ok_or("not a machine id")?,
                kind.ok_or("not a node action")?,
            );
            let result = self
                .hub()
                .node_commands
                .run_action(&m, kind)
                .await
                .map_err(|e| e.message)?;
            Ok(ActionOutcome {
                ok: result.ok,
                message: result.message.to_string(),
                probe: result.probe.as_ref().and_then(convert),
            })
        })
    }
}

fn settings_json(s: &t3_wire::types::ServerSettings) -> Value {
    serde_json::json!({
        "providerInstances": s.provider_instances.clone().unwrap_or_default(),
        "autoResumeLimitedThreads": s.auto_resume_limited_threads.unwrap_or(false),
    })
}

impl T3Settings for OpsPorts {
    fn read(&self, machine_id: &str) -> BoxFut<'_, Result<Value, String>> {
        let m = machine(machine_id);
        Box::pin(async move {
            let s = self
                .hub()
                .executors
                .settings_read(&m.ok_or("not a machine id")?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(settings_json(&s))
        })
    }
    fn update(
        &self,
        machine_id: &str,
        patch: Value,
        mutation: Option<Value>,
    ) -> BoxFut<'_, Result<Value, String>> {
        let m = machine(machine_id);
        Box::pin(async move {
            use t3_wire::types::{
                ProviderInstanceMutation, ProviderInstanceUpsert, SettingsPatch,
                UpdateSettingsInput,
            };
            let provider_instance_mutation = match mutation {
                None => None,
                Some(v) => Some(ProviderInstanceMutation::Upsert(ProviderInstanceUpsert {
                    instance_id: v["instanceId"].as_str().unwrap_or_default().to_string(),
                    instance: serde_json::from_value(v["instance"].clone())
                        .map_err(|e| e.to_string())?,
                })),
            };
            let input = UpdateSettingsInput {
                patch: SettingsPatch {
                    auto_resume_limited_threads: patch["autoResumeLimitedThreads"].as_bool(),
                },
                provider_instance_mutation,
            };
            let s = self
                .hub()
                .executors
                .settings_update(&m.ok_or("not a machine id")?, &input)
                .await
                .map_err(|e| e.to_string())?;
            Ok(settings_json(&s))
        })
    }
}

fn unwired_refusal<T>() -> Result<T, ApprovalRefused> {
    Err(ApprovalRefused {
        code: "invalid".into(),
        message: "the ledger is not wired".into(),
        fix: None,
    })
}

// PORT(ledger): Asks get / list / create / update / reopen.
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

// PORT(link): NodeCommands::deliver_secret / run_gated.
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
    // PORT(leads): LeadWakes::trigger with an answer.
    fn wake_answer(
        &self,
        _project: &ports::ProjectRef,
        _ask: Value,
        _value: String,
    ) -> BoxFut<'_, ()> {
        Box::pin(async {})
    }
    // PORT(checks): CheckRunner::verify.
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

// PORT(intake): the router's one-shot claude runner with RUN_TIMEOUT_MS.
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

// PORT(playbooks): Playbooks current / override / set_override and parse_playbook.
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

// PORT(ledger, incidents): global decisions, asks and incidents.
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

// PORT(incidents, leads, tasks).
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

/// Wakes wait while usage holds the thread (TS Wakes over Usage.hold / whenClear).
impl crate::hub::queue::ports::UsageHold for super::Usage {
    fn hold(
        &self,
        target: &fleetd_contracts::ids::ThreadRef,
    ) -> crate::hub::queue::ports::BoxFuture<'_, Option<String>> {
        let r: Option<ThreadRef> = convert(target);
        Box::pin(async move { super::Usage::hold(self, &r?) })
    }
    fn when_clear(
        &self,
        target: &fleetd_contracts::ids::ThreadRef,
    ) -> crate::hub::queue::ports::BoxFuture<'_, ()> {
        let r: Option<ThreadRef> = convert(target);
        Box::pin(async move {
            if let Some(r) = r {
                super::Usage::when_clear(self, &r).await;
            }
        })
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
    // TS FleetApi: no new turn goes into a login fleetd knows is exhausted.
    hub.executors.hooks.gate_launch(Arc::new(|hub, machine_id| {
        Box::pin(async move { hub.usage.gate(machine_id.as_str()) })
    }));
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
