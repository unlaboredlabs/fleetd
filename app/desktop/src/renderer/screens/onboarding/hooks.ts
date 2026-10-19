import { useEffect, useState } from "react";
import type { HubState } from "../../../shared/hub";
import type { Probe } from "../../../shared/pairing";
import { reaching, type Reaching } from "./form";

/**
 * The hub connection's state from main. Until the shared store (E1) carries it, this listens on its own; note each
 * subscribe makes main send a fresh snapshot, so mount it once per screen, not per row.
 */
export const useHubState = (): HubState | null => {
  const [state, setState] = useState<HubState | null>(null);
  useEffect(
    () =>
      window.fleetd.hub.subscribe((frame) => {
        if (frame.t === "state") setState(frame.state);
      }),
    [],
  );
  return state;
};

/** The connection on its way to the hub, holding the last failure's reason across attempts (see `reaching`). */
export const useReaching = (state: HubState | null): Reaching | null => {
  const [last, setLast] = useState<{ readonly hub: string; readonly reason: string } | null>(null);
  if (state?.phase === "retrying" && (last?.hub !== state.hub || last.reason !== state.reason)) {
    setLast({ hub: state.hub, reason: state.reason });
  }
  if (state === null || (state.phase !== "connecting" && state.phase !== "retrying")) return null;
  return reaching(state, last);
};

/** Seconds until `at` (epoch ms), ticking once a second only while there is a deadline. */
export const useSecondsUntil = (at: number | null): number | null => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (at === null) return;
    const tick = () => setNow(Date.now());
    // `now` may date from long before this deadline was set.
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
};

/** The hub's /healthz (version and protocol) once per connected hub. */
export const useHubProbe = (hub: string | null): Probe | null => {
  const [found, setFound] = useState<{ readonly hub: string; readonly probe: Probe } | null>(null);
  useEffect(() => {
    if (hub === null) return;
    let current = true;
    void window.fleetd.pair.probe(hub).then((probe) => {
      if (current) setFound({ hub, probe });
    });
    return () => {
      current = false;
    };
  }, [hub]);
  return found !== null && found.hub === hub ? found.probe : null;
};
