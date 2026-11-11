// Remove, from a machine's own page (MachinePage.tsx): asks first, saying what the hub undoes (removeLine), then runs
// machine_remove, and offers Remove anyway when the hub refuses one that runs projects' leads or is being added.
// machine.removed resyncs every open app, which drops the machine and its projects.
import { useState } from "react";
import type { Machine } from "../../../shared/contracts";
import { CallError } from "../../src/data/queries";
import { useToolQuery } from "../../src/data/react";
import { Button, Dialog, Text, toast } from "../../ui";
import { errorText, useHubCall, useLive, useRefetch } from "../settings/hub";
import { MACHINE_WAIT_MS, removeLine } from "./machines";

const noInput = {};

export function RemoveMachine(props: { machine: Machine; onClose: () => void; onRemoved: () => void }) {
  const call = useHubCall();
  const refetch = useRefetch();
  const live = useLive();
  const hosts = useToolQuery("machine_hosts", noInput).data?.hosts;
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
          props.onRemoved();
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
      description={removeLine(m.machineId, hosts)}
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
