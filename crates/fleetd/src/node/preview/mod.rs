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
    PreviewStopFrame,
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

/// Finds this machine on its tailnet, for the proxy.
pub type DetectTailnet =
    Arc<dyn Fn() -> proxy::BoxFuture<'static, std::io::Result<proxy::Config>> + Send + Sync>;
/// A project's checkout on this machine, by project id.
pub type ProjectRoot = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;

/// One running preview: how to end it.
struct Live {
    stop: watch::Sender<Option<PreviewEndReason>>,
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
        let detect: DetectTailnet = Arc::new(|| Box::pin(proxy::Config::detect()));
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

    /// `preview_run`: takes the run and answers at once; the run reports as it goes. The same preview again is
    /// taken again without a second run.
    pub fn run(self: &Arc<Self>, frame: PreviewRunFrame) -> PreviewRunResult {
        let id = frame.id.clone();
        let refuse = |why: String| PreviewRunResult {
            id: id.clone(),
            error: Some(McpToolError::new(ErrorCode::Invalid, why)),
        };
        let preview_id = frame.preview_id.as_str().to_owned();
        if self.runs.lock().unwrap().contains_key(&preview_id) {
            return PreviewRunResult { id, error: None };
        }
        let Some(root) = (self.root_of)(frame.project_id.as_str()) else {
            return refuse(format!(
                "no project {} on this machine",
                frame.project_id.as_str()
            ));
        };
        let Some(web) = frame.web.clone() else {
            return refuse("this machine runs web previews only".to_owned());
        };
        // What the hub names goes to git only once it is a full SHA or a branch name, never an option.
        let checked = frame.heads.iter().try_for_each(|h| {
            slots::check_sha(h.sha.as_str())?;
            slots::check_branch(&root, h.branch.as_str())
        });
        let checked = checked.and_then(|()| {
            frame
                .base
                .as_ref()
                .map_or(Ok(()), |b| slots::check_branch(&root, b.as_str()))
        });
        if let Err(why) = checked {
            return refuse(why);
        }
        let shas: Vec<&str> = frame.heads.iter().map(|h| h.sha.as_str()).collect();
        let key = slots::key_of(frame.base.as_ref().map(|b| b.as_str()), &shas);
        let dir = slots::project_dir(&self.home, frame.project_id.as_str());
        let Some(slot) = self.slots.take(&dir, self.slots_per_project, &key) else {
            return refuse(format!(
                "{} previews of this project already run on this machine; end one first",
                self.slots_per_project
            ));
        };
        let (stop, stopped) = watch::channel(None);
        self.runs
            .lock()
            .unwrap()
            .insert(preview_id.clone(), Live { stop });
        let me = self.clone();
        tokio::spawn(async move {
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
            me.runs.lock().unwrap().remove(&preview_id);
        });
        PreviewRunResult { id, error: None }
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

    /// Ends every preview, for a node shutting down.
    pub fn stop_all(&self) {
        for live in self.runs.lock().unwrap().values() {
            let _ = live.stop.send(Some(PreviewEndReason::Lost));
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
        let Ok(entries) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "pid") {
                serve::reap(&path, &path.with_extension(""));
            }
        }
    }
}
