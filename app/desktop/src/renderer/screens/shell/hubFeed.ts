// The connection state and new hub events for the frame, read from the data layer's store (one subscription to
// main for the whole page; a second one would make main resend the snapshot).
import { useEffect } from "react";
import type { HubEvent, HubState } from "../../../shared/hub";
import { useData, useDataLayer } from "../../src/data/react";

/** The hub connection as main reports it. */
export const useHubState = (): HubState => useData((s) => s.hub);

/** Calls `listener` with each event that arrives after mounting, once. */
export const useHubEvents = (listener: (event: HubEvent) => void): void => {
  const { store } = useDataLayer();
  useEffect(() => {
    let last = store.getState().events.at(-1)?.seq ?? -1;
    return store.subscribe((s) => {
      for (const event of s.events) {
        if (event.seq <= last) continue;
        last = event.seq;
        listener(event);
      }
    });
  }, [store, listener]);
};
