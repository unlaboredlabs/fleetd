//! The node takes up a new privacy grant by itself. macOS gives a running process a Screen Recording grant only once it
//! starts again, so the person used to restart the node by hand after turning fleetd on. Each check, the node asks a
//! fresh process of its own binary (`fleetd node grants`, which macOS answers as it would a new node) and, when that one
//! has a grant the node lacks, has launchd restart it: at most once for each answer, so a grant macOS never shows the
//! running node can't make it restart again and again.
//!
//! The node is also the one that asks macOS for a grant, so fleetd (not Terminal or the app) is what lands in System
//! Settings' list: setup's grant step writes [`ask_file`] and the node asks within 2 s ([`answer`]). Only then: a grant
//! an update lost ([`lost`]) is said by its check, whose fix asks, as a node asking by itself at each start would show
//! macOS's prompt again and again.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use fleetd_contracts::node_link::{MacCheckId, MacHealth};

/// Accessibility and Screen Recording, as one process reads them: None where macOS can't be asked.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Grants {
    pub accessibility: Option<bool>,
    pub screen_recording: Option<bool>,
}

fn word(grant: Option<bool>) -> &'static str {
    match grant {
        Some(true) => "yes",
        Some(false) => "no",
        None => "unknown",
    }
}

impl Grants {
    /// This process's, as macOS gave them to it.
    pub fn own() -> Self {
        Grants {
            accessibility: super::tcc::accessibility(),
            screen_recording: super::tcc::screen_recording(),
        }
    }

    /// What `fleetd node grants` prints, and [`Grants::parse`] reads.
    pub fn line(self) -> String {
        format!(
            "accessibility {} screen_recording {}",
            word(self.accessibility),
            word(self.screen_recording)
        )
    }

    pub fn parse(line: &str) -> Option<Self> {
        let read = |w: &str| match w {
            "yes" => Some(Some(true)),
            "no" => Some(Some(false)),
            "unknown" => Some(None),
            _ => None,
        };
        match line.split_whitespace().collect::<Vec<_>>().as_slice() {
            ["accessibility", a, "screen_recording", s] => Some(Grants {
                accessibility: read(a)?,
                screen_recording: read(s)?,
            }),
            _ => None,
        }
    }
}

/// What a fresh process found: its grants, and those an update took away ([`lost`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fresh {
    pub grants: Grants,
    pub lost: Vec<MacCheckId>,
}

/// The grant checks of `health` as a fresh process found them: what macOS has granted the node.
pub fn overlay(health: &mut MacHealth, fresh: &Fresh) {
    let checks = health
        .checks
        .iter()
        .map(|c| match c.id {
            id if fresh.lost.contains(&id) => super::checks::lost_grant(id),
            MacCheckId::Accessibility => super::checks::grant(c.id, fresh.grants.accessibility),
            MacCheckId::ScreenRecording => {
                super::checks::grant(c.id, fresh.grants.screen_recording)
            }
            _ => c.clone(),
        })
        .collect();
    health.checks = fleetd_contracts::prim::List::unchecked(checks);
}

/// Whether the node restarts for the grants a fresh process has (`fresh`): one it lacks itself (`own`), unless it
/// restarted for this same answer before (`last`, the [`Grants::line`] it wrote then). The line to keep when it does.
pub fn restart_for(own: Grants, fresh: Grants, last: Option<&str>) -> Option<String> {
    let gained = |own: Option<bool>, fresh: Option<bool>| fresh == Some(true) && own != Some(true);
    let line = fresh.line();
    ((gained(own.accessibility, fresh.accessibility)
        || gained(own.screen_recording, fresh.screen_recording))
        && last != Some(line.as_str()))
    .then_some(line)
}

/// Whether the node forgets the answer it last restarted for (`last`): a fresh process now says otherwise (a grant
/// turned off, or lost with an update), so the grant turned on again restarts it again.
pub fn forgets(fresh: Grants, last: Option<&str>) -> bool {
    last.is_some_and(|l| l != fresh.line())
}

/// Where the node writes the answer it last restarted for.
fn marker(home: &Path) -> PathBuf {
    super::tools_dir(home).join("restarted-for-grants")
}

/// Where the node writes what it last saw: its version, then the grants a fresh process had ([`Grants::line`]), to
/// tell an update that lost a grant.
fn seen_file(home: &Path) -> PathBuf {
    super::tools_dir(home).join("grants-seen")
}

