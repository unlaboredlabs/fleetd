//! The update's ports over the running hub: the release feed, this machine's binary and service, and the nodes.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use fleetd_contracts::events::HubEventType;
use fleetd_contracts::ids::{MachineId, Timestamp};
use fleetd_contracts::mcp::{HubUpdateData, HubUpdatePhase, UpdateState};
use fleetd_contracts::node_link::{
    CAP_CLAUDE_INSTALL, CAP_SELF_UPDATE, CAP_UPDATE_FETCH, CAP_UPDATE_HOLD, NodeActionResult,
    NodeUpdate,
};

use super::{Held, NodeAnswer, NodeFacts, Refusal, UpdatePorts};
use crate::hub::api::Hub;
use crate::update::finish::{self, Plan};
use crate::update::service::{self, Service};
use crate::update::{BoxFuture, Channel, Feed, HttpFeed};

pub struct HubPorts(pub Weak<Hub>);

/// Where the watcher asks `/healthz`: the listen address on loopback when it is every interface, an IPv6 address in
/// brackets (doctor's own URL).
pub fn health_url(host: &str, port: u16) -> String {
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    crate::hub::doctor::service::self_url(host, port)
}

impl HubPorts {
    fn hub(&self) -> Option<Arc<Hub>> {
        self.0.upgrade()
    }
}

impl UpdatePorts for HubPorts {
    fn feed(&self, channel: Channel) -> Arc<dyn Feed> {
        Arc::new(HttpFeed::new(channel.base_url()))
    }

    fn running(&self) -> String {
        crate::version().to_owned()
    }

    fn release_build(&self) -> bool {
        option_env!("FLEETD_VERSION").is_some()
    }

    fn exe(&self) -> std::io::Result<PathBuf> {
        crate::update::installed_exe()
    }

    fn asset(&self) -> Result<String, String> {
        crate::update::cli_asset()
    }

    fn hub_service(&self, exe: &Path) -> Option<Service> {
        service::services(exe).into_iter().find(Service::hub)
    }

    fn previous(&self) -> std::io::Result<Vec<u8>> {
        crate::update::running_binary()
    }

    fn health_url(&self) -> String {
        match self.hub() {
            Some(hub) => health_url(&hub.config.listen.host, hub.config.listen.port),
            None => health_url("", 4790),
        }
    }

    fn start_watcher(&self, plan: &Plan, plan_path: &Path) -> Result<(), String> {
        finish::start(plan, plan_path)
    }

    fn nodes(&self) -> Vec<NodeFacts> {
        let Some(hub) = self.hub() else {
            return Vec::new();
        };
        hub.store
            .machines_list()
            .unwrap_or_default()
            .into_iter()
            .map(|m| NodeFacts {
                live_since: hub.executors.live_since(&m.machine_id),
                can_update: hub.link.node_can(&m.machine_id, CAP_SELF_UPDATE),
                can_fetch: hub.link.node_can(&m.machine_id, CAP_UPDATE_FETCH),
                can_hold: hub.link.node_can(&m.machine_id, CAP_UPDATE_HOLD),
                can_install_claude: hub.link.node_can(&m.machine_id, CAP_CLAUDE_INSTALL),
                agents_mac: hub
                    .link
                    .node_can(&m.machine_id, fleetd_contracts::node_link::CAP_AGENTS_MAC),
                claude: hub
                    .executors
                    .cached_runner(&m.machine_id)
                    .and_then(|r| r.version),
                busy: busy(&hub, &m.machine_id),
                machine_id: m.machine_id,
                name: m.name,
                version: m.node_version,
            })
            .collect()
    }

    fn fetch_on_node(&self, machine_id: &MachineId, update: &NodeUpdate) {
        let Some(hub) = self.hub() else { return };
        let (machine_id, update) = (machine_id.clone(), update.clone());
        tokio::spawn(async move {
            if let Err(e) = hub.node_commands.fetch_update(&machine_id, &update).await {
                tracing::info!(%machine_id, "update: the node didn't take the fetch: {}", e.message);
            }
        });
    }

    fn claude_target(&self) -> String {
        crate::node::runner::claude::install::target().to_owned()
    }

