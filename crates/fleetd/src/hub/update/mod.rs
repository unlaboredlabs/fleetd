//! `hub_update`: the hub updates itself to the newest build of its channel, then tells every connected node to do the
//! same, with the CLI's own pieces (`crate::update`). The hub restarts at once: agents don't need it mid-step (a fleetd
//! tool call they make while it restarts fails, and they try again). A node waits for its agents first, for a while
//! at most ([`Updates::drain`]): it holds their tool calls that haven't started (`node_action` `hold`, node/hold.rs)
//! until none runs, then restarts, so they resume between steps rather than redo one; past the deadline it restarts
//! whatever runs, which carries on by itself afterwards (`crate::update`'s doc says how). Update now (`now`) doesn't
//! wait.
//!
//! Ahead of any update, every 10 minutes, the hub downloads the channel's newest build and checks it ([`Updates::
//! prefetch`]), and asks its nodes to do the same, so that pressing Update only swaps and restarts; the app says
//! "fleetd <version> is ready" then ([`Updates::ready`]). With automatic updates on, the same look starts an update
//! by itself, at most once an hour ([`Updates::auto_tick`]): to the build ready, or to the hub's own build for a
//! machine an update left behind; the last one's result stays in `<hub home>/update/last-auto.json`.
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
    AutoUpdateResult, DRAIN_MINUTES_MAX, HUB_UPDATE_MACHINES_MAX, HubChannel, HubUpdateData,
    HubUpdateMachine, HubUpdatePhase, LastAutoUpdate, UpdatePart, UpdatePartKind, UpdateRun,
    UpdateSettings, UpdateStage, UpdateState,
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
    /// Its node lists `update_hold`.
    pub can_hold: bool,
    /// Its Claude Code, as `claude --version` printed it at the node's last probe.
    pub claude: Option<String>,
    /// Its node lists `claude_install`.
    pub can_install_claude: bool,
    /// Its node lists `agents_mac`: the agents' Mac, which runs no Claude Code (D298).
    pub agents_mac: bool,
    /// What runs on it that can't carry on through its node's restart (live sessions), in words; None when
    /// nothing does. Agents' runs aren't in it: they carry on by themselves.
    pub busy: Option<String>,
}

/// What a cloud machine's catch-up did about its build ([`Updates::catch_up`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeCatchUp {
    /// It runs the hub's build, and the Claude Code that build was tested with.
    Current,
    /// Its node is updating to the hub's build, and restarts: the rest of its catch-up waits for its next hello.
    Restarting,
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
    /// Holds the node's agents between steps for a while (`node_action` `hold`): how many are still mid-step.
    fn hold_node<'a>(&'a self, machine_id: &'a MachineId) -> BoxFuture<'a, Result<u32, String>>;
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
    /// Tells the apps how the update looks now (the `hub.update` event); called only when that changed.
    fn announce(&self, update: &HubUpdateData);
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
    /// How often a node waiting for its agents is looked at again (and its hold renewed).
    pub drain_poll: Duration,
    /// How long a node waits for its agents at most, unless the hub's update settings say otherwise.
    pub drain: Duration,
    /// Automatic updates: how long after the last update started the next may start, at the earliest.
    pub auto_gap: Duration,
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
            drain_poll: Duration::from_secs(5),
            drain: Duration::from_secs(DRAIN_MINUTES * 60),
            auto_gap: Duration::from_secs(3600),
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
    /// Those tasks, for [`Self::start_over`] to stop.
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    /// Wakes the nodes waiting for their agents when Update now is pressed.
    hurry: tokio::sync::Notify,
    /// Held while a build downloads to [`Self::kept`] and while Update installs it: Update waits for a download ahead
    /// rather than writing the same file alongside it.
    fetching: tokio::sync::Mutex<()>,
    /// When [`Self::prefetch_loop`] looks at the channel next, ms.
    next_check: Mutex<Option<i64>>,
    /// Why the last look at the channel came to nothing, in a sentence; None when it went.
    check_failed: Mutex<Option<String>>,
    /// What [`UpdatePorts::announce`] last told the apps, so a write that changes nothing they show sends nothing.
    announced: Mutex<Option<HubUpdateData>>,
}

/// How long a node waits for its agents to finish their step by default.
pub const DRAIN_MINUTES: u64 = 10;

