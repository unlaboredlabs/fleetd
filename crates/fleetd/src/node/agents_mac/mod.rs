//! The agents' Mac (D298, docs: agents-mac.md): a Mac whose node runs in the account logged in at its screen (the
//! person's own, an admin's included, or a user set aside for agents: D309), joined with the installer's `--mac`, which
//! sets node.json's `agentsMac` (no screen switch does). It is a tool every project's agents use from their own machines,
//! never a runner:
//!
//! - it runs no claude, no lead, no task and no Navi: [`session_call_allowed`] refuses every session call but the few
//!   a hub sends any machine, and the lead socket relays no lead call (lead.rs);
//! - it takes no sealed secret (a Claude account, an API key, a 1Password token, an MCP server's, a project's or
//!   order's variable, a browser fill) and runs no gated command: [`TOOL_ONLY`];
//! - its hello lists only the calls a tool needs ([`capabilities`]), with [`CAP_AGENTS_MAC`] whatever its checks say,
//!   so the hub keeps its agents role off and clients seal nothing to it.
//!
//! The node checks the Mac's setup as its own user (checks.rs), takes up a new privacy grant by restarting (grants.rs), holds a keep-awake assertion for as
//! long as it runs, and installs the pinned Node.js and agent-desktop beside agent-device (tools.rs). Where Xcode is, and the
//! one command that selects it, is xcode.rs.
pub mod checks;
pub mod grants;
pub mod tools;
pub mod xcode;

#[cfg(target_os = "macos")]
mod tcc;
/// Elsewhere macOS can't be asked.
#[cfg(not(target_os = "macos"))]
mod tcc {
    pub fn accessibility() -> Option<bool> {
        None
    }
    pub fn screen_recording() -> Option<bool> {
        None
    }
    pub fn ask(_: fleetd_contracts::node_link::MacCheckId) {}
}

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::config::NodeConfig;
use fleetd_contracts::node_link::{
    CAP_AGENTS_MAC, CAP_BROWSER, CAP_BUILD_BUN, CAP_BUILD_RUST, CAP_LINK_DEFLATE, CAP_MAC_TOOL,
    CAP_PROJECT_SETTINGS, CAP_SCREEN_SETTINGS, CAP_SELF_UPDATE, CAP_SESSION_END, CAP_SESSION_HOST,
    CAP_SESSION_IOS, CAP_SESSION_SEAL, CAP_UPDATE_FETCH, CAP_UPDATE_HOLD, MacCheckId, MacHealth,
};
use fleetd_contracts::prim::{List, Text};
use fleetd_contracts::sessions::SessionCall;

/// What the agents' Mac answers the hub for everything it doesn't do: it is a tool, never a runner. Read in the app,
/// so it names the Mac; a person typing `fleetd` on the Mac gets lead.rs's own answer.
pub const TOOL_ONLY: &str = "the agents' Mac is a tool for agents on other machines: it runs no session, claude or \
     secret itself";

/// Whether this node is the agents' Mac. On any OS: a node.json that says so keeps the node a tool, though only macOS
/// gives agents a tool there.
pub fn is_agents_mac(config: &NodeConfig) -> bool {
    config.agents_mac == Some(true)
}

/// Whether this user may join as the agents' Mac: on macOS, in any account (an admin's too, D309). The installer's
/// `--mac` asks the same first.
pub fn may_join() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err(
            "--mac is for the agents' Mac: run it on a Mac, logged in at its screen".into(),
        );
    }
    Ok(())
}

/// node.json's `ios` as the node runs it. The agents' Mac lends agents iOS simulators (`mac sim`): with its tool on, it
/// makes its golden simulator whatever `enabled` says. A Mac that once turned iOS screens off (`"enabled": false`, from
/// before the iOS screen kind went) would otherwise keep `mac sim` off with no switch in the app to turn it on.
pub fn ios_config(
    config: Option<super::device::ios::IosConfig>,
    tool: bool,
) -> super::device::ios::IosConfig {
    let mut config = config.unwrap_or_default();
    if tool {
        config.enabled = Some(true);
    }
    config
}

