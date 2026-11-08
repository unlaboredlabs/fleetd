// A machine's role, on its page in Hub › Machines (admin/MachinePage.tsx): what it is for (agents, screens or both).
// Hub-wide, so only its owners and admins see it. The page reads machine_roles; a change is a machine_roles_set call
// (an admin's), and the hub's answer replaces the row. The agents' Mac (D298) has no roles to pick: it never runs
// agents, and its row is the "Agents may use this Mac" switch with why agents can't use it now, when they can't. How
// many screens it hosts at once is under its Screens (Screens.tsx).
import type { MachineRolesEntry } from "../../../shared/contracts";
import { Segmented, Switch, Text } from "../../ui";
import { useMachineSet } from "./Screens";
import { choiceOf, ROLE_CHOICES, ROLE_HELP, rolesOf } from "./machinesModel";
import s from "./settings.module.css";

export function MachineRole({ machine: m }: { machine: MachineRolesEntry }) {
  const { set, disabled, echo } = useMachineSet("machine_roles_set", m.machineId);
  const choice = choiceOf(m.roles);
  return (
    <div className={s.machineControls} data-roles={m.machineId}>
      {m.mac !== undefined ? (
        <>
          <Switch label="Agents may use this Mac" description="Agents build iOS apps and run simulators here. It runs no agents itself." checked={m.mac.on} disabled={disabled} onCheckedChange={(macTool) => set({ macTool })} />
          {m.mac.note === undefined ? null : (
            <Text size="xs" tone="quiet">
              {m.mac.note}
            </Text>
          )}
        </>
      ) : (
        <>
          <Segmented label={`What ${m.name} is for`} options={ROLE_CHOICES} value={choice} disabled={disabled} onChange={(roles) => roles !== choice && set({ roles: rolesOf(roles) })} />
          <Text size="xs" tone="quiet">
            {ROLE_HELP[choice]}
          </Text>
        </>
      )}
      {echo}
    </div>
  );
}
