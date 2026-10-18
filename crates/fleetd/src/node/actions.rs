//! `node_action` frames from the hub's doctor: probe the commit identity and free disk space. Each always answers, in
//! plain words.
use std::time::Duration;

use super::util::{exec, head_utf16, home_dir};
use super::wire::{
    GitEmailFrom, NodeAction, NodeActionKind, NodeActionResult, NodeProbe, head_text,
};
use fleetd_contracts::prim::Finite;

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

/// The email commits made here carry: `fleetd machine add` puts the hub's identity in the node unit's
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

pub async fn run_node_action(frame: NodeAction) -> NodeActionResult {
    match frame.action {
        NodeActionKind::Probe => NodeActionResult {
            id: frame.id,
            ok: true,
            message: head_text("probed"),
            probe: Some(probe_host().await),
        },
    }
}
