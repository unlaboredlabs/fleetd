// New workspace (W901): the switcher's last item makes an empty fleetd cloud workspace of the person's own, its own
// address, members, bots, plan and credits, asked on one of their cloud workspaces (fleetd cloud's POST
// ACCOUNTS_WORKSPACES_PATH: the key there only says who asks). A name, or none for the cloud's own; then it opens on its
// Get started, as a first sign-up's does. The cloud's refusals (the most one person may make, too many new ones from
// this address) are shown as written, with what to do.
import { useState } from "react";
import { Button, Dialog, Field, Input, Text } from "../../ui";
import { useHubSet } from "../../src/data/react";
import { startScreen } from "../start/kept";
import { navigate, setRouteHubs } from "./navigation";
import { showHub } from "./sidebarLayout";
import { WORKSPACE_NAME_MAX } from "./workspaceAsk";

export { askedOn, WORKSPACE_NAME_MAX } from "./workspaceAsk";

export function NewWorkspaceDialog({ from, open, onClose }: { from: string; open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; fix?: string | undefined } | null>(null);
  const set = useHubSet();
  // Made: opened once this window lists it (main's list follows its answer), so the route names it among the hubs.
  const opened = (hub: string) => {
    const listed = (hubs: ReadonlyArray<{ readonly id: string }>) => hubs.some((h) => h.id === hub);
    const go = (hubs: ReadonlyArray<{ readonly id: string }>) => {
      // As the shell will set them on its next render (navigation.ts hashFor names a hub only among several).
      setRouteHubs(hubs.map((h) => h.id));
      // The route first, as openHub does, so the sidebar's switch draws the new workspace's Get started beside it.
      navigate(startScreen(hub));
      showHub(hub);
    };
    if (set === undefined) return;
    if (listed(set.getState().hubs)) return go(set.getState().hubs);
    const off = set.subscribe(({ hubs }) => {
      if (!listed(hubs)) return;
      off();
      go(hubs);
    });
  };
  const long = name.trim().length > WORKSPACE_NAME_MAX;

  const close = () => {
    setName("");
    setError(null);
    setBusy(false);
    onClose();
  };

  const make = async () => {
    if (busy || long) return;
    setBusy(true);
    setError(null);
    const out = await window.fleetd.cloud.newWorkspace(from, name);
    if (!out.ok) {
      setBusy(false);
      setError({ message: out.failure.message, fix: out.failure.fix });
      return;
    }
    close();
    opened(out.hub);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
      title="New workspace"
      description="An empty workspace of your own on fleetd cloud, with its own address, members, bots, plan and credits."
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || long} onClick={() => void make()}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void make();
        }}
      >
        <Field label="Name" error={long ? `${String(WORKSPACE_NAME_MAX)} characters at most.` : undefined}>
          <Input value={name} autoFocus autoComplete="off" placeholder="Side project" onChange={(e) => setName(e.target.value)} disabled={busy} />
        </Field>
      </form>
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
