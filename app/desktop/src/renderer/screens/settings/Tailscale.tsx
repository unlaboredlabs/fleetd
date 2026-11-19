// Tailscale in Hub › Machines (admins only, as the whole Hub group): the team's tailnet for its hosted sandboxes, as a
// named connection. Connect asks the hub to start its gateway (tailnet_connect) and opens Tailscale's sign-in page it
// answers with; the person signs in and approves the device there, and the row reads the hub's state again until it
// says Connected, with the tailnet's name. Nothing is pasted. Disconnect (tailnet_disconnect) logs the device out of
// the tailnet and deletes its state on the hub. A hub too old for tailnet_get shows nothing.
import { useCallback, useEffect, useState } from "react";
import type { TailnetState } from "../../../shared/contracts";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { Button } from "../../ui";
import { ConfirmRemove, Problem } from "./claudeParts";
import { errorText, useHubCall, useLive } from "./hub";
import { RowMenu, SettingsRow, SettingsSection } from "./parts";
import { canConnect, HINT, lineOf, MACHINES_URL, markLabel, markOf, waiting } from "./tailscaleModel";

const noInput = {};
/** How often the row reads the hub's state while a sign-in is under way. */
const WAIT_MS = 2_000;

/** Reads tailnet_get again and waits for it. */
function useReread() {
  const layer = useDataLayer();
  return useCallback(() => layer.queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "call" && q.queryKey[1] === "tailnet_get" }), [layer]);
}

const open = (url: string) => window.fleetd.openExternal(url);

/** The Network section of Hub › Machines: Tailscale's one row. */
export function TailscaleSection() {
  const live = useLive();
  const read = useToolQuery("tailnet_get", noInput, { enabled: live });
  const reread = useReread();
  const state = read.data;
  // The person signs in on Tailscale's page: the hub's state is read again until it isn't waiting on them.
  useEffect(() => {
    if (!waiting(state)) return;
    const t = setInterval(() => void reread(), WAIT_MS);
    return () => clearInterval(t);
  }, [state, reread]);
  if (state === undefined) return null;
  return (
    <SettingsSection title="Network" reveal="hub.tailscale" data={{ "data-tailscale": state.status }}>
      <TailscaleRow state={state} reread={reread} />
    </SettingsSection>
  );
}

export function TailscaleRow({ state, reread }: { state: TailnetState; reread: () => Promise<unknown> }) {
  const call = useHubCall();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const connect = () => {
    setBusy(true);
    setProblem(null);
    void call("tailnet_connect", noInput, { timeoutMs: 60_000 })
      .then(
        async (s) => {
          if (s.loginUrl === undefined) return;
          const opened = await open(s.loginUrl);
          if (!opened.ok) setProblem(opened.message);
        },
        (e: unknown) => setProblem(`Not connected: ${errorText(e)}`),
      )
      .then(reread)
      .finally(() => setBusy(false));
  };
  const line = lineOf(state);
  const loginUrl = state.loginUrl;
  const control =
    state.status === "connected" ? (
      <RowMenu label="Tailscale" items={[{ label: "Disconnect", onSelect: () => setRemoving(true), danger: true }]} />
    ) : state.status === "login" && loginUrl !== undefined ? (
      <>
        <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void open(loginUrl)}>
          Open sign-in
        </Button>
      </>
    ) : state.status === "approve" ? (
      <>
        <Button size="sm" variant="ghost" onClick={() => setRemoving(true)}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void open(MACHINES_URL)}>
          Open Tailscale
        </Button>
      </>
    ) : state.status === "starting" ? undefined : (
      <Button size="sm" disabled={busy || !canConnect(state)} onClick={connect}>
        {busy ? "Connecting…" : state.status === "failed" ? "Connect again" : "Connect"}
      </Button>
    );
  return (
    <SettingsRow
      mark={markOf(state)}
      markLabel={markLabel(state)}
      title="Tailscale"
      hint={HINT}
      line={line === null ? null : <span role={line.tone === "danger" ? "alert" : "status"}>{line.text}</span>}
      lineTone={line?.tone}
      control={control}
      data={{ "data-tailscale-row": state.status }}
    >
      <Problem text={problem} />
      {removing ? (
        <ConfirmRemove
          title={state.status === "connected" ? "Disconnect Tailscale?" : "Stop connecting Tailscale?"}
          description="The hub logs its device out of your tailnet and deletes its state. Hosted sandboxes lose the tailnet at once."
          action="Disconnect"
          onRemove={() => call("tailnet_disconnect", noInput).then(reread)}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </SettingsRow>
  );
}
