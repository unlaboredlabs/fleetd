// The main area's one line for a hub restart that runs long: from 30 s after the hub closed to restart it says the hub
// isn't back yet, for how long, and that nothing is lost; once the hub answers it counts the machines coming back,
// a hairline under it filling as each does, and folds away when they all have. A restart that ends sooner never
// shows it; one past 2 minutes is an outage, and the offline banner takes the slot (onboarding/ConnectionBanner).
// Self-contained: the shell places it above the screen, in the banner's slot.
import { useEffect, useState } from "react";
import type { HubState } from "../../../shared/hub";
import type { Machine } from "../../../shared/contracts";
import { useData, useDataLayer } from "../../src/data/react";
import { Button, Text } from "../../ui";
import { hubName, restartOf } from "../shell/model";
import r from "./restartLine.module.css";

/** How long the line waits for the machines once the hub is back, before it folds away all the same. */
export const MACHINES_WAIT_MS = 60_000;

/** The machines that count: this fleet's own; a cloud machine asleep is at rest. */
const own = (machines: Readonly<Record<string, Machine>>): Machine[] => Object.values(machines).filter((m) => m.cloud !== true);

export type LineView =
  | { readonly t: "down"; readonly hub: string; readonly seconds: number }
  | { readonly t: "back"; readonly hub: string; readonly back: number; readonly of: number };

/** A restart that went long: since when, and which machines were online as it began; `backAt` once the hub answered. */
export interface Long {
  readonly since: number;
  readonly machines: readonly string[];
  readonly backAt?: number;
}

/** What the line says, from the restart (if it went long) and the machines the hub knows now; null when it is quiet. */
export const lineView = (state: HubState, long: Long | null, machines: readonly Machine[], now: number): LineView | null => {
  const restart = restartOf(state, now);
  const hub = state.phase === "unpaired" ? "" : hubName(state.hub);
  if (restart !== null) return restart.phase === "long" ? { t: "down", hub, seconds: Math.floor((now - restart.since) / 1000) } : null;
  if (long?.backAt === undefined || state.phase !== "live" || now - long.backAt >= MACHINES_WAIT_MS || long.machines.length === 0) return null;
  const online = new Set(machines.filter((m) => m.status === "online").map((m) => m.machineId));
  const back = long.machines.filter((id) => online.has(id)).length;
  return back >= long.machines.length ? null : { t: "back", hub, back, of: long.machines.length };
};

/** "41 s", "1 min 5 s". */
export const awayFor = (seconds: number): string => (seconds < 60 ? `${String(seconds)} s` : `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`);

export function RestartLine() {
  const state = useData((d) => d.hub);
  const known = useData((d) => d.machines);
  const layer = useDataLayer();
  const [now, setNow] = useState(Date.now);
  const [long, setLong] = useState<Long | null>(null);
  const restarting = state.phase === "connecting" || state.phase === "retrying" ? state.restarting : undefined;
  // A second's tick while a restart runs or the machines are awaited; nothing otherwise.
  const waiting = restarting !== undefined || (long?.backAt !== undefined && now - long.backAt < MACHINES_WAIT_MS);
  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [waiting]);
  // The restart went long: which machines were online then (as last known), to count back once the hub is.
  const phase = restartOf(state, now)?.phase;
  if (phase === "long" && long?.since !== restarting && restarting !== undefined) {
    setLong({ since: restarting, machines: own(known).filter((m) => m.status === "online").map((m) => m.machineId) });
  }
  if (phase === "outage" && long !== null) setLong(null);
  if (state.phase === "live" && long !== null && long.backAt === undefined) setLong({ ...long, backAt: now });
  const view = lineView(state, long, own(known), now);
  if (view === null) return null;
  const steps = view.t === "back" ? (1 + view.back) / (1 + view.of) : 0;
  return (
    <div className={r.line} role="status" data-banner="restart" data-restart={view.t}>
      <Text size="sm" tabular className={r.words}>
        {view.t === "down" ? (
          <>
            <Text size="sm" strong>{`${view.hub} isn’t back yet`}</Text>
            <Text size="sm" tone="quiet">{` · ${awayFor(view.seconds)}. It’s restarting into a new build; agents keep working, and anything you send goes once it’s back.`}</Text>
          </>
        ) : (
          <>
            <Text size="sm" strong>{`${view.hub} is back`}</Text>
            <Text size="sm" tone="quiet">{` · ${String(view.back)} of ${String(view.of)} machines`}</Text>
          </>
        )}
      </Text>
      {view.t === "down" ? (
        <Button variant="secondary" onClick={() => layer.retryNow()}>
          Try now
        </Button>
      ) : null}
      <span className={r.bar} style={{ transform: `scaleX(${String(steps)})` }} aria-hidden />
    </div>
  );
}
