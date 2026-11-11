// What the page knows of fleetd cloud's Sign in (main: src/main/cloud): whether this build offers it, and who is
// signed in. Asked once, and again after a sign-in or sign-out. Until main answers, and on any build without the
// cloud's values, it reads as unavailable: the screens are then today's, with nothing of Sign in on them.
import { useEffect, useSyncExternalStore } from "react";
import type { CloudState } from "../../../shared/cloud";

const OFF: CloudState = { available: false, email: null };

let current: CloudState | null = null;
const listeners = new Set<() => void>();

const set = (next: CloudState): void => {
  current = next;
  for (const l of listeners) l();
};

/** Asks main again; never rejects. */
export const refreshCloud = (): Promise<CloudState> =>
  Promise.resolve()
    .then(() => window.fleetd.cloud.state())
    .catch(() => OFF)
    .then((next) => {
      set(next);
      return next;
    });

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The cloud's state, and whether main has answered yet. */
export const useCloud = (): { readonly state: CloudState; readonly known: boolean } => {
  const state = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    if (current === null) void refreshCloud();
  }, []);
  return { state: state ?? OFF, known: state !== null };
};

/** For tests: forget what main said. */
export const resetCloud = (): void => {
  current = null;
};
