import { useMemo, useSyncExternalStore } from "react";
import { parseHash, toHash, type Route } from "./routes";

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

export const useRoute = (): Route => {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => parseHash(hash), [hash]);
};

export const currentRoute = (): Route => parseHash(window.location.hash);

/** `replace` for moves Back shouldn't return to (closing the inbox, a redirect). */
export const navigate = (route: Route, options?: { replace?: boolean }): void => {
  const hash = toHash(route);
  if (hash === window.location.hash) return;
  if (options?.replace === true) window.location.replace(hash);
  else window.location.hash = hash;
};
