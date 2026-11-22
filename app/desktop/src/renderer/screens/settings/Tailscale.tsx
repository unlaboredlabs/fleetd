// Tailscale's state and Connect (useTailnet), the team's route to its tailnet: Connections' Tailscale row
// (connections/ConnectionsSheet.tsx) and the Claude key's endpoint field (TailnetHint) use the same one. Connect asks
// the hub to start its gateway (tailnet_connect) and opens Tailscale's sign-in page it answers with; the person signs
// in and approves the device there, and the state is read again until it says connected. A hub too old for
// tailnet_get shows nothing.
import { useCallback, useEffect, useState } from "react";
import { tailnetLine } from "../../../shared/claudeEndpoint";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, Text } from "../../ui";
import { Problem } from "./claudeParts";
import { errorText, useHubCall, useLive } from "./hub";
import { canConnect, MACHINES_URL, waiting } from "./tailscaleModel";
import s from "./settings.module.css";

const noInput = {};
/** How often the row reads the hub's state while a sign-in is under way. */
const WAIT_MS = 2_000;

/** Reads tailnet_get again and waits for it. */
function useReread() {
  const layer = useDataLayer();
  return useCallback(() => layer.queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "call" && q.queryKey[1] === "tailnet_get" }), [layer]);
}

const open = (url: string) => window.fleetd.openExternal(url);

/**
 * The hub's Tailscale state, read again while a sign-in is under way, and its Connect: undefined state from a hub that
 * doesn't serve it (too old, or one with no gateway), which then shows nothing of it.
 */
export function useTailnet(enabled = true) {
  const live = useLive();
  const read = useToolQuery("tailnet_get", noInput, { enabled: live && enabled });
  const reread = useReread();
  const call = useHubCall();
  const state = read.data;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The person signs in on Tailscale's page: the hub's state is read again until it isn't waiting on them.
  useEffect(() => {
    if (!waiting(state)) return;
    const t = setInterval(() => void reread(), WAIT_MS);
    return () => clearInterval(t);
  }, [state, reread]);
  const connect = useCallback(() => {
    setBusy(true);
    setProblem(null);
    // As long as the hub can take: a first Connect downloads Tailscale (2 min at most), starts it and waits for its page.
    void call("tailnet_connect", noInput, { timeoutMs: 180_000 })
      .then(
        async (st) => {
          if (st.loginUrl === undefined) return;
          const opened = await open(st.loginUrl);
          if (!opened.ok) setProblem(opened.message);
        },
        (e: unknown) => setProblem(`Not connected: ${errorText(e)}`),
      )
      .then(reread)
      .finally(() => setBusy(false));
  }, [call, reread]);
  return { state, reread, connect, busy, problem };
}

export type Tailnet = ReturnType<typeof useTailnet>;

/**
 * Beside a Claude endpoint on the tailnet while Tailscale isn't connected: one line that says so, and Connect, the fix,
 * right there (a hub that serves no Tailscale says nothing). Connected, or another endpoint: nothing.
 */
export function TailnetHint({ endpoint, tailnet }: { endpoint: string; tailnet: Tailnet }) {
  const { state, connect, busy, problem } = tailnet;
  const line = state === undefined ? null : tailnetLine(endpoint, state.status === "connected");
  if (line === null || state === undefined) return null;
  const pending = waiting(state);
  return (
    <div className={s.stack} data-tailnet-hint={state.status}>
      <span role="status">
        <Text size="sm" tone="warning">
          {pending ? `${line} Finish signing in to Tailscale.` : line}
        </Text>
      </span>
      <span className={s.inline}>
        {state.status === "login" && state.loginUrl !== undefined ? (
          <Button size="sm" onClick={() => void open(state.loginUrl ?? "")}>
            Open sign-in
          </Button>
        ) : state.status === "approve" ? (
          <Button size="sm" onClick={() => void open(MACHINES_URL)}>
            Open Tailscale
          </Button>
        ) : pending ? null : canConnect(state) ? (
          <Button size="sm" disabled={busy} onClick={connect}>
            {busy ? "Connecting…" : "Connect Tailscale"}
          </Button>
        ) : (
          // Off where it can't run: why, so the button isn't simply missing.
          <Text size="sm" tone="quiet">
            {state.problem ?? ""}
          </Text>
        )}
      </span>
      <Problem text={problem} />
    </div>
  );
}
