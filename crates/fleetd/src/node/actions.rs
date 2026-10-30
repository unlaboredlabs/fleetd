//! `node_action` frames from the hub: the doctor's probe of the commit identity, updates and the hold ahead of one,
//! Claude Code's install and its login from the app. Each always answers, in plain words.
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
                login_url: None,
                steps: None,
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
                            super::runner::claude::install::Installed::Left(said) => said,
                        }),
                        probe: None,
                        login_url: None,
                        steps: None,
                    },
                    None,
                ),
                Err(f) => (failed(frame.id, &f), None),
            }
        }
        NodeActionKind::ClaudeLogin => {
            let started = super::claude_login::LOGINS
                .start(&super::claude_binary(), &sessions.runner_env())
                .await;
            (
                login_answer(
                    frame.id,
                    started.as_ref().map(String::as_str).map_err(String::as_str),
                    true,
                ),
                None,
            )
        }
        NodeActionKind::ClaudeLoginCode => {
            let Some(code) = frame.code else {
                return (
                    login_answer(frame.id, Err("the hub sent no code"), false),
                    None,
                );
            };
            let done = super::claude_login::LOGINS.finish(code.as_str()).await;
            // Logged in as the hub sees it, at once rather than at the next probe: the login is the probe's to judge.
            let done = match done {
                Ok(said) => match sessions.reprobe().await.login {
                    fleetd_contracts::sessions::LoginStatus::LoggedOut => {
                        Err(format!("{said}; but claude still reports no login"))
                    }
                    _ => Ok(said),
                },
                Err(e) => Err(e),
            };
            (
                login_answer(
                    frame.id,
                    done.as_ref().map(String::as_str).map_err(String::as_str),
                    false,
                ),
                None,
            )
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
                        login_url: None,
                        steps: None,
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
        NodeActionKind::Hold => {
            let steps = sessions.hold();
            (
                NodeActionResult {
                    id: frame.id,
                    ok: true,
                    stage: None,
                    message: head_text(&format!("holding; {steps} mid-step")),
                    probe: None,
                    login_url: None,
                    steps: Some(steps),
                },
                None,
            )
        }
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
                        login_url: None,
                        steps: None,
                    },
                    answer.watch,
                ),
                // No restart follows: what the hold stopped goes on now.
                Err(f) => {
                    super::hold::clear(home);
                    (failed(frame.id, &f), None)
                }
            }
        }
    }
}

/// A login's answer: the URL it started with (`url`), or the words it ended with.
fn login_answer(
    id: fleetd_contracts::prim::NonEmpty,
    done: Result<&str, &str>,
    url: bool,
) -> NodeActionResult {
    NodeActionResult {
        id,
        ok: done.is_ok(),
        message: head_text(match done {
            Ok(_) if url => "sign in at the URL, then give the code it shows",
            Ok(said) | Err(said) => said,
        }),
        probe: None,
        stage: None,
        login_url: done.ok().filter(|_| url).map(head_text),
        steps: None,
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
        login_url: None,
        steps: None,
    }
}
