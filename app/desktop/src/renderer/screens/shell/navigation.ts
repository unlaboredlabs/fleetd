import { useMemo, useSyncExternalStore } from "react";
import { parseHash, toHash, type Screen } from "./routes";

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

export const useRoute = (): Screen => {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return useMemo(() => parseHash(hash), [hash]);
};

export const currentRoute = (): Screen => parseHash(window.location.hash);

/** `replace` for moves Back shouldn't return to (resolving home to a project, a redirect). */
export const navigate = (screen: Screen, options?: { replace?: boolean }): void => {
  const hash = toHash(screen);
  if (hash === window.location.hash) return;
  if (options?.replace === true) window.location.replace(hash);
  else window.location.hash = hash;
};
