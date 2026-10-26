//! `hub_update`: the hub updates itself to the newest build of its channel, then tells every connected node to do the
//! same, with the CLI's own pieces (`crate::update`). It never waits for work to finish: a restart cuts off what runs,
//! and that carries on by itself afterwards (`crate::update`'s doc says how).
//!
//! The hub downloads the build and checks it against the release's SHA256SUMS (a failure changes nothing), keeps the
//! running binary, puts the new one in place and starts the watcher (`update::finish`) from the kept binary, outside
//! its own service. The watcher restarts the hub, waits for `/healthz` to answer on the new build, and puts the kept
//! binary back if it doesn't. The run lives in `<hub home>/update/run.json`, so the hub that comes up, new or put
//! back, takes it from there: it reads the watcher's verdict, then updates the nodes, each with `node_action`
//! `update`, and learns how each came back from the version it reconnects with.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::mcp::{
    HubChannel, UpdatePart, UpdatePartKind, UpdateRun, UpdateStage, UpdateState,
};
use fleetd_contracts::node_link::{NodeActionResult, NodeUpdate};
use fleetd_contracts::prim::{List, Text};

use crate::clock::Clock;
use crate::hub::store::{iso_ms, now_ms};
use crate::update::finish::{self, HEALTH_WAIT_SECS, Health, Plan, Verdict};
use crate::update::service::Service;
use crate::update::{BoxFuture, Channel, Failure, Feed};

pub mod ports;
pub mod tools;

#[cfg(test)]
mod tests;

/// A machine as the update sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NodeFacts {
    pub machine_id: MachineId,
    pub name: String,
    pub version: String,
    /// When its current link went live, ms; None while offline.
    pub live_since: Option<i64>,
    /// Its node lists `self_update`.
    pub can_update: bool,
}

/// What the update does to the hub's machine and its nodes; tests stand in fakes.
pub trait UpdatePorts: Send + Sync {
    fn feed(&self, channel: Channel) -> Arc<dyn Feed>;
    /// The hub's running build.
    fn running(&self) -> String;
    fn release_build(&self) -> bool;
    /// The installed binary the hub's service runs.
    fn exe(&self) -> std::io::Result<PathBuf>;
    /// This platform's CLI asset.
    fn asset(&self) -> Result<String, String>;
    /// The hub's own service; None for a hub started by hand.
    fn hub_service(&self, exe: &Path) -> Option<Service>;
    /// The running binary's bytes, kept for a rollback.
    fn previous(&self) -> std::io::Result<Vec<u8>>;
    /// Where the watcher asks `/healthz`.
    fn health_url(&self) -> String;
    fn start_watcher(&self, plan: &Plan, plan_path: &Path) -> Result<(), String>;
    fn nodes(&self) -> Vec<NodeFacts>;
    fn update_node<'a>(
        &'a self,
        machine_id: &'a MachineId,
        update: &'a NodeUpdate,
    ) -> BoxFuture<'a, Result<NodeActionResult, String>>;
}

/// How long the update waits on things, and how often it looks; tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub poll: Duration,
    /// For the watcher's verdict once the hub is back.
    pub verdict: Duration,
    /// For a node to reconnect after its update, or after the hub's own restart.
    pub node_back: Duration,
    /// For the restart this process handed to the watcher: past it, the restart never happened.
    pub restart: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            poll: Duration::from_secs(2),
            verdict: Duration::from_secs(HEALTH_WAIT_SECS * 2),
            node_back: Duration::from_secs(HEALTH_WAIT_SECS * 3),
            // The watcher's settle, the new build's 90 s, and the previous build's 90 s once put back.
            restart: Duration::from_secs(HEALTH_WAIT_SECS * 3),
        }
    }
}

pub struct Updates {
    dir: PathBuf,
    clock: Arc<dyn Clock>,
    timing: Timing,
    run: Mutex<Option<UpdateRun>>,
    ports: RwLock<Option<Arc<dyn UpdatePorts>>>,
}

