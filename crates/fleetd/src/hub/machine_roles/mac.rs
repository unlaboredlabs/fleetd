//! The agents' Mac (D298) as the hub sees it: the machine whose node lists `agents_mac` (a tool, never a runner), the
//! admin's "Agents may use this Mac" switch (`machine_roles_settings` key `mac_tool`, on unless set off), and where
//! agents' `mac` calls go: [`mac_machine`]. Every project's agents may use it; Navis never.
use fleetd_contracts::ids::MachineId;
use fleetd_contracts::machine_roles::MacTool;
use fleetd_contracts::model::MachineStatus;
use fleetd_contracts::node_link::CAP_MAC_TOOL;
use fleetd_contracts::prim::Line;
use rusqlite::{Connection, OptionalExtension};

use crate::hub::api::Hub;
use crate::hub::store::StoreError;

/// "Agents may use this Mac": on unless an admin set it off.
pub fn tool_on(c: &Connection) -> Result<bool, StoreError> {
    let v: Option<i64> = c
        .query_row(
            "SELECT value FROM machine_roles_settings WHERE key = 'mac_tool'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(v != Some(0))
}

pub fn set_tool_on(c: &Connection, on: bool) -> Result<(), StoreError> {
    c.execute(
        "INSERT INTO machine_roles_settings (key, value) VALUES ('mac_tool', ?1)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [i64::from(on)],
    )?;
    Ok(())
}

/// Whether `m` is the agents' Mac, by what its node last said at its hello.
pub fn is_agents_mac(hub: &Hub, m: &MachineId) -> bool {
    hub.store
        .machine_get(m)
        .ok()
        .flatten()
        .is_some_and(|machine| machine.agents_mac == Some(true))
}

/// The machine agents' `mac` calls go to: the online agents' Mac whose node lists `mac_tool` (the first by id, should
/// there be two), while the switch is on. Navis never reach it: the caller refuses them. [`tool`] says why it's None.
pub fn mac_machine(hub: &Hub) -> Option<MachineId> {
    if !hub.db.with(tool_on).unwrap_or(true) {
        return None;
    }
    let mut machines = hub.store.machines_list().ok()?;
    machines.sort_by(|a, b| a.machine_id.as_str().cmp(b.machine_id.as_str()));
    machines
        .into_iter()
        .filter(|m| m.agents_mac == Some(true) && m.status != MachineStatus::Offline)
        .map(|m| m.machine_id)
        .find(|m| hub.link.node_can(m, CAP_MAC_TOOL))
}

/// The agents' Mac's tool for Settings › Hub › Machines; None on any other machine.
pub fn tool(hub: &Hub, m: &MachineId) -> Option<MacTool> {
    let machine = hub.store.machine_get(m).ok().flatten()?;
    if machine.agents_mac != Some(true) {
        return None;
    }
    let on = hub.db.with(tool_on).unwrap_or(true);
    let ready = machine.status != MachineStatus::Offline && hub.link.node_can(m, CAP_MAC_TOOL);
    let name = machine.name;
    let note = if machine.status == MachineStatus::Offline {
        Some(format!(
            "{name} is offline. After a restart, log in as fleetd agents on it (at the Mac or over Screen Sharing) to \
             bring it back."
        ))
    } else if !ready {
        Some(format!(
            "{name}'s node doesn't offer the tool: its user must be a standard user that can't sudo, on macOS. Its \
             checks in Settings › Hub › Setup › A Mac for agents say what to fix."
        ))
    } else if !on {
        Some("Off: agents' mac commands answer that the Mac is turned off.".to_owned())
    } else {
        None
    };
    Some(MacTool {
        on,
        ready,
        note: note.map(|n| Line::unchecked(crate::hub::usage::time::clip(&n, 300))),
    })
}
