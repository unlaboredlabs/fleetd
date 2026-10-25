//! Where a writer's worktree started, in words: the spawn result, the task's lines, the attention item when git can't
//! fetch the project's remote, and the doctor checks that read it.
use chrono::{DateTime, Utc};
use fleetd_contracts::sessions::{BaseErrorKind, WorktreeBase};

/// A fetch failure a person has to fix: credentials, a wrong URL or a repo they can't see, a remote with no default
/// branch, or any other refusal. Being offline, or having no remote, fixes itself or is the project's choice.
pub fn alert(base: &WorktreeBase) -> Option<BaseErrorKind> {
    let kind = base.error.as_ref()?.kind;
    matches!(
        kind,
        BaseErrorKind::Auth
            | BaseErrorKind::NoAccess
            | BaseErrorKind::NoDefaultBranch
            | BaseErrorKind::Failed
    )
    .then_some(kind)
}

/// The fix [`fetch_failed_text`] names, as a doctor fix's label.
pub fn fix_label(kind: BaseErrorKind, machine_id: &str) -> String {
    match kind {
        BaseErrorKind::Auth => {
            format!("Log git in on {machine_id}: `gh auth login`, or add your SSH key")
        }
        BaseErrorKind::NoAccess => {
            "Check the remote's URL, the repo's name, and that your key or login can see it"
                .to_owned()
        }
        BaseErrorKind::NoDefaultBranch => "Set the remote's default branch".to_owned(),
        _ => "Run `git fetch` in the project to see why".to_owned(),
    }
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// "07:41 UTC" on the day of `now`, else "10-24 18:02 UTC".
fn when(at: &str, now: &str) -> String {
    let Ok(t) = DateTime::parse_from_rfc3339(at).map(|t| t.with_timezone(&Utc)) else {
        return at.to_owned();
    };
    let today = DateTime::parse_from_rfc3339(now)
        .is_ok_and(|n| n.with_timezone(&Utc).date_naive() == t.date_naive());
    t.format(if today {
        "%H:%M UTC"
    } else {
        "%m-%d %H:%M UTC"
    })
    .to_string()
}

/// "origin/main @abc1234 as of 07:41 UTC".
pub fn start(base: &WorktreeBase, now: &str) -> String {
    let at = base.fetched_at.as_ref().map_or_else(String::new, |at| {
        format!(" as of {}", when(at.as_str(), now))
    });
    format!("{} @{}{at}", base.base_ref, short(&base.sha))
}

/// "based on origin/main @abc1234 as of 07:41 UTC", and why it may be behind: "(fetch failed: offline)".
pub fn line(base: &WorktreeBase, now: &str) -> String {
    let Some(error) = &base.error else {
        return format!("based on {}", start(base, now));
    };
    match error.kind {
        BaseErrorKind::NoRemote => {
            format!(
                "based on local {} @{} (no remote)",
                base.base_ref,
                short(&base.sha)
            )
        }
        BaseErrorKind::NoDefaultBranch => {
            format!("based on {} ({})", start(base, now), error.message)
        }
        BaseErrorKind::Offline
        | BaseErrorKind::Auth
        | BaseErrorKind::NoAccess
        | BaseErrorKind::Failed => {
            format!(
                "based on {} (fetch failed: {})",
                start(base, now),
                error.message
            )
        }
    }
}

/// The attention item's line and its fix command, for a base [`alert`] flags: what failed, the fix, and where agents
/// start from meanwhile.
pub fn fetch_failed_text(
    project: &str,
    base: &WorktreeBase,
    now: &str,
) -> (String, Option<String>) {
    let Some(error) = &base.error else {
        return (String::new(), None);
    };
    let remote = base
        .base_ref
        .split_once('/')
        .map_or("its remote", |(remote, _)| remote);
    let from = start(base, now);
    match error.kind {
        BaseErrorKind::Auth => (
            format!(
                "git can't fetch {remote} for {project}: {}. Fix: `gh auth login` or your SSH key. Agents start from \
                 {from}; their pushes will fail the same way.",
                error.message.trim_end_matches('.')
            ),
            Some("gh auth login".to_owned()),
        ),
        BaseErrorKind::NoAccess => (
            format!(
                "git can't fetch {remote} for {project}: {}. Fix: check the remote's URL (`git remote get-url \
                 {remote}`), the repo's name, and that your key or login can see it. Agents start from {from}.",
                error.message.trim_end_matches('.')
            ),
            Some(format!("git remote get-url {remote}")),
        ),
        BaseErrorKind::NoDefaultBranch => (
            format!(
                "{}, so {project} has no default branch to start from. Fix: set the remote's default branch (on a bare \
                 repo, `git symbolic-ref HEAD refs/heads/main`). Agents start from {from} meanwhile.",
                error.message
            ),
            None,
        ),
        _ => (
            format!(
                "git can't fetch {remote} for {project}: {}. Fix: run `git fetch {remote}` in the project to see why. \
                 Agents start from {from}.",
                error.message.trim_end_matches('.')
            ),
            Some(format!("git fetch {remote}")),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleetd_contracts::ids::Timestamp;
    use fleetd_contracts::sessions::BaseError;

    const NOW: &str = "2026-10-25T07:45:00.000Z";

    fn base(fetched_at: Option<&str>, error: Option<(BaseErrorKind, &str)>) -> WorktreeBase {
        WorktreeBase {
            base_ref: "origin/main".into(),
            sha: "abc1234def5678".into(),
            fetched_at: fetched_at.map(|t| Timestamp(t.into())),
            error: error.map(|(kind, message)| BaseError {
                kind,
                message: message.into(),
            }),
            fork_behind: None,
        }
    }

    #[test]
    fn the_line_names_the_ref_the_commit_and_when_it_was_fetched() {
        assert_eq!(
            line(&base(Some("2026-10-25T07:41:00Z"), None), NOW),
            "based on origin/main @abc1234 as of 07:41 UTC"
        );
        assert_eq!(
            line(
                &base(
                    Some("2026-10-24T18:02:00Z"),
                    Some((BaseErrorKind::Offline, "offline"))
                ),
                NOW
            ),
            "based on origin/main @abc1234 as of 10-24 18:02 UTC (fetch failed: offline)"
        );
        let mut local = base(None, Some((BaseErrorKind::NoRemote, "no remote")));
        local.base_ref = "main".into();
        assert_eq!(
            line(&local, NOW),
            "based on local main @abc1234 (no remote)"
        );
    }

    #[test]
    fn only_failures_a_person_fixes_raise_an_alert() {
        assert_eq!(alert(&base(None, None)), None);
        assert_eq!(
            alert(&base(None, Some((BaseErrorKind::Offline, "offline")))),
            None
        );
        assert_eq!(
            alert(&base(None, Some((BaseErrorKind::NoRemote, "no remote")))),
            None
        );
        assert_eq!(
            alert(&base(None, Some((BaseErrorKind::Auth, "denied")))),
            Some(BaseErrorKind::Auth)
        );
        assert_eq!(
            alert(&base(None, Some((BaseErrorKind::NoDefaultBranch, "none")))),
            Some(BaseErrorKind::NoDefaultBranch)
        );
    }

    #[test]
    fn an_auth_failure_says_what_failed_and_the_fix() {
        let failed = base(
            Some("2026-10-25T06:00:00Z"),
            Some((BaseErrorKind::Auth, "remote: Invalid username or token.")),
        );
        let (text, fix) = fetch_failed_text("shop", &failed, NOW);
        assert_eq!(
            text,
            "git can't fetch origin for shop: remote: Invalid username or token. Fix: `gh auth login` or your SSH key. \
             Agents start from origin/main @abc1234 as of 06:00 UTC; their pushes will fail the same way."
        );
        assert_eq!(fix.as_deref(), Some("gh auth login"));
    }
}
