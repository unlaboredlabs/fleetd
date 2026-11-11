// Settings › Hub › Machines: the hub's machines, each a row between hairlines with its state (and, unless online, what
// it needs), opening its page (its checklist, role, screens and max agents) from anywhere on the row, which a trailing
// chevron marks, Remove, and Repair while it is degraded or offline. A search for a machine's role, screens or max agents lands on this list, since each is on a machine's
// own page. Repair goes again over SSH when the hub reaches
// the machine, else it makes a line that enrolls it again (machine_join with rejoin); Remove asks first, then runs
// machine_remove, and offers Remove anyway when the hub refuses one that runs projects' leads or is being added. A
// removed one leaves the list here at once; machine.removed resyncs every open app, which drops it and its projects.
// Projects the hub still lists from a machine it no longer has (removed before its rows were forgotten) are listed
// under them, each with Remove, which only forgets the project in fleetd (RemoveProjectDialog).
import { FolderX, Server } from "lucide-react";
import { useState, type RefCallback } from "react";
import type { Machine } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { selectMachines, selectOrphanProjects } from "../../src/data/selectors";
import { Button, Dialog, Text, toast } from "../../ui";
import { machineOrder } from "../projects/machineText";
import { RemoveProjectDialog, type RemoveTarget } from "../projects/RemoveProjectDialog";
import { CallError } from "../../src/data/queries";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { useReveal } from "../settings/search";
import { GroupNote, SettingsList, SettingsListRow, SettingsSection } from "../settings/parts";
import { toHash } from "../shell/routes";
import { MACHINE_WAIT_MS, removeLine, repairOf, statusLine, type Repair } from "./machines";
import a from "./admin.module.css";

const noInput = {};

const STATUS: Readonly<Record<Machine["status"], string>> = { online: "Online", degraded: "Degraded", offline: "Offline" };

export function MachineList({ onRepair }: { onRepair: (r: Repair) => void }) {
  const views = useData(selectMachines);
  const hosts = useToolQuery("machine_hosts", noInput).data?.hosts;
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [removing, setRemoving] = useState<Machine | null>(null);
  const all = views?.map((v) => v.machine).filter((m) => !removed.has(m.machineId));
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
        <SettingsSection title="This hub's machines" intro="Open one for its role, screens and max agents.">
          {machines === undefined ? (
            <GroupNote>Loading…</GroupNote>
          ) : machines.length === 0 ? (
            <GroupNote>No machines yet. Add one above.</GroupNote>
          ) : (
            <SettingsList label="Machines">
              {machines.map((m) => (
                <SettingsListRow
                  key={m.machineId}
                  label={m.name}
                  icon={<Server />}
                  name={m.name}
                  state={{ word: STATUS[m.status], tone: m.status === "online" ? "quiet" : m.status === "degraded" ? "warning" : "danger" }}
                  open={{ href: toHash({ id: "settings", tab: "hub.machines", machine: m.machineId }) }}
                  controls={
                    <>
                      {m.status === "online" ? null : (
                        <Button variant="ghost" onClick={() => onRepair(repairOf(m.machineId, hosts))}>
                          Repair
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => setRemoving(m)}>
                        Remove
                      </Button>
                    </>
                  }
                >
                  {m.machineId === m.name ? null : (
                    <Text size="sm" tone="quiet">
                      {m.machineId}
                    </Text>
                  )}
                  {statusLine(m) === null ? null : (
                    <Text size="sm" tone={m.status === "degraded" ? "warning" : "quiet"}>
                      {statusLine(m)}
                    </Text>
                  )}
                </SettingsListRow>
              ))}
            </SettingsList>
          )}
        </SettingsSection>
      </div>
      {removing === null ? null : (
        <RemoveDialog
          machine={removing}
          line={removeLine(removing.machineId, hosts)}
          onClose={() => setRemoving(null)}
          onRemoved={(id) => setRemoved((was) => new Set([...was, id]))}
        />
      )}
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
            icon={<FolderX />}
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

function RemoveDialog(props: { machine: Machine; line: string; onClose: () => void; onRemoved: (machineId: string) => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const live = useLive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The hub refused because removing it would stop its projects' leads or undo an add still going: the error says
  // which, and Remove anyway sends force.
  const [refused, setRefused] = useState(false);
  const m = props.machine;
  const remove = (force: boolean) => {
    setBusy(true);
    setError(undefined);
    call("machine_remove", force ? { machineId: m.machineId, force: true } : { machineId: m.machineId }, { timeoutMs: MACHINE_WAIT_MS })
      .then(
        (out) => {
          props.onRemoved(m.machineId);
          props.onClose();
          refetch(["machine_hosts", "doctor_list"]);
          const failed = out.steps.find((x) => x.state === "failed");
          toast({
            title: `Removed ${m.name}`,
            description: failed === undefined ? (out.revoked ? "Its key is revoked." : undefined) : (out.next ?? `${failed.title} failed: run it on ${m.name} by hand.`),
            tone: failed === undefined ? "success" : "warning",
          });
        },
        (e: unknown) => {
          setError(errorText(e));
          setRefused(!force && e instanceof CallError && e.error.code === "invalid");
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && props.onClose()}
      title={`Remove ${m.name}?`}
      description={props.line}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || !live} onClick={() => remove(refused)}>
            {busy ? "Removing…" : refused ? "Remove anyway" : `Remove ${m.name}`}
          </Button>
        </>
      }
    >
      {error === undefined ? null : (
        <p role="alert">
          <Text size="sm" tone="danger">{`Not removed: ${error}`}</Text>
        </p>
      )}
    </Dialog>
  );
}