/// Why `start` didn't start one.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    NotWired,
}

impl Updates {
    /// The update area over `<hub home>/update`, with the run a previous hub process left there.
    pub fn new(hub_home: &Path, clock: Arc<dyn Clock>, timing: Timing) -> Arc<Self> {
        let dir = hub_home.join("update");
        let run = fs::read(dir.join("run.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        Arc::new(Self {
            dir,
            clock,
            timing,
            run: Mutex::new(run),
            ports: RwLock::default(),
        })
    }

    /// Called once the hub is built; tests put fakes in.
    pub fn set_ports(&self, ports: Arc<dyn UpdatePorts>) {
        *self.ports.write().unwrap() = Some(ports);
    }

    fn ports(&self) -> Option<Arc<dyn UpdatePorts>> {
        self.ports.read().unwrap().clone()
    }

    /// The update going now, or the last one.
    pub fn status(&self) -> Option<UpdateRun> {
        self.run.lock().unwrap().clone()
    }

    fn now(&self) -> String {
        iso_ms(now_ms(self.clock.as_ref()))
    }

    /// Starts an update, or returns the one already going. Never waits for work to finish.
    pub fn start(self: &Arc<Self>, channel: Option<HubChannel>) -> Result<UpdateRun, Refused> {
        let ports = self.ports().ok_or(Refused::NotWired)?;
        let mut held = self.run.lock().unwrap();
        if let Some(run) = held.as_ref().filter(|r| r.finished_at.is_none()) {
            return Ok(run.clone());
        }
        let running = ports.running();
        let channel = match channel {
            Some(c @ (HubChannel::Nightly | HubChannel::Stable)) => c,
            _ => match Channel::of(&running, ports.release_build()) {
                Channel::Nightly => HubChannel::Nightly,
                Channel::Stable => HubChannel::Stable,
            },
        };
        let mut parts = vec![part(
            UpdatePartKind::Hub,
            None,
            "the hub",
            &running,
            UpdateState::Downloading,
        )];
        let mut nodes = ports.nodes();
        nodes.sort_by(|a, b| a.name.cmp(&b.name));
        parts.extend(
            nodes
                .iter()
                .take(fleetd_contracts::mcp::UPDATE_PARTS_MAX - 1)
                .map(|n| {
                    let mut p = part(
                        UpdatePartKind::Node,
                        Some(n.machine_id.clone()),
                        &n.name,
                        &n.version,
                        UpdateState::Waiting,
                    );
                    // Offline now: not waited for. One online now is, through the hub's restart (`update_node`).
                    if n.live_since.is_none() {
                        p.state = UpdateState::Skipped;
                        p.message = Some(text(OFFLINE));
                    }
                    p
                }),
        );
        let at = now_ms(self.clock.as_ref());
        let run = UpdateRun {
            id: Text::unchecked(format!("U{at}")),
            channel,
            to: None,
            started_at: Timestamp::from(iso_ms(at)),
            finished_at: None,
            parts: List::new(parts).expect("at most UPDATE_PARTS_MAX parts"),
        };
        *held = Some(run.clone());
        drop(held);
        self.save();
        let this = Arc::clone(self);
        tokio::spawn(async move { this.drive_hub(ports).await });
        Ok(run)
    }

    /// Changes the run and writes it down.
    fn change(&self, f: impl FnOnce(&mut UpdateRun)) {
        if let Some(run) = self.run.lock().unwrap().as_mut() {
            f(run);
            if run.finished_at.is_none() && run.parts.iter().all(|p| p.state.settled()) {
                run.finished_at = Some(Timestamp::from(self.now()));
            }
        }
        self.save();
    }