/// The calls the agents' Mac lists at its hello: updates, screens it hosts for agents elsewhere, and a project's
/// removal (a project that lived on the Mac before it became the agents' Mac goes cleanly), and compressed link frames
/// ([`CAP_LINK_DEFLATE`]: its mac push/pull pieces are the link's largest). Nothing that carries a
/// secret, a claude or a Navi, which the hub then never sends. `others` are the session kinds the node found it can
/// host. `tool`: the Mac's tool is on (macOS),
/// so it lists [`CAP_MAC_TOOL`] too, once.
pub fn capabilities(others: impl IntoIterator<Item = String>, tool: bool) -> Vec<String> {
    const KEPT: [&str; 14] = [
        CAP_MAC_TOOL,
        CAP_BUILD_RUST,
        CAP_BUILD_BUN,
        CAP_SELF_UPDATE,
        CAP_UPDATE_FETCH,
        CAP_UPDATE_HOLD,
        CAP_PROJECT_SETTINGS,
        CAP_SCREEN_SETTINGS,
        CAP_SESSION_END,
        CAP_SESSION_HOST,
        CAP_SESSION_SEAL,
        CAP_BROWSER,
        CAP_SESSION_IOS,
        CAP_LINK_DEFLATE,
    ];
    let mut caps = vec![CAP_AGENTS_MAC.to_owned()];
    caps.extend(
        others
            .into_iter()
            .filter(|c| KEPT.contains(&c.as_str()) && c != CAP_MAC_TOOL),
    );
    if tool {
        caps.push(CAP_MAC_TOOL.to_owned());
    }
    caps
}

/// The session calls the agents' Mac answers: the runner's figures (the doctor asks every machine) and a project's
/// removal. An allowlist: a call a newer hub adds is refused until it is named here.
pub fn session_call_allowed(call: &SessionCall) -> bool {
    matches!(
        call,
        SessionCall::RunnerInfo | SessionCall::ProjectRemove { .. }
    )
}

/// What a person runs in the node's account to restart it, which [`grants::take_up`] runs itself for a new grant.
/// `fleetd node restart` does the same for any node service.
pub const RESTART_NODE: &str = "launchctl kickstart -k gui/$(id -u)/sh.fleetd.node";

/// The two privacy grants, in the order setup asks for them.
pub const GRANTS: [MacCheckId; 2] = [MacCheckId::Accessibility, MacCheckId::ScreenRecording];

/// How often the node checks the Mac's setup again.
pub const CHECK_EVERY: Duration = Duration::from_secs(30);

/// The Mac's setup as last checked, for the heartbeat, and what the node holds for it while it runs.
#[derive(Clone, Default)]
pub struct AgentsMac {
    health: Arc<Mutex<Option<MacHealth>>>,
    /// What a fresh process of the node was granted last (grants.rs): the grant checks say this, not the running
    /// process's own reads, which macOS updates only once it starts again.
    fresh: Arc<Mutex<Option<grants::Fresh>>>,
    /// Its tool is on, as the node found at its start: its hello lists `mac_tool`.
    tool: bool,
}

impl AgentsMac {
    pub fn tool(&self) -> bool {
        self.tool
    }

    pub fn health(&self) -> Option<MacHealth> {
        self.health
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Holds `health`, with the grants a fresh process found, for the heartbeat and in [`health_file`] for setup.
    fn publish(&self, home: &Path, mut health: MacHealth) {
        if let Some(fresh) = &*self
            .fresh
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            grants::overlay(&mut health, fresh);
        }
        write_health(home, &health);
        *self
            .health
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(health);
    }

