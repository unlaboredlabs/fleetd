//! The node calls behind adding a project: scan a machine for checkouts, look at a path, clone with progress, and
//! `gh repo list` there.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::sessions::{
    CloneProgressFrame, GhRepos, RepoFacts, ScannedRepo, SessionCall, SessionOutput,
};
use tokio::sync::mpsc;

use super::{ExecutorError, Executors, NodeOperation, failed, new_uuid, non_empty};

pub(super) type CloneWatchers = Mutex<HashMap<String, mpsc::UnboundedSender<CloneProgressFrame>>>;

/// A scan reads at most a few hundred directories; an older node never answers the call at all.
const SCAN_TIMEOUT: Duration = Duration::from_secs(10);
/// gh lists the user's repos and each org's, one call per owner.
const GH_TIMEOUT: Duration = Duration::from_secs(120);
/// A large repository over a slow link.
pub const CLONE_TIMEOUT: Duration = Duration::from_secs(60 * 60);

/// A running clone: its progress frames until it ends, then its result.
pub struct CloneRun {
    pub add_id: String,
    pub progress: mpsc::UnboundedReceiver<CloneProgressFrame>,
}

impl Executors {
    pub(super) fn clone_progress(&self, frame: CloneProgressFrame) {
        if let Some(tx) = self.clones.lock().unwrap().get(frame.add_id.as_str()) {
            let _ = tx.send(frame);
        }
    }

    pub async fn repo_scan(
        &self,
        machine_id: &MachineId,
    ) -> Result<(String, Vec<ScannedRepo>), ExecutorError> {
        let op = NodeOperation::Read;
        match self
            .call(machine_id, op, SessionCall::RepoScan, SCAN_TIMEOUT)
            .await?
        {
            SessionOutput::Repos { clone_root, repos } => Ok((clone_root, repos)),
            _ => Err(failed(machine_id, op, "the node sent no repo list")),
        }
    }

    pub async fn repo_inspect(
        &self,
        machine_id: &MachineId,
        path: &str,
    ) -> Result<RepoFacts, ExecutorError> {
        let op = NodeOperation::Read;
        let call = SessionCall::RepoInspect {
            path: non_empty(machine_id, op, "path", path)?,
        };
        match self.call(machine_id, op, call, SCAN_TIMEOUT).await? {
            SessionOutput::RepoFacts(facts) => Ok(facts),
            _ => Err(failed(machine_id, op, "the node sent no repo facts")),
        }
    }

    pub async fn gh_repo_list(&self, machine_id: &MachineId) -> Result<GhRepos, ExecutorError> {
        let op = NodeOperation::Read;
        match self
            .call(machine_id, op, SessionCall::GhRepoList, GH_TIMEOUT)
            .await?
        {
            SessionOutput::GhRepos(repos) => Ok(repos),
            _ => Err(failed(machine_id, op, "the node sent no gh repo list")),
        }
    }

    /// Registers a clone's progress stream; pass the run to [`Executors::repo_clone`].
    pub fn clone_start(&self) -> CloneRun {
        let add_id = new_uuid();
        let (tx, progress) = mpsc::unbounded_channel();
        self.clones.lock().unwrap().insert(add_id.clone(), tx);
        CloneRun { add_id, progress }
    }

    /// Clones on the node; its progress frames go to the run's receiver until this returns.
    pub async fn repo_clone(
        &self,
        machine_id: &MachineId,
        add_id: &str,
        url: &str,
        dest: &str,
    ) -> Result<RepoFacts, ExecutorError> {
        let op = NodeOperation::Project;
        let call = (|| {
            Ok::<_, ExecutorError>(SessionCall::RepoClone {
                add_id: non_empty(machine_id, op, "add id", add_id)?,
                url: non_empty(machine_id, op, "url", url)?,
                dest: non_empty(machine_id, op, "destination", dest)?,
            })
        })();
        let result = match call {
            Ok(call) => self.call(machine_id, op, call, CLONE_TIMEOUT).await,
            Err(e) => Err(e),
        };
        self.clones.lock().unwrap().remove(add_id);
        match result? {
            SessionOutput::RepoFacts(facts) => Ok(facts),
            _ => Err(failed(machine_id, op, "the node sent no repo facts")),
        }
    }
}
