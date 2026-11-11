// Settings › Hub › Machines: the hub's machines in one group, each row its name alone, opening its page (its checklist,
// role, screens, max agents, Repair and Remove) from anywhere on the row, which a trailing chevron marks. One that
// needs someone (offline, degraded, claude logged out) says so with one dot at its row's end, why in its tooltip; a
// role other than the usual both is a quiet word beside its name. A search for a machine's role, screens or max agents
// lands on this list, since each is on a machine's own page.
// Projects the hub still lists from a machine it no longer has (removed before its rows were forgotten) are listed
// under them, each with Remove, which only forgets the project in fleetd (RemoveProjectDialog).
import { useState, type RefCallback } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { selectMachines, selectOrphanProjects } from "../../src/data/selectors";
import { Button, Text } from "../../ui";
import { useNow } from "../live";
import { machineOrder } from "../projects/machineText";
import { RemoveProjectDialog, type RemoveTarget } from "../projects/RemoveProjectDialog";
import { FleetCapNote } from "../settings/Agents";
import { roleWord } from "../settings/machinesModel";
import { useReveal } from "../settings/search";
import { GroupNote, SettingsList, SettingsListRow, SettingsSection } from "../settings/parts";
import { toHash } from "../shell/routes";
import { needsOf } from "./machines";
import a from "./admin.module.css";

const noInput = {};

const allChecks = {};

export function MachineList() {
  const views = useData(selectMachines);
  // As the hub last checked them, and as a machine's page reads them: a check that failed is the row's dot.
  const checks = useToolQuery("doctor_list", allChecks).data?.checks;
  const roles = useToolQuery("machine_roles", noInput).data?.machines;
  const nowMs = useNow(true, 60_000);
  const all = views?.map((v) => v.machine);
  const machines = all === undefined ? undefined : [...all].sort(machineOrder);
  const rolesRef = useReveal<HTMLElement>("hub.roles");
  const screensRef = useReveal<HTMLElement>("hub.screens");
  const capsRef = useReveal<HTMLElement>("hub.caps");
  const marked: RefCallback<HTMLElement> = (el) => {
    rolesRef.current = el;
    screensRef.current = el;
    capsRef.current = el;
  };
  return (
    <>
      <div ref={marked} tabIndex={-1} className={a.revealed}>
        <SettingsSection>
          {machines === undefined ? (
            <GroupNote>Loading…</GroupNote>
          ) : machines.length === 0 ? (
            <GroupNote>No machines yet. Add one with the plus above.</GroupNote>
          ) : (
            <SettingsList label="Machines">
              {machines.map((m) => (
                <SettingsListRow
                  key={m.machineId}
                  label={m.name}
                  name={m.name}
                  needs={needsOf(m, checks, nowMs)}
                  meta={roleWord(roles?.find((r) => r.machineId === m.machineId))}
                  open={{ href: toHash({ id: "settings", tab: "hub.machines", machine: m.machineId }) }}
                  data={{ "data-machine": m.status }}
                >
                  {m.machineId === m.name ? null : (
                    <Text size="sm" tone="quiet">
                      {m.machineId}
                    </Text>
                  )}
                </SettingsListRow>
              ))}
            </SettingsList>
          )}
          <FleetCapNote />
        </SettingsSection>
      </div>
      <LeftoverProjects />
    </>
  );
}

/** Projects whose machine was removed: shown only while there are some, each with Remove. */
function LeftoverProjects() {
  const projects = useData(selectOrphanProjects);
  const [removing, setRemoving] = useState<RemoveTarget | null>(null);
  if (projects.length === 0 && removing === null) return null;
  return (
    <SettingsSection
      title="Left from removed machines"
      intro="These projects' machines are no longer in this hub, so no machine holds their files. Removing one forgets it in fleetd."
    >
      <SettingsList label="Projects left from removed machines">
        {projects.map((p) => (
          <SettingsListRow
            key={`${p.machineId}/${p.projectId}`}
            label={p.title}
            name={p.title}
            controls={
              <Button variant="ghost" onClick={() => setRemoving({ machineId: p.machineId, projectId: p.projectId, title: p.title, path: p.workspaceRoot })}>
                Remove
              </Button>
            }
          >
            <Text size="sm" tone="quiet">{`${p.machineId} · ${p.workspaceRoot}`}</Text>
          </SettingsListRow>
        ))}
      </SettingsList>
      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </SettingsSection>
  );
}
