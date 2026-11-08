// Mounted once by the shell: it asks the hub on connect and every few minutes about its update run and the build it
// has downloaded and ready, which the hub row's word says (quiet.ts), and it holds the commands that reach updates
// (the palette, the app menu's "Check for Updates…"), which open Settings › Hub › Updates for an admin and General,
// with this app's own, for anyone else.
import { useEffect } from "react";
import { useData, useDataLayer } from "../../src/data/react";
import { useSettledAdministers } from "../admin/role";
import { useCommands } from "../palette";
import { useFlowDeps } from "./hooks";
import { loadRun, READY_EVERY_MS } from "./flow";
import type { AppAction } from "./model";
import { appUpdate, openUpdates, useAppUpdate } from "./state";

export const runApp = (action: AppAction): void => {
  if (action === "check") void window.fleetd.updates.check();
  // Restarting closes the window; the composer saves every draft as the page goes (pagehide).
  else if (action === "install") void window.fleetd.updates.install();
  else void window.fleetd.updates.keep();
};

/** Found already, or nothing to find: a check would only repeat it. */
const settled = (): boolean => {
  const kind = appUpdate()?.app.kind;
  return kind === "available" || kind === "ready" || kind === "manual" || kind === "checking" || kind === "unsupported";
};

export function UpdatesHost() {
  const ready = useAppUpdate()?.app.kind === "ready";
  const deps = useFlowDeps();
  const admin = useSettledAdministers();
  const { hub } = useDataLayer();
  // The hub's last run and the build it has ready, on connect and every few minutes; a run going on (another window
  // started it, or the hub's own automatic update) is followed from there.
  const live = useData((d) => d.hub.phase === "live");
  useEffect(() => {
    if (!live) return;
    void loadRun(deps);
    const every = setInterval(() => void loadRun(deps), READY_EVERY_MS);
    return () => clearInterval(every);
  }, [live, deps]);

  useCommands(
    [
      {
        id: "app.checkForUpdates",
        title: "Check for updates",
        detail: "The hub, its machines and this app",
        group: "actions",
        keywords: ["update", "upgrade", "version", "what's new"],
        run: () => {
          openUpdates(admin, hub);
          if (!settled()) runApp("check");
        },
      },
      { id: "app.restartToUpdate", title: "Restart to update", group: "actions", keywords: ["update", "install"], enabled: () => ready, run: () => runApp("install") },
    ],
    [ready, admin, hub],
  );
  return null;
}
