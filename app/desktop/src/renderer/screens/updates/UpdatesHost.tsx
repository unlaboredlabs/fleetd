// Mounted once by the shell: it asks the hub on connect, every few minutes and whenever the hub says an update began
// or ended about its run and the build it has downloaded and ready, which the word under your name says (quiet.ts), and it
// holds the commands that reach updates (the palette, the app menu's "Check for Updates…"), which open Settings ›
// Hub › Machines › Updates for an admin and General, with this app's own, for anyone else.
import { useEffect } from "react";
import { useData, useDataLayer } from "../../src/data/react";
import { useServes, useSettledAdministers } from "../admin/role";
import { useCommands } from "../palette";
import { useFlowDeps } from "./hooks";
import { loadRun, READY_EVERY_MS } from "./flow";
import { appUpdate, openUpdates, runApp, useAppUpdate } from "./state";

/** Found already, or nothing to find: a check would only repeat it. */
const settled = (): boolean => {
  const kind = appUpdate()?.app.kind;
  return kind === "available" || kind === "ready" || kind === "manual" || kind === "checking" || kind === "unsupported";
};

/** One per hub, each following its own hub's updates; `commands` on the screen's hub's only, so the palette has one of
 * each. */
export function UpdatesHost({ commands = true }: { commands?: boolean }) {
  const ready = useAppUpdate()?.app.kind === "ready";
  const deps = useFlowDeps();
  // On fleetd cloud, which updates itself, nothing to ask, and Check for updates is this app's own, as for a member.
  const updates = useServes("hub_update_status");
  const admin = useSettledAdministers() && updates;
  const { hub } = useDataLayer();
  // The hub's last run and the build it has ready, on connect, every few minutes, and as the hub says one began or
  // ended (its snapshot's and each hub.update event's word); a run going on (another window started it, or the hub's
  // own automatic update) is followed from there.
  const live = useData((d) => d.hub.phase === "live");
  const said = useData((d) => (d.update === undefined ? "" : `${d.update.runId} ${d.update.state}`));
  useEffect(() => {
    if (!live || !updates) return;
    void loadRun(deps);
    const every = setInterval(() => void loadRun(deps), READY_EVERY_MS);
    return () => clearInterval(every);
  }, [live, updates, deps, said]);

  const list = [
    {
      id: "app.checkForUpdates",
      title: "Check for updates",
      detail: "The hub, its machines and this app",
      group: "actions" as const,
      keywords: ["update", "upgrade", "version"],
      run: () => {
        openUpdates(admin, hub);
        if (!settled()) runApp("check");
      },
    },
    { id: "app.restartToUpdate", title: "Restart to update", group: "actions" as const, keywords: ["update", "install"], enabled: () => ready, run: () => runApp("install") },
  ];
  useCommands(commands ? list : [], [commands, ready, admin, hub]);
  return null;
}
