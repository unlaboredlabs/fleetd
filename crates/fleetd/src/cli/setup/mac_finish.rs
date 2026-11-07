//! The end of the agents' Mac's setup, on the Mac itself, once its node has joined (docs: agents-mac.md#permissions):
//! each grant's pane opened in turn and waited for, then the node's checks read until they pass. Each step returns
//! what it found, so `fleetd init --join … --mac` and the app's "Set up this Mac for agents" drive the same steps and
//! say the same things. The node does the restart a new grant needs by itself (node/agents_mac/grants.rs).
use std::path::Path;
use std::time::{Duration, SystemTime};

use fleetd_contracts::node_link::{MacCheck, MacCheckId, MacCheckState, MacHealth};

use crate::node::agents_mac::{checks, read_health};

/// The two grants, in the order setup asks for them.
pub const GRANTS: [MacCheckId; 2] = [MacCheckId::Accessibility, MacCheckId::ScreenRecording];

/// How long setup waits for the person to turn a grant on.
pub const GRANT_WAIT: Duration = Duration::from_secs(10 * 60);
/// How long it waits for the node's checks once both grants are on: a restart, then its first checks.
pub const CHECKS_WAIT: Duration = Duration::from_secs(90);

/// One grant: what it's called in System Settings, its pane, and whether the node has it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Grant {
    pub id: MacCheckId,
    pub name: &'static str,
    /// The `x-apple.systempreferences:` link to its pane.
    pub pane: &'static str,
    /// As a fresh process of the node found it last; None before the node said.
    pub granted: Option<bool>,
}

fn name(id: MacCheckId) -> &'static str {
    match id {
        MacCheckId::ScreenRecording => "Screen Recording",
        _ => "Accessibility",
    }
}

/// Both grants as the node at `node_home` found them last (`mac-health.json`, which it rewrites within 2 s of a grant).
pub fn grants(node_home: &Path) -> Vec<Grant> {
    let health = read_health(node_home).map(|(h, _)| h);
    GRANTS
        .iter()
        .map(|&id| Grant {
            id,
            name: name(id),
            pane: checks::pane(id),
            granted: health.as_ref().and_then(|h| {
                h.checks
                    .iter()
                    .find(|c| c.id == id)
                    .and_then(|c| match c.state {
                        MacCheckState::Ok => Some(true),
                        MacCheckState::Fail => Some(false),
                        _ => None,
                    })
            }),
        })
        .collect()
}

/// What the person does for a grant the node lacks.
pub fn ask(grant: &Grant) -> String {
    format!(
        "In System Settings › Privacy & Security › {} (open now), turn on fleetd. macOS may ask for an administrator's \
         name and password there.",
        grant.name
    )
}

/// What to do when the person didn't turn it on in time.
pub fn not_yet(grant: &Grant) -> String {
    format!(
        "fleetd doesn't have {} yet. Turn it on in System Settings › Privacy & Security › {}, then Test in Settings › \
         Hub › Setup › A Mac for agents.",
        grant.name, grant.name
    )
}

