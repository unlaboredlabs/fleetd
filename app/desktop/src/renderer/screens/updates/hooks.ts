import { useCallback, useEffect, useMemo, useState } from "react";
import type { HubState } from "../../../shared/hub";
import { useData, useDataLayer } from "../../src/data/react";
import { useServes, useSettledAdministers } from "../admin/role";
import { startUpdate, useAuto, useFlow, useReady, useRun, type FlowDeps } from "./flow";
import { FAILED_SHOWN_MS, RESULT_SHOWN_MS, shownFor, updateStatus, type Act, type MachineInput, type Status } from "./model";
import { quietOf, type Quiet } from "./quiet";
import { appUpdate, runApp, useAppUpdate } from "./state";

/** A render when `at` (epoch ms) passes: what was news until then no longer is. */
const useExpiry = (at: number | undefined): number => {
  const [expired, setExpired] = useState(0);
  useEffect(() => {
    if (at === undefined || at <= Date.now()) return;
    const timer = setTimeout(() => setExpired((n) => n + 1), at - Date.now());
    return () => clearTimeout(timer);
  }, [at]);
  return expired;
};

/** The one status every updates surface shows (model.ts), from main's update state, the hub's ready frame, its
 * machines, its run, the build it has ready, Update automatically, and whether this person updates the hub. */
export const useUpdateStatus = (): Status => {
  const app = useAppUpdate();
  const state = useData((s) => s.hub);
  const known = useData((s) => s.machines);
  const { hub: id } = useDataLayer();
  const run = useRun(id);
  const flow = useFlow(id);
  const ready = useReady(id);
  const auto = useAuto(id);
  const administers = useSettledAdministers();
  const updates = useServes("hub_update");
  const url = state.phase === "live" ? state.hub : null;
  const version = state.phase === "live" ? state.version : undefined;
  const machines = useMemo(
    (): MachineInput[] => Object.values(known).map((m) => ({ machineId: m.machineId, name: m.name, nodeVersion: m.nodeVersion, online: m.status !== "offline" })),
    [known],
  );
  // A finished run is news for a while (longer when it failed), then history.
  const finished = run?.finishedAt === undefined ? undefined : Date.parse(run.finishedAt);
  const expired = useExpiry(run === null || finished === undefined ? undefined : finished + shownFor(run));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `expired` reads the clock again.
  return useMemo(() => updateStatus({ app, hub: { url, version }, machines, run, flow, ready, auto, administers, updates }), [app, url, version, machines, run, flow, ready, auto, administers, updates, expired]);
};

/** The update flow's effects in this window: the hub's calls, its timers and this app's own updater. */
export const useFlowDeps = (): FlowDeps => {
  const layer = useDataLayer();
  return useMemo(
    (): FlowDeps => ({
      hub: layer.hub,
      call: layer.call,
      retry: () => layer.retryNow(),
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      app: {
        state: appUpdate,
        check: () => runApp("check"),
        install: () => runApp("install"),
      },
    }),
    [layer],
  );
};

/** What a status's button does (model.ts Act), wherever the status shows. */
export const useUpdateAct = (): ((act: Act) => void) => {
  const deps = useFlowDeps();
  return useCallback(
    (act: Act) => {
      if (act === "update") void startUpdate(deps);
      else if (act === "startOver") void startUpdate(deps, true);
      else runApp(act === "check" ? "check" : "install");
    },
    [deps],
  );
};

/** The word under your name and the menu's note (quiet.ts): read against the clock as the hub's state changes (each
 * redial while it restarts), and again when "Updated" has said it long enough. */
export const useQuiet = (hub: HubState): Quiet | null => {
  const status = useUpdateStatus();
  const updated = useData((s) => s.updated);
  const update = useData((s) => s.update);
  const administers = useSettledAdministers();
  useExpiry(updated === undefined ? undefined : updated.at + RESULT_SHOWN_MS);
  useExpiry(update?.finishedAt === undefined ? undefined : Date.parse(update.finishedAt) + FAILED_SHOWN_MS);
  // Small and cheap: read on every render, against the clock.
  // eslint-disable-next-line react-hooks/purity
  return quietOf({ status, hub, updated, update, administers, now: Date.now() });
};