/// `<hub home>/update/settings.json`, written by `hub_update_settings` (or a person); every field optional.
#[derive(Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    /// Updates install by themselves, at most once an hour ([`Updates::auto_tick`]). Off when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    auto: Option<bool>,
    /// How long a node waits for its agents at most, in minutes; 0 doesn't wait.
    #[serde(skip_serializing_if = "Option::is_none")]
    drain_minutes: Option<u64>,
}

impl Settings {
    fn read(hub_update_dir: &Path) -> Self {
        fs::read(hub_update_dir.join("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }
}

/// How long a node waits for its agents at most by the settings in `<hub home>/update`, else `default`.
pub fn drain_in(hub_home: &Path, default: Duration) -> Duration {
    Settings::read(&hub_home.join("update"))
        .drain_minutes
        .map_or(default, |m| {
            Duration::from_secs(m.min(u64::from(DRAIN_MINUTES_MAX)) * 60)
        })
}

tokio::task_local! {
    /// The id of the run the current task drives: its writes reach that run only, while it is unfinished, so a task
    /// stopped by [`Updates::start_over`] can't touch the run that took its place.
    static DRIVES: String;
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
            tasks: Mutex::default(),
            hurry: tokio::sync::Notify::new(),
            fetching: tokio::sync::Mutex::const_new(()),
            next_check: Mutex::default(),
            check_failed: Mutex::default(),
            announced: Mutex::default(),
        })
    }

    /// How long a node waits for its agents at most: `drainMinutes` in `<hub home>/update/settings.json`, read at
    /// each wait, else [`Timing::drain`].
    pub fn drain(&self) -> Duration {
        drain_in(self.dir.parent().unwrap_or(&self.dir), self.timing.drain)
    }

    /// The hub's update settings as they apply now.
    pub fn settings(&self) -> UpdateSettings {
        UpdateSettings {
            auto: Settings::read(&self.dir).auto == Some(true),
            drain_minutes: u32::try_from(self.drain().as_secs() / 60).unwrap_or(DRAIN_MINUTES_MAX),
        }
    }

    /// Changes the settings given, keeping the rest.
    pub fn set_settings(
        &self,
        auto: Option<bool>,
        drain_minutes: Option<u32>,
    ) -> std::io::Result<UpdateSettings> {
        let mut settings = Settings::read(&self.dir);
        if auto.is_some() {
            settings.auto = auto;
        }
        if let Some(m) = drain_minutes {
            settings.drain_minutes = Some(u64::from(m.min(DRAIN_MINUTES_MAX)));
        }
        fs::create_dir_all(&self.dir)?;
        crate::update::replace_file(
            &self.dir.join("settings.json"),
            &serde_json::to_vec_pretty(&settings).unwrap_or_default(),
        )?;
        Ok(self.settings())
    }

    /// When the last update started, ms.
    fn last_started(&self) -> Option<i64> {
        let run = self.status()?;
        chrono::DateTime::parse_from_rfc3339(run.started_at.as_str())
            .ok()
            .map(|t| t.timestamp_millis())
    }

    /// The build ready that the last update tried and put back, as the hub didn't come up healthy on it: automatic
    /// updates skip it until a newer one is out (Update still installs it). None otherwise.
    pub fn auto_skips(&self) -> Option<String> {
        let ready = self.ready()?;
        let run = self.status()?;
        let put_back = run
            .parts
            .iter()
            .any(|p| p.part == UpdatePartKind::Hub && p.state == UpdateState::RolledBack);
        (put_back && run.to.as_ref().is_some_and(|to| to.as_str() == ready)).then_some(ready)
    }

    /// An online machine that can update runs an older build than the hub: an update left it behind (it was offline,
    /// or failed). Automatic updates bring it to the hub's build, even with nothing newer out. Not one the last update
    /// already asked for this build that refused it in a way asking again won't change ([`refused_for_good`]): every
    /// hour its agents would wait for it again.
    fn behind(&self) -> bool {
        let Some(ports) = self.ports() else {
            return false;
        };
        let running = ports.running();
        let last = self
            .status()
            .filter(|r| r.to.as_ref().is_some_and(|to| to.as_str() == running));
        ports.release_build()
            && ports.nodes().iter().any(|n| {
                let refused = last.as_ref().is_some_and(|r| {
                    r.parts.iter().any(|p| {
                        p.part == UpdatePartKind::Node
                            && p.machine_id.as_ref() == Some(&n.machine_id)
                            && refused_for_good(p)
                    })
                });
                n.live_since.is_some()
                    && n.can_update
                    && !refused
                    && !crate::at_least(&n.version, &running)
            })
    }

