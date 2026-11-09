import { useEffect, useMemo, useState } from "react";
import type { HubState } from "../../../shared/hub";
import { useData, useDataLayer } from "../../src/data/react";
import { useSettledAdministers } from "../admin/role";
import { useFlow, useReady, useRun, type FlowDeps } from "./flow";
import { FAILED_SHOWN_MS, RESULT_SHOWN_MS, updatesView, type MachineInput, type UpdatesView } from "./model";
import { quietOf, type Quiet } from "./quiet";
import { appUpdate, useAppUpdate } from "./state";

/** Everything the updates surfaces say, from main's update state, the hub's ready frame, its machines, its run, the
 * build it has ready, and whether this person updates the hub. */
export const useUpdatesView = (): UpdatesView => {
  const app = useAppUpdate();
  const state = useData((s) => s.hub);
  const known = useData((s) => s.machines);
  const { hub: id } = useDataLayer();
  const run = useRun(id);
  const flow = useFlow(id);
  const ready = useReady(id);
  const administers = useSettledAdministers();
  const url = state.phase === "live" ? state.hub : null;
  const version = state.phase === "live" ? state.version : undefined;
  const machines = useMemo(
    (): MachineInput[] =>
      Object.values(known).map((m) => ({ machineId: m.machineId, name: m.name, nodeVersion: m.nodeVersion, online: m.status !== "offline" })),
    [known],
  );
  return useMemo(() => updatesView({ app, hub: { url, version }, machines, run, flow, ready, administers }), [app, url, version, machines, run, flow, ready, administers]);
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
        check: () => void window.fleetd.updates.check(),
        install: () => void window.fleetd.updates.install(),
      },
    }),
    [layer],
  );
};

/** The hub row's word and its popover's note (quiet.ts): read against the clock as the hub's state changes (each
 * redial while it restarts), and again when "Updated" has said it long enough. */
export const useQuiet = (hub: HubState): Quiet | null => {
  const view = useUpdatesView();
  const updated = useData((s) => s.updated);
  const update = useData((s) => s.update);
  const release = useAppUpdate()?.release;
  const administers = useSettledAdministers();
  // A render when "Updated" or "Put back" has said it long enough.
  const [, setExpired] = useState(0);
  const finished = update?.finishedAt === undefined ? undefined : Date.parse(update.finishedAt) + (update.state === "updated" ? RESULT_SHOWN_MS : FAILED_SHOWN_MS);
  useEffect(() => {
    const ends = [updated === undefined ? undefined : updated.at + RESULT_SHOWN_MS, finished].filter((t): t is number => t !== undefined && t > Date.now());
    if (ends.length === 0) return;
    const timer = setTimeout(() => setExpired((n) => n + 1), Math.min(...ends) - Date.now());
    return () => clearTimeout(timer);
  }, [updated, finished]);
  // Small and cheap: read on every render, against the clock.
  // eslint-disable-next-line react-hooks/purity
  return quietOf({ view, hub, updated, update, release, administers, now: Date.now() });
};
