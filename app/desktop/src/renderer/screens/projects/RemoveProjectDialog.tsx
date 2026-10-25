// Removing a project: project_remove stops its claude processes and forgets it; its files, branches and worktrees
// stay. Opened from a project's menu on the Machines screen. Settings → Projects opens it to delete: the name typed to
// confirm, and its fleetd worktrees removed too (`removeWorktrees`), never its checkout, branches or PRs.

import { useState } from "react";
import { Button, Dialog, Field, Input, Text, toast } from "../../ui";
import { useData, useDataLayer } from "../../src/data/react";
import { HubText } from "./HubText";
import { openAddProject } from "./store";

export interface RemoveTarget {
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
  readonly path: string;
  /** A delete: its worktrees go too, once its name is typed. `unsaved` are those holding uncommitted changes. */
  readonly deleting?: { readonly unsaved: ReadonlyArray<{ readonly path: string; readonly branch?: string | undefined }> };
}

/** The delete's confirm: the project's name exactly, around spaces. */
export const deleteConfirmed = (typed: string, title: string): boolean => typed.trim() === title.trim() && title.trim() !== "";

export function RemoveProjectDialog({ project, onClose, onRemoved }: { project: RemoveTarget | null; onClose: () => void; onRemoved?: () => void }) {
  const data = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const machine = useData((d) => (project ? (d.machines[project.machineId]?.name ?? project.machineId) : ""));
  const deleting = project?.deleting;

  const close = () => {
    setBusy(false);
    setError(null);
    setTyped("");
    onClose();
  };

  const remove = async (p: RemoveTarget) => {
    setBusy(true);
    setError(null);
    const out = await data.call("project_remove", { machineId: p.machineId, projectId: p.projectId, ...(p.deleting ? { removeWorktrees: true } : {}) });
    setBusy(false);
    if (!out.ok) {
      setError(out.error.fix ? { message: out.error.message, fix: out.error.fix } : { message: out.error.message });
      return;
    }
    close();
    onRemoved?.();
    // The way back in: the folder is still there, so adding it again is one click.
    toast({
      title: p.deleting ? `${p.title} deleted from fleetd` : `${p.title} removed from ${machine}`,
      description: p.deleting ? `Its checkout and branches stay on ${machine}.` : "Its files, branches and worktrees stay.",
      action: { label: "Add it again", onClick: () => openAddProject({ text: p.path, machine: p.machineId }) },
    });
  };

  const ready = project !== null && (!deleting || deleteConfirmed(typed, project.title));
  return (
    <Dialog
      open={project !== null}
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      title={project ? (deleting ? `Delete ${project.title}?` : `Remove ${project.title} from ${machine}?`) : ""}
      description={
        deleting
          ? `Its agents stop now, fleetd forgets it and its settings, and the worktrees its agents worked in are removed. Its checkout at ${project.path}, its branches and its pull requests stay as they are.`
          : "Its agents stop now. Its files, branches and worktrees stay on the machine; you can add the folder again any time."
      }
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || !ready} onClick={() => project && void remove(project)}>
            {busy ? (deleting ? "Deleting…" : "Removing…") : deleting ? "Delete project" : "Remove project"}
          </Button>
        </>
      }
    >
      {deleting ? (
        <>
          {deleting.unsaved.length > 0 ? (
            <div role="alert">
              <Text tone="warning">
                {deleting.unsaved.length === 1 ? "This worktree has" : "These worktrees have"} uncommitted changes, which are lost:
              </Text>
              <ul>
                {deleting.unsaved.map((w) => (
                  <li key={w.path}>
                    <Text size="sm" mono>
                      {w.branch ?? w.path}
                    </Text>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <Field label={`Type ${project.title} to confirm`}>
            <Input value={typed} autoComplete="off" spellCheck={false} onChange={(e) => setTyped(e.target.value)} disabled={busy} />
          </Field>
        </>
      ) : null}
      {error ? (
        <div role="alert">
          <Text tone="danger">
            <HubText>{error.message}</HubText>
          </Text>
          {error.fix ? (
            <Text as="p" tone="quiet">
              <HubText>{error.fix}</HubText>
            </Text>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
