// Settings › Hub › Machines: the hub's machines, each a row between hairlines with its state (and, unless online, what
// it needs), a link to its page (the checklist), Repair and Remove. Repair goes again over SSH when the hub reaches
// the machine, else it makes a line that enrolls it again (machine_join with rejoin); Remove asks first, then runs
// machine_remove, and offers Remove anyway when the hub refuses one that runs projects' leads or is being added. The hub sends no event when it forgets a machine, so a removed one leaves the list here at once and
// the store's next snapshot. Cloud machines (boat.dev) are listed apart, as their own group under these (Cloud.tsx).
import { useState } from "react";
import type { Machine } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { selectMachines } from "../../src/data/selectors";
import { Button, Dialog, Text, toast } from "../../ui";
import { machineOrder } from "../projects/machineText";
import { CallError } from "../../src/data/queries";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { toHash } from "../shell/routes";
import { MACHINE_WAIT_MS, removeLine, repairOf, statusLine, type Repair } from "./machines";
import { ownMachines } from "./cloudModel";
import { CloudGroup, useCloud } from "./Cloud";
import a from "./admin.module.css";

const noInput = {};

const STATUS: Readonly<Record<Machine["status"], string>> = { online: "Online", degraded: "Degraded", offline: "Offline" };

export function MachineList({ onRepair }: { onRepair: (r: Repair) => void }) {
  const views = useData(selectMachines);
  const hosts = useToolQuery("machine_hosts", noInput).data?.hosts;
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [removing, setRemoving] = useState<Machine | null>(null);
  const cloud = useCloud();
  const all = views?.map((v) => v.machine).filter((m) => !removed.has(m.machineId));
  const machines = all === undefined ? undefined : ownMachines(all, cloud ?? undefined).sort(machineOrder);
  return (
    <>
    <section className={`${a.section} ${a.machines}`} aria-labelledby="machines-list">
      <Text strong id="machines-list">
        This hub's machines
      </Text>
      {machines === undefined ? (
        <Text tone="quiet">Loading…</Text>
      ) : machines.length === 0 ? (
        <Text size="sm" tone="quiet">
          No machines yet. Add one above.
        </Text>
      ) : (
        <div className={a.list} role="list" aria-label="Machines">
          {machines.map((m) => (
            <div key={m.machineId} className={a.row} role="listitem" aria-label={m.name}>
              <div className={a.who}>
                <div className={a.name}>
                  <a className={a.machineLink} href={toHash({ id: "settings", tab: "hub.machines", machine: m.machineId })}>
                    <Text strong>{m.name}</Text>
                  </a>
                  <Text size="xs" tone={m.status === "online" ? "quiet" : m.status === "degraded" ? "warning" : "danger"}>
                    {STATUS[m.status]}
                  </Text>
                </div>
                <Text size="xs" tone="quiet">
                  {`fleetd ${m.nodeVersion}${m.machineId === m.name ? "" : ` · ${m.machineId}`}`}
                </Text>
                {statusLine(m) === null ? null : (
                  <Text size="xs" tone={m.status === "degraded" ? "warning" : "default"}>
                    {statusLine(m)}
                  </Text>
                )}
              </div>
              <div className={a.controls}>
                <Button size="sm" variant="ghost" onClick={() => onRepair(repairOf(m.machineId, hosts))}>
                  Repair
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRemoving(m)}>
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {removing === null ? null : (
        <RemoveDialog
          machine={removing}
          line={removeLine(removing.machineId, hosts)}
          onClose={() => setRemoving(null)}
          onRemoved={(id) => setRemoved((was) => new Set([...was, id]))}
        />
      )}
    </section>
    <CloudGroup />
    </>
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
