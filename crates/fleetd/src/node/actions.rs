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

/// `sessions` is the node's: an update keeps its previous binary and the watcher's plan in its home, and Claude Code's
/// install runs with its runner's environment. With the answer, the files shared with the watcher when an update
/// started one. A fetch is answered at once and downloads on its own task, not the link's, so the hub's restart doesn't
/// cut it off.
pub async fn run_node_action(
    frame: NodeAction,
    sessions: &super::sessions::SessionService,
) -> (NodeActionResult, Option<super::update::Watch>) {
    let home = &sessions.home();
    match frame.action {
        NodeActionKind::Probe => (
            NodeActionResult {
                id: frame.id,
                ok: true,
                message: head_text("probed"),
                probe: Some(probe_host().await),
                stage: None,
            },
            None,
        ),
        NodeActionKind::Claude => {
            let Some(target) = frame.claude else {
                let none = crate::update::Failure::new(
                    fleetd_contracts::mcp::UpdateStage::Install,
                    "the hub named no Claude Code version",
                );
                return (failed(frame.id, &none), None);
            };
            let claude = super::runner::claude::install::Real {
                binary: super::claude_binary(),
                env: sessions.runner_env(),
            };
            let done = super::runner::claude::install::bring_to(&claude, target.as_str()).await;
            // The runner's version as the hub sees it, at once rather than at the next probe.
            if matches!(
                done,
                Ok(super::runner::claude::install::Installed::Done { .. })
            ) {
                sessions.reprobe().await;
            }
            match done {
                Ok(installed) => (
                    NodeActionResult {
                        id: frame.id,
                        ok: true,
                        stage: None,
                        message: head_text(&match installed {
                            super::runner::claude::install::Installed::Current(v) => {
                                format!("{} {v}", super::runner::claude::install::ALREADY)
                            }
                            super::runner::claude::install::Installed::Done { from, to } => {
                                format!(
                                    "Claude Code {from} -> {to}: new sessions start on {to}, running ones finish on {from}"
                                )
                            }
                        }),
                        probe: None,
                    },
                    None,
                ),
                Err(f) => (failed(frame.id, &f), None),
            }
        }
        NodeActionKind::Fetch => match frame.update {
            Some(update) => {
                let home = home.to_owned();
                tokio::spawn(async move { super::update::run_fetch(&update, &home).await });
                (
                    NodeActionResult {
                        id: frame.id,
                        ok: true,
                        stage: None,
                        message: head_text("fetching"),
                        probe: None,
                    },
                    None,
                )
            }
            None => (
                failed(
                    frame.id,
                    &crate::update::Failure::new(
                        fleetd_contracts::mcp::UpdateStage::Download,
                        "the hub named no build to fetch",
                    ),
                ),
                None,
            ),
        },
        NodeActionKind::Update => {
            let done = match &frame.update {
                Some(update) => super::update::run(update, home).await,
                None => Err(crate::update::Failure::new(
                    fleetd_contracts::mcp::UpdateStage::Download,
                    "the hub named no build to update to",
                )),
            };
            match done {
                Ok(answer) => (
                    NodeActionResult {
                        id: frame.id,
                        ok: true,
                        stage: None,
                        message: head_text(&answer.message),
                        probe: None,
                    },
                    answer.watch,
                ),
                Err(f) => (failed(frame.id, &f), None),
            }
        }
    }
}

/// An update that failed, as the answer to its action.
pub fn failed(
    id: fleetd_contracts::prim::NonEmpty,
    f: &crate::update::Failure,
) -> NodeActionResult {
    NodeActionResult {
        id,
        ok: false,
        stage: Some(f.stage),
        message: head_text(&f.message),
        probe: None,
    }
}
