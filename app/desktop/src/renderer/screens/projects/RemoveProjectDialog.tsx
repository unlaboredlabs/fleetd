// Removing a project: project_remove stops its claude processes and forgets it; its files, branches and worktrees
// stay. Used by the Machines screen and, by import, the sidebar's project menu.

import { useState } from "react";
import { Button, Dialog, Text, toast } from "../../ui";
import { machineName } from "./fleet";
import { openAddProject } from "./store";

export interface RemoveTarget {
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
  readonly path: string;
}

export function RemoveProjectDialog({ project, onClose }: { project: RemoveTarget | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const machine = project ? machineName(project.machineId) : "";

  const close = () => {
    setBusy(false);
    setError(null);
    onClose();
  };

  const remove = async (p: RemoveTarget) => {
    setBusy(true);
    setError(null);
    const out = await window.fleetd.hub.call("project_remove", { machineId: p.machineId, projectId: p.projectId });
    setBusy(false);
    if (!out.ok) {
      setError(out.error.fix ? { message: out.error.message, fix: out.error.fix } : { message: out.error.message });
      return;
    }
    close();
    // The way back in: the folder is still there, so adding it again is one click.
    toast({
      title: `${p.title} removed from ${machine}`,
      description: "Its files, branches and worktrees stay.",
      action: { label: "Add it again", onClick: () => openAddProject({ text: p.path, machine: p.machineId }) },
    });
  };

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      title={project ? `Remove ${project.title} from ${machine}?` : ""}
      description="Its agents stop now. Its files, branches and worktrees stay on the machine; you can add the folder again any time."
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || project === null} onClick={() => project && void remove(project)}>
            {busy ? "Removing…" : "Remove project"}
          </Button>
        </>
      }
    >
      {error ? (
        <div role="alert">
          <Text tone="danger">{error.message}</Text>
          {error.fix ? (
            <Text as="p" tone="quiet">
              {error.fix}
            </Text>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