    /// With automatic updates on, and a build ready or a machine left behind ([`Self::behind`]): when the update
    /// starts by itself, ms (now, when the last update started an hour ago or more). None otherwise, while an update
    /// goes on, or for a build put back ([`Self::auto_skips`]).
    pub fn auto_at(&self) -> Option<i64> {
        if !self.settings().auto || self.auto_skips().is_some() {
            return None;
        }
        if self.ready().is_none() && !self.behind() {
            return None;
        }
        if self.status().is_some_and(|r| self.going(&r)) {
            return None;
        }
        let now = now_ms(self.clock.as_ref());
        Some(
            self.last_started()
                .map_or(now, |at| (at + ms(self.timing.auto_gap)).max(now)),
        )
    }

    /// Automatic updates: downloads the channel's newest build ahead ([`Self::prefetch`]), and, when the settings turn
    /// them on, starts an update to it once the last update started an hour ago or more, or to the hub's build for a
    /// machine left behind. Builds that come out within the hour aren't installed one by one: the one update that
    /// follows takes the newest. It waits for agents as the Update button does. The update it started, if any.
    pub async fn auto_tick(self: &Arc<Self>) -> Option<UpdateRun> {
        self.prefetch().await;
        let due = self.auto_at()?;
        if due > now_ms(self.clock.as_ref()) {
            return None;
        }
        self.begin(None, false, true).ok()
    }

    /// Update now was pressed for the run going on: its nodes stop waiting for their agents.
    fn hurried(&self) -> bool {
        self.status().is_some_and(|r| r.now == Some(true))
    }

    /// Called once the hub is built; tests put fakes in.
    pub fn set_ports(&self, ports: Arc<dyn UpdatePorts>) {
        *self.ports.write().unwrap() = Some(ports);
    }

    fn ports(&self) -> Option<Arc<dyn UpdatePorts>> {
        self.ports.read().unwrap().clone()
    }

    /// Runs `work` as a task driving the run `id`: counted while it lives, stopped by [`Self::start_over`], its writes
    /// for that run only. Taken under the run's lock, with the check it follows.
    fn drive(
        self: &Arc<Self>,
        id: &str,
        work: impl Future<Output = ()> + Send + 'static,
    ) -> tokio::task::JoinHandle<()> {
        self.drivers.fetch_add(1, Ordering::SeqCst);
        let driving = Driving(Arc::clone(self));
        let task = tokio::spawn(DRIVES.scope(id.to_owned(), async move {
            let _driving = driving;
            work.await;
        }));
        let mut tasks = self.tasks.lock().unwrap();
        tasks.retain(|t| !t.is_finished());
        tasks.push(task.abort_handle());
        task
    }

    /// The last run isn't finished, yet nothing in this process drives it any more: it won't change again.
    pub fn left_over(&self) -> bool {
        self.status()
            .is_some_and(|r| r.finished_at.is_none() && !self.going(&r))
    }

    /// The run isn't finished, and a task of this process drives it.
    fn going(&self, run: &UpdateRun) -> bool {
        run.finished_at.is_none() && self.drivers.load(Ordering::SeqCst) > 0
    }

    /// The machine's node is in the update going now and has no result yet: waiting its turn, downloading or
    /// restarting. Its node being away then is the update's doing (hub/outage pages nobody for it).
    pub fn updating(&self, machine_id: &MachineId) -> bool {
        self.status().is_some_and(|run| {
            self.going(&run)
                && run.parts.iter().any(|p| {
                    p.part == UpdatePartKind::Node
                        && p.machine_id.as_ref() == Some(machine_id)
                        && !p.state.settled()
                })
        })
    }

    /// A run this process drives, as an update going now looks to the rest of the hub.
    #[cfg(test)]
    pub(crate) fn drive_for_test(&self, run: UpdateRun) {
        *self.run.lock().unwrap() = Some(run);
        self.drivers.fetch_add(1, Ordering::SeqCst);
    }

    /// The update going now, or the last one.
    pub fn status(&self) -> Option<UpdateRun> {
        self.run.lock().unwrap().clone()
    }

    /// The update going now, or the last one, as the hub row shows it: the app snapshot's `update`.
    pub fn signal(&self) -> Option<HubUpdateData> {
        self.status().map(|run| signal(&run))
    }