    fn set_part(
        &self,
        machine_id: Option<&MachineId>,
        state: UpdateState,
        stage: Option<UpdateStage>,
        message: impl Into<String>,
    ) {
        let message = message.into();
        self.change(|run| {
            let mut parts = run.parts.to_vec();
            if let Some(p) = parts
                .iter_mut()
                .find(|p| p.machine_id.as_ref() == machine_id)
            {
                p.state = state;
                p.stage = stage;
                p.message = Some(text(&message));
            }
            run.parts = List::new(parts).expect("same parts");
        });
    }

    /// Every node not yet settled gets `state` with `message`.
    fn settle_nodes(&self, state: UpdateState, message: &str) {
        self.change(|run| {
            let mut parts = run.parts.to_vec();
            for p in parts
                .iter_mut()
                .filter(|p| p.part == UpdatePartKind::Node && !p.state.settled())
            {
                p.state = state;
                p.message = Some(text(message));
            }
            run.parts = List::new(parts).expect("same parts");
        });
    }

    fn save(&self) {
        let Some(run) = self.status() else { return };
        let wrote = fs::create_dir_all(&self.dir).and_then(|()| {
            crate::update::replace_file(
                &self.dir.join("run.json"),
                &serde_json::to_vec_pretty(&run).unwrap_or_default(),
            )
        });
        if let Err(e) = wrote {
            tracing::warn!(
                "update: couldn't write {}: {e}",
                self.dir.join("run.json").display()
            );
        }
    }

    fn hub_failed(&self, failure: &Failure) {
        self.set_part(
            None,
            UpdateState::Failed,
            Some(failure.stage),
            failure.message.clone(),
        );
        self.settle_nodes(
            UpdateState::Skipped,
            "not asked: the hub didn't update, and nodes follow the hub",
        );
    }

    async fn drive_hub(self: Arc<Self>, ports: Arc<dyn UpdatePorts>) {
        let Some(channel) = self.status().map(|r| r.channel) else {
            return;
        };
        match self.stage_hub(&*ports, channel).await {
            Err(failure) => self.hub_failed(&failure),
            Ok(None) => {
                let running = ports.running();
                self.change(|run| run.to = Some(text(&running)));
                self.set_part(
                    None,
                    UpdateState::Current,
                    None,
                    format!("already runs {}", crate::version_label(&running)),
                );
                self.drive_nodes(ports, running).await;
            }
            Ok(Some(plan)) => {
                self.change(|run| run.to = Some(text(&plan.to)));
                self.set_part(
                    None,
                    UpdateState::Restarting,
                    None,
                    format!("restarting on {}", crate::version_label(&plan.to)),
                );
                if let Err(e) = ports.start_watcher(&plan, &self.dir.join("hub-plan.json")) {
                    let _ = crate::update::restore(&plan.exe, &plan.prev);
                    self.hub_failed(&Failure::new(
                        UpdateStage::Restart,
                        format!(
                            "couldn't start the restart ({e}), so the previous binary was put back"
                        ),
                    ));
                    return;
                }
                // The watcher restarts this process, and the hub that comes up goes on in `resume`. Still here
                // past the deadline, the restart never happened: the run ends, and says so.
                self.restart_missed(&plan).await;
            }
        }
    }

    /// The hub that handed its restart to the watcher, still running long after: the watcher's verdict if it wrote
    /// one (the service manager refused the restart, and it says so), else the previous binary back and a failed
    /// restart.
    async fn restart_missed(&self, plan: &Plan) {
        let deadline = now_ms(self.clock.as_ref()) + ms(self.timing.restart);
        let verdict = loop {
            if let Some(verdict) = finish::read_verdict(&plan.verdict) {
                break Some(verdict);
            }
            if now_ms(self.clock.as_ref()) >= deadline {
                break None;
            }
            self.clock.sleep(self.timing.poll).await;
        };
        let (state, stage, message) = match verdict {
            Some(Verdict {
                state,
                stage,
                message,
            }) => (state, stage, message),
            None => {
                let back = crate::update::restore(&plan.exe, &plan.prev).is_ok();
                (
                    UpdateState::Failed,
                    Some(UpdateStage::Restart),
                    format!(
                        "the hub didn't restart onto {} within {} min, so it kept running {}{}",
                        crate::version_label(&plan.to),
                        self.timing.restart.as_secs().div_ceil(60),
                        crate::version_label(&plan.from),
                        if back {
                            " and its previous binary was put back"
                        } else {
                            "; its previous binary couldn't be put back: run `fleetd update` on its machine"
                        }
                    ),
                )
            }
        };
        if state == UpdateState::Done {
            // Only the new build writes this as it comes up; this process is the old one, about to go.
            return;
        }
        self.set_part(None, state, stage, message);
        self.settle_nodes(
            UpdateState::Skipped,
            "not asked: the hub kept its build, and nodes follow the hub",
        );
    }

