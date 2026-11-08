import { useMemo } from "react";
import { useData, useDataLayer } from "../../src/data/react";
import { useFlow, useReady, useRun, type FlowDeps } from "./flow";
import { updatesView, type MachineInput, type UpdatesView } from "./model";
import { appUpdate, useAppUpdate } from "./state";

/** Everything the updates surfaces say, from main's update state, the hub's ready frame, its machines, its run and the
 * build it has ready. */
export const useUpdatesView = (): UpdatesView => {
  const app = useAppUpdate();
  const state = useData((s) => s.hub);
  const known = useData((s) => s.machines);
  const run = useRun();
  const flow = useFlow();
  const ready = useReady();
  const url = state.phase === "live" ? state.hub : null;
  const version = state.phase === "live" ? state.version : undefined;
  const machines = useMemo(
    (): MachineInput[] =>
      Object.values(known).map((m) => ({ machineId: m.machineId, name: m.name, nodeVersion: m.nodeVersion, online: m.status !== "offline" })),
    [known],
  );
  return useMemo(() => updatesView({ app, hub: { url, version }, machines, run, flow, ready }), [app, url, version, machines, run, flow, ready]);
};

/** The update flow's effects in this window: the hub's calls, its timers and this app's own updater. */
export const useFlowDeps = (): FlowDeps => {
  const layer = useDataLayer();
  return useMemo(
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
};
