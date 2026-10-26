import { lazy, Suspense } from "react";
import { Shell } from "../screens/shell/Shell";
import { parseHash } from "../screens/shell/routes";

// A session's own window (main opens it on `#/session/…`) shows that session alone; every other window is the app.
const SessionWindow = lazy(() => import("../screens/sessions/SessionWindow").then((m) => ({ default: m.SessionWindow })));
const opened = parseHash(window.location.hash);

// main.tsx wraps this in the data layer and the design system's providers.
export const App = () =>
  opened.id === "session" ? (
    <Suspense fallback={<div aria-busy="true" />}>
      <SessionWindow project={opened.project} id={opened.session} />
    </Suspense>
  ) : (
    <Shell />
  );