    /// Puts the channel's newest build in place for the watcher, or None when the hub already runs it.
    async fn stage_hub(
        &self,
        ports: &dyn UpdatePorts,
        channel: HubChannel,
    ) -> Result<Option<Plan>, Failure> {
        let channel = match channel {
            HubChannel::Stable => Channel::Stable,
            _ => Channel::Nightly,
        };
        let feed = ports.feed(channel);
        let running = ports.running();
        let to = crate::update::release(&*feed)
            .await?
            .cli_version
            .ok_or_else(|| {
                Failure::new(
                    UpdateStage::Download,
                    format!("the {} channel has no fleetd build yet", channel.as_str()),
                )
            })?;
        if to == running {
            return Ok(None);
        }
        if !ports.release_build() {
            return Err(Failure::new(
                UpdateStage::Install,
                "the hub runs a local build of fleetd: install a release with curl -fsSL https://fleetd.sh | sh",
            ));
        }
        let exe = ports.exe().map_err(|e| {
            Failure::new(
                UpdateStage::Install,
                format!("couldn't find the hub's binary: {e}"),
            )
        })?;
        let service = ports.hub_service(&exe).ok_or_else(|| {
            Failure::new(
                UpdateStage::Restart,
                "the hub doesn't run as the service `fleetd init` sets up, so it can't restart itself: run \
                 `fleetd update` on its machine",
            )
        })?;
        let asset = ports
            .asset()
            .map_err(|e| Failure::new(UpdateStage::Download, e))?;
        let bytes = crate::update::verified(&*feed, &asset).await?;
        let previous = ports.previous().map_err(|e| {
            Failure::new(
                UpdateStage::Install,
                format!(
                    "couldn't keep the running binary for a rollback: {e}; nothing was changed"
                ),
            )
        })?;
        let prev = self.dir.join("fleetd.prev");
        crate::update::swap(&exe, &bytes, &previous, &prev)?;
        Ok(Some(Plan {
            exe,
            prev,
            service,
            from: running,
            to,
            health: Health::Hub {
                url: ports.health_url(),
            },
            wait_secs: HEALTH_WAIT_SECS,
            verdict: self.dir.join("hub-verdict.json"),
        }))
    }

    /// At the hub's start: takes an unfinished update from where the previous process left it. Runs until it ends.
    pub async fn resume(self: Arc<Self>) {
        let Some(ports) = self.ports() else { return };
        let Some(run) = self.status().filter(|r| r.finished_at.is_none()) else {
            return;
        };
        let Some(hub) = run
            .parts
            .iter()
            .find(|p| p.part == UpdatePartKind::Hub)
            .cloned()
        else {
            return;
        };
        let to = run.to.as_ref().map(|t| t.as_str().to_owned());
        match hub.state {
            UpdateState::Downloading => self.hub_failed(&Failure::new(
                UpdateStage::Download,
                "the hub restarted before the new build was in place; nothing was changed",
            )),
            UpdateState::Restarting => {
                let to = to.unwrap_or_default();
                match self.verdict(&*ports, &to).await {
                    Verdict {
                        state: UpdateState::Done,
                        message,
                        ..
                    } => {
                        self.set_part(None, UpdateState::Done, None, message);
                        self.drive_nodes(ports, to).await;
                    }
                    Verdict {
                        state,
                        stage,
                        message,
                    } => {
                        self.set_part(None, state, stage, message);
                        self.settle_nodes(
                            UpdateState::Skipped,
                            "not asked: the hub kept its build, and nodes follow the hub",
                        );
                    }
                }
            }
            UpdateState::Done | UpdateState::Current => {
                if let Some(to) = to {
                    self.drive_nodes(ports, to).await;
                }
            }
            _ => self.settle_nodes(UpdateState::Skipped, "not asked: the hub didn't update"),
        }
    }

