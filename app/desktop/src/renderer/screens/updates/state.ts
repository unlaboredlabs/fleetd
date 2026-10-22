// Main's update state (one subscription for the whole window) and whether the updates sheet is open: a tiny external
// store, so the sidebar line, the sheet and the palette share it without a provider.
import { useSyncExternalStore } from "react";
import type { UpdatesState } from "../../../shared/updates";

let state: UpdatesState | null = null;
let open = false;
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

export const useUpdatesOpen = (): boolean => useSyncExternalStore(subscribe, () => open);

export const setUpdatesOpen = (next: boolean): void => {
  if (open === next) return;
  open = next;
  notify();
};