/// Opens the grant's pane at the Mac. Only on macOS: elsewhere `open` is another program.
pub fn open_pane(grant: &Grant) {
    if cfg!(target_os = "macos") {
        let _ = std::process::Command::new("open")
            .arg(grant.pane)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Waits until the node has the grant, for up to `wait`; whether it has.
pub async fn wait_for_grant(node_home: &Path, id: MacCheckId, wait: Duration) -> bool {
    let until = tokio::time::Instant::now() + wait;
    loop {
        if grants(node_home)
            .iter()
            .any(|g| g.id == id && g.granted == Some(true))
        {
            return true;
        }
        if tokio::time::Instant::now() >= until {
            return false;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// The node's checks, once it wrote them after `since` with both grants passing, for up to `wait`; else the last it
/// wrote, if any.
pub async fn wait_for_checks(
    node_home: &Path,
    since: SystemTime,
    wait: Duration,
) -> Option<MacHealth> {
    let until = tokio::time::Instant::now() + wait;
    loop {
        let read = read_health(node_home);
        if let Some((health, written)) = &read
            && *written >= since
            && GRANTS.iter().all(|id| {
                health
                    .checks
                    .iter()
                    .any(|c| c.id == *id && c.state == MacCheckState::Ok)
            })
        {
            return Some(health.clone());
        }
        if tokio::time::Instant::now() >= until {
            return read.map(|(health, _)| health);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// The checks that want something done: failing or unknown. A warning (a GUI session behind someone else's) passes.
pub fn open_checks(health: &MacHealth) -> Vec<&MacCheck> {
    health
        .checks
        .iter()
        .filter(|c| !matches!(c.state, MacCheckState::Ok | MacCheckState::Warn))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::agents_mac::health_file;
    use fleetd_contracts::prim::{List, Text};

    fn write(home: &Path, health: &MacHealth) {
        std::fs::write(health_file(home), serde_json::to_vec(health).unwrap()).unwrap();
    }

    fn health(screen: MacCheckState) -> MacHealth {
        let check = |id, state| MacCheck {
            id,
            state,
            message: Text::unchecked("said"),
            fix: None,
            command: None,
        };
        MacHealth {
            user: Text::unchecked("ada"),
            checks: List::unchecked(vec![
                check(MacCheckId::Accessibility, MacCheckState::Ok),
                check(MacCheckId::ScreenRecording, screen),
                check(MacCheckId::GuiSession, MacCheckState::Warn),
                check(MacCheckId::Xcode, MacCheckState::Fail),
            ]),
        }
    }

    #[test]
    fn each_grant_says_its_pane_and_what_the_node_has() {
        let home = tempfile::tempdir().unwrap();
        let before = grants(home.path());
        assert_eq!(
            before.iter().map(|g| g.name).collect::<Vec<_>>(),
            ["Accessibility", "Screen Recording"]
        );
        assert!(before.iter().all(|g| g.granted.is_none()));
        assert!(before[1].pane.ends_with("Privacy_ScreenCapture"));
        assert!(
            ask(&before[0])
                .starts_with("In System Settings › Privacy & Security › Accessibility (open now)")
        );
        write(home.path(), &health(MacCheckState::Fail));
        let now = grants(home.path());
        assert_eq!((now[0].granted, now[1].granted), (Some(true), Some(false)));
    }

    #[tokio::test]
    async fn waits_for_a_grant_and_gives_up_in_time() {
        let home = tempfile::tempdir().unwrap();
        write(home.path(), &health(MacCheckState::Fail));
        let short = Duration::from_millis(10);
        assert!(wait_for_grant(home.path(), MacCheckId::Accessibility, short).await);
        assert!(!wait_for_grant(home.path(), MacCheckId::ScreenRecording, short).await);
    }

    /// The checks count once the node wrote them after the grants, with both grants passing; until then the last ones.
    #[tokio::test]
    async fn the_checks_count_once_the_restarted_node_has_both_grants() {
        let home = tempfile::tempdir().unwrap();
        let short = Duration::from_millis(10);
        assert_eq!(
            wait_for_checks(home.path(), SystemTime::UNIX_EPOCH, short).await,
            None
        );
        let write = |h: &MacHealth| write(home.path(), h);
        write(&health(MacCheckState::Fail));
        let last = wait_for_checks(home.path(), SystemTime::UNIX_EPOCH, short)
            .await
            .unwrap();
        assert_eq!(
            last,
            health(MacCheckState::Fail),
            "not yet: the last checks"
        );
        write(&health(MacCheckState::Ok));
        let done = wait_for_checks(home.path(), SystemTime::UNIX_EPOCH, short)
            .await
            .unwrap();
        assert_eq!(done, health(MacCheckState::Ok));
        // Written before the grants: not counted, though they pass.
        let later = SystemTime::now() + Duration::from_secs(60);
        let stale = wait_for_checks(home.path(), later, short).await.unwrap();
        assert_eq!(stale, health(MacCheckState::Ok));
        // Only the failing check wants anything; the warning passes.
        let open: Vec<_> = open_checks(&done).iter().map(|c| c.id).collect();
        assert_eq!(open, [MacCheckId::Xcode]);
    }
}
