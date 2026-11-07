// Deleting a project: project_remove stops its claude processes and erases it. Settings → Projects opens it, one rule
// for every project (D287): the name typed to confirm, everything
// fleetd keeps for it erased with its fleetd worktrees (`removeWorktrees`), and a tickbox, off by default, naming its
// folder that deletes the folder too (`removeFolder`). Its branches and pull requests stay either way. The phone's
// sheet says the same words (projects/model.ts `deleteWords`).
// A project whose machine the hub no longer has (a fresh snapshot lacks it) has no files on any machine to keep or
// remove: its dialog only forgets it in fleetd, which the hub does without a node.

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
  const gone = useData((d) => project !== null && d.fresh && d.machines[project.machineId] === undefined);
  // Every project's removal erases it now: without a worktree list (a caller that has none), the delete says so all the same.
  const deleting = gone || project === null ? undefined : (project.deleting ?? { unsaved: [] });

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
      {
        machineId: p.machineId,
        projectId: p.projectId,
        ...(gone ? {} : { removeWorktrees: true }),
        ...(!gone && folderToo ? { removeFolder: true } : {}),
      },
      { timeoutMs: REMOVE_MS },
    );
    setBusy(false);
    if (!out.ok) {
      setError(out.error.fix ? { message: out.error.message, fix: out.error.fix } : { message: out.error.message });
      return;
    }
    close();
    onRemoved?.();
    if (gone) {
      toast({ title: `${p.title} forgotten`, description: `${machine} is no longer in this hub, so fleetd no longer lists it.` });
      return;
    }
    if (folderToo) {
      toast({ title: `${p.title} deleted`, description: `Its folder is gone from ${machine} too.` });
      return;
    }
    // Its folder is still there, so a new project can start in it again: as a new one, with nothing it had.
    toast({
      title: `${p.title} deleted`,
      description: p.deleting?.plain === false ? `Its checkout and branches stay on ${machine}.` : `Its folder stays on ${machine}.`,
      action: { label: "Add the folder again", onClick: () => openAddProject({ text: p.path, machine: p.machineId }) },
    });
  };

  const ready = project !== null && (!deleting || deleteConfirmed(typed, project.title));
  return (
    <Dialog
      open={project !== null}
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
      title={project ? (gone ? `Forget ${project.title}?` : `Delete ${project.title}?`) : ""}
      description={
        gone
          ? `${machine} is no longer in this hub, so no machine holds its files. This only forgets the project, its chat and its settings in fleetd.`
          : deleting && project
            ? `${deleteWords(project.title, machine, tilde(project.path)).message}${deleting.plain === false ? " The worktrees its agents worked in are removed; its branches and pull requests stay." : ""}`
            : ""
      }
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || !ready} onClick={() => project && void remove(project)}>
            {busy ? (gone ? "Forgetting…" : "Deleting…") : gone ? "Forget project" : "Delete project"}
          </Button>
        </>
      }
    >
      {deleting && project ? (
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
