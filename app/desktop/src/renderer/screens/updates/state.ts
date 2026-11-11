// Main's update state (one subscription for the whole window): a tiny external store, so the sidebar, Settings and the
// palette share it without a provider. And where updates open.
import { useSyncExternalStore } from "react";
import type { UpdatesState } from "../../../shared/updates";
import { navigate } from "../shell/navigation";

let state: UpdatesState | null = null;
let started = false;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

const start = () => {
  if (started) return;
  started = true;
  // Subscribed first, so a change between the two calls isn't lost; a later answer never overwrites it.
  window.fleetd.updates.subscribe((next) => {
    state = next;
    notify();
  });
  void window.fleetd.updates.state().then((first) => {
    if (state !== null) return;
    state = first;
    notify();
  });
};

const subscribe = (listener: () => void) => {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Null until main first answers. */
export const useAppUpdate = (): UpdatesState | null => useSyncExternalStore(subscribe, () => state);
export const appUpdate = (): UpdatesState | null => state;

/** This app's own updater, in main: its check again, or its update (it downloads if it must, then restarts; the deb
 * opens its download). Restarting closes the window; the composer saves every draft as the page goes (pagehide). */
export const runApp = (action: "check" | "install"): void => {
  if (action === "check") void window.fleetd.updates.check();
  else void window.fleetd.updates.install();
};

/** Where the hub's updates are read and run: Settings › Hub › Updates for an admin; General (this app's own) for
 * anyone else. `at`: which hub's, with several; the screen's when absent. */
export const openUpdates = (admin: boolean, at?: string): void =>
  navigate(admin ? { id: "settings", tab: "hub.updates", ...(at === undefined ? {} : { at }) } : { id: "settings", tab: "general" });
