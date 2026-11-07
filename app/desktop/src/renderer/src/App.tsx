import { lazy, Suspense, useSyncExternalStore } from "react";
import { Shell } from "../screens/shell/Shell";
import { parseHash } from "../screens/shell/routes";
import { HubScope, useHubs } from "./data/react";

// A session's own window (main opens it on `#/session/…`) shows that session alone; every other window is the app.
const SessionWindow = lazy(() => import("../screens/sessions/SessionWindow").then((m) => ({ default: m.SessionWindow })));
// Set up this Mac for agents has a window of its own too (main opens it on `#/mac-setup`), with no hub in it.
const MacSetup = lazy(() => import("../screens/macSetup/MacSetup").then((m) => ({ default: m.MacSetup })));
// Once on it, the window stays on it, whatever the shell then makes of the route. Heard before the shell's own
// listener is (it registers as it mounts), so its redirect of a route it doesn't know never wins.
let onMacSetup = window.location.hash.startsWith("#/mac-setup");
const macSetupListeners = new Set<() => void>();
window.addEventListener("hashchange", () => {
  if (onMacSetup || !window.location.hash.startsWith("#/mac-setup")) return;
  onMacSetup = true;
  for (const listener of macSetupListeners) listener();
});
const onMacSetupChange = (changed: () => void) => {
  macSetupListeners.add(changed);
  return () => macSetupListeners.delete(changed);
};
const useMacSetup = () => useSyncExternalStore(onMacSetupChange, () => onMacSetup);
const opened = parseHash(window.location.hash);

// main.tsx wraps this in the hubs' data layers and the design system's providers.
export const App = () => {
  const hubs = useHubs();
  const macSetup = useMacSetup();
  if (macSetup) {
    return (
      <Suspense fallback={<div aria-busy="true" />}>
        <MacSetup />
      </Suspense>
    );
  }
  if (opened.id !== "session") return <Shell />;
  // The session's hub, as its route names it (absent: the first).
  const hub = hubs.find((h) => h.id === opened.at) ?? hubs[0];
  return hub === undefined ? null : (
    <HubScope key={hub.id} hub={hub}>
      <Suspense fallback={<div aria-busy="true" />}>
        <SessionWindow project={opened.project} id={opened.session} />
      </Suspense>
    </HubScope>
  );
};
