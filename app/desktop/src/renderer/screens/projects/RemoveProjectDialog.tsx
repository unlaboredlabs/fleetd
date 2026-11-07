// Removing a project: project_remove stops its claude processes and forgets it; its files, branches and worktrees
// stay. Settings → Projects opens it to delete: the name typed to confirm, and its fleetd worktrees removed too (`removeWorktrees`), never its checkout, branches or PRs. A
// plain folder has none of those: its delete says only that its agents stop, fleetd forgets it, and its folder stays.
// A Navi's delete erases it (D287 navi.delete-erases), with a tickbox naming its folder that deletes the folder too
// (`removeFolder`); the phone's sheet says the same words (`naviDeleteWords`).
// A project whose machine the hub no longer has (a fresh snapshot lacks it) has no files on any machine to keep or
// remove: its dialog only forgets it in fleetd, which the hub does without a node.

import { useState } from "react";
import { Button, Checkbox, Dialog, Field, Input, Text, toast } from "../../ui";
import { useData, useDataLayer } from "../../src/data/react";
import { HubText } from "./HubText";
import { naviDeleteWords } from "../navi/model";
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
   * A delete: its worktrees go too, once its name is typed. `unsaved` are those holding uncommitted changes; `plain`
   * is a project that is a folder rather than a git repo (a Navi's), with no checkout, branches or pull requests.
   */
  readonly deleting?: {
    readonly unsaved: ReadonlyArray<{ readonly path: string; readonly branch?: string | undefined }>;
    readonly plain?: boolean;
    /** A Navi: everything it had is erased, and its folder too when ticked. */
    readonly navi?: boolean;
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
  const deleting = gone ? undefined : project?.deleting;

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
    const navi = !gone && p.deleting?.navi === true;
    const out = await data.call(
      "project_remove",
      {
        machineId: p.machineId,
        projectId: p.projectId,
        ...(p.deleting && !gone ? { removeWorktrees: true } : {}),
        ...(navi && folderToo ? { removeFolder: true } : {}),
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
    if (navi) {
      toast({ title: `${p.title} deleted`, description: folderToo ? `Its folder is gone from ${machine} too.` : `Its folder stays on ${machine}.` });
      return;
    }
    // The way back in: the folder is still there, so adding it again is one click.
    toast({
      title: p.deleting ? `${p.title} deleted from fleetd` : `${p.title} removed from ${machine}`,
      description: p.deleting
        ? p.deleting.plain
          ? `Its folder stays on ${machine}.`
          : `Its checkout and branches stay on ${machine}.`
        : "Its files, branches and worktrees stay.",
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
      title={project ? (gone ? `Forget ${project.title}?` : deleting ? `Delete ${project.title}?` : `Remove ${project.title} from ${machine}?`) : ""}
      description={
        gone
          ? `${machine} is no longer in this hub, so no machine holds its files. This only forgets the project, its chat and its settings in fleetd.`
          : deleting && project
          ? deleting.navi
            ? naviDeleteWords(project.title, machine, tilde(project.path)).message
            : deleting.plain
            ? `Its agents stop now and fleetd forgets it and its settings. Its folder at ${project.path} stays as it is, with everything in it.`
            : `Its agents stop now, fleetd forgets it and its settings, and the worktrees its agents worked in are removed. Its checkout at ${project.path}, its branches and its pull requests stay as they are.`
          : "Its agents stop now. Its files, branches and worktrees stay on the machine; you can add the folder again any time."
      }
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || !ready} onClick={() => project && void remove(project)}>
            {busy
              ? gone
                ? "Forgetting…"
                : deleting
                  ? "Deleting…"
                  : "Removing…"
              : gone
                ? "Forget project"
                : deleting
                  ? deleting.navi
                    ? "Delete Navi"
                    : "Delete project"
                  : "Remove project"}
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
          {deleting.navi ? (
            <Checkbox
              checked={folderToo}
              onCheckedChange={(on) => setFolderToo(on === true)}
              disabled={busy}
              label={naviDeleteWords(project.title, machine, tilde(project.path)).folder}
              description={naviDeleteWords(project.title, machine, tilde(project.path)).folderNote}
            />
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
