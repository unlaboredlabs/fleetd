// The hubs this app is paired with (docs/design/hubs.md), each with a data layer of its own: its own store, query
// cache and offline cache, so no hub's data or calls ever mix with another's. Main keeps the list; this follows it,
// making a layer for a hub that comes and stopping the layer of one that goes.
import { createStore } from "zustand/vanilla";
import type { HubEntry, HubId } from "../../../shared/hubs";
import { bindHub, createDataLayer, type DataLayer } from "./queries";

export interface HubView extends HubEntry {
  readonly layer: DataLayer;
}

export interface HubSet {
  /** In sidebar order; never empty once started. */
  readonly hubs: readonly HubView[];
}

export const createHubSet = (
  api: Pick<Window["fleetd"], "hub" | "hubs">,
  first: readonly HubEntry[],
  makeLayer: (id: HubId) => DataLayer = (id) => createDataLayer(bindHub(api.hub, id), Date.now, id),
) => {
  const stops = new Map<HubId, () => void>();
  const store = createStore<HubSet>()(() => ({ hubs: [] }));
  const apply = (list: readonly HubEntry[]) => {
    const held = new Map(store.getState().hubs.map((h) => [h.id, h.layer]));
    const hubs = list.map((entry): HubView => ({ ...entry, layer: held.get(entry.id) ?? makeLayer(entry.id) }));
    for (const id of held.keys()) {
      if (hubs.some((h) => h.id === id)) continue;
      stops.get(id)?.();
      stops.delete(id);
    }
    for (const h of hubs) if (!stops.has(h.id)) stops.set(h.id, h.layer.start());
    store.setState({ hubs });
  };
  apply(first);
  api.hubs.subscribe(apply);
  // `first` may be what main had as the window opened: whatever changed since comes now. Main's list is never empty.
  void api.hubs.list().then((list) => {
    if (list.length > 0 && JSON.stringify(list) !== JSON.stringify(first)) apply(list);
  });
  return store;
};
export type HubSetStore = ReturnType<typeof createHubSet>;
