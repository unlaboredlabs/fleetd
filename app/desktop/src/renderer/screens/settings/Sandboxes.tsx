// A hosted sandbox provider's row (E2B, boat.dev, Daytona), as Providers.tsx lists every provider: a ProviderRow
// whose Connect opens its key's sealed field (and for E2B a self-hosted domain); connected, its limit and a menu with
// Test and Disconnect. Connecting checks the key at once, and the row says what the check found.
import { useCallback, useState } from "react";
import type { SandboxProviderState } from "../../../shared/contracts";
import { useDataLayer } from "../../src/data/react";
import { Select, Text } from "../../ui";
import { useHubCall } from "./hub";
import { ConnectKey, ProviderRow, useProviderRun } from "./Provider";
import { canWords, specOf } from "../../../shared/providers";
import { limitChoices, providerHint, providerLine, providerName, takesDomain, withFix } from "./sandboxModel";
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
  const { busy, checked, problem, run, setChecked } = useProviderRun(reread);
  const line = problem === null ? providerLine(p, checked) : { text: problem, tone: "danger" as const };
  const failed = p.connected && p.check !== undefined && !p.check.ok;
  return (
    <ProviderRow
      name={name}
      can={canWords(specOf(p.provider))}
      reveal={`hub.sandbox.${p.provider}`}
      hint={providerHint(p.provider)}
      connected={p.connected}
      mark={!p.connected ? "off" : failed ? "failed" : "ready"}
      line={
        line === null
          ? null
          : "domain" in line
            ? // A self-hosted E2B's domain, as it is typed: machine text, shown as such.
              { node: <Text mono size="sm" tone="quiet">{line.text}</Text> }
            : { node: <span role={line.tone === "danger" ? "alert" : "status"}>{withFix(line)}</span>, tone: line.tone }
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
      onTest={() => run("test", () => call("sandbox_test", { provider: p.provider }, { timeoutMs: TEST_TIMEOUT_MS }), "Not tested")}
      onDisconnect={() => run("disconnect", () => call("sandbox_disconnect", { provider: p.provider }), "Not disconnected")}
      connecting={connecting}
      onConnect={() => setConnecting(true)}
      form={
        <ConnectKey
          name={name}
          domain={takesDomain(p.provider)}
          seal={(key, domain) => window.fleetd.secret.sandboxKey(hub, { boxPubKey, provider: p.provider, key, ...(domain === undefined ? {} : { domain }) })}
          reread={reread}
          onCancel={() => setConnecting(false)}
          onDone={() => {
            setConnecting(false);
            setChecked(true);
          }}
        />
      }
      data={{ "data-sandbox": p.provider, "data-sandbox-state": p.connected ? "connected" : "off" }}
    />
  );
}
