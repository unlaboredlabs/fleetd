//! Try it yourself: previews of a PR's app the person opens themselves.
pub mod proxy;
mod run;
mod serve;
mod slots;
#[cfg(test)]
mod tests;

// The node's side (docs/design/try-it.md): the hub sends `preview_run` for a preview someone asked for, and the node
// checks the PR out into one of the project's preview worktrees, runs the project's setup, build and start commands,
// asks the app until it answers, and opens it on the tailnet (proxy.rs) to the hub owner's devices. It reports every
// step with `preview_report`, and ends the preview on `preview_stop`, after the project's idle time without a
// connection, or at the 4 hour cap: the app's processes and its port go, the worktree stays as the next one's cache.
// A node that restarts ends what its last run left behind.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fleetd_contracts::mcp::{ErrorCode, McpToolError};
use fleetd_contracts::node_link::NodeToHub;
use fleetd_contracts::preview::{
    PreviewEndReason, PreviewReport, PreviewRunFrame, PreviewRunResult, PreviewState,
    PreviewStopFrame, WebPreview,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};

use super::wire::to_json;

/// Preview worktrees kept per project when node.json sets none.
pub const SLOTS_DEFAULT: usize = 3;

/// node.json's `preview`: how this machine runs previews. Every field is optional.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewNodeConfig {
    /// False: this machine runs no previews. Absent: it does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Previews of one project at once, each in a worktree of its own that stays as its build cache. Absent: 3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slots: Option<usize>,
}

impl PreviewNodeConfig {
    pub fn enabled(&self) -> bool {
        self.enabled != Some(false)
    }
}

/// How long things take; tests shrink them.
#[derive(Clone, Debug)]
pub struct Timing {
    /// One of the project's idle minutes.
    pub minute: Duration,
    /// How often a running preview looks at its app and its idle time.
    pub tick: Duration,
    /// How long the app may take to answer after its start.
    pub ready_within: Duration,
    /// A build's time limit.
    pub build_timeout: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            minute: Duration::from_secs(60),
            tick: Duration::from_secs(5),
            ready_within: Duration::from_secs(120),
            build_timeout: Duration::from_secs(30 * 60),
        }
    }
}

/// Finds this machine on its tailnet, for the proxy, with the login whose devices it lets in (the hub owner's, when
/// the hub names one).
pub type DetectTailnet = Arc<
    dyn Fn(Option<String>) -> proxy::BoxFuture<'static, std::io::Result<proxy::Config>>
        + Send
        + Sync,
>;
/// A project's checkout on this machine, by project id.
pub type ProjectRoot = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

/// How long a node shutting down, or a project being removed, waits for its previews' apps to end.
pub const END_WAIT: Duration = Duration::from_secs(10);

/// One running preview: how to end it, and its task, to wait for.
struct Live {
    project: String,
    stop: watch::Sender<Option<PreviewEndReason>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

/// The node's previews.
pub struct Previews {
    home: PathBuf,
    slots_per_project: usize,
    root_of: ProjectRoot,
    detect: DetectTailnet,
    timing: Timing,
    slots: Arc<slots::Slots>,
    runs: Mutex<HashMap<String, Live>>,
    /// The newest report of each preview not yet known to have reached the hub as over.
    latest: Mutex<HashMap<String, PreviewReport>>,
    outlet: Mutex<Option<mpsc::UnboundedSender<String>>>,
}

impl Previews {
    /// The service, after ending whatever a previous run of the node left running in its preview worktrees.
    pub fn new(
        home: &Path,
        config: &PreviewNodeConfig,
        root_of: ProjectRoot,
        detect: DetectTailnet,
        timing: Timing,
    ) -> Arc<Self> {
        reap_all(home);
        Arc::new(Self {
            home: home.to_owned(),
            slots_per_project: config.slots.unwrap_or(SLOTS_DEFAULT).max(1),
            root_of,
            detect,
            timing,
            slots: Arc::default(),
            runs: Mutex::default(),
            latest: Mutex::default(),
            outlet: Mutex::default(),
        })
    }

