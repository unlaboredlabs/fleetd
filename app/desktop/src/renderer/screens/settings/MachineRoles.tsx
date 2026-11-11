// A machine's role, on its page in Hub › Machines (admin/MachinePage.tsx): what it is for (agents, screens or both).
// Hub-wide, so only its owners and admins see it. The page reads machine_roles; a change is a machine_roles_set call
// (an admin's), and the hub's answer replaces the row. The agents' Mac (D298) has no roles to pick: it never runs
// agents, and its row is the "Agents may use this Mac" switch with why agents can't use it now, when they can't. How
// many screens it hosts at once is under its Screens (Screens.tsx).
import type { MachineRolesEntry } from "../../../shared/contracts";
import { Segmented } from "../../ui";
import { useMachineSet } from "./Screens";
import { choiceOf, ROLE_CHOICES, ROLE_HELP, ROLE_TITLE, rolesOf } from "./machinesModel";
import { SettingsRow, SwitchRow } from "./parts";

export function MachineRole({ machine: m }: { machine: MachineRolesEntry }) {
  const { set, disabled, echo } = useMachineSet("machine_roles_set", m.machineId);
  const choice = choiceOf(m.roles);
  return (
    <div data-roles={m.machineId}>
      {m.mac !== undefined ? (
        <SwitchRow
          title="Agents may use this Mac"
          line={`Agents build iOS apps and run simulators here. It runs no agents itself.${m.mac.note === undefined ? "" : ` ${m.mac.note}`}`}
          checked={m.mac.on}
          disabled={disabled}
          onCheckedChange={(macTool) => set({ macTool })}
        />
      ) : (
        <SettingsRow
          title={ROLE_TITLE[choice]}
          label={`What ${m.name} is for`}
          line={ROLE_HELP[choice]}
          control={<Segmented label={`What ${m.name} is for`} options={ROLE_CHOICES} value={choice} disabled={disabled} onChange={(roles) => roles !== choice && set({ roles: rolesOf(roles) })} />}
        />
      )}
      {echo}
    </div>
  );
}
