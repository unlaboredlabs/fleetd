// Removing a project: project_remove stops its claude processes and forgets it; its files, branches and worktrees
// stay. Settings → Projects opens it to delete, one rule for every project (D287): the name typed to confirm, everything
// fleetd keeps for it erased with its fleetd worktrees (`removeWorktrees`), and a tickbox, off by default, naming its
// folder that deletes the folder too (`removeFolder`). Its branches and pull requests stay either way. The phone's
// sheet says the same words (projects/model.ts `deleteWords`).

import { useState } from "react";
import { Button, Checkbox, Dialog, Field, Input, Text, toast } from "../../ui";
import { useData, useDataLayer } from "../../src/data/react";
import { HubText } from "./HubText";
import { deleteWords } from "./model";
import { tilde } from "./source";
import { openAddProject } from "./store";

/** The hub gives the node 70 s: it stops the project's processes and browser, then removes it. */
const REMOVE_MS = 80_000;

export interface RemoveTarget {
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
  readonly path: string;
  /**
   * A delete: everything fleetd keeps for it is erased and its worktrees go too, once its name is typed, and its
   * folder when ticked. `unsaved` are the worktrees holding uncommitted changes; `plain` is a project that is a folder
   * rather than a git repo, with no branches or pull requests.
   */
  readonly deleting?: {
    readonly unsaved: ReadonlyArray<{ readonly path: string; readonly branch?: string | undefined }>;
    readonly plain?: boolean;
  };
}


/** The delete's confirm: the project's name exactly, around spaces. */
export const deleteConfirmed = (typed: string, title: string): boolean => typed.trim() === title.trim() && title.trim() !== "";

export function RemoveProjectDialog({ project, onClose, onRemoved }: { project: RemoveTarget | null; onClose: () => void; onRemoved?: () => void }) {
  const data = useDataLayer();
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [folderToo, setFolderToo] = useState(false);
  const [error, setError] = useState<{ message: string; fix?: string } | null>(null);
  const machine = useData((d) => (project ? (d.machines[project.machineId]?.name ?? project.machineId) : ""));
  const deleting = project?.deleting;

  const close = () => {
    setBusy(false);
    setError(null);
    setTyped("");
    setFolderToo(false);
    onClose();
  };

  const remove = async (p: RemoveTarget) => {
    setBusy(true);
    setError(null);
    const out = await data.call(
      "project_remove",
      { machineId: p.machineId, projectId: p.projectId, ...(p.deleting ? { removeWorktrees: true } : {}), ...(p.deleting && folderToo ? { removeFolder: true } : {}) },
      { timeoutMs: REMOVE_MS },
    );
    setBusy(false);
    if (!out.ok) {
      setError(out.error.fix ? { message: out.error.message, fix: out.error.fix } : { message: out.error.message });
      return;
    }
    close();
    onRemoved?.();
    if (p.deleting && folderToo) {
      toast({ title: `${p.title} deleted`, description: `Its folder is gone from ${machine} too.` });
      return;
    }
    // The way back in: the folder is still there, so adding it again is one click.
    toast({
      title: p.deleting ? `${p.title} deleted` : `${p.title} removed from ${machine}`,
      description: p.deleting ? (p.deleting.plain ? `Its folder stays on ${machine}.` : `Its checkout and branches stay on ${machine}.`) : "Its files, branches and worktrees stay.",
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
          ? `${deleteWords(project.title, machine, tilde(project.path)).message}${deleting.plain ? "" : " The worktrees its agents worked in are removed; its branches and pull requests stay."}`
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
          <Checkbox
            checked={folderToo}
            onCheckedChange={(on) => setFolderToo(on === true)}
            disabled={busy}
            label={deleteWords(project.title, machine, tilde(project.path)).folder}
            description={deleteWords(project.title, machine, tilde(project.path)).folderNote}
          />
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
