//! `machine_roles` and `machine_roles_set`: Administration › Hub settings and `fleetd machine set <id> --roles`.
use std::sync::Arc;

use fleetd_contracts::auth::Role;
use fleetd_contracts::machine_roles::MachineRole;
use fleetd_contracts::mcp::{
    ErrorCode, MachineRolesInput, MachineRolesOutput, MachineRolesSetInput, MachineRolesSetOutput,
};
use fleetd_contracts::prim::List;

use super::{entry, roles_on, runners, set_roles};
use crate::hub::api::{Caller, Hub, Registry, ToolError, readable, require};

pub fn register(tools: &mut Registry) {
    tools.add("machine_roles", machine_roles);
    tools.add("machine_roles_set", machine_roles_set);
}

async fn machine_roles(
    hub: Arc<Hub>,
    caller: Caller,
    _: MachineRolesInput,
) -> Result<MachineRolesOutput, ToolError> {
    let machines: Vec<_> = runners(&hub)?
        .into_iter()
        .filter(|(r, _, _)| readable(&caller, &r.machine_id))
        .map(|(r, roles, why)| entry(r, roles, why))
        .collect();
    let next = machines
        .is_empty()
        .then(|| "No machine has joined yet: add one with fleetd machine add.".to_owned());
    Ok(MachineRolesOutput {
        machines: List::unchecked(machines),
        next,
        truncated: None,
    })
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
        machine: entry(runner, roles, why),
        next,
        truncated: None,
    })
}
