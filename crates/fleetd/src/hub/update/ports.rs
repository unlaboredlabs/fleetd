//! The update's ports over the running hub: the release feed, this machine's binary and service, and the nodes.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

use fleetd_contracts::ids::MachineId;
use fleetd_contracts::node_link::{CAP_SELF_UPDATE, NodeActionResult, NodeUpdate};

use super::{NodeFacts, UpdatePorts};
use crate::hub::api::Hub;
use crate::update::finish::{self, Plan};
use crate::update::service::{self, Service};
use crate::update::{BoxFuture, Channel, Feed, HttpFeed};

pub struct HubPorts(pub Weak<Hub>);

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
        let Some(hub) = self.hub() else {
            return "http://127.0.0.1:4790".into();
        };
        let listen = &hub.config.listen;
        // A hub on every interface answers on loopback too.
        let host = match listen.host.as_str() {
            "0.0.0.0" | "" => "127.0.0.1",
            "::" | "[::]" => "[::1]",
            other => other,
        };
        format!("http://{host}:{}", listen.port)
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
                machine_id: m.machine_id,
                name: m.name,
                version: m.node_version,
            })
            .collect()
    }

    fn update_node<'a>(
        &'a self,
        machine_id: &'a MachineId,
        update: &'a NodeUpdate,
    ) -> BoxFuture<'a, Result<NodeActionResult, String>> {
        Box::pin(async move {
            let hub = self.hub().ok_or("the hub is stopping")?;
            hub.node_commands
                .update_node(machine_id, update)
                .await
                .map_err(|e| e.message)
        })
    }
}
