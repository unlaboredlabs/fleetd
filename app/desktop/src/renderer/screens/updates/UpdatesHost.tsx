// Mounted once by the shell: the updates sheet, the one "ready" notice, and the commands that reach the sheet (the
// palette, the app menu's "Check for Updates…"). It asks the hub on connect and every few minutes whether a newer
// build is downloaded and ready. The sheet's one Update button updates the hub, then every machine, then this app,
// and closes itself once everything came through, leaving "Updated to …" in the sidebar.
import { useEffect, useMemo, useRef } from "react";
import { Dialog, toast } from "../../ui";
import { useData, useDataLayer } from "../../src/data/react";
import { useCommands } from "../palette";
import { useUpdatesView } from "./hooks";
import { loadRun, READY_EVERY_MS, retryMachine, startOver, startUpdate, updateNow, useFlow, type FlowDeps } from "./flow";
import type { AppAction, Notice, Retry } from "./model";
import { noticeOnce, storedNotice } from "./notice";
import { appUpdate, setUpdatesOpen, useAppUpdate, useUpdatesOpen } from "./state";
import { Notes, UpdatesSheet } from "./UpdatesSheet";
import { Boundary } from "../../src/Boundary";

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
  const open = useUpdatesOpen();
  const view = useUpdatesView();
  const ready = useAppUpdate()?.app.kind === "ready";
  const layer = useDataLayer();
  const deps = useMemo(
    (): FlowDeps => ({
      call: layer.call,
      retry: () => layer.retryNow(),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      app: {
        state: appUpdate,
        check: () => void window.fleetd.updates.check(),
        install: () => void window.fleetd.updates.install(),
      },
    }),
    [layer],
  );
  // The hub's last run: one going on (the app restarted mid-update, or another window started it) is followed.
  useEffect(() => {
    if (open) void loadRun(deps);
  }, [open, deps]);
  // And the build it has ready, on connect and every few minutes: what the notice and the sheet say.
  const live = useData((d) => d.hub.phase === "live");
  useEffect(() => {
    if (!live) return;
    void loadRun(deps);
    const every = setInterval(() => void loadRun(deps), READY_EVERY_MS);
    return () => clearInterval(every);
  }, [live, deps]);

  // "fleetd <version> is ready", once per version; gone once an update starts.
  const dismiss = useRef<(() => void) | null>(null);
  const update = () => {
    setUpdatesOpen(true);
    void startUpdate(deps);
  };
  const shown = view.notice;
  useEffect(() => {
    if (shown === null) {
      dismiss.current?.();
      dismiss.current = null;
      return;
    }
    noticeOnce(shown, open, {
      ...storedNotice,
      show: (n: Notice) => {
        dismiss.current = toast({
          key: "update-ready",
          title: n.title,
          description: <Notes notes={n.notes} />,
          action: { label: "Update", onClick: update },
          duration: 0,
        });
      },
    });
    // Once per version: the rest of the view changing doesn't show it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.version]);

  // Everything came through: the sheet closes itself, and the sidebar says "Updated to …".
  const flow = useFlow();
  useEffect(() => {
    if (flow.phase === "finished" && flow.updated) setUpdatesOpen(false);
  }, [flow]);

  const retry = (r: Retry) => {
    if (r.kind === "machine") void retryMachine(deps, r.machineId);
    else if (r.kind === "update") void startUpdate(deps);
    else runApp(r.run);
  };

  useCommands(
    [
      {
        id: "app.checkForUpdates",
        title: "Check for updates",
        detail: "The hub, its machines and this app",
        group: "actions",
        keywords: ["update", "upgrade", "version", "what's new"],
        run: () => {
          setUpdatesOpen(true);
          if (!settled()) runApp("check");
        },
      },
      { id: "app.restartToUpdate", title: "Restart to update", group: "actions", keywords: ["update", "install"], enabled: () => ready, run: () => runApp("install") },
    ],
    [ready],
  );

  if (!open) return null;
  return (
    <Boundary part="the updates sheet" overlay={{ onError: () => setUpdatesOpen(false) }}>
      <Dialog open onOpenChange={setUpdatesOpen} title="Updates">
        <UpdatesSheet
          view={view}
          onUpdate={() => void startUpdate(deps)}
          onStartOver={() => void startOver(deps)}
          onUpdateNow={() => void updateNow(deps)}
          onRetry={retry}
          onApp={(a: AppAction) => runApp(a)}
        />
      </Dialog>
    </Boundary>
  );
}
