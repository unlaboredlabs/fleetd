import { lazy, Suspense } from "react";
import { Shell } from "../screens/shell/Shell";
import { parseHash } from "../screens/shell/routes";
import { HubScope, useHubs } from "./data/react";

// A session's own window (main opens it on `#/session/…`) shows that session alone; every other window is the app.
const SessionWindow = lazy(() => import("../screens/sessions/SessionWindow").then((m) => ({ default: m.SessionWindow })));
const opened = parseHash(window.location.hash);

// main.tsx wraps this in the hubs' data layers and the design system's providers.
export const App = () => {
  const hubs = useHubs();
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