/// What the node last saw, as [`seen_file`] holds it: the version, and the grants under it.
pub fn parse_seen(text: &str) -> Option<(String, Grants)> {
    let (version, line) = text.trim().split_once('\n')?;
    Some((version.trim().to_owned(), Grants::parse(line.trim())?))
}

fn seen(home: &Path) -> Option<(String, Grants)> {
    parse_seen(&std::fs::read_to_string(seen_file(home)).ok()?)
}

/// The grants an update lost: on when the node last looked, under another version (`seen`), off now under `version`.
/// Release signing keeps fleetd's identity across updates, so this is a build signed otherwise (one built locally). A
/// grant already off before the update (turned off, or macOS's periodic ask not answered) isn't one, nor one turned
/// off under the same version: the plain check says those.
pub fn lost(grants: Grants, seen: Option<&(String, Grants)>, version: &str) -> Vec<MacCheckId> {
    let Some((_, before)) = seen.filter(|(was, _)| was != version) else {
        return Vec::new();
    };
    [
        (
            MacCheckId::Accessibility,
            before.accessibility,
            grants.accessibility,
        ),
        (
            MacCheckId::ScreenRecording,
            before.screen_recording,
            grants.screen_recording,
        ),
    ]
    .into_iter()
    .filter(|(_, before, now)| *before == Some(true) && *now == Some(false))
    .map(|(id, _, _)| id)
    .collect()
}

/// Notes what a fresh process had under this version, unless a grant is lost: then what the node saw before the update
/// stays, so the check keeps saying so until the grant is back.
fn note_seen(home: &Path, grants: Grants, lost: &[MacCheckId]) {
    let text = format!("{}\n{}", crate::version(), grants.line());
    if lost.is_empty()
        && std::fs::read_to_string(seen_file(home)).ok().as_deref() != Some(text.as_str())
    {
        let _ = std::fs::create_dir_all(super::tools_dir(home))
            .and_then(|()| std::fs::write(seen_file(home), text));
    }
}

/// Where setup asks the node to ask macOS for a grant: the grant's id (`accessibility`, `screen_recording`), which
/// the node removes once it asked.
pub fn ask_file(home: &Path) -> PathBuf {
    home.join("mac-grant-ask")
}

/// Setup's half: asks the node at `home` to ask macOS for `id`.
pub fn request(home: &Path, id: MacCheckId) -> std::io::Result<()> {
    let tmp = home.join("mac-grant-ask.tmp");
    std::fs::write(&tmp, id.as_str()).and_then(|()| std::fs::rename(&tmp, ask_file(home)))
}

/// The grant [`ask_file`] names, if it names one.
pub fn asked(text: &str) -> Option<MacCheckId> {
    super::GRANTS
        .into_iter()
        .find(|id| id.as_str() == text.trim())
}

/// The node's half: asks macOS for the grant setup asked for, if it did, and removes the ask.
pub fn answer(home: &Path) {
    let Ok(text) = std::fs::read_to_string(ask_file(home)) else {
        return;
    };
    let _ = std::fs::remove_file(ask_file(home));
    if let Some(id) = asked(&text) {
        tracing::info!(
            "the agents' Mac asks macOS for {}, as setup asked",
            id.as_str()
        );
        super::tcc::ask(id);
    }
}

/// How often the node asks again: often while a grant is missing (the person is at System Settings), else at the
/// pace of the other checks.
pub fn every(fresh: Option<Grants>) -> std::time::Duration {
    let both =
        fresh.is_some_and(|g| g.accessibility == Some(true) && g.screen_recording == Some(true));
    if both {
        super::CHECK_EVERY
    } else {
        std::time::Duration::from_secs(2)
    }
}