    /// The close reason of the apps' sockets when the hub stops now: "updating to <version>" while an update restarts
    /// it, else None.
    pub fn restart_reason(&self) -> Option<String> {
        let run = self.status()?;
        let hub = run.parts.iter().find(|p| p.part == UpdatePartKind::Hub)?;
        (run.finished_at.is_none() && hub.state == UpdateState::Restarting).then(|| {
            let to = run.to.as_ref().map_or("", |t| t.as_str());
            format!("{}{to}", fleetd_contracts::app::APP_CLOSE_UPDATING)
        })
    }

    /// The channel's newest build when it is downloaded and checked here, ready to install.
    pub fn ready(&self) -> Option<String> {
        self.ready.lock().unwrap().clone()
    }

    fn kept(&self) -> PathBuf {
        self.dir.join("fleetd.next")
    }

    /// Runs [`Self::auto_tick`] now and every [`Timing::prefetch_every`]. Runs until the hub stops.
    pub async fn prefetch_loop(self: Arc<Self>) {
        loop {
            if let Some(run) = self.auto_tick().await {
                tracing::info!("update: started {} by itself (automatic updates)", run.id);
            }
            *self.next_check.lock().unwrap() =
                Some(now_ms(self.clock.as_ref()) + ms(self.timing.prefetch_every));
            self.clock.sleep(self.timing.prefetch_every).await;
        }
    }

    /// With automatic updates on: when the hub looks at the channel next, ms.
    pub fn next_check(&self) -> Option<i64> {
        self.settings()
            .auto
            .then(|| *self.next_check.lock().unwrap())
            .flatten()
    }

    /// With automatic updates on: why they hold back now, in a sentence. None while nothing does.
    pub fn skip_reason(&self) -> Option<String> {
        if !self.settings().auto {
            return None;
        }
        if self.ports().is_some_and(|p| !p.release_build()) {
            return Some(
                "the hub runs a local build of fleetd, which never updates itself: install a release with curl \
                 -fsSL https://fleetd.sh | sh"
                    .into(),
            );
        }
        if let Some(build) = self.auto_skips() {
            return Some(format!(
                "{} was put back, as the hub didn't come up healthy on it: automatic updates skip it until a newer \
                 build is out (Update still installs it)",
                crate::version_label(&build)
            ));
        }
        self.check_failed.lock().unwrap().clone()
    }

