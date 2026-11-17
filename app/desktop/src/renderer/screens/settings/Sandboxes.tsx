// The team's own hosted sandbox accounts, in Hub › Machines (admins only, as the whole Hub group): one section, a row
// per provider (E2B, boat.dev, Daytona) in the order agents go to the connected ones once a machine's own slots are
// full. A row connects the provider's API key (and for E2B a self-hosted domain), then sets its limit, tests it and
// disconnects it. The key goes to main, which seals it to the hub's own key (main/secret.ts) and calls sandbox_connect:
// it never reaches the hub in the clear and is never shown again. Connecting checks it at once, and the row says what
// the check found. A hub too old for sandbox_get shows none of it.
import { useCallback, useState } from "react";
import type { SandboxProvider, SandboxProviderState, SandboxState } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, cx, Input, Select, Text } from "../../ui";
import { errorText, useHubCall, useLive } from "./hub";
import { GroupNote, SettingsRow, SettingsSection } from "./parts";
import { domainOf, keyOf, limitChoices, notPlacingLine, orderLine, providerHint, providerLine, providerName, SECTION_HINT, takesDomain, withFix } from "./sandboxModel";
import s from "./settings.module.css";

const noInput = {};

/** A Test asks the provider from one of the team's machines (the hub waits up to 45 seconds for one). */
const TEST_TIMEOUT_MS = 60_000;

/** Reads sandbox_get again and waits for it, so a change's answer is on screen as its busy state ends. */
function useReread() {
  const layer = useDataLayer();
  return useCallback(() => layer.queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "call" && q.queryKey[1] === "sandbox_get" }), [layer]);
}

/** The Sandboxes section; nothing on a hub without it. */
export function Sandboxes() {
  const live = useLive();
  const read = useToolQuery("sandbox_get", noInput, { enabled: live });
  if (read.error instanceof CallError && lacksTool(read.error.error)) return null;
  const body = read.error ? (
    <GroupNote tone="danger">{`Couldn't read the sandbox settings: ${errorText(read.error)}`}</GroupNote>
  ) : read.data === undefined ? null : (
    <SandboxRows state={read.data} />
  );
  return (
    <SettingsSection title="Sandboxes" reveal="hub.sandboxes" hint={SECTION_HINT} data={{ "data-sandboxes": "" }}>
      {body}
    </SettingsSection>
  );
}

function SandboxRows({ state }: { state: SandboxState }) {
  const notes = [notPlacingLine(state), orderLine(state.providers)].filter((l): l is string => l !== null);
  return (
    <>
      {notes.length === 0 ? null : <GroupNote>{notes.join(" ")}</GroupNote>}
      {state.providers.map((p) => (
        <ProviderRow key={p.provider} p={p} boxPubKey={state.boxPubKey} />
      ))}
    </>
  );
}

function ProviderRow({ p, boxPubKey }: { p: SandboxProviderState; boxPubKey: string }) {
  const call = useHubCall();
  const reread = useReread();
  const name = providerName(p.provider);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<"test" | "disconnect" | "limit" | null>(null);
  const [checked, setChecked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = (what: "test" | "disconnect" | "limit", go: () => Promise<unknown>, failed: string) => {
    setBusy(what);
    setProblem(null);
    setChecked(false);
    void go()
      .then(
        () => setChecked(what === "test"),
        (e: unknown) => setProblem(`${failed}: ${errorText(e)}`),
      )
      .then(reread)
      .finally(() => setBusy(null));
  };
  const line = problem === null ? providerLine(p, checked) : { text: problem, tone: "danger" as const };
  const control = p.connected ? (
    <div className={s.inline}>
      <Select
        aria-label={`Agents at once in ${name}`}
        className={s.sandboxLimit}
        value={String(p.limit)}
        options={limitChoices(p.limit)}
        disabled={busy !== null}
        onValueChange={(v) => run("limit", () => call("sandbox_set", { provider: p.provider, limit: Number(v) }), "Not changed")}
      />
      <Button size="sm" disabled={busy !== null} onClick={() => run("test", () => call("sandbox_test", { provider: p.provider }, { timeoutMs: TEST_TIMEOUT_MS }), "Not tested")}>
        {busy === "test" ? "Testing…" : "Test"}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run("disconnect", () => call("sandbox_disconnect", { provider: p.provider }), "Not disconnected")}>
        {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
      </Button>
    </div>
  ) : connecting ? undefined : (
    <Button size="sm" onClick={() => setConnecting(true)}>
      Connect…
    </Button>
  );
  return (
    <SettingsRow
      reveal={`hub.sandbox.${p.provider}`}
      title={name}
      hint={providerHint(p.provider)}
      line={
        line === null ? null : "domain" in line ? (
          // A self-hosted E2B's domain, as it is typed: machine text, shown as such.
          <Text mono size="sm" tone="quiet">
            {line.text}
          </Text>
        ) : (
          <span role={line.tone === "danger" ? "alert" : "status"}>{withFix(line)}</span>
        )
      }
      lineTone={line?.tone}
      control={control}
      data={{ "data-sandbox": p.provider, "data-sandbox-state": p.connected ? "connected" : "off" }}
    >
      {connecting && !p.connected ? (
        <ConnectKey
          provider={p.provider}
          boxPubKey={boxPubKey}
          onCancel={() => setConnecting(false)}
          onDone={() => {
            setConnecting(false);
            setChecked(true);
          }}
        />
      ) : null}
    </SettingsRow>
  );
}

/** The key's field, its characters shown as dots, E2B's domain beside it, with Connect and Cancel. */
function ConnectKey(props: { provider: SandboxProvider; boxPubKey: string; onCancel: () => void; onDone: () => void }) {
  const { hub } = useDataLayer();
  const reread = useReread();
  const name = providerName(props.provider);
  const [key, setKey] = useState("");
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = keyOf(key);
  const submit = async () => {
    if (typed === null || busy) return;
    setBusy(true);
    setError(null);
    const d = takesDomain(props.provider) ? domainOf(domain) : undefined;
    const out = await window.fleetd.secret.sandboxKey(hub, { boxPubKey: props.boxPubKey, provider: props.provider, key: typed, ...(d === undefined ? {} : { domain: d }) });
    if (!out.ok) {
      setBusy(false);
      setError(out.error.fix === undefined ? out.error.message : `${out.error.message} ${out.error.fix}`);
      return;
    }
    setKey("");
    await reread();
    setBusy(false);
    props.onDone();
  };
  return (
    <form
      className={s.inline}
      aria-label={`Connect ${name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        mono
        aria-label={`${name} API key`}
        className={cx(s.secretValue, s.keyField)}
        data-secret=""
        value={key}
        placeholder={`${name} API key`}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        disabled={busy}
        onChange={(e) => setKey(e.target.value)}
      />
      {takesDomain(props.provider) ? (
        <Input
          aria-label="Self-hosted E2B domain"
          className={s.domainField}
          value={domain}
          placeholder="Domain, if self-hosted"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setDomain(e.target.value)}
        />
      ) : null}
      <Button type="submit" size="sm" variant="primary" disabled={typed === null || busy}>
        {busy ? "Connecting…" : "Connect"}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={props.onCancel}>
        Cancel
      </Button>
      {error === null ? null : (
        <span role="alert" className={s.keyError}>
          <Text size="sm" tone="danger">
            {error}
          </Text>
        </span>
      )}
    </form>
  );
}