    /// The watcher's verdict on the hub's restart, waited for; without one, what this process runs says it.
    async fn verdict(&self, ports: &dyn UpdatePorts, to: &str) -> Verdict {
        let path = self.dir.join("hub-verdict.json");
        let deadline = now_ms(self.clock.as_ref()) + ms(self.timing.verdict);
        loop {
            if let Some(verdict) = finish::read_verdict(&path) {
                return verdict;
            }
            if now_ms(self.clock.as_ref()) >= deadline {
                break;
            }
            self.clock.sleep(self.timing.poll).await;
        }
        let running = ports.running();
        if running == to {
            Verdict {
                state: UpdateState::Done,
                stage: None,
                message: format!("runs {}", crate::version_label(to)),
            }
        } else {
            Verdict {
                state: UpdateState::RolledBack,
                stage: Some(UpdateStage::Health),
                message: format!(
                    "the hub came back on {}, not {}",
                    crate::version_label(&running),
                    crate::version_label(to)
                ),
            }
        }
    }

    /// Updates every node not settled yet to `to`, all at once.
    async fn drive_nodes(self: &Arc<Self>, ports: Arc<dyn UpdatePorts>, to: String) {
        let Some(run) = self.status() else { return };
        let channel = run.channel;
        let waiting: Vec<MachineId> = run
            .parts
            .iter()
            .filter(|p| p.part == UpdatePartKind::Node && !p.state.settled())
            .filter_map(|p| p.machine_id.clone())
            .collect();
        let update = NodeUpdate {
            version: text(&to),
            channel,
        };
        let jobs = waiting.into_iter().map(|machine_id| {
            let this = Arc::clone(self);
            let ports = Arc::clone(&ports);
            let update = update.clone();
            tokio::spawn(async move { this.update_node(&*ports, &machine_id, &update).await })
        });
        for job in jobs.collect::<Vec<_>>() {
            let _ = job.await;
        }
        // A part a node's job couldn't settle (it panicked) still ends the run.
        self.settle_nodes(
            UpdateState::Failed,
            "the update of this node stopped without a result",
        );
    }

