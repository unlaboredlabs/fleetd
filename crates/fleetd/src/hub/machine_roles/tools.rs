//! `machine_roles` and `machine_roles_set`: Settings › Hub › Machines and `fleetd machine set <id> --roles`; and
//! `machine_screens_set`, its Screens: a kind of screen turned on or off on a machine, or its idle timeout, which the
//! machine's node writes into its node.json (node/screens.rs).
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::machine_roles::{MachineRole, MachineRolesEntry, ScreenSettings};
use fleetd_contracts::mcp::{
    ErrorCode, MachineRolesInput, MachineRolesOutput, MachineRolesSetInput, MachineRolesSetOutput,
    MachineScreensSetInput, MachineScreensSetOutput,
};
use fleetd_contracts::node_link::CAP_SCREEN_SETTINGS;
use fleetd_contracts::prim::{Line, List};

use super::{entry, roles_on, runners, set_roles};
use crate::hub::api::{Caller, Hub, Registry, ToolError, allows, readable, require};

pub fn register(tools: &mut Registry) {
    tools.add("machine_roles", machine_roles);
    tools.add("machine_roles_set", machine_roles_set);
    tools.add("machine_screens_set", machine_screens_set);
}

async fn machine_roles(
    hub: Arc<Hub>,
    caller: Caller,
    _: MachineRolesInput,
) -> Result<MachineRolesOutput, ToolError> {
    let machines: Vec<_> = runners(&hub)?
        .into_iter()
        .filter(|(r, _, _)| readable(&caller, &r.machine_id))
        .map(|(r, roles, why)| for_caller(&hub, &caller, entry(r, roles, why)))
        .collect();
    let next = machines
        .is_empty()
        .then(|| "No machine has joined yet: add one with fleetd machine add.".to_owned());
    Ok(MachineRolesOutput {
        machines: List::unchecked(machines),
        best: crate::hub::projects::best_worker(&hub),
        retention: Some(hub.db.with(crate::hub::browser::retention_on)?),
        next,
        truncated: None,
    })
}

/// What the app's Navi dialog reads besides roles: the machine's Navi sandbox, and whether the caller may make a Navi
/// there; and whether its node takes screen settings. A node between two links (restarting after an update or a
/// screen setting, while the machine still counts as online) says nothing either way: only a linked node that doesn't
/// list them is too old, and then the command that restarts it goes with it.
fn for_caller(hub: &Hub, caller: &Caller, entry: MachineRolesEntry) -> MachineRolesEntry {
    let m = &entry.machine_id;
    let (can, old) = (
        hub.link.node_can(m, CAP_SCREEN_SETTINGS),
        hub.link.node_lacks(m, CAP_SCREEN_SETTINGS),
    );
    let setup = old.then(|| crate::hub::doctor::config::read_hub_config(&hub.config.home).0);
    MachineRolesEntry {
        screen_settings: (can || old).then_some(can),
        node_restart: setup.map(|s| Line::unchecked(node_restart(s.machines.get(m.as_str())))),
        navi_sandbox: hub
            .executors
            .cached_runner(&entry.machine_id)
            .and_then(|info| info.sandbox),
        operates: Some(allows(caller, Role::Operate, Some(&entry.machine_id))),
        ..entry
    }
}

/// The command that restarts a machine's node, run there: as `fleetd machine add` set it up, else one that does on
/// either system.
fn node_restart(setup: Option<&crate::hub::doctor::config::MachineSetup>) -> String {
    match setup {
        Some(_) => crate::hub::doctor::config::restart_command("node", setup),
        None => "launchctl kickstart -k gui/$(id -u)/sh.fleetd.node 2>/dev/null || systemctl --user restart fleetd-node.service".to_owned(),
    }
}

async fn machine_roles_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: MachineRolesSetInput,
) -> Result<MachineRolesSetOutput, ToolError> {
    let m = &input.machine_id;
    require(&caller, Role::Admin, Some(m))?;
    if hub.store.machine_get(m)?.is_none() {
        return Err(
            ToolError::new(ErrorCode::NotFound, format!("No machine {m}."))
                .with_fix("machine_roles lists the machines."),
        );
    }
    let (before, after) = hub.db.transaction(|c| {
        let before = roles_on(c, m)?;
        let mut after = before;
        if let Some(roles) = &input.roles {
            after.agents = roles.contains(&MachineRole::Agents);
            after.sessions = roles.contains(&MachineRole::Sessions);
        }
        if let Some(n) = input.max_sessions {
            after.max_sessions = Some(n.get());
        }
        if input.auto_sessions == Some(true) {
            after.max_sessions = None;
        }
        set_roles(c, m, &after)?;
        Ok((before, after))
    })?;
    if before.agents != after.agents {
        hub.slots.set_runs_agents(m, after.agents)?;
    }
    let (runner, roles, why) = runners(&hub)?
        .into_iter()
        .find(|(r, _, _)| &r.machine_id == m)
        .ok_or_else(|| ToolError::new(ErrorCode::NotFound, format!("No machine {m}.")))?;
    let next = match (before.agents, after.agents) {
        (true, false) => Some(format!(
            "{m} takes no new agents: those running finish their work, and its projects' agents wait."
        )),
        (false, true) => Some(format!(
            "{m} runs agents again: queued ones start as slots free."
        )),
        _ => None,
    };
    Ok(MachineRolesSetOutput {
        machine: for_caller(&hub, &caller, entry(runner, roles, why)),
        next,
        truncated: None,
    })
}

async fn machine_screens_set(
    hub: Arc<Hub>,
    caller: Caller,
    input: MachineScreensSetInput,
) -> Result<MachineScreensSetOutput, ToolError> {
    let m = &input.machine_id;
    require(&caller, Role::Admin, Some(m))?;
    let Some(machine) = hub.store.machine_get(m)? else {
        return Err(
            ToolError::new(ErrorCode::NotFound, format!("No machine {m}."))
                .with_fix("machine_roles lists the machines."),
        );
    };
    let name = machine.name;
    if !hub.link.node_can(m, CAP_SCREEN_SETTINGS) {
        let (code, why, fix) = match hub.node_commands.linked(m) {
            false => (
                ErrorCode::MachineOffline,
                format!("{name} is offline."),
                format!("Start {name}'s node, then try again."),
            ),
            true => (
                ErrorCode::Failed,
                format!("{name}'s fleetd is too old to take screen settings from the hub."),
                format!(
                    "Update it from Settings › Hub › Machines › Updates, or set it in {name}'s node.json by hand."
                ),
            ),
        };
        return Err(ToolError::new(code, why).with_fix(fix));
    }
    let settings = ScreenSettings {
        host: input.host,
        on: input.on,
        idle_minutes: input.idle_minutes,
    };
    let answer = hub
        .node_commands
        .screens(m, &settings)
        .await
        .map_err(|e| ToolError::new(ErrorCode::Failed, e.message))?;
    if let Some(hosts) = answer.hosts {
        hub.link.set_hosts(m, hosts);
    }
    if !answer.ok {
        return Err(ToolError::new(
            ErrorCode::Failed,
            format!("{name} didn't change: {}", answer.message.as_str()),
        ));
    }
    let (runner, roles, why) = runners(&hub)?
        .into_iter()
        .find(|(r, _, _)| &r.machine_id == m)
        .ok_or_else(|| ToolError::new(ErrorCode::NotFound, format!("No machine {m}.")))?;
    Ok(MachineScreensSetOutput {
        machine: for_caller(&hub, &caller, entry(runner, roles, why)),
        next: Some(answer.message.as_str().to_owned()),
        truncated: None,
    })
}
