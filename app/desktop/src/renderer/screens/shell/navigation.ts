// Navigation is the hash (routes.ts). With several hubs a route names its hub (`?at=<id>`), and one that doesn't is
// on the hub of the screen before it: a link a screen builds as `#/settings/agents` stays on that screen's hub. So
// every screen keeps working on the hub it is on, and only what crosses hubs (the sidebar, notifications, Commands)
// names one. With one hub, no route names it and the hashes are as they always were.
import { useMemo, useSyncExternalStore } from "react";
import { FIRST_HUB, type HubId } from "../../../shared/hubs";
import { onHub, parseHash, toHash, type Screen } from "./routes";

/** A screen with its hub known. */
export type Routed = Screen & { readonly at: HubId };

let hubs: readonly HubId[] = [FIRST_HUB];
/** The hub of the last route that named one. */
let current: HubId | null = null;

/** The app's hubs, in sidebar order (the shell sets them as they change). */
export const setRouteHubs = (ids: readonly HubId[]): void => {
  hubs = ids.length === 0 ? [FIRST_HUB] : ids;
};

/** `screen` on its hub: the one it names, else the one before, else the first; a hub since removed is the first. */
export const routed = (screen: Screen): Routed => {
  if (screen.at !== undefined) current = screen.at;
  const at = screen.at ?? current;
  return { ...screen, at: at !== null && hubs.includes(at) ? at : (hubs[0] ?? FIRST_HUB) };
};

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

export const useRoute = (): Routed => {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => routed(parseHash(hash)), [hash]);
};

export const currentRoute = (): Routed => routed(parseHash(window.location.hash));

/** The hash for `screen`: on the hub it names or the current one, said only when there are several. */
export const hashFor = (screen: Screen): string => {
  return toHash(onHub(screen, hubs.length > 1 ? (screen.at ?? currentRoute().at) : undefined));
};

/** `replace` for moves Back shouldn't return to (resolving home to a project, a redirect). */
export const navigate = (screen: Screen, options?: { replace?: boolean }): void => {
  const hash = hashFor(screen);
  // The hub it goes to is the current one from here, even before the page reads the new hash.
  if (screen.at !== undefined) routed(screen);
  if (hash === window.location.hash) return;
  if (options?.replace === true) window.location.replace(hash);
  else window.location.hash = hash;
};
