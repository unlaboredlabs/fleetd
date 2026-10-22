import { useMemo } from "react";
import { useData } from "../../src/data/react";
import { useHubProbe } from "../onboarding";
import { updatesView, type UpdatesView } from "./model";
import { useAppUpdate } from "./state";

const platform = window.fleetd.platform;

/** Everything the updates surfaces say, from main's update state and the data layer's hub. */
export const useUpdatesView = (): UpdatesView => {
  const app = useAppUpdate();
  const hub = useData((s) => s.hubVersion);
  const state = useData((s) => s.hub);
  const hubUrl = state.phase === "live" ? state.hub : null;
  // Only a hub that doesn't report its version itself needs /healthz's.
  const probe = useHubProbe(hub === undefined ? hubUrl : null);
  const probeVersion = probe?.answers === true ? probe.version : null;
  return useMemo(() => updatesView({ app, hub, hubUrl, probeVersion, platform }), [app, hub, hubUrl, probeVersion]);
};
