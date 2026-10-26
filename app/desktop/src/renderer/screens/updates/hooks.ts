import { useMemo } from "react";
import { useData } from "../../src/data/react";
import { useFlow, useRun } from "./flow";
import { updatesView, type MachineInput, type UpdatesView } from "./model";
import { useAppUpdate } from "./state";

/** Everything the updates surfaces say, from main's update state, the hub's ready frame, its machines and its run. */
export const useUpdatesView = (): UpdatesView => {
  const app = useAppUpdate();
  const state = useData((s) => s.hub);
  const known = useData((s) => s.machines);
  const run = useRun();
  const flow = useFlow();
  const url = state.phase === "live" ? state.hub : null;
  const version = state.phase === "live" ? state.version : undefined;
  const machines = useMemo(
    (): MachineInput[] =>
      Object.values(known).map((m) => ({ machineId: m.machineId, name: m.name, nodeVersion: m.nodeVersion, online: m.status !== "offline" })),
    [known],
  );
  return useMemo(() => updatesView({ app, hub: { url, version }, machines, run, flow }), [app, url, version, machines, run, flow]);
};