    /// The real service: projects from the node's store, the tailnet from tailscaled.
    pub fn for_node(home: &Path, config: &PreviewNodeConfig, root_of: ProjectRoot) -> Arc<Self> {
        let detect: DetectTailnet = Arc::new(|owner| {
            Box::pin(async move { proxy::Config::detect(owner.as_deref()).await })
        });
        Self::new(home, config, root_of, detect, Timing::default())
    }

    /// Sends reports on `tx` from now on, starting with the newest of each preview (a new link may have missed them).
    pub fn attach(&self, tx: mpsc::UnboundedSender<String>) {
        let latest: Vec<PreviewReport> = self.latest.lock().unwrap().values().cloned().collect();
        for report in latest {
            let _ = tx.send(to_json(&NodeToHub::PreviewReport(report)));
        }
        *self.outlet.lock().unwrap() = Some(tx);
    }

    fn report(&self, report: PreviewReport) {
        let id = report.preview_id.as_str().to_owned();
        let over = report.state.is_over();
        let sent = self.outlet.lock().unwrap().as_ref().is_some_and(|tx| {
            tx.send(to_json(&NodeToHub::PreviewReport(report.clone())))
                .is_ok()
        });
        let mut latest = self.latest.lock().unwrap();
        if over && sent {
            latest.remove(&id);
        } else {
            latest.insert(id, report);
        }
    }

    /// `preview_run`: takes the run, or refuses it, and the run reports as it goes. The same preview again is taken
    /// without a second run.
    ///
    /// The preview is known from the moment this is called, before the future it returns runs: the link calls it on
    /// its own loop and spawns the rest, so a `preview_stop` right behind the run always finds it and ends it, however
    /// far it got (even before it starts). The rest runs its git (the names' checks, the slot's pick) off the async
    /// threads.
    pub fn run(
        self: &Arc<Self>,
        frame: PreviewRunFrame,
    ) -> impl std::future::Future<Output = PreviewRunResult> + Send + 'static {
        let preview_id = frame.preview_id.as_str().to_owned();
        let (stop, stopped) = watch::channel(None);
        let fresh = {
            let mut runs = self.runs.lock().unwrap();
            let fresh = !runs.contains_key(&preview_id);
            if fresh {
                runs.insert(
                    preview_id.clone(),
                    Live {
                        project: frame.project_id.as_str().to_owned(),
                        stop,
                        task: None,
                    },
                );
            }
            fresh
        };
        let me = self.clone();
        async move {
            let id = frame.id.clone();
            if !fresh {
                return PreviewRunResult { id, error: None };
            }
            me.start(frame, stopped).await
        }
    }

    async fn start(
        self: Arc<Self>,
        frame: PreviewRunFrame,
        stopped: watch::Receiver<Option<PreviewEndReason>>,
    ) -> PreviewRunResult {
        let id = frame.id.clone();
        let preview_id = frame.preview_id.as_str().to_owned();
        let taken = {
            let me = self.clone();
            let frame = frame.clone();
            tokio::task::spawn_blocking(move || me.take(&frame))
                .await
                .unwrap_or_else(|e| Err(e.to_string()))
        };
        let (root, web, key, slot) = match taken {
            Ok(taken) => taken,
            Err(why) => {
                self.runs.lock().unwrap().remove(&preview_id);
                return PreviewRunResult {
                    id,
                    error: Some(McpToolError::new(ErrorCode::Invalid, why)),
                };
            }
        };
        let me = self.clone();
        let done = preview_id.clone();
        let task = tokio::spawn(async move {
            // A stop that came meanwhile ends it at its first step, before anything runs.
            run::run(
                &me,
                run::Run {
                    frame,
                    web,
                    root,
                    key,
                },
                &slot.path,
                stopped,
            )
            .await;
            drop(slot);
            me.runs.lock().unwrap().remove(&done);
        });
        if let Some(live) = self.runs.lock().unwrap().get_mut(&preview_id) {
            live.task = Some(task);
        }
        PreviewRunResult { id, error: None }
    }

