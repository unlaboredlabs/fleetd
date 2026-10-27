// Administration › Machines: the hub's machines, each a row between hairlines with its state, a link to its page
// (the checklist), Repair and Remove. Repair goes again over SSH when the hub reaches the machine, else it makes a
// line that enrolls it again (machine_join with rejoin); Remove asks first, then runs machine_remove. The hub sends no
// event when it forgets a machine, so a removed one leaves the list here at once and the store's next snapshot.
import { useState } from "react";
import type { Machine } from "../../../shared/contracts";
import { useData, useToolQuery } from "../../src/data/react";
import { selectMachines } from "../../src/data/selectors";
import { Button, Dialog, Text, toast } from "../../ui";
import { machineOrder } from "../projects/machineText";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { toHash } from "../shell/routes";
import { removeLine, repairOf, type Repair } from "./machines";
import a from "./admin.module.css";

const noInput = {};

const STATUS: Readonly<Record<Machine["status"], string>> = { online: "Online", degraded: "Degraded", offline: "Offline" };

export function MachineList({ onRepair }: { onRepair: (r: Repair) => void }) {
  const views = useData(selectMachines);
  const hosts = useToolQuery("machine_hosts", noInput).data?.hosts;
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [removing, setRemoving] = useState<Machine | null>(null);
  const machines = views
    ?.map((v) => v.machine)
    .filter((m) => !removed.has(m.machineId))
    .sort(machineOrder);
  return (
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
                  <a className={a.machineLink} href={toHash({ id: "admin", section: "machines", machine: m.machineId })}>
                    <Text strong>{m.name}</Text>
                  </a>
                  <Text size="xs" tone={m.status === "online" ? "quiet" : m.status === "degraded" ? "warning" : "danger"}>
                    {STATUS[m.status]}
                  </Text>
                </div>
                <Text size="xs" tone="quiet">
                  {`fleetd ${m.nodeVersion}${m.machineId === m.name ? "" : ` · ${m.machineId}`}`}
                </Text>
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
  );
}

function RemoveDialog(props: { machine: Machine; line: string; onClose: () => void; onRemoved: (machineId: string) => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const live = useLive();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const m = props.machine;
  const remove = () => {
    setBusy(true);
    setError(undefined);
    call("machine_remove", { machineId: m.machineId })
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
        (e: unknown) => setError(errorText(e)),
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
          <Button variant="danger" disabled={busy || !live} onClick={remove}>
            {busy ? "Removing…" : `Remove ${m.name}`}
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