    /// Holds the keep-awake assertion, installs the pinned tools, and checks the setup every [`CHECK_EVERY`] until
    /// dropped. Asks macOS for a grant when setup asks it to (so fleetd is in that list of System Settings) and again
    /// for one an update lost, and restarts the node once a fresh process has a grant it lacks (grants.rs).
    pub fn start(home: &Path, tool: bool) -> (Self, super::util::AbortOnDrop) {
        let mac = Self {
            tool,
            ..Self::default()
        };
        let home = home.to_owned();
        let running = mac.clone();
        let task = tokio::spawn(async move {
            let awake = super::power::inhibit::take("fleetd: the agents' Mac stays awake")
                .await
                .map_err(|e| {
                    tracing::warn!("the agents' Mac can't hold its keep-awake assertion: {e}");
                    e
                });
            // A new grant is taken up within seconds while the person is at System Settings (grants.rs).
            if cfg!(target_os = "macos") {
                let (home, running) = (home.clone(), running.clone());
                tokio::spawn(async move {
                    loop {
                        let h = home.clone();
                        let fresh = tokio::task::spawn_blocking(move || {
                            grants::answer(&h);
                            grants::take_up(&h)
                        })
                        .await
                        .ok()
                        .flatten();
                        let every = grants::every(fresh.as_ref().map(|f| f.grants));
                        if fresh.is_some() {
                            *running
                                .fresh
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) = fresh;
                            if let Some(health) = running.health() {
                                running.publish(&home, health);
                            }
                        }
                        tokio::time::sleep(every).await;
                    }
                });
            }
            let tools = tools::Installing::default();
            {
                let (home, tools) = (home.clone(), tools.clone());
                tokio::spawn(async move { tools.run(&home).await });
            }
            loop {
                let probe = checks::Live {
                    awake: awake.as_ref().map(|_| ()).map_err(Clone::clone),
                    tools: tools.state(),
                };
                if let Ok(health) = tokio::task::spawn_blocking(move || checks::run(&probe)).await {
                    running.publish(&home, health);
                    // A run of every check, not the grants alone republished: setup counts only these.
                    let _ = std::fs::write(checked_file(&home), b"");
                }
                tokio::time::sleep(CHECK_EVERY).await;
            }
        });
        (mac, super::util::AbortOnDrop(task))
    }
}

/// Where the node writes its last checks (the contracts' `MacHealth`), after each run and each new read of the grants,
/// for setup to read on the Mac itself ([`read_health`]): the app's "Set up this Mac for agents" and `fleetd init --mac`.
pub fn health_file(home: &Path) -> PathBuf {
    home.join("mac-health.json")
}

fn write_health(home: &Path, health: &MacHealth) {
    if let Ok(json) = serde_json::to_vec(health) {
        // Whole or not at all, for a reader polling it.
        let tmp = home.join("mac-health.json.tmp");
        let _ = std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, health_file(home)));
    }
}

/// Touched after each run of every check (not when the grants loop republishes [`health_file`]), so setup can wait for
/// one by the node as it runs now ([`last_full_check`]).
pub fn checked_file(home: &Path) -> PathBuf {
    home.join("mac-health.checked")
}

/// When the node at `home` last ran every check; None before its first.
pub fn last_full_check(home: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(checked_file(home))
        .and_then(|m| m.modified())
        .ok()
}

/// The node's last checks at `home`, and when it wrote them; None before its first.
pub fn read_health(home: &Path) -> Option<(MacHealth, std::time::SystemTime)> {
    let file = health_file(home);
    let written = std::fs::metadata(&file).and_then(|m| m.modified()).ok()?;
    let health = serde_json::from_slice(&std::fs::read(&file).ok()?).ok()?;
    Some((health, written))
}

/// The macOS user the node runs as.
pub fn user() -> String {
    std::env::var("USER")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

pub(crate) fn health(user: &str, checks: Vec<fleetd_contracts::node_link::MacCheck>) -> MacHealth {
    MacHealth {
        user: Text::unchecked(clip(user, 64)),
        checks: List::unchecked(checks),
    }
}

pub(crate) fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => text[..at].to_owned(),
        None => text.to_owned(),
    }
}

/// Where the node keeps the Mac's pinned tools.
pub fn tools_dir(home: &Path) -> PathBuf {
    home.join("mac")
}

#[cfg(test)]
mod tests;
