// A hosted sandbox provider's row (boat.dev), as Providers.tsx lists every provider: a ProviderRow whose Connect opens
// its key's sealed field; connected, its limit and a menu with Test and Disconnect. Its dot and one line are its real
// state (shared/hostedRow.ts: Starting…, Ready with how many run, Needs a Claude account, Couldn't start with why and
// its fix), with the one button that fixes it on the line: Connect, Try again or Test again. Connecting checks the key
// at once. The hub's links to hosted sandboxes land here (reveal `hub.sandbox.<provider>`).
import { useCallback, useState } from "react";
import type { SandboxProviderState } from "../../../shared/contracts";
import { ACTION_LABELS, hostedRow, type HostedRow, rowWords, runnerOf } from "../../../shared/hostedRow";
import { useData, useDataLayer } from "../../src/data/react";
import { Button, Select } from "../../ui";
import { navigate } from "../shell/navigation";
import { useHubCall } from "./hub";
import { ConnectKey, ProviderRow, useProviderRun } from "./Provider";
import { canWords, specOf } from "../../../shared/providers";
import type { Mark } from "./parts";
import { limitChoices, providerHint, providerName } from "./sandboxModel";
import s from "./settings.module.css";

/** A Test asks the provider from one of the team's machines (the hub waits up to 45 seconds for one). */
const TEST_TIMEOUT_MS = 60_000;

/** Reads sandbox_get again and waits for it, so a change's answer is on screen as its busy state ends. */
function useReread() {
  const layer = useDataLayer();
  return useCallback(() => layer.queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "call" && q.queryKey[1] === "sandbox_get" }), [layer]);
}

/** One hosted sandbox provider, as Providers.tsx lists it wherever agents run. */
export function SandboxRow({ p, boxPubKey }: { p: SandboxProviderState; boxPubKey: string }) {
  const call = useHubCall();
  const reread = useReread();
  const { hub } = useDataLayer();
  const name = providerName(p.provider);
  const [connecting, setConnecting] = useState(false);
  const { busy, problem, run, setChecked } = useProviderRun(reread);
  // Its runner and its live count and trouble, as the hub pushes them; sandbox_get's where the push has none yet.
  // Each selector picks a stored object, so the value is stable between changes.
  const runner = useData((d) => Object.values(d.machines).find((m) => m.runner === true));
  const live = useData((d) => (d.live.slots ?? d.slots)?.hosted?.find((h) => h.provider === p.provider));
  const state = hostedRow(p, runner === undefined ? undefined : runnerOf([runner]), live);
  const test = () => run("test", () => call("sandbox_test", { provider: p.provider }, { timeoutMs: TEST_TIMEOUT_MS }), "Not tested");
  const act = () => (state.action === "connect" ? navigate({ id: "settings", tab: "accounts" }) : test());
  const words = problem ?? rowWords(state);
  const danger = problem !== null || state.state === "failed";
  return (
    <ProviderRow
      name={name}
      can={canWords(specOf(p.provider))}
      reveal={`hub.sandbox.${p.provider}`}
      hint={providerHint(p.provider)}
      connected={p.connected}
      mark={MARKS[state.state]}
      markLabel={`${name}: ${state.text ?? "not connected"}`}
      line={
        words === null
          ? null
          : {
              node: <span data-line="">{words}</span>,
              tone: danger ? "danger" : state.state === "needs_claude" ? "warning" : "quiet",
              ...(state.action === undefined || problem !== null
                ? {}
                : {
                    action: (
                      <Button size="sm" variant="secondary" disabled={busy !== null} onClick={act}>
                        {ACTION_LABELS[state.action]}
                      </Button>
                    ),
                  }),
            }
      }
      setting={
        <Select
          aria-label={`Agents at once in ${name}`}
          className={s.sandboxLimit}
          value={String(p.limit)}
          options={limitChoices(p.limit)}
          disabled={busy !== null}
          onValueChange={(v) => run("set", () => call("sandbox_set", { provider: p.provider, limit: Number(v) }), "Not changed")}
        />
      }
      busy={busy}
      onTest={test}
      onDisconnect={() => run("disconnect", () => call("sandbox_disconnect", { provider: p.provider }), "Not disconnected")}
      connecting={connecting}
      onConnect={() => setConnecting(true)}
      form={
        <ConnectKey
          name={name}
          seal={(key) => window.fleetd.secret.sandboxKey(hub, { boxPubKey, provider: p.provider, key })}
          reread={reread}
          onCancel={() => setConnecting(false)}
          onDone={() => {
            setConnecting(false);
            setChecked(true);
          }}
        />
      }
      data={{ "data-sandbox": p.provider, "data-sandbox-state": p.connected ? "connected" : "off", "data-hosted-state": state.state }}
    />
  );
}

/** The row's dot by its state: neutral while ready, a ring while it starts, amber while it needs someone, red when it
 * can't start. */
const MARKS: Readonly<Record<HostedRow["state"], Mark>> = { off: "off", starting: "starting", ready: "ready", needs_claude: "needs", failed: "failed" };
