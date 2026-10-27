//! Administration > Machines (W105): the hub adds and removes machines for an owner or admin, with the CLI's own
//! `machine add` and `machine remove` (cli/setup/machine.rs), run here with the hub's database instead of one opened
//! beside it. `machine_add` answers at once with its run and goes on in the background: each step it starts or ends
//! updates the run and sends a `machine_add.step` event, and `machine_add_status` reads the run. Runs live in memory:
//! a hub that restarts forgets them, and adding the machine again picks up where it stopped (finished steps are
//! skipped). A machine of another OS or CPU than the hub's gets the hub's own version built for it, from its release.
pub mod tools;

#[cfg(test)]
mod tests;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::machine_setup::{
    MachineAddRun, MachineAddRunId, MachineAddState, MachineAddStepData, SetupStep, SetupStepState,
};

use crate::cli::setup::detect::Peer;
use crate::cli::setup::machine::{Begin, Builds, Progress, Releases, Runner, Ssh, Stop, tail};
use crate::hub::api::Hub;
use crate::hub::store::{NewEvent, iso_ms, now_ms};
use crate::update::BoxFuture;

/// Runs kept for machine_add_status.
const KEEP: usize = 20;
/// A step's output, at most.
const OUTPUT_MAX: usize = 4000;

/// What adding a machine reaches outside the hub: the machine, the fleetd it gets, and where hosts are found. Tests
/// stand in fakes.
pub trait SetupPorts: Send + Sync {
    fn runner(&self) -> Arc<dyn Runner>;
    /// The fleetd a machine gets: the hub's own.
    fn exe(&self) -> Result<PathBuf, String>;
    /// This hub's version built for a machine of another OS or CPU.
    fn builds(&self) -> Arc<dyn Builds>;
    /// The `Host`s in the hub user's ~/.ssh/config, and the tailnet's peers.
    fn hosts(&self) -> BoxFuture<'_, (Vec<String>, Vec<Peer>)>;
}

/// The real ones: ssh, the running fleetd, ~/.ssh/config and `tailscale status`.
pub struct RealPorts;

impl SetupPorts for RealPorts {
    fn runner(&self) -> Arc<dyn Runner> {
        Arc::new(Ssh)
    }

    fn exe(&self) -> Result<PathBuf, String> {
        crate::cli::setup::current_exe()
    }

    fn builds(&self) -> Arc<dyn Builds> {
        Arc::new(Releases)
    }

    fn hosts(&self) -> BoxFuture<'_, (Vec<String>, Vec<Peer>)> {
        use crate::cli::setup::detect;
        Box::pin(async {
            let ssh = std::fs::read_to_string(crate::cli::home_dir().join(".ssh/config"))
                .map(|text| detect::parse_ssh_hosts(&text))
                .unwrap_or_default();
            let status = crate::cli::setup::ssh::run_local(
                "tailscale",
                &["status".into(), "--json".into()],
                None,
            )
            .await;
            let peers = (status.code == 0)
                .then(|| detect::parse_tailscale_status(&status.stdout))
                .flatten()
                .map(|net| net.peers)
                .unwrap_or_default();
            (ssh, peers)
        })
    }
}

pub struct MachineSetup {
    ports: RwLock<Arc<dyn SetupPorts>>,
    /// Newest first.
    runs: Mutex<VecDeque<MachineAddRun>>,
}

impl Default for MachineSetup {
    fn default() -> Self {
        Self {
            ports: RwLock::new(Arc::new(RealPorts)),
            runs: Mutex::default(),
        }
    }
}

impl MachineSetup {
    /// Tests put fakes in.
    pub fn set_ports(&self, ports: Arc<dyn SetupPorts>) {
        *self.ports.write().unwrap() = ports;
    }

    pub fn ports(&self) -> Arc<dyn SetupPorts> {
        self.ports.read().unwrap().clone()
    }

    pub fn runs(&self) -> Vec<MachineAddRun> {
        self.runs.lock().unwrap().iter().cloned().collect()
    }

