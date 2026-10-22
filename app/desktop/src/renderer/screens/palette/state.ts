// Which overlay is up (the palette or the shortcuts sheet) and the text the palette opens with. A tiny external
// store, so any screen can open the palette (`openPalette("1 ")` from a "Reply" button) without a provider.

import { useSyncExternalStore } from "react";
import { frecency, noteUse, type Frecency, type Use } from "./rank";

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

// Use survives a restart. Only ids are kept, never titles, so nothing stale is ever shown.
const USE_KEY = "fleetd.palette.use";

const isUse = (v: unknown): v is Use =>
  typeof v === "object" && v !== null && "count" in v && "last" in v && Number.isFinite(v.count) && Number.isFinite(v.last);

const readUses = (): Record<string, Use> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(USE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, Use] => isUse(e[1])));
  } catch {
    return {};
  }
};

/** Each remembered id's frecency now. */
export const readFrecency = (now = Date.now()): Frecency =>
  new Map(Object.entries(readUses()).map(([id, use]) => [id, frecency(use, now)]));

export const noteRun = (id: string, now = Date.now()): void => {
  try {
    localStorage.setItem(USE_KEY, JSON.stringify(noteUse(readUses(), id, now)));
  } catch {
    // Storage can be full or off; ranking by use is a convenience.
  }
};
