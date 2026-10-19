// Which overlay is up (the palette or the shortcuts sheet) and the text the palette opens with. A tiny external
// store, so any screen can open the palette (`openPalette("1 ")` from a "Reply" button) without a provider.

import { useSyncExternalStore } from "react";
import { pushRecent } from "./rank";

export type Overlay = { readonly kind: "none" } | { readonly kind: "palette"; readonly query: string; readonly seq: number } | { readonly kind: "shortcuts" };

let overlay: Overlay = { kind: "none" };
let seq = 0;
const listeners = new Set<() => void>();

const set = (next: Overlay) => {
  overlay = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useOverlay = (): Overlay => useSyncExternalStore(subscribe, () => overlay);

export const paletteOpen = (): boolean => overlay.kind === "palette";

/** Opens the palette with `query` typed in (a reply such as "1 " starts it in reply mode). */
export const openPalette = (query = ""): void => {
  seq += 1;
  set({ kind: "palette", query, seq });
};

export const togglePalette = (): void => (overlay.kind === "palette" ? closeOverlay() : openPalette());

export const openShortcuts = (): void => set({ kind: "shortcuts" });

export const toggleShortcuts = (): void => (overlay.kind === "shortcuts" ? closeOverlay() : openShortcuts());

export const closeOverlay = (): void => set({ kind: "none" });

// Recents survive a restart. Only ids are kept, never titles, so nothing stale is ever shown.
const RECENT_KEY = "fleetd.palette.recent";

export const readRecent = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

export const noteRecent = (id: string): void => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(pushRecent(readRecent(), id)));
  } catch {
    // Storage can be full or off; recents are a convenience.
  }
};