    /// Starts a run for `machine`, unless one is going for it already.
    fn start(
        &self,
        machine: &MachineId,
        host: Option<String>,
        at: Timestamp,
    ) -> Option<MachineAddRun> {
        let mut runs = self.runs.lock().unwrap();
        if runs
            .iter()
            .any(|r| &r.machine_id == machine && r.state == MachineAddState::Running)
        {
            return None;
        }
        let run = MachineAddRun {
            run_id: new_id(),
            machine_id: machine.clone(),
            host,
            state: MachineAddState::Running,
            steps: Vec::new(),
            notes: Vec::new(),
            message: None,
            fix: None,
            logged_in: None,
            started_at: at,
            finished_at: None,
        };
        runs.push_front(run.clone());
        runs.truncate(KEEP);
        Some(run)
    }

    fn update(
        &self,
        run_id: &MachineAddRunId,
        change: impl FnOnce(&mut MachineAddRun),
    ) -> Option<MachineAddRun> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs.iter_mut().find(|r| &r.run_id == run_id)?;
        change(run);
        Some(run.clone())
    }
}

fn new_id() -> MachineAddRunId {
    let bytes: [u8; 16] = rand::random();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    MachineAddRunId::unchecked(format!("M{hex}"))
}

/// `Fix: ` and what follows, apart from what went wrong.
pub fn split_fix(message: &str) -> (String, Option<String>) {
    match message.rsplit_once("Fix: ") {
        Some((what, fix)) => (what.trim_end().to_owned(), Some(fix.trim().to_owned())),
        None => (message.trim().to_owned(), None),
    }
}

fn clip(text: &str) -> Option<String> {
    let text = tail(text);
    if text.is_empty() {
        return None;
    }
    let start = text.len().saturating_sub(OUTPUT_MAX);
    let start = (start..=text.len())
        .find(|&i| text.is_char_boundary(i))
        .unwrap_or(text.len());
    Some(text[start..].to_owned())
}

/// A run's steps as `machine add` or `remove` reports them.
#[derive(Default)]
pub struct Steps {
    pub steps: Vec<SetupStep>,
    /// What it said besides its steps and notes.
    pub said: Vec<String>,
}

impl Steps {
    fn step(b: &Begin, state: SetupStepState) -> SetupStep {
        SetupStep {
            title: b.title.clone(),
            command: b.command.clone(),
            stdin: b.stdin.clone(),
            state,
            output: None,
        }
    }

    fn running(&mut self) -> Option<&mut SetupStep> {
        self.steps
            .iter_mut()
            .rev()
            .find(|s| s.state == SetupStepState::Running)
    }

    pub fn planned(&mut self, steps: &[Begin]) {
        self.steps.retain(|s| s.state != SetupStepState::Planned);
        self.steps
            .extend(steps.iter().map(|b| Self::step(b, SetupStepState::Planned)));
    }

    pub fn begin(&mut self, b: &Begin) {
        match self
            .steps
            .iter_mut()
            .find(|s| s.state == SetupStepState::Planned && s.title == b.title)
        {
            Some(planned) => *planned = Self::step(b, SetupStepState::Running),
            None => self.steps.push(Self::step(b, SetupStepState::Running)),
        }
    }

    pub fn done(&mut self, output: &str) {
        if let Some(step) = self.running() {
            step.state = SetupStepState::Done;
            step.output = clip(output);
        }
    }

    /// The step going now failed with `output`; false when none was going.
    pub fn failed(&mut self, output: &str) -> bool {
        match self.running() {
            Some(step) => {
                step.state = SetupStepState::Failed;
                step.output = clip(output);
                true
            }
            None => false,
        }
    }

    pub fn say(&mut self, line: &str) {
        // Notes come with the result.
        if !line.starts_with("note: ") {
            self.said.push(line.to_owned());
        }
    }
}

/// A machine_add's progress: each change goes into its run and out as a `machine_add.step` event.
struct Recorder {
    hub: Arc<Hub>,
    run_id: MachineAddRunId,
    steps: Mutex<Steps>,
}

impl Recorder {
    fn change(&self, change: impl FnOnce(&mut Steps)) {
        let steps = {
            let mut steps = self.steps.lock().unwrap();
            change(&mut steps);
            steps.steps.clone()
        };
        if let Some(run) = self
            .hub
            .machine_setup
            .update(&self.run_id, |run| run.steps = steps)
        {
            emit(&self.hub, &run);
        }
    }
}