    /// What a run needs before it starts, checked: the project's checkout, its web setting, the names the hub gave
    /// (a full SHA, a branch name, never an option, before they reach git) and a free slot. Blocking: it runs git.
    fn take(
        &self,
        frame: &PreviewRunFrame,
    ) -> Result<(PathBuf, WebPreview, String, slots::Held), String> {
        let root = (self.root_of)(frame.project_id.as_str())
            .ok_or_else(|| format!("no project {} on this machine", frame.project_id.as_str()))?;
        let web = frame
            .web
            .clone()
            .ok_or_else(|| "this machine runs web previews only".to_owned())?;
        for h in frame.heads.iter() {
            slots::check_sha(h.sha.as_str())?;
            slots::check_branch(&root, h.branch.as_str())?;
        }
        if let Some(base) = &frame.base {
            slots::check_branch(&root, base.as_str())?;
        }
        let shas: Vec<&str> = frame.heads.iter().map(|h| h.sha.as_str()).collect();
        let key = slots::key_of(frame.base.as_ref().map(|b| b.as_str()), &shas);
        let dir = slots::project_dir(&self.home, frame.project_id.as_str());
        let slot = self
            .slots
            .take(&dir, self.slots_per_project, &key)
            .ok_or_else(|| {
                format!(
                    "{} previews of this project already run on this machine; end one first",
                    self.slots_per_project
                )
            })?;
        Ok((root, web, key, slot))
    }

    /// `preview_stop`: ends the run. One the node doesn't know (it restarted, or it ended already) is reported ended,
    /// so the hub settles it.
    pub fn stop(&self, frame: PreviewStopFrame) {
        let live = self
            .runs
            .lock()
            .unwrap()
            .get(frame.preview_id.as_str())
            .map(|l| l.stop.clone());
        match live {
            Some(stop) => {
                let _ = stop.send(Some(frame.reason));
            }
            None => self.report(PreviewReport {
                preview_id: frame.preview_id,
                state: PreviewState::Ended,
                head: None,
                steps: Default::default(),
                url: None,
                session_id: None,
                idle_until: None,
                end_reason: Some(frame.reason),
                note: None,
            }),
        }
    }

    /// Ends the previews `which` picks with `reason`, and waits up to [`END_WAIT`] for their apps to end.
    async fn end_where(&self, which: impl Fn(&Live) -> bool, reason: PreviewEndReason) {
        let tasks: Vec<tokio::task::JoinHandle<()>> = {
            let mut runs = self.runs.lock().unwrap();
            runs.values_mut()
                .filter(|l| which(l))
                .filter_map(|l| {
                    let _ = l.stop.send(Some(reason));
                    l.task.take()
                })
                .collect()
        };
        let _ = tokio::time::timeout(END_WAIT, futures_util::future::join_all(tasks)).await;
    }

    /// Ends every preview, for a node shutting down, and waits a little for their apps to end.
    pub async fn stop_all(&self) {
        self.end_where(|_| true, PreviewEndReason::Lost).await;
    }

    /// A project removed from this machine: its previews end, and its preview worktrees go (they hold no work).
    pub async fn forget_project(&self, project_id: &str, root: &Path) {
        self.end_where(|l| l.project == project_id, PreviewEndReason::Done)
            .await;
        let dir = slots::project_dir(&self.home, project_id);
        let root = root.to_owned();
        let removed = tokio::task::spawn_blocking(move || {
            reap_project(&dir);
            super::worktree::remove_all(&root, &dir)
        })
        .await;
        if let Ok(Err(e)) = removed {
            tracing::warn!(project_id, error = %e.0, "preview worktrees not removed");
        }
    }

    #[cfg(test)]
    pub fn running(&self) -> usize {
        self.runs.lock().unwrap().len()
    }
}

/// Ends the apps a previous run of the node left in any project's preview worktrees.
fn reap_all(home: &Path) {
    let Ok(projects) = std::fs::read_dir(home.join("previews")) else {
        return;
    };
    for project in projects.flatten() {
        reap_project(&project.path());
    }
}

/// Ends the apps left in one project's preview worktrees, by the process groups their pid files name.
fn reap_project(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "pid") {
            serve::reap(&path, &path.with_extension(""));
        }
    }
}
