//! The ops areas' ports over the real hub: one `OpsPorts` per hub, built empty in `serve::build_on` (before the
//! `Hub` exists) and bound to it in `serve::start_loops`. Every method reads the other areas through `Hub`.
use super::ports::{self, BoxFut, NewEvent, ThreadRef, WaitInput, WaitPage};
use super::service::{UsageOwners, UsageQueue};
use super::source::{UsageReading, UsageSource};
use super::state::{Owner, ParkedKind, ParkedThread};
use crate::hub::api::Hub;
use crate::hub::store;
use crate::hub::tasks::records::{ENDED_STATES, TaskRecords};
use fleetd_contracts::events::HubEvent;
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
            self.hub()
                .events
                .append(typed)
                .expect("the event log appends")
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
                    events: page.events,
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

fn logged<T, E: std::fmt::Display>(result: Result<T, E>, what: &str) -> Option<T> {
    result
        .map_err(|error| tracing::warn!(%error, "ops: {what} failed"))
        .ok()
}

impl OpsPorts {
    /// The thread is a lead's current one.
    fn is_lead_thread(&self, machine_id: &str, thread_id: &str) -> bool {
        logged(self.hub().leads.records.leads_list(), "listing leads")
            .unwrap_or_default()
            .iter()
            .any(|l| {
                l.project_ref.machine_id.as_str() == machine_id && l.thread_id.as_str() == thread_id
            })
    }
}

impl UsageOwners for OpsPorts {
    fn owner_of(&self, thread: &ThreadRef) -> BoxFut<'_, Option<Owner>> {
        let target: Option<fleetd_contracts::ids::ThreadRef> = convert(thread);
        let (machine_id, thread_id) = (thread.machine_id.clone(), thread.thread_id.clone());
        Box::pin(async move {
            let hub = self.hub();
            if let Some(target) = target {
                let task = hub.db.with(|c| Ok(TaskRecords::by_thread(c, &target)?));
                if let Some(stored) = logged(task, "reading a thread's task").flatten() {
                    return Some(Owner {
                        kind: convert(&stored.task.kind)?,
                        task_id: Some(stored.task.task_id.to_string()),
                    });
                }
            }
            self.is_lead_thread(&machine_id, &thread_id)
                .then_some(Owner {
                    kind: ParkedKind::Lead,
                    task_id: None,
                })
        })
    }

    fn still_parked(&self, parked: &ParkedThread) -> BoxFut<'_, bool> {
        let parked = parked.clone();
        Box::pin(async move {
            if parked.kind == ParkedKind::Lead {
                return self.is_lead_thread(&parked.thread.machine_id, &parked.thread.thread_id);
            }
            let Some(task_id) = parked.task_id.as_ref().and_then(convert) else {
                return false;
            };
            let stored = self.hub().db.with(|c| Ok(TaskRecords::get(c, &task_id)?));
            logged(stored, "reading a task")
                .flatten()
                .is_some_and(|s| !ENDED_STATES.contains(&s.task.state))
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
            let info = self
                .hub()
                .executors
                .runner_info(&m)
                .await
                .map_err(|e| e.to_string())?;
            Ok(UsageReading {
                login: super::source::login_kind_of(info.login_kind.as_deref()),
            })
        })
    }
}

