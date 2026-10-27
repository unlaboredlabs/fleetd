//! `hub_update`: the hub updates itself to the newest build of its channel, then tells every connected node to do the
//! same, with the CLI's own pieces (`crate::update`). It never waits for work to finish: a restart cuts off what runs,
//! and that carries on by itself afterwards (`crate::update`'s doc says how).
//!
//! Ahead of any update, every 10 minutes, the hub downloads the channel's newest build and checks it ([`Updates::
//! prefetch`]), and asks its nodes to do the same, so that pressing Update only swaps and restarts; the app says
//! "fleetd <version> is ready" then ([`Updates::ready`]).
//!
//! The hub downloads the build and checks it against the release's SHA256SUMS (a failure changes nothing), while
//! every online node that can downloads it too (`node_action` `fetch`, nothing installed), then keeps the running
//! binary, puts the new one in place and starts the watcher (`update::finish`) from the kept binary, outside
//! its own service. The watcher restarts the hub, waits for `/healthz` to answer on the new build, and puts the kept
//! binary back if it doesn't. The run lives in `<hub home>/update/run.json`, so the hub that comes up, new or put
//! back, takes it from there: it reads the watcher's verdict, then updates the nodes, all at once, each with
//! `node_action` `update`, and learns how each came back from the version it reconnects with (it wakes on each link
//! that goes live or drops), or that it never restarted from the second answer a node sends when its service manager
//! refused the restart. Each machine whose node runs the new build then brings its Claude Code to the version that
//! build was tested with (`node_action` `claude`), its own part in the run: a failure there keeps the version it had,
//! and changes nothing else.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
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
use crate::node::runner::claude::install;
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
    /// Its node lists `update_fetch`.
    pub can_fetch: bool,
    /// Its Claude Code, as `claude --version` printed it at the node's last probe.
    pub claude: Option<String>,
    /// Its node lists `claude_install`.
    pub can_install_claude: bool,
    /// What runs on it that can't carry on through its node's restart (live sessions, previews), in words; None when
    /// nothing does. Agents' runs aren't in it: they carry on by themselves.
    pub busy: Option<String>,
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
    /// Asks the node to download `update` ahead of its update, without waiting for its answer.
    fn fetch_on_node(&self, machine_id: &MachineId, update: &NodeUpdate);
    /// Resolves once the machine's link goes live or drops after this call. Made before the facts it follows are
    /// read, so a change between the two isn't missed.
    fn node_changed(&self, machine_id: &MachineId) -> BoxFuture<'static, ()>;
    /// The Claude Code version the running hub's build was tested with.
    fn claude_target(&self) -> String;
    /// The node's install of Claude Code `version`, answered once done.
    fn install_claude<'a>(
        &'a self,
        machine_id: &'a MachineId,
        version: &'a str,
    ) -> BoxFuture<'a, Result<NodeActionResult, String>>;
    /// The node's answer, and the wait for its second, sent only when its restart was refused.
    fn update_node<'a>(
        &'a self,
        machine_id: &'a MachineId,
        update: &'a NodeUpdate,
    ) -> BoxFuture<'a, Result<NodeAnswer, String>>;
}

/// A node's answer to its update, and the wait for its second.
pub type NodeAnswer = (NodeActionResult, Box<dyn Refusal>);

/// A node's second answer to its update: it still runs, as its service manager refused the restart.
pub trait Refusal: Send {
    fn try_take(&mut self) -> Option<NodeActionResult>;
}

/// How long the update waits on things, and how often it looks; tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// For the files the watcher writes.
    pub poll: Duration,
    /// For a node, between the changes of its link it wakes on: for its second answer, and in case a change was missed.
    pub node_poll: Duration,
    /// For the watcher's verdict once the hub is back.
    pub verdict: Duration,
    /// For a node to reconnect after its update, or after the hub's own restart.
    pub node_back: Duration,
    /// For the restart this process handed to the watcher: past it, the restart never happened.
    pub restart: Duration,
    /// How often the channel's newest build is downloaded ahead of an update.
    pub prefetch_every: Duration,
    /// How often a busy machine is looked at again, and for how long it is waited for before it is skipped.
    pub idle_poll: Duration,
    pub idle: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            poll: Duration::from_millis(100),
            node_poll: Duration::from_secs(1),
            verdict: Duration::from_secs(HEALTH_WAIT_SECS * 2),
            node_back: Duration::from_secs(HEALTH_WAIT_SECS * 3),
            // The new build's 90 s and the previous build's 90 s once put back, with room to spare.
            restart: Duration::from_secs(HEALTH_WAIT_SECS * 3),
            prefetch_every: Duration::from_secs(600),
            idle_poll: Duration::from_secs(5),
            idle: Duration::from_secs(4 * 3600),
        }
    }
}

