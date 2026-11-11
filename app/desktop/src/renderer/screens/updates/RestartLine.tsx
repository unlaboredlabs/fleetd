// The main area's one line for a hub restart that runs long: from 30 s after the hub closed to restart it says the hub
// isn't back yet, for how long, and that nothing is lost, with Try now. A restart that ends sooner never shows it; one
// past 2 minutes is an outage, and the offline banner takes the slot (onboarding/ConnectionBanner). Self-contained:
// the shell places it above the screen, in the banner's slot.
import { useEffect, useState } from "react";
import type { HubState } from "../../../shared/hub";
import { useData, useDataLayer } from "../../src/data/react";
import { Button, Text } from "../../ui";
import { hubName, restartOf } from "../shell/model";
import r from "./restartLine.module.css";

export interface LineView {
  readonly hub: string;
  readonly seconds: number;
}

/** What the line says of a restart that went long; null when it is quiet. */
export const lineView = (state: HubState, now: number): LineView | null => {
  const restart = restartOf(state, now);
  if (restart?.phase !== "long" || state.phase === "unpaired") return null;
  return { hub: hubName(state.hub), seconds: Math.floor((now - restart.since) / 1000) };
};

/** "41 s", "1 min 5 s". */
export const awayFor = (seconds: number): string => (seconds < 60 ? `${String(seconds)} s` : `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`);

export function RestartLine() {
  const state = useData((d) => d.hub);
  const layer = useDataLayer();
  const [now, setNow] = useState(Date.now);
  const restarting = (state.phase === "connecting" || state.phase === "retrying") && state.restarting !== undefined;
  // A second's tick while a restart runs; nothing otherwise.
  useEffect(() => {
    if (!restarting) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [restarting]);
  const view = lineView(state, now);
  if (view === null) return null;
  return (
    <div className={r.line} role="status" data-banner="restart">
      <Text size="sm" tabular className={r.words}>
        <Text size="sm" strong>{`${view.hub} isn’t back yet`}</Text>
        <Text size="sm" tone="quiet">{` · ${awayFor(view.seconds)}. It’s restarting into a new build; agents keep working, and anything you send goes once it’s back.`}</Text>
      </Text>
      <Button variant="secondary" onClick={() => layer.retryNow()}>
        Try now
      </Button>
    </div>
  );
}
