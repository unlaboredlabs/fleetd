import { useMemo } from "react";
import { useData } from "../../src/data/react";
import { updatesView, type UpdatesView } from "./model";
import { useAppUpdate } from "./state";

/** Everything the updates surfaces say, from main's update state and the hub's ready frame. */
export const useUpdatesView = (): UpdatesView => {
  const app = useAppUpdate();
  const state = useData((s) => s.hub);
  const url = state.phase === "live" ? state.hub : null;
  const version = state.phase === "live" ? state.version : undefined;
  return useMemo(() => updatesView({ app, hub: { url, version } }), [app, url, version]);
};
