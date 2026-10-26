//! `node_action` frames from the hub's doctor: probe the commit identity. Each always answers, in plain words.
use std::time::Duration;

use super::util::{exec, head_utf16};
use super::wire::{
    GitEmailFrom, NodeAction, NodeActionKind, NodeActionResult, NodeProbe, head_text,
};

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

pub async fn probe_host() -> NodeProbe {
    let (git_email, git_email_from) = commit_email().await;
    NodeProbe {
        git_email: git_email.map(|e| head_text(&e)),
        git_email_from,
    }
}

/// `home` is the node's home: an update keeps its previous binary and the watcher's plan there.
pub async fn run_node_action(frame: NodeAction, home: &std::path::Path) -> NodeActionResult {
    match frame.action {
        NodeActionKind::Probe => NodeActionResult {
            id: frame.id,
            ok: true,
            message: head_text("probed"),
            probe: Some(probe_host().await),
            stage: None,
        },
        NodeActionKind::Update => {
            let done = match &frame.update {
                Some(update) => super::update::run(update, home).await,
                None => Err(crate::update::Failure::new(
                    fleetd_contracts::mcp::UpdateStage::Download,
                    "the hub named no build to update to",
                )),
            };
            NodeActionResult {
                id: frame.id,
                ok: done.is_ok(),
                stage: done.as_ref().err().map(|f| f.stage),
                message: head_text(&done.unwrap_or_else(|f| f.message)),
                probe: None,
            }
        }
    }
}
