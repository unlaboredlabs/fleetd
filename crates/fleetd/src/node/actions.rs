//! `node_action` frames from the hub's doctor: re-mint the hub's T3 session, restart T3 with the configured command,
//! or probe the commit identity and free disk space. Each always answers, in plain words.
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use super::supervisor::{Restart, exec};
use super::util::{head_utf16, home_dir};
use super::wire::{
    GitEmailFrom, NodeAction, NodeActionKind, NodeActionResult, NodeProbe, head_text,
};
use fleetd_contracts::prim::Finite;

const REMINT_WAIT: Duration = Duration::from_secs(30);

pub struct NodeActionDeps {
    /// Resolves once a fresh session has been sent to the hub.
    pub remint: Box<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>,
    /// Absent: this node has no T3 restart command.
    pub restart: Option<Restart>,
}

/// `git config --global user.email`, absent when unset or git is missing.
async fn git_config_email() -> Option<String> {
    let out = exec(
        &[
            "git".into(),
            "config".into(),
            "--global".into(),
            "user.email".into(),
        ],
        Duration::from_secs(10),
    )
    .await;
    let email = out.stdout.trim();
    (out.error.is_none() && !email.is_empty()).then(|| head_utf16(email, 320).to_owned())
}

/// The email commits made here carry: `fleetd machine add` puts the hub's identity in the T3 and node units'
/// GIT_AUTHOR_* / GIT_COMMITTER_* environment, which wins over git's global config.
async fn commit_email() -> (Option<String>, Option<GitEmailFrom>) {
    let from_env = std::env::var("GIT_AUTHOR_EMAIL")
        .or_else(|_| std::env::var("GIT_COMMITTER_EMAIL"))
        .ok();
    match from_env.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        Some(email) => (
            Some(head_utf16(email, 320).to_owned()),
            Some(GitEmailFrom::Env),
        ),
        None => match git_config_email().await {
            Some(email) => (Some(email), Some(GitEmailFrom::GitConfig)),
            None => (None, None),
        },
    }
}

/// Free bytes for this user on the filesystem holding `dir`; -1 when it cannot be read.
fn disk_free(dir: &std::path::Path) -> f64 {
    nix::sys::statfs::statfs(dir).map_or(-1.0, |s| {
        s.blocks_available() as f64 * s.block_size() as f64
    })
}

pub async fn probe_host() -> NodeProbe {
    let home = home_dir();
    let (git_email, git_email_from) = commit_email().await;
    NodeProbe {
        git_email: git_email.map(|e| head_text(&e)),
        git_email_from,
        disk_free_bytes: Finite::unchecked(disk_free(&home)),
        disk_path: home.to_string_lossy().into_owned(),
    }
}

pub async fn run_node_action(frame: NodeAction, deps: &NodeActionDeps) -> NodeActionResult {
    let answer = |ok: bool, message: String, probe: Option<NodeProbe>| NodeActionResult {
        id: frame.id.clone(),
        ok,
        message: head_text(&message),
        probe,
    };
    match frame.action {
        NodeActionKind::Probe => answer(true, "probed".into(), Some(probe_host().await)),
        NodeActionKind::RemintSession => match tokio::time::timeout(REMINT_WAIT, (deps.remint)()).await {
            Ok(()) => answer(true, "minted a fresh T3 session and sent it to the hub".into(), None),
            Err(_) => answer(
                false,
                format!("no new T3 session within {} s; T3 may be down (see the node log)", REMINT_WAIT.as_secs()),
                None,
            ),
        },
        NodeActionKind::RestartT3 => match &deps.restart {
            None => answer(
                false,
                "this node has no T3 restart command (fleetd node join --t3-restart-cmd); restart T3 by hand".into(),
                None,
            ),
            Some(restart) => match restart().await {
                Ok(()) => answer(true, "ran the T3 restart command".into(), None),
                Err(error) => answer(false, error, None),
            },
        },
    }
}
