//! Cloud machines, the machine's side (boat.dev, D306). A cloud machine is an ordinary fleetd machine the hub made and
//! keeps asleep while nothing needs it: hub/pool owns the VMs (create, wake and stop, the ledger and every fence that
//! bounds what they cost). This module makes the machine itself work:
//! - [`setup`]: the script a new VM runs to become a machine: a fresh `/etc/machine-id`, pinned fleetd, Claude Code,
//!   `gh`, sccache and Xvfb, the agents under a user of their own with no sudo, and an enroll with a pool enroll token
//!   the hub minted (`Auth::create_pool_enroll_token`), so no person is in the loop. A machine enrolled with one is a
//!   pool machine ([`is_pool`]), and only such a token enrolls its id again from a recreated VM.
//! - [`catch_up`]: what it missed while asleep, delivered at each hello before it counts as ready for work: fleetd and
//!   Claude Code updates, secrets to forget ([`outbox`]), its old worktrees, and the hub's Claude configuration
//!   ([`claude`]), resealed to it from a machine that holds it so nobody pastes it again.
//!
//! The node's heartbeat says what keeps it busy (`NodeBusy`: runs, screens, recordings to upload, screens hosted for
//! other machines; `NodeLinkServer::busy`), which hub/pool reads to stop an idle one, and `fleetd node flush` is the
//! VM's pre-stop hook.
pub mod catch_up;
pub mod claude;
pub mod outbox;
pub mod setup;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Mutex;

use fleetd_contracts::ids::MachineId;

use crate::hub::api::Hub;

/// Whether the machine is one of the hub's cloud machines: its node enrolled with a pool enroll token.
pub fn is_pool(hub: &Hub, machine_id: &MachineId) -> bool {
    hub.auth.is_pool(machine_id).unwrap_or_else(|e| {
        tracing::warn!(machine_id = %machine_id, "whether it is a cloud machine not read: {e}");
        false
    })
}

/// Which cloud machines have caught up since their link went live, by the time it did (`Executors::live_since`).
#[derive(Default)]
pub struct Cloud {
    caught_up: Mutex<HashMap<MachineId, i64>>,
}

impl Cloud {
    /// The catch-up of the link that went live at `live_since` is done.
    pub fn set_caught_up(&self, machine_id: &MachineId, live_since: i64) {
        self.caught_up
            .lock()
            .unwrap()
            .insert(machine_id.clone(), live_since);
    }

    /// Whether work may be placed on the machine: any machine but a cloud one at once; a cloud machine once its
    /// catch-up for its current link is done, so nothing runs there on an old fleetd, an old Claude or without the
    /// hub's Claude configuration.
    pub fn ready(&self, hub: &Hub, machine_id: &MachineId) -> bool {
        if !is_pool(hub, machine_id) {
            return true;
        }
        let Some(live_since) = hub.executors.live_since(machine_id) else {
            return false;
        };
        self.caught_up.lock().unwrap().get(machine_id) == Some(&live_since)
    }
}
