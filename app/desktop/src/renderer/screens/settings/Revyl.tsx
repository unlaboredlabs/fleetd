// The team's own Revyl account in Hub › Machines (admins only, as the whole Hub group): its row of Providers
// (Provider.tsx) to connect its API key, test it and disconnect it, and each phone kind's row of What runs where. The
// key goes to main, which seals it to the hub's own key (main/secret.ts) and calls revyl_connect: it never reaches the
// hub in the clear and is never shown again. Connecting checks it at once, and the row says what the check found. A
// kind's route is revyl_route_set, a choice while Revyl is connected (or its route still names Revyl); a member is
// told whom to ask. A hub too old for revyl_get shows none of it.
import { useCallback, useState } from "react";
import type { RevylKind, RevylRoute, RevylState } from "../../../shared/contracts";
import { useDataLayer } from "../../src/data/react";
import { Select } from "../../ui";
import { useHubRole } from "../admin/role";
import { errorText, useHubCall } from "./hub";
import { SettingsRow } from "./parts";
import { ConnectKey, ProviderRow, useProviderRun } from "./Provider";
import { canWords, specOf } from "../../../shared/providers";
import { revylLine, routeChoices, routeOffLine } from "./revylModel";
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

/** The team's own Revyl, as Providers.tsx lists every provider. */
export function RevylRow({ state }: { state: RevylState }) {
  const [connecting, setConnecting] = useState(false);
  const call = useHubCall();
  const reread = useReread();
  const { hub } = useDataLayer();
  const { busy, checked, problem, run, setChecked } = useProviderRun(reread);
  const line = problem === null ? revylLine(state, checked) : { text: problem, tone: "danger" as const };
  const fix = line?.tone === "danger" && "fix" in line ? line.fix : undefined;
  return (
    <ProviderRow
      name="Revyl"
      can={canWords(specOf("revyl"))}
      reveal="hub.revyl"
      hint={HINT}
      connected={state.connected}
      mark={!state.connected ? "off" : state.check !== undefined && !state.check.ok ? "failed" : "ready"}
      line={
        line === null
          ? null
          : { node: <span role={line.tone === "danger" ? "alert" : "status"}>{fix === undefined ? line.text : `${line.text} ${fix.charAt(0).toUpperCase()}${fix.slice(1)}`}</span>, tone: line.tone }
      }
      busy={busy}
      onTest={() => run("test", () => call("revyl_test", noInput, { timeoutMs: TEST_TIMEOUT_MS }), "Not tested")}
      onDisconnect={() => run("disconnect", () => call("revyl_disconnect", noInput), "Not disconnected")}
      connecting={connecting}
      onConnect={() => setConnecting(true)}
      form={
        <ConnectKey
          name="Revyl"
          seal={(key) => window.fleetd.secret.revylKey(hub, { boxPubKey: state.boxPubKey, key })}
          reread={reread}
          onCancel={() => setConnecting(false)}
          onDone={() => {
            setConnecting(false);
            setChecked(true);
          }}
        />
      }
      data={{ "data-revyl": state.connected ? "connected" : "off" }}
    />
  );
}

/** Where one phone kind's agent screens run, a row of What runs where: your machines, Revyl, or yours first. */
export function RouteRow({ kind, label, state }: { kind: RevylKind; label: string; state: RevylState }) {
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
  // An admin has Connect on Revyl's own row, just above, and the Revyl choices say they need a key: nothing more here.
  // Anyone else is told whom to ask.
  const line = problem !== null ? <span role="alert">{problem}</span> : admin ? null : off;
  return (
    <SettingsRow
      title={label}
      line={line}
      lineTone={problem === null ? "quiet" : "danger"}
      data={{ "data-revyl-route": kind, "data-where-kind": kind }}
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
