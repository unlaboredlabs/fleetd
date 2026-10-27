// What a person does to a Navi from the sidebar's menu and the Navi screen: archive it (with Undo, since it keeps its
// chat, memory and folder) or bring it back, and rename it in a small dialog. Each is one hub call (navi_archive,
// navi_rename); the hub's project.settings event updates the sidebar.
import { useState } from "react";
import type { DataLayer } from "../../src/data/queries";
import { useDataLayer } from "../../src/data/react";
import { Button, Dialog, Field, Input, Text, toast } from "../../ui";
import { HubText } from "../projects/HubText";
import { NAME_MAX, nameProblem } from "./model";

export interface NaviTarget {
  readonly machineId: string;
  readonly projectId: string;
  readonly title: string;
}

/** Archives `navi` (or, `archived: false`, brings it back), saying so with the way back. */
export async function archiveNavi(layer: DataLayer, navi: NaviTarget, archived = true): Promise<boolean> {
  const out = await layer.call("navi_archive", { machineId: navi.machineId, projectId: navi.projectId, archived });
  if (!out.ok) {
    toast({ title: archived ? `Couldn’t archive ${navi.title}` : `Couldn’t bring ${navi.title} back`, description: <HubText>{out.error.message}</HubText>, tone: "danger" });
    return false;
  }
  toast({
    key: `navi-archive:${navi.machineId}/${navi.projectId}`,
    title: archived ? `${navi.title} archived` : `${navi.title} is back`,
    description: archived ? "Its chat, memory and folder stay. Bring it back from Navi any time." : undefined,
    ...(archived ? { action: { label: "Undo", onClick: () => void archiveNavi(layer, navi, false) } } : {}),
  });
  return true;
}

export function RenameNaviDialog({ navi, onClose }: { navi: NaviTarget | null; onClose: () => void }) {
  const layer = useDataLayer();
  // The box starts at the current name; a key per Navi resets it.
  return navi === null ? <Dialog open={false} title="" /> : <RenameBody key={`${navi.machineId}/${navi.projectId}`} navi={navi} layer={layer} onClose={onClose} />;
}

function RenameBody({ navi, layer, onClose }: { navi: NaviTarget; layer: DataLayer; onClose: () => void }) {
  const [name, setName] = useState(navi.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = nameProblem(name);
  const ready = !busy && problem === undefined && name.trim() !== "" && name.trim() !== navi.title;
  const save = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const out = await layer.call("navi_rename", { machineId: navi.machineId, projectId: navi.projectId, name: name.trim() });
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
      title={`Rename ${navi.title}`}
      description="Its chat, memory and folder stay as they are; only what you call it changes."
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
