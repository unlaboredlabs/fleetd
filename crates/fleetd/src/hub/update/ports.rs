//! The update's ports over the running hub: the release feed, this machine's binary and service, and the nodes.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::node_link::{
    CAP_SELF_UPDATE, CAP_UPDATE_FETCH, NodeActionResult, NodeUpdate,
};

use super::{NodeAnswer, NodeFacts, Refusal, UpdatePorts};
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
