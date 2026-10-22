import { useMemo } from "react";
import { useData } from "../../src/data/react";
import { hubVersionOf, updatesItself } from "../../src/data/hub-update-contract";
import { updatesView, type UpdatesView } from "./model";
import { useAppUpdate } from "./state";

/** Everything the updates surfaces say, from main's update state and the data layer's hub. */
export const useUpdatesView = (): UpdatesView => {
  const app = useAppUpdate();
  const state = useData((s) => s.hub);
  const progress = useData((s) => s.hubUpdate);
  const url = state.phase === "live" ? state.hub : null;
  const version = hubVersionOf(state);
  const itself = updatesItself(state);
  return useMemo(() => updatesView({ app, hub: { url, version, updatesItself: itself, progress } }), [app, url, version, itself, progress]);
};
