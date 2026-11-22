// Whether Connections is open: one flag for the window, set by the sidebar's icon, `#/connections`, the palette and
// the links that send people here from what it replaced (a bot's settings, Settings search).
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
const set = (next: boolean) => {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
};

export const openConnections = (): void => set(true);
export const closeConnections = (): void => set(false);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useConnectionsOpen = (): boolean => useSyncExternalStore(subscribe, () => open);