    /// The last automatic update that finished.
    pub fn last_auto(&self) -> Option<LastAutoUpdate> {
        fs::read(self.dir.join("last-auto.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
    }

    /// Why the look at the channel came to nothing (None: it went), for [`Self::skip_reason`].
    fn checked(&self, failed: Option<String>) {
        let mut held = self.check_failed.lock().unwrap();
        // Once per reason: a channel that stays unreachable isn't a line every 10 minutes.
        let same = |a: &str, b: &str| a.split(" at ").next() == b.split(" at ").next();
        if let Some(why) = &failed
            && !held.as_deref().is_some_and(|was| same(was, why))
        {
            tracing::info!("update: {why}");
        }
        *held = failed;
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
        let at = chrono::DateTime::from_timestamp_millis(now_ms(self.clock.as_ref()))
            .map(|t| t.format("%H:%M UTC").to_string())
            .unwrap_or_default();
        let to = match crate::update::release(&*feed).await.map(|r| r.cli_version) {
            Ok(Some(to)) => to,
            Ok(None) => {
                return self.checked(Some(format!(
                    "the {} channel had no fleetd build at {at}",
                    channel.as_str()
                )));
            }
            Err(e) => {
                return self.checked(Some(format!(
                    "couldn't look at the {} channel at {at}: {e}",
                    channel.as_str()
                )));
            }
        };
        if to == running {
            *self.ready.lock().unwrap() = None;
            return self.checked(None);
        }
        let label = crate::version_label(&to);
        let (asset, sums) = match (ports.asset(), crate::update::sums(&*feed).await) {
            (Ok(asset), Ok(sums)) => (asset, sums),
            (Err(e), _) => {
                return self.checked(Some(format!("couldn't download {label} ahead: {e}")));
            }
            (_, Err(e)) => {
                return self.checked(Some(format!("couldn't download {label} ahead: {e}")));
            }
        };
        let fetching = self.fetching.lock().await;
        if !crate::update::is_build(&self.kept(), &sums, &asset)
            && let Err(e) = crate::update::checked_to(&*feed, &sums, &asset, &self.kept()).await
        {
            return self.checked(Some(format!(
                "couldn't download {label} ahead at {at}: {e}"
            )));
        }
        drop(fetching);
        self.checked(None);
        let update = NodeUpdate {
            version: text(&to),
            channel: match channel {
                Channel::Stable => HubChannel::Stable,
                Channel::Edge => HubChannel::Edge,
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
    pub fn retry(
        self: &Arc<Self>,
        machine_id: &MachineId,
        now: bool,
    ) -> Result<UpdateRun, Refused> {
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
        run.now = now.then_some(true);
        let run = run.clone();
        self.save(&run);
        let this = Arc::clone(self);
        let machine_id = machine_id.clone();
        self.drive(&run.id, async move {
            let update = NodeUpdate {
                version: to,
                channel: this.status().map_or(HubChannel::Edge, |r| r.channel),
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

    /// Starts an update, or returns the one already going; with `now` (Update now), its nodes don't wait for their
    /// agents, also when it is going already. An unfinished run nothing drives any more doesn't hold it up: a new one
    /// takes its place.
    pub fn start(
        self: &Arc<Self>,
        channel: Option<HubChannel>,
        now: bool,
    ) -> Result<UpdateRun, Refused> {
        self.begin(channel, now, false)
    }

    /// [`Self::start`], or an automatic update's (`auto`).
    fn begin(
        self: &Arc<Self>,
        channel: Option<HubChannel>,
        now: bool,
        auto: bool,
    ) -> Result<UpdateRun, Refused> {
        let ports = self.ports().ok_or(Refused::NotWired)?;
        let mut held = self.run.lock().unwrap();
        if let Some(run) = held.as_mut().filter(|r| self.going(r)) {
            if now && run.now.is_none() {
                run.now = Some(true);
                self.save(run);
                self.hurry.notify_waiters();
            }
            return Ok(run.clone());
        }
        let running = ports.running();
        let channel = match channel {
            Some(c @ (HubChannel::Edge | HubChannel::Stable)) => c,
            _ => match Channel::of(&running, ports.release_build()) {
                Channel::Edge => HubChannel::Edge,
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
            now: now.then_some(true),
            auto: auto.then_some(true),
        };
        self.save(&run);
        *held = Some(run.clone());
        let this = Arc::clone(self);
        self.drive(&run.id, async move { this.drive_hub(ports).await });
        Ok(run)
    }

    /// Start over: ends the run going on, with every part left skipped, and starts a new one. Only once the hub's part
    /// has its result: while the hub restarts, the run is returned as it is.
    pub fn start_over(
        self: &Arc<Self>,
        channel: Option<HubChannel>,
        now: bool,
    ) -> Result<UpdateRun, Refused> {
        self.ports().ok_or(Refused::NotWired)?;
        {
            let mut held = self.run.lock().unwrap();
            if let Some(run) = held.as_mut().filter(|r| r.finished_at.is_none()) {
                let hub_settled = run
                    .parts
                    .iter()
                    .any(|p| p.part == UpdatePartKind::Hub && p.state.settled());
                if !hub_settled {
                    return Ok(run.clone());
                }
                for task in self.tasks.lock().unwrap().drain(..) {
                    task.abort();
                }
                let mut parts = run.parts.to_vec();
                for p in parts.iter_mut().filter(|p| !p.state.settled()) {
                    p.state = UpdateState::Skipped;
                    p.stage = None;
                    p.message = Some(text("not asked: the update started over"));
                }
                run.parts = List::new(parts).expect("same parts");
                run.finished_at = Some(Timestamp::from(self.now()));
                self.save(run);
            }
        }
        self.start(channel, now)
    }

    /// Changes the run and writes it down, under the lock: nodes update at once, and two writes of `run.json` at the
    /// same time would share its temporary file.
    fn change(&self, f: impl FnOnce(&mut UpdateRun)) {
        let mut held = self.run.lock().unwrap();
        if let Some(run) = held.as_mut() {
            let elsewhere = DRIVES
                .try_with(|id| run.finished_at.is_some() || id != run.id.as_str())
                .unwrap_or(false);
            if elsewhere {
                return;
            }
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
                p.agents = None;
                p.installs_by = None;
            }
            run.parts = List::new(parts).expect("same parts");
        });
    }

    /// A machine's node part waiting for its agents (`agents` of them mid-step) and what else runs on it (`busy`),
    /// until `by` (ms) at most.
    fn set_waiting(&self, machine_id: &MachineId, agents: u32, busy: Option<&str>, by: i64) {
        let what = match agents {
            0 => None,
            1 => Some("1 agent to finish its step".to_owned()),
            n => Some(format!("{n} agents to finish their step")),
        };
        let what = match (what, busy) {
            (Some(agents), Some(busy)) => format!("{agents}, and for {busy}"),
            (Some(agents), None) => agents,
            (None, Some(busy)) => busy.to_owned(),
            (None, None) => "its agents".to_owned(),
        };
        let at = chrono::DateTime::from_timestamp_millis(by)
            .map(|t| t.format("%H:%M UTC").to_string())
            .unwrap_or_default();
        let message = format!("waits for {what}; installs by {at} whatever runs");
        self.change(|run| {
            let mut parts = run.parts.to_vec();
            if let Some(p) = parts.iter_mut().find(|p| {
                p.machine_id.as_ref() == Some(machine_id) && p.part == UpdatePartKind::Node
            }) {
                p.state = UpdateState::Waiting;
                p.stage = None;
                p.message = Some(text(&message));
                p.agents = Some(agents);
                p.installs_by = Some(Timestamp::from(iso_ms(by)));
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
        if run.auto == Some(true) && run.finished_at.is_some() {
            self.save_last_auto(run);
        }
        self.announce(run);
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

    /// Tells the apps how `run` looks now, when that changed since the last time.
    fn announce(&self, run: &UpdateRun) {
        let now = signal(run);
        {
            let mut announced = self.announced.lock().unwrap();
            if announced.as_ref() == Some(&now) {
                return;
            }
            *announced = Some(now.clone());
        }
        if let Some(ports) = self.ports() {
            ports.announce(&now);
        }
    }

    /// An automatic update that finished: its result in `last-auto.json`, and in the hub's log.
    fn save_last_auto(&self, run: &UpdateRun) {
        let last = last_auto(run);
        if self.last_auto().as_ref() == Some(&last) {
            return;
        }
        let path = self.dir.join("last-auto.json");
        let wrote = fs::create_dir_all(&self.dir).and_then(|()| {
            crate::update::replace_file(
                &path,
                &serde_json::to_vec_pretty(&last).unwrap_or_default(),
            )
        });
        if let Err(e) = wrote {
            tracing::warn!("update: couldn't write {}: {e}", path.display());
        }
        let said = last
            .message
            .as_ref()
            .map(|m| format!(": {m}"))
            .unwrap_or_default();
        tracing::info!(
            "update: {} (automatic) ended {:?}{said}",
            run.id,
            last.result
        );
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
            _ => Channel::Edge,
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
        let kept = self.kept();
        let _fetching = self.fetching.lock().await;
        if kept.exists() {
            let sums = crate::update::sums(&*feed).await?;
            if !crate::update::is_build(&kept, &sums, &asset) {
                crate::update::checked_to(&*feed, &sums, &asset, &kept).await?;
            }
        } else {
            crate::update::verified_to(&*feed, &asset, &kept).await?;
        }
        *self.ready.lock().unwrap() = None;
        let prev = self.dir.join("fleetd.prev");
        let swapped = ports
            .previous()
            .map_err(|e| {
                Failure::new(
                    UpdateStage::Install,
                    format!(
                        "couldn't keep the running binary for a rollback: {e}; nothing was changed"
                    ),
                )
            })
            .and_then(|previous| crate::update::swap(&exe, &kept, &previous, &prev));
        let _ = fs::remove_file(&kept);
        swapped?;
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
        let task = {
            let held = self.run.lock().unwrap();
            // Update pressed already took its place.
            let Some(run) = held
                .clone()
                .filter(|r| !self.going(r) && r.finished_at.is_none())
            else {
                return;
            };
            let (this, id) = (Arc::clone(&self), run.id.to_string());
            self.drive(&id, async move { this.take_on(ports, run).await })
        };
        let _ = task.await;
    }

    async fn take_on(self: Arc<Self>, ports: Arc<dyn UpdatePorts>, run: UpdateRun) {
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
        // Stopped with this task (start over), and driving its run as it does.
        let mut jobs = tokio::task::JoinSet::new();
        for machine_id in waiting {
            let this = Arc::clone(self);
            let ports = Arc::clone(&ports);
            let update = update.clone();
            jobs.spawn(DRIVES.scope(run.id.to_string(), async move {
                this.update_node(&*ports, &machine_id, &update).await;
                this.update_claude(&*ports, &machine_id).await;
            }));
        }
        while jobs.join_next().await.is_some() {}
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
        // The node holds its agents' tool calls that haven't started, and waits for those running to finish (and for
        // what else can't carry on through a restart: a live session), so the restart finds its agents
        // between steps. At the deadline it updates whatever runs; Update now doesn't wait.
        let by = now_ms(self.clock.as_ref()) + ms(self.drain());
        let mut said = None;
        while let Some(now) = facts(ports) {
            if current(&now) {
                return;
            }
            if self.hurried() || now_ms(self.clock.as_ref()) >= by {
                break;
            }
            let agents = match now.can_hold {
                true => ports.hold_node(machine_id).await.unwrap_or(0),
                false => 0,
            };
            if agents == 0 && now.busy.is_none() {
                break;
            }
            if said.as_ref() != Some(&(agents, now.busy.clone())) {
                self.set_waiting(machine_id, agents, now.busy.as_deref(), by);
                said = Some((agents, now.busy));
            }
            tokio::select! {
                () = self.clock.sleep(self.timing.drain_poll) => {}
                () = self.hurry.notified() => {}
            }
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
    /// A cloud machine's catch-up at its hello (hub/cloud): one that slept through an update gets it now. Its node is
    /// brought to the hub's build, which restarts it (`Restarting`: the rest waits for its next hello); one on the hub's
    /// build gets the Claude Code that build was tested with. Nothing while an update runs, which takes every node it
    /// sees online itself, nor from a hub built by hand, which updates nobody.
    pub async fn catch_up(&self, machine_id: &MachineId) -> Result<NodeCatchUp, String> {
        let ports = self.ports().ok_or("the hub's updates aren't wired")?;
        if !ports.release_build() || self.status().is_some_and(|r| self.going(&r)) {
            return Ok(NodeCatchUp::Current);
        }
        let node = ports
            .nodes()
            .into_iter()
            .find(|n| &n.machine_id == machine_id)
            .ok_or_else(|| format!("{machine_id} isn't linked"))?;
        let running = ports.running();
        if !crate::at_least(&node.version, &running) {
            if !node.can_update {
                return Err(format!(
                    "its fleetd {} can't update itself: run `fleetd update` on it",
                    crate::version_label(&node.version)
                ));
            }
            let channel = match Channel::of(&running, true) {
                Channel::Edge => HubChannel::Edge,
                Channel::Stable => HubChannel::Stable,
            };
            let update = NodeUpdate {
                version: text(&running),
                channel,
            };
            let (answer, _) = ports.update_node(machine_id, &update).await?;
            if !answer.ok {
                return Err(answer.message.to_string());
            }
            return Ok(NodeCatchUp::Restarting);
        }
        let target = ports.claude_target();
        let have = node.claude.as_deref().map(install::number);
        if node.agents_mac || !node.can_install_claude || have == Some(target.as_str()) {
            return Ok(NodeCatchUp::Current);
        }
        let answer = ports.install_claude(machine_id, &target).await?;
        if !answer.ok {
            return Err(answer.message.to_string());
        }
        Ok(NodeCatchUp::Current)
    }

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
        // Never "install it by hand" there: the agents' Mac must hold no claude.
        if facts.as_ref().is_some_and(|n| n.agents_mac) {
            return self.set_claude(
                machine_id,
                None,
                UpdateState::Skipped,
                None,
                "the agents' Mac runs no Claude Code: nothing to install",
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

/// A machine's node part that refused its build in a way asking again won't change: its build didn't come up healthy,
/// it can't install or restart itself (a local build, not run as the service), or it was skipped other than offline.
/// A failed download (the channel moved on, say) or a node that didn't come back is worth asking again.
fn refused_for_good(p: &UpdatePart) -> bool {
    match p.state {
        UpdateState::RolledBack => true,
        UpdateState::Failed => matches!(p.stage, Some(UpdateStage::Install | UpdateStage::Restart)),
        UpdateState::Skipped => p.message.as_ref().is_none_or(|m| m.as_str() != OFFLINE),
        _ => false,
    }
}

/// How a finished run went, as [`Updates::last_auto`] keeps it: failed when the hub didn't update, partial when a
/// machine didn't (its first such part says why), else done.
fn last_auto(run: &UpdateRun) -> LastAutoUpdate {
    let hub_ok = run.parts.iter().any(|p| {
        p.part == UpdatePartKind::Hub && matches!(p.state, UpdateState::Done | UpdateState::Current)
    });
    let missed = |p: &&UpdatePart| match p.part {
        UpdatePartKind::Hub => false,
        UpdatePartKind::Node => !matches!(p.state, UpdateState::Done | UpdateState::Current),
        _ => matches!(p.state, UpdateState::Failed | UpdateState::RolledBack),
    };
    let (result, message) = if hub_ok {
        let missed: Vec<&UpdatePart> = run.parts.iter().filter(missed).collect();
        match missed.first() {
            None => (AutoUpdateResult::Done, None),
            Some(p) => {
                let why = p.message.as_ref().map_or("didn't update", |m| m.as_str());
                let more = match missed.len() {
                    1 => String::new(),
                    n => format!(" ({} more didn't update)", n - 1),
                };
                (
                    AutoUpdateResult::Partial,
                    Some(format!("{}: {why}{more}", p.name)),
                )
            }
        }
    } else {
        let hub = run.parts.iter().find(|p| p.part == UpdatePartKind::Hub);
        (
            AutoUpdateResult::Failed,
            hub.and_then(|p| p.message.as_ref()).map(|m| m.to_string()),
        )
    };
    LastAutoUpdate {
        at: run.started_at.clone(),
        to: run.to.clone().filter(|_| hub_ok),
        result,
        message: message.map(|m| text(&m)),
    }
}

/// How `run` looks from the hub row ([`HubUpdateData`]): updating until every part has its result; then put back or
/// failed by the hub's part, updated when the hub or a machine moved, current when every machine already ran the hub's
/// build (or was offline), and failed when a machine the hub's build was for didn't get it and none did.
pub fn signal(run: &UpdateRun) -> HubUpdateData {
    let hub = run.parts.iter().find(|p| p.part == UpdatePartKind::Hub);
    let hub_state = hub.map_or(UpdateState::Waiting, |p| p.state);
    let nodes: Vec<&UpdatePart> = run
        .parts
        .iter()
        .filter(|p| p.part == UpdatePartKind::Node)
        .collect();
    // A machine that didn't get the hub's build: not one that already ran it, nor one offline when the update started.
    let missed = nodes.iter().find(|p| match p.state {
        UpdateState::Done | UpdateState::Current => false,
        UpdateState::Skipped => p.message.as_ref().is_none_or(|m| m.as_str() != OFFLINE),
        _ => true,
    });
    let state = if run.finished_at.is_none() {
        HubUpdatePhase::Updating
    } else {
        match hub_state {
            UpdateState::RolledBack => HubUpdatePhase::PutBack,
            UpdateState::Done => HubUpdatePhase::Updated,
            UpdateState::Current if nodes.iter().any(|p| p.state == UpdateState::Done) => {
                HubUpdatePhase::Updated
            }
            UpdateState::Current if missed.is_none() => HubUpdatePhase::Current,
            _ => HubUpdatePhase::Failed,
        }
    };
    // Failed with the hub current: the machine that missed says why, as `last_auto` words it.
    let message = match (state, hub_state) {
        (HubUpdatePhase::Failed, UpdateState::Current) => missed.map(|p| {
            let why = p.message.as_ref().map_or("didn't update", |m| m.as_str());
            text(&format!("{}: {why}", p.name))
        }),
        (HubUpdatePhase::PutBack | HubUpdatePhase::Failed, _) => hub
            .and_then(|p| p.message.as_ref())
            .map(|m| text(m.as_str())),
        _ => None,
    };
    let machines = nodes
        .iter()
        .take(HUB_UPDATE_MACHINES_MAX)
        .filter_map(|p| {
            Some(HubUpdateMachine {
                machine_id: p.machine_id.clone()?,
                name: text(p.name.as_str()),
                state: p.state,
            })
        })
        .collect();
    let more = nodes.len().saturating_sub(HUB_UPDATE_MACHINES_MAX);
    HubUpdateData {
        run_id: run.id.clone(),
        state,
        hub: hub_state,
        from: hub.map_or_else(|| text(""), |p| p.from.clone()),
        to: run.to.clone(),
        started_at: run.started_at.clone(),
        finished_at: run.finished_at.clone(),
        auto: run.auto,
        machines: List::new(machines).expect("at most HUB_UPDATE_MACHINES_MAX"),
        more_machines: (more > 0).then(|| u32::try_from(more).unwrap_or(u32::MAX)),
        message,
    }
}

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
        agents: None,
        installs_by: None,
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
