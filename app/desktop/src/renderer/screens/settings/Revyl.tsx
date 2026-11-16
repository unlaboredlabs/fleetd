// The team's own Revyl account, in Hub › Machines › Screens (admins only, as the whole Hub group): one row to connect
// its API key, test it and disconnect it, then where each phone kind's agent screens run. The key goes to main, which
// seals it to the hub's own key (main/secret.ts) and calls revyl_connect: it never reaches the hub in the clear and is
// never shown again. Connecting checks it at once, and the row says what the check found. Each kind's choice is
// revyl_route_set; before a key is connected the Revyl choices stay listed but off, and the row says why, with
// Connect right there. A hub too old for revyl_get shows none of it.
import { useCallback, useState } from "react";
import type { RevylKind, RevylRoute, RevylState } from "../../../shared/contracts";
import { lacksTool } from "../../src/data/errors";
import { CallError } from "../../src/data/queries";
import { useDataLayer, useToolQuery } from "../../src/data/react";
import { Button, cx, Input, Select, Text } from "../../ui";
import { useHubRole } from "../admin/role";
import { errorText, useHubCall, useLive } from "./hub";
import { GroupNote, SettingsRow } from "./parts";
import { keyOf, REVYL_KINDS, revylLine, routeChoices, routeOffLine } from "./revylModel";
import s from "./settings.module.css";

const noInput = {};

/** A Test may first install Revyl's CLI on the machine it runs on (the hub waits up to 2.75 minutes for one). */
const TEST_TIMEOUT_MS = 180_000;

const HINT = "Phone screens from your team's own Revyl account, which Revyl bills. The key is sealed and never shown again.";

/** Reads revyl_get again and waits for it, so a change's answer is on screen as its busy state ends. */
function useReread() {
  const layer = useDataLayer();
  return useCallback(() => layer.queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "call" && q.queryKey[1] === "revyl_get" }), [layer]);
}

/** The Revyl row and the two kinds' choices, as rows of the Screens section; nothing on a hub without them. */
export function RevylScreens() {
  const live = useLive();
  const read = useToolQuery("revyl_get", noInput, { enabled: live });
  const [connecting, setConnecting] = useState(false);
  if (read.error instanceof CallError && lacksTool(read.error.error)) return null;
  if (read.error) return <GroupNote tone="danger">{`Couldn't read Revyl's settings: ${errorText(read.error)}`}</GroupNote>;
  if (read.data === undefined) return null;
  const state = read.data;
  return (
    <>
      <RevylRow state={state} connecting={connecting} setConnecting={setConnecting} />
      {REVYL_KINDS.map(({ kind, label }) => (
        <RouteRow key={kind} kind={kind} label={label} state={state} onConnect={() => setConnecting(true)} />
      ))}
    </>
  );
}

function RevylRow({ state, connecting, setConnecting }: { state: RevylState; connecting: boolean; setConnecting: (on: boolean) => void }) {
  const call = useHubCall();
  const reread = useReread();
  const [busy, setBusy] = useState<"test" | "disconnect" | null>(null);
  const [checked, setChecked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = (what: "test" | "disconnect") => {
    setBusy(what);
    setProblem(null);
    setChecked(false);
    void (what === "test" ? call("revyl_test", noInput, { timeoutMs: TEST_TIMEOUT_MS }) : call("revyl_disconnect", noInput))
      .then(
        () => setChecked(what === "test"),
        (e: unknown) => setProblem(`${what === "test" ? "Not tested" : "Not disconnected"}: ${errorText(e)}`),
      )
      .then(reread)
      .finally(() => setBusy(null));
  };
  const line = problem === null ? revylLine(state, checked) : { text: problem, tone: "danger" as const };
  const fix = line?.tone === "danger" && "fix" in line ? line.fix : undefined;
  const control = state.connected ? (
    <div className={s.inline}>
      <Button size="sm" disabled={busy !== null} onClick={() => run("test")}>
        {busy === "test" ? "Testing…" : "Test"}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => run("disconnect")}>
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
      reveal="hub.revyl"
      title="Revyl"
      hint={HINT}
      line={line === null ? null : <span role={line.tone === "danger" ? "alert" : "status"}>{fix === undefined ? line.text : `${line.text} ${fix.charAt(0).toUpperCase()}${fix.slice(1)}`}</span>}
      lineTone={line?.tone}
      control={control}
      data={{ "data-revyl": state.connected ? "connected" : "off" }}
    >
      {connecting && !state.connected ? (
        <ConnectKey
          boxPubKey={state.boxPubKey}
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

/** The key's one field, its characters shown as dots, with Connect and Cancel. What was typed goes to main only. */
function ConnectKey(props: { boxPubKey: string; onCancel: () => void; onDone: () => void }) {
  const { hub } = useDataLayer();
  const reread = useReread();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = keyOf(key);
  const submit = async () => {
    if (typed === null || busy) return;
    setBusy(true);
    setError(null);
    const out = await window.fleetd.secret.revylKey(hub, { boxPubKey: props.boxPubKey, key: typed });
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
      aria-label="Connect Revyl"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        mono
        aria-label="Revyl API key"
        className={cx(s.secretValue, s.keyField)}
        data-secret=""
        value={key}
        placeholder="Revyl API key"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        disabled={busy}
        onChange={(e) => setKey(e.target.value)}
      />
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

/** Where one kind's agent screens run: our machines, Revyl, or ours first. Revyl's choices say why they're off. */
function RouteRow({ kind, label, state, onConnect }: { kind: RevylKind; label: string; state: RevylState; onConnect: () => void }) {
  const call = useHubCall();
  const reread = useReread();
  // The page is the Hub group's, so an admin's until the hub says otherwise: no member's words while it is asked.
  const role = useHubRole();
  const admin = role.administers || role.pending;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const off = routeOffLine(state.connected, admin);
  const route = state.routes[kind];
  const set = (next: RevylRoute) => {
    setBusy(true);
    setProblem(null);
    void call("revyl_route_set", { kind, route: next })
      .then(
        () => undefined,
        (e: unknown) => setProblem(`Not changed: ${errorText(e)}`),
      )
      .then(reread)
      .finally(() => setBusy(false));
  };
  const line =
    problem !== null ? (
      <span role="alert">{problem}</span>
    ) : off === null ? null : (
      <>
        {`${off} `}
        {admin ? (
          <Button variant="link" size="sm" onClick={onConnect}>
            Connect Revyl
          </Button>
        ) : null}
      </>
    );
  return (
    <SettingsRow
      title={label}
      line={line}
      lineTone={problem === null ? "quiet" : "danger"}
      data={{ "data-revyl-route": kind }}
      control={
        <Select
          aria-label={`Where ${label} screens run`}
          className={s.routeChoice}
          value={route}
          options={routeChoices(state.connected, route)}
          disabled={busy}
          onValueChange={set}
        />
      }
    />
  );
}