impl Progress for Recorder {
    fn planned(&self, steps: &[Begin]) {
        self.change(|s| s.planned(steps));
    }

    fn begin(&self, step: Begin) {
        self.change(|s| s.begin(&step));
    }

    fn done(&self, output: &str) {
        self.change(|s| s.done(output));
    }

    fn failed(&self, code: i32, output: &str, fix: &str) {
        self.change(|s| {
            s.failed(&format!("exit {code}: {output}\nFix: {fix}"));
        });
    }

    fn say(&self, line: &str) {
        self.steps.lock().unwrap().say(line);
    }
}

fn emit(hub: &Hub, run: &MachineAddRun) {
    let m = &run.machine_id;
    let summary = match run.state {
        MachineAddState::Done => format!("Added {m}"),
        MachineAddState::Failed => format!("Couldn't add {m}"),
        MachineAddState::Running => match run
            .steps
            .iter()
            .rev()
            .find(|s| s.state != SetupStepState::Planned)
        {
            Some(step) => format!("Adding {m}: {}", step.title),
            None => format!("Adding {m}"),
        },
    };
    let data = MachineAddStepData {
        run_id: run.run_id.clone(),
        machine_id: m.clone(),
        state: run.state,
    };
    let event = NewEvent {
        at: Timestamp(iso_ms(now_ms(hub.clock.as_ref()))),
        r#type: HubEventType::MachineAddStep,
        machine_id: None,
        project_id: None,
        thread_id: None,
        summary: summary.chars().take(200).collect(),
        data: serde_json::to_value(&data).ok(),
        attention: None,
    };
    if let Err(error) = hub.events.append(event) {
        tracing::warn!("machine_add.step for {m}: {error}");
    }
}

/// Runs `machine add` for the resolved machine in the background, recording each step in `run`.
fn spawn_add(hub: Arc<Hub>, run: MachineAddRun, resolved: crate::cli::setup::machine::Resolved) {
    use crate::cli::setup::machine::{HubSide, execute, prepare};
    let runner = hub.machine_setup.ports().runner();
    let builds = hub.machine_setup.ports().builds();
    tokio::spawn(async move {
        let recorder = Recorder {
            hub: hub.clone(),
            run_id: run.run_id.clone(),
            steps: Mutex::default(),
        };
        let side = HubSide {
            auth: &hub.auth,
            store: &hub.store,
        };
        let result = match prepare(
            &resolved,
            Some(side),
            runner.as_ref(),
            Some(builds.as_ref()),
            &recorder,
        )
        .await
        {
            Ok(prepared) => {
                execute(resolved, prepared, Some(side), runner.as_ref(), &recorder).await
            }
            Err(stop) => Err(stop),
        };
        let at = Timestamp(iso_ms(now_ms(hub.clock.as_ref())));
        let steps = {
            let mut steps = recorder.steps.lock().unwrap();
            match &result {
                Ok(_) => {
                    // The wait for a node that was online already: nothing to wait for.
                    for step in &mut steps.steps {
                        if step.state == SetupStepState::Planned {
                            step.state = SetupStepState::Done;
                        }
                    }
                }
                Err(Stop { message, .. }) => {
                    // "step 3 failed (exit 1):" heads the run's message; the step itself shows what it printed.
                    let what = split_fix(message).0;
                    let output = match what.split_once('\n') {
                        Some((head, rest)) if head.starts_with("step ") => rest.to_owned(),
                        _ => what,
                    };
                    steps.failed(&output);
                }
            }
            steps.steps.clone()
        };
        let finished = hub.machine_setup.update(&run.run_id, |r| {
            r.steps = steps;
            r.finished_at = Some(at);
            match result {
                Ok(added) => {
                    r.state = MachineAddState::Done;
                    r.notes = added.notes;
                    r.logged_in = Some(added.logged_in);
                }
                Err(stop) => {
                    let (message, fix) = split_fix(&stop.message);
                    r.state = MachineAddState::Failed;
                    r.message = Some(message);
                    r.fix = fix;
                }
            }
        });
        if let Some(run) = finished {
            emit(&hub, &run);
        }
    });
}
