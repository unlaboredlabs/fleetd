//! The node takes up a new privacy grant by itself. macOS gives a running process a Screen Recording grant only once it
//! starts again, so the person used to restart the node by hand after turning fleetd on. Each check, the node asks a
//! fresh process of its own binary (`fleetd node grants`, which macOS answers as it would a new node) and, when that one
//! has a grant the node lacks, has launchd restart it: at most once for each answer, so a grant macOS never shows the
//! running node can't make it restart again and again.
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

/// The grant checks of `health` as a fresh process found them: what macOS has granted the node.
pub fn overlay(health: &mut MacHealth, fresh: Grants) {
    let checks = health
        .checks
        .iter()
        .map(|c| match c.id {
            MacCheckId::Accessibility => super::checks::grant(c.id, fresh.accessibility),
            MacCheckId::ScreenRecording => super::checks::grant(c.id, fresh.screen_recording),
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

/// Where the node writes the answer it last restarted for.
fn marker(home: &Path) -> PathBuf {
    super::tools_dir(home).join("restarted-for-grants")
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
pub fn take_up(home: &Path) -> Option<Grants> {
    let fresh = fresh()?;
    let last = std::fs::read_to_string(marker(home)).ok();
    let Some(line) = restart_for(Grants::own(), fresh, last.as_deref().map(str::trim)) else {
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
        overlay(&mut health, g(Some(true), Some(true)));
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
}