    async fn update_node(
        &self,
        ports: &dyn UpdatePorts,
        machine_id: &MachineId,
        update: &NodeUpdate,
    ) {
        let facts = |ports: &dyn UpdatePorts| -> Option<NodeFacts> {
            ports
                .nodes()
                .into_iter()
                .find(|n| &n.machine_id == machine_id)
        };
        let to = update.version.as_str();
        let label = crate::version_label(to);
        let Some(node) = facts(ports) else {
            return self.set_part(
                Some(machine_id),
                UpdateState::Skipped,
                None,
                "not asked: the hub no longer knows it",
            );
        };
        if node.version == to {
            return self.set_part(
                Some(machine_id),
                UpdateState::Current,
                None,
                format!("already runs {label}"),
            );
        }
        // It was online when the run started (an offline one was skipped then), and the hub's own restart dropped
        // every link: it gets a while to reconnect before it counts as offline.
        let mut node = node;
        let deadline = now_ms(self.clock.as_ref()) + ms(self.timing.node_back);
        while node.live_since.is_none() {
            if now_ms(self.clock.as_ref()) >= deadline {
                return self.set_part(Some(machine_id), UpdateState::Skipped, None, OFFLINE);
            }
            self.clock.sleep(self.timing.poll).await;
            match facts(ports) {
                Some(n) => node = n,
                None => {
                    return self.set_part(
                        Some(machine_id),
                        UpdateState::Skipped,
                        None,
                        "not asked: the hub no longer knows it",
                    );
                }
            }
        }
        if node.version == to {
            return self.set_part(
                Some(machine_id),
                UpdateState::Current,
                None,
                format!("already runs {label}"),
            );
        }
        if !node.can_update {
            return self.set_part(
                Some(machine_id),
                UpdateState::Skipped,
                None,
                format!(
                    "its fleetd ({}) is too old to update from the hub: run `fleetd update` on {} once",
                    crate::version_label(&node.version),
                    node.name
                ),
            );
        }
        self.set_part(
            Some(machine_id),
            UpdateState::Downloading,
            None,
            format!("downloading {label}"),
        );
        let asked = now_ms(self.clock.as_ref());
        match ports.update_node(machine_id, update).await {
            Err(e) => {
                return self.set_part(
                    Some(machine_id),
                    UpdateState::Failed,
                    Some(UpdateStage::Download),
                    e,
                );
            }
            Ok(r) if !r.ok => {
                return self.set_part(
                    Some(machine_id),
                    UpdateState::Failed,
                    Some(r.stage.unwrap_or(UpdateStage::Download)),
                    r.message.as_str(),
                );
            }
            Ok(_) => {}
        }
        self.set_part(
            Some(machine_id),
            UpdateState::Restarting,
            None,
            format!("restarting on {label}"),
        );
        let deadline = asked + ms(self.timing.node_back);
        loop {
            match facts(ports) {
                Some(n) if n.live_since.is_some_and(|at| at > asked) && n.version == to => {
                    return self.set_part(
                        Some(machine_id),
                        UpdateState::Done,
                        None,
                        format!("runs {label}"),
                    );
                }
                Some(n) if n.live_since.is_some_and(|at| at > asked) => {
                    return self.set_part(
                        Some(machine_id),
                        UpdateState::RolledBack,
                        Some(UpdateStage::Health),
                        format!(
                            "{label} didn't come up healthy, so {} was put back and runs again",
                            crate::version_label(&n.version)
                        ),
                    );
                }
                _ => {}
            }
            if now_ms(self.clock.as_ref()) >= deadline {
                return self.set_part(
                    Some(machine_id),
                    UpdateState::Failed,
                    Some(UpdateStage::Health),
                    format!(
                        "didn't come back within {} min: check the fleetd node service on {}",
                        self.timing.node_back.as_secs() / 60,
                        node.name
                    ),
                );
            }
            self.clock.sleep(self.timing.poll).await;
        }
    }
}

const OFFLINE: &str = "offline: press Update again once it's online, or run `fleetd update` on it";

fn ms(d: Duration) -> i64 {
    i64::try_from(d.as_millis()).unwrap_or(i64::MAX)
}

fn text<const MIN: usize, const MAX: usize>(s: &str) -> Text<MIN, MAX> {
    crate::node::wire::head_text(s)
}

fn part(
    kind: UpdatePartKind,
    machine_id: Option<MachineId>,
    name: &str,
    from: &str,
    state: UpdateState,
) -> UpdatePart {
    UpdatePart {
        part: kind,
        machine_id,
        name: text(if name.is_empty() { "a machine" } else { name }),
        from: text(from),
        state,
        stage: None,
        message: None,
    }
}

/// The parts by machine, for a quick look in tests and the tool.
pub fn by_machine(run: &UpdateRun) -> HashMap<Option<MachineId>, UpdatePart> {
    run.parts
        .iter()
        .map(|p| (p.machine_id.clone(), p.clone()))
        .collect()
}
