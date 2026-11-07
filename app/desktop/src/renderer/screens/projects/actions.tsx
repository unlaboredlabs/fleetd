// What a person does to a project from the sidebar's menu and its settings: archive it (with Undo, since it keeps its
// chat, memory and folder) or bring it back, and rename it in a small dialog. Each is one hub call (project_archive,
// project_settings_set); the hub's project.settings event updates the sidebar.
import { useState } from "react";
import type { DataLayer } from "../../src/data/queries";
import { useDataLayer } from "../../src/data/react";
import { Button, Dialog, Field, Input, Text, toast } from "../../ui";
import { HubText } from "./HubText";
import { NAME_MAX, nameProblem, PROJECT_TOOLS } from "./model";

export interface ProjectTarget {
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
}

/** Archives `project` (or, `archived: false`, brings it back), saying so with the way back. */
export async function archiveProject(layer: DataLayer, project: ProjectTarget, archived = true): Promise<boolean> {
  const out = await layer.call(PROJECT_TOOLS.archive, { machineId: project.machineId, projectId: project.projectId, archived });
  if (!out.ok) {
    toast({ title: archived ? `Couldn’t archive ${project.title}` : `Couldn’t bring ${project.title} back`, description: <HubText>{out.error.message}</HubText>, tone: "danger" });
    return false;
  }
  toast({
    key: `project-archive:${project.machineId}/${project.projectId}`,
    title: archived ? `${project.title} archived` : `${project.title} is back`,
    description: archived ? "Its chat, memory and folder stay. Bring it back from Settings › Projects any time." : undefined,
    ...(archived ? { action: { label: "Undo", onClick: () => void archiveProject(layer, project, false) } } : {}),
  });
  return true;
}

export function RenameProjectDialog({ project, onClose }: { project: ProjectTarget | null; onClose: () => void }) {
  const layer = useDataLayer();
  // The box starts at the current name; a key per project resets it.
  return project === null ? <Dialog open={false} title="" /> : <RenameBody key={`${project.machineId}/${project.projectId}`} project={project} layer={layer} onClose={onClose} />;
}

function RenameBody({ project, layer, onClose }: { project: ProjectTarget; layer: DataLayer; onClose: () => void }) {
  const [name, setName] = useState(project.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = nameProblem(name);
  const ready = !busy && problem === undefined && name.trim() !== "" && name.trim() !== project.title;
  const save = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const out = await layer.call("project_settings_set", { machineId: project.machineId, projectId: project.projectId, title: name.trim() });
    setBusy(false);
    if (!out.ok) {
      setError(out.error.message);
      return;
    }
    onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={`Rename ${project.title}`}
      description="Its chat, memory and folder stay as they are; only what fleetd calls it changes."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} onClick={() => void save()}>
            {busy ? "Renaming…" : "Rename"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" error={problem ?? (error === null ? undefined : <HubText>{error}</HubText>)}>
          <Input value={name} maxLength={NAME_MAX + 1} autoFocus autoComplete="off" disabled={busy} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
      {error === null ? null : (
        <Text as="p" size="xs" tone="quiet">
          Nothing changed.
        </Text>
      )}
    </Dialog>
  );
}
