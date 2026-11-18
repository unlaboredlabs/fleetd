import { useEffect, useState } from "react";
import type { HubState } from "../../../shared/hub";
import type { KeyStore, Probe } from "../../../shared/pairing";
import { reaching, type Reaching } from "./form";

/** The frame's one hub subscription (each extra subscribe would make main send a fresh snapshot). */
export { useHubState } from "../shell/hubFeed";

/** The connection on its way to the hub, holding the last failure's reason across attempts (see `reaching`). */
export const useReaching = (state: HubState): Reaching | null => {
  const [last, setLast] = useState<{ readonly hub: string; readonly reason: string; readonly fix: string | null } | null>(null);
  if (state.phase === "retrying" && (last?.hub !== state.hub || last.reason !== state.reason)) {
    setLast({ hub: state.hub, reason: state.reason, fix: state.fix ?? null });
  }
  if (state.phase !== "connecting" && state.phase !== "retrying") return null;
  return reaching(state, last);
};

/**
 * Seconds until `at` (epoch ms), ticking once a second only while there is a deadline and the window is visible:
 * a hidden window has nobody to count for, and catches up when it shows.
 */
export const useSecondsUntil = (at: number | null): number | null => {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (at === null) return;
    const tick = () => setNow(Date.now());
    let timer: number | undefined;
    const run = () => {
      window.clearInterval(timer);
      timer = document.hidden ? undefined : window.setInterval(tick, 1000);
      // `now` may date from long before this deadline was set, or from before the window was hidden.
      if (!document.hidden) tick();
    };
    const first = window.setTimeout(run, 0);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
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

/** Where the hub key is kept (asked of main once per mount; it changes only with a restart). */
export const useKeyStore = (): KeyStore | null => {
  const [store, setStore] = useState<KeyStore | null>(null);
  useEffect(() => {
    let current = true;
    void window.fleetd.pair.store().then((found) => {
      if (current) setStore(found);
    });
    return () => {
      current = false;
    };
  }, []);
  return store;
};