    fn install_claude<'a>(
        &'a self,
        machine_id: &'a MachineId,
        version: &'a str,
    ) -> BoxFuture<'a, Result<NodeActionResult, String>> {
        Box::pin(async move {
            let hub = self.hub().ok_or("the hub is stopping")?;
            hub.node_commands
                .install_claude(machine_id, version)
                .await
                .map_err(|e| e.message)
        })
    }

    fn hold_node<'a>(
        &'a self,
        machine_id: &'a MachineId,
        unhosted: bool,
    ) -> BoxFuture<'a, Result<Held, String>> {
        Box::pin(async move {
            let hub = self.hub().ok_or("the hub is stopping")?;
            let answer = hub
                .node_commands
                .hold_node(machine_id, unhosted)
                .await
                .map_err(|e| e.message)?;
            Ok(Held {
                steps: answer.steps.unwrap_or(0),
                hosted: answer.hosted,
            })
        })
    }

    fn node_changed(&self, machine_id: &MachineId) -> BoxFuture<'static, ()> {
        let Some(hub) = self.hub() else {
            return Box::pin(std::future::pending());
        };
        let mut live = hub.executors.live_watch(machine_id);
        Box::pin(async move {
            if live.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        })
    }

    fn update_node<'a>(
        &'a self,
        machine_id: &'a MachineId,
        update: &'a NodeUpdate,
    ) -> BoxFuture<'a, Result<NodeAnswer, String>> {
        Box::pin(async move {
            let hub = self.hub().ok_or("the hub is stopping")?;
            let (result, refusal) = hub
                .node_commands
                .update_node(machine_id, update)
                .await
                .map_err(|e| e.message)?;
            Ok((result, Box::new(refusal) as Box<dyn Refusal>))
        })
    }

    fn announce(&self, update: &HubUpdateData) {
        let Some(hub) = self.hub() else { return };
        let to = update.to.as_ref().map(|t| crate::version_label(t.as_str()));
        let to = to.as_deref().unwrap_or("the newest build");
        let summary = match update.state {
            HubUpdatePhase::Updating => {
                let restarting = update
                    .machines
                    .iter()
                    .filter(|m| m.state == UpdateState::Restarting)
                    .count();
                match (update.hub, restarting) {
                    (UpdateState::Restarting, _) => {
                        format!("Updating fleetd to {to}: the hub restarts")
                    }
                    (_, 0) => format!("Updating fleetd to {to}"),
                    (_, 1) => format!("Updating fleetd to {to}: 1 machine restarts"),
                    (_, n) => format!("Updating fleetd to {to}: {n} machines restart"),
                }
            }
            HubUpdatePhase::Updated => format!("Updated fleetd to {to}"),
            HubUpdatePhase::PutBack => format!(
                "fleetd {to} didn't come up healthy, so {} was put back",
                crate::version_label(update.from.as_str())
            ),
            HubUpdatePhase::Current => format!("fleetd already runs {to}"),
            _ => "fleetd didn't update".to_owned(),
        };
        let event = crate::hub::store::NewEvent {
            at: Timestamp(crate::hub::store::iso_ms(crate::hub::store::now_ms(
                hub.clock.as_ref(),
            ))),
            r#type: HubEventType::HubUpdate,
            machine_id: None,
            project_id: None,
            thread_id: None,
            summary,
            data: serde_json::to_value(update).ok(),
            attention: None,
        };
        if let Err(error) = hub.events.append(event) {
            tracing::warn!("hub.update: {error}");
        }
    }
}

/// What runs on the machine that its node's restart would end: live sessions (a browser, a device, a desktop), the
/// approved commands running there, and the checks and regenerations the hub runs there (the train's `cmd_check`s).
/// Agents' runs carry on by themselves, so they aren't in it.
fn busy(hub: &Hub, machine_id: &MachineId) -> Option<String> {
    let now = crate::hub::store::now_ms(hub.clock.as_ref());
    let sessions = hub
        .db
        .with(|c| crate::hub::machine_roles::live_on(c, machine_id, now))
        .unwrap_or(0);
    let (checks, approved) = hub.node_commands.running(machine_id);
    busy_words(usize::try_from(sessions).unwrap_or(0), approved, checks)
}

/// [`busy`] in words: "1 live session and 2 approved commands"; None when nothing runs.
pub(super) fn busy_words(sessions: usize, approved: usize, checks: usize) -> Option<String> {
    let count = |n: usize, one: &str, many: &str| match n {
        0 => None,
        1 => Some(format!("1 {one}")),
        n => Some(format!("{n} {many}")),
    };
    let words: Vec<String> = [
        count(sessions, "live session", "live sessions"),
        count(approved, "approved command", "approved commands"),
        count(checks, "check", "checks"),
    ]
    .into_iter()
    .flatten()
    .collect();
    (!words.is_empty()).then(|| words.join(" and "))
}

impl Refusal for crate::hub::link::commands::Refusal {
    fn try_take(&mut self) -> Option<NodeActionResult> {
        Self::try_take(self)
    }
}

#[cfg(test)]
mod tests {
    use super::health_url;

    #[test]
    fn the_health_check_reaches_the_hub_on_any_listen_address() {
        assert_eq!(health_url("0.0.0.0", 4790), "http://127.0.0.1:4790");
        assert_eq!(health_url("100.104.0.7", 4790), "http://100.104.0.7:4790");
        assert_eq!(health_url("fd00::1", 4790), "http://[fd00::1]:4790");
        assert_eq!(health_url("[fd00::1]", 4790), "http://[fd00::1]:4790");
        assert_eq!(health_url("::", 4790), "http://[::1]:4790");
        assert_eq!(health_url("[::]", 4790), "http://[::1]:4790");
    }
}
