// What each hub's always-mounted watcher (HubWatch in Shell.tsx) found, for what spans every hub: the sidebar's
// groups, the commands that step through projects, `#/`'s last project and the Dock badge. A tiny external store,
// so each hub publishes from inside its own scope and the frame reads them all.
import { useSyncExternalStore } from "react";
import type { HubState } from "../../../shared/hub";
import type { HubId } from "../../../shared/hubs";
import type { SidebarProject } from "./model";

export interface HubRows {
  /** Undefined until that hub's projects loaded. */
  readonly projects: ReadonlyArray<SidebarProject> | undefined;
  /** Projects that need you; undefined while unknown. */
  readonly needsYou: number | undefined;
  readonly state: HubState;
}

let rows: ReadonlyMap<HubId, HubRows> = new Map();
const listeners = new Set<() => void>();

export const publishRows = (hub: HubId, next: HubRows): void => {
  const held = rows.get(hub);
  if (held !== undefined && held.projects === next.projects && held.needsYou === next.needsYou && held.state === next.state) return;
  rows = new Map(rows).set(hub, next);
  for (const l of listeners) l();
};

export const dropRows = (hub: HubId): void => {
  if (!rows.has(hub)) return;
  const next = new Map(rows);
  next.delete(hub);
  rows = next;
  for (const l of listeners) l();
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useHubRows = (): ReadonlyMap<HubId, HubRows> => useSyncExternalStore(subscribe, () => rows);
