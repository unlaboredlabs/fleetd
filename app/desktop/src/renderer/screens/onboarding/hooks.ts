import { useEffect, useState } from "react";
import type { HubState } from "../../../shared/hub";
import type { Probe } from "../../../shared/pairing";

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
