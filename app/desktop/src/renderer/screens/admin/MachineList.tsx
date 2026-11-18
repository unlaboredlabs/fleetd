// Settings › Hub › Machines: the hub's machines in one group, each row opening its page (what is wrong with it, what
// it is for, its agents and screens, Repair and Remove) from anywhere on the row, which a trailing chevron marks. Its
// state is the dot before its name, as every place on the page has one, and the row's end says it in a few words: what
// runs there now, or what is wrong (offline since when, claude logged out), in the dot's colour. A role other than the
// usual both is a quiet word beside its name. A search for a machine's role, screens or max agents
// lands on this list, since each is on a machine's own page.
// Projects the hub still lists from a machine it no longer has (removed before its rows were forgotten) are listed
// under them, each with Remove, which only forgets the project in fleetd (RemoveProjectDialog).
import { useState, type ReactNode, type RefCallback } from "react";
import { useData, useToolQuery } from "../../src/data/react";
import { selectMachines, selectOrphanProjects } from "../../src/data/selectors";
import { Button, Text, Truncate } from "../../ui";
import { useNow } from "../live";
import { machineOrder } from "../projects/machineText";
import { RemoveProjectDialog, type RemoveTarget } from "../projects/RemoveProjectDialog";
import { roleWord } from "../settings/machinesModel";
import { loadWords, machineMark } from "../settings/placesModel";
import { useReveal } from "../settings/search";
import { GroupNote, SettingsList, SettingsListRow, SettingsSection } from "../settings/parts";
import { toHash } from "../shell/routes";
import { needsOf } from "./machines";
import { useServes } from "./role";
import a from "./admin.module.css";
import g from "../settings/groups.module.css";

const noInput = {};

const allChecks = {};

/** `add`: the group's plus, at its label's end as every section's is. */
export function MachineList({ add }: { add?: ReactNode }) {
  const views = useData(selectMachines);
  // As the hub last checked them, and as a machine's page reads them: a check that failed is the row's dot.
  // fleetd cloud runs no doctor: no checks to read there.
  const checks = useToolQuery("doctor_list", allChecks, { enabled: useServes("doctor_list") }).data?.checks;
  const roles = useToolQuery("machine_roles", noInput).data?.machines;
  const slots = useData((st) => (st.fresh ? (st.live.slots ?? st.slots) : undefined));
  const nowMs = useNow(true, 60_000);
  // The team's computers: the hub's runner for hosted sandboxes is none (its providers are listed with them).
  const all = views?.map((v) => v.machine).filter((m) => m.runner !== true);
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
        <SettingsSection title="Machines" aside={add}>
          {machines === undefined ? (
            <GroupNote>Loading…</GroupNote>
          ) : machines.length === 0 ? (
            <GroupNote>No machines yet. Add one with the plus.</GroupNote>
          ) : (
            <SettingsList label="Machines">
              {machines.map((m) => {
                const needs = needsOf(m, checks, nowMs);
                const role = roles?.find((r) => r.machineId === m.machineId);
                const agents = role === undefined || role.roles.includes("agents") ? slots?.perMachine?.find((x) => x.machineId === m.machineId)?.running : undefined;
                const screens = role !== undefined && (role.roles.includes("sessions") || role.mac !== undefined) ? role.sessionsLive : undefined;
                const mark = machineMark(m.status, needs);
                return (
                  <SettingsListRow
                    key={m.machineId}
                    label={m.name}
                    name={m.name}
                    mark={mark}
                    markLabel={needs ?? "Online"}
                    meta={roleWord(role)}
                    controls={
                      <span className={g.state}>
                        <Truncate size="sm" expand="none" tone={mark === "ready" ? "quiet" : "warning"}>
                          {needs ?? loadWords({ agents, screens })}
                        </Truncate>
                      </span>
                    }
                    open={{ href: toHash({ id: "settings", tab: "hub.machines", machine: m.machineId }) }}
                    data={{ "data-machine": m.status }}
                  >
                    {m.machineId === m.name ? null : (
                      <Text size="sm" tone="quiet">
                        {m.machineId}
                      </Text>
                    )}
                  </SettingsListRow>
                );
              })}
            </SettingsList>
          )}
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
      hint="These bots' machines are no longer in this hub, so no machine holds their files. Removing one forgets it in fleetd."
    >
      <SettingsList label="Bots left from removed machines">
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