pub struct Updates {
    dir: PathBuf,
    clock: Arc<dyn Clock>,
    timing: Timing,
    run: Mutex<Option<UpdateRun>>,
    ports: RwLock<Option<Arc<dyn UpdatePorts>>>,
    /// The channel's newest build, downloaded and checked ahead ([`Self::prefetch`]).
    ready: Mutex<Option<String>>,
    /// The tasks of this process driving the run ([`Driving`]). An unfinished run none drives is left over (a task
    /// that ended without settling it): nothing waits behind it, and Update starts a new one.
    drivers: AtomicUsize,
}

/// A task of this process driving the run, counted while it lives.
struct Driving(Arc<Updates>);

impl Drop for Driving {
    fn drop(&mut self) {
        self.0.drivers.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Why `start` didn't start one.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    NotWired,
    /// A retry with no finished run whose hub updated, or of a machine it didn't have.
    NothingToRetry,
    /// A retry after the hub moved on from that run's build (`fleetd update` on its machine, say): it would put the
    /// machine behind the hub. The build the hub runs now.
    HubMovedOn(String),
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
            ready: Mutex::default(),
            drivers: AtomicUsize::new(0),
        })
    }

    /// Called once the hub is built; tests put fakes in.
    pub fn set_ports(&self, ports: Arc<dyn UpdatePorts>) {
        *self.ports.write().unwrap() = Some(ports);
    }

    fn ports(&self) -> Option<Arc<dyn UpdatePorts>> {
        self.ports.read().unwrap().clone()
    }

    /// Counts a task driving the run until it ends; taken under the run's lock, with the check it follows.
    fn drive(self: &Arc<Self>) -> Driving {
        self.drivers.fetch_add(1, Ordering::SeqCst);
        Driving(Arc::clone(self))
    }

    /// The run isn't finished, and a task of this process drives it.
    fn going(&self, run: &UpdateRun) -> bool {
        run.finished_at.is_none() && self.drivers.load(Ordering::SeqCst) > 0
    }

    /// The update going now, or the last one.
    pub fn status(&self) -> Option<UpdateRun> {
        self.run.lock().unwrap().clone()
    }

    /// The channel's newest build when it is downloaded and checked here, ready to install.
    pub fn ready(&self) -> Option<String> {
        self.ready.lock().unwrap().clone()
    }

    fn kept(&self) -> PathBuf {
        self.dir.join("fleetd.next")
    }

    /// Runs [`Self::prefetch`] now and every [`Timing::prefetch_every`]. Runs until the hub stops.
    pub async fn prefetch_loop(self: Arc<Self>) {
        loop {
            self.prefetch().await;
            self.clock.sleep(self.timing.prefetch_every).await;
        }
    }

    /// Downloads the channel's newest build when the hub doesn't run it, checks it against the release's SHA256SUMS
    /// and keeps it for the update, and asks every online node that can to do the same. Nothing is installed. Quiet
    /// on a failure: the update downloads it then, and says why if it can't.
    pub async fn prefetch(&self) {
        let Some(ports) = self.ports() else { return };
        if self.status().is_some_and(|r| self.going(&r)) || !ports.release_build() {
            return;
        }
        let running = ports.running();
        let channel = Channel::of(&running, true);
        let feed = ports.feed(channel);
        let Ok(Some(to)) = crate::update::release(&*feed).await.map(|r| r.cli_version) else {
            return;
        };
        if to == running {
            *self.ready.lock().unwrap() = None;
            return;
        }
        let (Ok(asset), Ok(sums)) = (ports.asset(), crate::update::sums(&*feed).await) else {
            return;
        };
        let have = fs::read(self.kept())
            .ok()
            .is_some_and(|b| sums.get(&asset) == Some(&crate::update::sha256_hex(&b)));
        if !have {
            let kept = match crate::update::checked(&*feed, &sums, &asset).await {
                Ok(bytes) => fs::create_dir_all(&self.dir)
                    .and_then(|()| crate::update::replace_file(&self.kept(), &bytes))
                    .map_err(|e| e.to_string()),
                Err(f) => Err(f.message),
            };
            if let Err(e) = kept {
                tracing::info!("update: couldn't download {to} ahead: {e}");
                return;
            }
        }
        let update = NodeUpdate {
            version: text(&to),
            channel: match channel {
                Channel::Stable => HubChannel::Stable,
                Channel::Nightly => HubChannel::Nightly,
            },
        };
        for node in ports.nodes() {
            if node.live_since.is_some() && node.can_fetch && !crate::at_least(&node.version, &to) {
                ports.fetch_on_node(&node.machine_id, &update);
            }
        }
        *self.ready.lock().unwrap() = Some(to);
    }

    /// Updates one machine of the last run again (a node that failed, was put back or skipped), when the hub still runs
    /// that run's build; refused once it runs another. A run going on is returned as it is.
    pub fn retry(self: &Arc<Self>, machine_id: &MachineId) -> Result<UpdateRun, Refused> {
        let ports = self.ports().ok_or(Refused::NotWired)?;
        let mut held = self.run.lock().unwrap();
        let run = held.as_mut().ok_or(Refused::NothingToRetry)?;
        if self.going(run) {
            return Ok(run.clone());
        }
        let hub_updated = run.parts.iter().any(|p| {
            p.part == UpdatePartKind::Hub
                && matches!(p.state, UpdateState::Done | UpdateState::Current)
        });
        let ours = |p: &UpdatePart| p.machine_id.as_ref() == Some(machine_id);
        let (Some(to), true, true) = (run.to.clone(), hub_updated, run.parts.iter().any(ours))
        else {
            return Err(Refused::NothingToRetry);
        };
        // Never a build older than the hub's: the machine follows the hub, as in an update.
        let running = ports.running();
        if to.as_str() != running {
            return Err(Refused::HubMovedOn(running));
        }
        let mut parts = run.parts.to_vec();
        for p in parts.iter_mut().filter(|p| ours(p)) {
            p.state = UpdateState::Waiting;
            p.stage = None;
            p.message = None;
        }
        run.parts = List::new(parts).expect("same parts");
        run.finished_at = None;
        let run = run.clone();
        self.save(&run);
        let driving = self.drive();
        drop(held);
        let this = Arc::clone(self);
        let machine_id = machine_id.clone();
        tokio::spawn(async move {
            let _driving = driving;
            let update = NodeUpdate {
                version: to,
                channel: this.status().map_or(HubChannel::Nightly, |r| r.channel),
            };
            this.update_node(&*ports, &machine_id, &update).await;
            this.update_claude(&*ports, &machine_id).await;
            this.settle_nodes(
                UpdateState::Failed,
                "the update of this node stopped without a result",
            );
        });
        Ok(run)
    }

    fn now(&self) -> String {
        iso_ms(now_ms(self.clock.as_ref()))
    }

    /// Starts an update, or returns the one already going. Never waits for work to finish. An unfinished run nothing
    /// drives any more doesn't hold it up: a new one takes its place.
    pub fn start(self: &Arc<Self>, channel: Option<HubChannel>) -> Result<UpdateRun, Refused> {
        let ports = self.ports().ok_or(Refused::NotWired)?;
        let mut held = self.run.lock().unwrap();
        if let Some(run) = held.as_ref().filter(|r| self.going(r)) {
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
                .take((fleetd_contracts::mcp::UPDATE_PARTS_MAX - 1) / 2)
                .flat_map(|n| {
                    let claude = n.claude.as_deref().map(install::number).unwrap_or("");
                    [
                        (UpdatePartKind::Node, n.version.as_str()),
                        (UpdatePartKind::Claude, claude),
                    ]
                    .map(|(kind, from)| {
                        let mut p = part(
                            kind,
                            Some(n.machine_id.clone()),
                            &n.name,
                            from,
                            UpdateState::Waiting,
                        );
                        // Offline now: not waited for. One online now is, through the hub's restart
                        // (`update_node`).
                        if n.live_since.is_none() {
                            p.state = UpdateState::Skipped;
                            p.message = Some(text(OFFLINE));
                        }
                        p
                    })
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
        self.save(&run);
        *held = Some(run.clone());
        let driving = self.drive();
        drop(held);
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let _driving = driving;
            this.drive_hub(ports).await;
        });
        Ok(run)
    }

    /// Changes the run and writes it down, under the lock: nodes update at once, and two writes of `run.json` at the
    /// same time would share its temporary file.
    fn change(&self, f: impl FnOnce(&mut UpdateRun)) {
        let mut held = self.run.lock().unwrap();
        if let Some(run) = held.as_mut() {
            f(run);
            if run.finished_at.is_none() && run.parts.iter().all(|p| p.state.settled()) {
                run.finished_at = Some(Timestamp::from(self.now()));
            }
            self.save(run);
        }
    }

    /// The hub's part (no machine), or a machine's node part.
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
                .find(|p| p.machine_id.as_ref() == machine_id && p.part != UpdatePartKind::Claude)
            {
                p.state = state;
                p.stage = stage;
                p.message = Some(text(&message));
            }
            run.parts = List::new(parts).expect("same parts");
        });
    }

    /// A machine's Claude Code part.
    fn set_claude(
        &self,
        machine_id: &MachineId,
        to: Option<&str>,
        state: UpdateState,
        stage: Option<UpdateStage>,
        message: impl Into<String>,
    ) {
        let message = message.into();
        self.change(|run| {
            let mut parts = run.parts.to_vec();
            if let Some(p) = parts.iter_mut().find(|p| {
                p.machine_id.as_ref() == Some(machine_id) && p.part == UpdatePartKind::Claude
            }) {
                if let Some(to) = to {
                    p.to = Some(text(to));
                }
                p.state = state;
                p.stage = stage;
                p.message = Some(text(&message));
            }
            run.parts = List::new(parts).expect("same parts");
        });
    }

    /// Every machine's part (its node's, its Claude Code's) not yet settled gets `state` with `message`.
    fn settle_nodes(&self, state: UpdateState, message: &str) {
        self.change(|run| {
            let mut parts = run.parts.to_vec();
            for p in parts
                .iter_mut()
                .filter(|p| p.part != UpdatePartKind::Hub && !p.state.settled())
            {
                p.state = state;
                p.message = Some(text(message));
            }
            run.parts = List::new(parts).expect("same parts");
        });
    }

    fn save(&self, run: &UpdateRun) {
        let wrote = fs::create_dir_all(&self.dir).and_then(|()| {
            crate::update::replace_file(
                &self.dir.join("run.json"),
                &serde_json::to_vec_pretty(run).unwrap_or_default(),
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
        self.fetch_ahead(ports, &to);
        // Downloaded ahead: checked against the sums again, else downloaded now.
        let bytes = match fs::read(self.kept()) {
            Ok(kept) => {
                let sums = crate::update::sums(&*feed).await?;
                match sums.get(&asset) == Some(&crate::update::sha256_hex(&kept)) {
                    true => kept,
                    false => crate::update::checked(&*feed, &sums, &asset).await?,
                }
            }
            Err(_) => crate::update::verified(&*feed, &asset).await?,
        };
        let _ = fs::remove_file(self.kept());
        *self.ready.lock().unwrap() = None;
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
            answered: None,
        }))
    }

    /// Every node the run waits for, online, that can fetch and doesn't run `to` downloads it now, alongside the hub, so
    /// its own update needn't once the hub runs it.
    fn fetch_ahead(&self, ports: &dyn UpdatePorts, to: &str) {
        let Some(run) = self.status() else { return };
        let waiting: Vec<&MachineId> = run
            .parts
            .iter()
            .filter(|p| p.part == UpdatePartKind::Node && p.state == UpdateState::Waiting)
            .filter_map(|p| p.machine_id.as_ref())
            .collect();
        let update = NodeUpdate {
            version: text(to),
            channel: run.channel,
        };
        for node in ports.nodes() {
            if waiting.contains(&&node.machine_id)
                && node.live_since.is_some()
                && node.can_fetch
                && !crate::at_least(&node.version, to)
            {
                ports.fetch_on_node(&node.machine_id, &update);
            }
        }
    }

    /// At the hub's start: takes an unfinished update from where the previous process left it. Runs until it ends.
    /// Whatever it can't take on ends: a run never stays unfinished with nothing driving it.
    pub async fn resume(self: Arc<Self>) {
        let Some(ports) = self.ports() else { return };
        let (run, _driving) = {
            let held = self.run.lock().unwrap();
            // Update pressed already took its place.
            let Some(run) = held
                .clone()
                .filter(|r| !self.going(r) && r.finished_at.is_none())
            else {
                return;
            };
            (run, self.drive())
        };
        let Some(hub) = run
            .parts
            .iter()
            .find(|p| p.part == UpdatePartKind::Hub)
            .cloned()
        else {
            return self.settle_nodes(UpdateState::Skipped, "not asked: the hub didn't update");
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
            UpdateState::Done | UpdateState::Current => match to {
                Some(to) => self.drive_nodes(ports, to).await,
                None => self.settle_nodes(UpdateState::Skipped, "not asked: the hub didn't update"),
            },
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

    /// Updates every node not settled yet to `to`, all at once. A hub that runs another build than `to` now (`fleetd
    /// update` on its machine, say) has moved past the run: it ends, with no machine moved to a build the hub left.
    async fn drive_nodes(self: &Arc<Self>, ports: Arc<dyn UpdatePorts>, to: String) {
        let running = ports.running();
        if running != to {
            return self.settle_nodes(
                UpdateState::Skipped,
                &format!(
                    "the hub moved on to {}: press Update for the newest",
                    crate::version_label(&running)
                ),
            );
        }
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
            tokio::spawn(async move {
                this.update_node(&*ports, &machine_id, &update).await;
                this.update_claude(&*ports, &machine_id).await;
            })
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
        // Never backwards: a node on `to` or newer is settled as it is, whenever it is looked at.
        let current = |node: &NodeFacts| {
            let at = crate::at_least(&node.version, to);
            if at {
                self.set_part(
                    Some(machine_id),
                    UpdateState::Current,
                    None,
                    format!("already runs {}", crate::version_label(&node.version)),
                );
            }
            at
        };
        let mut changed = ports.node_changed(machine_id);
        let Some(node) = facts(ports) else {
            return self.set_part(
                Some(machine_id),
                UpdateState::Skipped,
                None,
                "not asked: the hub no longer knows it",
            );
        };
        if current(&node) {
            return;
        }
        // It was online when the run started (an offline one was skipped then), and the hub's own restart dropped
        // every link: it gets a while to reconnect before it counts as offline.
        let mut node = node;
        let deadline = now_ms(self.clock.as_ref()) + ms(self.timing.node_back);
        while node.live_since.is_none() {
            if now_ms(self.clock.as_ref()) >= deadline {
                return self.set_part(Some(machine_id), UpdateState::Skipped, None, OFFLINE);
            }
            self.node_wait(changed).await;
            changed = ports.node_changed(machine_id);
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
        if current(&node) {
            return;
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
        // What can't carry on through a restart (a live session, a preview) is waited out: the machine updates once
        // it's idle, and says so meanwhile, unless it was updated past `to` another way by then.
        let idle_by = now_ms(self.clock.as_ref()) + ms(self.timing.idle);
        let mut said = None;
        while let Some(now) = facts(ports) {
            if current(&now) {
                return;
            }
            let Some(busy) = now.busy else { break };
            if now_ms(self.clock.as_ref()) >= idle_by {
                return self.set_part(
                    Some(machine_id),
                    UpdateState::Skipped,
                    None,
                    format!(
                        "still busy after {} h ({busy}): press Update again once it's idle",
                        self.timing.idle.as_secs() / 3600
                    ),
                );
            }
            if said.as_ref() != Some(&busy) {
                self.set_part(
                    Some(machine_id),
                    UpdateState::Waiting,
                    None,
                    format!("waits until it's idle: {busy} can't carry on through a restart"),
                );
                said = Some(busy);
            }
            self.clock.sleep(self.timing.idle_poll).await;
        }
        self.set_part(
            Some(machine_id),
            UpdateState::Downloading,
            None,
            format!("downloading {label}"),
        );
        let asked = now_ms(self.clock.as_ref());
        let mut refusal = match ports.update_node(machine_id, update).await {
            Err(e) => {
                return self.set_part(
                    Some(machine_id),
                    UpdateState::Failed,
                    Some(UpdateStage::Download),
                    e,
                );
            }
            Ok((r, _)) if !r.ok => {
                return self.set_part(
                    Some(machine_id),
                    UpdateState::Failed,
                    Some(r.stage.unwrap_or(UpdateStage::Download)),
                    r.message.as_str(),
                );
            }
            Ok((_, refusal)) => refusal,
        };
        self.set_part(
            Some(machine_id),
            UpdateState::Restarting,
            None,
            format!("restarting on {label}"),
        );
        let deadline = asked + ms(self.timing.node_back);
        loop {
            let changed = ports.node_changed(machine_id);
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
            if let Some(r) = refusal.try_take() {
                return self.set_part(
                    Some(machine_id),
                    UpdateState::Failed,
                    Some(r.stage.unwrap_or(UpdateStage::Restart)),
                    r.message.as_str(),
                );
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
            self.node_wait(changed).await;
        }
    }

    /// Brings the machine's Claude Code to the version the hub's build was tested with, once its node runs that build.
    async fn update_claude(&self, ports: &dyn UpdatePorts, machine_id: &MachineId) {
        let Some(run) = self.status() else { return };
        let node = run
            .parts
            .iter()
            .find(|p| p.part == UpdatePartKind::Node && p.machine_id.as_ref() == Some(machine_id))
            .cloned();
        let Some(node) = node else { return };
        if !matches!(node.state, UpdateState::Done | UpdateState::Current) {
            let why = if node.state == UpdateState::Skipped {
                node.message.as_ref().map_or("", |m| m.as_str()).to_owned()
            } else {
                "not asked: its fleetd didn't update".to_owned()
            };
            return self.set_claude(machine_id, None, UpdateState::Skipped, None, why);
        }
        let target = ports.claude_target();
        let facts = ports
            .nodes()
            .into_iter()
            .find(|n| &n.machine_id == machine_id);
        // Its fleetd is past the run's build (updated another way): the Claude Code that build was tested with would
        // be a step back for it, as its fleetd would.
        if let (Some(n), Some(to)) = (&facts, &run.to)
            && crate::version_cmp(&n.version, to) == Some(std::cmp::Ordering::Greater)
        {
            return self.set_claude(
                machine_id,
                None,
                UpdateState::Skipped,
                None,
                format!(
                    "left as it is: its fleetd runs {}, newer than this update's",
                    crate::version_label(&n.version)
                ),
            );
        }
        if !facts.as_ref().is_some_and(|n| n.can_install_claude) {
            return self.set_claude(
                machine_id,
                Some(&target),
                UpdateState::Skipped,
                None,
                format!("its fleetd doesn't install Claude Code: install {target} on it by hand"),
            );
        }
        self.set_claude(
            machine_id,
            Some(&target),
            UpdateState::Downloading,
            None,
            format!("installing Claude Code {target}"),
        );
        match ports.install_claude(machine_id, &target).await {
            // Installed another way, or not at all: left as it is, with how to update it. Not a failure.
            Ok(r) if r.ok && r.message.as_str().starts_with(install::LEFT) => self.set_claude(
                machine_id,
                None,
                UpdateState::Skipped,
                None,
                r.message.as_str(),
            ),
            Ok(r) if r.ok && r.message.as_str().starts_with(install::ALREADY) => self.set_claude(
                machine_id,
                None,
                UpdateState::Current,
                None,
                r.message.as_str(),
            ),
            Ok(r) if r.ok => self.set_claude(
                machine_id,
                None,
                UpdateState::Done,
                None,
                r.message.as_str(),
            ),
            Ok(r) => self.set_claude(
                machine_id,
                None,
                UpdateState::Failed,
                Some(r.stage.unwrap_or(UpdateStage::Install)),
                r.message.as_str(),
            ),
            Err(e) => self.set_claude(
                machine_id,
                None,
                UpdateState::Failed,
                Some(UpdateStage::Install),
                e,
            ),
        }
    }

    /// Until the node's link changes, or [`Timing::node_poll`] at the most.
    async fn node_wait(&self, changed: BoxFuture<'static, ()>) {
        tokio::select! {
            () = changed => {}
            () = self.clock.sleep(self.timing.node_poll) => {}
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
        to: None,
        state,
        stage: None,
        message: None,
    }
}

/// The hub's and the nodes' parts by machine, for a quick look in tests and the tool.
pub fn by_machine(run: &UpdateRun) -> HashMap<Option<MachineId>, UpdatePart> {
    run.parts
        .iter()
        .filter(|p| p.part != UpdatePartKind::Claude)
        .map(|p| (p.machine_id.clone(), p.clone()))
        .collect()
}
