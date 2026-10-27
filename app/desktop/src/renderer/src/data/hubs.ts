// The hubs this app is paired with (docs/design/hubs.md), each with a data layer of its own: its own store, query
// cache and offline cache, so no hub's data or calls ever mix with another's. Main keeps the list; this follows it,
// making a layer for a hub that comes and stopping the layer of one that goes.
import { createStore, type StoreApi } from "zustand/vanilla";
import type { HubEntry, HubId } from "../../../shared/hubs";
import { bindHub, createDataLayer, type DataLayer } from "./queries";

export interface HubView extends HubEntry {
  readonly layer: DataLayer;
}

export interface HubSet {
  /** In sidebar order; never empty once started. */
  readonly hubs: readonly HubView[];
}

/** The set, and its start: nothing talks to main until HubsProvider starts it, after the first render. */
export type HubSetStore = StoreApi<HubSet> & { readonly start: () => () => void };

export const createHubSet = (
  api: Pick<Window["fleetd"], "hub" | "hubs">,
  first: readonly HubEntry[],
  makeLayer: (id: HubId) => DataLayer = (id) => createDataLayer(bindHub(api.hub, id), Date.now, id),
): HubSetStore => {
  const stops = new Map<HubId, () => void>();
  let running = false;
  const store = createStore<HubSet>()(() => ({ hubs: [] }));
  const apply = (list: readonly HubEntry[]) => {
    const held = new Map(store.getState().hubs.map((h) => [h.id, h.layer]));
    const hubs = list.map((entry): HubView => ({ ...entry, layer: held.get(entry.id) ?? makeLayer(entry.id) }));
    for (const id of held.keys()) {
      if (hubs.some((h) => h.id === id)) continue;
      stops.get(id)?.();
      stops.delete(id);
    }
    if (running) for (const h of hubs) if (!stops.has(h.id)) stops.set(h.id, h.layer.start());
    store.setState({ hubs });
  };
  apply(first);
  // Started once the page has painted, as one hub's layer always was: its subscription, its offline cache and the
  // list's catching up wait for the first frame, not the other way round.
  const start = () => {
    running = true;
    for (const h of store.getState().hubs) if (!stops.has(h.id)) stops.set(h.id, h.layer.start());
    const offList = api.hubs.subscribe(apply);
    // `first` may be what main had as the window opened: whatever changed since comes now. Main's list is never empty.
    void api.hubs.list().then((list) => {
      if (running && list.length > 0 && JSON.stringify(list) !== JSON.stringify(store.getState().hubs.map(({ layer: _layer, ...entry }) => entry))) apply(list);
    });
    return () => {
      running = false;
      offList();
      for (const stop of stops.values()) stop();
      stops.clear();
    };
  };
  return Object.assign(store, { start });
};
