//! `node_action` frames from the hub's doctor: probe the commit identity and idle sleep. Each always answers, in plain
//! words.
use std::time::Duration;

use super::power;
use super::util::{exec, head_utf16};
use super::wire::{
    GitEmailFrom, NodeAction, NodeActionKind, NodeActionResult, NodeProbe, head_text,
};
use fleetd_contracts::node_link::IdleSleep;
use fleetd_contracts::prim::{Count, List, Text};

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
        idle_sleep: Some(List::unchecked(
            power::settings::read()
                .await
                .into_iter()
                .take(8)
                .map(|s| IdleSleep {
                    source: Text::unchecked(s.source),
                    action: Text::unchecked(s.action),
                    // An absurd timeout is dropped: past 2^53 the hub could not decode the probe.
                    after_sec: s
                        .after_sec
                        .and_then(|n| Count::new(i64::try_from(n).ok()?).ok()),
                    fix: Text::unchecked(head_utf16(&s.fix, 400)),
                })
                .collect(),
        )),
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
