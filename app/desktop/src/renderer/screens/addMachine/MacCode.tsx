// Add machine › A Mac for agents (D309): the 6-digit code the fleetd app on the Mac takes, with the hub's address
// should the Mac not find the hub by itself. One code per open view: minted once as it opens (mac_code_create, which
// revokes any code still open), kept until it expires, and a new one only when the person asks for it. Under it, a
// calm wait that turns into "joined" once the Mac's node links up. The paste line stays one click away, the CLI's way.
import { useEffect, useRef, useState } from "react";
import type { MacCodeCreateOutput } from "../../../shared/contracts";
import { useData, useDataLayer } from "../../src/data/react";
import { Button, StateGlyph, Text } from "../../ui";
import { errorText, useHubCall } from "../settings/hub";
import { macCodeState, macCodeWords, spacedCode } from "./model";
import s from "./addMachine.module.css";

/** A clock for the code's expiry: no ticking on screen. */
const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
};

export function MacCode(props: { onLine: () => void; onDone: () => void }) {
  const call = useHubCall();
  const layer = useDataLayer();
  const appUrl = useData((st) => (st.hub.phase === "unpaired" ? undefined : st.hub.hub));
  const [made, setMade] = useState<{ readonly out: MacCodeCreateOutput; readonly online: boolean; readonly linked: string | undefined }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const now = useNow();
  const machineId = made?.out.machineId;
  const online = useData((d) => (machineId === undefined ? false : (d.machines[machineId]?.status ?? "offline") !== "offline"));
  const linked = useData((d) => (machineId === undefined ? undefined : d.live.machines[machineId]?.linkedSince));

  const mint = () => {
    setBusy(true);
    setError(undefined);
    call("mac_code_create", appUrl === undefined ? {} : { hubUrl: appUrl })
      .then(
        (out) => {
          const at = layer.store.getState();
          setMade({ out, online: (at.machines[out.machineId]?.status ?? "offline") !== "offline", linked: at.live.machines[out.machineId]?.linkedSince });
        },
        (e: unknown) => setError(errorText(e)),
      )
      .finally(() => setBusy(false));
  };
  // Once per open view, however often React runs the effect.
  const minted = useRef(false);
  useEffect(() => {
    if (minted.current) return;
    minted.current = true;
    mint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const state = made === undefined ? undefined : macCodeState({ expiresAt: made.out.expiresAt, onlineAtMint: made.online, linkedAtMint: made.linked }, { online, linked }, now);
  return (
    <>
      <div className={s.head}>
        <Text strong>A Mac for agents</Text>
        <Text size="xs" tone="quiet">
          {"A Mac every project's agents use for builds and iOS simulators. It's a tool, never a runner: it runs no claude and no Navi, and holds none of your keys. Your own account on it is fine."}
        </Text>
      </div>
      <ol className={s.macSteps}>
        <li>
          <Text size="sm">On the Mac, open the fleetd app (download it from fleetd.sh) and choose Set up this Mac for agents.</Text>
        </li>
        <li>
          <Text size="sm">Type this code there:</Text>
        </li>
      </ol>
      {made === undefined ? (
        <Text tone={error === undefined ? "quiet" : "danger"}>{error ?? "Making a code…"}</Text>
      ) : (
        <div className={s.macCode} aria-label="Setup code" data-state={state}>
          <span className={s.macDigits} aria-live="polite">
            {state === "expired" ? "––– –––" : spacedCode(made.out.code)}
          </span>
          <Text size="xs" tone="quiet">
            {made.out.hubUrl === undefined
              ? (made.out.next ?? "")
              : `Joins as ${made.out.machineId}. Should the Mac ask for the hub: ${made.out.hubUrl}`}
          </Text>
        </div>
      )}
      {state === undefined ? null : (
        <div className={s.wait} data-line={state}>
          <StateGlyph state={state === "joined" ? "done" : state === "expired" ? "failed" : "queued"} size="sm" />
          <Text size="sm" tone={state === "expired" ? "danger" : "default"}>
            {macCodeWords(state, made?.out.machineId ?? "the Mac", made?.out.expiresAt ?? "")}
          </Text>
        </div>
      )}
      {error !== undefined && made !== undefined ? <Text tone="danger">{error}</Text> : null}
      <div className={s.actions}>
        {state === "joined" ? (
          <Button variant="primary" onClick={() => (window.location.hash = "#/setup/mac")}>
            {"Open the Mac's checks"}
          </Button>
        ) : null}
        {state === "expired" || (made === undefined && error !== undefined) ? (
          <Button variant="primary" disabled={busy} onClick={mint}>
            {busy ? "Making…" : "New code"}
          </Button>
        ) : null}
        {state === "joined" ? null : (
          <Button variant="ghost" onClick={props.onLine}>
            Use Terminal instead
          </Button>
        )}
        <Button variant={state === "joined" ? "secondary" : "ghost"} onClick={props.onDone}>
          {state === "joined" ? "Done" : "Back"}
        </Button>
      </div>
    </>
  );
}
