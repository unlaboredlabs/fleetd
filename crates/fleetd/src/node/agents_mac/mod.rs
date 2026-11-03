//! The agents' Mac (D298, docs: agents-mac.md): a dedicated Mac whose node runs in a standard, non-admin user of its
//! own (`agents`), joined with the installer's `--mac`, which sets node.json's `agentsMac` (no screen switch does). It is a
//! tool every project's agents use from their own machines, never a runner:
//!
//! - it runs no claude, no lead, no task and no Navi: [`session_call_allowed`] refuses every session call but the few
//!   a hub sends any machine, and the lead socket relays no lead call (lead.rs);
//! - it takes no sealed secret (a Claude account, an API key, a 1Password token, an MCP server's, a project's or
//!   order's variable, a browser fill) and runs no gated command: [`TOOL_ONLY`];
//! - its hello lists only the calls a tool needs ([`capabilities`]), with [`CAP_AGENTS_MAC`] whatever its checks say,
//!   so the hub keeps its agents role off and clients seal nothing to it.
//!
//! The node checks the Mac's setup as its own user, with no admin (checks.rs), holds a keep-awake assertion for as
//! long as it runs, and installs the pinned Node.js and agent-desktop beside agent-device (tools.rs).
pub mod checks;
pub mod tools;

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
    pub fn ask_once() {}
}

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::config::NodeConfig;
use fleetd_contracts::node_link::{
    CAP_AGENTS_MAC, CAP_BROWSER, CAP_MAC_TOOL, CAP_PROJECT_SETTINGS, CAP_SCREEN_SETTINGS,
    CAP_SELF_UPDATE, CAP_SESSION_END, CAP_SESSION_HOST, CAP_SESSION_IOS, CAP_SESSION_SEAL,
    CAP_UPDATE_FETCH, CAP_UPDATE_HOLD, MacHealth,
};
use fleetd_contracts::prim::{List, Text};
use fleetd_contracts::sessions::SessionCall;

/// What the agents' Mac answers everything it doesn't do: it is a tool, never a runner.
pub const TOOL_ONLY: &str =
    "this Mac is a tool for agents elsewhere: run fleetd from your own machine";

/// Whether this node is the agents' Mac. On any OS: a node.json that says so keeps the node a tool, though only macOS
/// gives agents a tool there.
pub fn is_agents_mac(config: &NodeConfig) -> bool {
    config.agents_mac == Some(true)
}

/// Whether this user may join as the agents' Mac: on macOS, as a standard user that can't sudo. The installer's
/// `--mac` asks the same first.
pub fn may_join() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("--mac is for the agents' Mac: run it on a Mac, as its agents user".into());
    }
    super::mac_tool::admin_check().map_err(|why| {
        format!(
            "{why}. The agents' Mac's node runs as a standard user of its own, so agents never act as an admin: log \
             in as the `agents` user (the guide's first step makes it) and paste the join line there"
        )
    })
}

/// The calls the agents' Mac lists at its hello: updates, screens it hosts for agents elsewhere, and a project's
/// removal (a project that lived on the Mac before it moved into the agents user goes cleanly). Nothing that carries a
/// secret, a claude or a Navi, which the hub then never sends. `others` are the session kinds the node found it can
/// host. `tool`: the Mac's tool is on (macOS, and node/mac_tool's `admin_check` passes: a standard user that can't sudo),
/// so it lists [`CAP_MAC_TOOL`] too, once.
pub fn capabilities(others: impl IntoIterator<Item = String>, tool: bool) -> Vec<String> {
    const KEPT: [&str; 11] = [
        CAP_MAC_TOOL,
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

/// How often the node checks the Mac's setup again.
pub const CHECK_EVERY: Duration = Duration::from_secs(30);

/// The Mac's setup as last checked, for the heartbeat, and what the node holds for it while it runs.
#[derive(Clone, Default)]
pub struct AgentsMac {
    health: Arc<Mutex<Option<MacHealth>>>,
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

    fn set(&self, health: MacHealth) {
        *self
            .health
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(health);
    }

    /// Holds the keep-awake assertion, installs the pinned tools, and checks the setup every [`CHECK_EVERY`] until
    /// dropped. Asks once for the two grants the person then turns on in System Settings, so fleetd is in their lists.
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
            tcc::ask_once();
            let tools = tools::Installing::default();
            {
                let (home, tools) = (home.clone(), tools.clone());
                tokio::spawn(async move { tools.run(&home).await });
            }
            loop {
                let probe = checks::Live {
                    home: home.clone(),
                    awake: awake.as_ref().map(|_| ()).map_err(Clone::clone),
                    tools: tools.state(),
                };
                if let Ok(health) = tokio::task::spawn_blocking(move || checks::run(&probe)).await {
                    running.set(health);
                }
                tokio::time::sleep(CHECK_EVERY).await;
            }
        });
        (mac, super::util::AbortOnDrop(task))
    }
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