use crate::hub::doctor::DoctorFleet;
use crate::hub::doctor::checks::MachineView;
use crate::hub::doctor::service::ActionOutcome;
use crate::hub::usage::service::UsageStatus;

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
    fn usage(&self, machine_id: &str) -> BoxFut<'_, UsageStatus> {
        let m = machine_id.to_string();
        Box::pin(async move {
            let hub = self.hub();
            hub.usage
                .status(&m, UsageSource::read(self, &m).await)
                .await
        })
    }
    /// The runner as the node last reported it (pushed events keep it fresh), else asked for now.
    fn runner_info(
        &self,
        machine_id: &str,
    ) -> BoxFut<'_, Option<fleetd_contracts::sessions::RunnerInfo>> {
        let m = machine(machine_id);
        Box::pin(async move {
            let m = m?;
            let executors = &self.hub().executors;
            match executors.cached_runner(&m) {
                Some(info) => Some(info),
                None => executors.runner_info(&m).await.ok(),
            }
        })
    }
    fn guard(
        &self,
        machine_id: &str,
    ) -> (
        Option<fleetd_contracts::node_link::NodeDisk>,
        Option<String>,
    ) {
        let Some(m) = machine(machine_id) else {
            return (None, None);
        };
        let link = &self.hub().link;
        (link.load(&m).and_then(|l| l.disk), link.paused(&m))
    }
    fn project_areas(
        &self,
        machine_id: &str,
    ) -> BoxFut<'_, Vec<crate::hub::doctor::service::ProjectAreas>> {
        let m = machine(machine_id);
        Box::pin(async move {
            let Some(m) = m else { return Vec::new() };
            let hub = self.hub();
            let projects = hub.store.projects_list(Some(&m), None).unwrap_or_default();
            let mut out = Vec::new();
            for p in projects {
                let r = fleetd_contracts::ids::ProjectRef {
                    machine_id: p.machine_id,
                    project_id: p.project_id,
                };
                if let Ok(resolved) = hub.policies.resolve(&r).await {
                    out.push(crate::hub::doctor::service::ProjectAreas {
                        title: p.title,
                        areas: resolved.policy.areas.into_keys().collect(),
                        inferred: resolved.inferred,
                        ignored_defaults: resolved.ignored_defaults,
                    });
                }
            }
            out
        })
    }
    /// One `true` in each project's checkout: the node answers a refusal without running anything.
    fn refused_projects(&self, machine_id: &str) -> BoxFut<'_, Vec<(String, String)>> {
        let m = machine(machine_id);
        Box::pin(async move {
            let Some(m) = m else { return Vec::new() };
            let hub = self.hub();
            let roots: Vec<String> = hub
                .store
                .projects_list(Some(&m), None)
                .unwrap_or_default()
                .into_iter()
                .map(|p| p.workspace_root)
                .collect();
            let answers = futures_util::future::join_all(roots.into_iter().map(|root| {
                let (hub, m) = (hub.clone(), m.clone());
                async move {
                    let input = crate::hub::link::commands::CommandInput {
                        cwd: root.clone(),
                        argv: vec!["true".into()],
                        timeout_sec: Some(30),
                    };
                    let result = hub.node_commands.run(&m, input).await.ok()?;
                    let why = crate::node::cmd::refusal(
                        result.exit_code.is_none(),
                        result.output_tail.as_str(),
                    )?;
                    Some((root, why.to_owned()))
                }
            }))
            .await;
            answers.into_iter().flatten().collect()
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
                message: result.message.to_string(),
                probe: result.probe.as_ref().and_then(convert),
            })
        })
    }
}

/// Wakes wait while usage holds the thread.
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

/// The three ops services over one set of ports, for `serve::build_on`.
pub struct Ops {
    pub ports: Arc<OpsPorts>,
    pub usage: Arc<super::Usage>,
    pub doctor: Arc<crate::hub::doctor::Doctor>,
    pub approvals: Arc<crate::hub::approvals::Approvals>,
}

pub fn build(
    config: &crate::hub::api::HubConfig,
    clock: Arc<dyn crate::clock::Clock>,
    requests: Arc<crate::hub::approvals::store::Requests>,
) -> Ops {
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
        events: ports.clone(),
        clock: clock.clone(),
    });
    let approvals = crate::hub::approvals::Approvals::new(crate::hub::approvals::ApprovalsDeps {
        requests,
        nodes: ports.clone(),
        hub: ports.clone(),
        events: ports.clone(),
        clock,
    });
    Ops {
        ports,
        usage,
        doctor,
        approvals,
    }
}

/// Binds the ports to the hub and starts the ops loops: usage's follower, approvals' answers and the
/// doctor's 15-minute run.
pub fn start(hub: &Arc<Hub>) -> Vec<tokio::task::JoinHandle<()>> {
    hub.ops.bind(hub);
    let (usage, approvals, doctor, stop) = (
        hub.usage.clone(),
        hub.approvals.clone(),
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
        until_stop(Box::pin(async move {
            loop {
                doctor.run_if_due().await;
                clock.sleep(std::time::Duration::from_secs(60)).await;
            }
        })),
    ]
}