/// A fresh process's grants: `fleetd node grants`, run from this node's own binary.
fn fresh() -> Option<Grants> {
    let exe = std::env::current_exe().ok()?;
    let out = Command::new(exe)
        .args(["node", "grants"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    Grants::parse(String::from_utf8_lossy(&out.stdout).trim())
}

/// Asks a fresh process for its grants, and has launchd restart the node when that process holds a grant the node
/// lacks (`fleetd node restart`, outside the node's own process group, which launchd ends with it). The restart ends
/// the node's jobs, as any does; grants change only while the person sets the Mac up. What the fresh process had.
pub fn take_up(home: &Path) -> Option<Fresh> {
    let grants = fresh()?;
    let fresh = Fresh {
        grants,
        lost: lost(grants, seen(home).as_ref(), crate::version()),
    };
    note_seen(home, grants, &fresh.lost);
    let last = std::fs::read_to_string(marker(home)).ok();
    let last = last.as_deref().map(str::trim);
    let Some(line) = restart_for(Grants::own(), grants, last) else {
        if forgets(grants, last) {
            let _ = std::fs::remove_file(marker(home));
        }
        return Some(fresh);
    };
    if let Err(e) = std::fs::create_dir_all(super::tools_dir(home))
        .and_then(|()| std::fs::write(marker(home), &line))
    {
        tracing::warn!(
            "the agents' Mac can't note its restart for a new grant, so it doesn't restart: {e}"
        );
        return Some(fresh);
    }
    tracing::info!("the agents' Mac restarts its node to take up a new grant ({line})");
    let restart = std::env::current_exe()
        .map_err(|e| e.to_string())
        .and_then(|exe| crate::update::service::spawn_outside(&exe, &["node", "restart"]));
    if let Err(e) = restart {
        tracing::warn!("the agents' Mac couldn't restart its node for a new grant: {e}");
    }
    Some(fresh)
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn g(accessibility: Option<bool>, screen_recording: Option<bool>) -> Grants {
        Grants {
            accessibility,
            screen_recording,
        }
    }

    #[test]
    fn asks_often_only_while_a_grant_is_missing() {
        assert_eq!(
            every(Some(g(Some(true), Some(true)))),
            crate::node::agents_mac::CHECK_EVERY
        );
        assert_eq!(every(Some(g(Some(true), Some(false)))).as_secs(), 2);
        assert_eq!(every(None).as_secs(), 2);
    }

    /// The heartbeat and mac-health.json say what macOS has granted, not what the running node read at its start.
    #[test]
    fn the_grant_checks_say_what_a_fresh_process_has() {
        use fleetd_contracts::node_link::MacCheckState;
        let mut health = crate::node::agents_mac::health(
            "ada",
            vec![
                super::super::checks::grant(MacCheckId::Accessibility, Some(true)),
                super::super::checks::grant(MacCheckId::ScreenRecording, Some(false)),
                super::super::checks::keep_awake(Ok(())),
            ],
        );
        overlay(
            &mut health,
            &Fresh {
                grants: g(Some(true), Some(true)),
                lost: Vec::new(),
            },
        );
        let states: Vec<_> = health.checks.iter().map(|c| (c.id, c.state)).collect();
        assert_eq!(
            states,
            [
                (MacCheckId::Accessibility, MacCheckState::Ok),
                (MacCheckId::ScreenRecording, MacCheckState::Ok),
                (MacCheckId::KeepAwake, MacCheckState::Ok),
            ]
        );
    }

    /// A grant on when the node last looked, under another version, and off now is one an update lost; one already off
    /// before the update, or off under the same version, or nothing seen yet, is the plain missing grant.
    #[test]
    fn a_grant_on_before_an_update_and_off_after_is_lost() {
        let (yes, no) = (Some(true), Some(false));
        let seen = |v: &str, grants| Some((v.to_owned(), grants));
        assert_eq!(
            lost(g(yes, no), seen("0.4.0", g(yes, yes)).as_ref(), "0.4.1"),
            [MacCheckId::ScreenRecording]
        );
        assert_eq!(
            lost(g(no, no), seen("0.4.0", g(yes, yes)).as_ref(), "0.4.1"),
            [MacCheckId::Accessibility, MacCheckId::ScreenRecording]
        );
        // Turned off (or its periodic ask unanswered) before the update: not the update's doing.
        assert!(lost(g(yes, no), seen("0.4.0", g(yes, no)).as_ref(), "0.4.1").is_empty());
        assert!(lost(g(yes, no), seen("0.4.1", g(yes, yes)).as_ref(), "0.4.1").is_empty());
        assert!(lost(g(no, no), None, "0.4.1").is_empty());
        assert!(
            lost(g(None, None), seen("0.4.0", g(yes, yes)).as_ref(), "0.4.1").is_empty(),
            "can't be asked"
        );
        let text = format!("0.4.0\n{}", g(yes, no).line());
        assert_eq!(parse_seen(&text), Some(("0.4.0".to_owned(), g(yes, no))));
        assert_eq!(parse_seen("0.4.0"), None);
    }

    /// While a grant is lost, what the node saw before the update stays, so the check keeps saying so; once it's back,
    /// the node notes the new version.
    #[test]
    fn a_lost_grant_stays_lost_until_it_is_back() {
        let home = tempfile::tempdir().unwrap();
        let (yes, no) = (Some(true), Some(false));
        std::fs::create_dir_all(crate::node::agents_mac::tools_dir(home.path())).unwrap();
        std::fs::write(
            seen_file(home.path()),
            format!("0.0.0-old\n{}", g(yes, yes).line()),
        )
        .unwrap();
        let now = g(yes, no);
        let first = lost(now, seen(home.path()).as_ref(), crate::version());
        assert_eq!(first, [MacCheckId::ScreenRecording]);
        note_seen(home.path(), now, &first);
        assert_eq!(
            lost(now, seen(home.path()).as_ref(), crate::version()),
            first
        );
        note_seen(home.path(), g(yes, yes), &[]);
        assert_eq!(
            seen(home.path()),
            Some((crate::version().to_owned(), g(yes, yes)))
        );
    }

    /// The lost grant's check says the update took it; the others read as before.
    #[test]
    fn a_lost_grant_says_the_update_took_it() {
        let mut health = crate::node::agents_mac::health(
            "ada",
            vec![
                super::super::checks::grant(MacCheckId::Accessibility, Some(true)),
                super::super::checks::grant(MacCheckId::ScreenRecording, Some(true)),
            ],
        );
        let fresh = Fresh {
            grants: g(Some(true), Some(false)),
            lost: vec![MacCheckId::ScreenRecording],
        };
        overlay(&mut health, &fresh);
        let sr = &health.checks[1];
        assert_eq!(sr.state, fleetd_contracts::node_link::MacCheckState::Fail);
        assert!(sr.message.as_str().contains("update"), "{}", sr.message);
        assert!(
            sr.command
                .as_ref()
                .is_some_and(|c| c.as_str().contains("--ask screen_recording")),
            "{:?}",
            sr.command
        );
    }

    /// Setup's ask names one grant; anything else asks nothing.
    #[test]
    fn the_ask_names_a_grant() {
        let home = tempfile::tempdir().unwrap();
        request(home.path(), MacCheckId::ScreenRecording).unwrap();
        let text = std::fs::read_to_string(ask_file(home.path())).unwrap();
        assert_eq!(asked(&text), Some(MacCheckId::ScreenRecording));
        assert_eq!(asked("accessibility\n"), Some(MacCheckId::Accessibility));
        assert_eq!(asked("xcode"), None);
        answer(home.path());
        assert!(!ask_file(home.path()).exists(), "taken");
    }

    #[test]
    fn the_line_reads_back() {
        for grants in [
            g(Some(true), Some(false)),
            g(None, Some(true)),
            g(Some(false), None),
        ] {
            assert_eq!(Grants::parse(&grants.line()), Some(grants));
        }
        assert_eq!(
            Grants::parse("accessibility maybe screen_recording yes"),
            None
        );
        assert_eq!(Grants::parse(""), None);
    }

    /// A restart when a fresh process has a grant the node lacks; never for one it has, one taken away, or one macOS
    /// can't be asked about; and once only for each answer.
    #[test]
    fn restarts_once_for_a_grant_the_running_node_lacks() {
        let (yes, no) = (Some(true), Some(false));
        // Screen Recording turned on: the running node still reads it off.
        let line = restart_for(g(yes, no), g(yes, yes), None).unwrap();
        assert_eq!(line, "accessibility yes screen_recording yes");
        // Restarted, and the new node has it: nothing more.
        assert_eq!(restart_for(g(yes, yes), g(yes, yes), Some(&line)), None);
        // Restarted, but macOS still shows the running node without it: no second restart for the same answer.
        assert_eq!(restart_for(g(yes, no), g(yes, yes), Some(&line)), None);
        // Accessibility on too, later: a new answer, one more restart.
        assert!(
            restart_for(
                g(no, no),
                g(yes, no),
                Some("accessibility no screen_recording no")
            )
            .is_some()
        );
        assert_eq!(restart_for(g(no, no), g(no, no), None), None);
        assert_eq!(
            restart_for(g(yes, yes), g(no, yes), None),
            None,
            "taken away"
        );
        assert_eq!(restart_for(g(None, None), g(None, None), None), None);
    }

    /// Turned off (or lost with an update) after a restart for it: the answer it restarted for is forgotten, so the
    /// grant turned on again restarts the node again.
    #[test]
    fn forgets_the_restart_once_a_grant_goes() {
        let (yes, no) = (Some(true), Some(false));
        let line = g(yes, yes).line();
        assert!(forgets(g(yes, no), Some(&line)));
        assert!(!forgets(g(yes, yes), Some(&line)));
        assert!(!forgets(g(yes, no), None));
        let after = restart_for(g(yes, no), g(yes, yes), None);
        assert_eq!(after.as_deref(), Some(line.as_str()));
    }
}
