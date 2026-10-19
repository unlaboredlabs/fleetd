// How the order list is grouped: by project (the default) or by status, as ⌘⇧G and View → Group by switch. A
// preference of this window, kept across restarts.
import { useSyncExternalStore } from "react";

export type Grouping = "project" | "status";

const KEY = "fleetd.board.grouping";
const stored = (): Grouping => {
  try {
    return globalThis.localStorage.getItem(KEY) === "status" ? "status" : "project";
  } catch {
    return "project";
  }
};

let grouping: Grouping | undefined;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const read = (): Grouping => (grouping ??= stored());

export const useGrouping = (): Grouping => useSyncExternalStore(subscribe, read);

export const setGrouping = (next: Grouping): void => {
  grouping = next;
  try {
    globalThis.localStorage.setItem(KEY, next);
  } catch {
    // A preference that can't be saved still applies to this window.
  }
  for (const l of listeners) l();
};

export const toggleGrouping = (): void => setGrouping(read() === "project" ? "status" : "project");
